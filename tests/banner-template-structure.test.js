import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { buildBannerDesignPrompt, normalizeBannerProposal } from "../src/core/banner-ai.js";
import { buildBannerImagePrompt, buildBannerInputImageManifest } from "../src/core/openai-image.js";
import {
  assertTemplateImageCapacity,
  buildSelectedAssetOverridePolicy,
  buildTemplateStructureContract
} from "../src/core/banner-template-structure.js";
import { buildColorNeutralTemplateZones } from "../src/core/banner-template-color.js";

const templates = JSON.parse(fs.readFileSync(new URL("../data/ad-templates.json", import.meta.url), "utf8"));
const TEMPLATE_IDS = ["tpl_default_026", "tpl_default_042", "tpl_default_009"];

test("全100テンプレのzone・elementを上限で切り捨てず閉じた契約へ含める", () => {
  assert.equal(templates.length, 100);
  for (const template of templates) {
    const contract = buildTemplateStructureContract(template.templateZones);
    const expectedZoneCount = template.templateZones.length;
    const expectedElementCount = template.templateZones.reduce((count, zone) => count + zone.elements.length, 0);
    const slotIds = contract.zones.flatMap((zone) => zone.elements.map((element) => element.slotId));

    assert.equal(contract.zoneCount, expectedZoneCount, `${template.id}: zone count`);
    assert.equal(contract.elementCount, expectedElementCount, `${template.id}: element count`);
    assert.equal(new Set(slotIds).size, slotIds.length, `${template.id}: slotId must be unique`);
  }
});

test("全100テンプレで無選択は厳格維持、選択ロゴ・商品・その他素材だけは例外許可する", () => {
  const cases = [
    { name: "none", banner: {}, selectedCount: 0 },
    { name: "logo", banner: { logoImagePaths: ["assets/logo.png"] }, selectedCount: 1 },
    { name: "product", banner: { productImagePaths: ["assets/product.png"] }, selectedCount: 1 },
    {
      name: "all",
      banner: {
        logoImagePaths: ["assets/logo.png"],
        productImagePaths: ["assets/product.png"],
        otherImagePaths: ["assets/scene.png"]
      },
      selectedCount: 3
    }
  ];

  for (const template of templates) {
    for (const fixture of cases) {
      const proposal = proposalFor(template, fixture.banner);
      const manifest = buildBannerInputImageManifest(fixture.banner);
      const imagePrompt = buildBannerImagePrompt({ promptJson: proposal.promptJson, imageText: proposal.imageText }, manifest);

      assert.equal(proposal.promptJson.selectedAssetPolicy.totalCount, fixture.selectedCount, `${template.id}/${fixture.name}: selected count`);
      assert.equal(manifest.length, fixture.selectedCount, `${template.id}/${fixture.name}: manifest count`);
      if (fixture.selectedCount) {
        assert.match(imagePrompt, /ユーザー選択素材の例外/, `${template.id}/${fixture.name}: override instruction`);
        assert.match(imagePrompt, /選択されていないロゴ・商品画像・参考素材を追加・生成しない/, `${template.id}/${fixture.name}: unselected forbidden`);
      } else {
        assert.doesNotMatch(imagePrompt, /ユーザー選択素材の例外/, `${template.id}/${fixture.name}: strict structure`);
      }
    }
  }
});

function templateById(id) {
  const template = templates.find((item) => item.id === id);
  assert.ok(template, `fixture template not found: ${id}`);
  return template;
}

function deterministicSlotId(element, zoneIndex, elementIndex) {
  return String(element?.slotId || `z${zoneIndex + 1}e${elementIndex + 1}`);
}

function expectedTopology(template) {
  const neutralZones = buildColorNeutralTemplateZones(template.templateZones, template.templateColorScheme);
  return neutralZones.map((zone, zoneIndex) => ({
    position: String(zone.position || ""),
    elements: zone.elements.map((element, elementIndex) => ({
      slotId: deterministicSlotId(element, zoneIndex, elementIndex),
      type: String(element.type || ""),
      role: String(element.role || ""),
      messageRole: String(element.messageRole || ""),
      position: element.position || {},
      size: String(element.size || ""),
      effect: String(element.effect || "")
    }))
  }));
}

function actualTopology(zones) {
  return zones.map((zone) => ({
    position: String(zone.position || ""),
    elements: zone.elements.map((element) => ({
      slotId: String(element.slotId || ""),
      type: String(element.type || ""),
      role: String(element.role || ""),
      messageRole: String(element.messageRole || ""),
      position: element.position || {},
      size: String(element.size || ""),
      effect: String(element.effect || "")
    }))
  }));
}

function typeCounts(zones) {
  return zones.flatMap((zone) => zone.elements || []).reduce((counts, element) => {
    const type = String(element.type || "");
    counts[type] = (counts[type] || 0) + 1;
    return counts;
  }, { text: 0, image: 0, shape: 0 });
}

