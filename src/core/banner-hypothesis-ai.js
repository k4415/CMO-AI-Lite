import crypto from "node:crypto";

import { openAiJson } from "./openai-text.js";
import { loadPrompt } from "./prompt-files.js";
import {
  sanitizeCopySlotPlanForPrompt,
  sanitizeTemplateCopyForPrompt
} from "./banner-copy-slots.js";
import { materializeHypothesisGroupPlan } from "./banner-hypothesis-group-contract.js";

const SYSTEM_PROMPT = loadPrompt("banner-hypothesis");
const FIT_STATUSES = new Set(["fit", "adapt", "reject"]);
const VARIATION_ROLES = new Set(["baseline", "variant"]);
const NON_BLOCKING_VARIATION_CODES = new Set([
  "declared_dimension_not_changed",
  "sibling_message_too_similar"
]);
const DIMENSIONS = new Set([
  "audience",
  "target_moment",
  "barrier",
  "angle",
  "promise",
  "proof",
  "offer",
  "template_structure",
  "visual_scene",
  "visual_motif"
]);

export async function generateCreativeHypotheses({
  banners = [],
  strategy = {},
  templateCopy = null,
  copySlotPlan = null,
  categoryRelation = null,
  instructionPolicy = {},
  approvedClaimSnapshot = {},
  generationRunId = "",
  candidateGroupId = "",
  candidateIndexes = [],
  groupSeed = null,
  hypothesisJsonGenerator = openAiJson
} = {}) {
  const targets = Array.isArray(banners) ? banners.filter(Boolean) : [];
  if (!targets.length) return { results: [] };
  const safeTemplateCopy = sanitizeTemplateCopyForPrompt(templateCopy);
  const safeCopySlotPlan = sanitizeCopySlotPlanForPrompt(copySlotPlan);
  const context = {
    strategyId: strategy.id,
    approvedClaimSnapshot,
    generationRunId,
    candidateGroupId,
    copySlotPlan: safeCopySlotPlan,
    instructionPolicy
  };
  const promptContext = {
    strategy,
    templateCopy: safeTemplateCopy,
    copySlotPlan: safeCopySlotPlan,
    categoryRelation,
    instructionPolicy,
    approvedClaimSnapshot
  };
  const stableCandidateIndexes = targets.map((_, index) => (
    Number.isInteger(candidateIndexes[index]) ? candidateIndexes[index] : index
  ));
  const lockedGroupSeed = groupSeed && typeof groupSeed === "object" && !Array.isArray(groupSeed)
    ? cloneJson(groupSeed)
    : null;

  if (lockedGroupSeed) {
    const parsed = await callHypothesisGenerator(hypothesisJsonGenerator, {
      mode: "extend_existing_group",
      lockedGroupSeed,
      retryCandidates: targetDescriptors(targets, stableCandidateIndexes),
      ...promptContext
    });
    const firstState = materializePlanState({
      plan: candidatePatchResponsePlan(parsed, lockedGroupSeed),
      targets,
      context,
      candidateIndexes: stableCandidateIndexes,
      externalBaseline: true
    });
    if (firstState.rootError) {
      return retryAllCandidatePatches({
        firstState,
        targets,
        context,
        promptContext,
        candidateIndexes: stableCandidateIndexes,
        hypothesisJsonGenerator
      });
    }
    const reviewed = applyGroupVariationReview(firstState, instructionPolicy, false);
    return retryFailedCandidates({
      reviewed,
      state: firstState,
      targets,
      context,
      promptContext,
      candidateIndexes: stableCandidateIndexes,
      hypothesisJsonGenerator
    });
  }

  const parsed = await callHypothesisGenerator(hypothesisJsonGenerator, {
    mode: "create_group_plan",
    count: targets.length,
    banners: targetDescriptors(targets, stableCandidateIndexes),
    ...promptContext
  });
  const firstState = materializePlanState({
    plan: parsed,
    targets,
    context,
    candidateIndexes: stableCandidateIndexes,
    externalBaseline: false
  });
  const baselineFailed = firstState.results[0]?.status === "failed";
  if (firstState.rootError || baselineFailed) {
    const retryParsed = await callHypothesisGenerator(hypothesisJsonGenerator, {
      mode: "retry_group_plan",
      count: targets.length,
      banners: targetDescriptors(targets, stableCandidateIndexes),
      error: firstState.rootError || firstState.results[0]?.error,
      ...promptContext
    });
    const retryState = materializePlanState({
      plan: retryParsed,
      targets,
      context,
      candidateIndexes: stableCandidateIndexes,
      externalBaseline: false
    });
    return { results: applyGroupVariationReview(retryState, instructionPolicy, true) };
  }
  const reviewed = applyGroupVariationReview(firstState, instructionPolicy, false);
  return retryFailedCandidates({
    reviewed,
    state: firstState,
    targets,
    context,
    promptContext,
    candidateIndexes: stableCandidateIndexes,
    hypothesisJsonGenerator
  });
}

