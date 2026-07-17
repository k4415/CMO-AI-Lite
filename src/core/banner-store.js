import crypto from "node:crypto";
import path from "node:path";
import { pathExists, readJson, writeJson, withFileLock } from "./project-store.js";
import { generateBannerCreativeProposal } from "./banner-ai.js";
import { buildTemplateCopyInput } from "./banner-copy-ai.js";
import { generateBannerCopyPlan } from "./banner-copyplan-ai.js";
import { buildCopySlotPlan, copyBriefMeetsSlotRequirements, findSlotLengthViolations } from "./banner-copy-slots.js";
import { buildApprovedClaimSnapshot } from "./banner-approved-claims.js";
import { buildInstructionPolicy, createLockedContentSnapshot } from "./banner-instruction-policy.js";
import { assertTemplateReadyForGeneration } from "./banner-generation-contract.js";
import { listAdTemplates } from "./ad-template-store.js";
import { listStrategies } from "./strategy-store.js";
import {
  buildPipelineInputHashes,
  buildPipelineOutputHashes,
  invalidatePipelineFrom,
  markPipelineNode,
  nextPipelineNode,
  normalizePipelineState,
  reconcilePipelineState,
  restartNodeForPipelineError
} from "./banner-pipeline-state.js";

const BANNERS_PATH = "data/banner-creatives.json";
export async function ensureBannerData(projectRoot) {
  if (!(await pathExists(path.join(projectRoot, BANNERS_PATH)))) await writeJson(projectRoot, BANNERS_PATH, []);
}

export async function listBannerCreatives(projectRoot) {
  await ensureBannerData(projectRoot);
  return readJson(projectRoot, BANNERS_PATH);
}

export async function reconcileBannerPipeline(projectRoot, bannerId, context = {}) {
  await ensureBannerData(projectRoot);
  return withFileLock(path.join(projectRoot, BANNERS_PATH), async () => {
    const banners = await readJson(projectRoot, BANNERS_PATH);
    const index = banners.findIndex((item) => item.id === bannerId);
    if (index < 0) throw new Error(`バナーが見つかりません: ${bannerId}`);
    const hadPipelineNodes = Boolean(banners[index]?.pipelineNodes && typeof banners[index].pipelineNodes === "object");
    const current = normalizeBanner(banners[index]);
    if (!hadPipelineNodes && current.imageGenerationStatus === "completed" && current.generatedImagePath) {
      return {
        banner: current,
        pipelineNodes: current.pipelineNodes,
        nextNode: null,
        expectedInputHashes: {},
        currentOutputHashes: {}
      };
    }
    const runtimeContext = buildBannerPipelineContext(current, context);
    const expectedInputHashes = buildPipelineInputHashes(runtimeContext);
    const currentOutputHashes = buildPipelineOutputHashes(runtimeContext);
    const pipelineNodes = reconcilePipelineState(current.pipelineNodes, expectedInputHashes, currentOutputHashes);
    const nextNode = nextPipelineNode({ ...current, pipelineNodes }, expectedInputHashes, currentOutputHashes);
    banners[index] = normalizeBanner({ ...current, pipelineNodes, updatedAt: new Date().toISOString() });
    await writeJson(projectRoot, BANNERS_PATH, banners);
    return { banner: banners[index], pipelineNodes, nextNode, expectedInputHashes, currentOutputHashes };
  });
}

function buildBannerPipelineContext(banner, context = {}) {
  const product = (context.products || []).find((item) => item.id === banner.productId) || context.product || {};
  const strategy = (context.strategies || []).find((item) => item.id === banner.strategyId) || context.strategy || {};
  const template = (context.adTemplates || []).find((item) => item.id === banner.templateAdId) || context.template || null;
  return {
    banner,
    product,
    strategy,
    template,
    copySlotPlan: buildCopySlotPlan(template),
    approvedClaimSnapshot: banner.approvedClaimSnapshot,
    creativeHypothesis: banner.creativeHypothesis,
    categoryRelation: banner.categoryRelation,
    expressionRules: context.expressionRules || [],
    referenceAssets: context.referenceAssets
  };
}

async function loadFreshBannerPipelineWorkspace(projectRoot) {
  const [products, strategies, expressionRules, adTemplates] = await Promise.all([
    readJson(projectRoot, "data/products.json").catch(() => []),
    listStrategies(projectRoot),
    readJson(projectRoot, "data/expression-rules.json").catch(() => []),
    listAdTemplates()
  ]);
  return { products, strategies, expressionRules, adTemplates };
}

function assertCurrentPipelineAttemptInput(current, attemptId, workspace) {
  if (!attemptId) return;
  const state = normalizePipelineState(current.pipelineNodes);
  const protectedNodes = Object.keys(state).filter((node) => (
    state[node].inputHash
    && (state[node].status === "completed" || state[node].attemptId === attemptId)
  ));
  if (!protectedNodes.length) return;
  const expected = buildPipelineInputHashes(buildBannerPipelineContext(current, workspace));
  const staleNode = protectedNodes.find((node) => state[node].inputHash !== expected[node]);
  if (!staleNode) return;
  const error = new Error("生成中に入力が変更されました。古い実行結果は保存しませんでした。");
  error.code = "STALE_PIPELINE_ATTEMPT";
  error.restartNode = staleNode;
  throw error;
}

function markCompletedPipelineNodes(banner, patch, context, nodes, attemptId = "") {
  const merged = normalizeBanner({ ...banner, ...patch });
  const runtimeContext = buildBannerPipelineContext(merged, context);
  const expected = buildPipelineInputHashes(runtimeContext);
  const outputs = buildPipelineOutputHashes(runtimeContext);
  let pipelineNodes = merged.pipelineNodes;
  for (const node of nodes) {
    if (!expected[node] || !outputs[node]) continue;
    pipelineNodes = markPipelineNode(pipelineNodes, node, {
      status: "completed",
      inputHash: expected[node],
      outputHash: outputs[node],
      attemptId,
      errorCode: "",
      errorMessage: "",
      retryCount: 0,
      retryExhausted: false
    });
  }
  return pipelineNodes;
}

function markFailedPipelineNode(banner, error, attemptId = "") {
  const node = restartNodeForPipelineError(error);
  const previous = normalizePipelineState(banner.pipelineNodes)[node];
  const sameFailure = previous.errorCode === clean(error?.code) && previous.inputHash;
  const retryCount = sameFailure ? previous.retryCount + 1 : 0;
  return markPipelineNode(banner.pipelineNodes, node, {
    status: "failed",
    attemptId,
    errorCode: clean(error?.code) || "PIPELINE_NODE_FAILED",
    errorMessage: clean(error?.message),
    retryCount,
    retryExhausted: sameFailure && retryCount >= 1
  });
}

export async function addBannerCreative(projectRoot, input) {
  await ensureBannerData(projectRoot);
  return withFileLock(path.join(projectRoot, BANNERS_PATH), async () => {
    const banners = await readJson(projectRoot, BANNERS_PATH);
    const now = new Date().toISOString();
    const banner = normalizeBanner({
      ...input,
      id: createId("ban"),
      productionStatus: input.productionStatus || "not_started",
      imageGenerationStatus: input.imageGenerationStatus || "not_started",
      createdAt: now,
      updatedAt: now
    });
    if (!banner.productId) throw new Error("\u30d0\u30ca\u30fc\u5236\u4f5c\u306b\u306f\u5546\u54c1\u30ea\u30ec\u30fc\u30b7\u30e7\u30f3\u304c\u5fc5\u8981\u3067\u3059\u3002");
    if (!banner.strategyId) throw new Error("\u30d0\u30ca\u30fc\u5236\u4f5c\u306b\u306fWHO-WHAT\u30ea\u30ec\u30fc\u30b7\u30e7\u30f3\u304c\u5fc5\u8981\u3067\u3059\u3002");
    banners.unshift(banner);
    await writeJson(projectRoot, BANNERS_PATH, banners);
    return banner;
  });
}

export async function generateBannerPrompt(projectRoot, bannerId, context = {}, options = {}) {
  const result = await generateBannerPromptBatch(projectRoot, [bannerId], context, options);
  if (result.banners?.[0]) return result.banners[0];
  const message = result.errors?.[0]?.message || `バナーが見つかりません: ${bannerId}`;
  throw new Error(message);
}

export async function generateBannerPromptBatch(projectRoot, bannerIds, context = {}, options = {}) {
  const ids = [...new Set((Array.isArray(bannerIds) ? bannerIds : []).map(clean).filter(Boolean))];
  if (!ids.length) throw new Error("生成するバナー案を1件以上指定してください。");
  if (ids.length > 5) throw new Error("一度に生成できるバナー案は5件までです。");
  const allBanners = await listBannerCreatives(projectRoot);
  const selected = ids.map((id) => {
    const banner = allBanners.find((item) => item.id === id);
    if (!banner) throw new Error(`バナーが見つかりません: ${id}`);
    return banner;
  });
  const plansByBannerId = options.plansByBannerId && typeof options.plansByBannerId === "object" ? options.plansByBannerId : {};
  const plans = selected.map((banner) => plansByBannerId[banner.id] || null);
  const errors = [];
  const plannedItems = [];
  for (let index = 0; index < selected.length; index += 1) {
    const banner = selected[index];
    const plan = plans[index];
    const attemptId = options.attemptIds?.[banner.id] || "";
    try {
      const plannedBanner = await updateBannerForPromptAttempt(projectRoot, banner.id, attemptId, {});
      plannedItems.push({ banner: plannedBanner, plan, attemptId });
    } catch (error) {
      errors.push({ bannerId: banner.id, message: error.message });
    }
  }
  const copyPrepared = await prepareCopyBriefsForPromptItems(projectRoot, plannedItems, context, {
    ...options,
    allBanners
  });
  errors.push(...copyPrepared.errors);
  const results = [];
  for (const item of copyPrepared.items) {
    try {
      const generated = await generateBannerPromptWithGuidance(projectRoot, item.banner, context, item.plan, { ...options, attemptId: item.attemptId });
      results.push(generated);
    } catch (error) {
      errors.push({ bannerId: item.banner.id, message: error.message });
    }
  }
  return { banners: results, errors };
}

