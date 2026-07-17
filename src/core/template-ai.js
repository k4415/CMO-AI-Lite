import { openAiVisionJson } from "./openai-text.js";
import { listAdTemplates, updateAdTemplate } from "./ad-template-store.js";
import { loadPrompt } from "./prompt-files.js";
import { buildTemplateReadinessState } from "./template-readiness.js";

export async function analyzeBannerTemplateImage(projectRoot, templateId, { visionJson = openAiVisionJson } = {}) {
  const template = await findTemplate(projectRoot, templateId);
  const promptJson = await visionJson({
    projectRoot,
    image: template.imageFile,
    system: BANNER_IMAGE_TEMPLATE_SYSTEM,
    text: "添付画像のバナー広告を分析し、指定JSON構造だけを返してください。商品固有のコピー・画像・オファー・証明要素を漏れなくプレースホルダーへ置換し、layoutBlueprintとcopyBlueprintを分離して、元カテゴリ、各要素の広告上の役割、心理メカニズム、訴求の流れ、文字数、原文、コピーパターンを記録してください。"
  });
  const normalizedPromptJson = normalizeTemplatePromptJson(promptJson);
  return {
    templatePromptJson: normalizedPromptJson,
    layoutBlueprint: normalizedPromptJson.layoutBlueprint,
    copyBlueprint: normalizedPromptJson.copyBlueprint,
    structureSheet: normalizedPromptJson.structureSheet || {
      source: "image_template",
      summary: (normalizedPromptJson.zones || []).map((zone) => `${zone.name || ""}: ${zone.position || ""} / ${zone.purpose || ""}`).join("\n")
    },
    templateZones: normalizedPromptJson.zones || [],
    templateGlobalDesign: normalizedPromptJson.globalDesign || null,
    templateColorScheme: normalizedPromptJson.colorScheme || null,
    templateReusePolicy: "構造レイヤーは維持し、デザインレイヤーは参考、コンテンツレイヤーは商品/WHO-WHATから新規作成する。",
    templateStatus: "template_ready",
    templateProcessingStatus: "completed",
    templateReadiness: buildTemplateReadiness(normalizedPromptJson, { imageFile: template.imageFile }),
    templateTextStoryboard: template.templateTextStoryboard || stringifyTemplateJson(normalizedPromptJson),
    successFactors: template.successFactors || normalizedPromptJson.globalDesign?.designRationale || normalizedPromptJson.reproduction?.keyPoints?.join(" / ") || ""
  };
}

export async function templateBannerImage(projectRoot, templateId, options = {}) {
  const patch = await analyzeBannerTemplateImage(projectRoot, templateId, options);
  return updateAdTemplate(projectRoot, templateId, patch);
}

async function findTemplate(projectRoot, templateId) {
  const templates = await listAdTemplates(projectRoot);
  const template = templates.find((item) => item.id === templateId);
  if (!template) throw new Error("広告テンプレが見つかりません: " + templateId);
  return template;
}

function stringifyTemplateJson(value) {
  return JSON.stringify(value, null, 2);
}

export function normalizeTemplatePromptJson(value) {
  const promptJson = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const zones = Array.isArray(promptJson.zones) ? normalizeTemplateZones(promptJson.zones) : [];
  const generatedDefinitions = collectVariableDefinitions(zones);
  const suppliedDefinitions = Array.isArray(promptJson.variableDefinitions) ? promptJson.variableDefinitions : [];
  const definitionsByPlaceholder = new Map();
  for (const item of generatedDefinitions) {
    const placeholder = String(item?.placeholder || "").trim();
    if (!placeholder) continue;
    definitionsByPlaceholder.set(placeholder, { ...item, placeholder });
  }
  for (const item of suppliedDefinitions) {
    const placeholder = String(item?.placeholder || "").trim();
    if (!isValidPlaceholder(placeholder)) continue;
    const generated = definitionsByPlaceholder.get(placeholder) || defaultVariableDefinition(placeholder);
    definitionsByPlaceholder.set(placeholder, {
      ...generated,
      ...item,
      placeholder,
      category: String(item?.category || generated.category),
      role: String(item?.role || generated.role),
      source: String(item?.source || generated.source),
      constraints: String(item?.constraints || generated.constraints),
      exampleOriginal: String(item?.exampleOriginal || generated.exampleOriginal || "")
    });
  }
  const variableDefinitions = [...definitionsByPlaceholder.values()].filter((item) => isValidPlaceholder(item.placeholder));
  const contentArchitecture = promptJson.contentArchitecture || inferContentArchitecture(zones);
  const layoutBlueprint = normalizeLayoutBlueprint(promptJson.layoutBlueprint, zones, contentArchitecture);
  const copyBlueprint = normalizeCopyBlueprint(promptJson.copyBlueprint, {
    zones,
    variableDefinitions,
    contentArchitecture,
    sourceCategoryProfile: promptJson.sourceCategoryProfile
  });
  return {
    ...promptJson,
    zones,
    contentArchitecture,
    variableDefinitions,
    layoutBlueprint,
    copyBlueprint
  };
}