export function normalizeCreativeHypothesis(item, context = {}) {
  const claimsById = new Map((context.approvedClaimSnapshot?.claims || []).map((claim) => [claim.claimId, claim]));
  const allowedClaimIds = new Set(claimsById.keys());
  if (!item || typeof item !== "object" || Array.isArray(item)) throw invalid("対象案の仮説がありません。");
  const changedDimensions = uniqueStrings(item.variationPolicy?.changedDimensions);
  const preservedDimensions = uniqueStrings(item.variationPolicy?.preservedDimensions);
  const variationRole = clean(item.variationPolicy?.role);
  const supportingClaimIds = uniqueStrings(item.supportingClaimIds);
  const proofClaimIds = uniqueStrings(item.proofClaimIds);
  const offerClaimIds = uniqueStrings(item.offerClaimIds);
  if (!clean(item.audienceAttribute) || !clean(item.targetMoment) || !clean(item.barrier) || !clean(item.chosenAngle) || !clean(item.primaryPromise)) {
    throw invalid("仮説の必須項目が不足しています。");
  }
  if (changedDimensions.length < 1 || changedDimensions.length > 2 || !preservedDimensions.length) {
    throw invalid("changedDimensionsは1〜2件、preservedDimensionsは1件以上必要です。");
  }
  if ([...changedDimensions, ...preservedDimensions].some((dimension) => !DIMENSIONS.has(dimension))) {
    throw invalid("未定義のvariation dimensionがあります。");
  }
  if (variationRole && !VARIATION_ROLES.has(variationRole)) {
    throw invalid("variationPolicy.roleがbaselineまたはvariantではありません。");
  }
  if ([...supportingClaimIds, ...proofClaimIds, ...offerClaimIds].some((claimId) => !allowedClaimIds.has(claimId))) {
    throw invalid("仮説がApprovedClaimSnapshot外のclaimIdを参照しています。");
  }
  if (!supportingClaimIds.length) {
    throw invalid("primaryPromiseを根拠づけるsupportingClaimIdsがありません。");
  }
  if (proofClaimIds.some((claimId) => !["proof", "instruction_claim"].includes(claimsById.get(claimId)?.claimKind))) {
    throw invalid("proofClaimIdsがproof用途ではないclaimを参照しています。");
  }
  if (offerClaimIds.some((claimId) => !["offer", "instruction_claim"].includes(claimsById.get(claimId)?.claimKind))) {
    throw invalid("offerClaimIdsがoffer用途ではないclaimを参照しています。");
  }
  const fitStatus = FIT_STATUSES.has(item.templateFitDecision?.status)
    ? item.templateFitDecision.status
    : "reject";
  const semanticGroupPlan = normalizeSemanticGroupPlan(item.semanticGroupPlan, context.copySlotPlan);
  const variationPolicy = {
    changedDimensions,
    preservedDimensions,
    ...(variationRole ? { role: variationRole } : {})
  };
  const base = {
    version: 1,
    strategyId: clean(context.strategyId),
    approvedClaimSnapshotId: clean(context.approvedClaimSnapshot?.snapshotId),
    approvedClaimSnapshotHash: clean(context.approvedClaimSnapshot?.contentHash),
    audienceAttribute: clean(item.audienceAttribute),
    targetMoment: clean(item.targetMoment),
    barrier: clean(item.barrier),
    chosenAngle: clean(item.chosenAngle),
    primaryPromise: clean(item.primaryPromise),
    supportingClaimIds,
    proofClaimIds,
    offerClaimIds,
    templateMechanism: clean(item.templateMechanism),
    visualIntent: {
      scene: clean(item.visualIntent?.scene),
      motif: clean(item.visualIntent?.motif)
    },
    semanticGroupPlan,
    templateFitDecision: {
      status: fitStatus,
      reason: clean(item.templateFitDecision?.reason),
      roleAdjustments: Array.isArray(item.templateFitDecision?.roleAdjustments)
        ? cloneJson(item.templateFitDecision.roleAdjustments)
        : []
    },
    variationPolicy,
    additionalInstructionIntent: instructionIntentFromPolicy(context.instructionPolicy),
    origin: "generated"
  };
  const contentHash = hashObject(base);
  return {
    ...base,
    hypothesisId: `hyp_${crypto.createHash("sha256")
      .update([context.generationRunId, context.candidateGroupId, String(context.candidateIndex), contentHash].join("\u0000"))
      .digest("hex")
      .slice(0, 16)}`,
    contentHash
  };
}

