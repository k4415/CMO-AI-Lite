import test from "node:test";
import assert from "node:assert/strict";

import { buildApprovedClaimSnapshot, validateCopyAuthorization } from "../src/core/banner-approved-claims.js";
import { classifyAdditionalInstruction } from "../src/core/banner-instruction-policy.js";
import { evaluateMessagePlanGate } from "../src/core/banner-message-coherence.js";
import { reviewOriginality } from "../src/core/banner-originality.js";

function v4Brief(visibleText) {
  return {
    version: 4,
    hypothesisId: "hyp_1",
    approvedClaimSnapshotId: "acs_1",
    messagePlan: { productOrTaskAnchor: "CMO AI", oneMessage: visibleText, primaryPromise: visibleText, numbers: [] },
    templateFitDecision: { status: "fit" },
    semanticGroupReadout: [{ groupId: "g1", visibleText }]
  };
}

test("CPA設計までつなぐだけで起点と終点が不明なら理解性NG", () => {
  const result = evaluateMessagePlanGate({ brief: { ...v4Brief(""), semanticGroupReadout: [{ groupId: "g1", visibleText: "" }] } });
  assert.equal(result.status, "failed");
  assert.ok(result.failures.includes("semantic_group_not_understood"));
});

test("分断語のsemanticGroupが意味を作らなければ理解性NG", () => {
  const result = evaluateMessagePlanGate({ brief: { ...v4Brief(""), semanticGroupReadout: [{ groupId: "g1", visibleText: "" }] } });
  assert.ok(result.failures.includes("semantic_group_not_understood"));
});

test("漫画家依頼だと1ヶ月は追加指示claimとして許可される", () => {
  const policy = classifyAdditionalInstruction("漫画家依頼だと1ヶ月かかる比較を入れてください");
  const snapshot = buildApprovedClaimSnapshot({ strategy: { id: "s1" }, product: { id: "p1", name: "商品" }, instructionPolicy: policy });
  assert.ok(snapshot.claims.some((claim) => claim.sourceType === "additional_instruction" && claim.text.includes("1ヶ月")));
});

test("BASE BREADの商品説明が兄弟案共通でも明示許可なら独自性NGにしない", () => {
  const brief = { candidateGroupId: "g", candidateIndex: 1, mainHook: "BASE BREAD 完全栄養の主食", slotTexts: [{ slotId: "h", text: "BASE BREAD 完全栄養の主食" }] };
  const result = reviewOriginality({
    brief,
    siblings: [{ candidateGroupId: "g", candidateIndex: 0, mainHook: brief.mainHook, slotTexts: brief.slotTexts }],
    creativeHypothesis: { chosenAngle: "product", additionalInstructionIntent: { allowSiblingSimilarity: true } },
    instructionPolicy: { allowSiblingSimilarity: true }
  });
  assert.equal(result.status, "passed");
});

test("出典にない満足度98%はobjective claim不足でNG", () => {
  const result = validateCopyAuthorization({
    copyBrief: { hypothesisId: "hyp_1", slotTexts: [{ slotId: "h", messageRole: "hook", text: "満足度98%", hypothesisId: "hyp_1", claimIds: [] }] },
    creativeHypothesis: { hypothesisId: "hyp_1" },
    approvedClaimSnapshot: { snapshotId: "acs_1", claims: [] }
  });
  assert.equal(result.status, "failed");
  assert.ok(result.violations.some((item) => item.code === "objective_claim_id_missing"));
});

test("WHO-WHAT複数claimを自然に統合したコピーは文字列不一致だけで落とさない", () => {
  const result = validateCopyAuthorization({
    copyBrief: { hypothesisId: "hyp_1", slotTexts: [{ slotId: "h", messageRole: "hook", text: "迷わず速く広告を作る", hypothesisId: "hyp_1", claimIds: ["c1", "c2"] }] },
    creativeHypothesis: { hypothesisId: "hyp_1" },
    approvedClaimSnapshot: { snapshotId: "acs_1", claims: [
      { claimId: "c1", text: "広告判断に迷わない", allowedUses: [] },
      { claimId: "c2", text: "制作を早める", allowedUses: [] }
    ] }
  });
  assert.equal(result.status, "passed");
});
