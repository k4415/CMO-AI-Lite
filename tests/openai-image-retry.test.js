import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { generateBannerImageWithGptImage2 } from "../src/core/openai-image.js";
import { addBannerCreative, listBannerCreatives, updateBannerCreative } from "../src/core/banner-store.js";

const PNG_BYTES = Buffer.from("fake-png-for-request-flow");

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
