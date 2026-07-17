import { openAiJson } from "./openai-text.js";
import { loadPrompt } from "./prompt-files.js";

const COPY_REVIEW_SYSTEM = loadPrompt("banner-copy-review");
const CLAIM_ALIGNMENT_SYSTEM = loadPrompt("banner-claim-alignment");
const SCORE_FIELDS = ["clarity", "specificity", "offerFit"];
const COMMUNICATION_BOOLEAN_FIELDS = [
  "productOrTaskUnderstood",
  "primaryPromiseUnderstood",
  "singleMessageFocus",
  "numberMeaningUnambiguous",
  "offerConditionUnderstood",
  "audienceRelevanceUnderstood"
];
const COMMUNICATION_FAILURES = Object.freeze({
  productOrTaskUnderstood: "product_or_task_not_understood",
  primaryPromiseUnderstood: "primary_promise_not_understood",
  singleMessageFocus: "single_message_focus_failed",
  numberMeaningUnambiguous: "number_meaning_ambiguous",
  offerConditionUnderstood: "offer_condition_not_understood",
  audienceRelevanceUnderstood: "audience_relevance_not_understood"
});

export const COPY_REVIEW_POLICY = Object.freeze({
  version: "4.1",
  passScore: 65,
  criticalFloor: Object.freeze({ clarity: 3 }),
  communicationCriticalFields: Object.freeze([...COMMUNICATION_BOOLEAN_FIELDS]),
  reviewerMode: "blind_reader"
});

export function buildBlindReviewPayload({ briefs = [], product = {}, creativeHypotheses = [] } = {}) {
  const candidates = (Array.isArray(briefs) ? briefs : []).map((brief, index) => ({
    audienceAttribute: clean(creativeHypotheses[index]?.audienceAttribute || brief?.authorizedClaimSet?.audienceAttribute),
    visibleProduct: visibleProductIdentity(product),
    visibleCopy: buildVisibleCopy(brief),
    applicableFields: applicableScoreFields(brief)
  }));
  return { policy: COPY_REVIEW_POLICY, candidates };
}

export async function reviewCopyBriefs({
  briefs = [],
  product = {},
  creativeHypotheses = [],
  copyLocked = false,
  reviewGenerator = openAiJson
} = {}) {
  const targets = Array.isArray(briefs) ? briefs : [];
  if (!targets.length) return [];
  const payload = buildBlindReviewPayload({ briefs: targets, product, creativeHypotheses });
  const parsed = reviewGenerator
    ? await reviewGenerator({ system: COPY_REVIEW_SYSTEM, user: JSON.stringify(payload, null, 2) })
    : { reviews: targets.map((brief) => heuristicReview(brief)) };
  const rawReviews = Array.isArray(parsed?.reviews) ? parsed.reviews : [];
  if (rawReviews.length < targets.length) throw copyReviewError("コピー理解性審査の返却件数が不足しています。");
  return targets.map((brief, index) => normalizeReview(
    rawReviews[index],
    brief,
    copyLocked,
    payload.candidates[index].applicableFields
  ));
}

