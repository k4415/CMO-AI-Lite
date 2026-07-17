# エージェント運用ガイド(Claude Code / Codex 向け)

> **生成物の保存契約**: 生成結果を保存するときは、先に [`docs/agent-output-contract.md`](agent-output-contract.md) を読む。

このリポジトリをローカルの Claude Code や Codex で開き、「この案件でバナー作って」のような雑な指示から作業を完了させるためのガイド。エージェントは作業前にこのファイルと `AGENTS.md` を読むこと。

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

## 前提

- CMO AI Lite は案件フォルダ(`projects/{案件名}/`)の JSON を直接データベースとして使う。UI(`npm run dev` → http://localhost:5173)は同じファイルを読み書きする「確認と選択」の画面。
- システムプロンプトの正は `config/prompts/*.md`(単一ソース)。エージェントが独自にプロンプトを組んで直接ファイルを書くことは禁止。
- AI実行には2つのモードがある。
  - **サブスク実行モード(エージェントの既定)**: `config/prompts/*.md` を読み、該当AIモジュールの `build*Prompt` と同じ入力を自分で集めて、Claude Code / Codex 自身のモデルで同じ出力JSONスキーマを作る。結果は既存のCRUD APIで保存し、テキストは保存前に `POST /api/regulations/apply` でNG表現を置換する。
  - **API実行モード**: サーバー側の生成API(`*/generate*`, `*/extract-ai` など)を使う。UIからの操作は常にこちら。
- 画像生成は常に `POST /api/banners/generate-image`(`gpt-image-2` 固定、OpenAI課金)。

## エージェントスキル（4体）

| スキル | 担当 |
| --- | --- |
| `cmoai-research` | 商品登録・内部LP解析・事実抽出 |
| `cmoai-who-what` | WHO-WHAT戦略提案 |
| `cmoai-banner` | バナー案・copyBrief・promptJson・画像生成 |
| `cmoai-template` | バナー画像テンプレ化 |

`.claude/skills/` と `.agents/skills/` は同一内容。

## サーバー起動

```bash
npm install
npm run dev   # http://localhost:5173
```

起動確認: `curl -s http://localhost:5173/api/projects`

## データの場所

| データ | パス |
| --- | --- |
| 案件一覧 | `projects/{案件名}/project.json` |
| 商品マスター | `projects/{案件名}/data/products.json` |
| 内部LP解析キャッシュ | `projects/{案件名}/data/research-materials.json` |
| 事実DB | `projects/{案件名}/data/facts.json` |
| 表現レギュレーション | `projects/{案件名}/data/expression-rules.json` |
| WHO-WHAT | `projects/{案件名}/data/strategies.json` |
| バナー案 | `projects/{案件名}/data/banner-creatives.json` |
| 生成画像 | `projects/{案件名}/outputs/banners/{bannerId}/` |
| 広告テンプレ(全案件共通) | `data/ad-templates.json` |

## 主要 API

```bash
# 案件作成
curl -s -X POST localhost:5173/api/projects -H "content-type: application/json" \
  -d '{"projectName":"案件名","productName":"商品名","productUrl":"https://..."}'

# 商品 / 内部LP解析 / 事実
POST /api/research/products            {"project":"...","name":"...","officialUrl":"..."}
POST /api/research/materials/extract   {"project":"...","materialId":"..."}
POST /api/research/facts               {"project":"...","productId":"...","title":"...","content":"..."}
POST /api/research/facts/extract-ai    {"project":"...","productId":"..."}

# WHO-WHAT
POST /api/strategies/generate          {"project":"...","productId":"..."}
POST /api/strategies                   {"project":"...", ...内容}

# NG表現置換
POST /api/regulations/apply            {"project":"...","target":{ ...任意のJSON }}
POST /api/regulations/import-text      {"project":"...","text":"..."}

# 商品画像/ロゴ
POST /api/research/products/upload-image  {"project":"...","productId":"...","fileName":"main.png","dataBase64":"...","role":"product"}

# バナー
POST /api/banners                  {"project":"...","title":"...","productId":"...","strategyId":"..."}
POST /api/banners/generate-prompt  {"project":"...","bannerId":"..."}
POST /api/banners/generate-image   {"project":"...","bannerId":"..."}
POST /api/banners/spread           {"project":"...","bannerId":"..."}
POST /api/banners/revise           {"project":"...","bannerId":"...","revisionInstruction":"..."}
POST /api/banners/edit-image       {"project":"...","bannerId":"...","editMode":"range|full",...}
PATCH /api/banners/{id}            {"project":"...","patch":{...}}

# テンプレ化
POST /api/ad-templates/template-image  {"project":"...","templateId":"..."}
```

## バナー生成の入力制約

サブスク実行モードでバナーを作る場合、生成素材は**選択WHO-WHAT・広告テンプレ・追加指示原文**に限定する。**事実DBは読まない。**

Preflight → Stage 1(copyBrief) → Stage 2(promptJson) → 画像生成(gpt-image-2) の順。詳細は `.claude/skills/cmoai-banner/SKILL.md` を参照。

追加指示は表現レギュレーションより優先する。

## テンプレ選定

エージェントが `data/ad-templates.json` を読み、WHO-WHAT との相性で近いものを選ぶ。ユーザー指定があれば最優先。迷ったらテンプレなし(`templateAdId` 省略)でも生成できる。

## テンプレ化

バナー画像テンプレ化のみ。`config/prompts/template-banner-image.md` を読んでから `POST /api/ad-templates/template-image` を実行。変数化は網羅的に行う。詳細は `.claude/skills/cmoai-template/SKILL.md`。

## Web網羅リサーチ

事実リサーチでは8方向(公式、口コミ、比較、メディア、専門家、運営会社、市場・競合、リスク)をすべて調べ、出典URL付きで事実DBへ保存する。詳細は `.claude/skills/cmoai-research/SKILL.md`。

## 守ること

- 1案件1商品の前提を維持する。共通DBは `data/ad-templates.json` だけ。
- WHO-WHAT の不要な案はアーカイブ(status: archived)で整理する。
- 他案件のフォルダに書き込まない。
