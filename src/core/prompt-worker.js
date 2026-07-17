import { FifoWorkerPool } from "./job-queue.js";

export function normalizePromptConcurrency(value, fallback = 10) {
  if (value === undefined || value === null || value === "") return Math.min(10, Math.max(1, Math.floor(Number(fallback) || 10)));
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return Math.min(10, Math.max(1, Math.floor(Number(fallback) || 10)));
  return Math.min(10, Math.max(1, Math.floor(numeric)));
}

export function createPromptWorkerPool(concurrency = 10) {
  return new FifoWorkerPool(normalizePromptConcurrency(concurrency));
}

export async function runPromptJobsInPool(pool, jobs, runJob, cleanup = null) {
  const tasks = (jobs || []).map((job) => pool.run(async () => {
    try {
      return await runJob(job);
    } finally {
      if (cleanup) await cleanup(job);
    }
  }));
  return Promise.allSettled(tasks);
}
