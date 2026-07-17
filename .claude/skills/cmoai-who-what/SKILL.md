---
name: cmoai-who-what
description: CMO AI Liteの案件でWHO-WHAT(戦略仮説)の提案を生成する。「WHO-WHAT作って」「戦略仮説を出して」「ターゲット案を考えて」のような指示のとき必ず使う。生成した提案は「提案中」ステータスで自動保存される。
---

生成結果の保存前に `docs/agent-output-contract.md` を読み、1案件1商品、必須の `productId`、ステータス値、完成JSONの契約に従う。

CMO AI Lite の WHO-WHAT スキル。API・データ配置は `docs/agent-operations.md` を先に読むこと。`PJ=./projects/{案件名}`。サーバー未起動なら `npm run dev` をバックグラウンド起動。

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

このスキルは「事実DB → WHO-WHAT戦略」を担当する。

## 入力DB（これ以外は読まない）

- 商品マスターDB
- 商品事実DB
- 表現レギュレーションDB
- 既存WHO-WHAT DB

## 実行モード

- **サブスク実行モード(エージェントの既定)**: OpenAI課金を使わず、自分(Claude Code / Codex)のモデルで生成する。`config/prompts/who-what.md` をシステムプロンプトとして読み、`who-what-ai.js` の `buildWhoWhatPrompt` と同じ入力(対象商品の商品マスターDB、関連する商品事実DB(直近80件)、表現レギュレーションDB(対象商品分、直近40件)、既存WHO-WHAT DB(対象商品分、直近20件))を自分で集めて、同じ出力JSON(`summary`, `warnings[]`, `proposals[]`(各: `segmentName`, `conceptName`(20文字目安), `targetAttributes`, `desire`, `decisionCriteria`, `alternatives`, `productConcept`, `usp`, `benefit`, `proof`, `offer`, `markdown`))を2〜3案作る。各 `proposals[]` を `POST /api/regulations/apply` に通してから、1件ずつ `POST /api/strategies`(`status` を省略すれば自動で `"proposed"` になり、既存の `/api/strategies/generate` と同じ「提案中」ステータスで保存される)で保存する。
- **API実行モード**: 従来どおり `POST /api/strategies/generate`(サーバーがOpenAIを呼ぶ・従量課金)。ユーザーが「OpenAIで」「UIと同じで」と言ったとき、またはサブスク実行が難しいときに使う。

## 手順

1. **前提確認**: `data/products.json`(対象商品を特定。複数あればユーザーに確認)と `data/facts.json` を読む。事実が0件なら「先に事実抽出をすると精度が上がる」と伝えたうえで、続行するか確認する。
2. **提案生成**: 上記「実行モード」に従う(既定はサブスク実行 — 自分で2〜3案を生成し `POST /api/regulations/apply` を通して `POST /api/strategies` で1件ずつ保存。API実行モード指定時は `POST /api/strategies/generate` で生成+自動保存)。いずれも「提案中」ステータスで保存される。
3. **報告と整理**: 保存された各案の要点を日本語で提示する。ユーザーが不要と言った案は `PATCH /api/strategies/{id}` に `{"project":"...","patch":{"status":"archived"}}` を送ってアーカイブする(patchでネスト必須)(削除はしない。アーカイブは戻せる)。修正指示があれば PATCH で内容へ反映する。
4. **報告**: 保存された WHO-WHAT の ID と概要、次工程(バナー制作)への提案を返す。

## 注意

- 既存の WHO-WHAT(`data/strategies.json`)は生成時にコンテキストとして自動で渡される。2回目以降は「既存案との差分・新しい切り口」を意識して提示する。全部を作り直す必要はない。
- 商品ごとに WHO-WHAT を分けて管理する(strategy の productId を必ず対象商品にする)。
- 口コミ・顧客の声は商品事実DBの「実績」カテゴリから参照する。事実DBにない内容は推測で埋めない。
