import test from "node:test";
import assert from "node:assert/strict";

import {
  buildBannerCopyPrompt,
  buildTemplateCopyInput,
  buildCopySlotPlan,
  copyBriefMeetsSlotRequirements,
  evaluateBannerCopyHardGate,
  generateBannerCopyBriefs,
  normalizeCopyBriefs
} from "../src/core/banner-copy-ai.js";
import { charBudgetBounds, findSlotLengthViolations } from "../src/core/banner-copy-slots.js";

test("near prompt omits original text and surface pattern while far includes pattern only", () => {
  const template = {
    id: "tpl_1",
    title: "自己流ケアで満足していませんか？",
    copyBlueprint: {
      sourceCategoryProfile: { category: "美容" },
      persuasionMechanism: { primaryHookMechanism: "現状不満への問いかけ" },
      slots: [{
        slotId: "z1e1",
        role: "headline",
        messageRole: "hook",
        charBudget: 18,
        originalText: "自己流ケアで満足していませんか？",
        pattern: "{他の解決策}で満足していませんか？",
        psychologicalMechanism: "現状不満を自覚させる"
      }]
    }
  };
  const near = JSON.stringify(buildTemplateCopyInput(template, { reuseMethod: "mechanism_only" }));
  const far = JSON.stringify(buildTemplateCopyInput(template, { reuseMethod: "pattern_fill" }));

  assert.doesNotMatch(near, /自己流ケア|満足していませんか/);
  assert.match(near, /現状不満を自覚させる/);
  assert.doesNotMatch(far, /自己流ケア/);
  assert.match(far, /\{他の解決策\}で満足していませんか/);
});

test("copyBrief normalization attaches metadata without inventing copy", () => {
  const [brief] = normalizeCopyBriefs({
    briefs: [{
      appealAxis: "速度訴求",
      targetMoment: "納期が迫った瞬間",
      mainHook: "今日中に初稿を出す",
      subHook: "制作工程ごと短縮",
      proof: "fact_1由来の根拠",
      offerBadge: "7日間無料",
      cta: "試してみる",
      disclaimer: "",
      authorizedClaimSet: validAuthorizedClaimSet(),
      messagePlan: {
        targetMoment: "納期が迫った瞬間",
        awarenessStage: "problem_aware",
        productOrTaskAnchor: "広告制作AI",
        oneMessage: "広告初稿をAIで今日中に作れる",
        primaryPromise: "今日中に初稿を作る",
        supportingProof: "制作工程を短縮",
        offer: "7日間無料",
        informationPriority: { mustShow: ["広告制作AI", "今日中"], support: ["7日間無料"], drop: [] },
        numbers: [],
        forbiddenInterpretations: []
      },
      templateFitDecision: { status: "fit", reason: "主約束を表示できる" },
      whyItStops: "今日中という時間が目に入る",
      rejectedAlternatives: [
        { text: "AIで効率化", reason: "抽象的" },
        { text: "成果を最大化", reason: "汎用的" },
        { text: "制作OS", reason: "読み解きが必要" },
        { text: "余剰", reason: "3件まで" }
      ]
    }]
  }, {
    count: 1,
    strategyId: "str_1",
    model: "gpt-5.5",
    generatedAt: "2026-07-15T00:00:00.000Z"
  });

  assert.equal(brief.version, 3);
  assert.equal(brief.strategyId, "str_1");
  assert.equal(brief.model, "gpt-5.5");
  assert.equal(brief.mainHook, "今日中に初稿を出す");
  assert.equal(Object.hasOwn(brief, "usedFactIds"), false);
  assert.equal(brief.rejectedAlternatives.length, 1);
  assert.equal(brief.messagePlan.productOrTaskAnchor, "広告制作AI");
  assert.equal(brief.templateFitDecision.status, "fit");
  assert.equal(brief.authorizedClaimSet.chosenAngle, "benefit");
});

test("Stage 1の正規化結果はmessagePlanから完成コピーのreadoutTextを保存する", () => {
  const copySlotPlan = {
    slots: [
      { slotId: "hook", order: 0, canonicalField: "mainHook", charBudget: 12, required: true },
      { slotId: "proof", order: 1, canonicalField: "proof", charBudget: 8, required: false }
    ]
  };
  const [brief] = normalizeCopyBriefs({
    briefs: [{
      appealAxis: "速度",
      whyItStops: "商品と変化が一目で分かる",
      authorizedClaimSet: validAuthorizedClaimSet(),
      messagePlan: validMessagePlan(),
      templateFitDecision: { status: "fit", reason: "表示可能" },
      slotTexts: [
        { slotId: "proof", text: "キャラ統一" },
        { slotId: "hook", text: "漫画広告をAI制作" }
      ]
    }]
  }, { count: 1, strategyId: "str_1", model: "test", copySlotPlan });

  assert.equal(brief.readoutText, "漫画広告をAI制作 / キャラ統一");
  assert.equal(brief.slotTexts[0].maxChars, 14);
  assert.equal(brief.slotTexts[0].minChars, 0);
  assert.equal(evaluateBannerCopyHardGate({ brief, copySlotPlan }).status, "passed");
});

test("Stage 1のmessagePlan欠落とテンプレートrejectは統合ハードゲートで失敗する", () => {
  const gate = evaluateBannerCopyHardGate({
    brief: {
      appealAxis: "速度",
      whyItStops: "短い",
      mainHook: "漫画広告をAI制作",
      templateFitDecision: { status: "reject", reason: "意味を分断する" }
    },
    copySlotPlan: null
  });

  assert.equal(gate.status, "failed");
  assert.ok(gate.failures.includes("message_plan_missing"));
  assert.ok(gate.failures.includes("authorized_claim_set_missing"));
  assert.ok(gate.failures.includes("template_message_fit_failed"));
});

