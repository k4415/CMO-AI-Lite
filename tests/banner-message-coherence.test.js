import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCopyReadoutText,
  evaluateMessagePlanGate,
  normalizeAuthorizedClaimSet,
  normalizeMessagePlan,
  normalizeTemplateFitDecision
} from "../src/core/banner-message-coherence.js";

test("AuthorizedClaimSetは属性・購入瞬間ゴール・切り口・許可主張・テンプレ伝達計画を正規化する", () => {
  const claimSet = normalizeAuthorizedClaimSet({
    audienceAttribute: "広告成果に責任を持つマーケター",
    purchaseMomentGoal: "次の検証用バナーを今週中に出せる",
    chosenAngle: "benefit",
    coreMessage: "当たり広告の仮説を自社で早く検証できる",
    whyThisAngle: "属性を持つ読者が最初に欲しい変化だから",
    additionalInstructionIntent: {
      priority: "normal",
      fixedCopy: ["7日無料", "7日無料"],
      requiredAngles: ["自社検証"],
      allowSiblingSimilarity: true
    },
    templateMessagePlan: [{
      groupId: "primary",
      semanticRole: "primary_promise",
      groupMessage: "当たり広告を自社で検証",
      slotIds: ["hook-1", "hook-2"]
    }],
    claims: [{
      claimId: "claim-1",
      text: "7日無料",
      sourceType: "additional_instruction",
      numericTokens: ["7日"],
      allowedUses: ["offer"],
      mandatory: true
    }],
    identityAnchors: ["CMO AI Pro"],
    mandatorySharedAnchors: ["CMO AI Pro"],
    forbiddenClaims: ["完全自動"]
  });

  assert.equal(claimSet.additionalInstructionIntent.priority, "highest");
  assert.deepEqual(claimSet.additionalInstructionIntent.fixedCopy, ["7日無料"]);
  assert.equal(claimSet.additionalInstructionIntent.allowSiblingSimilarity, true);
  assert.deepEqual(claimSet.templateMessagePlan[0].slotIds, ["hook-1", "hook-2"]);
  assert.deepEqual(claimSet.claims[0].numericTokens, ["7日"]);
});

test("messagePlanは主メッセージと数字の意味・主体・最小文脈を監査可能な形へ正規化する", () => {
  const messagePlan = normalizeMessagePlan({
    targetMoment: "漫画広告の外注費と納期に悩んだ時",
    awarenessStage: "solution_aware",
    productOrTaskAnchor: "漫画広告を作るAI",
    oneMessage: "漫画広告をAIで1日制作でき、キャラも統一できる",
    primaryPromise: "漫画広告を1日で制作",
    supportingProof: "キャラクター設定を共有できる",
    offer: "7日間無料",
    informationPriority: {
      mustShow: ["漫画広告AI", "1日制作"],
      support: ["キャラ統一", "7日無料"],
      drop: ["主約束と無関係な機能"]
    },
    numbers: [{
      value: "1日",
      meaning: "漫画広告の制作期間",
      owner: "利用者の制作作業",
      polarity: "shorter_is_better",
      minimumContext: "漫画広告を1日で制作"
    }],
    forbiddenInterpretations: ["1日だけ利用できる"]
  });

  assert.equal(messagePlan.productOrTaskAnchor, "漫画広告を作るAI");
  assert.equal(messagePlan.oneMessage, "漫画広告をAIで1日制作でき、キャラも統一できる");
  assert.deepEqual(messagePlan.informationPriority, {
    mustShow: ["漫画広告AI", "1日制作"],
    support: ["キャラ統一", "7日無料"],
    drop: ["主約束と無関係な機能"]
  });
  assert.deepEqual(messagePlan.numbers[0], {
    value: "1日",
    meaning: "漫画広告の制作期間",
    owner: "利用者の制作作業",
    polarity: "shorter_is_better",
    minimumContext: "漫画広告を1日で制作"
  });
});

test("readoutTextはテンプレートの表示順に空欄を除いて組み立てる", () => {
  const text = buildCopyReadoutText({
    slotTexts: [
      { slotId: "proof", text: "キャラ統一" },
      { slotId: "hook", text: "漫画広告をAI制作" },
      { slotId: "offer", text: "" },
      { slotId: "cta", text: "7日無料" }
    ]
  }, {
    slots: [
      { slotId: "hook", order: 0 },
      { slotId: "proof", order: 1 },
      { slotId: "offer", order: 2 },
      { slotId: "cta", order: 3 }
    ]
  });

  assert.equal(text, "漫画広告をAI制作 / キャラ統一 / 7日無料");
});

