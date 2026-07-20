import assert from "node:assert/strict";
import test from "node:test";

import { evidenceFromOcrBlocksInRegion, textFromOcrBlocksInRegion } from "../src/core/banner-ocr.js";

test("ロゴ枠へ一部重なる単語bboxは単語全体を採用し、枠外本文は除外する", () => {
  const blocks = [{ paragraphs: [{ lines: [{ words: [
    { text: "Sample", bbox: { x0: 820, y0: 45, x1: 920, y1: 85 }, symbols: [] },
    { text: "Smile", bbox: { x0: 930, y0: 45, x1: 1060, y1: 85 }, symbols: [] },
    { text: "Footer Brand", bbox: { x0: 300, y0: 980, x1: 500, y1: 1020 }, symbols: [] }
  ] }] }] }];
  const region = { left: 848, top: 10, width: 229, height: 120 };

  assert.equal(textFromOcrBlocksInRegion(blocks, region), "Sample Smile");
});

test("ロゴ領域のOCR証拠は文字列と単語信頼度の平均を返す", () => {
  const blocks = [{ paragraphs: [{ lines: [{ words: [
    { text: "CMO", confidence: 79, bbox: { x0: 200, y0: 900, x1: 560, y1: 1010 }, symbols: [] },
    { text: "AI", confidence: 95, bbox: { x0: 600, y0: 930, x1: 700, y1: 990 }, symbols: [] },
    { text: "本", confidence: 0, bbox: { x0: 780, y0: 930, x1: 890, y1: 990 }, symbols: [] }
  ] }] }] }];
  const region = { left: 190, top: 890, width: 710, height: 140 };

  assert.deepEqual(evidenceFromOcrBlocksInRegion(blocks, region), {
    text: "CMO AI 本",
    confidence: 58
  });
});