export async function ensureBannerCopyBriefsForPromptJobs(projectRoot, promptJobs, context = {}, options = {}) {
  const allBanners = await listBannerCreatives(projectRoot);
  const items = (promptJobs || [])
    .map((job) => {
      const banner = allBanners.find((item) => item.id === job.bannerId);
      return banner ? { banner, plan: job.promptPlan || null, attemptId: clean(job.attemptId) } : null;
    })
    .filter(Boolean);
  return prepareCopyBriefsForPromptItems(projectRoot, items, context, {
    ...options,
    allBanners
  });
}

async function prepareCopyBriefsForPromptItems(projectRoot, items, context = {}, options = {}) {
  const errors = [];
  const ready = [];
  const groups = groupCopyBriefItems(items, options.forceCopyBrief, context.adTemplates || []);
  const alreadyReadyIds = new Set(groups.flatMap((group) => group.items.map((item) => item.banner.id)));
  for (const item of items) {
    if (!alreadyReadyIds.has(item.banner.id)) ready.push(item);
  }

  const executeGroup = async (group) => {
    const copyStartedAt = new Date().toISOString();
    const copyStartMs = Date.now();
    try {
      const first = group.items[0]?.banner || {};
      const product = (context.products || []).find((item) => item.id === first.productId) || {};
      const strategy = (context.strategies || []).find((item) => item.id === first.strategyId) || {};
      const template = (context.adTemplates || []).find((item) => item.id === first.templateAdId) || null;
      assertTemplateReadyForGeneration(template);
      const copyBriefGenerator = options.copyBriefGenerator || generateBannerCopyPlan;
      const preflight = await prepareCopyplanGroupContext(projectRoot, group.items, { product, strategy, template });
      errors.push(...preflight.errors);
      if (!preflight.items.length) return;
      const generated = await copyBriefGenerator({
        banners: preflight.items.map((item) => item.banner),
        product,
        strategy,
        expressionRules: context.expressionRules || [],
        template,
        extraInstruction: effectiveBannerInstruction(group.items[0]?.banner),
        approvedClaimSnapshot: preflight.approvedClaimSnapshot,
        generationRunId: preflight.generationRunId,
        candidateGroupId: preflight.candidateGroupId,
        candidateIndexes: preflight.candidateIndexes
      });
      const copyCompletedAt = new Date().toISOString();
      const copyDurationMs = Date.now() - copyStartMs;
      const candidateResults = Array.isArray(generated?.results) ? generated.results : [];
      if (candidateResults.length < preflight.items.length) {
        throw new Error("コピー開発の返却件数が不足しています。");
      }
      for (let index = 0; index < preflight.items.length; index += 1) {
        const current = preflight.items[index];
        const candidate = candidateResults.find((result) => result?.bannerId === current.banner.id) || candidateResults[index];
        const history = mergeCopyReviewHistory(current.banner.copyReviewHistory, candidate?.reviewHistory, current.attemptId, current.banner.id);
        const latestHistory = history.at(-1) || null;
        const latestCopyBrief = candidate?.copyBrief || latestHistory?.copyBrief || null;
        const commonPatch = {
          categoryRelation: candidate?.categoryRelation || generated.categoryRelation,
          bannerGenerationContract: candidate?.bannerGenerationContract || null,
          copyReviewHistory: history,
          copyQualityReview: null,
          communicationReview: null,
          messagePlan: latestCopyBrief?.messagePlan || null,
          templateFitDecision: latestCopyBrief?.templateFitDecision || null,
          originalityReview: null,
          authorizedClaimSet: latestCopyBrief?.authorizedClaimSet || null,
          approvedClaimSnapshot: current.banner.approvedClaimSnapshot || preflight.approvedClaimSnapshot,
          creativeHypothesis: generated.hypothesis || current.banner.creativeHypothesis || null,
          generationRunId: clean(candidate?.generationRunId || latestCopyBrief?.generationRunId) || current.banner.generationRunId,
          candidateGroupId: clean(candidate?.candidateGroupId || latestCopyBrief?.candidateGroupId) || current.banner.candidateGroupId,
          candidateIndex: Number.isInteger(candidate?.candidateIndex)
            ? candidate.candidateIndex
            : (Number.isInteger(latestCopyBrief?.candidateIndex)
              ? latestCopyBrief.candidateIndex
              : (Number.isInteger(current.banner.candidateIndex) ? current.banner.candidateIndex : null)),
          warnings: mergeWarnings(current.banner.warnings, candidate?.warnings)
        };
        if (["passed", "warning"].includes(candidate?.status) && candidate.copyBrief) {
          const acceptedPatch = {
            ...commonPatch,
            copyBrief: candidate.copyBrief,
            variationAxis: candidate.copyBrief.appealAxis || current.banner.variationAxis,
            productionStatus: "prompt_ready",
            lastError: "",
            lastErrorAt: ""
          };
          acceptedPatch.pipelineNodes = markCompletedPipelineNodes(
            current.banner,
            acceptedPatch,
            context,
            ["copyplan"],
            current.attemptId
          );
          acceptedPatch.pipelineNodes = markPipelineNode(acceptedPatch.pipelineNodes, "copyplan", {
            startedAt: copyStartedAt,
            completedAt: copyCompletedAt,
            durationMs: copyDurationMs
          });
          const updated = await updateBannerForPromptAttempt(projectRoot, current.banner.id, current.attemptId, acceptedPatch);
          ready.push({ ...current, banner: updated });
        }
      }
    } catch (error) {
      for (const current of group.items) {
        errors.push({ bannerId: current.banner.id, code: error.code || "COPYPLAN_FAILED", message: error.message });
        const failedPatch = {
          productionStatus: productionStatusForPipelineError(error),
          ...(current.attemptId ? { promptGenerationLease: null } : {}),
          lastError: error.message,
          lastErrorAt: new Date().toISOString()
        };
        failedPatch.pipelineNodes = markFailedPipelineNode(current.banner, error, current.attemptId);
        await updateBannerForPromptAttempt(projectRoot, current.banner.id, current.attemptId, {
          ...failedPatch
        }).catch(() => null);
      }
    }
  };
  const runCopyGroup = typeof options.runCopyGroup === "function" ? options.runCopyGroup : (task) => task();
  await Promise.all(groups.map((group) => runCopyGroup(() => executeGroup(group))));
  return { items: ready, errors };
}

async function prepareCopyplanGroupContext(projectRoot, items, { product, strategy, template }) {
  const generationRunIds = uniqueNonEmpty(items.map((item) => item.banner?.generationRunId));
  const candidateGroupIds = uniqueNonEmpty(items.map((item) => item.banner?.candidateGroupId));
  if (generationRunIds.length > 1 || candidateGroupIds.length > 1) {
    const error = new Error("同じ生成group内でgenerationRunIdまたはcandidateGroupIdが競合しています。");
    error.code = "CANDIDATE_GROUP_ID_CONFLICT";
    throw error;
  }
  const generationRunId = generationRunIds[0] || crypto.randomUUID();
  const candidateGroupId = candidateGroupIds[0] || crypto.randomUUID();
  const candidateIndexes = items.map((item, index) => (
    Number.isInteger(item.banner?.candidateIndex) ? item.banner.candidateIndex : index
  ));
  const stampedItems = await persistBannerGroupPatches(
    projectRoot,
    items.map((item, index) => ({
      ...item,
      patch: {
        generationRunId,
        candidateGroupId,
        candidateIndex: candidateIndexes[index]
      }
    })),
    { acknowledgeHypothesisIdentityStamp: true }
  );
  const instructionPolicy = buildInstructionPolicy(effectiveBannerInstruction(stampedItems[0]?.banner));
  const approvedClaimSnapshot = buildApprovedClaimSnapshot({ product, strategy, instructionPolicy });
  const persisted = await persistBannerGroupPatches(projectRoot, stampedItems.map((item) => ({
    ...item,
    patch: { approvedClaimSnapshot }
  })));
  return {
    items: persisted,
    errors: [],
    approvedClaimSnapshot,
    generationRunId,
    candidateGroupId,
    candidateIndexes
  };
}

async function prepareHypothesisContractsForGroup(projectRoot, items, context) {
  return prepareCopyplanGroupContext(projectRoot, items, context);
}

const IDENTITY_STAMP_KEYS = new Set([
  "generationRunId",
  "candidateGroupId",
  "candidateIndex"
]);

function applyHypothesisIdentityStamp(current, entry, freshWorkspace) {
  const patch = entry.patch && typeof entry.patch === "object" ? entry.patch : {};
  const invalidKeys = Object.keys(patch).filter((key) => !IDENTITY_STAMP_KEYS.has(key));
  if (invalidKeys.length) {
    const error = new Error("仮説input baselineの更新にはgroup identity以外を含められません。");
    error.code = "INVALID_HYPOTHESIS_IDENTITY_STAMP";
    throw error;
  }
  const merged = normalizeBanner({ ...current, ...patch });
  if (!entry.attemptId) return merged;
  const node = normalizePipelineState(merged.pipelineNodes).copyplan;
  if (node.status !== "running" || node.attemptId !== entry.attemptId) {
    const error = new Error("copyplan identityを付与するattemptがcopyplan nodeを所有していません。");
    error.code = "HYPOTHESIS_IDENTITY_STAMP_NODE_MISMATCH";
    throw error;
  }
  return refreshRunningCopyplanInputHash(merged, entry.attemptId, freshWorkspace);
}

