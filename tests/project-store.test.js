import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createProject, listProjects, replaceFileWithRetry, updateProjectStatus, writeJson } from "../src/core/project-store.js";

async function createTestProject(projectsRoot, id, overrides = {}) {
  const projectRoot = path.join(projectsRoot, id);
  await fs.mkdir(projectRoot, { recursive: true });
  const project = {
    projectName: overrides.projectName || id,
    status: overrides.status || "draft",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    product: { name: "テスト商品" },
    ...overrides
  };
  await fs.writeFile(path.join(projectRoot, "project.json"), JSON.stringify(project, null, 2), "utf8");
  return projectRoot;
}

test("createProject はLite向けの空DBだけを持つ案件を作成する", async (t) => {
  const projectsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-create-project-"));
  const originalCwd = process.cwd();
  t.after(async () => {
    process.chdir(originalCwd);
    await fs.rm(projectsRoot, { recursive: true, force: true });
  });
  process.chdir(projectsRoot);
  await fs.mkdir(path.join(projectsRoot, "projects"), { recursive: true });
  await fs.cp(path.join(originalCwd, "projects/_template"), path.join(projectsRoot, "projects/_template"), { recursive: true });

  const projectRoot = path.join(projectsRoot, "projects/sample-lite");
  const project = await createProject(projectRoot, {
    projectName: "sample-lite",
    productName: "テスト商品",
    officialUrl: "https://example.com/product"
  });

  assert.equal(project.projectName, "sample-lite");
  assert.equal((await fs.stat(path.join(projectRoot, "data/research-materials.json"))).isFile(), true);
  assert.equal((await fs.stat(path.join(projectRoot, "data/material-extraction-jobs.json"))).isFile(), true);
  await assert.rejects(fs.stat(path.join(projectRoot, "data/copy-creatives.json")));
  await assert.rejects(fs.stat(path.join(projectRoot, "data/script-creatives.json")));
  await assert.rejects(fs.stat(path.join(projectRoot, "data/article-lp-creatives.json")));
  await assert.rejects(fs.stat(path.join(projectRoot, "insights/n1-analysis.md")));
  await assert.rejects(fs.stat(path.join(projectRoot, "strategy/creative-guideline.md")));
});

test("案件を削除せずアーカイブし、一覧にステータスと更新日時を返す", async (t) => {
  const projectsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-projects-"));
  t.after(() => fs.rm(projectsRoot, { recursive: true, force: true }));
  const projectRoot = await createTestProject(projectsRoot, "sample");

  const updated = await updateProjectStatus(projectRoot, "archived");

  assert.equal(updated.status, "archived");
  assert.notEqual(updated.updatedAt, "2026-01-01T00:00:00.000Z");
  assert.equal((await fs.stat(projectRoot)).isDirectory(), true);
  const projects = await listProjects(projectsRoot);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].status, "archived");
  assert.equal(projects[0].updatedAt, updated.updatedAt);
});

test("アーカイブ済み案件をdraftへ復元する", async (t) => {
  const projectsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-projects-"));
  t.after(() => fs.rm(projectsRoot, { recursive: true, force: true }));
  const projectRoot = await createTestProject(projectsRoot, "sample", { status: "archived" });

  const updated = await updateProjectStatus(projectRoot, "draft");

  assert.equal(updated.status, "draft");
  const saved = JSON.parse(await fs.readFile(path.join(projectRoot, "project.json"), "utf8"));
  assert.equal(saved.status, "draft");
  assert.equal(saved.updatedAt, updated.updatedAt);
});

test("不正な案件ステータスを拒否してproject.jsonを変更しない", async (t) => {
  const projectsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-projects-"));
  t.after(() => fs.rm(projectsRoot, { recursive: true, force: true }));
  const projectRoot = await createTestProject(projectsRoot, "sample");
  const before = await fs.readFile(path.join(projectRoot, "project.json"), "utf8");

  await assert.rejects(
    updateProjectStatus(projectRoot, "deleted"),
    (error) => error.code === "INVALID_PROJECT_STATUS"
  );

  assert.equal(await fs.readFile(path.join(projectRoot, "project.json"), "utf8"), before);
});

test("存在しない案件の更新を拒否する", async (t) => {
  const projectsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-projects-"));
  t.after(() => fs.rm(projectsRoot, { recursive: true, force: true }));

  await assert.rejects(
    updateProjectStatus(path.join(projectsRoot, "missing"), "archived"),
    (error) => error.code === "PROJECT_NOT_FOUND"
  );
});

test("Windowsの一時的なrenameエラーを再試行する", async () => {
  const attempts = [];
  const delays = [];
  const removals = [];
  const rename = async () => {
    attempts.push(Date.now());
    if (attempts.length < 3) throw Object.assign(new Error("temporarily locked"), { code: "EPERM" });
  };

  await replaceFileWithRetry("source.tmp", "target.json", {
    rename,
    remove: async (...args) => removals.push(args),
    sleep: async (delayMs) => delays.push(delayMs),
    retryDelays: [10, 20, 30]
  });

  assert.equal(attempts.length, 3);
  assert.deepEqual(delays, [10, 20]);
  assert.deepEqual(removals, [["source.tmp", { force: true }]]);
});

test("恒久的なrenameエラーは再試行せず一時ファイルを削除する", async () => {
  let attempts = 0;
  let removed = false;
  const expected = Object.assign(new Error("invalid target"), { code: "EINVAL" });

  await assert.rejects(
    replaceFileWithRetry("source.tmp", "target.json", {
      rename: async () => {
        attempts += 1;
        throw expected;
      },
      remove: async () => { removed = true; },
      sleep: async () => assert.fail("恒久エラーは再試行しない")
    }),
    (error) => error === expected
  );

  assert.equal(attempts, 1);
  assert.equal(removed, true);
});

test("renameの再試行上限後にエラーを返して一時ファイルを削除する", async () => {
  let attempts = 0;
  let removals = 0;
  const expected = Object.assign(new Error("still locked"), { code: "EBUSY" });

  await assert.rejects(
    replaceFileWithRetry("source.tmp", "target.json", {
      rename: async () => {
        attempts += 1;
        throw expected;
      },
      remove: async () => { removals += 1; },
      sleep: async () => {},
      retryDelays: [1, 2]
    }),
    (error) => error === expected
  );

  assert.equal(attempts, 3);
  assert.equal(removals, 1);
});

test("writeJsonは既存ファイルを置換して一時ファイルを残さない", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-write-json-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const relativePath = "data/example.json";
  await fs.mkdir(path.join(tempRoot, "data"), { recursive: true });
  await fs.writeFile(path.join(tempRoot, relativePath), '{"before":true}\n', "utf8");

  await writeJson(tempRoot, relativePath, { after: true });

  assert.deepEqual(JSON.parse(await fs.readFile(path.join(tempRoot, relativePath), "utf8")), { after: true });
  const leftovers = (await fs.readdir(path.join(tempRoot, "data"))).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);
});
