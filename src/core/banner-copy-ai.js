import crypto from "node:crypto";
import { openAiJson } from "./openai-text.js";
import { loadPrompt } from "./prompt-files.js";
import { classifyExpressionRules, prepareBannerGenerationContext } from "./banner-ai.js";
import { buildInstructionPolicy } from "./banner-instruction-policy.js";
import {
  normalizeApprovedClaimSnapshot,
  validateCopyAuthorization
} from "./banner-approved-claims.js";
import { reviewCopyBriefs, reviewCopyClaimAlignment } from "./banner-copy-review.js";
import { reviewOriginality } from "./banner-originality.js";
import { buildBannerGenerationContract } from "./banner-generation-contract.js";
import {
  buildCopyReadoutText,
  evaluateMessagePlanGate,
  normalizeAuthorizedClaimSet,
  normalizeMessagePlan,
  normalizeTemplateFitDecision
} from "./banner-message-coherence.js";
import {
  CANONICAL_COPY_FIELDS,
  buildCopySlotPlan,
  copyBriefMeetsSlotRequirements,
  countCopyChars,
  findSlotLengthViolations,
  normalizeSlotTexts,
  sanitizeCopySlotPlanForPrompt,
  sanitizeTemplateCopyForPrompt,
  syncCanonicalFieldsFromSlots
} from "./banner-copy-slots.js";
import { hashCopyBrief } from "./banner-copy-hash.js";

export {
  CANONICAL_COPY_FIELDS,
  buildCopySlotPlan,
  copyBriefMeetsSlotRequirements,
  countCopyChars,
  findSlotLengthViolations
} from "./banner-copy-slots.js";
export { hashCopyBrief } from "./banner-copy-hash.js";

const DEFAULT_TEXT_MODEL = process.env.CMOAI_TEXT_MODEL || process.env.OPENAI_TEXT_MODEL || "gpt-5.5";
const BANNER_COPY_SYSTEM = loadPrompt("banner-copy");
const COMMUNICATION_FAILURE_CODES = new Set([
  "message_plan_missing",
  "product_or_task_anchor_missing",
  "one_message_missing",
  "primary_promise_missing",
  "number_context_missing",
  "number_context_incomplete",
  "product_or_task_not_understood",
  "primary_promise_not_understood",
  "single_message_focus_failed",
  "number_meaning_ambiguous",
  "offer_condition_not_understood",
  "audience_relevance_not_understood",
  "unsupported_reader_inference",
  "reader_evidence_missing",
  "critical_misreading_risk",
  "critical_review_warning",
  "semantic_group_not_understood",
  "semantic_group_readout_missing"
]);
const BLOCKING_REVIEW_FAILURE_CODES = new Set([
  "claim_alignment_failed"
]);

