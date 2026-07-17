import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  addAdTemplate,
  claimTemplateAnalysis,
  completeTemplateAnalysis,
  getAdTemplateStatuses,
  listAdTemplates,
  recoverTemplateAnalysisJobs,
  renewTemplateAnalysisLease,
  startTemplateAnalysis,
  updateAdTemplate
} from "../src/core/ad-template-store.js";
import {
  createTemplateAnalysisWorkerPool,
  enqueueTemplateAnalysisJob,
  normalizeTemplateAnalysisConcurrency
} from "../src/core/template-analysis-worker.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("テンプレ解析の並列数は既定10、最小1、最大10に制限する", () => {
  assert.equal(normalizeTemplateAnalysisConcurrency(undefined), 10);
  assert.equal(normalizeTemplateAnalysisConcurrency(""), 10);
  assert.equal(normalizeTemplateAnalysisConcurrency("0"), 1);
  assert.equal(normalizeTemplateAnalysisConcurrency("3"), 3);
  assert.equal(normalizeTemplateAnalysisConcurrency("9"), 9);
  assert.equal(normalizeTemplateAnalysisConcurrency("11"), 10);
});

test("テンプレ解析ワーカープールは異なるテンプレを指定上限まで並列実行する", async () => {
  const pool = createTemplateAnalysisWorkerPool(3);
  let active = 0;
  let maxActive = 0;
  const tasks = Array.from({ length: 5 }, (_, index) => pool.run(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await delay(15);
    active -= 1;
    return index;
  }));

  assert.deepEqual(await Promise.all(tasks), [0, 1, 2, 3, 4]);
  assert.equal(maxActive, 3);
});

test("enqueueは解析完了を待たずに受付結果とtaskPromiseを返す", async () => {
  const pool = createTemplateAnalysisWorkerPool(1);
  let releaseAnalysis;
  const analysisGate = new Promise((resolve) => { releaseAnalysis = resolve; });
  const events = [];

  const job = await enqueueTemplateAnalysisJob({
    pool,
    projectRoot: "/tmp/project",
    templateId: "tpl_1",
    ownerId: "server-a",
    leaseMs: 60_000,
    claim: async () => ({
      claimed: true,
      template: { templateAnalysisAttemptId: "attempt-1", templateProcessingStatus: "queued" }
    }),
    start: async () => { events.push("started"); },
    renew: async () => null,
    runWithAnalysisSlot: async (task) => {
      events.push("slot-acquired");
      try {
        return await task();
      } finally {
        events.push("slot-released");
      }
    },
    analyze: async () => {
      events.push("analyzing");
      await analysisGate;
      return { successFactors: "done" };
    },
    complete: async (_projectRoot, _templateId, _attemptId, patch) => {
      events.push("completed");
      return patch;
    },
    fail: async () => { events.push("failed"); }
  });

  assert.equal(job.accepted, true);
  assert.equal(job.attemptId, "attempt-1");
  assert.equal(typeof job.taskPromise?.then, "function");
  await delay(0);
  assert.deepEqual(events, ["started", "slot-acquired", "analyzing"]);
  releaseAnalysis();
  assert.deepEqual(await job.taskPromise, { successFactors: "done" });
  assert.deepEqual(events, ["started", "slot-acquired", "analyzing", "slot-released", "completed"]);
});

test("同じ復旧attemptが重複スケジュールされても後発側は先発側を失敗にしない", async () => {
  const pool = createTemplateAnalysisWorkerPool(2);
  let started = false;
  let analyzeCount = 0;
  let failCount = 0;
  let releaseAnalysis;
  const analysisGate = new Promise((resolve) => { releaseAnalysis = resolve; });
  const start = async () => {
    if (started) {
      const error = new Error("テンプレート解析は別の実行へ移りました。");
      error.code = "TEMPLATE_ANALYSIS_ATTEMPT_REPLACED";
      throw error;
    }
    started = true;
  };
  const options = {
    pool,
    projectRoot: "/tmp/project",
    templateId: "tpl_recovered",
    ownerId: "server-a",
    attemptId: "attempt-recovered",
    start,
    renew: async () => null,
    analyze: async () => {
      analyzeCount += 1;
      await analysisGate;
      return { successFactors: "done" };
    },
    complete: async (_projectRoot, _templateId, _attemptId, patch) => patch,
    fail: async () => { failCount += 1; }
  };

  const first = await enqueueTemplateAnalysisJob(options);
  const duplicate = await enqueueTemplateAnalysisJob(options);
  const resultsPromise = Promise.allSettled([first.taskPromise, duplicate.taskPromise]);
  await delay(0);
  releaseAnalysis();
  const results = await resultsPromise;

  assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(analyzeCount, 1);
  assert.equal(failCount, 0);
});

