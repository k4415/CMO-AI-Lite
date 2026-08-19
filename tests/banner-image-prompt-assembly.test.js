import test from "node:test";
import assert from "node:assert/strict";

import {
  buildBannerImagePrompt,
  buildBannerImageRecoveryPrompt,
  buildBannerLogoRecoveryPrompt
} from "../src/core/openai-image.js";

const SAMPLE_PROSE = [
  "形式：1080x1080の正方形広告バナー。",
  "目的・戦略：朝の贈答シーンで便益を一瞬で伝える。",
  "スタイル・トーン：木目と側光で上質な和菓子感。",
  "視線は上部から入り、斜めの帯が商品ゾーンへ誘導する。独立したオーバーレイ文字だけを使う。木目のテーブルと朝の側光で質感を出す。"
].join("\n");
const LONG_PROSE = SAMPLE_PROSE.repeat(400);
const COPY_LINE = "今朝届く贈答だけを描く";
const PALETTE = { main: "#7A1F1F", sub: "#F7E7C6", accent: "#C45C26", background: "#FFF8EE" };

function bannerWithProse(overrides = {}) {
  return {
    imageText: COPY_LINE,
    writtenImagePrompt: SAMPLE_PROSE,
    styleNotes: "朝の側光と木目の質感を優先する",
    promptJson: {
      productName: "テスト和菓子",
      basic: { size: "1080x1080" },
      colorScheme: PALETTE,
      templateStructureContract: {
        closed: true,
        zoneCount: 1,
        elementCount: 2,
        typeCounts: { text: 1, image: 1, shape: 0 },
        zones: [{ elements: [{ slotId: "headline", type: "text", role: "headline" }] }]
      },
      zones: [{
        name: "hero",
        elements: [
          { type: "text", slotId: "headline", role: "headline", content: COPY_LINE },
          { type: "image", slotId: "product-shot", role: "product" }
        ]
      }],
      globalDesign: { mood: "legacy-json-dump-marker" }
    },
    ...overrides
  };
}

const productInput = [{ role: "product", ordinal: 1, fileName: "01-product-icon.png", path: "assets/icon.png" }];

test("writtenImagePromptがある初回組み立ては散文先頭と末尾契約を併用する", () => {
  const prompt = buildBannerImagePrompt(bannerWithProse(), productInput);
  assert.match(prompt, /^形式：/);
  assert.match(prompt, /デザイン意図/);
  assert.match(prompt, /バナー内テキスト:/);
  assert.match(prompt, new RegExp(COPY_LINE));
  assert.match(prompt, /【最終優先・確定コピー】/);
  assert.match(prompt, /Exclusive placement map/);
  assert.match(prompt, /#7A1F1F/);
  assert.doesNotMatch(prompt, /legacy-json-dump-marker/);
  assert.doesNotMatch(prompt, /【デザイン完成イメージ】/);
  assert.ok(prompt.indexOf("形式：") < prompt.indexOf("日本語のダイレクト広告バナー"));
  assert.ok(prompt.indexOf("【最終優先・確定コピー】") > prompt.indexOf("ブランドカラー"));
  assert.ok(prompt.indexOf("【最優先・閉じた構造契約】") > prompt.indexOf("ブランドカラー"));
});

test("空のwrittenImagePromptは現行のJSONダンプ組み立てへフォールバックする", () => {
  const prompt = buildBannerImagePrompt(bannerWithProse({ writtenImagePrompt: "" }), productInput);
  assert.match(prompt, /グローバルデザイン:/);
  assert.match(prompt, /legacy-json-dump-marker/);
  assert.doesNotMatch(prompt, /【デザイン完成イメージ】/);
});

test("12,000文字clip後も確定コピー・placement map・配色が完全に残る", () => {
  const prompt = buildBannerImagePrompt(bannerWithProse({
    writtenImagePrompt: "あ".repeat(20000),
    styleNotes: "い".repeat(3000)
  }), productInput);

  assert.match(prompt, /^あ/);
  assert.match(prompt, /あ{100}/);
  assert.ok(prompt.length <= 12000, `prompt length ${prompt.length}`);
  assert.match(prompt, /【最終優先・確定コピー】/);
  assert.ok(prompt.includes(COPY_LINE));
  assert.match(prompt, /Exclusive placement map: attached image 1 -> image slot product-shot only/);
  assert.match(prompt, /#7A1F1F/);
  assert.match(prompt, /#F7E7C6/);
  assert.match(prompt, /#C45C26/);
  assert.match(prompt, /#FFF8EE/);
  assert.ok(!prompt.includes("あ".repeat(20000)));
  assert.ok(!prompt.includes("い".repeat(3000)));
});

test("決定論ブロックだけで12,000を超える場合は現行組み立てへフォールバックする", () => {
  const hugeCopy = "確定コピー巨大文".repeat(2000);
  const prompt = buildBannerImagePrompt(bannerWithProse({
    imageText: hugeCopy,
    writtenImagePrompt: LONG_PROSE
  }), productInput);
  assert.match(prompt, /グローバルデザイン:/);
  assert.doesNotMatch(prompt, /【デザイン完成イメージ】/);
  assert.ok(prompt.includes(hugeCopy));
});

test("通常リカバリは短縮構造を維持し、散文アセンブリを使わない", () => {
  const recovery = buildBannerImageRecoveryPrompt(bannerWithProse(), productInput);
  const main = buildBannerImagePrompt(bannerWithProse(), productInput);
  assert.match(recovery, /再生成専用/);
  assert.doesNotMatch(recovery, /【デザイン完成イメージ】/);
  assert.doesNotMatch(recovery, /^形式：/m);
  assert.match(main, /^形式：/);
  assert.ok(recovery.length < 6000);
});

test("ロゴリカバリは特化構造を維持し、散文アセンブリを使わない", () => {
  const recovery = buildBannerLogoRecoveryPrompt(bannerWithProse(), [
    { role: "current-banner", ordinal: 1, fileName: "current.png", path: "outputs/current.png" },
    { role: "brand-logo", ordinal: 2, fileName: "logo.png", path: "assets/logo.png", logoIdentity: { officialWordmark: "Sample Smile" } }
  ], [1]);
  assert.match(recovery, /ロゴ特化編集/);
  assert.doesNotMatch(recovery, /【デザイン完成イメージ】/);
  assert.ok(recovery.length < 4000);
});
