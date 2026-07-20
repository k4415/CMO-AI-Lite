const ACTIVE_STATUSES = new Set(["queued", "running"]);
const TERMINAL_STATUSES = new Set(["completed", "completed_with_warnings", "failed", "stale"]);
const STATUS_PRIORITY = new Map([
  ["stale", 0],
  ["failed", 1],
  ["running", 2],
  ["queued", 3],
  ["completed_with_warnings", 4],
  ["completed", 5]
]);
const RECENT_WINDOW_MS = 60 * 60 * 1000;
const MATERIAL_STALE_MS = 10 * 60 * 1000;

export function normalizeMaterialJobs({ jobs = [], materials = [], now = new Date() } = {}) {
  const materialMap = new Map(materials.map((item) => [item.id, item]));
  return jobs.map((source) => {
    const material = materialMap.get(source.materialId) || {};
    const steps = (source.steps || []).map((step, index) => {
      const counts = extractProgressCounts(step);
      return {
        key: clean(step.key) || `step_${index + 1}`,
        label: clean(step.label) || "処理中",
        status: normalizeStatus(step.status),
        ...(counts.completedCount !== null ? { completedCount: counts.completedCount } : {}),
        ...(counts.totalCount !== null ? { totalCount: counts.totalCount } : {})
      };
    });
    const stageSource = [...steps].reverse().find((step) => step.status === "running")
      || [...steps].reverse().find((step) => ["completed", "failed"].includes(step.status))
      || { key: "extract", label: "内部LP解析", status: normalizeStatus(source.status) };
    let status = normalizeStatus(source.status);
    if (status === "completed" && clean(source.errorMessage)) status = "completed_with_warnings";
    if (status === "running" && isOlderThan(source.progressAt || source.updatedAt || source.startedAt, now, MATERIAL_STALE_MS)) status = "stale";
    const title = clean(material.title) || safeHost(material.sourceUrl) || "内部LP解析";
    return baseJob({
      id: `material:${clean(source.id)}`,
      kind: "material_extraction",
      targetId: clean(source.materialId),
      title,
      status,
      statusLabel: statusLabel(status, status === "running" ? "内部LPを解析中" : ""),
      stage: { ...stageSource, index: Math.max(1, steps.findIndex((step) => step.key === stageSource.key) + 1), total: Math.max(1, steps.length), determinate: false },
      steps,
      startedAt: source.startedAt || source.createdAt,
      updatedAt: source.progressAt || source.updatedAt || source.finishedAt,
      finishedAt: source.finishedAt,
      errorMessage: safeJobError(source.errorMessage, "内部LP解析に失敗しました。"),
      canRetry: status === "failed" || status === "stale",
      note: status === "completed_with_warnings"
        ? safeJobError(source.errorMessage, "一部の解析処理を完了できませんでした。")
        : "",
      now
    });
  });
}

export function normalizeTemplateJobs(templates = [], { now = new Date() } = {}) {
  return templates
    .filter((item) => ["queued", "running", "completed", "completed_with_warnings", "failed"].includes(normalizeStatus(item.templateProcessingStatus)))
    .map((source) => {
      let status = normalizeStatus(source.templateProcessingStatus);
      if (status === "running" && leaseExpired(source.templateAnalysisLease, now)) status = "stale";
      const label = status === "queued" ? "解析待ち" : status === "running" ? "構造・コピー枠を解析中" : "";
      return baseJob({
        id: `template:${clean(source.id)}:${clean(source.templateAnalysisAttemptId) || "latest"}`,
        kind: "template_analysis",
        scope: "shared",
        scopeLabel: "共通テンプレDB",
        targetId: clean(source.id),
        title: clean(source.title) || "バナーテンプレート",
        status,
        statusLabel: statusLabel(status, label),
        stage: { key: "analysis", label: label || "テンプレート解析", index: 1, total: 1, determinate: false },
        steps: [],
        startedAt: source.templateAnalysisStartedAt || source.templateAnalysisQueuedAt,
        updatedAt: source.templateAnalysisCompletedAt || source.updatedAt || source.templateAnalysisStartedAt || source.templateAnalysisQueuedAt,
        finishedAt: source.templateAnalysisCompletedAt,
        errorMessage: safeJobError(source.templateAnalysisError, "テンプレート解析に失敗しました。"),
        canRetry: status === "failed" || status === "stale",
        now
      });
    });
}

