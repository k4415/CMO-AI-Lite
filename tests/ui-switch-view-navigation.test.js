import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const source = await fs.readFile(new URL("../src/ui/app.js", import.meta.url), "utf8");

test("switchViewは画面切り替え対象を複数要素セレクタで取得する", () => {
  const switchView = functionSource("switchView", "renderViewStats");

  assert.match(switchView, /for \(const button of \$\$\("\.tabButton"\)\)/);
  assert.match(switchView, /for \(const button of \$\$\('\[data-workspace\]'\)\)/);
  assert.match(switchView, /for \(const panel of \$\$\("\.viewPanel"\)\)/);
});

function functionSource(name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`function ${nextName}(`, start + 1);
  assert.ok(start >= 0 && end > start, `${name}のソース範囲を取得できません`);
  return source.slice(start, end);
}
