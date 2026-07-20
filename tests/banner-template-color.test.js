import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  auditPromptColorContract,
  bindResolvedPaletteToZones,
  buildColorNeutralTemplateDesign,
  buildColorNeutralTemplateZones,
  stripTemplateColorTokens,
  TEMPLATE_COLOR_TOKEN_PATTERN
} from "../src/core/banner-template-color.js";
import { enforceTemplateStructure } from "../src/core/banner-template-structure.js";

const PALETTE = {
  main: "#16324F",
  sub: "#FFFFFF",
  accent: "#2563EB",
  background: "#F7FAFC"
};

test("色指定なしでも構造正規化後に元テンプレ色語を復元しない", () => {
  const templateZones = [{
    position: "top",
    elements: [
      { type: "shape", role: "icon", description: "左上のゴールドの戻る矢印" },
      { type: "text", role: "headline", color: "#000000", effect: "白い縁取り、黒い影" }
    ]
  }];
  const neutral = buildColorNeutralTemplateZones(templateZones, {
    main: "#000000", sub: "#BDBDBD", accent: "#D8A514", background: "#FFFFFF"
  });
  const enforced = enforceTemplateStructure({
    templateZones: neutral,
    generatedZones: neutral
  });
  const serialized = JSON.stringify(enforced.zones);
  assert.doesNotMatch(serialized, /ゴールド|黒い|白い|#000000|#D8A514/);
  assert.match(serialized, /戻る矢印|縁取り|影/);
});

test("確定paletteをcolorRoleへ再バインドする", () => {
  const zones = [{
    backgroundColorRole: "background",
    elements: [
      { type: "shape", role: "icon", colorRole: "accent", content: "戻る矢印" },
      { type: "text", role: "headline", colorRole: "main", content: "見出し" },
      { type: "shape", role: "background", colorRole: "background", content: "全面背景" },
      { type: "image", role: "product", content: "商品画像" }
    ]
  }];
  const bound = bindResolvedPaletteToZones(zones, PALETTE);
  assert.equal(bound[0].background, "#F7FAFC");
  assert.equal(bound[0].elements[0].color, "#2563EB");
  assert.equal(bound[0].elements[1].color, "#16324F");
  assert.equal(bound[0].elements[2].color, "#F7FAFC");
  assert.equal(Object.hasOwn(bound[0].elements[3], "color"), false);
});

test("閉じた構造強制後も具体色ではなくcolorRoleを維持する", () => {
  const neutral = buildColorNeutralTemplateZones([{
    position: "top",
    background: "white",
    elements: [{ type: "shape", role: "icon", color: "#D8A514", description: "ゴールドの矢印" }]
  }], { accent: "#D8A514", background: "#FFFFFF" });
  const enforced = enforceTemplateStructure({ templateZones: neutral, generatedZones: neutral });

  assert.equal(enforced.zones[0].backgroundColorRole, "background");
  assert.equal(enforced.zones[0].elements[0].colorRole, "accent");
  assert.equal(enforced.contract.zones[0].backgroundColorRole, "background");
  assert.equal(enforced.contract.zones[0].elements[0].colorRole, "accent");
  assert.doesNotMatch(JSON.stringify(enforced), /#D8A514|ゴールド/);
});

test("globalDesignの具体色だけを除去し構造・余白・ムードを維持する", () => {
  const neutral = buildColorNeutralTemplateDesign({
    style: "白背景・黒極太文字のテキスト主体デザイン",
    spacingPolicy: { overall: "余白を大きく取る" },
    contrastPolicy: { note: "白背景に黒文字を使用し、アクセントはゴールド" },
    visualStyle: { mood: "リアル、簡素、緊急、信頼感" }
  });

  assert.doesNotMatch(`${neutral.style}\n${neutral.contrastPolicy.note}`, /白背景|黒(?:極太|文字)|ゴールド/);
  assert.match(neutral.style, /背景・極太文字のテキスト主体デザイン/);
  assert.match(neutral.contrastPolicy.note, /背景に文字を使用/);
  assert.equal(neutral.spacingPolicy.overall, "余白を大きく取る");
  assert.equal(neutral.visualStyle.mood, "リアル、簡素、緊急、信頼感");
});

test("色だけの列挙やグラデーション表現を除去して不自然な接続語を残さない", () => {
  assert.equal(stripTemplateColorTokens("青と白の清潔な配色"), "清潔な配色");
  assert.equal(stripTemplateColorTokens("淡い水色から白への柔らかいグラデーション"), "柔らかいグラデーション");
  assert.equal(stripTemplateColorTokens("白背景に黒文字、オレンジ帯に白文字"), "背景に文字、帯に文字");
});

test("余白・面白いなど色ではない語の白を除去・誤検知しない", () => {
  const value = "余白を広く取り、面白い視線誘導にする";
  assert.equal(stripTemplateColorTokens(value), value);
  const review = auditPromptColorContract({
    promptJson: { globalDesign: { style: value }, zones: [] },
    colorDecision: { palette: PALETTE }
  });
  assert.equal(review.status, "passed");
});

test("解決済みpalette外のHEXと色名を監査で検出する", () => {
  const review = auditPromptColorContract({
    promptJson: {
      globalDesign: { style: "ゴールド基調" },
      colorScheme: PALETTE,
      zones: [{
        background: PALETTE.background,
        elements: [
          { type: "text", color: PALETTE.main, effect: "縁取り" },
          { type: "shape", color: "#D8A514", content: "戻る矢印" }
        ]
      }]
    },
    templateColorScheme: { accent: "#D8A514" },
    colorDecision: { palette: PALETTE }
  });

  assert.equal(review.status, "failed");
  assert.deepEqual(review.unexpectedHex, [{ path: "zones[0].elements[1].color", value: "#D8A514" }]);
  assert.deepEqual(review.unexpectedNamedColorPaths, ["globalDesign.style"]);
});

test("全100テンプレで色中立化と再バインドが構造を変えない", async () => {
  const templates = JSON.parse(await fs.readFile(new URL("../data/ad-templates.json", import.meta.url), "utf8"));
  assert.equal(templates.length, 100);

  for (const template of templates) {
    const originalZones = Array.isArray(template.templateZones) ? template.templateZones : [];
    const neutral = buildColorNeutralTemplateZones(originalZones, template.templateColorScheme);
    const bound = bindResolvedPaletteToZones(neutral, PALETTE);
    assert.equal(neutral.length, originalZones.length, `${template.id}: zone count`);

    for (let zoneIndex = 0; zoneIndex < originalZones.length; zoneIndex += 1) {
      const originalElements = Array.isArray(originalZones[zoneIndex]?.elements) ? originalZones[zoneIndex].elements : [];
      const neutralElements = neutral[zoneIndex]?.elements || [];
      assert.equal(neutralElements.length, originalElements.length, `${template.id}: element count`);
      for (let elementIndex = 0; elementIndex < originalElements.length; elementIndex += 1) {
        const original = originalElements[elementIndex];
        const current = neutralElements[elementIndex];
        assert.equal(current.type, original.type, `${template.id}: type`);
        assert.equal(current.slotId, original.slotId, `${template.id}: slotId`);
        assert.deepEqual(current.position, original.position, `${template.id}: position`);
        assert.equal(current.size, original.size, `${template.id}: size`);
        if (["image", "logo", "product"].includes(String(current.type || "").toLowerCase())) {
          assert.equal(Object.hasOwn(bound[zoneIndex].elements[elementIndex], "color"), false, `${template.id}: selected visual color`);
        }
      }
    }

    const structuralText = collectColorBearingText(neutral);
    for (const color of Object.values(template.templateColorScheme || {}).filter((value) => /^#[0-9a-f]{3,8}$/i.test(String(value)))) {
      assert.doesNotMatch(structuralText.toLowerCase(), new RegExp(escapeRegExp(String(color).toLowerCase())), `${template.id}: source HEX`);
    }
    assert.doesNotMatch(structuralText, new RegExp(TEMPLATE_COLOR_TOKEN_PATTERN.source, "i"), `${template.id}: named color`);

    const boundHex = [...collectColorBearingText(bound).matchAll(/#[0-9a-f]{6}\b/gi)].map((match) => match[0].toUpperCase());
    assert.ok(boundHex.every((color) => Object.values(PALETTE).includes(color)), `${template.id}: rebound palette`);
  }
});

function collectColorBearingText(zones) {
  return (zones || []).flatMap((zone) => [
    zone.background || "",
    ...(zone.elements || []).flatMap((element) => [
      element.color || "",
      element.effect || "",
      String(element.type || "").toLowerCase() === "shape" ? (element.content || element.description || "") : "",
      element.font || ""
    ])
  ]).join("\n");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
