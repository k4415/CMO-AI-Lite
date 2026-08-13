import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeBannerImagePrompt } from "../src/core/banner-image-prompt-writer.js";
import { buildSelectedAssetPlacementPlan } from "../src/core/openai-image.js";

const LONG_PROSE = [
  "視線は画面上部のメインビジュアルから入り、斜めの帯が左下の商品ゾーンへ誘導する。",
  "背景は朝の柔らかい側光を受けたテーブル面で、木目の質感と浅い被写界深度を使う。",
  "指定スロット内でのみ添付素材を見せ、他のimage枠には生成する被写体とシーンを置く。",
  "最大コピーは独立したオーバーレイ文字として浮かせ、素材表面への印字や刻印にはしない。",
  "配色は指定paletteの役割を守り、メインを布地の陰影、アクセントをCTA面の光沢で表現する。"
].join("");

assert.ok(LONG_PROSE.length >= 200);

const baseInput = () => ({
  promptJson: {
    basic: { size: "1080x1080" },
    zones: [{
      name: "hero",
      elements: [
        { type: "text", slotId: "headline", role: "headline" },
        { type: "image", slotId: "product-shot", role: "product" }
      ]
    }]
  },
  product: { id: "p1", name: "テスト和菓子" },
  strategy: { id: "s1", targetAttributes: "贈答を急ぐ人", benefit: "当日中に届けられる" },
  copyBrief: {
    slotTexts: [
      { slotId: "headline", text: "今朝届く贈答" },
      { slotId: "cta", text: "今すぐ見る" }
    ]
  },
  colorDecision: {
    palette: { main: "#7A1F1F", sub: "#F7E7C6", accent: "#C45C26", background: "#FFF8EE" }
  },
  templateStructureContract: { closed: true, zoneCount: 1 },
  selectedAssetPlacements: [
    { ordinal: 1, role: "product", slotId: "product-shot", fallback: false }
  ],
  instructionPolicy: { changeScope: "visual_only" },
  diversityGuidance: { axisLabel: "シーン" }
});

test("buildSelectedAssetPlacementPlanがexportされ、image枠へ素材を割り当てる", () => {
  const plan = buildSelectedAssetPlacementPlan(
    [{ elements: [{ type: "image", slotId: "shot-1", role: "product" }] }],
    [{ role: "product", ordinal: 1 }]
  );
  assert.deepEqual(plan, [{
    ordinal: 1,
    role: "product",
    slotId: "shot-1",
    fallback: false
  }]);
});

