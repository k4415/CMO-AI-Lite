import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPipelineInputHashes,
  buildPipelineOutputHashes,
  invalidatePipelineFrom,
  markPipelineNode,
  nextPipelineNode,
  normalizePipelineState,
  reconcilePipelineState,
  restartNodeForPipelineError
} from "../src/core/banner-pipeline-state.js";
import { hashCopyBrief } from "../src/core/banner-copy-hash.js";

const NODES = ["copyplan", "prompt", "image"];

function validCopyBrief(overrides = {}) {
  const base = {
    version: 4,
    strategyId: "str_1",
    hypothesisId: "hyp_1",
    hypothesisHash: "sha256:hypothesis",
    approvedClaimSnapshotId: "acs_1",
    approvedClaimSnapshotHash: "sha256:snapshot",
    appealAxis: "制作速度",
    targetMoment: "広告制作を急ぐ瞬間",
    whyItStops: "制作を急ぐ担当者の課題を具体的に示すため",
    mainHook: "広告制作を早める",
    subHook: "判断を止めず次の検証へ",
    slotTexts: [{ slotId: "hook", text: "広告制作を早める" }],
    semanticGroupReadout: []
  };
  const value = { ...base, ...overrides };
  return { ...value, copyBriefHash: hashCopyBrief(value) };
}

function pipelineContext(overrides = {}) {
  const copyBrief = validCopyBrief(overrides.banner?.copyBrief || {});
  const base = {
    banner: {
      id: "ban_1",
      productId: "prod_1",
      strategyId: "str_1",
      templateAdId: "tpl_1",
      imageSize: "1080x1080",
      additionalInstruction: "",
      revisionInstruction: "",
      generationRunId: "run_1",
      candidateGroupId: "group_1",
      candidateIndex: 0,
      copyBrief,
      promptJson: { contractRefs: { copyBriefHash: copyBrief.copyBriefHash }, zones: [] },
      promptText: "prompt",
      generatedImagePath: "outputs/banner.png",
      generatedImageHash: "sha256:image",
      generatedImageModel: "gpt-image-2"
    },
    product: { id: "prod_1", name: "CMO AI Pro" },
    strategy: { id: "str_1", benefit: "制作を早める" },
    template: {
      id: "tpl_1",
      copyBlueprint: { persuasionMechanism: { primaryHookMechanism: "large-number" } },
      layoutBlueprint: { visualHierarchy: ["hook", "visual", "cta"], eyeFlow: "top-to-bottom" }
    },
    copySlotPlan: {
      templateId: "tpl_1",
      slots: [{ slotId: "hook", canonicalField: "mainHook", charBudget: 16, required: true }],
      semanticGroups: [{ groupId: "promise", slotIds: ["hook"], readingOrder: 0, joinMode: "single" }]
    },
    approvedClaimSnapshot: { snapshotId: "acs_1", contentHash: "sha256:snapshot" },
    creativeHypothesis: {
      hypothesisId: "hyp_1",
      contentHash: "sha256:hypothesis",
      version: 1,
      strategyId: "str_1",
      approvedClaimSnapshotId: "acs_1",
      approvedClaimSnapshotHash: "sha256:snapshot",
      audienceAttribute: "a",
      targetMoment: "b",
      barrier: "c",
      chosenAngle: "d",
      primaryPromise: "e",
      supportingClaimIds: [],
      proofClaimIds: [],
      offerClaimIds: [],
      templateMechanism: "",
      visualIntent: { scene: "", motif: "" },
      semanticGroupPlan: [],
      templateFitDecision: { status: "adapt", reason: "", roleAdjustments: [] },
      variationPolicy: { changedDimensions: ["angle"], preservedDimensions: ["promise"] },
      additionalInstructionIntent: {},
      origin: "copyplan_v6"
    },
    categoryRelation: { value: "near", reuseMethod: "mechanism_only" },
    expressionRules: [{ id: "rule_1", ruleType: "ng", pattern: "保証" }],
    referenceAssets: [{ role: "product", path: "assets/product.png", contentHash: "sha256:asset" }]
  };
  const merged = { ...base, ...overrides };
  merged.banner = { ...base.banner, ...(overrides.banner || {}) };
  return merged;
}

function completedState(expected, outputs) {
  let state = {};
  for (const node of NODES) {
    state = markPipelineNode(state, node, {
      status: "completed",
      inputHash: expected[node],
      outputHash: outputs[node]
    });
  }
  return state;
}

test("copyplan完了とdurationMs記録", () => {
  let state = normalizePipelineState({});
  state = markPipelineNode(state, "copyplan", { status: "running", startedAt: "2026-07-17T00:00:00.000Z" });
  state = markPipelineNode(state, "copyplan", { status: "completed", completedAt: "2026-07-17T00:01:30.000Z", durationMs: 90000 });
  assert.equal(state.copyplan.status, "completed");
  assert.equal(state.copyplan.durationMs, 90000);
});

test("旧6ノード形式のデータはcopyplanがpendingとして扱われる", () => {
  const legacy = { hypothesis: { status: "completed" }, copy: { status: "completed" }, image: { status: "completed" } };
  const state = normalizePipelineState(legacy);
  assert.equal(state.copyplan.status, "pending");
  assert.equal(state.image.status, "completed");
});

