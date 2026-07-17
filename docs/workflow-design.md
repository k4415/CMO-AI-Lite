# ワークフロー設計 (CMO AI Lite)

CMO AI Lite の本質は、次の5ステップです。

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

## 全体フロー

```text
0. セットアップ（案件作成・商品登録）
1. STEP1 内部LP解析・事実抽出
2. STEP2 WHO-WHAT戦略
3. STEP3 バナー制作（copyBrief → promptJson → gpt-image-2）
4. 成果物レビュー・修正
5. 成功パターンを共通テンプレートへ蓄積
```

## Phase 1: リサーチ

```text
案件作成
  -> 商品登録（商品URL）
  -> 内部LP解析（本文・スクリーンショット・OCR）
  -> 事実抽出（8方向Web検索）
  -> 表現レギュレーション登録
```

| Step | 入力 | 処理 | 出力 |
| --- | --- | --- | --- |
| 商品登録 | 商品名、公式URL | 商品マスターDBへ保存 | 商品基礎データ |
| 内部LP解析 | 商品URL | 本文抽出、スクショ、OCR | 内部LP解析キャッシュ |
| 事実抽出 | 商品DB、LPキャッシュ、Web検索 | fact-extraction | 事実DBレコード |

## Phase 2: 戦略

```text
WHO-WHAT仮説生成（提案中で自動保存）
  -> 採用 / アーカイブ
```

入力: 商品マスターDB、商品事実DB、表現レギュレーションDB、既存WHO-WHAT DB

## Phase 3: バナー制作

```text
広告テンプレ選定 + 追加指示
  -> Preflight (creativeHypothesis)
  -> Stage 1 copyBrief
  -> Stage 2 promptJson
  -> gpt-image-2 画像生成
```

事実DBは入力に含めない。選択WHO-WHATに反映済みの内容だけを使う。

終端ステータス: `completed` / `completed_with_warnings` / `failed`

## Phase 4: テンプレ循環

```text
参考バナー登録
  -> バナー画像テンプレ化
  -> 別案件で再利用
```

## エージェント実行

4スキル(cmoai-research / cmoai-who-what / cmoai-banner / cmoai-template)で上記フローをターミナルから実行できる。詳細は `docs/agent-operations.md`。
