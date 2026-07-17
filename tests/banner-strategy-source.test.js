import test from "node:test";
import assert from "node:assert/strict";

import { buildBannerDesignPrompt, normalizeBannerProposal, prepareBannerGenerationContext } from "../src/core/banner-ai.js";

test("Stage 2 promptはfactsを受け取らず事実DBを参照しない", () => {
  const prompt = buildBannerDesignPrompt({
    banner: { factCheck: { note: "旧事実チェック内容" }, unrelated: "不要なバナー内部値" },
    product: { id: "prod_1", name: "商品", shortDescription: "商品マスター由来のコピー素材にしてはいけない説明" },
    strategy: { id: "str_1", markdown: "選択WHO-WHAT" },
    template: null,
    facts: [{ content: "バナーへ渡してはいけない事実" }],
    specifiedRules: [],
    copyBrief: testBrief(),
    copySlotPlan: null
  });

  assert.doesNotMatch(prompt, /バナーへ渡してはいけない事実|旧事実チェック内容|商品マスター由来のコピー素材にしてはいけない説明|事実DB|facts|factCheck/);
  assert.match(prompt, /選択WHO-WHAT/);
});

test("banner AI input excludes brandColor but preserves brandTone", () => {
  const context = prepareBannerGenerationContext(
    { id: "product-1", name: "商品", brandColor: "#ff0000", brandTone: "上品で静か", shortDescription: "コピー素材にしない説明" },
    {}
  );

  assert.equal(Object.hasOwn(context.product, "brandColor"), false);
  assert.equal(context.product.brandTone, "上品で静か");
  assert.equal(Object.hasOwn(context.product, "shortDescription"), false);
});

test("strategy markdown is the source of truth and conflicting structured fields are excluded", () => {
  const context = prepareBannerGenerationContext({}, {
    id: "strategy-1",
    conceptName: "編集後の戦略",
    markdown: "## ターゲット\n新しいターゲット\n## オファー\n新しいオファー",
    targetAttributes: "古いターゲット",
    benefit: "古い便益",
    offer: "古いオファー"
  });

  assert.equal(context.strategy.sourceMode, "markdown");
  assert.match(context.strategy.markdown, /新しいターゲット/);
  assert.equal(Object.hasOwn(context.strategy, "targetAttributes"), false);
  assert.equal(Object.hasOwn(context.strategy, "benefit"), false);
  assert.equal(Object.hasOwn(context.strategy, "offer"), false);
});

test("normalization never restores conflicting structured values when markdown exists", () => {
  const context = prepareBannerGenerationContext(
    { name: "商品", brandTone: "親しみやすい" },
    {
      conceptName: "編集後の戦略",
      markdown: "## ターゲット\n新しいターゲット",
      targetAttributes: "古いターゲット",
      benefit: "古い便益",
      offer: "古いオファー"
    }
  );
  const proposal = normalizeBannerProposal(
    { promptJson: { zones: [] } },
    { banner: { imageSize: "1080x1080" }, product: context.product, strategy: context.strategy, template: null, copyBrief: testBrief() }
  );

  assert.equal(proposal.promptJson.target, "");
  assert.equal(proposal.promptJson.benefit, "");
  assert.equal(proposal.promptJson.offer, "");
  assert.equal(proposal.promptJson.globalDesign.tone, "親しみやすい");
  assert.doesNotMatch(JSON.stringify(proposal), /古いターゲット|古い便益|古いオファー/);
});

test("markdown戦略からAIが生成した訴求要素を最終画像プロンプトへ保持する", () => {
  const context = prepareBannerGenerationContext({}, { markdown: "## ターゲット\n新しいターゲット" });
  const proposal = normalizeBannerProposal(
    { promptJson: { zones: [], target: "AI抽出ターゲット", desire: "AI抽出欲求", benefit: "AI抽出便益", offer: "AI抽出オファー" } },
    { banner: {}, product: context.product, strategy: context.strategy, template: null, copyBrief: testBrief() }
  );

  assert.equal(proposal.promptJson.target, "AI抽出ターゲット");
  assert.equal(proposal.promptJson.desire, "AI抽出欲求");
  assert.equal(proposal.promptJson.benefit, "AI抽出便益");
  assert.equal(proposal.promptJson.offer, "AI抽出オファー");
});

test("legacy strategies without markdown keep structured fallback", () => {
  const context = prepareBannerGenerationContext({}, {
    targetAttributes: "既存ターゲット",
    benefit: "既存便益",
    offer: "既存オファー"
  });
  const proposal = normalizeBannerProposal(
    { promptJson: { zones: [] } },
    { banner: {}, product: context.product, strategy: context.strategy, template: null, copyBrief: testBrief() }
  );

  assert.equal(context.strategy.sourceMode, "structured_fallback");
  assert.equal(proposal.promptJson.target, "既存ターゲット");
  assert.equal(proposal.promptJson.benefit, "既存便益");
  assert.equal(proposal.promptJson.offer, "既存オファー");
});

function testBrief() {
  return {
    appealAxis: "テスト軸",
    mainHook: "一瞬で伝わる見出し",
    subHook: "根拠から選べる",
    cta: "詳しく見る",
    whyItStops: "短く具体的"
  };
}
