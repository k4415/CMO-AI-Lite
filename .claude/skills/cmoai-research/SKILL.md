---
name: cmoai-research
description: CMO AI Liteの案件で商品登録・内部LP解析・事実抽出を実行する。「この商品でリサーチして」「URLから事実を出して」のような指示のとき必ず使う。
---

生成結果の保存前に `docs/agent-output-contract.md` を読み、Liteの保存単位（LP解析結果は根拠ごとの事実）と引用元URLの規約に従う。

CMO AI Lite のリサーチスキル。API・データ配置は `docs/agent-operations.md` を先に読むこと。`PJ=./projects/{案件名}`。サーバー未起動なら `npm run dev` をバックグラウンド起動。

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

このスキルは上段の「商品URL → 内部LP解析キャッシュ → 事実DB」までを担当する。

## 実行モード

- **サブスク実行モード(エージェントの既定)**: OpenAI課金を使わず、自分(Claude Code / Codex)のモデルで生成する。
  - 事実抽出: `config/prompts/fact-extraction.md` をシステムプロンプトとして読み、`product-research-ai.js` の `buildProductResearchPrompt` と同じ入力(商品マスターDBの対象商品、内部LP解析キャッシュ(id/productId/type/title/sourceUrl/manualText/extractedText/visualAnalysis/screenshotStatus/screenshotCount)、既存事実DB(直近80件))を自分で集めて、同じ出力JSON(`summary`, `facts[]`(title/content/category/sourceType/sourceUrl/sourceMaterialId/confidenceScore), `insufficientCategories[]`)を作る。各 `facts[]` の要素を1件ずつ `POST /api/research/facts`(対象商品の `productId` を必ず含める)で保存する(content/title等のテキストは保存前に `POST /api/regulations/apply` を通す)。
- **API実行モード**: 従来どおり `POST /api/research/facts/extract-ai`(サーバーがOpenAIを呼ぶ・従量課金)。ユーザーが「OpenAIで」「UIと同じで」と言ったとき、またはサブスク実行が難しいときに使う。

## 手順

1. **案件と商品**: 案件がなければ `POST /api/projects`(productName/productUrl を渡すと商品マスターにも自動登録される)。既存案件なら `data/products.json` を確認し、なければ `POST /api/research/products`。
2. **内部LP解析**: 商品URLと登録済みLP/記事LPのうち未解析のURLを先に `POST /api/research/materials/extract` で文字起こしし、解析済みURLは内部LP解析キャッシュ(保存済み本文・スクリーンショット・OCR)を再利用する。
3. **事実抽出**: 上記「実行モード」に従う(既定はサブスク実行 — 商品マスター + 内部LP解析キャッシュ + 8方向Web検索で自分が抽出して `POST /api/research/facts` で1件ずつ保存。API実行モード指定時は `POST /api/research/facts/extract-ai`)。件数と代表的な事実を報告する。
4. **報告**: 追加された事実の件数と要点、次の工程(WHO-WHAT生成)への提案を返す。

## Web網羅リサーチ

事実リサーチを依頼されたときは、「網羅的に」「Webも調べて」という明示がなくても、エージェント自身のWeb検索で次の8方向をすべて調べ、直接事実として抽出する。渡されたLP・記事LPだけを読んで完了にしない。

1. **公式情報**: 公式サイト、公式LP、プレスリリース、公式SNS
2. **口コミ・レビュー**: ECサイトのレビュー、SNSの感想、体験談
3. **比較・おすすめ記事**: 「商品名 比較」「商品名 おすすめ」などのまとめ・比較記事
4. **メディア掲載・受賞**: 紹介記事、掲載実績、受賞歴
5. **専門家・監修・権威性**: 監修者、資格、特許、研究根拠
6. **運営会社**: 会社概要、事業実績、問い合わせ・サポート体制
7. **市場・トレンド・競合**: 市場データ、同カテゴリの競合商品・競合LP
8. **リスク・注意点・規制**: デメリット、利用条件、法令・業界上の注意

見つけた情報から直接事実を抽出し、上記「実行モード」に従って保存する(既定はサブスク実行モード)。このとき各事実の`sourceUrl`には出典URLを必ず入れる。出典が特定できない情報は事実DBに入れない。

完了報告では8方向ごとに、実行した検索クエリ、確認した主要URL、保存した事実件数、情報が見つからなかった観点を示す。1方向でも未検索なら「網羅リサーチ完了」と報告せず、追加検索してから保存・報告する。

## 表現レギュレーション取り込み

ファイル/テキストから表現レギュレーションをAI抽出する。UI の「ファイルから取り込み」と同じく `config/prompts/regulation-import.md` を使う。

- **サブスク実行モード(エージェントの既定)**: `config/prompts/regulation-import.md` をシステムプロンプトとして読み、対象本文(表現レギュ以外の内容が混ざっていてもよい)から AI 抽出して `{ rules: [{ ruleType, pattern, replacement, description, severity }] }` の配列を作る。各ルール行を `POST /api/research/expression-rules` で保存する(project と productId を必ず含める)。
- **API実行モード**: 従来どおり `POST /api/regulations/import-text`(テキスト本文を送り、サーバーが OpenAI で抽出→DB保存を通し実行)または `POST /api/regulations/extract-text`(抽出のみ、保存はしない)。ユーザーが「OpenAIで」と言ったときに使う。

## 注意

- 事実は「1行1事実」で、内部LP解析キャッシュまたはWeb出典に根拠を持つものだけがDBに入る。勝手に facts.json を直接編集して事実を足さない。
- 根拠原文と事実の紐付け(sourceMaterialId)を壊さない。
- 事実DBはWHO-WHAT戦略設計までの入力であり、バナー生成時には読み込まない。
