import test from "node:test";
import assert from "node:assert/strict";

import { reviewCopyClaimAlignment } from "../src/core/banner-copy-review.js";

const snapshot = {
  snapshotId: "acs_1",
  claims: [
    { claimId: "clm_speed", text: "広告制作を早められる", claimKind: "benefit", allowedUses: ["headline", "benefit"] },
    { claimId: "clm_identity", text: "CMO AI Pro", claimKind: "identity", allowedUses: ["headline"] }
  ]
};

test("benefitの自然な要約はclaim alignmentを通る", async () => {
  const result = await reviewCopyClaimAlignment({
    briefs: [{
      hypothesisId: "hyp_1",
      slotTexts: [{ slotId: "hook", text: "広告制作をもっと速く", claimIds: ["clm_speed"] }]
    }],
    approvedClaimSnapshot: snapshot,
    reviewGenerator: async ({ user }) => {
      const payload = JSON.parse(user);
      return { reviews: payload.candidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        slotId: candidate.slotId,
        status: "entailed",
        claimIds: candidate.claimIds,
        reason: "benefitの自然な要約"
      })) };
    }
  });

  assert.equal(result[0].status, "passed");
});

test("無関係なclaimIdを付けた保証表現はclaim_alignment_failedになる", async () => {
  const result = await reviewCopyClaimAlignment({
    briefs: [{
      hypothesisId: "hyp_1",
      slotTexts: [{ slotId: "hook", text: "売上が必ず伸びる", claimIds: ["clm_identity"] }]
    }],
    approvedClaimSnapshot: snapshot,
    reviewGenerator: async ({ user }) => {
      const payload = JSON.parse(user);
      return { reviews: payload.candidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        slotId: candidate.slotId,
        status: "not_entailed",
        claimIds: candidate.claimIds,
        reason: "商品名から売上保証は導けない"
      })) };
    }
  });

  assert.equal(result[0].status, "failed");
  assert.deepEqual(result[0].failures, ["claim_alignment_failed"]);
});

test("審査件数不足はCLAIM_ALIGNMENT_REVIEW_ERRORにする", async () => {
  await assert.rejects(
    reviewCopyClaimAlignment({
      briefs: [{ hypothesisId: "hyp_1", slotTexts: [{ slotId: "hook", text: "広告制作を速く", claimIds: ["clm_speed"] }] }],
      approvedClaimSnapshot: snapshot,
      reviewGenerator: async () => ({ reviews: [] })
    }),
    (error) => error.code === "CLAIM_ALIGNMENT_REVIEW_ERROR"
  );
});
