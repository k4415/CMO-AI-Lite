import crypto from "node:crypto";
import path from "node:path";
import { pathExists, readJson, writeJson, withFileLock } from "./project-store.js";

const STRATEGIES_PATH = "data/strategies.json";

export async function ensureStrategyData(projectRoot) {
  if (!(await pathExists(path.join(projectRoot, STRATEGIES_PATH)))) await writeJson(projectRoot, STRATEGIES_PATH, []);
}

export async function listStrategies(projectRoot) {
  await ensureStrategyData(projectRoot);
  return readJson(projectRoot, STRATEGIES_PATH);
}

export async function addStrategy(projectRoot, input) {
  await ensureStrategyData(projectRoot);
  return withFileLock(path.join(projectRoot, STRATEGIES_PATH), async () => {
    const strategies = await readJson(projectRoot, STRATEGIES_PATH);
    const now = new Date().toISOString();
    const strategy = normalizeStrategy({
      ...input,
      id: createId("str"),
      status: input.status || "proposed",
      createdAt: now,
      updatedAt: now
    });
    if (!strategy.productId) throw new Error("WHO-WHATには商品リレーションが必要です。");
    if (!strategy.conceptName) strategy.conceptName = "WHO-WHAT仮説";
    strategies.unshift(strategy);
    await writeJson(projectRoot, STRATEGIES_PATH, strategies);
    return strategy;
  });
}

export async function upsertStrategyFromAction(projectRoot, input) {
  await ensureStrategyData(projectRoot);
  return withFileLock(path.join(projectRoot, STRATEGIES_PATH), async () => {
    const strategies = await readJson(projectRoot, STRATEGIES_PATH);
    const now = new Date().toISOString();
    const existingIndex = strategies.findIndex((item) => item.sourceRunId && item.sourceRunId === input.sourceRunId);
    const strategy = normalizeStrategy({
      ...input,
      id: existingIndex >= 0 ? strategies[existingIndex].id : createId("str"),
      status: input.status || "proposed",
      createdAt: existingIndex >= 0 ? strategies[existingIndex].createdAt : now,
      updatedAt: now
    });
    if (existingIndex >= 0) strategies.splice(existingIndex, 1, strategy);
    else strategies.unshift(strategy);
    await writeJson(projectRoot, STRATEGIES_PATH, strategies);
    return strategy;
  });
}

export async function updateStrategy(projectRoot, strategyId, patch) {
  await ensureStrategyData(projectRoot);
  return withFileLock(path.join(projectRoot, STRATEGIES_PATH), async () => {
    const strategies = await readJson(projectRoot, STRATEGIES_PATH);
    const index = strategies.findIndex((item) => item.id === strategyId);
    if (index < 0) throw new Error("WHO-WHAT not found: " + strategyId);
    strategies[index] = normalizeStrategy({ ...strategies[index], ...patch, id: strategies[index].id, updatedAt: new Date().toISOString() });
    await writeJson(projectRoot, STRATEGIES_PATH, strategies);
    return strategies[index];
  });
}

export async function deleteStrategy(projectRoot, strategyId) {
  await ensureStrategyData(projectRoot);
  return withFileLock(path.join(projectRoot, STRATEGIES_PATH), async () => {
    const strategies = await readJson(projectRoot, STRATEGIES_PATH);
    const index = strategies.findIndex((item) => item.id === strategyId);
    if (index < 0) throw new Error("WHO-WHAT not found: " + strategyId);
    const [deleted] = strategies.splice(index, 1);
    await writeJson(projectRoot, STRATEGIES_PATH, strategies);
    return deleted;
  });
}

function normalizeStrategy(input) {
  return {
    id: clean(input.id),
    productId: clean(input.productId),
    conceptName: clean(input.conceptName),
    targetAttributes: clean(input.targetAttributes),
    desire: clean(input.desire),
    decisionCriteria: clean(input.decisionCriteria),
    alternatives: clean(input.alternatives),
    productConcept: clean(input.productConcept),
    usp: clean(input.usp),
    benefit: clean(input.benefit),
    offer: clean(input.offer),
    proof: clean(input.proof),
    status: clean(input.status) || "draft",
    sourceRunId: clean(input.sourceRunId),
    markdown: clean(input.markdown),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt
  };
}

function clean(value) {
  return String(value || "").trim();
}

function createId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
