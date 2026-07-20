import test from "node:test";
import assert from "node:assert/strict";

import { evaluateBannerBatchSla } from "../src/core/banner-sla.js";

const REQUEST_STARTED_AT = "2026-07-20T00:00:00.000Z";

function makeBanners({
  count = 10,
  processingStartedAt = REQUEST_STARTED_AT,
  completedAt = "2026-07-20T00:03:00.000Z",
  status = "completed",
  qualityPassed = true
} = {}) {
  return Array.from({ length: count }, (_, index) => ({
    id: `banner-${index + 1}`,
    productionStatus: typeof status === "function" ? status(index) : status,
    slaQualityPassed: typeof qualityPassed === "function" ? qualityPassed(index) : qualityPassed,
    pipelineNodes: {
      copyplan: { startedAt: processingStartedAt },
      image: { completedAt }
    }
  }));
}

test("10件が180秒ちょうどで品質合格なら理想・最低SLAを通過する", () => {
  const result = evaluateBannerBatchSla({
    requestStartedAt: REQUEST_STARTED_AT,
    banners: makeBanners()
  });

  assert.equal(result.idealPassed, true);
  assert.equal(result.minimumPassed, true);
  assert.equal(result.batchMakespanMs, 180000);
  assert.equal(result.completedCount, 10);
  assert.equal(result.qualityFailureCount, 0);
  assert.ok(result.perBanner.every((item) => item.processingMs === 180000));
});

test("クリックから181秒なら理想SLAを通過しない", () => {
  const result = evaluateBannerBatchSla({
    requestStartedAt: REQUEST_STARTED_AT,
    banners: makeBanners({ completedAt: "2026-07-20T00:03:01.000Z" })
  });

  assert.equal(result.idealPassed, false);
  assert.equal(result.minimumPassed, false);
});

test("キュー待ちが長くても各処理が180秒以内なら最低SLAだけ通過する", () => {
  const result = evaluateBannerBatchSla({
    requestStartedAt: REQUEST_STARTED_AT,
    banners: makeBanners({
      processingStartedAt: "2026-07-20T00:02:00.000Z",
      completedAt: "2026-07-20T00:05:00.000Z"
    })
  });

  assert.equal(result.idealPassed, false);
  assert.equal(result.minimumPassed, true);
  assert.equal(result.batchMakespanMs, 300000);
});

test("失敗または品質不合格のバナーはSLA完了件数に数えない", () => {
  const result = evaluateBannerBatchSla({
    requestStartedAt: REQUEST_STARTED_AT,
    banners: makeBanners({
      status: (index) => index === 8 ? "failed" : "completed_with_warnings",
      qualityPassed: (index) => index !== 9
    })
  });

  assert.equal(result.completedCount, 8);
  assert.equal(result.qualityFailureCount, 1);
  assert.equal(result.idealPassed, false);
  assert.equal(result.minimumPassed, false);
});

test("件数不足・不正日時・完了より後の開始日時はSLAを通過しない", () => {
  const missing = evaluateBannerBatchSla({
    requestStartedAt: REQUEST_STARTED_AT,
    banners: makeBanners({ count: 9, completedAt: "2026-07-20T00:02:00.000Z" })
  });
  const invalidRequest = evaluateBannerBatchSla({
    requestStartedAt: "invalid",
    banners: makeBanners({ completedAt: "2026-07-20T00:02:00.000Z" })
  });
  const invalidProcessing = evaluateBannerBatchSla({
    requestStartedAt: REQUEST_STARTED_AT,
    banners: makeBanners({ processingStartedAt: "invalid", completedAt: "2026-07-20T00:02:00.000Z" })
  });
  const negativeProcessing = evaluateBannerBatchSla({
    requestStartedAt: REQUEST_STARTED_AT,
    banners: makeBanners({
      processingStartedAt: "2026-07-20T00:02:01.000Z",
      completedAt: "2026-07-20T00:02:00.000Z"
    })
  });

  assert.equal(missing.idealPassed, false);
  assert.equal(missing.minimumPassed, false);
  assert.equal(invalidRequest.idealPassed, false);
  assert.equal(invalidProcessing.minimumPassed, false);
  assert.equal(negativeProcessing.minimumPassed, false);
});

test("最初に開始した有効なノードを処理開始時刻として使う", () => {
  const banners = makeBanners({ completedAt: "2026-07-20T00:03:00.000Z" }).map((banner) => ({
    ...banner,
    pipelineNodes: {
      copyplan: { startedAt: "2026-07-20T00:00:30.000Z" },
      prompt: { startedAt: "2026-07-20T00:01:00.000Z" },
      image: { startedAt: "2026-07-20T00:02:00.000Z", completedAt: "2026-07-20T00:03:00.000Z" }
    }
  }));
  const result = evaluateBannerBatchSla({ requestStartedAt: REQUEST_STARTED_AT, banners });

  assert.equal(result.minimumPassed, true);
  assert.ok(result.perBanner.every((item) => item.processingMs === 150000));
});
