import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import { buildBannerDesignPrompt } from "../src/core/banner-ai.js";
import { buildCopySlotPlan } from "../src/core/banner-copy-slots.js";
import { buildBannerGenerationContract } from "../src/core/banner-generation-contract.js";

const LEGACY_TOTAL_INPUT_CHARS = 28909;

test("Stage 2 input is a single contract and at least 30 percent smaller than the fixed legacy fixture", async () => {
  const templates = JSON.parse(await fs.readFile(new URL("../data/ad-templates.json", import.meta.url), "utf8"));
  const template = templates.find((item) => String(item.title || "").includes("NO.097"));
  const banner = {
    id: "fixture",
    imageSize: "1080x1080",
    additionalInstruction: "ロゴを必ず表示",
    logoImagePaths: ["assets/logo.png"],
    productImagePaths: ["assets/product.png"]
  };
  const product = { id: "p1", name: "CMO AI Pro", brandName: "CMO AI Pro", companyName: "CMO AI, Inc.", brandTone: "信頼感" };
  const strategy = { id: "s1", markdown: "## WHO\n広告運用責任者\n## WHAT\nCPA改善仮説をチームで検証する" };
  const copySlotPlan = buildCopySlotPlan(template);
  const copyBrief = {
    version: 3,
    strategyId: "s1",
    appealAxis: "改善速度",
    whyItStops: "短い",
    slotTexts: copySlotPlan.slots.map((slot, index) => ({ slotId: slot.slotId, text: `確定コピー${index + 1}` }))
  };
  const generationContract = buildBannerGenerationContract({
    banner, product, strategy, template, extraInstruction: banner.additionalInstruction
  });
  const prompt = buildBannerDesignPrompt({
    banner,
    product,
    strategy,
    template,
    specifiedRules: [{ id: "r1", ruleType: "ng_word", pattern: "必ず成功" }],
    diversityGuidance: {
      axisLabel: "速度",
      axisInstruction: "制作を速く",
      avoidCopies: Array.from({ length: 20 }, (_, index) => ({
        candidateIdentity: `candidate-${index}`,
        mainHook: `見出し${index}`,
        variationAxis: `軸${index}`,
        visualDirection: "ノートPCを囲むチーム".repeat(10)
      }))
    },
    copyBrief,
    copySlotPlan,
    generationContract,
    creativeHypothesis: { hypothesisId: "h1", primaryPromise: "早くする" },
    approvedClaimSnapshot: { snapshotId: "a1", contentHash: "x" }
  });
  const systemPrompt = (await fs.readFile(new URL("../config/prompts/banner.md", import.meta.url), "utf8")).trim();
  const totalChars = systemPrompt.length + prompt.length;

  assert.match(prompt, /# Stage2Input/);
  assert.equal((prompt.match(/# Stage2Input/g) || []).length, 1);
  assert.doesNotMatch(prompt, /# BannerGenerationContract|# 確定コピー|# コピー枠プラン|"templateZones"/);
  assert.match(prompt, /templateStructureContract/);
  assert.match(prompt, /selectedAssetPolicy/);
  assert.match(prompt, /creativeHypothesis/);
  assert.match(prompt, /approvedClaimSnapshotRef/);
  assert.ok(totalChars <= Math.floor(LEGACY_TOTAL_INPUT_CHARS * 0.7), `expected <= 70% of ${LEGACY_TOTAL_INPUT_CHARS}, got ${totalChars}`);
});
