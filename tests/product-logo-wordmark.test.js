import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { addProduct, addProductImage, getBannerImageContext } from "../src/core/research-store.js";

test("ロゴ素材の正式ロゴ表記を商品DBへ保存し画像生成コンテキストで取得できる", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-logo-wordmark-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const product = await addProduct(root, { name: "Sample Smile" });
  const image = await addProductImage(root, product.id, {
    fileName: "logo.png",
    dataBase64: Buffer.from("logo").toString("base64"),
    role: "logo",
    label: "公式ロゴ",
    officialWordmark: "Sample Smile"
  });
  const context = await getBannerImageContext(root, product.id);

  assert.equal(image.officialWordmark, "Sample Smile");
  assert.equal(context.product.images[0].officialWordmark, "Sample Smile");
});
