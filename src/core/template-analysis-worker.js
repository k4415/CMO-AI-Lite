import { FifoWorkerPool } from "./job-queue.js";
import {
  claimTemplateAnalysis,
  completeTemplateAnalysis,
  failTemplateAnalysis,
  renewTemplateAnalysisLease,
  startTemplateAnalysis
} from "./ad-template-store.js";
import { analyzeBannerTemplateImage } from "./template-ai.js";

export function normalizeTemplateAnalysisConcurrency(value, fallback = 10) {
  if (value === undefined || value === null || value === "") return Math.min(10, Math.max(1, Math.floor(Number(fallback) || 10)));
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return Math.min(10, Math.max(1, Math.floor(Number(fallback) || 10)));
  return Math.min(10, Math.max(1, Math.floor(numeric)));
}

export function createTemplateAnalysisWorkerPool(concurrency = 10) {
  return new FifoWorkerPool(normalizeTemplateAnalysisConcurrency(concurrency));
}

export async function enqueueTemplateAnalysisJob({
  pool,
  projectRoot,
  templateId,
  ownerId,
  attemptId = "",
  leaseMs = 10 * 60 * 1000,
  claim = claimTemplateAnalysis,
  start = startTemplateAnalysis,
  renew = renewTemplateAnalysisLease,
  analyze = analyzeBannerTemplateImage,
  runWithAnalysisSlot = (task) => task(),
  complete = completeTemplateAnalysis,
  fail = failTemplateAnalysis
}) {
  const claimResult = attemptId
    ? { claimed: true, recoveredStale: true, template: { templateAnalysisAttemptId: attemptId, templateProcessingStatus: "queued" } }
    : await claim(projectRoot, templateId, { ownerId, leaseMs });
  if (!claimResult.claimed) return { accepted: false, claim: claimResult };

  const resolvedAttemptId = attemptId || claimResult.template.templateAnalysisAttemptId;
  const taskPromise = pool.run(async () => {
    let heartbeat = null;
    try {
      await start(projectRoot, templateId, resolvedAttemptId, { ownerId, leaseMs });
      const heartbeatMs = Math.max(30_000, Math.min(60_000, Math.floor(leaseMs / 3)));
      heartbeat = setInterval(() => {
        renew(projectRoot, templateId, resolvedAttemptId, leaseMs).catch(() => null);
      }, heartbeatMs);
      heartbeat.unref();
      const patch = await runWithAnalysisSlot(() => analyze(projectRoot, templateId));
      return await complete(projectRoot, templateId, resolvedAttemptId, patch);
    } catch (error) {
      // A recovered job can briefly be scheduled by overlapping server processes.
      // If another worker already moved the same attempt forward (or replaced it),
      // this worker is stale and must not overwrite the winner with `failed`.
      if (error?.code !== "TEMPLATE_ANALYSIS_ATTEMPT_REPLACED") {
        await fail(projectRoot, templateId, resolvedAttemptId, error.message).catch(() => null);
      }
      throw error;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  });
  return {
    accepted: true,
    attemptId: resolvedAttemptId,
    recoveredStale: Boolean(claimResult.recoveredStale),
    claim: claimResult,
    taskPromise
  };
}
