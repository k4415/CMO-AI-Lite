import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildBannerDiversityInstruction } from "../src/core/banner-ai.js";
import { hashCopyBrief } from "../src/core/banner-copy-hash.js";
import { generateBannerCopyPlan } from "../src/core/banner-copyplan-ai.js";
import {
  addBannerCreative,
  claimBannerPromptGeneration,
  ensureBannerCopyBriefsForPromptJobs,
  generateBannerPrompt,
  generateBannerPromptBatch,
  listBannerCreatives,
  reconcileBannerPipeline,
  reviseBannerCreative,
  updateBannerCreative
} from "../src/core/banner-store.js";

test("diversity instruction includes axis and prior copy without unbounded history", () => {
  const text = buildBannerDiversityInstruction({
    axisLabel: "判断基準起点",
    axisInstruction: "選ぶ理由を示す",
    avoidCopies: Array.from({ length: 15 }, (_, index) => ({
      title: `案${index}`,
      imageText: `コピー${index}`,
      visualDirection: index === 14 ? "ノートPCを囲むチーム" : ""
    }))
  });

  assert.match(text, /今回の訴求軸: 判断基準起点/);
  assert.doesNotMatch(text, /コピー0"/);
  assert.match(text, /ノートPCを囲むチーム/);
  assert.match(text, /同じ被写体・利用シーン/);
});

test("prompt claim without an explicit node infers copyplan and records its input ownership", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-banner-inferred-claim-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  const context = contractContext();
  await fs.writeFile(path.join(projectRoot, "data", "products.json"), JSON.stringify(context.products));
  await fs.writeFile(path.join(projectRoot, "data", "strategies.json"), JSON.stringify(context.strategies));
  await fs.writeFile(path.join(projectRoot, "data", "expression-rules.json"), JSON.stringify(context.expressionRules));
  const banner = await addBannerCreative(projectRoot, {
    productId: "product-1",
    strategyId: "strategy-1",
    title: "初回API生成"
  });

  const claim = await claimBannerPromptGeneration(projectRoot, banner.id, {
    ownerId: "test-server",
    attemptId: "attempt-inferred",
    leaseMs: 60000
  });

  assert.equal(claim.claimed, true);
  assert.equal(claim.banner.pipelineNodes.copyplan.status, "running");
  assert.equal(claim.banner.pipelineNodes.copyplan.attemptId, "attempt-inferred");
  assert.match(claim.banner.pipelineNodes.copyplan.inputHash, /^sha256:/);
});

test("batch generation creates copyBriefs once and passes each brief to Stage 2", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-banner-diversity-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  const base = { productId: "product-1", strategyId: "strategy-1", title: "案" };
  for (let index = 0; index < 12; index += 1) {
    const existing = await addBannerCreative(projectRoot, { ...base, title: `既存案${index + 1}` });
    await updateBannerCreative(projectRoot, existing.id, {
      imageText: `月${index + 1}案件以上の広告運用に\nCPA改善をチームで回す`,
      copyBrief: { ...brief(`既存軸${index + 1}`, `月${index + 1}案件以上の広告運用に`), proof: `長い根拠${index + 1}` },
      promptJson: { globalDesign: { visualStyle: { type: "team workflow" } }, zones: [{ elements: [{ type: "image", role: `scene-${index + 1}` }] }] }
    });
  }
  const first = await addBannerCreative(projectRoot, { ...base, title: "新規案1" });
  const second = await addBannerCreative(projectRoot, { ...base, title: "新規案2" });
  const copyBriefCalls = [];
  const proposalCalls = [];
  const copyBriefGenerator = async ({ banners, existingCopies }) => {
    copyBriefCalls.push({ banners, existingCopies });
    return copyResults(banners, [
      brief("属人化回避", "担当者ごとの当たり外れを減らす"),
      brief("判断基準", "広告判断を迷わない")
    ]);
  };
  const proposalGenerator = async (input) => {
    proposalCalls.push(input);
    const { copyBrief } = input;
    const imageText = [copyBrief.mainHook, copyBrief.subHook, copyBrief.cta].join("\n");
    return {
      imageText,
      copyBrief,
      promptJson: { zones: [{ elements: [{ type: "text", role: "main hook", content: copyBrief.mainHook }] }], structureSheet: {} },
      promptText: imageText,
      reviewNotes: "",
      selectionReason: ""
    };
  };
  const context = {
    products: [{ id: "product-1", name: "CMO AI Pro" }],
    strategies: [{ id: "strategy-1", markdown: "戦略本文" }],
    adTemplates: [],
    facts: [],
    expressionRules: []
  };

  const generated = await generateBannerPromptBatch(projectRoot, [first.id, second.id], context, { proposalGenerator, copyBriefGenerator });

  assert.equal(copyBriefCalls.length, 1);
  assert.equal(copyBriefCalls[0].banners.length, 2);
  assert.equal(Object.hasOwn(copyBriefCalls[0], "facts"), false);
  assert.equal(proposalCalls.length, 2);
  assert.equal(proposalCalls[0].diversityGuidance.avoidCopies.length, 8);
  assert.equal(proposalCalls[0].diversityGuidance.avoidCopies.every((item) => !Object.hasOwn(item, "copyBrief") && !Object.hasOwn(item, "proof")), true);
  assert.equal(proposalCalls[0].diversityGuidance.avoidCopies.every((item) => Object.hasOwn(item, "candidateIdentity") && Object.hasOwn(item, "mainHook")), true);
  assert.equal(proposalCalls.every((call) => !Object.hasOwn(call, "facts")), true);
  assert.equal(generated.errors.length, 0);
  assert.notEqual(generated.banners[0].variationAxis, generated.banners[1].variationAxis);
  assert.match(generated.banners[0].imageText, /担当者ごと/);
  assert.equal(generated.banners[1].copyBrief.appealAxis, "判断基準");
  assert.equal(generated.banners[0].generationRunId, "run-test");
  assert.equal(generated.banners[0].candidateGroupId, "group-test");
  assert.equal(generated.banners[0].candidateIndex, 0);
  assert.ok(generated.banners[0].approvedClaimSnapshot?.snapshotId);
});

