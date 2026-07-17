import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { geminiVisionText } from "./gemini-text.js";
import { openAiVisionText } from "./openai-text.js";

const DEFAULT_LOCAL_OCR_LANG = process.env.CMOAI_LOCAL_OCR_LANG || "jpn";
const CONTINUITY_TAIL_CHARS = 400;
const OCR_CACHE_DIR = path.resolve(process.cwd(), ".cache", "tesseract");

export async function transcribeLpScreenshots(projectRoot, material, options = {}) {
  const configuredLimit = Number(process.env.CMOAI_LP_TRANSCRIBE_MAX_SLICES || process.env.CMOAI_SCREENSHOT_MAX_SLICES || 0);
  const allImages = Array.isArray(material.screenshotUrls) ? material.screenshotUrls : [];
  const plannedIndexes = Array.isArray(material.visionSliceIndexes)
    ? material.visionSliceIndexes.filter((index) => Number.isInteger(index) && index >= 0 && index < allImages.length)
    : allImages.map((_, index) => index);
  const limitedIndexes = Number.isFinite(configuredLimit) && configuredLimit > 0 ? plannedIndexes.slice(0, configuredLimit) : plannedIndexes;
  const images = limitedIndexes.map((index) => allImages[index]);
  const domEvidence = String(material.lpDomEvidence || "").trim();
  if (!images.length) {
    return {
      text: domEvidence,
      summary: domEvidence ? `DOM本文と画像altから抽出しました（Vision呼び出し 0/${allImages.length}枚）` : "",
      analyses: domEvidence ? [domEvidence] : [],
      totalSlices: allImages.length,
      processedSlices: 0,
      skippedSlices: allImages.length,
      provider: "dom"
    };
  }

  const visionMaterial = {
    ...material,
    screenshotUrls: images,
    screenshotSlices: limitedIndexes.map((index) => material.screenshotSlices?.[index]).filter(Boolean)
  };

  const mode = String(options.provider || process.env.CMOAI_OCR_MODE || "openai").toLowerCase();
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  let result;
  if (mode === "gemini") result = await transcribeWithGemini(projectRoot, visionMaterial, images, onProgress);
  else if (mode === "local") result = await transcribeWithLocalOcr(projectRoot, images);
  else if (mode === "both") result = await transcribeWithBoth(projectRoot, visionMaterial, images);
  else result = await transcribeWithOpenAi(projectRoot, visionMaterial, images, onProgress);
  // 制限(CMOAI_LP_TRANSCRIBE_MAX_SLICES等)で一部のスクショのみを処理した場合に、呼び出し側が「N/M枚」をjob stepsに記録できるようにする。
  const text = [domEvidence, result.text].filter(Boolean).join("\n\n---\n\n");
  const summary = [
    result.summary,
    plannedIndexes.length < allImages.length ? `DOM/alt/重複判定によりVision ${allImages.length - plannedIndexes.length}枚を省略` : ""
  ].filter(Boolean).join(" / ");
  return { ...result, text, summary, totalSlices: allImages.length, processedSlices: images.length, skippedSlices: allImages.length - images.length };
}

export async function analyzeLpScreenshots(projectRoot, material, options = {}) {
  return transcribeLpScreenshots(projectRoot, material, options);
}