export function normalizeBannerJobs(banners = [], { now = new Date() } = {}) {
  return banners.map((source) => normalizeBannerJob(source, now)).filter(Boolean);
}

function normalizeBannerJob(source, now) {
  const imageLease = source.imageGenerationLease || {};
  const isEdit = imageLease.operationKind === "edit" && ["queued", "generating", "running"].includes(clean(source.imageGenerationStatus));
  if (isEdit) {
    let status = clean(source.imageGenerationStatus) === "queued" ? "queued" : "running";
    if (leaseExpired(imageLease, now)) status = "stale";
    const editMode = clean(imageLease.editMode || source.lastImageEditMode);
    const stageLabel = editMode === "range" ? "範囲指定修正" : "全体修正";
    return baseJob({
      id: `banner:${clean(source.id)}:${clean(imageLease.attemptId) || "edit"}`,
      kind: "banner_image_edit",
      targetId: clean(source.id),
      title: clean(source.title) || "バナー画像修正",
      status,
      statusLabel: statusLabel(status, status === "queued" ? `${stageLabel}待ち` : `${stageLabel}中`),
      stage: { key: "edit", label: stageLabel, index: 1, total: 1, determinate: false },
      steps: [{ key: "edit", label: stageLabel, status }],
      startedAt: imageLease.startedAt || source.updatedAt,
      updatedAt: imageLease.heartbeatAt || source.updatedAt,
      finishedAt: "",
      errorMessage: safeJobError(source.lastImageEditError, "バナー画像の修正に失敗しました。"),
      canRetry: status === "stale",
      now
    });
  }

  const nodeDefinitions = [
    ["copyplan", "コピー設計"],
    ["prompt", "プロンプト作成"],
    ["image", "画像生成"]
  ];
  const nodes = source.pipelineNodes || {};
  const steps = nodeDefinitions.map(([key, label]) => ({ key, label, status: normalizeNodeStatus(nodes[key]?.status) }));
  let activeIndex = steps.findIndex((step) => ["running", "queued"].includes(step.status));
  if (activeIndex < 0 && clean(source.imageGenerationStatus) === "queued") activeIndex = 2;
  if (activeIndex < 0 && ["generating", "running"].includes(clean(source.imageGenerationStatus))) activeIndex = 2;
  if (activeIndex < 0) activeIndex = lastMeaningfulStepIndex(steps);
  const activeNode = nodeDefinitions[Math.max(0, activeIndex)][0];
  const node = nodes[activeNode] || {};
  let status = deriveBannerStatus(source, steps, activeIndex);
  const lease = activeNode === "image" ? source.imageGenerationLease : source.promptGenerationLease;
  if (["queued", "running"].includes(status) && leaseExpired(lease, now)) status = "stale";
  if (!status) return null;
  if (["queued", "running", "stale"].includes(status) && steps[activeIndex]) steps[activeIndex].status = status;
  const attemptId = clean(node.attemptId || lease?.attemptId || latestAttemptId(nodes)) || "latest";
  const waitSuffix = status === "queued" ? "待ち" : status === "running" ? "中" : "";
  const recoveryAction = clean(source.jobRecoveryAudit?.lastAction);
  const note = recoveryAction === "image_requeued"
    ? "サーバー再起動後に画像生成を再開"
    : ["prompt_reset_for_manual_retry", "image_reset_for_manual_retry"].includes(recoveryAction)
      ? "手動での再実行が必要です。"
      : "";
  return baseJob({
    id: `banner:${clean(source.id)}:${attemptId}`,
    kind: "banner_generation",
    targetId: clean(source.id),
    title: clean(source.title) || "バナー生成",
    status,
    statusLabel: statusLabel(status, `${nodeDefinitions[Math.max(0, activeIndex)][1]}${waitSuffix}`),
    stage: { key: activeNode, label: nodeDefinitions[Math.max(0, activeIndex)][1], index: Math.max(0, activeIndex) + 1, total: 3, determinate: true },
    steps,
    startedAt: node.startedAt || lease?.startedAt || lease?.queuedAt || source.createdAt,
    updatedAt: node.updatedAt || node.completedAt || lease?.heartbeatAt || source.lastErrorAt || source.updatedAt,
    finishedAt: node.completedAt || (TERMINAL_STATUSES.has(status) ? source.updatedAt : ""),
    errorMessage: safeJobError(node.errorMessage || source.lastImageEditError || source.lastError, "バナー生成に失敗しました。"),
    canRetry: status === "failed" || status === "stale",
    note,
    now
  });
}