test("Stage 2は追加指示で許可されたWHO-WHAT外の数値コピーを再遮断しない", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-banner-instruction-number-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  const banner = await addBannerCreative(projectRoot, {
    productId: "product-1",
    strategyId: "strategy-1",
    title: "追加指示数値",
    additionalInstruction: "漫画家依頼だと1ヶ月かかる比較を入れてください"
  });
  const requestedBrief = brief("競合差分", "漫画家依頼だと1ヶ月");
  const result = await generateBannerPrompt(projectRoot, banner.id, {
    products: [{ id: "product-1", name: "CMO AI Pro" }],
    strategies: [{ id: "strategy-1", markdown: "漫画広告を今週中に検証したい" }]
  }, {
    copyBriefGenerator: async ({ banners }) => copyResults(banners, [requestedBrief]),
    proposalGenerator: async ({ copyBrief }) => ({
      imageText: copyBrief.mainHook,
      copyBrief,
      promptJson: { zones: [{ elements: [{ type: "text", role: "main hook", content: copyBrief.mainHook }] }], structureSheet: {} },
      promptText: copyBrief.mainHook,
      reviewNotes: "",
      selectionReason: ""
    })
  });

  assert.equal(result.productionStatus, "prompt_ready");
  assert.equal(result.strategyCheck, null);
});

test("different sibling instructions are isolated into separate copy requests", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-banner-instruction-isolation-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  const first = await addBannerCreative(projectRoot, {
    productId: "product-1",
    strategyId: "strategy-1",
    title: "人物案",
    additionalInstruction: "人物を主役にする"
  });
  const second = await addBannerCreative(projectRoot, {
    productId: "product-1",
    strategyId: "strategy-1",
    title: "商品案",
    additionalInstruction: "商品を主役にする"
  });
  const instructions = [];
  const copyBriefGenerator = async ({ banners, extraInstruction }) => {
    instructions.push({ bannerIds: banners.map((item) => item.id), extraInstruction });
    return copyResults(banners, [brief("個別軸", banners[0].title)]);
  };
  const proposalGenerator = async ({ copyBrief }) => ({
    imageText: copyBrief.mainHook,
    copyBrief,
    promptJson: { zones: [{ elements: [{ type: "text", role: "main hook", content: copyBrief.mainHook }] }], structureSheet: {} },
    promptText: "prompt",
    reviewNotes: "",
    selectionReason: ""
  });
  const context = { products: [{ id: "product-1", name: "商品" }], strategies: [{ id: "strategy-1", markdown: "戦略本文" }] };

  const result = await generateBannerPromptBatch(projectRoot, [first.id, second.id], context, { copyBriefGenerator, proposalGenerator });

  assert.equal(result.errors.length, 0);
  assert.equal(instructions.length, 2);
  assert.deepEqual(instructions.map((item) => item.bannerIds.length), [1, 1]);
  assert.deepEqual(new Set(instructions.map((item) => item.extraInstruction)), new Set(["人物を主役にする", "商品を主役にする"]));
});

test("batch generation continues with remaining banners after one prompt failure", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-banner-partial-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  const base = { productId: "product-1", strategyId: "strategy-1", title: "案" };
  const first = await addBannerCreative(projectRoot, { ...base, title: "失敗案" });
  const second = await addBannerCreative(projectRoot, { ...base, title: "成功案" });
  let callCount = 0;
  const copyBriefGenerator = async ({ banners }) => copyResults(banners, [brief("失敗軸", "失敗する案"), brief("成功軸", "判断を迷わない広告運用")]);
  const proposalGenerator = async ({ copyBrief }) => {
    callCount += 1;
    if (callCount === 1) throw new Error("temporary failure");
    return { imageText: copyBrief.mainHook, copyBrief, promptJson: { zones: [{ elements: [{ type: "text", role: "main hook", content: copyBrief.mainHook }] }], structureSheet: {} }, promptText: "prompt", reviewNotes: "", selectionReason: "" };
  };
  const context = { products: [{ id: "product-1", name: "商品" }], strategies: [{ id: "strategy-1", markdown: "戦略本文" }] };

  const result = await generateBannerPromptBatch(projectRoot, [first.id, second.id], context, { proposalGenerator, copyBriefGenerator });

  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].bannerId, first.id);
  assert.equal(result.banners.length, 1);
  assert.equal(result.banners[0].id, second.id);
  assert.equal(result.banners[0].productionStatus, "prompt_ready");
});

