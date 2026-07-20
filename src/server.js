import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProjectPath } from "./core/paths.js";
import { createProject, listProjectCollections, listProjects, updateProjectStatus, validateProject } from "./core/project-store.js";
import { addExpressionRule, addFact, addMaterial, addProduct, addProductImage, deleteExpressionRule, deleteFact, deleteMaterial, deleteProduct, extractMaterial, extractTextFromUrl, getBannerGenerationWorkspace, getBannerImageContext, getResearchWorkspace, removeProductImage, updateExpressionRule, updateFact, updateMaterial, updateProduct } from "./core/research-store.js";
import { addStrategy, deleteStrategy, updateStrategy } from "./core/strategy-store.js";
import { extractTextFromFile } from "./core/file-import.js";
import { addBannerCreative, claimBannerImageEdit, claimBannerImageGeneration, claimBannerPromptGeneration, completeBannerPromptOperation, deleteBannerCreative, ensureBannerCopyBriefsForPromptJobs, failBannerImageEdit, failBannerImageGeneration, failBannerPromptGeneration, generateBannerPromptBatch, listBannerCreatives, reconcileBannerPipeline, recoverAbandonedBannerJobs, releaseBannerPromptGeneration, renewBannerImageGenerationLease, renewBannerPromptGenerationLease, resetRecoveredBannerImageForManualRetry, reviseBannerCreative, spreadBannerIdeas, startBannerImageGeneration, updateBannerCreative } from "./core/banner-store.js";
import { scheduleRecoveredImageJob } from "./core/banner-job-recovery.js";
import { buildCompositeEditInstruction, normalizeEditRegionsFromBody, validateEditRegions } from "./core/banner-range-edit.js";
import {
  getAnthropicSettingsStatus,
  getOpenAiSettingsStatus,
  saveAnthropicKey,
  saveOpenAiKey
} from "./core/settings-store.js";
import { addAdTemplate, deleteAdTemplate, getAdTemplateStatuses, recoverTemplateAnalysisJobs, updateAdTemplate } from "./core/ad-template-store.js";
import { editBannerImageWithGptImage2, generateBannerImageWithGptImage2, normalizeBannerEditMode } from "./core/openai-image.js";
import { generateWhoWhatProposals } from "./core/who-what-ai.js";
import { extractProductFactsWithAi } from "./core/product-research-ai.js";
import { applyRegulationRules, classifyExpressionRules } from "./core/banner-ai.js";
import { buildInstructionPolicy } from "./core/banner-instruction-policy.js";
import { importRegulationsFromText, extractRegulationRulesFromText } from "./core/regulation-import-ai.js";
import { resolveContext } from "./core/context-resolver.js";
import { runAction } from "./core/action-runner.js";
import { FifoWorkerPool } from "./core/job-queue.js";
import { createPromptWorkerPool, normalizePromptConcurrency, runPromptJobsInPool } from "./core/prompt-worker.js";
import { acquireFileSemaphore } from "./core/file-semaphore.js";
import { createTemplateAnalysisWorkerPool, enqueueTemplateAnalysisJob, normalizeTemplateAnalysisConcurrency } from "./core/template-analysis-worker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const port = Number(process.env.PORT || 5173);
const promptConcurrency = normalizePromptConcurrency(process.env.CMOAI_PROMPT_CONCURRENCY, 10);
const promptWorkerPool = createPromptWorkerPool(promptConcurrency);
const imageConcurrency = Math.max(1, Number(process.env.CMOAI_IMAGE_CONCURRENCY) || 10);
const imageWorkerPool = new FifoWorkerPool(imageConcurrency);
const imageWorkerOwnerId = `${process.pid}-${crypto.randomUUID()}`;
const templateAnalysisConcurrency = normalizeTemplateAnalysisConcurrency(process.env.CMOAI_TEMPLATE_ANALYSIS_CONCURRENCY, 10);
const templateAnalysisWorkerPool = createTemplateAnalysisWorkerPool(templateAnalysisConcurrency);
const templateAnalysisWorkerOwnerId = `${process.pid}-template-${crypto.randomUUID()}`;
const scheduledTemplateAnalysisAttempts = new Set();
const scheduledBannerRecoveryAttempts = new Set();
let templateAnalysisRecoveryTimer = null;
let bannerJobRecoveryTimer = null;
let bannerJobRecoverySweep = null;
const TEMPLATE_ANALYSIS_CONTROL_FIELDS = new Set([
  "templateProcessingStatus",
  "templateAnalysisAttemptId",
  "templateAnalysisQueuedAt",
  "templateAnalysisStartedAt",
  "templateAnalysisCompletedAt",
  "templateAnalysisError",
  "templateAnalysisLease"
]);

function sanitizeAdTemplateUserPatch(patch) {
  return Object.fromEntries(Object.entries(patch && typeof patch === "object" ? patch : {})
    .filter(([key]) => !TEMPLATE_ANALYSIS_CONTROL_FIELDS.has(key)));
}

function durationFromEnv(name, fallback, minimum = 60000) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

// Prevents the same expensive AI job (per banner/material/product row, keyed by
// action+target) from running twice at once, e.g. a page reload re-firing a
// request while the first one is still in flight on the server. This guard is
// server-side and in-memory, so it also protects against double submits that
// the UI's own client-side runExclusive() cannot catch after a reload.
const runningJobs = new Map();
let jobTokenSeq = 0;

async function withJobLock(res, key, handler) {
  const current = runningJobs.get(key);
  if (current) {
    return sendJson(res, { ok: false, errorCode: "ALREADY_RUNNING", message: "実行中です。完了までお待ちください。" }, 409);
  }
  const token = ++jobTokenSeq;
  runningJobs.set(key, { token });
  try {
    return await handler();
  } catch (error) {
    // 各ルートは withJobLock の戻り値を await せずに return しているため、ここで
    // 捕捉して応答を返さないと、例外が unhandledRejection になり応答が永久に返らない
    // (例: APIキー未設定の初回実行)。外側の catch と同じ形式で返す。
    return sendJson(res, { ok: false, errorCode: "SERVER_ERROR", message: error.message }, 500);
  } finally {
    if (runningJobs.get(key)?.token === token) runningJobs.delete(key);
  }
}

async function prepareBannerImageJob(projectRoot, bannerId, taskFactory = null, pipelineInputHash = "") {
  const attemptId = crypto.randomUUID();
  const queueLeaseMs = durationFromEnv("CMOAI_IMAGE_QUEUE_LEASE_MS", 15 * 60 * 1000);
  const claim = await claimBannerImageGeneration(projectRoot, bannerId, {
    ownerId: imageWorkerOwnerId,
    attemptId,
    inputHash: pipelineInputHash,
    leaseMs: queueLeaseMs,
    legacyStaleMs: durationFromEnv("CMOAI_IMAGE_STALE_MS", 15 * 60 * 1000)
  });
  if (!claim.claimed) return { accepted: false, claim };
  return enqueueClaimedBannerImageJob(projectRoot, bannerId, attemptId, taskFactory, claim);
}

function enqueueClaimedBannerImageJob(projectRoot, bannerId, attemptId, taskFactory = null, claim = null) {
  const queueLeaseMs = durationFromEnv("CMOAI_IMAGE_QUEUE_LEASE_MS", 15 * 60 * 1000);
  const heartbeatMs = Math.max(30000, Math.min(60000, Math.floor(queueLeaseMs / 3)));
  const heartbeat = setInterval(() => {
    renewBannerImageGenerationLease(projectRoot, bannerId, attemptId, queueLeaseMs).catch(() => null);
  }, heartbeatMs);
  heartbeat.unref();
  const taskPromise = imageWorkerPool.run(async () => {
    let releaseSlot;
    try {
      releaseSlot = await acquireFileSemaphore(
        path.join(appRoot, "data", ".runtime", "image-generation"),
        imageConcurrency,
        { staleMs: durationFromEnv("CMOAI_IMAGE_SLOT_STALE_MS", 3 * 60 * 1000) }
      );
      const started = await startBannerImageGeneration(
        projectRoot,
        bannerId,
        attemptId,
        durationFromEnv("CMOAI_IMAGE_GENERATION_LEASE_MS", 15 * 60 * 1000)
      );
      const imageContext = await getBannerImageContext(projectRoot, started.productId);
      const context = { ...imageContext, attemptId };
      return await (taskFactory
        ? taskFactory(started, context)
        : generateBannerImageWithGptImage2(projectRoot, started, context));
    } catch (error) {
      await failBannerImageGeneration(projectRoot, bannerId, attemptId, error.message);
      throw error;
    } finally {
      if (releaseSlot) await releaseSlot();
    }
  }).finally(() => clearInterval(heartbeat));
  return { accepted: true, claim, attemptId, taskPromise };
}