export async function generateBannerCopyBriefs({
  banners,
  product,
  strategy,
  expressionRules = [],
  template = null,
  categoryRelation = null,
  existingCopies = [],
  extraInstruction = "",
  copyJsonGenerator = openAiJson,
  copyReviewGenerator = undefined,
  originalityReviewer = reviewOriginality,
  claimAlignmentGenerator = undefined,
  creativeHypotheses = [],
  approvedClaimSnapshot = null,
  generationRunId: requestedGenerationRunId = "",
  candidateGroupId: requestedCandidateGroupId = "",
  candidateIndexes = []
}) {
  const targets = Array.isArray(banners) ? banners.filter(Boolean) : [];
  if (!targets.length) throw new Error("コピー開発対象のバナー案がありません。");
  const generationRunId = clean(requestedGenerationRunId) || crypto.randomUUID();
  const candidateGroupId = clean(requestedCandidateGroupId) || crypto.randomUUID();
  const hypotheses = targets.map((_, index) => creativeHypotheses[index] || null);
  const stableCandidateIndexes = targets.map((banner, index) => (
    Number.isInteger(candidateIndexes[index])
      ? candidateIndexes[index]
      : (Number.isInteger(banner?.candidateIndex) ? banner.candidateIndex : index)
  ));
  const snapshot = approvedClaimSnapshot ? normalizeApprovedClaimSnapshot(approvedClaimSnapshot) : null;
  const usesWinningDesignContracts = Boolean(snapshot?.snapshotId && hypotheses.every((item) => item?.hypothesisId));

  const generationContext = prepareBannerGenerationContext(product, strategy);
  const instructionPolicy = buildInstructionPolicy(extraInstruction);
  const copyLocked = instructionPolicy.protectedFields.includes("copyBrief");
  const rules = classifyExpressionRules(expressionRules, generationContext.product, instructionPolicy);
  const copySlotPlan = buildCopySlotPlan(template);
  const relation = normalizeRelationForCopy(categoryRelation);
  const generationContracts = targets.map((banner, index) => buildBannerGenerationContract({
    banner,
    product: generationContext.product,
    strategy: generationContext.strategy,
    template,
    categoryRelation: relation,
    instructionPolicy,
    expressionRules: rules.specifiedRules,
    approvedClaimSnapshot: usesWinningDesignContracts ? snapshot : null,
    creativeHypothesis: usesWinningDesignContracts ? hypotheses[index] : null
  }));
  const baseInput = {
    banners: targets,
    product: generationContext.product,
    strategy: generationContext.strategy,
    expressionRules: rules.specifiedRules.slice(0, 40),
    templateCopy: buildTemplateCopyInput(template, relation),
    copySlotPlan: sanitizeCopySlotPlanForPrompt(copySlotPlan),
    categoryRelation: relation,
    existingCopies: normalizeExistingCopies(existingCopies).slice(0, 20),
    extraInstruction,
    instructionPolicy,
    generationContract: generationContracts[0],
    generationContracts,
    creativeHypotheses: usesWinningDesignContracts ? hypotheses : [],
    approvedClaimSnapshot: usesWinningDesignContracts ? snapshot : null,
    count: targets.length
  };

  const first = await requestCopyBriefs(baseInput, copyJsonGenerator);
  let briefs = normalizeCopyBriefs(first, {
    count: targets.length,
    strategyId: generationContext.strategy.id || targets[0]?.strategyId || "",
    model: DEFAULT_TEXT_MODEL,
    copySlotPlan,
    instructionPolicy,
    creativeHypotheses: usesWinningDesignContracts ? hypotheses : [],
    approvedClaimSnapshot: usesWinningDesignContracts ? snapshot : null
  }).map((brief, index) => attachCandidateMetadata(brief, { generationRunId, candidateGroupId, candidateIndex: stableCandidateIndexes[index] }));

  const missingIndexes = invalidBriefIndexes(briefs, targets.length, copySlotPlan);
  if (missingIndexes.length) {
    const retry = await requestCopyBriefs({
      ...baseInput,
      count: missingIndexes.length,
      retryInstruction: [
        "前回出力は件数不足または必須フィールド不足でした。",
        "appealAxis, whyItStops と、コピー枠プランにある全slotTexts.textが空でない案を再生成してください。",
        "mainHook/CTAスロットがないテンプレではmainHook/ctaは空で構いません。スロットにないcanonicalFieldは空文字にしてください。",
        "返すbriefsの件数は retryCount と一致させてください。"
      ].join("\n"),
      retryCount: missingIndexes.length,
      previousBriefs: briefs,
      banners: missingIndexes.map((index) => targets[index]),
      creativeHypotheses: usesWinningDesignContracts ? missingIndexes.map((index) => hypotheses[index]) : []
    }, copyJsonGenerator);
    const retryBriefs = normalizeCopyBriefs(retry, {
      count: missingIndexes.length,
      strategyId: generationContext.strategy.id || targets[0]?.strategyId || "",
      model: DEFAULT_TEXT_MODEL,
      copySlotPlan,
      instructionPolicy,
      creativeHypotheses: usesWinningDesignContracts ? missingIndexes.map((index) => hypotheses[index]) : [],
      approvedClaimSnapshot: usesWinningDesignContracts ? snapshot : null
    });
    for (let index = 0; index < missingIndexes.length; index += 1) {
      const candidateIndex = missingIndexes[index];
      briefs[candidateIndex] = attachCandidateMetadata(retryBriefs[index], { generationRunId, candidateGroupId, candidateIndex: stableCandidateIndexes[candidateIndex] });
    }
  }

  const lengthIssueIndexes = invalidLengthBriefIndexes(briefs, copySlotPlan);
  if (lengthIssueIndexes.length) {
    const retry = await requestCopyBriefs({
      ...baseInput,
      count: lengthIssueIndexes.length,
      retryInstruction: [
        "前回出力はコピー枠の文字数上限を超えたslotTextsがありました。",
        "該当案だけ、slotTextsの各textを、charBudgetが10字以下なら13字以内、11字以上ならcharBudgetの120%以内（小数点以下切り捨て）へ収めて再生成してください。文字数の下限は設けません。",
        "コード側で短縮・補完はしません。訴求を削るのではなく、各スロットの役割を再設計して収めてください。",
        "逸脱一覧:",
        JSON.stringify(lengthIssueIndexes.map((briefIndex) => ({
          briefIndex: briefIndex + 1,
          violations: findSlotLengthViolations(briefs[briefIndex], copySlotPlan).map((slot) => ({
            slotId: slot.slotId,
            role: slot.role,
            canonicalField: slot.canonicalField,
            text: slot.text,
            actualChars: slot.charCount,
            charBudget: slot.charBudget,
            maxChars: slot.maxChars,
            allowed: `最大${slot.maxChars}字`
          }))
        })), null, 2),
        "返すbriefsの件数は retryCount と一致させてください。"
      ].join("\n"),
      retryCount: lengthIssueIndexes.length,
      previousBriefs: briefs,
      banners: lengthIssueIndexes.map((index) => targets[index]),
      creativeHypotheses: usesWinningDesignContracts ? lengthIssueIndexes.map((index) => hypotheses[index]) : []
    }, copyJsonGenerator);
    const retryBriefs = normalizeCopyBriefs(retry, {
      count: lengthIssueIndexes.length,
      strategyId: generationContext.strategy.id || targets[0]?.strategyId || "",
      model: DEFAULT_TEXT_MODEL,
      copySlotPlan,
      instructionPolicy,
      creativeHypotheses: usesWinningDesignContracts ? lengthIssueIndexes.map((index) => hypotheses[index]) : [],
      approvedClaimSnapshot: usesWinningDesignContracts ? snapshot : null
    });
    for (let index = 0; index < lengthIssueIndexes.length; index += 1) {
      const candidateIndex = lengthIssueIndexes[index];
      briefs[candidateIndex] = attachCandidateMetadata(retryBriefs[index], { generationRunId, candidateGroupId, candidateIndex: stableCandidateIndexes[candidateIndex] });
    }
  }

  const reviewGenerator = copyReviewGenerator === undefined
    ? (copyJsonGenerator === openAiJson ? openAiJson : null)
    : copyReviewGenerator;
  const alignmentReviewGenerator = claimAlignmentGenerator === undefined
    ? (copyJsonGenerator === openAiJson ? openAiJson : null)
    : claimAlignmentGenerator;
  const reviewHistory = targets.map(() => []);
  const attemptOne = await assessCandidates({
    briefs,
    indexes: targets.map((_, index) => index),
    targets,
    strategy: generationContext.strategy,
    product: generationContext.product,
    template,
    relation,
    existingCopies,
    reviewGenerator,
    claimAlignmentGenerator: alignmentReviewGenerator,
    originalityReviewer,
    copySlotPlan,
    generationContracts,
    copyLocked,
    instructionPolicy,
    approvedClaimSnapshot: usesWinningDesignContracts ? snapshot : null,
    attempt: 1
  });
  for (const result of attemptOne) reviewHistory[result.index].push(result.history);
  const rewriteIndexes = attemptOne.filter((result) => result.decision === "rewrite").map((result) => result.index);
  let finalAssessments = new Map(attemptOne.map((result) => [result.index, result]));

  if (rewriteIndexes.length) {
    const retry = await requestCopyBriefs({
      ...baseInput,
      count: rewriteIndexes.length,
      retryCount: rewriteIndexes.length,
      retryInstruction: [
        "ハードゲートまたは品質審査で不合格になりました。見出しだけでなく完成コピーセット全体を書き直してください。",
        "テンプレートHOWは維持し、出典トレースを含む全slotTextsを返してください。",
        "不合格詳細:",
        JSON.stringify(rewriteIndexes.map((index) => ({
          briefIndex: index + 1,
          hardGate: finalAssessments.get(index)?.hardGate,
          copyQualityReview: finalAssessments.get(index)?.copyBrief?.copyQualityReview,
          originalityReview: finalAssessments.get(index)?.copyBrief?.originalityReview
        })), null, 2),
        "返すbriefsの件数は retryCount と一致させてください。"
      ].join("\n"),
      previousBriefs: briefs,
      banners: rewriteIndexes.map((index) => targets[index]),
      creativeHypotheses: usesWinningDesignContracts ? rewriteIndexes.map((index) => hypotheses[index]) : []
    }, copyJsonGenerator);
    const retryBriefs = normalizeCopyBriefs(retry, {
      count: rewriteIndexes.length,
      strategyId: generationContext.strategy.id || targets[0]?.strategyId || "",
      model: DEFAULT_TEXT_MODEL,
      copySlotPlan,
      instructionPolicy,
      creativeHypotheses: usesWinningDesignContracts ? rewriteIndexes.map((index) => hypotheses[index]) : [],
      approvedClaimSnapshot: usesWinningDesignContracts ? snapshot : null
    });
    for (let index = 0; index < rewriteIndexes.length; index += 1) {
      const candidateIndex = rewriteIndexes[index];
      briefs[candidateIndex] = attachCandidateMetadata(retryBriefs[index], { generationRunId, candidateGroupId, candidateIndex: stableCandidateIndexes[candidateIndex] });
    }
    const attemptTwo = await assessCandidates({
      briefs,
      indexes: rewriteIndexes,
      targets,
      strategy: generationContext.strategy,
      product: generationContext.product,
      template,
      relation,
      existingCopies,
      reviewGenerator,
      claimAlignmentGenerator: alignmentReviewGenerator,
      originalityReviewer,
      copySlotPlan,
      generationContracts,
      copyLocked,
      instructionPolicy,
      approvedClaimSnapshot: usesWinningDesignContracts ? snapshot : null,
      attempt: 2
    });
    for (const result of attemptTwo) {
      reviewHistory[result.index].push(result.history);
      finalAssessments.set(result.index, result);
    }
  }

  return {
    results: targets.map((banner, index) => {
      const assessment = finalAssessments.get(index) || failedAssessment(index, briefs[index], "COPY_REVIEW_ERROR", "コピー審査結果を取得できませんでした。", 1);
      const accepted = ["passed", "warning"].includes(assessment.decision);
      return {
        bannerId: String(banner?.id || ""),
        status: accepted ? assessment.decision : productionStatusForError(assessment.error?.code),
        generationRunId,
        candidateGroupId,
        candidateIndex: stableCandidateIndexes[index],
        ...(accepted ? { copyBrief: assessment.copyBrief } : {}),
        reviewHistory: reviewHistory[index],
        categoryRelation: relation,
        bannerGenerationContract: generationContracts[index],
        ...(accepted ? {} : { error: assessment.error })
      };
    })
  };
}