async function transcribeWithGemini(projectRoot, material, images, onProgress) {
  const parts = [];
  const errors = [];
  let successCount = 0;
  let previousTail = "";

  for (let index = 0; index < images.length; index += 1) {
    try {
      const cleaned = await withRetryOnce(async () => {
        const result = await geminiVisionText({
          projectRoot,
          images: [images[index]],
          system: LP_VISIBLE_TRANSCRIPTION_PROMPT,
          text: buildScreenshotPrompt(material, index, images.length, previousTail)
        });
        const stripped = stripCodeFence(result.text);
        const quality = transcriptQuality(stripped);
        if (!quality.ok) throw new Error(quality.reason);
        return stripped;
      });
      successCount += 1;
      previousTail = cleaned.slice(-CONTINUITY_TAIL_CHARS);
      parts.push(formatScreenshotPart(index, cleaned, getScreenshotMeta(material, index)));
    } catch (error) {
      errors.push(`スクリーンショット ${index + 1}: ${error.message}`);
      parts.push(formatScreenshotPart(index, `[Gemini文字起こし失敗: ${error.message}]`));
    }
    if (onProgress) await onProgress({ processed: index + 1, total: images.length });
  }

  if (!successCount && errors.length) {
    return {
      text: "",
      summary: "Gemini文字起こしに失敗しました。",
      analyses: [],
      error: errors.join("\n"),
      errors
    };
  }

  const text = parts.join("\n\n---\n\n");
  return {
    text,
    summary: errors.length
      ? `GeminiでLPスクリーンショット ${images.length} 枚を処理しました。一部失敗: ${errors.length}件`
      : `GeminiでLPスクリーンショット ${images.length} 枚を文字起こししました。`,
    analyses: parts,
    errors,
    provider: "gemini"
  };
}

async function transcribeWithOpenAi(projectRoot, material, images, onProgress) {
  const parts = [];
  const errors = [];
  let successCount = 0;
  let previousTail = "";

  for (let index = 0; index < images.length; index += 1) {
    try {
      const cleaned = await withRetryOnce(async () => {
        const text = await openAiVisionText({
          projectRoot,
          image: images[index],
          system: LP_VISIBLE_TRANSCRIPTION_PROMPT,
          text: buildScreenshotPrompt(material, index, images.length, previousTail)
        });
        const stripped = stripCodeFence(text);
        const quality = transcriptQuality(stripped);
        if (!quality.ok) throw new Error(quality.reason);
        return stripped;
      });
      successCount += 1;
      previousTail = cleaned.slice(-CONTINUITY_TAIL_CHARS);
      parts.push(formatScreenshotPart(index, cleaned, getScreenshotMeta(material, index)));
    } catch (error) {
      errors.push(`スクリーンショット ${index + 1}: ${error.message}`);
      parts.push(formatScreenshotPart(index, `[AI文字起こし失敗: ${error.message}]`));
    }
    if (onProgress) await onProgress({ processed: index + 1, total: images.length });
  }

  if (!successCount && errors.length) {
    return {
      text: "",
      summary: "AI Vision文字起こしに失敗しました。",
      analyses: [],
      error: errors.join("\n"),
      errors
    };
  }

  const text = parts.join("\n\n---\n\n");
  return {
    text,
    summary: errors.length
      ? `AI VisionでLPスクリーンショット ${images.length} 枚を処理しました。一部失敗: ${errors.length}件`
      : `AI VisionでLPスクリーンショット ${images.length} 枚を文字起こししました。`,
    analyses: parts,
    errors
  };
}

