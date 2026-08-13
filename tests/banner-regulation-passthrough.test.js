import test from "node:test";
import assert from "node:assert/strict";

import { generateBannerCreativeProposal } from "../src/core/banner-ai.js";
import { writeBannerImagePrompt } from "../src/core/banner-image-prompt-writer.js";

const LONG_PROSE = "視線は画面上部のメインビジュアルから入り、斜めの帯が左下の商品ゾーンへ誘導する。".repeat(8);

const writerBase = {
  promptJson: { basic: { size: "1080x1080" }, zones: [] },
  product: { id: "prod_1", name: "テスト美容液" },
  strategy: { id: "s1", markdown: "## WHO\n30代。" },
  copyBrief: { slotTexts: [] },
  colorDecision: {
    palette: { main: "#041024", sub: "#2460F0", accent: "#FFFFFF", background: "#041024" }
  },
  templateStructureContract: {},
  selectedAssetPlacements: [],
  instructionPolicy: {},
  diversityGuidance: {}
};

const regulationRules = [
  { id: "ng-item", description: "成果保証や煽りコピーにOrange/Redを使う。", createdAt: "2026-08-13T12:00:00.000Z", active: true, productId: "prod_1" },
  { id: "palette", description: "このパレットはCMO AI Liteの公式ブランドカラーである。", createdAt: "2026-08-13T10:00:00.000Z", active: true, productId: "prod_1" },
  { id: "ng-heading", description: "組み合わせNG:", createdAt: "2026-08-13T11:00:00.000Z", active: true, productId: "prod_1" },
  { id: "inactive", description: "無効ルールは渡さない", createdAt: "2026-08-13T09:00:00.000Z", active: false, productId: "prod_1" },
  { id: "other-product", description: "他商品のルールは渡さない", createdAt: "2026-08-13T09:30:00.000Z", active: true, productId: "prod_other" }
];

async function captureWriterUser(input) {
  let user = "";
  await writeBannerImagePrompt({
    ...writerBase,
    ...input,
    jsonGenerator: async (args) => {
      user = String(args.user || "");
      return { writtenImagePrompt: LONG_PROSE, styleNotes: "質感メモ" };
    }
  });
  return user;
}

test("ライター入力にレギュレーション全文がcreatedAt昇順で含まれる", async () => {
  const user = await captureWriterUser({ expressionRules: regulationRules });

  assert.match(user, /表現レギュレーション（原文・記載順。見出しと配下項目の関係を読み取ること）:/);
  const start = user.indexOf("このパレットはCMO AI Liteの公式ブランドカラーである。");
  const mid = user.indexOf("組み合わせNG:");
  const end = user.indexOf("成果保証や煽りコピーにOrange/Redを使う。");
  assert.ok(start >= 0 && mid > start && end > mid);
});

test("無効ルールと他商品ルールはライター入力から除外される", async () => {
  const user = await captureWriterUser({ expressionRules: regulationRules });

  assert.doesNotMatch(user, /無効ルールは渡さない/);
  assert.doesNotMatch(user, /他商品のルールは渡さない/);
});

test("ライターへ渡す色リストは役割別HEXではなく重複排除される", async () => {
  const user = await captureWriterUser({ expressionRules: [] });

  assert.match(user, /ブランドカラー（この範囲で構成する）: #041024 \/ #2460F0 \/ #FFFFFF/);
  assert.doesNotMatch(user, /配色palette:/);
  assert.doesNotMatch(user, /"main":"#041024"/);
});

test("generateBannerCreativeProposalは生のexpressionRulesをライターへ流す", async () => {
  let captured = null;
  const template = {
    id: "template-passthrough",
    copyBlueprint: {
      slots: [{ slotId: "headline", role: "headline", canonicalField: "mainHook", charBudget: 12 }]
    },
    templateZones: [{
      position: "top",
      purpose: "hook",
      elements: [{ type: "text", slotId: "headline", role: "headline", content: "旧コピー" }]
    }]
  };

  await generateBannerCreativeProposal({
    banner: { id: "banner-passthrough", imageSize: "1080x1080" },
    product: { id: "prod_1", name: "テスト美容液" },
    strategy: { id: "strategy-1", markdown: "## WHO\n30代。" },
    template,
    expressionRules: regulationRules,
    copyBrief: {
      version: 3,
      strategyId: "strategy-1",
      appealAxis: "実感",
      whyItStops: "乾燥の悩みに直結するため",
      mainHook: "うるおい実感",
      slotTexts: [{ slotId: "headline", text: "うるおい実感" }]
    },
    promptWriter: async (input) => {
      captured = input;
      return {
        writtenImagePrompt: LONG_PROSE,
        styleNotes: "質感メモ",
        writerAudit: { model: "stub", calls: 1, outputChars: 300, outcome: "completed", fallback: false }
      };
    }
  });

  assert.ok(Array.isArray(captured.expressionRules));
  assert.equal(captured.expressionRules.length, regulationRules.length);
  assert.equal(captured.expressionRules[0].id, "ng-item");
  assert.ok(captured.expressionRules.some((rule) => rule.description === "組み合わせNG:"));
});
