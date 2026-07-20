import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  classifyAbandonedLease,
  isProcessAlive,
  parseLeaseOwnerPid,
  scheduleRecoveredImageJob
} from "../src/core/banner-job-recovery.js";
import {
  addBannerCreative,
  completeBannerImageGeneration,
  listBannerCreatives,
  recoverAbandonedBannerJobs,
  resetRecoveredBannerImageForManualRetry,
  startBannerImageGeneration,
  updateBannerCreative
} from "../src/core/banner-store.js";

const RECOVERY_NOW = Date.parse("2026-07-20T12:30:00.000Z");

function deadProcess() {
  const error = new Error("missing");
  error.code = "ESRCH";
  throw error;
}

async function createProject(t) {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-banner-recovery-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  return projectRoot;
}

function runningPipeline(attemptId, inputHash = "sha256:image-input") {
  return {
    copyplan: { status: "completed", inputHash: "copy-in", outputHash: "copy-out" },
    prompt: { status: "completed", inputHash: "prompt-in", outputHash: "prompt-out" },
    image: { status: "running", inputHash, outputHash: "", attemptId }
  };
}

function abandonedLease(attemptId, operationKind = "generate") {
  return {
    ownerId: "7796-old-worker",
    attemptId,
    operationKind,
    state: "generating",
    queuedAt: "2026-07-20T12:00:00.000Z",
    startedAt: "2026-07-20T12:01:00.000Z",
    heartbeatAt: "2026-07-20T12:20:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z"
  };
}

test("lease ownerIdの先頭PIDだけを安全に取り出す", () => {
  assert.equal(parseLeaseOwnerPid("7796-old-worker"), 7796);
  assert.equal(parseLeaseOwnerPid("0-invalid"), null);
  assert.equal(parseLeaseOwnerPid("worker-7796"), null);
  assert.equal(parseLeaseOwnerPid(""), null);
});

test("死亡した旧PIDは期限内でも放棄と判定する", () => {
  const result = classifyAbandonedLease(
    { ownerId: "7796-old", expiresAt: "2099-01-01T00:00:00.000Z" },
    {
      now: Date.parse("2026-07-20T12:30:00.000Z"),
      signalProcess: () => {
        const error = new Error("missing");
        error.code = "ESRCH";
        throw error;
      }
    }
  );

  assert.deepEqual(result, { abandoned: true, reason: "owner_process_missing" });
});

test("生存PIDとEPERMの期限内リースは復旧しない", () => {
  const alive = classifyAbandonedLease(
    { ownerId: "65882-current", expiresAt: "2099-01-01T00:00:00.000Z" },
    { now: Date.parse("2026-07-20T12:30:00.000Z"), signalProcess: () => undefined }
  );
  const protectedProcess = isProcessAlive(65882, () => {
    const error = new Error("not permitted");
    error.code = "EPERM";
    throw error;
  });

  assert.deepEqual(alive, { abandoned: false, reason: "owner_alive" });
  assert.equal(protectedProcess, true);
});

test("ownerId不正時は期限切れだけを根拠にする", () => {
  const now = Date.parse("2026-07-20T12:30:00.000Z");
  const active = classifyAbandonedLease(
    { ownerId: "unknown", expiresAt: "2099-01-01T00:00:00.000Z" },
    { now }
  );
  const expired = classifyAbandonedLease(
    { ownerId: "unknown", expiresAt: "2026-07-20T12:29:59.000Z" },
    { now }
  );

  assert.deepEqual(active, { abandoned: false, reason: "owner_unknown" });
  assert.deepEqual(expired, { abandoned: true, reason: "lease_expired" });
});

