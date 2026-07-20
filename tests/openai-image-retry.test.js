import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { generateBannerImageWithGptImage2, validateLogoRecoveryEditRequest } from "../src/core/openai-image.js";
import { addBannerCreative, listBannerCreatives, updateBannerCreative } from "../src/core/banner-store.js";

const PNG_BYTES = Buffer.from("fake-png-for-request-flow");

test("ロゴ修復入力が上限を超える場合は選択素材を削らず送信前に停止する", () => {
  const images = Array.from({ length: 3 }, (_, index) => ({
    role: index === 0 ? "current-banner" : "brand-logo",
    fileName: `${index}.png`,
    mime: "image/png",
    buffer: PNG_BYTES
  }));

  const result = validateLogoRecoveryEditRequest(images, { maxInputs: 2 });
  assert.equal(result.ok, false);
  assert.equal(result.code, "LOGO_RECOVERY_INPUT_LIMIT");
  assert.equal(images.length, 3);
});

test("無関係画像は完了扱いせず、短い復旧プロンプトで1回だけ自動再生成する", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-image-retry-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  const originalKey = process.env.OPENAI_API_KEY;
  process.env["OPENAI_API_KEY"] = "test-key";
  t.after(() => {
    if (originalKey === undefined) delete process.env["OPENAI_API_KEY"];
    else process.env["OPENAI_API_KEY"] = originalKey;
  });

  const created = await addBannerCreative(projectRoot, { productId: "p1", strategyId: "s1", title: "retry" });
  const banner = await updateBannerCreative(projectRoot, created.id, {
    imageText: "CPA改善仮説を戦略から\n案件ごとに検証",
    promptJson: {
      productName: "CMO AI Pro",
      target: "広告成果を改善したいマーケター",
      benefit: "案件ごとに勝ち筋を検証できる",
      basic: { size: "1024x1024" },
      zones: [{ name: "main", position: "center", purpose: "主便益", elements: [{ type: "text", role: "headline", content: "CPA改善仮説を戦略から" }] }]
    },
    promptText: "legacy prompt"
  });
  const prompts = [];
  let requestCount = 0;
  const fetchImpl = async (_url, options) => {
    requestCount += 1;
    prompts.push(JSON.parse(options.body).prompt);
    return new Response(JSON.stringify({ data: [{ b64_json: PNG_BYTES.toString("base64") }] }), {
      status: 200,
      headers: { "content-type": "application/json", "x-request-id": `req_${requestCount}` }
    });
  };
  const ocrReader = async (_projectRoot, _relativePath, attempt) => attempt === 1
    ? {
        ocrText: "TYPES OF CLOUDS\nCIRRUS high altitude thin clouds\nCUMULUS fluffy clouds across the sky\nLearn more about weather",
        ocrError: ""
      }
    : { ocrText: "CPA改善仮説を戦略から\n案件ごとに検証", ocrError: "" };

  await generateBannerImageWithGptImage2(projectRoot, banner, { fetchImpl, ocrReader });
  const [stored] = await listBannerCreatives(projectRoot);

  assert.equal(requestCount, 2);
  assert.doesNotMatch(prompts[0], /legacy prompt/);
  assert.match(prompts[1], /再生成専用/);
  assert.equal(stored.imageGenerationStatus, "completed");
  assert.equal(stored.imageGenerationAudit.attempts.length, 2);
  assert.equal(stored.imageGenerationAudit.attempts[0].outcome, "gross_mismatch");
  assert.equal(stored.imageGenerationAudit.attempts[0].requestId, "req_1");
  assert.equal(stored.imageGenerationAudit.attempts[1].outcome, "accepted");
  assert.equal(stored.imageGenerationAudit.selectedAttempt, 2);
  assert.equal(stored.images.length, 1);
  assert.match(stored.generatedImagePath, /attempt-2/);
});

