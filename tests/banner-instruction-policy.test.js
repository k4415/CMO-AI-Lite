import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildInstructionPolicy,
  classifyAdditionalInstruction,
  createLockedContentSnapshot,
  hashLockedCopy
} from "../src/core/banner-instruction-policy.js";
import { applyRegulationRules, classifyExpressionRules } from "../src/core/banner-ai.js";
import { addBannerCreative, updateBannerCreative } from "../src/core/banner-store.js";

test("コピーはそのままで画像だけ変更 protects copy only", () => {
  const policy = buildInstructionPolicy("コピーはそのままで画像だけ人物を変えてください");

  assert.deepEqual(policy.protectedFields, ["copyBrief", "imageText"]);
  assert.deepEqual(policy.editableFields, ["imageElements"]);
  assert.equal(policy.rawInstruction, "コピーはそのままで画像だけ人物を変えてください");
});

test("全案で同じ主見出しや切り口を求める追加指示は兄弟類似を明示許可する", () => {
  const policy = buildInstructionPolicy("全案で主見出しと訴求の切り口を同じに揃えてください");

  assert.equal(policy.allowSiblingSimilarity, true);
});

test("追加指示をコピー主張・禁止・visual-onlyへ分離する", () => {
  const intent = classifyAdditionalInstruction("漫画家依頼だと1ヶ月。7日無料は入れない。背景だけ赤に変更する");

  assert.deepEqual(intent.authorizedClaims, ["漫画家依頼だと1ヶ月"]);
  assert.deepEqual(intent.forbiddenClaims, ["7日無料は入れない"]);
  assert.deepEqual(intent.visualInstructions, ["背景だけ赤に変更する"]);
  assert.equal(intent.changeScope, "copy_and_visual");
});

test("明示された固定コピーだけを抽出し指示文全体は固定しない", () => {
  const intent = classifyAdditionalInstruction("見出しを「AIで広告制作を速く」で固定し、同じ切り口で揃える");

  assert.deepEqual(intent.fixedCopy, ["AIで広告制作を速く"]);
  assert.deepEqual(intent.similarityOverrideDimensions, ["angle", "promise"]);
  assert.equal(intent.fixedCopy.includes(intent.rawInstruction), false);
});

test("追加指示原文を正として色指定をレギュレーションより優先する", () => {
  const policy = buildInstructionPolicy("アクセントカラーは赤を必ず使ってください");
  const rules = classifyExpressionRules([
    { id: "rule_1", ruleType: "color", pattern: "赤", description: "赤は禁止" }
  ], { id: "prod_1" }, policy);
  const proposal = { imageText: "赤を主役に", promptJson: { colorScheme: { accent: "赤" } } };
  const applied = applyRegulationRules(proposal, rules.ngRules, policy);

  assert.ok(policy.explicitOverrides.some((item) => item.field === "color"));
  assert.equal(rules.overriddenRules.length, 1);
  assert.equal(applied.promptJson.colorScheme.accent, "赤");
});

test("コピー指示は競合しないNGルールまで上書きしない", () => {
  const policy = buildInstructionPolicy("コピーは短くしてください");
  const rules = classifyExpressionRules([
    { id: "rule_1", ruleType: "copy_ng", pattern: "絶対", replacement: "目指す" }
  ], { id: "prod_1" }, policy);
  const applied = applyRegulationRules({ imageText: "絶対に変わる" }, rules.ngRules, policy);

  assert.equal(rules.overriddenRules.length, 0);
  assert.equal(rules.ngRules.length, 1);
  assert.equal(applied.imageText, "目指すに変わる");
});

test("コピー完全固定は競合するコピーNGルールより優先する", () => {
  const policy = buildInstructionPolicy("コピーはそのままで画像だけ変えてください");
  const rules = classifyExpressionRules([
    { id: "rule_1", ruleType: "copy_ng", pattern: "絶対", replacement: "目指す" }
  ], { id: "prod_1" }, policy);
  const applied = applyRegulationRules({ imageText: "絶対に変わる" }, rules.ngRules, policy);

  assert.equal(rules.overriddenRules.length, 1);
  assert.equal(applied.imageText, "絶対に変わる");
});

test("locked content hash is deterministic", () => {
  const first = createLockedContentSnapshot({
    templateAdId: "tpl_1",
    imageText: "固定コピー",
    copyBrief: { subHook: "サブ", mainHook: "固定コピー" }
  });
  const secondHash = hashLockedCopy({
    imageText: "固定コピー",
    copyBrief: { mainHook: "固定コピー", subHook: "サブ" }
  });

  assert.equal(first.normalizedHash, secondHash);
});

test("updating additionalInstruction snapshots copy before invalidation", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-banner-policy-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  const created = await addBannerCreative(projectRoot, {
    productId: "prod_1",
    strategyId: "strategy_1",
    title: "固定テスト"
  });
  await updateBannerCreative(projectRoot, created.id, {
    copyBrief: {
      mainHook: "固定コピー",
      subHook: "サブ",
      slotTexts: [{ slotId: "hook", canonicalField: "mainHook", text: "固定コピー長文版", charBudget: 5 }]
    },
    imageText: "固定コピー\nサブ",
    promptJson: { zones: [] }
  });

  const updated = await updateBannerCreative(projectRoot, created.id, {
    additionalInstruction: "コピーはそのままで画像だけ人物を変えてください"
  });

  assert.equal(updated.copyBrief.mainHook, "固定コピー");
  assert.equal(updated.imageText, "固定コピー\nサブ");
  assert.ok(updated.lockedContentSnapshot.normalizedHash);
  assert.deepEqual(updated.instructionPolicy.protectedFields, ["copyBrief", "imageText"]);
  assert.equal(updated.promptJson, null);
  assert.equal(updated.copyLengthReview.status, "passed");
  assert.deepEqual(updated.copyLengthReview.violations, []);
  assert.equal(updated.communicationReview.status, "warning");
  assert.equal(updated.communicationReview.exemption, "explicit_copy_lock");
  assert.equal(updated.copyQualityReview.rewriteAllowed, false);
});
