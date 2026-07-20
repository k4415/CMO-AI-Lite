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

export function recognizeBannerEvidence(imagePath, { regions = [] } = {}) {
  const task = ocrQueue.then(() => runOcrEvidence(imagePath, regions));
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

async function runOcrEvidence(imagePath, regions) {
  const cachePath = path.join(os.homedir(), ".cache", "cmoai", "tesseract");
  await fs.mkdir(cachePath, { recursive: true });
  const worker = await createWorker("jpn+eng", 1, { cachePath });
  try {
    const fullResult = await worker.recognize(imagePath, {}, { text: true, blocks: true });
    const logoRegionTexts = [];
    for (const region of Array.isArray(regions) ? regions : []) {
      let text = textFromOcrBlocksInRegion(fullResult.data?.blocks, region.rectangle);
      if (!text) {
        const result = await worker.recognize(imagePath, { rectangle: region.rectangle });
        text = String(result.data?.text || "").trim();
      }
      logoRegionTexts.push({
        slotId: String(region.slotId || ""),
        rectangle: region.rectangle,
        text
      });
    }
    return { ocrText: String(fullResult.data?.text || "").trim(), logoRegionTexts };
  } finally {
    await worker.terminate();
  }
}

export function textFromOcrBlocksInRegion(blocks, rectangle) {
  if (!rectangle || !Array.isArray(blocks)) return "";
  const words = [];
  collectOcrWords(blocks, words, new WeakSet());
  return words
    .filter((word) => boxesIntersect(word.bbox, rectangle))
    .map((word) => String(word.text || "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function collectOcrWords(value, words, seen) {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (!Array.isArray(value) && Array.isArray(value.symbols) && value.bbox && value.text !== undefined) {
    words.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectOcrWords(item, words, seen);
    return;
  }
  for (const child of Object.values(value)) collectOcrWords(child, words, seen);
}

function boxesIntersect(bbox, rectangle) {
  if (!bbox) return false;
  const left = Number(bbox.x0);
  const top = Number(bbox.y0);
  const right = Number(bbox.x1);
  const bottom = Number(bbox.y1);
  const regionRight = Number(rectangle.left) + Number(rectangle.width);
  const regionBottom = Number(rectangle.top) + Number(rectangle.height);
  return [left, top, right, bottom, regionRight, regionBottom].every(Number.isFinite)
    && right > Number(rectangle.left)
    && left < regionRight
    && bottom > Number(rectangle.top)
    && top < regionBottom;
}
