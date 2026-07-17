# CMO AI Lite 開発エージェント指示

このリポジトリは、商品URLから事実抽出・WHO-WHAT戦略・バナー画像生成までをローカル実行できる制作システムです。作業前にこのファイルを読み、DB構造・AIスキル・プロンプトを前提に判断してください。

## 基本方針

- 返答、ドキュメント、コミット本文は日本語を基本にする。
- 配布本体に開発用エージェント、検証用ログ、不要なskillsを混ぜない。
- **CMO AI Liteは5ステップに特化**: 内部LP解析 → 事実抽出 → WHO-WHAT → バナー(copyBrief+promptJson) → gpt-image-2。
- 1案件=1商品を前提にする(複数商品は別案件として登録する)。1商品に複数事実・複数WHO-WHAT・複数バナー案がある前提は維持する。
- 案件を新規作成したら、商品マスターDB、内部LP解析キャッシュ、事実DB、表現レギュレーションDB、WHO-WHAT DB、バナー制作DB、outputs/logs は案件配下に新規作成する。
- 共通DBは広告テンプレDB(バナー画像テンプレのみ)だけ。広告テンプレはアプリルートの `data/ad-templates.json` を使い、`projects/{案件}/data/ad-templates.json` を新規運用に使わない。
- UIは業務DB操作を目指す。フォームよりテーブル上で追加、編集、選択、詳細確認できる体験を優先する。

## データフロー（正）

```text
商品URL
  → 内部LP解析キャッシュ（本文・スクリーンショット・OCR・抽出ジョブ）
  → 事実DB
  → WHO-WHAT戦略
  → バナー画像テンプレ + 追加指示
  → copyBrief + promptJson
  → gpt-image-2
```

**事実DBはWHO-WHAT戦略設計までの入力であり、バナー生成時には読み込まず、プロンプト・画像完成判定へ渡さない。**

## まず読む資料

- 全体像: `docs/master-cmoai-system.md`
- アーキテクチャ: `docs/architecture.md`
- データモデル: `docs/data-model.md`
- ワークフロー: `docs/workflow-design.md`
- テンプレ化プロンプト原文: `docs/template-prompt-sources.md`
- Engineering Loop: `docs/engineering-loop.md`
- エージェント運用(案件操作のAPI・スキル): `docs/agent-operations.md` と `.claude/skills/`

## エージェントスキル（4体）

| スキル | 担当 |
| --- | --- |
| `cmoai-research` | 商品登録・内部LP解析・事実抽出 |
| `cmoai-who-what` | WHO-WHAT戦略提案 |
| `cmoai-banner` | バナー案・copyBrief・promptJson・画像生成 |
| `cmoai-template` | バナー画像テンプレ化 |

`.agents/skills/` と `.claude/skills/` は同一内容を維持する。

## 主な実装箇所

- Web UI: `src/ui/index.html`, `src/ui/app.js`, `src/ui/styles.css`
- サーバー/API: `src/server.js`
- 商品、内部LP解析キャッシュ、事実、表現レギュレーション: `src/core/research-store.js`
- 商品事実抽出AI: `src/core/product-research-ai.js`
- WHO-WHAT生成AI: `src/core/who-what-ai.js`, `src/core/strategy-store.js`
- 広告テンプレDB、テンプレ化AI: `src/core/ad-template-store.js`, `src/core/template-ai.js`
- バナー案DB、バナー生成AI: `src/core/banner-store.js`, `src/core/banner-ai.js`, `src/core/openai-image.js`
- OpenAI呼び出し: `src/core/openai-text.js`, `src/core/openai-image.js`
- 案件データ: `projects/{案件名}/data/*.json`
- 共通広告テンプレDB: `data/ad-templates.json`

## ワークフロー別の確認先

### STEP1 内部LP解析・事実抽出

1. `docs/data-model.md`
2. `src/core/research-store.js`
3. `src/core/product-research-ai.js`
4. 案件の `data/products.json`, `data/research-materials.json`(内部LP解析キャッシュ), `data/facts.json`

事実抽出の入力は「商品マスター + 内部LP解析キャッシュ + 8方向Web検索」。商品URLと登録済みLP/記事LPを事実抽出前に内部LP解析キャッシュへ非同期書き出しし、HTML本文・スクリーンショット・画像内文字を一次情報として利用する。解析済みURLはキャッシュを再利用する。

### STEP2 WHO-WHAT生成

1. `src/core/who-what-ai.js`
2. `src/core/strategy-store.js`
3. 入力: 商品マスターDB、商品事実DB、表現レギュレーションDB、既存WHO-WHAT DB のみ

WHO-WHAT生成の提案は「提案中」ステータスで自動保存される。不要な案の整理はアーカイブで行う。

### STEP3 バナー制作

1. `docs/template-prompt-sources.md`
2. `src/core/banner-ai.js`
3. `src/core/banner-store.js`
4. `src/core/template-ai.js`
5. `data/banner-creatives.json`, `data/ad-templates.json`

バナー案の生成は **copyplan → prompt → image の3ノード** で実行する。生成素材は、選択WHO-WHAT、共通広告テンプレ、追加指示原文に限定する。商品マスターは商品名・正式素材等の識別情報、表現レギュレーションは制約としてのみ使う。終端ステータスは `completed` / `completed_with_warnings` / `failed` の3値。

### エージェント作業(ターミナル)

UI内蔵ターミナル(PTY)は廃止した。エージェントによる作業は、手元のターミナルで Claude Code / Codex を直接起動し、`.claude/skills/` と `docs/agent-operations.md` を読んで、案件フォルダ(`projects/{案件名}/`)とサーバーAPIを操作する方式に一本化している。

## AI実行とプロンプトの正

- システムプロンプトの正は `config/prompts/*.md`(単一ソース)。各 `src/core/*-ai.js` はモジュール読み込み時にこのファイルを読んで定数化しているだけで、プロンプト本文はここにしか置かない。
- UIからの操作は常に**サーバー内蔵実行**(`src/core/*-ai.js` がサーバー側でOpenAIを呼ぶ)で、挙動は変わらない。
- エージェント(Claude Code / Codex)は既定で**サブスク実行モード**(config/prompts を読み、同じ入力を集めて自分のモデルで生成し、既存のCRUD APIで保存する)を使う。画像生成(`POST /api/banners/generate-image`, `gpt-image-2`)は常にAPI実行。詳細は `docs/agent-operations.md` と各 `.claude/skills/*/SKILL.md` の「実行モード」を参照。

## OpenAIモデル

- テキスト/JSON/画像分析のデフォルト: `gpt-5.5`(全AIモジュール共通)
- 上書き: `CMOAI_TEXT_MODEL` または `OPENAI_TEXT_MODEL`
- バナー画像生成: `gpt-image-2` 固定

## 検証

変更後は最低限以下を確認する。

```bash
node --check src/server.js
node --check src/ui/app.js
node --check src/core/openai-text.js
node --check src/core/who-what-ai.js
node --check src/core/banner-ai.js
node --check src/core/template-ai.js
node --check src/core/product-research-ai.js
node --check src/core/lp-vision-ai.js
```

UI変更時は `npm run dev` で起動し、テーブル追加、セル編集、詳細ペイン、WHO-WHAT生成、バナー案生成、gpt-image-2画像生成の導線を確認する。

## エージェント実行モード

Claude Code / Codex から操作する場合は、`.claude/skills/`（または `.agents/skills/`）の4スキルと `docs/agent-operations.md` に従う。テキスト生成はサブスク実行モード、画像生成（`gpt-image-2`）はOpenAI API実行。