test("放棄された通常画像生成を新attemptで原子的に再キューする", async (t) => {
  const projectRoot = await createProject(t);
  const banner = await addBannerCreative(projectRoot, {
    productId: "p1",
    strategyId: "s1",
    title: "recover image"
  });
  await updateBannerCreative(projectRoot, banner.id, {
    productionStatus: "prompt_ready",
    imageGenerationStatus: "generating",
    imageGenerationLease: abandonedLease("old-image-attempt"),
    pipelineNodes: runningPipeline("old-image-attempt")
  });

  const recovered = await recoverAbandonedBannerJobs(projectRoot, {
    ownerId: "9000-new-server",
    now: RECOVERY_NOW,
    signalProcess: deadProcess,
    attemptIdFactory: () => "recovered-image-attempt",
    leaseMs: 120000
  });
  const [stored] = await listBannerCreatives(projectRoot);

  assert.deepEqual(recovered.imageJobs, [{
    bannerId: banner.id,
    attemptId: "recovered-image-attempt",
    inputHash: "sha256:image-input",
    previousAttemptId: "old-image-attempt",
    reason: "owner_process_missing"
  }]);
  assert.equal(stored.imageGenerationStatus, "queued");
  assert.equal(stored.imageGenerationLease.ownerId, "9000-new-server");
  assert.equal(stored.imageGenerationLease.attemptId, "recovered-image-attempt");
  assert.equal(stored.pipelineNodes.image.attemptId, "recovered-image-attempt");
  assert.equal(stored.jobRecoveryAudit.automaticImageRetryCount, 0);
  assert.equal(stored.jobRecoveryAudit.lastAction, "image_requeued");

  const started = await startBannerImageGeneration(projectRoot, banner.id, "recovered-image-attempt", 120000);
  assert.equal(started.jobRecoveryAudit.automaticImageRetryCount, 1);
});

test("生存中のownerが持つ画像リースは変更しない", async (t) => {
  const projectRoot = await createProject(t);
  const banner = await addBannerCreative(projectRoot, { productId: "p1", strategyId: "s1", title: "alive" });
  await updateBannerCreative(projectRoot, banner.id, {
    imageGenerationStatus: "generating",
    imageGenerationLease: abandonedLease("alive-attempt"),
    pipelineNodes: runningPipeline("alive-attempt")
  });

  const recovered = await recoverAbandonedBannerJobs(projectRoot, {
    ownerId: "9000-new-server",
    now: RECOVERY_NOW,
    signalProcess: () => undefined,
    attemptIdFactory: () => "must-not-be-used"
  });
  const [stored] = await listBannerCreatives(projectRoot);

  assert.equal(recovered.imageJobs.length, 0);
  assert.equal(stored.imageGenerationLease.attemptId, "alive-attempt");
  assert.equal(stored.jobRecoveryAudit, null);
});

test("自動画像復旧済みなら再送せず手動再生成可能な失敗状態へ戻す", async (t) => {
  const projectRoot = await createProject(t);
  const banner = await addBannerCreative(projectRoot, { productId: "p1", strategyId: "s1", title: "retry limit" });
  await updateBannerCreative(projectRoot, banner.id, {
    imageGenerationStatus: "generating",
    imageGenerationLease: abandonedLease("second-old-attempt"),
    pipelineNodes: runningPipeline("second-old-attempt"),
    jobRecoveryAudit: { version: 1, automaticImageRetryCount: 1 }
  });

  const recovered = await recoverAbandonedBannerJobs(projectRoot, {
    ownerId: "9000-new-server",
    now: RECOVERY_NOW,
    signalProcess: deadProcess,
    attemptIdFactory: () => "must-not-be-used"
  });
  const [stored] = await listBannerCreatives(projectRoot);

  assert.equal(recovered.imageJobs.length, 0);
  assert.deepEqual(recovered.manualImageIds, [banner.id]);
  assert.equal(stored.imageGenerationStatus, "failed");
  assert.equal(stored.imageGenerationLease, null);
  assert.equal(stored.pipelineNodes.image.status, "failed");
  assert.equal(stored.jobRecoveryAudit.lastAction, "image_reset_for_manual_retry");
});