test("Stage 1は事前確定したhypothesisIdをコピーと全slotへ保持する", async () => {
  const result = await generateBannerCopyBriefs({
    banners: [{ id: "ban_1", strategyId: "str_1" }],
    product: { id: "prod_1", name: "商品" },
    strategy: { id: "str_1", markdown: "## ベネフィット\n制作時間を5分の1に" },
    template: {
      id: "tpl_1",
      templateZones: [{ elements: [{ type: "text", slotId: "mainHook", role: "headline", messageRole: "hook", content: "{便益}", charCount: 18 }] }],
      copyBlueprint: {
        slots: [{ slotId: "mainHook", required: true }],
        semanticGroups: [{ groupId: "group-main", semanticRole: "primary_promise", slotIds: ["mainHook"], readingOrder: 0, joinMode: "single" }]
      }
    },
    approvedClaimSnapshot: {
      version: 1,
      snapshotId: "acs_1",
      contentHash: "sha256:claims",
      claims: [{ claimId: "clm_1", text: "制作時間を5分の1に", claimKind: "benefit", allowedUses: ["headline", "benefit"], numericTokens: ["5分の1"], risk: "objective" }]
    },
    creativeHypotheses: [{
      version: 1,
      hypothesisId: "hyp_1",
      contentHash: "sha256:hypothesis",
      strategyId: "str_1",
      approvedClaimSnapshotId: "acs_1",
      audienceAttribute: "広告担当者",
      targetMoment: "制作を急ぐ瞬間",
      barrier: "制作が遅い",
      chosenAngle: "speed",
      primaryPromise: "制作時間を5分の1に",
      supportingClaimIds: ["clm_1"],
      templateMechanism: "大数字",
      semanticGroupPlan: [{ groupId: "group-main", semanticRole: "primary_promise", intendedMessage: "制作時間を5分の1に", slotIds: ["mainHook"], readingOrder: 0, joinMode: "single" }],
      templateFitDecision: { status: "fit", reason: "表示可能", roleAdjustments: [] },
      variationPolicy: { changedDimensions: ["angle"], preservedDimensions: ["audience"] }
    }],
    generationRunId: "run_1",
    candidateGroupId: "group_1",
    copyJsonGenerator: async () => ({
      briefs: [{
        appealAxis: "速度",
        mainHook: "制作時間を5分の1に",
        whyItStops: "数字で変化が分かる",
        slotTexts: [{ slotId: "mainHook", role: "headline", text: "制作時間を5分の1に", claimIds: ["clm_1"], strategySource: { sourceText: "旧形式" } }],
        messagePlan: {
          productOrTaskAnchor: "広告制作",
          oneMessage: "広告制作時間を5分の1にする",
          primaryPromise: "制作時間を5分の1に",
          numbers: [{ value: "5分の1", meaning: "制作時間", owner: "広告制作", polarity: "decrease", minimumContext: "制作時間を5分の1に" }]
        },
        semanticGroupReadout: [{ groupId: "改ざん", slotIds: [], visibleText: "信用しない", expectedMessage: "信用しない" }],
        templateFitDecision: { status: "fit", reason: "AI出力値" }
      }]
    }),
    copyReviewGenerator: null
  });
  const brief = result.results[0].copyBrief;
  assert.equal(result.results[0].status, "passed");
  assert.equal(brief.version, 4);
  assert.equal(brief.hypothesisId, "hyp_1");
  assert.equal(brief.approvedClaimSnapshotId, "acs_1");
  assert.match(brief.copyBriefHash, /^sha256:/);
  assert.equal(brief.slotTexts[0].hypothesisId, "hyp_1");
  assert.deepEqual(brief.slotTexts[0].claimIds, ["clm_1"]);
  assert.equal(Object.hasOwn(brief.slotTexts[0], "strategySource"), false);
  assert.deepEqual(brief.semanticGroupReadout, [{
    groupId: "group-main",
    slotIds: ["mainHook"],
    visibleText: "制作時間を5分の1に",
    expectedMessage: "制作時間を5分の1に"
  }]);
});

test("copy prompt carries selected strategy and template structure without facts or template display names", () => {
  const copySlotPlan = {
    ...buildCopySlotPlan(null),
    templateTitle: "NO.102_BtoB SaaS 赤背景",
    slots: [{
      ...buildCopySlotPlan(null).slots[0],
      zoneName: "赤背景ゾーン",
      sampleContent: "赤を主役にする見本コピー"
    }]
  };
  const prompt = buildBannerCopyPrompt({
    count: 2,
    banners: [{ id: "ban_1", title: "NO.102_BtoB SaaS 赤背景", strategyId: "str_1", variationAxis: "速度" }],
    product: { id: "prod_1", name: "商品" },
    strategy: { id: "str_1", markdown: "選択された戦略だけ" },
    facts: [{ id: "fact_1", content: "制作時間を短縮" }],
    expressionRules: [{ pattern: "断定禁止" }],
    templateCopy: {
      id: "tpl_102",
      title: "NO.102_BtoB SaaS 赤背景",
      slots: [{ slotId: "hook", title: "赤背景の見出し", role: "headline", psychologicalMechanism: "大見出し" }]
    },
    copySlotPlan,
    existingCopies: [{ id: "ban_old", imageText: "既出見出し" }],
    extraInstruction: "数字を使う"
  });

  assert.match(prompt, /選択された戦略だけ/);
  assert.doesNotMatch(prompt, /制作時間を短縮|事実DB|usedFactIds/);
  assert.doesNotMatch(prompt, /NO\.102_BtoB SaaS 赤背景|templateTitle|赤背景ゾーン|赤を主役にする見本コピー|赤背景の見出し|zoneName|sampleContent/);
  assert.match(prompt, /tpl_102/);
  assert.match(prompt, /既出見出し/);
  assert.match(prompt, /コピー枠プラン/);
  assert.match(prompt, /briefs の件数は指定案数と一致/);
  assert.ok(prompt.indexOf("# 追加指示") < prompt.indexOf("# 選択WHO-WHAT"));
  assert.match(prompt, /ApprovedClaimSnapshot/);
  assert.match(prompt, /CreativeHypothesisContract/);
});

