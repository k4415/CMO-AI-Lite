# データモデル (CMO AI Lite)

CMO AI Lite では、1案件=1商品を前提に、案件配下の JSON DB でデータを管理します。

## データフロー

```text
商品URL
  → 内部LP解析キャッシュ（本文・スクリーンショット・OCR・抽出ジョブ）
  → 事実DB
  → WHO-WHAT戦略
  → バナー画像テンプレ + 追加指示
  → copyBrief + promptJson
  → gpt-image-2
```

## 案件ページ内DB

| DB | 保持先 | 用途 |
| --- | --- | --- |
| 商品マスターDB | `data/products.json` | 商品名、URL、画像、ブランド情報 |
| 内部LP解析キャッシュ | `data/research-materials.json` | LP本文、スクリーンショット、OCR、抽出ステータス |
| 事実DB | `data/facts.json` | 1行1事実の客観的情報 |
| 表現レギュレーションDB | `data/expression-rules.json` | NG表現、言い換え、トーン制約 |
| WHO-WHAT DB | `data/strategies.json` | 戦略仮説 |
| バナー案DB | `data/banner-creatives.json` | copyBrief、promptJson、生成画像 |

共通DB: 広告テンプレDB (`data/ad-templates.json`)

## STEP1 商品マスター登録

入力: 商品名、公式サイトURL、簡易説明
保存先: `data/products.json`

商品画像の主なフィールド:

- `role`: `product` / `logo` / `other`
- `label`: 「横長・黒版」など素材を識別する表示名
- `officialWordmark`: ロゴ画像に含まれる正式な全文表記（例: `Sample Smile`）。ロゴ同一性の正本であり、`label` やOCR推測とは分離する

既存ロゴで `officialWordmark` がない場合は、選択ロゴが1件のときだけ商品マスターの `brandName`、次に `name` を使用する。複数ロゴで個別の正式表記を解決できない場合は、画像生成後のロゴ検証を `not_verifiable` とする。

## STEP2 内部LP解析キャッシュ

入力: 商品URL、登録済みLP/記事LP URL
処理: 本文抽出、スクリーンショット取得、OCR、画像内文字分析
保存先: `data/research-materials.json`
再利用: 解析済みURLはキャッシュをそのまま使う

## STEP3 商品事実抽出

担当: `product-research-ai.js` / スキル `cmoai-research`
入力: 商品マスターDB、内部LP解析キャッシュ、Web検索(8方向)、既存事実DB
出力: 事実DB（1行1事実、sourceUrl必須）

## STEP4 WHO-WHAT生成

担当: `who-what-ai.js` / スキル `cmoai-who-what`
入力: **商品マスターDB、商品事実DB、表現レギュレーションDB、既存WHO-WHAT DB のみ**
出力: WHO-WHAT提案（status: proposed）

## STEP5 バナー制作

担当: `banner-ai.js` / スキル `cmoai-banner`
入力: 選択WHO-WHAT、広告テンプレ、表現レギュレーション、追加指示、商品識別情報
**事実DBは読まない。**
出力: copyBrief → promptJson → gpt-image-2 画像

## バナー案DBの主要フィールド

- `copyBrief`: slotTexts付きコピー設計（Stage 1の正本）
- `creativeHypothesis`: 勝ち筋仮説
- `approvedClaimSnapshot`: 許可主張スナップショット
- `promptJson` / `promptText`: gpt-image-2向けプロンプト（Stage 2）
- `productImagePaths` / `logoImagePaths` / `otherImagePaths`: ユーザーが明示選択した画像素材。選択済みだけを画像生成へ添付する
- `promptJson.selectedAssetPolicy`: 選択素材の役割・件数・パス・必須性をコード側で固定した契約。選択素材だけを閉じたテンプレ構造より優先する唯一の例外とし、未選択素材は許可しない
- `promptGenerationAudit`: Stage 2の入力文字数・hash、モデル設計呼び出し回数、HTTP試行、request ID、決定論的コピー補正を保存する任意監査情報。プロンプト本文・AI応答本文・APIキーは保存しない
- `imageGenerationAudit`: gpt-image-2の試行時間、request ID、prompt hash、ロゴ判定、retry判断を保存する。ロゴ特化編集時だけ編集元画像hashと入力manifest hashを追加し、絶対パスや画像本体は複製しない
- `jobRecoveryAudit`: サーバー再起動復旧の任意監査情報。`automaticImageRetryCount`、最終復旧action/reason/時刻、旧owner・旧attempt・復旧attemptを保持する。履歴配列、prompt本文、APIキー、絶対パスは保存しない
- `pipelineNodes`: ノード別hashと再開地点
- `productionStatus`: `prompt_ready` / `completed` / `completed_with_warnings` / `failed`
- `logoVerification`: 選択ロゴごとの正式ワードマーク照合結果。`items[]`に`assetOrdinal`、`mode`（`template_slot` / `selected_asset_override`）、`status`、`reason`、`evidenceRegionIds`を保存する。集約statusは`missing` / `present_unlocalized` / `not_verifiable` / `verified`。明示logo image枠と同一zone・同一行のlogo/brand textは一つの複合検証領域とし、領域OCRの不一致が信頼度75未満なら`template_slot_ocr_low_confidence`として`not_verifiable`へ落とす。高信頼の明確な不一致だけを`missing`として自動修復対象にする

`jobRecoveryAudit.lastAction`は`image_requeued`、`image_reset_for_manual_retry`、`edit_reset_preserving_output`、`prompt_reset_for_manual_retry`、`completed_output_preserved`のいずれかとする。通常画像の自動復旧回数は、復旧attemptが実際に処理開始した時点で加算し、最大1回とする。

### テンプレ構造と選択素材の優先順位

`templateZones` は閉じた構造を基本とする。ただしユーザーがバナー案で選択したロゴ・商品画像・その他画像は、画像枠の有無、role、枠数より優先する。対応枠があればそこへ配置し、なければ基本の視線順と可読性を維持した最小限の配置追加・置換を許可する。この例外は選択素材だけに限定し、未選択素材や別の装飾要素は追加しない。ロゴ枠がない場合は、推奨領域・四隅・上下端の候補領域と画像全体OCRを併用する。候補領域外で正式名を確認した場合やOCRだけで欠落を確定できない場合は警告完了とし、高コストな自動再生成は行わない。

## 広告テンプレDB

バナー用広告テンプレは `layoutBlueprint` と `copyBlueprint` を分離して持つ。
全案件共通の `data/ad-templates.json` に保存する。
