export const COLOR_FIELDS = Object.freeze(["main", "sub", "accent", "background"]);

export const SAFE_BANNER_PALETTE = Object.freeze({
  main: "#1F2937",
  sub: "#FFFFFF",
  accent: "#F97316",
  background: "#F8FAFC"
});

const NAMED_COLORS = Object.freeze([
  ["オレンジ", "#F97316"], ["orange", "#F97316"],
  ["ゴールド", "#EAB308"], ["金色", "#EAB308"],
  ["イエロー", "#EAB308"], ["yellow", "#EAB308"], ["黄色", "#EAB308"], ["黄", "#EAB308"],
  ["ピンク", "#EC4899"], ["pink", "#EC4899"], ["桃色", "#EC4899"],
  ["パープル", "#7C3AED"], ["purple", "#7C3AED"], ["紫色", "#7C3AED"], ["紫", "#7C3AED"],
  ["グリーン", "#16A34A"], ["green", "#16A34A"], ["緑色", "#16A34A"], ["緑", "#16A34A"],
  ["ブルー", "#2563EB"], ["blue", "#2563EB"], ["シアン", "#2563EB"], ["水色", "#2563EB"], ["青色", "#2563EB"], ["青", "#2563EB"],
  ["レッド", "#DC2626"], ["red", "#DC2626"], ["赤色", "#DC2626"], ["赤", "#DC2626"],
  ["ブラック", "#111827"], ["black", "#111827"], ["黒色", "#111827"], ["黒", "#111827"],
  ["ホワイト", "#FFFFFF"], ["white", "#FFFFFF"], ["白色", "#FFFFFF"], ["白", "#FFFFFF"],
  ["グレー", "#6B7280"], ["grey", "#6B7280"], ["gray", "#6B7280"], ["灰色", "#6B7280"]
]);

const COLOR_TOKEN_PATTERN = /#[0-9a-f]{6}\b|#[0-9a-f]{3}\b|オレンジ|orange\b|ゴールド|金色|イエロー|yellow\b|黄(?:色|背景|地|(?=$|[\s、,。のをでとにへはが]))|ピンク|pink\b|桃色|パープル|purple\b|紫(?:色|背景|(?=$|[\s、,。のをでとにへはが]))|グリーン|green\b|緑(?:色|の|背景|(?=$|[\s、,。をでとにへはが]))|ブルー|blue\b|シアン|水色|青(?:色|い|背景|(?=$|[\s、,。のをでとにへはが]))|レッド|red\b|赤(?:色|い|背景|(?=$|[\s、,。のをでとにへはが]))|ブラック|black\b|黒(?:色|い|背景|字|(?=$|[\s、,。のをでとにへはが]))|ホワイト|white\b|(?<!余|空|面)白(?:色|い|地|背景|(?=$|[\s、,。のをでとにへはが]))|グレー|grey\b|gray\b|灰色/gi;

const ROLE_PATTERNS = Object.freeze({
  main: /メイン(?:カラー|色)?|基調(?:カラー|色)|primary(?:\s*color)?\b|main(?:\s*color)?\b/gi,
  sub: /サブ(?:カラー|色)?|補助(?:カラー|色)?|secondary(?:\s*color)?\b|sub(?:\s*color)?\b/gi,
  accent: /アクセント(?:カラー|色)?|cta(?:\s*color)?\b|ボタン(?:カラー|色)?|accent(?:\s*color)?\b/gi,
  background: /背景(?:カラー|色)?|background(?:\s*color)?\b/gi
});

const SOURCE_LABELS = Object.freeze({
  user_instruction: "追加指示・修正指示",
  regulation: "表現レギュレーション",
  official_brand: "正式ブランド指定",
  who_what_inference: "WHO-WHAT配色推論",
  template: "テンプレートフォールバック",
  safe_default: "安全な標準配色"
});

