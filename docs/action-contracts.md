# Action Contract v0.3 (CMO AI Lite)

Action Contractは、CMO AI LiteのAIワークフローを実行可能な単位に分解した定義です。

## 共通フィールド

- `id`: CLI/UIで指定するAction ID
- `phase`: research / strategy / creative / template / operation
- `name`: UI表示名
- `description`: 目的
- `reads`: 読み込むDB/ファイル
- `writes`: 書き込むDB/ファイル
- `requiresReview`: ユーザー確認が必要か
- `handler`: 実行関数またはAPI

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

## 実装済みAction

### project.resolve_context

案件フォルダ内の必要DBとMarkdownを読み込み、後続ActionやAI生成が使えるコンテキストにまとめます。

### research.extract_lp_cache

商品URLから内部LP解析キャッシュ（本文・スクリーンショット・OCR）を生成します。

- 実装: `src/core/research-store.js`, `src/core/lp-vision-ai.js`
- 読む: 商品マスターDB、商品URL
- 書く: 内部LP解析キャッシュ(`research-materials.json`)

### research.extract_facts

商品事実抽出です。

- 実装: `src/core/product-research-ai.js`
- 読む: 商品マスターDB、内部LP解析キャッシュ、Web検索結果、既存事実DB
- 書く: 事実DB

### strategy.create_who_what

WHO-WHAT戦略提案の生成です。

- 実装: `src/core/who-what-ai.js`
- 読む: 商品マスターDB、商品事実DB、表現レギュレーションDB、既存WHO-WHAT DB
- 出力: WHO-WHAT提案（「提案中」で自動保存）

### content.banner_create

バナー制作です。パイプラインは `copyplan → prompt → image` の3ノード。

- 実装: `src/core/banner-ai.js`, `src/core/banner-store.js`, `src/core/banner-copyplan-ai.js`
- 読む: 商品マスターDB（識別情報・正式素材のみ）、WHO-WHAT DB、広告テンプレDB、表現レギュレーションDB、バナー案DB、追加指示。**事実DBは読まない。**
- 出力: copyBrief、promptJson、promptText、生成画像
- 画像生成: `src/core/openai-image.js` で `gpt-image-2` を固定使用

### template.banner_image

バナー画像を分析し、再利用可能な画像生成プロンプトJSONへ変換します。

- 実装: `src/core/template-ai.js`
- 読む: 広告テンプレDBの画像パス
- 出力: `templatePromptJson`, `successFactors`

## 注意

現在のボタン生成系は、主に `src/core/*ai.js` と `src/core/*store.js` を使います。実装判断時は `AGENTS.md` を先に読んでください。
