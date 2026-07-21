import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { addStrategy, updateStrategy } from "../src/core/strategy-store.js";

const DEFAULT_MARKDOWN = `### 仮説\x20

**戦略コンセプト:**


**ターゲット属性:**
-\x20
-\x20

**欲求:**
-\x20
という欲求を満たしたい。

**判断基準:**
-\x20
-\x20
を満たすものがいい。

**想定競合:**
-\x20
-\x20
とは異なり、

**商品コンセプト:**
「」
なら、

**USP:**
-\x20
-\x20
という特徴があるから、

**ベネフィット:**
-\x20
になりそうだし、

**実績:**
実際に
-\x20
-\x20
という実績があるみたいだ。

**オファー:**
-\x20
なら始めてみよう。`;

const FILLED_MARKDOWN = `### 仮説 制作量を増やしたい運用者

**戦略コンセプト:**
制作ワークをAI化

**ターゲット属性:**
- SNS運用者
- ひとり広報

**欲求:**
- 制作時間を減らしたい
という欲求を満たしたい。

**判断基準:**
- 実務ですぐ使える
- 未経験でも進められる
を満たすものがいい。

**想定競合:**
- 汎用AIツール
- 制作代行
とは異なり、

**商品コンセプト:**
「AIとの対話で制作を効率化する講座」
なら、

**USP:**
- 実務に近い作成例
- 1日で体験できる
という特徴があるから、

**ベネフィット:**
- 発信量を増やせる
になりそうだし、

**実績:**
実際に
- LINE登録者12,000人
- 講師の受講実績
という実績があるみたいだ。

**オファー:**
- 初回0円で視聴する
なら始めてみよう。`;

async function makeStrategyRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-strategy-markdown-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "data"), { recursive: true });
  return root;
}

test("Markdownだけの手動戦略は戦略コンセプトを本文から抽出して保存する", async (t) => {
  const root = await makeStrategyRoot(t);

  const saved = await addStrategy(root, {
    productId: "product-1",
    markdown: FILLED_MARKDOWN,
    status: "proposed"
  });

  assert.equal(saved.conceptName, "制作ワークをAI化");
  assert.equal(saved.markdown, FILLED_MARKDOWN);
  assert.equal(saved.targetAttributes, "");
  assert.equal(saved.benefit, "");
});

test("Markdownエディタから本文を更新すると戦略コンセプトも同期する", async (t) => {
  const root = await makeStrategyRoot(t);
  const saved = await addStrategy(root, {
    productId: "product-1",
    markdown: FILLED_MARKDOWN
  });
  const nextMarkdown = FILLED_MARKDOWN.replace("制作ワークをAI化", "現場の1日AI自動化");

  const updated = await updateStrategy(root, saved.id, { markdown: nextMarkdown });

  assert.equal(updated.conceptName, "現場の1日AI自動化");
  assert.equal(updated.markdown, nextMarkdown);
});

test("手動追加エディタのデフォルトMarkdownは指定フォーマットと完全一致する", async () => {
  const markdownModule = await import("../src/core/strategy-markdown.js");

  assert.equal(markdownModule.DEFAULT_STRATEGY_MARKDOWN, DEFAULT_MARKDOWN);
});

test("Markdown保存前検証は必須見出しと戦略コンセプトを確認する", async () => {
  const markdownModule = await import("../src/core/strategy-markdown.js");
  assert.equal(typeof markdownModule.validateStrategyMarkdown, "function");

  assert.deepEqual(markdownModule.validateStrategyMarkdown(FILLED_MARKDOWN), {
    ok: true,
    conceptName: "制作ワークをAI化",
    missingHeadings: []
  });

  const missingOffer = FILLED_MARKDOWN.replace(/\n\*\*オファー:\*\*[\s\S]*$/, "");
  assert.deepEqual(markdownModule.validateStrategyMarkdown(missingOffer), {
    ok: false,
    conceptName: "制作ワークをAI化",
    missingHeadings: ["オファー"]
  });
});