function refreshRunningCopyplanInputHash(banner, attemptId, workspace) {
  if (!attemptId) return banner;
  const node = normalizePipelineState(banner.pipelineNodes).copyplan;
  if (node.status !== "running" || node.attemptId !== attemptId) return banner;
  const expected = buildPipelineInputHashes(buildBannerPipelineContext(banner, workspace));
  return normalizeBanner({
    ...banner,
    pipelineNodes: markPipelineNode(banner.pipelineNodes, "copyplan", {
      status: "running",
      inputHash: expected.copyplan,
      outputHash: "",
      attemptId
    })
  });
}

async function persistBannerGroupPatches(projectRoot, entries, {
  acknowledgeHypothesisIdentityStamp = false
} = {}) {
  return withFileLock(path.join(projectRoot, BANNERS_PATH), async () => {
    const freshWorkspace = await loadFreshBannerPipelineWorkspace(projectRoot);
    const banners = await readJson(projectRoot, BANNERS_PATH);
    const resolved = entries.map((entry) => {
      const index = banners.findIndex((banner) => banner.id === entry.banner.id);
      if (index < 0) throw new Error(`バナーが見つかりません: ${entry.banner.id}`);
      const current = banners[index];
      if (entry.attemptId && current.promptGenerationLease?.attemptId !== entry.attemptId) {
        const error = new Error("生成権が別の実行へ移りました。古い仮説結果は保存しませんでした。");
        error.code = "PROMPT_ATTEMPT_REPLACED";
        throw error;
      }
      assertCurrentPipelineAttemptInput(current, entry.attemptId, freshWorkspace);
      return { entry, index, current };
    });
    const now = new Date().toISOString();
    for (const { entry, index, current } of resolved) {
      const merged = acknowledgeHypothesisIdentityStamp
        ? applyHypothesisIdentityStamp(current, entry, freshWorkspace)
        : refreshRunningCopyplanInputHash(
          normalizeBanner({ ...current, ...entry.patch }),
          entry.attemptId,
          freshWorkspace
        );
      banners[index] = normalizeBanner({ ...merged, updatedAt: now });
    }
    await writeJson(projectRoot, BANNERS_PATH, banners);
    return resolved.map(({ entry, index }) => ({
      ...entry,
      banner: banners[index]
    }));
  });
}

function uniqueNonEmpty(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(clean).filter(Boolean))];
}

function mergeCopyReviewHistory(existing, incoming, attemptId, candidateId) {
  const merged = Array.isArray(existing) ? [...existing] : [];
  for (const item of Array.isArray(incoming) ? incoming : []) {
    const normalized = {
      ...item,
      candidateId: clean(item?.candidateId) || candidateId,
      attemptId: clean(item?.attemptId) || clean(attemptId)
    };
    const duplicate = Boolean(normalized.attemptId) && merged.some((current) => (
      clean(current?.candidateId) === normalized.candidateId
      && clean(current?.attemptId) === normalized.attemptId
      && Number(current?.attempt) === Number(normalized.attempt)
    ));
    if (!duplicate) merged.push(normalized);
  }
  return merged;
}

function mergeWarnings(existing, incoming) {
  const merged = Array.isArray(existing) ? [...existing] : [];
  for (const item of Array.isArray(incoming) ? incoming : []) {
    if (!item || typeof item !== "object") continue;
    merged.push(item);
  }
  return merged;
}

function productionStatusForPipelineError(error) {
  if (error?.productionStatus) return error.productionStatus;
  if (error?.code === "TEMPLATE_NOT_READY") return "template_not_ready";
  if (error?.code === "STRATEGY_INPUT_INSUFFICIENT") return "strategy_input_insufficient";
  return "failed";
}

function groupCopyBriefItems(items, force = false, adTemplates = []) {
  const groups = new Map();
  for (const item of items || []) {
    const template = adTemplates.find((candidate) => candidate.id === item.banner.templateAdId) || null;
    const copyLocked = item.banner.instructionPolicy?.protectedFields?.includes("copyBrief");
    const forceItem = typeof force === "function" ? force(item) : force;
    const usableCopyBrief = hasUsableCopyBrief(item.banner.copyBrief, template);
    if (copyLocked && item.banner.lockedContentSnapshot && (item.banner.copyBrief || item.banner.imageText)) continue;
    if (!forceItem && usableCopyBrief) continue;
    const copyplanNode = normalizePipelineState(item.banner.pipelineNodes).copyplan;
    if (!forceItem && copyplanNode.status === "completed" && !usableCopyBrief) {
      const error = new Error("保存済みcopyBriefが現在の必須契約を満たしていません。copyplanから再生成してください。");
      error.code = "COPYBRIEF_CONTRACT_INVALID";
      error.restartNode = "copyplan";
      throw error;
    }
    const key = [
      item.banner.productId || "",
      item.banner.strategyId || "",
      item.banner.templateAdId || "",
      effectiveBannerInstruction(item.banner)
    ].join("::");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.values()].map((groupItems) => ({ items: groupItems }));
}

function hasUsableCopyBrief(copyBrief, template = null) {
  return copyBriefMeetsSlotRequirements(copyBrief, buildCopySlotPlan(template));
}

function summarizeExistingCopies(banners, targetBanners) {
  const targets = Array.isArray(targetBanners) ? targetBanners : [targetBanners];
  const targetIds = new Set(targets.map((item) => item?.id).filter(Boolean));
  const productId = targets.find((item) => item?.productId)?.productId || "";
  const strategyId = targets.find((item) => item?.strategyId)?.strategyId || "";
  return (banners || [])
    .filter((item) => !targetIds.has(item.id)
      && (!strategyId || item.strategyId === strategyId)
      && (!productId || item.productId === productId)
      && (item.imageText || item.copyBrief))
    .slice(0, 20)
    .map((item) => ({
      id: item.id,
      title: item.title || "",
      variationAxis: item.copyBrief?.appealAxis || item.variationAxis || "",
      copyBrief: item.copyBrief || null,
      imageText: summarizeCopyBriefText(item.copyBrief, item.imageText),
      visualDirection: summarizeVisualDirection(item.promptJson)
    }));
}

function summarizeCopyBriefText(copyBrief, fallbackText = "") {
  const brief = copyBrief && typeof copyBrief === "object" ? copyBrief : {};
  const lines = [
    ...(Array.isArray(brief.slotTexts) ? brief.slotTexts.map((slot) => slot.text) : []),
    brief.mainHook,
    brief.subHook,
    brief.proof,
    brief.offerBadge,
    brief.cta,
    brief.disclaimer,
    fallbackText
  ].map(clean).filter(Boolean);
  return clip([...new Set(lines)].join("\n"), 700);
}

function summarizeVisualDirection(promptJson) {
  if (!promptJson || typeof promptJson !== "object") return "";
  const visualStyle = promptJson.globalDesign?.visualStyle || {};
  const imageElements = (promptJson.zones || [])
    .flatMap((zone) => zone?.elements || [])
    .filter((element) => String(element?.type || "").toLowerCase() === "image")
    .map((element) => [element.role, element.content, element.sourceReason].filter(Boolean).join(": "))
    .filter(Boolean);
  return clip([
    visualStyle.type,
    visualStyle.mood,
    visualStyle.note,
    ...imageElements
  ].filter(Boolean).join(" / "), 500);
}

async function generateBannerPromptWithGuidance(projectRoot, banner, context, guidance, options = {}) {
  const attemptId = clean(options.attemptId);
  const generatingPatch = { productionStatus: "prompt_generating" };
  if (attemptId) {
    const expected = buildPipelineInputHashes(buildBannerPipelineContext(banner, context));
    generatingPatch.pipelineNodes = markPipelineNode(banner.pipelineNodes, "prompt", {
      status: "running",
      inputHash: expected.prompt,
      outputHash: "",
      attemptId,
      errorCode: "",
      errorMessage: ""
    });
  }
  await updateBannerForPromptAttempt(projectRoot, banner.id, attemptId, generatingPatch);
  try {
    const template = (context.adTemplates || []).find((item) => item.id === banner.templateAdId) || null;
    const product = (context.products || []).find((item) => item.id === banner.productId) || {};
    const strategy = (context.strategies || []).find((item) => item.id === banner.strategyId) || {};
    const proposalGenerator = options.proposalGenerator || generateBannerCreativeProposal;
    const promptStartedAt = new Date().toISOString();
    const promptStartMs = Date.now();
    const proposal = await proposalGenerator({
      banner,
      product,
      strategy,
      template,
      expressionRules: context.expressionRules || [],
      diversityGuidance: {
        ...guidance,
        avoidCopies: summarizeExistingCopies(await listBannerCreatives(projectRoot), [banner])
      },
      copyBrief: banner.copyBrief,
      creativeHypothesis: banner.creativeHypothesis,
      approvedClaimSnapshot: banner.approvedClaimSnapshot
    });
    const promptPatch = {
      imageText: proposal.imageText,
      copyBrief: proposal.copyBrief || banner.copyBrief,
      promptJson: proposal.promptJson,
      promptText: proposal.promptText,
      reviewNotes: proposal.reviewNotes,
      structureSheet: proposal.promptJson?.structureSheet || null,
      regulationCheck: proposal.regulationCheck || null,
      overriddenRules: proposal.overriddenRules || [],
      strategyCheck: null,
      colorDecision: proposal.colorDecision || null,
      reviewChecklist: proposal.promptJson?.reviewChecklist || null,
      selectionReason: proposal.selectionReason || "",
      bannerGenerationContract: proposal.bannerGenerationContract || banner.bannerGenerationContract || null,
      creativeHypothesis: banner.creativeHypothesis || null,
      visualHypothesisRef: proposal.visualHypothesisRef || null,
      diversityReview: {
        axis: guidance?.axisLabel || banner.variationAxis || "",
        visualGuidance: guidance?.axisInstruction || "",
        copyBriefAppealAxis: proposal.copyBrief?.appealAxis || banner.copyBrief?.appealAxis || ""
      },
      productionStatus: "prompt_ready",
      ...(attemptId ? { promptGenerationLease: null } : {}),
      lastError: "",
      lastErrorAt: ""
    };
    promptPatch.pipelineNodes = markCompletedPipelineNodes(banner, promptPatch, context, ["prompt"], attemptId);
    const promptDurationMs = Date.now() - promptStartMs;
    promptPatch.pipelineNodes = markPipelineNode(promptPatch.pipelineNodes, "prompt", {
      startedAt: promptStartedAt,
      completedAt: new Date().toISOString(),
      durationMs: promptDurationMs
    });
    return await updateBannerForPromptAttempt(projectRoot, banner.id, attemptId, promptPatch);
  } catch (error) {
    const failedPatch = {
      productionStatus: "failed",
      ...(attemptId ? { promptGenerationLease: null } : {}),
      lastError: error.message,
      lastErrorAt: new Date().toISOString()
    };
    failedPatch.pipelineNodes = markFailedPipelineNode(banner, error, attemptId);
    await updateBannerForPromptAttempt(projectRoot, banner.id, attemptId, failedPatch);
    throw error;
  }
}

