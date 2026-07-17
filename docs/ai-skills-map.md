# AIスキル配置 (CMO AI Lite)

CMO AI Lite では、4つのエージェントスキルと AI モジュールでワークフローを構成します。

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

## 配置方針

| 要素 | 置き場所 | 役割 |
| --- | --- | --- |
| スキル一覧 | `.claude/skills/` / `.agents/skills/` | Claude Code / Codex が読む定型ワークフロー（4スキル） |
| システムプロンプト | `config/prompts/*.md` | AI実行の単一ソース |
| AI実行モジュール | `src/core/*ai.js` | OpenAI APIを使う実行本体 |
| DB保存/更新 | `src/core/*store.js` | ローカルJSON DBの読み書き |
| 案件データ | `projects/{案件}/data/*.json` | 商品、事実、WHO-WHAT、バナー案 |

## 4スキル

| スキル | AIモジュール | 担当フェーズ |
| --- | --- | --- |
| `cmoai-research` | `product-research-ai.js`, `lp-vision-ai.js` | 内部LP解析 → 事実DB |
| `cmoai-who-what` | `who-what-ai.js` | 事実DB → WHO-WHAT |
| `cmoai-banner` | `banner-ai.js`, `openai-image.js` | WHO-WHAT → copyBrief → gpt-image-2 |
| `cmoai-template` | `template-ai.js` | バナー画像テンプレ化 |

## WHO-WHAT入力DB

- 商品マスターDB
- 商品事実DB
- 表現レギュレーションDB
- 既存WHO-WHAT DB

## バナー入力DB

- 商品マスターDB（識別情報・正式素材のみ）
- 選択WHO-WHAT DB
- 広告テンプレDB
- 表現レギュレーションDB
- 追加指示

**事実DBはバナー生成では読まない。**

## エージェント連携

UI内蔵ターミナル(PTY)は廃止済み。手元の Claude Code / Codex でリポジトリを開き、4スキルと `docs/agent-operations.md` のAPIリファレンスで案件を操作する。

## AIスキルの構成要素

1. 対象DBの読み取り
2. リレーション解決
3. 推論手順（`config/prompts/*.md`）
4. 出力JSON/Markdownの整形
5. CRUD API経由でのDB保存
6. ステータス更新

新しい実装を追加する場合は、まず `AGENTS.md` を確認してください。
