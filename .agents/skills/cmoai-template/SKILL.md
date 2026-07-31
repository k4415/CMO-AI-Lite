---
name: cmoai-template
description: CMO AI Liteの広告テンプレDBでバナー画像テンプレ化を実行する。「このバナーをテンプレ化して」のような指示のとき必ず使う。UI実行と同じ config/prompts を使う。
---

CMO AI Lite のテンプレ化スキル。API・データ配置は `docs/agent-operations.md` を先に読むこと。共通の広告テンプレDB は `data/ad-templates.json`(案件配下ではない)。

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

このスキルは「バナー画像テンプレ」の登録・変数化を担当する。

## 実行モード

- **サブスク実行モード(エージェントの既定)**: OpenAI課金を使わず、自分(Claude Code / Codex)のモデルで生成する。
  - バナー画像テンプレ化: `config/prompts/template-banner-image.md`(画像分析→JSON)。画像入力が要るためこれは基本 **API実行**(`POST /api/ad-templates/template-image/enqueue`)。
  - **重要**: 変数化は config/prompts に従い、固有名詞/成果/価格/通常価格/割引率/割引額/実績数/期間/権威者/媒体名まで漏れなくプレースホルダー化する(シンプルな{商品名}{数値}止まりにしない)。
- **API実行モード**: ユーザーが「OpenAIで」「UIと同じ課金で」と言ったとき、サーバーのテンプレ化API を使う。
  - 解析受付: `POST /api/ad-templates/template-image/enqueue`（`templateId` 必須）
  - 状態確認: `GET /api/ad-templates/template-image/status?templateIds={templateId}`
  - 同期API `POST /api/ad-templates/template-image` は互換用。エージェントの通常実行では使わない。

## 手順

1. **テンプレ対象の確認**: `data/ad-templates.json` を読み、テンプレ化する対象テンプレ行の `id` と `imageFile` を確認する。
2. **プロンプト確認**: `config/prompts/template-banner-image.md` を読み、画像分析の方針(構造・配色・成功要因の抽出)を把握する。
3. **非同期で受付**:
   - `POST /api/ad-templates/template-image/enqueue` を呼ぶ。HTTP 202 / `accepted: true` を受付完了とし、長時間の同期HTTP接続を保持しない。
   - `TEMPLATE_ANALYSIS_ALREADY_ACTIVE` の409が返った場合は再投入せず、既存ジョブの状態確認へ進む。
4. **状態監視**:
   - `GET /api/ad-templates/template-image/status?templateIds={templateId}` を3〜5秒間隔で確認する。他の安全な作業は解析中も進めてよい。
   - `templateProcessingStatus` が `queued` / `running` の間は監視を続ける。
   - `completed` かつ `templateStatus: "template_ready"` で成功。`failed` の場合は `templateAnalysisError` を省略せず報告する。
   - 対象テンプレートがレスポンスにない、状態APIへ接続できない、または未知の状態値になった場合は無限監視せず、その事実を報告して停止する。
5. **結果確認**: 成功後に `data/ad-templates.json` の対象行とUIを再読込し、サムネイル/構造が更新されたことを確認する。抽出された構造・配色・成功要因を報告する。

## 注意

- バナー画像テンプレ化の分析精度向上のため、`config/prompts/template-banner-image.md` で指定された構造・配色・成功要因の抽出をしっかり拾う。
- 受付成功だけでテンプレ化完了と報告しない。必ず状態APIで終端状態まで確認する。
- API実行で失敗したら、エラーメッセージを略さず報告する。
- 共通テンプレDB(`data/ad-templates.json`)へのアクセスなので、他案件パスに書き込まないこと。
