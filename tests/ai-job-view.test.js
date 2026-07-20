import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAiJobSnapshot,
  normalizeBannerJobs,
  normalizeMaterialJobs,
  normalizeTemplateJobs,
  safeJobError
} from "../src/core/ai-job-view.js";

const NOW = new Date("2026-07-20T12:00:00.000Z");

test("内部LP解析は工程とheartbeat staleを正規化する", () => {
  const jobs = normalizeMaterialJobs({
    jobs: [{
      id: "extract_1",
      materialId: "mat_1",
      status: "running",
      startedAt: "2026-07-20T11:40:00.000Z",
      progressAt: "2026-07-20T11:45:00.000Z",
      steps: [
        { key: "capture", label: "画面取得", status: "completed" },
        { label: "画像内文字を解析", status: "running", detail: "2/5枚" }
      ]
    }],
    materials: [{ id: "mat_1", title: "記事LP", sourceUrl: "https://example.com/lp" }],
    now: NOW
  });

  assert.equal(jobs[0].id, "material:extract_1");
  assert.equal(jobs[0].title, "記事LP");
  assert.equal(jobs[0].status, "stale");
  assert.equal(jobs[0].stage.label, "画像内文字を解析");
  assert.equal(jobs[0].stage.completedCount, 2);
  assert.equal(jobs[0].stage.totalCount, 5);
});

test("内部LP解析の警告あり完了は安全化した警告内容をnoteで返す", () => {
  const jobs = normalizeMaterialJobs({
    jobs: [{
      id: "extract_warning",
      materialId: "mat_warning",
      status: "completed",
      startedAt: "2026-07-20T11:50:00.000Z",
      finishedAt: "2026-07-20T11:59:00.000Z",
      errorMessage: "一部失敗 /Users/test/private.json"
    }],
    materials: [{ id: "mat_warning", title: "警告ありLP" }],
    now: NOW
  });

  assert.equal(jobs[0].status, "completed_with_warnings");
  assert.match(jobs[0].note, /一部失敗/);
  assert.doesNotMatch(jobs[0].note, /\/Users\/test/);
  assert.equal(jobs[0].errorMessage, "");
});

test("テンプレ解析はqueued/running/completed/failedと期限切れリースを正規化する", () => {
  const templates = normalizeTemplateJobs([
    { id: "tpl_q", title: "Q", templateProcessingStatus: "queued", templateAnalysisAttemptId: "a1", templateAnalysisQueuedAt: "2026-07-20T11:59:00.000Z" },
    { id: "tpl_r", title: "R", templateProcessingStatus: "running", templateAnalysisAttemptId: "a2", templateAnalysisStartedAt: "2026-07-20T11:58:00.000Z", templateAnalysisLease: { expiresAt: "2026-07-20T11:59:59.000Z" } },
    { id: "tpl_c", title: "C", templateProcessingStatus: "completed", templateAnalysisAttemptId: "a3", templateAnalysisCompletedAt: "2026-07-20T11:57:00.000Z" },
    { id: "tpl_f", title: "F", templateProcessingStatus: "failed", templateAnalysisAttemptId: "a4", templateAnalysisCompletedAt: "2026-07-20T11:56:00.000Z", templateAnalysisError: "boom" }
  ], { now: NOW });

  assert.deepEqual(templates.map((job) => job.status), ["queued", "stale", "completed", "failed"]);
  assert.equal(templates[0].scope, "shared");
  assert.equal(templates[1].statusLabel, "中断の可能性");
});

