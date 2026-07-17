import crypto from "node:crypto";

import { buildInstructionPolicy } from "./banner-instruction-policy.js";
import { hashCopyBrief } from "./banner-copy-hash.js";
import { copyBriefMeetsSlotRequirements } from "./banner-copy-slots.js";

export const PIPELINE_NODE_ORDER = [
  "copyplan",
  "prompt",
  "image"
];

export const PIPELINE_POLICY_VERSIONS = Object.freeze({
  copyplan: 2,
  prompt: 2,
  image: 1
});

const NODE_STATUSES = new Set(["pending", "running", "completed", "failed"]);

export function normalizePipelineState(value = {}) {
  return Object.fromEntries(PIPELINE_NODE_ORDER.map((node) => {
    const source = value?.[node] && typeof value[node] === "object" ? value[node] : {};
    return [node, {
      status: NODE_STATUSES.has(source.status) ? source.status : "pending",
      inputHash: clean(source.inputHash),
      outputHash: clean(source.outputHash),
      attemptId: clean(source.attemptId),
      errorCode: clean(source.errorCode),
      errorMessage: clean(source.errorMessage),
      updatedAt: clean(source.updatedAt),
      startedAt: clean(source.startedAt),
      completedAt: clean(source.completedAt),
      durationMs: nonNegativeInteger(source.durationMs),
      retryCount: nonNegativeInteger(source.retryCount),
      retryExhausted: source.retryExhausted === true
    }];
  }));
}

export function markPipelineNode(value, node, patch = {}) {
  if (!PIPELINE_NODE_ORDER.includes(node)) throw new Error("Unknown pipeline node: " + node);
  const state = normalizePipelineState(value);
  state[node] = {
    ...state[node],
    ...patch,
    status: NODE_STATUSES.has(patch.status) ? patch.status : state[node].status,
    inputHash: clean(patch.inputHash ?? state[node].inputHash),
    outputHash: clean(patch.outputHash ?? state[node].outputHash),
    attemptId: clean(patch.attemptId ?? state[node].attemptId),
    errorCode: clean(patch.errorCode ?? state[node].errorCode),
    errorMessage: clean(patch.errorMessage ?? state[node].errorMessage),
    retryCount: nonNegativeInteger(patch.retryCount ?? state[node].retryCount),
    retryExhausted: patch.retryExhausted === true,
    updatedAt: new Date().toISOString()
  };
  return state;
}

export function invalidatePipelineFrom(value, node) {
  const state = normalizePipelineState(value);
  const start = PIPELINE_NODE_ORDER.indexOf(node);
  if (start < 0) throw new Error("Unknown pipeline node: " + node);
  const updatedAt = new Date().toISOString();
  for (let index = start; index < PIPELINE_NODE_ORDER.length; index += 1) {
    state[PIPELINE_NODE_ORDER[index]] = {
      status: "pending",
      inputHash: "",
      outputHash: "",
      attemptId: "",
      errorCode: "",
      errorMessage: "",
      updatedAt,
      startedAt: "",
      completedAt: "",
      durationMs: 0,
      retryCount: 0,
      retryExhausted: false
    };
  }
  return state;
}

export function reconcilePipelineState(value, expectedInputHashes = {}, currentOutputHashes = {}) {
  const state = normalizePipelineState(value);
  const staleNode = findFirstInvalidPipelineNode(state, expectedInputHashes, currentOutputHashes);
  if (!staleNode) return state;
  const invalidated = invalidatePipelineFrom(state, staleNode);
  const previous = state[staleNode];
  if (previous.status === "failed" && previous.inputHash === clean(expectedInputHashes[staleNode])) {
    invalidated[staleNode] = {
      ...invalidated[staleNode],
      inputHash: previous.inputHash,
      errorCode: previous.errorCode,
      errorMessage: previous.errorMessage,
      retryCount: previous.retryCount,
      retryExhausted: previous.retryExhausted
    };
  }
  return invalidated;
}

export function nextPipelineNode(banner = {}, expectedInputHashes = {}, currentOutputHashes = {}) {
  return findFirstInvalidPipelineNode(normalizePipelineState(banner.pipelineNodes), expectedInputHashes, currentOutputHashes);
}

export function findFirstInvalidPipelineNode(state, expectedInputHashes = {}, currentOutputHashes = {}) {
  return PIPELINE_NODE_ORDER.find((node) => (
    state[node].status !== "completed"
    || !state[node].inputHash
    || state[node].inputHash !== clean(expectedInputHashes[node])
    || !state[node].outputHash
    || state[node].outputHash !== clean(currentOutputHashes[node])
  )) || null;
}

