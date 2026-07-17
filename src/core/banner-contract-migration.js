import crypto from "node:crypto";

import { buildApprovedClaimSnapshot } from "./banner-approved-claims.js";
import { hashCopyBrief } from "./banner-copy-hash.js";
import { buildCopySlotPlan } from "./banner-copy-slots.js";
import { buildInstructionPolicy } from "./banner-instruction-policy.js";
import { markPipelineNode, normalizePipelineState } from "./banner-pipeline-state.js";

export const BANNER_CONTRACT_MIGRATION_VERSION = "banner-winning-design-contract-v5.1";

export function migrateLegacyBannerContract({ banner = {}, product = {}, strategy = {}, template = null } = {}) {
  if (isCompletedImage(banner)) return banner;
  if (banner.migration?.version === BANNER_CONTRACT_MIGRATION_VERSION) return banner;

  const latestHistory = [...(Array.isArray(banner.copyReviewHistory) ? banner.copyReviewHistory : [])].reverse()
    .find((item) => item?.copyBrief) || null;
  const soleStrategySourceFailure = isSoleStrategySourceFailure(latestHistory);
  const recoveredFromHistory = !banner.copyBrief && Boolean(latestHistory?.copyBrief) && soleStrategySourceFailure;
  const legacyBrief = banner.copyBrief || (recoveredFromHistory ? latestHistory.copyBrief : null);
  const instructionPolicy = banner.instructionPolicy || buildInstructionPolicy(
    [banner.additionalInstruction, banner.revisionInstruction].filter(Boolean).join("\n")
  );
  const approvedClaimSnapshot = legacyBrief
    ? buildApprovedClaimSnapshot({ product, strategy, instructionPolicy })
    : null;
  const creativeHypothesis = legacyBrief
    ? migrateCreativeHypothesis(legacyBrief, banner, approvedClaimSnapshot)
    : null;
  const copyBrief = legacyBrief && creativeHypothesis
    ? migrateCopyBrief(legacyBrief, creativeHypothesis, approvedClaimSnapshot, template)
    : null;
  const canCompleteCopy = Boolean(copyBrief) && (Boolean(banner.copyBrief) || recoveredFromHistory);
  const reviewPassed = canCompleteCopy && legacyReviewsPassed(banner, latestHistory);
  const contractComplete = reviewPassed && allClaimReferencesValid(copyBrief, approvedClaimSnapshot);
  const promptComplete = contractComplete && promptMatchesFrozenCopy(banner, copyBrief);

  let pipelineNodes = normalizePipelineState();
  if (canCompleteCopy && copyBrief) pipelineNodes = completeNode(pipelineNodes, "copyplan", copyBrief.copyBriefHash);

  let promptJson = banner.promptJson || null;
  if (promptComplete) {
    promptJson = {
      ...promptJson,
      contractRefs: {
        hypothesisId: creativeHypothesis.hypothesisId,
        hypothesisHash: creativeHypothesis.contentHash,
        approvedClaimSnapshotId: approvedClaimSnapshot.snapshotId,
        approvedClaimSnapshotHash: approvedClaimSnapshot.contentHash,
        copyBriefVersion: 4,
        copyBriefHash: copyBrief.copyBriefHash
      }
    };
    pipelineNodes = completeNode(pipelineNodes, "prompt", hashObject({ promptJson, promptText: banner.promptText }));
  }
  if (banner.imageGenerationStatus === "failed" && promptComplete) {
    pipelineNodes = markPipelineNode(pipelineNodes, "image", {
      status: "failed",
      inputHash: hashObject({ prompt: pipelineNodes.prompt.outputHash }),
      errorCode: "IMAGE_GENERATION_FAILED",
      errorMessage: String(banner.lastError || "")
    });
  }

  const now = new Date().toISOString();
  return {
    ...banner,
    ...(approvedClaimSnapshot ? { approvedClaimSnapshot } : {}),
    ...(creativeHypothesis ? { creativeHypothesis } : {}),
    ...(copyBrief ? { copyBrief } : {}),
    ...(promptComplete ? { promptJson } : {}),
    pipelineNodes,
    migration: {
      version: BANNER_CONTRACT_MIGRATION_VERSION,
      migratedAt: now,
      recoveredCopyBrief: recoveredFromHistory,
      source: recoveredFromHistory ? "copy_review_history" : (banner.copyBrief ? "saved_copy_brief" : "none")
    }
  };
}

function migrateCreativeHypothesis(copyBrief, banner, snapshot) {
  const audienceAttribute = clean(copyBrief.authorizedClaimSet?.audienceAttribute);
  const chosenAngle = clean(copyBrief.authorizedClaimSet?.chosenAngle || copyBrief.appealAxis);
  const primaryPromise = clean(copyBrief.messagePlan?.primaryPromise || copyBrief.mainHook);
  if (!audienceAttribute || !chosenAngle || !primaryPromise || !snapshot?.snapshotId) return null;
  const base = {
    version: 1,
    strategyId: clean(banner.strategyId),
    approvedClaimSnapshotId: snapshot.snapshotId,
    approvedClaimSnapshotHash: snapshot.contentHash,
    audienceAttribute,
    targetMoment: clean(copyBrief.messagePlan?.targetMoment || copyBrief.targetMoment),
    barrier: clean(copyBrief.authorizedClaimSet?.problem),
    chosenAngle,
    primaryPromise,
    supportingClaimIds: [],
    proofClaimIds: [],
    offerClaimIds: [],
    templateMechanism: clean(copyBrief.templateFitDecision?.reason),
    visualIntent: { scene: "", motif: "" },
    semanticGroupPlan: [],
    templateFitDecision: copyBrief.templateFitDecision || { status: "adapt", reason: "旧保存コピーから移行", roleAdjustments: [] },
    variationPolicy: { changedDimensions: ["angle"], preservedDimensions: ["promise"] },
    additionalInstructionIntent: {},
    origin: "legacy_migration"
  };
  const contentHash = hashObject(base);
  return { ...base, hypothesisId: `hyp_${contentHash.slice(-16)}`, contentHash };
}

