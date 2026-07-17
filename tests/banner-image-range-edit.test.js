import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  BANNER_EDIT_MAX_SELECTIONS,
  BANNER_EDIT_MIN_RECT_PX,
  bannerEditRunButtonLabel,
  buildCompositeEditInstruction,
  buildEditRegionsPayload,
  canAddSelection,
  canRunBannerEditState,
  computeCompositeMaskPixels,
  computeMaskPixels,
  findOverlappingSelections,
  normalizeDragRect,
  normalizeEditRegionsFromBody,
  rectsOverlap,
  removeSelectionById,
  selectionDisplayNumber,
  selectionToImagePixels,
  validateEditRegions
} from "../src/core/banner-range-edit.js";
import {
  addBannerCreative,
  claimBannerImageEdit,
  claimBannerImageGeneration,
  failBannerImageEdit,
  updateBannerCreative
} from "../src/core/banner-store.js";

const appSource = await fs.readFile(new URL("../src/ui/app.js", import.meta.url), "utf8");
const htmlSource = await fs.readFile(new URL("../src/ui/index.html", import.meta.url), "utf8");

test("UI文言とDOMがまとめて1回修正向けに更新されている", () => {
  assert.match(htmlSource, /&#x307E;&#x3068;&#x3081;&#x3066;1&#x56DE;&#x3067;&#x4FEE;&#x6B63;/);
  assert.match(htmlSource, /bannerEditSelectionCanvas/);
  assert.doesNotMatch(htmlSource, /bannerEditPaintCanvas/);
  assert.match(appSource, /buildCompositeBannerEditMaskBase64/);
  assert.match(appSource, /regions/);
  assert.doesNotMatch(functionSource("runBannerEditAction", "async function saveOpenAiSettings"), /for \(let index = 0; index < runnable\.length; index\+\+\)/);
});

test("edit-image APIは202で非同期受付する", async () => {
  const serverSource = await fs.readFile(new URL("../src/server.js", import.meta.url), "utf8");
  const marker = 'url.pathname === "/api/banners/edit-image"';
  const start = serverSource.indexOf(marker);
  assert.notEqual(start, -1);
  const block = serverSource.slice(start, start + 5000);
  assert.match(block, /taskPromise\.catch\(\(\) => null\)/);
  assert.match(block, /accepted:\s*true/);
  assert.doesNotMatch(block, /await job\.taskPromise/);
  assert.match(block, /,\s*202\s*\)/);
});

test("クライアントは修正受付後にモーダルを閉じてバックグラウンド追跡する", () => {
  assert.match(appSource, /pendingBannerEdits/);
  assert.match(appSource, /flushPendingBannerEditToasts/);
  const closeFn = functionSource("closeBannerEditModal", "loadBannerEditBackgroundImage");
  assert.doesNotMatch(closeFn, /bannerEditState\?\.running/);
  const runFn = functionSource("runBannerEditAction", "async function saveOpenAiSettings");
  assert.match(runFn, /data\?\.accepted/);
  assert.match(runFn, /editMode:\s*"range"/);
  assert.match(runFn, /修正を受け付けました/);
  assert.doesNotMatch(runFn, /箇所の範囲指定修正が完了しました/);
});