export function buildAiJobSnapshot({ jobs = [], now = new Date(), recentLimit = 20, snapshotVersion = "", sourceWarning = "" } = {}) {
  const nowDate = toDate(now);
  const limit = clamp(Number(recentLimit) || 0, 0, 50);
  const active = jobs.filter((job) => ACTIVE_STATUSES.has(job.status));
  const recent = jobs
    .filter((job) => TERMINAL_STATUSES.has(job.status))
    .filter((job) => nowDate.getTime() - timeOf(job.finishedAt || job.updatedAt) <= RECENT_WINDOW_MS)
    .sort(compareJobs)
    .slice(0, limit);
  const selected = [...active, ...recent].sort(compareJobs).map((job) => ({ ...job, elapsedMs: elapsedFor(job, nowDate) }));
  return {
    ok: true,
    serverTime: nowDate.toISOString(),
    snapshotVersion,
    activeCount: active.length,
    sourceWarning: clean(sourceWarning),
    jobs: selected
  };
}

export function safeJobError(value, fallback = "AI処理に失敗しました。") {
  let text = clean(value);
  if (!text) return clean(fallback);
  text = text
    .replace(/Authorization\s*:\s*[^\s,;]+(?:\s+[^\s,;]+)?/gi, "Authorization: [非表示]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[非表示]")
    .replace(/\/[Uu]sers\/[^\s'\"}]+/g, "[非表示]")
    .replace(/\/(?:private|tmp|var|home|opt|etc|Volumes)\/[^\s'\"}]+/g, "[非表示]")
    .replace(/\b[A-Za-z]:\\[^\s'\"}]+/g, "[非表示]")
    .replace(/\{[\s\S]*\}/g, "[非表示]")
    .replace(/\s+/g, " ")
    .trim();
  return (text || clean(fallback)).slice(0, 300);
}

function baseJob(input) {
  const now = toDate(input.now);
  const startedAt = validIso(input.startedAt);
  const updatedAt = validIso(input.updatedAt || input.startedAt);
  const finishedAt = validIso(input.finishedAt);
  return {
    id: input.id,
    kind: input.kind,
    scope: input.scope || "project",
    ...(input.scopeLabel ? { scopeLabel: input.scopeLabel } : {}),
    targetId: input.targetId,
    title: input.title,
    status: input.status,
    statusLabel: input.statusLabel,
    stage: input.stage,
    steps: input.steps || [],
    startedAt,
    updatedAt,
    finishedAt,
    elapsedMs: elapsedFor({ startedAt, finishedAt }, now),
    errorMessage: ["failed", "stale"].includes(input.status) ? input.errorMessage : "",
    canRetry: Boolean(input.canRetry),
    ...(input.note ? { note: input.note } : {})
  };
}

function deriveBannerStatus(source, steps, activeIndex) {
  const imageStatus = clean(source.imageGenerationStatus);
  const productionStatus = clean(source.productionStatus);
  if (imageStatus === "queued") return "queued";
  if (["generating", "running"].includes(imageStatus)) return "running";
  if (imageStatus === "failed" || productionStatus === "failed" || steps.some((step) => step.status === "failed")) return "failed";
  if (imageStatus === "completed_with_warnings" || productionStatus === "completed_with_warnings" || steps.some((step) => step.status === "completed_with_warnings")) return "completed_with_warnings";
  if (imageStatus === "completed" || (activeIndex >= 0 && steps[activeIndex].status === "completed")) return "completed";
  if (["prompt_queued", "queued"].includes(productionStatus)) return "queued";
  if (["prompt_generating", "generating", "running"].includes(productionStatus)) return "running";
  if (steps.some((step) => step.status === "running")) return "running";
  if (steps.some((step) => step.status === "queued")) return "queued";
  return "";
}

function normalizeStatus(value) {
  const status = clean(value);
  if (["queued", "running", "completed", "completed_with_warnings", "failed", "stale"].includes(status)) return status;
  if (["generating", "processing", "in_progress"].includes(status)) return "running";
  if (["pending", "waiting"].includes(status)) return "queued";
  if (["done", "success"].includes(status)) return "completed";
  return status || "failed";
}

function normalizeNodeStatus(value) {
  const status = clean(value);
  if (["not_started", "pending", "idle", ""].includes(status)) return "not_started";
  return normalizeStatus(status);
}

function statusLabel(status, activeLabel = "") {
  if (status === "stale") return "中断の可能性";
  if (status === "failed") return "失敗";
  if (status === "completed_with_warnings") return "警告ありで完了";
  if (status === "completed") return "完了";
  return activeLabel || (status === "queued" ? "処理待ち" : "処理中");
}

function compareJobs(left, right) {
  const priority = (STATUS_PRIORITY.get(left.status) ?? 99) - (STATUS_PRIORITY.get(right.status) ?? 99);
  if (priority) return priority;
  return timeOf(right.updatedAt || right.startedAt) - timeOf(left.updatedAt || left.startedAt);
}

function lastMeaningfulStepIndex(steps) {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (!["queued", "not_started", ""].includes(steps[index].status)) return index;
  }
  return 0;
}

function latestAttemptId(nodes) {
  return [nodes.image, nodes.prompt, nodes.copyplan].find((node) => clean(node?.attemptId))?.attemptId || "";
}

function leaseExpired(lease, now) {
  const expiresAt = lease?.expiresAt || lease?.leaseExpiresAt;
  return Boolean(expiresAt && timeOf(expiresAt) <= toDate(now).getTime());
}

function isOlderThan(value, now, durationMs) {
  const timestamp = timeOf(value);
  return Boolean(timestamp && toDate(now).getTime() - timestamp >= durationMs);
}

function safeHost(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return "";
  }
}

function elapsedFor(job, now) {
  const start = timeOf(job.startedAt);
  if (!start) return 0;
  const end = timeOf(job.finishedAt) || toDate(now).getTime();
  return Math.max(0, end - start);
}

function validIso(value) {
  const timestamp = timeOf(value);
  return timestamp ? new Date(timestamp).toISOString() : "";
}

function timeOf(value) {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function toDate(value) {
  return value instanceof Date ? value : new Date(value);
}

function finite(value) {
  return Number.isFinite(Number(value));
}

function extractProgressCounts(step) {
  const explicitCompleted = finite(step.completedCount) ? Number(step.completedCount) : null;
  const explicitTotal = finite(step.totalCount) ? Number(step.totalCount) : null;
  if (explicitCompleted !== null || explicitTotal !== null) return { completedCount: explicitCompleted, totalCount: explicitTotal };
  const match = clean(step.detail).match(/(\d+)\s*\/\s*(\d+)/);
  return match ? { completedCount: Number(match[1]), totalCount: Number(match[2]) } : { completedCount: null, totalCount: null };
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function clean(value) {
  return String(value ?? "").trim();
}
