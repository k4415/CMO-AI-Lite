# バナー画像プロンプトライター導入 修正計画書

作成日: 2026-08-12（レビュー反映改訂: 2026-08-13）
ブランチ: `feature/banner-image-prompt-writer`
ステータス: 提案（外部レビュー反映済み）

## 1. 背景と本質課題

### 観測された品質課題

1. 構図・デザインが単調でテンプレ感が強い
2. 文字の乱れ・コピー再現性が不安定
3. 配色・トーンに違和感がある

### 根本原因

**gpt-image-2に渡る最終テキストが「デザイナーが書いた完成イメージの記述」ではなく「構造化データのダンプ」になっている。**

コード上の証拠:

- `src/core/banner-ai.js:164` — 閉じたテンプレ（標準NO.001〜100）では `runDeterministicDesign()` が実行され、**AIによるデザイン設計が一切走らない**。決定論コンパイラ（`src/core/banner-prompt-compiler.js`）がテンプレzonesと確定コピーを機械的に詰めるだけ。
- `src/core/banner-prompt-compiler.js:36` — zoneの目的が全件「テンプレのZone N構造・視線順・要素役割を維持する」という定型文。被写体・シーン・ライティング・質感の記述が生成されない。
- `src/core/openai-image.js:737` `buildBannerImagePrompt` — 最終プロンプトが「グローバルデザイン: {JSON}」「配色設計: {JSON}」「elements=[JSON配列]」の改行連結。戦略・テンプレデータがほぼ生のまま画像モデルへ流れる。
- 開いたテンプレ経路でも、Stage 2（gpt-5.5）は promptJson というJSON構造を吐くだけで、「1枚の広告としてどう見せるか」を言語化する工程が存在しない。

### 症状と原因の対応

| 症状 | 原因 |
|---|---|
| 構図単調・テンプレ感 | 閉経路はAI設計ゼロ。zone目的が定型文で視覚設計の情報量がない |
| 文字の乱れ | プロンプトの大半がJSON構文。タイポグラフィ設計（強弱・組み方・可読性）の記述がない |
| 配色違和感 | paletteのHEX値がJSONで渡るだけ。色をどの素材感・トーンで使うかの翻訳がない |

### 参考: 社内上位実装の解決方法

社内の上位版リポジトリ（ローカル: `~/`直下の上位版v1、`lib/banner-generation.ts:419` 以降）で実証済みのアプローチ:

- Anthropic上位モデル1コールで、自然言語の詳細な画像生成プロンプト（`image_prompt.prompt` + `style_notes`）を**書かせる**
- 構造レイヤー=テンプレから継承 / デザインレイヤー=参考 / コンテンツレイヤー=作り直し、の3レイヤー規律を厳守ルールとして明文化
- 図形コンテナ（吹き出し・枠・帯・斜め区切り線）は形状・輪郭・位置・向きを維持し「具体的な図形描写」としてプロンプトに書き下す
- 配色はテンプレ固有色を転用せず、色の役割とコントラスト水準だけを継承して商品に合わせ再設計
- コピー全文はコード側で決定論的にプロンプト末尾へ追記（同`banner-generation.ts:241`）。文字整合はコードが担保する

## 2. 検討した代替案と選定理由

| 案 | 内容 | 評価 |
|---|---|---|
| A: 決定論リライトのみ | `buildBannerImagePrompt` のJSONダンプを自然文組み立てに書き直す。コール増ゼロ | リスク最小だが、閉経路は「定型文しか材料がない」ため構図単調の解消が限定的 |
| **B: プロンプトライター挿入（採用）** | promptJson確定後にOpus 5の執筆コールを挿入（両経路共通で+1コール、§3.3参照） | 3症状すべての根本原因に直接効く。改修が最終プロンプト組み立てプロセスに閉じる。上位実装で実証済み。3テンプレのA/B検証で品質向上を確認済み |
| C: 上位実装構成へフル統合 | Stage 1+2を上位実装の単一コール構成に移植 | 品質は同等になるが、copyBriefロック・カラー契約・監査を壊す大改修。範囲希望から逸脱 |
| D: テンプレ資産の再解析 | テンプレDBに上位実装の解析層を追加抽出 | テンプレ100件の再解析コストが一時発生し、解析結果の書き写しだけでは設計知性が入らない |

ユーザー確認済みの制約:

- 改修は可能な限り「最後のプロンプト組み立てプロセス」に閉じる
- コスト: 1バナーあたりの追加はテキスト1コールまで（画像コストが支配的）
- ライターのモデルは **Opus 5**（上位実装準拠）

