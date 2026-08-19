import { anthropicJson } from "./anthropic-text.js";
import { listUniqueBrandColors } from "./banner-color-decision.js";
import { loadPrompt } from "./prompt-files.js";

const WRITER_SYSTEM = loadPrompt("banner-image-prompt-writer");
const MIN_PROSE_CHARS = 200;
const WRITER_HEADER_LINE_PATTERNS = [
  /^形式[：:]/,
  /^目的・戦略[：:]/,
  /^スタイル・トーン[：:]/
];
const WRITER_HEADER_SANITIZE_PATTERN = /^(形式|目的・戦略|スタイル・トーン)[：:]/;
// コピー開発用の予算を継承すると散文が途中で切れるため、ライター専用の枠を持つ。
const WRITER_MAX_TOKENS = Number(process.env.CMOAI_PROMPT_WRITER_MAX_TOKENS) || 8000;
const STRATEGY_MARKDOWN_CLIP = 12000;
// 実測55〜81秒。prompt工程のリースを超えないよう上限を明示する。
const WRITER_TIMEOUT_MS = Number(process.env.CMOAI_PROMPT_WRITER_TIMEOUT_MS) || 180000;

export async function writeBannerImagePrompt({
  promptJson,
  product,
  strategy,
  copyBrief,
  creativeHypothesis,
  colorDecision,
  templateStructureContract,
  selectedAssetPlacements,
  instructionPolicy,
  diversityGuidance,
  expressionRules,
  jsonGenerator = anthropicJson
} = {}) {
  const model = resolveWriterModel();
  const user = buildWriterUserPrompt({
    promptJson,
    product,
    strategy,
    copyBrief,
    creativeHypothesis,
    colorDecision,
    templateStructureContract,
    selectedAssetPlacements,
    instructionPolicy,
    diversityGuidance,
    expressionRules
  });
  const slotTexts = Array.isArray(copyBrief?.slotTexts) ? copyBrief.slotTexts : [];
  const attempts = [];
  let lastOutputChars = 0;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const startedAt = Date.now();
    const attemptRecord = {
      attempt,
      durationMs: 0,
      ok: false,
      errorClass: "api_error",
      outputChars: 0
    };
    try {
      const parsed = await jsonGenerator({
        system: WRITER_SYSTEM,
        user,
        model,
        maxTokens: WRITER_MAX_TOKENS,
        timeoutMs: WRITER_TIMEOUT_MS
      });
      const rawPrompt = String(parsed?.writtenImagePrompt || "");
      const rawNotes = String(parsed?.styleNotes || "");
      lastOutputChars = rawPrompt.length + rawNotes.length;
      attemptRecord.outputChars = lastOutputChars;
      attemptRecord.durationMs = Date.now() - startedAt;
      if (!hasWriterHeaderContract(rawPrompt)) {
        attemptRecord.errorClass = "header_missing";
        attempts.push(attemptRecord);
        continue;
      }
      const writtenImagePrompt = sanitizeWriterText(rawPrompt, slotTexts);
      const styleNotes = sanitizeWriterText(rawNotes, slotTexts);
      if (effectiveCharCount(writtenImagePrompt) < MIN_PROSE_CHARS) {
        attemptRecord.errorClass = "too_short";
        attempts.push(attemptRecord);
        continue;
      }
      attemptRecord.ok = true;
      attemptRecord.errorClass = "";
      attempts.push(attemptRecord);
      return {
        writtenImagePrompt,
        styleNotes,
        writerAudit: buildWriterAudit({ model, attempts, outputChars: lastOutputChars, fallback: false })
      };
    } catch (error) {
      attemptRecord.durationMs = Date.now() - startedAt;
      attemptRecord.errorClass = classifyWriterError(error);
      attempts.push(attemptRecord);
    }
  }

  return {
    writtenImagePrompt: "",
    styleNotes: "",
    writerAudit: buildWriterAudit({
      model,
      attempts,
      outputChars: lastOutputChars,
      fallback: true
    })
  };
}

function classifyWriterError(error) {
  const message = String(error?.message || error || "");
  const name = String(error?.name || "");
  if (name === "TimeoutError" || name === "AbortError" || /時間内に完了しなかった|timeout/i.test(message)) {
    return "timeout";
  }
  if (/JSON形式ではありません|Unexpected token|JSON\.parse/i.test(message)) {
    return "parse_error";
  }
  return "api_error";
}

function resolveWriterModel() {
  const configured = String(process.env.CMOAI_PROMPT_WRITER_MODEL || "").trim();
  return configured || "claude-sonnet-5";
}

function buildWriterAudit({ model, attempts, outputChars, fallback }) {
  const normalizedAttempts = (Array.isArray(attempts) ? attempts : []).map((entry) => ({
    attempt: entry.attempt,
    durationMs: nonNegativeInteger(entry.durationMs),
    ok: entry.ok === true,
    errorClass: entry.ok === true ? "" : cleanErrorClass(entry.errorClass),
    outputChars: nonNegativeInteger(entry.outputChars)
  }));
  return {
    model,
    calls: normalizedAttempts.length,
    outputChars: Number(outputChars) || 0,
    outcome: fallback ? "failed" : "completed",
    fallback,
    attempts: normalizedAttempts
  };
}

