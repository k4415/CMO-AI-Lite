import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { addAdTemplate, listAdTemplates, updateAdTemplate } from "../src/core/ad-template-store.js";
import { normalizeTemplatePromptJson, templateBannerImage } from "../src/core/template-ai.js";

test("invalid JSON placeholders are rejected and normalized blueprints are produced", () => {
  const normalized = normalizeTemplatePromptJson({
    zones: [{
      name: "main",
      position: "top",
      elements: [{ type: "text", role: "headline", messageRole: "hook", content: "{悩み}で満足していませんか？", charCount: 18 }]
    }],
    variableDefinitions: [
      { placeholder: "{\"main\":\"#fff\"}", role: "invalid" },
      { placeholder: "{悩み}", exampleOriginal: "自己流ケア" }
    ],
    sourceCategoryProfile: { category: "美容", solutionType: "美容液" }
  });

  assert.equal(normalized.variableDefinitions.some((item) => item.placeholder.includes("#fff")), false);
  assert.equal(normalized.layoutBlueprint.zones.length, 1);
  assert.equal(normalized.copyBlueprint.slots[0].charBudget, 18);
  assert.equal(normalized.copyBlueprint.slots[0].originalText, "自己流ケアで満足していませんか？");
  assert.equal(normalized.copyBlueprint.sourceCategoryProfile.category, "美容");
});

test("新規画像テンプレを構造化し、変数定義を補完して共通DBへ保存する", async (t) => {
  const originalCwd = process.cwd();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-template-test-"));
  t.after(async () => {
    process.chdir(originalCwd);
    await fs.rm(tempRoot, { recursive: true, force: true });
  });
  process.chdir(tempRoot);

  const template = await addAdTemplate(tempRoot, {
    title: "新規画像テンプレ",
    imageFile: "/shared-file?path=ad-template-uploads/test/banner.png",
    templateStatus: "not_started"
  });
  let visionInput = null;

  const result = await templateBannerImage(tempRoot, template.id, {
    visionJson: async (input) => {
      visionInput = input;
      return {
        basic: { size: "1080x1080" },
        zones: [{
          name: "オファー",
          position: "上部",
          purpose: "フック",
          elements: [
            { type: "text", content: "{商品名} {価格}", messageRole: "hook", charCount: "12" },
            { type: "text", content: "{実績数}人が利用", role: "proof" }
          ]
        }],
        // APIが一部のメタデータを省略しても、保存前に補完されることを確認する。
        variableDefinitions: [
          { placeholder: "{価格}", exampleOriginal: "980円" },
          { placeholder: "{保証}", role: "risk-reversal" }
        ],
        globalDesign: { designRationale: "明確な情報階層" },
        colorScheme: { main: "#ffffff" }
      };
    }
  });

  assert.equal(visionInput.image, template.imageFile);
  assert.match(visionInput.system, /variableDefinitions/);
  assert.equal(result.templateStatus, "template_ready");
  assert.equal(result.templateProcessingStatus, "completed");
  assert.equal(result.templateReadiness.readyForGeneration, true);
  assert.equal(result.templateReadiness.schemaVersion, 2);
  assert.match(result.templateReadiness.validationHash, /^sha256:[a-f0-9]{64}$/);
  assert.ok(Date.parse(result.templateReadiness.validatedAt));
  assert.equal(result.templatePromptJson.zones.length, 1);
  assert.equal(result.templateZones.length, 1);
  assert.equal(result.templateZones[0].elements[0].charCount, 12);
  assert.deepEqual(
    result.templatePromptJson.variableDefinitions.map((item) => item.placeholder),
    ["{商品名}", "{価格}", "{実績数}", "{保証}"]
  );
  for (const definition of result.templatePromptJson.variableDefinitions) {
    assert.ok(definition.category);
    assert.ok(definition.role);
    assert.ok(definition.source);
    assert.ok(definition.constraints);
  }
  assert.equal(
    result.templatePromptJson.variableDefinitions.find((item) => item.placeholder === "{価格}").exampleOriginal,
    "980円"
  );
  assert.deepEqual(result.templatePromptJson.contentArchitecture.messageFlow, ["hook", "proof"]);
  assert.equal(result.structureSheet.source, "image_template");
  assert.match(result.templateTextStoryboard, /variableDefinitions/);
  assert.equal(result.successFactors, "明確な情報階層");
  assert.equal(result.templateGlobalDesign.designRationale, "明確な情報階層");
  assert.equal(result.templateColorScheme.main, "#ffffff");
  assert.ok(result.layoutBlueprint.zones.length);
  assert.ok(result.copyBlueprint.slots.length);

  const saved = (await listAdTemplates()).find((item) => item.id === template.id);
  assert.equal(saved.templatePromptJson.variableDefinitions.length, 4);
  assert.equal(saved.templateZones.length, 1);
  assert.equal(saved.templateStatus, "template_ready");
  assert.equal(saved.templateProcessingStatus, "completed");

  const renamed = await updateAdTemplate(tempRoot, template.id, { title: "名前だけ変更" });
  assert.equal(renamed.templateReadiness.readyForGeneration, true);
  assert.equal(renamed.templateReadiness.validationHash, saved.templateReadiness.validationHash);

  const changed = await updateAdTemplate(tempRoot, template.id, {
    copyBlueprint: {
      ...renamed.copyBlueprint,
      slots: renamed.copyBlueprint.slots.map((slot, index) => index === 0 ? { ...slot, charBudget: slot.charBudget + 1 } : slot)
    }
  });
  assert.equal(changed.templateReadiness.readyForGeneration, false);
  assert.ok(changed.templateReadiness.issues.includes("validation_hash_mismatch"));
});