function prepareRecoveredBannerImageJob(projectRoot, recoveryJob) {
  const recoveryKey = `${projectRoot}:${recoveryJob.bannerId}:${recoveryJob.attemptId}`;
  if (scheduledBannerRecoveryAttempts.has(recoveryKey)) {
    return { accepted: false, claim: { claimed: false, reason: "scheduled" } };
  }
  scheduledBannerRecoveryAttempts.add(recoveryKey);
  try {
    const prepared = enqueueClaimedBannerImageJob(
      projectRoot,
      recoveryJob.bannerId,
      recoveryJob.attemptId,
      null,
      { claimed: true, recovered: true }
    );
    const taskPromise = prepared.taskPromise.finally(() => {
      scheduledBannerRecoveryAttempts.delete(recoveryKey);
    });
    return { ...prepared, taskPromise };
  } catch (error) {
    scheduledBannerRecoveryAttempts.delete(recoveryKey);
    throw error;
  }
}

async function prepareBannerImageEditJob(projectRoot, bannerId, taskFactory, { editMode = "range" } = {}) {
  const attemptId = crypto.randomUUID();
  const queueLeaseMs = durationFromEnv("CMOAI_IMAGE_QUEUE_LEASE_MS", 15 * 60 * 1000);
  const claim = await claimBannerImageEdit(projectRoot, bannerId, {
    ownerId: imageWorkerOwnerId,
    attemptId,
    editMode,
    leaseMs: queueLeaseMs,
    legacyStaleMs: durationFromEnv("CMOAI_IMAGE_STALE_MS", 15 * 60 * 1000)
  });
  if (!claim.claimed) return { accepted: false, claim };
  const heartbeatMs = Math.max(30000, Math.min(60000, Math.floor(queueLeaseMs / 3)));
  const heartbeat = setInterval(() => {
    renewBannerImageGenerationLease(projectRoot, bannerId, attemptId, queueLeaseMs).catch(() => null);
  }, heartbeatMs);
  heartbeat.unref();
  const taskPromise = imageWorkerPool.run(async () => {
    let releaseSlot;
    try {
      releaseSlot = await acquireFileSemaphore(
        path.join(appRoot, "data", ".runtime", "image-generation"),
        imageConcurrency,
        { staleMs: durationFromEnv("CMOAI_IMAGE_SLOT_STALE_MS", 3 * 60 * 1000) }
      );
      const started = await startBannerImageGeneration(
        projectRoot,
        bannerId,
        attemptId,
        durationFromEnv("CMOAI_IMAGE_GENERATION_LEASE_MS", 15 * 60 * 1000)
      );
      const imageContext = await getBannerImageContext(projectRoot, started.productId);
      const context = { ...imageContext, attemptId, operationKind: "edit", editMode };
      return await taskFactory(started, context);
    } catch (error) {
      await failBannerImageEdit(projectRoot, bannerId, attemptId, error.message);
      throw error;
    } finally {
      if (releaseSlot) await releaseSlot();
    }
  }).finally(() => clearInterval(heartbeat));
  return { accepted: true, claim, taskPromise };
}

async function prepareTemplateAnalysisJob(projectRoot, templateId, attemptId = "") {
  const recoveryKey = attemptId ? `${templateId}:${attemptId}` : "";
  if (recoveryKey && scheduledTemplateAnalysisAttempts.has(recoveryKey)) {
    return { accepted: false, claim: { claimed: false, reason: "scheduled" } };
  }
  const job = await enqueueTemplateAnalysisJob({
    pool: templateAnalysisWorkerPool,
    projectRoot,
    templateId,
    ownerId: templateAnalysisWorkerOwnerId,
    attemptId,
    leaseMs: durationFromEnv("CMOAI_TEMPLATE_ANALYSIS_LEASE_MS", 15 * 60 * 1000),
    runWithAnalysisSlot: async (task) => {
      const release = await acquireFileSemaphore(
        path.join(appRoot, "data", ".runtime", "template-analysis"),
        templateAnalysisConcurrency,
        { staleMs: durationFromEnv("CMOAI_TEMPLATE_ANALYSIS_SLOT_STALE_MS", 3 * 60 * 1000) }
      );
      try {
        return await task();
      } finally {
        await release();
      }
    }
  });
  if (!job.accepted) return job;
  const scheduledKey = `${templateId}:${job.attemptId}`;
  scheduledTemplateAnalysisAttempts.add(scheduledKey);
  const taskPromise = job.taskPromise.finally(() => scheduledTemplateAnalysisAttempts.delete(scheduledKey));
  return { ...job, taskPromise };
}

async function recoverTemplateAnalysisQueue() {
  const leaseMs = durationFromEnv("CMOAI_TEMPLATE_ANALYSIS_LEASE_MS", 15 * 60 * 1000);
  const jobs = await recoverTemplateAnalysisJobs(appRoot, {
    ownerId: templateAnalysisWorkerOwnerId,
    leaseMs
  });
  let queuedCount = 0;
  for (const job of jobs) {
    const prepared = await prepareTemplateAnalysisJob(appRoot, job.templateId, job.attemptId);
    if (prepared.accepted) {
      queuedCount += 1;
      prepared.taskPromise.catch(() => null);
    }
  }
  if (queuedCount) console.log(`[CMOAI] Requeued ${queuedCount} template analysis job(s).`);
}

async function recoverBannerJobQueues() {
  if (bannerJobRecoverySweep) return bannerJobRecoverySweep;
  bannerJobRecoverySweep = (async () => {
    const projects = (await listProjects()).filter((project) => !project.isTemplate && project.status === "draft");
    const summary = { requeued: 0, promptReset: 0, editReset: 0, imageReset: 0, completedPreserved: 0 };
    for (const project of projects) {
      try {
        const projectRoot = resolveProjectPath(project.path);
        const recovery = await recoverAbandonedBannerJobs(projectRoot, {
          ownerId: imageWorkerOwnerId,
          leaseMs: durationFromEnv("CMOAI_IMAGE_QUEUE_LEASE_MS", 15 * 60 * 1000)
        });
        summary.promptReset += recovery.resetPromptIds.length;
        summary.editReset += recovery.resetEditIds.length;
        summary.imageReset += recovery.manualImageIds.length;
        summary.completedPreserved += recovery.completedImageIds.length;

        for (const recoveryJob of recovery.imageJobs) {
          const scheduled = await scheduleRecoveredImageJob(recoveryJob, {
            reconcile: async () => {
              const workspace = await getBannerGenerationWorkspace(projectRoot);
              return reconcileBannerPipeline(projectRoot, recoveryJob.bannerId, workspace);
            },
            enqueue: async () => prepareRecoveredBannerImageJob(projectRoot, recoveryJob),
            reset: async (_job, reason) => resetRecoveredBannerImageForManualRetry(
              projectRoot,
              recoveryJob.bannerId,
              recoveryJob.attemptId,
              reason
            )
          });
          if (scheduled.scheduled) {
            summary.requeued += 1;
            scheduled.prepared.taskPromise.catch(() => null);
          }
        }
      } catch (error) {
        console.error(`[CMOAI] Banner recovery skipped project ${project.id}:`, error);
      }
    }

    const total = Object.values(summary).reduce((sum, count) => sum + count, 0);
    if (total) {
      console.log(
        `[CMOAI] Banner recovery: requeued=${summary.requeued}, promptReset=${summary.promptReset}, `
        + `editReset=${summary.editReset}, imageReset=${summary.imageReset}, completedPreserved=${summary.completedPreserved}`
      );
    }
    return summary;
  })().finally(() => {
    bannerJobRecoverySweep = null;
  });
  return bannerJobRecoverySweep;
}

