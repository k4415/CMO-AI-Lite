# Agent Runtime Policy

CMO AI Lite の agent jobs は以下の環境で動作する想定です。

- Agent providers: Claude Code / Codex
- Operating systems: Windows and macOS

## 実装ルール

- ジョブの入出力はファイルベース。`input.json`, `prompt.md`, `output.md`, `result.json`, `run.log` を優先する。
- ビジネスロジックを1つのCLIに結合しない。`codex` / `claude` のプロバイダ抽象化を使う。
- パスは `path.join` / `path.resolve` ベース。OS固有の処理は `process.platform` のみ。
- UTF-8日本語入力は Node ベースのリーダーを使う。
- 失敗時も必ず `result.json` を書く。

## 内部LP解析

商品URLから内部LP解析キャッシュ（本文・スクリーンショット・OCR）を生成する際:

- `CMOAI_MATERIAL_EXTRACTOR=codex` → Codex
- `CMOAI_MATERIAL_EXTRACTOR=claude` → Claude Code
- `CMOAI_MATERIAL_EXTRACTOR=vision` → 直接 AI Vision

## エージェントスキル

4スキル(cmoai-research / cmoai-who-what / cmoai-banner / cmoai-template)は `.claude/skills/` と `.agents/skills/` に同一内容で配置する。