async function assessCandidates({
  briefs,
  indexes,
  targets,
  strategy,
  product,
  template,
  relation,
  existingCopies,
  reviewGenerator,
  claimAlignmentGenerator,
  originalityReviewer,
  copySlotPlan,
  generationContracts,
  copyLocked,
  instructionPolicy,
  approvedClaimSnapshot,
  attempt
}) {
  const structural = [];
  const reviewableIndexes = [];
  for (const index of indexes) {
    const brief = briefs[index];
    const hardGate = evaluateBannerCopyHardGate({
      brief,
      copySlotPlan,
      generationContract: generationContracts[index] || generationContracts[0],
      copyLocked
    });
    if (hardGate.status === "failed") {
      const code = hardGate.failures.includes("template_message_fit_failed")
        ? "TEMPLATE_MESSAGE_FIT_FAILED"
        : (hardGate.failures.some((failure) => COMMUNICATION_FAILURE_CODES.has(failure)) ? "COPY_COMMUNICATION_FAILED" : "COPY_HARD_GATE_FAILED");
      structural.push(failedAssessment(index, brief, code, hardGate.failures.join(" / "), attempt, hardGate, targets[index]));
    } else {
      reviewableIndexes.push(index);
    }
  }
  if (!reviewableIndexes.length) return structural.sort((left, right) => left.index - right.index);

  const reviewableBriefs = reviewableIndexes.map((index) => briefs[index]);
  let reviewed;
  try {
    reviewed = await runCopyReviewsWithFormatRetry({
      briefs: reviewableBriefs,
      strategy,
      product,
      template,
      relation,
      existingCopies: [
        ...existingCopies,
        ...briefs
          .filter((_, index) => !reviewableIndexes.includes(index))
          .map((copyBrief) => ({ copyBrief }))
      ],
      reviewGenerator,
      claimAlignmentGenerator,
      originalityReviewer,
      copyLocked,
      instructionPolicy,
      creativeHypotheses: reviewableIndexes.map((index) => generationContracts[index]?.creativeHypothesis || {}),
      approvedClaimSnapshot,
      rewriteCount: attempt - 1
    });
  } catch (error) {
    const message = error?.message || "コピー品質審査の形式エラーです。";
    return [
      ...structural,
      ...reviewableIndexes.map((index) => failedAssessment(index, briefs[index], "COPY_REVIEW_ERROR", message, attempt, null, targets[index]))
    ].sort((left, right) => left.index - right.index);
  }

  const assessed = reviewed.map((copyBrief, localIndex) => {
    const index = reviewableIndexes[localIndex];
    const baseHardGate = evaluateBannerCopyHardGate({
      brief: copyBrief,
      copySlotPlan,
      generationContract: generationContracts[index] || generationContracts[0],
      copyLocked
    });
    const originalityFailed = copyBrief.originalityReview?.status === "failed";
    const hardGate = {
      ...baseHardGate,
      status: baseHardGate.status === "failed" || originalityFailed
        ? "failed"
        : (baseHardGate.status === "warning" ? "warning" : "passed"),
      originality: copyBrief.originalityReview,
      failures: [
        ...baseHardGate.failures,
        ...(originalityFailed ? copyBrief.originalityReview.failures || ["originality_failed"] : [])
      ]
    };
    const qualityFailed = copyBrief.copyQualityReview?.status === "failed";
    const qualityFailureReasons = copyBrief.copyQualityReview?.failureReasons || [];
    const blockingReviewFailed = qualityFailureReasons.some((code) => BLOCKING_REVIEW_FAILURE_CODES.has(code));
    const canContinueWithWarning = attempt >= 2
      && hardGate.status !== "failed"
      && !originalityFailed
      && qualityFailed
      && !blockingReviewFailed;
    const decision = hardGate.status !== "failed" && !qualityFailed
      ? "passed"
      : (canContinueWithWarning ? "warning" : (attempt < 2 ? "rewrite" : "failed"));
    const assessedBrief = canContinueWithWarning ? continueCopyBriefAfterReview(copyBrief) : copyBrief;
    const communicationFailed = qualityFailureReasons.some((code) => COMMUNICATION_FAILURE_CODES.has(code));
    const errorCode = canContinueWithWarning ? "" : (hardGate.status === "failed"
      ? (hardGate.failures.includes("template_message_fit_failed")
        ? "TEMPLATE_MESSAGE_FIT_FAILED"
        : (hardGate.failures.some((failure) => COMMUNICATION_FAILURE_CODES.has(failure)) ? "COPY_COMMUNICATION_FAILED" : "COPY_HARD_GATE_FAILED"))
      : (qualityFailed ? (communicationFailed ? "COPY_COMMUNICATION_FAILED" : "COPY_SCORE_BELOW_THRESHOLD") : ""));
    const message = [...hardGate.failures, ...(copyBrief.copyQualityReview?.failureReasons || [])].join(" / ");
    return {
      index,
      copyBrief: assessedBrief,
      hardGate,
      decision,
      ...(errorCode ? { error: { code: errorCode, message: message || "コピー品質基準を満たしませんでした。" } } : {}),
      history: buildReviewHistory(targets[index], attempt, assessedBrief, hardGate, decision)
    };
  });
  return [...structural, ...assessed].sort((left, right) => left.index - right.index);
}