test("テンプレ解析状態を永続化し、二重受付を拒否して期限切れだけを復旧する", async (t) => {
  const originalCwd = process.cwd();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-template-analysis-"));
  t.after(async () => {
    process.chdir(originalCwd);
    await fs.rm(tempRoot, { recursive: true, force: true });
  });
  process.chdir(tempRoot);

  const staleTemplate = await addAdTemplate(tempRoot, { title: "期限切れ", imageFile: "/stale.png" });
  const queuedTemplate = await addAdTemplate(tempRoot, { title: "待機中", imageFile: "/queued.png" });
  const activeTemplate = await addAdTemplate(tempRoot, { title: "実行中", imageFile: "/active.png" });

  const staleClaim = await claimTemplateAnalysis(tempRoot, staleTemplate.id, {
    ownerId: "server-a",
    attemptId: "attempt-stale",
    leaseMs: 60_000
  });
  assert.equal(staleClaim.claimed, true);
  assert.equal(staleClaim.template.templateProcessingStatus, "queued");
  assert.equal(staleClaim.template.templateStatus, "template_generating");

  const duplicate = await claimTemplateAnalysis(tempRoot, staleTemplate.id, {
    ownerId: "server-b",
    attemptId: "attempt-duplicate",
    leaseMs: 60_000
  });
  assert.equal(duplicate.claimed, false);
  assert.equal(duplicate.reason, "active");

  await startTemplateAnalysis(tempRoot, staleTemplate.id, "attempt-stale", {
    ownerId: "server-a",
    leaseMs: 60_000
  });
  await claimTemplateAnalysis(tempRoot, queuedTemplate.id, {
    ownerId: "server-a",
    attemptId: "attempt-queued",
    leaseMs: 60_000
  });
  await claimTemplateAnalysis(tempRoot, activeTemplate.id, {
    ownerId: "server-a",
    attemptId: "attempt-active",
    leaseMs: 60_000
  });
  const active = await startTemplateAnalysis(tempRoot, activeTemplate.id, "attempt-active", {
    ownerId: "server-a",
    leaseMs: 60_000
  });
  const renewed = await renewTemplateAnalysisLease(tempRoot, activeTemplate.id, "attempt-active", 120_000);
  assert.ok(Date.parse(renewed.templateAnalysisLease.expiresAt) > Date.now() + 110_000);

  await updateAdTemplate(tempRoot, staleTemplate.id, {
    templateAnalysisLease: {
      ...staleClaim.template.templateAnalysisLease,
      attemptId: "attempt-stale",
      expiresAt: new Date(Date.now() - 1_000).toISOString()
    }
  });

  const recovered = await recoverTemplateAnalysisJobs(tempRoot, {
    ownerId: "server-b",
    leaseMs: 60_000,
    attemptIdFactory: () => "attempt-recovered"
  });
  const recoveredById = new Map(recovered.map((job) => [job.templateId, job]));
  assert.equal(recoveredById.get(staleTemplate.id).attemptId, "attempt-recovered");
  assert.equal(recoveredById.get(queuedTemplate.id).attemptId, "attempt-queued");
  assert.equal(recoveredById.has(activeTemplate.id), false);

  await assert.rejects(
    completeTemplateAnalysis(tempRoot, staleTemplate.id, "attempt-stale", { successFactors: "古い結果" }),
    (error) => error.code === "TEMPLATE_ANALYSIS_ATTEMPT_REPLACED"
  );
  await startTemplateAnalysis(tempRoot, staleTemplate.id, "attempt-recovered", {
    ownerId: "server-b",
    leaseMs: 60_000
  });
  const completed = await completeTemplateAnalysis(tempRoot, staleTemplate.id, "attempt-recovered", {
    successFactors: "新しい結果"
  });
  assert.equal(completed.templateProcessingStatus, "completed");
  assert.equal(completed.templateStatus, "template_ready");
  assert.equal(completed.templateAnalysisLease, null);
  assert.equal(completed.successFactors, "新しい結果");

  const statuses = await getAdTemplateStatuses(tempRoot, [staleTemplate.id, queuedTemplate.id, activeTemplate.id]);
  assert.deepEqual(statuses.map((item) => item.templateId).sort(), [activeTemplate.id, queuedTemplate.id, staleTemplate.id].sort());
  assert.equal(statuses.find((item) => item.templateId === staleTemplate.id).templateProcessingStatus, "completed");
  assert.equal(statuses.find((item) => item.templateId === activeTemplate.id).templateAnalysisStartedAt, active.templateAnalysisStartedAt);

  const saved = await listAdTemplates();
  assert.equal(saved.find((item) => item.id === staleTemplate.id).templateAnalysisAttemptId, "attempt-recovered");
});

test("旧テンプレ状態を新しい解析処理状態へ読み替える", async (t) => {
  const originalCwd = process.cwd();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-template-legacy-status-"));
  t.after(async () => {
    process.chdir(originalCwd);
    await fs.rm(tempRoot, { recursive: true, force: true });
  });
  process.chdir(tempRoot);
  await fs.mkdir(path.join(tempRoot, "data"), { recursive: true });
  await fs.writeFile(path.join(tempRoot, "data", "ad-templates.json"), JSON.stringify([
    { id: "tpl_running", title: "実行中", creativeType: "banner", templateStatus: "template_generating" },
    { id: "tpl_failed", title: "失敗", creativeType: "banner", templateStatus: "failed" },
    { id: "tpl_ready", title: "完了", creativeType: "banner", templateStatus: "template_ready" },
    { id: "tpl_new", title: "未着手", creativeType: "banner", templateStatus: "not_started" }
  ], null, 2));

  const templates = await listAdTemplates();
  const statusById = new Map(templates.map((item) => [item.id, item.templateProcessingStatus]));

  assert.equal(statusById.get("tpl_running"), "running");
  assert.equal(statusById.get("tpl_failed"), "failed");
  assert.equal(statusById.get("tpl_ready"), "completed");
  assert.equal(statusById.get("tpl_new"), "not_started");
});

test("空の共通DBへ同時追加しても初期化競合でレコードを失わない", async (t) => {
  const originalCwd = process.cwd();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-template-first-write-"));
  t.after(async () => {
    process.chdir(originalCwd);
    await fs.rm(tempRoot, { recursive: true, force: true });
  });
  process.chdir(tempRoot);

  await Promise.all([
    addAdTemplate(tempRoot, { title: "A", imageFile: "/a.png" }),
    addAdTemplate(tempRoot, { title: "B", imageFile: "/b.png" })
  ]);

  const templates = await listAdTemplates();
  assert.deepEqual(templates.map((item) => item.title).sort(), ["A", "B"]);
});