test("copy prompt carries one WHAT/HOW generation contract and preserves slot source trace", () => {
  const copySlotPlan = buildCopySlotPlan({
    templateZones: [{ elements: [{ type: "text", slotId: "z1e1", role: "headline", messageRole: "hook", content: "{便益}", charCount: 12 }] }]
  });
  const generationContract = {
    strategyWhat: { strategyId: "str_1", markdown: "制作時間を5分の1に" },
    templateHow: { templateId: "tpl_1", reuseMethod: "mechanism_only" },
    sourceTracePolicy: { requireStrategySourceForClaims: true, requireTemplateSourceForHow: true }
  };
  const prompt = buildBannerCopyPrompt({ count: 1, copySlotPlan, generationContract });
  const [brief] = normalizeCopyBriefs({
    briefs: [{
      appealAxis: "便益起点",
      whyItStops: "大きな変化が伝わる",
      slotTexts: [{
        slotId: "z1e1",
        text: "制作時間を5分の1に",
        strategySource: { strategyId: "str_1", section: "WHAT", sourceText: "制作時間を5分の1に" },
        templateHowSource: { templateId: "tpl_1", messageRole: "hook", mechanism: "大数字" }
      }]
    }]
  }, { count: 1, strategyId: "str_1", model: "test", copySlotPlan });

  assert.match(prompt, /BannerGenerationContract/);
  assert.match(prompt, /requireStrategySourceForClaims/);
  assert.equal(brief.slotTexts[0].strategySource.strategyId, "str_1");
  assert.equal(brief.slotTexts[0].templateHowSource.templateId, "tpl_1");
});

test("copy promptは別セクションにある戦略・テンプレ・指示・snapshot・仮説・表現ルールをgeneration contract内で重複送信しない", () => {
  const repeatedClaim = "REPEATED_APPROVED_CLAIM";
  const repeatedHypothesis = "REPEATED_HYPOTHESIS_PROMISE";
  const repeatedRule = "REPEATED_EXPRESSION_RULE";
  const repeatedStrategy = "REPEATED_STRATEGY_WHAT";
  const repeatedTemplate = "REPEATED_TEMPLATE_HOW";
  const repeatedInstruction = "REPEATED_INSTRUCTION_POLICY";
  const prompt = buildBannerCopyPrompt({
    count: 1,
    banners: [{ id: "ban_1", productId: "prod_1", strategyId: "str_1" }],
    product: { id: "prod_1", name: "CMO AI Pro" },
    strategy: { id: "str_1", markdown: repeatedStrategy },
    copySlotPlan: buildCopySlotPlan(null),
    templateCopy: { id: "tpl_1", persuasionMechanism: { summary: repeatedTemplate } },
    instructionPolicy: { requiredAngles: [repeatedInstruction] },
    creativeHypotheses: [{ hypothesisId: "hyp_1", primaryPromise: repeatedHypothesis }],
    approvedClaimSnapshot: { snapshotId: "acs_1", claims: [{ claimId: "clm_1", text: repeatedClaim }] },
    expressionRules: [{ id: "rule_1", description: repeatedRule }],
    generationContract: {
      version: 1,
      strategyWhat: { strategyId: "str_1", markdown: repeatedStrategy },
      templateHow: { templateId: "tpl_1", hookMechanism: repeatedTemplate },
      instructionPolicy: { requiredAngles: [repeatedInstruction] },
      approvedClaimSnapshotRef: { snapshotId: "acs_1" },
      creativeHypothesisRef: { hypothesisId: "hyp_1" },
      approvedClaimSnapshot: { snapshotId: "acs_1", claims: [{ claimId: "clm_1", text: repeatedClaim }] },
      creativeHypothesis: { hypothesisId: "hyp_1", primaryPromise: repeatedHypothesis },
      constraints: {
        expressionRules: [{ id: "rule_1", description: repeatedRule }],
        imageSize: "1080x1080",
        productIdentity: { productId: "prod_1", productName: "CMO AI Pro" }
      }
    }
  });
  const occurrences = (value) => prompt.split(value).length - 1;

  assert.equal(occurrences(repeatedClaim), 1);
  assert.equal(occurrences(repeatedHypothesis), 1);
  assert.equal(occurrences(repeatedRule), 1);
  assert.equal(occurrences(repeatedStrategy), 1);
  assert.equal(occurrences(repeatedTemplate), 1);
  assert.equal(occurrences(repeatedInstruction), 1);
  assert.match(prompt, /approvedClaimSnapshotRef/);
  assert.match(prompt, /creativeHypothesisRef/);
  assert.match(prompt, /productIdentity/);
});

