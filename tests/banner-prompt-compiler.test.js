import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import { generateBannerCreativeProposal } from "../src/core/banner-ai.js";
import { compileClosedTemplatePromptSeed } from "../src/core/banner-prompt-compiler.js";
import { buildTemplateStructureContract, enforceTemplateStructure } from "../src/core/banner-template-structure.js";

test("閉じたテンプレはStage 2モデルを呼ばず確定コピーからpromptJsonを生成する", async () => {
  let modelCalls = 0;
  const proposal = await generateBannerCreativeProposal({
    banner: { id: "banner-1", imageSize: "1080x1080" },
    product: { id: "product-1", name: "広告改善AI" },
    strategy: {
      id: "strategy-1",
      conceptName: "制作時間を短縮",
      targetAttributes: "広告運用者",
      benefit: "検証案を早く増やせる"
    },
    template: {
      id: "template-1",
      copyBlueprint: {
        slots: [{ slotId: "headline", role: "headline", canonicalField: "mainHook", charBudget: 12 }]
      },
      templateZones: [{
        position: "top",
        purpose: "hook",
        elements: [{ type: "text", slotId: "headline", role: "headline", content: "旧コピー" }]
      }]
    },
    copyBrief: {
      version: 3,
      strategyId: "strategy-1",
      appealAxis: "速度",
      variationDirection: "所要時間を具体化",
      whyItStops: "所要時間が短く具体的に伝わるため",
      mainHook: "3分で広告案",
      slotTexts: [{ slotId: "headline", text: "3分で広告案" }]
    },
    creativeHypothesis: { visualIntent: { scene: "広告制作", motif: "速度" } },
    jsonGenerator: async () => {
      modelCalls += 1;
      throw new Error("closed template must not call Stage 2 model");
    }
  });

  assert.equal(modelCalls, 0);
  assert.equal(proposal.promptGenerationAudit.model, "deterministic-template-compiler-v1");
  assert.equal(proposal.promptGenerationAudit.modelDesignCalls, 0);
  assert.deepEqual(proposal.promptGenerationAudit.httpAttempts, []);
  assert.equal(proposal.promptJson.zones[0].elements[0].content, "3分で広告案");
  assert.equal(proposal.promptJson.zones[0].elements.length, 1);
});

test("決定論的promptも正本のWHO-WHAT markdownと案別variationを画像プロンプトへ残す", async () => {
  const proposal = await generateBannerCreativeProposal({
    banner: {
      id: "banner-2",
      imageSize: "1080x1080",
      additionalInstruction: "背景は白を基調にして、人物を追加しない"
    },
    product: { id: "product-1", name: "広告改善AI", brandTone: "明快で誠実" },
    strategy: {
      id: "strategy-2",
      conceptName: "締切前の制作短縮",
      segmentName: "複数案件を担当する広告運用者",
      markdown: "WHO: 複数案件の締切が重なる広告運用者\nWHAT: 検証用バナーを短時間で増やせる"
    },
    template: {
      id: "template-2",
      copyBlueprint: {
        slots: [{ slotId: "headline", role: "headline", canonicalField: "mainHook", charBudget: 16 }]
      },
      templateZones: [{
        position: "top",
        purpose: "hook",
        elements: [{ type: "text", slotId: "headline", role: "headline", content: "旧コピー" }]
      }]
    },
    copyBrief: {
      version: 3,
      strategyId: "strategy-2",
      appealAxis: "締切",
      variationDirection: "複数案件の切迫感を前に出す",
      whyItStops: "対象者の切迫した瞬間を具体化しているため",
      mainHook: "締切前でも10案",
      slotTexts: [{ slotId: "headline", text: "締切前でも10案" }]
    },
    creativeHypothesis: { visualIntent: { scene: "締切前の制作現場", motif: "複数案件" } },
    jsonGenerator: async () => { throw new Error("must not call"); }
  });

  assert.match(proposal.promptText, /WHO: 複数案件の締切が重なる広告運用者/);
  assert.match(proposal.promptText, /WHAT: 検証用バナーを短時間で増やせる/);
  assert.match(proposal.promptText, /複数案件の切迫感を前に出す/);
  assert.match(proposal.promptText, /背景は白を基調にして、人物を追加しない/);
  assert.equal(proposal.promptJson.additionalInstruction, "背景は白を基調にして、人物を追加しない");
});

