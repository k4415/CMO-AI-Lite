import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLogoVerificationPlan,
  logoRegionsFromContract,
  normalizeLogoWordmark,
  resolveLogoIdentity,
  verifyLogoIdentity
} from "../src/core/logo-identity.js";

test("正式ワードマークは空白を含む複数語と日本語を同一性判定できる", () => {
  assert.equal(normalizeLogoWordmark(" Sample Smile "), "samplesmile");
  assert.equal(normalizeLogoWordmark("オー・マイ・ティース"), "オーマイティース");
});

test("商品素材のofficialWordmarkをOCR観測値より優先する", () => {
  const identity = resolveLogoIdentity({
    inputImage: { role: "brand-logo", path: "assets/sample-brand.png", asset: { officialWordmark: "Sample Smile" } },
    product: { name: "Sample Smile" },
    selectedLogoCount: 1,
    observedInputText: "SMILE"
  });

  assert.equal(identity.officialWordmark, "Sample Smile");
  assert.equal(identity.source, "asset_metadata");
  assert.equal(identity.observedInputText, "SMILE");
});

test("単一ロゴ選択時だけ商品ブランド名を正式表記のフォールバックにする", () => {
  const single = resolveLogoIdentity({
    inputImage: { role: "brand-logo", path: "assets/sample-brand.png" },
    product: { brandName: "Sample Smile", name: "サンプルサービス" },
    selectedLogoCount: 1,
    observedInputText: "SMILE"
  });
  const multiple = resolveLogoIdentity({
    inputImage: { role: "brand-logo", path: "assets/sample-brand.png" },
    product: { brandName: "Sample Smile", name: "サンプルサービス" },
    selectedLogoCount: 2,
    observedInputText: "SMILE"
  });

  assert.equal(single.officialWordmark, "Sample Smile");
  assert.equal(single.source, "product_brand_name");
  assert.equal(multiple.officialWordmark, "");
  assert.equal(multiple.source, "unresolved");
});

test("ロゴ同一性は完成画像全体ではなくロゴ枠OCRだけで検証する", () => {
  const identities = [{ officialWordmark: "Sample Smile", source: "asset.officialWordmark" }];
  const result = verifyLogoIdentity({
    identities,
    logoRegionTexts: [{ slotId: "z5e1", text: "SMILE" }],
    fullImageText: "本文末尾に Sample Smile と書かれている"
  });

  assert.equal(result.status, "missing");
  assert.deepEqual(result.missing, ["Sample Smile"]);
});

test("テンプレのロゴ枠を生成画像のOCR矩形へ変換する", () => {
  const regions = logoRegionsFromContract({
    closed: true,
    zones: [{ elements: [{
      slotId: "z5e1",
      type: "image",
      role: "logo",
      messageRole: "logo",
      position: { top: "3%", left: "80%" },
      size: "約17% width x 7% height"
    }] }]
  }, "1088x1088");

  assert.equal(regions.length, 1);
  assert.equal(regions[0].slotId, "z5e1");
  assert.deepEqual(regions[0].rectangle, { left: 848, top: 10, width: 229, height: 120 });
});

test("ロゴ枠がないテンプレでも選択ロゴ用の固定例外領域をOCR対象にする", () => {
  const regions = logoRegionsFromContract({
    closed: true,
    zones: [{ elements: [{ slotId: "z1e1", type: "text", role: "headline" }] }]
  }, "1088x1088", { selectedLogoCount: 1 });

  assert.equal(regions.length, 1);
  assert.equal(regions[0].slotId, "selected-logo-fallback-1");
  assert.deepEqual(regions[0].rectangle, { left: 718, top: 10, width: 360, height: 175 });
});

