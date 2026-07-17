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
  - バナー画像テンプレ化: `config/prompts/template-banner-image.md`(画像分析→JSON)。画像入力が要るためこれは基本 **API実行**(`POST /api/ad-templates/template-image`)。
  - **重要**: 変数化は config/prompts に従い、固有名詞/成果/価格/通常価格/割引率/割引額/実績数/期間/権威者/媒体名まで漏れなくプレースホルダー化する(シンプルな{商品名}{数値}止まりにしない)。
- **API実行モード**: ユーザーが「OpenAIで」「UIと同じ課金で」と言ったとき、サーバーのテンプレ化API を使う。
  - バナー画像: `POST /api/ad-templates/template-image`（`templateId` 必須）

## 手順

1. **テンプレ対象の確認**: `data/ad-templates.json` を読み、テンプレ化する対象テンプレ行の `id` と `imageFile` を確認する。
2. **プロンプト確認**: `config/prompts/template-banner-image.md` を読み、画像分析の方針(構造・配色・成功要因の抽出)を把握する。
3. **実行**:
   - API実行: `POST /api/ad-templates/template-image` を呼び、画像分析結果をテンプレに保存。保存時に `templateStatus: "template_ready"` も設定される。
4. **結果確認**: テンプレのサムネイル/構造が更新されたことを確認(UI リロードで表示)。抽出された構造・配色・成功要因を報告する。

## 注意

- バナー画像テンプレ化の分析精度向上のため、`config/prompts/template-banner-image.md` で指定された構造・配色・成功要因の抽出をしっかり拾う。
- API実行で失敗したら、エラーメッセージを略さず報告する。
- 共通テンプレDB(`data/ad-templates.json`)へのアクセスなので、他案件パスに書き込まないこと。
