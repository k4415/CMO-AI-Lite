import { extractProductFactsWithAi } from "../core/product-research-ai.js";

export const extractFactsAction = {
  id: "research.extract_facts",
  skillId: "product-research",
  phase: "リサーチ",
  name: "商品事実抽出",
  description: "商品マスターDBと内部LP解析キャッシュを読み、事実DBへ追加します。",
  reads: ["data/products.json", "data/research-materials.json", "data/facts.json"],
  writes: ["data/facts.json"],
  requiresReview: true,
  async handler({ projectRoot, context, dryRun, input = {} }) {
    const workspace = context.researchWorkspace || {};
    const product = resolveProductForAction(workspace.products || [], input.productId);
    if (!product) throw new Error(productSelectionError(workspace.products || []));
    if (dryRun) {
      return {
        status: "needs_review",
        writtenFiles: [],
        data: {
          product: product.name,
          materialCount: materialsForProduct(workspace.materials || [], product.id).length,
          existingFactCount: (workspace.facts || []).filter((item) => item.productId === product.id).length,
          message: "dryRunのためAI抽出とDB書き込みは実行していません。"
        },
        warnings: [],
        nextActions: ["strategy.create_who_what"]
      };
    }
    const result = await extractProductFactsWithAi(projectRoot, { productId: product.id });
    return {
      status: "needs_review",
      writtenFiles: ["data/facts.json"],
      data: {
        product: result.product?.name || product.name,
        addedFactCount: result.added?.length || 0,
        existingFactCount: result.existingFactCount,
        candidateCount: result.candidateCount,
        addedFacts: result.added || [],
        summary: result.summary || ""
      },
      warnings: result.insufficientCategories?.length ? ["情報不足カテゴリ: " + result.insufficientCategories.join("、")] : [],
      nextActions: ["strategy.create_who_what"]
    };
  }
};

function resolveProductForAction(products, productId) {
  if (productId) return products.find((item) => item.id === productId) || null;
  return products.length === 1 ? products[0] : null;
}

function productSelectionError(products) {
  if (!products.length) return "商品マスターDBに商品がありません。";
  return "案件内に複数の商品があります。商品マスターDBの対象商品を選択してから実行してください。";
}

function materialsForProduct(materials, productId) {
  return materials.filter((item) => !item.productId || item.productId === productId);
}
