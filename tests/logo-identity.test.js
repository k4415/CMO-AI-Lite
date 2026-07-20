import assert from "node:assert/strict";
import test from "node:test";

import {
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