function copyBriefForTemplate(template) {
  const slotTexts = template.templateZones.flatMap((zone, zoneIndex) => zone.elements.map((element, elementIndex) => ({ element, zoneIndex, elementIndex })))
    .filter(({ element }) => element.type === "text")
    .map(({ element, zoneIndex, elementIndex }, index) => ({
      slotId: deterministicSlotId(element, zoneIndex, elementIndex),
      text: `確定コピー${index + 1}`,
      charBudget: Number(element.charCount) || 30
    }));
  return {
    appealAxis: "テンプレ構造固定",
    whyItStops: "元構造を崩さず読ませる",
    slotTexts
  };
}

function adversarialModelZones(template) {
  const zones = template.templateZones.map((zone, zoneIndex) => ({
    name: `AI Zone ${zoneIndex + 1}`,
    position: "AIが変更した位置",
    purpose: "AIが変更した目的",
    background: "AIが追加した背景",
    elements: zone.elements.map((element, elementIndex) => ({
      type: zoneIndex === 0 && elementIndex === 0 ? "image" : element.type,
      slotId: deterministicSlotId(element, zoneIndex, elementIndex),
      role: "AIが変更したrole",
      messageRole: "AIが変更したmessageRole",
      content: "AIが追加・変更した内容",
      position: { top: "99%", left: "99%" },
      size: "幅1%、高さ1%",
      effect: "AIが追加した下線と発光",
      font: "AI指定フォント",
      color: "#123456",
      sourceReason: "AI判断"
    })).filter((_, elementIndex) => !(zoneIndex === 1 && elementIndex === zone.elements.length - 1))
  }));
  zones[0].elements.push(
    { type: "text", slotId: "extra_text", role: "extra", content: "追加テキスト" },
    { type: "image", slotId: "extra_image", role: "logo", content: "追加ロゴ" },
    { type: "shape", slotId: "extra_shape", role: "underline", content: "追加下線" }
  );
  zones.push({
    name: "Extra Zone",
    position: "center",
    purpose: "追加図解",
    elements: [{ type: "image", slotId: "extra_zone_image", role: "diagram", content: "追加図解" }]
  });
  return zones;
}

function proposalFor(template, banner = {}) {
  return normalizeBannerProposal(
    {
      promptJson: {
        globalDesign: { visualStyle: { type: "product photograph", mood: "dramatic", note: "ロゴと端末と図解を追加" } },
        zones: adversarialModelZones(template)
      }
    },
    {
      banner: { imageSize: "1080x1080", ...banner },
      product: { name: "検証商品" },
      strategy: { id: "str_test", conceptName: "検証戦略", benefit: "制作判断を揃える" },
      template,
      copyBrief: copyBriefForTemplate(template)
    }
  );
}

for (const templateId of TEMPLATE_IDS) {
  test(`${templateId}: テンプレ外のzone・text・image・shape・type変更を除外する`, () => {
    const template = templateById(templateId);
    const proposal = proposalFor(template);

    assert.deepEqual(actualTopology(proposal.promptJson.zones), expectedTopology(template));
    assert.deepEqual(proposal.promptJson.templateStructureContract.typeCounts, typeCounts(template.templateZones));
    assert.equal(proposal.promptJson.templateStructureContract.closed, true);
    assert.ok(proposal.promptJson.templateStructureReview.violations.some((item) => item.type === "extra_zone"));
    assert.ok(proposal.promptJson.templateStructureReview.violations.some((item) => item.type === "extra_element"));
    assert.ok(proposal.promptJson.templateStructureReview.violations.some((item) => item.type === "type_change"));
    assert.ok(proposal.promptJson.templateStructureReview.violations.some((item) => item.type === "missing_element"));
  });
}

test("メモ帳風テンプレは元のshape種別を維持し、画像向けvisualStyleを残さない", () => {
  const template = templateById("tpl_default_026");
  const proposal = proposalFor(template);
  const sourceShapeDescriptions = buildColorNeutralTemplateZones(template.templateZones, template.templateColorScheme)
    .flatMap((zone) => zone.elements)
    .filter((element) => element.type === "shape")
    .map((element) => element.description || element.content || "");
  const normalizedShapeDescriptions = proposal.promptJson.zones.flatMap((zone) => zone.elements)
    .filter((element) => element.type === "shape")
    .map((element) => element.content);

  assert.deepEqual(normalizedShapeDescriptions, sourceShapeDescriptions);
  assert.equal(proposal.promptJson.globalDesign.visualStyle.type, "text-and-existing-shapes-only");
  assert.equal(proposal.promptJson.templateStructureContract.typeCounts.image, 0);
});

