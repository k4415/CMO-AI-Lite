import test from "node:test";
import assert from "node:assert/strict";

import {
  createPaidRequestBudget,
  runBannerSlaValidation
} from "../scripts/validate-banner-sla.mjs";

const START = "2026-07-20T00:00:00.000Z";
const IDS = Array.from({ length: 10 }, (_, index) => `banner-${index + 1}`);

function makeTerminalBanners() {
  return IDS.map((id, index) => ({
    id,
    productId: "must-not-leak",
    title: "must-not-leak",
    templateAdId: `template-${(index % 3) + 1}`,
    productionStatus: "completed",
    imageGenerationStatus: "completed",
    pipelineNodes: {
      copyplan: { startedAt: START, completedAt: "2026-07-20T00:00:20.000Z", durationMs: 20000 },
      prompt: { startedAt: "2026-07-20T00:00:20.000Z", completedAt: "2026-07-20T00:00:21.000Z", durationMs: 1000 },
      image: { startedAt: "2026-07-20T00:00:21.000Z", completedAt: "2026-07-20T00:02:30.000Z", durationMs: 129000 }
    },
    imageGenerationAudit: {
      quality: "low",
      attempts: [{ attempt: 1, durationMs: 129000 }]
    }
  }));
}

function makeQualityReview(verdict = "PASS") {
  return Object.fromEntries(IDS.map((id) => [id, {
    verdict,
    reason: verdict === "WARN" ? "目視上の違和感なし" : ""
  }]));
}

test("10件以外のbatchはAPIを呼ぶ前に拒否する", async () => {
  let calls = 0;
  await assert.rejects(() => runBannerSlaValidation({
    baseUrl: "http://localhost:5176",
    project: "./projects/validation",
    bannerIds: ["banner-1"],
    qualityReview: {},
    maxPaidRequests: 30,
    fetchImpl: async () => {
      calls += 1;
      return new Response("{}");
    }
  }), /10件/);
  assert.equal(calls, 0);
});

test("paid request budgetは自動回復を含む31回目を拒否する", () => {
  const budget = createPaidRequestBudget(30);
  for (let index = 0; index < 30; index += 1) budget.consume();
  assert.equal(budget.used, 30);
  assert.equal(budget.remaining, 0);
  assert.throws(() => budget.consume(), /30/);
});

test("10件を起動・terminalまでpollし、匿名化したSLA reportを返す", async () => {
  const calls = [];
  const pending = makeTerminalBanners().map((banner) => ({
    ...banner,
    productionStatus: "prompt_generating",
    imageGenerationStatus: "not_started",
    pipelineNodes: {}
  }));
  const terminal = makeTerminalBanners();
  let researchReads = 0;
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET", body: options.body || "" });
    if (String(url).includes("/api/research?")) {
      researchReads += 1;
      return Response.json({ ok: true, workspace: { banners: researchReads === 1 ? pending : terminal } });
    }
    if (String(url).endsWith("/api/banners/generate-full-batch")) {
      return Response.json({ ok: true, accepted: true }, { status: 202 });
    }
    return Response.json({ ok: false, message: "unexpected" }, { status: 404 });
  };

  const report = await runBannerSlaValidation({
    baseUrl: "http://localhost:5176",
    project: "./projects/validation",
    bannerIds: IDS,
    qualityReview: makeQualityReview(),
    maxPaidRequests: 30,
    round: 1,
    requestStartedAt: START,
    fetchImpl,
    pollIntervalMs: 0,
    timeoutMs: 1000
  });

  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
  assert.equal(report.passed, true);
  assert.equal(report.idealPassed, true);
  assert.equal(report.minimumPassed, true);
  assert.equal(report.paidRequestCount, 10);
  assert.equal(report.banners.length, 10);
  assert.equal(report.banners[0].bannerId, "banner-1");
  assert.equal(report.banners[0].templateId, "template-1");
  assert.equal(JSON.stringify(report).includes("must-not-leak"), false);
  assert.equal(Object.hasOwn(report, "project"), false);
});

test("未レビュー・FAIL・理由なしWARNは品質合格にしない", async () => {
  const terminal = makeTerminalBanners();
  const fetchImpl = async () => Response.json({ ok: true, workspace: { banners: terminal } });
  const missingReview = makeQualityReview();
  delete missingReview[IDS[9]];
  const warnWithoutReason = makeQualityReview();
  warnWithoutReason[IDS[9]] = { verdict: "WARN", reason: "" };
  const failedReview = makeQualityReview();
  failedReview[IDS[9]] = { verdict: "FAIL", reason: "ロゴ不一致" };

  for (const qualityReview of [missingReview, warnWithoutReason, failedReview]) {
    const report = await runBannerSlaValidation({
      baseUrl: "http://localhost:5176",
      project: "./projects/validation",
      bannerIds: IDS,
      qualityReview,
      maxPaidRequests: 30,
      requestStartedAt: START,
      fetchImpl,
      pollIntervalMs: 0,
      timeoutMs: 1000
    });
    assert.equal(report.passed, false);
    assert.equal(report.completedCount, 9);
    assert.equal(report.qualityFailureCount, 1);
    assert.equal(report.terminalCount, 10);
    assert.equal(report.timingIdealPassed, true);
    assert.equal(report.timingMinimumPassed, true);
  }
});

test("残予算が10件の最大2試行を収容できない場合は起動しない", async () => {
  let posts = 0;
  const pending = makeTerminalBanners().map((banner) => ({ ...banner, productionStatus: "not_started" }));
  const fetchImpl = async (url, options = {}) => {
    if ((options.method || "GET") === "POST") posts += 1;
    return Response.json({ ok: true, workspace: { banners: pending } });
  };

  await assert.rejects(() => runBannerSlaValidation({
    baseUrl: "http://localhost:5176",
    project: "./projects/validation",
    bannerIds: IDS,
    qualityReview: makeQualityReview(),
    maxPaidRequests: 30,
    priorPaidRequests: 11,
    fetchImpl
  }), /残予算/);
  assert.equal(posts, 0);
});