export function evaluateBannerCopyHardGate({ brief, copySlotPlan, generationContract, copyLocked = false } = {}) {
  const missingRequired = !copyBriefMeetsSlotRequirements(brief, copySlotPlan);
  const lengthViolations = findSlotLengthViolations(brief, copySlotPlan);
  const sourceTrace = Number(brief?.version) >= 4
    ? validateCopyAuthorization({
        copyBrief: brief,
        creativeHypothesis: generationContract?.creativeHypothesis || {},
        approvedClaimSnapshot: generationContract?.approvedClaimSnapshot || {}
      })
    : { status: "passed", violations: [] };
  const messagePlanGate = evaluateMessagePlanGate({ brief, copyLocked });
  const detectedIssues = [
    ...(missingRequired ? ["required_copy_missing"] : []),
    ...(lengthViolations.length ? ["copy_length_exceeded"] : []),
    ...sourceTrace.violations.map((item) => item.code),
    ...messagePlanGate.failures
  ];
  const failures = copyLocked ? [] : detectedIssues;
  const warnings = copyLocked ? [...detectedIssues, ...messagePlanGate.warnings] : messagePlanGate.warnings;
  return {
    status: failures.length ? "failed" : (warnings.length ? "warning" : "passed"),
    missingRequired,
    lengthViolations,
    sourceTrace,
    messagePlanGate,
    failures,
    warnings: [...new Set(warnings)]
  };
}

