import test from "node:test";
import assert from "node:assert/strict";

import {
  assertTemplateReadyForGeneration,
  buildBannerGenerationContract,
  validateCopySourceTrace
} from "../src/core/banner-generation-contract.js";
import { buildApprovedClaimSnapshot } from "../src/core/banner-approved-claims.js";
import { buildTemplateReadinessState } from "../src/core/template-readiness.js";

test("near contractはWHO-WHATをWHAT、テンプレートを表層コピーなしのHOWとして分離する", () => {
  const template = readyTemplate();
  const contract = buildBannerGenerationContract({
    banner: { id: "ban_1", imageSize: "1080x1080" },
    product: { id: "prod_1", name: "商品" },
    strategy: { id: "str_1", markdown: "## WHO\n制作担当者\n## WHAT\n制作時間を5分の1に" },
    template,
    categoryRelation: { value: "near", reuseMethod: "mechanism_only" },
    extraInstruction: "コピーはそのままで画像だけ変える",
    expressionRules: [{ pattern: "断定禁止" }]
  });

  assert.equal(contract.strategyWhat.strategyId, "str_1");
  assert.match(contract.strategyWhat.markdown, /制作時間を5分の1/);
  assert.equal(contract.templateHow.templateId, "tpl_1");
  assert.equal(contract.templateHow.reuseMethod, "mechanism_only");
  assert.equal(Object.hasOwn(contract.templateHow.copySlots[0], "originalText"), false);
  assert.equal(Object.hasOwn(contract.templateHow.copySlots[0], "pattern"), false);
  assert.equal(contract.instructionPolicy.rawInstruction, "コピーはそのままで画像だけ変える");
  assert.deepEqual(contract.communicationPolicy, {
    requireProductOrTaskAnchor: true,
    requireSinglePrimaryPromise: true,
    requireNumberContext: true,
    requireMessageUnity: true,
    copyLocked: true
  });
  assert.equal(Object.hasOwn(contract, "facts"), false);
});

test("far contractだけ抽象patternとvariablesをHOWへ含める", () => {
  const contract = buildBannerGenerationContract({
    strategy: { id: "str_1", markdown: "選択WHO-WHAT" },
    template: readyTemplate(),
    categoryRelation: { value: "far", reuseMethod: "pattern_fill" }
  });

  assert.equal(contract.templateHow.reuseMethod, "pattern_fill");
  assert.equal(contract.templateHow.copySlots[0].pattern, "{課題}で満足していませんか？");
  assert.deepEqual(contract.templateHow.copySlots[0].variables, ["{課題}"]);
  assert.equal(Object.hasOwn(contract.templateHow.copySlots[0], "originalText"), false);
});

test("テンプレート指定時はreadiness schemaとhashが一致しない限り生成を拒否する", () => {
  const template = readyTemplate();
  assert.doesNotThrow(() => assertTemplateReadyForGeneration(template));
  assert.throws(
    () => assertTemplateReadyForGeneration({ ...template, templateReadiness: { ...template.templateReadiness, validationHash: "sha256:stale" } }),
    (error) => error.code === "TEMPLATE_NOT_READY"
  );
  assert.doesNotThrow(() => assertTemplateReadyForGeneration(null));
});

test("コピー主張はApprovedClaimSnapshotのclaimIdと仮説IDで追跡する", () => {
  const snapshot = buildApprovedClaimSnapshot({
    strategy: { id: "str_1", benefit: "制作時間を5分の1に" },
    product: { id: "prod_1", name: "CMO AI Pro" }
  });
  const hypothesis = { hypothesisId: "hyp_1", contentHash: "sha256:hypothesis" };
  const contract = buildBannerGenerationContract({
    strategy: { id: "str_1", benefit: "制作時間を5分の1に" },
    template: readyTemplate(),
    categoryRelation: { value: "near" },
    approvedClaimSnapshot: snapshot,
    creativeHypothesis: hypothesis
  });
  const claimId = snapshot.claims.find((claim) => claim.claimKind === "benefit").claimId;
  const passed = validateCopySourceTrace({
    copyBrief: {
      hypothesisId: "hyp_1",
      slotTexts: [{
        slotId: "z1e1",
        text: "制作時間を5分の1に",
        hypothesisId: "hyp_1",
        claimIds: [claimId],
        strategySource: { strategyId: "wrong", sourceText: "一致しない旧出典" },
        templateHowSource: { templateId: "tpl_1", messageRole: "hook", mechanism: "問いかけ" }
      }]
    },
    contract
  });
  const failed = validateCopySourceTrace({
    copyBrief: { hypothesisId: "hyp_1", slotTexts: [{ slotId: "z1e1", text: "根拠のない成果", hypothesisId: "hyp_1", claimIds: [] }] },
    contract
  });

  assert.equal(passed.status, "passed");
  assert.deepEqual(passed.violations, []);
  assert.equal(failed.status, "failed");
  assert.ok(failed.violations.some((item) => item.code === "claim_id_missing"));
  assert.equal(contract.approvedClaimSnapshotRef.snapshotId, snapshot.snapshotId);
  assert.equal(contract.creativeHypothesisRef.hypothesisId, "hyp_1");
  assert.equal(Object.hasOwn(contract.sourceTracePolicy, "requireStrategySourceForClaims"), false);
});