test("矩形と番号: 選択順に①〜⑤が付き、削除後もselectionIdと指示が維持される", () => {
  assert.equal(selectionDisplayNumber(0), "①");
  const selections = [
    { selectionId: "a", instruction: "one", x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
    { selectionId: "b", instruction: "two", x: 0.6, y: 0.1, width: 0.2, height: 0.2 },
    { selectionId: "c", instruction: "three", x: 0.1, y: 0.6, width: 0.2, height: 0.2 }
  ];
  const next = removeSelectionById(selections, "b");
  assert.equal(next[0].instruction, "one");
  assert.equal(next[1].instruction, "three");
  assert.equal(canAddSelection(Array.from({ length: BANNER_EDIT_MAX_SELECTIONS }, (_, i) => ({ selectionId: String(i) }))), false);
});

test("複合マスク: 3矩形すべてが透明でユニーク面積と一致する", () => {
  const selections = [
    { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
    { x: 0.6, y: 0.1, width: 0.2, height: 0.2 },
    { x: 0.1, y: 0.6, width: 0.2, height: 0.2 }
  ];
  const mask = computeCompositeMaskPixels(selections, 100, 100);
  assert.equal(mask.width, 100);
  assert.equal(mask.height, 100);
  let uniqueTransparent = 0;
  for (let i = 3; i < mask.data.length; i += 4) if (mask.data[i] === 0) uniqueTransparent++;
  assert.equal(mask.transparentPixels, uniqueTransparent);
  assert.ok(mask.transparentPixels > 0);
  const rectA = selectionToImagePixels(selections[0], 100, 100);
  const rectB = selectionToImagePixels(selections[1], 100, 100);
  const alphaAt = (x, y) => mask.data[(y * 100 + x) * 4 + 3];
  assert.equal(alphaAt(rectA.x, rectA.y), 0);
  assert.equal(alphaAt(rectB.x, rectB.y), 0);
  assert.equal(alphaAt(50, 50), 255);
});

test("重複矩形を検出し、辺接触だけなら重複にしない", () => {
  const touching = [
    { selectionId: "a", x: 0, y: 0, width: 0.5, height: 0.5 },
    { selectionId: "b", x: 0.5, y: 0, width: 0.5, height: 0.5 }
  ];
  assert.equal(findOverlappingSelections(touching), null);
  assert.equal(rectsOverlap(touching[0], touching[1]), false);
  const overlapping = [
    { selectionId: "a", x: 0.1, y: 0.1, width: 0.3, height: 0.3, instruction: "a" },
    { selectionId: "b", x: 0.2, y: 0.2, width: 0.3, height: 0.3, instruction: "b" }
  ];
  assert.ok(findOverlappingSelections(overlapping));
  const validation = canRunBannerEditState({ selections: overlapping, running: false, jobBusy: false });
  assert.equal(validation.ok, false);
  assert.equal(validation.reason, "overlap");
});

test("構造化指示とregions payload", () => {
  const selections = [
    { selectionId: "a", x: 0.05, y: 0.05, width: 0.2, height: 0.15, instruction: "削除" },
    { selectionId: "b", x: 0.7, y: 0.7, width: 0.2, height: 0.2, instruction: "変更" }
  ];
  const instruction = buildCompositeEditInstruction(selections);
  assert.match(instruction, /【範囲①】/);
  assert.match(instruction, /【範囲②】/);
  assert.match(instruction, /指示: 削除/);
  assert.match(instruction, /x=\d+〜\d+%, y=\d+〜\d+%/);
  const regions = buildEditRegionsPayload(selections);
  assert.deepEqual(regions.map((item) => item.number), [1, 2]);
  assert.equal(validateEditRegions(regions).ok, true);
  assert.equal(normalizeEditRegionsFromBody(regions).length, 2);
});

test("実行ボタン文言が件数ベースになる", () => {
  assert.equal(bannerEditRunButtonLabel({ selections: [{ instruction: "a" }], running: false, failed: false }), "1箇所を修正");
  assert.equal(bannerEditRunButtonLabel({ selections: [{}, {}, {}], running: false, failed: false }), "3箇所をまとめて修正");
  assert.equal(bannerEditRunButtonLabel({ selections: [{}, {}], running: true, failed: false }), "2箇所をまとめて修正中…");
  assert.equal(bannerEditRunButtonLabel({ selections: [{}, {}], running: false, failed: true }), "もう一度まとめて修正");
});

test("8px未満の矩形は登録しない", () => {
  assert.equal(normalizeDragRect({ x: 0, y: 0 }, { x: 7, y: 20 }, 640, 640), null);
  const rect = normalizeDragRect({ x: 0, y: 0 }, { x: BANNER_EDIT_MIN_RECT_PX, y: 20 }, 640, 640);
  assert.ok(rect);
});

test("単一範囲マスク互換", () => {
  const selection = { x: 0.1, y: 0.1, width: 0.2, height: 0.2 };
  const single = computeMaskPixels(selection, 100, 100);
  const composite = computeCompositeMaskPixels([selection], 100, 100);
  assert.equal(single.transparentPixels, composite.transparentPixels);
});

test("操作ロック: 受付後はモーダルを閉じてバックグラウンド追跡する", () => {
  assert.doesNotMatch(functionSource("closeBannerEditModal", "loadBannerEditBackgroundImage"), /bannerEditState\?\.running/);
  assert.match(appSource, /data\?\.accepted/);
});

test("完成済みバナーはgenerate claimを拒否しedit claimは成功する", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-edit-claim-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  const banner = await addBannerCreative(projectRoot, { productId: "p1", strategyId: "s1", title: "案" });
  await updateBannerCreative(projectRoot, banner.id, {
    productionStatus: "completed",
    generatedImagePath: "outputs/banners/test.png",
    imageGenerationStatus: "completed"
  });
  const generateClaim = await claimBannerImageGeneration(projectRoot, banner.id, {
    ownerId: "server-a",
    attemptId: "gen-a",
    leaseMs: 60000
  });
  assert.equal(generateClaim.claimed, false);
  assert.equal(generateClaim.reason, "completed");
  const editClaim = await claimBannerImageEdit(projectRoot, banner.id, {
    ownerId: "server-a",
    attemptId: "edit-a",
    leaseMs: 60000
  });
  assert.equal(editClaim.claimed, true);
  assert.equal(editClaim.banner.imageGenerationLease.operationKind, "edit");
});

test("編集失敗後も元画像と完成ステータスを維持する", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-edit-fail-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  const banner = await addBannerCreative(projectRoot, { productId: "p1", strategyId: "s1", title: "案" });
  await updateBannerCreative(projectRoot, banner.id, {
    productionStatus: "completed",
    generatedImagePath: "outputs/banners/original.png",
    images: ["outputs/banners/original.png"],
    imageGenerationStatus: "completed"
  });
  const claim = await claimBannerImageEdit(projectRoot, banner.id, {
    ownerId: "server-a",
    attemptId: "edit-fail",
    leaseMs: 60000
  });
  assert.equal(claim.claimed, true);
  const failed = await failBannerImageEdit(projectRoot, banner.id, "edit-fail", "OpenAI error");
  assert.equal(failed.generatedImagePath, "outputs/banners/original.png");
  assert.equal(failed.productionStatus, "completed");
  assert.equal(failed.imageGenerationStatus, "completed");
  assert.equal(failed.lastImageEditError, "OpenAI error");
});

function functionSource(name, nextName) {
  const start = appSource.indexOf(`function ${name}`);
  const altStart = appSource.indexOf(`async function ${name}`);
  const resolvedStart = altStart >= 0 && (start < 0 || altStart < start) ? altStart : start;
  assert.notEqual(resolvedStart, -1, `missing function ${name}`);
  const end = nextName ? appSource.indexOf(`function ${nextName}`, resolvedStart + 1) : appSource.length;
  return appSource.slice(resolvedStart, end);
}
