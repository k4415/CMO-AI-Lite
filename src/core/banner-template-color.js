import { COLOR_FIELDS, normalizeColorValue, normalizePalette } from "./banner-color-decision.js";

const COLOR_CONTEXT_NOUN = "極太|太|塗り|縁|影|光|光芒|発光|文字|字|見出し|コピー|枠|抜き|線|ライン|アウトライン|ベース|背景|地|雲|帯|円|丸|面|単色|装飾|フチ|グロー|シャドウ|ドロップ|リボン|ゴシック|アクセント|ハイライト|シルエット|CTA|ボタン|カード|価格|バッジ|スタンプ|タイル|吹き出し|パネル|ラベル|フッター|箱|容器|ボトル|商品|画像|写真|イラスト|手袋|錠剤|服|トップス|看板";
const COLOR_BOUNDARY = "[\\s、,。〜~・／/のをでとにへはが]";
const COLOR_MODIFIER = "(?:淡い|薄い|濃い|鮮やかな|明るい|暗い)\\s*";
const contextualColor = (name, suffixes = "色") => `${name}(?:${suffixes}|(?=${COLOR_CONTEXT_NOUN})|(?=$|${COLOR_BOUNDARY}))`;
const NAMED_COLOR_SOURCE = [
  "紫ピンク", "ピンク紫", "赤ピンク", "ブルーグリーン", "青緑(?:色|系)?", "黄緑(?:色|系)?", "赤紫(?:色|系)?", "青紫(?:色|系)?", "赤橙(?:色|系)?", "青灰(?:色|系)?", "紫紺(?:色|系)?", "黒緑(?:色|系)?", "黒紫(?:色|系)?", "黒赤(?:色|系)?", "白赤(?:色|系)?", "白青(?:色|系)?", "白黒(?:色|系)?", "青黒(?:色|系)?",
  "青白(?:色|い|く)?", "緑白(?:色|い|く)?", "赤白(?:色|い|く)?", "黒白(?:色|い|く)?",
  "深緑色?", "濃緑色?", "濃青色?", "濃紫色?", "濃グレー", "薄青色?", "薄緑色?", "薄紫色?", "淡青色?", "淡緑色?", "淡紫色?", "淡ピンク", "濃赤色?", "淡灰色?", "薄灰色?", "濃灰色?", "濃茶色?", "焦げ茶色?", "肌色", "深紅", "朱色", "生成り", "乳白色", "オフホワイト", "黄金",
  "淡色", "濃色", "暗色", "暖色", "寒色", "高彩度", "低彩度", "パステル(?:カラー)?", "カラフル", "虹色",
  "ダークブルー", "ライトブルー", "ライトグリーン", "ダークグリーン", "ローズ", "サーモン", "アプリコット", "ワインレッド", "赤茶色?", "トープ(?:ベージュ)?", "ボルドー", "マゼンタ", "コーラル", "ラベンダー", "エメラルド", "ターコイズ", "ティール", "ミント", "クリーム", "アイボリー", "ブラウン", "茶色", "カーキ", "シルバー", "銀色", "ゴールド", "金色",
  "イエロー", "オレンジ", "橙色?", contextualColor("黄", "色|系"),
  "レッド", contextualColor("赤", "色|い|く|み|系"),
  "ブルー", "シアン", "水色", contextualColor("青", "色|い|く|み(?:のある)?|系"),
  "グリーン", contextualColor("緑", "色|の|系"),
  "パープル", contextualColor("紫", "色|の|系"),
  "ピンク", "桃色", "ブラック", contextualColor("黒", "色|い|く|系"),
  "ホワイト", `(?<!余|空|面)${contextualColor("白", "色|い|く|系")}`,
  "グレー", "灰色", "ベージュ", "ネイビー", "濃紺", "紺色?",
  "\\b(?:red|blue|green|yellow|orange|pink|purple|black|white|gray|grey|gold|golden|beige|navy|silver|brown|teal|turquoise|mint|cream|ivory|magenta|coral|lavender|emerald|khaki|burgundy)\\b"
].join("|");

