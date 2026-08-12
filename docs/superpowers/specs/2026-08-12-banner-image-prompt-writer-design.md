# バナー画像プロンプトライター導入 修正計画書

作成日: 2026-08-12
ブランチ: `feature/banner-image-prompt-writer`
ステータス: 提案（レビュー待ち）

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

### 参考: CMO AI Pro v1の解決方法

`/Users/koukamiyoshihiko/CMO AI Pro v1/lib/banner-generation.ts:419` 以降:

- Anthropic上位モデル1コールで、自然言語の詳細な画像生成プロンプト（`image_prompt.prompt` + `style_notes`）を**書かせる**
- 構造レイヤー=テンプレから継承 / デザインレイヤー=参考 / コンテンツレイヤー=作り直し、の3レイヤー規律を厳守ルールとして明文化
- 図形コンテナ（吹き出し・枠・帯・斜め区切り線）は形状・輪郭・位置・向きを維持し「具体的な図形描写」としてプロンプトに書き下す
- 配色はテンプレ固有色を転用せず、色の役割とコントラスト水準だけを継承して商品に合わせ再設計
- コピー全文はコード側で決定論的にプロンプト末尾へ追記（`banner-generation.ts:241`）。文字整合はコードが担保する

## 2. 検討した代替案と選定理由

| 案 | 内容 | 評価 |
|---|---|---|
| A: 決定論リライトのみ | `buildBannerImagePrompt` のJSONダンプを自然文組み立てに書き直す。コール増ゼロ | リスク最小だが、閉経路は「定型文しか材料がない」ため構図単調の解消が限定的 |
| **B: プロンプトライター挿入（採用）** | 最終組み立て点にOpus 5の執筆コールを挿入。開経路は既存gpt-5.5コールを置換、閉経路のみ+1コール | 3症状すべての根本原因に直接効く。改修が最終プロンプト組み立てプロセスに閉じる。Proで実証済み |
| C: Pro構成へフル統合 | Stage 1+2をProの単一コール構成に移植 | 品質はPro同等だが、copyBriefロック・カラー契約・監査を壊す大改修。範囲希望から逸脱 |
| D: テンプレ資産の再解析 | テンプレDBにProの解析層を追加抽出 | テンプレ100件の再解析コストが一時発生し、解析結果の書き写しだけでは設計知性が入らない |

ユーザー確認済みの制約:

- 改修は可能な限り「最後のプロンプト組み立てプロセス」に閉じる
- コスト: 既存コール置換ならOK（閉経路の+1コールは品質影響最大の経路のため許容）
- ライターのモデルは **Opus 5**（Pro準拠）

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
  → Stage 2:
      閉テンプレ: 決定論コンパイラ → promptJson 【不変】
                  → ★ライターコール (Opus 5): promptJson+文脈 → writtenImagePrompt
      開テンプレ: ★Opus 5（gpt-5.5を置換）: promptJson + writtenImagePrompt を同一コールで出力
  → 画像生成時: buildBannerImagePrompt =
      writtenImagePrompt（デザイン記述の散文）
      + 決定論ブロック（構造契約・素材/ロゴ指示・コピー全文・確定palette・品質ルール）
      → gpt-image-2
