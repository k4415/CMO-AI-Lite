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
- `pipelineNodes`: ノード別hashと再開地点
- `productionStatus`: `prompt_ready` / `completed` / `completed_with_warnings` / `failed`

## 広告テンプレDB

バナー用広告テンプレは `layoutBlueprint` と `copyBlueprint` を分離して持つ。
全案件共通の `data/ad-templates.json` に保存する。
