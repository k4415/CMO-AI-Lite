import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { FifoWorkerPool, KeyedFifoQueue } from "../src/core/job-queue.js";
import { getImageRequestTimeoutMs } from "../src/core/openai-image.js";
import { getTextRequestTimeoutMs, getVisionJsonRequestTimeoutMs } from "../src/core/openai-text.js";
import {
  addBannerCreative,
  claimBannerImageGeneration,
  claimBannerPromptGeneration,
  completeBannerPromptOperation,
  completeBannerImageGeneration,
  failBannerImageGeneration,
  failBannerPromptGeneration,
  releaseBannerPromptGeneration,
  renewBannerImageGenerationLease,
  renewBannerPromptGenerationLease,
  startBannerImageGeneration,
  updateBannerCreative,
  listBannerCreatives,
  reconcileBannerPipeline
} from "../src/core/banner-store.js";

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

test("keyed queue runs jobs for the same project in FIFO order", async () => {
  const queue = new KeyedFifoQueue();
  const events = [];
  const jobs = [1, 2, 3].map((number) => queue.run("project-a", async () => {
    events.push(`start-${number}`);
    await wait(5);
    events.push(`end-${number}`);
    return number;
  }));

  assert.deepEqual(await Promise.all(jobs), [1, 2, 3]);
  assert.deepEqual(events, ["start-1", "end-1", "start-2", "end-2", "start-3", "end-3"]);
});

test("prompt lease rejects duplicate submissions and ignores an old attempt", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-prompt-lease-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  const banner = await addBannerCreative(projectRoot, { productId: "p1", strategyId: "s1", title: "test" });

  const first = await claimBannerPromptGeneration(projectRoot, banner.id, {
    ownerId: "server-a",
    attemptId: "prompt-a",
    leaseMs: 60000
  });
  assert.equal(first.claimed, true);
  const duplicate = await claimBannerPromptGeneration(projectRoot, banner.id, {
    ownerId: "server-b",
    attemptId: "prompt-b",
    leaseMs: 60000
  });
  assert.equal(duplicate.claimed, false);
  const renewed = await renewBannerPromptGenerationLease(projectRoot, banner.id, "prompt-a", 120000);
  assert.ok(Date.parse(renewed.promptGenerationLease.expiresAt) > Date.now() + 110000);
  const ignored = await failBannerPromptGeneration(projectRoot, banner.id, "prompt-b", "old failure");
  assert.equal(ignored, null);
});

test("同じstrategyIdの本文が処理中に変わった場合は古いprompt attemptを保存しない", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-prompt-input-cas-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "data", "products.json"), JSON.stringify([{ id: "p1", name: "商品" }]));
  await fs.writeFile(path.join(projectRoot, "data", "strategies.json"), JSON.stringify([{ id: "s1", benefit: "制作を早める" }]));
  await fs.writeFile(path.join(projectRoot, "data", "expression-rules.json"), "[]");
  const banner = await addBannerCreative(projectRoot, { productId: "p1", strategyId: "s1", title: "input cas" });
  const workspace = {
    products: [{ id: "p1", name: "商品" }],
    strategies: [{ id: "s1", benefit: "制作を早める" }],
    expressionRules: [],
    adTemplates: []
  };
  const pipeline = await reconcileBannerPipeline(projectRoot, banner.id, workspace);
  await claimBannerPromptGeneration(projectRoot, banner.id, {
    ownerId: "server-a",
    attemptId: "prompt-old-input",
    startNode: pipeline.nextNode,
    inputHash: pipeline.expectedInputHashes[pipeline.nextNode],
    leaseMs: 60000
  });

  await fs.writeFile(path.join(projectRoot, "data", "strategies.json"), JSON.stringify([{ id: "s1", benefit: "制作を5分の1にする" }]));

  await assert.rejects(
    completeBannerPromptOperation(projectRoot, banner.id, "prompt-old-input", { promptJson: { stale: true }, promptText: "stale" }),
    (error) => error.code === "STALE_PIPELINE_ATTEMPT"
  );
  const [stored] = await listBannerCreatives(projectRoot);
  assert.equal(stored.promptJson, null);
});