function buildScreenshotPrompt(material, index, total, previousTail = "") {
  const meta = getScreenshotMeta(material, index);
  const metaLines = meta ? [
    `Capture y-range: ${meta.yStart}px-${meta.yEnd}px of page height ${meta.pageHeight}px`,
    `Viewport: ${meta.viewportWidth}x${meta.viewportHeight}px`,
    `Overlap: top ${meta.overlapTop}px / bottom ${meta.overlapBottom}px`,
    "Use overlap areas only to recover boundary continuity; do not duplicate the same visible content from adjacent screenshots."
  ] : [];
  const continuityLines = previousTail ? [
    "",
    "前のスクリーンショットの書き起こし末尾(参考用。この文言自体を再掲しないこと):",
    "---",
    previousTail,
    "---",
    "この末尾と同じ内容がこの画像の上部(オーバーラップ部分)に見える場合は重複させず、その続きから書き起こしてください。文章や見出しが前の画像とこの画像にまたがっている場合は、不自然に途切れさせず一つの流れとして続けて書き起こしてください。"
  ] : [];
  return [
    "対象URL: " + (material.sourceUrl || ""),
    "資料名: " + (material.title || ""),
    `これはLP全体を上から下まで分割したスクリーンショットの ${index + 1} / ${total} 枚目です。`,
    ...metaLines,
    ...continuityLines,
    "",
    "LPを上から下まで、表示される順番のまま文字起こししてください。",
    "",
    "【ルール】",
    "- テキストは表示されている通りに書き起こす（要約言い換え禁止）",
    "- 画像/GIF/動画がある箇所は【画像】【GIF】【動画】と明記し、その中に見える内容をすべて書き起こす",
    "- 【画像】【GIF】【動画】には、見える範囲の色、構図、配置、被写体、イラスト、背景、強調表示、CTA、バナー、デザイン詳細も簡潔に含める",
    "- ボタンやリンクは【ボタン：】【リンク：】と記載",
    "- 改行区切り、色強調、太字、下線、赤字、吹き出し、囲み、カード、ラベルなどもわかる範囲で再現",
    "- 分析、解釈、役割、マーケティング意味の説明は一切不要",
    "- Section分けや項目名（見出し、本文、CTA、Visual analysis、Marketing facts等）のラベル付けは不要",
    "- 読めない文字は推測せず【判読不能】と書く",
    "- 画面上端または下端で切れている要素は【途中で切れている】と添える",
    "",
    "【出力形式】",
    "上から順番に、見たままをそのまま羅列する。",
    "推測サンプル生成は禁止。対象LPに表示されている内容のみを書き起こすこと。"
  ].join("\n");
}

async function transcribeWithBoth(projectRoot, material, images) {
  const ai = await transcribeWithOpenAi(projectRoot, material, images);
  const local = await transcribeWithLocalOcr(projectRoot, images).catch((error) => ({
    text: "",
    summary: "ローカルOCRに失敗しました: " + error.message,
    analyses: [],
    errors: [error.message]
  }));
  return {
    text: [
      "## AI Vision結果",
      ai.text,
      local.text ? "## ローカルOCR参考結果\n\n" + local.text : ""
    ].filter(Boolean).join("\n\n---\n\n"),
    summary: [ai.summary, local.summary].filter(Boolean).join("\n"),
    analyses: [...(ai.analyses || []), ...(local.analyses || [])],
    errors: [...(ai.errors || []), ...(local.errors || [])]
  };
}

async function transcribeWithLocalOcr(projectRoot, images) {
  const parts = [];
  const errors = [];
  for (let index = 0; index < images.length; index += 1) {
    try {
      const imagePath = resolveScreenshotPath(projectRoot, images[index]);
      const text = await runTesseract(imagePath);
      const cleaned = cleanOcrText(text);
      parts.push(formatScreenshotPart(index, cleaned || "[文字を検出できませんでした]"));
    } catch (error) {
      errors.push(`スクリーンショット ${index + 1}: ${error.message}`);
      parts.push(formatScreenshotPart(index, `[ローカルOCR失敗: ${error.message}]`));
    }
  }
  return {
    text: parts.join("\n\n---\n\n"),
    summary: errors.length
      ? `ローカルOCRでLPスクリーンショット ${images.length} 枚を処理しました。一部失敗: ${errors.length}件`
      : `ローカルOCRでLPスクリーンショット ${images.length} 枚を文字起こししました。`,
    analyses: parts,
    errors
  };
}

async function runTesseract(imagePath) {
  const mod = await import("tesseract.js");
  const recognize = mod.recognize || mod.default?.recognize;
  if (!recognize) throw new Error("tesseract.js の recognize API が見つかりません。");
  await fs.mkdir(OCR_CACHE_DIR, { recursive: true });
  const result = await recognize(imagePath, DEFAULT_LOCAL_OCR_LANG, { cachePath: OCR_CACHE_DIR });
  return result?.data?.text || "";
}