function cleanErrorClass(value) {
  const allowed = new Set(["timeout", "api_error", "parse_error", "header_missing", "too_short"]);
  const text = String(value || "").trim();
  return allowed.has(text) ? text : "api_error";
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function hasWriterHeaderContract(rawText) {
  const nonEmptyLines = String(rawText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (nonEmptyLines.length < WRITER_HEADER_LINE_PATTERNS.length) return false;
  return WRITER_HEADER_LINE_PATTERNS.every((pattern, index) => pattern.test(nonEmptyLines[index]));
}

function sanitizeWriterText(text, slotTexts) {
  const phrases = (Array.isArray(slotTexts) ? slotTexts : [])
    .map((slot) => String(slot?.text || "").trim())
    .filter((phrase) => phrase.length >= 4);
  return String(text || "")
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (WRITER_HEADER_SANITIZE_PATTERN.test(trimmed)) return true;
      return !phrases.some((phrase) => line.includes(phrase));
    })
    .join("\n")
    .trim();
}

function effectiveCharCount(text) {
  return String(text || "").trim().length;
}

function buildWriterUserPrompt({
  promptJson,
  product,
  strategy,
  copyBrief,
  creativeHypothesis,
  colorDecision,
  templateStructureContract,
  selectedAssetPlacements,
  instructionPolicy,
  diversityGuidance,
  expressionRules
}) {
  const slots = (Array.isArray(copyBrief?.slotTexts) ? copyBrief.slotTexts : []).map((slot) => ({
    slotId: String(slot?.slotId || ""),
    role: String(slot?.role || slot?.canonicalField || "")
  }));
  const hypothesisBlock = formatCreativeHypothesisBlock(creativeHypothesis, copyBrief);
  return [
    "次の確定構造から、gpt-image-2向けの完成イメージ散文を書いてください。コピー文言は出力に含めないでください。",
    "商品: " + JSON.stringify({
      id: product?.id || "",
      name: product?.name || "",
      category: product?.category || ""
    }),
    // markdownがWHO-WHATの正本。旧構造化項目はmarkdownがない旧データのフォールバック。
    "戦略: " + JSON.stringify({
      id: strategy?.id || "",
      conceptName: strategy?.conceptName || "",
      segmentName: strategy?.segmentName || "",
      markdown: String(strategy?.markdown || "").slice(0, STRATEGY_MARKDOWN_CLIP),
      targetAttributes: strategy?.targetAttributes || strategy?.target || "",
      desire: strategy?.desire || "",
      benefit: strategy?.benefit || "",
      offer: strategy?.offer || ""
    }),
    hypothesisBlock,
    "タイポグラフィ参照（文言は書かない）: " + JSON.stringify(slots),
    formatBrandColorBoundary(colorDecision?.palette),
    formatExpressionRulesForWriter(expressionRules, product),
    "テンプレ構造契約: " + JSON.stringify(templateStructureContract || {}),
    "選択素材の配置マップ: " + JSON.stringify(selectedAssetPlacements || []),
    "追加指示方針: " + JSON.stringify(instructionPolicy || {}),
    "多様性方針: " + JSON.stringify(diversityGuidance || {}),
    "promptJson: " + JSON.stringify(promptJson || {})
  ].filter(Boolean).join("\n");
}

function formatCreativeHypothesisBlock(creativeHypothesis, copyBrief) {
  const hypothesis = creativeHypothesis && typeof creativeHypothesis === "object" ? creativeHypothesis : null;
  const brief = copyBrief && typeof copyBrief === "object" ? copyBrief : null;
  const summary = {
    appealAxis: cleanText(brief?.appealAxis || hypothesis?.chosenAngle),
    audienceAttribute: cleanText(hypothesis?.audienceAttribute),
    targetMoment: cleanText(hypothesis?.targetMoment || brief?.targetMoment),
    barrier: cleanText(hypothesis?.barrier),
    primaryPromise: cleanText(hypothesis?.primaryPromise),
    templateMechanism: cleanText(hypothesis?.templateMechanism),
    visualIntent: {
      scene: cleanText(hypothesis?.visualIntent?.scene),
      motif: cleanText(hypothesis?.visualIntent?.motif)
    }
  };
  if (!summary.visualIntent.scene && !summary.visualIntent.motif) delete summary.visualIntent;
  const hasContent = Object.entries(summary).some(([key, value]) => {
    if (key === "visualIntent") return Boolean(value?.scene || value?.motif);
    return Boolean(value);
  });
  if (!hasContent) return "";
  return "訴求仮説要点（creativeHypothesis）: " + JSON.stringify(summary);
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function formatBrandColorBoundary(palette) {
  const colors = listUniqueBrandColors(palette);
  if (!colors.length) return "カラーアンカー:";
  return `カラーアンカー: ${colors.join(" / ")}`;
}

function formatExpressionRulesForWriter(expressionRules, product) {
  const rules = sortExpressionRulesByCreatedAt(scopeExpressionRules(expressionRules, product));
  return [
    "表現レギュレーション（原文・記載順。見出しと配下項目の関係を読み取ること）:",
    ...rules.map((rule) => `- ${rule.description || rule.pattern || ""}`)
  ].join("\n");
}

function scopeExpressionRules(expressionRules, product) {
  return (Array.isArray(expressionRules) ? expressionRules : []).filter((item) => (
    item.active !== false && (!product?.id || !item.productId || item.productId === product.id)
  ));
}

function sortExpressionRulesByCreatedAt(rules) {
  return [...rules].sort((left, right) => String(left?.createdAt || "").localeCompare(String(right?.createdAt || "")));
}
