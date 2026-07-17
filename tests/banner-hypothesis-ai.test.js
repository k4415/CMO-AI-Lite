import test from "node:test";
import assert from "node:assert/strict";

import {
  generateCreativeHypotheses,
  normalizeCreativeHypothesis
} from "../src/core/banner-hypothesis-ai.js";

test("初回group planから共通項目を固定した3案の仮説を作る", async () => {
  const result = await generateCreativeHypotheses({
    banners: [{ id: "ban_1" }, { id: "ban_2" }, { id: "ban_3" }],
    strategy: { id: "str_1" },
    copySlotPlan: slotPlan(),
    approvedClaimSnapshot: claims(),
    generationRunId: "run_1",
    candidateGroupId: "group_1",
    candidateIndexes: [0, 1, 2],
    hypothesisJsonGenerator: async () => groupPlan()
  });

  assert.equal(result.results.length, 3);
  assert.equal(result.results.every((item) => item.status === "passed"), true);
  assert.equal(result.results[0].hypothesis.audienceAttribute, result.results[1].hypothesis.audienceAttribute);
  assert.equal(result.results[0].hypothesis.offerClaimIds.join(","), result.results[2].hypothesis.offerClaimIds.join(","));
  assert.deepEqual(result.results[1].hypothesis.variationPolicy.changedDimensions, ["angle", "promise"]);
  assert.equal(result.results[0].hypothesis.variationPolicy.role, "baseline");
  assert.equal(result.results[1].hypothesis.variationPolicy.role, "variant");
  assert.notEqual(result.results[0].hypothesis.hypothesisId, result.results[1].hypothesis.hypothesisId);
  assert.equal(Object.hasOwn(result.results[0].hypothesis, "expectedMetric"), false);
});

test("再試行へ具体的な共通契約・基準案・合格済み兄弟案を渡し、失敗案だけを直す", async () => {
  const calls = [];
  const result = await generateCreativeHypotheses({
    banners: [{ id: "ban_1" }, { id: "ban_2" }],
    strategy: { id: "str_1", name: "CPA改善" },
    copySlotPlan: slotPlan(),
    approvedClaimSnapshot: claims(),
    generationRunId: "run_1",
    candidateGroupId: "group_1",
    hypothesisJsonGenerator: async ({ user }) => {
      const payload = JSON.parse(user);
      calls.push(payload);
      if (calls.length === 1) {
        const plan = groupPlan({ bannerIds: ["ban_1", "ban_2"] });
        plan.candidatePatches[0].changes.promise.supportingClaimIds = ["missing"];
        return plan;
      }
      return { candidatePatches: [patchFor("ban_2", "改善本数", "検証に使える画像を増やす")] };
    }
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].mode, "retry_candidate_patches");
  assert.equal(calls[1].sharedContract.audienceAttribute, "広告担当者");
  assert.equal(calls[1].baselineCandidate.bannerId, "ban_1");
  assert.equal(calls[1].acceptedSiblingCandidates[0].bannerId, "ban_1");
  assert.deepEqual(calls[1].retryCandidates.map((item) => item.bannerId), ["ban_2"]);
  assert.equal(Object.hasOwn(calls[1], "strategy"), true);
  assert.equal(Object.hasOwn(calls[1], "approvedClaimSnapshot"), true);
  assert.equal(result.results.every((item) => item.status === "passed"), true);
});

test("部分再実行は保存済みgroup seedを固定し、対象patchだけを生成する", async () => {
  const calls = [];
  const groupSeed = savedGroupSeed();
  const before = structuredClone(groupSeed);
  const result = await generateCreativeHypotheses({
    banners: [{ id: "ban_2" }, { id: "ban_3" }],
    strategy: { id: "str_1" },
    copySlotPlan: slotPlan(),
    approvedClaimSnapshot: claims(),
    generationRunId: "run_1",
    candidateGroupId: "group_1",
    candidateIndexes: [1, 2],
    groupSeed,
    hypothesisJsonGenerator: async ({ user }) => {
      calls.push(JSON.parse(user));
      return {
        candidatePatches: [
          patchFor("ban_2", "改善本数", "検証に使える画像を増やす"),
          proofPatchFor("ban_3")
        ]
      };
    }
  });

  assert.equal(calls[0].mode, "extend_existing_group");
  assert.equal(calls[0].lockedGroupSeed.baselineCandidate.bannerId, "ban_1");
  assert.deepEqual(calls[0].retryCandidates.map((item) => item.bannerId), ["ban_2", "ban_3"]);
  assert.deepEqual(result.results.map((item) => item.bannerId), ["ban_2", "ban_3"]);
  assert.equal(result.results.every((item) => item.status === "passed"), true);
  assert.deepEqual(groupSeed, before);
});