```

コール数の変化: 開経路 ±0（モデルはgpt-5.5→Opus 5に変更）、閉経路 +1（0→1）。

### 3.2 新規コンポーネント

**(1) `src/core/banner-image-prompt-writer.js`（新規）**

- `writeBannerImagePrompt({ promptJson, product, strategy, copyBrief, colorDecision, templateStructureContract, instructionPolicy, diversityGuidance, jsonGenerator })`
- `anthropicJson`（`src/core/anthropic-text.js`）を使用。モデルは `CMOAI_PROMPT_WRITER_MODEL` 環境変数（デフォルト `claude-opus-5`）
- 出力契約: `{ writtenImagePrompt: string, styleNotes: string }`（JSONのみ）
- 出力長の上限: writtenImagePrompt は11,000文字でclip（Pro準拠）
- 失敗時: 1回リトライ → それでも失敗なら `writtenImagePrompt` なしで続行（現行のJSONダンプ組み立てへフォールバック）。バナー生成自体は止めない

**(2) `config/prompts/banner-image-prompt-writer.md`（新規）**

ライターのシステムプロンプト。Pro v1から移植する品質ルール:

- あなたはトップクラスの広告アートディレクター。gpt-image-2に渡す1枚の広告の完成イメージを、視線順に沿った具体的な散文で記述する
- 構造レイヤー（ゾーン構成・配置・視線誘導・余白・バッジ位置）はテンプレ構造契約から継承する
- 図形コンテナ（吹き出し・枠・帯・斜め区切り線等）は形状・輪郭・位置・向きを具体的な図形描写として書き下す。構造契約にない図形装飾を追加しない
- 被写体・シーン・ライティング・質感・カメラアングルを具体的に記述する。WHO-WHAT戦略のターゲットと利用場面に合わせる
- 配色は colorDecision.palette のHEXを役割どおりに使い、その色をどの素材感・トーン・グラデーションで表現するかを言語化する。palette外の色を主要色に使わない
- タイポグラフィの階層（最大コピーはどれか、サイズ強弱、可動域）を記述する。ただし**コピーの文言そのものは一切書かない**（コード側が全文を別ブロックで追記する。ライターが書くと改変リスクが生じるため）
- 禁止事項: テンプレ元素材の複製・模倣、読める文字の創作、選択されていない素材の追加

**(3) `buildBannerImagePrompt` の改修（`src/core/openai-image.js`）**

- `banner.writtenImagePrompt` が存在する場合の新アセンブリ:
  1. writtenImagePrompt（散文のデザイン記述）
  2. 閉構造契約の指示（既存 `buildClosedStructureInstruction`、不変）
  3. 添付素材・ロゴ指示（既存の決定論ロジック、不変）
  4. `画像内に必ず一字一句正確に配置する日本語コピー:` + `banner.imageText`（既存の正本）
  5. 確定配色: colorScheme のHEXと役割（コンパクトな1ブロック）
  6. 日本語文字品質ルール・negative rules（既存文言を維持）
  - 全体を12,000文字でclip（Pro準拠）
- `banner.writtenImagePrompt` がない場合（旧バナーの再生成・ライター失敗時）: **現行のJSONダンプ組み立てをそのまま使用**（後方互換）
- リカバリプロンプト（`buildBannerImageRecoveryPrompt` / logo recovery）は新アセンブリの上に既存の追記が乗る形を維持

### 3.3 既存経路への組み込み（`src/core/banner-ai.js`）

- **閉経路**: `runDeterministicDesign()` の結果に対し、ライターコールを1回実行して `writtenImagePrompt` を付与。コンパイラ・normalize・slot reapply・カラー契約は不変
- **開経路**: `runDesign()` の `jsonGenerator` を `openAiJson` から `anthropicJson`（Opus 5）へ差し替え、出力契約に `writtenImagePrompt` / `styleNotes` を追加（1コールで promptJson と散文を同時出力。Proが copy_texts + image_prompt を1コールで出す構成と同型）
- **監査フックのアダプタ**: `anthropicJson` は `openAiJson` が持つ `onAttempt` / `onResult` コールバックを受けないため、ライターモジュール側で呼び出し前後に audit イベント（model・outputChars・attempt）を記録する薄いラッパを実装する（`anthropic-text.js` 本体は変更しない）
- `generateBannerCreativeProposal` の戻り値に `writtenImagePrompt` / `styleNotes` を追加し、`banner-store` 保存対象へ含める
- `promptGenerationAudit` にライターの model / 呼び出し回数 / フォールバック有無を記録

### 3.4 不変条件（壊してはいけない契約）

| 契約 | 扱い |
|---|---|
| copyBriefロック（slotTexts一字不変） | 不変。コピーは従来どおり `imageText` としてコード側で組み立て、プロンプト末尾に決定論追記。ライターはコピー文言を書くこと自体を禁止 |
| カラー契約（`assertBannerImageColorContract`、promptJson.colorScheme = colorDecision.palette） | 不変。promptJson の生成・検証フローは触らない |
| OCRコピー検証・ロゴ検証・2回リトライ | 不変。`verifyCopyIntegrity` / `verifyLogoIdentity` はそのまま機能する |
| テンプレ構造契約（closed-structure） | 不変。`buildClosedStructureInstruction` は新アセンブリでも必ず含める |
| ジョブ復旧・lease・audit | 不変。ライターは prompt 工程内で完結し、失敗時は再生成可能な失敗状態へ戻す既存規約に従う |

### 3.5 コスト影響

- 画像1枚あたりの支配的コストは gpt-image-2（不変）
- 開経路: コール数±0。モデル単価は gpt-5.5 → Opus 5 で上がるが、1コールあたり入力〜10K・出力〜3Kトークン想定で数円〜十数円程度
- 閉経路: +1コール（同上）。標準テンプレ経路の品質がボトルネックのため投資対効果が最も高い
- ライター失敗時のリトライは最大1回に制限

## 4. 実装ステップ

1. **ライターモジュール** — `banner-image-prompt-writer.js` + `config/prompts/banner-image-prompt-writer.md` を新規作成。単体テスト（jsonGeneratorモック、出力契約、clip、リトライ→フォールバック）
2. **閉経路組み込み** — `generateBannerCreativeProposal` の決定論経路にライターを接続。audit記録。テスト（閉テンプレでライターが呼ばれる／失敗時にフォールバックする）
3. **開経路置換** — `runDesign` のjsonGeneratorをOpus 5へ差し替え、出力契約拡張。既存の normalize / slot reapply / カラー契約テストが全て通ることを確認
4. **最終アセンブリ改修** — `buildBannerImagePrompt` に新アセンブリと後方互換フォールバックを実装。テスト（writtenImagePromptあり／なし両パス、コピーブロック・構造契約・palette・ロゴ指示の包含検証）
5. **保存とUI表示** — `banner-store` に writtenImagePrompt / styleNotes を永続化。（UI表示は最小限: 既存のprompt表示欄に含まれれば可）
6. **E2E検証** — 実案件で before/after 比較（下記 §5）

各ステップ完了ごとにテストを実行し、グリーンを確認してから次へ進む。

## 5. 検証・受け入れ基準

1. `npm test` 全グリーン（既存テストの破壊なし）
2. 閉テンプレ・開テンプレ各1案件で実生成し、生成された最終プロンプトが「散文デザイン記述 + 決定論ブロック」構成になっていることを確認
3. before/after 比較（同一商品・同一戦略・同一テンプレで各3枚）:
   - 構図: 被写体・シーンが商材とWHO-WHATに合った具体性を持つか
   - 文字: OCRコピー検証の通過率が悪化していないか
   - 配色: palette準拠のまま素材感・トーンの表現が向上したか
4. ライター強制失敗時（APIキー無効等）にバナー生成がフォールバックで完走すること
5. 旧バナー（writtenImagePromptなし）の再生成が現行どおり動くこと

## 6. 対象外（out of scope）

- Stage 1 コピー開発・copyBrief契約の変更
- テンプレDBスキーマ・テンプレ解析プロンプトの変更（案Dは将来の別施策）
- 範囲指定修正・全体修正（revision）経路のプロンプト改善
- colorDecision の決定ロジック自体の見直し（配色違和感が残る場合の次の一手として記録）
- UIの新規画面追加

## 7. リスクと軽減策

| リスク | 軽減策 |
|---|---|
| ライターがコピー文言を散文中に書いてしまい、コード追記分と二重になる | プロンプトで明示禁止 + 出力検証で slotTexts の文言が散文に含まれる場合は該当行を除去（決定論サニタイズ） |
| Opus 5の出力が長すぎて画像モデルの入力上限に当たる | 11,000/12,000文字のclip（Pro実績値） |
| 開経路の1コール統合で promptJson の構造品質が落ちる | 既存の normalize / repair / 契約検証が全て残るため構造は事後修復される。テストで担保 |
| ライター障害でバナー生成が止まる | リトライ1回 + 現行アセンブリへのフォールバックで必ず完走 |
| Opus 5のモデルID・単価変動 | `CMOAI_PROMPT_WRITER_MODEL` 環境変数で差し替え可能にする |
