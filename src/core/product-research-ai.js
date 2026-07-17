import { openAiJson, openAiJsonWebSearch } from "./openai-text.js";
import { addFacts, getResearchWorkspace } from "./research-store.js";
import { loadPrompt } from "./prompt-files.js";

const FACT_CATEGORIES = ["特徴", "メリット", "実績", "権威性", "オファー"];
const RESEARCH_DIRECTIONS = [
  ["official", "公式情報"],
  ["reviews", "口コミ・レビュー"],
  ["comparisons", "比較・おすすめ記事"],
  ["media", "メディア掲載・受賞"],
  ["authority", "専門家・監修・権威性"],
  ["company", "運営会社"],
  ["market", "市場・トレンド"],
  ["risks", "リスク・注意点・規制"]
];

// Web検索を既定で使う。CMOAI_FACT_WEBSEARCH=off で従来の登録資料のみ抽出に切り替え可能。
const WEB_SEARCH_ENABLED = String(process.env.CMOAI_FACT_WEBSEARCH || "on").toLowerCase() !== "off";

export async function extractProductFactsWithAi(projectRoot, { productId = "", webSearch } = {}) {
  const workspace = await getResearchWorkspace(projectRoot);
  const products = workspace.products || [];
  if (!productId && products.length > 1) throw new Error("\u8907\u6570\u306e\u5546\u54c1\u304c\u3042\u308a\u307e\u3059\u3002\u5546\u54c1\u3092\u9078\u629e\u3057\u3066\u304b\u3089\u5546\u54c1\u4e8b\u5b9f\u62bd\u51fa\u3092\u5b9f\u884c\u3057\u3066\u304f\u3060\u3055\u3044\u3002");
  const product = products.find((item) => item.id === productId) || products[0];
  if (!product) throw new Error("商品マスターDBに商品がありません。");
  const relatedMaterials = (workspace.materials || []).filter((item) => !item.productId || item.productId === product.id);
  const existingFacts = (workspace.facts || []).filter((item) => !item.productId || item.productId === product.id);

  const useWebSearch = webSearch === undefined ? WEB_SEARCH_ENABLED : Boolean(webSearch);
  const request = {
    system: PRODUCT_RESEARCH_SYSTEM,
    user: buildProductResearchPrompt({ product, materials: relatedMaterials, existingFacts, useWebSearch })
  };

  let parsed;
  let webSearchUsed = false;
  let webSearchError = "";
  if (useWebSearch) {
    try {
      parsed = await openAiJsonWebSearch(request);
      webSearchUsed = true;
      const missing = missingResearchDirections(parsed.researchCoverage);
      if (missing.length) {
        try {
          const supplemental = await openAiJsonWebSearch({
            system: PRODUCT_RESEARCH_SYSTEM,
            user: buildSupplementalResearchPrompt(request.user, parsed, missing)
          });
          parsed = mergeResearchResults(parsed, supplemental);
        } catch (error) {
          webSearchError = "補完検索に失敗しました: " + String(error?.message || error);
        }
      }
    } catch (error) {
      // Web検索が使えない環境・モデルのときは登録資料のみで抽出にフォールバックする。
      webSearchError = String(error?.message || error || "Web検索を実行できませんでした");
      parsed = await openAiJson({
        system: PRODUCT_RESEARCH_SYSTEM,
        user: buildProductResearchPrompt({ product, materials: relatedMaterials, existingFacts, useWebSearch: false })
      });
    }
  } else {
    parsed = await openAiJson(request);
  }

  const searchQueriesRun = Array.isArray(parsed.searchQueriesRun) ? parsed.searchQueriesRun.map(String).map((item) => item.trim()).filter(Boolean) : [];
  const webSearchStatus = webSearchUsed ? "completed" : (useWebSearch ? "fallback" : "disabled");
  const researchCoverage = normalizeResearchCoverage(parsed.researchCoverage);
  const missingDirections = useWebSearch ? missingResearchDirections(researchCoverage) : [];
  const researchCoverageStatus = !useWebSearch ? "disabled" : !webSearchUsed ? "fallback" : missingDirections.length ? "partial" : "complete";
  const extractedAt = new Date().toISOString();
  const candidates = normalizeFacts(parsed.facts || parsed.items || [], product, relatedMaterials, {
    webSearchStatus,
    searchQueriesRun,
    researchCoverageStatus,
    missingDirections,
    extractedAt
  });
  const added = await addFacts(projectRoot, candidates);
  return {
    product,
    added,
    summary: String(parsed.summary || ""),
    proposals: Array.isArray(parsed.proposals) ? parsed.proposals.map(normalizeProposal).filter(Boolean) : [],
    searchQueriesRun,
    webSearchUsed,
    webSearchStatus,
    webSearchError,
    researchCoverage,
    researchCoverageStatus,
    missingDirections,
    insufficientCategories: Array.isArray(parsed.insufficientCategories) ? parsed.insufficientCategories.map(String) : [],
    existingFactCount: existingFacts.length,
    candidateCount: candidates.length
  };
}

