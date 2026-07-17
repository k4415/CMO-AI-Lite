import { findSlotLengthViolations, countCopyChars } from "./banner-copy-slots.js";

// Stage B: AIを使わない機械チェック。超過・欠落・NGワードだけを見る(下限なし)。
export function checkCopyGate({ copyBrief = {}, copySlotPlan = {}, expressionRules = [] } = {}) {
  const violations = [];
  for (const slot of findSlotLengthViolations(copyBrief, copySlotPlan)) {
    violations.push({
      type: "copy_length_over",
      slotId: slot.slotId,
      message: `「${slot.text}」(${slot.charCount}字)が上限${slot.maxChars}字を超えています。`
    });
  }
  const texts = new Map((Array.isArray(copyBrief.slotTexts) ? copyBrief.slotTexts : [])
    .map((item) => [String(item?.slotId || ""), String(item?.text || "")]));
  for (const slot of (Array.isArray(copySlotPlan.slots) ? copySlotPlan.slots : [])) {
    if (slot?.required !== false && !countCopyChars(texts.get(String(slot?.slotId || "")))) {
      violations.push({ type: "slot_missing", slotId: String(slot?.slotId || ""), message: "必須スロットのコピーがありません。" });
    }
  }
  const ngRules = (Array.isArray(expressionRules) ? expressionRules : [])
    .filter((rule) => rule?.active !== false && String(rule?.ruleType || "") === "ng_word" && String(rule?.pattern || "").trim());
  for (const [slotId, text] of texts) {
    for (const rule of ngRules) {
      if (text.includes(String(rule.pattern).trim())) {
        violations.push({ type: "regulation_violation", slotId, message: `禁止表現「${rule.pattern}」が含まれています。` });
      }
    }
  }
  return { ok: violations.length === 0, violations };
}
