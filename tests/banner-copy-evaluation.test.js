import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import { evaluateBannerCopyFixtures } from "../scripts/evaluate-banner-copy-pipeline.mjs";

test("5件だけの回帰セットを個別判定し、母集団の合格率を目標にしない", async () => {
  const fixture = JSON.parse(await fs.readFile(new URL("./fixtures/banner-copy-quality-v2.json", import.meta.url), "utf8"));
  const report = await evaluateBannerCopyFixtures(fixture);

  assert.equal(report.reviewPolicyVersion, "4.1");
  assert.equal(report.caseCount, 5);
  assert.equal(report.passed, true);
  assert.deepEqual(report.failedCaseIds, []);
  assert.deepEqual(report.results.map((item) => [item.id, item.actual]), [
    ["cpa-design-ambiguous", "failed"],
    ["choco-fragmented-group", "failed"],
    ["additional-instruction-one-month", "passed"],
    ["protein-snack-shared-anchor", "passed"],
    ["unsupported-98-percent", "warning"]
  ]);
  assert.equal(Object.hasOwn(report, "firstPassRate"), false);
  assert.equal(Object.hasOwn(report, "secondPassCumulativeRate"), false);
});