export const TEMPLATE_COLOR_TOKEN_PATTERN = new RegExp(`(?:#[0-9a-f]{3,8}\\b|(?:${COLOR_MODIFIER})?(?:${NAMED_COLOR_SOURCE}))`, "gi");
const NAMED_COLOR_PATTERN = new RegExp(`(?:(?:${COLOR_MODIFIER})?(?:${NAMED_COLOR_SOURCE}))`, "i");
const HEX_PATTERN = /#[0-9a-f]{3,8}\b/gi;
const VISUAL_ELEMENT_TYPES = new Set(["image", "photo", "illustration", "logo", "product"]);
const COLOR_DESIGN_FIELDS = new Set(["style", "fontPolicy", "contrastPolicy", "visualStyle", "gridAlignment"]);

export function buildColorNeutralTemplateDesign(templateGlobalDesign) {
  if (!templateGlobalDesign || typeof templateGlobalDesign !== "object" || Array.isArray(templateGlobalDesign)) return {};
  const result = {};
  for (const [key, value] of Object.entries(templateGlobalDesign)) {
    result[key] = COLOR_DESIGN_FIELDS.has(key) ? sanitizeNestedColorText(value) : cloneJsonValue(value);
  }
  return result;
}

export function buildColorNeutralTemplateZones(templateZones, templateColorScheme = {}) {
  const sourcePalette = normalizePalette(templateColorScheme);
  return (Array.isArray(templateZones) ? templateZones : []).map((zone) => {
    const nextZone = cloneJsonValue(zone) || {};
    delete nextZone.background;
    nextZone.backgroundColorRole = "background";
    nextZone.elements = (Array.isArray(zone?.elements) ? zone.elements : []).map((element) => {
      const next = cloneJsonValue(element) || {};
      const type = String(next.type || "text").toLowerCase();
      const visualAsset = VISUAL_ELEMENT_TYPES.has(type);
      const colorRole = visualAsset ? "" : paletteRoleForColor(next.color, sourcePalette) || inferColorRole(next);
      delete next.color;
      if (colorRole) next.colorRole = colorRole;
      else delete next.colorRole;
      if (typeof next.effect === "string") next.effect = stripTemplateColorTokens(next.effect);
      if (typeof next.font === "string") next.font = stripTemplateColorTokens(next.font);
      if (type === "shape") {
        if (typeof next.description === "string") next.description = stripTemplateColorTokens(next.description);
        if (typeof next.content === "string") next.content = stripTemplateColorTokens(next.content);
      }
      return next;
    });
    return nextZone;
  });
}

export function bindResolvedPaletteToZones(zones, palette) {
  const resolved = normalizePalette(palette);
  return (Array.isArray(zones) ? zones : []).map((zone) => {
    const nextZone = cloneJsonValue(zone) || {};
    const backgroundRole = COLOR_FIELDS.includes(nextZone.backgroundColorRole) ? nextZone.backgroundColorRole : "";
    if (backgroundRole && resolved[backgroundRole]) nextZone.background = resolved[backgroundRole];
    nextZone.elements = (Array.isArray(zone?.elements) ? zone.elements : []).map((element) => {
      const next = cloneJsonValue(element) || {};
      const type = String(next.type || "text").toLowerCase();
      if (VISUAL_ELEMENT_TYPES.has(type)) {
        delete next.color;
        delete next.colorRole;
        return next;
      }
      const colorRole = COLOR_FIELDS.includes(next.colorRole) ? next.colorRole : inferColorRole(next);
      if (resolved[colorRole]) {
        next.colorRole = colorRole;
        next.color = resolved[colorRole];
      }
      return next;
    });
    return nextZone;
  });
}

export function auditPromptColorContract({ promptJson = {}, templateColorScheme = {}, colorDecision = {} } = {}) {
  void templateColorScheme;
  const palette = normalizePalette(colorDecision?.palette || promptJson?.colorScheme);
  const allowedHex = new Set(Object.values(palette));
  const unexpectedHex = [];
  const unexpectedNamedColorPaths = [];
  const targets = collectAuditTargets(promptJson);

  for (const { path, value } of targets) {
    const text = String(value || "");
    for (const match of text.matchAll(new RegExp(HEX_PATTERN.source, HEX_PATTERN.flags))) {
      const normalized = normalizeColorValue(match[0]);
      if (normalized && !allowedHex.has(normalized)) unexpectedHex.push({ path, value: normalized });
    }
    if (NAMED_COLOR_PATTERN.test(text)) unexpectedNamedColorPaths.push(path);
  }

  return {
    status: unexpectedHex.length || unexpectedNamedColorPaths.length ? "failed" : "passed",
    unexpectedHex: uniqueObjects(unexpectedHex),
    unexpectedNamedColorPaths: [...new Set(unexpectedNamedColorPaths)]
  };
}