const FIELD_LABELS = Object.freeze({
  main: "メインカラー",
  sub: "サブカラー",
  accent: "アクセントカラー",
  background: "背景色"
});

export function normalizeColorValue(value) {
  const text = String(value ?? "").normalize("NFKC").trim();
  if (/^#[0-9a-f]{6}$/i.test(text)) return text.toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(text)) {
    return `#${text.slice(1).split("").map((character) => character.repeat(2)).join("")}`.toUpperCase();
  }
  const lower = text.toLowerCase();
  const exact = NAMED_COLORS.find(([name]) => name.toLowerCase() === lower)?.[1];
  if (exact) return exact;
  const base = lower.replace(/(?:背景|色|地|い|の|字)$/u, "");
  return NAMED_COLORS.find(([name]) => name.toLowerCase() === base)?.[1] || "";
}

export function normalizePalette(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const palette = {};
  for (const field of COLOR_FIELDS) {
    const color = normalizeColorValue(value[field]);
    if (color) palette[field] = color;
  }
  return palette;
}

export function extractPaletteFromText(value) {
  const text = String(value ?? "").normalize("NFKC");
  if (!text.trim()) return {};
  const colors = collectMatches(text, COLOR_TOKEN_PATTERN)
    .map((match) => ({ ...match, color: normalizeColorValue(match.value) }))
    .filter((match) => match.color);
  if (!colors.length) return {};

  const roles = Object.entries(ROLE_PATTERNS).flatMap(([field, pattern]) => (
    collectMatches(text, pattern).map((match) => ({ ...match, field }))
  ));
  for (const match of text.matchAll(/(?:白|ホワイト)\s*地/gi)) {
    roles.push({ field: "background", index: match.index || 0, length: match[0].length, value: match[0] });
  }
  roles.sort((left, right) => left.index - right.index);

  if (!roles.length) return colors.length === 1 ? { main: colors[0].color } : {};

  const palette = {};
  for (const role of roles) {
    const nearest = colors
      .map((color) => ({ color, distance: matchDistance(text, role, color) }))
      .filter((item) => item.distance <= 40)
      .sort((left, right) => left.distance - right.distance || left.color.index - right.color.index)[0]?.color;
    if (nearest) palette[role.field] = nearest.color;
  }
  return palette;
}

export function extractRegulationPalette(rules) {
  const palette = {};
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (!rule || rule.active === false) continue;
    const text = [rule.ruleType, rule.pattern, rule.description, rule.replacement, rule.note]
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .join("\n");
    Object.assign(palette, extractPaletteFromText(text));
  }
  return palette;
}

export function extractOfficialBrandPalette(product) {
  const source = product?.brandColor ?? product?.brandColors;
  return source && typeof source === "object" && !Array.isArray(source)
    ? normalizePalette(source)
    : extractPaletteFromText(source);
}

