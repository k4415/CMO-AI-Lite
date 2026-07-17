import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readJson } from "../src/core/project-store.js";

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