test("Stage A warningコピーは保存してStage 2へ進む", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-banner-copy-partial-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  const base = { productId: "product-1", strategyId: "strategy-1", title: "案" };
  const warned = await addBannerCreative(projectRoot, { ...base, title: "コピー警告" });
  const passed = await addBannerCreative(projectRoot, { ...base, title: "コピー合格" });
  const copyBriefGenerator = async ({ banners }) => ({
    hypothesis: hypothesis("hyp_shared", { snapshotId: "acs_test", contentHash: "sha256:snap", claims: [{ claimId: "c1", claimKind: "benefit" }] }),
    results: [
      {
        bannerId: banners[0].id,
        status: "warning",
        copyBrief: brief("弱い軸", "警告付きコピー"),
        reviewHistory: [{ attempt: 1, decision: "warning" }],
        categoryRelation: { value: "near", reuseMethod: "mechanism_only" },
        warnings: [{ type: "copy_selfcheck_unresolved", stage: "copyplan", message: "数字が弱い", occurredAt: "2026-07-17T00:00:00.000Z" }]
      },
      {
        bannerId: banners[1].id,
        status: "passed",
        copyBrief: brief("判断基準", "広告判断を迷わない"),
        reviewHistory: [{ attempt: 1, decision: "passed" }],
        categoryRelation: { value: "near", reuseMethod: "mechanism_only" },
        warnings: []
      }
    ]
  });
  const proposalCalls = [];
  const proposalGenerator = async ({ banner, copyBrief }) => {
    proposalCalls.push(banner.id);
    return {
      imageText: copyBrief.mainHook,
      copyBrief,
      promptJson: { zones: [{ elements: [{ type: "text", role: "main hook", content: copyBrief.mainHook }] }], structureSheet: {} },
      promptText: "prompt",
      reviewNotes: "",
      selectionReason: ""
    };
  };
  const context = { products: [{ id: "product-1", name: "商品" }], strategies: [{ id: "strategy-1", markdown: "戦略本文" }] };

  const result = await generateBannerPromptBatch(projectRoot, [warned.id, passed.id], context, { copyBriefGenerator, proposalGenerator });
  const stored = await listBannerCreatives(projectRoot);
  const storedWarned = stored.find((item) => item.id === warned.id);

  assert.deepEqual(proposalCalls.sort(), [warned.id, passed.id].sort());
  assert.equal(result.banners.length, 2);
  assert.equal(storedWarned.productionStatus, "prompt_ready");
  assert.equal(storedWarned.warnings[0].type, "copy_selfcheck_unresolved");
  assert.equal(storedWarned.lastError, "");
});

test("Stage 1のwarningコピーを保存してStage 2へ進める", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-banner-copy-warning-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  const banner = await addBannerCreative(projectRoot, {
    productId: "product-1",
    strategyId: "strategy-1",
    title: "コピー警告"
  });
  const warningBrief = brief("CPA改善", "CPA1/10改善");
  const reviewHistory = [{
    attempt: 1,
    copyBrief: warningBrief,
    decision: "warning"
  }];
  const proposalCalls = [];
  const result = await generateBannerPromptBatch(projectRoot, [banner.id], {
    products: [{ id: "product-1", name: "商品" }],
    strategies: [{ id: "strategy-1", markdown: "戦略本文" }]
  }, {
    copyBriefGenerator: async ({ banners }) => ({
      hypothesis: hypothesis("hyp_warn", { snapshotId: "acs_test", contentHash: "sha256:snap", claims: [{ claimId: "c1", claimKind: "benefit" }] }),
      results: [{
        bannerId: banners[0].id,
        status: "warning",
        copyBrief: warningBrief,
        reviewHistory,
        categoryRelation: { value: "near", reuseMethod: "mechanism_only" },
        warnings: [{ type: "copy_selfcheck_unresolved", stage: "copyplan", message: "比較基準が曖昧", occurredAt: "2026-07-17T00:00:00.000Z" }]
      }]
    }),
    proposalGenerator: async ({ banner: target, copyBrief }) => {
      proposalCalls.push(target.id);
      return {
        imageText: copyBrief.mainHook,
        copyBrief,
        promptJson: { zones: [{ elements: [{ type: "text", role: "main hook", content: copyBrief.mainHook }] }], structureSheet: {} },
        promptText: "prompt",
        reviewNotes: "",
        selectionReason: ""
      };
    }
  });
  const stored = (await listBannerCreatives(projectRoot)).find((item) => item.id === banner.id);

  assert.deepEqual(proposalCalls, [banner.id]);
  assert.equal(result.errors.length, 0);
  assert.equal(result.banners.length, 1);
  assert.equal(stored.productionStatus, "prompt_ready");
  assert.equal(stored.warnings[0].type, "copy_selfcheck_unresolved");
  assert.equal(stored.copyReviewHistory.length, 1);
  assert.equal(stored.lastError, "");
});

test("explicit revision prioritizes the requested edit without diversity regeneration", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-banner-revise-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  const banner = await addBannerCreative(projectRoot, { productId: "product-1", strategyId: "strategy-1", title: "修正案" });
  let callCount = 0;
  let copyBriefCallCount = 0;
  const copyBriefGenerator = async ({ banners }) => {
    copyBriefCallCount += 1;
    return copyResults(banners, [brief("修正軸", "指定どおりの修正版")]);
  };
  const proposalGenerator = async ({ copyBrief }) => {
    callCount += 1;
    return { imageText: copyBrief.mainHook, copyBrief, promptJson: { zones: [{ elements: [{ type: "text", role: "main hook", content: copyBrief.mainHook }] }], structureSheet: {} }, promptText: "prompt", reviewNotes: "", selectionReason: "" };
  };
  const context = { products: [{ id: "product-1", name: "商品" }], strategies: [{ id: "strategy-1", markdown: "戦略本文" }] };

  const revised = await reviseBannerCreative(projectRoot, banner.id, context, { proposalGenerator, copyBriefGenerator });

  assert.equal(copyBriefCallCount, 1);
  assert.equal(callCount, 1);
  assert.equal(revised.imageText, "指定どおりの修正版");
});

