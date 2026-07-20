# バナーロゴ正式表記・忠実度 修正指示書

> 2026-07-20追記: ロゴ枠不一致・容量超過で停止する記述は、`docs/superpowers/specs/2026-07-20-selected-assets-template-override-design.md` により更新された。現在はユーザーが選択した正式ロゴを、既存ロゴ枠の有無にかかわらず必須反映する。

> 2026-07-20追加更新: `docs/banner-generation-latency-retry-fix-instructions-2026-07-20.md` を優先する。明示logo slotはその領域で厳格判定するが、logo slotなしの選択素材例外は単一固定領域の不一致だけで欠落とせず、複数候補領域と画像全体OCRで`present_unlocalized` / `not_verifiable`を判定し、自動再生成しない。

> **For agentic workers:** 実装時は `superpowers:test-driven-development` と `implementation-self-review-loop` を適用し、本書のTask 1から順番にRED→GREEN→レビューを進める。

**Goal:** 選択した正式ロゴの全文・字形・語順を既存logo image枠内で維持し、部分語への短縮と誤った合格判定を防ぐ。

**Architecture:** 商品画像メタデータを正式ワードマークの正本とし、画像入力へidentityを付与する。生成時はロゴ原本と競合するテンプレ表層指示を除き、完成時はテンプレのlogo image領域だけをOCRして判定する。

**Tech Stack:** Node.js 20、Tesseract.js、既存JSONストア、既存CRUD API、gpt-image-2

## Global Constraints

- 画像への文字・ロゴの後載せや機械合成は禁止する。
- `copyplan → promptJson → gpt-image-2` の3ノードを維持する。
- 事実DBをバナー生成入力へ加えない。
- 選択テンプレのzone・element数とlogo image枠の位置・サイズを維持する。
- 実装はTDDで行い、対象テスト・全体テスト・実画像2回の順で検証する。

---

作成日: 2026-07-20
対象: `/Users/koukamiyoshihiko/CMO-AI-Lite-main`
状態: 実装前指示書（本書作成時点ではコード未修正）

## 1. 目的

商品ロゴ画像を選択したバナー生成で、ロゴ原本が `Oh my teeth` であるにもかかわらず、画像内のロゴが `TEETH` へ短縮・再描画される問題を解消する。

修正後は、次の3点を同時に満たすこと。

1. 選択したロゴ画像を `gpt-image-2` の入力画像として渡す。
2. 正式ワードマーク全体を正本としてプロンプトへ渡し、部分語へ短縮しない。
3. 完成画像のロゴ領域だけを検査し、本文やフッターに同じブランド名があってもロゴ合格の代用にしない。

## 2. 結論

直接原因は `src/core/openai-image.js` の `extractLogoWordmark()` である。

現在の処理はOCR結果を空白で分断し、「3文字以上で最長の英数字トークン」だけを正式ワードマークとして採用する。

```text
入力ロゴOCR: Oh my teeth
候補: TEETH
保存・プロンプト・検査上の正式ワードマーク: TEETH
```

`OH` と `MY` は2文字のため候補から落ち、`TEETH` だけが残る。さらに次の処理が誤りを増幅している。

- 画像生成プロンプトへ「正式ワードマークは `TEETH`。別の語を付加しない」と送る。
- 完成画像の全体OCRに `TEETH` があればロゴ検証を `verified` にする。
- テンプレ由来の「白単色ロゴ」と、ロゴ原本の色を変えない指示が同時に渡る。
- 一覧画面では `completed_with_warnings` を `completed` と表示するため、ロゴ不一致が利用者へ伝わらない。

## 3. 現物確認

対象案件:

```text
projects/oh-my-teeth-20260720/
```

選択されたロゴ素材:

```text
assets/products/prod_5bf18333101048c2/img_3bd3db9c42534abc_omt_logo.png
```

確認済み事項:

- 商品名は `Oh my teeth` で保存されている。
- ロゴ素材の `role` は `logo` である。
- 問題の2バナーとも同じロゴパスを `logoImagePaths` に保持している。
- 元画像は `Oh my teeth` の全文ワードマークである。
- Tesseract OCR結果も `Oh my teeth` である。
- 現行 `extractLogoWordmark("Oh my teeth")` の結果は `TEETH` になる。
- 生成結果の `logoVerification.expected` は誤って `TEETH` となり、`verified` で保存されている。

対象バナー:

```text
ban_2b332d02ead8435d
ban_3b55af17dfe84968
```

## 4. 守る制約

