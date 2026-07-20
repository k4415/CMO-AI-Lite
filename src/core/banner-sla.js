const TERMINAL_PRODUCTION_STATUSES = new Set(["completed", "completed_with_warnings"]);

function parseTimestamp(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function findProcessingStartMs(nodes) {
  const starts = [nodes.copyplan?.startedAt, nodes.prompt?.startedAt, nodes.image?.startedAt]
    .map(parseTimestamp)
    .filter(Number.isFinite);
  return starts.length ? Math.min(...starts) : null;
}

export function evaluateBannerBatchSla({
  requestStartedAt,
  banners = [],
  expectedCount = 10,
  limitMs = 180000
} = {}) {
  const requestMs = parseTimestamp(requestStartedAt);
  const normalizedExpectedCount = Math.max(1, Number(expectedCount) || 10);
  const normalizedLimitMs = Math.max(0, Number(limitMs) || 180000);
  const perBanner = (Array.isArray(banners) ? banners : []).map((banner) => {
    const nodes = banner?.pipelineNodes && typeof banner.pipelineNodes === "object"
      ? banner.pipelineNodes
      : {};
    const processingStartMs = findProcessingStartMs(nodes);
    const completedMs = parseTimestamp(nodes.image?.completedAt);
    const terminal = TERMINAL_PRODUCTION_STATUSES.has(String(banner?.productionStatus || ""));
    const qualityPassed = banner?.slaQualityPassed !== false;
    const processingMs = processingStartMs === null || completedMs === null
      ? null
      : completedMs - processingStartMs;

    return {
      bannerId: String(banner?.id || ""),
      terminal,
      qualityPassed,
      processingStartMs,
      completedMs,
      processingMs
    };
  });
  const accepted = perBanner.filter((item) => (
    item.terminal
    && item.qualityPassed
    && Number.isFinite(item.completedMs)
  ));
  const batchMakespanMs = requestMs !== null && accepted.length
    ? Math.max(...accepted.map((item) => item.completedMs)) - requestMs
    : Infinity;
  const expectedCompleted = accepted.length === normalizedExpectedCount;
  const allProcessingWithinLimit = expectedCompleted && accepted.every((item) => (
    Number.isFinite(item.processingMs)
    && item.processingMs >= 0
    && item.processingMs <= normalizedLimitMs
  ));

  return {
    idealPassed: expectedCompleted
      && batchMakespanMs >= 0
      && batchMakespanMs <= normalizedLimitMs,
    minimumPassed: allProcessingWithinLimit,
    batchMakespanMs,
    perBanner,
    completedCount: accepted.length,
    qualityFailureCount: perBanner.filter((item) => !item.qualityPassed).length
  };
}
