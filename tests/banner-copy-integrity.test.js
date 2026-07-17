import test from "node:test";
import assert from "node:assert/strict";

import { verifyCopyIntegrity } from "../src/core/banner-ocr.js";
import {
  classifyImageOutputMismatch,
  normalizeBannerImageCompletionPatch
} from "../src/core/openai-image.js";

test("OCR exact copy match passes while whitespace differences are tolerated", () => {
  const check = verifyCopyIntegrity("今日中に初稿\n根拠で選べる", "今日中に 初稿\n根拠で選べる");

  assert.equal(check.status, "passed");
  assert.deepEqual(check.missing, []);
});

test("OCR missing or changed copy is not completed", () => {
  const check = verifyCopyIntegrity("今日中に初稿\n根拠で選べる", "今日中に初稿\n勘で選べる");
  const patch = normalizeBannerImageCompletionPatch({
    relativePath: "outputs/banner.png",
    banner: { imageText: "今日中に初稿\n根拠で選べる" },
    copyIntegrityCheck: check
  });

  assert.equal(check.status, "failed");
  assert.ok(check.missing.includes("根拠で選べる"));
  assert.equal(patch.productionStatus, "completed_with_warnings");
  assert.equal(patch.copyIntegrityCheck.status, "failed");
  assert.ok(patch.warnings.some((item) => item.type === "ocr_mismatch"));
});

test("OCR unavailable requires visual review", () => {
  const check = verifyCopyIntegrity("固定コピー", "", { ocrError: "OCR失敗" });
  const patch = normalizeBannerImageCompletionPatch({ copyIntegrityCheck: check });

  assert.equal(check.status, "not_verifiable");
  assert.equal(patch.productionStatus, "completed_with_warnings");
  assert.ok(patch.warnings.some((item) => item.type === "ocr_mismatch"));
});

test("コピー審査警告付きで続行した画像はOCR一致後もcompletedになる", () => {
  const patch = normalizeBannerImageCompletionPatch({
    relativePath: "outputs/banner.png",
    banner: {
      imageText: "CPAが従来比1/10に改善",
      copyQualityReview: { status: "warning", continuedAfterReview: true }
    },
    copyIntegrityCheck: { status: "passed", missing: [], note: "" }
  });

  assert.equal(patch.productionStatus, "completed");
  assert.equal(patch.warnings.length, 0);
});

test("仮説差別化warning付き画像はOCR一致後もcompletedになる", () => {
  const patch = normalizeBannerImageCompletionPatch({
    relativePath: "outputs/banner.png",
    banner: {
      creativeHypothesis: {
        variationReview: { status: "warning", continuedAfterReview: true }
      }
    },
    copyIntegrityCheck: { status: "passed", missing: [], note: "" }
  });

  assert.equal(patch.productionStatus, "completed");
  assert.equal(patch.warnings.length, 0);
});

test("確定コピーが全欠落し、十分な別内容が読めた画像は無関係出力として再生成対象にする", () => {
  const decision = classifyImageOutputMismatch({
    status: "failed",
    expected: ["CPA改善仮説を戦略から", "勝ちパターンをテンプレ化", "案件ごとに検証"],
    missing: ["CPA改善仮説を戦略から", "勝ちパターンをテンプレ化", "案件ごとに検証"],
    actualText: [
      "TYPES OF CLOUDS",
      "CIRRUS High altitude thin wispy clouds",
      "CUMULUS fluffy white clouds with flat bases",
      "Look up and enjoy the sky"
    ].join("\n")
  });

  assert.equal(decision.shouldRetry, true);
  assert.equal(decision.code, "IMAGE_OUTPUT_UNRELATED");
});

test("コピーの一部だけOCR不一致でも無関係出力とは断定しない", () => {
  const decision = classifyImageOutputMismatch({
    status: "failed",
    expected: ["CPA改善仮説", "案件ごとに検証"],
    missing: ["案件ごとに検証"],
    actualText: "CPA改善仮説\n案件ごとに検証する"
  });

  assert.equal(decision.shouldRetry, false);
});

test("全行の完全一致に失敗しても日本語の部分一致が多い画像はOCR誤読として止めない", () => {
  const decision = classifyImageOutputMismatch({
    status: "failed",
    expected: ["CPA改善仮説を戦略から", "案件ごとに検証"],
    missing: ["CPA改善仮説を戦略から", "案件ごとに検証"],
    actualText: [
      "CPA改普仮説を戦略から",
      "案件ごとに検正",
      "広告制作の仮説をチームで共有し、案件ごとに改善を重ねるための管理画面です。",
      "戦略から制作までを一つの流れで確認できます。"
    ].join("\n")
  });

  assert.equal(decision.shouldRetry, false);
});

test("OCR不能は従来どおり目視確認に回し、自動再生成を暴発させない", () => {
  const decision = classifyImageOutputMismatch({
    status: "not_verifiable",
    expected: ["固定コピー"],
    missing: ["固定コピー"],
    actualText: ""
  });

  assert.equal(decision.shouldRetry, false);
});
