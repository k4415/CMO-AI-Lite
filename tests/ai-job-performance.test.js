import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createAiJobSourceCache } from "../src/core/ai-job-source-cache.js";
import { FifoWorkerPool } from "../src/core/job-queue.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("大容量sourceの定常pollとbanner集中更新が性能基準内に収まる", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-ai-job-perf-"));
  const projectRoot = path.join(tempRoot, "projects", "test");
  const projectData = path.join(projectRoot, "data");
  const sharedData = path.join(tempRoot, "data");
  await fs.mkdir(projectData, { recursive: true });
  await fs.mkdir(sharedData, { recursive: true });
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));

  const templatePath = path.join(sharedData, "ad-templates.json");
  const bannerPath = path.join(projectData, "banner-creatives.json");
  const materialJobPath = path.join(projectData, "material-extraction-jobs.json");
  const materialPath = path.join(projectData, "research-materials.json");
  const templateBody = JSON.stringify([{
    id: "tpl_perf",
    title: "性能テンプレ",
    templateProcessingStatus: "completed",
    templateAnalysisAttemptId: "attempt_perf",
    templateAnalysisCompletedAt: "2026-07-20T11:00:00.000Z",
    rawAnalysis: "t".repeat(Math.floor(8.24 * 1024 * 1024))
  }]);
  const bannerBase = {
    id: "ban_perf",
    title: "性能バナー0",
    productionStatus: "completed",
    imageGenerationStatus: "completed",
    pipelineNodes: { image: { status: "completed", attemptId: "image_perf", completedAt: "2026-07-20T11:00:00.000Z" } },
    promptJson: "b".repeat(Math.floor(2.92 * 1024 * 1024))
  };
  const bannerBody = (index) => JSON.stringify([{ ...bannerBase, title: `性能バナー${String(index % 10)}` }]);
  await Promise.all([
    fs.writeFile(templatePath, templateBody),
    fs.writeFile(bannerPath, bannerBody(0)),
    fs.writeFile(materialJobPath, JSON.stringify([{ id: "job_perf", materialId: "mat_perf", status: "completed", finishedAt: "2026-07-20T11:00:00.000Z" }])),
    fs.writeFile(materialPath, JSON.stringify([{ id: "mat_perf", title: "性能LP", text: "本文はprojectionで破棄" }]))
  ]);

  const reads = new Map();
  const fsApi = {
    stat: (...args) => fs.stat(...args),
    readFile: async (filePath, ...args) => {
      reads.set(filePath, (reads.get(filePath) || 0) + 1);
      return fs.readFile(filePath, ...args);
    }
  };
  const cache = createAiJobSourceCache({ fsApi, retryDelays: [] });
  const args = { projectRoot, sharedTemplatesPath: templatePath };
  await cache.loadSources(args);
  assert.ok(Buffer.byteLength(templateBody) >= 8.24 * 1024 * 1024);
  assert.ok(Buffer.byteLength(bannerBody(0)) >= 2.92 * 1024 * 1024);

  const hitDurations = [];
  for (let index = 0; index < 100; index += 1) {
    const startedAt = performance.now();
    await cache.loadSources(args);
    hitDurations.push(performance.now() - startedAt);
  }
  assert.ok(p95(hitDurations) < 10, `cache hit p95=${p95(hitDurations).toFixed(2)}ms`);
  assert.equal(reads.get(templatePath), 1);
  assert.equal(reads.get(bannerPath), 1);
  assert.equal(reads.get(materialJobPath), 1);
  assert.equal(reads.get(materialPath), 1);

  const coldDurations = [];
  for (let index = 1; index <= 20; index += 1) {
    await fs.writeFile(bannerPath, bannerBody(index));
    const timestamp = new Date(Date.now() + index * 1000);
    await fs.utimes(bannerPath, timestamp, timestamp);
    const startedAt = performance.now();
    await cache.loadSources(args);
    coldDurations.push(performance.now() - startedAt);
  }
  assert.ok(p95(coldDurations) < 25, `banner cold p95=${p95(coldDurations).toFixed(2)}ms`);
  assert.equal(reads.get(templatePath), 1, "未変更の共有テンプレは再読込しない");
  assert.equal(reads.get(bannerPath), 21);

  const baseline = await runWorkerScenario({ withMonitor: false, cache, args });
  const monitored = await runWorkerScenario({ withMonitor: true, cache, args });
  assert.equal(baseline.maxActive, 10);
  assert.equal(monitored.maxActive, 10);
  assert.ok(Math.abs(monitored.startP95 - baseline.startP95) < 50, `worker start p95 diff=${Math.abs(monitored.startP95 - baseline.startP95).toFixed(2)}ms`);
  assert.ok(Math.abs(monitored.totalMs - baseline.totalMs) / baseline.totalMs < 0.03, `worker total diff=${(100 * Math.abs(monitored.totalMs - baseline.totalMs) / baseline.totalMs).toFixed(2)}%`);
  t.diagnostic(`cache hit p95=${p95(hitDurations).toFixed(2)}ms, banner cold p95=${p95(coldDurations).toFixed(2)}ms`);
  t.diagnostic(`worker start p95 diff=${Math.abs(monitored.startP95 - baseline.startP95).toFixed(2)}ms, total diff=${(100 * Math.abs(monitored.totalMs - baseline.totalMs) / baseline.totalMs).toFixed(2)}%`);
});

test("AIジョブGET routeはworker・semaphore・復旧・AIを呼ばない", async () => {
  const source = await fs.readFile(path.join(repoRoot, "src", "server.js"), "utf8");
  const route = source.match(/if \(url\.pathname === "\/api\/ai-jobs"[\s\S]*?\n    }\n\n\n    const productMatch/)?.[0] || "";
  assert.ok(route);
  assert.doesNotMatch(route, /promptWorkerPool|imageWorkerPool|templateAnalysisWorkerPool|acquireFileSemaphore|recover|generateWhoWhat|extractProductFacts|openai|anthropic|withFileLock/i);
});

async function runWorkerScenario({ withMonitor, cache, args }) {
  const pool = new FifoWorkerPool(10);
  const starts = [];
  const monitorPromises = new Set();
  let active = 0;
  let maxActive = 0;
  const startedAt = performance.now();
  const timer = withMonitor ? setInterval(() => {
    const promise = cache.loadSources(args).finally(() => monitorPromises.delete(promise));
    monitorPromises.add(promise);
  }, 3) : null;
  const jobs = Array.from({ length: 10 }, () => pool.run(async () => {
    starts.push(performance.now() - startedAt);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await delay(250);
    active -= 1;
  }));
  await Promise.all(jobs);
  if (timer) clearInterval(timer);
  await Promise.all(monitorPromises);
  return { maxActive, startP95: p95(starts), totalMs: performance.now() - startedAt };
}

function p95(values) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)] || 0;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