function normalizeTemplateZones(zones) {
  return (Array.isArray(zones) ? zones : []).map((zone, zoneIndex) => ({
    ...zone,
    elements: (Array.isArray(zone?.elements) ? zone.elements : []).map((element, elementIndex) => {
      const slotId = String(element?.slotId || `z${zoneIndex + 1}e${elementIndex + 1}`);
      if (String(element?.type || "text").toLowerCase() !== "text") return element;
      const charCount = positiveInteger(element.charCount ?? element.characterCount);
      return {
        ...element,
        slotId,
        ...(charCount ? { charCount } : {})
      };
    })
  }));
}

export function buildTemplateReadiness(promptJson = {}, { imageFile = "" } = {}) {
  return buildTemplateReadinessState({
    imageFile,
    layoutBlueprint: promptJson.layoutBlueprint,
    copyBlueprint: promptJson.copyBlueprint
  });
}

function normalizeLayoutBlueprint(value, zones, contentArchitecture) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    version: 1,
    visualHierarchy: normalizeStringArray(source.visualHierarchy || contentArchitecture.visualHierarchy),
    eyeFlow: String(source.eyeFlow || contentArchitecture.eyeFlow || ""),
    zones: zones.map((zone) => ({
      name: String(zone.name || ""),
      position: zone.position || "",
      purpose: String(zone.purpose || ""),
      elements: (zone.elements || []).map((element, elementIndex) => ({
        type: String(element.type || "text"),
        slotId: String(element.slotId || `slot_${elementIndex + 1}`),
        role: String(element.role || ""),
        messageRole: String(element.messageRole || ""),
        position: element.position || {},
        size: element.size || "",
        effect: element.effect || ""
      }))
    }))
  };
}

function normalizeCopyBlueprint(value, { zones, variableDefinitions, contentArchitecture, sourceCategoryProfile }) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const suppliedSlots = new Map((Array.isArray(source.slots) ? source.slots : []).map((slot) => [String(slot?.slotId || ""), slot]));
  const slots = zones.flatMap((zone) => zone.elements || [])
    .filter((element) => String(element.type || "text").toLowerCase() === "text")
    .map((element) => {
      const supplied = suppliedSlots.get(String(element.slotId || "")) || {};
      const pattern = String(supplied.pattern || element.content || element.text || "");
      const originalText = String(supplied.originalText || element.originalText || restoreOriginalText(pattern, variableDefinitions));
      const role = String(supplied.role || element.role || "text");
      const messageRole = String(supplied.messageRole || element.messageRole || "");
      const optional = isOptionalCopySlot(role, messageRole);
      return {
        slotId: String(element.slotId || ""),
        role,
        messageRole,
        charBudget: positiveInteger(supplied.charBudget ?? element.charCount ?? element.characterCount) || estimateTextBudget(originalText || pattern),
        required: supplied.required === undefined ? !optional : supplied.required !== false,
        sourcePolicy: String(supplied.sourcePolicy || (/offer|cta|action/i.test(`${role} ${messageRole}`) ? "instruction_or_strategy" : "strategy_required")),
        emptyPolicy: String(supplied.emptyPolicy || (supplied.required === false || optional ? "allow" : "block")),
        originalText,
        pattern,
        variables: normalizeStringArray(supplied.variables || [...pattern.matchAll(/\{[^{}]+\}/g)].map((match) => match[0])).filter(isValidPlaceholder),
        rhetoricalDevice: String(supplied.rhetoricalDevice || ""),
        psychologicalMechanism: String(supplied.psychologicalMechanism || contentArchitecture.primaryHook?.targetResponse || "")
      };
    });
  return {
    version: 1,
    sourceCategoryProfile: normalizeSourceCategoryProfile(source.sourceCategoryProfile || sourceCategoryProfile, contentArchitecture),
    persuasionMechanism: {
      appealType: String(source.persuasionMechanism?.appealType || contentArchitecture.appealType || ""),
      primaryHookMechanism: String(source.persuasionMechanism?.primaryHookMechanism || contentArchitecture.primaryHook?.role || ""),
      targetResponse: String(source.persuasionMechanism?.targetResponse || contentArchitecture.primaryHook?.targetResponse || ""),
      messageFlow: normalizeStringArray(source.persuasionMechanism?.messageFlow || contentArchitecture.messageFlow),
      proofRole: String(source.persuasionMechanism?.proofRole || contentArchitecture.proofStrategy?.purpose || ""),
      offerRole: String(source.persuasionMechanism?.offerRole || contentArchitecture.offerStrategy?.ctaRole || "")
    },
    slots
  };
}