test("画像サイズ変更はcopyBriefと勝ち筋仮説を保持してprompt以降だけ無効化する", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-prompt-only-invalidation-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  const banner = await addBannerCreative(projectRoot, { productId: "p1", strategyId: "s1", title: "prompt invalidation" });
  await updateBannerCreative(projectRoot, banner.id, {
    approvedClaimSnapshot: { snapshotId: "acs_1", contentHash: "sha256:snapshot" },
    creativeHypothesis: { hypothesisId: "hyp_1", contentHash: "sha256:hypothesis" },
    copyBrief: { version: 4, copyBriefHash: "sha256:copy", mainHook: "固定コピー" },
    imageText: "固定コピー",
    promptJson: { zones: [] },
    promptText: "prompt"
  });

  const updated = await updateBannerCreative(projectRoot, banner.id, { imageSize: "1200x628" });

  assert.equal(updated.copyBrief.mainHook, "固定コピー");
  assert.equal(updated.creativeHypothesis.hypothesisId, "hyp_1");
  assert.equal(updated.approvedClaimSnapshot.snapshotId, "acs_1");
  assert.equal(updated.promptJson, null);
  assert.equal(updated.pipelineNodes.prompt.status, "pending");
  assert.equal(updated.pipelineNodes.image.status, "pending");
});

test("copy review failureの状態と理由を保ったままprompt leaseだけ解放する", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-prompt-release-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  const banner = await addBannerCreative(projectRoot, { productId: "p1", strategyId: "s1", title: "test" });
  await claimBannerPromptGeneration(projectRoot, banner.id, {
    ownerId: "server-a",
    attemptId: "prompt-a",
    leaseMs: 60000
  });
  await updateBannerCreative(projectRoot, banner.id, {
    productionStatus: "copy_review_failed",
    lastError: "品質スコア未達",
    lastErrorAt: "2026-07-16T00:00:00.000Z"
  });

  const released = await releaseBannerPromptGeneration(projectRoot, banner.id, "prompt-a");

  assert.equal(released.promptGenerationLease, null);
  assert.equal(released.productionStatus, "copy_review_failed");
  assert.equal(released.lastError, "品質スコア未達");
  assert.equal(released.lastErrorAt, "2026-07-16T00:00:00.000Z");
});

test("matching prompt failureは内部inputHash差分があってもleaseを解放する", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-prompt-fail-cleanup-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "data", "products.json"), JSON.stringify([{ id: "p1", name: "商品" }]));
  await fs.writeFile(path.join(projectRoot, "data", "strategies.json"), JSON.stringify([{ id: "s1", benefit: "制作を早める" }]));
  await fs.writeFile(path.join(projectRoot, "data", "expression-rules.json"), "[]");
  const banner = await addBannerCreative(projectRoot, { productId: "p1", strategyId: "s1", title: "cleanup" });
  const workspace = {
    products: [{ id: "p1", name: "商品" }],
    strategies: [{ id: "s1", benefit: "制作を早める" }],
    expressionRules: [],
    adTemplates: []
  };
  const pipeline = await reconcileBannerPipeline(projectRoot, banner.id, workspace);
  await claimBannerPromptGeneration(projectRoot, banner.id, {
    ownerId: "server-a",
    attemptId: "prompt-cleanup",
    startNode: pipeline.nextNode,
    inputHash: pipeline.expectedInputHashes[pipeline.nextNode],
    leaseMs: 60000
  });
  await updateBannerCreative(projectRoot, banner.id, {
    generationRunId: "run-internal",
    candidateGroupId: "group-internal",
    candidateIndex: 0
  });

  const failed = await failBannerPromptGeneration(
    projectRoot,
    banner.id,
    "prompt-cleanup",
    "内部保存後に仮説生成へ失敗"
  );

  assert.equal(failed.promptGenerationLease, null);
  assert.equal(failed.productionStatus, "failed");
  assert.equal(failed.lastError, "内部保存後に仮説生成へ失敗");
});