test("汎用CTAはclaimId不要だが成果主張にはclaimIdを必須とする", () => {
  const snapshot = buildApprovedClaimSnapshot({ strategy: { id: "str_1", benefit: "制作時間を5分の1に" } });
  const contract = buildBannerGenerationContract({
    strategy: { id: "str_1", benefit: "制作時間を5分の1に" },
    approvedClaimSnapshot: snapshot,
    creativeHypothesis: { hypothesisId: "hyp_1" }
  });
  const cta = validateCopySourceTrace({
    copyBrief: {
      hypothesisId: "hyp_1",
      slotTexts: [{
        slotId: "cta",
        role: "cta",
        messageRole: "action",
        text: "詳しく見る",
        hypothesisId: "hyp_1",
        claimIds: []
      }]
    },
    contract
  });
  const offer = validateCopySourceTrace({
    copyBrief: {
      hypothesisId: "hyp_1",
      slotTexts: [{
        slotId: "offer",
        role: "offer",
        text: "成果が伸びる",
        hypothesisId: "hyp_1",
        claimIds: []
      }]
    },
    contract
  });

  assert.equal(cta.status, "passed");
  assert.equal(offer.status, "failed");
  assert.ok(offer.violations.some((item) => item.code === "claim_id_missing"));
});

test("商品識別情報もApprovedClaimSnapshotのclaimIdで出典追跡できる", () => {
  const snapshot = buildApprovedClaimSnapshot({
    product: { id: "prod_1", name: "CMO AI Pro" },
    strategy: { id: "str_1", benefit: "広告制作を自社で検証する" }
  });
  const identityClaim = snapshot.claims.find((claim) => claim.claimKind === "identity");
  const contract = buildBannerGenerationContract({
    product: { id: "prod_1", name: "CMO AI Pro" },
    strategy: { id: "str_1", benefit: "広告制作を自社で検証する" },
    approvedClaimSnapshot: snapshot,
    creativeHypothesis: { hypothesisId: "hyp_1" }
  });
  const passed = validateCopySourceTrace({
    copyBrief: {
      hypothesisId: "hyp_1",
      slotTexts: [{
        slotId: "hook",
        role: "headline",
        text: "CMO AI Pro",
        hypothesisId: "hyp_1",
        claimIds: [identityClaim.claimId]
      }]
    },
    contract
  });
  const failed = validateCopySourceTrace({
    copyBrief: {
      hypothesisId: "hyp_1",
      slotTexts: [{ slotId: "hook", role: "headline", text: "未許可の商品名", hypothesisId: "hyp_1", claimIds: ["missing"] }]
    },
    contract
  });

  assert.equal(passed.status, "passed");
  assert.equal(failed.status, "failed");
  assert.ok(failed.violations.some((item) => item.code === "unknown_claim_id"));
});

function readyTemplate() {
  const template = {
    id: "tpl_1",
    title: "問いかけ型",
    imageFile: "/template.png",
    templateProcessingStatus: "completed",
    layoutBlueprint: { zones: [{ name: "Hero" }] },
    copyBlueprint: {
      version: 1,
      sourceCategoryProfile: { category: "BtoB" },
      persuasionMechanism: {
        primaryHookMechanism: "既存解決策への不満を問いかける",
        messageFlow: ["hook", "proof", "cta"]
      },
      slots: [{
        slotId: "z1e1",
        role: "headline",
        messageRole: "hook",
        charBudget: 18,
        originalText: "自己流で満足していませんか？",
        pattern: "{課題}で満足していませんか？",
        variables: ["{課題}"],
        psychologicalMechanism: "不満の顕在化"
      }]
    }
  };
  return {
    ...template,
    templateReadiness: buildTemplateReadinessState(template)
  };
}
