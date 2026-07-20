const ACTIVE_STATUSES = new Set(["queued", "running"]);
const TERMINAL_STATUSES = new Set(["completed", "completed_with_warnings", "failed", "stale"]);

export function aiJobStatusPresentation(status) {
  const values = {
    queued: { label: "待機中", tone: "info", icon: "◷" },
    running: { label: "実行中", tone: "info", icon: "↻" },
    completed: { label: "完了", tone: "success", icon: "✓" },
    completed_with_warnings: { label: "警告ありで完了", tone: "warning", icon: "!" },
    failed: { label: "失敗", tone: "danger", icon: "!" },
    stale: { label: "中断の可能性", tone: "danger", icon: "!" }
  };
  return values[status] || { label: "状態不明", tone: "neutral", icon: "?" };
}

export function buildAiJobViewModel(snapshot = {}) {
  const jobs = Array.isArray(snapshot.jobs) ? snapshot.jobs.map((job) => ({
    ...job,
    title: safeText(job.title, "AI処理"),
    statusLabel: safeText(job.statusLabel, aiJobStatusPresentation(job.status).label),
    errorMessage: safeText(job.errorMessage),
    note: safeText(job.note),
    stage: job.stage && typeof job.stage === "object"
      ? { ...job.stage, label: safeText(job.stage.label, "処理中") }
      : { key: "ai", label: "処理中", determinate: false },
    steps: Array.isArray(job.steps) ? job.steps.map((step) => ({
      key: safeText(step.key),
      label: safeText(step.label, "工程"),
      status: safeText(step.status, "queued")
    })) : [],
    presentation: aiJobStatusPresentation(job.status),
    indeterminate: job.stage?.determinate !== true
  })).sort((left, right) => Number(ACTIVE_STATUSES.has(right.status)) - Number(ACTIVE_STATUSES.has(left.status))) : [];
  const activeJobs = jobs.filter((job) => ACTIVE_STATUSES.has(job.status));
  const recentJobs = jobs.filter((job) => !ACTIVE_STATUSES.has(job.status));
  return {
    activeCount: Math.max(0, Number(snapshot.activeCount) || activeJobs.length),
    sourceWarning: safeText(snapshot.sourceWarning),
    jobs,
    activeJobs,
    recentJobs,
    empty: jobs.length === 0
  };
}

export function collectAiJobTerminalTransitions(previousJobs = [], nextJobs = [], { initialized = false, notifiedIds = new Set() } = {}) {
  if (!initialized) return [];
  const previousById = new Map(previousJobs.map((job) => [job.id, job]));
  const transitions = [];
  for (const job of nextJobs) {
    if (!TERMINAL_STATUSES.has(job.status) || notifiedIds.has(job.id)) continue;
    const previous = previousById.get(job.id);
    if (previous && TERMINAL_STATUSES.has(previous.status)) continue;
    notifiedIds.add(job.id);
    transitions.push(job);
  }
  return transitions;
}

export function pollDelayForAiJobs({ hidden = false, panelOpen = false, activeCount = 0 } = {}) {
  if (hidden) return 30_000;
  if (activeCount > 0) return 3_000;
  if (panelOpen) return 5_000;
  return 10_000;
}

export function isAiJobSnapshotCurrent({ requestGeneration, currentGeneration, requestProject, currentProject }) {
  return requestGeneration === currentGeneration && requestProject === currentProject;
}

export async function fetchAiJobSnapshot(fetchImpl, url, { etag = "", signal } = {}) {
  try {
    const headers = etag ? { "if-none-match": etag } : {};
    const response = await fetchImpl(url, { headers, signal });
    const nextEtag = response.headers.get("etag") || etag;
    if (response.status === 304) return { kind: "not_modified", etag: nextEtag };
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok || !data?.ok) {
      return { kind: "error", status: response.status, message: safeText(data?.message, "AIジョブ情報を取得できませんでした。"), etag: nextEtag };
    }
    return { kind: "snapshot", snapshot: data, etag: nextEtag };
  } catch (error) {
    if (error?.name === "AbortError") return { kind: "aborted" };
    return { kind: "error", status: 0, message: "AIジョブ情報を取得できませんでした。" };
  }
}

export function formatAiJobElapsed(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}分${String(seconds).padStart(2, "0")}秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours}時間${String(minutes % 60).padStart(2, "0")}分`;
}

function safeText(value, fallback = "") {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return (text || fallback).slice(0, 500);
}
