import { anthropicJson } from "./anthropic-text.js";
import { listUniqueBrandColors } from "./banner-color-decision.js";
import { loadPrompt } from "./prompt-files.js";

const WRITER_SYSTEM = loadPrompt("banner-image-prompt-writer");
const MIN_PROSE_CHARS = 200;
// コピー開発用の予算を継承すると散文が途中で切れるため、ライター専用の枠を持つ。
const WRITER_MAX_TOKENS = Number(process.env.CMOAI_PROMPT_WRITER_MAX_TOKENS) || 8000;
// 実測55〜81秒。prompt工程のリースを超えないよう上限を明示する。
const WRITER_TIMEOUT_MS = Number(process.env.CMOAI_PROMPT_WRITER_TIMEOUT_MS) || 180000;

export async function writeBannerImagePrompt({
  promptJson,
  product,
  strategy,
  copyBrief,
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
    colorDecision,
    templateStructureContract,
    selectedAssetPlacements,
    instructionPolicy,
    diversityGuidance,
    expressionRules
  });
  const slotTexts = Array.isArray(copyBrief?.slotTexts) ? copyBrief.slotTexts : [];
  const calls = [];
  let lastOutputChars = 0;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const startedAt = Date.now();
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
      calls.push({
        attempt,
        model,
        outputChars: lastOutputChars,
        durationMs: Date.now() - startedAt,
        ok: true
      });
      const writtenImagePrompt = sanitizeWriterText(rawPrompt, slotTexts);
      const styleNotes = sanitizeWriterText(rawNotes, slotTexts);
      if (effectiveCharCount(writtenImagePrompt) < MIN_PROSE_CHARS) {
        continue;
      }
      return {
        writtenImagePrompt,
        styleNotes,
        writerAudit: buildWriterAudit({ model, calls, outputChars: lastOutputChars, fallback: false })
      };
    } catch {
      calls.push({
        attempt,
        model,
        outputChars: 0,
        durationMs: Date.now() - startedAt,
        ok: false
      });
    }
  }

  return {
    writtenImagePrompt: "",
    styleNotes: "",
    writerAudit: buildWriterAudit({
      model,
      calls,
      outputChars: lastOutputChars,
      fallback: true
    })
  };
}

function resolveWriterModel() {
  const configured = String(process.env.CMOAI_PROMPT_WRITER_MODEL || "").trim();
  return configured || "claude-opus-5";
}

function buildWriterAudit({ model, calls, outputChars, fallback }) {
  return {
    model,
    calls: calls.length,
    outputChars: Number(outputChars) || 0,
    outcome: fallback ? "failed" : "completed",
    fallback
  };
}

function sanitizeWriterText(text, slotTexts) {
  const phrases = (Array.isArray(slotTexts) ? slotTexts : [])
    .map((slot) => String(slot?.text || "").trim())
    .filter((phrase) => phrase.length >= 4);
  return String(text || "")
    .split(/\r?\n/)
    .filter((line) => !phrases.some((phrase) => line.includes(phrase)))
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
      markdown: String(strategy?.markdown || "").slice(0, 3000),
      targetAttributes: strategy?.targetAttributes || strategy?.target || "",
      desire: strategy?.desire || "",
      benefit: strategy?.benefit || "",
      offer: strategy?.offer || ""
    }),
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

function formatBrandColorBoundary(palette) {
  const colors = listUniqueBrandColors(palette);
  if (!colors.length) return "ブランドカラー（この範囲で構成する）:";
  return `ブランドカラー（この範囲で構成する）: ${colors.join(" / ")}`;
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
