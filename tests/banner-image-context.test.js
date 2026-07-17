import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getBannerGenerationWorkspace, getBannerImageContext } from "../src/core/research-store.js";

test("画像生成用コンテキストは商品識別情報だけを読みfactsを渡さない", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-image-context-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "data", "products.json"), JSON.stringify([{ id: "prod_1", name: "CMO AI Pro" }]), "utf8");
  await fs.writeFile(path.join(projectRoot, "data", "facts.json"), JSON.stringify([{ id: "fact_1", productId: "prod_1", content: "制作支援" }]), "utf8");
  await fs.writeFile(path.join(projectRoot, "data", "banner-creatives.json"), '{"broken": ', "utf8");

  const context = await getBannerImageContext(projectRoot, "prod_1");

  assert.equal(context.product.name, "CMO AI Pro");
  assert.equal(Object.hasOwn(context, "facts"), false);
  assert.equal(Object.hasOwn(context, "banners"), false);
});

test("バナープロンプト用workspaceは壊れたfactsファイルにも触れない", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-banner-workspace-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "data", "products.json"), "[]", "utf8");
  await fs.writeFile(path.join(projectRoot, "data", "expression-rules.json"), "[]", "utf8");
  await fs.writeFile(path.join(projectRoot, "data", "strategies.json"), "[]", "utf8");
  await fs.writeFile(path.join(projectRoot, "data", "banner-creatives.json"), "[]", "utf8");
  await fs.writeFile(path.join(projectRoot, "data", "facts.json"), '{"broken": ', "utf8");

  const context = await getBannerGenerationWorkspace(projectRoot);

  assert.deepEqual(Object.keys(context).sort(), ["adTemplates", "banners", "expressionRules", "products", "strategies"]);
});
