import crypto from "node:crypto";
import { anthropicJson } from "./anthropic-text.js";
import { loadPrompt } from "./prompt-files.js";
import { classifyExpressionRules, prepareBannerGenerationContext } from "./banner-ai.js";
import { buildInstructionPolicy } from "./banner-instruction-policy.js";
import { normalizeApprovedClaimSnapshot } from "./banner-approved-claims.js";
import {
  buildCopySlotPlan,
  charBudgetBounds,
  normalizeSlotTexts,
  sanitizeCopySlotPlanForPrompt,
  syncCanonicalFieldsFromSlots
} from "./banner-copy-slots.js";
import { buildTemplateCopyInput } from "./banner-copy-ai.js";
import { hashCopyBrief } from "./banner-copy-hash.js";
import { checkCopyGate } from "./banner-copy-gate.js";

const DEFAULT_TEXT_MODEL = process.env.CMOAI_BANNER_COPY_MODEL || process.env.ANTHROPIC_MODEL || "claude-opus-4-8";
const BANNER_COPYPLAN_SYSTEM = loadPrompt("banner-copy");
const REASONING_EFFORT = process.env.CMOAI_BANNER_COPY_EFFORT || process.env.ANTHROPIC_EFFORT || "high";
const COPYPLAN_TIMEOUT_MS = Number(process.env.CMOAI_BANNER_COPY_TIMEOUT_MS || process.env.ANTHROPIC_TIMEOUT_MS) || 120000;

export async function generateBannerCopyPlan({
  banners,
  product,
  strategy,
  template,
  expressionRules = [],
  extraInstruction = "",
  approvedClaimSnapshot = null,
  generationRunId: requestedGenerationRunId = "",
  candidateGroupId: requestedCandidateGroupId = "",
  candidateIndexes = [],
  baselineSeed = null,
  jsonGenerator = anthropicJson
} = {}) {
  const targets = Array.isArray(banners) ? banners.filter(Boolean) : [];
  if (!targets.length) throw new Error("コピー開発対象のバナー案がありません。");

  const generationRunId = clean(requestedGenerationRunId) || crypto.randomUUID();
  const candidateGroupId = clean(requestedCandidateGroupId) || crypto.randomUUID();
  const stableCandidateIndexes = targets.map((banner, index) => (
    Number.isInteger(candidateIndexes[index])
      ? candidateIndexes[index]
      : (Number.isInteger(banner?.candidateIndex) ? banner.candidateIndex : index)
  ));

  const generationContext = prepareBannerGenerationContext(product, strategy);
  const instructionPolicy = buildInstructionPolicy(extraInstruction);
  const rules = classifyExpressionRules(expressionRules, generationContext.product, instructionPolicy);
  const copySlotPlan = buildCopySlotPlan(template);
  const snapshot = approvedClaimSnapshot ? normalizeApprovedClaimSnapshot(approvedClaimSnapshot) : null;
  const categoryRelation = normalizeCategoryRelation(null, template, strategy);

  const userPrompt = buildCopyplanUserPrompt({
    product: generationContext.product,
    strategy: generationContext.strategy,
    template,
    copySlotPlan,
    expressionRules: rules.specifiedRules.slice(0, 40),
    extraInstruction,
    instructionPolicy,
    approvedClaimSnapshot: snapshot,
    count: targets.length,
    candidateIndexes: stableCandidateIndexes,
    baselineSeed: normalizeBaselineSeed(baselineSeed),
    categoryRelation
  });

  let parsed = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await jsonGenerator({
        system: BANNER_COPYPLAN_SYSTEM,
        user: userPrompt,
        model: DEFAULT_TEXT_MODEL,
        reasoningEffort: REASONING_EFFORT,
        timeoutMs: COPYPLAN_TIMEOUT_MS
      });
      validateBatchResponse(response, {
        expectedCount: targets.length,
        candidateIndexes: stableCandidateIndexes,
        baselineSeed
      });
      parsed = response;
      break;
    } catch (error) {
      if (attempt >= 1) {
        throw new Error("コピー設計の生成に失敗しました: " + (error?.message || "不明なエラー"));
      }
    }
  }

  const hypothesis = buildCopyplanHypothesis(parsed.hypothesis, {
    strategyId: generationContext.strategy.id || "",
    approvedClaimSnapshot: snapshot,
    generationRunId,
    candidateGroupId
  });
  const resolvedCategoryRelation = normalizeCategoryRelation(parsed.categoryRelation, template, strategy);

  const candidateMap = new Map(
    (Array.isArray(parsed.candidates) ? parsed.candidates : [])
      .map((candidate) => [Number(candidate?.candidateIndex), candidate])
  );

  const results = [];
  for (let index = 0; index < targets.length; index += 1) {
    const banner = targets[index];
    const candidateIndex = stableCandidateIndexes[index];
    let candidate = candidateMap.get(candidateIndex) || parsed.candidates[index];
    const warnings = [];
    let gateResult = checkCopyGate({
      copyBrief: { slotTexts: candidate?.slotTexts || [] },
      copySlotPlan,
      expressionRules: rules.ngRules
    });

    if (!gateResult.ok) {
      const retryPrompt = userPrompt + "\n\n## 修正指示\n" + gateResult.violations.map((v) => v.message).join("\n")
        + "\n\ncandidateIndex=" + candidateIndex + " の案だけを1件返してください。";
      try {
        const retryParsed = await jsonGenerator({
          system: BANNER_COPYPLAN_SYSTEM,
          user: retryPrompt,
          model: DEFAULT_TEXT_MODEL,
          reasoningEffort: REASONING_EFFORT,
          timeoutMs: COPYPLAN_TIMEOUT_MS
        });
        const retryCandidate = Array.isArray(retryParsed?.candidates) ? retryParsed.candidates[0] : retryParsed;
        if (retryCandidate?.slotTexts) candidate = retryCandidate;
        gateResult = checkCopyGate({
          copyBrief: { slotTexts: candidate?.slotTexts || [] },
          copySlotPlan,
          expressionRules: rules.ngRules
        });
      } catch {
        // 単案リトライ失敗時は警告付きで続行
      }
      if (!gateResult.ok) {
        for (const violation of gateResult.violations) {
          warnings.push(warningEntry(violation.type, violation.message));
        }
      }
    }

    const selfCheckWarnings = collectSelfCheckWarnings(candidate?.selfCheck);
    for (const message of selfCheckWarnings) {
      warnings.push(warningEntry("copy_selfcheck_unresolved", message));
    }

    const copyBrief = buildCopyBriefFromCandidate(candidate, {
      strategyId: generationContext.strategy.id || banner.strategyId || "",
      hypothesis,
      approvedClaimSnapshot: snapshot,
      copySlotPlan,
      generationRunId,
      candidateGroupId,
      candidateIndex
    });

    const status = warnings.length ? "warning" : "passed";
    results.push({
      bannerId: banner.id,
      status,
      copyBrief,
      reviewHistory: [{
        attempt: 1,
        decision: status,
        copyBrief,
        qualityReview: null,
        candidateId: banner.id,
        attemptId: ""
      }],
      categoryRelation: resolvedCategoryRelation,
      bannerGenerationContract: null,
      generationRunId,
      candidateGroupId,
      candidateIndex,
      warnings
    });
  }

  return {
    hypothesis,
    categoryRelation: resolvedCategoryRelation,
    results
  };
}