async function runCopyReviewsWithFormatRetry(options) {
  try {
    return await runCopyReviews(options);
  } catch (error) {
    if (!["COPY_REVIEW_ERROR", "CLAIM_ALIGNMENT_REVIEW_ERROR"].includes(error?.code)) throw error;
    return runCopyReviews(options);
  }
}

function failedAssessment(index, copyBrief, code, message, attempt, hardGate = null, banner = null) {
  const decision = attempt < 2 && code !== "COPY_REVIEW_ERROR" ? "rewrite" : "failed";
  const gate = hardGate || { status: "error", failures: [] };
  return {
    index,
    copyBrief,
    hardGate: gate,
    decision,
    error: { code, message },
    history: buildReviewHistory(banner || { id: "" }, attempt, copyBrief, gate, decision, code)
  };
}

function continueCopyBriefAfterReview(copyBrief) {
  return {
    ...copyBrief,
    copyQualityReview: {
      ...(copyBrief?.copyQualityReview || {}),
      status: "warning",
      rewriteAllowed: false,
      continuedAfterReview: true
    }
  };
}

function buildReviewHistory(banner, attempt, copyBrief, hardGate, decision, errorCode = "") {
  return {
    candidateId: String(banner?.id || ""),
    generationRunId: String(copyBrief?.generationRunId || ""),
    candidateGroupId: String(copyBrief?.candidateGroupId || ""),
    candidateIndex: Number.isInteger(copyBrief?.candidateIndex) ? copyBrief.candidateIndex : null,
    attempt,
    copyBrief: copyBrief || null,
    hardGate,
    qualityReview: copyBrief?.copyQualityReview || null,
    communicationReview: copyBrief?.copyQualityReview?.communicationReview || null,
    originalityReview: copyBrief?.originalityReview || null,
    decision,
    ...(errorCode ? { errorCode } : {}),
    reviewedAt: new Date().toISOString()
  };
}

function productionStatusForError(code) {
  if (code === "COPY_REVIEW_ERROR") return "copy_review_error";
  if (code === "COPY_COMMUNICATION_FAILED") return "copy_communication_failed";
  if (code === "TEMPLATE_MESSAGE_FIT_FAILED") return "template_message_fit_failed";
  if (code === "TEMPLATE_NOT_READY") return "template_not_ready";
  if (code === "STRATEGY_INPUT_INSUFFICIENT") return "strategy_input_insufficient";
  return "copy_review_failed";
}

async function runCopyReviews({
  briefs,
  strategy,
  product,
  template,
  relation,
  existingCopies,
  reviewGenerator,
  claimAlignmentGenerator,
  originalityReviewer,
  copyLocked = false,
  instructionPolicy = {},
  creativeHypotheses = [],
  approvedClaimSnapshot = null,
  rewriteCount = 0
}) {
  const [qualityReviews, alignmentReviews] = await Promise.all([
    reviewCopyBriefs({
      briefs,
      product,
      creativeHypotheses,
      copyLocked,
      reviewGenerator
    }),
    approvedClaimSnapshot
      ? reviewCopyClaimAlignment({
          briefs,
          approvedClaimSnapshot,
          reviewGenerator: claimAlignmentGenerator
        })
      : Promise.resolve(briefs.map(() => ({ status: "passed", slots: [], failures: [] })))
  ]);
  return briefs.map((brief, index) => {
    const siblings = [
      ...(Array.isArray(existingCopies) ? existingCopies : []),
      ...briefs
        .map((copyBrief, siblingIndex) => ({ copyBrief, creativeHypothesis: creativeHypotheses[siblingIndex] || null }))
        .filter((_, siblingIndex) => siblingIndex !== index)
    ];
    const originalityReview = originalityReviewer({
      brief,
      template,
      siblings,
      relation,
      copyLocked,
      instructionPolicy,
      candidateGroupId: brief?.candidateGroupId,
      creativeHypothesis: creativeHypotheses[index] || null,
      approvedClaimSnapshot,
      excludedTerms: [product?.name, product?.brandName, product?.companyName].filter(Boolean)
    });
    return {
      ...brief,
      copyQualityReview: {
        ...qualityReviews[index],
        status: qualityReviews[index]?.status === "failed" || alignmentReviews[index]?.status === "failed"
          ? (copyLocked ? "warning" : "failed")
          : qualityReviews[index]?.status,
        failureReasons: [
          ...(qualityReviews[index]?.failureReasons || []),
          ...(alignmentReviews[index]?.failures || [])
        ],
        claimAlignmentReview: alignmentReviews[index],
        rewriteCount
      },
      originalityReview
    };
  });
}

async function requestCopyBriefs(input, copyJsonGenerator = openAiJson) {
  return copyJsonGenerator({
    system: BANNER_COPY_SYSTEM,
    user: buildBannerCopyPrompt(input)
  });
}