## 3. 設計

### 3.1 全体フロー（before → after）

```text
【現行】
Preflight → Stage 1 コピー開発 (Opus 4.8)
  → Stage 2:
      閉テンプレ: 決定論コンパイラ → promptJson
      開テンプレ: gpt-5.5 → promptJson
  → 画像生成時: buildBannerImagePrompt が promptJson をJSONダンプ連結 → gpt-image-2

【改修後】
Preflight → Stage 1 コピー開発 (Opus 4.8) 【不変】
  → Stage 2a（promptJson確定・現行のまま）:
      閉テンプレ: 決定論コンパイラ → promptJson 【不変】
      開テンプレ: gpt-5.5 (banner.md) → promptJson 【不変】
  → Stage 2b（★新設・両経路共通）:
      promptJson確定後に placement計算 → Opus 5ライター1コール → writtenImagePrompt / styleNotes
  → 画像生成時（初回のみ）: buildBannerImagePrompt =
      writtenImagePrompt（散文）+ 決定論ガード（構造契約・素材/ロゴ指示・コピー全文・確定palette・品質ルール）
      → gpt-image-2
```

コール数の変化: **両経路とも+1コール（Opus 5ライター）**。

> **レビュー反映（開経路の設計変更）**: 当初案は「開経路は既存gpt-5.5コールをライターに置換（1コール統合）」だったが、placement map（`buildSelectedAssetPlacementPlan`、`src/core/openai-image.js:977`）の計算に確定後の `promptJson.zones` が必要なため、zones自体を生成する同一コールへ確定マップを渡せない（鶏と卵）。よって**ライターは常にpromptJson確定後の独立コール**とする。これにより開経路も既存コール維持+1となる。1コール統合＋出力後のplacement矛盾検証＋散文破棄フォールバック案も検討したが、検証済みの2段構成の方が単純で、実験（3テンプレA/B）と同一の形であるため採用しない。副次効果として `config/prompts/banner.md` は無変更で済む。

### 3.2 新規コンポーネント

**(1) `src/core/banner-image-prompt-writer.js`（新規）**

- `writeBannerImagePrompt({ promptJson, product, strategy, copyBrief, colorDecision, templateStructureContract, selectedAssetPlacements, instructionPolicy, diversityGuidance, jsonGenerator })`
- `selectedAssetPlacements` は `buildSelectedAssetPlacementPlan(promptJson.zones, inputImageManifest)` で事前計算して渡す（同関数をexport化。ロジックは変更しない）
- 内部で**共通アダプタ**（下記(4)）経由でAnthropicを呼ぶ。モデルは `CMOAI_PROMPT_WRITER_MODEL` 環境変数（デフォルト `claude-opus-5`）。`anthropicJson` は既定で `claude-opus-4-8` 系を使い `CMOAI_PROMPT_WRITER_MODEL` を読まないため、**必ずモデルを明示指定**する
- 出力契約: `{ writtenImagePrompt: string, styleNotes: string }`（JSONのみ）
- 決定論サニタイズ: copyBrief.slotTexts の文言（4文字以上）が `writtenImagePrompt` **および `styleNotes`** に混入した行を除去。サニタイズ後に散文が実質空（有効文字数200未満）なら失敗扱い
- 失敗時: 1回リトライ → それでも失敗なら失敗を返し、呼び出し元は `writtenImagePrompt = ""`（空文字）を**明示的に保存**する。以前の散文を再利用しない。空文字時の画像生成は現行のJSONダンプ組み立てへフォールバックし、バナー生成自体は止めない

**(2) `config/prompts/banner-image-prompt-writer.md`（新規）**

ライターのシステムプロンプト。上位実装から移植する品質ルール:

