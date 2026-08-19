import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { generateBannerImageWithGptImage2 } from "../src/core/openai-image.js";
import { addBannerCreative, listBannerCreatives, updateBannerCreative } from "../src/core/banner-store.js";

const PNG_BYTES = Buffer.from("fake-png-for-final-prompt");

function hashPrompt(prompt) {
  return `sha256:${crypto.createHash("sha256").update(prompt).digest("hex")}`;
}

test("画像生成時にsentPromptとfinalImagePromptを保存し再読込できる", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-final-prompt-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  t.after(() => {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  });

  const prose = [
    "形式：1024x1024の正方形広告バナー。",
    "目的・戦略：固定コピーを一瞬で伝える。",
    "スタイル・トーン：視線誘導を明確にする。",
    "視線は上部から入り、斜めの帯が商品ゾーンへ誘導する。".repeat(8)
  ].join("\n");
  const created = await addBannerCreative(projectRoot, { productId: "p1", strategyId: "s1", title: "final prompt" });
  const banner = await updateBannerCreative(projectRoot, created.id, {
    imageText: "固定コピーA\n固定コピーB",
    writtenImagePrompt: prose,
    promptJson: {
      productName: "CMO AI Pro",
      basic: { size: "1024x1024" },
      zones: [{ name: "main", position: "center", purpose: "主便益", elements: [{ type: "text", role: "headline", content: "固定コピーA" }] }]
    },
    promptText: "legacy preview prompt"
  });

  let sentPrompt = "";
  const fetchImpl = async (_url, options) => {
    sentPrompt = JSON.parse(options.body).prompt;
    return new Response(JSON.stringify({ data: [{ b64_json: PNG_BYTES.toString("base64") }] }), {
      status: 200,
      headers: { "content-type": "application/json", "x-request-id": "req_final" }
    });
  };
  const ocrReader = async () => ({ ocrText: "固定コピーA\n固定コピーB", ocrError: "" });

  await generateBannerImageWithGptImage2(projectRoot, banner, { fetchImpl, ocrReader });
  const [stored] = await listBannerCreatives(projectRoot);

  assert.ok(sentPrompt.length > 0);
  assert.match(sentPrompt, /^形式：/);
  assert.doesNotMatch(sentPrompt, /【デザイン完成イメージ】/);
  assert.doesNotMatch(sentPrompt, /legacy preview prompt/);
  assert.equal(stored.finalImagePrompt, sentPrompt);
  assert.equal(stored.imageGenerationAudit.attempts.length, 1);
  assert.equal(stored.imageGenerationAudit.attempts[0].sentPrompt, sentPrompt);
  assert.equal(stored.imageGenerationAudit.attempts[0].promptHash, hashPrompt(sentPrompt));
  assert.equal(stored.imageGenerationAudit.attempts[0].promptLength, sentPrompt.length);
});

test("失敗時も最後に送信したpromptをfinalImagePromptへ保存する", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-final-prompt-fail-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  t.after(() => {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  });

  const created = await addBannerCreative(projectRoot, { productId: "p1", strategyId: "s1", title: "final prompt fail" });
  const banner = await updateBannerCreative(projectRoot, created.id, {
    imageText: "固定コピーA\n固定コピーB",
    promptJson: { productName: "CMO AI Pro", basic: { size: "1024x1024" }, zones: [] },
    promptText: "legacy"
  });
  const prompts = [];
  const fetchImpl = async (_url, options) => {
    prompts.push(JSON.parse(options.body).prompt);
    return new Response(JSON.stringify({ data: [{ b64_json: PNG_BYTES.toString("base64") }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const ocrReader = async (_projectRoot, _relativePath, attempt) => attempt === 1
    ? {
        ocrText: "TYPES OF CLOUDS\nCIRRUS high altitude thin clouds\nCUMULUS fluffy clouds across the sky\nLearn more about weather",
        ocrError: ""
      }
    : {
        ocrText: "TYPES OF CLOUDS\nCIRRUS high altitude thin clouds\nCUMULUS fluffy clouds across the sky\nLearn more about weather",
        ocrError: ""
      };

  await assert.rejects(
    () => generateBannerImageWithGptImage2(projectRoot, banner, { fetchImpl, ocrReader }),
    /改善しませんでした/
  );
  const [stored] = await listBannerCreatives(projectRoot);

  assert.equal(prompts.length, 2);
  assert.equal(stored.finalImagePrompt, prompts[1]);
  assert.equal(stored.imageGenerationAudit.attempts[1].sentPrompt, prompts[1]);
  assert.equal(stored.imageGenerationAudit.attempts[0].sentPrompt, prompts[0]);
});

test("sentPromptのない旧audit構造もnormalize後に読み込める", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-final-prompt-legacy-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });

  const created = await addBannerCreative(projectRoot, { productId: "p1", strategyId: "s1", title: "legacy audit" });
  const legacyAudit = {
    version: 1,
    model: "gpt-image-2",
    size: "1024x1024",
    quality: "low",
    startedAt: "2026-01-01T00:00:00.000Z",
    selectedAttempt: 1,
    completedAt: "2026-01-01T00:00:01.000Z",
    attempts: [{
      attempt: 1,
      quality: "low",
      requestId: "req_legacy",
      promptHash: "sha256:abc",
      promptLength: 120,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
      durationMs: 1000,
      outcome: "accepted"
    }]
  };
  const saved = await updateBannerCreative(projectRoot, created.id, {
    finalImagePrompt: "",
    imageGenerationAudit: legacyAudit,
    imageGenerationStatus: "completed"
  });

  assert.equal(saved.imageGenerationAudit.attempts[0].promptHash, "sha256:abc");
  assert.equal(Object.prototype.hasOwnProperty.call(saved.imageGenerationAudit.attempts[0], "sentPrompt"), false);
  assert.equal(saved.finalImagePrompt, "");

  const [reloaded] = await listBannerCreatives(projectRoot);
  assert.deepEqual(reloaded.imageGenerationAudit, legacyAudit);
  assert.equal(reloaded.finalImagePrompt, "");
});

test("prompt無効化時にfinalImagePromptを消去する", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-final-prompt-clear-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });

  const created = await addBannerCreative(projectRoot, { productId: "p1", strategyId: "s1", title: "clear final prompt" });
  await updateBannerCreative(projectRoot, created.id, {
    finalImagePrompt: "sent prompt body",
    promptText: "preview",
    promptJson: { zones: [] },
    writtenImagePrompt: "prose"
  });
  const cleared = await updateBannerCreative(projectRoot, created.id, {
    additionalInstruction: "背景を明るく"
  });

  assert.equal(cleared.finalImagePrompt, "");
  assert.equal(cleared.writtenImagePrompt, "");
});