- `copyplan → promptJson → gpt-image-2` の3ノード構成を維持する。
- 事実DBをバナー生成入力へ加えない。
- ロゴや文字をHTML、CSS、Python、Pillow、canvas等で後載せ・合成しない。
- ロゴ領域のOCRは完成検査であり、画像への追記・加工ではないため実行可とする。
- 選択テンプレのlogo image枠の位置・サイズ・所属zoneは維持する。
- ロゴ素材をtext要素へ変換しない。logo image枠のまま扱う。
- `gpt-image-2`で公式に利用できると確認できないパラメータへ依存しない。今回の修正は `input_fidelity` を前提にしない。
- 案件JSONを手編集せず、UIまたは既存CRUD APIを使う。
- テンプレにロゴ枠がない場合は、現在の `TEMPLATE_IMAGE_ROLE_MISMATCH` を維持する。

## 5. 正式ワードマークの正本

### 5.1 商品画像メタデータ

`products.json` のロゴ画像に、表示用の素材名 `label` とは別に `officialWordmark` を追加できるようにする。

```json
{
  "id": "img_xxx",
  "role": "logo",
  "path": "assets/products/prod_xxx/logo.png",
  "label": "横長ロゴ",
  "officialWordmark": "Oh my teeth",
  "createdAt": "..."
}
```

`label` は「横長」「白版」などの素材識別名に使われるため、正式表記の正本として流用しない。

### 5.2 解決優先順位

選択ロゴごとに以下の順で正式ワードマークを決める。

1. 画像メタデータの `officialWordmark`
2. 選択ロゴが1件だけの場合に限り、商品マスターの `brandName`
3. 選択ロゴが1件だけの場合に限り、商品マスターの `name`
4. 上記がすべて空なら `unresolved`

OCR結果は入力画像の観測値として保存してよいが、正式ワードマークの正本にはしない。特に「最長トークンを正本にする」fallbackは禁止する。

複数ロゴを選択し、それぞれの `officialWordmark` がない場合は、商品名1件を全ロゴへ流用しない。検証状態を `not_verifiable` とし、UIで正式表記の入力を求める。

### 5.3 正規化

照合時だけ以下の正規化を使い、表示用の原文は保持する。

```js
export function normalizeLogoWordmark(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/[^\p{L}\p{N}]/gu, "");
}
```

期待結果:

```text
Oh my teeth  → ohmyteeth
Example Brand Pro → examplebrandpro
7-Eleven     → 7eleven
オーマイティース → オーマイティース
```

## 6. 実装構成

### 6.1 新規モジュール

作成:

```text
src/core/logo-identity.js
```

責務:

```js
normalizeLogoWordmark(value)

resolveLogoIdentity({
  inputImage,
  product,
  selectedLogoCount,
  observedInputText
})

verifyLogoIdentity({
  identities,
  logoRegionTexts,
  ocrError
})

logoRegionsFromContract(templateStructureContract, generatedImageSize)
```

`resolveLogoIdentity()` の戻り値:

```json
{
  "assetPath": "assets/products/prod_xxx/logo.png",
  "officialWordmark": "Oh my teeth",
  "normalizedWordmark": "ohmyteeth",
  "source": "asset_metadata",
  "observedInputText": "Oh my teeth",
  "verifiable": true
}
```

`source` は次のいずれかに限定する。

```text
asset_metadata
product_brand_name
single_product_name
unresolved
```

### 6.2 商品画像保存

変更:

```text
src/core/research-store.js
src/ui/app.js
docs/data-model.md
```

実装内容:

- `addProductImage()` が任意の `officialWordmark` を保存できるようにする。
- `role: "logo"` の画像行に「正式ロゴ表記」入力欄を表示する。
- `label` 入力欄は現在どおり「素材名」として残す。
- roleをlogo以外へ変更しても値は消さず、再度logoへ戻したとき再利用できるようにする。
- 既存画像は無移行で読めるようにし、未設定時は5.2のfallbackを使う。

UI例:

```text
素材名: 横長・黒版
正式ロゴ表記: Oh my teeth
```

### 6.3 画像入力へのidentity付与

変更:

```text
src/core/openai-image.js
```

`prepareBannerImageJob()` はすでに `getBannerImageContext()` の `product` を `context` に渡している。この既存経路を利用し、新しい商品DB読み込みを増やさない。

```js
const sourceImages = await loadBannerInputImages(projectRoot, banner, {
  product: context.product
});
```

