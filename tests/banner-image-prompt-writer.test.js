import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeBannerImagePrompt } from "../src/core/banner-image-prompt-writer.js";
import { buildSelectedAssetPlacementPlan } from "../src/core/openai-image.js";
import { PIPELINE_POLICY_VERSIONS } from "../src/core/banner-pipeline-state.js";

const WRITER_HEADER_LINES = [
  "形式：1080x1080の正方形広告バナー。",
  "目的・戦略：贈答を急ぐ人の不安を解消し、当日中に届く安心感から購入を促す。",
  "スタイル・トーン：温かみのある幸福感と華やかさを、木目と朝光で表現する。"
];

const LONG_PROSE_BODY = [
  "視線は画面上部のメインビジュアルから入り、斜めの帯が左下の商品ゾーンへ誘導する。",
  "背景は朝の柔らかい側光を受けたテーブル面で、木目の質感と浅い被写界深度を使う。",
  "指定スロット内でのみ添付素材を見せ、他のimage枠には生成する被写体とシーンを置く。",
  "最大コピーは独立したオーバーレイ文字として浮かせ、素材表面への印字や刻印にはしない。",
  "配色は指定paletteの役割を守り、メインを布地の陰影、アクセントをCTA面の光沢で表現する。"
].join("");

const LONG_PROSE = [...WRITER_HEADER_LINES, LONG_PROSE_BODY].join("\n");
const LONG_PROSE_WITHOUT_HEADERS = LONG_PROSE_BODY;

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