test("matching prompt releaseは内部inputHash差分があっても既存失敗状態を保ってleaseだけ解放する", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-prompt-release-cleanup-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "data", "products.json"), JSON.stringify([{ id: "p1", name: "商品" }]));
  await fs.writeFile(path.join(projectRoot, "data", "strategies.json"), JSON.stringify([{ id: "s1", benefit: "制作を早める" }]));
  await fs.writeFile(path.join(projectRoot, "data", "expression-rules.json"), "[]");
  const banner = await addBannerCreative(projectRoot, { productId: "p1", strategyId: "s1", title: "release" });
  const workspace = {
    products: [{ id: "p1", name: "商品" }],
    strategies: [{ id: "s1", benefit: "制作を早める" }],
    expressionRules: [],
    adTemplates: []
  };
  const pipeline = await reconcileBannerPipeline(projectRoot, banner.id, workspace);
  await claimBannerPromptGeneration(projectRoot, banner.id, {
    ownerId: "server-a",
    attemptId: "prompt-release",
    startNode: pipeline.nextNode,
    inputHash: pipeline.expectedInputHashes[pipeline.nextNode],
    leaseMs: 60000
  });
  await updateBannerCreative(projectRoot, banner.id, {
    generationRunId: "run-internal",
    candidateGroupId: "group-internal",
    candidateIndex: 0,
    productionStatus: "copy_review_failed",
    lastError: "品質スコア未達",
    lastErrorAt: "2026-07-16T00:00:00.000Z"
  });

  const released = await releaseBannerPromptGeneration(projectRoot, banner.id, "prompt-release");

  assert.equal(released.promptGenerationLease, null);
  assert.equal(released.productionStatus, "copy_review_failed");
  assert.equal(released.lastError, "品質スコア未達");
  assert.equal(released.lastErrorAt, "2026-07-16T00:00:00.000Z");
});

test("前回attemptの上流completed nodeも現在attemptの後続保存前に再検査する", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-prompt-completed-node-cas-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "data", "products.json"), JSON.stringify([{ id: "p1", name: "商品" }]));
  await fs.writeFile(path.join(projectRoot, "data", "strategies.json"), JSON.stringify([{ id: "s1", benefit: "制作を早める" }]));
  await fs.writeFile(path.join(projectRoot, "data", "expression-rules.json"), "[]");
  const banner = await addBannerCreative(projectRoot, { productId: "p1", strategyId: "s1", title: "completed cas" });
  const workspace = {
    products: [{ id: "p1", name: "商品" }],
    strategies: [{ id: "s1", benefit: "制作を早める" }],
    expressionRules: [],
    adTemplates: []
  };
  const pipeline = await reconcileBannerPipeline(projectRoot, banner.id, workspace);
  await updateBannerCreative(projectRoot, banner.id, {
    pipelineNodes: {
      ...pipeline.pipelineNodes,
      copyplan: {
        ...pipeline.pipelineNodes.copyplan,
        status: "completed",
        inputHash: pipeline.expectedInputHashes.copyplan,
        outputHash: "sha256:test-output",
        attemptId: "prompt-previous"
      }
    }
  });
  await claimBannerPromptGeneration(projectRoot, banner.id, {
    ownerId: "server-a",
    attemptId: "prompt-current",
    startNode: "prompt",
    inputHash: pipeline.expectedInputHashes.prompt,
    leaseMs: 60000
  });
  await fs.writeFile(
    path.join(projectRoot, "data", "strategies.json"),
    JSON.stringify([{ id: "s1", benefit: "制作を5分の1にする" }])
  );

  await assert.rejects(
    completeBannerPromptOperation(projectRoot, banner.id, "prompt-current", {
      promptJson: { stale: true },
      promptText: "stale"
    }),
    (error) => error.code === "STALE_PIPELINE_ATTEMPT" && error.restartNode === "copyplan"
  );
  const [stored] = await listBannerCreatives(projectRoot);
  assert.equal(stored.promptJson, null);
  assert.equal(stored.promptGenerationLease.attemptId, "prompt-current");
});

