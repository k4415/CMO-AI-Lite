import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { extractTextFromFile } from "../src/core/file-import.js";
import { regulationExcelFixtures } from "./fixtures/regulation-excel-fixtures.js";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "regulations");

async function extractFixture(fixture, overrides = {}) {
  const fixturePath = path.join(fixtureDir, fixture.fixtureFileName);
  return extractTextFromFile({
    fileName: fixture.fileName,
    mimeType: fixture.mimeType,
    dataBase64: fs.readFileSync(fixturePath).toString("base64"),
    ...overrides
  });
}

test("標準的な1シートの表現レギュレーションをCSVテキストへ変換する", async () => {
  const result = await extractFixture(regulationExcelFixtures.standardSingleSheet);

  assert.equal(result.method, "xlsx");
  assert.match(result.text, /^# 表現レギュレーション\n/);
  assert.match(result.text, /種別,NG表現,推奨表現,備考/);
  assert.match(result.text, /NG,絶対に治る,改善を目指す,効果保証を避ける/);
  assert.match(result.text, /指定,,個人差があります,注記を併記する/);
});

test("複数シートと列名の揺れを加工せず保持する", async () => {
  const result = await extractFixture(regulationExcelFixtures.multipleSheetsAndHeaderVariants);

  assert.equal(result.method, "xlsx");
  assert.match(result.text, /# NGワード\n禁止語,言い換え案,理由/);
  assert.match(result.text, /必ず痩せる,健康的な体づくりを支援,断定表現を避ける/);
  assert.match(result.text, /# 必須注記\n分類,表示文言,掲載箇所/);
  assert.match(result.text, /価格,送料が別途必要です,価格訴求の近く/);
  assert.ok(result.text.indexOf("# NGワード") < result.text.indexOf("# 必須注記"));
});

test("空行を含むシートでも注記と数値を欠落させない", async () => {
  const result = await extractFixture(regulationExcelFixtures.blankRowsNotesAndNumbers);

  assert.equal(result.method, "xlsx");
  assert.match(result.text, /初回価格,880,税込・送料550円は別途/);
  assert.match(result.text, /割引率上限,20,%表記では条件を併記/);
  assert.match(result.text, /継続回数,0,購入回数の縛りなし/);
  assert.match(result.text, /自由記述,※個人差があります,画像内にも表示/);
  assert.doesNotMatch(result.text, /undefined|null/);
});

test("拡張子が不明でもExcel MIMEなら取り込める", async () => {
  const fixture = regulationExcelFixtures.standardSingleSheet;
  const result = await extractFixture(fixture, { fileName: "uploaded-file.bin" });

  assert.equal(result.method, "xlsx");
  assert.match(result.text, /絶対に治る/);
});