- あなたはトップクラスの広告アートディレクター。gpt-image-2に渡す1枚の広告の完成イメージを、視線順に沿った具体的な散文で記述する
- 構造レイヤー（ゾーン構成・配置・視線誘導・余白・バッジ位置）はテンプレ構造契約から継承する
- 図形コンテナ（吹き出し・枠・帯・斜め区切り線等）は形状・輪郭・位置・向きを具体的な図形描写として書き下す。構造契約にない図形装飾を追加しない
- 被写体・シーン・ライティング・質感・カメラアングルを具体的に記述する。WHO-WHAT戦略のターゲットと利用場面に合わせる
- 配色は colorDecision.palette のHEXを役割どおりに使い、その色をどの素材感・トーン・グラデーションで表現するかを言語化する。palette外の色を主要色に使わない
- タイポグラフィの階層（最大コピーはどれか、サイズ強弱、可動域）を記述する。ただし**コピーの文言そのものは一切書かない**（コード側が全文を別ブロックで追記する。slotIdと役割名で参照する）
- 禁止事項: テンプレ元素材の複製・模倣、読める文字の創作、選択されていない素材の追加
- **選択素材の配置マップを入力に含める（2026-08-12検証で追加）**: `selectedAssetPlacements`（どのimage slotに添付素材が入るか）を必ず渡し、添付素材の見せ方の記述はそのスロット内に限定させる。他のimage枠には「生成する被写体・シーン」を記述させる。検証実験でマップ未入力のままライターが素材を2箇所に配置する散文を書き、末尾の決定論ガードと矛盾して素材が画像内に2回出現した。マップ入力後のNO.061/NO.064検証では再発なし
- **素材表面へのコピー印字表現の禁止（2026-08-12 NO.064検証で追加）**: テキストスロットが写真ゾーン内にあるテンプレで、ライターが「化粧箱のラベルに印字されたように」と表現→画像モデルが商品箱を描き直しコピーをパッケージ面に合成した。ルール化: コピーが素材・被写体と重なる場合も「独立したオーバーレイ文字」として記述し、素材や被写体の表面に印字・刻印されたように見せる表現を禁止する
- **カテゴリ跨ぎ時の被写体再解釈（2026-08-12 NO.061検証で追加）**: 他カテゴリ用テンプレ（白い商品5点並列）を和菓子に転用した検証で、現行方式は化粧品容器を描き商材と完全に乖離、新方式も部分的にテンプレ被写体種別を引きずった。上位実装の例外条項（「商材と全く無関係な場合を除き同種の被写体で維持」）をライタープロンプトに明示移植し、無関係な被写体種別は商材側の同役割モチーフへ再解釈させる

**(3) `buildBannerImagePrompt` の改修（`src/core/openai-image.js`）— 初回画像生成のみ**

- `banner.writtenImagePrompt` が非空の場合の新アセンブリ:
  1. 現行の先頭ガード（ヘッダ・閉構造契約・素材例外・添付画像役割・日本語文字品質ルール）
  2. 基本仕様（サイズ）
  3. 【デザイン完成イメージ】writtenImagePrompt ＋ デザイン意図（styleNotes）
  4. `バナー内テキスト:` + `banner.imageText`（ラベル文言は既存を維持。末尾ガードの【最終優先・確定コピー】がこのラベルを参照するため）
  5. 確定配色（colorScheme のHEX4色と役割のコンパクト表記）
  6. 現行の末尾ガード（【最終優先・確定コピー】〜Exclusive placement map）
- **clip予算方式（レビュー反映）**: 全体を後ろから12,000文字でclipすると末尾の確定コピー・placement mapが欠落し得るため、次の順で組む。
  1. 決定論ブロック（1,2,4,5,6）を先に構築し文字数を確定する（**これらは絶対にclipしない**）
  2. `残り予算 = 12,000 − 決定論ブロック合計` を算出
  3. 残り予算内で styleNotes → writtenImagePrompt の順にclipする（writtenImagePrompt単体の上限も従来どおり11,000）
  4. 決定論ブロックだけで12,000を超える場合はライター散文を落とし、現行組み立てへフォールバックする
- `banner.writtenImagePrompt` が空・未設定の場合（旧バナー・ライター失敗時）: 現行のJSONダンプ組み立てをそのまま使用（後方互換）
- **リカバリ経路は変更しない（レビュー反映）**: `buildBannerImageRecoveryPrompt`（`openai-image.js:845`）と `buildBannerLogoRecoveryPrompt`（同:882）は現行どおり**独立した短縮プロンプト**を維持する（「短いこと」が既存テストの契約）。writtenImagePromptのリカバリへの流用は本計画のスコープ外とし、必要になったら別途設計・テストする

**(4) Anthropic監査アダプタ（新規・両経路共通）**

`anthropicJson` は `openAiJson` が持つ `onAttempt` / `onResult` フックを受けないため、そのまま差し替えると監査上 model が旧値のまま・outputChars 0・httpAttempts 空になる。ライターモジュール内に共通アダプタを実装し、呼び出し前後で以下を記録する:

