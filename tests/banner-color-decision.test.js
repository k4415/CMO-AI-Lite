import test from "node:test";
import assert from "node:assert/strict";

import {
  extractPaletteFromText,
  normalizeColorValue,
  resolveBannerColorDecision
} from "../src/core/banner-color-decision.js";

test("#RGB・#RRGGBB・既定色名を大文字HEXへ正規化する", () => {
  assert.equal(normalizeColorValue("#0af"), "#00AAFF");
  assert.equal(normalizeColorValue("#0b1f3a"), "#0B1F3A");
  assert.equal(normalizeColorValue("青"), "#2563EB");
  assert.equal(normalizeColorValue("#XXXXXX"), "");
});

test("追加指示の複数カラーを役割別に抽出する", () => {
  assert.deepEqual(
    extractPaletteFromText("メインカラーは#0B1F3A、アクセントは#FF6B00、背景は白"),
    { main: "#0B1F3A", accent: "#FF6B00", background: "#FFFFFF" }
  );
  assert.deepEqual(
    extractPaletteFromText("全体は明るい白地と青のアクセント"),
    { accent: "#2563EB", background: "#FFFFFF" }
  );
  assert.deepEqual(
    extractPaletteFromText("背景は白を基調にして、人物を追加しない"),
    { background: "#FFFFFF" }
  );
});

test("役割不明の複数色は推測せず、単一色だけmainへ割り当てる", () => {
  assert.deepEqual(extractPaletteFromText("#112233"), { main: "#112233" });
  assert.deepEqual(extractPaletteFromText("#112233と#445566"), {});
  assert.deepEqual(extractPaletteFromText("余白を広くして、面白い構図にする"), {});
});

test("カラーをフィールド単位で優先順位解決する", () => {
  const decision = resolveBannerColorDecision({
    userInstruction: "アクセントは#FF6600",
    expressionRules: [{ ruleType: "image_rule", description: "メインカラーは#003366" }],
    product: {},
    strategy: {
      decisionCriteria: "信頼できる",
      colorInference: {
        status: "inferred",
        palette: { main: "#102030", sub: "#FFFFFF", accent: "#E06020", background: "#F8F5F0" },
        reason: "信頼感と行動喚起",
        evidence: ["判断基準: 信頼できる"]
      }
    },
    template: {
      templateColorScheme: { main: "#111111", sub: "#EEEEEE", accent: "#D8A514", background: "#FFFFFF" }
    }
  });

  assert.deepEqual(decision.palette, {
    main: "#003366",
    sub: "#FFFFFF",
    accent: "#FF6600",
    background: "#F8F5F0"
  });
  assert.deepEqual(decision.sourceByField, {
    main: "regulation",
    sub: "who_what_inference",
    accent: "user_instruction",
    background: "who_what_inference"
  });
  assert.equal(decision.source, "mixed");
  assert.deepEqual(decision.templateFallbackFields, []);
});

test("修正指示に相当する後方の指定を同一フィールドで優先する", () => {
  const decision = resolveBannerColorDecision({
    userInstruction: "アクセントは赤\nアクセントは青",
    template: { templateColorScheme: { main: "#111111", sub: "#EEEEEE", accent: "#D8A514", background: "#FFFFFF" } }
  });

  assert.equal(decision.palette.accent, "#2563EB");
  assert.equal(decision.sourceByField.accent, "user_instruction");
});

test("表現レギュレーションは正式ブランド指定より優先する", () => {
  const decision = resolveBannerColorDecision({
    expressionRules: [{ ruleType: "color", description: "メインは#003366" }],
    product: { brandColor: "メインは#AA0000、アクセントは#FF8800" },
    template: { templateColorScheme: { main: "#111111", sub: "#EEEEEE", accent: "#D8A514", background: "#FFFFFF" } }
  });

  assert.equal(decision.palette.main, "#003366");
  assert.equal(decision.sourceByField.main, "regulation");
  assert.equal(decision.palette.accent, "#FF8800");
  assert.equal(decision.sourceByField.accent, "official_brand");
});

test("WHO-WHATがinsufficientならテンプレカラーへフォールバックする", () => {
  const templatePalette = { main: "#000000", sub: "#BDBDBD", accent: "#D8A514", background: "#FFFFFF" };
  const decision = resolveBannerColorDecision({
    strategy: { colorInference: { status: "insufficient", palette: {}, reason: "根拠不足", evidence: [] } },
    template: { templateColorScheme: templatePalette }
  });

  assert.deepEqual(decision.palette, templatePalette);
  assert.deepEqual(decision.templateFallbackFields, ["main", "sub", "accent", "background"]);
  assert.equal(decision.source, "template");
});

test("テンプレの欠落フィールドだけ安全な標準色へフォールバックする", () => {
  const decision = resolveBannerColorDecision({
    template: { templateColorScheme: { main: "#000000", accent: "invalid" } }
  });

  assert.equal(decision.palette.main, "#000000");
  assert.equal(decision.palette.accent, "#F97316");
  assert.deepEqual(decision.safeDefaultFields, ["sub", "accent", "background"]);
});
