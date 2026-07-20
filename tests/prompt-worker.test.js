import test from "node:test";
import assert from "node:assert/strict";

import {
  createPromptWorkerPool,
  normalizePromptConcurrency,
  runPromptJobsInPool
} from "../src/core/prompt-worker.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function waitUntil(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timeout");
    await wait(1);
  }
}

test("prompt workerは既定10並列で上限も10に固定する", () => {
  assert.equal(normalizePromptConcurrency(undefined), 10);
  assert.equal(normalizePromptConcurrency(10), 10);
  assert.equal(normalizePromptConcurrency(11), 10);
  assert.equal(normalizePromptConcurrency(0), 1);
});

test("prompt workerは10件を同時実行し、11件目を待機させる", async () => {
  const pool = createPromptWorkerPool(10);
  const release = deferred();
  let active = 0;
  let peak = 0;
  const starts = [];
  const settledPromise = runPromptJobsInPool(
    pool,
    Array.from({ length: 11 }, (_, index) => ({ id: index + 1 })),
    async (job) => {
      starts.push(job.id);
      active += 1;
      peak = Math.max(peak, active);
      await release.promise;
      active -= 1;
      return job.id;
    }
  );

  await waitUntil(() => peak === 10);
  assert.equal(peak, 10);
  assert.deepEqual(starts, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

  release.resolve();
  const settled = await settledPromise;
  assert.equal(settled.length, 11);
  assert.ok(settled.every((item) => item.status === "fulfilled"));
  assert.deepEqual(starts, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});