async function retryAllCandidatePatches({
  firstState,
  targets,
  context,
  promptContext,
  candidateIndexes,
  hypothesisJsonGenerator
}) {
  const seed = firstState.groupPlanSeed;
  if (!seed) return { results: failureResults(targets, firstState.rootError) };
  const retryParsed = await callHypothesisGenerator(hypothesisJsonGenerator, {
    mode: "retry_candidate_patches",
    sharedContract: seed.sharedContract,
    baselineCandidate: seed.baselineCandidate,
    acceptedSiblingCandidates: [baselineSibling(seed)],
    retryCandidates: targetDescriptors(targets, candidateIndexes, firstState.rootError),
    ...promptContext
  });
  const retryState = materializePlanState({
    plan: candidatePatchResponsePlan(retryParsed, seed),
    targets,
    context,
    candidateIndexes,
    externalBaseline: true
  });
  return { results: applyGroupVariationReview(retryState, promptContext.instructionPolicy, true) };
}

async function retryFailedCandidates({
  reviewed,
  state,
  targets,
  context,
  promptContext,
  candidateIndexes,
  hypothesisJsonGenerator
}) {
  const failed = reviewed
    .map((result, index) => ({ result, index }))
    .filter(({ result }) => result.status === "failed");
  if (!failed.length) return { results: reviewed };
  const seed = state.groupPlanSeed;
  if (!seed) return { results: reviewed };
  const retryTargets = failed.map(({ index }) => targets[index]).filter(Boolean);
  const retryIndexes = failed.map(({ index }) => candidateIndexes[index]);
  const acceptedSiblingCandidates = [
    baselineSibling(seed),
    ...reviewed
      .filter((result) => result.status === "passed" && result.bannerId !== seed.baselineCandidate.bannerId)
      .map((result) => ({ bannerId: result.bannerId, hypothesis: cloneJson(result.hypothesis) }))
  ];
  const retryParsed = await callHypothesisGenerator(hypothesisJsonGenerator, {
    mode: "retry_candidate_patches",
    sharedContract: seed.sharedContract,
    baselineCandidate: seed.baselineCandidate,
    acceptedSiblingCandidates,
    retryCandidates: failed.map(({ result, index }) => ({
      bannerId: targets[index]?.id || result.bannerId,
      candidateIndex: candidateIndexes[index],
      error: result.error
    })),
    ...promptContext
  });
  const retryState = materializePlanState({
    plan: candidatePatchResponsePlan(retryParsed, seed),
    targets: retryTargets,
    context,
    candidateIndexes: retryIndexes,
    externalBaseline: true
  });
  const retryById = new Map(retryState.results.map((result) => [result.bannerId, result]));
  const merged = reviewed.map((result) => retryById.get(result.bannerId) || result);
  return {
    results: applyGroupVariationReview({
      ...state,
      results: merged,
      baselineHypothesis: state.baselineHypothesis || retryState.baselineHypothesis
    }, promptContext.instructionPolicy, true)
  };
}

