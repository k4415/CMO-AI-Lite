import { generateBannerPrompt, addBannerCreative, listBannerCreatives } from "../core/banner-store.js";
import { writeText } from "../core/project-store.js";

export const createBannerBriefAction = {
  id: "content.banner_create",
  skillId: "new-banner-creator-4",
  phase: "\u5236\u4f5c",
  name: "\u30d0\u30ca\u30fc\u5236\u4f5c",
  description: "\u5546\u54c1\u3001WHO-WHAT\u3001\u5e83\u544a\u30c6\u30f3\u30d7\u30ec\u3001\u4e8b\u5b9fDB\u3001\u8868\u73fe\u30ec\u30ae\u30e5\u30ec\u30fc\u30b7\u30e7\u30f3\u3092\u8aad\u307f\u3001Notion\u7248 new-banner-creator-4 \u306e\u30d7\u30ed\u30f3\u30d7\u30c8\u3067\u30d0\u30ca\u30fc\u6848\u3092\u751f\u6210\u3057\u307e\u3059\u3002",
  reads: ["data/products.json", "data/strategies.json", "data/ad-templates.json", "data/facts.json", "data/expression-rules.json", "data/banner-creatives.json"],
  writes: ["data/banner-creatives.json", "outputs/banners/{runId}/brief.md"],
  requiresReview: true,
  async handler({ projectRoot, context, runId, dryRun, input = {} }) {
    const workspace = context.researchWorkspace || {};
    const existingBanner = await resolveExistingBanner(projectRoot, workspace, input.bannerId);
    const product = existingBanner ? findById(workspace.products || [], existingBanner.productId) : resolveProductForAction(workspace.products || [], input.productId);
    if (!product) throw new Error(productSelectionError(workspace.products || [], existingBanner));
    const strategies = (workspace.strategies || []).filter((item) => item.productId === product.id);
    const strategy = existingBanner ? findById(workspace.strategies || [], existingBanner.strategyId) : resolveStrategyForAction(strategies, input.strategyId);
    if (!strategy) throw new Error(strategySelectionError(strategies, product.name, existingBanner));
    const bannerTemplates = (workspace.adTemplates || []).filter((item) => item.creativeType === "banner");
    const template = existingBanner ? findById(workspace.adTemplates || [], existingBanner.templateAdId) : resolveTemplateForAction(bannerTemplates, input.templateAdId);

    if (dryRun) {
      return {
        status: "needs_review",
        writtenFiles: [],
        data: {
          mode: existingBanner ? "existing_banner" : "new_banner",
          bannerId: existingBanner?.id || "",
          product: product.name,
          strategy: strategy.conceptName,
          template: template?.title || "\u672a\u9078\u629e",
          message: "dryRun\u306e\u305f\u3081AI\u751f\u6210\u3068DB\u66f8\u304d\u8fbc\u307f\u306f\u5b9f\u884c\u3057\u3066\u3044\u307e\u305b\u3093\u3002"
        },
        nextActions: []
      };
    }

    const target = existingBanner || await addBannerCreative(projectRoot, {
      productId: product.id,
      strategyId: strategy.id,
      templateAdId: template?.id || "",
      title: (product.name || "\u5546\u54c1") + " \u30d0\u30ca\u30fc\u6848",
      additionalInstruction: "Action\u7d4c\u7531\u3067\u4f5c\u6210\u3002Notion\u7248 new-banner-creator-4 \u306e\u6d41\u308c\u3067\u3001\u30c6\u30f3\u30d7\u30ec\u69cb\u9020\u3092\u7dad\u6301\u3057\u3064\u3064\u5546\u54c1\u3068WHO-WHAT\u306b\u5408\u308f\u305b\u3066\u518d\u69cb\u6210\u3059\u308b\u3002",
      productionStatus: "generating",
      imageGenerationStatus: "not_started",
      provider: "gpt-image-2",
      sourceRunId: runId
    });
    const banner = await generateBannerPrompt(projectRoot, target.id, workspace);
    const briefPath = "outputs/banners/" + runId + "/brief.md";
    await writeText(projectRoot, briefPath, renderBrief({ product, strategy, template, banner }));
    return {
      status: "needs_review",
      writtenFiles: ["data/banner-creatives.json", briefPath],
      data: { bannerId: banner.id, title: banner.title, imageText: banner.imageText, promptPreview: String(banner.promptText || "").slice(0, 1800), briefPath },
      nextActions: []
    };
  }
};