test("既存ロゴ枠より選択ロゴが多い場合は重ならない例外領域を追加する", () => {
  const regions = logoRegionsFromContract({
    closed: true,
    zones: [{ elements: [{
      slotId: "z1e1",
      type: "image",
      role: "logo",
      position: { top: "3%", left: "80%" },
      size: "17% width x 7% height"
    }] }]
  }, "1000x1000", { selectedLogoCount: 2 });

  assert.equal(regions.length, 2);
  assert.equal(regions[1].slotId, "selected-logo-fallback-2");
  assert.deepEqual(regions[1].rectangle, { left: 660, top: 830, width: 330, height: 160 });
});

test("ロゴ枠が取得できない場合は画像全体OCRへフォールバックせず確認不能にする", () => {
  const result = verifyLogoIdentity({
    identities: [{ officialWordmark: "Sample Smile", source: "asset.officialWordmark" }],
    logoRegionTexts: [],
    ocrError: ""
  });

  assert.equal(result.status, "not_verifiable");
  assert.equal(result.required, true);
});

test("ロゴ領域OCRが空ならmissingと断定せず確認不能にする", () => {
  const result = verifyLogoIdentity({
    identities: [{ officialWordmark: "Sample Smile", source: "asset_metadata" }],
    logoRegionTexts: [{ slotId: "z5e1", text: "" }]
  });

  assert.equal(result.status, "not_verifiable");
});

test("logo slotと選択素材例外をロゴごとに1対1で割り当てる", () => {
  const plan = buildLogoVerificationPlan({
    closed: true,
    zones: [{ elements: [{
      slotId: "z1e1",
      type: "image",
      role: "logo",
      position: { top: "3%", left: "80%" },
      size: "17% width x 7% height"
    }] }]
  }, "1024x1024", { selectedLogoCount: 2 });

  assert.equal(plan.items.length, 2);
  assert.equal(plan.items[0].mode, "template_slot");
  assert.deepEqual(plan.items[0].regionIds, ["z1e1"]);
  assert.equal(plan.items[1].mode, "selected_asset_override");
  assert.ok(plan.items[1].regionIds.length >= 1);
  assert.ok(plan.regions.length <= 8);
});

test("imageロゴ枠と同一zoneのブランド名textを一つの厳格検証領域にする", () => {
  const plan = buildLogoVerificationPlan({
    closed: true,
    zones: [{ elements: [
      {
        slotId: "z5e2",
        type: "image",
        role: "logo",
        messageRole: "logo",
        position: { top: "84.5%", left: "20.5%" },
        size: "8.5% width x 7.5% height"
      },
      {
        slotId: "z5e3",
        type: "text",
        role: "logo",
        messageRole: "proof",
        position: { top: "84.5%", left: "30%" },
        size: "50% width x 8% height"
      }
    ] }]
  }, "1024x1024", { selectedLogoCount: 1 });

  assert.equal(plan.items[0].mode, "template_slot");
  assert.equal(plan.regions[0].slotId, "z5e2");
  assert.ok(plan.regions[0].rectangle.width > 600);
  const result = verifyLogoIdentity({
    identities: [{ officialWordmark: "CMO AI Lite" }],
    verificationPlan: plan,
    logoRegionTexts: [{ slotId: "z5e2", text: "CMO AI Lite" }],
    fullImageText: "本文 CMO AI Lite"
  });
  assert.equal(result.status, "verified");
});

test("テンプレロゴ枠の低信頼OCR不一致は欠落と断定せず再生成対象にしない", () => {
  const plan = buildLogoVerificationPlan({
    closed: true,
    zones: [{ elements: [{
      slotId: "z5e1",
      type: "image",
      role: "logo",
      position: { top: "84%", left: "20%" },
      size: "60% width x 10% height"
    }] }]
  }, "1088x1088", { selectedLogoCount: 1 });

  const result = verifyLogoIdentity({
    identities: [{ officialWordmark: "CMO AI Lite" }],
    verificationPlan: plan,
    logoRegionTexts: [{ slotId: "z5e1", text: "JCMO Al 本", confidence: 58 }],
    fullImageText: "本文"
  });

  assert.equal(result.status, "not_verifiable");
  assert.equal(result.items[0].reason, "template_slot_ocr_low_confidence");
});