function materializePlanState({
  plan,
  targets,
  context,
  candidateIndexes,
  externalBaseline
}) {
  const source = plan && typeof plan === "object" && !Array.isArray(plan) ? cloneJson(plan) : {};
  const expectedPatchCount = externalBaseline ? targets.length : Math.max(0, targets.length - 1);
  const groupPlanSeed = source.sharedContract && source.baselineCandidate
    ? {
        sharedContract: cloneJson(source.sharedContract),
        baselineCandidate: cloneJson(source.baselineCandidate)
      }
    : null;
  if (!groupPlanSeed) {
    const rootError = patchInvalid("sharedContractまたはbaselineCandidateがありません。");
    return { results: failureResults(targets, rootError), rootError, groupPlanSeed: null, baselineHypothesis: null };
  }
  let baselineItem;
  try {
    baselineItem = materializeHypothesisGroupPlan({
      plan: { ...groupPlanSeed, candidatePatches: [] },
      copySlotPlan: context.copySlotPlan,
      bannerIds: [groupPlanSeed.baselineCandidate.bannerId]
    }).items[0];
  } catch (error) {
    return {
      results: failureResults(targets, error),
      rootError: error,
      groupPlanSeed,
      baselineHypothesis: null
    };
  }
  const baselineResult = normalizeHypothesisResult({
    banner: { id: groupPlanSeed.baselineCandidate.bannerId },
    item: baselineItem,
    context: { ...context, candidateIndex: externalBaseline ? -1 : candidateIndexes[0] }
  });
  const patches = Array.isArray(source.candidatePatches) ? source.candidatePatches : [];
  if (patches.length !== expectedPatchCount) {
    const rootError = patchInvalid("candidatePatchesの件数が対象bannerと一致しません。");
    return {
      results: failureResults(targets, rootError),
      rootError,
      groupPlanSeed,
      baselineHypothesis: baselineResult.hypothesis || null
    };
  }
  const variantTargets = externalBaseline ? targets : targets.slice(1);
  const variantIndexes = externalBaseline ? candidateIndexes : candidateIndexes.slice(1);
  const variantResults = variantTargets.map((banner, index) => {
    try {
      const item = materializeHypothesisGroupPlan({
        plan: { ...groupPlanSeed, candidatePatches: [patches[index]] },
        copySlotPlan: context.copySlotPlan,
        bannerIds: [banner.id],
        includeBaseline: false
      }).items[0];
      return normalizeHypothesisResult({
        banner,
        item,
        context: { ...context, candidateIndex: variantIndexes[index] }
      });
    } catch (error) {
      return failedResult(banner.id, error);
    }
  });
  return {
    results: externalBaseline ? variantResults : [baselineResult, ...variantResults],
    rootError: null,
    groupPlanSeed,
    baselineHypothesis: baselineResult.hypothesis || null
  };
}

