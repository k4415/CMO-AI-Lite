export const ORIGINALITY_POLICY = Object.freeze({
  version: "2.0",
  templateNearMax: 0.45,
  templateFarMax: 0.70,
  siblingMax: 0.55,
  continuousMatchChars: 12
});

const COMMON_EXCLUSIONS = ["詳しく見る", "詳細を見る", "今すぐ見る", "もっと見る", "お申し込み", "無料相談"];

export function reviewOriginality({
  brief = {},
  template = null,
  siblings = [],
  relation = {},
  excludedTerms = [],
  copyLocked = false,
  instructionPolicy = {},
  candidateGroupId = "",
  creativeHypothesis = null,
  approvedClaimSnapshot = null
} = {}) {
  const authorizedClaimSet = brief?.authorizedClaimSet && typeof brief.authorizedClaimSet === "object"
    ? brief.authorizedClaimSet
    : {};
  const additionalInstructionIntent = creativeHypothesis?.additionalInstructionIntent
    || authorizedClaimSet?.additionalInstructionIntent
    || instructionPolicy;
  const sharedClaimExclusions = sharedClaimTexts(brief, approvedClaimSnapshot);
  const originalityExclusions = [
    ...COMMON_EXCLUSIONS.map((text) => ({ text, reason: "generic_cta" })),
    ...normalizeExclusions(excludedTerms),
    ...normalizeExclusions((additionalInstructionIntent.fixedCopy || []).map((text) => ({ text, reason: "additional_instruction" }))),
    ...normalizeExclusions((authorizedClaimSet.mandatorySharedAnchors || []).map((text) => ({ text, reason: "mandatory_shared_anchor" }))),
    ...normalizeExclusions(sharedClaimExclusions.map((text) => ({ text, reason: "approved_shared_claim" })))
  ];
  const exclusions = originalityExclusions.map((item) => item.text);
  const briefSlots = briefSlotEntries(brief);
  const templateSlots = Array.isArray(template?.copyBlueprint?.slots)
    ? template.copyBlueprint.slots
    : (Array.isArray(template?.templatePromptJson?.copyBlueprint?.slots) ? template.templatePromptJson.copyBlueprint.slots : []);
  let templateSimilarity = 0;
  const matchedPhrases = [];
  let exactTemplateMatch = false;
  for (const slot of templateSlots) {
    const candidate = briefSlots.find((item) => item.slotId === slot.slotId)
      || briefSlots.find((item) => item.canonicalField && item.canonicalField === canonicalFieldForMessageRole(slot.messageRole));
    if (!candidate?.text || !slot.originalText) continue;
    const normalizedCandidate = normalizeSimilarityText(candidate.text, exclusions);
    const normalizedOriginal = normalizeSimilarityText(slot.originalText, exclusions);
    templateSimilarity = Math.max(templateSimilarity, char3GramJaccard(normalizedCandidate, normalizedOriginal));
    exactTemplateMatch ||= Boolean(normalizedCandidate && normalizedCandidate === normalizedOriginal);
    const phrase = longestCommonSubstring(normalizedCandidate, normalizedOriginal);
    if (phrase.length >= ORIGINALITY_POLICY.continuousMatchChars) matchedPhrases.push(phrase);
  }

  const briefText = collectBriefText(brief);
  let siblingMaxSimilarity = 0;
  let candidateDuplicate = false;
  const currentGroupId = String(candidateGroupId || brief?.candidateGroupId || "").trim();
  const currentCandidateIndex = candidateIndexOf(brief);
  const currentMainHook = normalizeSimilarityText(primaryHook(brief), exclusions);
  const currentAngle = normalizeSimilarityText(creativeHypothesis?.chosenAngle || authorizedClaimSet?.chosenAngle || brief?.appealAxis, []);
  for (const sibling of Array.isArray(siblings) ? siblings : []) {
    const siblingBrief = sibling?.copyBrief || sibling;
    const siblingText = typeof sibling === "string" ? sibling : collectBriefText(siblingBrief) || String(sibling?.imageText || "");
    siblingMaxSimilarity = Math.max(siblingMaxSimilarity, char3GramJaccard(
      normalizeSimilarityText(briefText, exclusions),
      normalizeSimilarityText(siblingText, exclusions)
    ));
    const phrase = longestCommonSubstring(
      normalizeSimilarityText(briefText, exclusions),
      normalizeSimilarityText(siblingText, exclusions)
    );
    if (phrase.length >= ORIGINALITY_POLICY.continuousMatchChars) matchedPhrases.push(phrase);
    const siblingGroupId = String(sibling?.candidateGroupId || siblingBrief?.candidateGroupId || "").trim();
    const siblingCandidateIndex = candidateIndexOf(siblingBrief, sibling);
    const siblingMainHook = normalizeSimilarityText(primaryHook(siblingBrief), exclusions);
    const siblingHypothesis = sibling?.creativeHypothesis || siblingBrief?.creativeHypothesis || null;
    const siblingAngle = normalizeSimilarityText(siblingHypothesis?.chosenAngle || siblingBrief?.authorizedClaimSet?.chosenAngle || siblingBrief?.appealAxis, []);
    if (currentGroupId
      && siblingGroupId === currentGroupId
      && currentMainHook
      && currentMainHook === siblingMainHook
      && currentAngle
      && currentAngle === siblingAngle
      && (currentCandidateIndex === null || siblingCandidateIndex === null || currentCandidateIndex > siblingCandidateIndex)) {
      candidateDuplicate = true;
    }
  }

  const templateLimit = relation?.value === "far" ? ORIGINALITY_POLICY.templateFarMax : ORIGINALITY_POLICY.templateNearMax;
  const allowSiblingSimilarity = copyLocked
    || instructionPolicy?.allowSiblingSimilarity === true
    || additionalInstructionIntent?.allowSiblingSimilarity === true
    || (additionalInstructionIntent?.similarityOverrideDimensions || []).some((dimension) => ["angle", "promise"].includes(dimension));
  const failures = candidateDuplicate && !allowSiblingSimilarity ? ["candidate_duplicate"] : [];
  const exemption = copyLocked
    ? "explicit_copy_reuse"
    : (allowSiblingSimilarity ? "additional_instruction_similarity" : "");
  return {
    version: ORIGINALITY_POLICY.version,
    templateSimilarity: round(templateSimilarity),
    siblingMaxSimilarity: round(siblingMaxSimilarity),
    matchedPhrases: [...new Set(matchedPhrases)],
    exactTemplateMatch,
    candidateDuplicate,
    thresholds: {
      template: templateLimit,
      sibling: ORIGINALITY_POLICY.siblingMax,
      continuousMatchChars: ORIGINALITY_POLICY.continuousMatchChars
    },
    status: failures.length ? "failed" : "passed",
    failures,
    originalityExclusions: originalityExclusions.filter((item) => item.reason !== "generic_cta"),
    ...(exemption ? { exemption } : {})
  };
}

