import { generateWhoWhatProposals } from "../core/who-what-ai.js";

export const createWhoWhatAction = {
  id: "strategy.create_who_what",
  skillId: "strategy",
  phase: "戦略",
  name: "WHO-WHAT作成",
  description: "商品事実DBと表現レギュレーションDBをもとに、AIでWHO-WHAT仮説を提案します。保存はユーザー確認後に行います。",
  reads: ["project.json", "data/products.json", "data/facts.json", "data/strategies.json", "regulations/expression-rules.md"],
  writes: [],
  requiresReview: true,
  async handler({ context, dryRun, input = {} }) {
    const workspace = context.researchWorkspace || {};
    const product = resolveProductForAction(workspace.products || [], input.productId);
    if (!product) throw new Error(productSelectionError(workspace.products || []));
    if (dryRun) {
      return {
        status: "needs_review",
        writtenFiles: [],
        warnings: context.warnings || [],
        data: {
          productId: product.id,
          product: product.name,
          factCount: (workspace.facts || []).filter((item) => !item.productId || item.productId === product.id).length,
          message: "dryRunのためAI生成は実行していません。"
        },
        nextActions: ["content.banner_create"]
      };
    }
    const result = await generateWhoWhatProposals(context, { productId: product.id });
    const proposal = result.proposals[0] || null;
    return {
      status: "needs_review",
      writtenFiles: [],
      warnings: result.warnings,
      data: {
        model: result.model,
        proposals: result.proposals,
        strategy: proposal,
        whoWhatPreview: proposal?.markdown || result.summary
      },
      nextActions: ["content.banner_create"]
    };
  }
};

function resolveProductForAction(products, productId) {
  if (productId) return products.find((item) => item.id === productId) || null;
  return products.length === 1 ? products[0] : null;
}

function productSelectionError(products) {
  if (!products.length) return "商品マスターDBに商品がありません。";
  return "案件内に複数の商品があります。WHO-WHAT生成に使う商品を選択してください。";
}