function migrateCopyBrief(value, hypothesis, snapshot, template) {
  const slotTexts = (Array.isArray(value.slotTexts) ? value.slotTexts : []).map((slot) => ({
    ...slot,
    hypothesisId: hypothesis.hypothesisId,
    claimIds: resolveUniqueClaimIds(slot.text, snapshot)
  }));
  const semanticGroupReadout = buildSemanticGroupReadout(template, slotTexts, value.authorizedClaimSet?.templateMessagePlan);
  const migrated = {
    ...value,
    version: 4,
    hypothesisId: hypothesis.hypothesisId,
    hypothesisHash: hypothesis.contentHash,
    approvedClaimSnapshotId: snapshot.snapshotId,
    approvedClaimSnapshotHash: snapshot.contentHash,
    slotTexts,
    semanticGroupReadout
  };
  migrated.copyBriefHash = hashCopyBrief(migrated);
  return migrated;
}

function buildSemanticGroupReadout(template, slotTexts, legacyMessagePlan) {
  const plan = buildCopySlotPlan(template);
  const groups = Array.isArray(plan.semanticGroups) && plan.semanticGroups.length
    ? plan.semanticGroups
    : slotTexts.map((slot, index) => ({ groupId: `legacy-group-${index + 1}`, slotIds: [slot.slotId] }));
  const byId = new Map(slotTexts.map((slot) => [clean(slot.slotId), clean(slot.text)]));
  return groups.map((group) => ({
    groupId: clean(group.groupId),
    slotIds: (group.slotIds || []).map(clean).filter(Boolean),
    visibleText: (group.slotIds || []).map((slotId) => byId.get(clean(slotId))).filter(Boolean).join(" "),
    expectedMessage: clean(legacyMessagePlan?.[group.groupId] || "")
  }));
}

function resolveUniqueClaimIds(text, snapshot) {
  const normalized = normalizeText(text);
  const numbers = normalized.match(/\d+(?:\.\d+)?(?:分の\d+|%|％|円|日|ヶ月|か月|倍)?/g) || [];
  if (!numbers.length) return [];
  const candidates = (snapshot?.claims || []).filter((claim) => numbers.every((token) => normalizeText(claim.text).includes(normalizeText(token))));
  return candidates.length === 1 ? [candidates[0].claimId] : [];
}

function allClaimReferencesValid(copyBrief, snapshot) {
  const valid = new Set((snapshot?.claims || []).map((claim) => claim.claimId));
  return (copyBrief.slotTexts || []).every((slot) => {
    const hasObjective = /\d/.test(clean(slot.text));
    return !hasObjective || (slot.claimIds || []).length === 1 && valid.has(slot.claimIds[0]);
  });
}

function isSoleStrategySourceFailure(history) {
  if (!history) return false;
  const failures = [...new Set((history.hardGate?.failures || []).map(clean).filter(Boolean))];
  if (failures.length !== 1 || failures[0] !== "strategy_source_missing") return false;
  if (history.communicationReview?.status === "failed" || history.originalityReview?.status === "failed") return false;
  if (history.copyBrief?.templateFitDecision?.status === "reject") return false;
  return true;
}

function legacyReviewsPassed(banner, history) {
  const reviews = [
    banner.copyQualityReview || history?.qualityReview,
    banner.communicationReview || history?.communicationReview,
    banner.originalityReview || history?.originalityReview
  ].filter(Boolean);
  return reviews.length >= 2 && reviews.every((review) => ["passed", "warning"].includes(clean(review.status)));
}

function promptMatchesFrozenCopy(banner, copyBrief) {
  if (!banner.promptJson || !clean(banner.promptText)) return false;
  const prompt = normalizeText(JSON.stringify(banner.promptJson) + " " + banner.promptText);
  return (copyBrief.slotTexts || []).filter((slot) => clean(slot.text)).every((slot) => prompt.includes(normalizeText(slot.text)));
}

function completeNode(state, node, outputHash) {
  return markPipelineNode(state, node, { status: "completed", inputHash: `migration:${node}`, outputHash });
}

function isCompletedImage(banner) {
  return banner.imageGenerationStatus === "completed"
    || (banner.productionStatus === "completed" && Boolean(banner.generatedImagePath));
}

function hashObject(value) {
  return `sha256:${crypto.createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function normalizeText(value) {
  return clean(value).normalize("NFKC").replace(/[\s,，、。・「」『』（）()／/]/g, "").toLowerCase();
}

function clean(value) {
  return String(value ?? "").trim();
}