test("visual-only revision keeps locked copy and skips Stage 1 regeneration", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-banner-copy-lock-revise-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  const created = await addBannerCreative(projectRoot, { productId: "product-1", strategyId: "strategy-1", title: "固定案" });
  await updateBannerCreative(projectRoot, created.id, {
    copyBrief: brief("固定軸", "固定コピー"),
    imageText: "固定コピー\n根拠から選べる運用へ\n詳しく見る"
  });
  await updateBannerCreative(projectRoot, created.id, {
    revisionInstruction: "コピーはそのままで画像だけ女性経営者に変えてください"
  });
  let receivedCopy = null;
  const proposalGenerator = async ({ copyBrief }) => {
    receivedCopy = copyBrief;
    return {
      imageText: [copyBrief.mainHook, copyBrief.subHook, copyBrief.cta].join("\n"),
      copyBrief,
      promptJson: { zones: [{ elements: [{ type: "text", role: "main hook", content: copyBrief.mainHook }] }], structureSheet: {} },
      promptText: "prompt",
      reviewNotes: "",
      selectionReason: ""
    };
  };
  const context = { products: [{ id: "product-1", name: "商品" }], strategies: [{ id: "strategy-1", markdown: "固定コピーを使う戦略" }] };

  const revised = await reviseBannerCreative(projectRoot, created.id, context, {
    copyBriefGenerator: async () => { throw new Error("Stage 1 should not run"); },
    proposalGenerator
  });

  assert.equal(receivedCopy.mainHook, "固定コピー");
  assert.equal(revised.copyBrief.mainHook, "固定コピー");
  assert.equal(revised.lockedContentSnapshot.normalizedHash.length, 64);
});

test("single generationは事前diversity planなしでcopyBriefの実訴求軸へ正規化する", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-banner-legacy-axis-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  const banner = await addBannerCreative(projectRoot, {
    productId: "product-1",
    strategyId: "strategy-1",
    title: "旧横展開案",
    variationAxis: "欲求起点"
  });
  let receivedAxis = "";
  const copyBriefGenerator = async ({ banners }) => copyResults(banners, [brief("欲求・課題起点", "目の前の課題から始める")]);
  const proposalGenerator = async ({ diversityGuidance, copyBrief }) => {
    receivedAxis = diversityGuidance.axisLabel;
    return { imageText: copyBrief.mainHook, copyBrief, promptJson: { zones: [{ elements: [{ type: "text", role: "main hook", content: copyBrief.mainHook }] }], structureSheet: {} }, promptText: "prompt", reviewNotes: "", selectionReason: "" };
  };
  const context = { products: [{ id: "product-1", name: "商品" }], strategies: [{ id: "strategy-1", markdown: "戦略本文" }] };

  const generated = await generateBannerPrompt(projectRoot, banner.id, context, { proposalGenerator, copyBriefGenerator });

  assert.equal(receivedAxis, undefined);
  assert.equal(generated.variationAxis, "欲求・課題起点");
  assert.equal(generated.diversityReview.axis, "欲求・課題起点");
});

test("copyplanは1回呼び出しで仮説と全案コピーを返す", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-banner-hypothesis-first-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  const base = { productId: "product-1", strategyId: "strategy-1", title: "案" };
  const first = await addBannerCreative(projectRoot, { ...base, title: "案1" });
  const second = await addBannerCreative(projectRoot, { ...base, title: "案2" });
  let callCount = 0;
  const result = await generateBannerPromptBatch(projectRoot, [first.id, second.id], contractContext(), {
    copyBriefGenerator: async ({ banners, approvedClaimSnapshot }) => {
      callCount += 1;
      const shared = hypothesis("hyp_shared", approvedClaimSnapshot);
      return {
        hypothesis: shared,
        results: banners.map((banner, index) => ({
          bannerId: banner.id,
          status: "passed",
          copyBrief: {
            ...brief(`angle_${index}`, `広告制作を早める ${index + 1}`),
            version: 4,
            hypothesisId: shared.hypothesisId,
            hypothesisHash: shared.contentHash,
            approvedClaimSnapshotId: approvedClaimSnapshot.snapshotId,
            approvedClaimSnapshotHash: approvedClaimSnapshot.contentHash,
            copyBriefHash: `sha256:copy-${index}`,
            semanticGroupReadout: []
          },
          reviewHistory: [{ attempt: 1, decision: "passed" }],
          categoryRelation: { value: "near", reuseMethod: "mechanism_only" },
          warnings: []
        }))
      };
    },
    proposalGenerator: passingProposalGenerator
  });

  assert.equal(callCount, 1);
  assert.equal(result.errors.length, 0);
  assert.equal(result.banners[0].creativeHypothesis.hypothesisId, result.banners[1].creativeHypothesis.hypothesisId);
  assert.equal(result.banners[0].approvedClaimSnapshot.snapshotId, result.banners[1].approvedClaimSnapshot.snapshotId);
});