function prepareBannerPromptJob(projectRoot, bannerId, pipeline = {}) {
  const attemptId = crypto.randomUUID();
  const leaseMs = durationFromEnv("CMOAI_PROMPT_LEASE_MS", 5 * 60 * 1000);
  return claimBannerPromptGeneration(projectRoot, bannerId, {
    ownerId: imageWorkerOwnerId,
    attemptId,
    startNode: pipeline.startNode || "",
    inputHash: pipeline.inputHash || "",
    leaseMs
  }).then((claim) => {
    if (!claim.claimed) return { accepted: false, claim };
    const heartbeat = setInterval(() => {
      renewBannerPromptGenerationLease(projectRoot, bannerId, attemptId, leaseMs).catch(() => null);
    }, Math.max(30000, Math.min(60000, Math.floor(leaseMs / 3))));
    heartbeat.unref();
    return { accepted: true, bannerId, attemptId, heartbeat, startNode: pipeline.startNode || "" };
  });
}

async function withGlobalTextSlot(task) {
  const release = await acquireFileSemaphore(
    path.join(appRoot, "data", ".runtime", "openai-text"),
    promptConcurrency,
    { staleMs: durationFromEnv("CMOAI_PROMPT_SLOT_STALE_MS", 3 * 60 * 1000) }
  );
  try {
    return await task();
  } finally {
    await release();
  }
}

async function executeSinglePromptJob(projectRoot, job) {
  return withGlobalTextSlot(async () => {
    const workspace = await getBannerGenerationWorkspace(projectRoot);
    const generated = await generateBannerPromptBatch(projectRoot, [job.bannerId], workspace, {
      attemptIds: { [job.bannerId]: job.attemptId }
    });
    const failure = generated.errors?.find((item) => item.bannerId === job.bannerId);
    if (failure) {
      await failBannerPromptGeneration(projectRoot, job.bannerId, job.attemptId, failure.message);
      return { bannerId: job.bannerId, error: failure };
    }
    const banner = generated.banners?.[0] || null;
    if (!banner) {
      const error = { bannerId: job.bannerId, message: "コピー設計に失敗しました。" };
      await failBannerPromptGeneration(projectRoot, job.bannerId, job.attemptId, error.message);
      return { bannerId: job.bannerId, error };
    }
    return { bannerId: job.bannerId, banner };
  });
}

async function runFullBannerBatchInBackground(projectRoot, promptJobs) {
  let plannedPromptJobs = promptJobs;
  const dispatchedIds = new Set();
  const dispatchReadyItems = async (items) => {
    const readyIds = new Set((items || []).map((item) => item?.banner?.id).filter(Boolean));
    const readyJobs = plannedPromptJobs.filter((job) => readyIds.has(job.bannerId) && !dispatchedIds.has(job.bannerId));
    for (const job of readyJobs) dispatchedIds.add(job.bannerId);
    if (readyJobs.length) await runPromptJobsAndStartImages(projectRoot, readyJobs);
  };
  try {
    const workspace = await getBannerGenerationWorkspace(projectRoot);
    const copyPreparation = await ensureBannerCopyBriefsForPromptJobs(projectRoot, plannedPromptJobs, workspace, {
      runCopyGroup: (task) => promptWorkerPool.run(() => withGlobalTextSlot(task)),
      onItemsReady: dispatchReadyItems,
      forceCopyBrief: (item) => ["copyplan"].includes(
        plannedPromptJobs.find((job) => job.bannerId === item.banner.id)?.startNode
      )
    });
    const failedIds = new Set((copyPreparation.errors || []).map((item) => item.bannerId));
    for (const error of copyPreparation.errors || []) {
      const job = plannedPromptJobs.find((item) => item.bannerId === error.bannerId);
      if (job) {
        clearInterval(job.heartbeat);
        await releaseBannerPromptGeneration(projectRoot, job.bannerId, job.attemptId);
      }
    }
    plannedPromptJobs = plannedPromptJobs.filter((job) => !failedIds.has(job.bannerId));
  } catch (error) {
    promptJobs.forEach((job) => clearInterval(job.heartbeat));
    throw error;
  }
  const remainingJobs = plannedPromptJobs.filter((job) => !dispatchedIds.has(job.bannerId));
  if (remainingJobs.length) await runPromptJobsAndStartImages(projectRoot, remainingJobs);
}

async function runPromptJobsAndStartImages(projectRoot, promptJobs) {
  if (!promptJobs.length) return;
  const settled = await runPromptJobsInPool(promptWorkerPool, promptJobs, async (job) => {
    const result = await executeSinglePromptJob(projectRoot, job);
    if (!result.banner) return result;
    try {
      const currentWorkspace = await getBannerGenerationWorkspace(projectRoot);
      const pipeline = await reconcileBannerPipeline(projectRoot, result.banner.id, currentWorkspace);
      if (pipeline.nextNode !== "image") {
        return {
          ...result,
          error: {
            bannerId: result.banner.id,
            errorCode: "PIPELINE_PRE_IMAGE_INCOMPLETE",
            message: `画像生成前の${pipeline.nextNode || "unknown"}ノードが未完了です。`
          }
        };
      }
      const imageJob = await prepareBannerImageJob(projectRoot, result.banner.id, null, pipeline.expectedInputHashes.image);
      if (imageJob.accepted) imageJob.taskPromise.catch(() => null);
    } catch (error) {
      await updateBannerCreative(projectRoot, result.banner.id, {
        imageGenerationStatus: "failed",
        lastError: error.message,
        lastErrorAt: new Date().toISOString()
      });
    }
    return result;
  }, (job) => clearInterval(job.heartbeat));
  for (let index = 0; index < settled.length; index += 1) {
    const result = settled[index];
    if (result.status === "rejected") {
      const job = promptJobs[index];
      await failBannerPromptGeneration(projectRoot, job.bannerId, job.attemptId, result.reason?.message || String(result.reason || ""));
    }
  }
}

async function runPromptJobs(projectRoot, promptJobs) {
  let plannedPromptJobs = promptJobs;
  const stageOneErrors = [];
  try {
    const workspace = await getBannerGenerationWorkspace(projectRoot);
    const copyPreparation = await ensureBannerCopyBriefsForPromptJobs(projectRoot, plannedPromptJobs, workspace, {
      runCopyGroup: (task) => promptWorkerPool.run(() => withGlobalTextSlot(task)),
      forceCopyBrief: (item) => ["copyplan"].includes(
        plannedPromptJobs.find((job) => job.bannerId === item.banner.id)?.startNode
      )
    });
    stageOneErrors.push(...(copyPreparation.errors || []));
    const failedIds = new Set(stageOneErrors.map((item) => item.bannerId));
    for (const error of stageOneErrors) {
      const job = plannedPromptJobs.find((item) => item.bannerId === error.bannerId);
      if (job) {
        clearInterval(job.heartbeat);
        await releaseBannerPromptGeneration(projectRoot, job.bannerId, job.attemptId);
      }
    }
    plannedPromptJobs = plannedPromptJobs.filter((job) => !failedIds.has(job.bannerId));
  } catch (error) {
    promptJobs.forEach((job) => clearInterval(job.heartbeat));
    throw error;
  }
  if (!plannedPromptJobs.length) return { banners: [], errors: stageOneErrors };
  const settled = await runPromptJobsInPool(promptWorkerPool, plannedPromptJobs, (job) => executeSinglePromptJob(projectRoot, job), (job) => clearInterval(job.heartbeat));
  const banners = [];
  const errors = [...stageOneErrors];
  for (let index = 0; index < settled.length; index += 1) {
    const result = settled[index];
    const job = plannedPromptJobs[index];
    if (result.status === "rejected") {
      const message = result.reason?.message || String(result.reason || "コピー設計に失敗しました。");
      await failBannerPromptGeneration(projectRoot, job.bannerId, job.attemptId, message);
      errors.push({ bannerId: job.bannerId, message });
      continue;
    }
    if (result.value?.banner) banners.push(result.value.banner);
    if (result.value?.error) errors.push(result.value.error);
  }
  return { banners, errors };
}

