import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPromptWorkerPool, normalizePromptConcurrency, runPromptJobsInPool } from "../src/core/prompt-worker.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("normalizePromptConcurrencyは既定値10で、1〜10に制限する", () => {
  assert.equal(normalizePromptConcurrency(undefined), 10);
  assert.equal(normalizePromptConcurrency(""), 10);
  assert.equal(normalizePromptConcurrency("0"), 1);
  assert.equal(normalizePromptConcurrency("-2"), 1);
  assert.equal(normalizePromptConcurrency("5"), 5);
  assert.equal(normalizePromptConcurrency("11"), 10);
});

test("runPromptJobsInPoolは指定concurrencyまで同時実行し、jobごとにcleanupする", async () => {
  const pool = createPromptWorkerPool(3);
  let active = 0;
  let maxActive = 0;
  const cleaned = [];
  const jobs = Array.from({ length: 5 }, (_, index) => ({ id: `job_${index}` }));

  const results = await runPromptJobsInPool(pool, jobs, async (job) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await delay(20);
    active -= 1;
    return job.id;
  }, (job) => cleaned.push(job.id));

  assert.equal(maxActive, 3);
  assert.deepEqual(results.map((item) => item.value).sort(), jobs.map((job) => job.id).sort());
  assert.deepEqual(cleaned.sort(), jobs.map((job) => job.id).sort());
});

test("同じpoolに後続バッチを投入しても先行バッチ完了待ちの案件単位直列にはならない", async () => {
  const pool = createPromptWorkerPool(3);
  let active = 0;
  let maxActive = 0;
  let releaseFirstBatch;
  const firstBatchGate = new Promise((resolve) => { releaseFirstBatch = resolve; });

  const firstBatch = runPromptJobsInPool(pool, [{ id: "a" }, { id: "b" }], async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await firstBatchGate;
    active -= 1;
    return "first";
  });

  await delay(10);
  const secondBatch = runPromptJobsInPool(pool, [{ id: "c" }, { id: "d" }], async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await delay(10);
    active -= 1;
    return "second";
  });

  await delay(10);
  assert.equal(maxActive, 3);
  releaseFirstBatch();
  await Promise.all([firstBatch, secondBatch]);
});

test("banner text処理は案件別ではなくアプリ共通のopenai-text semaphoreを使う", async () => {
  const source = await fs.readFile(path.join(repoRoot, "src", "server.js"), "utf8");
  assert.match(source, /data["'],\s*["']\.runtime["'],\s*["']openai-text["']/);
  assert.doesNotMatch(source, /data["'],\s*["']\.runtime["'],\s*["']prompt-generation["']/);
  assert.match(source, /runCopyGroup:\s*\(task\)\s*=>\s*promptWorkerPool\.run\(\(\)\s*=>\s*withGlobalTextSlot\(task\)\)/);
});