async function updateBannerForPromptAttempt(projectRoot, bannerId, attemptId, patch) {
  if (!attemptId) return updateBannerCreative(projectRoot, bannerId, patch);
  return updateBannerCreativeForAttempt(projectRoot, bannerId, "promptGenerationLease", attemptId, patch, "PROMPT_ATTEMPT_REPLACED");
}

export async function spreadBannerIdeas(projectRoot, bannerId, context = {}) {
  const banners = await listBannerCreatives(projectRoot);
  const parent = banners.find((item) => item.id === bannerId);
  if (!parent) throw new Error(`\u30d0\u30ca\u30fc\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093: ${bannerId}`);
  await updateBannerCreative(projectRoot, parent.id, { productionStatus: "generating" });
  try {
    const strategy = (context.strategies || []).find((item) => item.id === parent.strategyId) || {};
    const axes = buildStrategicSpreadAxes(strategy);
    const children = [];
    for (const axis of axes) {
      const child = await addBannerCreative(projectRoot, {
        ...parent,
        parentId: parent.id,
        title: (parent.title || "\u30d0\u30ca\u30fc\u6848") + " / " + axis.label,
        additionalInstruction: [parent.additionalInstruction, axis.instruction].filter(Boolean).join("\n"),
        variationAxis: axis.label,
        hypothesis: axis.hypothesis,
        productionStatus: "sub_item_created",
        imageGenerationStatus: "not_started",
        generatedImagePath: "",
        images: []
      });
      children.push(await generateBannerPrompt(projectRoot, child.id, context));
    }
    await updateBannerCreative(projectRoot, parent.id, { productionStatus: "sub_item_created", lastError: "", lastErrorAt: "" });
    return children;
  } catch (error) {
    await updateBannerCreative(projectRoot, parent.id, {
      productionStatus: "failed",
      lastError: error.message,
      lastErrorAt: new Date().toISOString()
    });
    throw error;
  }
}

export async function reviseBannerCreative(projectRoot, bannerId, context = {}, options = {}) {
  const banners = await listBannerCreatives(projectRoot);
  const banner = banners.find((item) => item.id === bannerId);
  if (!banner) throw new Error(`\u30d0\u30ca\u30fc\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093: ${bannerId}`);
  const copyLocked = banner.instructionPolicy?.protectedFields?.includes("copyBrief");
  await updateBannerCreative(projectRoot, bannerId, { productionStatus: "revising" });
  try {
    const plan = {
      axisLabel: banner.variationAxis || "修正指示反映",
      axisInstruction: banner.revisionInstruction || banner.additionalInstruction || "ユーザーの修正指示を反映する。",
      hypothesis: banner.hypothesis || "修正指示を反映したバナー案として再検証する。"
    };
    const result = await generateBannerPromptBatch(projectRoot, [bannerId], context, {
      ...options,
      forceCopyBrief: !copyLocked,
      plansByBannerId: { [bannerId]: plan }
    });
    const revised = result.banners?.[0];
    if (!revised) throw new Error(result.errors?.[0]?.message || "修正案の生成に失敗しました。");
    return await updateBannerCreative(projectRoot, bannerId, {
      ...revised,
      productionStatus: "prompt_ready",
      lastError: "",
      lastErrorAt: "",
      promptText: [revised.promptText, banner.revisionInstruction ? "\u4fee\u6b63\u6307\u793a: " + banner.revisionInstruction : ""].filter(Boolean).join("\n")
    });
  } catch (error) {
    await updateBannerCreative(projectRoot, bannerId, {
      productionStatus: "failed",
      lastError: error.message,
      lastErrorAt: new Date().toISOString()
    });
    throw error;
  }
}

export async function updateBannerCreative(projectRoot, bannerId, patch) {
  await ensureBannerData(projectRoot);
  return withFileLock(path.join(projectRoot, BANNERS_PATH), async () => {
    const banners = await readJson(projectRoot, BANNERS_PATH);
    const index = banners.findIndex((item) => item.id === bannerId);
    if (index < 0) throw new Error(`\u30d0\u30ca\u30fc\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093: ${bannerId}`);
    const current = banners[index];
    const normalizedPatch = { ...patch };
    const imageFields = [
      ["productImagePath", "productImagePaths"],
      ["logoImagePath", "logoImagePaths"],
      ["otherImagePath", "otherImagePaths"]
    ];
    let invalidateFrom = "";
    for (const [singleKey, multipleKey] of imageFields) {
      if (Object.prototype.hasOwnProperty.call(normalizedPatch, singleKey) && !Object.prototype.hasOwnProperty.call(normalizedPatch, multipleKey)) {
        normalizedPatch[multipleKey] = normalizedPatch[singleKey] ? [normalizedPatch[singleKey]] : [];
      }
      if (Object.prototype.hasOwnProperty.call(normalizedPatch, singleKey) && clean(normalizedPatch[singleKey]) !== clean(current[singleKey])) invalidateFrom = earlierPipelineNode(invalidateFrom, "prompt");
      if (Object.prototype.hasOwnProperty.call(normalizedPatch, multipleKey)
        && JSON.stringify(normalizedPatch[multipleKey] || []) !== JSON.stringify(current[multipleKey] || [])) invalidateFrom = earlierPipelineNode(invalidateFrom, "prompt");
    }
    if (["templateAdId", "strategyId", "productId"].some((key) => (
      Object.prototype.hasOwnProperty.call(normalizedPatch, key) && clean(normalizedPatch[key]) !== clean(current[key])
    ))) invalidateFrom = earlierPipelineNode(invalidateFrom, "copyplan");
    if (Object.prototype.hasOwnProperty.call(normalizedPatch, "imageSize")
      && clean(normalizedPatch.imageSize) !== clean(current.imageSize)) {
      invalidateFrom = earlierPipelineNode(invalidateFrom, "prompt");
    }
    const additionalInstructionChanged = Object.prototype.hasOwnProperty.call(normalizedPatch, "additionalInstruction")
      && clean(normalizedPatch.additionalInstruction) !== clean(current.additionalInstruction);
    const revisionInstructionChanged = Object.prototype.hasOwnProperty.call(normalizedPatch, "revisionInstruction")
      && clean(normalizedPatch.revisionInstruction) !== clean(current.revisionInstruction);
    if (additionalInstructionChanged) {
      const additionalPolicy = buildInstructionPolicy(normalizedPatch.additionalInstruction);
      const copyProtectedVisualEdit = additionalPolicy.protectedFields.includes("copyBrief")
        && additionalPolicy.editableFields.includes("imageElements");
      invalidateFrom = earlierPipelineNode(invalidateFrom, additionalPolicy.changeScope === "visual_only" || copyProtectedVisualEdit ? "prompt" : "copyplan");
    }
    if (revisionInstructionChanged) {
      const revisionPolicy = buildInstructionPolicy(normalizedPatch.revisionInstruction);
      const copyProtectedVisualEdit = revisionPolicy.protectedFields.includes("copyBrief")
        && revisionPolicy.editableFields.includes("imageElements");
      invalidateFrom = earlierPipelineNode(invalidateFrom, revisionPolicy.changeScope === "visual_only" || copyProtectedVisualEdit ? "prompt" : "copy");
    }
    const nextInstruction = [
      Object.prototype.hasOwnProperty.call(normalizedPatch, "additionalInstruction") ? normalizedPatch.additionalInstruction : current.additionalInstruction,
      Object.prototype.hasOwnProperty.call(normalizedPatch, "revisionInstruction") ? normalizedPatch.revisionInstruction : current.revisionInstruction
    ].filter(Boolean).join("\n");
    const instructionPolicy = buildInstructionPolicy(nextInstruction);
    normalizedPatch.instructionPolicy = instructionPolicy;
    if (invalidateFrom) {
      const copyLocked = instructionPolicy.protectedFields.includes("copyBrief");
      const lockedContentSnapshot = copyLocked ? createLockedContentSnapshot(current) : null;
      if (copyLocked) {
        normalizedPatch.copyBrief = lockedContentSnapshot?.copyBrief || current.copyBrief || null;
        normalizedPatch.imageText = lockedContentSnapshot?.imageText || current.imageText || "";
        normalizedPatch.lockedContentSnapshot = lockedContentSnapshot;
        normalizedPatch.copyLengthReview = buildLockedCopyLengthReview(lockedContentSnapshot?.copyBrief);
        normalizedPatch.messagePlan = lockedContentSnapshot?.copyBrief?.messagePlan || current.messagePlan || null;
        normalizedPatch.templateFitDecision = lockedContentSnapshot?.copyBrief?.templateFitDecision || current.templateFitDecision || null;
        normalizedPatch.communicationReview = {
          version: "3.0",
          status: "warning",
          perceivedMessage: clean(lockedContentSnapshot?.copyBrief?.readoutText || lockedContentSnapshot?.imageText),
          rewriteAllowed: false,
          exemption: "explicit_copy_lock",
          warnings: [{
            code: "explicit_copy_lock",
            severity: "warning",
            message: "明示的な追加指示を優先し、コピーを変更せずビジュアルだけを更新します。"
          }]
        };
        normalizedPatch.copyQualityReview = {
          ...(current.copyQualityReview || {}),
          version: current.copyQualityReview?.version || "3.0",
          status: "warning",
          rewriteAllowed: false,
          exemption: "explicit_copy_lock"
        };
        normalizedPatch.originalityReview = {
          ...(current.originalityReview || {}),
          status: "passed",
          failures: [],
          exemption: "explicit_copy_reuse"
        };
      }
      applyPipelineArtifactInvalidation(normalizedPatch, current, invalidateFrom, copyLocked);
      normalizedPatch.pipelineNodes = invalidatePipelineFrom(current.pipelineNodes, invalidateFrom);
      normalizedPatch.productionStatus = "not_started";
      normalizedPatch.promptGenerationLease = null;
      normalizedPatch.imageGenerationStatus = "not_started";
      normalizedPatch.imageGenerationLease = null;
    }
    banners[index] = normalizeBanner({ ...banners[index], ...normalizedPatch, updatedAt: new Date().toISOString() });
    await writeJson(projectRoot, BANNERS_PATH, banners);
    return banners[index];
  });
}

