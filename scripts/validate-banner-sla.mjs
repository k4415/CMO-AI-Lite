import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { evaluateBannerBatchSla } from "../src/core/banner-sla.js";

const REQUIRED_BANNER_COUNT = 10;
const MAX_IMAGE_ATTEMPTS_PER_BANNER = 2;
const TERMINAL_STATUSES = new Set([
  "completed",
  "completed_with_warnings",
  "failed",
  "copy_review_failed",
  "strategy_input_insufficient",
  "template_not_ready"
]);

export function createPaidRequestBudget(maxPaidRequests = 30, initialUsed = 0) {
  const limit = Math.max(1, Math.floor(Number(maxPaidRequests) || 30));
  let used = Math.max(0, Math.floor(Number(initialUsed) || 0));
  if (used > limit) throw new Error(`有料画像APIの累計が上限${limit}回を超えています。`);
  return {
    get limit() { return limit; },
    get used() { return used; },
    get remaining() { return limit - used; },
    consume(count = 1) {
      const increment = Math.max(1, Math.floor(Number(count) || 1));
      if (used + increment > limit) {
        throw new Error(`有料画像APIは最大${limit}回です。回復試行を含む次のリクエストは実行しません。`);
      }
      used += increment;
      return used;
    }
  };
}

export async function runBannerSlaValidation({
  baseUrl,
  project,
  bannerIds,
  qualityReview = {},
  maxPaidRequests = 30,
  priorPaidRequests = 0,
  round = 1,
  requestStartedAt = "",
  limitMs = 180000,
  timeoutMs = 20 * 60 * 1000,
  pollIntervalMs = 1000,
  fetchImpl = fetch,
  now = () => new Date(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  const ids = [...new Set((Array.isArray(bannerIds) ? bannerIds : []).map(String).filter(Boolean))];
  if (ids.length !== REQUIRED_BANNER_COUNT) {
    throw new Error(`SLA検証は重複のないバナー10件を指定してください（指定: ${ids.length}件）。`);
  }
  if (!String(baseUrl || "").trim()) throw new Error("--base-urlを指定してください。");
  if (!String(project || "").trim()) throw new Error("--projectを指定してください。");

  const budget = createPaidRequestBudget(maxPaidRequests, priorPaidRequests);
  const initialWorkspace = await fetchWorkspace({ baseUrl, project, fetchImpl });
  let selected = selectBanners(initialWorkspace, ids);
  assertAllBannersFound(selected, ids);
  const alreadyTerminal = selected.every(isTerminalBanner);
  let requestedAt = normalizeIso(requestStartedAt);

  if (!alreadyTerminal) {
    const maximumRoundCost = ids.length * MAX_IMAGE_ATTEMPTS_PER_BANNER;
    if (budget.remaining < maximumRoundCost) {
      throw new Error(`残予算${budget.remaining}回では、10件の最大2試行（${maximumRoundCost}回）を安全に実行できません。`);
    }
    requestedAt = requestedAt || now().toISOString();
    await postJson(`${stripTrailingSlash(baseUrl)}/api/banners/generate-full-batch`, {
      project,
      bannerIds: ids
    }, fetchImpl);
    selected = await pollTerminalBanners({
      baseUrl,
      project,
      ids,
      fetchImpl,
      timeoutMs,
      pollIntervalMs,
      sleep
    });
  }

  requestedAt = requestedAt || inferRequestStartedAt(selected) || now().toISOString();
  const reviews = normalizeQualityReview(qualityReview, ids);
  const bannersForEvaluation = selected.map((banner) => ({
    ...banner,
    slaQualityPassed: reviews[banner.id].passed
  }));
  const paidRequestCount = selected.reduce((sum, banner) => (
    sum + (Array.isArray(banner.imageGenerationAudit?.attempts) ? banner.imageGenerationAudit.attempts.length : 0)
  ), 0);
  if (paidRequestCount) budget.consume(paidRequestCount);
  const evaluated = evaluateBannerBatchSla({
    requestStartedAt: requestedAt,
    banners: bannersForEvaluation,
    expectedCount: REQUIRED_BANNER_COUNT,
    limitMs
  });
  const timingEvaluated = evaluateBannerBatchSla({
    requestStartedAt: requestedAt,
    banners: selected.map((banner) => ({ ...banner, slaQualityPassed: true })),
    expectedCount: REQUIRED_BANNER_COUNT,
    limitMs
  });
  const passed = evaluated.completedCount === REQUIRED_BANNER_COUNT
    && evaluated.qualityFailureCount === 0
    && (evaluated.idealPassed || evaluated.minimumPassed);

  return {
    schemaVersion: 1,
    round: Math.max(1, Math.floor(Number(round) || 1)),
    requestedAt,
    evaluatedAt: now().toISOString(),
    expectedCount: REQUIRED_BANNER_COUNT,
    limitMs,
    paidRequestCount,
    cumulativePaidRequestCount: budget.used,
    maxPaidRequests: budget.limit,
    passed,
    idealPassed: evaluated.idealPassed,
    minimumPassed: evaluated.minimumPassed,
    timingIdealPassed: timingEvaluated.idealPassed,
    timingMinimumPassed: timingEvaluated.minimumPassed,
    batchMakespanMs: timingEvaluated.batchMakespanMs,
    terminalCount: timingEvaluated.completedCount,
    completedCount: evaluated.completedCount,
    qualityFailureCount: evaluated.qualityFailureCount,
    banners: selected.map((banner) => {
      const timing = evaluated.perBanner.find((item) => item.bannerId === banner.id);
      return sanitizeBannerResult(banner, reviews[banner.id], timing);
    })
  };
}

async function fetchWorkspace({ baseUrl, project, fetchImpl }) {
  const url = `${stripTrailingSlash(baseUrl)}/api/research?project=${encodeURIComponent(project)}`;
  const response = await fetchImpl(url);
  const data = await readResponseJson(response);
  if (!response.ok || data.ok === false) throw new Error(data.message || `案件取得に失敗しました（HTTP ${response.status}）。`);
  return data.workspace || {};
}

async function postJson(url, body, fetchImpl) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await readResponseJson(response);
  if (!response.ok || data.ok === false) throw new Error(data.message || `一括生成の開始に失敗しました（HTTP ${response.status}）。`);
  return data;
}

async function pollTerminalBanners({ baseUrl, project, ids, fetchImpl, timeoutMs, pollIntervalMs, sleep }) {
  const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 20 * 60 * 1000);
  while (Date.now() <= deadline) {
    const workspace = await fetchWorkspace({ baseUrl, project, fetchImpl });
    const selected = selectBanners(workspace, ids);
    assertAllBannersFound(selected, ids);
    if (selected.every(isTerminalBanner)) return selected;
    await sleep(Math.max(0, Number(pollIntervalMs) || 0));
  }
  throw new Error("10件のバナー生成がタイムアウトしました。");
}