test("copy slot plan maps roles, excludes logo, and estimates missing charCount", () => {
  const plan = buildCopySlotPlan({
    id: "tpl_1",
    title: "テンプレ",
    templateZones: [{
      name: "Hero",
      elements: [
        { type: "text", role: "logo", content: "{ブランド名}", charCount: 6 },
        { type: "text", role: "headline", messageRole: "hook", content: "{悩み}を解決", charCount: 8 },
        { type: "text", role: "body", messageRole: "benefit", content: "{ベネフィット}です" },
        { type: "text", role: "cta", messageRole: "cta", content: "詳しく見る", charCount: 5 }
      ]
    }]
  });

  assert.equal(plan.templateId, "tpl_1");
  assert.deepEqual(plan.slots.map((slot) => slot.canonicalField), ["mainHook", "subHook", "cta"]);
  assert.equal(plan.slots[0].charBudget, 8);
  assert.equal(plan.slots[1].estimated, true);
  assert.equal(plan.slots[1].charBudget, 6);
  assert.deepEqual(plan.semanticGroups.map((group) => group.semanticRole), ["primary_promise", "supporting_benefit", "action"]);
});

test("copy slot planは明示semanticGroupsを優先し、複数見出しを一つの主約束として扱う", () => {
  const explicit = buildCopySlotPlan({
    copyBlueprint: {
      slots: [{ slotId: "hook-1" }, { slotId: "hook-2" }],
      semanticGroups: [{
        groupId: "hero-message",
        slotIds: ["hook-1", "hook-2"],
        semanticRole: "primary_promise",
        readingOrder: 1,
        joinMode: "continuous_sentence",
        required: true,
        groupCharBudget: 18,
        maxSemanticUnits: 1
      }]
    },
    templateZones: [{ elements: [
      { type: "text", slotId: "hook-1", role: "headline", messageRole: "hook", content: "{前半}", charCount: 8 },
      { type: "text", slotId: "hook-2", role: "headline", messageRole: "hook", content: "{後半}", charCount: 10 }
    ] }]
  });
  const derived = buildCopySlotPlan({
    templateZones: [{ elements: [
      { type: "text", slotId: "hook-1", role: "headline", messageRole: "hook", content: "{前半}", charCount: 8 },
      { type: "text", slotId: "hook-2", role: "headline", messageRole: "proof", content: "{後半}", charCount: 10 }
    ] }]
  });

  assert.deepEqual(explicit.semanticGroups, [{
    groupId: "hero-message",
    slotIds: ["hook-1", "hook-2"],
    semanticRole: "primary_promise",
    readingOrder: 1,
    joinMode: "continuous_sentence",
    required: true,
    groupCharBudget: 18,
    maxSemanticUnits: 1
  }]);
  assert.deepEqual(derived.semanticGroups[0].slotIds, ["hook-1", "hook-2"]);
  assert.equal(derived.semanticGroups[0].maxSemanticUnits, 1);
});

test("visual headline slots remain mainHook even when messageRole describes problem or proof", () => {
  const plan = buildCopySlotPlan({
    id: "tpl_headline_priority",
    templateZones: [{
      name: "Hero",
      elements: [
        { type: "text", role: "headline", messageRole: "problem", content: "{業務領域}で困っていませんか", charCount: 14 },
        { type: "text", role: "subheadline", messageRole: "solution", content: "{サービスカテゴリ}で解決", charCount: 10 },
        { type: "text", role: "headline", messageRole: "proof", content: "{実績数}選", charCount: 4 }
      ]
    }]
  });

  assert.deepEqual(plan.slots.map((slot) => slot.canonicalField), ["mainHook", "subHook", "mainHook"]);
});

test("slotTexts are the source of canonical fields and cta is not required without a cta slot", () => {
  const copySlotPlan = buildCopySlotPlan({
    templateZones: [{
      elements: [
        { type: "text", role: "headline", messageRole: "hook", content: "{悩み}", charCount: 8 },
        { type: "text", role: "body", messageRole: "benefit", content: "{ベネフィット}", charCount: 8 }
      ]
    }]
  });
  const [brief] = normalizeCopyBriefs({
    briefs: [{
      appealAxis: "課題起点",
      whyItStops: "今日中という具体性",
      cta: "これはスロット外なので消える",
      slotTexts: [
        { slotId: "z1e1", text: "今日中に初稿", charBudget: 8 },
        { slotId: "z1e2", text: "根拠で選べる", charBudget: 8 }
      ]
    }]
  }, {
    count: 1,
    strategyId: "str_1",
    model: "test",
    generatedAt: "2026-07-15T00:00:00.000Z",
    copySlotPlan
  });

  assert.equal(brief.mainHook, "今日中に初稿");
  assert.equal(brief.subHook, "根拠で選べる");
  assert.equal(brief.cta, "");
  assert.equal(copyBriefMeetsSlotRequirements(brief, copySlotPlan), true);
});

test("mainHook is not required when the template has no mainHook slot", () => {
  const copySlotPlan = buildCopySlotPlan({
    templateZones: [{
      elements: [
        { type: "text", role: "caption", messageRole: "proof", content: "{サービス説明}", charCount: 8 },
        { type: "text", role: "cta", messageRole: "cta", content: "詳しく見る", charCount: 5 }
      ]
    }]
  });
  const [brief] = normalizeCopyBriefs({
    briefs: [{
      appealAxis: "根拠起点",
      whyItStops: "証拠が短く見える",
      slotTexts: [
        { slotId: "z1e1", text: "実績で比較", charBudget: 8 },
        { slotId: "z1e2", text: "詳しく見る", charBudget: 5 }
      ]
    }]
  }, {
    count: 1,
    strategyId: "str_1",
    model: "test",
    generatedAt: "2026-07-15T00:00:00.000Z",
    copySlotPlan
  });

  assert.equal(brief.mainHook, "");
  assert.equal(brief.proof, "実績で比較");
  assert.equal(copyBriefMeetsSlotRequirements(brief, copySlotPlan), true);
});