function buildCopyplanUserPrompt({
  product,
  strategy,
  template,
  copySlotPlan,
  expressionRules,
  extraInstruction,
  instructionPolicy,
  approvedClaimSnapshot,
  count,
  candidateIndexes,
  baselineSeed,
  categoryRelation
}) {
  const slotLimits = (copySlotPlan.slots || []).map((slot) => ({
    slotId: slot.slotId,
    role: slot.canonicalField || slot.role || "",
    charBudget: slot.charBudget,
    maxChars: charBudgetBounds(slot.charBudget).max,
    required: slot.required !== false
  }));
  return JSON.stringify({
    product,
    strategy,
    templateCopy: buildTemplateCopyInput(template, categoryRelation),
    copySlotPlan: sanitizeCopySlotPlanForPrompt(copySlotPlan),
    slotLimits,
    expressionRules,
    extraInstruction,
    instructionPolicy,
    approvedClaimSnapshot,
    categoryRelation,
    count,
    candidateIndexes,
    baselineSeed
  }, null, 2);
}

function buildCopyplanHypothesis(raw, { strategyId, approvedClaimSnapshot, generationRunId, candidateGroupId }) {
  const source = raw && typeof raw === "object" ? raw : {};
  const base = {
    version: 1,
    strategyId: clean(strategyId),
    approvedClaimSnapshotId: clean(approvedClaimSnapshot?.snapshotId),
    approvedClaimSnapshotHash: clean(approvedClaimSnapshot?.contentHash),
    audienceAttribute: clean(source.audienceAttribute),
    targetMoment: clean(source.targetMoment),
    barrier: clean(source.barrier),
    chosenAngle: clean(source.chosenAngle),
    primaryPromise: clean(source.primaryPromise),
    supportingClaimIds: [],
    proofClaimIds: [],
    offerClaimIds: [],
    templateMechanism: clean(source.templateMechanism),
    visualIntent: {
      scene: clean(source.visualIntent?.scene),
      motif: clean(source.visualIntent?.motif)
    },
    semanticGroupPlan: [],
    templateFitDecision: { status: "adapt", reason: "copyplan_v7", roleAdjustments: [] },
    variationPolicy: { changedDimensions: ["hook", "supportingProof", "ctaTone"], preservedDimensions: ["primaryPromise", "templateStructure"] },
    additionalInstructionIntent: {},
    origin: "copyplan_v7"
  };
  const contentHash = hashObject(base);
  return {
    ...base,
    hypothesisId: `hyp_${crypto.createHash("sha256")
      .update([generationRunId, candidateGroupId, "shared", contentHash].join("\u0000"))
      .digest("hex")
      .slice(0, 16)}`,
    contentHash
  };
}