function applyGroupVariationReview(state, instructionPolicy, continueWeakVariation) {
  if (state.rootError || !state.baselineHypothesis) return state.results;
  const relaxedDimensions = new Set(
    instructionPolicy?.allowSiblingSimilarity === true
      ? uniqueStrings(instructionPolicy.similarityOverrideDimensions)
      : []
  );
  const allowSiblingSimilarity = instructionPolicy?.allowSiblingSimilarity === true;
  const accepted = [state.baselineHypothesis];
  return state.results.map((result) => {
    if (result.status !== "passed" || !result.hypothesis) return result;
    if (result.hypothesis.hypothesisId === state.baselineHypothesis.hypothesisId) return result;
    const reasons = validatePreservedDimensions(
      [state.baselineHypothesis, result.hypothesis],
      relaxedDimensions
    ).map((violation) => violation.code);
    const messageSignature = semanticMessageSignature(result.hypothesis);
    if (!allowSiblingSimilarity
      && result.hypothesis.variationPolicy.changedDimensions.includes("promise")
      && messageSignature
      && accepted.some((hypothesis) => semanticMessageSignature(hypothesis) === messageSignature)) {
      reasons.push("sibling_message_too_similar");
    }
    const failureReasons = [...new Set(reasons)];
    if (!failureReasons.length) {
      accepted.push(result.hypothesis);
      return result;
    }
    if (continueWeakVariation && failureReasons.every((reason) => NON_BLOCKING_VARIATION_CODES.has(reason))) {
      const hypothesis = continueWeakVariationReview(result.hypothesis, failureReasons);
      accepted.push(hypothesis);
      return { bannerId: result.bannerId, status: "warning", hypothesis };
    }
    return {
      bannerId: result.bannerId,
      status: "failed",
      hypothesis: result.hypothesis,
      error: {
        code: "HYPOTHESIS_VARIATION_INVALID",
        message: "兄弟案との差別化が勝ち筋契約を満たしていません。",
        failureReasons
      }
    };
  });
}

function continueWeakVariationReview(hypothesis, failureReasons) {
  return {
    ...hypothesis,
    variationReview: {
      status: "warning",
      failureReasons: [...new Set(failureReasons)],
      continuedAfterReview: true,
      retryAllowed: false
    }
  };
}

function normalizeHypothesisResult({ banner, item, context }) {
  try {
    const hypothesis = normalizeCreativeHypothesis(item, context);
    if (hypothesis.templateFitDecision.status === "reject") {
      return {
        bannerId: banner.id,
        status: "template_rejected",
        hypothesis,
        error: {
          code: "TEMPLATE_MESSAGE_FIT_REJECTED",
          message: hypothesis.templateFitDecision.reason
        }
      };
    }
    return { bannerId: banner.id, status: "passed", hypothesis };
  } catch (error) {
    return failedResult(banner.id, error);
  }
}

function normalizeSemanticGroupPlan(value, copySlotPlan) {
  const expected = new Map((copySlotPlan?.semanticGroups || []).map((group) => [clean(group.groupId), group]));
  const supplied = new Map((Array.isArray(value) ? value : []).map((group) => [clean(group.groupId), group]));
  return [...expected.values()].map((group) => {
    const item = supplied.get(clean(group.groupId));
    if (!item || !clean(item.intendedMessage)) throw invalid(`semanticGroupPlanが不足しています: ${group.groupId}`);
    const slotIds = uniqueStrings(item.slotIds);
    if (JSON.stringify(slotIds) !== JSON.stringify(uniqueStrings(group.slotIds))) {
      throw invalid(`semanticGroupのslotIdsが変わっています: ${group.groupId}`);
    }
    return {
      groupId: clean(group.groupId),
      semanticRole: clean(group.semanticRole),
      intendedMessage: clean(item.intendedMessage),
      slotIds,
      readingOrder: Number(group.readingOrder) || 0,
      joinMode: clean(group.joinMode)
    };
  });
}

const DIMENSION_FIELDS = {
  audience: (item) => item.audienceAttribute,
  target_moment: (item) => item.targetMoment,
  barrier: (item) => item.barrier,
  angle: (item) => item.chosenAngle,
  promise: (item) => item.primaryPromise,
  proof: (item) => item.proofClaimIds,
  offer: (item) => item.offerClaimIds,
  template_structure: (item) => item.semanticGroupPlan.map((group) => ({
    groupId: group.groupId,
    slotIds: group.slotIds,
    joinMode: group.joinMode
  })),
  visual_scene: (item) => item.visualIntent.scene,
  visual_motif: (item) => item.visualIntent.motif
};