export async function reviewCopyClaimAlignment({
  briefs = [],
  approvedClaimSnapshot = {},
  reviewGenerator = openAiJson
} = {}) {
  const targets = Array.isArray(briefs) ? briefs : [];
  if (!targets.length) return [];
  const claimsById = new Map((Array.isArray(approvedClaimSnapshot?.claims) ? approvedClaimSnapshot.claims : [])
    .map((claim) => [clean(claim?.claimId), claim])
    .filter(([claimId]) => claimId));
  const candidates = targets.flatMap((brief, candidateIndex) => {
    const candidateId = clean(brief?.candidateId || brief?.hypothesisId) || `candidate-${candidateIndex + 1}`;
    return (Array.isArray(brief?.slotTexts) ? brief.slotTexts : [])
      .filter((slot) => clean(slot?.text) && Array.isArray(slot?.claimIds) && slot.claimIds.length)
      .map((slot) => {
        const claimIds = [...new Set(slot.claimIds.map(clean).filter(Boolean))];
        return {
          candidateId,
          candidateIndex,
          slotId: clean(slot?.slotId),
          text: clean(slot?.text),
          claimIds,
          claims: claimIds.map((claimId) => claimsById.get(claimId)).filter(Boolean).map((claim) => ({
            claimId: clean(claim.claimId),
            text: clean(claim.text),
            claimKind: clean(claim.claimKind),
            allowedUses: Array.isArray(claim.allowedUses) ? claim.allowedUses.map(clean).filter(Boolean) : []
          }))
        };
      });
  });
  if (!candidates.length) return targets.map(() => ({ status: "passed", slots: [], failures: [] }));
  const parsed = reviewGenerator
    ? await reviewGenerator({
        system: CLAIM_ALIGNMENT_SYSTEM,
        user: JSON.stringify({ candidates: candidates.map(({ candidateIndex: _candidateIndex, ...candidate }) => candidate) }, null, 2)
      })
    : { reviews: candidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        slotId: candidate.slotId,
        status: candidate.claims.length === candidate.claimIds.length ? "entailed" : "uncertain",
        claimIds: candidate.claimIds,
        reason: "ID整合のみを確認"
      })) };
  const rawReviews = Array.isArray(parsed?.reviews) ? parsed.reviews : [];
  if (rawReviews.length !== candidates.length) throw claimAlignmentReviewError("claim alignment審査の返却件数が入力と一致しません。");
  const byCandidate = targets.map(() => []);
  candidates.forEach((candidate, index) => {
    const review = rawReviews[index];
    if (clean(review?.candidateId) !== candidate.candidateId || clean(review?.slotId) !== candidate.slotId) {
      throw claimAlignmentReviewError("claim alignment審査のcandidateIdまたはslotIdが入力と一致しません。");
    }
    const status = ["entailed", "not_entailed", "uncertain"].includes(clean(review?.status))
      ? clean(review.status)
      : "uncertain";
    const claimIds = [...new Set((Array.isArray(review?.claimIds) ? review.claimIds : []).map(clean).filter(Boolean))];
    if (!claimIds.length || !clean(review?.reason)) {
      throw claimAlignmentReviewError("claim alignment審査の根拠claimIdまたはreasonがありません。");
    }
    byCandidate[candidate.candidateIndex].push({
      candidateId: candidate.candidateId,
      slotId: candidate.slotId,
      status,
      claimIds,
      reason: clean(review.reason)
    });
  });
  return byCandidate.map((slots) => {
    const failed = slots.some((slot) => slot.status !== "entailed");
    return {
      status: failed ? "failed" : "passed",
      slots,
      failures: failed ? ["claim_alignment_failed"] : []
    };
  });
}

function normalizeReview(value, brief, copyLocked, applicableFields) {
  const scores = {};
  for (const field of SCORE_FIELDS) {
    const rawScore = value?.scores?.[field];
    if (applicableFields.includes(field)) {
      if (!Number.isFinite(Number(rawScore)) || Number(rawScore) < 0 || Number(rawScore) > 5) {
        throw copyReviewError(`コピー理解性審査の必須スコアが不正です: ${field}`);
      }
      scores[field] = Math.round(Number(rawScore));
    } else {
      scores[field] = null;
    }
  }
  const rawScore = applicableFields.reduce((sum, field) => sum + scores[field], 0);
  const rawMaxScore = applicableFields.length * 5;
  const normalizedScore = rawMaxScore ? Math.round((rawScore / rawMaxScore) * 100) : 0;
  const failureReasons = [];
  for (const [field, floor] of Object.entries(COPY_REVIEW_POLICY.criticalFloor)) {
    if (applicableFields.includes(field) && scores[field] < floor) failureReasons.push(`${field}_below_${floor}`);
  }
  if (normalizedScore < COPY_REVIEW_POLICY.passScore) failureReasons.push(`normalized_score_below_${COPY_REVIEW_POLICY.passScore}`);
  const communicationReview = normalizeCommunicationReview(value?.communicationReview, brief);
  failureReasons.push(...communicationReview.failureReasons);
  const warnings = normalizeWarnings(value?.warnings);
  if (warnings.some((warning) => warning.severity === "critical")) failureReasons.push("critical_review_warning");
  return {
    version: COPY_REVIEW_POLICY.version,
    reviewPolicyVersion: COPY_REVIEW_POLICY.version,
    reviewerMode: COPY_REVIEW_POLICY.reviewerMode,
    status: copyLocked ? (failureReasons.length || warnings.length ? "warning" : "passed") : (failureReasons.length ? "failed" : "passed"),
    scores,
    applicableFields,
    rawScore,
    rawMaxScore,
    total: rawScore,
    normalizedScore,
    passScore: COPY_REVIEW_POLICY.passScore,
    criticalFloor: COPY_REVIEW_POLICY.criticalFloor,
    warnings,
    failureReasons: [...new Set(failureReasons)],
    communicationReview,
    rewriteCount: 0,
    rewriteAllowed: !copyLocked,
    reviewNote: clean(value?.reviewNote),
    mainHook: clean(brief?.mainHook)
  };
}