function sharedClaimTexts(brief, approvedClaimSnapshot) {
  const claimsById = new Map((Array.isArray(approvedClaimSnapshot?.claims) ? approvedClaimSnapshot.claims : [])
    .map((claim) => [String(claim?.claimId || "").trim(), claim])
    .filter(([claimId]) => claimId));
  const claimIds = new Set((Array.isArray(brief?.slotTexts) ? brief.slotTexts : [])
    .flatMap((slot) => Array.isArray(slot?.claimIds) ? slot.claimIds : [])
    .map((claimId) => String(claimId || "").trim())
    .filter(Boolean));
  return [...claimIds]
    .map((claimId) => claimsById.get(claimId))
    .filter((claim) => claim && (claim.sourceType === "product_identity" || claim.claimKind === "identity" || claim.claimKind === "product_concept"))
    .map((claim) => String(claim.text || "").trim())
    .filter(Boolean);
}

function candidateIndexOf(...values) {
  for (const value of values) {
    const numeric = Number(value?.candidateIndex);
    if (Number.isInteger(numeric) && numeric >= 0) return numeric;
  }
  return null;
}

function primaryHook(brief) {
  const direct = String(brief?.mainHook || "").trim();
  if (direct) return direct;
  const slot = (Array.isArray(brief?.slotTexts) ? brief.slotTexts : []).find((item) => (
    String(item?.canonicalField || "") === "mainHook" && String(item?.text || "").trim()
  ));
  return String(slot?.text || "").trim();
}

