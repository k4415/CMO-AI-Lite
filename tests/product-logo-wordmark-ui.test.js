import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../src/ui/app.js", import.meta.url), "utf8");

test("ロゴ素材カードは正式ロゴ表記を編集できる", () => {
  assert.match(source, /productImageWordmarkInput/);
  assert.match(source, /正式ロゴ表記/);
  assert.match(source, /officialWordmark/);
});

test("ロゴ不一致は一覧カードでロゴ確認が必要と表示する", () => {
  const start = source.indexOf("function bannerAuditWarningHtml(");
  const end = source.indexOf("function bannerListProductionStatus(", start);
  const auditSource = source.slice(start, end);
  assert.match(auditSource, /logo_mismatch/);
  assert.match(auditSource, /ロゴ確認が必要/);
  assert.match(source, /logo_mismatch: "ロゴ不一致"/);
});
