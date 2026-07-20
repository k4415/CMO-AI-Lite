import test from "node:test";
import assert from "node:assert/strict";
import { generateBannerCopyPlan } from "../src/core/banner-copyplan-ai.js";

const baseInput = () => ({
  banners: [{ id: "b1", templateAdId: "tpl_1" }, { id: "b2", templateAdId: "tpl_1" }],
  product: { id: "p1", name: "テスト商品" },
  strategy: { id: "st1", desire: "時短したい", benefit: "毎朝10分短縮", competitors: ["競合A"], offer: "初回無料" },
  template: { id: "tpl_1", copyBlueprint: { slots: [{ slotId: "s1", role: "headline", charBudget: 12 }] } },
  expressionRules: [],
  extraInstruction: "",
  approvedClaimSnapshot: { contentHash: "sha256:x" },
  generationRunId: "run1", candidateGroupId: "grp1", candidateIndexes: [0, 1]
});

const okResponse = {
  hypothesis: { audienceAttribute: "共働き", chosenAngle: "時短", primaryPromise: "毎朝10分短縮", targetMoment: "", barrier: "", templateMechanism: "", visualIntent: { scene: "", motif: "" } },
  categoryRelation: { value: "near", reuseMethod: "mechanism_only" },
  candidates: [
    { candidateIndex: 0, variationRole: "baseline", baselineReference: 0, variationDirection: "", angle: "時短", slotTexts: [{ slotId: "s1", text: "毎朝10分短縮" }], semanticGroupReadout: [], appealAxis: "時短", whyItStops: "毎朝10分という具体的な変化が一読で伝わるため", selfCheck: { blindReadability: "pass", system1Impact: "pass", coherence: "pass", strategyFit: "pass", issues: [] } },
    { candidateIndex: 1, variationRole: "variant", baselineReference: 0, variationDirection: "オファー訴求を前に出す", angle: "時短", slotTexts: [{ slotId: "s1", text: "初回無料で試せる" }], semanticGroupReadout: [], appealAxis: "オファー", whyItStops: "初回無料という行動障壁の低さが即座に伝わるため", selfCheck: { blindReadability: "pass", system1Impact: "warn", coherence: "pass", strategyFit: "pass", issues: ["数字が弱い"] } }
  ]
};

test("1コールでN案生成し、baseline / variation metadataを保持したままselfCheck warnはstatus=warningで通す", async () => {
  const calls = [];
  const result = await generateBannerCopyPlan({ ...baseInput(), jsonGenerator: async (args) => { calls.push(args); return okResponse; } });
  assert.equal(calls.length, 1);
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].status, "passed");
  assert.equal(result.results[1].status, "warning");
  assert.equal(result.results[1].warnings[0].type, "copy_selfcheck_unresolved");
  assert.equal(result.results[0].copyBrief.model, "claude-opus-4-8");
  assert.equal(result.results[0].copyBrief.variationRole, "baseline");
  assert.equal(result.results[1].copyBrief.variationRole, "variant");
  assert.equal(result.results[1].copyBrief.baselineReference, 0);
  assert.ok(result.results[0].copyBrief.copyBriefHash.startsWith("sha256:"));
  assert.equal(calls[0].reasoningEffort, "low");
  assert.ok(calls[0].maxTokens < 12000);
});

test("根拠にない希少性を任意slotへ生成しても完成コピーから除去する", async () => {
  const input = baseInput();
  input.template = {
    id: "tpl_1",
    copyBlueprint: {
      slots: [
        { slotId: "s1", role: "headline", messageRole: "hook", charBudget: 12, required: true, sourcePolicy: "strategy_required" },
        { slotId: "s2", role: "disclaimer", messageRole: "disclaimer", charBudget: 30, required: false, sourcePolicy: "instruction_or_strategy", emptyPolicy: "allow" }
      ]
    }
  };
  input.strategy = { ...input.strategy, offer: "" };
  input.approvedClaimSnapshot = {
    contentHash: "sha256:x",
    claims: [{
      claimId: "clm-benefit",
      sourceType: "strategy",
      sourcePath: "benefit.0",
      text: "毎朝10分短縮",
      claimKind: "benefit"
    }]
  };
  const response = {
    ...okResponse,
    candidates: okResponse.candidates.map((candidate, index) => ({
      ...candidate,
      slotTexts: [
        ...candidate.slotTexts,
        { slotId: "s2", text: index === 0 ? "検証版は公開枠に限りあり" : "先着枠のみ。お早めに" }
      ]
    }))
  };

  const result = await generateBannerCopyPlan({ ...input, jsonGenerator: async () => response });

  for (const item of result.results) {
    assert.equal(item.copyBrief.slotTexts.find((slot) => slot.slotId === "s2")?.text, "");
    assert.equal(item.copyBrief.disclaimer, "");
  }
});