function normalizeExclusions(values) {
  return (Array.isArray(values) ? values : []).map((value) => {
    if (value && typeof value === "object") {
      return { text: String(value.text || "").trim(), reason: String(value.reason || "fixed_term").trim() || "fixed_term" };
    }
    return { text: String(value || "").trim(), reason: "fixed_term" };
  }).filter((item) => item.text);
}

export function char3GramJaccard(left, right) {
  const a = grams(String(left || ""));
  const b = grams(String(right || ""));
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection / new Set([...a, ...b]).size;
}

export function normalizeSimilarityText(value, excludedTerms = []) {
  let text = String(value || "").normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
  for (const term of excludedTerms) {
    const normalizedTerm = String(term || "").normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
    if (normalizedTerm) text = text.replaceAll(normalizedTerm, "");
  }
  return text;
}

function grams(value) {
  const text = String(value || "");
  if (text.length < 3) return new Set();
  const result = new Set();
  for (let index = 0; index <= text.length - 3; index += 1) result.add(text.slice(index, index + 3));
  return result;
}

function longestCommonSubstring(left, right) {
  if (!left || !right) return "";
  const previous = new Array(right.length + 1).fill(0);
  let bestLength = 0;
  let bestEnd = 0;
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = new Array(right.length + 1).fill(0);
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      if (left[leftIndex - 1] !== right[rightIndex - 1]) continue;
      current[rightIndex] = previous[rightIndex - 1] + 1;
      if (current[rightIndex] > bestLength) {
        bestLength = current[rightIndex];
        bestEnd = leftIndex;
      }
    }
    for (let index = 0; index < current.length; index += 1) previous[index] = current[index];
  }
  return left.slice(bestEnd - bestLength, bestEnd);
}

function briefSlotEntries(brief) {
  if (Array.isArray(brief?.slotTexts) && brief.slotTexts.length) {
    return brief.slotTexts.map((slot) => ({
      slotId: String(slot?.slotId || ""),
      canonicalField: String(slot?.canonicalField || ""),
      text: String(slot?.text || "")
    }));
  }
  return ["mainHook", "subHook", "proof", "offerBadge", "cta", "disclaimer"]
    .map((field) => ({ slotId: "", canonicalField: field, text: String(brief?.[field] || "") }))
    .filter((item) => item.text);
}

function collectBriefText(brief) {
  const slotText = (Array.isArray(brief?.slotTexts) ? brief.slotTexts : []).map((slot) => slot?.text).filter(Boolean);
  const canonical = [brief?.mainHook, brief?.subHook, brief?.proof, brief?.offerBadge, brief?.cta, brief?.disclaimer].filter(Boolean);
  return [...new Set([...slotText, ...canonical].map(String))].join("\n");
}

function canonicalFieldForMessageRole(role) {
  const value = String(role || "").toLowerCase();
  if (/hook|headline|main|primary/.test(value)) return "mainHook";
  if (/problem|empathy|solution|benefit|sub/.test(value)) return "subHook";
  if (/proof|reason|evidence|trust/.test(value)) return "proof";
  if (/offer/.test(value)) return "offerBadge";
  if (/cta|action/.test(value)) return "cta";
  if (/disclaimer|note/.test(value)) return "disclaimer";
  return "";
}

function round(value) {
  return Math.round(value * 10000) / 10000;
}