test("初回未採番bannerはgroup identity付与後も同じprompt attemptで生成を継続する", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-banner-first-run-cas-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  const first = await addBannerCreative(projectRoot, {
    productId: "product-1",
    strategyId: "strategy-1",
    title: "初回案1"
  });
  const second = await addBannerCreative(projectRoot, {
    productId: "product-1",
    strategyId: "strategy-1",
    title: "初回案2"
  });
  const context = contractContext();
  await fs.writeFile(path.join(projectRoot, "data", "products.json"), JSON.stringify(context.products));
  await fs.writeFile(path.join(projectRoot, "data", "strategies.json"), JSON.stringify(context.strategies));
  await fs.writeFile(path.join(projectRoot, "data", "expression-rules.json"), JSON.stringify(context.expressionRules));
  const attemptIds = {
    [first.id]: "attempt-first",
    [second.id]: "attempt-second"
  };

  for (const banner of [first, second]) {
    const pipeline = await reconcileBannerPipeline(projectRoot, banner.id, context);
    const claim = await claimBannerPromptGeneration(projectRoot, banner.id, {
      ownerId: "test-server",
      attemptId: attemptIds[banner.id],
      startNode: pipeline.nextNode,
      inputHash: pipeline.expectedInputHashes[pipeline.nextNode],
      leaseMs: 60000
    });
    assert.equal(claim.claimed, true);
  }

  const result = await generateBannerPromptBatch(projectRoot, [first.id, second.id], context, {
    attemptIds,
    copyBriefGenerator: async ({ banners, approvedClaimSnapshot }) => ({
      hypothesis: hypothesis("hyp_shared", approvedClaimSnapshot),
      results: banners.map((banner, index) => ({
        bannerId: banner.id,
        status: "passed",
        copyBrief: stageACopyBrief(brief(`angle_${index}`, `広告制作を早める ${index + 1}`), {
          hypothesisId: "hyp_shared",
          hypothesisHash: "sha256:hyp_shared",
          approvedClaimSnapshotId: approvedClaimSnapshot.snapshotId,
          approvedClaimSnapshotHash: approvedClaimSnapshot.contentHash,
          semanticGroupReadout: []
        }),
        reviewHistory: [{ attempt: 1, decision: "passed" }],
        categoryRelation: { value: "near", reuseMethod: "mechanism_only" },
        warnings: []
      }))
    }),
    proposalGenerator: async (input) => {
      const current = (await listBannerCreatives(projectRoot))
        .find((banner) => banner.id === input.banner.id);
      assert.equal(current.pipelineNodes.prompt.status, "running");
      assert.equal(current.pipelineNodes.prompt.attemptId, attemptIds[input.banner.id]);
      assert.ok(current.pipelineNodes.prompt.inputHash);
      return passingProposalGenerator(input);
    }
  });
  const stored = await listBannerCreatives(projectRoot);

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.banners.map((banner) => banner.id).sort(), [first.id, second.id].sort());
  const storedFirst = stored.find((item) => item.id === first.id);
  const storedSecond = stored.find((item) => item.id === second.id);
  assert.ok(storedFirst.generationRunId);
  assert.equal(storedFirst.generationRunId, storedSecond.generationRunId);
  assert.ok(storedFirst.candidateGroupId);
  assert.equal(storedFirst.candidateGroupId, storedSecond.candidateGroupId);
  assert.notEqual(storedFirst.candidateIndex, storedSecond.candidateIndex);
  assert.equal(storedFirst.pipelineNodes.copyplan.status, "completed");
  assert.equal(storedSecond.pipelineNodes.copyplan.status, "completed");
});

test("v6フルバッチはStage Aを1回だけ実行し各案をStage Cへ渡す", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-v6-two-pass-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  const context = contractContext();
  await fs.writeFile(path.join(projectRoot, "data", "products.json"), JSON.stringify(context.products));
  await fs.writeFile(path.join(projectRoot, "data", "strategies.json"), JSON.stringify(context.strategies));
  await fs.writeFile(path.join(projectRoot, "data", "expression-rules.json"), JSON.stringify(context.expressionRules));

  const banners = await Promise.all([0, 1, 2].map((index) => addBannerCreative(projectRoot, {
    productId: "product-1",
    strategyId: "strategy-1",
    title: `v6案${index + 1}`
  })));
  const attemptIds = Object.fromEntries(banners.map((banner, index) => [banner.id, `attempt-${index}`]));
  const promptJobs = [];
  for (const banner of banners) {
    const pipeline = await reconcileBannerPipeline(projectRoot, banner.id, context);
    const claim = await claimBannerPromptGeneration(projectRoot, banner.id, {
      ownerId: "test-server",
      attemptId: attemptIds[banner.id],
      startNode: pipeline.nextNode,
      inputHash: pipeline.expectedInputHashes[pipeline.nextNode],
      leaseMs: 60000
    });
    assert.equal(claim.claimed, true);
    promptJobs.push({ bannerId: banner.id, attemptId: attemptIds[banner.id] });
  }

  let copyplanCalls = 0;
  const jsonGenerator = async () => ({
    hypothesis: {
      audienceAttribute: "広告担当者",
      targetMoment: "制作を急ぐ瞬間",
      barrier: "制作待ち",
      chosenAngle: "制作速度",
      primaryPromise: "広告制作を早める",
      templateMechanism: "明快な見出し",
      visualIntent: { scene: "制作現場", motif: "速度" }
    },
    categoryRelation: { value: "near", reuseMethod: "mechanism_only" },
    candidates: banners.map((banner, index) => ({
      candidateIndex: index,
      angle: `angle-${index}`,
      appealAxis: `訴求軸${index}`,
      whyItStops: `担当者の制作課題を具体的に示す案${index + 1}だから`,
      slotTexts: [
        { slotId: "default-mainHook", text: `広告制作を早める${index + 1}` },
        { slotId: "default-subHook", text: "判断を止めず次の検証へ" }
      ],
      semanticGroupReadout: [],
      selfCheck: { blindReadability: "pass", system1Impact: "pass", coherence: "pass", strategyFit: "pass", issues: [] }
    }))
  });
  const copyBriefGenerator = async (input) => {
    copyplanCalls += 1;
    return generateBannerCopyPlan({ ...input, jsonGenerator });
  };

  const prepared = await ensureBannerCopyBriefsForPromptJobs(projectRoot, promptJobs, context, {
    forceCopyBrief: true,
    copyBriefGenerator
  });
  assert.deepEqual(prepared.errors, []);
  assert.equal(copyplanCalls, 1);

  for (const banner of banners) {
    const result = await generateBannerPromptBatch(projectRoot, [banner.id], context, {
      attemptIds: { [banner.id]: attemptIds[banner.id] },
      copyBriefGenerator: async () => {
        throw new Error("Stage Aを再実行してはいけません");
      },
      proposalGenerator: passingProposalGenerator
    });
    assert.deepEqual(result.errors, []);
    assert.equal(result.banners.length, 1);
  }

  const stored = await listBannerCreatives(projectRoot);
  for (const banner of banners) {
    const current = stored.find((item) => item.id === banner.id);
    assert.equal(current.pipelineNodes.copyplan.status, "completed");
    assert.equal(current.pipelineNodes.prompt.status, "completed");
    assert.ok(current.copyBrief.whyItStops);
  }
});