test("戦略入力不足とテンプレート未準備の候補は画像生成を開始できない", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-copy-communication-block-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  for (const status of ["strategy_input_insufficient", "template_not_ready"]) {
    const banner = await addBannerCreative(projectRoot, { productId: "p1", strategyId: "s1", title: status });
    await updateBannerCreative(projectRoot, banner.id, { productionStatus: status });
    await assert.rejects(
      claimBannerImageGeneration(projectRoot, banner.id, { ownerId: "a", attemptId: `image-${status}`, leaseMs: 60000 }),
      (error) => error.code === "BANNER_COPY_REVIEW_BLOCKED"
    );
  }
});

test("an old image attempt cannot overwrite a newer lease", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-image-cas-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  const banner = await addBannerCreative(projectRoot, { productId: "p1", strategyId: "s1", title: "test" });
  await claimBannerImageGeneration(projectRoot, banner.id, { ownerId: "a", attemptId: "image-a", leaseMs: 60000 });
  await updateBannerCreative(projectRoot, banner.id, {
    imageGenerationLease: { ownerId: "b", attemptId: "image-b", expiresAt: new Date(Date.now() + 60000).toISOString() },
    imageGenerationStatus: "generating"
  });
  await assert.rejects(
    completeBannerImageGeneration(projectRoot, banner.id, "image-a", { generatedImagePath: "old.png" }),
    (error) => error.code === "IMAGE_ATTEMPT_REPLACED"
  );
  const failed = await failBannerImageGeneration(projectRoot, banner.id, "image-a", "old failure");
  assert.equal(failed.imageGenerationLease.attemptId, "image-b");
  assert.equal(failed.generatedImagePath, "");
});

test("画像生成失敗時にrequest id・prompt hash・所要時間の監査情報を保持する", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-image-audit-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  const banner = await addBannerCreative(projectRoot, { productId: "p1", strategyId: "s1", title: "audit" });
  await claimBannerImageGeneration(projectRoot, banner.id, { ownerId: "a", attemptId: "image-audit", leaseMs: 60000 });

  const audit = {
    version: 1,
    selectedAttempt: null,
    attempts: [{
      attempt: 1,
      requestId: "req_test",
      promptHash: "sha256:prompt",
      promptLength: 1234,
      durationMs: 4321,
      outcome: "gross_mismatch"
    }]
  };
  const failed = await failBannerImageGeneration(projectRoot, banner.id, "image-audit", "無関係な画像が返されました。", {
    imageGenerationAudit: audit
  });

  assert.deepEqual(failed.imageGenerationAudit, audit);
  assert.equal(failed.imageGenerationStatus, "failed");
});

test("画像ノードはAPI処理開始と完了の時刻・所要時間を保存する", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-image-node-timing-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  const banner = await addBannerCreative(projectRoot, { productId: "p1", strategyId: "s1", title: "timing" });
  await claimBannerImageGeneration(projectRoot, banner.id, {
    ownerId: "server-a",
    attemptId: "image-timing",
    leaseMs: 60000
  });

  const started = await startBannerImageGeneration(projectRoot, banner.id, "image-timing");
  assert.ok(Number.isFinite(Date.parse(started.pipelineNodes.image.startedAt)));
  assert.equal(started.pipelineNodes.image.completedAt, "");

  const completed = await completeBannerImageGeneration(projectRoot, banner.id, "image-timing", {
    generatedImagePath: "outputs/banners/timing.png",
    generatedImageHash: "sha256:timing",
    generatedImageModel: "gpt-image-2",
    generatedImageSize: "1024x1024"
  });
  assert.ok(Number.isFinite(Date.parse(completed.pipelineNodes.image.completedAt)));
  assert.ok(completed.pipelineNodes.image.durationMs >= 0);
  assert.equal(
    completed.pipelineNodes.image.durationMs,
    Date.parse(completed.pipelineNodes.image.completedAt) - Date.parse(completed.pipelineNodes.image.startedAt)
  );
});

