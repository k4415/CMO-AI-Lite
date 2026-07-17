import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildBannerImageRevisionForm,
  buildBannerImageRevisionPrompt,
  normalizeBannerEditMode
} from "../src/core/openai-image.js";
import {
  addBannerCreative,
  claimBannerImageEdit,
  completeBannerImageEdit,
  failBannerImageEdit,
  updateBannerCreative
} from "../src/core/banner-store.js";

const appSource = await fs.readFile(new URL("../src/ui/app.js", import.meta.url), "utf8");
const htmlSource = await fs.readFile(new URL("../src/ui/index.html", import.meta.url), "utf8");

test("full edit promptは画像全体へ指示し、ユーザー指示を原文保持する", () => {
  const instruction = "全体を明るくし、より高級感のある配色に変更してください";
  const prompt = buildBannerImageRevisionPrompt({ editMode: "full", instruction });
  assert.match(prompt, /画像全体/);
  assert.match(prompt, /ユーザーの修正指示・最優先/);
  assert.match(prompt, new RegExp(instruction));
  assert.match(prompt, /指示と矛盾しない限り/);
});

test("range edit promptはマスク外保持を維持する", () => {
  const prompt = buildBannerImageRevisionPrompt({ editMode: "range", instruction: "価格を変更" });
  assert.match(prompt, /マスクで透明/);
  assert.match(prompt, /マスク外は完全に元のまま/);
});

test("full FormDataはmaskなし、range FormDataはmaskあり", () => {
  const common = {
    prompt: "prompt",
    size: "1024x1024",
    imageBuffer: Buffer.from("image"),
    imageFileName: "source.png",
    imageMime: "image/png"
  };
  const full = buildBannerImageRevisionForm({ ...common, editMode: "full" });
  assert.equal(full.has("image[]"), true);
  assert.equal(full.has("mask"), false);
  const range = buildBannerImageRevisionForm({
    ...common,
    editMode: "range",
    maskBuffer: Buffer.from("mask")
  });
  assert.equal(range.has("mask"), true);
});

test("editModeを正規化し、不正値を拒否する", () => {
  assert.equal(normalizeBannerEditMode("full", false), "full");
  assert.equal(normalizeBannerEditMode("range", true), "range");
  assert.equal(normalizeBannerEditMode("", true), "range");
  assert.equal(normalizeBannerEditMode("", false), "full");
  assert.throws(() => normalizeBannerEditMode("other", false), /editMode/);
});

test("full edit claimはleaseへeditModeを保存し、失敗時も元画像を維持する", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-full-edit-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  const banner = await addBannerCreative(projectRoot, { productId: "p1", strategyId: "s1", title: "案" });
  await updateBannerCreative(projectRoot, banner.id, {
    productionStatus: "completed",
    imageGenerationStatus: "completed",
    generatedImagePath: "outputs/banners/original.png",
    images: ["outputs/banners/original.png"]
  });
  const claim = await claimBannerImageEdit(projectRoot, banner.id, {
    ownerId: "server-a",
    attemptId: "edit-full",
    editMode: "full",
    leaseMs: 60000
  });
  assert.equal(claim.banner.imageGenerationLease.editMode, "full");
  const failed = await failBannerImageEdit(projectRoot, banner.id, "edit-full", "OpenAI error");
  assert.equal(failed.generatedImagePath, "outputs/banners/original.png");
  assert.equal(failed.imageGenerationStatus, "completed");
  assert.equal(failed.lastImageEditMode, "full");
});

test("full edit完了は画像履歴だけを更新し、コピー設計とプロンプトを保持する", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-full-edit-complete-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  const banner = await addBannerCreative(projectRoot, { productId: "p1", strategyId: "s1", title: "案" });
  const originalPath = "outputs/banners/original.png";
  const originalCopyBrief = { mainHook: "元のコピー", slotTexts: [{ slotId: "main", text: "元のコピー" }] };
  const originalPromptJson = { basic: { size: "1024x1024" }, structureSheet: { zones: [] } };
  await updateBannerCreative(projectRoot, banner.id, {
    productionStatus: "completed",
    imageGenerationStatus: "completed",
    generatedImagePath: originalPath,
    generatedImageHash: "sha256:original",
    images: [originalPath],
    imageText: "元の画像テキスト",
    copyBrief: originalCopyBrief,
    promptJson: originalPromptJson
  });
  const claim = await claimBannerImageEdit(projectRoot, banner.id, {
    ownerId: "server-a",
    attemptId: "edit-full-complete",
    editMode: "full",
    leaseMs: 60000
  });
  assert.equal(claim.claimed, true);
  const revisedPath = "outputs/banners/revised.png";
  const completed = await completeBannerImageEdit(projectRoot, banner.id, "edit-full-complete", {
    generatedImagePath: revisedPath,
    generatedImageHash: "sha256:revised",
    images: [revisedPath, originalPath],
    lastEditMode: "full",
    lastEditInstruction: "全体を明るくする",
    lastEditRegionCount: 0,
    lastEditRegions: []
  });
  assert.equal(completed.generatedImagePath, revisedPath);
  assert.deepEqual(completed.images, [revisedPath, originalPath]);
  assert.equal(completed.lastEditMode, "full");
  assert.equal(completed.imageText, "元の画像テキスト");
  assert.deepEqual(completed.copyBrief, originalCopyBrief);
  assert.deepEqual(completed.promptJson, originalPromptJson);
});

test("serverはfullをmaskなしで受け付ける分岐を持つ", async () => {
  const serverSource = await fs.readFile(new URL("../src/server.js", import.meta.url), "utf8");
  const start = serverSource.indexOf('url.pathname === "/api/banners/edit-image"');
  const block = serverSource.slice(start, start + 4500);
  assert.match(block, /editMode/);
  assert.match(block, /=== "full"/);
  assert.match(block, /editBannerImageWithGptImage2[\s\S]*\{\s*editMode,/);
  assert.match(block, /accepted:\s*true/);
});

test("詳細画面に範囲指定修正と全体修正の独立ボタンがある", () => {
  assert.match(appSource, /rowActionButton\("範囲指定修正"/);
  assert.match(appSource, /rowActionButton\("全体修正"/);
  assert.match(appSource, /openBannerFullEditModal/);
});

test("全体修正専用モーダルは矩形UIを持たない", () => {
  const start = htmlSource.indexOf('id="bannerFullEditModal"');
  assert.notEqual(start, -1);
  const end = htmlSource.indexOf('</div>\n\n    <div id="projectSwitcherModal"', start);
  const block = htmlSource.slice(start, end > start ? end : start + 3500);
  assert.match(block, /bannerFullEditInstruction/);
  assert.match(block, /runBannerFullEdit/);
  assert.doesNotMatch(block, /SelectionCanvas|選択範囲/);
});

test("pending編集はmode付きMapで追跡される", () => {
  assert.match(appSource, /pendingBannerEdits\s*=\s*new Map/);
  assert.match(appSource, /pendingBannerEdits\.set\(bannerId,\s*"full"\)/);
  assert.match(appSource, /editMode === "full" \? "全体修正" : "範囲指定修正"/);
  assert.match(appSource, /label \+ "が完了しました。"/);
});