test("復旧後も無関係なら完了にせず失敗として保存する", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-image-retry-fail-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  const originalKey = process.env.OPENAI_API_KEY;
  process.env["OPENAI_API_KEY"] = "test-key";
  t.after(() => {
    if (originalKey === undefined) delete process.env["OPENAI_API_KEY"];
    else process.env["OPENAI_API_KEY"] = originalKey;
  });

  const created = await addBannerCreative(projectRoot, { productId: "p1", strategyId: "s1", title: "retry fail" });
  const banner = await updateBannerCreative(projectRoot, created.id, {
    imageText: "固定コピーA\n固定コピーB",
    promptJson: { productName: "CMO AI Pro", basic: { size: "1024x1024" }, zones: [] },
    promptText: "prompt"
  });
  let requestCount = 0;
  const fetchImpl = async () => {
    requestCount += 1;
    return new Response(JSON.stringify({ data: [{ b64_json: PNG_BYTES.toString("base64") }] }), {
      status: 200,
      headers: { "content-type": "application/json", "x-request-id": `req_fail_${requestCount}` }
    });
  };
  const ocrReader = async () => ({
    ocrText: "THE HUMAN BRAIN\nFRONTAL LOBE and memory\nPARIETAL LOBE and perception\nLearn how the brain works",
    ocrError: ""
  });

  await assert.rejects(
    generateBannerImageWithGptImage2(projectRoot, banner, { fetchImpl, ocrReader }),
    (error) => error.code === "IMAGE_OUTPUT_UNRELATED"
  );
  const [stored] = await listBannerCreatives(projectRoot);

  assert.equal(requestCount, 2);
  assert.equal(stored.imageGenerationStatus, "failed");
  assert.equal(stored.generatedImagePath, "");
  assert.equal(stored.imageGenerationAudit.attempts.length, 2);
  assert.equal(stored.imageGenerationAudit.selectedAttempt, null);
});