各 `brand-logo` inputへ `logoIdentity` を付与する。現在の `enrichLogoInputText()` と `extractLogoWordmark()` を正式表記の決定には使わない。

入力ロゴのOCRは次の用途だけに限定する。

- アップロード画像が空・破損していないかの診断
- `observedInputText` として監査記録へ残す
- 明示された `officialWordmark` と入力画像OCRが大きく異なる場合の警告

## 7. 画像生成プロンプト

変更:

```text
src/core/openai-image.js
config/prompts/banner.md
```

### 7.1 正式表記

正式表記が解決できた場合は、次の意味でプロンプトへ渡す。

```text
正式ワードマーク全文は「Oh my teeth」。
これは添付ロゴの照合用表記であり、通常テキストとして打ち直す許可ではない。
「TEETH」など一部だけへ短縮しない。
添付されたロゴ画像そのものを既存logo image枠内で使用する。
```

次の誤った指示は出力しない。

```text
正式ワードマークは「TEETH」。別の語を付加しない。
```

### 7.2 テンプレ表層との競合解消

選択ロゴ画像があるlogo image要素では、テンプレ由来の以下を最終画像プロンプトへ渡さない。

- `content` 内の元ブランド名
- `font`
- `color`
- `effect` に含まれる「白単色」「別色へ変更」「再描画」指示

維持するのは以下だけとする。

- zone
- slotId
- type=image
- role=logo
- position
- size

ロゴと背景のコントラストが不足する場合、ロゴを反転・着色せず、既存の背景shape要素の許容範囲で背景側を調整する。

これは「テンプレ外要素を増やさない」という閉じた構造契約を維持したまま、ロゴ原本を保護する例外である。logo image要素の位置・サイズ・個数は変えない。

## 8. ロゴ領域限定の完成検査

### 8.1 全体OCRを使わない理由

今回の生成画像では、右上ロゴが `TEETH` でも、フッター本文に `Oh my teeth` が存在する。したがって画像全体OCRで `ohmyteeth` を検索すると誤って合格する。

禁止する検査:

```js
normalizeLogoWordmark(fullImageOcr).includes("ohmyteeth")
```

### 8.2 logo image枠のOCR

変更:

```text
src/core/banner-ocr.js
src/core/openai-image.js
src/core/logo-identity.js
```

`templateStructureContract` のlogo image要素から `position` と `size` を取り、生成画像サイズへ変換してロゴ領域だけをOCRする。

今回の例:

```text
position: top 3%, left 80%
size: width 17%, height 7%
```

OCR誤差を考慮し、上下左右へ画像幅・高さの2%以内のpaddingを加える。ただしフッターや本文領域まで広げない。

Tesseractのrectangle指定または文字bboxを利用する。検査用領域の抽出は画像へ変更を加えず、検査結果だけを返す。

戻り値例:

```json
{
  "ocrText": "画像全体のOCR",
  "logoRegions": [
    {
      "slotId": "z5e1",
      "text": "TEETH",
      "rectangle": { "left": 848, "top": 11, "width": 240, "height": 120 }
    }
  ],
  "ocrError": ""
}
```

ロゴ領域を数値化できない場合、画像全体OCRへfallbackして `verified` にしない。`not_verifiable` として目視確認へ回す。

### 8.3 判定

```text
logo領域OCR = Oh my teeth → verified
logo領域OCR = TEETH       → missing
logo領域OCR = 空           → not_verifiable
正式表記未解決             → not_verifiable
```

複数ロゴでは、選択ロゴ順とlogo image枠順を対応させ、各領域を個別に判定する。選択ロゴ数が対応logo枠数を超える場合は画像生成前に `TEMPLATE_IMAGE_SLOT_CAPACITY_EXCEEDED` で停止する。

## 9. 完成ステータスとUI

変更:

```text
src/core/openai-image.js
src/ui/app.js
tests/banner-image-completion.test.js
```

`normalizeBannerImageCompletionPatch()` へロゴ判定を反映する。

```text
verified       → ロゴ警告なし
missing        → productionStatus=completed_with_warnings
not_verifiable → productionStatus=completed_with_warnings
```

warnings:

```json
{
  "type": "logo_mismatch",
  "stage": "image",
  "message": "ロゴ枠内で正式表記『Oh my teeth』を確認できません。検出: TEETH",
  "occurredAt": "..."
}
```

UI変更:

