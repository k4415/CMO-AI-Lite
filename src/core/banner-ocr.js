import { createWorker } from "tesseract.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let ocrQueue = Promise.resolve();

export function recognizeBannerText(imagePath) {
  const task = ocrQueue.then(() => runOcr(imagePath));
  ocrQueue = task.catch(() => {});
  return task;
}

export function verifyCopyIntegrity(expected, actual, { ocrError = "" } = {}) {
  const expectedLines = normalizeExpectedLines(expected);
  const actualText = String(actual || "").trim();
  if (!expectedLines.length) {
    return { status: "passed", missing: [], changed: [], expected: [], actualText, note: "確認対象コピーなし" };
  }
  if (ocrError || !actualText) {
    return {
      status: "not_verifiable",
      missing: expectedLines,
      changed: [],
      expected: expectedLines,
      actualText,
      ocrError: String(ocrError || "OCR結果が空です"),
      note: "OCRでコピー完全性を確認できないため目視確認が必要です。"
    };
  }
  const normalizedActual = normalizeCopyText(actualText);
  const missing = expectedLines.filter((line) => !normalizedActual.includes(normalizeCopyText(line)));
  return {
    status: missing.length ? "failed" : "passed",
    missing,
    changed: missing.map((line) => ({ expected: line, observedText: actualText })),
    expected: expectedLines,
    actualText,
    ocrError: "",
    note: missing.length ? "確定コピーとOCR結果が一致しません。" : "確定コピーが生成画像内に確認できました。"
  };
}

function normalizeExpectedLines(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  return String(value || "").replace(/\\n/g, "\n").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function normalizeCopyText(value) {
  return String(value || "").normalize("NFKC").replace(/[\s\u3000]/g, "").toLowerCase();
}

async function runOcr(imagePath) {
  const cachePath = path.join(os.homedir(), ".cache", "cmoai", "tesseract");
  await fs.mkdir(cachePath, { recursive: true });
  const worker = await createWorker("jpn", 1, { cachePath });
  try {
    const result = await worker.recognize(imagePath);
    return String(result.data?.text || "").trim();
  } finally {
    await worker.terminate();
  }
}
