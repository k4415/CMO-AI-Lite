このリポジトリで作業する前に @AGENTS.md を読むこと。

CMO AI Lite は次の5ステップに特化する。

```text
商品URL
  → 内部LP解析キャッシュ（本文・スクリーンショット・OCR・抽出ジョブ）
  → 事実DB
  → WHO-WHAT戦略
  → バナー画像テンプレ + 追加指示
  → copyBrief + promptJson
  → gpt-image-2
```

- 操作API・データ配置・テンプレ選定基準: `docs/agent-operations.md`
- ユーザー向け定型フロー(4スキル): `.claude/skills/`（cmoai-research / cmoai-who-what / cmoai-banner / cmoai-template）
- 「この案件でバナー作って」等の指示は、該当スキルの手順に従って実行する。
- 事実DBはWHO-WHATまで。バナー生成では事実DBを読まない。