export function validatePreservedDimensions(hypotheses, relaxedDimensions = new Set()) {
  const baseline = hypotheses[0];
  const violations = [];
  for (let candidateIndex = 1; candidateIndex < hypotheses.length; candidateIndex += 1) {
    const current = hypotheses[candidateIndex];
    const changed = new Set(current.variationPolicy.changedDimensions);
    const preserved = new Set(current.variationPolicy.preservedDimensions);
    for (const [dimension, read] of Object.entries(DIMENSION_FIELDS)) {
      const differs = JSON.stringify(read(current)) !== JSON.stringify(read(baseline));
      if (preserved.has(dimension) && differs) {
        violations.push({ candidateIndex, dimension, code: "preserved_dimension_changed" });
      }
      if (differs && !changed.has(dimension) && !relaxedDimensions.has(dimension)) {
        violations.push({ candidateIndex, dimension, code: "undeclared_dimension_changed" });
      }
      if (!differs && changed.has(dimension) && !relaxedDimensions.has(dimension)) {
        violations.push({ candidateIndex, dimension, code: "declared_dimension_not_changed" });
      }
    }
  }
  return violations;
}

function candidatePatchResponsePlan(parsed, seed) {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)
    && (Object.hasOwn(parsed, "sharedContract") || Object.hasOwn(parsed, "baselineCandidate"))) {
    return { ...seed, candidatePatches: null };
  }
  return {
    ...cloneJson(seed),
    candidatePatches: Array.isArray(parsed?.candidatePatches) ? parsed.candidatePatches : null
  };
}

function targetDescriptors(targets, candidateIndexes, error = null) {
  return targets.map((banner, index) => ({
    bannerId: clean(banner?.id),
    candidateIndex: candidateIndexes[index],
    additionalInstruction: clean(banner?.additionalInstruction),
    ...(error ? { error: normalizeError(error) } : {})
  }));
}

function baselineSibling(seed) {
  return {
    bannerId: seed.baselineCandidate.bannerId,
    sharedContract: cloneJson(seed.sharedContract),
    candidate: cloneJson(seed.baselineCandidate)
  };
}

function failureResults(targets, error) {
  return targets.map((banner) => failedResult(banner.id, error));
}

function failedResult(bannerId, error) {
  return {
    bannerId,
    status: "failed",
    error: normalizeError(error)
  };
}

function normalizeError(error) {
  return {
    code: clean(error?.code) || "HYPOTHESIS_CONTRACT_INVALID",
    message: clean(error?.message) || "勝ち筋仮説契約を確定できませんでした。",
    ...(Array.isArray(error?.failureReasons) ? { failureReasons: [...error.failureReasons] } : {})
  };
}

function semanticMessageSignature(hypothesis) {
  return (hypothesis?.semanticGroupPlan || [])
    .map((group) => clean(group?.intendedMessage).toLowerCase().replace(/\s+/g, ""))
    .filter(Boolean)
    .join("|");
}

async function callHypothesisGenerator(generator, payload) {
  return generator({
    system: SYSTEM_PROMPT,
    user: JSON.stringify(payload, null, 2)
  });
}

function instructionIntentFromPolicy(policy = {}) {
  return {
    fixedCopy: uniqueStrings(policy.fixedCopy),
    requiredAngles: uniqueStrings(policy.requiredAngles),
    forbiddenClaims: uniqueStrings(policy.forbiddenClaims),
    allowSiblingSimilarity: policy.allowSiblingSimilarity === true,
    similarityOverrideDimensions: uniqueStrings(policy.similarityOverrideDimensions),
    changeScope: clean(policy.changeScope) || "none"
  };
}

function invalid(message) {
  const error = new Error(message);
  error.code = "HYPOTHESIS_CONTRACT_INVALID";
  return error;
}

function patchInvalid(message) {
  const error = new Error(message);
  error.code = "HYPOTHESIS_PATCH_INVALID";
  return error;
}

function hashObject(value) {
  return `sha256:${crypto.createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function uniqueStrings(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(clean).filter(Boolean))];
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function clean(value) {
  return String(value ?? "").trim();
}
