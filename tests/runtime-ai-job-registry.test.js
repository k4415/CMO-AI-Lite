import assert from "node:assert/strict";
import test from "node:test";

import { createRuntimeAiJobRegistry, runtimeAiJobMetaForAction } from "../src/core/runtime-ai-job-registry.js";

test("正常resolveはcompleted、throwはfailedにして元の値・例外を保つ", async () => {
  let nowMs = Date.parse("2026-07-20T12:00:00.000Z");
  const registry = createRuntimeAiJobRegistry({ now: () => new Date(nowMs), idFactory: () => `job_${nowMs}` });
  const result = await registry.withRuntimeAiJob({ kind: "fact_extraction", projectRoot: "/tmp/p1", title: "商品事実抽出" }, async ({ update }) => {
    update({ stageLabel: "保存処理中" });
    return { ok: true };
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(registry.listRuntimeAiJobs({ projectRoot: "/tmp/p1" })[0].status, "completed");

  nowMs += 1;
  const expected = new Error("secret");
  await assert.rejects(
    registry.withRuntimeAiJob({ kind: "strategy_generation", projectRoot: "/tmp/p1" }, async () => { throw expected; }),
    (error) => error === expected
  );
  assert.equal(registry.listRuntimeAiJobs({ projectRoot: "/tmp/p1" })[0].status, "failed");
});

test("isSuccess=falseはfailedにして元resultを返す", async () => {
  const registry = createRuntimeAiJobRegistry({ idFactory: () => "job_failed_result" });
  const result = await registry.withRuntimeAiJob(
    { kind: "fact_extraction", projectRoot: "/tmp/p1" },
    async () => ({ ok: false, message: "failure" }),
    { isSuccess: (value) => value.ok === true }
  );
  assert.equal(result.ok, false);
  assert.equal(registry.listRuntimeAiJobs({ projectRoot: "/tmp/p1" })[0].status, "failed");
});

test("案件分離、mutationだけのversion増加、期限切れterminalだけのprune", () => {
  let nowMs = Date.parse("2026-07-20T12:00:00.000Z");
  let id = 0;
  const registry = createRuntimeAiJobRegistry({
    now: () => new Date(nowMs),
    idFactory: () => `job_${++id}`,
    terminalTtlMs: 1000,
    pruneIntervalMs: 0
  });
  const first = registry.beginRuntimeAiJob({ kind: "fact_extraction", projectRoot: "/tmp/p1" });
  const active = registry.beginRuntimeAiJob({ kind: "strategy_generation", projectRoot: "/tmp/p2" });
  const afterMutations = registry.getVersion();
  assert.equal(registry.listRuntimeAiJobs({ projectRoot: "/tmp/p1" }).length, 1);
  assert.equal(registry.getVersion(), afterMutations);
  registry.completeRuntimeAiJob(first.id);
  nowMs += 1001;
  registry.pruneRuntimeAiJobs({ force: true });
  assert.equal(registry.listRuntimeAiJobs({ projectRoot: "/tmp/p1" }).length, 0);
  assert.equal(registry.listRuntimeAiJobs({ projectRoot: "/tmp/p2" })[0].id, active.id);
});

test("registry補助更新が失敗してもhandler結果を変えない", async () => {
  const warnings = [];
  const registry = createRuntimeAiJobRegistry({
    idFactory: () => { throw new Error("registry unavailable"); },
    onError: (error) => warnings.push(error.message)
  });
  const result = await registry.withRuntimeAiJob({ kind: "fact_extraction", projectRoot: "/tmp/p1" }, async () => 42);
  assert.equal(result, 42);
  assert.ok(warnings.length >= 1);
});

test("runtime action metadataは許可した2 actionだけを返す", () => {
  assert.equal(runtimeAiJobMetaForAction({ actionId: "research.extract_facts", projectRoot: "/p" })?.projectRoot, "/p");
  assert.equal(runtimeAiJobMetaForAction({ actionId: "strategy.create_who_what", projectRoot: "/p" })?.kind, "strategy_generation");
  assert.equal(runtimeAiJobMetaForAction({ actionId: "content.banner_create", projectRoot: "/p" }), null);
});
