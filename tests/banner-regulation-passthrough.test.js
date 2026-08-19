import test from "node:test";
import assert from "node:assert/strict";

import { generateBannerCreativeProposal } from "../src/core/banner-ai.js";
import { writeBannerImagePrompt } from "../src/core/banner-image-prompt-writer.js";
import { buildBannerImagePrompt } from "../src/core/openai-image.js";

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

  assert.match(user, /カラーアンカー: #041024 \/ #2460F0 \/ #FFFFFF/);
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

function assemblyBanner(overrides = {}) {
  return {
    id: "banner-color-list",
    imageSize: "1080x1080",
    imageText: "うるおい実感",
    writtenImagePrompt: "視線順に沿った完成イメージの散文。".repeat(20),
    styleNotes: "柔らかい側光",
    promptJson: {
      productName: "テスト美容液",
      basic: { size: "1080x1080" },
      zones: [{ name: "Z1", position: "top", purpose: "hook", elements: [{ type: "text", slotId: "headline", role: "headline", content: "うるおい実感" }] }],
      colorScheme: {
        main: "#041024",
        sub: "#2460F0",
        accent: "#FFFFFF",
        background: "#041024",
        usage: { main: "見出し・本文", sub: "補助情報", accent: "CTA・バッジ", background: "各zoneの背景" }
      },
      colorContract: { status: "passed" },
      globalDesign: { mood: "legacy-json-dump-marker" }
    },
    colorDecision: { palette: { main: "#041024", sub: "#2460F0", accent: "#FFFFFF", background: "#041024" } },
    ...overrides
  };
}

const FALLBACK_PROMPT_SNAPSHOT = `日本語のダイレクト広告バナーを制作してください。
モデルはgpt-image-2を使用しています。
画像内テキストは後処理で合成せず、画像生成時点で自然に配置してください。
ただし日本語は読みやすさを最優先し、文字化け、崩れ、重なり、切れを避けてください。
基本仕様: {"size":"1080x1080"}
商品: テスト美容液
戦略名: 
目的: 広告クリック率を高める
ターゲット: 
欲求: 
ベネフィット: 
オファー: 
バナー内テキスト:
うるおい実感
構造シート:
グローバルデザイン:
{
  "mood": "legacy-json-dump-marker"
}
配色設計:
{
  "main": "#16243A",
  "sub": "#C7A96B",
  "accent": "#9E2430",
  "background": "#F7F2E8",
  "usage": {
    "main": "見出し・本文",
    "sub": "補助情報",
    "accent": "CTA・バッジ",
    "background": "各zoneの背景"
  }
}
ゾーン別レイアウト指示:
Zone 1: Z1
Position: top
Purpose: hook
Elements:
- text / slot: headline / role: headline; exact content: うるおい実感
参照画像指示:
禁止事項:
【最終優先・確定コピー】画像内に描く文字は「バナー内テキスト」に列挙した行だけに限定する。空欄text slotを推測で補完しない。テンプレのpurpose・role・見本も文字の根拠にしない。列挙されていない注釈、限定、終了、CTA、商品名を追加しない。
最終品質条件: 余白を確保し、視線誘導を明確にし、CTAを読みやすく目立たせる。効果保証や医療的治療断定は避ける。`;

test("散文アセンブリの配色ブロックは重複排除した色リストで役割別HEXが無い", () => {
  const prompt = buildBannerImagePrompt(assemblyBanner(), []);
  assert.match(prompt, /カラーアンカー: #041024 \/ #2460F0 \/ #FFFFFF/);
  assert.match(prompt, /アンカー色から派生する範囲で展開してよい/);
  assert.match(prompt, /アンカーと無関係な色を新たな主要色として導入しない/);
  assert.doesNotMatch(prompt, /確定配色:/);
  assert.doesNotMatch(prompt, /main=#/);
  assert.doesNotMatch(prompt, /background=#041024/);
  assert.doesNotMatch(prompt, /表現レギュレーション/);
});

test("フォールバック経路のプロンプトは従来と完全一致する", () => {
  const prompt = buildBannerImagePrompt(assemblyBanner({
    writtenImagePrompt: "",
    promptJson: {
      productName: "テスト美容液",
      basic: { size: "1080x1080" },
      zones: [{ name: "Z1", position: "top", purpose: "hook", elements: [{ type: "text", slotId: "headline", role: "headline", content: "うるおい実感" }] }],
      colorScheme: {
        main: "#16243A",
        sub: "#C7A96B",
        accent: "#9E2430",
        background: "#F7F2E8",
        usage: { main: "見出し・本文", sub: "補助情報", accent: "CTA・バッジ", background: "各zoneの背景" }
      },
      colorContract: { status: "passed" },
      globalDesign: { mood: "legacy-json-dump-marker" }
    },
    colorDecision: { palette: { main: "#16243A", sub: "#C7A96B", accent: "#9E2430", background: "#F7F2E8" } }
  }), []);
  assert.equal(prompt, FALLBACK_PROMPT_SNAPSHOT);
});