test("offerまたは追加指示の根拠がない任意CTA・注釈は空欄にする", async () => {
  const input = baseInput();
  input.banners = [{ id: "b1", templateAdId: "tpl_1" }];
  input.candidateIndexes = [0];
  input.strategy = { ...input.strategy, offer: "" };
  input.template = {
    id: "tpl_1",
    copyBlueprint: { slots: [
      { slotId: "s1", role: "headline", messageRole: "hook", charBudget: 12, required: true, sourcePolicy: "strategy_required" },
      { slotId: "s2", role: "disclaimer", messageRole: "disclaimer", canonicalField: "disclaimer", charBudget: 30, required: false, sourcePolicy: "instruction_or_strategy", emptyPolicy: "allow" }
    ] }
  };
  input.approvedClaimSnapshot = {
    contentHash: "sha256:x",
    claims: [{ claimId: "clm-benefit", text: "毎朝10分短縮", claimKind: "benefit" }]
  };
  const response = {
    ...okResponse,
    candidates: [{
      ...okResponse.candidates[0],
      slotTexts: [{ slotId: "s1", text: "毎朝10分短縮" }, { slotId: "s2", text: "まず一案件で試せます" }]
    }]
  };

  const result = await generateBannerCopyPlan({ ...input, jsonGenerator: async () => response });

  assert.equal(result.results[0].copyBrief.slotTexts.find((slot) => slot.slotId === "s2")?.text, "");
});

test("許可claimにない数値・保証表現は単案リトライで修正する", async () => {
  const input = baseInput();
  input.banners = [{ id: "b1", templateAdId: "tpl_1" }];
  input.candidateIndexes = [0];
  input.approvedClaimSnapshot = {
    contentHash: "sha256:x",
    claims: [{ claimId: "clm-benefit", text: "判断のズレを減らす", claimKind: "benefit", objectiveTokens: [] }]
  };
  const unauthorized = {
    ...okResponse,
    candidates: [{ ...okResponse.candidates[0], slotTexts: [{ slotId: "s1", text: "ズレ0!" }] }]
  };
  const fixed = {
    ...okResponse,
    candidates: [{ ...okResponse.candidates[0], slotTexts: [{ slotId: "s1", text: "判断がそろう" }] }]
  };
  let call = 0;

  const result = await generateBannerCopyPlan({ ...input, jsonGenerator: async () => (call++ === 0 ? unauthorized : fixed) });

  assert.equal(call, 2);
  assert.equal(result.results[0].copyBrief.slotTexts[0].text, "判断がそろう");
  assert.equal(result.results[0].status, "passed");
});

test("任意slotが必須slotと同じ文言なら任意側だけを空にする", async () => {
  const input = baseInput();
  input.banners = [{ id: "b1", templateAdId: "tpl_1" }];
  input.candidateIndexes = [0];
  input.template = {
    id: "tpl_1",
    copyBlueprint: {
      slots: [
        { slotId: "s1", role: "headline", messageRole: "benefit", charBudget: 12, required: true, sourcePolicy: "strategy_required" },
        { slotId: "s2", role: "subheadline", messageRole: "offer", charBudget: 12, required: false, sourcePolicy: "instruction_or_strategy", emptyPolicy: "allow" }
      ]
    }
  };
  const response = {
    ...okResponse,
    candidates: [{
      ...okResponse.candidates[0],
      slotTexts: [
        { slotId: "s1", text: "比較が楽" },
        { slotId: "s2", text: "比較が楽" }
      ]
    }]
  };

  const result = await generateBannerCopyPlan({ ...input, jsonGenerator: async () => response });

  assert.equal(result.results[0].copyBrief.slotTexts.find((slot) => slot.slotId === "s1")?.text, "比較が楽");
  assert.equal(result.results[0].copyBrief.slotTexts.find((slot) => slot.slotId === "s2")?.text, "");
});