- `bannerWarningLabel()` に `logo_mismatch: "ロゴ不一致"` を追加する。
- `bannerAuditWarningHtml()` は `logo_mismatch` がある場合に「ロゴ確認が必要」を表示する。
- 詳細ペインの警告欄に、期待表記、ロゴ領域OCR、対象slotIdを表示する。
- `logo_mismatch` がある画像を一覧上で無警告の「完了」に見せない。

自動再生成は最大1回に限定する。初回が `missing` の場合だけ、正式ワードマーク全文とロゴ原本優先を明記した短縮プロンプトで再生成する。`not_verifiable` はOCRの問題である可能性があるため自動再生成せず、確認待ちとする。

2回目も `missing` の場合は追加課金を続けず、`completed_with_warnings` と `logo_mismatch` を保存する。

## 10. TDD実装手順

### Task 1: 正式ワードマーク正本

対象:

```text
Create: src/core/logo-identity.js
Modify: src/core/openai-image.js
Test: tests/banner-logo-reference.test.js
```

先に以下の失敗テストを追加する。

```js
test("複数単語と2文字語を含む正式ロゴ名を分断しない", () => {
  const identity = resolveLogoIdentity({
    inputImage: { path: "assets/omt.png", asset: { officialWordmark: "Oh my teeth" } },
    product: { name: "Oh my teeth" },
    selectedLogoCount: 1,
    observedInputText: "Oh my teeth"
  });
  assert.equal(identity.officialWordmark, "Oh my teeth");
  assert.equal(identity.normalizedWordmark, "ohmyteeth");
  assert.equal(identity.source, "asset_metadata");
});

test("legacy単一ロゴは商品名をfallbackに使いOCR最長語を正本にしない", () => {
  const identity = resolveLogoIdentity({
    inputImage: { path: "assets/omt.png", asset: {} },
    product: { name: "Oh my teeth" },
    selectedLogoCount: 1,
    observedInputText: "Oh my teeth"
  });
  assert.equal(identity.officialWordmark, "Oh my teeth");
  assert.equal(identity.source, "single_product_name");
});
```

実行:

```bash
node --test tests/banner-logo-reference.test.js
```

RED理由が `resolveLogoIdentity is not defined` または現行の `TEETH` 抽出であることを確認してから実装する。

### Task 2: プロンプト競合除去

対象:

```text
Modify: src/core/openai-image.js
Modify: config/prompts/banner.md
Test: tests/banner-logo-reference.test.js
```

テスト要件:

```js
assert.match(prompt, /正式ワードマーク全文は「Oh my teeth」/);
assert.doesNotMatch(prompt, /正式ワードマークは「TEETH」/);
assert.doesNotMatch(logoZoneInstruction, /白単色|ロゴを再描画|typeset/);
assert.match(logoZoneInstruction, /position/);
assert.match(logoZoneInstruction, /size/);
```

### Task 3: ロゴ領域検査

対象:

```text
Modify: src/core/banner-ocr.js
Modify: src/core/logo-identity.js
Modify: src/core/openai-image.js
Test: tests/banner-logo-reference.test.js
```

必須テスト:

```js
test("本文に正式名があってもロゴ枠がTEETHならmissing", () => {
  const result = verifyLogoIdentity({
    identities: [{ officialWordmark: "Oh my teeth", normalizedWordmark: "ohmyteeth", verifiable: true }],
    logoRegionTexts: [{ slotId: "z5e1", text: "TEETH" }],
    fullImageText: "TEETH\n本文｜Oh my teeth"
  });
  assert.equal(result.status, "missing");
});

test("ロゴ枠内の全文一致だけをverifiedにする", () => {
  const result = verifyLogoIdentity({
    identities: [{ officialWordmark: "Oh my teeth", normalizedWordmark: "ohmyteeth", verifiable: true }],
    logoRegionTexts: [{ slotId: "z5e1", text: "Oh my teeth" }]
  });
  assert.equal(result.status, "verified");
});
```

### Task 4: 保存状態とUI警告

対象:

```text
Modify: src/core/openai-image.js
Modify: src/ui/app.js
Test: tests/banner-image-completion.test.js
Test: tests/banner-ui-copy-status.test.js
```

必須テスト:

- ロゴ `missing` で `logo_mismatch` warningを保存する。
- ロゴ `not_verifiable` で確認待ちになる。
- ロゴ `verified` かつコピー一致なら通常完了になる。
- 一覧に「ロゴ確認が必要」が表示される。
- `TEETH` だけの画像を通常完了表示しない。

### Task 5: 商品画像メタデータUI

対象:

