import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { hashCopyBrief } from "../src/core/banner-copy-hash.js";
import { normalizeBannerImageCompletionPatch } from "../src/core/openai-image.js";
import {
  addBannerCreative,
  claimBannerImageGeneration,
  generateBannerPromptBatch,
  listBannerCreatives,
  updateBannerCreative
} from "../src/core/banner-store.js";

test("Stage A warningはprompt_readyまで進みwarningsを保存する", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-banner-warning-copyplan-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  const banner = await addBannerCreative(projectRoot, {
    productId: "product-1",
    strategyId: "strategy-1",
    title: "warning案"
  });
  const context = {
    products: [{ id: "product-1", name: "CMO AI Pro" }],
    strategies: [{ id: "strategy-1", targetAttributes: "広告担当者", benefit: "広告制作を早める" }],
    expressionRules: []
  };
  await fs.writeFile(path.join(projectRoot, "data", "products.json"), JSON.stringify(context.products));
  await fs.writeFile(path.join(projectRoot, "data", "strategies.json"), JSON.stringify(context.strategies));
  await fs.writeFile(path.join(projectRoot, "data", "expression-rules.json"), JSON.stringify(context.expressionRules));

  const copyBriefBase = {
    version: 3,
    strategyId: "strategy-1",
    generatedAt: "2026-07-17T00:00:00.000Z",
    model: "test",
    appealAxis: "時短",
    targetMoment: "制作が遅い瞬間",
    whyItStops: "制作待ちの課題が一読で伝わるため",
    mainHook: "広告制作を早める",
    subHook: "根拠から選べる",
    slotTexts: [
      { slotId: "default-mainHook", text: "広告制作を早める" },
      { slotId: "default-subHook", text: "根拠から選べる" }
    ],
    proof: "",
    offerBadge: "",
    cta: "詳しく見る",
    disclaimer: "",
    authorizedClaimSet: {
      audienceAttribute: "広告担当者",
      purchaseMomentGoal: "次の検証へ",
      chosenAngle: "benefit",
      coreMessage: "広告制作を早める",
      whyThisAngle: "検証に直結",
      additionalInstructionIntent: { priority: "highest", fixedCopy: [], requiredAngles: [], allowSiblingSimilarity: false },
      templateMessagePlan: [],
      claims: [],
      identityAnchors: [],
      mandatorySharedAnchors: [],
      forbiddenClaims: []
    },
    whyItStops: "課題が伝わる",
    rejectedAlternatives: []
  };
  const copyBrief = { ...copyBriefBase, copyBriefHash: hashCopyBrief(copyBriefBase) };

  const result = await generateBannerPromptBatch(projectRoot, [banner.id], context, {
    copyBriefGenerator: async ({ banners, approvedClaimSnapshot }) => ({
      hypothesis: {
        version: 1,
        hypothesisId: "hyp_warn",
        contentHash: "sha256:hyp_warn",
        strategyId: "strategy-1",
        approvedClaimSnapshotId: approvedClaimSnapshot.snapshotId,
        approvedClaimSnapshotHash: approvedClaimSnapshot.contentHash,
        audienceAttribute: "広告担当者",
        targetMoment: "制作が遅い瞬間",
        barrier: "制作が遅い",
        chosenAngle: "hyp_warn",
        primaryPromise: "広告制作を早める",
        supportingClaimIds: [],
        proofClaimIds: [],
        offerClaimIds: [],
        templateMechanism: "大見出し",
        visualIntent: { scene: "制作", motif: "速度" },
        semanticGroupPlan: [],
        origin: "generated"
      },
      results: [{
        bannerId: banners[0].id,
        status: "warning",
        copyBrief,
        reviewHistory: [{ attempt: 1, decision: "warning" }],
        categoryRelation: { value: "near", reuseMethod: "mechanism_only" },
        warnings: [{ type: "copy_selfcheck_unresolved", stage: "copyplan", message: "差分が弱い", occurredAt: "2026-07-17T00:00:00.000Z" }]
      }]
    }),
    proposalGenerator: async ({ copyBrief: brief }) => ({
      imageText: brief.mainHook,
      promptText: "prompt",
      promptJson: { structureSheet: {} },
      copyBrief: brief
    })
  });

  assert.equal(result.errors.length, 0);
  const stored = (await listBannerCreatives(projectRoot)).find((item) => item.id === banner.id);
  assert.equal(stored.productionStatus, "prompt_ready");
  assert.equal(stored.pipelineNodes.copyplan.status, "completed");
  assert.equal(stored.warnings[0].type, "copy_selfcheck_unresolved");
});

test("copyIntegrity failedはcompleted_with_warningsとocr_mismatch warningになる", () => {
  const patch = normalizeBannerImageCompletionPatch({
    relativePath: "outputs/banner.png",
    banner: { imageText: "期待コピー\n2行目" },
    copyIntegrityCheck: {
      status: "failed",
      missing: ["2行目"],
      note: "OCR不一致"
    }
  });

  assert.equal(patch.productionStatus, "completed_with_warnings");
  assert.ok(patch.warnings.some((item) => item.type === "ocr_mismatch"));
});

test("ロゴ枠で正式ワードマークを確認できない場合はlogo_mismatch warningになる", () => {
  const patch = normalizeBannerImageCompletionPatch({
    relativePath: "outputs/banner.png",
    banner: { warnings: [] },
    logoVerification: {
      status: "missing",
      required: true,
      expected: ["Sample Smile"],
      missing: ["Sample Smile"],
      observed: ["SMILE"]
    }
  });

  assert.equal(patch.productionStatus, "completed_with_warnings");
  const warning = patch.warnings.find((item) => item.type === "logo_mismatch");
  assert.ok(warning);
  assert.match(warning.message, /Sample Smile/);
  assert.match(warning.message, /SMILE/);
  assert.match(patch.reviewNotes, /ロゴ同一性チェック/);
  assert.match(patch.reviewNotes, /Sample Smile/);
});

test("旧審査ステータスの保存済みバナーはlistBannerCreativesで読める", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-banner-legacy-status-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  const banner = await addBannerCreative(projectRoot, {
    productId: "product-1",
    strategyId: "strategy-1",
    title: "旧データ"
  });
  await updateBannerCreative(projectRoot, banner.id, {
    productionStatus: "copy_review_failed",
    lastError: "旧審査不合格"
  });

  const stored = (await listBannerCreatives(projectRoot)).find((item) => item.id === banner.id);
  assert.equal(stored.productionStatus, "copy_review_failed");
  assert.equal(stored.lastError, "旧審査不合格");
});

test("completed_with_warningsかつ画像ありのバナーは画像生成を再claimできない", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-banner-warning-reclaim-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  const banner = await addBannerCreative(projectRoot, {
    productId: "product-1",
    strategyId: "strategy-1",
    title: "警告完了"
  });
  await updateBannerCreative(projectRoot, banner.id, {
    productionStatus: "completed_with_warnings",
    generatedImagePath: "outputs/warned.png",
    generatedImageHash: "sha256:warned",
    imageGenerationStatus: "completed",
    warnings: [{ type: "ocr_mismatch", stage: "image", message: "1行不一致", occurredAt: "2026-07-17T00:00:00.000Z" }]
  });

  const claim = await claimBannerImageGeneration(projectRoot, banner.id, {
    ownerId: "test-server",
    attemptId: "image-retry",
    leaseMs: 60000
  });

  assert.equal(claim.claimed, false);
  assert.equal(claim.reason, "completed");
});
