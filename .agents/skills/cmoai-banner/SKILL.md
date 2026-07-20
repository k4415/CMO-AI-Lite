---
name: cmoai-banner
description: CMO AI Liteの案件でバナー案の作成から画像生成・拡散・修正までを実行する。「バナー作って」「この案件でバナー10案」「◯◯のバナーを修正して」のような指示のとき必ず使う。テンプレ選定はユーザー指定がなければエージェントが近いものを選ぶ。
---

生成結果の保存前に `docs/agent-output-contract.md` を読み、バナー行の作成、複数素材パス、PATCH形式、保存後確認の契約に従う。

CMO AI Lite のバナー制作スキル。詳細な API・データ配置・選定基準は `docs/agent-operations.md` を先に読むこと。

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

このスキルは「WHO-WHAT戦略 → バナー画像テンプレ + 追加指示 → copyBrief + promptJson → gpt-image-2」を担当する。**事実DBは読み込まない。**

## 実行モード

- バナー生成は copyBrief と画像生成プロンプト(imageText/promptJson/promptText)を作る。
- **サブスク実行モード(エージェントの既定)**: バナー案のテキスト生成は、OpenAI課金を使わず自分(Claude Code / Codex)のモデルで行う。Preflightと2ステージで実行する。
  - Preflight: `config/prompts/banner-hypothesis.md` を読み、同じstrategy・template・追加指示を使う兄弟案ごとに `sharedContract`、`baselineCandidate`、`candidatePatches` を作る。共通項目はコード側の契約どおり固定し、各bannerへ完全形の `creativeHypothesis` を保存してからcopyBriefを作る。完全形仮説を3件別々に作ることは禁止する。一時的な `HypothesisGroupPlan` 自体は保存しない。
  - Stage 1: テンプレの `copyBlueprint` / `templateZones[].elements[]` から `copySlotPlan`（slotId、役割、canonicalField、charBudget）を作る。`config/prompts/banner-copy.md` を読み、選択WHO-WHAT、カテゴリ距離に応じたテンプレ参照、既出コピー、追加指示原文から `slotTexts` 付き `copyBrief` を作る。第1案はテンプレ文面構造ベースの baseline、第2案以降は baseline variation とし、事実DBは読まず、選択WHO-WHAT外の機能・用途・根拠は混ぜない。`near` は心理メカニズムだけ、`far` は抽象化済みpatternまで使う。
  - Stage 2: `config/prompts/banner.md` を読み、確定済み `copyBrief.slotTexts` を変更せず、slotId対応で `imageText`, `selectionReason`, `promptJson`(basic/globalDesign/colorScheme/structureSheet/zones/referenceImage/negativeRules/reviewChecklist を含む), `promptText`, `reviewNotes` を作る。
  1. まず `POST /api/banners` でバナー行を作成する(productId/strategyId必須。テンプレや商品画像/ロゴのpathも通常どおり設定)。
  2. Preflightの完全形 `creativeHypothesis` と `approvedClaimSnapshot`、`generationRunId`、`candidateGroupId`、`candidateIndex` を各bannerへ保存する。部分再実行では同じcandidateGroupIdの正常な保存済み兄弟案をgroup seedにし、失敗したbannerIdのcandidate patchだけを作る。基準兄弟案の仮説・copyBrief・pipeline hash・画像は再保存しない。
  3. Stage 1の `copyBrief` を `PATCH /api/banners/{id}` に `{"project":"...","patch":{"copyBrief":...}}` の形で保存する(**patchでネストしないと無視される**)。`slotTexts` を単一の正にし、mainHook/subHook/proof/offerBadge/cta/disclaimerはslotTextsから導出した値に同期する。
  4. Stage 2で生成したJSON全体を `POST /api/regulations/apply` に通す。`additionalInstruction` も同APIへ渡し、競合時は追加指示を優先する。
  5. 置換後の内容を `PATCH /api/banners/{id}` に保存する。`copyBrief`, `imageText`, `promptJson`, `promptText`, `colorDecision`, `reviewNotes`, `selectionReason` に加えて `productionStatus: "prompt_ready"` を設定する(既存の `generate-prompt` API が生成成功時に設定するのと同じステータス)。失敗した場合は `productionStatus: "failed"` と `lastError` を設定する。
  6. 拡散(`spread`)・修正(`revise`)も同じ考え方で、複数バナー行への展開や再生成分をサブスク実行モードで作れる。ただし手順や横展開の軸出しは既存APIの挙動(戦略軸5案など)を踏襲する。
- **API実行モード**: `POST /api/banners/generate-prompt`、`POST /api/banners/spread`、`POST /api/banners/revise` を使う。サーバー内では Stage 1 copyplan が Anthropic (`claude-opus-4-8`)、Stage 2 と画像生成が OpenAI 系。ユーザーが「UIと同じで」と言ったとき、またはサブスク実行が難しいときに使う。
- **画像生成は常に** `POST /api/banners/generate-image`(gpt-image-2固定・OpenAI課金)。サブスク実行モードでも画像生成だけはこのAPIを呼ぶ。

