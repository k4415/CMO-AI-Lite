import test from "node:test";
import assert from "node:assert/strict";

import {
  buildApprovedClaimSnapshot,
  validateCopyAuthorization
} from "../src/core/banner-approved-claims.js";
import { classifyAdditionalInstruction } from "../src/core/banner-instruction-policy.js";

test("複数のWHO-WHAT要素を統合したコピーは連続文字列一致なしで通る", () => {
  const snapshot = buildApprovedClaimSnapshot({
    strategy: {
      id: "str_1",
      targetAttributes: "広告制作に時間がかかる担当者",
      benefit: "今週中に広告を検証できる"
    },
    product: { id: "prod_1", name: "CMO AI Pro" },
    instructionPolicy: { rawInstruction: "" }
  });
  const result = validateCopyAuthorization({
    copyBrief: {
      hypothesisId: "hyp_1",
      slotTexts: [{
        slotId: "hook",
        role: "headline",
        text: "制作を早め、今週中に広告検証",
        hypothesisId: "hyp_1",
        claimIds: snapshot.claims
          .filter((claim) => ["audience", "benefit"].includes(claim.claimKind))
          .map((claim) => claim.claimId)
      }]
    },
    creativeHypothesis: { hypothesisId: "hyp_1" },
    approvedClaimSnapshot: snapshot
  });
  assert.equal(result.status, "passed");
});

test("未知の数字はclaimIdがないまま通さない", () => {
  const snapshot = buildApprovedClaimSnapshot({
    strategy: { id: "str_1", markdown: "## ベネフィット\n広告制作を早める" },
    product: { id: "prod_1", name: "商品" },
    instructionPolicy: { rawInstruction: "" }
  });
  const result = validateCopyAuthorization({
    copyBrief: {
      hypothesisId: "hyp_1",
      slotTexts: [{
        slotId: "proof",
        role: "proof",
        text: "満足度98%",
        hypothesisId: "hyp_1",
        claimIds: []
      }]
    },
    creativeHypothesis: { hypothesisId: "hyp_1" },
    approvedClaimSnapshot: snapshot
  });
  assert.equal(result.status, "failed");
  assert.ok(result.violations.some((item) => item.code === "objective_claim_id_missing"));
});

test("同じ入力から同じclaimIdとsnapshotIdを作る", () => {
  const input = {
    strategy: { id: "str_1", markdown: "## オファー\n7日無料" },
    product: { id: "prod_1", name: "商品" },
    instructionPolicy: { rawInstruction: "" }
  };
  assert.deepEqual(buildApprovedClaimSnapshot(input), buildApprovedClaimSnapshot(input));
});

test("実運用の太字見出しmarkdownを旧データfallbackとして分割する", () => {
  const snapshot = buildApprovedClaimSnapshot({
    strategy: {
      id: "str_legacy",
      markdown: [
        "### 仮説 【広告担当者】",
        "",
        "**USP:**",
        "- テンプレート構造を再利用できる",
        "- 部分修正できる",
        "",
        "**ベネフィット:**",
        "制作時間を5分の1にできる"
      ].join("\n")
    }
  });
  assert.equal(snapshot.claims.filter((claim) => claim.claimKind === "usp").length, 2);
  assert.equal(snapshot.claims.filter((claim) => claim.claimKind === "benefit").length, 1);
});

test("否定指示とvisual-only指示を許可claimにしない", () => {
  const snapshot = buildApprovedClaimSnapshot({
    strategy: { id: "str_1", benefit: "広告制作を早める" },
    instructionPolicy: classifyAdditionalInstruction("7日無料は入れない。背景だけ赤に変更する")
  });
  assert.equal(snapshot.claims.some((claim) => /7日無料|背景.*赤/.test(claim.text)), false);
});

test("コピーという語がなくても肯定事実の追加指示はclaimにする", () => {
  const snapshot = buildApprovedClaimSnapshot({
    strategy: { id: "str_1", benefit: "漫画制作を早める" },
    instructionPolicy: classifyAdditionalInstruction("漫画家依頼だと1ヶ月")
  });
  assert.equal(snapshot.claims.some((claim) => claim.sourceType === "additional_instruction" && claim.text === "漫画家依頼だと1ヶ月"), true);
});

test("数字がなくても主張slotにclaimIdがなければ通さない", () => {
  const snapshot = buildApprovedClaimSnapshot({ strategy: { id: "str_1", benefit: "広告制作を早める" } });
  const result = validateCopyAuthorization({
    copyBrief: { hypothesisId: "hyp_1", slotTexts: [{ slotId: "hook", role: "headline", text: "売上が必ず伸びる", hypothesisId: "hyp_1", claimIds: [] }] },
    creativeHypothesis: { hypothesisId: "hyp_1" },
    approvedClaimSnapshot: snapshot
  });
  assert.ok(result.violations.some((item) => item.code === "claim_id_missing"));
});

test("数字が一致しても未許可の保証表現は通さない", () => {
  const snapshot = buildApprovedClaimSnapshot({
    strategy: { id: "str_1", offer: "7日無料で試せる" }
  });
  const offerClaim = snapshot.claims.find((claim) => claim.claimKind === "offer");
  const result = validateCopyAuthorization({
    copyBrief: { hypothesisId: "hyp_1", slotTexts: [{ slotId: "hook", role: "headline", text: "7日で成果保証", hypothesisId: "hyp_1", claimIds: [offerClaim.claimId] }] },
    creativeHypothesis: { hypothesisId: "hyp_1" },
    approvedClaimSnapshot: snapshot
  });
  assert.ok(result.violations.some((item) => item.code === "objective_token_not_authorized"));
});

test("追加指示で明示されたオファーはoffer slotで利用できる", () => {
  const snapshot = buildApprovedClaimSnapshot({
    strategy: { id: "str_1", benefit: "広告制作を早める" },
    instructionPolicy: classifyAdditionalInstruction("7日無料で試せる")
  });
  const claim = snapshot.claims.find((item) => item.sourceType === "additional_instruction");
  const result = validateCopyAuthorization({
    copyBrief: {
      hypothesisId: "hyp_1",
      slotTexts: [{
        slotId: "offer",
        role: "offer",
        text: "7日無料",
        hypothesisId: "hyp_1",
        claimIds: [claim.claimId]
      }]
    },
    creativeHypothesis: { hypothesisId: "hyp_1" },
    approvedClaimSnapshot: snapshot
  });
  assert.equal(result.status, "passed");
});