test("画像だけ失敗した場合はimageから再開する", () => {
  let state = {};
  const expected = Object.fromEntries(NODES.map((node) => [node, "input:" + node]));
  const outputs = Object.fromEntries(NODES.slice(0, -1).map((node) => [node, "output:" + node]));
  for (const node of NODES.slice(0, -1)) {
    state = markPipelineNode(state, node, { status: "completed", inputHash: expected[node], outputHash: outputs[node] });
  }
  state = markPipelineNode(state, "image", { status: "failed", inputHash: expected.image, errorCode: "IMAGE_GENERATION_FAILED" });
  assert.equal(nextPipelineNode({ pipelineNodes: state }, expected, outputs), "image");
});

test("保存statusとinputが一致しても現在のcopy成果物hashが違えばcopyplanから再開する", () => {
  const expected = Object.fromEntries(NODES.map((node) => [node, "input:" + node]));
  const outputs = Object.fromEntries(NODES.map((node) => [node, "output:" + node]));
  const state = completedState(expected, outputs);
  outputs.copyplan = "output:current-copy";

  assert.equal(nextPipelineNode({ pipelineNodes: state }, expected, outputs), "copyplan");
  const reconciled = reconcilePipelineState(state, expected, outputs);
  assert.equal(reconciled.copyplan.status, "pending");
  assert.equal(reconciled.image.status, "pending");
});

test("同じstrategyIdの本文変更もhashでcopyplanから無効化する", () => {
  const before = buildPipelineInputHashes(pipelineContext({ strategy: { id: "str_1", benefit: "制作を早める" } }));
  const after = buildPipelineInputHashes(pipelineContext({ strategy: { id: "str_1", benefit: "制作を5分の1にする" } }));
  assert.notEqual(before.copyplan, after.copyplan);
});

test("visual-only追加指示はpromptより前のhashを変えない", () => {
  const before = buildPipelineInputHashes(pipelineContext({ banner: { additionalInstruction: "背景だけ青にする" } }));
  const after = buildPipelineInputHashes(pipelineContext({ banner: { additionalInstruction: "背景だけ赤にする" } }));
  assert.equal(before.copyplan, after.copyplan);
  assert.notEqual(before.prompt, after.prompt);
});

test("画像サイズ変更はpromptから無効化する", () => {
  const before = buildPipelineInputHashes(pipelineContext({ banner: { imageSize: "1080x1080" } }));
  const after = buildPipelineInputHashes(pipelineContext({ banner: { imageSize: "1200x628" } }));
  assert.deepEqual(NODES.filter((node) => before[node] !== after[node]), ["prompt", "image"]);
});

test("template semanticGroups変更はcopyplanから無効化する", () => {
  const before = buildPipelineInputHashes(pipelineContext());
  const after = buildPipelineInputHashes(pipelineContext({
    copySlotPlan: {
      templateId: "tpl_1",
      slots: [{ slotId: "hook", canonicalField: "mainHook", charBudget: 16, required: true }],
      semanticGroups: [{ groupId: "promise", slotIds: ["hook"], readingOrder: 0, joinMode: "continuous_sentence" }]
    }
  }));
  assert.notEqual(before.copyplan, after.copyplan);
});

test("expressionRules変更はcopyplanとpromptから無効化する", () => {
  const before = buildPipelineInputHashes(pipelineContext());
  const after = buildPipelineInputHashes(pipelineContext({ expressionRules: [{ id: "rule_1", ruleType: "ng", pattern: "絶対" }] }));
  assert.notEqual(before.copyplan, after.copyplan);
  assert.notEqual(before.prompt, after.prompt);
});

test("whyItStopsのない保存済みv6 copyBriefはcopyplan成果物として無効", () => {
  const incomplete = validCopyBrief({ whyItStops: "" });
  const context = pipelineContext({ banner: { copyBrief: incomplete } });
  const outputs = buildPipelineOutputHashes(context);
  assert.equal(outputs.copyplan, "");
});

test("copyBrief契約不正とidentity stamp不整合はcopyplanへ戻す", () => {
  assert.equal(restartNodeForPipelineError({ code: "COPYBRIEF_CONTRACT_INVALID" }), "copyplan");
  assert.equal(restartNodeForPipelineError({ code: "HYPOTHESIS_IDENTITY_STAMP_NODE_MISMATCH" }), "copyplan");
});

test("保存copyBriefHashが本文と違う場合はcopyplan成果物hashを空にする", () => {
  const stale = {
    ...validCopyBrief({ mainHook: "本文変更後" }),
    copyBriefHash: "sha256:stale"
  };
  const outputs = buildPipelineOutputHashes(pipelineContext({
    banner: { copyBrief: stale }
  }));
  assert.equal(outputs.copyplan, "");
});

test("invalidatePipelineFromは指定ノードより前の成果物を保持する", () => {
  const expected = Object.fromEntries(NODES.map((node) => [node, "input:" + node]));
  const outputs = Object.fromEntries(NODES.map((node) => [node, "output:" + node]));
  const invalidated = invalidatePipelineFrom(completedState(expected, outputs), "prompt");
  assert.equal(invalidated.copyplan.status, "completed");
  assert.equal(invalidated.prompt.status, "pending");
  assert.equal(invalidated.image.status, "pending");
});

test("画像生成失敗はimageから再開する", () => {
  assert.equal(restartNodeForPipelineError({ code: "IMAGE_GENERATION_FAILED" }), "image");
  assert.equal(restartNodeForPipelineError({ code: "PROMPT_CONTRACT_REFS_INVALID" }), "prompt");
  assert.equal(restartNodeForPipelineError({ code: "UNKNOWN" }), "prompt");
});