export function buildBannerCopyPrompt(input) {
  return [
    input.retryInstruction ? "# リトライ指示\n" + input.retryInstruction : "",
    "# 生成案数",
    String(input.retryCount || input.count || 1),
    "",
    "# バナー行",
    JSON.stringify((input.banners || []).map((banner) => ({
      id: banner.id || "",
      productId: banner.productId || "",
      strategyId: banner.strategyId || "",
      variationAxis: banner.variationAxis || "",
      additionalInstruction: banner.additionalInstruction || ""
    })), null, 2),
    "",
    input.extraInstruction ? "# 追加指示（最優先）\n" + input.extraInstruction : "# 追加指示（最優先）\nなし",
    input.instructionPolicy ? "# 追加指示ポリシー\n" + JSON.stringify(input.instructionPolicy, null, 2) : "",
    input.creativeHypotheses?.length ? "# CreativeHypothesisContract（確定済み正本）\n" + JSON.stringify(input.creativeHypotheses, null, 2) : "",
    input.approvedClaimSnapshot ? "# ApprovedClaimSnapshot（使用可能なclaimIdの正本）\n" + JSON.stringify(input.approvedClaimSnapshot, null, 2) : "",
    "",
    "# テンプレート構造と伝達グループ",
    JSON.stringify(sanitizeCopySlotPlanForPrompt(input.copySlotPlan || buildCopySlotPlan(null)), null, 2),
    "",
    "# 商品マスター",
    JSON.stringify(input.product || {}, null, 2),
    "",
    "# 選択WHO-WHAT（この範囲だけを訴求する）",
    JSON.stringify(input.strategy || {}, null, 2),
    "",
    "# 表現レギュレーション",
    JSON.stringify(input.expressionRules || [], null, 2),
    "",
    "# テンプレコピー枠構造",
    JSON.stringify(sanitizeTemplateCopyForPrompt(input.templateCopy), null, 2),
    "",
    "# カテゴリ距離と再利用方法",
    JSON.stringify(input.categoryRelation || normalizeRelationForCopy(null), null, 2),
    "",
    "# 既出コピー（重複回避）",
    JSON.stringify(input.existingCopies || [], null, 2),
    "",
    input.generationContract ? "# BannerGenerationContract（WHAT/HOW/追加指示の共通契約）\n" + JSON.stringify(sanitizeGenerationContractForCopyPrompt(input.generationContract), null, 2) : "",
    input.previousBriefs ? "# 前回出力\n" + JSON.stringify(input.previousBriefs, null, 2) : "",
    "",
    "# 厳守",
    "briefs の件数は指定案数と一致させる。",
    "選択WHO-WHAT外の機能・用途・戦略を混入させない。",
    "追加指示原文は表現レギュレーションより優先する。追加指示を固定モード名へ置換せず、protectedFieldsを維持しながら原文の意味を反映する。",
    "categoryRelation.reuseMethod にかかわらず、テンプレートから使うのはslotId・role・messageRole・charBudgetだけとする。元広告の文言・語順・表層構文・心理メカニズム・コピーpattern・募集や限定などの意味を新しいコピーへ持ち込まない。",
    "CreativeHypothesisContractは確定済み正本であり、対象、切り口、primaryPromise、templateMechanismを変更しない。",
    "ApprovedClaimSnapshot外の数字、価格、期間、実績、比較、保証、オファーを作らず、claimIdを発明しない。",
    "各slotTextsへ対応するhypothesisIdを付ける。CTA、純粋な注記、ブランド表示、純装飾以外の主張slotには1件以上のclaimIdsを付ける。",
    "semanticGroupPlanのgroupId、slotIds、readingOrderを維持し、各groupの実際の連結表示をsemanticGroupReadoutとして返す。",
    "兄弟案の差分はvariationPolicy.changedDimensionsだけに限定し、preservedDimensionsを変えない。",
    "数字を使う場合はmessagePlan.numbersへvalue・meaning・owner・polarity・minimumContextを記録し、数字単独で料金・期間・実績の対象を誤読させない。",
    "templateFitDecisionはfit/adapt/rejectのいずれかを返す。レイアウトHOWを維持したままoneMessageを伝えられない場合はrejectにし、意味を分断して無理に埋めない。",
    "slotTexts を単一の正として返す。各slotTextsはコピー枠プランのslotIdと対応させ、textはcharBudgetが10字以下なら13字以内、11字以上ならcharBudgetの120%以内（小数点以下切り捨て）に収める。文字数の下限は設けない。短くても意味が明確なら無理に基準へ近づけない。",
    "コピー枠プランに存在しないmainHook/subHook/proof/offerBadge/cta/disclaimerは空文字にする。",
    "logo/brand枠はcopySlotPlanに含まれないため、コピーとして生成しない。",
    "proof は選択WHO-WHATに明記されたproof・実績・理由だけで書く。対応情報がない任意proof枠は空文字にする。",
    "緊急性・限定性は選択WHO-WHATのオファーに期限・数量・特典が明記されている場合だけ使う。記載がなければ創作しない。",
    "コード側でコピーは補完しない。required=trueの必須フィールドは空にせず、required=falseかつ対応情報がない枠は埋め草を作らず空文字にする。",
    "広告成果の予測値や検証指標フィールドを出力しない。"
  ].filter(Boolean).join("\n");
}

