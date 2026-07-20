import crypto from "node:crypto";

const DEFAULT_TERMINAL_TTL_MS = 60 * 60 * 1000;
const DEFAULT_TERMINAL_LIMIT = 50;
const DEFAULT_PRUNE_INTERVAL_MS = 60 * 1000;
const TERMINAL_STATUSES = new Set(["completed", "completed_with_warnings", "failed"]);

export function runtimeAiJobMetaForAction({ actionId, projectRoot, dryRun = false, input = {} } = {}) {
  if (dryRun) return null;
  if (actionId === "research.extract_facts") {
    return {
      kind: "fact_extraction",
      projectRoot: clean(projectRoot),
      targetId: clean(input.productId),
      title: "商品事実抽出"
    };
  }
  if (actionId === "strategy.create_who_what") {
    return {
      kind: "strategy_generation",
      projectRoot: clean(projectRoot),
      targetId: clean(input.productId),
      title: "WHO-WHAT生成"
    };
  }
  return null;
}

export function createRuntimeAiJobRegistry({
  now = () => new Date(),
  idFactory = () => `job_${crypto.randomUUID()}`,
  terminalTtlMs = DEFAULT_TERMINAL_TTL_MS,
  terminalLimit = DEFAULT_TERMINAL_LIMIT,
  pruneIntervalMs = DEFAULT_PRUNE_INTERVAL_MS,
  onError = (error) => console.warn("[CMOAI] AI job registry update failed:", error?.message || error)
} = {}) {
  const jobs = new Map();
  let version = 0;
  let lastPrunedAt = 0;

  function report(error) {
    try {
      onError(error);
    } catch {
      // The monitor must never affect the AI operation it observes.
    }
  }

  function mutate(operation, fallback = null) {
    try {
      return operation();
    } catch (error) {
      report(error);
      return fallback;
    }
  }

  function pruneRuntimeAiJobs({ force = false } = {}) {
    return mutate(() => {
      const nowMs = now().getTime();
      if (!force && pruneIntervalMs > 0 && nowMs - lastPrunedAt < pruneIntervalMs) return 0;
      lastPrunedAt = nowMs;
      const terminal = [...jobs.values()]
        .filter((job) => TERMINAL_STATUSES.has(job.status))
        .sort((left, right) => Date.parse(right.finishedAt || right.updatedAt || 0) - Date.parse(left.finishedAt || left.updatedAt || 0));
      const keepIds = new Set(terminal.slice(0, Math.max(0, terminalLimit)).map((job) => job.id));
      let removed = 0;
      for (const job of terminal) {
        const finishedMs = Date.parse(job.finishedAt || job.updatedAt || 0);
        if (keepIds.has(job.id) && nowMs - finishedMs <= terminalTtlMs) continue;
        jobs.delete(job.id);
        removed += 1;
      }
      if (removed) version += 1;
      return removed;
    }, 0);
  }

  function beginRuntimeAiJob(meta = {}) {
    return mutate(() => {
      pruneRuntimeAiJobs();
      const timestamp = now().toISOString();
      const job = {
        id: idFactory(),
        kind: clean(meta.kind) || "ai_processing",
        scope: "project",
        projectRoot: clean(meta.projectRoot),
        targetId: clean(meta.targetId),
        title: clean(meta.title) || "AI処理",
        status: "running",
        statusLabel: clean(meta.statusLabel) || defaultStatusLabel(meta.kind),
        stage: {
          key: clean(meta.stageKey) || "ai",
          label: clean(meta.stageLabel) || "AI応答待ち",
          index: 1,
          total: 1,
          determinate: false
        },
        steps: [],
        startedAt: timestamp,
        updatedAt: timestamp,
        finishedAt: "",
        errorMessage: "",
        canRetry: false
      };
      jobs.set(job.id, job);
      version += 1;
      return publicJob(job);
    });
  }

  function updateRuntimeAiJob(jobId, patch = {}) {
    return mutate(() => {
      const current = jobs.get(jobId);
      if (!current || TERMINAL_STATUSES.has(current.status)) return current ? publicJob(current) : null;
      const timestamp = now().toISOString();
      const next = {
        ...current,
        targetId: patch.targetId === undefined ? current.targetId : clean(patch.targetId),
        title: patch.title === undefined ? current.title : clean(patch.title),
        statusLabel: patch.statusLabel === undefined ? current.statusLabel : clean(patch.statusLabel),
        stage: patch.stageLabel === undefined && patch.stageKey === undefined
          ? current.stage
          : {
              ...current.stage,
              key: patch.stageKey === undefined ? current.stage.key : clean(patch.stageKey),
              label: patch.stageLabel === undefined ? current.stage.label : clean(patch.stageLabel),
              determinate: false
            },
        updatedAt: timestamp
      };
      jobs.set(jobId, next);
      version += 1;
      return publicJob(next);
    });
  }

  function finishRuntimeAiJob(jobId, status, patch = {}) {
    return mutate(() => {
      const current = jobs.get(jobId);
      if (!current || TERMINAL_STATUSES.has(current.status)) return current ? publicJob(current) : null;
      const timestamp = now().toISOString();
      const next = {
        ...current,
        ...pickTerminalPatch(patch),
        status,
        statusLabel: clean(patch.statusLabel) || (status === "failed" ? "失敗" : "完了"),
        updatedAt: timestamp,
        finishedAt: timestamp,
        errorMessage: status === "failed" ? clean(patch.errorMessage) : ""
      };
      jobs.set(jobId, next);
      version += 1;
      pruneRuntimeAiJobs();
      return publicJob(next);
    });
  }

  function completeRuntimeAiJob(jobId, patch = {}) {
    return finishRuntimeAiJob(jobId, patch.completedWithWarnings ? "completed_with_warnings" : "completed", patch);
  }

  function failRuntimeAiJob(jobId, error) {
    const message = error instanceof Error ? error.message : error?.message || error;
    return finishRuntimeAiJob(jobId, "failed", { errorMessage: clean(message), canRetry: false });
  }

  function listRuntimeAiJobs({ projectRoot = "", recentSince = "" } = {}) {
    try {
      const cutoff = recentSince ? Date.parse(recentSince) : Number.NEGATIVE_INFINITY;
      return [...jobs.values()]
        .filter((job) => job.projectRoot === clean(projectRoot))
        .filter((job) => !TERMINAL_STATUSES.has(job.status) || Date.parse(job.finishedAt || job.updatedAt || 0) >= cutoff)
        .sort((left, right) => Date.parse(right.updatedAt || right.startedAt || 0) - Date.parse(left.updatedAt || left.startedAt || 0))
        .map(publicJob);
    } catch (error) {
      report(error);
      return [];
    }
  }

  async function withRuntimeAiJob(meta, handler, options = {}) {
    const started = beginRuntimeAiJob(meta);
    const update = (patch) => started ? updateRuntimeAiJob(started.id, patch) : null;
    let terminal = false;
    try {
      const result = await handler({ jobId: started?.id || "", update });
      if (started) {
        const successful = typeof options.isSuccess === "function" ? options.isSuccess(result) : true;
        if (successful) completeRuntimeAiJob(started.id, options.completePatch || {});
        else failRuntimeAiJob(started.id, result?.message || "AI処理に失敗しました。");
        terminal = true;
      }
      return result;
    } catch (error) {
      if (started) {
        failRuntimeAiJob(started.id, error);
        terminal = true;
      }
      throw error;
    } finally {
      if (started && !terminal && jobs.get(started.id)?.status === "running") {
        failRuntimeAiJob(started.id, "AI処理の終了状態を確認できませんでした。");
      }
    }
  }

  return {
    beginRuntimeAiJob,
    updateRuntimeAiJob,
    completeRuntimeAiJob,
    failRuntimeAiJob,
    listRuntimeAiJobs,
    pruneRuntimeAiJobs,
    withRuntimeAiJob,
    getVersion: () => version
  };
}

function publicJob(job) {
  const { projectRoot, ...safe } = job;
  return structuredClone(safe);
}

function pickTerminalPatch(patch) {
  const safe = {};
  if (patch.title !== undefined) safe.title = clean(patch.title);
  if (patch.targetId !== undefined) safe.targetId = clean(patch.targetId);
  if (patch.canRetry !== undefined) safe.canRetry = Boolean(patch.canRetry);
  return safe;
}

function defaultStatusLabel(kind) {
  if (kind === "fact_extraction") return "商品事実を抽出中";
  if (kind === "strategy_generation") return "WHO-WHATを生成中";
  if (kind === "regulation_extraction") return "表現レギュレーションを抽出中";
  return "AI処理中";
}

function clean(value) {
  return String(value ?? "").trim();
}