test("copyplan groupが完了した案は他groupを待たずonItemsReadyへ渡す", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-copy-group-stream-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  const context = contractContext();
  context.strategies.push({ id: "strategy-slow", targetAttributes: "広告担当者", benefit: "慎重に制作する" });
  await fs.writeFile(path.join(projectRoot, "data", "products.json"), JSON.stringify(context.products));
  await fs.writeFile(path.join(projectRoot, "data", "strategies.json"), JSON.stringify(context.strategies));
  await fs.writeFile(path.join(projectRoot, "data", "expression-rules.json"), JSON.stringify(context.expressionRules));
  const fast = await addBannerCreative(projectRoot, { productId: "product-1", strategyId: "strategy-1", title: "fast" });
  const slow = await addBannerCreative(projectRoot, { productId: "product-1", strategyId: "strategy-slow", title: "slow" });
  let releaseSlow;
  const slowGate = new Promise((resolve) => { releaseSlow = resolve; });
  const emitted = [];
  const preparation = ensureBannerCopyBriefsForPromptJobs(projectRoot, [
    { bannerId: fast.id },
    { bannerId: slow.id }
  ], context, {
    forceCopyBrief: true,
    copyBriefGenerator: async ({ banners, strategy, approvedClaimSnapshot }) => {
      if (strategy.id === "strategy-slow") await slowGate;
      return copyResults(banners, [brief(strategy.id, `${strategy.id}のコピー`)], hypothesis(`hyp_${strategy.id}`, approvedClaimSnapshot));
    },
    onItemsReady: async (items) => {
      emitted.push(items.map((item) => item.banner.id));
    }
  });

  try {
    const deadline = Date.now() + 500;
    while (!emitted.length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(emitted, [[fast.id]]);
  } finally {
    releaseSlow();
  }
  const result = await preparation;
  assert.deepEqual(result.errors, []);
  assert.deepEqual(emitted, [[fast.id], [slow.id]]);
});

test("copyplan失敗は全案failedでStage 2へ進まない", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-banner-hypothesis-partial-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  const first = await addBannerCreative(projectRoot, { productId: "product-1", strategyId: "strategy-1", title: "失敗" });
  const second = await addBannerCreative(projectRoot, { productId: "product-1", strategyId: "strategy-1", title: "成功" });
  const result = await generateBannerPromptBatch(projectRoot, [first.id, second.id], contractContext(), {
    copyBriefGenerator: async () => {
      throw new Error("コピー設計の生成に失敗しました");
    },
    proposalGenerator: passingProposalGenerator
  });

  assert.equal(result.errors.length, 2);
  assert.equal(result.banners.length, 0);
  const stored = await listBannerCreatives(projectRoot);
  for (const banner of stored) {
    assert.equal(banner.pipelineNodes.copyplan.status, "failed");
    assert.equal(banner.pipelineNodes.copyplan.errorCode, "COPYPLAN_FAILED");
    assert.equal(banner.pipelineNodes.prompt.status, "pending");
  }
});

test("copyplan warningはStage 2へ進む", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-banner-hypothesis-warning-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  const banner = await addBannerCreative(projectRoot, {
    productId: "product-1",
    strategyId: "strategy-1",
    title: "warningでも続行"
  });
  const result = await generateBannerPromptBatch(projectRoot, [banner.id], contractContext(), {
    copyBriefGenerator: async ({ banners, approvedClaimSnapshot }) => ({
      hypothesis: hypothesis("hyp_warn", approvedClaimSnapshot),
      results: [{
        bannerId: banners[0].id,
        status: "warning",
        copyBrief: withCopyBriefHash(brief("弱い差分", "広告制作を早める")),
        reviewHistory: [{ attempt: 1, decision: "warning" }],
        categoryRelation: { value: "near", reuseMethod: "mechanism_only" },
        warnings: [{ type: "copy_selfcheck_unresolved", stage: "copyplan", message: "差分は弱い", occurredAt: "2026-07-17T00:00:00.000Z" }]
      }]
    }),
    proposalGenerator: passingProposalGenerator
  });
  const stored = (await listBannerCreatives(projectRoot)).find((item) => item.id === banner.id);

  assert.equal(result.errors.length, 0);
  assert.equal(stored.pipelineNodes.copyplan.status, "completed");
  assert.equal(stored.warnings[0].type, "copy_selfcheck_unresolved");
  assert.equal(stored.lastError, "");
});

