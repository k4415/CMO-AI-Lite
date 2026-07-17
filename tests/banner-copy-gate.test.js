import test from "node:test";
import assert from "node:assert/strict";
import { checkCopyGate } from "../src/core/banner-copy-gate.js";

const plan = {
  templateId: "tpl_1",
  slots: [
    { slotId: "s1", canonicalField: "headline", charBudget: 10, required: true },
    { slotId: "s2", canonicalField: "sub", charBudget: 20, required: true }
  ],
  semanticGroups: []
};

test("文字数超過はcopy_length_over(10字以下枠は14字からNG、11字以上枠は121%からNG)", () => {
  const result = checkCopyGate({
    copyBrief: { slotTexts: [
      { slotId: "s1", text: "あ".repeat(14) },
      { slotId: "s2", text: "い".repeat(25) }
    ] },
    copySlotPlan: plan,
    expressionRules: []
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.violations.map((v) => [v.type, v.slotId]), [
    ["copy_length_over", "s1"], ["copy_length_over", "s2"]
  ]);
});

test("短いコピーと境界内(13字/24字)は通過する", () => {
  const result = checkCopyGate({
    copyBrief: { slotTexts: [
      { slotId: "s1", text: "あ".repeat(13) },
      { slotId: "s2", text: "い".repeat(24) }
    ] },
    copySlotPlan: plan,
    expressionRules: []
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
});

test("必須スロットの欠落はslot_missing、NGワードはregulation_violation", () => {
  const result = checkCopyGate({
    copyBrief: { slotTexts: [{ slotId: "s1", text: "業界No.1" }] },
    copySlotPlan: plan,
    expressionRules: [{ id: "r1", ruleType: "ng_word", pattern: "No.1", active: true }]
  });
  assert.equal(result.ok, false);
  const types = result.violations.map((v) => v.type).sort();
  assert.deepEqual(types, ["regulation_violation", "slot_missing"]);
});
