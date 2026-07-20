import { buildColorNeutralTemplateZones } from "./banner-template-color.js";

const IMAGE_TYPES = new Set(["image"]);
const SHAPE_TYPES = new Set(["shape"]);

export function compileClosedTemplatePromptSeed({
  banner = {},
  product = {},
  strategy = {},
  template = {},
  copyBrief = {},
  creativeHypothesis = {},
  instructionPolicy = {}
} = {}) {
  const slotTextById = new Map((Array.isArray(copyBrief.slotTexts) ? copyBrief.slotTexts : [])
    .map((slot) => [String(slot?.slotId || ""), String(slot?.text || "")])
    .filter(([slotId]) => slotId));
  const visualIntent = safeVisualIntentText(creativeHypothesis?.visualIntent, banner);
  const neutralTemplateZones = buildColorNeutralTemplateZones(
    template.templateZones,
    template.templateColorScheme || template.templatePromptJson?.colorScheme
  );
  const variationDirection = uniqueStrings([
    copyBrief.appealAxis,
    copyBrief.variationDirection,
    copyBrief.targetMoment
  ]).join(" / ");
  const designRationale = uniqueStrings([
    visualIntent,
    variationDirection,
    instructionPolicy.rawInstruction
  ]).join(" / ");

  const zones = neutralTemplateZones.map((zone, zoneIndex) => ({
    position: String(zone?.position || zone?.area || ""),
    purpose: `テンプレのZone ${zoneIndex + 1}構造・視線順・要素役割を維持する`,
    background: "",
    backgroundColorRole: String(zone?.backgroundColorRole || ""),
    elements: (Array.isArray(zone?.elements) ? zone.elements : []).map((element, elementIndex) => {
      const type = normalizeElementType(element?.type);
      const slotId = String(element?.slotId || `z${zoneIndex + 1}e${elementIndex + 1}`);
      const role = String(element?.role || element?.name || "");
      return {
        type,
        slotId,
        role,
        messageRole: String(element?.messageRole || ""),
        content: elementContent({
          element,
          type,
          role,
          slotId,
          slotTextById,
          product,
          visualIntent,
          variationDirection
        }),
        position: plainObject(element?.position),
        size: String(element?.size || ""),
        colorRole: String(element?.colorRole || ""),
        effect: String(element?.effect || ""),
        targetChars: element?.charCount ?? element?.characterCount ?? "",
        sourceReason: sourceReasonFor(type, visualIntent, variationDirection),
        templateReuseLevel: "closed-structure"
      };
    })
  }));

  return {
    promptJson: {
      basic: { size: String(banner.imageSize || "1080x1080") },
      target: strategyText(strategy, "targetAttributes", "segmentName", "desire"),
      desire: strategyText(strategy, "desire"),
      benefit: strategyText(strategy, "benefit", "productConcept", "markdown"),
      offer: strategyText(strategy, "offer") || String(copyBrief.offerBadge || ""),
      globalDesign: { designRationale },
      colorScheme: {},
      additionalInstruction: String(instructionPolicy.rawInstruction || ""),
      zones,
      referenceImage: { instruction: "", url: "" },
      negativeRules: [],
      reviewChecklist: []
    },
    reviewNotes: "Stage 2は閉じたテンプレ契約から決定論的に生成しました。",
    selectionReason: String(copyBrief.whyItStops || "")
  };
}

function elementContent({ element, type, role, slotId, slotTextById, product, visualIntent, variationDirection }) {
  if (type === "text") {
    if (slotTextById.has(slotId)) return slotTextById.get(slotId);
    if (isBrandText(role, element?.messageRole)) return String(product.brandName || product.name || "");
    return "";
  }
  if (IMAGE_TYPES.has(type)) {
    const messageRole = String(element?.messageRole || "");
    if (/person|人物/i.test(`${role} ${messageRole}`)) {
      return "人物画像枠。選択WHO-WHATのターゲットを1人の自然な場面として表現する。読める文字を入れず、ユーザー選択素材を複製・模倣しない。";
    }
    if (/background|decoration|背景|装飾/i.test(`${role} ${messageRole}`)) {
      return "背景・装飾画像枠。選択WHO-WHATの利用場面を低コントラストで表現する。読める文字を入れず、ユーザー選択素材を複製・模倣しない。";
    }
    return `画像枠（${role || "visual"}）。選択WHO-WHATの対象場面を文字なしで表現する。ユーザー選択素材を複製・模倣しない。`;
  }
  if (SHAPE_TYPES.has(type)) return String(element?.description || element?.content || "");
  return "";
}

function sourceReasonFor(type, visualIntent, variationDirection) {
  if (type === "image") return uniqueStrings([visualIntent, variationDirection]).join(" / ");
  if (type === "text") return "copyBrief.slotTextsの確定文言";
  return "テンプレの閉じた構造を維持";
}

function strategyText(strategy, ...keys) {
  for (const key of keys) {
    const value = String(strategy?.[key] || "").trim();
    if (value) return value;
  }
  return "";
}

function visualIntentText(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  return uniqueStrings(Object.values(value).filter((item) => typeof item === "string")).join(" / ");
}

function safeVisualIntentText(value, banner) {
  const hasSelectedAssets = [
    ...(Array.isArray(banner?.logoImagePaths) ? banner.logoImagePaths : []),
    ...(Array.isArray(banner?.productImagePaths) ? banner.productImagePaths : []),
    ...(Array.isArray(banner?.otherImagePaths) ? banner.otherImagePaths : []),
    banner?.logoImagePath,
    banner?.productImagePath,
    banner?.otherImagePath
  ].some(Boolean);
  if (!hasSelectedAssets) return visualIntentText(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  return uniqueStrings(Object.values(value)
    .filter((item) => typeof item === "string")
    .filter((item) => !/(?:ロゴ|商品画像|商品素材|選択素材|パッケージ|ボトル).*(?:複数|並べ|量産|反復|同じ)|(?:複数|並べ|量産|反復|同じ).*(?:ロゴ|商品画像|商品素材|選択素材|パッケージ|ボトル)/i.test(item)))
    .join(" / ");
}

function isBrandText(role, messageRole) {
  return /logo|brand|service.?name|product.?name|ロゴ|ブランド|商品名|サービス名/i.test(`${role || ""} ${messageRole || ""}`);
}

function normalizeElementType(value) {
  const type = String(value || "text").toLowerCase();
  return type === "image" || type === "shape" ? type : "text";
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? JSON.parse(JSON.stringify(value)) : {};
}
