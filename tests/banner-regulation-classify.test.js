import test from "node:test";
import assert from "node:assert/strict";

import { classifyExpressionRules } from "../src/core/banner-ai.js";

test("Orangeを含む行はspecifiedRulesに入り、ngの誤爆をしない", () => {
  const rules = classifyExpressionRules([
    { id: "orange-copy", description: "成果保証や煽りコピーにOrange/Redを使う。" },
    { id: "orange-table", description: "| Signal Orange | #FF6B3D | アクセント候補 |" },
    { id: "ratio", description: "CMO AI Lite: White・Cloud Gray 55-65%、Navy 20-25%、Blue 15-20%、Greenは原則使わない" }
  ], { id: "prod_1" });

  assert.deepEqual(rules.specifiedRules.map((rule) => rule.id), ["orange-copy", "orange-table", "ratio"]);
  assert.equal(rules.ngRules.length, 0);
});

test("組み合わせNG・禁止・avoidは従来どおりngRulesに入る", () => {
  const rules = classifyExpressionRules([
    { id: "heading", description: "組み合わせNG:" },
    { id: "ban", description: "グラデーションを使用禁止" },
    { id: "avoid", description: "avoid using red" },
    { id: "copy-ng", ruleType: "copy_ng", pattern: "絶対" }
  ], { id: "prod_1" });

  assert.deepEqual(rules.ngRules.map((rule) => rule.id), ["heading", "ban", "avoid", "copy-ng"]);
  assert.equal(rules.specifiedRules.length, 0);
});