async function runClaimedPromptOperation(projectRoot, bannerId, operation) {
  const job = await prepareBannerPromptJob(projectRoot, bannerId);
  if (!job.accepted) {
    const error = new Error("コピー設計は実行中または待機中です。");
    error.code = "PROMPT_ALREADY_ACTIVE";
    throw error;
  }
  try {
    const result = await promptWorkerPool.run(() => withGlobalTextSlot(operation));
    await completeBannerPromptOperation(projectRoot, bannerId, job.attemptId);
    return result;
  } catch (error) {
    await failBannerPromptGeneration(projectRoot, bannerId, job.attemptId, error.message);
    throw error;
  } finally {
    clearInterval(job.heartbeat);
  }
}

// Keep the server process alive on unexpected errors instead of crashing the
// whole process for one bad request or async failure.
process.on("unhandledRejection", (reason) => {
  console.error("[CMOAI] Unhandled rejection (ignored, server stays up):", reason);
});
process.on("uncaughtException", (error) => {
  console.error("[CMOAI] Uncaught exception (ignored, server stays up):", error);
});

// `node --watch` sends SIGTERM to restart on file changes. Without this, the
// listening socket can be left lingering while the old process winds down,
// which is what makes the next start briefly hit EADDRINUSE. Close the socket
// explicitly so the port frees up immediately instead of on its own schedule.
function shutdownGracefully() {
  if (templateAnalysisRecoveryTimer) clearInterval(templateAnalysisRecoveryTimer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGTERM", shutdownGracefully);
process.on("SIGINT", shutdownGracefully);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/api/settings/openai" && req.method === "GET") {
      return sendJson(res, { ok: true, settings: await getOpenAiSettingsStatus() });
    }

    if (url.pathname === "/api/settings/openai" && req.method === "POST") {
      const body = await readJsonBody(req);
      return sendJson(res, { ok: true, settings: await saveOpenAiKey(body.apiKey || "") });
    }

    if (url.pathname === "/api/settings/anthropic" && req.method === "GET") {
      return sendJson(res, { ok: true, settings: await getAnthropicSettingsStatus() });
    }

    if (url.pathname === "/api/settings/anthropic" && req.method === "POST") {
      const body = await readJsonBody(req);
      return sendJson(res, { ok: true, settings: await saveAnthropicKey(body.apiKey || "") });
    }

    if (url.pathname === "/api/projects" && req.method === "POST") {
      const body = await readJsonBody(req);
      const slug = createSlug(body.projectName || body.productName || "new-project");
      const projectRoot = resolveProjectPath(`./projects/${slug}`);
      const productName = String(body.productName || "").trim();
      const productUrl = String(body.productUrl || body.officialUrl || "").trim();
      const project = await createProject(projectRoot, {
        projectName: body.projectName || slug,
        productName,
        officialUrl: productUrl
      });
      let warning = "";
      if (productName || productUrl) {
        try {
          await addProduct(projectRoot, { name: productName || productUrl, officialUrl: productUrl, shortDescription: "" });
        } catch (error) {
          warning = `商品マスターへの自動登録に失敗しました: ${error.message}`;
        }
      }
      return sendJson(res, { ok: true, project: { id: slug, path: `./projects/${slug}`, ...project }, ...(warning ? { warning } : {}) });
    }

    if (url.pathname === "/api/projects" && req.method === "GET") {
      return sendJson(res, { ok: true, projects: await listProjects() });
    }

    if (url.pathname === "/api/projects/status" && req.method === "PATCH") {
      const body = await readJsonBody(req);
      const projectPath = String(body.project || "").trim();
      const status = String(body.status || "").trim();
      if (!/^\.\/projects\/[^/\\]+$/.test(projectPath) || projectPath === "./projects/_template") {
        return sendJson(res, { ok: false, errorCode: "INVALID_PROJECT_PATH", message: "有効な案件を指定してください。" }, 400);
      }
      if (status !== "draft" && status !== "archived") {
        return sendJson(res, { ok: false, errorCode: "INVALID_PROJECT_STATUS", message: "案件ステータスは draft または archived を指定してください。" }, 400);
      }

      const projectRoot = resolveProjectPath(projectPath);
      try {
        const project = await updateProjectStatus(projectRoot, status);
        return sendJson(res, { ok: true, project: { id: path.basename(projectRoot), path: projectPath, ...project } });
      } catch (error) {
        if (error.code === "PROJECT_NOT_FOUND") {
          return sendJson(res, { ok: false, errorCode: error.code, message: error.message }, 404);
        }
        throw error;
      }
    }

    if (url.pathname === "/api/project/detail") {
      const projectRoot = resolveProjectPath(url.searchParams.get("project"));
      const validation = await validateProject(projectRoot);
      const collections = await listProjectCollections(projectRoot);
      return sendJson(res, { ok: validation.ok, validation, collections });
    }

    if (url.pathname === "/api/research" && req.method === "GET") {
      const projectRoot = resolveProjectPath(url.searchParams.get("project"));
      return sendJson(res, { ok: true, workspace: await getResearchWorkspace(projectRoot) });
    }


    const productMatch = url.pathname.match(/^\/api\/research\/products\/([^/]+)$/);
    if (productMatch && (req.method === "PATCH" || req.method === "DELETE")) {
      const productId = decodeURIComponent(productMatch[1]);
      const body = req.method === "PATCH" ? await readJsonBody(req) : {};
      const projectRoot = resolveProjectPath(body.project || url.searchParams.get("project"));
      if (req.method === "PATCH") return sendJson(res, { ok: true, product: await updateProduct(projectRoot, productId, body.patch || {}) });
      return sendJson(res, { ok: true, deleted: await deleteProduct(projectRoot, productId) });
    }

    const materialMatch = url.pathname.match(/^\/api\/research\/materials\/([^/]+)$/);
    if (materialMatch && (req.method === "PATCH" || req.method === "DELETE")) {
      const materialId = decodeURIComponent(materialMatch[1]);
      const body = req.method === "PATCH" ? await readJsonBody(req) : {};
      const projectRoot = resolveProjectPath(body.project || url.searchParams.get("project"));
      if (req.method === "PATCH") return sendJson(res, { ok: true, material: await updateMaterial(projectRoot, materialId, body.patch || {}) });
      return sendJson(res, { ok: true, deleted: await deleteMaterial(projectRoot, materialId) });
    }

    const factMatch = url.pathname.match(/^\/api\/research\/facts\/([^/]+)$/);
    if (factMatch && (req.method === "PATCH" || req.method === "DELETE")) {
      const factId = decodeURIComponent(factMatch[1]);
      const body = req.method === "PATCH" ? await readJsonBody(req) : {};
      const projectRoot = resolveProjectPath(body.project || url.searchParams.get("project"));
      if (req.method === "PATCH") return sendJson(res, { ok: true, fact: await updateFact(projectRoot, factId, body.patch || {}) });
      return sendJson(res, { ok: true, deleted: await deleteFact(projectRoot, factId) });
    }

    const ruleMatch = url.pathname.match(/^\/api\/research\/expression-rules\/([^/]+)$/);
    if (ruleMatch && (req.method === "PATCH" || req.method === "DELETE")) {
      const ruleId = decodeURIComponent(ruleMatch[1]);
      const body = req.method === "PATCH" ? await readJsonBody(req) : {};
      const projectRoot = resolveProjectPath(body.project || url.searchParams.get("project"));
      if (req.method === "PATCH") return sendJson(res, { ok: true, rule: await updateExpressionRule(projectRoot, ruleId, body.patch || {}) });
      return sendJson(res, { ok: true, deleted: await deleteExpressionRule(projectRoot, ruleId) });
    }

    const strategyMatch = url.pathname.match(/^\/api\/strategies\/([^/]+)$/);
    if (strategyMatch && (req.method === "PATCH" || req.method === "DELETE")) {
      const strategyId = decodeURIComponent(strategyMatch[1]);
      const body = req.method === "PATCH" ? await readJsonBody(req) : {};
      const projectRoot = resolveProjectPath(body.project || url.searchParams.get("project"));
      if (req.method === "PATCH") return sendJson(res, { ok: true, strategy: await updateStrategy(projectRoot, strategyId, body.patch || {}) });
      return sendJson(res, { ok: true, deleted: await deleteStrategy(projectRoot, strategyId) });
    }

    const bannerMatch = url.pathname.match(/^\/api\/banners\/([^/]+)$/);
    if (bannerMatch && (req.method === "PATCH" || req.method === "DELETE")) {
      const bannerId = decodeURIComponent(bannerMatch[1]);
      const body = req.method === "PATCH" ? await readJsonBody(req) : {};
      const projectRoot = resolveProjectPath(body.project || url.searchParams.get("project"));
      if (req.method === "PATCH") return sendJson(res, { ok: true, banner: await updateBannerCreative(projectRoot, bannerId, body.patch || {}) });
      return sendJson(res, { ok: true, deleted: await deleteBannerCreative(projectRoot, bannerId) });
    }

    const adTemplateMatch = url.pathname.match(/^\/api\/ad-templates\/([^/]+)$/);
    if (adTemplateMatch && (req.method === "PATCH" || req.method === "DELETE")) {
      const templateId = decodeURIComponent(adTemplateMatch[1]);
      const body = req.method === "PATCH" ? await readJsonBody(req) : {};
      const projectRoot = resolveProjectPath(body.project || url.searchParams.get("project"));
      if (req.method === "PATCH") return sendJson(res, { ok: true, template: await updateAdTemplate(projectRoot, templateId, sanitizeAdTemplateUserPatch(body.patch)) });
      return sendJson(res, { ok: true, deleted: await deleteAdTemplate(projectRoot, templateId) });
    }

    if (url.pathname === "/api/research/products" && req.method === "POST") {
      const body = await readJsonBody(req);
      const projectRoot = resolveProjectPath(body.project);
      return sendJson(res, { ok: true, product: await addProduct(projectRoot, body) });
    }

    if (url.pathname === "/api/research/products/upload-image" && req.method === "POST") {
      const body = await readJsonBody(req);
      const projectRoot = resolveProjectPath(body.project);
      return sendJson(res, { ok: true, image: await addProductImage(projectRoot, body.productId, body) });
    }

    if (url.pathname === "/api/research/products/remove-image" && req.method === "POST") {
      const body = await readJsonBody(req);
      const projectRoot = resolveProjectPath(body.project);
      return sendJson(res, { ok: true, removed: await removeProductImage(projectRoot, body.productId, body.imageId) });
    }

    // 商品URLの内部LP解析前処理
    if (url.pathname === "/api/research/materials" && req.method === "POST") {
      const body = await readJsonBody(req);
      const projectRoot = resolveProjectPath(body.project);
      return sendJson(res, { ok: true, material: await addMaterial(projectRoot, body) });
    }

    // 商品URLの内部LP解析前処理
    if (url.pathname === "/api/research/materials/extract" && req.method === "POST") {
      const body = await readJsonBody(req);
      const projectRoot = resolveProjectPath(body.project);
      const lockKey = `materialExtract:${body.materialId}`;
      if (body.async === false) {
        return withJobLock(res, lockKey, async () => sendJson(res, { ok: true, ...(await extractMaterial(projectRoot, body.materialId)) }));
      }
      const current = runningJobs.get(lockKey);
      // 非同期処理は完了時の finally で必ず解除する。長大LPが10分を超えても
      // 同じ資料の二重実行を許さない。
      if (current) {
        return sendJson(res, { ok: false, errorCode: "ALREADY_RUNNING", jobId: current.jobId || "", message: "すでに実行中です。完了までお待ちください。" }, 409);
      }
      const token = ++jobTokenSeq;
      const jobId = `job_${crypto.randomUUID()}`;
      runningJobs.set(lockKey, { startedAt: Date.now(), token, jobId });
      sendJson(res, {
        ok: true,
        accepted: true,
        jobId,
        job: { id: jobId, materialId: body.materialId, status: "queued", steps: [] }
      }, 202);
      void extractMaterial(projectRoot, body.materialId, { jobId })
        .catch((error) => console.error(`[CMOAI] Material extraction failed (${jobId}):`, error))
        .finally(() => {
          if (runningJobs.get(lockKey)?.token === token) runningJobs.delete(lockKey);
        });
      return;
    }

    // 商品URLの内部LP解析前処理
    if (url.pathname === "/api/research/materials/extract/status" && req.method === "GET") {
      const projectRoot = resolveProjectPath(url.searchParams.get("project"));
      const jobId = url.searchParams.get("jobId") || "";
      const workspace = await getResearchWorkspace(projectRoot);
      const job = workspace.extractionJobs.find((item) => item.id === jobId);
      if (!job) {
        const queued = [...runningJobs.values()].some((item) => item.jobId === jobId);
        if (queued) return sendJson(res, { ok: true, pending: true, job: { id: jobId, status: "queued", steps: [] } });
        return sendJson(res, { ok: false, errorCode: "JOB_NOT_FOUND", message: "抽出ジョブが見つかりません。" }, 404);
      }
      const material = workspace.materials.find((item) => item.id === job.materialId) || null;
      return sendJson(res, { ok: true, pending: job.status === "running", job, material });
    }

    // 表現レギュDB等へのファイル取り込み: PDF/Excel/Word/テキスト/画像を文字起こしして返す。
    if (url.pathname === "/api/research/import-file" && req.method === "POST") {
      const body = await readJsonBody(req);
      const projectRoot = resolveProjectPath(body.project);
      const result = await extractTextFromFile({
        fileName: body.fileName,
        mimeType: body.mimeType,
        dataBase64: body.dataBase64,
        projectRoot
      });
      return sendJson(res, { ok: true, ...result });
    }

    // URLから可読テキストを抽出する(記事LPテンプレのURL取り込み等)。
    if (url.pathname === "/api/research/extract-url" && req.method === "POST") {
      const body = await readJsonBody(req);
      return sendJson(res, { ok: true, ...(await extractTextFromUrl(body.url || "")) });
    }


    if (url.pathname === "/api/research/expression-rules" && req.method === "POST") {
      const body = await readJsonBody(req);
      const projectRoot = resolveProjectPath(body.project);
      return sendJson(res, { ok: true, rule: await addExpressionRule(projectRoot, body) });
    }

    if (url.pathname === "/api/research/facts" && req.method === "POST") {
      const body = await readJsonBody(req);
      const projectRoot = resolveProjectPath(body.project);
      return sendJson(res, { ok: true, fact: await addFact(projectRoot, body) });
    }

    if (url.pathname === "/api/research/facts/extract-ai" && req.method === "POST") {
      const body = await readJsonBody(req);
      const projectRoot = resolveProjectPath(body.project);
      return withJobLock(res, `factExtract:${projectRoot}:${body.productId || ""}`, async () => sendJson(res, { ok: true, ...(await extractProductFactsWithAi(projectRoot, { productId: body.productId || "", webSearch: body.webSearch !== false })) }));
    }

    // AI呼び出しを伴わない無償のNG表現置換API。エージェントのサブスク実行モードが
    // 自前で生成したテキストを保存前に通すためのもので、ジョブロックは不要。
    if (url.pathname === "/api/regulations/apply" && req.method === "POST") {
      const body = await readJsonBody(req);
      const projectRoot = resolveProjectPath(body.project);
      const workspace = await getResearchWorkspace(projectRoot);
      const product = (workspace.products || []).find((item) => item.id === body.productId) || { id: body.productId || "" };
      const instructionPolicy = buildInstructionPolicy(body.additionalInstruction || "");
      const rules = classifyExpressionRules(workspace.expressionRules || [], product, instructionPolicy);
      const target = body.target && typeof body.target === "object" ? body.target : {};
      const result = applyRegulationRules(target, rules.ngRules, instructionPolicy);
      return sendJson(res, { ok: true, result, reviewNotes: result.reviewNotes || "", overriddenRules: rules.overriddenRules });
    }

    // 表現レギュレーションのエディタ「ファイルから取り込み」用。.txt/.md/.csvの本文を
    // AIで構造化ルールに変換し、表現レギュレーションDBへ一括追加する(API実行モード)。
    if (url.pathname === "/api/regulations/import-text" && req.method === "POST") {
      const body = await readJsonBody(req);
      const projectRoot = resolveProjectPath(body.project);
      return withJobLock(res, `regImport:${projectRoot}`, async () => sendJson(res, { ok: true, ...(await importRegulationsFromText(projectRoot, { productId: body.productId || "", text: body.text || "" })) }));
    }

    // 任意フォーマットの本文からAIで表現レギュレーションを抽出して返す(保存はしない。UIで編集後に保存)。
    if (url.pathname === "/api/regulations/extract-text" && req.method === "POST") {
      const body = await readJsonBody(req);
      return sendJson(res, { ok: true, ...(await extractRegulationRulesFromText({ text: body.text || "" })) });
    }

    if (url.pathname === "/api/strategies" && req.method === "POST") {
      const body = await readJsonBody(req);
      const projectRoot = resolveProjectPath(body.project);
      return sendJson(res, { ok: true, strategy: await addStrategy(projectRoot, body) });
    }

    if (url.pathname === "/api/strategies/generate" && req.method === "POST") {
      const body = await readJsonBody(req);
      const projectRoot = resolveProjectPath(body.project);
      return withJobLock(res, `whoWhat:${projectRoot}:${body.productId || ""}`, async () => {
        const context = await resolveContext(projectRoot);
        if (!context.ok) return sendJson(res, { ok: false, message: "\u30d7\u30ed\u30b8\u30a7\u30af\u30c8\u69cb\u9020\u304c\u4e0d\u5b8c\u5168\u3067\u3059\u3002", validation: context.validation, warnings: context.warnings }, 400);
        const result = await generateWhoWhatProposals(context, { productId: body.productId || "" });
        // \u63d0\u6848\u306f\u300c\u63d0\u6848\u4e2d\u300d\u30b9\u30c6\u30fc\u30bf\u30b9\u3067\u81ea\u52d5\u4fdd\u5b58\u3059\u308b(\u4e0d\u8981\u306a\u6848\u306f\u30a2\u30fc\u30ab\u30a4\u30d6\u3067\u623b\u305b\u308b\u305f\u3081\u3001
        // \u30e6\u30fc\u30b6\u30fc\u78ba\u8a8d\u3092\u631f\u307e\u306a\u3044\u3002\u65e7\u30d5\u30ed\u30fc\u306e\u63d0\u6848\u2192\u78ba\u8a8d\u2192\u4fdd\u5b58\u306f\u5ec3\u6b62)
        const saved = [];
        for (const proposal of result.proposals || []) {
          saved.push(await addStrategy(projectRoot, { ...proposal, status: "proposed" }));
        }
        return sendJson(res, { ok: true, ...result, strategies: saved });
      });
    }

    if (url.pathname === "/api/ad-templates" && req.method === "POST") {
      const body = await readJsonBody(req);
      const projectRoot = resolveProjectPath(body.project);
      return sendJson(res, { ok: true, template: await addAdTemplate(projectRoot, body) });
    }

    if (url.pathname === "/api/ad-templates/template-image/status" && req.method === "GET") {
      const templateIds = (url.searchParams.get("templateIds") || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .slice(0, 100);
      return sendJson(res, { ok: true, templates: await getAdTemplateStatuses(appRoot, templateIds) });
    }

    if (url.pathname === "/api/ad-templates/template-image/enqueue" && req.method === "POST") {
      const body = await readJsonBody(req);
      const projectRoot = resolveProjectPath(body.project);
      const job = await prepareTemplateAnalysisJob(projectRoot, body.templateId);
      if (!job.accepted) {
        return sendJson(res, {
          ok: false,
          errorCode: "TEMPLATE_ANALYSIS_ALREADY_ACTIVE",
          message: "このテンプレートは解析待ちまたは解析中です。",
          template: job.claim.template
        }, 409);
      }
      job.taskPromise.catch(() => null);
      return sendJson(res, {
        ok: true,
        accepted: true,
        templateId: body.templateId,
        attemptId: job.attemptId,
        templateProcessingStatus: job.claim.template.templateProcessingStatus,
        template: job.claim.template
      }, 202);
    }

    if (url.pathname === "/api/ad-templates/template-image" && req.method === "POST") {
      const body = await readJsonBody(req);
      const projectRoot = resolveProjectPath(body.project);
      return withJobLock(res, `templateImage:${body.templateId}`, async () => {
        const job = await prepareTemplateAnalysisJob(projectRoot, body.templateId);
        if (!job.accepted) {
          return sendJson(res, {
            ok: false,
            errorCode: "TEMPLATE_ANALYSIS_ALREADY_ACTIVE",
            message: "このテンプレートは解析待ちまたは解析中です。",
            template: job.claim.template
          }, 409);
        }
        return sendJson(res, { ok: true, template: await job.taskPromise });
      });
    }

    if (url.pathname === "/api/ad-templates/upload-image" && req.method === "POST") {
      const body = await readJsonBody(req);
      return sendJson(res, { ok: true, ...(await saveSharedUpload(body.fileName, body.dataBase64)) });
    }

    if (url.pathname === "/shared-file") {
      const relativePath = url.searchParams.get("path") || "";
      const sharedRoot = path.join(appRoot, "data");
      const target = path.resolve(sharedRoot, relativePath);
      if (!target.startsWith(sharedRoot)) return sendJson(res, { ok: false, message: "invalid path" }, 400);
      const body = await fs.readFile(target);
      return send(res, 200, contentTypeFor(target), body);
    }

    if (url.pathname === "/api/banners" && req.method === "POST") {
      const body = await readJsonBody(req);
      const projectRoot = resolveProjectPath(body.project);
      return sendJson(res, { ok: true, banner: await addBannerCreative(projectRoot, body) });
    }

    if (url.pathname === "/api/banners/generate-prompt" && req.method === "POST") {
      const body = await readJsonBody(req);
      const projectRoot = resolveProjectPath(body.project);
      const job = await prepareBannerPromptJob(projectRoot, body.bannerId);
      if (!job.accepted) return sendJson(res, { ok: false, errorCode: "PROMPT_ALREADY_ACTIVE", message: "コピー設計は実行中または待機中です。" }, 409);
      const result = await runPromptJobs(projectRoot, [job]);
      if (!result.banners?.[0]) return sendJson(res, { ok: false, message: result.errors?.[0]?.message || "コピー設計に失敗しました。" }, 500);
      return sendJson(res, { ok: true, banner: result.banners[0] });
    }

    if (url.pathname === "/api/banners/generate-prompt-batch" && req.method === "POST") {
      const body = await readJsonBody(req);
      const projectRoot = resolveProjectPath(body.project);
      const bannerIds = [...new Set((Array.isArray(body.bannerIds) ? body.bannerIds : []).map(String).filter(Boolean))];
      const jobs = [];
      const claimErrors = [];
      for (const bannerId of bannerIds) {
        const job = await prepareBannerPromptJob(projectRoot, bannerId);
        if (job.accepted) jobs.push(job);
        else claimErrors.push({ bannerId, message: "コピー設計は実行中または待機中です。" });
      }
      const result = jobs.length ? await runPromptJobs(projectRoot, jobs) : { banners: [], errors: [] };
      return sendJson(res, { ok: true, banners: result.banners || [], errors: [...claimErrors, ...(result.errors || [])] });
    }

    if (url.pathname === "/api/banners/spread" && req.method === "POST") {
      const body = await readJsonBody(req);
      const projectRoot = resolveProjectPath(body.project);
      try {
        const banners = await runClaimedPromptOperation(projectRoot, body.bannerId, async () => {
        const workspace = await getBannerGenerationWorkspace(projectRoot);
          return spreadBannerIdeas(projectRoot, body.bannerId, workspace);
        });
        return sendJson(res, { ok: true, banners });
      } catch (error) {
        if (error.code === "PROMPT_ALREADY_ACTIVE") return sendJson(res, { ok: false, errorCode: error.code, message: error.message }, 409);
        throw error;
      }
    }

    if (url.pathname === "/api/banners/revise" && req.method === "POST") {
      const body = await readJsonBody(req);
      const projectRoot = resolveProjectPath(body.project);
      try {
        const banner = await runClaimedPromptOperation(projectRoot, body.bannerId, async () => {
        const workspace = await getBannerGenerationWorkspace(projectRoot);
          return reviseBannerCreative(projectRoot, body.bannerId, workspace);
        });
        return sendJson(res, { ok: true, banner });
      } catch (error) {
        if (error.code === "PROMPT_ALREADY_ACTIVE") return sendJson(res, { ok: false, errorCode: error.code, message: error.message }, 409);
        throw error;
      }
    }

    if (url.pathname === "/api/banners/generate-full-batch" && req.method === "POST") {
      const body = await readJsonBody(req);
      const projectRoot = resolveProjectPath(body.project);
      const bannerIds = [...new Set((Array.isArray(body.bannerIds) ? body.bannerIds : []).map(String).filter(Boolean))];
      if (!bannerIds.length) return sendJson(res, { ok: false, message: "生成するバナー案を1件以上指定してください。" }, 400);
      if (bannerIds.length > 25) return sendJson(res, { ok: false, message: "一度に生成できるバナー案は25件までです。" }, 400);
      const allBanners = await listBannerCreatives(projectRoot);
      const selected = bannerIds.map((bannerId) => allBanners.find((item) => item.id === bannerId)).filter(Boolean);
      const missingIds = bannerIds.filter((bannerId) => !selected.some((item) => item.id === bannerId));
      const promptJobs = [];
      const imageJobs = [];
      const errors = missingIds.map((bannerId) => ({ bannerId, errorCode: "NOT_FOUND", message: "バナーが見つかりません。" }));
      const workspace = await getBannerGenerationWorkspace(projectRoot);
      for (const banner of selected) {
        const pipeline = await reconcileBannerPipeline(projectRoot, banner.id, workspace);
        const nextNode = pipeline.nextNode;
        if (!nextNode) continue;
        if (pipeline.pipelineNodes[nextNode]?.retryExhausted) {
          errors.push({ bannerId: banner.id, errorCode: "PIPELINE_RETRY_EXHAUSTED", message: "同じ入力で再試行上限に達しました。入力を見直して再生成してください。" });
          continue;
        }
        if (["copyplan", "prompt"].includes(nextNode)) {
          const promptJob = await prepareBannerPromptJob(projectRoot, banner.id, {
            startNode: nextNode,
            inputHash: pipeline.expectedInputHashes[nextNode]
          });
          if (promptJob.accepted) promptJobs.push(promptJob);
          else errors.push({ bannerId: banner.id, errorCode: "PROMPT_ALREADY_ACTIVE", message: "コピー設計は実行中または待機中です。" });
          continue;
        }
        try {
          const imageJob = await prepareBannerImageJob(projectRoot, banner.id, null, pipeline.expectedInputHashes.image);
          if (imageJob.accepted) imageJobs.push({ bannerId: banner.id, ...imageJob });
          else errors.push({ bannerId: banner.id, errorCode: "IMAGE_ALREADY_ACTIVE", message: "画像生成は実行中または待機中です。" });
        } catch (error) {
          errors.push({ bannerId: banner.id, errorCode: "QUEUE_FAILED", message: error.message });
        }
      }
      imageJobs.forEach((item) => item.taskPromise.catch(() => null));
      if (promptJobs.length) {
        runFullBannerBatchInBackground(projectRoot, promptJobs).catch(async (error) => {
          for (const { bannerId, attemptId } of promptJobs) await failBannerPromptGeneration(projectRoot, bannerId, attemptId, error.message);
        });
      }
      return sendJson(res, {
        ok: true,
        accepted: true,
        promptQueuedCount: promptJobs.length,
        imageQueuedCount: imageJobs.length,
        errors
      }, 202);
    }

    if (url.pathname === "/api/banners/generate-image" && req.method === "POST") {
      const body = await readJsonBody(req);
      const projectRoot = resolveProjectPath(body.project);
      const job = await prepareBannerImageJob(projectRoot, body.bannerId);
      if (!job.accepted) {
        return sendJson(res, { ok: false, errorCode: "IMAGE_ALREADY_ACTIVE", message: "画像生成は実行中または待機中です。", banner: job.claim.banner }, 409);
      }
      return sendJson(res, { ok: true, banner: await job.taskPromise, recoveredStale: job.claim.recoveredStale });
    }

    if (url.pathname === "/api/banners/generate-images-batch" && req.method === "POST") {
      const body = await readJsonBody(req);
      const projectRoot = resolveProjectPath(body.project);
      const bannerIds = [...new Set((Array.isArray(body.bannerIds) ? body.bannerIds : []).map(String).filter(Boolean))];
      if (!bannerIds.length) return sendJson(res, { ok: false, message: "生成するバナー案を1件以上指定してください。" }, 400);
      if (bannerIds.length > 25) return sendJson(res, { ok: false, message: "一度に画像生成できるバナー案は25件までです。" }, 400);
      const prepared = [];
      const errors = [];
      for (const bannerId of bannerIds) {
        try {
          const job = await prepareBannerImageJob(projectRoot, bannerId);
          if (!job.accepted) {
            errors.push({ bannerId, errorCode: "IMAGE_ALREADY_ACTIVE", message: "画像生成は実行中または待機中です。" });
            continue;
          }
          prepared.push({ bannerId, ...job });
        } catch (error) {
          errors.push({ bannerId, errorCode: "QUEUE_FAILED", message: error.message });
        }
      }
      // HTTP接続はキュー受付だけで返す。各taskは内部で失敗をDBへ保存するため、
      // rejectをここで消費しつつサーバーワーカーはレスポンス後も処理を継続する。
      prepared.forEach((item) => item.taskPromise.catch(() => null));
      return sendJson(res, {
        ok: true,
        accepted: true,
        queuedCount: prepared.length,
        banners: prepared.map((item) => item.claim.banner),
        errors
      }, 202);
    }

    if (url.pathname === "/api/banners/edit-image" && req.method === "POST") {
      const body = await readJsonBody(req);
      const projectRoot = resolveProjectPath(body.project);
      const rawEditMode = String(body.editMode || "").trim();
      if (rawEditMode && rawEditMode !== "range" && rawEditMode !== "full") {
        return sendJson(res, { ok: false, errorCode: "IMAGE_EDIT_INPUT_INVALID", message: "修正方式を確認してください。" }, 400);
      }
      const maskBase64 = String(body.maskBase64 || "").replace(/^data:[^;]+;base64,/, "");
      const maskBuffer = Buffer.from(maskBase64, "base64");
      const editMode = normalizeBannerEditMode(rawEditMode, Boolean(maskBuffer.length));
      let regions = [];
      let instruction = String(body.instruction || "").trim();
      if (editMode === "full") {
        if (maskBase64 || (Array.isArray(body.regions) && body.regions.length)) {
          return sendJson(res, { ok: false, errorCode: "IMAGE_EDIT_INPUT_INVALID", message: "全体修正には範囲指定を含めないでください。" }, 400);
        }
        if (!instruction || instruction.length > 2000) {
          return sendJson(res, { ok: false, errorCode: "IMAGE_EDIT_INPUT_INVALID", message: "修正指示を1〜2000文字で入力してください。" }, 400);
        }
      } else if (!maskBuffer.length) {
        return sendJson(res, { ok: false, errorCode: "IMAGE_EDIT_INPUT_INVALID", message: "範囲と修正指示を確認してください。" }, 400);
      } else if (Array.isArray(body.regions) && body.regions.length) {
        regions = normalizeEditRegionsFromBody(body.regions);
        const validation = validateEditRegions(regions);
        if (!validation.ok) {
          return sendJson(res, { ok: false, errorCode: "IMAGE_EDIT_INPUT_INVALID", message: "範囲と修正指示を確認してください。" }, 400);
        }
        instruction = buildCompositeEditInstruction(regions);
      } else if (!instruction || instruction.length > 2000) {
        return sendJson(res, { ok: false, errorCode: "IMAGE_EDIT_INPUT_INVALID", message: "範囲と修正指示を確認してください。" }, 400);
      }
      const job = await prepareBannerImageEditJob(projectRoot, body.bannerId, (banner, context) => (
        editBannerImageWithGptImage2(projectRoot, banner, { editMode, maskBuffer, instruction, regions, context })
      ), { editMode });
      if (!job.accepted) {
        if (job.claim.reason === "active") {
          return sendJson(res, { ok: false, errorCode: "IMAGE_ALREADY_ACTIVE", message: "画像生成または修正は実行中です。完了までお待ちください。" }, 409);
        }
        if (job.claim.reason === "missing_source") {
          return sendJson(res, { ok: false, errorCode: "IMAGE_EDIT_SOURCE_MISSING", message: "先に画像を生成してください。" }, 400);
        }
        return sendJson(res, { ok: false, errorCode: "IMAGE_EDIT_INPUT_INVALID", message: `${editMode === "full" ? "全体修正" : "範囲指定修正"}を開始できません。` }, 400);
      }
      job.taskPromise.catch(() => null);
      return sendJson(res, {
        ok: true,
        accepted: true,
        editMode,
        banner: job.claim.banner
      }, 202);
    }

    if (url.pathname === "/api/run" && req.method === "POST") {
      const body = await readJsonBody(req);
      const projectRoot = resolveProjectPath(body.project);
      return withJobLock(res, `run:${projectRoot}:${body.actionId}`, async () =>
        sendJson(res, await runAction({ actionId: body.actionId, projectRoot, dryRun: Boolean(body.dryRun), input: body.input || {} })));
    }

    if (url.pathname === "/project-file") {
      const projectName = path.basename(url.searchParams.get("project") || "");
      const relativePath = url.searchParams.get("path") || "";
      const projectRoot = resolveProjectPath("./projects/" + projectName);
      const target = path.resolve(projectRoot, relativePath);
      if (!target.startsWith(projectRoot)) return sendJson(res, { ok: false, message: "invalid path" }, 400);
      const body = await fs.readFile(target);
      return send(res, 200, contentTypeFor(target), body);
    }

    if (url.pathname === "/") return send(res, 200, "text/html; charset=utf-8", await fs.readFile(path.join(__dirname, "ui/index.html"), "utf8"));
    if (url.pathname === "/app.js") return send(res, 200, "text/javascript; charset=utf-8", await fs.readFile(path.join(__dirname, "ui/app.js"), "utf8"));
    if (url.pathname === "/core/banner-range-edit.js") return send(res, 200, "text/javascript; charset=utf-8", await fs.readFile(path.join(__dirname, "core/banner-range-edit.js"), "utf8"));
    if (url.pathname === "/styles.css") return send(res, 200, "text/css; charset=utf-8", await fs.readFile(path.join(__dirname, "ui/styles.css"), "utf8"));
    if (url.pathname.startsWith("/assets/")) {
      const assetName = path.basename(url.pathname);
      const asset = await fs.readFile(path.join(__dirname, "ui/assets", assetName));
      return send(res, 200, contentTypeFor(assetName), asset);
    }

    sendJson(res, { ok: false, message: "not found" }, 404);
  } catch (error) {
    sendJson(res, { ok: false, errorCode: "SERVER_ERROR", message: error.message }, 500);
  }
});