test("forceCopyBriefで未完了案だけcopyplanから再実行できる", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-banner-hypothesis-seed-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  const base = { productId: "product-1", strategyId: "strategy-1" };
  const first = await addBannerCreative(projectRoot, { ...base, title: "案1" });
  const second = await addBannerCreative(projectRoot, { ...base, title: "案2" });
  const context = contractContext();

  const initial = await generateBannerPromptBatch(projectRoot, [first.id, second.id], context, {
    copyBriefGenerator: async ({ banners, approvedClaimSnapshot }) => ({
      hypothesis: hypothesis("hyp_initial", approvedClaimSnapshot),
      results: banners.map((banner, index) => ({
        bannerId: banner.id,
        status: "passed",
        copyBrief: {
          ...brief(`angle_${index}`, `初期コピー ${index + 1}`),
          version: 4,
          copyBriefHash: `sha256:initial-${index}`,
          semanticGroupReadout: []
        },
        reviewHistory: [{ attempt: 1, decision: "passed" }],
        categoryRelation: { value: "near", reuseMethod: "mechanism_only" },
        warnings: []
      }))
    }),
    proposalGenerator: passingProposalGenerator
  });
  assert.equal(initial.errors.length, 0);
  await updateBannerCreative(projectRoot, first.id, {
    generatedImagePath: "outputs/baseline.png",
    generatedImageHash: "sha256:baseline-image",
    imageGenerationStatus: "completed",
    productionStatus: "completed"
  });
  const afterInitial = await listBannerCreatives(projectRoot);
  const baselineBefore = afterInitial.find((item) => item.id === first.id);
  for (const target of afterInitial.filter((item) => item.id === second.id)) {
    await updateBannerCreative(projectRoot, target.id, {
      copyBrief: null,
      imageText: "",
      promptJson: null,
      promptText: "",
      productionStatus: "failed",
      lastError: "再生成が必要",
      pipelineNodes: invalidateCopyplanNode(target.pipelineNodes)
    });
  }

  let copyCalls = 0;
  const retried = await generateBannerPromptBatch(projectRoot, [second.id], context, {
    forceCopyBrief: true,
    copyBriefGenerator: async ({ banners, approvedClaimSnapshot }) => {
      copyCalls += 1;
      return {
        hypothesis: hypothesis("hyp_retry", approvedClaimSnapshot),
        results: banners.map((banner) => ({
          bannerId: banner.id,
          status: "passed",
          copyBrief: { ...brief("再生成", "再生成コピー"), version: 4, copyBriefHash: "sha256:retry", semanticGroupReadout: [] },
          reviewHistory: [{ attempt: 1, decision: "passed" }],
          categoryRelation: { value: "near", reuseMethod: "mechanism_only" },
          warnings: []
        }))
      };
    },
    proposalGenerator: passingProposalGenerator
  });
  const afterRetry = await listBannerCreatives(projectRoot);
  const baselineAfter = afterRetry.find((item) => item.id === first.id);

  assert.equal(retried.errors.length, 0);
  assert.equal(copyCalls, 1);
  assert.deepEqual(baselineAfter.creativeHypothesis, baselineBefore.creativeHypothesis);
  assert.equal(baselineAfter.generatedImagePath, baselineBefore.generatedImagePath);
});

test("group IDが混在する場合は全案を上書きせず停止する", async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-banner-group-conflict-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
  const first = await addBannerCreative(projectRoot, { productId: "product-1", strategyId: "strategy-1", title: "案1" });
  const second = await addBannerCreative(projectRoot, { productId: "product-1", strategyId: "strategy-1", title: "案2" });
  await updateBannerCreative(projectRoot, first.id, { generationRunId: "run_a", candidateGroupId: "group_a" });
  await updateBannerCreative(projectRoot, second.id, { generationRunId: "run_b", candidateGroupId: "group_b" });
  let called = false;
  const result = await generateBannerPromptBatch(projectRoot, [first.id, second.id], contractContext(), {
    copyBriefGenerator: async () => { called = true; throw new Error("copy should not run"); },
    proposalGenerator: passingProposalGenerator
  });
  const stored = await listBannerCreatives(projectRoot);

  assert.equal(called, false);
  assert.equal(result.errors.every((error) => error.code === "CANDIDATE_GROUP_ID_CONFLICT"), true);
  assert.equal(stored.find((banner) => banner.id === first.id).candidateGroupId, "group_a");
  assert.equal(stored.find((banner) => banner.id === second.id).candidateGroupId, "group_b");
});

function brief(appealAxis, mainHook) {
  const subHook = "根拠から選べる運用へ";
  return {
    version: 3,
    strategyId: "strategy-1",
    generatedAt: "2026-07-15T00:00:00.000Z",
    model: "test",
    appealAxis,
    targetMoment: "広告制作で迷った瞬間",
    whyItStops: `${mainHook}が一読で課題を想起させるため`,
    mainHook,
    subHook,
    slotTexts: [
      { slotId: "default-mainHook", text: mainHook },
      { slotId: "default-subHook", text: subHook }
    ],
    proof: "",
    offerBadge: "",
    cta: "詳しく見る",
    disclaimer: "",
    authorizedClaimSet: {
      audienceAttribute: "広告成果に責任を持つ担当者",
      purchaseMomentGoal: "次の広告検証へ進める",
      chosenAngle: "benefit",
      coreMessage: mainHook,
      whyThisAngle: "検証に直結するため",
      additionalInstructionIntent: { priority: "highest", fixedCopy: [], requiredAngles: [], allowSiblingSimilarity: false },
      templateMessagePlan: [{ groupId: "primary", semanticRole: "primary_promise", groupMessage: mainHook, slotIds: ["hook"] }],
      claims: [], identityAnchors: [], mandatorySharedAnchors: [], forbiddenClaims: []
    },
    whyItStops: "課題が短く具体的に伝わる",
    rejectedAlternatives: []
  };
}

function withCopyBriefHash(copyBrief) {
  return { ...copyBrief, copyBriefHash: hashCopyBrief(copyBrief) };
}

function stageACopyBrief(base, extras = {}) {
  const payload = { ...base, ...extras, version: 4 };
  return { ...payload, copyBriefHash: hashCopyBrief(payload) };
}

function copyResults(banners, briefs, hypothesisValue = null) {
  return {
    ...(hypothesisValue ? { hypothesis: hypothesisValue } : {}),
    results: banners.map((banner, index) => {
      const copyBrief = { ...briefs[index], copyBriefHash: hashCopyBrief(briefs[index]) };
      return {
        bannerId: banner.id,
        status: "passed",
        copyBrief,
        reviewHistory: [],
        categoryRelation: { value: "near", reuseMethod: "mechanism_only" },
        bannerGenerationContract: { version: 2 },
        generationRunId: "run-test",
        candidateGroupId: "group-test",
        candidateIndex: index,
        warnings: []
      };
    })
  };
}

