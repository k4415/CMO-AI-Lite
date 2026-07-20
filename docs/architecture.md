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
  -> Stage 1 コピー開発 (copyBrief / Anthropic Claude Opus 4.8)
  -> Stage 2 デザイン化 (promptJson / promptText / OpenAI 系)
  -> Stage 3 画像生成 (gpt-image-2 / OpenAI)
```

Stage 1 は選択されたWHO-WHATの範囲だけでコピーを開発する。事実DBは読まない。
第1案はテンプレ文面構造ベースの baseline、第2案以降は baseline variation として作る。

Stage 2 は copyBrief の文言を変更せず、slotId対応で画像生成プロンプト化する。

### サーバー再起動時のジョブ復旧

サーバーは起動時と60秒間隔で、draft案件の`promptGenerationLease`と`imageGenerationLease`を検査する。期限切れ、またはownerId先頭のPIDが存在しないリースだけを放棄ジョブとして扱う。PIDを判定できないownerIdは期限切れまで待ち、生存中の別サーバーが持つジョブは引き取らない。

- 通常画像生成: 現在のimage入力hashが一致し、自動復旧が未実施なら新attemptとして既存の最大10並列画像キューへ1回だけ再投入する
- コピー設計・prompt: 外部AIへ自動再送せず、成果物を保持して再生成可能な失敗状態へ戻す
- 範囲指定修正・全体修正: 既存画像、コピー、promptを保持し、修正を再実行できる状態へ戻す
- 保存済み画像とcontent hashがある場合: APIを再送せず完了状態を復元する

旧attemptの完了結果はattemptId照合で拒否し、新attemptを上書きさせない。自動画像再投入後に再び中断した場合は、二重課金を抑えるため自動再送せず手動再生成へ戻す。

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
