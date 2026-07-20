import assert from "node:assert/strict";
import test from "node:test";

import { textFromOcrBlocksInRegion } from "../src/core/banner-ocr.js";

test("ロゴ枠へ一部重なる単語bboxは単語全体を採用し、枠外本文は除外する", () => {
  const blocks = [{ paragraphs: [{ lines: [{ words: [
    { text: "Sample", bbox: { x0: 820, y0: 45, x1: 920, y1: 85 }, symbols: [] },
    { text: "Smile", bbox: { x0: 930, y0: 45, x1: 1060, y1: 85 }, symbols: [] },
    { text: "Footer Brand", bbox: { x0: 300, y0: 980, x1: 500, y1: 1020 }, symbols: [] }
  ] }] }] }];
  const region = { left: 848, top: 10, width: 229, height: 120 };

  assert.equal(textFromOcrBlocksInRegion(blocks, region), "Sample Smile");
});