test("ゲートNGの案だけ単案リトライし、成功すればpassed", async () => {
  const over = { ...okResponse, candidates: [
    { ...okResponse.candidates[0], slotTexts: [{ slotId: "s1", text: "あ".repeat(20) }] },
    okResponse.candidates[1]
  ] };
  const fixed = { ...okResponse, candidates: [okResponse.candidates[0]] };
  let call = 0;
  const result = await generateBannerCopyPlan({ ...baseInput(), jsonGenerator: async () => (call++ === 0 ? over : fixed) });
  assert.equal(call, 2);
  assert.equal(result.results[0].status, "passed");
});

test("単案リトライ後もNGならwarningで通しviolationをwarningsに積む", async () => {
  const over = { ...okResponse, candidates: [
    { ...okResponse.candidates[0], slotTexts: [{ slotId: "s1", text: "あ".repeat(20) }] },
    okResponse.candidates[1]
  ] };
  const stillOver = { ...okResponse, candidates: [over.candidates[0]] };
  let call = 0;
  const result = await generateBannerCopyPlan({ ...baseInput(), jsonGenerator: async () => (call++ === 0 ? over : stillOver) });
  assert.equal(result.results[0].status, "warning");
  assert.equal(result.results[0].warnings[0].type, "copy_length_over");
});

test("AI応答不正はバッチ1回リトライ、2回目も不正なら例外", async () => {
  let call = 0;
  await assert.rejects(
    () => generateBannerCopyPlan({ ...baseInput(), jsonGenerator: async () => { call++; return { candidates: [] }; } }),
    /コピー設計/
  );
  assert.equal(call, 2);
});

test("baseline variationの契約を満たす限りangle重複は許可する", async () => {
  let call = 0;
  const result = await generateBannerCopyPlan({ ...baseInput(), jsonGenerator: async () => { call += 1; return okResponse; } });
  assert.equal(call, 1);
  assert.deepEqual(result.results.map((r) => r.status), ["passed", "warning"]);
});

test("variationがbaselineと同一コピーなら不正扱いでバッチリトライされる", async () => {
  const duplicated = {
    ...okResponse,
    candidates: [
      okResponse.candidates[0],
      {
        ...okResponse.candidates[1],
        variationDirection: "",
        slotTexts: okResponse.candidates[0].slotTexts.map((slot) => ({ ...slot }))
      }
    ]
  };
  let call = 0;
  const result = await generateBannerCopyPlan({ ...baseInput(), jsonGenerator: async () => (call++ === 0 ? duplicated : okResponse) });
  assert.equal(call, 2);
  assert.deepEqual(result.results.map((r) => r.status), ["passed", "warning"]);
});

test("baseline seedがあればvariation単独再生成でもcandidateIndex=0を要求しない", async () => {
  const singleVariation = {
    hypothesis: okResponse.hypothesis,
    categoryRelation: okResponse.categoryRelation,
    candidates: [okResponse.candidates[1]]
  };
  const result = await generateBannerCopyPlan({
    ...baseInput(),
    banners: [{ id: "b2", templateAdId: "tpl_1", candidateIndex: 1 }],
    candidateIndexes: [1],
    baselineSeed: {
      candidateIndex: 0,
      slotTexts: okResponse.candidates[0].slotTexts,
      appealAxis: okResponse.candidates[0].appealAxis,
      whyItStops: okResponse.candidates[0].whyItStops
    },
    jsonGenerator: async () => singleVariation
  });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].copyBrief.candidateIndex, 1);
  assert.equal(result.results[0].copyBrief.variationRole, "variant");
});

test("v6 copyBriefはwhyItStopsを保存しhash対象に含める", async () => {
  const result = await generateBannerCopyPlan({ ...baseInput(), jsonGenerator: async () => okResponse });
  assert.equal(result.results[0].copyBrief.whyItStops, "毎朝10分という具体的な変化が一読で伝わるため");
  assert.ok(result.results[0].copyBrief.copyBriefHash.startsWith("sha256:"));
});

test("whyItStops欠落はバッチ応答不正として1回リトライする", async () => {
  const missing = {
    ...okResponse,
    candidates: okResponse.candidates.map(({ whyItStops, ...candidate }) => candidate)
  };
  let call = 0;
  const result = await generateBannerCopyPlan({
    ...baseInput(),
    jsonGenerator: async () => (call++ === 0 ? missing : okResponse)
  });
  assert.equal(call, 2);
  assert.equal(result.results[0].copyBrief.whyItStops, "毎朝10分という具体的な変化が一読で伝わるため");
});