test("手動追加UIは複数フィールドを廃止して単一Markdownエディタを使う", async () => {
  const source = await fs.readFile(new URL("../src/ui/app.js", import.meta.url), "utf8");
  const inputRow = functionSource(source, "strategyInputRow", "openBannerAddModal");
  const submit = functionSource(source, "addStrategy", "runWhoWhat");

  assert.match(source, /from "\/core\/strategy-markdown\.js"/);
  assert.match(source, /\$\("#strategyProduct"\)/);
  assert.match(inputRow, /id="strategyMarkdown"/);
  assert.match(inputRow, /DEFAULT_STRATEGY_MARKDOWN/);
  assert.match(inputRow, /data-strategy-add-mode="edit"/);
  assert.match(inputRow, /data-strategy-add-mode="preview"/);
  assert.match(inputRow, /strategyMarkdownAddPreview/);
  assert.doesNotMatch(inputRow, /strategyConcept|strategyWho|strategyBenefit|strategyOffer/);
  assert.match(submit, /validateStrategyMarkdown/);
  assert.match(submit, /markdown/);
  assert.match(submit, /productId:\s*\$\("#strategyProduct"\)\?\.value\s*\|\|\s*research\.products\[0\]\?\.id\s*\|\|\s*""/);
  assert.doesNotMatch(submit, /targetAttributes|desire|benefit|productConcept|offer/);
});

test("戦略詳細は戦略コンセプト個別欄を持たずMarkdownだけを編集する", async () => {
  const source = await fs.readFile(new URL("../src/ui/app.js", import.meta.url), "utf8");
  const inspector = functionSource(source, "strategyInspectorHtml", "bindStrategyInspector");
  const binder = functionSource(source, "bindStrategyInspector", "renderBanners");
  const strategyTableRow = functionSource(source, "strategyRow", "stripMarkdownForPreview");

  assert.doesNotMatch(inspector, /data-strategy-inline-concept/);
  assert.match(inspector, /data-strategy-inline-markdown/);
  assert.match(binder, /validateStrategyMarkdown/);
  assert.doesNotMatch(binder, /data-strategy-inline-concept/);
  assert.doesNotMatch(strategyTableRow, /editableCellHtml\("strategy"/);
});

test("ブラウザへ共通Markdownモジュールを配信する", async () => {
  const server = await fs.readFile(new URL("../src/server.js", import.meta.url), "utf8");

  assert.match(server, /url\.pathname === "\/core\/strategy-markdown\.js"/);
  assert.match(server, /core\/strategy-markdown\.js/);
});

test("編集とプレビューの切替ではhidden側を確実に非表示にする", async () => {
  const styles = await fs.readFile(new URL("../src/ui/styles.css", import.meta.url), "utf8");

  assert.match(styles, /\[data-strategy-add-editor\]\[hidden\][^{]*\{[^}]*display:\s*none/);
  assert.match(styles, /\[data-strategy-add-preview\]\[hidden\][^{]*\{[^}]*display:\s*none/);
});

test("戦略の商品セルは従来どおり商品との関係を編集できる", async () => {
  const source = await fs.readFile(new URL("../src/ui/app.js", import.meta.url), "utf8");
  const strategyTableRow = functionSource(source, "strategyRow", "stripMarkdownForPreview");

  assert.match(strategyTableRow, /relationCellHtml\("strategy",\s*strategy\.id,\s*"productId"/);
  assert.doesNotMatch(strategyTableRow, /strategyProductText/);
});

test("戦略追加フォームの全幅セルは固定列にならず全ヘッダーの下に表示される", async () => {
  const [html, styles] = await Promise.all([
    fs.readFile(new URL("../src/ui/index.html", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/ui/styles.css", import.meta.url), "utf8")
  ]);

  assert.match(html, /<tbody class="tableAddBody"><tr><td colspan="5"><div class="addRowPanel" id="strategiesAddPanel">/);
  assert.match(styles, /\.dataTable tbody\.tableAddBody > tr > td:first-child:last-child\s*\{[^}]*position:\s*static/);
  assert.match(styles, /\.dataTable tbody\.tableAddBody > tr > td:first-child:last-child\s*\{[^}]*max-width:\s*none/);
});

test("手動追加のMarkdownエディタは判断基準付近まで見える初期高にする", async () => {
  const styles = await fs.readFile(new URL("../src/ui/styles.css", import.meta.url), "utf8");

  assert.match(styles, /\.inlineAddForm textarea\.tableInput\.strategyMarkdownEditor\s*\{[^}]*min-height:\s*360px/);
});

function functionSource(source, name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`function ${nextName}(`, start + 1);
  assert.ok(start >= 0 && end > start, `${name}のソース範囲を取得できません`);
  return source.slice(start, end);
}
