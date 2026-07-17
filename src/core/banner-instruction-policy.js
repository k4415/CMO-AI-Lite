import crypto from "node:crypto";

const COPY_LOCK_PATTERN = /(?:コピー|文言|文字|テキスト).{0,12}(?:そのまま|変えない|変更しない|維持|固定)|(?:画像|ビジュアル|写真|人物|背景)だけ.{0,20}(?:変え|変更|差し替え|修正)/i;
const VISUAL_ONLY_PATTERN = /(?:画像|ビジュアル|写真|人物|背景)だけ.{0,20}(?:変え|変更|差し替え|修正)/i;
const NEGATIVE_CLAIM_PATTERN = /(?:入れない|含めない|使わない|使用しない|書かない|記載しない|避ける|禁止|削除|外す)/i;
const VISUAL_SCOPE_PATTERN = /(?:背景|色|カラー|配色|写真|人物|モデル|被写体|商品画像|ロゴ|構図|ビジュアル)/i;
const COPY_SCOPE_PATTERN = /(?:コピー|文言|見出し|CTA|オファー|訴求|切り口|主張|比較|数字)/i;
const CONTROL_PATTERN = /(?:案を?作|生成して|変更して|修正して|全案|兄弟案|同じ切り口|共通化|統一|揃え|固定する)/i;
const FACTUAL_CLAIM_PATTERN = /(?:[0-9０-９]|無料|割引|保証|限定|実績|ターゲット|担当者|依頼|制作|期間|費用|できる|かかる|短縮|改善|増やせる|減らせる)/i;

export function classifyAdditionalInstruction(rawInstruction = "") {
  const raw = String(rawInstruction || "").trim();
  const lines = raw.split(/[\n。]+/).map((line) => line.trim()).filter(Boolean);
  const forbiddenClaims = lines.filter((line) => NEGATIVE_CLAIM_PATTERN.test(line));
  const visualInstructions = lines.filter((line) => VISUAL_SCOPE_PATTERN.test(line) && !COPY_SCOPE_PATTERN.test(line));
  const authorizedClaims = lines.filter((line) => (
    !NEGATIVE_CLAIM_PATTERN.test(line)
    && !visualInstructions.includes(line)
    && !CONTROL_PATTERN.test(line)
    && FACTUAL_CLAIM_PATTERN.test(line)
  ));
  const fixedCopy = extractQuotedFixedCopy(raw);
  const requiredAngles = extractRequiredAngles(lines);
  const allowSiblingSimilarity = allowsSiblingSimilarity(raw);
  const hasCopy = authorizedClaims.length > 0
    || forbiddenClaims.length > 0
    || fixedCopy.length > 0
    || requiredAngles.length > 0
    || allowSiblingSimilarity
    || lines.some((line) => COPY_SCOPE_PATTERN.test(line));
  const hasVisual = lines.some((line) => VISUAL_SCOPE_PATTERN.test(line));
  return {
    rawInstruction: raw,
    authorizedClaims,
    forbiddenClaims,
    visualInstructions,
    fixedCopy,
    requiredAngles,
    allowSiblingSimilarity,
    similarityOverrideDimensions: inferSimilarityOverrideDimensions(raw),
    changeScope: hasCopy ? (hasVisual ? "copy_and_visual" : "copy_only") : (hasVisual ? "visual_only" : "none")
  };
}

export function buildInstructionPolicy(rawInstruction = "") {
  const intent = classifyAdditionalInstruction(rawInstruction);
  const copyLocked = COPY_LOCK_PATTERN.test(intent.rawInstruction);
  const visualOnly = VISUAL_ONLY_PATTERN.test(intent.rawInstruction);
  return {
    ...intent,
    protectedFields: copyLocked ? ["copyBrief", "imageText"] : [],
    editableFields: visualOnly ? ["imageElements"] : [],
    explicitOverrides: detectExplicitOverrides(intent.rawInstruction),
    interpretationNote: copyLocked
      ? "追加指示原文を正としてコピーを完全固定し、ビジュアルだけを編集する。"
      : "追加指示原文を正として生成工程へ渡す。"
  };
}