// A previous instance of this same process (killed by a crash, or still shutting
// down after `node --watch` triggered a restart) can briefly hold the port. Retry
// a few times with a short backoff instead of failing immediately, since the old
// process usually releases the port within a second or two on its own.
const LISTEN_RETRY_DELAYS_MS = [300, 600, 1000, 2000, 3000];
let listenRetryCount = 0;
function startListening() {
  server.listen(port, () => {
    console.log(`CMOAI local UI: http://localhost:${port}`);
    recoverTemplateAnalysisQueue().catch((error) => {
      console.error("[CMOAI] Template analysis recovery failed:", error);
    });
    if (!templateAnalysisRecoveryTimer) {
      templateAnalysisRecoveryTimer = setInterval(() => {
        recoverTemplateAnalysisQueue().catch((error) => {
          console.error("[CMOAI] Template analysis recovery sweep failed:", error);
        });
      }, 60_000);
      templateAnalysisRecoveryTimer.unref();
    }
    recoverBannerJobQueues().catch((error) => {
      console.error("[CMOAI] Banner job recovery failed:", error);
    });
    if (!bannerJobRecoveryTimer) {
      bannerJobRecoveryTimer = setInterval(() => {
        recoverBannerJobQueues().catch((error) => {
          console.error("[CMOAI] Banner job recovery sweep failed:", error);
        });
      }, 60_000);
      bannerJobRecoveryTimer.unref();
    }
  });
}
server.on("error", (error) => {
  if (error.code !== "EADDRINUSE" || listenRetryCount >= LISTEN_RETRY_DELAYS_MS.length) {
    console.error(`[CMOAI] Could not start on port ${port}: ${error.message}`);
    if (error.code === "EADDRINUSE") {
      console.error(`[CMOAI] Port ${port} is still in use after ${listenRetryCount} retries. Stop whatever is holding it, then save a file to retry.`);
    }
    return;
  }
  const delay = LISTEN_RETRY_DELAYS_MS[listenRetryCount];
  listenRetryCount += 1;
  console.warn(`[CMOAI] Port ${port} is in use (likely a previous instance still shutting down). Retrying in ${delay}ms... (${listenRetryCount}/${LISTEN_RETRY_DELAYS_MS.length})`);
  setTimeout(startListening, delay);
});
startListening();

