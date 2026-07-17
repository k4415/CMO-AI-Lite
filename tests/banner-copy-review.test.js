import test from "node:test";
import assert from "node:assert/strict";

import {
  COPY_REVIEW_POLICY,
  buildBlindReviewPayload,
  reviewCopyBriefs
} from "../src/core/banner-copy-review.js";

test("blind review payloadは属性と表示コピーだけを渡し、戦略・購入ゴール・制作意図・兄弟案を渡さない", async () => {
  const brief = validBrief({
    authorizedClaimSet: {
      ...validClaimSet(),
      purchaseMomentGoal: "次の検証を今週中に開始する",
      chosenAngle: "benefit",
      coreMessage: "当たり広告を自社で早く検証できる",
      whyThisAngle: "速度便益が強い",
      templateMessagePlan: [{
        groupId: "primary",
        semanticRole: "primary_promise",
        groupMessage: "これは制作者だけが知る意図",
        slotIds: ["hook-1", "hook-2"]
      }]
    },
    messagePlan: { oneMessage: "隠すべき制作者の中心意図" },
    slotTexts: [
      { slotId: "hook-1", canonicalField: "mainHook", text: "広告バナーを" },
      { slotId: "hook-2", canonicalField: "mainHook", text: "自社で検証" }
    ],
    readoutText: "広告バナーを / 自社で検証"
  });
  const payload = buildBlindReviewPayload({
    briefs: [brief],
    product: { name: "CMO AI Pro", brandName: "CMO AI", usp: "渡してはいけないUSP" },
    strategy: { markdown: "渡してはいけないWHO-WHAT" },
    siblingBriefs: [{ mainHook: "渡してはいけない兄弟案" }]
  });
  const json = JSON.stringify(payload);

  assert.deepEqual(payload.candidates[0], {
    audienceAttribute: "広告成果に責任を持つマーケター",
    visibleProduct: { name: "CMO AI Pro", brandName: "CMO AI" },
    visibleCopy: {
      readoutText: "広告バナーを / 自社で検証",
      semanticGroups: [{
        groupId: "primary",
        semanticRole: "primary_promise",
        slotIds: ["hook-1", "hook-2"],
        text: "広告バナーを 自社で検証"
      }],
      slotTexts: [
        { slotId: "hook-1", canonicalField: "mainHook", text: "広告バナーを" },
        { slotId: "hook-2", canonicalField: "mainHook", text: "自社で検証" }
      ]
    },
    applicableFields: ["clarity", "specificity"]
  });
  assert.doesNotMatch(json, /WHO-WHAT|購入|chosenAngle|coreMessage|whyThisAngle|oneMessage|制作者|兄弟案|USP/);
});

test("v4 blind reviewはcreativeHypothesisのaudienceと実表示groupだけを渡す", () => {
  const payload = buildBlindReviewPayload({
    briefs: [{
      version: 4,
      hypothesisId: "hyp_1",
      readoutText: "広告制作を速く",
      slotTexts: [{ slotId: "hook", canonicalField: "mainHook", text: "広告制作を速く" }],
      semanticGroupReadout: [{ groupId: "main", slotIds: ["hook"], visibleText: "広告制作を速く", expectedMessage: "制作時間を短縮できる" }]
    }],
    product: { name: "CMO AI Pro" },
    creativeHypotheses: [{ audienceAttribute: "広告制作を急ぐ担当者", primaryPromise: "正解説明として渡さない" }]
  });

  assert.equal(payload.candidates[0].audienceAttribute, "広告制作を急ぐ担当者");
  assert.equal(payload.candidates[0].visibleCopy.semanticGroups[0].text, "広告制作を速く");
  assert.doesNotMatch(JSON.stringify(payload), /制作時間を短縮できる|正解説明として渡さない/);
});

test("copy review v4.1は初見理解の適用項目だけを65点基準で正規化する", async () => {
  const [review] = await reviewCopyBriefs({
    briefs: [validBrief({ offerBadge: "7日無料" })],
    product: { name: "CMO AI Pro" },
    reviewGenerator: async () => ({
      reviews: [{
        scores: { clarity: 4, specificity: 4, offerFit: 3 },
        communicationReview: passingCommunication(),
        warnings: []
      }]
    })
  });

  assert.equal(COPY_REVIEW_POLICY.version, "4.1");
  assert.equal(COPY_REVIEW_POLICY.passScore, 65);
  assert.deepEqual(review.applicableFields, ["clarity", "specificity", "offerFit"]);
  assert.equal(review.normalizedScore, 73);
  assert.equal(review.status, "passed");
  assert.equal(Object.hasOwn(review.communicationReview, "intendedMessage"), false);
  assert.equal(Object.hasOwn(review.communicationReview, "matchesIntendedMessage"), false);
});

