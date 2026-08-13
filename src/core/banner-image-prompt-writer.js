import { anthropicJson } from "./anthropic-text.js";
import { loadPrompt } from "./prompt-files.js";

const WRITER_SYSTEM = loadPrompt("banner-image-prompt-writer");
const MIN_PROSE_CHARS = 200;

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
    diversityGuidance
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
        model
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
  diversityGuidance
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
    "戦略: " + JSON.stringify({
      id: strategy?.id || "",
      targetAttributes: strategy?.targetAttributes || strategy?.target || "",
      desire: strategy?.desire || "",
      benefit: strategy?.benefit || "",
      offer: strategy?.offer || ""
    }),
    "タイポグラフィ参照（文言は書かない）: " + JSON.stringify(slots),
    "配色palette: " + JSON.stringify(colorDecision?.palette || {}),
    "テンプレ構造契約: " + JSON.stringify(templateStructureContract || {}),
    "選択素材の配置マップ: " + JSON.stringify(selectedAssetPlacements || []),
    "追加指示方針: " + JSON.stringify(instructionPolicy || {}),
    "多様性方針: " + JSON.stringify(diversityGuidance || {}),
    "promptJson: " + JSON.stringify(promptJson || {})
  ].join("\n");
}