export function normalizeColorInference(value, strategy = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const reason = String(source.reason || "").trim();
  const evidence = (Array.isArray(source.evidence) ? source.evidence : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  const palette = normalizePalette(source.palette);
  const completePalette = COLOR_FIELDS.every((field) => palette[field]);
  const evidenceLinked = evidence.some((item) => evidenceReferencesStrategy(item, strategy));
  if (source.status !== "inferred" || !completePalette || !reason || !evidence.length || !evidenceLinked) {
    return {
      status: "insufficient",
      palette: {},
      reason: reason || (source.status === "insufficient" ? "insufficient" : "invalid_or_unverifiable_inference"),
      evidence: []
    };
  }
  return { status: "inferred", palette, reason, evidence };
}

export function resolveBannerColorDecision({
  userInstruction = "",
  expressionRules = [],
  product = {},
  strategy = {},
  template = {},
  safePalette = SAFE_BANNER_PALETTE
} = {}) {
  const inference = normalizeColorInference(strategy?.colorInference, strategy);
  const templatePalette = normalizePalette(template?.templateColorScheme || template?.templatePromptJson?.colorScheme);
  const normalizedSafePalette = { ...SAFE_BANNER_PALETTE, ...normalizePalette(safePalette) };
  const candidates = [
    ["user_instruction", extractPaletteFromText(userInstruction)],
    ["regulation", extractRegulationPalette(expressionRules)],
    ["official_brand", extractOfficialBrandPalette(product)],
    ["who_what_inference", inference.status === "inferred" ? inference.palette : {}],
    ["template", templatePalette],
    ["safe_default", normalizedSafePalette]
  ];
  const palette = {};
  const sourceByField = {};
  const reasonByField = {};

  for (const field of COLOR_FIELDS) {
    const winner = candidates.find(([, candidate]) => candidate[field]);
    palette[field] = winner[1][field];
    sourceByField[field] = winner[0];
    reasonByField[field] = colorReason(field, winner[0]);
  }

  const sourcesUsed = [...new Set(COLOR_FIELDS.map((field) => sourceByField[field]))];
  return {
    version: 2,
    palette,
    source: sourcesUsed.length === 1 ? sourcesUsed[0] : "mixed",
    sourceByField,
    reasonByField,
    sourcesUsed,
    templateFallbackFields: COLOR_FIELDS.filter((field) => sourceByField[field] === "template"),
    safeDefaultFields: COLOR_FIELDS.filter((field) => sourceByField[field] === "safe_default"),
    strategyInferenceStatus: inference.status,
    templatePaletteAvailable: Object.keys(templatePalette).length > 0
  };
}

function colorReason(field, source) {
  return `${SOURCE_LABELS[source] || source}の${FIELD_LABELS[field] || field}`;
}

function collectMatches(text, pattern) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return [...text.matchAll(new RegExp(pattern.source, flags))].map((match) => ({
    index: match.index || 0,
    length: match[0].length,
    value: match[0]
  }));
}

function matchDistance(text, left, right) {
  const leftEnd = left.index + left.length;
  const rightEnd = right.index + right.length;
  const between = right.index >= leftEnd
    ? text.slice(leftEnd, right.index)
    : text.slice(rightEnd, left.index);
  if (/[、,，;；\n。]/.test(between)) return Number.POSITIVE_INFINITY;
  const leftCenter = left.index + left.length / 2;
  const rightCenter = right.index + right.length / 2;
  const beforeRolePenalty = rightEnd <= left.index && !/^[\sのをはが:：=]*$/.test(between) ? 100 : 0;
  return Math.abs(leftCenter - rightCenter) + beforeRolePenalty;
}

function evidenceReferencesStrategy(evidence, strategy) {
  const normalizedEvidence = comparableEvidence(evidence);
  const evidenceBody = comparableEvidence(String(evidence || "").replace(/^[^:：]{1,24}[:：]\s*/, ""));
  if (!normalizedEvidence) return false;
  return strategyEvidenceValues(strategy).some((value) => {
    const normalizedValue = comparableEvidence(value);
    if (normalizedValue.length < 2) return false;
    return normalizedEvidence.includes(normalizedValue)
      || normalizedValue.includes(normalizedEvidence)
      || (evidenceBody.length >= 2 && (evidenceBody.includes(normalizedValue) || normalizedValue.includes(evidenceBody)));
  });
}

function strategyEvidenceValues(strategy) {
  return ["targetAttributes", "desire", "decisionCriteria", "productConcept", "benefit", "offer"]
    .flatMap((field) => flattenText(strategy?.[field]));
}

function flattenText(value) {
  if (Array.isArray(value)) return value.flatMap(flattenText);
  if (value && typeof value === "object") return Object.values(value).flatMap(flattenText);
  return String(value || "").split(/[\n、,]/).map((item) => item.trim()).filter(Boolean);
}

function comparableEvidence(value) {
  return String(value || "").normalize("NFKC").replace(/[\s:：・\-–—_()[\]{}「」『』]/g, "").toLowerCase();
}