test("テンプレロゴ枠の高信頼な別表記は従来どおりmissingにする", () => {
  const plan = buildLogoVerificationPlan({
    closed: true,
    zones: [{ elements: [{
      slotId: "z5e1",
      type: "image",
      role: "logo",
      position: { top: "3%", left: "80%" },
      size: "17% width x 7% height"
    }] }]
  }, "1088x1088", { selectedLogoCount: 1 });

  const result = verifyLogoIdentity({
    identities: [{ officialWordmark: "Oh my teeth" }],
    verificationPlan: plan,
    logoRegionTexts: [{ slotId: "z5e1", text: "TEETH", confidence: 96 }],
    fullImageText: "本文 Oh my teeth"
  });

  assert.equal(result.status, "missing");
  assert.equal(result.items[0].reason, "template_slot_mismatch");
});

test("選択素材例外は別候補領域の正式名をverifiedにする", () => {
  const plan = buildLogoVerificationPlan({ closed: true, zones: [] }, "1024x1024", { selectedLogoCount: 1 });
  const evidenceId = plan.items[0].regionIds[1];
  const result = verifyLogoIdentity({
    identities: [{ officialWordmark: "Sample Smile" }],
    verificationPlan: plan,
    logoRegionTexts: plan.regions.map((region) => ({
      slotId: region.slotId,
      text: region.slotId === evidenceId ? "Sample Smile" : ""
    })),
    fullImageText: "本文"
  });

  assert.equal(result.status, "verified");
  assert.equal(result.items[0].mode, "selected_asset_override");
  assert.deepEqual(result.items[0].evidenceRegionIds, [evidenceId]);
});

test("選択素材例外は画像全体だけで正式名を読めても自動再生成しない", () => {
  const plan = buildLogoVerificationPlan({ closed: true, zones: [] }, "1024x1024", { selectedLogoCount: 1 });
  const result = verifyLogoIdentity({
    identities: [{ officialWordmark: "Sample Smile" }],
    verificationPlan: plan,
    logoRegionTexts: plan.regions.map((region) => ({ slotId: region.slotId, text: "" })),
    fullImageText: "本文末尾に Sample Smile"
  });

  assert.equal(result.status, "present_unlocalized");
  assert.equal(result.items[0].reason, "full_ocr_only");
});

test("選択素材例外はOCR不在だけでmissingと断定しない", () => {
  const plan = buildLogoVerificationPlan({ closed: true, zones: [] }, "1024x1024", { selectedLogoCount: 1 });
  const result = verifyLogoIdentity({
    identities: [{ officialWordmark: "Sample Smile" }],
    verificationPlan: plan,
    logoRegionTexts: plan.regions.map((region) => ({ slotId: region.slotId, text: "別の本文" })),
    fullImageText: "別の本文"
  });

  assert.equal(result.status, "not_verifiable");
  assert.equal(result.items[0].reason, "ocr_absence_unconfirmed");
});

test("複数ロゴは同じOCR領域を合格根拠として使い回さない", () => {
  const plan = buildLogoVerificationPlan({ closed: true, zones: [] }, "1024x1024", { selectedLogoCount: 2 });
  const sharedId = plan.regions[0].slotId;
  const result = verifyLogoIdentity({
    identities: [{ officialWordmark: "Alpha" }, { officialWordmark: "Beta" }],
    verificationPlan: plan,
    logoRegionTexts: plan.regions.map((region) => ({
      slotId: region.slotId,
      text: region.slotId === sharedId ? "Alpha Beta" : ""
    })),
    fullImageText: "Alpha Beta"
  });

  assert.equal(result.items.filter((item) => item.status === "verified").length, 1);
  assert.equal(new Set(result.items.flatMap((item) => item.evidenceRegionIds)).size, 1);
  assert.equal(result.status, "present_unlocalized");
});