test("画像枠0件テンプレでも選択ロゴ・商品画像だけは構造例外として許可する", () => {
  const template = templateById("tpl_default_026");
  const proposal = proposalFor(template, {
    logoImagePaths: ["assets/logo.png"],
    productImagePaths: ["assets/product.png"]
  });

  assert.equal(proposal.promptJson.selectedAssetPolicy.enabled, true);
  assert.equal(proposal.promptJson.selectedAssetPolicy.totalCount, 2);
  assert.deepEqual(proposal.promptJson.selectedAssetPolicy.roles.logo.paths, ["assets/logo.png"]);
  assert.deepEqual(proposal.promptJson.selectedAssetPolicy.roles.product.paths, ["assets/product.png"]);
  assert.equal(proposal.promptJson.templateStructureContract.typeCounts.image, 0);
});

test("ロゴ枠のない画像テンプレでも選択ロゴを唯一の構造例外として許可する", () => {
  const template = templateById("tpl_default_009");
  const proposal = proposalFor(template, { logoImagePaths: ["assets/logo.png"] });

  assert.equal(proposal.promptJson.selectedAssetPolicy.enabled, true);
  assert.equal(proposal.promptJson.selectedAssetPolicy.roles.logo.required, true);
  assert.deepEqual(proposal.promptJson.selectedAssetPolicy.roles.logo.paths, ["assets/logo.png"]);
});

test("画像枠数を超える複数の選択素材もすべて構造例外として許可する", () => {
  const template = templateById("tpl_default_081");
  const banner = {
    logoImagePaths: ["assets/logo-primary.png", "assets/logo-secondary.png"],
    productImagePaths: ["assets/product.png"],
    otherImagePaths: ["assets/scene.png"]
  };

  assert.doesNotThrow(() => assertTemplateImageCapacity({ templateZones: template.templateZones, banner }));
  const policy = buildSelectedAssetOverridePolicy(banner);
  assert.equal(policy.totalCount, 4);
  assert.equal(policy.roles.logo.count, 2);
  assert.equal(policy.roles.product.count, 1);
  assert.equal(policy.roles.other.count, 1);
});

test("素材を選択していない場合は構造例外を有効化しない", () => {
  const template = templateById("tpl_default_026");
  const proposal = proposalFor(template);

  assert.equal(proposal.promptJson.selectedAssetPolicy.enabled, false);
  assert.equal(proposal.promptJson.selectedAssetPolicy.totalCount, 0);
  assert.deepEqual(proposal.promptJson.selectedAssetPolicy.roles.logo.paths, []);
  assert.deepEqual(proposal.promptJson.selectedAssetPolicy.roles.product.paths, []);
});

test("テンプレなしではモデルが作った自由なzone・elementを維持する", () => {
  const proposal = normalizeBannerProposal(
    { promptJson: { zones: [{ name: "Free", elements: [{ type: "image", role: "new visual", content: "自由な画像" }] }] } },
    {
      banner: {},
      product: { name: "検証商品" },
      strategy: { conceptName: "自由生成" },
      template: null,
      copyBrief: { appealAxis: "自由", whyItStops: "自由", mainHook: "自由な見出し" }
    }
  );

  assert.equal(proposal.promptJson.zones.length, 1);
  assert.equal(proposal.promptJson.zones[0].elements[0].type, "image");
  assert.equal(Object.hasOwn(proposal.promptJson, "templateStructureContract"), false);
});

test("Stage 2と画像生成の両プロンプトが閉じた構造契約を最優先で伝える", () => {
  const template = templateById("tpl_default_026");
  const copyBrief = copyBriefForTemplate(template);
  const stage2Prompt = buildBannerDesignPrompt({
    banner: { imageSize: "1080x1080" },
    product: { name: "検証商品" },
    strategy: { conceptName: "検証戦略" },
    template,
    copyBrief
  });
  const proposal = proposalFor(template);
  const imagePrompt = buildBannerImagePrompt({ promptJson: proposal.promptJson, imageText: proposal.imageText }, []);

  assert.match(stage2Prompt, /閉じた構造契約/);
  assert.match(stage2Prompt, /text・image・shape.*追加しない/);
  assert.match(imagePrompt, /閉じた構造契約/);
  assert.match(imagePrompt, /画像要素は0件/);
  assert.match(imagePrompt, /ロゴ・写真・イラスト.*端末・図解を追加しない/);
});

test("Stage 2は選択素材だけを閉じた構造の唯一の例外として明示する", () => {
  const template = templateById("tpl_default_026");
  const stage2Prompt = buildBannerDesignPrompt({
    banner: {
      imageSize: "1080x1080",
      logoImagePaths: ["assets/logo.png"],
      productImagePaths: ["assets/product.png"]
    },
    product: { name: "検証商品" },
    strategy: { conceptName: "検証戦略" },
    template,
    copyBrief: copyBriefForTemplate(template)
  });

  assert.match(stage2Prompt, /ユーザー選択素材/);
  assert.match(stage2Prompt, /唯一の例外/);
  assert.match(stage2Prompt, /選択されていない.*素材.*追加しない/);
  assert.match(stage2Prompt, /assets\/logo\.png/);
  assert.match(stage2Prompt, /assets\/product\.png/);
});
