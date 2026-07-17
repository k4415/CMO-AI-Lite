import test from "node:test";
import assert from "node:assert/strict";

import { char3GramJaccard, reviewOriginality } from "../src/core/banner-originality.js";

const template = {
  copyBlueprint: {
    persuasionMechanism: { messageFlow: ["hook"] },
    slots: [{
      slotId: "z1e1",
      role: "headline",
      messageRole: "hook",
      originalText: "自己流ケアで満足していませんか？",
      pattern: "{他の解決策}で満足していませんか？"
    }]
  }
};

test("元テンプレートの表層一致は診断値だけを残し不合格にしない", () => {
  const review = reviewOriginality({
    brief: { slotTexts: [{ slotId: "z1e1", text: "自己流ケアで満足していませんか？" }] },
    template,
    siblings: [],
    relation: { value: "near" }
  });

  assert.equal(char3GramJaccard("自己流ケアで満足", "自己流ケアで満足"), 1);
  assert.equal(review.status, "passed");
  assert.equal(review.templateSimilarity, 1);
  assert.deepEqual(review.failures, []);
});

test("far category permits abstract pattern reuse below far threshold", () => {
  const review = reviewOriginality({
    brief: { slotTexts: [{ slotId: "z1e1", text: "広告代理店任せで成果に満足できていますか？" }] },
    template,
    siblings: [],
    relation: { value: "far" }
  });

  assert.equal(review.status, "passed");
  assert.ok(review.templateSimilarity < 0.7);
});

test("explicit copy reuse bypasses originality rewrite", () => {
  const review = reviewOriginality({
    brief: { slotTexts: [{ slotId: "z1e1", text: "自己流ケアで満足していませんか？" }] },
    template,
    siblings: [],
    relation: { value: "near" },
    copyLocked: true
  });

  assert.equal(review.status, "passed");
  assert.equal(review.exemption, "explicit_copy_reuse");
});

test("product names and other fixed terms are excluded with an audit reason", () => {
  const review = reviewOriginality({
    brief: { slotTexts: [{ slotId: "z1e1", text: "CMO AI Pro" }] },
    template: {
      copyBlueprint: { slots: [{ slotId: "z1e1", originalText: "CMO AI Pro" }] }
    },
    excludedTerms: [{ text: "CMO AI Pro", reason: "product_name" }],
    relation: { value: "near" }
  });

  assert.equal(review.status, "passed");
  assert.deepEqual(review.originalityExclusions, [{ text: "CMO AI Pro", reason: "product_name" }]);
});

test("同一生成グループで主見出しと切り口が完全一致する事故的重複だけを止める", () => {
  const review = reviewOriginality({
    brief: {
      mainHook: "広告バナーを自社で検証",
      authorizedClaimSet: { chosenAngle: "benefit", additionalInstructionIntent: {} }
    },
    candidateGroupId: "group-1",
    siblings: [{
      candidateGroupId: "group-1",
      copyBrief: {
        mainHook: "広告バナーを自社で検証",
        authorizedClaimSet: { chosenAngle: "benefit" }
      }
    }]
  });

  assert.equal(review.status, "failed");
  assert.deepEqual(review.failures, ["candidate_duplicate"]);
});

test("同一グループの重複は先行候補を残し、後続候補だけを書き直す", () => {
  const common = {
    mainHook: "広告バナーを自社で検証",
    authorizedClaimSet: { chosenAngle: "benefit", additionalInstructionIntent: {} }
  };
  const first = reviewOriginality({
    brief: { ...common, candidateIndex: 0 },
    candidateGroupId: "group-ordered",
    siblings: [{ candidateGroupId: "group-ordered", copyBrief: { ...common, candidateIndex: 1 } }]
  });
  const second = reviewOriginality({
    brief: { ...common, candidateIndex: 1 },
    candidateGroupId: "group-ordered",
    siblings: [{ candidateGroupId: "group-ordered", copyBrief: { ...common, candidateIndex: 0 } }]
  });

  assert.equal(first.status, "passed");
  assert.equal(second.status, "failed");
  assert.deepEqual(second.failures, ["candidate_duplicate"]);
});

test("追加指示の共通化意図は同じ主見出しと切り口を許可する", () => {
  const review = reviewOriginality({
    brief: {
      mainHook: "広告バナーを自社で検証",
      authorizedClaimSet: {
        chosenAngle: "benefit",
        additionalInstructionIntent: { allowSiblingSimilarity: true }
      }
    },
    candidateGroupId: "group-1",
    siblings: [{
      candidateGroupId: "group-1",
      copyBrief: {
        mainHook: "広告バナーを自社で検証",
        authorizedClaimSet: { chosenAngle: "benefit" }
      }
    }]
  });

  assert.equal(review.status, "passed");
  assert.equal(review.exemption, "additional_instruction_similarity");
});

test("BASE BREADの商品説明のようなmandatory shared anchorは兄弟案で共有できる", () => {
  const review = reviewOriginality({
    brief: {
      mainHook: "甘党にたんぱく軽食",
      authorizedClaimSet: {
        chosenAngle: "benefit",
        mandatorySharedAnchors: ["甘党にたんぱく軽食"],
        additionalInstructionIntent: {}
      }
    },
    candidateGroupId: "group-base",
    siblings: [{
      candidateGroupId: "group-base",
      copyBrief: {
        mainHook: "甘党にたんぱく軽食",
        authorizedClaimSet: { chosenAngle: "benefit" }
      }
    }]
  });

  assert.equal(review.status, "passed");
  assert.deepEqual(review.failures, []);
});

test("ApprovedClaimSnapshotの商品共通説明は兄弟重複の比較対象から除外する", () => {
  const snapshot = {
    claims: [{ claimId: "clm_product", sourceType: "product_identity", claimKind: "identity", text: "完全栄養食BASE BREAD" }]
  };
  const review = reviewOriginality({
    brief: {
      mainHook: "完全栄養食BASE BREAD",
      candidateGroupId: "group-1",
      candidateIndex: 1,
      slotTexts: [{ slotId: "hook", canonicalField: "mainHook", text: "完全栄養食BASE BREAD", claimIds: ["clm_product"] }]
    },
    creativeHypothesis: { chosenAngle: "product", additionalInstructionIntent: {} },
    approvedClaimSnapshot: snapshot,
    siblings: [{
      candidateGroupId: "group-1",
      copyBrief: { mainHook: "完全栄養食BASE BREAD", candidateGroupId: "group-1", candidateIndex: 0 },
      creativeHypothesis: { chosenAngle: "product" }
    }]
  });

  assert.equal(review.status, "passed");
  assert.ok(review.originalityExclusions.some((item) => item.reason === "approved_shared_claim"));
});

test("新契約でも同一主見出しとchosenAngleの後続案だけを止める", () => {
  const review = reviewOriginality({
    brief: { mainHook: "広告制作を速く", candidateGroupId: "group-1", candidateIndex: 1 },
    creativeHypothesis: { chosenAngle: "speed", additionalInstructionIntent: {} },
    siblings: [{
      candidateGroupId: "group-1",
      copyBrief: { mainHook: "広告制作を速く", candidateGroupId: "group-1", candidateIndex: 0 },
      creativeHypothesis: { chosenAngle: "speed" }
    }]
  });

  assert.equal(review.status, "failed");
  assert.deepEqual(review.failures, ["candidate_duplicate"]);
});