function createSlug(value) {
  const slug = String(value || "new-project")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `${slug || "project"}-${stamp}`;
}

function sendJson(res, value, status = 200) {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(value, null, 2));
}

function contentTypeFor(fileName) {
  if (fileName.endsWith(".png")) return "image/png";
  if (fileName.endsWith(".jpg") || fileName.endsWith(".jpeg")) return "image/jpeg";
  if (fileName.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

// Ad templates are a shared DB (data/ad-templates.json, not per-project), so uploaded
// reference images live alongside it in data/ad-template-uploads/ rather than under
// any single project's outputs/, and are served back via /shared-file.
async function saveSharedUpload(fileName, dataBase64) {
  if (!dataBase64) throw new Error("画像データがありません。");
  const safeName = path.basename(String(fileName || "upload.png")).replace(/[^a-zA-Z0-9._-]/g, "_") || "upload.png";
  const uploadId = "upload_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const relDir = path.join("ad-template-uploads", uploadId);
  const dir = path.join(appRoot, "data", relDir);
  await fs.mkdir(dir, { recursive: true });
  const base64Body = String(dataBase64).replace(/^data:[^;]+;base64,/, "");
  await fs.writeFile(path.join(dir, safeName), Buffer.from(base64Body, "base64"));
  const relPath = path.join(relDir, safeName).split(path.sep).join("/");
  return { relative: relPath, url: "/shared-file?path=" + encodeURIComponent(relPath) };
}

function send(res, status, type, body) {
  const headers = { "content-type": type };
  if (type.startsWith("text/html") || type.startsWith("text/javascript") || type.startsWith("text/css")) {
    headers["cache-control"] = "no-store, max-age=0";
  }
  res.writeHead(status, headers);
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}