function buildProductResearchPrompt({ product, materials, existingFacts, useWebSearch }) {
  return [
    "# 実行タスク",
    "商品マスターDBと資料DB" + (useWebSearch ? "、およびWeb検索" : "") + "から、事実DBに追加する新しい事実を抽出してください。",
    "system指示のカテゴリ(5区分)・命名ルール・本文の書き方・出力JSONスキーマに厳密に従ってください。",
    useWebSearch
      ? "Web検索ツールを使い、system指示の8観点をすべて個別に検索してください。各観点で最低1クエリを実行し、researchCoverageに観点別のクエリと確認できたURLを、searchQueriesRunに全クエリを列挙してください。登録資料に無い事実も補完してください。"
      : "今回はWeb検索なしで、登録済みの資料と商品マスターの範囲で抽出してください。",
    "既存事実と重複する内容は出さないでください。画像LPは資料DBのvisualAnalysis(スクショAI分析)も一次情報として扱ってください。",
    "",
    "# 商品マスターDB(検索シード)",
    JSON.stringify(product, null, 2),
    "",
    "# 資料DB",
    JSON.stringify(materials.map(slimMaterial), null, 2),
    "",
    "# 既存事実DB(重複チェック用)",
    JSON.stringify(existingFacts.slice(0, 80).map((fact) => ({ title: fact.title, content: fact.content, category: fact.category })), null, 2)
  ].join("\n");
}

function buildSupplementalResearchPrompt(originalPrompt, firstResult, missingKeys) {
  const labels = RESEARCH_DIRECTIONS.filter(([key]) => missingKeys.includes(key)).map(([, label]) => label);
  return [
    originalPrompt,
    "",
    "# 補完検索",
    `初回検索で未確認の観点があります: ${labels.join("、")}`,
    "上記の未確認観点だけを追加検索し、新しく確認できた事実とresearchCoverageを返してください。初回と同じ事実は重複させないでください。",
    "# 初回結果",
    JSON.stringify(firstResult, null, 2)
  ].join("\n");
}

export function normalizeResearchCoverage(input) {
  const source = input && typeof input === "object" ? input : {};
  return Object.fromEntries(RESEARCH_DIRECTIONS.map(([key, label]) => {
    const item = source[key] && typeof source[key] === "object" ? source[key] : {};
    return [key, {
      label,
      searched: item.searched === true,
      queries: uniqueReferences(Array.isArray(item.queries) ? item.queries : []),
      sources: uniqueReferences(Array.isArray(item.sources) ? item.sources : item.urls || [])
    }];
  }));
}

export function missingResearchDirections(input) {
  const coverage = normalizeResearchCoverage(input);
  return RESEARCH_DIRECTIONS
    .filter(([key]) => !coverage[key].searched || coverage[key].queries.length === 0)
    .map(([key]) => key);
}