function sanitizeGenerationContractForCopyPrompt(contract) {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) return {};
  const {
    approvedClaimSnapshot: _approvedClaimSnapshot,
    creativeHypothesis: _creativeHypothesis,
    strategyWhat: _strategyWhat,
    templateHow: _templateHow,
    instructionPolicy: _instructionPolicy,
    constraints,
    ...contractSummary
  } = contract;
  const {
    expressionRules: _expressionRules,
    ...constraintSummary
  } = constraints && typeof constraints === "object" && !Array.isArray(constraints)
    ? constraints
    : {};
  return {
    ...contractSummary,
    constraints: constraintSummary
  };
}

export function normalizeCopyBriefs(parsed, {
  count,
  strategyId,
  model,
  generatedAt = new Date().toISOString(),
  copySlotPlan = null,
  instructionPolicy = {},
  creativeHypotheses = [],
  approvedClaimSnapshot = null
} = {}) {
  const rawBriefs = Array.isArray(parsed?.briefs) ? parsed.briefs : [];
  return rawBriefs.slice(0, count).map((brief, index) => normalizeCopyBrief(brief, {
    strategyId,
    model,
    generatedAt,
    copySlotPlan,
    instructionPolicy,
    creativeHypothesis: creativeHypotheses[index] || null,
    approvedClaimSnapshot
  }));
}

function normalizeCopyBrief(brief, {
  strategyId,
  model,
  generatedAt,
  copySlotPlan,
  instructionPolicy,
  creativeHypothesis,
  approvedClaimSnapshot
}) {
  const source = brief && typeof brief === "object" && !Array.isArray(brief) ? brief : {};
  const slotTexts = normalizeBriefSlotTexts(source, copySlotPlan);
  const canonicalFromSlots = slotTexts.length ? syncCanonicalFieldsFromSlots(slotTexts) : {};
  const canonical = slotTexts.length
    ? canonicalFromSlots
    : Object.fromEntries(CANONICAL_COPY_FIELDS.map((field) => [field, clean(source[field])]));
  const hasMessagePlan = source.messagePlan && typeof source.messagePlan === "object" && !Array.isArray(source.messagePlan);
  if (creativeHypothesis?.hypothesisId && approvedClaimSnapshot?.snapshotId) {
    const normalizedSlots = slotTexts.map((slot) => {
      const { strategySource: _strategySource, authorizedClaimId: _authorizedClaimId, ...rest } = slot;
      return {
        ...rest,
        hypothesisId: clean(creativeHypothesis.hypothesisId),
        claimIds: [...new Set((slot.claimIds || []).map(clean).filter(Boolean))]
      };
    });
    const normalized = {
      version: 4,
      strategyId: clean(source.strategyId || strategyId),
      hypothesisId: clean(creativeHypothesis.hypothesisId),
      hypothesisHash: clean(creativeHypothesis.contentHash),
      approvedClaimSnapshotId: clean(approvedClaimSnapshot.snapshotId),
      approvedClaimSnapshotHash: clean(approvedClaimSnapshot.contentHash),
      generatedAt,
      model: clean(source.model || model || DEFAULT_TEXT_MODEL),
      appealAxis: clean(source.appealAxis || creativeHypothesis.chosenAngle),
      targetMoment: clean(creativeHypothesis.targetMoment),
      mainHook: canonical.mainHook || "",
      subHook: canonical.subHook || "",
      proof: canonical.proof || "",
      offerBadge: canonical.offerBadge || "",
      cta: canonical.cta || "",
      disclaimer: canonical.disclaimer || "",
      slotTexts: normalizedSlots,
      ...(hasMessagePlan ? { messagePlan: normalizeMessagePlan(source.messagePlan) } : {}),
      templateFitDecision: normalizeTemplateFitDecision(creativeHypothesis.templateFitDecision),
      templateUseNote: clean(source.templateUseNote),
      whyItStops: clean(source.whyItStops),
      rejectedAlternatives: normalizeRejectedAlternatives(source.rejectedAlternatives)
    };
    normalized.semanticGroupReadout = buildSemanticGroupReadout(
      creativeHypothesis.semanticGroupPlan,
      normalized.slotTexts
    );
    normalized.readoutText = buildCopyReadoutText(normalized, copySlotPlan);
    normalized.copyBriefHash = hashCopyBrief(normalized);
    return normalized;
  }
  const hasAuthorizedClaimSet = source.authorizedClaimSet && typeof source.authorizedClaimSet === "object" && !Array.isArray(source.authorizedClaimSet);
  const authorizedClaimSet = hasAuthorizedClaimSet ? normalizeAuthorizedClaimSet(source.authorizedClaimSet) : null;
  if (authorizedClaimSet && (instructionPolicy?.allowSiblingSimilarity === true || instructionPolicy?.protectedFields?.includes("copyBrief"))) {
    authorizedClaimSet.additionalInstructionIntent.allowSiblingSimilarity = true;
  }
  const hasTemplateFitDecision = source.templateFitDecision && typeof source.templateFitDecision === "object" && !Array.isArray(source.templateFitDecision);
  const normalized = {
    version: 3,
    strategyId: String(source.strategyId || strategyId || "").trim(),
    generatedAt,
    model: String(source.model || model || DEFAULT_TEXT_MODEL).trim(),
    appealAxis: clean(source.appealAxis),
    targetMoment: clean(source.targetMoment),
    mainHook: canonical.mainHook || "",
    subHook: canonical.subHook || "",
    proof: canonical.proof || "",
    offerBadge: canonical.offerBadge || "",
    cta: canonical.cta || "",
    disclaimer: canonical.disclaimer || "",
    ...(slotTexts.length ? { slotTexts } : {}),
    ...(authorizedClaimSet ? { authorizedClaimSet } : {}),
    ...(hasMessagePlan ? { messagePlan: normalizeMessagePlan(source.messagePlan) } : {}),
    ...(hasTemplateFitDecision ? { templateFitDecision: normalizeTemplateFitDecision(source.templateFitDecision) } : {}),
    templateUseNote: clean(source.templateUseNote),
    whyItStops: clean(source.whyItStops),
    rejectedAlternatives: normalizeRejectedAlternatives(source.rejectedAlternatives)
  };
  return {
    ...normalized,
    readoutText: buildCopyReadoutText(normalized, copySlotPlan)
  };
}