function earlierPipelineNode(current, candidate) {
  if (!current) return candidate;
  const order = ["copyplan", "prompt", "image"];
  return order.indexOf(candidate) < order.indexOf(current) ? candidate : current;
}

function applyPipelineArtifactInvalidation(patch, current, node, copyLocked = false) {
  const order = ["copyplan", "prompt", "image"];
  const start = order.indexOf(node);
  const preserveCopy = copyLocked && start >= order.indexOf("prompt");
  if (start <= order.indexOf("copyplan")) {
    patch.approvedClaimSnapshot = null;
    patch.creativeHypothesis = null;
  }
  if (start <= order.indexOf("copyplan") && !preserveCopy) {
    patch.copyBrief = null;
    patch.imageText = "";
    patch.messagePlan = null;
    patch.templateFitDecision = null;
    patch.copyReviewHistory = [];
  }
  if (start <= order.indexOf("prompt")) {
    patch.promptJson = null;
    patch.promptText = "";
    patch.structureSheet = null;
    patch.reviewChecklist = null;
    patch.visualHypothesisRef = null;
    patch.colorDecision = null;
  }
  if (start <= order.indexOf("image")) {
    patch.generatedImagePath = "";
    patch.generatedImageHash = "";
    patch.generatedImageModel = "";
    patch.generatedImageSize = "";
    patch.previewPath = "";
    patch.images = [];
  }
}

async function updateBannerCreativeForAttempt(
  projectRoot,
  bannerId,
  leaseField,
  attemptId,
  patch,
  errorCode,
  { validateInputHash = true } = {}
) {
  await ensureBannerData(projectRoot);
  return withFileLock(path.join(projectRoot, BANNERS_PATH), async () => {
    const banners = await readJson(projectRoot, BANNERS_PATH);
    const index = banners.findIndex((item) => item.id === bannerId);
    if (index < 0) throw new Error(`バナーが見つかりません: ${bannerId}`);
    const current = banners[index];
    if (current[leaseField]?.attemptId !== attemptId) {
      const error = new Error("生成権が別の実行へ移りました。古い実行結果は保存しませんでした。");
      error.code = errorCode;
      throw error;
    }
    const freshWorkspace = validateInputHash && leaseField === "promptGenerationLease"
      ? await loadFreshBannerPipelineWorkspace(projectRoot)
      : null;
    if (freshWorkspace) assertCurrentPipelineAttemptInput(current, attemptId, freshWorkspace);
    const normalizedPatch = { ...patch };
    if (leaseField === "promptGenerationLease"
      && current.promptGenerationLease
      && !Object.prototype.hasOwnProperty.call(normalizedPatch, leaseField)) {
      normalizedPatch.promptGenerationLease = {
        ...current.promptGenerationLease,
        state: normalizedPatch.productionStatus === "prompt_generating"
          ? "generating"
          : current.promptGenerationLease.state
      };
    }
    banners[index] = normalizeBanner({
      ...current,
      ...normalizedPatch,
      updatedAt: new Date().toISOString()
    });
    await writeJson(projectRoot, BANNERS_PATH, banners);
    return banners[index];
  });
}

export async function claimBannerPromptGeneration(projectRoot, bannerId, claim) {
  await ensureBannerData(projectRoot);
  return withFileLock(path.join(projectRoot, BANNERS_PATH), async () => {
    const banners = await readJson(projectRoot, BANNERS_PATH);
    const index = banners.findIndex((item) => item.id === bannerId);
    if (index < 0) throw new Error(`バナーが見つかりません: ${bannerId}`);
    const current = banners[index];
    const now = Date.now();
    const lease = current.promptGenerationLease && typeof current.promptGenerationLease === "object" ? current.promptGenerationLease : null;
    const expiresAt = Date.parse(lease?.expiresAt || "");
    if (lease && Number.isFinite(expiresAt) && expiresAt > now) return { claimed: false, banner: current, reason: "active" };
    const leaseMs = Math.max(60000, Number(claim.leaseMs) || 5 * 60 * 1000);
    const queuedAt = new Date(now).toISOString();
    const startNode = ["copyplan", "prompt"].includes(claim.startNode) ? claim.startNode : "";
    const pipelineNodes = startNode
      ? markPipelineNode(current.pipelineNodes, startNode, {
          status: "running",
          inputHash: clean(claim.inputHash),
          outputHash: "",
          attemptId: clean(claim.attemptId),
          retryExhausted: false
        })
      : current.pipelineNodes;
    banners[index] = normalizeBanner({
      ...current,
      pipelineNodes,
      productionStatus: "prompt_queued",
      promptGenerationLease: {
        ownerId: clean(claim.ownerId),
        attemptId: clean(claim.attemptId),
        state: "queued",
        queuedAt,
        heartbeatAt: queuedAt,
        expiresAt: new Date(now + leaseMs).toISOString()
      },
      lastError: "",
      lastErrorAt: "",
      updatedAt: queuedAt
    });
    await writeJson(projectRoot, BANNERS_PATH, banners);
    return { claimed: true, banner: banners[index] };
  });
}

export async function renewBannerPromptGenerationLease(projectRoot, bannerId, attemptId, leaseMs) {
  await ensureBannerData(projectRoot);
  return withFileLock(path.join(projectRoot, BANNERS_PATH), async () => {
    const banners = await readJson(projectRoot, BANNERS_PATH);
    const index = banners.findIndex((item) => item.id === bannerId);
    if (index < 0) return null;
    const current = banners[index];
    if (current.promptGenerationLease?.attemptId !== attemptId) return current;
    const now = new Date();
    banners[index] = normalizeBanner({
      ...current,
      promptGenerationLease: {
        ...current.promptGenerationLease,
        heartbeatAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + Math.max(60000, Number(leaseMs) || 5 * 60 * 1000)).toISOString()
      },
      updatedAt: now.toISOString()
    });
    await writeJson(projectRoot, BANNERS_PATH, banners);
    return banners[index];
  });
}

export async function failBannerPromptGeneration(projectRoot, bannerId, attemptId, errorMessage) {
  try {
    return await updateBannerCreativeForAttempt(projectRoot, bannerId, "promptGenerationLease", attemptId, {
      productionStatus: "failed",
      promptGenerationLease: null,
      lastError: clean(errorMessage) || "バナー案のコピー設計に失敗しました。",
      lastErrorAt: new Date().toISOString()
    }, "PROMPT_ATTEMPT_REPLACED", { validateInputHash: false });
  } catch (error) {
    if (error.code === "PROMPT_ATTEMPT_REPLACED") return null;
    throw error;
  }
}

export async function releaseBannerPromptGeneration(projectRoot, bannerId, attemptId) {
  try {
    return await updateBannerCreativeForAttempt(projectRoot, bannerId, "promptGenerationLease", attemptId, {
      promptGenerationLease: null
    }, "PROMPT_ATTEMPT_REPLACED", { validateInputHash: false });
  } catch (error) {
    if (error.code === "PROMPT_ATTEMPT_REPLACED") return null;
    throw error;
  }
}

export async function completeBannerPromptOperation(projectRoot, bannerId, attemptId, patch = {}) {
  return updateBannerCreativeForAttempt(projectRoot, bannerId, "promptGenerationLease", attemptId, {
    ...patch,
    promptGenerationLease: null,
    lastError: "",
    lastErrorAt: ""
  }, "PROMPT_ATTEMPT_REPLACED");
}

