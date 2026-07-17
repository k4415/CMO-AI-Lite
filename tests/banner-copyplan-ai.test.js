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