test("optional proof and offer slots may remain empty while required hook slots still block", () => {
  const template = {
    templateZones: [{ elements: [
      { type: "text", slotId: "hook", role: "headline", messageRole: "hook", content: "{便益}", charCount: 12 },
      { type: "text", slotId: "proof", role: "proof", messageRole: "proof", content: "{実績}", charCount: 10 }
    ] }],
    copyBlueprint: { slots: [
      { slotId: "hook", required: true, sourcePolicy: "strategy_required", emptyPolicy: "block" },
      { slotId: "proof", required: false, sourcePolicy: "strategy_required", emptyPolicy: "allow" }
    ] }
  };
  const plan = buildCopySlotPlan(template);
  const valid = {
    appealAxis: "便益起点",
    whyItStops: "便益が明確",
    slotTexts: [{ slotId: "hook", text: "制作を速く" }, { slotId: "proof", text: "" }]
  };
  const invalid = { ...valid, slotTexts: [{ slotId: "hook", text: "" }, { slotId: "proof", text: "" }] };

  assert.equal(plan.slots[0].required, true);
  assert.equal(plan.slots[1].required, false);
  assert.equal(copyBriefMeetsSlotRequirements(valid, plan), true);
  assert.equal(copyBriefMeetsSlotRequirements(invalid, plan), false);
});

test("copy generation retries once when slot text exceeds char budget", async () => {
  const template = {
    id: "tpl_retry",
    templateZones: [{
      elements: [
        { type: "text", role: "headline", messageRole: "hook", content: "{悩み}", charCount: 8 },
        { type: "text", role: "body", messageRole: "benefit", content: "{ベネフィット}", charCount: 8 }
      ]
    }]
  };
  const responses = [
    {
      briefs: [{
        appealAxis: "課題起点",
        whyItStops: "長すぎるが具体的",
        authorizedClaimSet: validAuthorizedClaimSet(),
        messagePlan: validMessagePlan(),
        templateFitDecision: { status: "fit", reason: "一つの主約束を表示できる" },
        slotTexts: [
          { slotId: "z1e1", text: "これは明らかに長すぎるメインコピーです", charBudget: 8 },
          { slotId: "z1e2", text: "根拠で選べる", charBudget: 8 }
        ]
      }]
    },
    {
      briefs: [{
        appealAxis: "課題起点",
        whyItStops: "短く具体的",
        authorizedClaimSet: validAuthorizedClaimSet(),
        messagePlan: validMessagePlan(),
        templateFitDecision: { status: "fit", reason: "一つの主約束を表示できる" },
        slotTexts: [
          {
            slotId: "z1e1",
            text: "今日中に初稿",
            charBudget: 8,
            strategySource: { strategyId: "str_1", sourceText: "今日中に初稿" },
            templateHowSource: { templateId: "tpl_retry", messageRole: "hook", mechanism: "短い見出し" }
          },
          {
            slotId: "z1e2",
            text: "担当者向け",
            charBudget: 8,
            strategySource: { strategyId: "str_1", sourceText: "担当者" },
            templateHowSource: { templateId: "tpl_retry", messageRole: "benefit", mechanism: "補足" }
          }
        ],
        templateUseNote: "見出しはゼロベース型"
      }]
    }
  ];
  const calls = [];
  const generated = await generateBannerCopyBriefs({
    banners: [{ id: "ban_1", productId: "prod_1", strategyId: "str_1" }],
    product: { id: "prod_1", name: "商品" },
    strategy: { id: "str_1", markdown: "今日中に初稿を出したい担当者" },
    facts: [],
    expressionRules: [],
    template,
    copyJsonGenerator: async (input) => {
      calls.push(input.user);
      return responses.shift();
    }
  });

  assert.equal(calls.length, 2);
  assert.match(calls[1], /文字数上限/);
  assert.equal(generated.results[0].status, "passed");
  assert.equal(generated.results[0].copyBrief.mainHook, "今日中に初稿");
  assert.equal(generated.results[0].copyBrief.cta, "");
  assert.equal(generated.results[0].copyBrief.templateUseNote, "見出しはゼロベース型");
});

test("2回目も品質NGの候補はwarningで保存し、初回合格の兄弟案も保持する", async () => {
  const template = {
    id: "tpl_candidate",
    templateZones: [{ elements: [{ type: "text", role: "headline", messageRole: "hook", content: "{便益}", charCount: 12 }] }]
  };
  const generatedCopies = [
    {
      briefs: [
        tracedBrief("ban_1", "制作時間を短縮", "制作時間を短縮", "str_1", "tpl_candidate"),
        tracedBrief("ban_2", "判断を迷わない", "判断を迷わない", "str_1", "tpl_candidate")
      ]
    },
    { briefs: [tracedBrief("ban_2", "判断を速くする", "判断を速くする", "str_1", "tpl_candidate")] }
  ];
  let reviewCall = 0;
  const result = await generateBannerCopyBriefs({
    banners: [{ id: "ban_1", strategyId: "str_1" }, { id: "ban_2", strategyId: "str_1" }],
    product: { id: "prod_1", name: "商品" },
    strategy: { id: "str_1", markdown: "制作時間を短縮し、判断を迷わない。判断を速くする" },
    template,
    copyJsonGenerator: async () => generatedCopies.shift(),
    copyReviewGenerator: async ({ user }) => {
      reviewCall += 1;
      const candidates = JSON.parse(user).candidates;
      const count = candidates.length;
      if (reviewCall === 1) {
        return { reviews: [qualityScores(4, candidates[0].visibleCopy.readoutText), qualityScores(1, candidates[1].visibleCopy.readoutText)] };
      }
      return { reviews: Array.from({ length: count }, (_, index) => qualityScores(1, candidates[index].visibleCopy.readoutText)) };
    },
    originalityReviewer: () => ({ status: "passed", failures: [] })
  });

  assert.equal(result.results[0].status, "passed");
  assert.equal(result.results[0].reviewHistory.length, 1);
  assert.equal(result.results[1].status, "warning");
  assert.equal(result.results[1].reviewHistory.length, 2);
  assert.equal(result.results[1].reviewHistory[0].decision, "rewrite");
  assert.equal(result.results[1].reviewHistory[1].decision, "warning");
  assert.equal(result.results[1].copyBrief.copyQualityReview.status, "warning");
  assert.equal(result.results[1].copyBrief.copyQualityReview.continuedAfterReview, true);
  assert.ok(result.results[1].copyBrief.copyQualityReview.failureReasons.length > 0);
  assert.equal(Object.hasOwn(result.results[1], "error"), false);
  assert.match(result.results[0].generationRunId, /^[0-9a-f-]{36}$/);
  assert.equal(result.results[0].generationRunId, result.results[1].generationRunId);
  assert.equal(result.results[0].candidateGroupId, result.results[1].candidateGroupId);
  assert.deepEqual(result.results.map((item) => item.candidateIndex), [0, 1]);
  assert.equal(result.results[0].copyBrief.candidateGroupId, result.results[0].candidateGroupId);
});