function buildVisibleCopy(brief = {}) {
  const slotTexts = (Array.isArray(brief?.slotTexts) ? brief.slotTexts : [])
    .map((slot) => ({
      slotId: clean(slot?.slotId),
      canonicalField: clean(slot?.canonicalField),
      text: clean(slot?.text)
    }))
    .filter((slot) => slot.text);
  const byId = new Map(slotTexts.map((slot) => [slot.slotId, slot.text]).filter(([slotId]) => slotId));
  const hasSemanticGroupReadout = Array.isArray(brief?.semanticGroupReadout);
  const plans = hasSemanticGroupReadout
    ? brief.semanticGroupReadout
    : (Array.isArray(brief?.authorizedClaimSet?.templateMessagePlan) ? brief.authorizedClaimSet.templateMessagePlan : []);
  const semanticGroups = plans.map((plan, index) => {
    const slotIds = [...new Set((Array.isArray(plan?.slotIds) ? plan.slotIds : []).map(clean).filter(Boolean))];
    return {
      groupId: clean(plan?.groupId) || `group-${index + 1}`,
      semanticRole: clean(plan?.semanticRole),
      slotIds,
      text: hasSemanticGroupReadout
        ? clean(plan?.visibleText)
        : slotIds.map((slotId) => byId.get(slotId)).filter(Boolean).join(" ")
    };
  }).filter((group) => group.text);
  return {
    readoutText: clean(brief?.readoutText) || slotTexts.map((slot) => slot.text).join(" / "),
    semanticGroups,
    slotTexts
  };
}

function visibleProductIdentity(product = {}) {
  const result = {};
  if (clean(product?.name)) result.name = clean(product.name);
  if (clean(product?.brandName)) result.brandName = clean(product.brandName);
  return result;
}

function applicableScoreFields(brief) {
  const fields = ["clarity", "specificity"];
  if (hasVisibleOffer(brief)) fields.push("offerFit");
  return fields;
}

function hasVisibleOffer(brief) {
  if (clean(brief?.offerBadge)) return true;
  return (Array.isArray(brief?.slotTexts) ? brief.slotTexts : []).some((slot) => (
    clean(slot?.text) && /offer|オファー|特典|無料|割引/i.test(`${slot?.canonicalField || ""} ${slot?.messageRole || ""} ${slot?.role || ""}`)
  ));
}