```text
Modify: src/core/research-store.js
Modify: src/ui/app.js
Modify: docs/data-model.md
Create: tests/product-image-metadata.test.js
```

必須テスト:

- upload時に `officialWordmark` を保存できる。
- 既存画像の `officialWordmark` 未設定を壊さない。
- `label` と `officialWordmark` を別々に更新できる。
- ロゴ以外の画像では正式表記欄を表示しない。

## 11. 既存Oh my teeth案件の確認手順

実装後、UIの「前提情報 → 画像」で対象ロゴへ以下を設定する。

```text
正式ロゴ表記: Oh my teeth
```

保存は既存商品PATCH APIを使い、JSONを直接編集しない。

次に `tpl_default_081`（NO.012_美容液AURA SCIENCE）を使う2案を再生成する。

確認項目:

1. `logoImagePaths[0]` が元ロゴを指している。
2. 最終プロンプトに `Oh my teeth` 全文が照合用表記として入る。
3. 最終プロンプトに正式表記としての単独 `TEETH` がない。
4. 右上logo image枠に `Oh my teeth` 全文が表示される。
5. ロゴ原本の字形・語順・比率が維持される。
6. ロゴ位置・サイズ・zone数・element数はテンプレ契約どおりである。
7. フッターに `Oh my teeth` があっても、右上が `TEETH` なら検査は `missing` になる。
8. `logoVerification.expected` は `Oh my teeth` になる。
9. ロゴ不一致を一覧で無警告の完了表示にしない。

実画像は最低2回生成し、確率的な1回成功ではなく再現性を確認する。

## 12. 全体検証

対象テスト:

```bash
node --test tests/banner-logo-reference.test.js tests/banner-image-completion.test.js tests/banner-template-structure.test.js
```

全体テスト:

```bash
npm test
```

構文確認:

```bash
node --check src/server.js
node --check src/ui/app.js
node --check src/core/openai-image.js
node --check src/core/banner-ocr.js
node --check src/core/logo-identity.js
```

差分確認:

```bash
git diff --check
git status --short
```

## 13. 受入基準

- [ ] `extractLogoWordmark("Oh my teeth") → TEETH` に依存する経路がなくなっている。
- [ ] 正式ワードマークの正本が画像メタデータまたは商品識別情報から決まる。
- [ ] `Oh my teeth`、複数語の英字ロゴ、日本語ロゴを全文で正規化・照合できる。
- [ ] ロゴ画像は `image[]` として `gpt-image-2` へ直接渡される。
- [ ] 選択ロゴがある場合、テンプレ由来の再着色・再描画指示が最終画像プロンプトへ入らない。
- [ ] ロゴ位置・サイズ・個数は閉じたテンプレ構造契約を維持する。
- [ ] ロゴ検査はlogo image枠の領域だけを使う。
- [ ] 本文やフッターのブランド名でロゴ検査を代用しない。
- [ ] 右上が `TEETH`、フッターが `Oh my teeth` の画像を `verified` にしない。
- [ ] ロゴ不一致・未確認をUI上で利用者が認識できる。
- [ ] Oh my teethの実画像2回で全文ロゴを確認する。
- [ ] 対象テスト、全体テスト、構文確認、`git diff --check` がPASSする。

## 14. 対象外

- ロゴを生成後に機械合成する処理
- テンプレに存在しないロゴ枠の新設
- 商品画像・人物画像の一般的な類似度評価
- copyBriefのコピー設計変更
- 事実DB・WHO-WHAT生成の変更
- 過去の生成画像そのものの上書き

## 15. 実装前レビュー

レビュー結果: 9.4 / 10、実装可能。

- 原因と修正箇所が一対一で対応している。
- 正式表記をOCR推測から分離し、複数単語・短い語・日本語へ対応している。
- フッターのブランド名で誤合格する二次不具合を領域OCRで防いでいる。
- 閉じたテンプレ構造とロゴ原本優先の境界を明文化している。
- 後方互換として単一ロゴ＋商品名fallbackを用意している。
- 不一致時の追加課金を1回に制限している。

残余リスク:

- `gpt-image-2` は生成モデルのため、直接入力してもロゴのピクセル完全一致を常に保証できない。
- そのため「正しい正本を渡す」「競合指示を除く」「logo枠だけ検査する」「不一致を完了扱いにしない」の多層防御が必要である。
- パーセント表記を数値化できない旧テンプレでは領域OCRが `not_verifiable` になる可能性がある。誤って `verified` にするより安全側へ倒す。