- 実際に使用したモデル名（`claude-opus-5` 等）、attempt番号、outputChars、所要時間、成否
- `promptGenerationAudit` は単一 `model` フィールドでは表現できないため、`audit.model`（既存: compiler/gpt-5.5の値を維持）に加えて `audit.writer = { model, calls, outputChars, outcome, fallback }` を追加する

### 3.3 既存経路への組み込み（`src/core/banner-ai.js`）

- **閉経路**: `runDeterministicDesign()` → normalize → slot reapply 完了後、ライターを1回実行して `writtenImagePrompt` / `styleNotes` を付与
- **開経路**: `runDesign()`（gpt-5.5 / `banner.md`）は**無変更**。その結果のpromptJson確定後、閉経路と同一のライター呼び出しを実行する（Stage 2b共通化）
- placement計算: 両経路ともライター呼び出し直前に `buildSelectedAssetPlacementPlan(promptJson.zones, buildBannerInputImageManifest(banner))` で確定マップを作り、ライター入力へ渡す
- `generateBannerCreativeProposal` の戻り値に `writtenImagePrompt` / `styleNotes` を追加し、`banner-store` 保存対象へ含める
- ライター失敗時は `writtenImagePrompt: ""` を保存（§3.6のライフサイクル参照）

### 3.4 不変条件（壊してはいけない契約）

| 契約 | 扱い |
|---|---|
| copyBriefロック（slotTexts一字不変） | 不変。コピーは従来どおり `imageText` としてコード側で組み立て、プロンプトへ決定論追記。ライターはコピー文言を書くこと自体を禁止 |
| カラー契約（`assertBannerImageColorContract`、promptJson.colorScheme = colorDecision.palette） | 不変。promptJson の生成・検証フローは触らない |
| OCRコピー検証・ロゴ検証・2回リトライ | 不変。`verifyCopyIntegrity` / `verifyLogoIdentity` はそのまま機能する |
| テンプレ構造契約（closed-structure） | 不変。`buildClosedStructureInstruction` は新アセンブリでも必ず含める |
| リカバリプロンプトの独立・短縮構造 | 不変（§3.2(3)参照） |
| Stage 2a（決定論コンパイラ / gpt-5.5 `banner.md`） | 不変 |
| ジョブ復旧・lease | 不変。ライターは prompt 工程内で完結し、失敗時は再生成可能な失敗状態へ戻す既存規約に従う |

### 3.5 コスト影響

- 画像1枚あたりの支配的コストは gpt-image-2（不変）
- **両経路とも+1コール（Opus 5ライター）**: 1コールあたり入力〜10K・出力〜3Kトークン想定で数円〜十数円程度。検証実測: 55〜81秒/コール
- 当初の「開経路は置換でコール数±0」はplacement mapの依存関係（§3.1）により成立しないため、+1へ変更。標準テンプレ100件はすべて閉経路であり、実運用の大半は当初想定どおり閉経路+1と同じ
- ライター失敗時のリトライは最大1回に制限

### 3.6 writtenImagePrompt のライフサイクル（レビュー反映・新設）

パイプラインの正しさを保つため、新フィールドを既存のハッシュ・無効化・復旧の仕組みへ組み込む:

1. **prompt無効化時の消去**: `banner-store.js` のprompt無効化パッチ（`:930` 付近、`start <= order.indexOf("prompt")` ブロック）に `patch.writtenImagePrompt = ""` / `patch.styleNotes = ""` を追加。prompt再生成時に古い散文が残らない
2. **prompt出力ハッシュへの追加**: `banner-pipeline-state.js` の `hashPromptOutput`（`:125` 付近）へ `writtenImagePrompt` / `styleNotes` を含める。散文の変更がprompt出力の変更として検知される
3. **image入力ハッシュへの追加**: `buildPipelineInputHashes` のimageノード入力（promptOutputHash経由＋明示フィールド）に両フィールドを含める。散文変更で画像が再生成対象になる
4. **ポリシーバージョン更新**: `PIPELINE_POLICY_VERSIONS.prompt` と `.image` をインクリメントし、既存バナーのハッシュを一括で旧版扱いにする（既存バナーは次回生成時に新フローで再構築される）
5. **失敗時の値**: ライター失敗は `writtenImagePrompt: ""` を明示保存。null/undefinedのまま残さない（「未生成」と「生成失敗」をhash上で区別しないため空文字に統一）
6. **job復旧**: 復旧時に古い散文を再利用しないことをテストで確認（prompt工程の復旧は成果物保持→再生成可能な失敗状態へ戻す既存規約に従う）

