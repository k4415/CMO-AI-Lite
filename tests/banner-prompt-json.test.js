import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import { buildBannerDesignPrompt, normalizeBannerProposal } from "../src/core/banner-ai.js";
import { hashCopyBrief } from "../src/core/banner-copy-ai.js";
import { buildInstructionPolicy } from "../src/core/banner-instruction-policy.js";

function validStage2Context() {
  const approvedClaimSnapshot = {
    version: 1,
    snapshotId: "acs_1",
    contentHash: "sha256:claims",
    claims: []
  };
  const creativeHypothesis = {
    version: 1,
    hypothesisId: "hyp_1",
    contentHash: "sha256:hypothesis",
    approvedClaimSnapshotId: "acs_1",
    approvedClaimSnapshotHash: "sha256:claims",
    audienceAttribute: "広告制作の担当者",
    targetMoment: "制作の締切が迫った瞬間",
    barrier: "制作時間が足りない",
    primaryPromise: "制作時間を5分の1に",
    templateMechanism: "大数字",
    visualIntent: { subject: "制作フロー", focalPoint: "短縮された工程" }
  };
  const copyBrief = {
    version: 4,
    strategyId: "str_1",
    hypothesisId: "hyp_1",
    hypothesisHash: "sha256:hypothesis",
    approvedClaimSnapshotId: "acs_1",
    approvedClaimSnapshotHash: "sha256:claims",
    appealAxis: "速度",
    mainHook: "制作時間を5分の1に",
    whyItStops: "数字",
    slotTexts: [{ slotId: "mainHook", text: "制作時間を5分の1に", hypothesisId: "hyp_1", claimIds: [] }]
  };
  copyBrief.copyBriefHash = hashCopyBrief(copyBrief);
  return {
    banner: { id: "banner_1", imageSize: "1080x1080", creativeHypothesis, approvedClaimSnapshot },
    product: { name: "CMO AI Pro" },
    strategy: { id: "str_1" },
    template: null,
    copyBrief,
    creativeHypothesis,
    approvedClaimSnapshot
  };
}