test("messagePlan欠落とテンプレート不適合をハードゲートで止める", () => {
  const result = evaluateMessagePlanGate({
    brief: {
      messagePlan: { oneMessage: "便益だけ" },
      templateFitDecision: { status: "reject", reason: "商品カテゴリを示す枠がない" }
    }
  });

  assert.equal(result.status, "failed");
  assert.deepEqual(result.failures, [
    "authorized_claim_set_missing",
    "product_or_task_anchor_missing",
    "primary_promise_missing",
    "template_message_fit_failed"
  ]);
});

test("コピー固定時はmessagePlan欠落を警告として保持しコピーを書き換えない", () => {
  const result = evaluateMessagePlanGate({ brief: {}, copyLocked: true });

  assert.equal(result.status, "warning");
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.warnings, [
    "authorized_claim_set_missing",
    "message_plan_missing",
    "template_fit_decision_missing"
  ]);
});

test("AuthorizedClaimSetの伝達方針が欠ける候補をコピー具体化前のゲートで止める", () => {
  const result = evaluateMessagePlanGate({
    brief: {
      authorizedClaimSet: {
        audienceAttribute: "広告担当者",
        purchaseMomentGoal: "",
        chosenAngle: "benefit",
        coreMessage: "当たり広告を早く検証",
        templateMessagePlan: []
      },
      messagePlan: {
        productOrTaskAnchor: "広告バナー生成AI",
        oneMessage: "当たり広告を早く検証",
        primaryPromise: "検証を早める"
      },
      templateFitDecision: { status: "fit" }
    }
  });

  assert.equal(result.status, "failed");
  assert.ok(result.failures.includes("purchase_moment_goal_missing"));
  assert.ok(result.failures.includes("template_message_plan_missing"));
});

test("templateFitDecisionは許可状態だけを保持し不正値をrejectへ倒す", () => {
  assert.deepEqual(normalizeTemplateFitDecision({ status: "adapt", reason: "proof枠を商品説明に変更" }), {
    status: "adapt",
    reason: "proof枠を商品説明に変更",
    roleAdjustments: []
  });
  assert.equal(normalizeTemplateFitDecision({ status: "unknown" }).status, "reject");
});

test("画像内に数字があるのに意味・主体・最小文脈がなければmessagePlan gateで止める", () => {
  const missing = evaluateMessagePlanGate({
    brief: {
      readoutText: "漫画記事LP / 10万前後 / 7日試す",
      authorizedClaimSet: validAuthorizedClaimSet(),
      messagePlan: {
        productOrTaskAnchor: "漫画記事LP制作AI",
        oneMessage: "漫画記事LP制作の外注費を抑える",
        primaryPromise: "外注費を抑える",
        numbers: []
      },
      templateFitDecision: { status: "fit" }
    }
  });
  const incomplete = evaluateMessagePlanGate({
    brief: {
      readoutText: "外注10万 / 7日無料",
      authorizedClaimSet: validAuthorizedClaimSet(),
      messagePlan: {
        productOrTaskAnchor: "漫画記事LP制作AI",
        oneMessage: "漫画記事LP制作の外注費を抑える",
        primaryPromise: "外注費を抑える",
        numbers: [{ value: "10万", meaning: "外注費", owner: "", minimumContext: "外注10万" }]
      },
      templateFitDecision: { status: "fit" }
    }
  });

  assert.ok(missing.failures.includes("number_context_missing"));
  assert.ok(incomplete.failures.includes("number_context_incomplete"));
});

function validAuthorizedClaimSet() {
  return {
    audienceAttribute: "漫画広告を急いで検証する担当者",
    purchaseMomentGoal: "次の広告検証へ間に合わせる",
    chosenAngle: "benefit",
    coreMessage: "漫画広告を短期間で制作できる",
    whyThisAngle: "検証速度を最優先するため",
    additionalInstructionIntent: { priority: "highest", fixedCopy: [], requiredAngles: [], allowSiblingSimilarity: false },
    templateMessagePlan: [{ groupId: "primary", semanticRole: "primary_promise", groupMessage: "漫画広告を短期間で制作", slotIds: ["hook"] }],
    claims: [],
    identityAnchors: [],
    mandatorySharedAnchors: [],
    forbiddenClaims: []
  };
}
