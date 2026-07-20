import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readJson } from "../src/core/project-store.js";
import { addBannerCreative, listBannerCreatives } from "../src/core/banner-store.js";

test("readJsonは一時的な途中書きJSONを短くリトライして読み直す", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-json-retry-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  const target = path.join(projectRoot, "data", "sample.json");
  await fs.writeFile(target, '{"items": [', "utf8");

  setTimeout(() => {
    fs.writeFile(target, JSON.stringify({ items: [1, 2, 3] }), "utf8").catch(() => null);
  }, 35);

  const result = await readJson(projectRoot, "data/sample.json");

  assert.deepEqual(result, { items: [1, 2, 3] });
});

test("空のバナーDBへ同時追加しても初期化競合でレコードを失わない", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-banner-init-race-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });

  const created = await Promise.all(Array.from({ length: 10 }, (_, index) => addBannerCreative(projectRoot, {
    productId: "product-1",
    strategyId: "strategy-1",
    title: `同時作成${index + 1}`
  })));
  const stored = await listBannerCreatives(projectRoot);

  assert.equal(stored.length, 10);
  assert.deepEqual(new Set(stored.map((banner) => banner.id)), new Set(created.map((banner) => banner.id)));
});