export function buildPipelineInputHashes(context = {}) {
  const banner = context.banner || {};
  const instructionPolicy = context.instructionPolicy || buildInstructionPolicy(
    [banner.additionalInstruction, banner.revisionInstruction].filter(Boolean).join("\n")
  );
  const snapshotHash = clean(context.approvedClaimSnapshot?.contentHash || banner.approvedClaimSnapshot?.contentHash);
  const hypothesisHash = clean(context.creativeHypothesis?.contentHash || banner.creativeHypothesis?.contentHash);
  const copyBriefHash = clean(banner.copyBrief?.copyBriefHash || context.copyBrief?.copyBriefHash);
  const promptOutputHash = hashPromptOutput(banner.promptJson, banner.promptText);
  const referenceAssets = normalizeReferenceAssets(context.referenceAssets, banner);
  const expressionRules = normalizeExpressionRules(context.expressionRules);
  const copySlotPlan = normalizeCopySlotPlan(context.copySlotPlan);
  const copyplan = hashNode("copyplan", {
    strategy: normalizeStrategy(context.strategy),
    product: normalizeProduct(context.product),
    approvedClaimSnapshotHash: snapshotHash,
    templateMechanism: normalizeTemplateMechanism(context.template),
    copySlotPlan,
    instructionIntent: normalizeCopyInstructionIntent(instructionPolicy),
    expressionRules,
    generationRunId: banner.generationRunId,
    candidateGroupId: banner.candidateGroupId,
    candidateIndex: Number.isInteger(banner.candidateIndex) ? banner.candidateIndex : null
  });
  const prompt = hashNode("prompt", {
    copyBriefHash,
    creativeHypothesisHash: hypothesisHash,
    approvedClaimSnapshotHash: snapshotHash,
    templateVisualStructure: normalizeTemplateVisualStructure(context.template),
    imageSize: clean(banner.imageSize || "1080x1080"),
    referenceAssets,
    visualInstructionIntent: normalizeVisualInstructionIntent(instructionPolicy),
    expressionRules
  });
  const image = hashNode("image", {
    promptOutputHash,
    promptText: clean(banner.promptText),
    promptJson: banner.promptJson && typeof banner.promptJson === "object" ? banner.promptJson : null,
    imageSize: clean(banner.imageSize || "1080x1080"),
    referenceAssets,
    provider: "openai",
    model: "gpt-image-2"
  });
  return { copyplan, prompt, image };
}

export function buildPipelineOutputHashes(context = {}) {
  const banner = context.banner || context || {};
  const copySlotPlan = context.copySlotPlan;
  const hypothesis = banner.creativeHypothesis || context.creativeHypothesis;
  const copyBrief = banner.copyBrief || context.copyBrief;
  const hypothesisOutput = hashCreativeHypothesisContract(hypothesis);
  const copyOutput = validCopyBriefOutputHash(copyBrief, copySlotPlan);
  const copyplanOutput = copyOutput && hypothesisOutput
    ? hashObject({ copyBriefHash: copyBrief.copyBriefHash, hypothesisHash: hypothesis.contentHash })
    : copyOutput;
  const promptOutput = hashPromptOutput(banner.promptJson, banner.promptText);
  const imageOutput = banner.generatedImagePath && banner.generatedImageHash
    ? hashObject({
        path: clean(banner.generatedImagePath),
        contentHash: clean(banner.generatedImageHash),
        model: clean(banner.generatedImageModel || "gpt-image-2"),
        size: clean(banner.generatedImageSize || banner.imageSize)
      })
    : "";
  return {
    copyplan: copyplanOutput,
    prompt: promptOutput,
    image: imageOutput
  };
}

export function restartNodeForPipelineError(error = {}) {
  if (PIPELINE_NODE_ORDER.includes(error.restartNode)) return error.restartNode;
  const byCode = {
    COPYPLAN_FAILED: "copyplan",
    COPYBRIEF_CONTRACT_INVALID: "copyplan",
    HYPOTHESIS_IDENTITY_STAMP_NODE_MISMATCH: "copyplan",
    INVALID_HYPOTHESIS_IDENTITY_STAMP: "copyplan",
    IMAGE_GENERATION_FAILED: "image",
    PROMPT_CONTRACT_REFS_INVALID: "prompt"
  };
  return byCode[clean(error.code)] || "prompt";
}

function validCopyBriefOutputHash(copyBrief, copySlotPlan) {
  if (!copyBrief || typeof copyBrief !== "object") return "";
  if (!copyBriefMeetsSlotRequirements(copyBrief, copySlotPlan)) return "";
  const recomputed = hashCopyBrief(copyBrief);
  return clean(copyBrief.copyBriefHash) === recomputed ? recomputed : "";
}

