# Master CMO AI Lite システム理解

CMO AI Lite は、商品URLからバナー画像生成までをローカル実行する制作システムです。

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

## 1. 最上位構造

```text
CMO AI Lite
  ├─ 案件（projects/{案件名}/）
  │   ├─ 商品マスターDB
  │   ├─ 内部LP解析キャッシュ
  │   ├─ 事実DB
  │   ├─ 表現レギュレーションDB
  │   ├─ WHO-WHAT DB
  │   └─ バナー案DB
  ├─ 共通広告テンプレDB (data/ad-templates.json)
  └─ エージェントスキル (.claude/skills/ × 4)
```

## 2. 案件ページの役割

1案件 = 1商品。案件フォルダ内に工程別の JSON DB を持つ。

## 3. STEP1 内部LP解析・事実抽出

### 商品マスター登録

入力: 商品名、公式サイトURL、簡易説明
用途: 事実抽出の検索シード、WHO-WHAT作成時の商品理解

### 内部LP解析キャッシュ

入力: 商品URL
処理: 本文抽出、スクリーンショット取得、OCR、画像内文字分析
出力: 内部LP解析キャッシュ（解析済みURLは再利用）

### 商品事実抽出

入力: 商品マスターDB、内部LP解析キャッシュ、Web検索(8方向)、既存事実DB
処理: 1行1事実で差分追加、sourceUrl必須
出力: 事実DB

**事実DBの利用範囲はWHO-WHAT戦略設計まで。バナー生成では再読込しない。**

## 4. STEP2 WHO-WHAT

入力: 商品マスターDB、商品事実DB、表現レギュレーションDB、既存WHO-WHAT DB
出力: WHO-WHAT提案（「提案中」で自動保存）

## 5. STEP3 バナー制作

入力: 選択WHO-WHAT、広告テンプレ、表現レギュレーション、追加指示
処理: copyBrief → promptJson → gpt-image-2
出力: バナー画像

## 6. 共通テンプレート

成果の出たバナーを `data/ad-templates.json` にテンプレ化し、別案件で再利用する。

## 7. エージェントスキル

| スキル | フェーズ |
| --- | --- |
| cmoai-research | 内部LP解析 → 事実DB |
| cmoai-who-what | 事実DB → WHO-WHAT |
| cmoai-banner | WHO-WHAT → バナー画像 |
| cmoai-template | テンプレ化 |

## 8. 最小再現フロー

```text
案件作成
  -> 商品URL登録
  -> 内部LP解析
  -> 事実抽出
  -> WHO-WHAT作成
  -> バナー制作 (copyBrief + promptJson + gpt-image-2)
```
