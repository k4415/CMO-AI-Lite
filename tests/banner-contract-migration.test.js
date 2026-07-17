import test from "node:test";
import assert from "node:assert/strict";

import { migrateLegacyBannerContract } from "../src/core/banner-contract-migration.js";

function legacyCopyBrief() {
  return {
    version: 3,
    appealAxis: "速度",
    mainHook: "制作時間を5分の1に",
    whyItStops: "数字",
    messagePlan: {
      targetMoment: "制作を急ぐ瞬間",
      productOrTaskAnchor: "広告制作",
      oneMessage: "広告制作時間を5分の1にする",
      primaryPromise: "制作時間を5分の1に"
    },
    authorizedClaimSet: { audienceAttribute: "広告担当者", chosenAngle: "speed", claims: [] },
    slotTexts: [{ slotId: "hook", role: "headline", text: "制作時間を5分の1に", strategySource: { strategyId: "str_1", sourceText: "制作時間／5分の1" } }]
  };
}

function legacyFailedBanner({ hardGateFailures = ["strategy_source_missing"], communicationStatus = "passed" } = {}) {
  return {
    id: "ban_1",
    productId: "prod_1",
    strategyId: "str_1",
    productionStatus: "copy_review_failed",
    copyBrief: null,
    copyReviewHistory: [{
      errorCode: "COPY_HARD_GATE_FAILED",
      hardGate: { failures: hardGateFailures },
      communicationReview: { status: communicationStatus },
      copyBrief: legacyCopyBrief()
    }]
  };
}

function legacyTemplateWithSemanticGroups() {
  return {
    id: "tpl_1",
    templateZones: [{ name: "Hero", elements: [{ type: "text", slotId: "hook", role: "headline", messageRole: "hook", charCount: 18 }] }],
    copyBlueprint: { semanticGroups: [{ groupId: "promise", slotIds: ["hook"], joinMode: "single" }] }
  };
}

function legacyImageFailedBannerWithValidPrompt() {
  return {
    ...legacyFailedBanner(),
    templateAdId: "tpl_1",
    copyBrief: legacyCopyBrief(),
    copyQualityReview: { status: "passed", claimAlignmentReview: { status: "passed" } },
    communicationReview: { status: "passed" },
    originalityReview: { status: "passed" },
    promptJson: { basic: { size: "1024x1024" }, zones: [{ elements: [{ type: "text", slotId: "hook", content: "制作時間を5分の1に" }] }] },
    promptText: "制作時間を5分の1に",
    imageGenerationStatus: "failed"
  };
}

test("strategy_source_missingの旧レコードはreviewHistoryのcopyBriefを再利用する", () => {
  const migrated = migrateLegacyBannerContract({
    banner: legacyFailedBanner(),
    product: { id: "prod_1", name: "商品" },
    strategy: { id: "str_1", markdown: "## ベネフィット\n制作時間を5分の1に" }
  });
  assert.equal(migrated.copyBrief.mainHook, "制作時間を5分の1に");
  assert.equal(migrated.creativeHypothesis.origin, "legacy_migration");
  assert.equal(migrated.pipelineNodes.copyplan.status, "completed");
  assert.equal(migrated.pipelineNodes.prompt.status, "pending");
  assert.equal(migrated.pipelineNodes.image.status, "pending");
});

test("strategy_source_missing以外の失敗が併存する旧コピーはcompletedにしない", () => {
  const migrated = migrateLegacyBannerContract({
    banner: legacyFailedBanner({ hardGateFailures: ["strategy_source_missing", "copy_structure_failed"], communicationStatus: "failed" }),
    product: { id: "prod_1", name: "商品" },
    strategy: { id: "str_1", benefit: "制作時間を5分の1にする" }
  });
  assert.equal(migrated.pipelineNodes.copyplan.status, "pending");
  assert.equal(migrated.migration.recoveredCopyBrief, false);
});

test("有効な旧promptが残る画像失敗レコードはimageから再開する", () => {
  const migrated = migrateLegacyBannerContract({
    banner: legacyImageFailedBannerWithValidPrompt(),
    product: { id: "prod_1", name: "商品" },
    strategy: { id: "str_1", benefit: "制作時間を5分の1にする" },
    template: legacyTemplateWithSemanticGroups()
  });
  assert.equal(migrated.pipelineNodes.prompt.status, "completed");
  assert.equal(migrated.pipelineNodes.image.status, "failed");
});

test("画像完成済みレコードはmigration結果を完全一致で返す", () => {
  const banner = { id: "done", productionStatus: "completed", imageGenerationStatus: "completed", generatedImagePath: "outputs/done.png" };
  assert.deepEqual(migrateLegacyBannerContract({ banner }), banner);
});

test("同じmigrationVersionの2回目実行は完全に冪等", () => {
  const first = migrateLegacyBannerContract({ banner: legacyFailedBanner(), product: { id: "prod_1", name: "商品" }, strategy: { id: "str_1", benefit: "制作時間を5分の1にする" } });
  assert.deepEqual(migrateLegacyBannerContract({ banner: first }), first);
});
