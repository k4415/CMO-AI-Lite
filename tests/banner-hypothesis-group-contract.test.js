import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveGroupPlanSeedFromHypothesis,
  materializeHypothesisGroupPlan
} from "../src/core/banner-hypothesis-group-contract.js";

test("共通契約を全案へコピーし、candidate patchの項目だけを変更する", () => {
  const materialized = materializeHypothesisGroupPlan({
    bannerIds: ["ban_1", "ban_2", "ban_3"],
    copySlotPlan: slotPlan(),
    plan: validGroupPlan()
  });

  assert.equal(materialized.items.length, 3);
  assert.equal(new Set(materialized.items.map((item) => item.audienceAttribute)).size, 1);
  assert.equal(new Set(materialized.items.map((item) => item.offerClaimIds.join(","))).size, 1);
  assert.equal(materialized.items[1].chosenAngle, "改善本数");
  assert.equal(materialized.items[1].primaryPromise, "検証に使える画像を増やす");
  assert.equal(materialized.items[1].visualIntent.scene, materialized.items[0].visualIntent.scene);
  assert.equal(materialized.items[0].variationPolicy.role, "baseline");
  assert.equal(materialized.items[1].variationPolicy.role, "variant");
  assert.deepEqual(materialized.items[1].variationPolicy.changedDimensions, ["angle", "promise"]);
  assert.equal(materialized.items[1].semanticGroupPlan[0].intendedMessage, "検証に使える画像を増やす");
  assert.deepEqual(materialized.items[1].semanticGroupPlan[0].slotIds, ["z1e1"]);
});

test("changedDimensions外の値と3項目以上の変更を拒否する", () => {
  const tooMany = validGroupPlan();
  tooMany.candidatePatches[0].changedDimensions = ["angle", "promise", "proof"];
  tooMany.candidatePatches[0].changes.proof = { proofClaimIds: ["claim-proof-1"] };

  assert.throws(
    () => materializeHypothesisGroupPlan({
      plan: tooMany,
      copySlotPlan: slotPlan(),
      bannerIds: ["ban_1", "ban_2", "ban_3"]
    }),
    (error) => error.code === "HYPOTHESIS_PATCH_INVALID"
  );

  const undeclared = validGroupPlan();
  undeclared.candidatePatches[0].changes.visual_scene = { scene: "宣言外の場面" };
  assert.throws(
    () => materializeHypothesisGroupPlan({
      plan: undeclared,
      copySlotPlan: slotPlan(),
      bannerIds: ["ban_1", "ban_2", "ban_3"]
    }),
    (error) => error.code === "HYPOTHESIS_PATCH_INVALID"
  );
});

test("保存済み兄弟案をshared contractとbaseline candidateへ復元する", () => {
  const banner = savedPassedSibling();
  const before = structuredClone(banner);
  const seed = deriveGroupPlanSeedFromHypothesis({ banner, copySlotPlan: slotPlan() });

  assert.equal(seed.sharedContract.audienceAttribute, "広告担当者");
  assert.equal(seed.sharedContract.offerClaimIds.join(","), "claim-offer-1");
  assert.equal(seed.baselineCandidate.bannerId, "ban_1");
  assert.equal(seed.baselineCandidate.primaryPromise, "広告検証を止めない");
  assert.deepEqual(seed.baselineCandidate.focusDimensions, ["angle"]);
  assert.deepEqual(seed.baselineCandidate.semanticGroupMessages, [
    { groupId: "group-main", intendedMessage: "広告検証を止めない" }
  ]);
  assert.deepEqual(banner, before);
});

