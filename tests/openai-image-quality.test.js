import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildBannerImageEditForm,
  generateBannerImageWithGptImage2,
  resolveBannerImageQuality
} from "../src/core/openai-image.js";
import { addBannerCreative, listBannerCreatives, updateBannerCreative } from "../src/core/banner-store.js";

const PNG_BYTES = Buffer.from("quality-test-png");

test("バナー画像品質はlowを既定値にし、明示したmediumだけを許可する", () => {
  assert.equal(resolveBannerImageQuality(undefined), "low");
  assert.equal(resolveBannerImageQuality("low"), "low");
  assert.equal(resolveBannerImageQuality("medium"), "medium");
  assert.equal(resolveBannerImageQuality("unexpected"), "low");
});

test("素材付き画像生成フォームは指定されたlow品質をgpt-image-2へ送る", () => {
  const form = buildBannerImageEditForm({
    prompt: "日本語バナーを生成",
    size: "1024x1024",
    inputImages: [{ buffer: PNG_BYTES, mime: "image/png", fileName: "logo.png" }],
    quality: "low"
  });

  assert.equal(form.get("quality"), "low");
  assert.equal(form.get("model"), "gpt-image-2");
});

test("通常画像生成はlowを既定値にして送信品質と所要時間を監査へ保存する", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-image-quality-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });

  const originalKey = process.env.OPENAI_API_KEY;
  const originalQuality = process.env.CMOAI_BANNER_IMAGE_QUALITY;
  process.env.OPENAI_API_KEY = "test-key";
  delete process.env.CMOAI_BANNER_IMAGE_QUALITY;
  t.after(() => {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    if (originalQuality === undefined) delete process.env.CMOAI_BANNER_IMAGE_QUALITY;
    else process.env.CMOAI_BANNER_IMAGE_QUALITY = originalQuality;
  });

  const created = await addBannerCreative(projectRoot, {
    productId: "product-1",
    strategyId: "strategy-1",
    title: "quality"
  });
  const banner = await updateBannerCreative(projectRoot, created.id, {
    imageText: "3分で広告案",
    promptJson: {
      productName: "広告改善AI",
      basic: { size: "1024x1024" },
      zones: [{ name: "main", elements: [{ type: "text", role: "headline", content: "3分で広告案" }] }]
    }
  });
  let requestBody = null;
  const fetchImpl = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ data: [{ b64_json: PNG_BYTES.toString("base64") }] }), {
      status: 200,
      headers: { "content-type": "application/json", "x-request-id": "req-quality" }
    });
  };

  await generateBannerImageWithGptImage2(projectRoot, banner, {
    fetchImpl,
    ocrReader: async () => ({ ocrText: "3分で広告案", logoRegionTexts: [], ocrError: "" })
  });
  const [stored] = await listBannerCreatives(projectRoot);

  assert.equal(requestBody.quality, "low");
  assert.equal(stored.imageGenerationAudit.quality, "low");
  assert.equal(stored.imageGenerationAudit.attempts[0].quality, "low");
  assert.ok(Number.isInteger(stored.imageGenerationAudit.attempts[0].durationMs));
  assert.ok(stored.imageGenerationAudit.attempts[0].durationMs >= 0);
});
