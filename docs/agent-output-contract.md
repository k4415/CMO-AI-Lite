# エージェント生成物の保存契約（CMO AI Lite）

Claude Code / Codex や別ツールの生成結果をUIへ反映するための正規契約です。案件JSONを直接編集せず、起動中のサーバーのCRUD APIへ保存してください。

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

## 最短フロー

1. `npm run dev` を起動する。
2. `GET /api/projects` から案件の `path` を得る。
3. `GET /api/research?project=...` を読み、唯一の商品を `products[0]` に固定する。
4. 生成結果を下記の保存単位へ変換する。
5. 生成JSONを `POST /api/regulations/apply` に通す。
6. 置換後JSONをCRUD APIへ保存する。
7. 同じGETで再取得し、保存件数・ID・リレーションを確認する。

`project` は `./projects/{案件名}` です。

## 入れ先

| 生成物 | 保存単位 | API | UI |
| --- | --- | --- | --- |
| 商品名、LP URL、説明 | 1商品 | `PATCH /api/research/products/{id}` | 前提情報 > 商品情報 |
| 商品写真、ロゴ | 1画像 | `POST /api/research/products/upload-image` | 前提情報 > 画像 |
| LP解析結果（根拠原文） | 1原文 | 内部LP解析キャッシュ経由 | （内部） |
| LP・Web検索から得た根拠 | 1事実 | `POST /api/research/facts` | リサーチ > 事実 |
| NG表現、言い換え | 1ルール | `POST /api/research/expression-rules` | 前提情報 > 表現レギュレーション |
| WHO-WHAT案 | 1戦略案 | `POST /api/strategies` | 戦略 |
| バナーの文字・プロンプト | 1バナー案 | `POST /api/banners` → `PATCH /api/banners/{id}` | 制作 |
| 生成画像 | APIが保存 | `POST /api/banners/generate-image` | 制作 |

## 商品

```json
{"project":"./projects/sample","patch":{"name":"商品名","officialUrl":"https://example.com/lp","shortDescription":"誰のどんな課題をどう解決する商品か","brandColor":"#0057B8","brandTone":"清潔感、専門的、誠実"}}
```

## 事実

```json
{"project":"./projects/sample","productId":"prod_xxx","title":"初回価格","content":"初回は税込2,980円で購入できる。","category":"オファー","sourceType":"lp","sourceUrl":"https://example.com/lp","sourceMaterialId":"","confidenceScore":0.95}
```

`sourceUrl` は確認した一次情報ページを必ず入れる。

## WHO-WHAT

入力は商品マスターDB、商品事実DB、表現レギュレーションDB、既存WHO-WHAT DB のみ。

```json
{"project":"./projects/sample","productId":"prod_xxx","conceptName":"忙しい朝の時短ケア","targetAttributes":"30代、仕事と育児を両立","desire":"短時間でもきちんとケアしたい","decisionCriteria":"手間、使用感、継続価格","alternatives":"一般的なオールインワン","productConcept":"1工程で本格ケア","usp":"商品の独自性","benefit":"朝の余裕を保てる","proof":"LPで確認した実績","offer":"LPで確認した特典","markdown":"WHO / WHATの整理本文","status":"proposed"}
```

## バナー案

事実DBはバナー生成の入力に含めない。

```json
{"project":"./projects/sample","title":"朝の時短訴求 01","productId":"prod_xxx","strategyId":"str_xxx","templateAdId":"tpl_xxx","productImagePaths":["assets/products/prod_xxx/img_a.png"],"logoImagePaths":[],"imageSize":"1080x1080"}
```

```json
{"project":"./projects/sample","patch":{"copyBrief":{},"imageText":"メインコピーと補足コピー","promptJson":{},"promptText":"gpt-image-2へ渡す完成プロンプト","productionStatus":"prompt_ready"}}
```

## 禁止事項

- 商品URLだけを事実の代わりに保存しない。
- AIが示した出典を未確認のまま保存しない。
- IDを推測しない。
- JSONファイルを直接編集しない。
- バナー生成時に事実DBを入力として渡さない。

## 完了確認

`GET /api/research?project=./projects/sample` を再取得し、`products` が1件、全生成物の `productId` が一致、事実に `sourceUrl` がある、バナーに `strategyId` があることを確認する。
