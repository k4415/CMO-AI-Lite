import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildBannerImageEditForm,
  buildBannerImagePrompt,
  buildBannerImageRecoveryPrompt,
  buildBannerInputImageManifest,
  extractLogoWordmark,
  logoVerificationResult,
  loadBannerInputImages
} from "../src/core/openai-image.js";
import { addBannerCreative, listBannerCreatives } from "../src/core/banner-store.js";

test("ロゴを最優先の参照画像として重複なく並べる", () => {
  const banner = {
    logoImagePaths: ["assets/logo.png"],
    logoImagePath: "assets/logo.png",
    productImagePaths: ["assets/product.png", "assets/logo.png"],
    otherImagePaths: ["assets/scene.jpg"]
  };

  assert.deepEqual(buildBannerInputImageManifest(banner), [
    { role: "brand-logo", path: "assets/logo.png", ordinal: 1, fileName: "01-brand-logo-logo.png" },
    { role: "product", path: "assets/product.png", ordinal: 2, fileName: "02-product-product.png" },
    { role: "reference", path: "assets/scene.jpg", ordinal: 3, fileName: "03-reference-scene.jpg" }
  ]);
});

test("最終画像プロンプトに添付順とロゴ必須条件を直接含める", () => {
  const banner = {
    logoImagePaths: ["assets/logo.png"],
    productImagePaths: ["assets/product.png"],
    promptJson: { productName: "テスト商品", referenceImage: { instruction: "参照素材を使う" } }
  };
  const prompt = buildBannerImagePrompt(banner);

  assert.match(prompt, /1枚目（01-brand-logo-logo\.png）: 正式なブランドロゴ/);
  assert.match(prompt, /ブランドロゴを省略しない/);
  assert.match(prompt, /2枚目（02-product-product\.png）: 実際の商品写真/);
  assert.ok(prompt.indexOf("【添付画像の役割と必須条件】") < prompt.indexOf("参照画像指示:"));
});

test("旧promptJsonの色語付きtemplateNameもgpt-image-2へ渡さない", () => {
  const prompt = buildBannerImagePrompt({
    imageText: "制作時間を5分の1に",
    promptJson: {
      templateAdId: "tpl_red_name",
      templateName: "NO.102_BtoB SaaS 赤背景 代理店チャネル変革",
      basic: { size: "1024x1024", aspectRatio: "1:1" },
      zones: []
    }
  });

  assert.doesNotMatch(prompt, /テンプレ名:|赤背景|代理店チャネル変革/);
  assert.match(prompt, /制作時間を5分の1に/);
});

test("最終画像プロンプトはpromptJsonの正本だけを使い、重複した旧promptTextを再送しない", () => {
  const prompt = buildBannerImagePrompt({
    imageText: "CPA改善仮説を戦略から\n案件ごとに検証",
    promptText: "LEGACY_DUPLICATE Copy brief: {大量の重複JSON}".repeat(200),
    promptJson: {
      productName: "CMO AI Pro",
      strategyName: "CPA改善仮説の再現",
      target: "広告成果を改善したいマーケター",
      benefit: "案件ごとに勝ち筋を検証できる",
      basic: { size: "1024x1024", aspectRatio: "1:1" },
      zones: [{
        name: "main",
        position: "center",
        purpose: "主便益を伝える",
        elements: [{ type: "text", role: "headline", content: "CPA改善仮説を戦略から" }]
      }]
    }
  });

  assert.match(prompt, /CMO AI Pro/);
  assert.match(prompt, /CPA改善仮説を戦略から/);
  assert.doesNotMatch(prompt, /LEGACY_DUPLICATE|Copy brief:/);
  assert.ok(prompt.length < 8000);
});

test("無関係出力からの復旧プロンプトは短く、確定コピーと広告用途を最優先する", () => {
  const prompt = buildBannerImageRecoveryPrompt({
    imageText: "CPA改善仮説を戦略から\n案件ごとに検証",
    promptJson: {
      productName: "CMO AI Pro",
      target: "広告成果を改善したいマーケター",
      benefit: "案件ごとに勝ち筋を検証できる",
      basic: { size: "1024x1024", aspectRatio: "1:1" },
      globalDesign: { mood: "信頼感のあるBtoB SaaS広告", visualHierarchy: "大見出しを最優先" },
      colorScheme: { main: "深い青", accent: "明るいシアン", background: "白" },
      zones: [{ name: "main", position: "center", purpose: "主便益", elements: [{ type: "text", role: "headline", content: "CPA改善仮説を戦略から" }] }]
    }
  });

  assert.match(prompt, /再生成専用/);
  assert.match(prompt, /CMO AI Pro/);
  assert.match(prompt, /CPA改善仮説を戦略から/);
  assert.match(prompt, /教育ポスター|解説図/);
  assert.ok(prompt.length < 6000);
});