test("バナー3工程・画像修正・warning・回復状態を正規化する", () => {
  const jobs = normalizeBannerJobs([
    {
      id: "ban_1",
      title: "バナー案 01",
      productionStatus: "prompt_generating",
      imageGenerationStatus: "not_started",
      pipelineNodes: {
        copyplan: { status: "completed", attemptId: "p1", completedAt: "2026-07-20T11:57:00.000Z" },
        prompt: { status: "running", attemptId: "p2", startedAt: "2026-07-20T11:58:00.000Z" },
        image: { status: "pending" }
      }
    },
    {
      id: "ban_2",
      title: "範囲修正",
      imageGenerationStatus: "generating",
      imageGenerationLease: { attemptId: "e1", operationKind: "edit", editMode: "range", expiresAt: "2026-07-20T12:05:00.000Z" },
      updatedAt: "2026-07-20T11:59:00.000Z"
    },
    {
      id: "ban_3",
      title: "警告完了",
      productionStatus: "completed_with_warnings",
      imageGenerationStatus: "completed",
      pipelineNodes: { image: { status: "completed_with_warnings", attemptId: "i3", completedAt: "2026-07-20T11:59:00.000Z" } },
      jobRecoveryAudit: { lastAction: "image_requeued" }
    },
    {
      id: "ban_4",
      title: "全体修正",
      imageGenerationStatus: "queued",
      imageGenerationLease: { attemptId: "e2", operationKind: "edit", editMode: "full", queuedAt: "2026-07-20T11:59:30.000Z", expiresAt: "2026-07-20T12:05:00.000Z" }
    },
    {
      id: "ban_5",
      title: "期限切れ画像生成",
      imageGenerationStatus: "generating",
      pipelineNodes: { image: { status: "running", attemptId: "i5", startedAt: "2026-07-20T11:50:00.000Z" } },
      imageGenerationLease: { attemptId: "i5", expiresAt: "2026-07-20T11:59:59.000Z" }
    }
  ], { now: NOW });

  assert.equal(jobs[0].stage.key, "prompt");
  assert.equal(jobs[0].steps.length, 3);
  assert.equal(jobs[1].kind, "banner_image_edit");
  assert.equal(jobs[1].stage.label, "範囲指定修正");
  assert.equal(jobs[2].status, "completed_with_warnings");
  assert.match(jobs[2].note, /サーバー再起動後/);
  assert.equal(jobs[3].kind, "banner_image_edit");
  assert.equal(jobs[3].stage.label, "全体修正");
  assert.equal(jobs[4].status, "stale");
});

test("safeJobErrorは秘密情報・絶対パス・JSON本文を隠して300文字以内にする", () => {
  const value = safeJobError(
    'Authorization: Bearer sk-proj-abcdefghijklmnopqrstuvwxyz /Users/test/secret.json /tmp/private.json C:\\private\\key.json {"prompt":"secret prompt","input":"secret"}',
    "AI処理に失敗しました。"
  );
  assert.ok(value.length <= 300);
  assert.doesNotMatch(value, /sk-proj|\/Users\/test|\/tmp\/private|C:\\private|secret prompt|Bearer/);
  assert.match(value, /\[非表示\]/);
  assert.equal(safeJobError("", "既定エラー"), "既定エラー");
});

test("snapshotはactiveを全件、recentを期間・limit内で優先順に返す", () => {
  const jobs = [
    { id: "running", status: "running", updatedAt: "2026-07-20T11:00:00.000Z" },
    { id: "failed", status: "failed", updatedAt: "2026-07-20T11:59:00.000Z", finishedAt: "2026-07-20T11:59:00.000Z" },
    { id: "done-new", status: "completed", updatedAt: "2026-07-20T11:58:00.000Z", finishedAt: "2026-07-20T11:58:00.000Z" },
    { id: "done-old", status: "completed", updatedAt: "2026-07-20T10:00:00.000Z", finishedAt: "2026-07-20T10:00:00.000Z" }
  ];
  const snapshot = buildAiJobSnapshot({ jobs, now: NOW, recentLimit: 1, snapshotVersion: "v1" });

  assert.equal(snapshot.activeCount, 1);
  assert.deepEqual(snapshot.jobs.map((job) => job.id), ["failed", "running"]);
  assert.equal(snapshot.snapshotVersion, "v1");
});