test("放棄された画像編集は既存画像を保持して編集失敗状態へ戻す", async (t) => {
  const projectRoot = await createProject(t);
  const banner = await addBannerCreative(projectRoot, { productId: "p1", strategyId: "s1", title: "edit" });
  await updateBannerCreative(projectRoot, banner.id, {
    productionStatus: "completed",
    imageGenerationStatus: "generating",
    generatedImagePath: "outputs/banners/existing.png",
    generatedImageHash: "sha256:existing",
    images: ["outputs/banners/existing.png"],
    copyBrief: { mainHook: "保持するコピー" },
    promptJson: { zones: [] },
    promptText: "保持するprompt",
    imageGenerationLease: { ...abandonedLease("old-edit-attempt", "edit"), editMode: "range" },
    pipelineNodes: runningPipeline("old-edit-attempt")
  });

  const recovered = await recoverAbandonedBannerJobs(projectRoot, {
    ownerId: "9000-new-server",
    now: RECOVERY_NOW,
    signalProcess: deadProcess
  });
  const [stored] = await listBannerCreatives(projectRoot);

  assert.deepEqual(recovered.resetEditIds, [banner.id]);
  assert.equal(stored.generatedImagePath, "outputs/banners/existing.png");
  assert.deepEqual(stored.images, ["outputs/banners/existing.png"]);
  assert.equal(stored.copyBrief.mainHook, "保持するコピー");
  assert.equal(stored.promptText, "保持するprompt");
  assert.equal(stored.imageGenerationStatus, "completed");
  assert.equal(stored.imageGenerationLease, null);
  assert.equal(stored.lastImageEditMode, "range");
  assert.equal(stored.jobRecoveryAudit.lastAction, "edit_reset_preserving_output");
});

test("放棄されたpromptは成果物を保持して手動再実行可能な失敗状態へ戻す", async (t) => {
  const projectRoot = await createProject(t);
  const banner = await addBannerCreative(projectRoot, { productId: "p1", strategyId: "s1", title: "prompt" });
  await updateBannerCreative(projectRoot, banner.id, {
    productionStatus: "prompt_generating",
    copyBrief: { mainHook: "保持するコピー" },
    promptJson: { zones: [{ id: "headline" }] },
    promptText: "途中まで完成したprompt",
    promptGenerationLease: abandonedLease("old-prompt-attempt", "prompt"),
    pipelineNodes: {
      copyplan: { status: "completed", inputHash: "copy-in", outputHash: "copy-out" },
      prompt: { status: "running", inputHash: "prompt-in", attemptId: "old-prompt-attempt" },
      image: { status: "pending" }
    }
  });

  const recovered = await recoverAbandonedBannerJobs(projectRoot, {
    ownerId: "9000-new-server",
    now: RECOVERY_NOW,
    signalProcess: deadProcess
  });
  const [stored] = await listBannerCreatives(projectRoot);

  assert.deepEqual(recovered.resetPromptIds, [banner.id]);
  assert.equal(stored.promptGenerationLease, null);
  assert.equal(stored.productionStatus, "failed");
  assert.equal(stored.pipelineNodes.prompt.status, "failed");
  assert.equal(stored.pipelineNodes.prompt.errorCode, "SERVER_RESTART_INTERRUPTED");
  assert.equal(stored.copyBrief.mainHook, "保持するコピー");
  assert.equal(stored.promptText, "途中まで完成したprompt");
  assert.equal(stored.jobRecoveryAudit.lastAction, "prompt_reset_for_manual_retry");
});

test("復旧画像は現在のimage入力hashが一致する場合だけ既存キューへ渡す", async () => {
  const job = { bannerId: "ban_1", attemptId: "attempt_2", inputHash: "sha256:same" };
  const enqueued = [];
  const reset = [];

  const result = await scheduleRecoveredImageJob(job, {
    reconcile: async () => ({
      nextNode: "image",
      expectedInputHashes: { image: "sha256:same" }
    }),
    enqueue: async (item) => {
      enqueued.push(item);
      return { accepted: true };
    },
    reset: async (...args) => reset.push(args)
  });

  assert.equal(result.scheduled, true);
  assert.deepEqual(enqueued, [job]);
  assert.deepEqual(reset, []);
});