function contractContext() {
  return {
    products: [{ id: "product-1", name: "CMO AI Pro" }],
    strategies: [{ id: "strategy-1", targetAttributes: "広告担当者", benefit: "広告制作を早める" }],
    adTemplates: [],
    expressionRules: []
  };
}

function hypothesis(hypothesisId, snapshot) {
  return {
    version: 1,
    hypothesisId,
    contentHash: `sha256:${hypothesisId}`,
    strategyId: "strategy-1",
    approvedClaimSnapshotId: snapshot.snapshotId,
    approvedClaimSnapshotHash: snapshot.contentHash,
    audienceAttribute: "広告担当者",
    targetMoment: "広告制作を急ぐ瞬間",
    barrier: "制作が遅い",
    chosenAngle: hypothesisId,
    primaryPromise: "広告制作を早める",
    supportingClaimIds: [snapshot.claims.find((claim) => claim.claimKind === "benefit").claimId],
    proofClaimIds: [],
    offerClaimIds: [],
    templateMechanism: "大見出し",
    visualIntent: { scene: "広告制作", motif: "速度" },
    semanticGroupPlan: [],
    templateFitDecision: { status: "fit", reason: "表示可能", roleAdjustments: [] },
    variationPolicy: { changedDimensions: ["angle"], preservedDimensions: ["audience"] },
    additionalInstructionIntent: { fixedCopy: [], requiredAngles: [], forbiddenClaims: [], allowSiblingSimilarity: false, similarityOverrideDimensions: [], changeScope: "none" },
    origin: "generated"
  };
}

function validHypothesisForGenerator(input, banner, localIndex) {
  const candidateIndex = Number.isInteger(input.candidateIndexes?.[localIndex])
    ? input.candidateIndexes[localIndex]
    : (Number.isInteger(banner.candidateIndex) ? banner.candidateIndex : localIndex);
  const supportingClaim = input.approvedClaimSnapshot.claims.find((claim) => claim.claimKind === "benefit")
    || input.approvedClaimSnapshot.claims[0];
  return normalizeCreativeHypothesis({
    audienceAttribute: "広告担当者",
    targetMoment: "広告制作を急ぐ瞬間",
    barrier: "制作が遅い",
    chosenAngle: `angle_${candidateIndex}`,
    primaryPromise: "広告制作を早める",
    supportingClaimIds: [supportingClaim.claimId],
    proofClaimIds: [],
    offerClaimIds: [],
    templateMechanism: "大見出し",
    visualIntent: { scene: `広告制作の場面${candidateIndex}`, motif: `速度${candidateIndex}` },
    semanticGroupPlan: (input.copySlotPlan.semanticGroups || []).map((group) => ({
      groupId: group.groupId,
      semanticRole: group.semanticRole,
      intendedMessage: `広告制作を早める${candidateIndex}`,
      slotIds: group.slotIds,
      readingOrder: group.readingOrder,
      joinMode: group.joinMode
    })),
    templateFitDecision: { status: "fit", reason: "表示可能", roleAdjustments: [] },
    variationPolicy: { changedDimensions: ["angle"], preservedDimensions: ["audience"] }
  }, {
    strategyId: input.strategy.id,
    approvedClaimSnapshot: input.approvedClaimSnapshot,
    generationRunId: input.generationRunId,
    candidateGroupId: input.candidateGroupId,
    candidateIndex,
    copySlotPlan: input.copySlotPlan,
    instructionPolicy: input.instructionPolicy
  });
}

function contractCopyResults(banners, hypotheses, snapshot) {
  return {
    results: banners.map((banner, index) => ({
      bannerId: banner.id,
      status: "passed",
      copyBrief: {
        ...brief(hypotheses[index].chosenAngle, `広告制作を早める ${index + 1}`),
        version: 4,
        hypothesisId: hypotheses[index].hypothesisId,
        hypothesisHash: hypotheses[index].contentHash,
        approvedClaimSnapshotId: snapshot.snapshotId,
        approvedClaimSnapshotHash: snapshot.contentHash,
        copyBriefHash: `sha256:copy-${index}`,
        semanticGroupReadout: []
      },
      reviewHistory: [],
      categoryRelation: { value: "near", reuseMethod: "mechanism_only" },
      bannerGenerationContract: { version: 2 },
      generationRunId: banner.generationRunId,
      candidateGroupId: banner.candidateGroupId,
      candidateIndex: banner.candidateIndex
    }))
  };
}

async function passingProposalGenerator({ copyBrief, banner }) {
  return {
    imageText: copyBrief.mainHook,
    copyBrief,
    creativeHypothesis: banner.creativeHypothesis,
    promptJson: { zones: [{ elements: [{ type: "text", role: "main hook", content: copyBrief.mainHook }] }], structureSheet: {} },
    promptText: copyBrief.mainHook,
    reviewNotes: "",
    selectionReason: ""
  };
}

function invalidateCopyplanNode(nodes = {}) {
  return {
    ...nodes,
    copyplan: { status: "pending", inputHash: "", outputHash: "", attemptId: "", errorCode: "", errorMessage: "", retryCount: 0, retryExhausted: false },
    prompt: { status: "pending", inputHash: "", outputHash: "", attemptId: "", errorCode: "", errorMessage: "", retryCount: 0, retryExhausted: false },
    image: { status: "pending", inputHash: "", outputHash: "", attemptId: "", errorCode: "", errorMessage: "", retryCount: 0, retryExhausted: false }
  };
}