function selectBanners(workspace, ids) {
  const banners = Array.isArray(workspace?.banners) ? workspace.banners : [];
  return ids.map((id) => banners.find((banner) => String(banner?.id || "") === id)).filter(Boolean);
}

function assertAllBannersFound(selected, ids) {
  if (selected.length !== ids.length) {
    const found = new Set(selected.map((banner) => String(banner.id || "")));
    const missing = ids.filter((id) => !found.has(id));
    throw new Error(`バナーが見つかりません: ${missing.join(", ")}`);
  }
}

function isTerminalBanner(banner) {
  return TERMINAL_STATUSES.has(String(banner?.productionStatus || ""));
}

function normalizeQualityReview(input, ids) {
  const source = input && typeof input === "object" ? input : {};
  return Object.fromEntries(ids.map((id) => {
    const item = source[id] && typeof source[id] === "object" ? source[id] : {};
    const verdict = String(item.verdict || "MISSING").trim().toUpperCase();
    const reason = String(item.reason || "").trim();
    const passed = verdict === "PASS" || (verdict === "WARN" && Boolean(reason));
    return [id, {
      verdict: ["PASS", "WARN", "FAIL"].includes(verdict) ? verdict : "MISSING",
      reason,
      passed
    }];
  }));
}

function sanitizeBannerResult(banner, review, timing) {
  const nodes = banner.pipelineNodes && typeof banner.pipelineNodes === "object" ? banner.pipelineNodes : {};
  return {
    bannerId: String(banner.id || ""),
    templateId: String(banner.templateAdId || ""),
    productionStatus: String(banner.productionStatus || ""),
    imageGenerationStatus: String(banner.imageGenerationStatus || ""),
    quality: String(banner.imageGenerationAudit?.quality || ""),
    qualityReview: { verdict: review.verdict, reason: review.reason },
    imageAttemptCount: Array.isArray(banner.imageGenerationAudit?.attempts) ? banner.imageGenerationAudit.attempts.length : 0,
    processingStartedAt: timestampToIso(timing?.processingStartMs),
    completedAt: timestampToIso(timing?.completedMs),
    processingMs: Number.isFinite(timing?.processingMs) ? timing.processingMs : null,
    nodeDurationsMs: {
      copyplan: finiteOrNull(nodes.copyplan?.durationMs),
      prompt: finiteOrNull(nodes.prompt?.durationMs),
      image: finiteOrNull(nodes.image?.durationMs)
    }
  };
}