export function buildSemanticGroupReadout(semanticGroupPlan, slotTexts) {
  const textBySlotId = new Map((Array.isArray(slotTexts) ? slotTexts : [])
    .map((slot) => [clean(slot?.slotId), clean(slot?.text)])
    .filter(([slotId]) => slotId));
  return (Array.isArray(semanticGroupPlan) ? semanticGroupPlan : []).map((group) => {
    const slotIds = [...new Set((Array.isArray(group?.slotIds) ? group.slotIds : []).map(clean).filter(Boolean))];
    return {
      groupId: clean(group?.groupId),
      slotIds,
      visibleText: slotIds.map((slotId) => textBySlotId.get(slotId)).filter(Boolean).join(" "),
      expectedMessage: clean(group?.intendedMessage)
    };
  });
}

function attachCandidateMetadata(brief, { generationRunId, candidateGroupId, candidateIndex }) {
  if (!brief || typeof brief !== "object") return brief;
  return { ...brief, generationRunId, candidateGroupId, candidateIndex };
}

function normalizeBriefSlotTexts(source, copySlotPlan) {
  const slots = Array.isArray(copySlotPlan?.slots) ? copySlotPlan.slots : [];
  if (Array.isArray(source.slotTexts)) return normalizeSlotTexts(source.slotTexts, copySlotPlan);
  if (!slots.length) return [];
  const canonicalSources = Object.fromEntries(CANONICAL_COPY_FIELDS.map((field) => [field, clean(source[field])]));
  return normalizeSlotTexts(slots.map((slot) => ({
    slotId: slot.slotId,
    text: slot.canonicalField ? canonicalSources[slot.canonicalField] || "" : "",
    charBudget: slot.charBudget
  })), copySlotPlan);
}

function invalidBriefIndexes(briefs, expectedCount, copySlotPlan = null) {
  const invalid = [];
  for (let index = 0; index < expectedCount; index += 1) {
    const brief = briefs[index];
    if (!copyBriefMeetsSlotRequirements(brief, copySlotPlan)) invalid.push(index);
  }
  return invalid;
}

function invalidLengthBriefIndexes(briefs, copySlotPlan = null) {
  const slots = Array.isArray(copySlotPlan?.slots) ? copySlotPlan.slots : [];
  if (!slots.length) return [];
  const invalid = [];
  for (let index = 0; index < briefs.length; index += 1) {
    if (findSlotLengthViolations(briefs[index], copySlotPlan).length) invalid.push(index);
  }
  return invalid;
}

export function buildTemplateCopyInput(template, relation = null) {
  if (!template || typeof template !== "object") return null;
  const normalizedRelation = normalizeRelationForCopy(relation);
  const blueprint = template.copyBlueprint || template.templatePromptJson?.copyBlueprint || {};
  const slots = (Array.isArray(blueprint.slots) ? blueprint.slots : []).map((slot) => ({
    slotId: String(slot?.slotId || ""),
    role: String(slot?.role || ""),
    messageRole: String(slot?.messageRole || ""),
    charBudget: Number(slot?.charBudget) || 0
  }));
  return {
    id: template.id || "",
    reuseMethod: normalizedRelation.reuseMethod,
    slots
  };
}

function normalizeRelationForCopy(value) {
  const far = value?.value === "far" || value?.reuseMethod === "pattern_fill";
  return {
    value: far ? "far" : "near",
    confidence: Number(value?.confidence) || 0,
    reason: String(value?.reason || ""),
    signals: Array.isArray(value?.signals) ? value.signals : [],
    reuseMethod: far ? "pattern_fill" : "mechanism_only"
  };
}

function normalizeExistingCopies(copies) {
  return (Array.isArray(copies) ? copies : [])
    .map((item) => {
      const brief = item?.copyBrief && typeof item.copyBrief === "object" ? item.copyBrief : {};
      const lines = [
        ...(Array.isArray(brief.slotTexts) ? brief.slotTexts.map((slot) => slot.text) : []),
        brief.mainHook,
        brief.subHook,
        brief.proof,
        brief.offerBadge,
        brief.cta,
        item?.imageText
      ].map(clean).filter(Boolean);
      return {
        id: item?.id || "",
        title: item?.title || "",
        appealAxis: brief.appealAxis || item?.variationAxis || "",
        imageText: clip([...new Set(lines)].join("\n"), 700)
      };
    })
    .filter((item) => item.imageText);
}

function normalizeRejectedAlternatives(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => ({
      text: clean(item?.text || item),
      reason: clean(item?.reason)
    }))
    .filter((item) => item.text)
    .slice(0, 1);
}

function clean(value) {
  return String(value || "").trim();
}

function clip(value, length) {
  const text = clean(value).replace(/\s+/g, " ");
  return text.length > length ? text.slice(0, length) + "..." : text;
}
