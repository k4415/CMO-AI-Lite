import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runtimeAiJobMetaForAction } from "../src/core/runtime-ai-job-registry.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("AIジョブAPIはread-only snapshotとETag/304を返し、不正案件を400にする", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-ai-jobs-api-"));
  const projectRoot = path.join(tempRoot, "projects", "test");
  const dataRoot = path.join(projectRoot, "data");
  const port = await getFreePort();
  await fs.mkdir(dataRoot, { recursive: true });
  await fs.mkdir(path.join(tempRoot, "data"), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(dataRoot, "material-extraction-jobs.json"), "[]"),
    fs.writeFile(path.join(dataRoot, "research-materials.json"), "[]"),
    fs.writeFile(path.join(dataRoot, "banner-creatives.json"), JSON.stringify([{
      id: "ban_1",
      title: "生成中バナー",
      productionStatus: "completed",
      imageGenerationStatus: "generating",
      pipelineNodes: {
        copyplan: { status: "completed", attemptId: "copy_1", completedAt: "2026-07-20T11:00:00.000Z" },
        prompt: { status: "completed", attemptId: "prompt_1", completedAt: "2026-07-20T11:01:00.000Z" },
        image: { status: "running", attemptId: "image_1", startedAt: "2026-07-20T11:02:00.000Z" }
      },
      imageGenerationLease: { attemptId: "image_1", expiresAt: "2099-07-20T12:00:00.000Z" },
      lastError: "Authorization: Bearer sk-proj-supersecret /Users/me/private.json"
    }])),
    fs.writeFile(path.join(tempRoot, "data", "ad-templates.json"), JSON.stringify([{
      id: "tpl_1",
      title: "共通テンプレ",
      creativeType: "banner",
      templateProcessingStatus: "running",
      templateAnalysisAttemptId: "attempt_1",
      templateAnalysisQueuedAt: "2026-07-20T11:59:00.000Z",
      templateAnalysisStartedAt: "2026-07-20T11:59:01.000Z",
      templateAnalysisLease: { attemptId: "attempt_1", expiresAt: "2099-07-20T12:00:00.000Z" }
    }]))
  ]);

  const child = spawn(process.execPath, [path.join(repoRoot, "src", "server.js")], {
    cwd: tempRoot,
    env: { ...process.env, PORT: String(port), OPENAI_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString()));
  t.after(async () => {
    child.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(1500)]);
    await fs.rm(tempRoot, { recursive: true, force: true });
  });
  await waitForServer(port, child, logs);

  const watchedFiles = [
    path.join(dataRoot, "material-extraction-jobs.json"),
    path.join(dataRoot, "research-materials.json"),
    path.join(dataRoot, "banner-creatives.json"),
    path.join(tempRoot, "data", "ad-templates.json")
  ];
  const before = await Promise.all(watchedFiles.map((file) => fs.stat(file)));
  const response = await fetch(`http://127.0.0.1:${port}/api/ai-jobs?project=${encodeURIComponent("./projects/test")}&recentLimit=99`);
  const body = await response.json();
  const after = await Promise.all(watchedFiles.map((file) => fs.stat(file)));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-cache, private");
  assert.ok(response.headers.get("etag"));
  assert.equal(body.ok, true);
  assert.ok(Buffer.byteLength(JSON.stringify(body)) < 100 * 1024);
  assert.ok(body.activeCount >= 1);
  assert.ok(body.jobs.some((job) => job.scope === "shared" && job.targetId === "tpl_1"));
  assert.ok(body.jobs.some((job) => job.targetId === "ban_1"));
  assert.doesNotMatch(JSON.stringify(body), /sk-proj-supersecret|\/Users\/me|private\.json|projects\/test/);
  assert.deepEqual(after.map((stat) => [stat.mtimeMs, stat.ctimeMs, stat.size]), before.map((stat) => [stat.mtimeMs, stat.ctimeMs, stat.size]));

  const notModified = await fetch(`http://127.0.0.1:${port}/api/ai-jobs?project=${encodeURIComponent("./projects/test")}&recentLimit=99`, {
    headers: { "if-none-match": response.headers.get("etag") }
  });
  assert.equal(notModified.status, 304);
  assert.equal(notModified.headers.get("etag"), response.headers.get("etag"));
  assert.equal(notModified.headers.get("cache-control"), "no-cache, private");
  assert.equal(await notModified.text(), "");

  for (const project of ["", "../../etc", "./projects/_template", "./projects/..", "./projects/.", "./projects/.hidden", "./projects/test/extra"]) {
    const invalid = await fetch(`http://127.0.0.1:${port}/api/ai-jobs?project=${encodeURIComponent(project)}`);
    assert.equal(invalid.status, 400);
  }
});

test("runtime action判定は実AIのみを対象にしdryRun・バナーactionを除外する", () => {
  assert.equal(runtimeAiJobMetaForAction({ actionId: "research.extract_facts", dryRun: false, projectRoot: "/p" }).kind, "fact_extraction");
  assert.equal(runtimeAiJobMetaForAction({ actionId: "strategy.create_who_what", dryRun: false, projectRoot: "/p" }).kind, "strategy_generation");
  assert.equal(runtimeAiJobMetaForAction({ actionId: "research.extract_facts", dryRun: true, projectRoot: "/p" }), null);
  assert.equal(runtimeAiJobMetaForAction({ actionId: "content.banner_create", dryRun: false, projectRoot: "/p" }), null);
  assert.equal(runtimeAiJobMetaForAction({ actionId: "project.resolve_context", dryRun: false, projectRoot: "/p" }), null);
});

test("serverは既存withJobLockを保ち、その内側で対象同期AIだけを追跡する", async () => {
  const source = await fs.readFile(path.join(repoRoot, "src", "server.js"), "utf8");
  assert.match(source, /withRuntimeAiJob\(\{[\s\S]*?kind:\s*"fact_extraction"/);
  assert.match(source, /withRuntimeAiJob\(\{[\s\S]*?kind:\s*"strategy_generation"/);
  assert.match(source, /withRuntimeAiJob\(\{[\s\S]*?kind:\s*"regulation_extraction"/);
  assert.doesNotMatch(source.match(/\/api\/banners\/generate-full-batch[\s\S]*?\/api\/banners\/generate-image/)?.[0] || "", /withRuntimeAiJob/);
});

async function waitForServer(port, child, logs) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${logs.join("")}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/projects`);
      if (response.ok) return;
    } catch {}
    await delay(20);
  }
  throw new Error(`server did not start: ${logs.join("")}`);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