function buildCopyBriefFromCandidate(candidate, {
  strategyId,
  hypothesis,
  approvedClaimSnapshot,
  copySlotPlan,
  generationRunId,
  candidateGroupId,
  candidateIndex
}) {
  const source = candidate && typeof candidate === "object" ? candidate : {};
  const slotTexts = normalizeSlotTexts(source.slotTexts || [], copySlotPlan);
  const canonical = syncCanonicalFieldsFromSlots(slotTexts);
  const variationRole = normalizeVariationRole(source.variationRole, candidateIndex);
  const brief = {
    version: 4,
    strategyId: clean(strategyId),
    hypothesisId: clean(hypothesis.hypothesisId),
    hypothesisHash: clean(hypothesis.contentHash),
    approvedClaimSnapshotId: clean(approvedClaimSnapshot?.snapshotId),
    approvedClaimSnapshotHash: clean(approvedClaimSnapshot?.contentHash),
    generatedAt: new Date().toISOString(),
    model: DEFAULT_TEXT_MODEL,
    appealAxis: clean(source.appealAxis || source.angle || hypothesis.chosenAngle),
    variationRole,
    baselineReference: normalizeBaselineReference(source.baselineReference, candidateIndex),
    variationDirection: clean(source.variationDirection || source.angle || source.appealAxis),
    whyItStops: clean(source.whyItStops),
    targetMoment: clean(hypothesis.targetMoment),
    mainHook: canonical.mainHook || "",
    subHook: canonical.subHook || "",
    proof: canonical.proof || "",
    offerBadge: canonical.offerBadge || "",
    cta: canonical.cta || "",
    disclaimer: canonical.disclaimer || "",
    slotTexts: slotTexts.map((slot) => ({
      ...slot,
      hypothesisId: clean(hypothesis.hypothesisId),
      claimIds: []
    })),
    semanticGroupReadout: Array.isArray(source.semanticGroupReadout) ? source.semanticGroupReadout : [],
    generationRunId,
    candidateGroupId,
    candidateIndex
  };
  brief.copyBriefHash = hashCopyBrief(brief);
  return brief;
}

