import test from "node:test";
import assert from "node:assert/strict";

import { generateBannerCreativeProposal } from "../src/core/banner-ai.js";

const LONG_PROSE = [
  "視線は画面上部のメインビジュアルから入り、斜めの帯が左下の商品ゾーンへ誘導する。",
  "背景は朝の柔らかい側光を受けたテーブル面で、木目の質感と浅い被写界深度を使う。",
  "指定スロット内でのみ添付素材を見せ、他のimage枠には生成する被写体とシーンを置く。"
].join("");

const copyBrief = {
  version: 3,
  strategyId: "strategy-1",
  appealAxis: "速度",
  whyItStops: "所要時間が短く具体的に伝わるため",
  mainHook: "3分で広告案",
  slotTexts: [{ slotId: "headline", text: "3分で広告案" }]
};

const closedTemplate = {
  id: "template-1",
  copyBlueprint: {
    slots: [{ slotId: "headline", role: "headline", canonicalField: "mainHook", charBudget: 12 }]
  },
  templateZones: [{
    position: "top",
    purpose: "hook",
    elements: [
      { type: "text", slotId: "headline", role: "headline", content: "旧コピー" },
      { type: "image", slotId: "product-shot", role: "product" }
    ]
  }]
};

function writerSuccess(overrides = {}) {
  return {
    writtenImagePrompt: LONG_PROSE,
    styleNotes: "朝の側光と木目の質感",
    writerAudit: {
      model: "claude-opus-5",
      calls: 1,
      outputChars: LONG_PROSE.length,
      outcome: "completed",
      fallback: false
    },
    ...overrides
  };
}

test("閉じたテンプレはpromptJson確定後にライターを呼び、配置マップを渡す", async () => {
  const writerCalls = [];
  let designCalls = 0;
  const proposal = await generateBannerCreativeProposal({
    banner: {
      id: "banner-1",
      imageSize: "1080x1080",
      productImagePaths: ["assets/product.png"]
    },
    product: { id: "product-1", name: "広告改善AI" },
    strategy: { id: "strategy-1", conceptName: "制作時間を短縮", benefit: "検証案を早く増やせる" },
    template: closedTemplate,
    copyBrief,
    jsonGenerator: async () => {
      designCalls += 1;
      throw new Error("closed template must not call Stage 2a model");
    },
    promptWriter: async (args) => {
      writerCalls.push(args);
      return writerSuccess();
    }
  });

  assert.equal(designCalls, 0);
  assert.equal(writerCalls.length, 1);
  assert.ok(Array.isArray(writerCalls[0].selectedAssetPlacements));
  assert.ok(writerCalls[0].promptJson?.zones?.length > 0);
  assert.equal(proposal.writtenImagePrompt, LONG_PROSE);
  assert.equal(proposal.styleNotes, "朝の側光と木目の質感");
  assert.equal(proposal.promptGenerationAudit.model, "deterministic-template-compiler-v1");
  assert.deepEqual(proposal.promptGenerationAudit.writer, writerSuccess().writerAudit);
});

test("開いたテンプレは既存designの後にライターを呼び、audit.writerを残す", async () => {
  const writerCalls = [];
  const proposal = await generateBannerCreativeProposal({
    banner: { id: "banner-open", imageSize: "1080x1080" },
    product: { id: "product-1", name: "商品" },
    strategy: { id: "strategy-1", markdown: "制作を速めたい" },
    template: null,
    copyBrief: {
      ...copyBrief,
      subHook: "次の検証へ",
      slotTexts: [
        { slotId: "default-mainHook", text: "制作を止めない" },
        { slotId: "default-subHook", text: "次の検証へ" }
      ]
    },
    jsonGenerator: async ({ onAttempt, onResult }) => {
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
    },
    promptWriter: async (args) => {
      writerCalls.push(args);
      return writerSuccess({
        writerAudit: {
          model: "claude-opus-5",
          calls: 1,
          outputChars: 410,
          outcome: "completed",
          fallback: false
        }
      });
    }
  });

  assert.equal(writerCalls.length, 1);
  assert.equal(proposal.promptGenerationAudit.model, "test-model");
  assert.equal(proposal.promptGenerationAudit.modelDesignCalls, 1);
  assert.equal(proposal.promptGenerationAudit.writer.model, "claude-opus-5");
  assert.equal(proposal.promptGenerationAudit.writer.outputChars, 410);
  assert.equal(proposal.promptGenerationAudit.writer.fallback, false);
  assert.equal(proposal.writtenImagePrompt, LONG_PROSE);
});

test("ライター失敗時はwrittenImagePromptを空文字で返しnullやundefinedにしない", async () => {
  const proposal = await generateBannerCreativeProposal({
    banner: { id: "banner-1", imageSize: "1080x1080" },
    product: { id: "product-1", name: "広告改善AI" },
    strategy: { id: "strategy-1", benefit: "検証案を早く増やせる" },
    template: closedTemplate,
    copyBrief,
    promptWriter: async () => ({
      writtenImagePrompt: "",
      styleNotes: "",
      writerAudit: {
        model: "claude-opus-5",
        calls: 2,
        outputChars: 0,
        outcome: "failed",
        fallback: true
      }
    })
  });

  assert.equal(proposal.writtenImagePrompt, "");
  assert.equal(proposal.styleNotes, "");
  assert.equal(Object.prototype.hasOwnProperty.call(proposal, "writtenImagePrompt"), true);
  assert.notEqual(proposal.writtenImagePrompt, null);
  assert.notEqual(proposal.writtenImagePrompt, undefined);
  assert.equal(proposal.promptGenerationAudit.writer.fallback, true);
  assert.equal(proposal.promptGenerationAudit.writer.outcome, "failed");
});

test("ライターフォールバック時はreviewNotesに再試行案内を追記する", async () => {
  const proposal = await generateBannerCreativeProposal({
    banner: { id: "banner-1", imageSize: "1080x1080" },
    product: { id: "product-1", name: "広告改善AI" },
    strategy: { id: "strategy-1", benefit: "検証案を早く増やせる" },
    template: closedTemplate,
    copyBrief,
    promptWriter: async () => ({
      writtenImagePrompt: "",
      styleNotes: "",
      writerAudit: {
        model: "claude-opus-5",
        calls: 2,
        outputChars: 0,
        outcome: "failed",
        fallback: true,
        attempts: [
          { attempt: 1, durationMs: 10, ok: false, errorClass: "api_error", outputChars: 0 },
          { attempt: 2, durationMs: 12, ok: false, errorClass: "api_error", outputChars: 0 }
        ]
      }
    })
  });

  assert.match(
    proposal.reviewNotes,
    /画像プロンプトライターが失敗したため旧方式プロンプトで生成（次回の画像生成時に自動再試行）/
  );
});
