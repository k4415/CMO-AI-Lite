import test from "node:test";
import assert from "node:assert/strict";

import { normalizeBannerImageCompletionPatch } from "../src/core/openai-image.js";

test("画像生成完了patchはWHO-WHAT整合を保存しfactCheckを新規作成しない", () => {
  const patch = normalizeBannerImageCompletionPatch({
    relativePath: "https://example.com/banner.png",
    banner: { reviewNotes: "", images: [] },
    strategyCheck: {
      status: "warning",
      warnings: ["選択WHO-WHAT範囲外の可能性: 満足度98%"],
      note: "事実DBは参照していません。"
    },
    logoVerification: { status: "not_verifiable", expected: [] }
  });

  assert.equal(patch.productionStatus, "completed");
  assert.equal(patch.strategyCheck.status, "warning");
  assert.equal(Object.hasOwn(patch, "factCheck"), false);
  assert.match(patch.reviewNotes, /WHO-WHAT整合チェック/);
});
