import { openAiJson } from "./openai-text.js";
import { loadPrompt } from "./prompt-files.js";

const DEFAULT_MODEL = process.env.CMOAI_TEXT_MODEL || process.env.OPENAI_TEXT_MODEL || "gpt-5.5";

export async function generateWhoWhatProposals(context, options = {}) {
  const workspace = context.researchWorkspace || {};
  const products = workspace.products || [];
  if (!options.productId && products.length > 1) throw new Error("複数の商品があります。商品を選択してからWHO-WHAT生成を実行してください。");
  const prompt = buildWhoWhatPrompt(context, options);
  const parsed = await openAiJson({ system: WHO_WHAT_SYSTEM_PROMPT, user: prompt, model: options.model || DEFAULT_MODEL });
  const proposals = normalizeProposals(parsed.proposals || parsed.hypotheses || [], context, parsed, options.productId || "");
  if (!proposals.length) throw new Error("WHO-WHAT生成結果を解釈できませんでした。もう一度実行してください。");

  return {
    model: options.model || DEFAULT_MODEL,
    summary: String(parsed.summary || ""),
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings.map(String) : [],
    proposals
  };
}

function buildWhoWhatPrompt(context, options) {
  const workspace = context.researchWorkspace || {};
  const productId = options.productId || "";
  const products = workspace.products || [];
  const selectedProduct = products.find((item) => item.id === productId) || products[0] || context.project?.product || {};
  const related = (items) => (items || []).filter((item) => !selectedProduct.id || !item.productId || item.productId === selectedProduct.id);

  const relatedFacts = related(workspace.facts);
  const relatedExpressionRules = related(workspace.expressionRules);
  const relatedStrategies = related(workspace.strategies);

  return [
    "# 実行タスク",
    "CMO AI LiteのWHO-WHAT壁打ちくんとして、商品のWHO-WHAT仮説を作成してください。",
    "ただし、保存は行わず、ユーザー確認前の提案として出力してください。",
    "",
    "# 出力要件",
    "JSONのみで返してください。Markdownのコードフェンスは禁止です。",
    "proposals配列に2〜3案を入れてください。各案は以下のキーを必ず持ちます。",
    "segmentName, conceptName, targetAttributes, desire, decisionCriteria, alternatives, productConcept, usp, benefit, proof, offer, markdown",
    "conceptNameは20文字以内を目安にしてください。",
    "markdownはユーザーにそのまま見せる提案文で、指定フォーマットに従ってください。",
    "既存WHO-WHAT DBに登録済みの案と重複する切り口は避け、新しい角度の提案を優先する。",
    "欲求・判断基準は口コミ・顧客の声・LP訴求の事実から仮説化し、直接確認できない場合は「（LP・事実からの仮説）」と明示する。",
    "",
    "# 商品マスターDB",
    JSON.stringify(selectedProduct, null, 2),
    "",
    `# 商品事実DB(${relatedFacts.length}件)`,
    JSON.stringify(relatedFacts.slice(0, 80), null, 2),
    "",
    `# 表現レギュレーションDB(${relatedExpressionRules.length}件)`,
    JSON.stringify(relatedExpressionRules.slice(0, 40), null, 2),
    "",
    `# 既存WHO-WHAT DB(${relatedStrategies.length}件)`,
    JSON.stringify(relatedStrategies.slice(0, 20), null, 2)
  ].join("\n");
}

const WHO_WHAT_SYSTEM_PROMPT = loadPrompt("who-what");

function normalizeProposals(items, context, parsed, productId = "") {
  const products = context.researchWorkspace?.products || [];
  const product = products.find((item) => item.id === productId) || products[0] || context.project?.product || {};
  return items.map((item, index) => {
    const markdown = String(item.markdown || item.output || "").trim();
    return {
      productId: String(item.productId || product.id || "").trim(),
      segmentName: String(item.segmentName || item.segment || `仮説${index + 1}`).trim(),
      conceptName: String(item.conceptName || item.strategyConcept || item.segmentName || `WHO-WHAT仮説${index + 1}`).trim().slice(0, 30),
      targetAttributes: String(item.targetAttributes || item.who || "").trim(),
      desire: String(item.desire || "").trim(),
      decisionCriteria: normalizeListText(item.decisionCriteria),
      alternatives: normalizeListText(item.alternatives),
      productConcept: String(item.productConcept || "").trim(),
      usp: normalizeListText(item.usp),
      benefit: String(item.benefit || "").trim(),
      proof: normalizeListText(item.proof),
      offer: String(item.offer || "").trim(),
      status: "proposed",
      markdown: markdown || buildFallbackMarkdown(item, parsed, index)
    };
  }).filter((item) => item.targetAttributes || item.benefit || item.markdown);
}

function buildFallbackMarkdown(item, parsed, index) {
  return [
    `### 仮説 【${item.segmentName || item.conceptName || `仮説${index + 1}`}】`,
    "",
    "**戦略コンセプト:**",
    item.conceptName || "",
    "",
    "**ターゲット属性:**",
    item.targetAttributes || "",
    "",
    "**欲求:**",
    item.desire || "",
    "",
    "**判断基準:**",
    normalizeListText(item.decisionCriteria),
    "",
    "**想定競合:**",
    normalizeListText(item.alternatives),
    "",
    "**商品コンセプト:**",
    item.productConcept || "",
    "",
    "**USP:**",
    normalizeListText(item.usp),
    "",
    "**ベネフィット:**",
    item.benefit || "",
    "",
    "**実績:**",
    normalizeListText(item.proof),
    "",
    "**オファー:**",
    item.offer || "",
    "",
    parsed.summary ? "補足: " + parsed.summary : ""
  ].join("\n");
}

function normalizeListText(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean).join("\n");
  if (value && typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value || "").trim();
}

function clip(value, length) {
  const text = String(value || "");
  return text.length > length ? text.slice(0, length) + "\n...[truncated]" : text;
}
