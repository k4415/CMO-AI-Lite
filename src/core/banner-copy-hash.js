import crypto from "node:crypto";
import { CANONICAL_COPY_FIELDS } from "./banner-copy-slots.js";

export function hashCopyBrief(copyBrief = {}) {
  const payload = {
    policyVersion: 1,
    version: Number(copyBrief.version) || 0,
    strategyId: clean(copyBrief.strategyId),
    hypothesisId: clean(copyBrief.hypothesisId),
    hypothesisHash: clean(copyBrief.hypothesisHash),
    approvedClaimSnapshotId: clean(copyBrief.approvedClaimSnapshotId),
    approvedClaimSnapshotHash: clean(copyBrief.approvedClaimSnapshotHash),
    appealAxis: clean(copyBrief.appealAxis),
    targetMoment: clean(copyBrief.targetMoment),
    messagePlan: copyBrief.messagePlan && typeof copyBrief.messagePlan === "object" ? copyBrief.messagePlan : null,
    templateFitDecision: copyBrief.templateFitDecision && typeof copyBrief.templateFitDecision === "object" ? copyBrief.templateFitDecision : null,
    templateUseNote: clean(copyBrief.templateUseNote),
    whyItStops: clean(copyBrief.whyItStops),
    canonicalCopy: Object.fromEntries(CANONICAL_COPY_FIELDS.map((field) => [field, clean(copyBrief[field])])),
    slotTexts: (Array.isArray(copyBrief.slotTexts) ? copyBrief.slotTexts : []).map((slot) => ({
      slotId: clean(slot?.slotId),
      text: clean(slot?.text),
      claimIds: [...new Set((Array.isArray(slot?.claimIds) ? slot.claimIds : []).map(clean).filter(Boolean))]
    })),
    semanticGroupReadout: (Array.isArray(copyBrief.semanticGroupReadout) ? copyBrief.semanticGroupReadout : []).map((group) => ({
      groupId: clean(group?.groupId),
      slotIds: [...new Set((Array.isArray(group?.slotIds) ? group.slotIds : []).map(clean).filter(Boolean))],
      visibleText: clean(group?.visibleText),
      expectedMessage: clean(group?.expectedMessage)
    }))
  };
  return `sha256:${crypto.createHash("sha256").update(stableStringify(payload)).digest("hex")}`;
}

function clean(value) {
  return String(value || "").trim();
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
