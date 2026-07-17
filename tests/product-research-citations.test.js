import test from "node:test";
import assert from "node:assert/strict";
import { stripFactReferenceMarkers, normalizeFacts } from "../src/core/product-research-ai.js";

test("事実本文から引用番号を除去する", () => {
  assert.equal(stripFactReferenceMarkers("確認済み（※1）"), "確認済み");
  assert.equal(stripFactReferenceMarkers("複数確認 (※1, ※2)"), "複数確認");
});

test("Web由来の事実は実際の参照URLがない場合に保存候補から外す", () => {
  const product = { id: "prod_1", officialUrl: "https://official.example/" };
  const facts = normalizeFacts([
    { title: "出典なし", content: "確認できない事実", sourceType: "web" },
    { title: "出典あり", content: "確認できた事実", sourceType: "web", references: ["https://source.example/article"] }
  ], product, []);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].sourceUrl, "https://source.example/article");
  assert.deepEqual(facts[0].references, ["https://source.example/article"]);
});

test("referencesの順番を引用番号の正として維持する", () => {
  const facts = normalizeFacts([{
    title: "複数出典",
    content: "複数サイトで確認 (※1)",
    sourceType: "web",
    sourceUrl: "https://different.example/",
    references: ["https://first.example/", "https://second.example/"]
  }], { id: "prod_1", officialUrl: "https://official.example/" }, []);
  assert.equal(facts[0].sourceUrl, "https://first.example/");
  assert.equal(facts[0].content, "複数サイトで確認");
});
