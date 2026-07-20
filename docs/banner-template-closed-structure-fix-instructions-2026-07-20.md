# バナーテンプレ構造固定 修正指示書

> 2026-07-20追記: 画像枠・role・容量不一致で選択素材を停止する記述は、`docs/superpowers/specs/2026-07-20-selected-assets-template-override-design.md` により更新された。現在はユーザー選択素材だけを閉じた構造の唯一の例外として必須反映する。

> 2026-07-20追加更新: `docs/banner-generation-latency-retry-fix-instructions-2026-07-20.md` を優先する。選択素材以外のzone / text / image / shapeは増やさない一方、画像slotがないことを理由に選択素材を停止する旧受入基準は廃止済みである。

作成日: 2026-07-20
対象: CMO AI Lite / STEP3 バナー制作
対象リポジトリ: `/Users/koukamiyoshihiko/CMO-AI-Lite-main`

## 1. 修正目的

広告テンプレを選択して新規バナーを制作する場合、元テンプレの `templateZones` に存在しない `text` / `image` / `shape` 要素を原則として追加しない。

テンプレの構造だけを別商品へ掛け合わせる場合でも、変更できるのは既存要素の中身であり、要素の増設ではない。たとえば画像要素が0件のメモ帳風テンプレには、ロゴ、人物、端末、図解、カード、下線などを新規追加しない。

## 2. 現象と根本原因

### 2.1 確認した現象

`tpl_default_026`（NO.097 メモアプリ風）は、元テンプレの構造が `shape: 5 / text: 6 / image: 0` である。一方、生成結果には元テンプレにないロゴ、ワークフロー図、カード、接続線、CTA下線などが追加され得る。

### 2.2 根本原因

1. `src/core/banner-ai.js` の `normalizePromptJson` は、Stage 2モデルが `zones` を1件でも返すと、テンプレの `templateZones` よりモデル出力を優先する。
2. `normalizeZones` はテキスト内容だけを `slotId` で固定し、AIが追加した `image` / `shape`、追加zone、要素type変更を許容する。
3. `config/prompts/banner.md` は「slotIdのない新しいテキスト枠」を禁止するだけで、画像・図形の新規追加を禁止していない。
4. 同プロンプトの「コンテンツレイヤーは新規作成」という表現が、既存画像枠の被写体差し替えだけでなく、新規画像要素の増設も許すように解釈できる。
5. `src/core/openai-image.js` が作る最終画像プロンプトに、許可された要素数・type一覧と「それ以外を描かない」という閉じた構造契約がない。
6. 画像枠0件のテンプレでもロゴ・商品画像を指定でき、最終プロンプトがその表示を必須化するため、テンプレ外の画像要素を作る圧力が生じる。

## 3. 採用方針

### 3.1 テンプレ選択時は閉じた構造契約にする

`template.templateZones` が1件以上ある場合、以下をテンプレ側の正本として固定する。

- zoneの個数と順序
- 各zoneに属するelementの個数と順序
- `slotId`
- `type` (`text` / `image` / `shape`)
- `role` と `messageRole`
- `position` と `size`
- `effect`（下線、囲み、影などの装飾を含む）
- shapeの `description` / `content`（戻る、共有、枠、帯など図形の構造的な種類）

Stage 2モデルが変更できるのは、既存elementの枠内で商品・WHO-WHATに適合させる次の情報に限定する。

- text: `content` は `copyBrief.slotTexts` の確定文言のみ、`font`、`color`、`sourceReason`
- image: 既存画像枠のroleを変えない範囲での `content` / `sourceReason`（被写体や素材の具体化）
- shape: `sourceReason` のみ。元テンプレの図形種別、位置、サイズ、effectは変更しない
- zone: 元の位置と目的を維持したうえでの背景表現。ただし新しいelementを発生させない

### 3.2 AI出力を信頼するだけでなくコード側で強制する

Stage 2モデルの出力に次が含まれても、保存前の正規化で除外・復元する。

- テンプレにない追加zone
- テンプレにない追加element
- `text` から `image` などへのtype変更
- 元テンプレにないロゴ、人物、端末、カード、図解、線、バッジ、下線など
- elementの別zoneへの移動
- 既存elementの削除

テンプレ要素をAIが返さなかった場合も削除せず、テンプレ側の要素を残す。つまり、AI出力からテンプレを再構築するのではなく、テンプレ構造へAI出力の許可フィールドだけを投影する。

### 3.3 画像素材と画像枠の不整合は明示エラーにする