test("2回目も差別化だけが弱い候補はwarningで画像生成対象に残す", async () => {
  let callCount = 0;
  const weakPatch = {
    bannerId: "ban_2",
    changedDimensions: ["angle"],
    changes: { angle: { chosenAngle: "検証停止の回避" } }
  };
  const result = await generateCreativeHypotheses({
    banners: [{ id: "ban_1" }, { id: "ban_2" }],
    strategy: { id: "str_1" },
    copySlotPlan: slotPlan(),
    approvedClaimSnapshot: claims(),
    generationRunId: "run_1",
    candidateGroupId: "group_1",
    hypothesisJsonGenerator: async () => {
      callCount += 1;
      if (callCount === 1) {
        const plan = groupPlan({ bannerIds: ["ban_1", "ban_2"] });
        plan.candidatePatches = [weakPatch];
        return plan;
      }
      return { candidatePatches: [weakPatch] };
    }
  });

  assert.equal(callCount, 2);
  assert.equal(result.results[0].status, "passed");
  assert.equal(result.results[1].status, "warning");
  assert.equal(result.results[1].hypothesis.variationReview.status, "warning");
  assert.equal(result.results[1].hypothesis.variationReview.continuedAfterReview, true);
  assert.ok(result.results[1].hypothesis.variationReview.failureReasons.includes("declared_dimension_not_changed"));
  assert.equal(Object.hasOwn(result.results[1], "error"), false);
});

test("未許可claimは2回目もhard failureとして停止する", async () => {
  let callCount = 0;
  const invalidPatch = patchFor("ban_2", "改善本数", "未許可の成果保証");
  invalidPatch.changes.promise.supportingClaimIds = ["missing"];
  const result = await generateCreativeHypotheses({
    banners: [{ id: "ban_1" }, { id: "ban_2" }],
    strategy: { id: "str_1" },
    copySlotPlan: slotPlan(),
    approvedClaimSnapshot: claims(),
    hypothesisJsonGenerator: async () => {
      callCount += 1;
      if (callCount === 1) {
        const plan = groupPlan({ bannerIds: ["ban_1", "ban_2"] });
        plan.candidatePatches = [invalidPatch];
        return plan;
      }
      return { candidatePatches: [invalidPatch] };
    }
  });

  assert.equal(callCount, 2);
  assert.equal(result.results[1].status, "failed");
  assert.equal(result.results[1].error.code, "HYPOTHESIS_CONTRACT_INVALID");
  assert.equal(result.results[1].hypothesis, undefined);
});

test("template rejectはwarningへ変えず停止する", async () => {
  const plan = groupPlan({ bannerIds: ["ban_1"] });
  plan.sharedContract.templateFitDecision = {
    status: "reject",
    reason: "意味を分断しないと収まらない",
    roleAdjustments: []
  };
  const result = await generateCreativeHypotheses({
    banners: [{ id: "ban_1" }],
    strategy: { id: "str_1" },
    copySlotPlan: slotPlan(),
    approvedClaimSnapshot: claims(),
    hypothesisJsonGenerator: async () => plan
  });

  assert.equal(result.results[0].status, "template_rejected");
  assert.equal(result.results[0].error.code, "TEMPLATE_MESSAGE_FIT_REJECTED");
});

test("仮説生成と再試行へテンプレ表示名・ゾーン名・見本コピーを渡さない", async () => {
  const calls = [];
  await generateCreativeHypotheses({
    banners: [{ id: "ban_1", title: "NO.102_BtoB SaaS 赤背景" }, { id: "ban_2" }],
    strategy: { id: "str_1" },
    templateCopy: {
      id: "tpl_102",
      title: "NO.102_BtoB SaaS 赤背景",
      slots: [{ slotId: "hook", name: "赤い見出し", role: "headline", psychologicalMechanism: "大見出し" }]
    },
    copySlotPlan: {
      templateId: "tpl_102",
      templateTitle: "NO.102_BtoB SaaS 赤背景",
      slots: [{ slotId: "hook", zoneName: "赤背景ゾーン", role: "headline", sampleContent: "赤を使う見本" }],
      semanticGroups: [{ groupId: "main", slotIds: ["hook"], semanticRole: "primary_promise", joinMode: "single" }]
    },
    approvedClaimSnapshot: claims(),
    hypothesisJsonGenerator: async ({ user }) => {
      calls.push(user);
      if (calls.length === 1) {
        const plan = groupPlan({ bannerIds: ["ban_1", "ban_2"], groupId: "main" });
        plan.candidatePatches[0].changes.promise.supportingClaimIds = ["missing"];
        return plan;
      }
      return { candidatePatches: [patchFor("ban_2", "改善本数", "検証に使える画像を増やす", "main")] };
    }
  });

  assert.equal(calls.length, 2);
  for (const prompt of calls) {
    assert.doesNotMatch(prompt, /NO\.102_BtoB SaaS 赤背景|赤い見出し|赤背景ゾーン|赤を使う見本|templateTitle|zoneName|sampleContent/);
    assert.match(prompt, /tpl_102|psychologicalMechanism/);
  }
});

