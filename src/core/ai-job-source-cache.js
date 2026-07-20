import fs from "node:fs/promises";
import path from "node:path";

const STALE_WARNING = "一部のAIジョブ情報は直前に取得できた内容を表示しています。";

export function createAiJobSourceCache({
  fsApi = fs,
  retryDelays = [0, 25, 75, 150],
  maxProjectCaches = 5,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  const entries = new Map();
  const pending = new Map();
  const projectUsage = new Map();
  let usageSequence = 0;

  async function loadFile(filePath, projectionKind) {
    const resolved = path.resolve(filePath);
    if (pending.has(resolved)) return pending.get(resolved);
    const promise = loadFileUnshared(resolved, projectionKind).finally(() => pending.delete(resolved));
    pending.set(resolved, promise);
    return promise;
  }

  async function loadFileUnshared(filePath, projectionKind) {
    const previous = entries.get(filePath);
    try {
      const stat = await retry(() => fsApi.stat(filePath));
      const fingerprint = sourceFingerprint(stat);
      if (previous?.fingerprint === fingerprint) {
        return { data: previous.data, fingerprint, warning: "" };
      }
      const raw = await retry(() => fsApi.readFile(filePath, "utf8"));
      const parsed = JSON.parse(String(raw).replace(/^\uFEFF/, ""));
      const data = projectRecords(parsed, projectionKind);
      entries.set(filePath, { fingerprint, data, projectionKind });
      return { data, fingerprint, warning: "" };
    } catch (error) {
      if (previous) return { data: previous.data, fingerprint: previous.fingerprint, warning: STALE_WARNING };
      const wrapped = new Error("AIジョブ情報を読み込めませんでした。しばらく待ってから再試行してください。");
      wrapped.code = "AI_JOB_SOURCE_UNAVAILABLE";
      throw wrapped;
    }
  }

  async function loadSources({ projectRoot, sharedTemplatesPath }) {
    const root = path.resolve(projectRoot);
    touchProject(root);
    const sources = await Promise.all([
      loadFile(path.join(root, "data", "material-extraction-jobs.json"), "materialJobs"),
      loadFile(path.join(root, "data", "research-materials.json"), "materials"),
      loadFile(path.join(root, "data", "banner-creatives.json"), "banners"),
      loadFile(sharedTemplatesPath, "templates")
    ]);
    const warnings = sources.map((source) => source.warning).filter(Boolean);
    return {
      materialJobs: sources[0].data,
      materials: sources[1].data,
      banners: sources[2].data,
      templates: sources[3].data,
      signature: sources.map((source) => source.fingerprint).join("|"),
      sourceWarning: warnings.length ? STALE_WARNING : ""
    };
  }

  function touchProject(projectRoot) {
    projectUsage.set(projectRoot, ++usageSequence);
    if (projectUsage.size <= maxProjectCaches) return;
    const [oldest] = [...projectUsage.entries()].sort((a, b) => a[1] - b[1])[0];
    projectUsage.delete(oldest);
    const prefix = `${oldest}${path.sep}`;
    for (const key of entries.keys()) {
      if (key.startsWith(prefix)) entries.delete(key);
    }
  }

  async function retry(operation) {
    const delays = retryDelays.length ? retryDelays : [0];
    let lastError;
    for (let index = 0; index < delays.length; index += 1) {
      if (delays[index] > 0) await sleep(delays[index]);
      try {
        return await operation();
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  return {
    loadFile,
    loadSources,
    getStats: () => ({ cachedSources: entries.size, pendingReloads: pending.size, cachedProjects: projectUsage.size })
  };
}

function sourceFingerprint(stat) {
  return [stat.mtimeMs || 0, stat.ctimeMs || 0, stat.size || 0, stat.ino || 0].join(":");
}

function projectRecords(value, kind) {
  const records = Array.isArray(value) ? value : [];
  if (kind === "materials") {
    return records.map((item) => ({
      id: clean(item.id),
      title: clean(item.title),
      sourceUrl: clean(item.sourceUrl)
    }));
  }
  if (kind === "materialJobs") {
    return records.map((item) => ({
      ...pick(item, ["id", "materialId", "status", "startedAt", "progressAt", "finishedAt", "errorMessage", "transcribedSliceCount", "totalSliceCount", "createdAt", "updatedAt"]),
      steps: Array.isArray(item.steps) ? item.steps.map((step) => pick(step, ["key", "label", "status", "detail", "completedCount", "totalCount", "startedAt", "completedAt", "updatedAt", "errorMessage"])) : []
    }));
  }
  if (kind === "templates") {
    return records.map((item) => pick(item, [
      "id", "title", "templateProcessingStatus", "templateStatus", "templateAnalysisAttemptId",
      "templateAnalysisQueuedAt", "templateAnalysisStartedAt", "templateAnalysisCompletedAt",
      "templateAnalysisError", "templateAnalysisLease", "createdAt", "updatedAt"
    ]));
  }
  if (kind === "banners") {
    return records.map((item) => ({
      ...pick(item, [
        "id", "title", "productionStatus", "imageGenerationStatus", "pipelineNodes", "lastEditMode",
        "promptGenerationLease", "imageGenerationLease", "lastImageEditMode", "lastImageEditError",
        "lastImageEditErrorAt", "lastError", "lastErrorAt", "jobRecoveryAudit", "createdAt", "updatedAt"
      ])
    }));
  }
  return records;
}

function pick(source, keys) {
  const result = {};
  for (const key of keys) {
    if (source?.[key] !== undefined) result[key] = structuredClone(source[key]);
  }
  return result;
}

function clean(value) {
  return String(value ?? "").trim();
}
