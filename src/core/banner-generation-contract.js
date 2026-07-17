import { buildInstructionPolicy } from "./banner-instruction-policy.js";
import {
  normalizeApprovedClaimSnapshot,
  validateCopyAuthorization
} from "./banner-approved-claims.js";
import { normalizeTemplateReadinessState } from "./template-readiness.js";

export function buildBannerGenerationContract({
  banner = {},
  product = {},
  strategy = {},
  template = null,
  categoryRelation = null,
  extraInstruction = "",
  instructionPolicy = null,
  expressionRules = [],
  approvedClaimSnapshot = null,
  creativeHypothesis = null
} = {}) {
  const relation = normalizeCategoryRelation(categoryRelation);
  const policy = instructionPolicy || buildInstructionPolicy(extraInstruction || banner.additionalInstruction || "");
  const snapshot = normalizeApprovedClaimSnapshot(approvedClaimSnapshot);
  const hypothesis = creativeHypothesis && typeof creativeHypothesis === "object" ? creativeHypothesis : {};
  return {
    version: 2,
    strategyWhat: normalizeStrategyWhat(strategy),
    templateHow: normalizeTemplateHow(template, relation),
    instructionPolicy: policy,
    approvedClaimSnapshotRef: {
      snapshotId: String(snapshot.snapshotId || ""),
      contentHash: String(snapshot.contentHash || "")
    },
    creativeHypothesisRef: {
      hypothesisId: String(hypothesis.hypothesisId || ""),
      contentHash: String(hypothesis.contentHash || "")
    },
    approvedClaimSnapshot: snapshot,
    creativeHypothesis: hypothesis,
    constraints: {
      expressionRules: (Array.isArray(expressionRules) ? expressionRules : []).slice(0, 40),
      imageSize: String(banner.imageSize || "1080x1080"),
      productIdentity: {
        productId: String(product.id || banner.productId || ""),
        productName: String(product.name || ""),
        brandTone: String(product.brandTone || "")
      }
    },
    sourceTracePolicy: {
      requireTemplateSourceForHow: Boolean(template),
      claimSource: "authorized_claim_set"
    },
    communicationPolicy: {
      requireProductOrTaskAnchor: true,
      requireSinglePrimaryPromise: true,
      requireNumberContext: true,
      requireMessageUnity: true,
      copyLocked: policy.protectedFields.includes("copyBrief")
    }
  };
}

export function assertTemplateReadyForGeneration(template) {
  if (!template) return { templateMode: "none", readiness: null };
  const readiness = normalizeTemplateReadinessState(template.templateReadiness, template);
  if (template.templateProcessingStatus === "completed" && readiness.readyForGeneration) {
    return { templateMode: "selected", readiness };
  }
  const error = new Error("選択したテンプレートは再解析が必要です。");
  error.code = "TEMPLATE_NOT_READY";
  error.productionStatus = "template_not_ready";
  error.templateId = String(template.id || "");
  error.issues = readiness.issues;
  throw error;
}

export function validateCopySourceTrace({
  copyBrief = {},
  contract = {},
  creativeHypothesis = contract.creativeHypothesis || {},
  approvedClaimSnapshot = contract.approvedClaimSnapshot || {}
} = {}) {
  return validateCopyAuthorization({
    copyBrief,
    creativeHypothesis,
    approvedClaimSnapshot
  });
}

function normalizeStrategyWhat(strategy) {
  const source = strategy && typeof strategy === "object" && !Array.isArray(strategy) ? strategy : {};
  const markdown = String(source.markdown || "").trim();
  if (markdown) {
    return {
      strategyId: String(source.id || ""),
      sourceMode: "markdown",
      conceptName: String(source.conceptName || ""),
      markdown
    };
  }
  return {
    strategyId: String(source.id || ""),
    sourceMode: "structured_fallback",
    conceptName: String(source.conceptName || ""),
    who: String(source.targetAttributes || source.target || ""),
    problem: String(source.problem || source.pain || ""),
    desiredOutcome: String(source.desire || ""),
    decisionCriteria: normalizeArray(source.decisionCriteria || source.selectionCriteria),
    alternatives: normalizeArray(source.competitors || source.alternatives),
    promise: String(source.benefit || source.promise || ""),
    proof: normalizeArray(source.proof || source.reasonsToBelieve),
    offer: String(source.offer || "")
  };
}

function normalizeTemplateHow(template, relation) {
  if (!template) {
    return {
      templateMode: "none",
      templateId: "",
      categoryRelation: relation.value,
      reuseMethod: "none",
      hookMechanism: "",
      messageFlow: [],
      copySlots: [],
      visualHierarchy: [],
      eyeFlow: ""
    };
  }
  const blueprint = template.copyBlueprint || template.templatePromptJson?.copyBlueprint || {};
  const persuasion = blueprint.persuasionMechanism || {};
  const layout = template.layoutBlueprint || template.templatePromptJson?.layoutBlueprint || {};
  const copySlots = (Array.isArray(blueprint.slots) ? blueprint.slots : []).map((slot) => ({
    slotId: String(slot?.slotId || ""),
    role: String(slot?.role || ""),
    messageRole: String(slot?.messageRole || ""),
    charBudget: Number(slot?.charBudget) || 0,
    required: slot?.required !== false,
    sourcePolicy: String(slot?.sourcePolicy || "strategy_required"),
    emptyPolicy: String(slot?.emptyPolicy || (slot?.required === false ? "allow" : "block")),
    rhetoricalDevice: String(slot?.rhetoricalDevice || ""),
    psychologicalMechanism: String(slot?.psychologicalMechanism || ""),
    ...(relation.reuseMethod === "pattern_fill" ? {
      pattern: String(slot?.pattern || ""),
      variables: normalizeArray(slot?.variables)
    } : {})
  }));
  return {
    templateMode: "selected",
    templateId: String(template.id || ""),
    categoryRelation: relation.value,
    reuseMethod: relation.reuseMethod,
    hookMechanism: String(persuasion.primaryHookMechanism || persuasion.targetResponse || ""),
    messageFlow: normalizeArray(persuasion.messageFlow),
    copySlots,
    visualHierarchy: normalizeArray(layout.visualHierarchy),
    eyeFlow: String(layout.eyeFlow || "")
  };
}

function normalizeCategoryRelation(value) {
  const far = value?.value === "far" || value?.reuseMethod === "pattern_fill";
  return {
    value: far ? "far" : "near",
    reuseMethod: far ? "pattern_fill" : "mechanism_only"
  };
}

function normalizeText(value) {
  return String(value || "").normalize("NFKC").replace(/[\s,，、。・「」『』（）()]/g, "").toLowerCase();
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  return String(value || "").split(/[\n,、]/).map((item) => item.trim()).filter(Boolean);
}