function hashCreativeHypothesisContract(value) {
  if (!value || typeof value !== "object" || !clean(value.contentHash)) return "";
  const base = {
    version: Number(value.version) || 0,
    strategyId: clean(value.strategyId),
    approvedClaimSnapshotId: clean(value.approvedClaimSnapshotId),
    approvedClaimSnapshotHash: clean(value.approvedClaimSnapshotHash),
    audienceAttribute: clean(value.audienceAttribute),
    targetMoment: clean(value.targetMoment),
    barrier: clean(value.barrier),
    chosenAngle: clean(value.chosenAngle),
    primaryPromise: clean(value.primaryPromise),
    supportingClaimIds: uniqueStrings(value.supportingClaimIds),
    proofClaimIds: uniqueStrings(value.proofClaimIds),
    offerClaimIds: uniqueStrings(value.offerClaimIds),
    templateMechanism: clean(value.templateMechanism),
    visualIntent: {
      scene: clean(value.visualIntent?.scene),
      motif: clean(value.visualIntent?.motif)
    },
    semanticGroupPlan: Array.isArray(value.semanticGroupPlan) ? value.semanticGroupPlan : [],
    templateFitDecision: value.templateFitDecision && typeof value.templateFitDecision === "object" ? value.templateFitDecision : null,
    variationPolicy: value.variationPolicy && typeof value.variationPolicy === "object" ? value.variationPolicy : null,
    additionalInstructionIntent: value.additionalInstructionIntent && typeof value.additionalInstructionIntent === "object" ? value.additionalInstructionIntent : null,
    origin: clean(value.origin)
  };
  const recomputed = hashObject(base);
  return recomputed === clean(value.contentHash) ? recomputed : "";
}

function hasContractEvidence(banner) {
  return Boolean(banner.bannerGenerationContract || banner.claimAlignmentReview || banner.copyQualityReview?.claimAlignmentReview);
}

function normalizeReviewEvidence(banner) {
  const evidence = {
    copyQualityReview: banner.copyQualityReview || null,
    communicationReview: banner.communicationReview || null,
    originalityReview: banner.originalityReview || null,
    strategyCheck: banner.strategyCheck || null,
    regulationCheck: banner.regulationCheck || null
  };
  return Object.values(evidence).some(Boolean) ? evidence : null;
}

function hashPromptOutput(promptJson, promptText) {
  if (!promptJson || typeof promptJson !== "object" || !Object.keys(promptJson).length || !clean(promptText)) return "";
  return hashObject({ promptJson, promptText: clean(promptText) });
}

function normalizeStrategy(value = {}) {
  return {
    id: clean(value.id),
    markdown: clean(value.markdown),
    targetAttributes: clean(value.targetAttributes || value.target),
    problem: clean(value.problem || value.pain),
    desire: clean(value.desire),
    decisionCriteria: normalizeList(value.decisionCriteria || value.selectionCriteria),
    competitors: normalizeList(value.competitors || value.alternatives),
    usp: clean(value.usp),
    benefit: clean(value.benefit || value.promise),
    proof: normalizeList(value.proof || value.reasonsToBelieve),
    offer: clean(value.offer)
  };
}

function normalizeProduct(value = {}) {
  return { id: clean(value.id), name: clean(value.name) };
}

function normalizeTemplateMechanism(template = {}) {
  const source = template && typeof template === "object" ? template : {};
  const persuasion = source.copyBlueprint?.persuasionMechanism
    || source.templatePromptJson?.copyBlueprint?.persuasionMechanism
    || {};
  return {
    primaryHookMechanism: clean(persuasion.primaryHookMechanism),
    targetResponse: clean(persuasion.targetResponse),
    messageFlow: normalizeList(persuasion.messageFlow)
  };
}

function normalizeTemplateVisualStructure(template = {}) {
  const source = template && typeof template === "object" ? template : {};
  const layout = source.layoutBlueprint || source.templatePromptJson?.layoutBlueprint || {};
  return {
    templateId: clean(source.id),
    visualHierarchy: normalizeList(layout.visualHierarchy),
    eyeFlow: clean(layout.eyeFlow),
    zones: (Array.isArray(layout.zones) ? layout.zones : []).map((zone) => ({
      position: zone?.position || "",
      purpose: clean(zone?.purpose),
      elements: (Array.isArray(zone?.elements) ? zone.elements : []).map((element) => ({
        type: clean(element?.type),
        slotId: clean(element?.slotId),
        role: clean(element?.role),
        messageRole: clean(element?.messageRole),
        position: element?.position || {},
        size: clean(element?.size),
        effect: clean(element?.effect)
      }))
    }))
  };
}