test("復旧時にimage入力hashが変わっていればAPIへ送らず手動再生成へ戻す", async () => {
  const job = { bannerId: "ban_1", attemptId: "attempt_2", inputHash: "sha256:old" };
  let enqueueCount = 0;
  const resets = [];

  const result = await scheduleRecoveredImageJob(job, {
    reconcile: async () => ({
      nextNode: "image",
      expectedInputHashes: { image: "sha256:new" }
    }),
    enqueue: async () => {
      enqueueCount += 1;
    },
    reset: async (item, reason) => resets.push({ item, reason })
  });

  assert.equal(result.scheduled, false);
  assert.equal(result.reason, "pipeline_input_changed");
  assert.equal(enqueueCount, 0);
  assert.deepEqual(resets, [{ item: job, reason: "pipeline_input_changed" }]);
});

test("同じ復旧attemptが既にメモリキュー登録済みなら状態を失敗へ戻さない", async () => {
  const job = { bannerId: "ban_1", attemptId: "attempt_2", inputHash: "sha256:same" };
  let resetCount = 0;
  const result = await scheduleRecoveredImageJob(job, {
    reconcile: async () => ({ nextNode: "image", expectedInputHashes: { image: "sha256:same" } }),
    enqueue: async () => ({ accepted: false, claim: { reason: "scheduled" } }),
    reset: async () => { resetCount += 1; }
  });

  assert.equal(result.scheduled, false);
  assert.equal(result.reason, "already_scheduled");
  assert.equal(resetCount, 0);
});

test("復旧前のpipeline再照合が失敗した場合もresetは1回だけ実行する", async () => {
  const job = { bannerId: "ban_1", attemptId: "attempt_2", inputHash: "sha256:same" };
  const reasons = [];
  const result = await scheduleRecoveredImageJob(job, {
    reconcile: async () => { throw new Error("broken project data"); },
    enqueue: async () => ({ accepted: true }),
    reset: async (_job, reason) => reasons.push(reason)
  });

  assert.equal(result.scheduled, false);
  assert.equal(result.reason, "recovery_reconcile_failed");
  assert.deepEqual(reasons, ["recovery_reconcile_failed"]);
});

test("復旧用の新attemptだけが入力変更時の手動再生成状態へ戻せる", async (t) => {
  const projectRoot = await createProject(t);
  const banner = await addBannerCreative(projectRoot, { productId: "p1", strategyId: "s1", title: "input changed" });
  await updateBannerCreative(projectRoot, banner.id, {
    imageGenerationStatus: "generating",
    imageGenerationLease: abandonedLease("old-attempt"),
    pipelineNodes: runningPipeline("old-attempt")
  });
  await recoverAbandonedBannerJobs(projectRoot, {
    ownerId: "9000-new-server",
    now: RECOVERY_NOW,
    signalProcess: deadProcess,
    attemptIdFactory: () => "recovered-attempt"
  });

  const ignored = await resetRecoveredBannerImageForManualRetry(
    projectRoot,
    banner.id,
    "old-attempt",
    "pipeline_input_changed"
  );
  assert.equal(ignored, null);

  const reset = await resetRecoveredBannerImageForManualRetry(
    projectRoot,
    banner.id,
    "recovered-attempt",
    "pipeline_input_changed"
  );
  assert.equal(reset.imageGenerationStatus, "failed");
  assert.equal(reset.imageGenerationLease, null);
  assert.equal(reset.pipelineNodes.image.errorCode, "SERVER_RESTART_INPUT_CHANGED");
  assert.equal(reset.jobRecoveryAudit.lastAction, "image_reset_for_manual_retry");
});

