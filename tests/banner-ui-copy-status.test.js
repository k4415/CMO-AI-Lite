import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const source = await fs.readFile(new URL("../src/ui/app.js", import.meta.url), "utf8");

test("バナー一覧とカードは内部審査カテゴリやlastError生文を表示しない", () => {
  const summary = functionSource("renderBannersSummary", "renderBanners");
  const table = functionSource("renderBanners", "bannerLastErrorNoteHtml");
  const cards = functionSource("renderBannerCards", "bannerGenerationPlaceholderHtml");

  assert.match(summary, /再生成が必要/);
  assert.doesNotMatch(summary, /コピー審査不合格|伝達内容が不明確|テンプレートとメッセージが不適合|独自性審査不合格|WHO-WHAT情報不足/);
  assert.doesNotMatch(table, /bannerLastErrorNoteHtml\(banner\)/);
  assert.doesNotMatch(cards, /bannerLastErrorNoteHtml\(banner\)|banner\.lastError/);
});

test("バナー詳細は内部レビュー・監査・失敗理由をユーザー向けに展開しない", () => {
  const detail = functionSource("bannerDetailHtml", "bannerDownloadFileName");

  assert.doesNotMatch(detail, /value\.lastError|value\.lastErrorAt/);
  assert.doesNotMatch(detail, /bannerCommunicationReviewHtml|bannerGenerationAuditHtml/);
  assert.doesNotMatch(detail, /レビュー \/ NGチェック/);
});

test("旧要修正とコピー系の内部状態はstatusMetaとdisplayValueで再生成が必要へ統一する", () => {
  const meta = functionSource("statusMeta", "displayValue");
  const display = functionSource("displayValue", "imageCellHtml");
  for (const status of [
    "needs_revision",
    "hypothesis_contract_failed",
    "copy_review_failed",
    "copy_communication_failed",
    "template_message_fit_failed",
    "originality_review_failed",
    "copy_review_error",
    "strategy_input_insufficient",
    "template_not_ready"
  ]) {
    assert.match(meta, new RegExp(`${status}: \\\["再生成が必要"`));
    assert.match(display, new RegExp(`${status}: "再生成が必要"`));
  }
});

test("仮説失敗を含む停止状態の生成ボタンは再生成と表示する", () => {
  const actionLabel = functionSource("bannerGenerateActionLabel", "bannerAuditWarningHtml");

  assert.match(actionLabel, /hypothesis_contract_failed/);
  assert.match(actionLabel, /return "再生成"/);
});

test("v6終端ステータスは詳細ペインで警告を確認でき、一覧では完了警告を隠す", () => {
  const meta = functionSource("statusMeta", "displayValue");
  const display = functionSource("displayValue", "imageCellHtml");
  const listStatus = functionSource("bannerListProductionStatus", "bannerWarningLabel");
  const audit = functionSource("bannerAuditWarningHtml", "bannerListProductionStatus");
  const detail = functionSource("bannerDetailHtml", "bannerDownloadFileName");
  const timing = functionSource("bannerPipelineTimingHtml", "renderBannerCards");
  const warnings = functionSource("bannerWarningsDetailHtml", "bannerPipelineTimingHtml");
  const table = functionSource("renderBanners", "bannerLastErrorNoteHtml");
  const cards = functionSource("renderBannerCards", "bannerGenerationPlaceholderHtml");
  const compare = functionSource("compareCardInnerHtml", "selectBannerComparePreview");

  assert.match(meta, /completed_with_warnings:/);
  assert.match(meta, /\\u8b66\\u544a\\u3042\\u308a/);
  assert.match(display, /completed_with_warnings:/);
  assert.match(display, /\\u8b66\\u544a\\u3042\\u308a/);
  assert.match(display, /failed: "\\u5931\\u6557"/);
  assert.match(listStatus, /completed_with_warnings.*completed/);
  assert.match(audit, /needs_copy_visual_review/);
  assert.match(warnings, /bannerWarningLabel/);
  assert.match(timing, /durationMs/);
  assert.match(timing, /コピー設計/);
  assert.match(detail, /bannerPipelineTimingHtml/);
  assert.match(detail, /displayValue\(value\.productionStatus\)/);
  assert.match(detail, /bannerWarningsDetailHtml/);
  assert.match(table, /bannerListProductionStatus\(banner\.productionStatus\)/);
  assert.doesNotMatch(table, /bannerCompletionWarningBadgeHtml/);
  assert.match(cards, /bannerListProductionStatus\(banner\.productionStatus\)/);
  assert.doesNotMatch(cards, /bannerCompletionWarningBadgeHtml/);
  assert.match(compare, /bannerListProductionStatus\(banner\.productionStatus\)/);
  assert.doesNotMatch(source, /function bannerCompletionWarningBadgeHtml\(/);
});

function functionSource(name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`function ${nextName}(`, start + 1);
  assert.ok(start >= 0 && end > start, `${name}のソース範囲を取得できません`);
  return source.slice(start, end);
}