## 手順

1. **案件特定**: `ls projects/` で候補を確認。指示に案件名がなければユーザーに確認する。以下 `PJ=./projects/{案件名}`。
2. **前提確認**: `data/products.json`(商品)と `data/strategies.json`(WHO-WHAT)を読む。
   - 商品がなければ登録から(cmoai-research スキル)。
   - WHO-WHAT がなければ先に cmoai-who-what スキルで提案→保存。
3. **テンプレ選定**: ルートの `data/ad-templates.json` を読み、WHO-WHAT との相性で選ぶ(`docs/agent-operations.md` の選定基準)。ユーザー指定があれば従う。該当なしなら `templateAdId` を省略してよい。
4. **商品画像・ロゴの確認(重要)**: 対象商品の `images`(`data/products.json`)を確認する。
   - `role: "product"`(商品写真)/ `role: "logo"`(ロゴ)のラベルが付いていれば、その `path` をバナー行の `productImagePath` / `logoImagePath` に設定して生成する(実素材が画像生成に取り込まれる)。
   - **役割ラベルがない画像や、どれが商品写真/ロゴか曖昧な場合は、勝手に判断せず必ずユーザーに確認する**(例: 「assets/products/.../main.png を商品写真として使います。ロゴは xxx.png で合っていますか?」)。
   - 画像が1枚もない場合は「商品画像なしで生成するか、画像を登録するか」を確認する(なしでも生成は可能)。
   - `brandTone` はトーン制約として使う。配色は「追加指示・修正指示 > 表現レギュレーション/正式ブランド指定 > 保存済みWHO-WHAT colorInference > テンプレカラー > safe default」の順でフィールド単位に決める。既存WHO-WHATが`colorInference`未設定なら`insufficient`としてテンプレへフォールバックし、バナー生成中にカラー専用AIを追加しない。選択素材は原本色を維持する。
5. **生成**: サーバー(localhost:5173)が未起動なら `npm run dev` をバックグラウンドで起動してから、上記「実行モード」に従う。
  - 既定(サブスク実行): `POST /api/banners` で行を作成 → Preflightで共通契約と差分を合成しcreativeHypothesisを保存 → Stage 1でcopyBrief生成・保存 → Stage 2で画像prompt生成 → `POST /api/regulations/apply` → `PATCH /api/banners/{id}` で保存(prompt_ready)
   - API実行モード指定時: `POST /api/banners/generate-prompt`
   - 画像は常に `POST /api/banners/generate-image`(gpt-image-2)
   - 複数案の指示(「10案」等)は、戦略軸5案の横展開と、テンプレ/WHO-WHATを変えた追加行の組み合わせで満たす。件数と使ったテンプレを報告する。
   - 注意: UIのバナー操作は「画像生成」(プロンプト生成→画像生成の通し実行)と「削除」のみ。拡散・修正はエージェントの仕事なので、ユーザーから頼まれたらこのスキルで実行する。
6. **修正指示**: 追加指示原文を最優先する。「コピーはそのままで画像だけ変える」等は `copyBrief` / `imageText` をスナップショット固定し、コピー生成をやり直さない。「◯◯を直して」は修正指示を反映したプロンプトを保存し、再度画像生成する(API実行モードなら `POST /api/banners/revise`)。画像の一部分だけを直したい場合はUIの「部分修正」も使える。
7. **報告**: 生成したバナーID、画像パス(`outputs/banners/{bannerId}/`)、選定したテンプレと理由を日本語でまとめる。UI をリロードすれば同じ結果が表示されることを添える。

## 注意

- API エラーの日本語メッセージは略さず報告する(APIキー未設定など)。
- 表現レギュレーション(`data/expression-rules.json`)はサーバー側で自動適用される。置換が入った場合は reviewNotes に記録されるので、あれば報告する。
- 画像生成後はOCRによる `copyIntegrityCheck` を確認する。不一致・未確認は警告付き完成(`completed_with_warnings`)として報告する。
- 仮説差別化だけが2回目も弱い案は `creativeHypothesis.variationReview.continuedAfterReview=true` を保存して画像生成まで続けるが、完成後は目視確認を促す。
- テンプレの表示名・ゾーン表示名・見本コピー・自然言語内の元テンプレ固有色は仮説、コピー、画像の生成入力へ渡さない。`templateColorScheme`の有効色だけは上位3ソースがないフィールドのfallback候補にできる。
- テンプレに `charCount` がある場合は、それを各slotの文字数基準にする。無い場合はプレースホルダー1個を全角4字として推定する。各slotTexts.textの文字数は下限を設けず、charBudgetが10字以下なら13字以内、11字以上なら基準の120%以内（小数点以下切り捨て）に収める。空欄可否は必須スロット判定に従い、CTAスロットがないテンプレではctaは空でよい。
- slotTextsより先に `messagePlan` を作り、商品・対象業務と主約束を一つに絞る。slotTextsはそのoneMessageを視線順に分解し、数字にはmeaning・owner・minimumContextを付ける。商品理解・主便益・数字の意味を初見で誤読する案は保存しない。