export function mergeResearchResults(primary = {}, supplemental = {}) {
  const facts = [...(primary.facts || primary.items || []), ...(supplemental.facts || supplemental.items || [])];
  const seen = new Set();
  const dedupedFacts = facts.filter((fact) => {
    const key = `${String(fact?.title || "").trim()}\n${String(fact?.content || "").trim()}`;
    if (!key.trim() || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const firstCoverage = normalizeResearchCoverage(primary.researchCoverage);
  const nextCoverage = normalizeResearchCoverage(supplemental.researchCoverage);
  const researchCoverage = Object.fromEntries(RESEARCH_DIRECTIONS.map(([key, label]) => [key, {
    label,
    searched: firstCoverage[key].searched || nextCoverage[key].searched,
    queries: uniqueReferences([...firstCoverage[key].queries, ...nextCoverage[key].queries]),
    sources: uniqueReferences([...firstCoverage[key].sources, ...nextCoverage[key].sources])
  }]));
  return {
    ...primary,
    ...supplemental,
    facts: dedupedFacts,
    summary: [primary.summary, supplemental.summary].filter(Boolean).join("\n"),
    searchQueriesRun: uniqueReferences([...(primary.searchQueriesRun || []), ...(supplemental.searchQueriesRun || [])]),
    researchCoverage,
    proposals: [...(primary.proposals || []), ...(supplemental.proposals || [])],
    insufficientCategories: uniqueReferences([...(primary.insufficientCategories || []), ...(supplemental.insufficientCategories || [])])
  };
}

function normalizeProposal(item) {
  const title = String(item?.title || "").trim();
  const content = String(item?.content || "").trim();
  if (!title && !content) return null;
  return { title, content, reason: String(item?.reason || "").trim() };
}

function slimMaterial(material) {
  return {
    id: material.id,
    productId: material.productId,
    type: material.type,
    title: material.title,
    sourceUrl: material.sourceUrl,
    manualText: clip(material.manualText, 8000),
    extractedText: clip(material.extractedText, 18000),
    visualAnalysis: clip(material.visualAnalysis, 12000),
    screenshotStatus: material.screenshotStatus,
    screenshotCount: (material.screenshotUrls || []).length
  };
}

export function normalizeFacts(items, product, materials, provenance = {}) {
  return (items || []).map((item) => {
    const material = materials.find((candidate) => candidate.id === item.sourceMaterialId) || null;
    const references = normalizeReferences(item.references);
    const explicitSourceUrl = normalizeReference(item.sourceUrl);
    const sourceType = String(item.sourceType || (material ? "material" : "web")).trim();
    const fallbackSourceUrl = material?.sourceUrl || (sourceType === "web" ? "" : product.officialUrl) || "";
    const mergedReferences = references.length
      ? references
      : uniqueReferences([explicitSourceUrl, fallbackSourceUrl]);
    const sourceUrl = mergedReferences[0] || "";
    return {
      productId: product.id,
      title: String(item.title || "").trim(),
      content: stripFactReferenceMarkers(String(item.content || "").trim()),
      category: normalizeCategory(item.category),
      sourceType,
      sourceUrl: String(sourceUrl).trim(),
      sourceMaterialId: String(item.sourceMaterialId || material?.id || "").trim(),
      references: mergedReferences,
      webSearchStatus: provenance.webSearchStatus || "",
      searchQueriesRun: Array.isArray(provenance.searchQueriesRun) ? provenance.searchQueriesRun : [],
      researchCoverageStatus: provenance.researchCoverageStatus || "",
      missingResearchDirections: Array.isArray(provenance.missingDirections) ? provenance.missingDirections : [],
      extractedAt: provenance.extractedAt || "",
      confidenceScore: Number(item.confidenceScore || 0.75)
    };
  }).filter((item) => item.title && item.content && (item.sourceType !== "web" || item.references.length > 0));
}

function normalizeReferences(input) {
  const values = Array.isArray(input) ? input : (input ? [input] : []);
  return uniqueReferences(values.map(normalizeReference));
}

function normalizeReference(value) {
  if (value && typeof value === "object") {
    return String(value.url || value.sourceUrl || value.href || "").trim();
  }
  return String(value || "").trim();
}

function uniqueReferences(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

export function stripFactReferenceMarkers(content) {
  return String(content || "")
    .replace(/\s*[\(（]\s*※[0-9０-９]+(?:\s*[,、，]\s*※[0-9０-９]+)*\s*[\)）]/g, "")
    .trim();
}

// AIが返すカテゴリ表記の揺れ(絵文字付き/旧8区分など)を、UIの5区分に寄せる。
function normalizeCategory(raw) {
  const value = String(raw || "");
  if (FACT_CATEGORIES.some((cat) => value.includes(cat))) {
    return FACT_CATEGORIES.find((cat) => value.includes(cat));
  }
  if (value.includes("リスク") || value.includes("注意") || value.includes("制約")) return "特徴";
  if (value.includes("会社") || value.includes("運営")) return "権威性";
  if (value.includes("市場") || value.includes("トレンド") || value.includes("ベネフィット")) return "メリット";
  if (value.includes("実績") || value.includes("口コミ") || value.includes("顧客の声")) return "実績";
  if (value.includes("価格") || value.includes("特典") || value.includes("保証")) return "オファー";
  return FACT_CATEGORIES[0];
}

function clip(value, max) {
  const text = String(value || "");
  return text.length > max ? text.slice(0, max) + "\n...[truncated]" : text;
}

const PRODUCT_RESEARCH_SYSTEM = loadPrompt("fact-extraction");