test("worker pool keeps at most two image jobs active and starts them FIFO", async () => {
  const pool = new FifoWorkerPool(2);
  let active = 0;
  let maxActive = 0;
  const starts = [];
  const jobs = [1, 2, 3, 4].map((number) => pool.run(async () => {
    starts.push(number);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await wait(number < 3 ? 15 : 2);
    active -= 1;
    return number;
  }));

  assert.deepEqual(await Promise.all(jobs), [1, 2, 3, 4]);
  assert.equal(maxActive, 2);
  assert.deepEqual(starts, [1, 2, 3, 4]);
});

test("worker poolは10件を同時実行し、11件目を待機させる", async () => {
  const pool = new FifoWorkerPool(10);
  const release = deferred();
  let active = 0;
  let peak = 0;
  const starts = [];
  const jobs = Array.from({ length: 11 }, (_, index) => pool.run(async () => {
    starts.push(index + 1);
    active += 1;
    peak = Math.max(peak, active);
    await release.promise;
    active -= 1;
  }));

  await waitUntil(() => peak === 10);
  assert.equal(peak, 10);
  assert.deepEqual(starts, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

  release.resolve();
  await Promise.all(jobs);
  assert.deepEqual(starts, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

test("image API timeout defaults to ten minutes and accepts an explicit override", () => {
  assert.equal(getImageRequestTimeoutMs(undefined), 600000);
  assert.equal(getImageRequestTimeoutMs("2500"), 2500);
  assert.equal(getImageRequestTimeoutMs("0"), 600000);
});

test("copy design timeout defaults to ten minutes and accepts an explicit override", () => {
  assert.equal(getTextRequestTimeoutMs(undefined), 600000);
  assert.equal(getTextRequestTimeoutMs("2500"), 2500);
  assert.equal(getTextRequestTimeoutMs("0"), 600000);
});

test("template vision JSON timeout defaults to ten minutes and cannot be disabled", () => {
  assert.equal(getVisionJsonRequestTimeoutMs(undefined), 600000);
  assert.equal(getVisionJsonRequestTimeoutMs("2500"), 2500);
  assert.equal(getVisionJsonRequestTimeoutMs("0"), 600000);
});

test("image generation lease rejects an active claim and recovers only an expired claim", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-image-lease-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  const banner = await addBannerCreative(projectRoot, { productId: "p1", strategyId: "s1", title: "案" });

  const first = await claimBannerImageGeneration(projectRoot, banner.id, {
    ownerId: "server-a",
    attemptId: "attempt-a",
    leaseMs: 60000
  });
  assert.equal(first.claimed, true);
  assert.equal(first.banner.imageGenerationStatus, "queued");

  const duplicate = await claimBannerImageGeneration(projectRoot, banner.id, {
    ownerId: "server-b",
    attemptId: "attempt-b",
    leaseMs: 60000
  });
  assert.equal(duplicate.claimed, false);
  assert.equal(duplicate.reason, "active");

  const renewed = await renewBannerImageGenerationLease(projectRoot, banner.id, "attempt-a", 120000);
  assert.ok(Date.parse(renewed.imageGenerationLease.expiresAt) > Date.now() + 110000);

  await updateBannerCreative(projectRoot, banner.id, {
    imageGenerationLease: { ...first.banner.imageGenerationLease, expiresAt: new Date(Date.now() - 1000).toISOString() }
  });
  const recovered = await claimBannerImageGeneration(projectRoot, banner.id, {
    ownerId: "server-b",
    attemptId: "attempt-b",
    leaseMs: 60000
  });
  assert.equal(recovered.claimed, true);
  assert.equal(recovered.recoveredStale, true);

  await assert.rejects(
    startBannerImageGeneration(projectRoot, banner.id, "attempt-a"),
    /別の実行へ移りました/
  );
  const started = await startBannerImageGeneration(projectRoot, banner.id, "attempt-b");
  assert.equal(started.imageGenerationStatus, "generating");
  assert.equal(started.imageGenerationLease.state, "generating");

  const failed = await failBannerImageGeneration(projectRoot, banner.id, "attempt-b", "timeout");
  assert.equal(failed.imageGenerationStatus, "failed");
  assert.equal(failed.imageGenerationLease, null);
  assert.equal(failed.lastError, "timeout");
});