## 4. 実装ステップ

0. **ベースライン**: `npm test` を実行しグリーンであることを確認してから着手（本計画書の表記修正により配布範囲テストは解消済みであること）
1. **ライターモジュール＋監査アダプタ** — `banner-image-prompt-writer.js` + `config/prompts/banner-image-prompt-writer.md` + `buildSelectedAssetPlacementPlan` のexport化。単体テスト
2. **ライフサイクル組み込み** — §3.6の1〜5（banner-store無効化パッチ、pipeline-stateハッシュ、ポリシーバージョン）。ハッシュ・無効化・復旧のテスト
3. **Stage 2b組み込み** — 閉経路・開経路の両方でpromptJson確定後にライターを接続。audit.writer記録。フォールバックテスト
4. **最終アセンブリ改修** — `buildBannerImagePrompt` のclip予算方式＋後方互換フォールバック。リカバリ2種が不変であることのテスト
5. **永続化** — `banner-store` に writtenImagePrompt / styleNotes を追加（未コミットの手元変更と衝突しないよう最小差分）
6. **E2E検証** — 実案件で before/after 比較（§5）

各ステップ完了ごとにテストを実行し、グリーンを確認してから次へ進む。

## 5. 検証・受け入れ基準

1. `npm test` 全グリーン（既存テストの破壊なし）
2. 新規テスト（レビュー指摘分を含む）:
   - 出力契約・clip・リトライ→失敗・サニタイズ・audit記録（単体）
   - `styleNotes` にも確定コピーが混入しないこと
   - サニタイズ後に散文が実質空ならJSONフォールバックすること
   - 末尾ガード（確定コピー・placement map・配色）が12,000文字clip後も完全に残ること
   - prompt再生成（無効化）時に古い散文が消えること
   - 散文の変更でprompt出力ハッシュ・image入力ハッシュが変わること
   - 開経路でOpusモデル名・出力文字数・フォールバック有無が `audit.writer` に残ること
   - 通常リカバリ／ロゴリカバリが現行の短縮・特化構造を維持していること
   - job復旧で古い散文を再利用しないこと
3. 閉テンプレ・開テンプレ各1案件で実生成し、最終プロンプトが「散文＋決定論ブロック」構成になっていることを確認
4. before/after 比較（同一商品・戦略・テンプレで各3枚）: 構図の具体性 / OCRコピー検証の非悪化 / palette準拠のままトーン表現向上
5. ライター強制失敗時（APIキー無効等）にバナー生成がフォールバックで完走すること
6. 旧バナー（writtenImagePromptなし）の再生成が現行どおり動くこと

## 6. 対象外（out of scope）

- Stage 1 コピー開発・copyBrief契約の変更
- Stage 2a（決定論コンパイラ / `banner.md`）の変更
- テンプレDBスキーマ・テンプレ解析プロンプトの変更（案Dは将来の別施策）
- 範囲指定修正・全体修正（revision）経路、リカバリプロンプトへの散文流用
- colorDecision の決定ロジック自体の見直し（配色違和感が残る場合の次の一手として記録）
- UIの新規画面追加

## 7. リスクと軽減策

| リスク | 軽減策 |
|---|---|
| ライターがコピー文言を散文中に書いてしまい、コード追記分と二重になる | プロンプトで明示禁止 + writtenImagePrompt/styleNotes両方への決定論サニタイズ + 実質空ならフォールバック |
| clipで確定コピー・placement mapが欠落する | clip予算方式（決定論ブロック優先確保、散文側のみclip） |
| 散文と決定論ガードの矛盾（素材の複数配置・印字表現・カテゴリ跨ぎ被写体） | placement map入力・印字表現禁止・被写体再解釈のライタールール（3テンプレ検証で導出済み） |
| 古い散文が新しいpromptJsonと組み合わさる | §3.6のライフサイクル（無効化パッチ・ハッシュ組み込み・ポリシーバージョン更新） |
| 監査の欠落（model旧値・outputChars 0） | 共通監査アダプタ + `audit.writer` の分離記録 |
| Opus 5の出力が長すぎる／短すぎる | 11,000文字clip＋実質空判定→フォールバック |
| ライター障害でバナー生成が止まる | リトライ1回 + 空文字保存 + 現行アセンブリへのフォールバックで必ず完走 |
| モデルID・単価変動 | `CMOAI_PROMPT_WRITER_MODEL` 環境変数で差し替え可能 |