function normalizeCommunicationReview(value, brief) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw copyReviewError("コピー理解性審査のcommunicationReviewがありません。");
  }
  const decodedProductOrTask = requiredText(value.decodedProductOrTask, "decodedProductOrTask");
  const decodedPromise = requiredText(value.decodedPromise, "decodedPromise");
  const normalized = {
    decodedProductOrTask,
    decodedPromise,
    decodedMechanism: clean(value.decodedMechanism),
    decodedOffer: clean(value.decodedOffer),
    numberMeanings: normalizeNumberMeanings(value.numberMeanings),
    evidenceSpans: normalizeEvidenceSpans(value.evidenceSpans),
    ambiguities: normalizeWarnings(value.ambiguities)
  };
  for (const field of COMMUNICATION_BOOLEAN_FIELDS) {
    if (typeof value[field] !== "boolean") throw copyReviewError(`コピー理解性審査の必須真偽値が不正です: ${field}`);
    normalized[field] = value[field];
  }

  const visibleText = [
    clean(brief?.readoutText),
    ...(Array.isArray(brief?.slotTexts) ? brief.slotTexts.map((slot) => clean(slot?.text)) : [])
  ].filter(Boolean).join("\n");
  const failureReasons = [];
  for (const field of COMMUNICATION_BOOLEAN_FIELDS) {
    if (normalized[field] !== false) continue;
    if (field === "numberMeaningUnambiguous" && !/[0-9０-９]/.test(visibleText)) continue;
    if (field === "offerConditionUnderstood" && !hasVisibleOffer(brief)) continue;
    failureReasons.push(COMMUNICATION_FAILURES[field]);
  }
  if (!normalized.evidenceSpans.length) failureReasons.push("reader_evidence_missing");
  if (normalized.evidenceSpans.some((span) => !visibleText.includes(span.text))) {
    failureReasons.push("unsupported_reader_inference");
  }
  if (normalized.ambiguities.some((item) => item.severity === "critical")) {
    failureReasons.push("critical_misreading_risk");
  }
  return {
    ...normalized,
    readoutText: clean(brief?.readoutText),
    failureReasons: [...new Set(failureReasons)]
  };
}

function normalizeNumberMeanings(value) {
  return (Array.isArray(value) ? value : []).map((item) => ({
    value: clean(item?.value),
    meaning: clean(item?.meaning),
    evidenceSpan: clean(item?.evidenceSpan)
  })).filter((item) => item.value || item.meaning || item.evidenceSpan);
}

function normalizeEvidenceSpans(value) {
  if (!Array.isArray(value)) throw copyReviewError("コピー理解性審査のevidenceSpansがありません。");
  return value.map((item) => ({
    text: clean(item?.text),
    supports: clean(item?.supports)
  })).filter((item) => item.text);
}

function normalizeWarnings(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        return {
          code: clean(item.code) || "review_warning",
          severity: clean(item.severity).toLowerCase() === "critical" ? "critical" : "warning",
          slotId: clean(item.slotId),
          message: clean(item.message),
          rewriteInstruction: clean(item.rewriteInstruction)
        };
      }
      return { code: "review_warning", severity: "warning", slotId: "", message: clean(item), rewriteInstruction: "" };
    })
    .filter((item) => item.message || item.code !== "review_warning");
}

function heuristicReview(brief) {
  const visibleText = clean(brief?.readoutText || brief?.mainHook);
  const evidence = visibleText ? visibleText.slice(0, 40) : "";
  return {
    scores: {
      clarity: visibleText ? 4 : 0,
      specificity: visibleText.length >= 6 ? 4 : 3,
      offerFit: hasVisibleOffer(brief) ? 4 : null
    },
    communicationReview: {
      decodedProductOrTask: visibleText || "特定できない",
      decodedPromise: visibleText || "特定できない",
      decodedMechanism: "",
      decodedOffer: clean(brief?.offerBadge),
      numberMeanings: [],
      evidenceSpans: evidence ? [{ text: evidence, supports: "visible_message" }] : [],
      ambiguities: [],
      productOrTaskUnderstood: Boolean(visibleText),
      primaryPromiseUnderstood: Boolean(visibleText),
      singleMessageFocus: true,
      numberMeaningUnambiguous: true,
      offerConditionUnderstood: true,
      audienceRelevanceUnderstood: Boolean(visibleText)
    },
    warnings: []
  };
}

function requiredText(value, field) {
  const text = clean(value);
  if (!text) throw copyReviewError(`コピー理解性審査の${field}がありません。`);
  return text;
}

function copyReviewError(message) {
  const error = new Error(message);
  error.code = "COPY_REVIEW_ERROR";
  return error;
}

function claimAlignmentReviewError(message) {
  const error = new Error(message);
  error.code = "CLAIM_ALIGNMENT_REVIEW_ERROR";
  return error;
}

function clean(value) {
  return String(value ?? "").trim();
}