export function stripTemplateColorTokens(value) {
  return String(value || "")
    .replace(new RegExp(TEMPLATE_COLOR_TOKEN_PATTERN.source, TEMPLATE_COLOR_TOKEN_PATTERN.flags), "")
    .replace(/\s*(?:・|／|\/|と|や)\s*(?=(?:・|／|\/|と|や|、|,|。|$))/g, "")
    .replace(/(^|[、,，。;；])\s*(?:(?:と|や|の|を|で)\s*)+/g, "$1")
    .replace(/(?:から|〜|~)\s*へ(?:抜ける)?(?:の)?/g, "")
    .replace(/(^|[、,，。;；])\s*基調(?:に|と)?(?:した|する)?\s*/g, "$1")
    .replace(/(^|[、,，。;；])\s*地(?=に|で|と|の|$)/g, "$1背景")
    .replace(/(^|[、,，。;；])\s*字(?=で|を|と|の|$)/g, "$1文字")
    .replace(/の{2,}/g, "の")
    .replace(/の(?=(?:塗り|縁|影|光|文字|枠|抜き|線|ライン|アウトライン|ベース|雲|帯|円|面|単色|装飾|アクセント|ハイライト))/g, "")
    .replace(/([、,，。;；]){2,}/g, "$1")
    .replace(/^[\s、,，。;；・／/]+|[\s、,，;；・／/]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function sanitizeNestedColorText(value) {
  if (typeof value === "string") return stripTemplateColorTokens(value);
  if (Array.isArray(value)) return value.map(sanitizeNestedColorText);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sanitizeNestedColorText(child)]));
}

function paletteRoleForColor(value, palette) {
  const normalized = normalizeColorValue(value);
  if (!normalized) return "";
  return COLOR_FIELDS.find((field) => palette[field] === normalized) || "";
}

function inferColorRole(element) {
  const role = `${element?.role || ""} ${element?.messageRole || ""} ${element?.name || ""}`.toLowerCase();
  if (/background|backdrop|背景/.test(role)) return "background";
  if (/cta|offer|badge|action|button|オファー|特典|ボタン|行動/.test(role)) return "accent";
  if (/sub|secondary|divider|muted|補助|区切り/.test(role)) return "sub";
  if (/headline|body|caption|disclaimer|brand|text|見出し|本文|注記|ブランド/.test(role)) return "main";
  return String(element?.type || "text").toLowerCase() === "shape" ? "accent" : "main";
}

function collectAuditTargets(promptJson) {
  const targets = [];
  pushNestedTargets(targets, "globalDesign.style", promptJson?.globalDesign?.style);
  pushNestedTargets(targets, "globalDesign.fontPolicy", promptJson?.globalDesign?.fontPolicy);
  pushNestedTargets(targets, "globalDesign.contrastPolicy", promptJson?.globalDesign?.contrastPolicy);
  pushNestedTargets(targets, "globalDesign.visualStyle", promptJson?.globalDesign?.visualStyle);
  for (const [zoneIndex, zone] of (Array.isArray(promptJson?.zones) ? promptJson.zones : []).entries()) {
    targets.push({ path: `zones[${zoneIndex}].background`, value: zone?.background });
    for (const [elementIndex, element] of (Array.isArray(zone?.elements) ? zone.elements : []).entries()) {
      const prefix = `zones[${zoneIndex}].elements[${elementIndex}]`;
      targets.push({ path: `${prefix}.color`, value: element?.color });
      targets.push({ path: `${prefix}.effect`, value: element?.effect });
      if (String(element?.type || "").toLowerCase() === "shape") {
        targets.push({ path: `${prefix}.content`, value: element?.content || element?.description });
      }
    }
  }
  return targets.filter((item) => item.value !== undefined && item.value !== null && item.value !== "");
}

function pushNestedTargets(targets, path, value) {
  if (typeof value === "string") {
    targets.push({ path, value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => pushNestedTargets(targets, `${path}[${index}]`, child));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) pushNestedTargets(targets, `${path}.${key}`, child);
  }
}

function uniqueObjects(values) {
  const seen = new Set();
  return values.filter((value) => {
    const key = `${value.path}\n${value.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cloneJsonValue(value) {
  if (value === undefined) return undefined;
  return value && typeof value === "object" ? structuredClone(value) : value;
}
