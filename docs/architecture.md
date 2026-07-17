# アーキテクチャ (CMO AI Lite)

CMO AI Lite は、商品URLからバナー画像生成までをローカル実行するアプリです。

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

## 基本構造

```text
ブラウザUI
  -> Local API (src/server.js)
  -> Core AI Modules (src/core/*ai.js)
  -> Project Store (projects/{案件}/data/*.json)
```

```text
Claude Code / Codex
  -> .claude/skills/ (4スキル)
  -> Local API
  -> Project Store
```

## 主要コンポーネント

- **Project Store**: 案件作成、JSON DB読み書き、ログ保存
- **Research Store**: 商品マスター、内部LP解析キャッシュ、事実DB、表現レギュレーション
- **Strategy Store**: WHO-WHAT DB
- **Banner Store**: バナー案DB、生成画像
- **Ad Template Store**: 共通広告テンプレDB (`data/ad-templates.json`)
- **UI**: 工程別のDB操作画面

## バナー生成パイプライン

```text
Preflight (creativeHypothesis)
  -> Stage 1 コピー開発 (copyBrief)
  -> Stage 2 デザイン化 (promptJson / promptText)
  -> Stage 3 画像生成 (gpt-image-2)
```

Stage 1 は選択されたWHO-WHATの範囲だけでコピーを開発する。事実DBは読まない。

Stage 2 は copyBrief の文言を変更せず、slotId対応で画像生成プロンプト化する。

## DB境界

| DB | WHO-WHAT | バナー |
| --- | --- | --- |
| 商品マスターDB | ○ | ○（識別情報のみ） |
| 商品事実DB | ○ | × |
| 表現レギュレーションDB | ○ | ○（制約のみ） |
| 既存WHO-WHAT DB | ○ | × |
| 選択WHO-WHAT DB | — | ○ |
| 広告テンプレDB | — | ○ |
| 追加指示 | — | ○ |

## 案件フォルダ構成

```text
projects/{案件名}/
  project.json
  data/
    products.json
    research-materials.json   # 内部LP解析キャッシュ
    facts.json
    expression-rules.json
    strategies.json
    banner-creatives.json
  outputs/
    banners/{bannerId}/
```

共通DB: `data/ad-templates.json`（全案件共有）
