import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("テンプレ解析APIは複数レコードを202で即時受付し、失敗状態も永続化する", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-template-api-"));
  const port = await getFreePort();
  await fs.mkdir(path.join(tempRoot, "data"), { recursive: true });
  await fs.mkdir(path.join(tempRoot, "projects", "test"), { recursive: true });
  await fs.writeFile(path.join(tempRoot, "data", "ad-templates.json"), JSON.stringify([
    { id: "tpl_a", title: "A", creativeType: "banner", imageFile: "/shared-file?path=missing-a.png", templateStatus: "not_started" },
    { id: "tpl_b", title: "B", creativeType: "banner", imageFile: "/shared-file?path=missing-b.png", templateStatus: "not_started" }
  ], null, 2));

  const child = spawn(process.execPath, [path.join(repoRoot, "src", "server.js")], {
    cwd: tempRoot,
    env: {
      ...process.env,
      PORT: String(port),
      OPENAI_API_KEY: "",
      CMOAI_TEMPLATE_ANALYSIS_CONCURRENCY: "2"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString()));
  t.after(async () => {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 1_500))
    ]);
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  await waitForServer(port, child, logs);
  const startedAt = Date.now();
  const responses = await Promise.all(["tpl_a", "tpl_b"].map((templateId) => fetch(`http://127.0.0.1:${port}/api/ad-templates/template-image/enqueue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project: "./projects/test", templateId })
  })));
  const bodies = await Promise.all(responses.map((response) => response.json()));

  assert.deepEqual(responses.map((response) => response.status), [202, 202]);
  assert.equal(Date.now() - startedAt < 1_000, true);
  assert.equal(bodies.every((body) => body.accepted && body.templateProcessingStatus === "queued"), true);

  const finalStatuses = await waitForTemplateStatuses(port, ["tpl_a", "tpl_b"], "failed");
  assert.equal(finalStatuses.every((item) => item.templateAnalysisError.includes("APIキー")), true);
  const originalAttemptId = finalStatuses.find((item) => item.templateId === "tpl_a").templateAnalysisAttemptId;
  const patchedResponse = await fetch(`http://127.0.0.1:${port}/api/ad-templates/tpl_a`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      project: "./projects/test",
      patch: {
        title: "A renamed",
        templateProcessingStatus: "running",
        templateAnalysisAttemptId: "attempt-injected",
        templateAnalysisError: null
      }
    })
  });
  const patchedBody = await patchedResponse.json();
  assert.equal(patchedBody.template.title, "A renamed");
  assert.equal(patchedBody.template.templateProcessingStatus, "failed");
  assert.equal(patchedBody.template.templateAnalysisAttemptId, originalAttemptId);
  assert.match(patchedBody.template.templateAnalysisError, /APIキー/);
  const persisted = JSON.parse(await fs.readFile(path.join(tempRoot, "data", "ad-templates.json"), "utf8"));
  assert.equal(persisted.every((item) => item.templateProcessingStatus === "failed"), true);
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

async function waitForTemplateStatuses(port, templateIds, expectedStatus) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`http://127.0.0.1:${port}/api/ad-templates/template-image/status?templateIds=${encodeURIComponent(templateIds.join(","))}`);
    const data = await response.json();
    if (data.templates?.length === templateIds.length && data.templates.every((item) => item.templateProcessingStatus === expectedStatus)) return data.templates;
    await delay(20);
  }
  throw new Error(`template statuses did not become ${expectedStatus}`);
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
