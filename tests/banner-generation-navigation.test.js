import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const source = await fs.readFile(new URL("../src/ui/app.js", import.meta.url), "utf8");

test("addBanner(true) は制作画面切り替え後に selectItem(null, null) で詳細を閉じる", () => {
  const addBanner = functionSource("addBanner", "generateBannerBatchFull");

  assert.match(addBanner, /switchView\("banners"\);/);
  assert.match(addBanner, /if \(startGeneration\) \{\s*selectItem\(null, null\);/);
});

test("addBanner(true) は作成した最後のバナーを自動選択しない", () => {
  const addBanner = functionSource("addBanner", "generateBannerBatchFull");

  const trueBranch = addBanner.match(/if \(startGeneration\) \{([\s\S]*?)\} else \{/);
  assert.ok(trueBranch, "startGeneration の true 分岐が見つかりません");
  assert.match(trueBranch[1], /selectItem\(null, null\)/);
  assert.doesNotMatch(trueBranch[1], /selectItem\("banner", createdBanners/);
});

test("addBanner(false) は既存の自動選択を維持する", () => {
  const addBanner = functionSource("addBanner", "generateBannerBatchFull");

  assert.match(addBanner, /else \{\s*selectItem\("banner", createdBanners\[createdBanners\.length - 1\]\);/);
});

test("addBanner の単件・複数件生成分岐は変更されていない", () => {
  const addBanner = functionSource("addBanner", "generateBannerBatchFull");

  assert.match(addBanner, /if \(startGeneration && createdBanners\.length > 1\) generateBannerBatchFull\(createdBanners\)/);
  assert.match(addBanner, /else if \(startGeneration\) generateBannerFull\(createdBanners\[0\]\.id, null\)/);
});

function functionSource(name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`function ${nextName}(`, start + 1);
  assert.ok(start >= 0 && end > start, `${name}のソース範囲を取得できません`);
  return source.slice(start, end);
}
