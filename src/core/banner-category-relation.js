import { openAiJson } from "./openai-text.js";
import { loadPrompt } from "./prompt-files.js";

const CATEGORY_RELATION_SYSTEM = loadPrompt("banner-category-relation");
const relationCache = new Map();

export async function resolveCategoryRelation({ template = null, strategy = {}, jsonGenerator = openAiJson } = {}) {
  const source = template?.copyBlueprint?.sourceCategoryProfile
    || template?.templatePromptJson?.copyBlueprint?.sourceCategoryProfile
    || null;
  if (!hasSourceProfile(source)) return fallbackRelation("source_profile_missing");

  const cacheKey = categoryRelationCacheKey(template, strategy);
  if (relationCache.has(cacheKey)) return relationCache.get(cacheKey);

  const pending = (async () => {
    const parsed = await jsonGenerator({
      system: CATEGORY_RELATION_SYSTEM,
      user: [
        "# 参照テンプレートの元カテゴリ",
        JSON.stringify(source, null, 2),
        "",
        "# 生成先の選択WHO-WHAT",
        JSON.stringify(normalizeStrategy(strategy), null, 2),
        "",
        "JSONのみを返してください。"
      ].join("\n")
    });
    return normalizeCategoryRelation(parsed);
  })();
  relationCache.set(cacheKey, pending);
  try {
    const result = await pending;
    relationCache.set(cacheKey, Promise.resolve(result));
    trimRelationCache();
    return result;
  } catch (error) {
    relationCache.delete(cacheKey);
    throw error;
  }
}

export function clearCategoryRelationCache() {
  relationCache.clear();
}

function categoryRelationCacheKey(template, strategy) {
  const blueprint = template?.copyBlueprint || template?.templatePromptJson?.copyBlueprint || {};
  return [
    String(strategy?.id || ""),
    String(strategy?.updatedAt || strategy?.createdAt || ""),
    String(template?.id || ""),
    String(blueprint?.version || "")
  ].join("::");
}

function trimRelationCache() {
  while (relationCache.size > 500) relationCache.delete(relationCache.keys().next().value);
}

export function normalizeCategoryRelation(value = {}) {
  const relationValue = value?.value === "far" ? "far" : "near";
  const confidence = Math.min(1, Math.max(0, Number(value?.confidence) || 0));
  return {
    value: relationValue,
    confidence,
    reason: String(value?.reason || (value?.value === relationValue ? "" : "invalid_relation_response")),
    signals: (Array.isArray(value?.signals) ? value.signals : []).map((item) => String(item || "").trim()).filter(Boolean).slice(0, 8),
    reuseMethod: relationValue === "far" ? "pattern_fill" : "mechanism_only"
  };
}

function fallbackRelation(reason) {
  return {
    value: "near",
    confidence: 0,
    reason,
    signals: [],
    reuseMethod: "mechanism_only"
  };
}

function hasSourceProfile(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && [value.category, value.subcategory, value.audience, value.problem, value.solutionType, value.purchaseContext]
      .some((item) => String(item || "").trim());
}

function normalizeStrategy(strategy) {
  const markdown = String(strategy?.markdown || "").trim();
  if (markdown) return { id: strategy.id || "", markdown };
  return {
    id: strategy?.id || "",
    targetAttributes: strategy?.targetAttributes || "",
    desire: strategy?.desire || "",
    alternatives: strategy?.alternatives || "",
    productConcept: strategy?.productConcept || "",
    benefit: strategy?.benefit || "",
    offer: strategy?.offer || ""
  };
}