テンプレの画像elementが0件なのに `logoImagePaths` / `productImagePaths` / `otherImagePaths` が指定された場合、画像枠を自動追加せず、prompt生成時に明示エラーで停止する。

- エラーコード: `TEMPLATE_IMAGE_SLOT_REQUIRED`
- 再開ノード: `prompt`
- 利用者向け内容: 「選択テンプレに画像枠がありません。素材指定を外すか、画像枠のあるテンプレを選択してください。」

画像枠がある場合、指定素材はその既存画像枠の中でのみ使う。ロゴ専用枠がないテンプレへロゴを必須表示する挙動は行わない。今回の改修では暗黙の“構造拡張モード”を設けず、構造を増やしたい場合はテンプレなし生成を使う。

素材roleと画像枠roleも照合する。ロゴ素材には `role` / `messageRole` が `logo` / `brand` の画像枠、商品素材には `product` / `package` / `item` の画像枠が必要である。互換枠がない場合は `TEMPLATE_IMAGE_ROLE_MISMATCH` で停止する。その他素材は既存画像枠のroleに沿う用途としてのみ使える。

## 4. 実装指示

### 4.1 構造契約の純粋関数を追加する

新規ファイル `src/core/banner-template-structure.js` を作成し、少なくとも以下を実装する。

- `buildTemplateStructureContract(templateZones)`
  - zone数、element総数、type別数、zoneごとの許可elementを返す。
  - `slotId` がない要素には、既存の慣例と同じ `z{zoneIndex}e{elementIndex}` を決定的に付与する。
- `enforceTemplateStructure({ templateZones, generatedZones })`
  - テンプレ構造を基準に、モデル出力の許可フィールドだけを投影する。
  - `zones`、`contract`、`violations` を返す。
  - `violations` は少なくとも `extra_zone` / `extra_element` / `type_change` / `missing_element` を記録する。
- `assertTemplateImageCapacity({ templateZones, banner })`
  - 画像枠0件かつ画像素材指定ありの場合に `TEMPLATE_IMAGE_SLOT_REQUIRED` をthrowする。
  - ロゴ・商品素材に対応するroleの画像枠がない場合は `TEMPLATE_IMAGE_ROLE_MISMATCH` をthrowする。

### 4.2 `src/core/banner-ai.js`

- `normalizePromptJson` で、テンプレzoneがある場合は必ず `enforceTemplateStructure` を通す。
- `hasModelZones` によるモデルzone優先を廃止し、テンプレありとテンプレなしを明示分岐する。
- 正規化後の `promptJson` に `templateStructureContract` と `templateStructureReview` を保存する。
- テンプレがない場合は既存の自由生成・fallback zonesを維持する。
- `buildBannerDesignPrompt` に、テンプレありの場合の閉じた構造ルールと許可element一覧を含める。
- 画像素材の事前検証を、Stage 2モデル呼び出し前と正規化時の双方で共有関数により実行する。
- 画像枠0件の場合、`globalDesign.visualStyle` も「既存テキストと既存図形のみ」に正規化し、人物・写真・イラスト・端末・図解を要求する矛盾を残さない。

### 4.3 `config/prompts/banner.md`

次の意味を明文化する。

- `templateZones` がある場合、zone / elementの集合は閉じている。
- textだけでなく、image / shapeも追加禁止。
- 「コンテンツレイヤーを新規作成」は、既存image / shape枠の内容差し替えだけを意味する。
- 元テンプレに存在しないロゴ、人物、端末、図解、カード、線、バッジ、下線、装飾を追加しない。
- `visualIntent` や追加指示とテンプレ構造が衝突した場合は、テンプレ構造を優先し、既存枠内で表現する。

### 4.4 `src/core/openai-image.js`

- `buildBannerImagePrompt` と回復用プロンプトへ `templateStructureContract` を明示する。
- テンプレありの場合は「記載されたzone / elementだけを描画し、それ以外の文字・画像・図形・装飾を追加しない」と最優先で指示する。
- 許可type別件数を含め、特に画像枠0件なら「ロゴ・写真・イラスト・端末・図解を描画しない」と明示する。
- 後処理で文字や画像を合成する方式へ変更しない。

## 5. テスト指示（TDD）

実装前に失敗テストを追加し、意図した理由でREDになることを確認する。

### 5.1 自動テスト

実データ `data/ad-templates.json` から次の3件を読み込む。