export async function claimBannerImageOperation(projectRoot, bannerId, claim, options = {}) {
  const operationKind = options.operationKind === "edit" ? "edit" : "generate";
  const editMode = operationKind === "edit" && claim.editMode === "full" ? "full" : "range";
  await ensureBannerData(projectRoot);
  return withFileLock(path.join(projectRoot, BANNERS_PATH), async () => {
    const banners = await readJson(projectRoot, BANNERS_PATH);
    const index = banners.findIndex((item) => item.id === bannerId);
    if (index < 0) throw new Error(`バナーが見つかりません: ${bannerId}`);
    const current = banners[index];
    if (["strategy_input_insufficient", "template_not_ready"].includes(current.productionStatus)) {
      const error = new Error("戦略またはテンプレートの入力不備のため画像生成できません。");
      error.code = "BANNER_COPY_REVIEW_BLOCKED";
      throw error;
    }
    if (operationKind === "generate") {
      if ((current.productionStatus === "completed" || current.productionStatus === "completed_with_warnings") && current.generatedImagePath) {
        return { claimed: false, banner: current, reason: "completed" };
      }
    } else if (!clean(current.generatedImagePath)) {
      return { claimed: false, banner: current, reason: "missing_source" };
    }
    const now = Date.now();
    const lease = current.imageGenerationLease && typeof current.imageGenerationLease === "object"
      ? current.imageGenerationLease
      : null;
    const leaseExpiresAt = Date.parse(lease?.expiresAt || "");
    const updatedAt = Date.parse(current.updatedAt || "");
    const legacyStaleMs = Math.max(60000, Number(claim.legacyStaleMs) || 15 * 60 * 1000);
    const activeStatus = current.imageGenerationStatus === "queued" || current.imageGenerationStatus === "generating";
    const leaseIsActive = Number.isFinite(leaseExpiresAt) && leaseExpiresAt > now;
    const legacyIsFresh = !lease && Number.isFinite(updatedAt) && updatedAt > now - legacyStaleMs;
    if (activeStatus && (leaseIsActive || legacyIsFresh)) {
      return { claimed: false, banner: current, reason: "active" };
    }
    const queuedAt = new Date(now).toISOString();
    const leaseMs = Math.max(60000, Number(claim.leaseMs) || 15 * 60 * 1000);
    const imageInputHash = clean(claim.inputHash) || buildPipelineInputHashes({ banner: current }).image;
    const pipelineNodes = markPipelineNode(current.pipelineNodes, "image", {
      status: "running",
      inputHash: imageInputHash,
      outputHash: "",
      attemptId: clean(claim.attemptId),
      retryExhausted: false
    });
    banners[index] = normalizeBanner({
      ...current,
      pipelineNodes,
      imageGenerationStatus: "queued",
      imageGenerationLease: {
        ownerId: clean(claim.ownerId),
        attemptId: clean(claim.attemptId),
        operationKind,
        ...(operationKind === "edit" ? { editMode } : {}),
        state: "queued",
        queuedAt,
        heartbeatAt: queuedAt,
        expiresAt: new Date(now + leaseMs).toISOString()
      },
      lastError: "",
      lastErrorAt: "",
      updatedAt: queuedAt
    });
    await writeJson(projectRoot, BANNERS_PATH, banners);
    return { claimed: true, banner: banners[index], recoveredStale: activeStatus, operationKind };
  });
}

export async function claimBannerImageGeneration(projectRoot, bannerId, claim) {
  return claimBannerImageOperation(projectRoot, bannerId, claim, { operationKind: "generate" });
}

export async function claimBannerImageEdit(projectRoot, bannerId, claim) {
  return claimBannerImageOperation(projectRoot, bannerId, claim, { operationKind: "edit" });
}

export async function startBannerImageGeneration(projectRoot, bannerId, attemptId, leaseMs = 12 * 60 * 1000) {
  await ensureBannerData(projectRoot);
  return withFileLock(path.join(projectRoot, BANNERS_PATH), async () => {
    const banners = await readJson(projectRoot, BANNERS_PATH);
    const index = banners.findIndex((item) => item.id === bannerId);
    if (index < 0) throw new Error(`バナーが見つかりません: ${bannerId}`);
    const current = banners[index];
    if (current.imageGenerationLease?.attemptId !== attemptId) {
      const error = new Error("画像生成の待機権が別の実行へ移りました。再読み込みしてください。");
      error.code = "IMAGE_ATTEMPT_REPLACED";
      throw error;
    }
    const now = new Date();
    banners[index] = normalizeBanner({
      ...current,
      imageGenerationStatus: "generating",
      imageGenerationLease: {
        ...current.imageGenerationLease,
        state: "generating",
        startedAt: now.toISOString(),
        heartbeatAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + Math.max(60000, Number(leaseMs) || 12 * 60 * 1000)).toISOString()
      },
      updatedAt: now.toISOString()
    });
    await writeJson(projectRoot, BANNERS_PATH, banners);
    return banners[index];
  });
}

export async function renewBannerImageGenerationLease(projectRoot, bannerId, attemptId, leaseMs) {
  await ensureBannerData(projectRoot);
  return withFileLock(path.join(projectRoot, BANNERS_PATH), async () => {
    const banners = await readJson(projectRoot, BANNERS_PATH);
    const index = banners.findIndex((item) => item.id === bannerId);
    if (index < 0) return null;
    const current = banners[index];
    if (!["queued", "generating"].includes(current.imageGenerationStatus) || current.imageGenerationLease?.attemptId !== attemptId) return current;
    const now = new Date();
    banners[index] = normalizeBanner({
      ...current,
      imageGenerationLease: {
        ...current.imageGenerationLease,
        heartbeatAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + Math.max(60000, Number(leaseMs) || 15 * 60 * 1000)).toISOString()
      },
      updatedAt: now.toISOString()
    });
    await writeJson(projectRoot, BANNERS_PATH, banners);
    return banners[index];
  });
}

export async function failBannerImageGeneration(projectRoot, bannerId, attemptId, errorMessage, failurePatch = {}) {
  await ensureBannerData(projectRoot);
  return withFileLock(path.join(projectRoot, BANNERS_PATH), async () => {
    const banners = await readJson(projectRoot, BANNERS_PATH);
    const index = banners.findIndex((item) => item.id === bannerId);
    if (index < 0) throw new Error(`バナーが見つかりません: ${bannerId}`);
    const current = banners[index];
    if (attemptId && current.imageGenerationLease?.attemptId !== attemptId) {
      return current;
    }
    const now = new Date().toISOString();
    const imageNode = normalizePipelineState(current.pipelineNodes).image;
    const pipelineNodes = markPipelineNode(current.pipelineNodes, "image", {
      status: "failed",
      attemptId: clean(attemptId),
      inputHash: imageNode.inputHash,
      outputHash: "",
      errorCode: "IMAGE_GENERATION_FAILED",
      errorMessage: clean(errorMessage) || "画像生成に失敗しました。",
      retryCount: imageNode.errorCode === "IMAGE_GENERATION_FAILED" ? imageNode.retryCount + 1 : 0,
      retryExhausted: imageNode.errorCode === "IMAGE_GENERATION_FAILED" && imageNode.retryCount >= 0
    });
    banners[index] = normalizeBanner({
      ...current,
      ...(failurePatch && typeof failurePatch === "object" ? failurePatch : {}),
      pipelineNodes,
      imageGenerationStatus: "failed",
      imageGenerationLease: null,
      lastError: clean(errorMessage) || "画像生成に失敗しました。",
      lastErrorAt: now,
      updatedAt: now
    });
    await writeJson(projectRoot, BANNERS_PATH, banners);
    return banners[index];
  });
}

export async function failBannerImageEdit(projectRoot, bannerId, attemptId, errorMessage) {
  await ensureBannerData(projectRoot);
  return withFileLock(path.join(projectRoot, BANNERS_PATH), async () => {
    const banners = await readJson(projectRoot, BANNERS_PATH);
    const index = banners.findIndex((item) => item.id === bannerId);
    if (index < 0) throw new Error(`バナーが見つかりません: ${bannerId}`);
    const current = banners[index];
    if (attemptId && current.imageGenerationLease?.attemptId !== attemptId) return current;
    if (current.imageGenerationLease?.operationKind && current.imageGenerationLease.operationKind !== "edit") return current;
    const lastImageEditMode = current.imageGenerationLease?.editMode === "full" ? "full" : "range";
    const now = new Date().toISOString();
    const imageNode = normalizePipelineState(current.pipelineNodes).image;
    const outputs = buildPipelineOutputHashes({ banner: current });
    banners[index] = normalizeBanner({
      ...current,
      imageGenerationStatus: current.generatedImagePath ? "completed" : current.imageGenerationStatus,
      imageGenerationLease: null,
      pipelineNodes: markPipelineNode(current.pipelineNodes, "image", {
        status: "completed",
        inputHash: imageNode.inputHash,
        outputHash: imageNode.outputHash || outputs.image || "",
        attemptId: clean(attemptId),
        errorCode: "",
        errorMessage: "",
        retryCount: 0,
        retryExhausted: false
      }),
      lastImageEditMode,
      lastImageEditError: clean(errorMessage) || "画像修正に失敗しました。",
      lastImageEditErrorAt: now,
      updatedAt: now
    });
    await writeJson(projectRoot, BANNERS_PATH, banners);
    return banners[index];
  });
}