test("伝達critical gateが2回とも不合格でもwarningで画像生成へ進める", async () => {
  const template = {
    id: "tpl_communication",
    templateZones: [{ elements: [{ type: "text", slotId: "z1e1", role: "headline", messageRole: "hook", content: "{便益}", charCount: 12 }] }]
  };
  const attempts = [
    { briefs: [tracedBrief("ban_1", "キャラを保つ", "漫画広告をAIで制作する", "str_1", "tpl_communication")] },
    { briefs: [tracedBrief("ban_1", "作画共有AI", "漫画広告をAIで制作する", "str_1", "tpl_communication")] }
  ];
  const result = await generateBannerCopyBriefs({
    banners: [{ id: "ban_1", strategyId: "str_1" }],
    product: { id: "prod_1", name: "CMO AI Pro" },
    strategy: { id: "str_1", markdown: "漫画広告をAIで制作する" },
    template,
    copyJsonGenerator: async () => attempts.shift(),
    copyReviewGenerator: async () => ({
      reviews: [{
        ...qualityScores(5),
        communicationReview: passingCommunicationReview({
          perceivedMessage: "キャラクター作画を共有するツール",
          productOrTaskUnderstood: false,
          singleMessageFocus: false
        })
      }]
    }),
    originalityReviewer: () => ({ status: "passed", failures: [] })
  });

  assert.equal(result.results[0].status, "warning");
  assert.equal(result.results[0].reviewHistory.length, 2);
  assert.equal(result.results[0].reviewHistory[0].decision, "rewrite");
  assert.equal(result.results[0].reviewHistory[1].decision, "warning");
  assert.equal(result.results[0].copyBrief.copyQualityReview.status, "warning");
  assert.equal(result.results[0].copyBrief.copyQualityReview.continuedAfterReview, true);
  assert.ok(result.results[0].copyBrief.copyQualityReview.failureReasons.includes("product_or_task_not_understood"));
  assert.equal(Object.hasOwn(result.results[0], "error"), false);
});

test("claim alignmentが2回とも不合格なら引き続き画像生成を止める", async () => {
  const template = {
    id: "tpl_claim_alignment",
    templateZones: [{ elements: [{ type: "text", slotId: "z1e1", role: "headline", messageRole: "hook", content: "{便益}", charCount: 12 }] }],
    copyBlueprint: {
      slots: [{ slotId: "z1e1", required: true }],
      semanticGroups: [{ groupId: "primary", semanticRole: "primary_promise", slotIds: ["z1e1"], readingOrder: 0, joinMode: "single" }]
    }
  };
  const approvedClaimSnapshot = {
    version: 1,
    snapshotId: "acs_claim_alignment",
    contentHash: "sha256:claim-alignment",
    claims: [{
      claimId: "clm_speed",
      text: "広告制作を速くする",
      claimKind: "benefit",
      allowedUses: ["headline", "benefit"],
      numericTokens: [],
      risk: "objective"
    }]
  };
  const creativeHypothesis = {
    version: 1,
    hypothesisId: "hyp_claim_alignment",
    contentHash: "sha256:hypothesis-claim-alignment",
    strategyId: "str_1",
    approvedClaimSnapshotId: approvedClaimSnapshot.snapshotId,
    audienceAttribute: "広告担当者",
    targetMoment: "広告制作を急ぐ瞬間",
    barrier: "制作が遅い",
    chosenAngle: "speed",
    primaryPromise: "広告制作を速くする",
    supportingClaimIds: ["clm_speed"],
    templateMechanism: "短い大見出し",
    semanticGroupPlan: [{
      groupId: "primary",
      semanticRole: "primary_promise",
      intendedMessage: "広告制作を速くする",
      slotIds: ["z1e1"],
      readingOrder: 0,
      joinMode: "single"
    }],
    templateFitDecision: { status: "fit", reason: "表示可能", roleAdjustments: [] },
    variationPolicy: { changedDimensions: ["angle"], preservedDimensions: ["audience"] }
  };
  const attempts = ["広告制作を速くする", "広告制作を速くする"].map((text) => ({
    briefs: [{
      appealAxis: "制作速度",
      whyItStops: "便益が明確",
      messagePlan: validMessagePlan(),
      templateFitDecision: { status: "fit", reason: "表示可能" },
      slotTexts: [{ slotId: "z1e1", role: "headline", text, claimIds: ["clm_speed"] }]
    }]
  }));
  const result = await generateBannerCopyBriefs({
    banners: [{ id: "ban_1", strategyId: "str_1" }],
    product: { id: "prod_1", name: "CMO AI Pro" },
    strategy: { id: "str_1", markdown: "広告制作を速くする" },
    template,
    approvedClaimSnapshot,
    creativeHypotheses: [creativeHypothesis],
    copyJsonGenerator: async () => attempts.shift(),
    copyReviewGenerator: async ({ user }) => {
      const [candidate] = JSON.parse(user).candidates;
      return { reviews: [qualityScores(5, candidate.visibleCopy.readoutText)] };
    },
    claimAlignmentGenerator: async ({ user }) => ({
      reviews: JSON.parse(user).candidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        slotId: candidate.slotId,
        status: "not_entailed",
        claimIds: candidate.claimIds,
        reason: "外部claim alignment審査で根拠不十分と判定"
      }))
    }),
    originalityReviewer: () => ({ status: "passed", failures: [] })
  });

  assert.equal(result.results[0].status, "copy_review_failed");
  assert.equal(result.results[0].error.code, "COPY_SCORE_BELOW_THRESHOLD");
  assert.equal(result.results[0].reviewHistory.length, 2);
  assert.equal(Object.hasOwn(result.results[0], "copyBrief"), false);
});