function resolveScreenshotPath(projectRoot, src) {
  const raw = String(src || "");
  let relativePath = raw;
  if (raw.startsWith("/project-file")) {
    const url = new URL(raw, "http://localhost");
    relativePath = url.searchParams.get("path") || "";
  } else if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    relativePath = url.searchParams.get("path") || url.pathname;
  } else if (raw.startsWith("file:")) {
    return fileURLToPath(raw);
  }
  if (!relativePath) throw new Error("スクリーンショットの保存パスを解決できません。");
  const normalized = relativePath.replace(/^[/\\]+/, "");
  return path.resolve(projectRoot, normalized);
}

function formatScreenshotPart(index, text, meta = null) {
  const lines = ["## スクリーンショット " + String(index + 1)];
  if (meta) {
    lines.push(`Capture: y=${meta.yStart}-${meta.yEnd}px, viewport=${meta.viewportWidth}x${meta.viewportHeight}px, overlapTop=${meta.overlapTop}px, overlapBottom=${meta.overlapBottom}px`);
  }
  lines.push(text);
  return lines.join("\n");
}

function getScreenshotMeta(material, index) {
  const slices = Array.isArray(material?.screenshotSlices) ? material.screenshotSlices : [];
  return slices[index] || null;
}

function cleanOcrText(value) {
  return String(value || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

async function withRetryOnce(task) {
  try {
    return await task();
  } catch (error) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return await task();
  }
}

function stripCodeFence(value) {
  return String(value || "")
    .trim()
    .replace(/^```(?:text|markdown)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

function transcriptQuality(value) {
  const text = String(value || "");
  const chars = Math.max(text.length, 1);
  const questionCount = (text.match(/\?/g) || []).length;
  const mojibakeCount = (text.match(/[縺繧譁蜒譛螟荳豌蛻鬆驕謗]/g) || []).length;
  const questionRatio = questionCount / chars;
  const mojibakeRatio = mojibakeCount / chars;
  if (text.length < 20) return { ok: false, reason: "短すぎます" };
  if (/申し訳ありません|お応えできません|対応できません|can't assist|cannot assist/i.test(text)) return { ok: false, reason: "拒否応答です" };
  if (questionCount > 20 && questionRatio > 0.08) return { ok: false, reason: `疑問符が多すぎます (${questionCount})` };
  if (mojibakeCount > 20 && mojibakeRatio > 0.06) return { ok: false, reason: `文字化けを検出しました (${mojibakeCount})` };
  return { ok: true, reason: "" };
}

const LP_VISIBLE_TRANSCRIPTION_PROMPT = `
これはユーザーが指定した公開LPスクリーンショットのOCR作業です。
人物の識別、属性推定、評価、マーケティング解釈、翻訳、要約はしないでください。
対象LPに表示されている内容のみを、見える証拠に基づいて書き起こしてください。

LPを上から下まで、表示される順番のまま文字起こししてください。

【ルール】
- テキストは表示されている通りに書き起こす（要約言い換え禁止）
- 画像/GIF/動画がある箇所は【画像】【GIF】【動画】と明記し、その中に見える内容をすべて書き起こす
- 【画像】【GIF】【動画】には、見える範囲の色、構図、配置、被写体、イラスト、背景、強調表示、CTA、バナー、デザイン詳細も簡潔に含める
- ボタンやリンクは【ボタン：】【リンク：】と記載
- 改行区切り色強調（太字下線赤字など）もわかる範囲で再現
- 分析解釈役割の説明は一切不要
- Section分けや項目名（見出し本文CTA等）のラベル付けは不要
- 読めない文字は推測せず【判読不能】と書く
- 画面上端または下端で切れている要素は【途中で切れている】と添える

【出力形式】
上から順番に、見たままをそのまま羅列する。

推測サンプル生成は禁止。対象LPに表示されている内容のみを書き起こすこと。`;