export async function completeBannerImageEdit(projectRoot, bannerId, attemptId, patch) {
  await ensureBannerData(projectRoot);
  return withFileLock(path.join(projectRoot, BANNERS_PATH), async () => {
    const banners = await readJson(projectRoot, BANNERS_PATH);
    const index = banners.findIndex((item) => item.id === bannerId);
    if (index < 0) throw new Error(`バナーが見つかりません: ${bannerId}`);
    const current = banners[index];
    if (current.imageGenerationLease?.attemptId !== attemptId) {
      const error = new Error("編集権が別の実行へ移りました。古い画像結果は保存しませんでした。");
      error.code = "IMAGE_ATTEMPT_REPLACED";
      throw error;
    }
    if (current.imageGenerationLease?.operationKind !== "edit") {
      const error = new Error("画像編集リースではありません。");
      error.code = "IMAGE_ATTEMPT_REPLACED";
      throw error;
    }
    const merged = normalizeBanner({
      ...current,
      ...patch,
      imageGenerationStatus: "completed",
      imageGenerationLease: null,
      productionStatus: patch.productionStatus || (
        patch.copyIntegrityCheck && patch.copyIntegrityCheck.status !== "passed"
          ? "completed_with_warnings"
          : (current.productionStatus === "completed_with_warnings" ? "completed_with_warnings" : "completed")
      ),
      warnings: mergeWarnings(current.warnings, patch.warnings),
      lastError: "",
      lastErrorAt: "",
      lastImageEditError: "",
      lastImageEditErrorAt: ""
    });
    const outputs = buildPipelineOutputHashes({ banner: merged });
    if (!outputs.image) {
      const error = new Error("生成画像のcontent hashがないため完了できません。");
      error.code = "IMAGE_OUTPUT_HASH_MISSING";
      throw error;
    }
    const imageNode = normalizePipelineState(current.pipelineNodes).image;
    merged.pipelineNodes = markPipelineNode(current.pipelineNodes, "image", {
      status: "completed",
      inputHash: imageNode.inputHash,
      outputHash: outputs.image,
      attemptId,
      errorCode: "",
      errorMessage: "",
      retryCount: 0,
      retryExhausted: false
    });
    banners[index] = normalizeBanner({ ...merged, updatedAt: new Date().toISOString() });
    await writeJson(projectRoot, BANNERS_PATH, banners);
    return banners[index];
  });
}

export async function completeBannerImageGeneration(projectRoot, bannerId, attemptId, patch) {
  await ensureBannerData(projectRoot);
  return withFileLock(path.join(projectRoot, BANNERS_PATH), async () => {
    const banners = await readJson(projectRoot, BANNERS_PATH);
    const index = banners.findIndex((item) => item.id === bannerId);
    if (index < 0) throw new Error(`バナーが見つかりません: ${bannerId}`);
    const current = banners[index];
    if (current.imageGenerationLease?.attemptId !== attemptId) {
      const error = new Error("生成権が別の実行へ移りました。古い画像結果は保存しませんでした。");
      error.code = "IMAGE_ATTEMPT_REPLACED";
      throw error;
    }
    if (normalizePipelineState(current.pipelineNodes).image.attemptId !== attemptId) {
      const error = new Error("生成中に入力が変更されました。古い画像結果は保存しませんでした。");
      error.code = "STALE_PIPELINE_ATTEMPT";
      throw error;
    }
    const merged = normalizeBanner({
      ...current,
      ...patch,
      imageGenerationStatus: "completed",
      imageGenerationLease: null,
      productionStatus: patch.productionStatus || (
        patch.copyIntegrityCheck && patch.copyIntegrityCheck.status !== "passed"
          ? "completed_with_warnings"
          : (current.productionStatus === "completed_with_warnings" ? "completed_with_warnings" : "completed")
      ),
      warnings: mergeWarnings(current.warnings, patch.warnings),
      lastError: "",
      lastErrorAt: ""
    });
    const outputs = buildPipelineOutputHashes({ banner: merged });
    if (!outputs.image) {
      const error = new Error("生成画像のcontent hashがないため完了できません。");
      error.code = "IMAGE_OUTPUT_HASH_MISSING";
      throw error;
    }
    const imageNode = normalizePipelineState(current.pipelineNodes).image;
    merged.pipelineNodes = markPipelineNode(current.pipelineNodes, "image", {
      status: "completed",
      inputHash: imageNode.inputHash,
      outputHash: outputs.image,
      attemptId,
      errorCode: "",
      errorMessage: "",
      retryCount: 0,
      retryExhausted: false
    });
    banners[index] = normalizeBanner({ ...merged, updatedAt: new Date().toISOString() });
    await writeJson(projectRoot, BANNERS_PATH, banners);
    return banners[index];
  });
}

export async function deleteBannerCreative(projectRoot, bannerId) {
  await ensureBannerData(projectRoot);
  return withFileLock(path.join(projectRoot, BANNERS_PATH), async () => {
    const banners = await readJson(projectRoot, BANNERS_PATH);
    const index = banners.findIndex((item) => item.id === bannerId);
    if (index < 0) throw new Error("Row not found: " + bannerId);
    const [deleted] = banners.splice(index, 1);
    await writeJson(projectRoot, BANNERS_PATH, banners);
    return deleted;
  });
}

function deriveLegacyPipelineStateFromArtifacts(input = {}) {
  let state = normalizePipelineState();
  const completedImage = input.imageGenerationStatus === "completed"
    || ((input.productionStatus === "completed" || input.productionStatus === "completed_with_warnings") && Boolean(input.generatedImagePath));
  if (completedImage) {
    for (const node of ["copyplan", "prompt", "image"]) {
      state = markPipelineNode(state, node, {
        status: "completed",
        inputHash: `legacy-completed:${node}`,
        outputHash: `legacy-completed:${node}`
      });
    }
    return state;
  }
  if (input.copyBrief?.copyBriefHash) {
    state = markPipelineNode(state, "copyplan", { status: "completed", inputHash: "legacy:copyplan", outputHash: clean(input.copyBrief.copyBriefHash) });
  }
  if (input.promptJson && Object.keys(input.promptJson).length && clean(input.promptText)) {
    const outputHash = `sha256:${crypto.createHash("sha256").update(JSON.stringify({ promptJson: input.promptJson, promptText: input.promptText })).digest("hex")}`;
    state = markPipelineNode(state, "prompt", { status: "completed", inputHash: "legacy:prompt", outputHash });
    if (input.imageGenerationStatus === "failed") {
      state = markPipelineNode(state, "image", { status: "failed", inputHash: outputHash, errorCode: "IMAGE_GENERATION_FAILED", errorMessage: clean(input.lastError) });
    }
  }
  return state;
}

function normalizeBanner(input) {
  const generatedImagePath = clean(input.generatedImagePath);
  const productImagePaths = cleanImagePaths(input.productImagePaths, input.productImagePath);
  const logoImagePaths = cleanImagePaths(input.logoImagePaths, input.logoImagePath);
  const otherImagePaths = cleanImagePaths(input.otherImagePaths, input.otherImagePath);
  return {
    id: clean(input.id),
    productId: clean(input.productId),
    strategyId: clean(input.strategyId),
    parentId: clean(input.parentId),
    templateAdId: clean(input.templateAdId),
    adCopyTemplateId: clean(input.adCopyTemplateId),
    title: clean(input.title) || "\u30d0\u30ca\u30fc\u6848",
    imageSize: clean(input.imageSize) || "1080x1080",
    additionalInstruction: clean(input.additionalInstruction),
    revisionInstruction: clean(input.revisionInstruction),
    instructionPolicy: input.instructionPolicy && typeof input.instructionPolicy === "object"
      ? input.instructionPolicy
      : buildInstructionPolicy([input.additionalInstruction, input.revisionInstruction].filter(Boolean).join("\n")),
    lockedContentSnapshot: input.lockedContentSnapshot && typeof input.lockedContentSnapshot === "object" ? input.lockedContentSnapshot : null,
    lastEditMode: input.lastEditMode === "full" ? "full" : (input.lastEditMode === "range" ? "range" : ""),
    lastEditInstruction: clean(input.lastEditInstruction),
    lastEditRegionCount: Number.isFinite(Number(input.lastEditRegionCount)) ? Number(input.lastEditRegionCount) : 0,
    lastEditRegions: Array.isArray(input.lastEditRegions) ? input.lastEditRegions : [],
    lastImageEditMode: input.lastImageEditMode === "full" ? "full" : (input.lastImageEditMode === "range" ? "range" : ""),
    lastImageEditError: clean(input.lastImageEditError),
    lastImageEditErrorAt: clean(input.lastImageEditErrorAt),
    imageText: clean(input.imageText),
    adCopyText: clean(input.adCopyText),
    copyBrief: input.copyBrief && typeof input.copyBrief === "object" ? input.copyBrief : null,
    authorizedClaimSet: input.authorizedClaimSet && typeof input.authorizedClaimSet === "object"
      ? input.authorizedClaimSet
      : (input.copyBrief?.authorizedClaimSet && typeof input.copyBrief.authorizedClaimSet === "object" ? input.copyBrief.authorizedClaimSet : null),
    generationRunId: clean(input.generationRunId),
    candidateGroupId: clean(input.candidateGroupId),
    candidateIndex: input.candidateIndex === null || input.candidateIndex === undefined || input.candidateIndex === ""
      ? null
      : Number(input.candidateIndex),
    messagePlan: input.messagePlan && typeof input.messagePlan === "object" ? input.messagePlan : null,
    communicationReview: input.communicationReview && typeof input.communicationReview === "object" ? input.communicationReview : null,
    templateFitDecision: input.templateFitDecision && typeof input.templateFitDecision === "object" ? input.templateFitDecision : null,
    promptJson: input.promptJson || null,
    promptText: clean(input.promptText),
    structureSheet: input.structureSheet || input.promptJson?.structureSheet || null,
    regulationCheck: input.regulationCheck || null,
    overriddenRules: Array.isArray(input.overriddenRules) ? input.overriddenRules : [],
    reviewChecklist: input.reviewChecklist || input.promptJson?.reviewChecklist || null,
    factCheck: input.factCheck || null,
    strategyCheck: input.strategyCheck || null,
    categoryRelation: input.categoryRelation && typeof input.categoryRelation === "object" ? input.categoryRelation : null,
    copyQualityReview: input.copyQualityReview && typeof input.copyQualityReview === "object" ? input.copyQualityReview : null,
    copyLengthReview: input.copyLengthReview && typeof input.copyLengthReview === "object" ? input.copyLengthReview : null,
    originalityReview: input.originalityReview && typeof input.originalityReview === "object" ? input.originalityReview : null,
    copyReviewHistory: Array.isArray(input.copyReviewHistory) ? input.copyReviewHistory : [],
    bannerGenerationContract: input.bannerGenerationContract && typeof input.bannerGenerationContract === "object" ? input.bannerGenerationContract : null,
    approvedClaimSnapshot: input.approvedClaimSnapshot && typeof input.approvedClaimSnapshot === "object" ? input.approvedClaimSnapshot : null,
    creativeHypothesis: input.creativeHypothesis && typeof input.creativeHypothesis === "object" ? input.creativeHypothesis : null,
    visualHypothesisRef: input.visualHypothesisRef && typeof input.visualHypothesisRef === "object" ? input.visualHypothesisRef : null,
    pipelineNodes: input.pipelineNodes && typeof input.pipelineNodes === "object"
      ? normalizePipelineState(input.pipelineNodes)
      : deriveLegacyPipelineStateFromArtifacts(input),
    colorDecision: input.colorDecision && typeof input.colorDecision === "object" ? input.colorDecision : null,
    copyIntegrityCheck: input.copyIntegrityCheck && typeof input.copyIntegrityCheck === "object" ? input.copyIntegrityCheck : null,
    logoVerification: input.logoVerification || null,
    selectionReason: clean(input.selectionReason),
    diversityReview: input.diversityReview && typeof input.diversityReview === "object" ? input.diversityReview : null,
    variationAxis: clean(input.variationAxis),
    hypothesis: clean(input.hypothesis),
    expectedCvrReason: clean(input.expectedCvrReason),
    referenceImageUrl: clean(input.referenceImageUrl),
    productImagePath: productImagePaths[0] || "",
    productImagePaths,
    logoImagePath: logoImagePaths[0] || "",
    logoImagePaths,
    otherImagePath: otherImagePaths[0] || "",
    otherImagePaths,
    previewPath: clean(input.previewPath),
    generatedImagePath,
    generatedImageHash: clean(input.generatedImageHash),
    generatedImageModel: clean(input.generatedImageModel),
    generatedImageSize: clean(input.generatedImageSize),
    images: Array.isArray(input.images) && input.images.length ? input.images : (generatedImagePath ? [generatedImagePath] : []),
    warnings: Array.isArray(input.warnings) ? input.warnings : [],
    productionStatus: clean(input.productionStatus) || "not_started",
    imageGenerationStatus: clean(input.imageGenerationStatus) || "not_started",
    imageGenerationLease: input.imageGenerationLease && typeof input.imageGenerationLease === "object" ? input.imageGenerationLease : null,
    imageGenerationAudit: input.imageGenerationAudit && typeof input.imageGenerationAudit === "object" ? input.imageGenerationAudit : null,
    promptGenerationLease: input.promptGenerationLease && typeof input.promptGenerationLease === "object" ? input.promptGenerationLease : null,
    lastError: clean(input.lastError),
    lastErrorAt: clean(input.lastErrorAt),
    provider: clean(input.provider),
    reviewNotes: clean(input.reviewNotes),
    sourceRunId: clean(input.sourceRunId),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt
  };
}