test("ロゴ領域で正式表記が欠けた場合は1回だけ再生成し、改善後に完了する", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-logo-retry-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, "assets"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "assets", "sample-brand.png"), Buffer.from("source-logo"));
  const originalKey = process.env.OPENAI_API_KEY;
  process.env["OPENAI_API_KEY"] = "test-key";
  t.after(() => {
    if (originalKey === undefined) delete process.env["OPENAI_API_KEY"];
    else process.env["OPENAI_API_KEY"] = originalKey;
  });

  const created = await addBannerCreative(projectRoot, { productId: "p1", strategyId: "s1", title: "logo retry", logoImagePaths: ["assets/sample-brand.png"] });
  const banner = await updateBannerCreative(projectRoot, created.id, {
    imageText: "毎日をもっと便利に",
    promptJson: {
      productName: "Sample Smile",
      basic: { size: "1024x1024" },
      templateStructureContract: {
        closed: true,
        zoneCount: 1,
        elementCount: 1,
        typeCounts: { text: 0, image: 1, shape: 0 },
        zones: [{ elements: [{ slotId: "z1e1", type: "image", role: "logo", messageRole: "logo", position: { top: "3%", left: "80%" }, size: "17% width x 7% height" }] }]
      },
      zones: [{ name: "brand", elements: [{ slotId: "z1e1", type: "image", role: "logo", messageRole: "logo", position: { top: "3%", left: "80%" }, size: "17% width x 7% height" }] }]
    }
  });
  const prompts = [];
  const imageInputs = [];
  const fetchImpl = async (_url, options) => {
    prompts.push(options.body.get("prompt"));
    imageInputs.push(options.body.getAll("image[]").map((part) => part.name));
    return new Response(JSON.stringify({ data: [{ b64_json: PNG_BYTES.toString("base64") }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const ocrReader = async (_root, _path, attempt, options) => ({
    ocrText: "毎日をもっと便利に Sample Smile",
    ocrError: "",
    logoRegionTexts: [{ slotId: options.logoRegions[0].slotId, text: attempt === 1 ? "SMILE" : "Sample Smile" }]
  });
  await generateBannerImageWithGptImage2(projectRoot, banner, {
    fetchImpl,
    ocrReader,
    product: { id: "p1", name: "Sample Smile", images: [{ id: "img1", path: "assets/sample-brand.png", role: "logo", officialWordmark: "Sample Smile" }] }
  });
  const [stored] = await listBannerCreatives(projectRoot);

  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /正式ワードマークは「Sample Smile」/);
  assert.match(prompts[1], /ロゴ特化編集/);
  assert.deepEqual(imageInputs.map((items) => items.length), [1, 2]);
  assert.match(imageInputs[1][0], /current-banner/);
  assert.match(imageInputs[1][1], /brand-logo/);
  assert.equal(stored.logoVerification.status, "verified");
  assert.equal(stored.productionStatus, "completed");
  assert.equal(stored.imageGenerationAudit.attempts[0].outcome, "logo_mismatch");
});

test("選択素材例外は全体OCRだけで正式名が見つかっても再生成しない", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-logo-present-unlocalized-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, "assets"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "assets", "sample-brand.png"), Buffer.from("source-logo"));
  const originalKey = process.env.OPENAI_API_KEY;
  process.env["OPENAI_API_KEY"] = "test-key";
  t.after(() => {
    if (originalKey === undefined) delete process.env["OPENAI_API_KEY"];
    else process.env["OPENAI_API_KEY"] = originalKey;
  });

  const created = await addBannerCreative(projectRoot, {
    productId: "p1", strategyId: "s1", title: "unlocalized", logoImagePaths: ["assets/sample-brand.png"]
  });
  const banner = await updateBannerCreative(projectRoot, created.id, {
    imageText: "毎日をもっと便利に",
    promptJson: {
      productName: "Sample Smile",
      basic: { size: "1024x1024" },
      templateStructureContract: {
        closed: true,
        zoneCount: 1,
        elementCount: 1,
        typeCounts: { text: 1, image: 0, shape: 0 },
        zones: [{ elements: [{ slotId: "z1e1", type: "text", role: "headline" }] }]
      },
      zones: [{ name: "main", elements: [{ slotId: "z1e1", type: "text", role: "headline", content: "毎日をもっと便利に" }] }]
    }
  });
  let requestCount = 0;
  const fetchImpl = async () => {
    requestCount += 1;
    return new Response(JSON.stringify({ data: [{ b64_json: PNG_BYTES.toString("base64") }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const ocrReader = async (_root, _path, _attempt, options) => ({
    ocrText: "毎日をもっと便利に Sample Smile",
    ocrError: "",
    logoRegionTexts: options.logoRegions.map((region) => ({ slotId: region.slotId, text: "" }))
  });

  await generateBannerImageWithGptImage2(projectRoot, banner, {
    fetchImpl,
    ocrReader,
    product: { id: "p1", name: "Sample Smile", images: [{ id: "img1", path: "assets/sample-brand.png", role: "logo", officialWordmark: "Sample Smile" }] }
  });
  const [stored] = await listBannerCreatives(projectRoot);

  assert.equal(requestCount, 1);
  assert.equal(stored.logoVerification.status, "present_unlocalized");
  assert.equal(stored.productionStatus, "completed_with_warnings");
  assert.ok(stored.warnings.some((warning) => warning.type === "logo_mismatch" && warning.code === "LOGO_LOCATION_UNVERIFIED"));
  assert.equal(stored.imageGenerationAudit.attempts[0].retryDecision, "skip_present_unlocalized");
});

test("テンプレにロゴ枠がなくても選択ロゴ例外領域で正式表記を検証する", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-logo-fallback-region-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, "assets"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "assets", "sample-brand.png"), Buffer.from("source-logo"));
  const originalKey = process.env.OPENAI_API_KEY;
  process.env["OPENAI_API_KEY"] = "test-key";
  t.after(() => {
    if (originalKey === undefined) delete process.env["OPENAI_API_KEY"];
    else process.env["OPENAI_API_KEY"] = originalKey;
  });

  const created = await addBannerCreative(projectRoot, {
    productId: "p1",
    strategyId: "s1",
    title: "logo fallback region",
    logoImagePaths: ["assets/sample-brand.png"]
  });
  const banner = await updateBannerCreative(projectRoot, created.id, {
    imageText: "毎日をもっと便利に",
    promptJson: {
      productName: "Sample Smile",
      basic: { size: "1024x1024" },
      templateStructureContract: {
        closed: true,
        zoneCount: 1,
        elementCount: 1,
        typeCounts: { text: 1, image: 0, shape: 0 },
        zones: [{ elements: [{ slotId: "z1e1", type: "text", role: "headline" }] }]
      },
      zones: [{ name: "main", elements: [{ slotId: "z1e1", type: "text", role: "headline", content: "毎日をもっと便利に" }] }]
    }
  });
  const prompts = [];
  const observedRegions = [];
  const fetchImpl = async (_url, options) => {
    prompts.push(options.body.get("prompt"));
    return new Response(JSON.stringify({ data: [{ b64_json: PNG_BYTES.toString("base64") }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const ocrReader = async (_root, _path, _attempt, options) => {
    observedRegions.push(options.logoRegions);
    return {
      ocrText: "毎日をもっと便利に Sample Smile",
      ocrError: "",
      logoRegionTexts: [{ slotId: options.logoRegions[0].slotId, text: "Sample Smile" }]
    };
  };

  await generateBannerImageWithGptImage2(projectRoot, banner, {
    fetchImpl,
    ocrReader,
    product: { id: "p1", name: "Sample Smile", images: [{ id: "img1", path: "assets/sample-brand.png", role: "logo", officialWordmark: "Sample Smile" }] }
  });
  const [stored] = await listBannerCreatives(projectRoot);

  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /selected-logo-fallback-1/);
  assert.equal(observedRegions[0][0].slotId, "selected-logo-fallback-1");
  assert.equal(stored.logoVerification.status, "verified");
  assert.equal(stored.productionStatus, "completed");
});

test("ロゴ再生成後も正式表記が欠ける場合は失敗にせず警告完了する", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-logo-warning-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, "assets"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "assets", "sample-brand.png"), Buffer.from("source-logo"));
  const originalKey = process.env.OPENAI_API_KEY;
  process.env["OPENAI_API_KEY"] = "test-key";
  t.after(() => {
    if (originalKey === undefined) delete process.env["OPENAI_API_KEY"];
    else process.env["OPENAI_API_KEY"] = originalKey;
  });

  const created = await addBannerCreative(projectRoot, { productId: "p1", strategyId: "s1", title: "logo warning", logoImagePaths: ["assets/sample-brand.png"] });
  const banner = await updateBannerCreative(projectRoot, created.id, {
    imageText: "毎日をもっと便利に",
    promptJson: {
      productName: "Sample Smile",
      basic: { size: "1024x1024" },
      templateStructureContract: { closed: true, zoneCount: 1, elementCount: 1, typeCounts: { text: 0, image: 1, shape: 0 }, zones: [{ elements: [{ slotId: "z1e1", type: "image", role: "logo", messageRole: "logo", position: { top: "3%", left: "80%" }, size: "17% width x 7% height" }] }] },
      zones: [{ name: "brand", elements: [{ slotId: "z1e1", type: "image", role: "logo", messageRole: "logo", position: { top: "3%", left: "80%" }, size: "17% width x 7% height" }] }]
    }
  });
  let requestCount = 0;
  const fetchImpl = async () => {
    requestCount += 1;
    return new Response(JSON.stringify({ data: [{ b64_json: PNG_BYTES.toString("base64") }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const ocrReader = async (_root, _path, _attempt, options) => ({
    ocrText: "毎日をもっと便利に Sample Smile",
    ocrError: "",
    logoRegionTexts: [{ slotId: options.logoRegions[0].slotId, text: "SMILE" }]
  });
  await generateBannerImageWithGptImage2(projectRoot, banner, {
    fetchImpl,
    ocrReader,
    product: { id: "p1", name: "Sample Smile", images: [{ id: "img1", path: "assets/sample-brand.png", role: "logo", officialWordmark: "Sample Smile" }] }
  });
  const [stored] = await listBannerCreatives(projectRoot);

  assert.equal(requestCount, 2);
  assert.equal(stored.imageGenerationStatus, "completed");
  assert.equal(stored.productionStatus, "completed_with_warnings");
  assert.equal(stored.logoVerification.status, "missing");
  assert.ok(stored.warnings.some((warning) => warning.type === "logo_mismatch"));
});