test("variationPolicy.roleは新規仮説だけhashへ含め、旧仮説はroleなしで互換維持する", () => {
  const base = {
    audienceAttribute: "担当者",
    targetMoment: "検討時",
    barrier: "遅い",
    chosenAngle: "speed",
    primaryPromise: "早くなる",
    supportingClaimIds: ["claim-benefit-1"],
    proofClaimIds: [],
    offerClaimIds: [],
    templateMechanism: "大見出し",
    visualIntent: { scene: "制作画面", motif: "工程" },
    semanticGroupPlan: [{ groupId: "group-main", intendedMessage: "早くなる", slotIds: ["z1e1"] }],
    templateFitDecision: { status: "fit", reason: "表示可能", roleAdjustments: [] },
    variationPolicy: { changedDimensions: ["angle"], preservedDimensions: ["audience"] }
  };
  const context = {
    strategyId: "str_1",
    approvedClaimSnapshot: claims(),
    copySlotPlan: slotPlan(),
    candidateIndex: 0
  };
  const legacy = normalizeCreativeHypothesis(base, context);
  const current = normalizeCreativeHypothesis({
    ...base,
    variationPolicy: { ...base.variationPolicy, role: "baseline" }
  }, context);

  assert.equal(Object.hasOwn(legacy.variationPolicy, "role"), false);
  assert.equal(current.variationPolicy.role, "baseline");
  assert.notEqual(current.contentHash, legacy.contentHash);
});

function claims() {
  return {
    version: 1,
    snapshotId: "acs_1",
    contentHash: "sha256:claims",
    claims: [
      { claimId: "claim-benefit-1", text: "広告検証を止めない", claimKind: "benefit" },
      { claimId: "claim-benefit-2", text: "検証に使える画像を増やす", claimKind: "benefit" },
      { claimId: "claim-proof-1", text: "制作工程をAI上で進める", claimKind: "proof" },
      { claimId: "claim-proof-2", text: "部分修正まで対応する", claimKind: "proof" },
      { claimId: "claim-offer-1", text: "7日間試せる", claimKind: "offer" }
    ]
  };
}

function groupPlan({ bannerIds = ["ban_1", "ban_2", "ban_3"], groupId = "group-main" } = {}) {
  return {
    sharedContract: {
      audienceAttribute: "広告担当者",
      targetMoment: "次の広告検証用画像を急いで用意したい瞬間",
      barrier: "制作待ちで検証が止まる",
      offerClaimIds: ["claim-offer-1"],
      templateMechanism: "大きな主約束と工程証拠を順番に見せる",
      templateFitDecision: { status: "fit", reason: "意味を分断せず表示できる", roleAdjustments: [] }
    },
    baselineCandidate: {
      bannerId: bannerIds[0],
      focusDimensions: ["angle", "promise"],
      chosenAngle: "検証停止の回避",
      primaryPromise: "広告検証を止めない",
      supportingClaimIds: ["claim-benefit-1"],
      proofClaimIds: ["claim-proof-1"],
      visualIntent: { scene: "広告制作の進行画面", motif: "生成工程がつながる流れ" },
      semanticGroupMessages: [{ groupId, intendedMessage: "広告検証を止めない" }]
    },
    candidatePatches: bannerIds.slice(1).map((bannerId, index) => index === 0
      ? patchFor(bannerId, "改善本数", "検証に使える画像を増やす", groupId)
      : proofPatchFor(bannerId))
  };
}

function patchFor(bannerId, angle, primaryPromise, groupId = "group-main") {
  return {
    bannerId,
    changedDimensions: ["angle", "promise"],
    changes: {
      angle: { chosenAngle: angle },
      promise: {
        primaryPromise,
        supportingClaimIds: ["claim-benefit-2"],
        semanticGroupMessages: [{ groupId, intendedMessage: primaryPromise }]
      }
    }
  };
}

function proofPatchFor(bannerId) {
  return {
    bannerId,
    changedDimensions: ["proof", "visual_motif"],
    changes: {
      proof: { proofClaimIds: ["claim-proof-2"] },
      visual_motif: { motif: "複数画像が連続生成される装置" }
    }
  };
}

function savedGroupSeed() {
  const plan = groupPlan({ bannerIds: ["ban_1"] });
  return {
    sharedContract: plan.sharedContract,
    baselineCandidate: plan.baselineCandidate
  };
}

function slotPlan() {
  return {
    templateId: "tpl_1",
    semanticGroups: [{
      groupId: "group-main",
      semanticRole: "primary_promise",
      slotIds: ["z1e1"],
      readingOrder: 0,
      joinMode: "single"
    }]
  };
}
