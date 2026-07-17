import test from "node:test";
import assert from "node:assert/strict";
import { extractRegulationRulesFromText } from "../src/core/regulation-import-ai.js";

test("Excel由来の推奨表現・備考列をAIなしで構造化する", async () => {
  const result = await extractRegulationRulesFromText({
    text: "# 表現レギュレーション\n種別,NG表現,推奨表現,備考\nNG,絶対に治る,改善を目指す,効果保証を避ける\n指定,,個人差があります,注記を併記する"
  });
  assert.equal(result.count, 2);
  assert.deepEqual(result.rules[0], {
    ruleType: "ng_expression",
    pattern: "絶対に治る",
    replacement: "改善を目指す",
    description: "効果保証を避ける",
    severity: "medium",
    active: true
  });
  assert.equal(result.rules[1].ruleType, "legal_disclaimer");
  assert.equal(result.rules[1].description, "個人差があります / 注記を併記する");
});

test("複数シート由来の複数テーブルをまとめて構造化する", async () => {
  const result = await extractRegulationRulesFromText({
    text: "# NG一覧\n区分,NGワード,言い換え,理由\nNG,必ず成功,成功を目指す,保証を避ける\n# 注記\nタイプ,禁止表現,代替表現,備考\n指定,,効果には個人差があります,末尾に表示"
  });
  assert.equal(result.count, 2);
  assert.equal(result.rules[0].pattern, "必ず成功");
  assert.equal(result.rules[1].description, "効果には個人差があります / 末尾に表示");
});