test("部分再実行では保存済み基準案を返さず対象patchだけを合成する", () => {
  const seed = deriveGroupPlanSeedFromHypothesis({
    banner: savedPassedSibling(),
    copySlotPlan: slotPlan()
  });
  const materialized = materializeHypothesisGroupPlan({
    plan: {
      ...seed,
      candidatePatches: [
        patchFor("ban_2", "改善本数", "検証に使える画像を増やす"),
        patchFor("ban_3", "判断速度", "次の検証判断を早める")
      ]
    },
    copySlotPlan: slotPlan(),
    bannerIds: ["ban_2", "ban_3"],
    includeBaseline: false
  });

  assert.deepEqual(materialized.items.map((item) => item.bannerId), ["ban_2", "ban_3"]);
  assert.equal(materialized.items.some((item) => item.bannerId === "ban_1"), false);
  assert.equal(materialized.items.every((item) => item.audienceAttribute === "広告担当者"), true);
});

test("保存済み仮説とcopy slotのsemantic group構造が違う場合はseedに使わない", () => {
  const banner = savedPassedSibling();
  banner.creativeHypothesis.semanticGroupPlan[0].slotIds = ["different-slot"];

  assert.throws(
    () => deriveGroupPlanSeedFromHypothesis({ banner, copySlotPlan: slotPlan() }),
    (error) => error.code === "HYPOTHESIS_PATCH_INVALID"
  );
});

function validGroupPlan() {
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
      bannerId: "ban_1",
      focusDimensions: ["angle", "promise"],
      chosenAngle: "検証停止の回避",
      primaryPromise: "広告検証を止めない",
      supportingClaimIds: ["claim-benefit-1"],
      proofClaimIds: ["claim-proof-1"],
      visualIntent: { scene: "広告制作の進行画面", motif: "生成工程がつながる流れ" },
      semanticGroupMessages: [{ groupId: "group-main", intendedMessage: "広告検証を止めない" }]
    },
    candidatePatches: [
      patchFor("ban_2", "改善本数", "検証に使える画像を増やす"),
      {
        bannerId: "ban_3",
        changedDimensions: ["proof", "visual_motif"],
        changes: {
          proof: { proofClaimIds: ["claim-proof-2"] },
          visual_motif: { motif: "複数画像が連続生成される装置" }
        }
      }
    ]
  };
}

function patchFor(bannerId, angle, primaryPromise) {
  return {
    bannerId,
    changedDimensions: ["angle", "promise"],
    changes: {
      angle: { chosenAngle: angle },
      promise: {
        primaryPromise,
        supportingClaimIds: ["claim-benefit-2"],
        semanticGroupMessages: [{ groupId: "group-main", intendedMessage: primaryPromise }]
      }
    }
  };
}

function slotPlan() {
  return {
    semanticGroups: [{
      groupId: "group-main",
      semanticRole: "primary_promise",
      slotIds: ["z1e1"],
      readingOrder: 0,
      joinMode: "single"
    }]
  };
}

function savedPassedSibling() {
  return {
    id: "ban_1",
    creativeHypothesis: {
      audienceAttribute: "広告担当者",
      targetMoment: "次の広告検証用画像を急いで用意したい瞬間",
      barrier: "制作待ちで検証が止まる",
      chosenAngle: "検証停止の回避",
      primaryPromise: "広告検証を止めない",
      supportingClaimIds: ["claim-benefit-1"],
      proofClaimIds: ["claim-proof-1"],
      offerClaimIds: ["claim-offer-1"],
      templateMechanism: "大きな主約束と工程証拠を順番に見せる",
      visualIntent: { scene: "広告制作の進行画面", motif: "生成工程がつながる流れ" },
      semanticGroupPlan: [{
        groupId: "group-main",
        semanticRole: "primary_promise",
        intendedMessage: "広告検証を止めない",
        slotIds: ["z1e1"],
        readingOrder: 0,
        joinMode: "single"
      }],
      templateFitDecision: { status: "fit", reason: "意味を分断せず表示できる", roleAdjustments: [] },
      variationPolicy: {
        changedDimensions: ["angle", "target_moment"],
        preservedDimensions: ["audience", "offer", "template_structure"]
      }
    }
  };
}