test("ライターは既定でclaude-sonnet-5を明示指定し、散文とstyleNotesを返す", async () => {
  const calls = [];
  const result = await writeBannerImagePrompt({
    ...baseInput(),
    jsonGenerator: async (args) => {
      calls.push(args);
      return { writtenImagePrompt: LONG_PROSE, styleNotes: "朝の側光と木目の質感を優先する" };
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "claude-sonnet-5");
  assert.equal(result.writtenImagePrompt, LONG_PROSE);
  assert.equal(result.styleNotes, "朝の側光と木目の質感を優先する");
  assert.equal(result.writerAudit.model, "claude-sonnet-5");
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

test("3行ヘッダー行はコピー混入があってもサニタイズで除去しない", async () => {
  const headerWithCopyPhrase = [
    "形式：1080x1080の正方形広告バナー。",
    "目的・戦略：今朝届く贈答という訴求軸で、贈答を急ぐ人の行動を促す。",
    "スタイル・トーン：今すぐ見るCTAのトーンに合わせた高揚感を与える。"
  ].join("\n");
  const proseWithHeaders = `${headerWithCopyPhrase}\n${LONG_PROSE_BODY}`;
  const result = await writeBannerImagePrompt({
    ...baseInput(),
    jsonGenerator: async () => ({
      writtenImagePrompt: proseWithHeaders,
      styleNotes: "木目の質感を残す"
    })
  });

  assert.equal(result.writtenImagePrompt, proseWithHeaders);
  assert.match(result.writtenImagePrompt, /^形式：/m);
  assert.match(result.writtenImagePrompt, /^目的・戦略：/m);
  assert.match(result.writtenImagePrompt, /^スタイル・トーン：/m);
});

test("半角コロンの3行ヘッダーは合格する", async () => {
  const halfWidthHeaders = [
    "形式:1080x1080の正方形広告バナー。",
    "目的・戦略:贈答を急ぐ人の不安を解消し、当日中に届く安心感から購入を促す。",
    "スタイル・トーン:温かみのある幸福感と華やかさを、木目と朝光で表現する。"
  ].join("\n");
  const prose = `${halfWidthHeaders}\n${LONG_PROSE_BODY}`;
  const result = await writeBannerImagePrompt({
    ...baseInput(),
    jsonGenerator: async () => ({
      writtenImagePrompt: prose,
      styleNotes: "質感メモ"
    })
  });

  assert.equal(result.writtenImagePrompt, prose);
  assert.equal(result.writerAudit.outcome, "completed");
  assert.equal(result.writerAudit.fallback, false);
});

test("ヘッダー前に別の非空行がある場合は失敗扱いでリトライする", async () => {
  let attempts = 0;
  const result = await writeBannerImagePrompt({
    ...baseInput(),
    jsonGenerator: async () => {
      attempts += 1;
      return {
        writtenImagePrompt: `前置き行\n${LONG_PROSE}`,
        styleNotes: "質感メモ"
      };
    }
  });

  assert.equal(attempts, 2);
  assert.equal(result.writtenImagePrompt, "");
  assert.equal(result.writerAudit.outcome, "failed");
  assert.equal(result.writerAudit.fallback, true);
});

test("3行ヘッダー行の前後空白はtrimして判定する", async () => {
  const paddedHeaders = WRITER_HEADER_LINES.map((line) => `  ${line}  `).join("\n");
  const prose = `${paddedHeaders}\n${LONG_PROSE_BODY}`;
  const result = await writeBannerImagePrompt({
    ...baseInput(),
    jsonGenerator: async () => ({
      writtenImagePrompt: prose,
      styleNotes: "質感メモ"
    })
  });

  assert.equal(result.writerAudit.outcome, "completed");
  assert.equal(result.writerAudit.fallback, false);
  const headerLines = result.writtenImagePrompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3);
  assert.match(headerLines[0], /^形式[：:]/);
  assert.match(headerLines[1], /^目的・戦略[：:]/);
  assert.match(headerLines[2], /^スタイル・トーン[：:]/);
});

test("サニタイズ後に散文が200字未満なら失敗扱いになる", async () => {
  const result = await writeBannerImagePrompt({
    ...baseInput(),
    jsonGenerator: async () => ({
      writtenImagePrompt: [
        "形式：1080x1080の正方形広告バナー。",
        "目的・戦略：短い訴求。",
        "スタイル・トーン：短いトーン。",
        "今朝届く贈答を大きく置く短い描写"
      ].join("\n"),
      styleNotes: "今すぐ見る"
    })
  });

  assert.equal(result.writtenImagePrompt, "");
  assert.equal(result.styleNotes, "");
  assert.equal(result.writerAudit.outcome, "failed");
  assert.equal(result.writerAudit.fallback, true);
});

test("3行ヘッダー欠落時はリトライし、2回失敗なら空散文フォールバック", async () => {
  let attempts = 0;
  const result = await writeBannerImagePrompt({
    ...baseInput(),
    jsonGenerator: async () => {
      attempts += 1;
      return {
        writtenImagePrompt: LONG_PROSE_WITHOUT_HEADERS,
        styleNotes: "朝の側光と木目の質感を優先する"
      };
    }
  });

  assert.equal(attempts, 2);
  assert.equal(result.writtenImagePrompt, "");
  assert.equal(result.styleNotes, "");
  assert.equal(result.writerAudit.calls, 2);
  assert.equal(result.writerAudit.outcome, "failed");
  assert.equal(result.writerAudit.fallback, true);
});

test("1回目ヘッダー欠落後のリトライ成功ではcompletedになる", async () => {
  let attempts = 0;
  const result = await writeBannerImagePrompt({
    ...baseInput(),
    jsonGenerator: async () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          writtenImagePrompt: LONG_PROSE_WITHOUT_HEADERS,
          styleNotes: "質感メモ"
        };
      }
      return { writtenImagePrompt: LONG_PROSE, styleNotes: "質感メモ" };
    }
  });

  assert.equal(attempts, 2);
  assert.equal(result.writtenImagePrompt, LONG_PROSE);
  assert.equal(result.writerAudit.calls, 2);
  assert.equal(result.writerAudit.outcome, "completed");
  assert.equal(result.writerAudit.fallback, false);
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

test("監査アダプタはmodel/calls/outputChars/outcome/fallback/attemptsを記録する", async () => {
  const result = await writeBannerImagePrompt({
    ...baseInput(),
    jsonGenerator: async () => ({ writtenImagePrompt: LONG_PROSE, styleNotes: "質感メモ" })
  });
  assert.deepEqual(Object.keys(result.writerAudit).sort(), [
    "attempts",
    "calls",
    "fallback",
    "model",
    "outcome",
    "outputChars"
  ]);
  assert.equal(typeof result.writerAudit.outputChars, "number");
  assert.ok(result.writerAudit.outputChars >= LONG_PROSE.length);
  assert.equal(result.writerAudit.attempts.length, 1);
  assert.equal(result.writerAudit.attempts[0].attempt, 1);
  assert.equal(result.writerAudit.attempts[0].ok, true);
  assert.equal(result.writerAudit.attempts[0].errorClass, "");
});

test("API例外はerrorClass=api_errorでattemptsに記録する", async () => {
  const result = await writeBannerImagePrompt({
    ...baseInput(),
    jsonGenerator: async () => {
      throw new Error("writer down");
    }
  });

  assert.equal(result.writerAudit.attempts.length, 2);
  assert.equal(result.writerAudit.attempts[0].errorClass, "api_error");
  assert.equal(result.writerAudit.attempts[1].errorClass, "api_error");
  assert.equal(result.writerAudit.attempts[0].ok, false);
});

test("タイムアウトはerrorClass=timeoutで記録する", async () => {
  const result = await writeBannerImagePrompt({
    ...baseInput(),
    jsonGenerator: async () => {
      const error = new Error("Anthropicのコピー設計が時間内に完了しなかったため中断しました。再実行してください。");
      error.name = "TimeoutError";
      throw error;
    }
  });

  assert.equal(result.writerAudit.attempts[0].errorClass, "timeout");
});

test("JSONパース失敗はerrorClass=parse_errorで記録する", async () => {
  const result = await writeBannerImagePrompt({
    ...baseInput(),
    jsonGenerator: async () => {
      throw new Error("AI応答がJSON形式ではありませんでした。");
    }
  });

  assert.equal(result.writerAudit.attempts[0].errorClass, "parse_error");
});

test("ヘッダー欠落はerrorClass=header_missingで記録する", async () => {
  const result = await writeBannerImagePrompt({
    ...baseInput(),
    jsonGenerator: async () => ({
      writtenImagePrompt: LONG_PROSE_WITHOUT_HEADERS,
      styleNotes: "質感メモ"
    })
  });

  assert.equal(result.writerAudit.attempts.length, 2);
  assert.equal(result.writerAudit.attempts[0].errorClass, "header_missing");
  assert.equal(result.writerAudit.attempts[1].errorClass, "header_missing");
});

test("200字未満はerrorClass=too_shortで記録する", async () => {
  const result = await writeBannerImagePrompt({
    ...baseInput(),
    jsonGenerator: async () => ({
      writtenImagePrompt: [
        "形式：1080x1080の正方形広告バナー。",
        "目的・戦略：短い訴求。",
        "スタイル・トーン：短いトーン。",
        "今朝届く贈答を大きく置く短い描写"
      ].join("\n"),
      styleNotes: "今すぐ見る"
    })
  });

  assert.equal(result.writerAudit.attempts[0].errorClass, "too_short");
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

test("ライタープロンプトは色境界・コントラスト確保・見出しと配下の関係を指示する", () => {
  const promptPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "config",
    "prompts",
    "banner-image-prompt-writer.md"
  );
  const prompt = fs.readFileSync(promptPath, "utf8");
  assert.match(prompt, /カラーアンカー|アンカー色/);
  assert.match(prompt, /役割構造（どの要素が濃色・誘目色・背景か）/);
  assert.match(prompt, /コントラスト水準/);
  assert.match(prompt, /トーンの感情/);
  assert.match(prompt, /アンカー色からのトーン展開・素材感・商材を象徴する具体物のメタファー表現/);
  assert.match(prompt, /どの面にどの文字色/);
  assert.match(prompt, /コントラストを必ず確保/);
  assert.match(prompt, /組み合わせOK:|組み合わせNG:|推奨比率:/);
  assert.match(prompt, /見出し.*配下項目の関係|配下項目の関係を尊重/);
  assert.match(prompt, /NG側に列挙された配色・表現は採用しない/);
});

test("ライタープロンプトに3行ヘッダー契約と配色記述契約がある", () => {
  const promptPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "config",
    "prompts",
    "banner-image-prompt-writer.md"
  );
  const prompt = fs.readFileSync(promptPath, "utf8");
  assert.match(prompt, /形式：.*サイズと.*広告バナー/);
  assert.match(prompt, /目的・戦略：.*誰のどんな認識をどう変え.*行動をとってもらうか/);
  assert.match(prompt, /コピー文言は書かない/);
  assert.match(prompt, /スタイル・トーン：.*印象・トーン・色彩設計の意図/);
  assert.match(prompt, /確定パレットの色をどの役割（濃色・誘目色・背景）にどう使い分けるか/);
  assert.match(prompt, /選定理由を1文含める/);
  assert.match(prompt, /華やかさ・高揚感・幸福感・安心感/);
  assert.match(prompt, /落ち着き・信頼系に固定しない/);
});

test("PIPELINE_POLICY_VERSIONS.promptは5", () => {
  assert.equal(PIPELINE_POLICY_VERSIONS.prompt, 5);
});

test("ライター入力は戦略markdownを12000字まで渡す", async () => {
  const longTail = "末尾マーカー";
  const markdown = "あ".repeat(12050) + longTail;
  let capturedUser = "";
  await writeBannerImagePrompt({
    ...baseInput(),
    strategy: { id: "s-long", markdown },
    jsonGenerator: async (args) => {
      capturedUser = String(args.user || "");
      return { writtenImagePrompt: LONG_PROSE, styleNotes: "質感メモ" };
    }
  });

  const strategyLine = capturedUser.split("\n").find((line) => line.startsWith("戦略: "));
  assert.ok(strategyLine);
  const parsed = JSON.parse(strategyLine.slice("戦略: ".length));
  assert.equal(parsed.markdown.length, 12000);
  assert.doesNotMatch(parsed.markdown, /末尾マーカー/);
});

test("creativeHypothesis要点があるときは明示ブロックを追加する", async () => {
  let capturedUser = "";
  await writeBannerImagePrompt({
    ...baseInput(),
    creativeHypothesis: {
      chosenAngle: "当日配送",
      audienceAttribute: "贈答を急ぐ人",
      visualIntent: { scene: "朝の和室", motif: "木目の膳" }
    },
    jsonGenerator: async (args) => {
      capturedUser = String(args.user || "");
      return { writtenImagePrompt: LONG_PROSE, styleNotes: "質感メモ" };
    }
  });

  assert.match(capturedUser, /訴求仮説要点（creativeHypothesis）:/);
  assert.match(capturedUser, /"appealAxis":"当日配送"/);
  assert.match(capturedUser, /"scene":"朝の和室"/);
  assert.match(capturedUser, /"motif":"木目の膳"/);
  assert.match(capturedUser, /多様性方針:/);
});

test("creativeHypothesis要点が空のときはブロックを省略する", async () => {
  let capturedUser = "";
  await writeBannerImagePrompt({
    ...baseInput(),
    copyBrief: { slotTexts: baseInput().copyBrief.slotTexts },
    creativeHypothesis: { visualIntent: { scene: "", motif: "" } },
    jsonGenerator: async (args) => {
      capturedUser = String(args.user || "");
      return { writtenImagePrompt: LONG_PROSE, styleNotes: "質感メモ" };
    }
  });

  assert.doesNotMatch(capturedUser, /訴求仮説要点（creativeHypothesis）:/);
  assert.match(capturedUser, /多様性方針:/);
});