function extractQuotedFixedCopy(raw) {
  const values = [];
  for (const match of String(raw || "").matchAll(/[「『“\"]([^」』”\"]+)[」』”\"]/g)) {
    const prefix = String(raw).slice(Math.max(0, match.index - 24), match.index);
    if (/(?:見出し|コピー|文言|テキスト|そのまま|固定)/i.test(prefix)) values.push(match[1]);
  }
  const patterns = [
    /(?:見出し|コピー|文言|テキスト)を?(.+?)で固定(?:する|して|$)/i,
    /(?:コピー|文言|見出し)は(.+?)をそのまま使(?:う|って|用)/i
  ];
  for (const pattern of patterns) {
    const match = String(raw || "").match(pattern);
    if (match?.[1]) values.push(match[1].replace(/^[「『“\"]|[」』”\"]$/g, "").trim());
  }
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function extractRequiredAngles(lines) {
  return [...new Set(lines
    .filter((line) => /(?:切り口|訴求|角度|観点)/.test(line) && !NEGATIVE_CLAIM_PATTERN.test(line))
    .map((line) => line.replace(/(?:で|に)?(?:全案|兄弟案).*/, "").trim())
    .filter(Boolean))];
}

function inferSimilarityOverrideDimensions(raw) {
  const dimensions = [];
  if (/(?:同じ|共通|統一|揃え|固定).{0,12}(?:切り口|訴求)|(?:切り口|訴求).{0,12}(?:同じ|共通|統一|揃え|固定)/.test(raw)) dimensions.push("angle");
  if (/(?:同じ|共通|統一|揃え|固定).{0,12}(?:主?見出し|コピー|文言)|(?:主?見出し|コピー|文言).*?(?:同じ|共通|統一|揃え|固定|そのまま)/.test(raw)) dimensions.push("promise");
  return dimensions;
}

function allowsSiblingSimilarity(raw) {
  if (!raw) return false;
  return /(?:全案|兄弟案|各案)/.test(raw)
    && /(?:同じ|共通|統一|揃え|固定)/.test(raw)
    && /(?:コピー|文言|見出し|切り口|訴求|主張)/.test(raw);
}

export function createLockedContentSnapshot(banner = {}, template = null) {
  const copyBrief = clonePlainObject(banner.copyBrief);
  const imageText = String(banner.imageText || "");
  if (!copyBrief && !imageText.trim()) return null;
  const locked = { copyBrief, imageText };
  return {
    ...locked,
    templateAdId: String(banner.templateAdId || template?.id || ""),
    normalizedHash: hashLockedCopy(locked),
    createdAt: new Date().toISOString()
  };
}

export function hashLockedCopy(snapshot = {}) {
  const normalized = {
    copyBrief: snapshot?.copyBrief && typeof snapshot.copyBrief === "object" ? snapshot.copyBrief : null,
    imageText: String(snapshot?.imageText || "")
  };
  return crypto.createHash("sha256").update(stableStringify(normalized)).digest("hex");
}

export function ruleIsExplicitlyOverridden(rule = {}, instructionPolicy = {}) {
  const overrides = Array.isArray(instructionPolicy.explicitOverrides) ? instructionPolicy.explicitOverrides : [];
  if (!overrides.length) return false;
  const ruleScope = inferRuleScope(rule);
  if (ruleScope === "copy" && instructionPolicy.protectedFields?.includes("copyBrief")) return true;
  if (!overrides.some((item) => item.field === ruleScope)) return false;
  const pattern = String(rule.pattern || "").trim();
  return Boolean(pattern && instructionPolicy.rawInstruction?.includes(pattern) && isAffirmativeInstruction(instructionPolicy.rawInstruction));
}

function detectExplicitOverrides(raw) {
  if (!raw) return [];
  const fields = [];
  if (/(?:色|カラー|配色|背景色|文字色|アクセント|#[0-9a-f]{3,8}|赤|青|緑|黄|黒|白|ピンク|オレンジ|紫)/i.test(raw)) fields.push("color");
  if (/(?:画像|ビジュアル|写真|人物|モデル|被写体|背景|商品画像|ロゴ)/i.test(raw)) fields.push("image");
  if (/(?:トーン|雰囲気|テイスト|印象|世界観|高級|親しみ|信頼感)/i.test(raw)) fields.push("tone");
  if (/(?:コピー|文言|文字|テキスト|見出し|CTA|オファー)/i.test(raw)) fields.push("copy");
  return [...new Set(fields)].map((field) => ({ field, instruction: raw }));
}

function inferRuleScope(rule) {
  const text = `${rule.ruleType || ""} ${rule.pattern || ""} ${rule.description || ""}`.toLowerCase();
  if (/(?:color|colour|カラー|配色|色)/i.test(text)) return "color";
  if (/(?:image|visual|photo|画像|写真|人物|被写体|背景|ロゴ)/i.test(text)) return "image";
  if (/(?:tone|mood|トーン|雰囲気|テイスト|印象|世界観)/i.test(text)) return "tone";
  if (/(?:copy|text|コピー|文言|文字|見出し|cta|オファー)/i.test(text)) return "copy";
  return "";
}

function isAffirmativeInstruction(raw) {
  if (/(?:使わない|使用しない|避け|禁止|削除|外して|入れない|含めない)/i.test(raw)) return false;
  return /(?:使って|使用|残して|そのまま|維持|固定|必ず|変更しない|変えない|入れて|含めて|にする|でお願い)/i.test(raw);
}

function clonePlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return JSON.parse(JSON.stringify(value));
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