| テンプレ | 画像枠 | 検証目的 |
| --- | ---: | --- |
| `tpl_default_026` NO.097 メモアプリ風 | 0 | ロゴ・図解・下線などを追加できない |
| `tpl_default_042` NO.003 国家試験アプリ | 1 | 既存ロゴ画像枠1件だけを維持する |
| `tpl_default_009` NO.006 転職支援 | 3 | 既存画像枠3件を維持し、人物等の内容だけ差し替える |

必須テスト:

1. モデル出力へ追加text / image / shape / zoneを混ぜても、正規化後のzone数・element数・type別数・slotId・位置が元テンプレと一致する。
2. 同じslotIdでtypeを変更しても元typeへ戻る。
3. モデル出力で既存elementを省略しても、元テンプレのelementが残る。
4. 画像枠0件のテンプレへロゴ・商品・その他画像を指定すると `TEMPLATE_IMAGE_SLOT_REQUIRED` になる。
5. ロゴ枠のないテンプレへロゴ素材、商品枠のないテンプレへ商品素材を指定すると `TEMPLATE_IMAGE_ROLE_MISMATCH` になる。
6. 画像枠0件では `globalDesign.visualStyle` に画像・図解生成の指示が残らない。
7. テンプレなしでは既存どおり自由なzone / elementを生成できる。
8. Stage 2プロンプトと最終画像プロンプトに閉じた構造ルール、許可件数、追加禁止が含まれる。
9. 既存のcopyBrief / slotId / contract hash / 表現レギュレーションのテストが回帰しない。

### 5.2 実画像テスト

上記3テンプレそれぞれで `gpt-image-2` により1枚ずつ生成し、次を確認する。

- 共通: zone数、テキスト枠数、画像枠数、図形枠数が元テンプレと同じ。
- メモ帳風: 白背景のメモUIと文字中心。ロゴ、人物、端末、カード、ワークフロー図、接続線、CTA下線がない。
- 国家試験アプリ: 既存のフレーム・4タイル・見出し・フッター構造を維持し、画像は既存ロゴ枠1件だけ。
- 転職支援: 見出し・本文・下部ビジュアル・右下サービス名の配置を維持し、画像は既存3枠だけ。
- 画像内コピーは確定文言と一致し、テンプレ由来の旧コピーが混入しない。
- 商品・戦略に合う内容へ差し替わっているが、構造上の新規要素はない。

画像モデルの微細な描画揺らぎと、構造上の要素追加を区別する。レビューでNGとするのは、意味を持つ新しい文字枠・画像枠・図形枠・装飾が生成された場合である。

## 6. 検証コマンド

```bash
node --test tests/banner-template-structure.test.js tests/banner-prompt-json.test.js tests/banner-logo-reference.test.js
npm test
node --check src/server.js
node --check src/ui/app.js
node --check src/core/openai-text.js
node --check src/core/who-what-ai.js
node --check src/core/banner-ai.js
node --check src/core/banner-template-structure.js
node --check src/core/openai-image.js
node --check src/core/template-ai.js
node --check src/core/product-research-ai.js
node --check src/core/lp-vision-ai.js
```

実画像確認は既存の `localhost:5173` と衝突させず、このリポジトリを `PORT=5174` で起動して行う。検証用案件はCRUD API経由で作成・保存し、JSONを直接編集しない。

## 7. 受入基準

次のすべてを満たしたときだけ完了とする。

1. 3テンプレすべてで、正規化後の構造が元テンプレと完全一致する自動テストがPASSする。
2. 画像枠0件テンプレへ画像素材を指定した不整合が明示エラーになる。
3. テンプレなし生成の既存挙動が回帰しない。
4. 対象テスト、全テスト、指定構文確認がPASSする。
5. 3テンプレの実画像レビューがすべてPASSする。
6. 実画像で新しい構造要素が見つかった場合、本書の原因・対策・テストへ追記し、修正と再生成を繰り返す。
7. 最終自己レビューが8.5/10以上で、重大な未解決事項がない。

## 8. 非対象

- `copyplan -> promptJson -> gpt-image-2` の3ノード変更
- 画像へのHTML/CSS/Python等による文字・ロゴの後載せ
- 事実DBをバナー生成入力へ追加する変更
- 元テンプレ画像そのものをgpt-image-2へ常時添付する変更
- 明示的な構造拡張モードの新設
- UIの大規模変更

## 9. 指示書レビュー記録

初回レビュー結果: 9.1 / 10、実装着手可。