function validateBatchResponse(parsed, {
  expectedCount,
  candidateIndexes = [],
  baselineSeed = null
} = {}) {
  if (!parsed || typeof parsed !== "object") throw invalidBatch("応答がオブジェクトではありません。");
  if (!parsed.hypothesis || typeof parsed.hypothesis !== "object") throw invalidBatch("hypothesisがありません。");
  const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
  if (candidates.length < expectedCount) throw invalidBatch("candidates件数が不足しています。");
  const requestedCandidateIndexes = Array.isArray(candidateIndexes) && candidateIndexes.length
    ? candidateIndexes.map((candidateIndex) => Number(candidateIndex))
    : Array.from({ length: expectedCount }, (_, index) => index);
  const candidateMap = new Map(candidates.map((candidate) => [Number(candidate?.candidateIndex), candidate]));
  const selectedCandidates = requestedCandidateIndexes.map((candidateIndex) => candidateMap.get(candidateIndex)).filter(Boolean);
  if (selectedCandidates.length < expectedCount) {
    throw invalidBatch("要求されたcandidateIndexが不足しています。");
  }
  const selectedCandidateIndexes = selectedCandidates.map((candidate) => Number(candidate?.candidateIndex));
  if (selectedCandidateIndexes.some((candidateIndex) => !Number.isInteger(candidateIndex))) {
    throw invalidBatch("candidateIndexが不足しています。");
  }
  if (new Set(selectedCandidateIndexes).size !== selectedCandidateIndexes.length) {
    throw invalidBatch("candidateIndexが重複しています。");
  }
  const baseline = selectedCandidates.find((candidate) => Number(candidate?.candidateIndex) === 0) || normalizeBaselineSeed(baselineSeed);
  if (!baseline) throw invalidBatch("candidateIndex=0 のbaseline案がありません。");
  if (Number(baseline?.candidateIndex || 0) === 0 && normalizeVariationRole(baseline?.variationRole, 0) !== "baseline") {
    throw invalidBatch("baseline案のvariationRoleが不正です。");
  }
  const baselineSignature = slotTextSignature(baseline);
  if (selectedCandidates.some((candidate) => !clean(candidate?.whyItStops))) {
    throw invalidBatch("whyItStopsが不足しています。");
  }
  for (const candidate of selectedCandidates) {
    const candidateIndex = Number(candidate?.candidateIndex);
    if (!Array.isArray(candidate?.slotTexts) || !candidate.slotTexts.length) {
      throw invalidBatch(`candidateIndex=${candidateIndex} のslotTextsが不足しています。`);
    }
    if (candidateIndex === 0) continue;
    if (normalizeBaselineReference(candidate?.baselineReference, candidateIndex) !== 0) {
      throw invalidBatch(`candidateIndex=${candidateIndex} のbaselineReferenceは0を参照してください。`);
    }
    if (!clean(candidate?.variationDirection || candidate?.angle || candidate?.appealAxis)) {
      throw invalidBatch(`candidateIndex=${candidateIndex} のvariationDirectionが不足しています。`);
    }
    if (slotTextSignature(candidate) === baselineSignature) {
      throw invalidBatch(`candidateIndex=${candidateIndex} がbaselineと同一コピーです。`);
    }
  }
}

function collectSelfCheckWarnings(selfCheck) {
  if (!selfCheck || typeof selfCheck !== "object") return [];
  const checks = ["blindReadability", "system1Impact", "coherence", "strategyFit"];
  const messages = [];
  for (const key of checks) {
    if (clean(selfCheck[key]) === "warn") {
      messages.push(...(Array.isArray(selfCheck.issues) ? selfCheck.issues : []).map(clean).filter(Boolean));
    }
  }
  return messages.length ? messages : (
    checks.some((key) => clean(selfCheck[key]) === "warn") ? ["自己チェックで警告がありました。"] : []
  );
}

function normalizeCategoryRelation(value, template, strategy) {
  if (value && typeof value === "object") {
    const far = value.value === "far" || value.reuseMethod === "abstract_pattern" || value.reuseMethod === "pattern_fill";
    return {
      value: far ? "far" : "near",
      reuseMethod: far ? "pattern_fill" : "mechanism_only",
      confidence: Number(value.confidence) || 0,
      reason: clean(value.reason),
      signals: Array.isArray(value.signals) ? value.signals : []
    };
  }
  return { value: "near", reuseMethod: "mechanism_only", confidence: 0, reason: "", signals: [] };
}

function warningEntry(type, message) {
  return { type, stage: "copyplan", message, occurredAt: new Date().toISOString() };
}

function invalidBatch(message) {
  return new Error(message);
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

function clean(value) {
  return String(value ?? "").trim();
}

function normalizeVariationRole(value, candidateIndex) {
  const normalized = clean(value).toLowerCase();
  if (normalized === "baseline" || normalized === "base") return "baseline";
  if (normalized === "variant" || normalized === "variation") return "variant";
  return Number(candidateIndex) === 0 ? "baseline" : "variant";
}

function normalizeBaselineReference(value, candidateIndex) {
  if (Number(candidateIndex) === 0) return 0;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : 0;
}

function slotTextSignature(candidate) {
  const items = Array.isArray(candidate?.slotTexts) ? candidate.slotTexts : [];
  return stableStringify(items.map((slot) => ({
    slotId: clean(slot?.slotId),
    text: clean(slot?.text)
  })).sort((left, right) => left.slotId.localeCompare(right.slotId)));
}

function normalizeBaselineSeed(value) {
  if (!value || typeof value !== "object") return null;
  const slotTexts = Array.isArray(value.slotTexts)
    ? value.slotTexts
    : (Array.isArray(value.copyBrief?.slotTexts) ? value.copyBrief.slotTexts : []);
  if (!slotTexts.length) return null;
  return {
    candidateIndex: Number.isInteger(value.candidateIndex) ? value.candidateIndex : 0,
    variationRole: normalizeVariationRole(value.variationRole, 0),
    slotTexts,
    appealAxis: clean(value.appealAxis || value.copyBrief?.appealAxis),
    whyItStops: clean(value.whyItStops || value.copyBrief?.whyItStops)
  };
}
