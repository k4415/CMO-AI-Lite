import test from "node:test";
import assert from "node:assert/strict";

import { generateBannerCreativeProposal } from "../src/core/banner-ai.js";
import { buildBannerImagePrompt } from "../src/core/openai-image.js";

const template = {
  id: "template-regulation",
  copyBlueprint: {
    slots: [{ slotId: "headline", role: "headline", canonicalField: "mainHook", charBudget: 12 }]
  },
  templateZones: [{
    position: "top",
    purpose: "hook",
    elements: [{ type: "text", slotId: "headline", role: "headline", content: "旧コピー" }]
  }]
};

const copyBrief = {
  version: 3,
  strategyId: "strategy-1",
  appealAxis: "実感",
  whyItStops: "乾燥の悩みに直結するため",
  mainHook: "うるおい実感",
  slotTexts: [{ slotId: "headline", text: "うるおい実感" }]
};

const strategyMarkdown = "## WHO\n30代の乾燥肌。\n## WHAT\nシミが完全に消える体験を提供する。";

function proposalInput(promptWriter) {
  return {
    banner: { id: "banner-regulation", imageSize: "1080x1080" },
    product: { id: "product-1", name: "テスト美容液" },
    strategy: { id: "strategy-1", markdown: strategyMarkdown },
    template,
    expressionRules: [
      { id: "rule-1", ruleType: "NG", pattern: "完全に消える", replacement: "変化を実感しやすい", severity: "high", active: true }
    ],
    copyBrief,
    promptWriter
  };
}

test("NG表現レギュレーションはwrittenImagePromptとstyleNotesにも適用される", async () => {
  const proposal = await generateBannerCreativeProposal(proposalInput(async () => ({
    writtenImagePrompt: "画面中央に女性の横顔。肌のシミが完全に消える様子を明るい光で表現する。".repeat(6),
    styleNotes: "シミが完全に消える印象の柔らかいライティング。",
    writerAudit: { model: "stub", calls: 1, outputChars: 300, outcome: "completed", fallback: false }
  })));

  assert.doesNotMatch(proposal.writtenImagePrompt, /完全に消える/);
  assert.doesNotMatch(proposal.styleNotes, /完全に消える/);
  assert.match(proposal.writtenImagePrompt, /変化を実感しやすい/);
  assert.ok(proposal.regulationCheck.hits.some((hit) => hit.scope === "writtenImagePrompt"));
});

test("ライターへ戦略markdownを渡す", async () => {
  let captured = null;
  await generateBannerCreativeProposal(proposalInput(async (input) => {
    captured = input;
    return {
      writtenImagePrompt: "視線順に沿った完成イメージの散文。".repeat(20),
      styleNotes: "柔らかい側光",
      writerAudit: { model: "stub", calls: 1, outputChars: 300, outcome: "completed", fallback: false }
    };
  }));

  assert.equal(captured.strategy.markdown, strategyMarkdown);
});

test("散文アセンブリの配色ブロックは色リストで渡し役割別HEXを書かない", async () => {
  const banner = {
    id: "banner-color",
    imageSize: "1080x1080",
    imageText: "うるおい実感",
    writtenImagePrompt: "視線順に沿った完成イメージの散文。".repeat(20),
    styleNotes: "柔らかい側光",
    promptJson: {
      basic: { size: "1080x1080" },
      zones: [{ name: "Z1", position: "top", purpose: "hook", elements: [{ type: "text", slotId: "headline", role: "headline", content: "うるおい実感" }] }],
      colorScheme: {
        main: "#16243A",
        sub: "#C7A96B",
        accent: "#9E2430",
        background: "#F7F2E8",
        usage: { main: "見出し・本文", sub: "補助情報", accent: "CTA・バッジ", background: "各zoneの背景" }
      },
      colorContract: { status: "passed" }
    },
    colorDecision: { palette: { main: "#16243A", sub: "#C7A96B", accent: "#9E2430", background: "#F7F2E8" } }
  };

  const prompt = buildBannerImagePrompt(banner, []);
  assert.match(prompt, /ブランドカラー（この4色で構成する）: #16243A \/ #C7A96B \/ #9E2430 \/ #F7F2E8/);
  assert.match(prompt, /文字と背景のコントラストを必ず確保する。palette外の色を主要色に使わない。/);
  assert.doesNotMatch(prompt, /確定配色:/);
  assert.doesNotMatch(prompt, /main=#16243A/);
  assert.doesNotMatch(prompt, /accent=#9E2430\(CTA・バッジ\)/);
});
