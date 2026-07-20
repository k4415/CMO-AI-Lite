import crypto from "node:crypto";
import { anthropicJson } from "./anthropic-text.js";
import { loadPrompt } from "./prompt-files.js";
import { classifyExpressionRules, prepareBannerGenerationContext } from "./banner-ai.js";
import { buildInstructionPolicy } from "./banner-instruction-policy.js";
import { extractObjectiveTokens, normalizeApprovedClaimSnapshot } from "./banner-approved-claims.js";
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
const REASONING_EFFORT = process.env.CMOAI_BANNER_COPY_EFFORT || process.env.ANTHROPIC_EFFORT || "low";
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
  const enforceObjectiveAuthorization = Array.isArray(approvedClaimSnapshot?.claims);
  const categoryRelation = normalizeCategoryRelation(null, template, strategy);
  const maxTokens = resolveBannerCopyMaxTokens({ count: targets.length, slotCount: copySlotPlan.slots?.length || 0 });

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
        timeoutMs: COPYPLAN_TIMEOUT_MS,
        maxTokens
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
    let gateResult = checkCandidateGate(candidate, {
      copySlotPlan,
      expressionRules: rules.ngRules,
      approvedClaimSnapshot: snapshot,
      enforceObjectiveAuthorization
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
          timeoutMs: COPYPLAN_TIMEOUT_MS,
          maxTokens
        });
        const retryCandidate = Array.isArray(retryParsed?.candidates) ? retryParsed.candidates[0] : retryParsed;
        if (retryCandidate?.slotTexts) candidate = retryCandidate;
        gateResult = checkCandidateGate(candidate, {
          copySlotPlan,
          expressionRules: rules.ngRules,
          approvedClaimSnapshot: snapshot,
          enforceObjectiveAuthorization
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
  const slotTexts = sanitizeGeneratedSlotTexts(
    normalizeSlotTexts(source.slotTexts || [], copySlotPlan),
    copySlotPlan,
    approvedClaimSnapshot
  );
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

function checkCandidateGate(candidate, {
  copySlotPlan,
  expressionRules,
  approvedClaimSnapshot,
  enforceObjectiveAuthorization
}) {
  const base = checkCopyGate({
    copyBrief: { slotTexts: candidate?.slotTexts || [] },
    copySlotPlan,
    expressionRules
  });
  if (!enforceObjectiveAuthorization) return base;
  const allowedTokens = new Set((approvedClaimSnapshot?.claims || []).flatMap((claim) => claim.objectiveTokens || []));
  const unauthorized = (candidate?.slotTexts || []).flatMap((slot) => (
    extractObjectiveTokens(slot?.text).filter((token) => !allowedTokens.has(token)).map((token) => ({
      type: "unauthorized_objective_claim",
      slotId: clean(slot?.slotId),
      message: `${clean(slot?.slotId) || "copy slot"} の数値・保証表現「${token}」は選択WHO-WHATまたは追加指示に根拠がありません。根拠内の表現へ修正してください。`
    }))
  ));
  return {
    ok: base.ok && unauthorized.length === 0,
    violations: [...(base.violations || []), ...unauthorized]
  };
}

export function resolveBannerCopyMaxTokens({ count = 1, slotCount = 1 } = {}, configuredValue = process.env.CMOAI_BANNER_COPY_MAX_TOKENS) {
  const configured = Number(configuredValue);
  if (Number.isFinite(configured) && configured > 0) return Math.max(1000, Math.round(configured));
  const candidateCount = Math.max(1, Number(count) || 1);
  const slotsPerCandidate = Math.max(1, Number(slotCount) || 1);
  return Math.min(12000, 4000 + candidateCount * slotsPerCandidate * 100);
}

function sanitizeGeneratedSlotTexts(slotTexts, copySlotPlan, approvedClaimSnapshot) {
  const planSlots = Array.isArray(copySlotPlan?.slots) ? copySlotPlan.slots : [];
  const planById = new Map(planSlots.map((slot) => [clean(slot.slotId), slot]));
  const requiredTexts = new Set(slotTexts
    .filter((slot) => planById.get(clean(slot.slotId))?.required !== false)
    .map((slot) => comparableCopy(slot.text))
    .filter(Boolean));
  const authorizedClaimTexts = Array.isArray(approvedClaimSnapshot?.claims)
    ? approvedClaimSnapshot.claims.map((claim) => clean(claim?.text)).filter(Boolean)
    : [];

  return slotTexts.map((slot) => {
    const planSlot = planById.get(clean(slot.slotId));
    if (!planSlot || planSlot.required !== false || !clean(slot.text)) return slot;
    const duplicateOfRequired = requiredTexts.has(comparableCopy(slot.text));
    const hasOfferOrInstructionSource = (approvedClaimSnapshot?.claims || []).some((claim) => (
      claim?.claimKind === "offer" || claim?.claimKind === "instruction_claim"
    ));
    const unsupportedOptionalAction = planSlot.sourcePolicy === "instruction_or_strategy"
      && /disclaimer|cta|注釈|免責|行動/i.test(`${planSlot.messageRole || ""} ${planSlot.canonicalField || ""} ${planSlot.role || ""}`)
      && !hasOfferOrInstructionSource;
    const unsupportedScarcity = planSlot.sourcePolicy === "instruction_or_strategy"
      && hasUnsupportedScarcityClaim(slot.text, authorizedClaimTexts);
    if (!duplicateOfRequired && !unsupportedOptionalAction && !unsupportedScarcity) return slot;
    return { ...slot, text: "", charCount: 0 };
  });
}

function hasUnsupportedScarcityClaim(value, authorizedClaimTexts) {
  const text = clean(value);
  const claims = Array.isArray(authorizedClaimTexts) ? authorizedClaimTexts : [];
  const signals = [
    { output: /先着/, source: /先着/ },
    { output: /(?:公開)?枠/, source: /枠/ },
    { output: /限定|限りあり|今だけ/, source: /限定|限りあり|今だけ/ },
    { output: /予告なく終了|終了間近/, source: /予告なく終了|終了間近/ },
    { output: /残り(?:わずか|[0-9０-９])/, source: /残り(?:わずか|[0-9０-９])/ }
  ];
  return signals.some(({ output, source }) => output.test(text) && !claims.some((claim) => source.test(claim)));
}

function comparableCopy(value) {
  return clean(value).normalize("NFKC").toLowerCase().replace(/[\s。、，,.!！?？・「」『』（）()【】\[\]]/g, "");
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