test("独立したコピー品質審査と主張整合審査を同時に開始する", async () => {
  const template = {
    id: "tpl_parallel_review",
    templateZones: [{ elements: [{ type: "text", slotId: "z1e1", role: "headline", messageRole: "hook", content: "{便益}", charCount: 12 }] }],
    copyBlueprint: {
      slots: [{ slotId: "z1e1", required: true }],
      semanticGroups: [{ groupId: "primary", semanticRole: "primary_promise", slotIds: ["z1e1"], readingOrder: 0, joinMode: "single" }]
    }
  };
  const approvedClaimSnapshot = {
    version: 1,
    snapshotId: "acs_parallel",
    contentHash: "sha256:parallel",
    claims: [{ claimId: "clm_speed", text: "広告制作を速くする", claimKind: "benefit", allowedUses: ["headline", "benefit"], numericTokens: [], risk: "objective" }]
  };
  const creativeHypothesis = {
    version: 1,
    hypothesisId: "hyp_parallel",
    contentHash: "sha256:hyp-parallel",
    strategyId: "str_1",
    approvedClaimSnapshotId: approvedClaimSnapshot.snapshotId,
    audienceAttribute: "広告担当者",
    targetMoment: "広告制作を急ぐ瞬間",
    barrier: "制作が遅い",
    chosenAngle: "speed",
    primaryPromise: "広告制作を速くする",
    supportingClaimIds: ["clm_speed"],
    templateMechanism: "短い大見出し",
    semanticGroupPlan: [{ groupId: "primary", semanticRole: "primary_promise", intendedMessage: "広告制作を速くする", slotIds: ["z1e1"], readingOrder: 0, joinMode: "single" }],
    templateFitDecision: { status: "fit", reason: "表示可能", roleAdjustments: [] },
    variationPolicy: { changedDimensions: ["angle"], preservedDimensions: ["audience"] }
  };
  let qualityResolvedAt = 0;
  let alignmentStartedAt = 0;
  const result = await generateBannerCopyBriefs({
    banners: [{ id: "ban_1", strategyId: "str_1" }],
    product: { id: "prod_1", name: "CMO AI Pro" },
    strategy: { id: "str_1", markdown: "広告制作を速くする" },
    template,
    approvedClaimSnapshot,
    creativeHypotheses: [creativeHypothesis],
    copyJsonGenerator: async () => ({
      briefs: [{
        appealAxis: "制作速度",
        whyItStops: "便益が明確",
        messagePlan: validMessagePlan(),
        templateFitDecision: { status: "fit", reason: "表示可能" },
        slotTexts: [{ slotId: "z1e1", role: "headline", text: "広告制作を速くする", claimIds: ["clm_speed"] }]
      }]
    }),
    copyReviewGenerator: async ({ user }) => new Promise((resolve) => {
      setTimeout(() => {
        qualityResolvedAt = Date.now();
        const [candidate] = JSON.parse(user).candidates;
        resolve({ reviews: [qualityScores(5, candidate.visibleCopy.readoutText)] });
      }, 40);
    }),
    claimAlignmentGenerator: async ({ user }) => {
      alignmentStartedAt = Date.now();
      return {
        reviews: JSON.parse(user).candidates.map((candidate) => ({
          candidateId: candidate.candidateId,
          slotId: candidate.slotId,
          status: "entailed",
          claimIds: candidate.claimIds,
          reason: "許可主張の言い換え範囲内"
        }))
      };
    },
    originalityReviewer: () => ({ status: "passed", failures: [] })
  });

  assert.equal(result.results[0].status, "passed");
  assert.ok(alignmentStartedAt > 0);
  assert.ok(alignmentStartedAt < qualityResolvedAt);
});

test("テンプレートが主メッセージを保持できない候補は2回目もrejectなら専用状態で止める", async () => {
  const rejectedBrief = {
    ...tracedBrief("ban_1", "漫画広告をAI制作", "漫画広告をAI制作", "str_1", "tpl_reject"),
    templateFitDecision: { status: "reject", reason: "商品説明と主便益を同時に置けない" }
  };
  const result = await generateBannerCopyBriefs({
    banners: [{ id: "ban_1", strategyId: "str_1" }],
    product: { id: "prod_1", name: "CMO AI Pro" },
    strategy: { id: "str_1", markdown: "漫画広告をAIで制作する" },
    template: {
      id: "tpl_reject",
      templateZones: [{ elements: [{ type: "text", slotId: "z1e1", role: "headline", messageRole: "hook", content: "{便益}", charCount: 12 }] }]
    },
    copyJsonGenerator: async () => ({ briefs: [rejectedBrief] }),
    copyReviewGenerator: async () => ({ reviews: [{ ...qualityScores(5), communicationReview: passingCommunicationReview() }] }),
    originalityReviewer: () => ({ status: "passed", failures: [] })
  });

  assert.equal(result.results[0].status, "template_message_fit_failed");
  assert.equal(result.results[0].error.code, "TEMPLATE_MESSAGE_FIT_FAILED");
  assert.equal(result.results[0].reviewHistory.length, 2);
});

