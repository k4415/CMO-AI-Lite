import assert from "node:assert/strict";
import test from "node:test";

import { createAiJobSourceCache } from "../src/core/ai-job-source-cache.js";

function createFakeFs(files) {
  const reads = new Map();
  const stats = new Map();
  let failPath = "";
  return {
    api: {
      async stat(filePath) {
        stats.set(filePath, (stats.get(filePath) || 0) + 1);
        if (filePath === failPath) throw Object.assign(new Error("EIO /secret/path"), { code: "EIO" });
        const file = files.get(filePath);
        if (!file) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return { mtimeMs: file.version, ctimeMs: file.version, size: file.body.length, ino: file.ino || 1 };
      },
      async readFile(filePath) {
        reads.set(filePath, (reads.get(filePath) || 0) + 1);
        if (filePath === failPath) throw Object.assign(new Error("EIO /secret/path"), { code: "EIO" });
        return files.get(filePath).body;
      }
    },
    reads,
    stats,
    fail(filePath) { failPath = filePath; },
    recover() { failPath = ""; }
  };
}

test("同じfingerprintは再読込せず、変更sourceだけを再projectionする", async () => {
  const files = new Map([
    ["/p/data/material-extraction-jobs.json", { version: 1, body: "\ufeff[]" }],
    ["/p/data/research-materials.json", { version: 1, body: JSON.stringify([{ id: "m1", title: "LP", text: "large secret" }]) }],
    ["/p/data/banner-creatives.json", { version: 1, body: "[]" }],
    ["/shared/ad-templates.json", { version: 1, body: "[]" }]
  ]);
  const fake = createFakeFs(files);
  const cache = createAiJobSourceCache({ fsApi: fake.api, retryDelays: [] });
  const args = { projectRoot: "/p", sharedTemplatesPath: "/shared/ad-templates.json" };
  const first = await cache.loadSources(args);
  const second = await cache.loadSources(args);
  assert.equal(fake.reads.get("/p/data/research-materials.json"), 1);
  assert.deepEqual(first.materials, [{ id: "m1", title: "LP", sourceUrl: "" }]);
  assert.equal("text" in first.materials[0], false);
  assert.equal(second.signature, first.signature);

  files.set("/p/data/banner-creatives.json", { version: 2, body: JSON.stringify([{ id: "b1", title: "B", hugePrompt: "omit" }]) });
  const third = await cache.loadSources(args);
  assert.equal(fake.reads.get("/p/data/banner-creatives.json"), 2);
  assert.equal(fake.reads.get("/p/data/research-materials.json"), 1);
  assert.equal(third.banners[0].id, "b1");
  assert.equal("hugePrompt" in third.banners[0], false);
});

test("同時reloadは同じPromiseを共有する", async () => {
  let release;
  let reads = 0;
  const body = "[]";
  const fsApi = {
    async stat() { return { mtimeMs: 1, ctimeMs: 1, size: body.length, ino: 1 }; },
    async readFile() {
      reads += 1;
      await new Promise((resolve) => { release = resolve; });
      return body;
    }
  };
  const cache = createAiJobSourceCache({ fsApi, retryDelays: [] });
  const first = cache.loadFile("/one.json", "templates");
  const second = cache.loadFile("/one.json", "templates");
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await Promise.all([first, second]);
  assert.equal(reads, 1);
});

test("成功後の一時障害は前回値と固定warning、初回障害はthrow", async () => {
  const files = new Map([["/one.json", { version: 1, body: JSON.stringify([{ id: "t1", title: "T" }]) }]]);
  const fake = createFakeFs(files);
  const cache = createAiJobSourceCache({ fsApi: fake.api, retryDelays: [] });
  const first = await cache.loadFile("/one.json", "templates");
  fake.fail("/one.json");
  const stale = await cache.loadFile("/one.json", "templates");
  assert.deepEqual(stale.data, first.data);
  assert.equal(stale.warning, "一部のAIジョブ情報は直前に取得できた内容を表示しています。");

  const emptyCache = createAiJobSourceCache({ fsApi: fake.api, retryDelays: [] });
  await assert.rejects(emptyCache.loadFile("/one.json", "templates"), /AIジョブ情報を読み込めませんでした/);
});