function buildLockedCopyLengthReview(copyBrief) {
  const violations = findSlotLengthViolations(copyBrief, null).map((slot) => ({
    slotId: slot.slotId,
    role: slot.role,
    canonicalField: slot.canonicalField,
    charCount: slot.charCount,
    charBudget: slot.charBudget,
    maxChars: slot.maxChars,
    overBy: slot.charCount - slot.maxChars
  }));
  return {
    version: "1.0",
    status: violations.length ? "warning" : "passed",
    rule: "no_minimum_under_10_plus_2_otherwise_floor_120_percent",
    copyLocked: true,
    rewriteAllowed: false,
    violations,
    checkedAt: new Date().toISOString()
  };
}

function cleanImagePaths(paths, legacyPath) {
  const values = Array.isArray(paths) ? paths : [legacyPath];
  return [...new Set(values.map(clean).filter(Boolean))];
}

function buildStrategicSpreadAxes(strategy = {}) {
  const markdown = clean(strategy.markdown);
  if (markdown) {
    const sourceSummary = clip(markdown, 120);
    return [
      ["欲求起点", "戦略本文から欲求を読み取り、自分ごと化するフックを最優先して横展開する。"],
      ["判断基準起点", "戦略本文から判断基準を読み取り、選ぶ理由が一目で伝わる構成にする。"],
      ["競合差分起点", "戦略本文から想定競合との差分を読み取り、独自性が伝わる構成にする。"],
      ["USP/実績起点", "戦略本文からUSPと実績を読み取り、信頼できる根拠を強調する。"],
      ["オファー障壁除去", "戦略本文からオファーを読み取り、行動のハードルを下げる構成にする。"]
    ].map(([label, instruction]) => ({
      label,
      source: markdown,
      instruction: `${instruction}\n戦略本文を唯一の正とし、旧構造化項目は参照しない。`,
      hypothesis: `戦略本文「${sourceSummary}」を${label}で再構成すると、異なる反応軸を検証できる。`
    }));
  }

  return [
    {
      label: "欲求起点",
      source: strategy.desire,
      instruction: "WHO-WHATの欲求を起点に、自分ごと化するフックを最優先して横展開する。",
      hypothesis: `欲求「${clip(strategy.desire, 80)}」を冒頭で言語化すると、ターゲットの注意を止めやすい。`
    },
    {
      label: "判断基準起点",
      source: strategy.decisionCriteria,
      instruction: "WHO-WHATの判断基準を起点に、選ぶ理由が一目で伝わる構成にする。",
      hypothesis: `判断基準「${clip(strategy.decisionCriteria, 80)}」に直接答えると、比較検討中のユーザーに刺さる。`
    },
    {
      label: "競合差分起点",
      source: strategy.alternatives,
      instruction: "WHO-WHATの想定競合との差分を起点に、それではダメな理由とこれなら解決する理由を暗示する。",
      hypothesis: `想定競合「${clip(strategy.alternatives, 80)}」との違いを示すと、既存解決策に不満がある層を動かせる。`
    },
    {
      label: "USP/実績起点",
      source: [strategy.usp, strategy.proof].filter(Boolean).join("\n"),
      instruction: "USPと実績を起点に、信頼・根拠・権威性で行動の不安を下げる。",
      hypothesis: `USP/実績「${clip([strategy.usp, strategy.proof].filter(Boolean).join(" / "), 80)}」を強調すると、信頼不足を補える。`
    },
    {
      label: "オファー障壁除去",
      source: strategy.offer,
      instruction: "WHO-WHATのオファーを起点に、まず試すだけ・今選ぶ理由・損しにくさを強調する。",
      hypothesis: `オファー「${clip(strategy.offer, 80)}」を目立たせると、行動ハードルを下げられる。`
    }
  ].map((axis) => ({
    ...axis,
    hypothesis: axis.source ? axis.hypothesis : `${axis.label}で横展開し、WHO-WHATから不足情報を補って検証する。`
  }));
}

function clip(value, length) {
  const text = clean(value).replace(/\s+/g, " ");
  return text.length > length ? text.slice(0, length) + "..." : text;
}

function uniqueStrings(values) {
  return Array.from(new Set((values || []).map(clean).filter(Boolean)));
}

function buildImageText({ banner, product, strategy }) {
  const productName = product.name || "\u5546\u54c1";
  const benefit = strategy.benefit || strategy.productConcept || "\u9078\u3070\u308c\u308b\u7406\u7531\u3092\u76f4\u611f\u7684\u306b\u4f1d\u3048\u308b";
  const offer = strategy.offer || "\u8a73\u3057\u304f\u898b\u308b";
  return [productName, benefit, offer, banner.additionalInstruction].filter(Boolean).join("\n");
}

function buildPromptJson({ banner, product, strategy, template, imageText }) {
  const templateText = template?.templateTextStoryboard || template?.textStoryboard || "\u30c6\u30f3\u30d7\u30ec\u672a\u9078\u629e\u3002\u60c5\u5831\u968e\u5c64\u3001\u8996\u7dda\u8a98\u5c0e\u3001CTA\u306e\u76ee\u7acb\u3061\u65b9\u3092\u91cd\u8996\u3059\u308b\u3002";
  return {
    productName: product.name || "",
    strategyName: strategy.conceptName || "",
    templateAdId: template?.id || "",
    templateTextStoryboard: templateText,
    successFactors: template?.successFactors || "",
    target: strategy.targetAttributes || strategy.desire || "",
    benefit: strategy.benefit || strategy.productConcept || "",
    offer: strategy.offer || "",
    imageText,
    visualDirection: [
      "\u9078\u629e\u3057\u305f\u5e83\u544a\u30c6\u30f3\u30d7\u30ec\u306e\u69cb\u9020\u3092\u4f7f\u3044\u3001\u5546\u54c1\u30fbWHO-WHAT\u30fb\u8ffd\u52a0\u6307\u793a\u306b\u5408\u308f\u305b\u3066\u4e2d\u8eab\u3060\u3051\u3092\u518d\u69cb\u6210\u3059\u308b\u3002",
      "\u30c6\u30f3\u30d7\u30ec\u69cb\u9020: " + templateText,
      banner.additionalInstruction ? "\u8ffd\u52a0\u6307\u793a: " + banner.additionalInstruction : "",
      banner.referenceImageUrl ? "\u53c2\u7167\u753b\u50cf: " + banner.referenceImageUrl : ""
    ].filter(Boolean).join("\n"),
    negativeRules: ["\u52b9\u679c\u306e\u65ad\u5b9a", "\u904e\u5ea6\u306a\u30d3\u30d5\u30a9\u30fc\u30a2\u30d5\u30bf\u30fc", "\u533b\u7642\u7684\u306a\u6cbb\u7642\u8868\u73fe"]
  };
}

function effectiveBannerInstruction(banner = {}) {
  return uniqueStrings([banner.additionalInstruction, banner.revisionInstruction]).join("\n");
}

function clean(value) {
  return String(value || "").trim();
}

function createId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