function inferRequestStartedAt(banners) {
  const values = banners.flatMap((banner) => [
    banner.pipelineNodes?.copyplan?.startedAt,
    banner.pipelineNodes?.prompt?.startedAt,
    banner.pipelineNodes?.image?.startedAt
  ]).map((value) => Date.parse(String(value || ""))).filter(Number.isFinite);
  return values.length ? new Date(Math.min(...values)).toISOString() : "";
}

function normalizeIso(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
}

function timestampToIso(value) {
  return Number.isFinite(value) ? new Date(value).toISOString() : "";
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

async function readResponseJson(response) {
  return response.json().catch(() => ({}));
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) args[key] = true;
    else {
      args[key] = value;
      index += 1;
    }
  }
  return args;
}

async function readJsonIfExists(filePath, fallback) {
  if (!filePath) return fallback;
  try {
    return JSON.parse(await fs.readFile(path.resolve(filePath), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  const round = Math.max(1, Math.floor(Number(args.round) || 1));
  const outputPath = path.resolve(args.output || `.codex-validation/round-${round}-report.json`);
  const ledgerPath = path.resolve(args.ledger || ".codex-validation/banner-sla-paid-ledger.json");
  const idsInput = await readJsonIfExists(args["banner-ids-file"], []);
  const bannerIds = Array.isArray(idsInput) ? idsInput : idsInput.bannerIds;
  const qualityReview = await readJsonIfExists(args["quality-review"], {});
  const existingReport = await readJsonIfExists(outputPath, {});
  const ledger = await readJsonIfExists(ledgerPath, { rounds: {} });
  const priorPaidRequests = Object.entries(ledger.rounds || {})
    .filter(([key]) => key !== String(round))
    .reduce((sum, [, count]) => sum + Math.max(0, Number(count) || 0), 0);
  const report = await runBannerSlaValidation({
    baseUrl: args["base-url"],
    project: args.project,
    bannerIds,
    qualityReview,
    maxPaidRequests: args["max-paid-requests"],
    priorPaidRequests,
    round,
    requestStartedAt: existingReport.requestedAt || ""
  });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const nextLedger = {
    schemaVersion: 1,
    maxPaidRequests: report.maxPaidRequests,
    rounds: { ...(ledger.rounds || {}), [String(round)]: report.paidRequestCount }
  };
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fs.writeFile(ledgerPath, `${JSON.stringify(nextLedger, null, 2)}\n`, "utf8");
  console.log(`banner-sla round=${round} passed=${report.passed} ideal=${report.idealPassed} minimum=${report.minimumPassed} paid=${report.cumulativePaidRequestCount}/${report.maxPaidRequests}`);
  if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    console.error(`banner-sla error: ${error.message}`);
    process.exitCode = 1;
  });
}