test("案件配下の選択済みロゴを役割情報付きで読み込む（API呼び出しなし）", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-logo-reference-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "assets"), { recursive: true });
  await fs.writeFile(path.join(root, "assets", "logo.png"), Buffer.from("logo-bytes"));

  const images = await loadBannerInputImages(root, { logoImagePaths: ["assets/logo.png"] });
  assert.equal(images.length, 1);
  assert.equal(images[0].role, "brand-logo");
  assert.equal(images[0].fileName, "01-brand-logo-logo.png");
  assert.equal(images[0].mime, "image/png");
  assert.equal(images[0].buffer.toString(), "logo-bytes");
});

test("選択ロゴの原画像をgpt-image-2のimage[]へ直接添付する", async () => {
  const logoBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03]);
  const productBytes = Buffer.from([0xff, 0xd8, 0xff, 0x04, 0x05]);
  const form = buildBannerImageEditForm({
    prompt: "ロゴを使用する",
    size: "1024x1024",
    inputImages: [
      { role: "brand-logo", buffer: logoBytes, mime: "image/png", fileName: "01-brand-logo-logo.png" },
      { role: "product", buffer: productBytes, mime: "image/jpeg", fileName: "02-product-product.jpg" }
    ]
  });
  const images = form.getAll("image[]");

  assert.equal(form.get("model"), "gpt-image-2");
  assert.equal(form.get("quality"), "medium");
  assert.equal(images.length, 2);
  assert.equal(images[0].name, "01-brand-logo-logo.png");
  assert.equal(images[0].type, "image/png");
  assert.deepEqual(Buffer.from(await images[0].arrayBuffer()), logoBytes);
  assert.equal(images[1].name, "02-product-product.jpg");
  assert.deepEqual(Buffer.from(await images[1].arrayBuffer()), productBytes);
  assert.equal(form.get("mask"), null);
});

test("バナー作成時に選択した複数ロゴを案件DBへ保持する", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-logo-store-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const created = await addBannerCreative(root, {
    productId: "product-1",
    strategyId: "strategy-1",
    logoImagePath: "assets/logo-primary.png",
    logoImagePaths: ["assets/logo-primary.png", "assets/logo-secondary.png"]
  });
  const [stored] = await listBannerCreatives(root);

  assert.deepEqual(created.logoImagePaths, ["assets/logo-primary.png", "assets/logo-secondary.png"]);
  assert.equal(created.logoImagePath, "assets/logo-primary.png");
  assert.deepEqual(stored.logoImagePaths, created.logoImagePaths);
});

test("logo selection disables text fallback and removes logo copy from banner text", () => {
  const prompt = buildBannerImagePrompt({
    logoImagePaths: ["assets/logo.png"],
    imageText: "Main copy\nTEST BRAND\nCTA",
    promptJson: {
      zones: [{
        name: "brand",
        elements: [{ type: "logo", role: "brandLogo", content: "TEST BRAND", font: "fallback font" }]
      }]
    }
  });

  const imageTextSection = prompt.split("バナー内テキスト:")[1].split("構造シート:")[0];
  assert.doesNotMatch(imageTextSection, /TEST BRAND/);
  assert.match(prompt, /ブランド名を文字で打ち直さず/);
  assert.match(prompt, /添付された正式ロゴ画像そのもの/);
});

test("logo OCR noise is reduced to the longest official wordmark", () => {
  assert.equal(extractLogoWordmark("-- KN FITNEXUS24"), "FITNEXUS24");
});

test("生成結果から正式ワードマークの欠落を検出する", () => {
  const images = [{ role: "brand-logo", logoText: "FITNEXUS24" }];
  assert.equal(logoVerificationResult(images, "FITNEXUS FC").status, "missing");
  assert.equal(logoVerificationResult(images, "FITNEXUS24").status, "verified");
});