test("文字数上限は10字以下なら13字、11字以上なら120%切り捨てで下限を設けない", () => {
  assert.deepEqual(charBudgetBounds(3), { min: 0, max: 13 });
  assert.deepEqual(charBudgetBounds(8), { min: 0, max: 13 });
  assert.deepEqual(charBudgetBounds(10), { min: 0, max: 13 });
  assert.deepEqual(charBudgetBounds(11), { min: 0, max: 13 });
  assert.deepEqual(charBudgetBounds(12), { min: 0, max: 14 });
  assert.deepEqual(charBudgetBounds(20), { min: 0, max: 24 });
});

test("基準より短いコピーは文字数違反にせず、上限超過だけを返す", () => {
  const copySlotPlan = {
    slots: [
      { slotId: "short", role: "headline", canonicalField: "mainHook", charBudget: 18 },
      { slotId: "over", role: "body", canonicalField: "subHook", charBudget: 8 }
    ]
  };
  const violations = findSlotLengthViolations({
    slotTexts: [
      { slotId: "short", text: "短い" },
      { slotId: "over", text: "12345678901234" }
    ]
  }, copySlotPlan);

  assert.deepEqual(violations.map((slot) => slot.slotId), ["over"]);
  assert.equal(violations[0].maxChars, 13);
  assert.equal(violations[0].minChars, 0);
});

test("コピー生成promptは10字以下13字・11字以上120%の上限ルールを伝える", () => {
  const prompt = buildBannerCopyPrompt({ count: 1, copySlotPlan: buildCopySlotPlan(null) });
  const legacyPercentRule = ["±", "10%"].join("");
  const legacyShortRule = [
    "10字未満は",
    "±2字"
  ].join("");

  assert.match(prompt, /10字以下なら13字以内/);
  assert.match(prompt, /11字以上ならcharBudgetの120%以内/);
  assert.match(prompt, /文字数の下限は設けない/);
  assert.equal(prompt.includes(legacyPercentRule), false);
  assert.equal(prompt.includes(legacyShortRule), false);
});

function tracedBrief(_bannerId, text, sourceText, strategyId, templateId) {
  return {
    appealAxis: "便益起点",
    whyItStops: "短く明確",
    authorizedClaimSet: validAuthorizedClaimSet(),
    messagePlan: validMessagePlan(),
    templateFitDecision: { status: "fit", reason: "一つの主約束を表示できる" },
    slotTexts: [{
      slotId: "z1e1",
      text,
      strategySource: { strategyId, sourceText },
      templateHowSource: { templateId, messageRole: "hook", mechanism: "短い見出し" }
    }]
  };
}

function validAuthorizedClaimSet() {
  return {
    audienceAttribute: "広告成果に責任を持つマーケター",
    purchaseMomentGoal: "次の検証用バナーを今週中に出せる",
    chosenAngle: "benefit",
    coreMessage: "当たり広告の仮説を早く検証できる",
    whyThisAngle: "検証速度の便益が最重要だから",
    additionalInstructionIntent: { priority: "highest", fixedCopy: [], requiredAngles: [], allowSiblingSimilarity: false },
    templateMessagePlan: [{ groupId: "primary", semanticRole: "primary_promise", groupMessage: "当たり広告の仮説を早く検証", slotIds: ["z1e1", "hook"] }],
    claims: [],
    identityAnchors: [],
    mandatorySharedAnchors: [],
    forbiddenClaims: []
  };
}

function qualityScores(score, evidenceText = "漫画広告") {
  return {
    scores: {
      clarity: score,
      specificity: score
    },
    communicationReview: passingCommunicationReview({ evidenceSpans: [{ text: evidenceText, supports: "visible_message" }] }),
    warnings: []
  };
}

function validMessagePlan() {
  return {
    targetMoment: "漫画広告の制作を急ぐ時",
    awarenessStage: "solution_aware",
    productOrTaskAnchor: "漫画広告制作AI",
    oneMessage: "漫画広告をAIで1日制作できる",
    primaryPromise: "漫画広告を1日で制作",
    supportingProof: "キャラを統一できる",
    offer: "",
    informationPriority: { mustShow: ["漫画広告制作AI", "1日制作"], support: ["キャラ統一"], drop: [] },
    numbers: [{ value: "1日", meaning: "制作期間", owner: "利用者", polarity: "shorter_is_better", minimumContext: "漫画広告を1日制作" }],
    forbiddenInterpretations: []
  };
}

function passingCommunicationReview(overrides = {}) {
  return {
    decodedProductOrTask: "漫画広告制作AI",
    decodedPromise: "漫画広告をAIで1日制作できる",
    decodedMechanism: "AIで漫画広告を制作する",
    decodedOffer: "",
    numberMeanings: [],
    evidenceSpans: [{ text: "漫画広告", supports: "product_or_task" }],
    ambiguities: [],
    productOrTaskUnderstood: true,
    primaryPromiseUnderstood: true,
    singleMessageFocus: true,
    numberMeaningUnambiguous: true,
    offerConditionUnderstood: true,
    audienceRelevanceUnderstood: true,
    ...overrides
  };
}
