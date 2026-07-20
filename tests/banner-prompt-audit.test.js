import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  addBannerCreative,
  generateBannerPrompt,
  listBannerCreatives,
  updateBannerCreative
} from "../src/core/banner-store.js";
import { hashCopyBrief } from "../src/core/banner-copy-hash.js";
import { generateBannerCreativeProposal, reapplyLockedSlotTexts } from "../src/core/banner-ai.js";
import { buildBannerImagePrompt } from "../src/core/openai-image.js";

test("prompt generation audit survives banner storage normalization", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-prompt-audit-store-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  const banner = await addBannerCreative(projectRoot, {
    productId: "product-1",
    strategyId: "strategy-1",
    promptGenerationAudit: { version: 1, modelDesignCalls: 1, httpAttempts: [{ status: 429 }, { status: 200 }] }
  });
  await updateBannerCreative(projectRoot, banner.id, {
    promptGenerationAudit: { version: 1, modelDesignCalls: 1, httpAttempts: [{ status: 200 }] }
  });

  const stored = (await listBannerCreatives(projectRoot)).find((item) => item.id === banner.id);
  assert.deepEqual(stored.promptGenerationAudit, { version: 1, modelDesignCalls: 1, httpAttempts: [{ status: 200 }] });
});

test("colorDecision version 2と旧形式・未設定を包み直さず保存して再読込できる", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-color-decision-store-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  const palette = { main: "#16324F", sub: "#FFFFFF", accent: "#F28C28", background: "#F7FAFC" };
  const version2 = await addBannerCreative(projectRoot, {
    title: "v2",
    productId: "product-1",
    strategyId: "strategy-1",
    colorDecision: {
      version: 2,
      palette,
      source: "who_what_inference",
      contractReview: { status: "passed", unexpectedHex: [], unexpectedNamedColorPaths: [] }
    }
  });
  const version1 = await addBannerCreative(projectRoot, {
    title: "v1",
    productId: "product-1",
    strategyId: "strategy-1",
    colorDecision: { source: "safe_default", palette, ignoredTemplatePalette: true }
  });
  const missing = await addBannerCreative(projectRoot, { title: "missing", productId: "product-1", strategyId: "strategy-1" });

  const stored = await listBannerCreatives(projectRoot);
  assert.deepEqual(stored.find((item) => item.id === version2.id).colorDecision, version2.colorDecision);
  assert.deepEqual(stored.find((item) => item.id === version1.id).colorDecision, version1.colorDecision);
  assert.equal(stored.find((item) => item.id === missing.id).colorDecision, null);
});

test("画像promptはversion 2のカラー監査不合格・palette不一致をAPI前に拒否する", () => {
  const palette = { main: "#16324F", sub: "#FFFFFF", accent: "#F28C28", background: "#F7FAFC" };
  const base = {
    promptJson: { colorScheme: palette, zones: [] },
    colorDecision: { version: 2, palette, contractReview: { status: "passed" } }
  };

  assert.doesNotThrow(() => buildBannerImagePrompt(base, []));
  assert.throws(
    () => buildBannerImagePrompt({ ...base, colorDecision: { ...base.colorDecision, contractReview: { status: "failed" } } }, []),
    (error) => error.code === "PROMPT_COLOR_CONTRACT_VIOLATION" && error.restartNode === "prompt"
  );
  assert.throws(
    () => buildBannerImagePrompt({
      ...base,
      promptJson: { colorScheme: { ...palette, accent: "#2563EB" }, zones: [] }
    }, []),
    (error) => error.code === "PROMPT_COLOR_DECISION_MISMATCH" && error.restartNode === "prompt"
  );
  assert.doesNotThrow(() => buildBannerImagePrompt({ promptJson: { zones: [] }, colorDecision: { source: "safe_default" } }, []));
  assert.doesNotThrow(() => buildBannerImagePrompt({ promptJson: { zones: [] } }, []));
});