test("表示コピーに存在しないevidence spanは読者推測として不合格にする", async () => {
  const [review] = await reviewCopyBriefs({
    briefs: [validBrief()],
    product: { name: "CMO AI Pro" },
    reviewGenerator: async () => ({
      reviews: [{
        scores: { clarity: 5, specificity: 5 },
        communicationReview: passingCommunication({
          evidenceSpans: [{ text: "売上が必ず上がる", supports: "promise" }]
        }),
        warnings: []
      }]
    })
  });

  assert.equal(review.status, "failed");
  assert.ok(review.failureReasons.includes("unsupported_reader_inference"));
});

test("CPA設計までつなぐは商品・対象業務と読者ゴールを解読できずcritical failureになる", async () => {
  const [review] = await reviewCopyBriefs({
    briefs: [validBrief({
      readoutText: "CPA設計までつなぐ",
      mainHook: "CPA設計までつなぐ",
      slotTexts: [{ slotId: "hook", canonicalField: "mainHook", text: "CPA設計までつなぐ" }]
    })],
    product: { name: "CMO AI Pro" },
    reviewGenerator: async () => ({
      reviews: [{
        scores: { clarity: 4, specificity: 4 },
        communicationReview: passingCommunication({
          decodedProductOrTask: "特定できない",
          decodedPromise: "何かをCPA設計へ接続する",
          productOrTaskUnderstood: false,
          primaryPromiseUnderstood: false,
          audienceRelevanceUnderstood: false,
          evidenceSpans: [{ text: "CPA設計までつなぐ", supports: "ambiguous_message" }],
          ambiguities: [{ code: "object_missing", severity: "critical", message: "何をつなぐのか分からない" }]
        }),
        warnings: []
      }]
    })
  });

  assert.equal(review.status, "failed");
  assert.ok(review.failureReasons.includes("product_or_task_not_understood"));
  assert.ok(review.failureReasons.includes("primary_promise_not_understood"));
  assert.ok(review.failureReasons.includes("audience_relevance_not_understood"));
});

test("copy固定時は理解性不合格を警告として保存し書き換えない", async () => {
  const [review] = await reviewCopyBriefs({
    briefs: [validBrief()],
    product: { name: "CMO AI Pro" },
    copyLocked: true,
    reviewGenerator: async () => ({
      reviews: [{
        scores: { clarity: 0, specificity: 0 },
        communicationReview: passingCommunication({ productOrTaskUnderstood: false }),
        warnings: [{ code: "unclear", severity: "warning", message: "不明瞭" }]
      }]
    })
  });

  assert.equal(review.status, "warning");
  assert.equal(review.rewriteAllowed, false);
  assert.ok(review.failureReasons.includes("product_or_task_not_understood"));
});

test("必須スコアやcommunicationReviewの形式不正はCOPY_REVIEW_ERRORにする", async () => {
  await assert.rejects(
    reviewCopyBriefs({
      briefs: [validBrief()],
      product: { name: "CMO AI Pro" },
      reviewGenerator: async () => ({ reviews: [{ scores: { clarity: 6 }, communicationReview: passingCommunication() }] })
    }),
    (error) => error.code === "COPY_REVIEW_ERROR"
  );
});

function validBrief(overrides = {}) {
  return {
    mainHook: "広告バナーを自社で検証",
    readoutText: "広告バナーを自社で検証",
    slotTexts: [{ slotId: "hook", canonicalField: "mainHook", text: "広告バナーを自社で検証" }],
    authorizedClaimSet: validClaimSet(),
    ...overrides
  };
}

function validClaimSet() {
  return {
    audienceAttribute: "広告成果に責任を持つマーケター",
    purchaseMomentGoal: "次の検証用バナーを今週中に出せる",
    chosenAngle: "benefit",
    coreMessage: "広告バナーを自社で検証できる",
    whyThisAngle: "検証速度が重要だから",
    additionalInstructionIntent: { priority: "highest", fixedCopy: [], requiredAngles: [], allowSiblingSimilarity: false },
    templateMessagePlan: [{ groupId: "primary", semanticRole: "primary_promise", groupMessage: "広告バナーを自社で検証", slotIds: ["hook"] }],
    claims: [], identityAnchors: [], mandatorySharedAnchors: [], forbiddenClaims: []
  };
}

function passingCommunication(overrides = {}) {
  return {
    decodedProductOrTask: "広告バナー生成AI",
    decodedPromise: "広告バナーを自社で検証できる",
    decodedMechanism: "AIでバナーを生成する",
    decodedOffer: "",
    numberMeanings: [],
    evidenceSpans: [
      { text: "広告バナー", supports: "product_or_task" },
      { text: "自社で検証", supports: "promise" }
    ],
    ambiguities: [],
    productOrTaskUnderstood: true,
    primaryPromiseUnderstood: true,
    singleMessageFocus: true,
    numberMeaningUnambiguous: true,
    offerConditionUnderstood: true,
    audienceRelevanceUnderstood: true,
    ...overrides
  };
}