function normalizeCopySlotPlan(value = {}) {
  return {
    templateId: clean(value.templateId),
    slots: (Array.isArray(value.slots) ? value.slots : []).map((slot) => ({
      slotId: clean(slot?.slotId),
      canonicalField: clean(slot?.canonicalField),
      charBudget: Number(slot?.charBudget) || 0,
      required: slot?.required !== false,
      sourcePolicy: clean(slot?.sourcePolicy),
      emptyPolicy: clean(slot?.emptyPolicy)
    })),
    semanticGroups: (Array.isArray(value.semanticGroups) ? value.semanticGroups : []).map((group) => ({
      groupId: clean(group?.groupId),
      slotIds: uniqueStrings(group?.slotIds),
      semanticRole: clean(group?.semanticRole),
      readingOrder: Number(group?.readingOrder) || 0,
      joinMode: clean(group?.joinMode),
      required: group?.required !== false,
      groupCharBudget: Number(group?.groupCharBudget) || 0,
      maxSemanticUnits: Number(group?.maxSemanticUnits) || 1
    }))
  };
}

function normalizeSemanticGroupReadout(value) {
  return (Array.isArray(value) ? value : []).map((group) => ({
    groupId: clean(group?.groupId),
    slotIds: uniqueStrings(group?.slotIds),
    visibleText: clean(group?.visibleText),
    expectedMessage: clean(group?.expectedMessage)
  }));
}

function normalizeHypothesisInstructionIntent(policy = {}) {
  return {
    authorizedClaims: uniqueStrings(policy.authorizedClaims),
    forbiddenClaims: uniqueStrings(policy.forbiddenClaims),
    fixedCopy: uniqueStrings(policy.fixedCopy),
    requiredAngles: uniqueStrings(policy.requiredAngles),
    allowSiblingSimilarity: policy.allowSiblingSimilarity === true,
    similarityOverrideDimensions: uniqueStrings(policy.similarityOverrideDimensions)
  };
}

function normalizeCopyInstructionIntent(policy = {}) {
  return {
    ...normalizeHypothesisInstructionIntent(policy),
    changeScope: clean(policy.changeScope)
  };
}

function normalizeVisualInstructionIntent(policy = {}) {
  return {
    visualInstructions: uniqueStrings(policy.visualInstructions),
    visualOverrides: (Array.isArray(policy.explicitOverrides) ? policy.explicitOverrides : [])
      .filter((item) => ["color", "image", "tone", "layout"].includes(clean(item?.field)))
      .map((item) => ({ field: clean(item?.field), instruction: clean(item?.instruction) })),
    changeScope: clean(policy.changeScope)
  };
}

function normalizeExpressionRules(value) {
  return (Array.isArray(value) ? value : [])
    .filter((rule) => rule?.active !== false)
    .map((rule) => ({
      id: clean(rule?.id),
      productId: clean(rule?.productId),
      ruleType: clean(rule?.ruleType),
      pattern: clean(rule?.pattern),
      description: clean(rule?.description),
      active: rule?.active !== false
    }))
    .sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
}

function normalizeReferenceAssets(value, banner) {
  if (Array.isArray(value) && value.length) {
    return value.map((asset) => ({
      role: clean(asset?.role),
      path: clean(asset?.path),
      contentHash: clean(asset?.contentHash)
    }));
  }
  return [
    ...normalizePaths(banner.logoImagePaths, banner.logoImagePath).map((path) => ({ role: "brand-logo", path, contentHash: "" })),
    ...normalizePaths(banner.productImagePaths, banner.productImagePath).map((path) => ({ role: "product", path, contentHash: "" })),
    ...normalizePaths(banner.otherImagePaths, banner.otherImagePath).map((path) => ({ role: "reference", path, contentHash: "" }))
  ];
}

function normalizePaths(multiple, single) {
  return uniqueStrings([...(Array.isArray(multiple) ? multiple : []), single]);
}

function normalizeCategoryRelation(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return { value: clean(source.value), reuseMethod: clean(source.reuseMethod) };
}

function hashNode(node, payload) {
  return hashObject({ policyVersion: PIPELINE_POLICY_VERSIONS[node], ...payload });
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

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  return clean(value) ? [clean(value)] : [];
}

function uniqueStrings(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(clean).filter(Boolean))];
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function clean(value) {
  return String(value ?? "").trim();
}