function isOptionalCopySlot(role, messageRole) {
  return /proof|reason|evidence|trust|offer|badge|disclaimer|note|caption|cta|action/i.test(`${role} ${messageRole}`);
}

function normalizeSourceCategoryProfile(value, contentArchitecture = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    category: String(source.category || contentArchitecture.appealType || "未分類"),
    subcategory: String(source.subcategory || ""),
    audience: String(source.audience || contentArchitecture.primaryHook?.targetResponse || ""),
    problem: String(source.problem || contentArchitecture.primaryHook?.pattern || ""),
    solutionType: String(source.solutionType || contentArchitecture.primaryHook?.role || ""),
    purchaseContext: String(source.purchaseContext || contentArchitecture.offerStrategy?.type || ""),
    keywords: normalizeStringArray(source.keywords)
  };
}

function restoreOriginalText(pattern, definitions) {
  let restored = String(pattern || "");
  for (const placeholder of [...restored.matchAll(/\{[^{}]+\}/g)].map((match) => match[0])) {
    const definition = definitions.find((item) => item.placeholder === placeholder);
    if (definition?.exampleOriginal) restored = restored.split(placeholder).join(String(definition.exampleOriginal));
  }
  return restored;
}

function normalizeStringArray(value) {
  return (Array.isArray(value) ? value : []).map((item) => String(item || "").trim()).filter(Boolean);
}

function estimateTextBudget(value) {
  return Math.max(1, String(value || "").replace(/\{[^{}]+\}/g, "値").replace(/[\s\u3000]/g, "").length);
}

function isValidPlaceholder(value) {
  return /^\{[^{}:"',\[\]]{1,80}\}$/.test(String(value || "").trim());
}

function collectVariableDefinitions(zones) {
  const definitions = [];
  const seen = new Set();
  for (const zone of zones) {
    for (const element of Array.isArray(zone?.elements) ? zone.elements : []) {
      const text = [element?.content, element?.description].filter(Boolean).join(" ");
      for (const match of text.matchAll(/\{[^{}]+\}/g)) {
        if (seen.has(match[0])) continue;
        seen.add(match[0]);
        definitions.push(defaultVariableDefinition(match[0], element.messageRole || element.role));
      }
    }
  }
  return definitions;
}

function defaultVariableDefinition(placeholder, role = "content") {
  return {
    placeholder,
    category: variableCategory(placeholder),
    role: String(role || "content"),
    source: variableSource(placeholder),
    constraints: "元要素と同程度の情報量・文字量を保ち、選択WHO-WHATに基づいて差し替える。",
    exampleOriginal: ""
  };
}

function inferContentArchitecture(zones) {
  const roles = zones.flatMap((zone) => (zone?.elements || []).map((element) => element?.messageRole || element?.role).filter(Boolean));
  return {
    appealType: "",
    messageFlow: roles,
    primaryHook: { role: roles[0] || "", pattern: "", targetResponse: "" },
    proofStrategy: { type: "", placement: "", purpose: "" },
    offerStrategy: { type: "", urgencyDevice: "", ctaRole: "" },
    visualHierarchy: zones.map((zone) => zone?.name || zone?.purpose).filter(Boolean),
    eyeFlow: ""
  };
}

function variableCategory(placeholder) {
  if (/価格|割引|特典|保証/.test(placeholder)) return "offer";
  if (/実績|成果|評価|受賞|権威|口コミ|メディア/.test(placeholder)) return "proof";
  if (/ターゲット|悩み|欲求|不安|ベネフィット|比較|選定/.test(placeholder)) return "strategy";
  if (/数値|期間/.test(placeholder)) return "fact";
  return "product";
}

function variableSource(placeholder) {
  const category = variableCategory(placeholder);
  if (category === "strategy") return "WHO-WHAT DB";
  if (category === "offer" || category === "proof" || category === "fact") return "選択WHO-WHAT";
  return "商品マスターDBまたは選択WHO-WHAT";
}

function positiveInteger(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : 0;
}

const BANNER_IMAGE_TEMPLATE_SYSTEM = loadPrompt("template-banner-image");