test("復旧済みleaseは再スイープで二重に再キューされず開始回数も1回だけ数える", async (t) => {
  const projectRoot = await createProject(t);
  const banner = await addBannerCreative(projectRoot, { productId: "p1", strategyId: "s1", title: "idempotent" });
  await updateBannerCreative(projectRoot, banner.id, {
    imageGenerationStatus: "generating",
    imageGenerationLease: abandonedLease("old-attempt"),
    pipelineNodes: runningPipeline("old-attempt")
  });
  const signalProcess = (pid) => {
    if (pid === 7796) deadProcess();
  };

  const first = await recoverAbandonedBannerJobs(projectRoot, {
    ownerId: "9000-new-server",
    now: RECOVERY_NOW,
    signalProcess,
    attemptIdFactory: () => "recovered-attempt"
  });
  const second = await recoverAbandonedBannerJobs(projectRoot, {
    ownerId: "9000-new-server",
    now: RECOVERY_NOW,
    signalProcess,
    attemptIdFactory: () => "duplicate-attempt"
  });
  await startBannerImageGeneration(projectRoot, banner.id, "recovered-attempt", 120000);
  const startedAgain = await startBannerImageGeneration(projectRoot, banner.id, "recovered-attempt", 120000);

  assert.equal(first.imageJobs.length, 1);
  assert.equal(second.imageJobs.length, 0);
  assert.equal(startedAgain.jobRecoveryAudit.automaticImageRetryCount, 1);
});

test("旧attemptの遅延完了は復旧後の新attemptを上書きできない", async (t) => {
  const projectRoot = await createProject(t);
  const banner = await addBannerCreative(projectRoot, { productId: "p1", strategyId: "s1", title: "cas" });
  await updateBannerCreative(projectRoot, banner.id, {
    imageGenerationStatus: "generating",
    imageGenerationLease: abandonedLease("old-attempt"),
    pipelineNodes: runningPipeline("old-attempt")
  });
  await recoverAbandonedBannerJobs(projectRoot, {
    ownerId: "9000-new-server",
    now: RECOVERY_NOW,
    signalProcess: deadProcess,
    attemptIdFactory: () => "recovered-attempt"
  });

  await assert.rejects(
    completeBannerImageGeneration(projectRoot, banner.id, "old-attempt", {
      generatedImagePath: "outputs/banners/stale.png",
      generatedImageHash: "sha256:stale"
    }),
    (error) => error.code === "IMAGE_ATTEMPT_REPLACED"
  );
  const [stored] = await listBannerCreatives(projectRoot);
  assert.equal(stored.generatedImagePath, "");
  assert.equal(stored.imageGenerationLease.attemptId, "recovered-attempt");
});

test("画像ファイルとhashが保存済みならAPI再送せず完了状態を復元する", async (t) => {
  const projectRoot = await createProject(t);
  const banner = await addBannerCreative(projectRoot, { productId: "p1", strategyId: "s1", title: "preserve completed" });
  await updateBannerCreative(projectRoot, banner.id, {
    productionStatus: "prompt_ready",
    imageGenerationStatus: "generating",
    generatedImagePath: "outputs/banners/already-written.png",
    generatedImageHash: "sha256:already-written",
    generatedImageModel: "gpt-image-2",
    generatedImageSize: "1080x1080",
    imageGenerationLease: abandonedLease("old-attempt"),
    pipelineNodes: runningPipeline("old-attempt")
  });

  const recovered = await recoverAbandonedBannerJobs(projectRoot, {
    ownerId: "9000-new-server",
    now: RECOVERY_NOW,
    signalProcess: deadProcess
  });
  const [stored] = await listBannerCreatives(projectRoot);

  assert.equal(recovered.imageJobs.length, 0);
  assert.deepEqual(recovered.completedImageIds, [banner.id]);
  assert.equal(stored.productionStatus, "completed");
  assert.equal(stored.imageGenerationStatus, "completed");
  assert.equal(stored.imageGenerationLease, null);
  assert.equal(stored.jobRecoveryAudit.lastAction, "completed_output_preserved");
});