test("上位の色指定がない場合はtemplateColorSchemeを最終フォールバックにする", () => {
  const template = {
    id: "tpl_color",
    templateColorScheme: { main: "#ff0000", sub: "#ffffff", accent: "#00ff00", background: "#f8fafc" },
    templateZones: [{ name: "Hero", background: "#ff0000", elements: [{ type: "text", role: "headline", color: "#00ff00", content: "{悩み}" }] }]
  };
  const copyBrief = { appealAxis: "課題", mainHook: "判断を迷わない", whyItStops: "具体的" };
  const proposal = normalizeBannerProposal(
    { promptJson: { zones: [] } },
    { banner: {}, product: {}, strategy: {}, template, copyBrief }
  );
  const prompt = buildBannerDesignPrompt({ banner: {}, product: {}, strategy: {}, template, copyBrief });

  assert.deepEqual(paletteOnly(proposal.promptJson.colorScheme), {
    main: "#FF0000",
    sub: "#FFFFFF",
    accent: "#00FF00",
    background: "#F8FAFC"
  });
  assert.deepEqual(paletteOnly(proposal.promptJson.colorScheme), proposal.colorDecision.palette);
  assert.deepEqual(proposal.colorDecision.templateFallbackFields, ["main", "sub", "accent", "background"]);
  assert.match(prompt, /"colorDecision"/);
  assert.match(prompt, /#FF0000|#00FF00/);
  assert.doesNotMatch(prompt, /旧コピー|\{悩み\}/);
  assert.equal(proposal.colorDecision.contractReview.status, "passed");
});

test("explicit color instruction overrides model and regulation palettes", () => {
  const proposal = normalizeBannerProposal(
    { promptJson: { colorScheme: { accent: "#0000FF" }, zones: [] } },
    {
      banner: {},
      product: {},
      strategy: {},
      template: null,
      copyBrief: { appealAxis: "色", mainHook: "判断を迷わない", whyItStops: "明確" },
      specifiedRules: [{ ruleType: "color", pattern: "#00FF00" }],
      instructionPolicy: buildInstructionPolicy("アクセントカラーは#FF0000を必ず使ってください")
    }
  );

  assert.equal(proposal.promptJson.colorScheme.accent, "#FF0000");
  assert.equal(proposal.colorDecision.sourceByField.accent, "user_instruction");
  assert.deepEqual(paletteOnly(proposal.promptJson.colorScheme), proposal.colorDecision.palette);
});

test("tpl_default_026の元ゴールドを除去し、追加指示の青アクセントへ再バインドする", async () => {
  const template = await loadTemplate("tpl_default_026");
  const proposal = normalizeBannerProposal(
    { promptJson: { zones: [] } },
    {
      banner: { additionalInstruction: "アクセントカラーは青にしてください" },
      product: {},
      strategy: { colorInference: { status: "insufficient", palette: {}, reason: "根拠不足", evidence: [] } },
      template,
      copyBrief: { appealAxis: "募集", mainHook: "募集しています", whyItStops: "直接的" },
      instructionPolicy: buildInstructionPolicy("アクセントカラーは青にしてください")
    }
  );

  assert.equal(proposal.promptJson.colorScheme.accent, "#2563EB");
  assert.equal(proposal.colorDecision.sourceByField.accent, "user_instruction");
  assert.deepEqual(paletteOnly(proposal.promptJson.colorScheme), proposal.colorDecision.palette);
  assert.doesNotMatch(JSON.stringify(proposal.promptJson), /#D8A514|ゴールド/);
  assert.equal(proposal.colorDecision.contractReview.status, "passed");
});

test("tpl_default_032ではregulation指定外の色をWHO-WHAT推論、次にtemplateから補う", async () => {
  const template = await loadTemplate("tpl_default_032");
  const strategy = inferredStrategy({
    main: "#16324F",
    sub: "#E2E8F0",
    accent: "#F28C28",
    background: "#F7FAFC"
  });
  const proposal = normalizeBannerProposal(
    { promptJson: { zones: [] } },
    {
      banner: {},
      product: {},
      strategy,
      template,
      specifiedRules: [{ ruleType: "color", description: "メインカラーは#003366、背景色は#FFFFFF" }],
      copyBrief: { appealAxis: "得感", mainHook: "今なら始めやすい", whyItStops: "具体的" }
    }
  );

  assert.deepEqual(proposal.colorDecision.sourceByField, {
    main: "regulation",
    sub: "who_what_inference",
    accent: "who_what_inference",
    background: "regulation"
  });
  assert.deepEqual(paletteOnly(proposal.promptJson.colorScheme), proposal.colorDecision.palette);
  assert.equal(proposal.colorDecision.contractReview.status, "passed");
});

test("有効なWHO-WHAT colorInferenceだけで4色を決定する", () => {
  const strategy = inferredStrategy({
    main: "#16324F",
    sub: "#FFFFFF",
    accent: "#F28C28",
    background: "#F7FAFC"
  });
  const proposal = normalizeBannerProposal(
    { promptJson: { colorScheme: { main: "#DEADBE", accent: "#BADBAD" }, zones: [] } },
    {
      banner: {}, product: {}, strategy, template: null,
      copyBrief: { appealAxis: "信頼", mainHook: "安心して始める", whyItStops: "具体的" }
    }
  );

  assert.equal(proposal.colorDecision.source, "who_what_inference");
  assert.deepEqual(proposal.colorDecision.sourcesUsed, ["who_what_inference"]);
  assert.deepEqual(paletteOnly(proposal.promptJson.colorScheme), proposal.colorDecision.palette);
  assert.doesNotMatch(JSON.stringify(proposal.promptJson.colorScheme), /DEADBE|BADBAD/);
});

test("WHO-WHAT推論がinsufficientなら4色すべてtemplate由来にする", async () => {
  const template = await loadTemplate("tpl_default_026");
  const proposal = normalizeBannerProposal(
    { promptJson: { zones: [] } },
    {
      banner: {}, product: {},
      strategy: { colorInference: { status: "insufficient", palette: {}, reason: "根拠不足", evidence: [] } },
      template,
      copyBrief: { appealAxis: "募集", mainHook: "募集しています", whyItStops: "直接的" }
    }
  );

  assert.equal(proposal.colorDecision.source, "template");
  assert.deepEqual(proposal.colorDecision.templateFallbackFields, ["main", "sub", "accent", "background"]);
  assert.deepEqual(paletteOnly(proposal.promptJson.colorScheme), proposal.colorDecision.palette);
  assert.deepEqual(proposal.colorDecision.palette, {
    main: "#000000",
    sub: "#BDBDBD",
    accent: "#D8A514",
    background: "#FFFFFF"
  });
});

function paletteOnly(value = {}) {
  return {
    main: value.main,
    sub: value.sub,
    accent: value.accent,
    background: value.background
  };
}

function inferredStrategy(palette) {
  return {
    targetAttributes: "広告運用担当者",
    decisionCriteria: "信頼できること",
    colorInference: {
      status: "inferred",
      palette,
      reason: "信頼できる判断を支える配色",
      evidence: ["判断基準: 信頼できること"]
    }
  };
}

async function loadTemplate(id) {
  const templates = JSON.parse(await fs.readFile(new URL("../data/ad-templates.json", import.meta.url), "utf8"));
  return templates.find((item) => item.id === id);
}

test("新規promptJsonにはテンプレ全文を複製保存しない", () => {
  const proposal = normalizeBannerProposal(
    {
      promptJson: {
        basic: { size: "1080x1080" },
        zones: [{ name: "Hero", elements: [{ type: "text", content: "まだ担当者の勘で作ってる？" }] }]
      },
      promptText: "prompt"
    },
    {
      banner: { imageSize: "1080x1080" },
      product: { name: "CMO AI Pro" },
      strategy: { conceptName: "広告運用", benefit: "改善仮説をチームで回す" },
      template: {
        id: "tpl_1",
        title: "NO.101",
        templateTextStoryboard: "巨大なテンプレ字コンテ本文".repeat(100),
        templatePromptJson: { huge: "巨大なテンプレPrompt JSON".repeat(100) }
      },
      copyBrief: {
        appealAxis: "課題起点",
        mainHook: "まだ担当者の勘で作ってる？",
        subHook: "改善仮説をチームで回す",
        cta: "詳しく見る",
        whyItStops: "課題が具体的"
      }
    }
  );

  assert.equal(proposal.imageText, "まだ担当者の勘で作ってる？\n改善仮説をチームで回す\n詳しく見る");
  assert.equal(proposal.promptJson.templateAdId, "tpl_1");
  assert.equal(Object.hasOwn(proposal.promptJson, "templateName"), false);
  assert.equal(Object.hasOwn(proposal.promptJson, "templateTextStoryboard"), false);
  assert.equal(Object.hasOwn(proposal.promptJson, "templatePromptJson"), false);
});

test("Stage 2はコピー前に確定したhypothesisIdを画像プロンプトまで保持する", () => {
  const context = validStage2Context();
  const proposal = normalizeBannerProposal(
    { promptJson: { zones: [] } },
    context
  );

  assert.equal(proposal.creativeHypothesis.hypothesisId, "hyp_1");
  assert.equal(proposal.promptJson.contractRefs.hypothesisId, "hyp_1");
  assert.equal(proposal.promptJson.contractRefs.approvedClaimSnapshotId, "acs_1");
  assert.equal(proposal.promptJson.contractRefs.copyBriefHash, context.copyBrief.copyBriefHash);
});

test("copyBriefとcreativeHypothesisのhash不一致はcopyノードへ戻す", () => {
  const context = validStage2Context();
  context.creativeHypothesis = {
    ...context.creativeHypothesis,
    contentHash: "sha256:new"
  };

  assert.throws(() => normalizeBannerProposal(
    { promptJson: { zones: [] } },
    context
  ), (error) => error.code === "COPY_HYPOTHESIS_REF_STALE" && error.restartNode === "copy");
});

test("モデル出力の偽contractRefsは正本参照で上書きする", () => {
  const context = validStage2Context();
  const proposal = normalizeBannerProposal(
    { promptJson: { contractRefs: { hypothesisId: "hyp_forged", copyBriefHash: "sha256:forged" }, zones: [] } },
    context
  );

  assert.equal(proposal.promptJson.contractRefs.hypothesisId, "hyp_1");
  assert.equal(proposal.promptJson.contractRefs.copyBriefHash, context.copyBrief.copyBriefHash);
});

test("テンプレ表示名の具体色語をStage 2へ渡さずpromptJsonにも保存しない", () => {
  const context = validStage2Context();
  context.template = {
    id: "tpl_red_name",
    title: "NO.102_BtoB SaaS 赤背景 代理店チャネル変革",
    creativeType: "banner",
    copyBlueprint: { persuasionMechanism: { primaryHookMechanism: "problem-solution" } },
    layoutBlueprint: { visualHierarchy: ["大見出し", "管理画面", "統合メリット"] }
  };
  context.banner.title = context.template.title;
  const modelPrompt = buildBannerDesignPrompt({
    ...context,
    specifiedRules: [],
    copySlotPlan: { semanticGroups: [] }
  });
  const proposal = normalizeBannerProposal({ promptJson: { zones: [] } }, context);

  assert.doesNotMatch(modelPrompt, /赤背景|代理店チャネル変革/);
  assert.match(modelPrompt, /tpl_red_name/);
  assert.equal(proposal.promptJson.templateAdId, "tpl_red_name");
  assert.equal(Object.hasOwn(proposal.promptJson, "templateName"), false);
});

test("Stage 2 model-authored promptText cannot reintroduce changed copy", () => {
  const proposal = normalizeBannerProposal(
    {
      promptJson: { zones: [{ name: "Hero", elements: [{ type: "text", role: "headline", content: "変更されたコピー" }] }] },
      promptText: "画像内には『変更されたコピー』と書いてください"
    },
    {
      banner: {},
      product: {},
      strategy: {},
      template: null,
      copyBrief: { appealAxis: "固定", mainHook: "確定コピー", whyItStops: "明確" }
    }
  );

  assert.match(proposal.promptText, /確定コピー/);
  assert.doesNotMatch(proposal.promptText, /変更されたコピー/);
});

test("legacy template storyboard cannot enter normalized Stage 2 prompt", () => {
  const proposal = normalizeBannerProposal(
    { promptJson: { zones: [] } },
    {
      banner: {},
      product: {},
      strategy: {},
      template: {
        templateTextStoryboard: "RAW_TEMPLATE_COPY_#FF0000",
        structureSheet: { source: "legacy", summary: "RAW_TEMPLATE_COPY_#FF0000" },
        templateZones: [{ name: "Hero", position: "top", purpose: "hook", elements: [{ type: "text", role: "headline", content: "旧コピー" }] }]
      },
      copyBrief: { appealAxis: "固定", mainHook: "確定コピー", whyItStops: "明確" }
    }
  );

  assert.doesNotMatch(JSON.stringify(proposal), /RAW_TEMPLATE_COPY|#FF0000/);
});

test("slotTextsがある場合はスロット順のimageTextとslotId対応のzonesにする", () => {
  const proposal = normalizeBannerProposal(
    {
      promptJson: {
        basic: { size: "1080x1080" },
        zones: [{
          name: "Hero",
          elements: [
            { type: "text", role: "headline", content: "AIが書いた長い見出し" },
            { type: "text", role: "body", content: "AIが書いた本文" },
            { type: "text", role: "label", content: "ここに余ったCTAを入れる" }
          ]
        }]
      },
      promptText: "prompt"
    },
    {
      banner: { imageSize: "1080x1080" },
      product: { name: "CMO AI Pro" },
      strategy: { conceptName: "広告運用" },
      template: {
        id: "tpl_slots",
        title: "スロットテンプレ",
        templateZones: [{
          name: "Hero",
          elements: [
            { type: "text", role: "headline", messageRole: "hook", content: "{悩み}", charCount: 8 },
            { type: "text", role: "body", messageRole: "benefit", content: "{便益}", charCount: 8 }
          ]
        }]
      },
      copyBrief: {
        appealAxis: "課題起点",
        whyItStops: "短く具体的",
        slotTexts: [
          { slotId: "z1e1", text: "今日中に初稿", charBudget: 8 },
          { slotId: "z1e2", text: "根拠で選べる", charBudget: 8 }
        ]
      }
    }
  );

  assert.equal(proposal.imageText, "今日中に初稿\n根拠で選べる");
  assert.equal(proposal.copyBrief.mainHook, "今日中に初稿");
  assert.equal(proposal.copyBrief.cta, "");
  assert.equal(proposal.promptJson.zones[0].elements[0].content, "今日中に初稿");
  assert.equal(proposal.promptJson.zones[0].elements[1].content, "根拠で選べる");
  assert.equal(proposal.promptJson.zones[0].elements.length, 2);
  assert.equal(proposal.promptJson.templateStructureReview.violations.some((item) => item.type === "extra_element"), true);
});

test("Stage 2は同じgeneration contractを保存し、当たる理由を追加AIなしで構造化する", () => {
  const generationContract = {
    strategyWhat: { strategyId: "str_1", markdown: "制作時間を5分の1に" },
    templateHow: { templateId: "tpl_1", hookMechanism: "大数字で変化を即時理解", reuseMethod: "mechanism_only" },
    instructionPolicy: { rawInstruction: "" },
    sourceTracePolicy: { requireStrategySourceForClaims: true, requireTemplateSourceForHow: true }
  };
  const proposal = normalizeBannerProposal(
    {
      promptJson: { zones: [] },
      creativeHypothesis: {
        targetMoment: "制作の締切が迫った瞬間",
        proofLogic: "時間短縮の約束を判断材料へ接続",
        whyItShouldWin: "大数字でスクロールを止める",
        testVariable: "時間短縮の数字",
        expectedMetricImpact: "CTR"
      }
    },
    {
      banner: {},
      product: {},
      strategy: { id: "str_1", markdown: "制作時間を5分の1に" },
      template: null,
      copyBrief: {
        version: 2,
        appealAxis: "便益",
        mainHook: "制作時間を5分の1に",
        whyItStops: "数字",
        readoutText: "広告制作AI / 制作時間を5分の1に",
        messagePlan: {
          productOrTaskAnchor: "広告制作AI",
          oneMessage: "広告制作AIで制作時間を5分の1にする",
          primaryPromise: "制作時間を5分の1に"
        },
        templateFitDecision: { status: "fit", reason: "主約束を表示できる" }
      },
      generationContract
    }
  );
  const prompt = buildBannerDesignPrompt({
    banner: {}, product: {}, strategy: {}, template: null,
    copyBrief: proposal.copyBrief,
    generationContract
  });

  assert.deepEqual(proposal.bannerGenerationContract, generationContract);
  assert.equal(proposal.creativeHypothesis.templateMechanism, "大数字で変化を即時理解");
  assert.equal(proposal.creativeHypothesis.strategyPromise, "制作時間を5分の1に");
  assert.equal(proposal.creativeHypothesis.oneMessage, "広告制作AIで制作時間を5分の1にする");
  assert.equal(proposal.copyBrief.messagePlan.productOrTaskAnchor, "広告制作AI");
  assert.equal(proposal.promptJson.copyBrief.readoutText, "広告制作AI / 制作時間を5分の1に");
  assert.match(prompt, /# Stage2Input/);
  assert.doesNotMatch(prompt, /# BannerGenerationContract/);
});