test("ライターは既定でclaude-opus-5を明示指定し、散文とstyleNotesを返す", async () => {
  const calls = [];
  const result = await writeBannerImagePrompt({
    ...baseInput(),
    jsonGenerator: async (args) => {
      calls.push(args);
      return { writtenImagePrompt: LONG_PROSE, styleNotes: "朝の側光と木目の質感を優先する" };
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "claude-opus-5");
  assert.equal(result.writtenImagePrompt, LONG_PROSE);
  assert.equal(result.styleNotes, "朝の側光と木目の質感を優先する");
  assert.equal(result.writerAudit.model, "claude-opus-5");
  assert.equal(result.writerAudit.calls, 1);
  assert.ok(result.writerAudit.outputChars > 0);
  assert.equal(result.writerAudit.outcome, "completed");
  assert.equal(result.writerAudit.fallback, false);
});

test("CMOAI_PROMPT_WRITER_MODELが指定されていればそのモデルを使う", async () => {
  const previous = process.env.CMOAI_PROMPT_WRITER_MODEL;
  process.env.CMOAI_PROMPT_WRITER_MODEL = "claude-opus-4-8";
  try {
    const calls = [];
    await writeBannerImagePrompt({
      ...baseInput(),
      jsonGenerator: async (args) => {
        calls.push(args);
        return { writtenImagePrompt: LONG_PROSE, styleNotes: "質感メモ" };
      }
    });
    assert.equal(calls[0].model, "claude-opus-4-8");
  } finally {
    if (previous === undefined) delete process.env.CMOAI_PROMPT_WRITER_MODEL;
    else process.env.CMOAI_PROMPT_WRITER_MODEL = previous;
  }
});

test("確定コピーはwrittenImagePromptとstyleNotesの両方から行単位で除去する", async () => {
  const result = await writeBannerImagePrompt({
    ...baseInput(),
    jsonGenerator: async () => ({
      writtenImagePrompt: `${LONG_PROSE}\n見出しは「今朝届く贈答」を大きく置く`,
      styleNotes: "CTAは今すぐ見るのトーンで\n木目の質感を残す"
    })
  });

  assert.equal(result.writtenImagePrompt, LONG_PROSE);
  assert.equal(result.styleNotes, "木目の質感を残す");
  assert.doesNotMatch(result.writtenImagePrompt, /今朝届く贈答/);
  assert.doesNotMatch(result.styleNotes, /今すぐ見る/);
});

test("サニタイズ後に散文が200字未満なら失敗扱いになる", async () => {
  const result = await writeBannerImagePrompt({
    ...baseInput(),
    jsonGenerator: async () => ({
      writtenImagePrompt: "今朝届く贈答を大きく置く短い描写",
      styleNotes: "今すぐ見る"
    })
  });

  assert.equal(result.writtenImagePrompt, "");
  assert.equal(result.styleNotes, "");
  assert.equal(result.writerAudit.outcome, "failed");
  assert.equal(result.writerAudit.fallback, true);
});

test("失敗時は1回リトライし、それでも失敗なら空文字とfallbackを返す", async () => {
  let attempts = 0;
  const result = await writeBannerImagePrompt({
    ...baseInput(),
    jsonGenerator: async () => {
      attempts += 1;
      throw new Error("writer down");
    }
  });

  assert.equal(attempts, 2);
  assert.equal(result.writtenImagePrompt, "");
  assert.equal(result.styleNotes, "");
  assert.equal(result.writerAudit.calls, 2);
  assert.equal(result.writerAudit.outcome, "failed");
  assert.equal(result.writerAudit.fallback, true);
});

test("1回目失敗後のリトライ成功ではcompletedになりfallbackしない", async () => {
  let attempts = 0;
  const result = await writeBannerImagePrompt({
    ...baseInput(),
    jsonGenerator: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient");
      return { writtenImagePrompt: LONG_PROSE, styleNotes: "質感メモ" };
    }
  });

  assert.equal(attempts, 2);
  assert.equal(result.writtenImagePrompt, LONG_PROSE);
  assert.equal(result.writerAudit.calls, 2);
  assert.equal(result.writerAudit.outcome, "completed");
  assert.equal(result.writerAudit.fallback, false);
});

test("監査アダプタはmodel/calls/outputChars/outcome/fallbackを記録する", async () => {
  const result = await writeBannerImagePrompt({
    ...baseInput(),
    jsonGenerator: async () => ({ writtenImagePrompt: LONG_PROSE, styleNotes: "質感メモ" })
  });
  assert.deepEqual(Object.keys(result.writerAudit).sort(), [
    "calls",
    "fallback",
    "model",
    "outcome",
    "outputChars"
  ]);
  assert.equal(typeof result.writerAudit.outputChars, "number");
  assert.ok(result.writerAudit.outputChars >= LONG_PROSE.length);
});

test("ライタープロンプトに構造継承・コピー禁止・placement限定・印字禁止・被写体再解釈がある", () => {
  const promptPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "config",
    "prompts",
    "banner-image-prompt-writer.md"
  );
  const prompt = fs.readFileSync(promptPath, "utf8");
  assert.match(prompt, /アートディレクター/);
  assert.match(prompt, /コピーの文言そのものは一切書かない|コピー文言を書かない|文言そのものは一切書かない/);
  assert.match(prompt, /選択素材|selectedAssetPlacements|配置マップ/);
  assert.match(prompt, /独立したオーバーレイ|印字|刻印/);
  assert.match(prompt, /被写体.*再解釈|無関係な被写体/);
  assert.match(prompt, /図形コンテナ|吹き出し/);
});