async function resolveExistingBanner(projectRoot, workspace, bannerId) {
  if (!bannerId) return null;
  const local = (workspace.banners || []).find((item) => item.id === bannerId);
  if (local) return local;
  const banners = await listBannerCreatives(projectRoot);
  return banners.find((item) => item.id === bannerId) || null;
}

function renderBrief({ product, strategy, template, banner }) {
  return [
    "# \u30d0\u30ca\u30fc\u5236\u4f5cAI\u30d6\u30ea\u30fc\u30d5",
    "",
    "status: needs_review",
    "",
    "## \u5165\u529b",
    "",
    "- \u5546\u54c1: " + (product.name || "\u672a\u8a2d\u5b9a"),
    "- WHO-WHAT: " + (strategy.conceptName || "\u672a\u8a2d\u5b9a"),
    "- \u5e83\u544a\u30c6\u30f3\u30d7\u30ec: " + (template?.title || "\u672a\u9078\u629e"),
    "",
    "## \u753b\u50cf\u30c6\u30ad\u30b9\u30c8",
    "",
    banner.imageText || "",
    "",
    "## \u753b\u50cf\u751f\u6210\u30d7\u30ed\u30f3\u30d7\u30c8",
    "",
    banner.promptText || "",
    "",
    "## \u30ec\u30d3\u30e5\u30fc notes",
    "",
    banner.reviewNotes || "",
    ""
  ].join("\n");
}

function findById(items, id) { return id ? items.find((item) => item.id === id) || null : null; }
function resolveProductForAction(products, productId) { if (productId) return products.find((item) => item.id === productId) || null; return products.length === 1 ? products[0] : null; }
function resolveStrategyForAction(strategies, strategyId) { if (strategyId) return strategies.find((item) => item.id === strategyId) || null; return strategies.length === 1 ? strategies[0] : null; }
function resolveTemplateForAction(templates, templateId) { if (templateId) return templates.find((item) => item.id === templateId) || null; return templates.length === 1 ? templates[0] : null; }

function productSelectionError(products, existingBanner) {
  if (existingBanner) return "\u65e2\u5b58\u30d0\u30ca\u30fc\u6848\u306b\u5546\u54c1\u30ea\u30ec\u30fc\u30b7\u30e7\u30f3\u304c\u3042\u308a\u307e\u305b\u3093\u3002";
  if (!products.length) return "\u5546\u54c1\u30de\u30b9\u30bf\u30fcDB\u306b\u5546\u54c1\u304c\u3042\u308a\u307e\u305b\u3093\u3002";
  return "\u6848\u4ef6\u5185\u306b\u8907\u6570\u306e\u5546\u54c1\u304c\u3042\u308a\u307e\u3059\u3002\u30d0\u30ca\u30fc\u5236\u4f5c\u306b\u4f7f\u3046\u5546\u54c1\u3092\u9078\u629e\u3057\u3066\u304f\u3060\u3055\u3044\u3002";
}

function strategySelectionError(strategies, productName, existingBanner) {
  if (existingBanner) return "\u65e2\u5b58\u30d0\u30ca\u30fc\u6848\u306bWHO-WHAT\u30ea\u30ec\u30fc\u30b7\u30e7\u30f3\u304c\u3042\u308a\u307e\u305b\u3093\u3002";
  if (!strategies.length) return "WHO-WHAT DB\u306b\u300c" + (productName || "\u5bfe\u8c61\u5546\u54c1") + "\u300d\u3078\u7d10\u3065\u304f\u6226\u7565\u304c\u3042\u308a\u307e\u305b\u3093\u3002";
  return "\u300c" + (productName || "\u5bfe\u8c61\u5546\u54c1") + "\u300d\u306b\u8907\u6570\u306eWHO-WHAT\u304c\u3042\u308a\u307e\u3059\u3002\u30d0\u30ca\u30fc\u5236\u4f5c\u306b\u4f7f\u3046WHO-WHAT\u3092\u9078\u629e\u3057\u3066\u304f\u3060\u3055\u3044\u3002";
}