test("閉じたテンプレは元広告のpurpose表層意味を新規画像へ持ち込まない", () => {
  const seed = compileClosedTemplatePromptSeed({
    banner: { imageSize: "1024x1024" },
    product: { name: "検証商品" },
    strategy: { benefit: "比較しやすい" },
    template: {
      templateZones: [{
        position: "bottom",
        purpose: "募集終了の限定性を伝え、早期申込みを促す",
        elements: [{ type: "text", slotId: "optional", role: "disclaimer" }]
      }]
    },
    copyBrief: { slotTexts: [{ slotId: "optional", text: "" }] },
    instructionPolicy: {}
  });

  assert.doesNotMatch(seed.promptJson.zones[0].purpose, /募集終了|早期申込み/);
  assert.match(seed.promptJson.zones[0].purpose, /構造/);
});

test("画像枠へ案全体の素材反復意図を複製せず、枠固有の構造役割だけを渡す", () => {
  const seed = compileClosedTemplatePromptSeed({
    banner: { imageSize: "1024x1024", productImagePaths: ["assets/icon.png"] },
    product: { name: "検証商品" },
    strategy: { benefit: "切り口を比較しやすい" },
    template: {
      templateZones: [{
        position: "bottom",
        elements: [
          { type: "image", slotId: "background", role: "illustration", messageRole: "decoration" },
          { type: "image", slotId: "foreground", role: "illustration", messageRole: "person" }
        ]
      }]
    },
    copyBrief: { variationDirection: "素材を守って比較", slotTexts: [] },
    creativeHypothesis: { visualIntent: { scene: "同じロゴ・商品画像を複数並べる", motif: "量産" } }
  });

  const imageContents = seed.promptJson.zones[0].elements.map((element) => element.content);
  assert.equal(new Set(imageContents).size, 2);
  assert.doesNotMatch(imageContents.join("\n"), /同じロゴ|商品画像|複数並べる|量産/);
});

test("追加指示のアクセント色を既存shapeへ割り当て、元テンプレの色語を残さない", () => {
  const seed = compileClosedTemplatePromptSeed({
    banner: { imageSize: "1024x1024" },
    template: {
      templateZones: [{
        position: "top",
        elements: [{ type: "shape", role: "icon", description: "左上のゴールドの戻る矢印" }]
      }]
    },
    copyBrief: { slotTexts: [] },
    instructionPolicy: { rawInstruction: "明るい白地と青のアクセントにしてください" }
  });

  assert.equal(seed.promptJson.colorScheme.accent, "青");
  assert.match(seed.promptJson.zones[0].elements[0].content, /青/);
  assert.doesNotMatch(seed.promptJson.zones[0].elements[0].content, /ゴールド/);
  const enforced = enforceTemplateStructure({
    templateZones: [{
      position: "top",
      elements: [{ type: "shape", role: "icon", description: "左上のゴールドの戻る矢印" }]
    }],
    generatedZones: seed.promptJson.zones
  });
  assert.match(enforced.zones[0].elements[0].content, /青/);
  assert.doesNotMatch(enforced.zones[0].elements[0].content, /ゴールド/);
  assert.doesNotMatch(enforced.zones[0].elements[0].content, /色は青.*色は青/);
});

test("全配布テンプレを決定論的compileしてもzone・element・type数を変えない", async () => {
  const templates = JSON.parse(await fs.readFile(new URL("../data/ad-templates.json", import.meta.url), "utf8"));
  assert.equal(templates.length, 100);

  for (const template of templates) {
    const expected = buildTemplateStructureContract(template.templateZones);
    const seed = compileClosedTemplatePromptSeed({
      banner: { id: "validation", imageSize: "1080x1080" },
      product: { id: "product-1", name: "検証商品" },
      strategy: { id: "strategy-1", markdown: "WHO: 広告運用者\nWHAT: 制作を短縮" },
      template,
      copyBrief: { appealAxis: "時短", variationDirection: "具体性", slotTexts: [] },
      creativeHypothesis: { visualIntent: { scene: "制作現場", motif: "速度" } }
    });
    const actual = enforceTemplateStructure({
      templateZones: template.templateZones,
      generatedZones: seed.promptJson.zones
    }).contract;

    assert.equal(actual.zoneCount, expected.zoneCount, `${template.id}: zone count`);
    assert.equal(actual.elementCount, expected.elementCount, `${template.id}: element count`);
    assert.deepEqual(actual.typeCounts, expected.typeCounts, `${template.id}: type counts`);
  }
});