- 根本原因: モデル指示、正規化、最終画像プロンプト、素材指定の4層を特定できている。
- 要件網羅: text / image / shape、追加zone、type変更、effect変更、欠落要素の復元を対象化できている。
- 検証可能性: 実データの画像枠0・1・複数という3テンプレと、RED→GREEN→実画像の終了条件が明確である。
- 初回レビューで見つけた不足: shapeの構造的description固定と、ロゴ・商品素材のrole不一致検証が不足していたため本書へ追記した。
- 残余リスク: gpt-image-2は確率的なため、JSON構造が一致しても描画上の小装飾を足す可能性がある。最終画像プロンプトの最優先制約と3枚の目視レビューで検出し、問題が出た場合は本書へ追記して再修正する。

## 10. 実装・検証レビュー記録

### 10.1 自動テスト

- RED確認: 新規8テスト中、テンプレなし互換の1件だけPASS、構造固定・素材不整合・プロンプト制約の7件が意図した理由でFAIL。
- GREEN確認: 対象テスト31件PASS。
- 全体確認: `npm test` で305件PASS、失敗0件。
- 構文確認: 本書6章に記載した全対象ファイルがPASS。
- `git diff --check`: PASS。

### 10.2 実画像3テンプレレビュー

実画像は `gpt-image-2` の通常画像生成APIで各1枚生成した。後処理による文字・画像合成は行っていない。

| テンプレ | 保存契約 | 実画像レビュー | 判定 |
| --- | --- | --- | --- |
| `tpl_default_026` メモアプリ風 | text 6 / image 0 / shape 5 | 白背景のメモUI、上部5アイコン、6テキストだけ。ロゴ、人物、端末、カード、図解、接続線、CTA下線なし | PASS |
| `tpl_default_042` 国家試験アプリ | text 9 / image 1 / shape 8 | 外枠、背景図形、4タイル、見出し、フッター、既存ロゴ画像枠1件だけを維持 | PASS |
| `tpl_default_009` 転職支援 | text 5 / image 3 / shape 2 | 上部見出し、中央本文、下部の背景・遠景人物・前景人物という既存3画像枠、右下サービス名を維持 | PASS |

2件が自動OCRで `completed_with_warnings` になったが、目視では確定コピーが正しく表示されていた。原因は1文字タイルと手書き風文字の分かち書き・誤認であり、構造追加やコピー変更ではないため構造検証はPASSとした。

検証画像は配布本体へ混ぜず、Codexの検証領域 `template-structure-validation/` に元テンプレと生成結果を対で保存した。

### 10.3 実行結果レビュー

- 初回実装後、旧 `layoutBlueprint.zones` の別slotIdが閉じた契約と同時にStage 2へ渡る余地をレビューで検出し、`templateZones` 契約へ構造の正を一本化した。
- テンプレなしの旧バナーへ「閉じた構造契約」と誤表示する後方互換上の文言ミスを検出し、契約の有無で分岐した。
- 全100テンプレへ契約生成を適用する追加レビューで、従来の `.slice(0, 12)` により20ゾーンの `tpl_default_055` が12ゾーンへ切り捨てられる問題を検出した。ゾーン上限を撤廃し、全100テンプレで元のzone数・element数と一意なslotIdが完全一致するテストを追加した。
- 上記修正後、自動テストと3実画像のいずれにも新たな構造問題は確認されなかったため、追加の修正指示・再生成ループは不要と判断した。

### 10.4 最終レビュー

- 正しさ: 9.4 / 10。モデル出力へ依存せず、元テンプレ構造を決定的に復元する。
- 要件適合: 9.5 / 10。text / image / shape、追加zone、type変更、画像素材不整合、テンプレなし互換を網羅した。
- 検証: 9.6 / 10。対象31テスト、全305テスト、全100テンプレ不変条件、3件の実画像を確認した。
- 保守性: 9.0 / 10。構造契約を単一モジュールへ分離し、Stage 2と最終画像プロンプトで同じ契約を利用する。
- 総合: 9.4 / 10。受入基準を満たし、重大な未解決事項なし。
- 外部Review Board: Claude CLIのOAuthアクセストークン失効（401）のためSKIP。実装やテストの失敗ではない。代替として全差分の自己レビュー、全100テンプレの不変条件テスト、3実画像の目視レビューを実施した。
- 残余リスク: 画像生成は確率的であり、ピクセル単位の小さな装飾揺らぎを完全には禁止できない。ただし、構造JSON、最終プロンプト、入力画像の3層で閉じた契約を固定し、意味を持つ新規要素は今回の3実画像で確認されなかった。