test("prompt generation persists success and failure audits", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-prompt-audit-run-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  const copyBrief = {
    version: 3,
    strategyId: "strategy-1",
    generatedAt: "2026-07-20T00:00:00.000Z",
    model: "test",
    appealAxis: "速度",
    targetMoment: "制作を急ぐ瞬間",
    whyItStops: "課題が短く具体的に伝わる",
    mainHook: "制作を止めない",
    subHook: "次の検証へ",
    slotTexts: [
      { slotId: "default-mainHook", text: "制作を止めない" },
      { slotId: "default-subHook", text: "次の検証へ" }
    ],
    proof: "",
    offerBadge: "",
    cta: "詳しく見る",
    disclaimer: "",
    authorizedClaimSet: {
      audienceAttribute: "広告担当者",
      purchaseMomentGoal: "次の検証へ進む",
      chosenAngle: "benefit",
      coreMessage: "制作を止めない",
      whyThisAngle: "検証に直結するため",
      additionalInstructionIntent: { priority: "highest", fixedCopy: [], requiredAngles: [], allowSiblingSimilarity: false },
      templateMessagePlan: [], claims: [], identityAnchors: [], mandatorySharedAnchors: [], forbiddenClaims: []
    },
    rejectedAlternatives: []
  };
  copyBrief.copyBriefHash = hashCopyBrief(copyBrief);
  const base = {
    productId: "product-1",
    strategyId: "strategy-1",
    copyBrief,
    productionStatus: "copy_ready"
  };
  const successful = await addBannerCreative(projectRoot, { ...base, title: "成功" });
  const failed = await addBannerCreative(projectRoot, { ...base, title: "失敗" });
  const context = {
    products: [{ id: "product-1", name: "商品" }],
    strategies: [{ id: "strategy-1", markdown: "制作を速めたい" }]
  };
  const successAudit = { version: 1, modelDesignCalls: 1, httpAttempts: [{ status: 200 }] };
  const copyBriefGenerator = async ({ banners }) => ({
    results: banners.map((banner, index) => ({
      bannerId: banner.id,
      status: "passed",
      copyBrief,
      reviewHistory: [],
      categoryRelation: { value: "near", reuseMethod: "mechanism_only" },
      bannerGenerationContract: { version: 2 },
      generationRunId: `run-${index}`,
      candidateGroupId: `group-${banner.id}`,
      candidateIndex: index,
      warnings: []
    }))
  });

  const generated = await generateBannerPrompt(projectRoot, successful.id, context, {
    copyBriefGenerator,
    proposalGenerator: async ({ copyBrief: brief }) => ({
      imageText: brief.mainHook,
      copyBrief: brief,
      promptJson: { zones: [{ elements: [{ type: "text", slotId: "default-mainHook", content: brief.mainHook }] }] },
      promptText: "prompt",
      reviewNotes: "",
      selectionReason: "",
      promptGenerationAudit: successAudit
    })
  });
  assert.deepEqual(generated.promptGenerationAudit, successAudit);

  const failureAudit = { version: 1, modelDesignCalls: 1, httpAttempts: [{ status: 200 }], outcome: "parse_failed" };
  await assert.rejects(() => generateBannerPrompt(projectRoot, failed.id, context, {
    copyBriefGenerator,
    proposalGenerator: async () => {
      const error = new Error("invalid model JSON");
      error.promptGenerationAudit = failureAudit;
      throw error;
    }
  }), /invalid model JSON/);

  const storedFailed = (await listBannerCreatives(projectRoot)).find((item) => item.id === failed.id);
  assert.equal(storedFailed.productionStatus, "failed");
  assert.deepEqual(storedFailed.promptGenerationAudit, failureAudit);
});

test("Stage 2 uses one model design call and deterministically restores every locked copy slot", async () => {
  const calls = [];
  const copyBrief = {
    version: 3,
    strategyId: "strategy-1",
    appealAxis: "速度",
    whyItStops: "短く具体的",
    mainHook: "制作を止めない",
    subHook: "次の検証へ",
    slotTexts: [
      { slotId: "default-mainHook", text: "制作を止めない" },
      { slotId: "default-subHook", text: "次の検証へ" }
    ]
  };
  const proposal = await generateBannerCreativeProposal({
    banner: { id: "banner-1", imageSize: "1080x1080" },
    product: { id: "product-1", name: "商品" },
    strategy: { id: "strategy-1", markdown: "制作を速めたい" },
    template: null,
    copyBrief,
    jsonGenerator: async ({ onAttempt, onResult }) => {
      calls.push("design");
      onAttempt?.({ httpAttempt: 1, status: 200, requestId: "req-stage2", outcome: "response_received", durationMs: 12 });
      onResult?.({ outcome: "completed", status: 200, requestId: "req-stage2", outputChars: 120, model: "test-model" });
      return {
        promptJson: {
          zones: [{
            name: "Hero",
            elements: [
              { type: "text", slotId: "invented-hook", role: "main hook", content: "モデルが言い換えた見出し" },
              { type: "text", slotId: "invented-sub", role: "sub hook", content: "モデルが作った補足" }
            ]
          }]
        }
      };
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(proposal.promptGenerationAudit.modelDesignCalls, 1);
  assert.equal(proposal.promptGenerationAudit.httpAttempts.length, 1);
  assert.equal(proposal.promptGenerationAudit.outcome, "completed");
  assert.equal(proposal.promptGenerationAudit.outputChars, 120);
  assert.match(proposal.promptGenerationAudit.inputHash, /^sha256:/);
  assert.ok(proposal.promptGenerationAudit.inputChars > 0);
  assert.equal(proposal.promptGenerationAudit.deterministicRepairs.length, 2);
  assert.deepEqual(
    proposal.promptJson.zones.flatMap((zone) => zone.elements).filter((element) => element.type === "text")
      .map((element) => ({ slotId: element.slotId, content: element.content })),
    [
      { slotId: "default-mainHook", content: "制作を止めない" },
      { slotId: "default-subHook", content: "次の検証へ" }
    ]
  );
});

test("fallback repair never adds a text element or zone for a missing locked slot", () => {
  const source = {
    promptJson: {
      zones: [{
        name: "Hero",
        elements: [{ type: "text", slotId: "default-mainHook", role: "main hook", content: "モデル文言" }]
      }]
    }
  };
  const repaired = reapplyLockedSlotTexts(source, {
    template: null,
    copyBrief: {
      slotTexts: [
        { slotId: "default-mainHook", text: "確定見出し" },
        { slotId: "default-subHook", text: "確定補足" }
      ]
    }
  });

  assert.equal(repaired.proposal.promptJson.zones.length, 1);
  assert.equal(repaired.proposal.promptJson.zones[0].elements.length, 1);
  assert.deepEqual(repaired.proposal.promptJson.zones[0].elements[0], {
    type: "text",
    slotId: "default-mainHook",
    role: "main hook",
    content: "確定見出し"
  });
  assert.equal(repaired.repairs.length, 1);
});
