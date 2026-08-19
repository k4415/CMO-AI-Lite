# 閉テンプレ投影の強化とW契約の移植

- 日付: 2026-08-19
- 前提ブランチ: feature/banner-image-prompt-writer（PR #9、マージ待ち）
- 参照: Pro版 H-513（テンプレデータ完全性）/ H-529（W契約化、docs/superpowers/plans/2026-08-18-banner-w-prompt-color-intent.md）

## 問題

1. **閉テンプレ経路の投影が既存データを捨てている（Pro H-513と同型）**。`data/ad-templates.json` の templateZones には zone名・実purpose・background描写・要素のfont/effect/配置が、templateGlobalDesign には style/tone/targetImpression/fontPolicy/spacingPolicy/contrastPolicy/visualStyle が入っているのに、`compileClosedTemplatePromptSeed`（src/core/banner-prompt-compiler.js）は purpose を全件同一の定型文にし、background を空にし、font を落とし、image要素contentを3種の固定文言に置換し、globalDesign を designRationale 1本にしている。結果、ライター（Stage 2b）は材料不足のままデザイン散文を書いている。テンプレ再解析は**不要**（データは既にある）。
2. **散文に意図伝達の契約がない（Pro H-529と同型）**。writtenImagePrompt が「形式・目的・スタイル」から始まる保証がなく、配色の選定理由・トーンの感情も裁量任せ。

## 修正方針

### A. 閉テンプレ投影の強化（レビュー反映済み・2026-08-19 Cursorレビュー）

**変更対象は banner-prompt-compiler.js と banner-template-structure.js の両方**。後段の `enforceTemplateStructure` がseedのname/purpose/backgroundを定型文で上書きし、fontはどの段階でも復元されないため、compiler単体の変更では届かない（レビュー指摘#1）。

1. **zone.name**: テンプレの実zone名（例「上部フックエリア」）を投影。`enforceTemplateStructure` の「Zone N」置換をやめ、テンプレ名を保持する
2. **zone.purpose**: **現行の構造維持定型文を維持**（変更しない）。実purposeは元広告の販促意図（「募集終了の限定性」等）をカテゴリ転用先へ漏らすため、既存の抑止方針とテスト（「purpose表層意味を持ち込まない」）を尊重する。視覚的な材料はpurposeではなくbackground/font/画像描写で渡す（レビュー指摘#2の解決）
3. **zone.background**: `buildColorNeutralTemplateZones` はbackgroundをdeleteするため、**raw `template.templateZones[].background` から読み**、`stripTemplateColorTokens` で色トークン除去して投影。`enforceTemplateStructure` でも保持する
4. **element.font**: raw templateZonesの要素fontを色トークン除去のうえ投影し、`normalizeTemplateZones`/`projectElement`（banner-template-structure.js）にfontフィールドを追加して最終zonesまで貫通させる
5. **image要素content**: 固定安全文言（読める文字なし・素材模倣禁止）は維持しつつ、raw templateの元content描写（色トークン除去済み）を**前置**して結合する
6. **globalDesign**: style/tone等は既に `normalizePromptJson` 経由でライターへ到達済み（レビュー指摘#3）。追加するのは (a) `templateGlobalDesign.designRationale` を最終globalDesignマージに含める (b) `colorPolicy: "テンプレ由来の色表現は役割・トーンの参考。具体色は確定パレット（colorScheme）に必ず従う"` の2点のみ
7. **色監査ゲート**: 投影強化後、bundled全テンプレ（100件）に対し `auditPromptColorContract` のドライランをテストとして追加し、named color/元HEXの漏れがhard failにならないことを固定する（レビュー指摘#4）
8. **不変契約**: slotTexts一字不変の流し込み、閉構造契約（zone/element数・type）、colorScheme:{}（後段確定）、text要素contentへの不干渉

### B. W契約の移植（ライター）

1. `config/prompts/banner-image-prompt-writer.md` に3行ヘッダー契約を追加: 散文は必ず次の3行から書き始める
   - 「形式：」（サイズと、これが広告バナーであること。1行）
   - 「目的・戦略：」（誰のどんな認識をどう変え、どんな行動をとってもらうか。1〜2文。コピー文言は書かない）
   - 「スタイル・トーン：」（与えたい印象・トーン・色彩設計の意図。1〜2文）
2. 同mdに配色記述契約を追加: 確定パレットの色をどの役割（濃色・誘目色・背景）にどう使い分けるかと、その選定理由を1文含める。トーンはカテゴリが売る感情（華やかさ・高揚感・幸福感・安心感など）に合わせ、落ち着き・信頼系に固定しない ※Pro H-529との差分: Liteは具体色がコード側で確定済みのため、ライターの役割は「色の選定」ではなく「使い分けの意図の記述」
3. `src/core/banner-image-prompt-writer.js` のヘッダー検証仕様（レビュー指摘#5・#6反映）:
   - 検証は**サニタイズ前のraw散文**に対して行う（サニタイズでヘッダーが落ちた場合に原因を正しくリトライへ伝えるため）
   - 判定: 先頭から3つの非空行が順に `^形式[：:]` `^目的・戦略[：:]` `^スタイル・トーン[：:]` にマッチすること（全角・半角コロン両対応、前後空白許容）
   - 欠落時は当該試行を失敗扱いとし既存リトライ（最大2試行）に載せる。2回失敗時は既存どおり空散文→レガシー経路フォールバック（挙動不変）
   - `sanitizeWriterText` は `^(形式|目的・戦略|スタイル・トーン)[：:]` にマッチする行を**除去対象から除外**する（コピー混入防止はヘッダー3行の文言契約「コピー文言を書かない」とレビューで担保）
   - 以上をテストで固定（ヘッダーあり合格／欠落リトライ／サニタイズとの共存）
4. アセンブリ順は現行維持（head→size→散文→copyBlock→colorBlock→tail）。clipは末尾からのため冒頭ヘッダーは常に生存
5. `PIPELINE_POLICY_VERSIONS.prompt` を 3→4 に一括インクリメント（A+Bで1回のみ）

### C. アーム比較ハーネス（検証用）

`scripts/banner-writer-arm-compare.mjs` を新設。既存バナー1件を入力に、`CMOAI_PROMPT_WRITER_MODEL` を claude-opus-5 / claude-sonnet-5 で切り替えてライター＋最終プロンプト組み立てまでを実行し、散文と最終プロンプトを並べて `outputs/arm-compare/` に保存する（画像生成はオプションフラグ `--images` 時のみ）。人間の目視判定材料にする。

## 検証

- 既存テスト506件の回帰 + 追加テスト（投影強化の各項目、色トークン除去、ヘッダー契約、サニタイズとヘッダーの共存、ポリシーバージョン）
- プロンプトmdの契約文言はテストで逐語アサート（Pro H-476の作法）
- 実画像: ハーネスで Opus 5 vs Sonnet 5 のアーム比較 → 人間の目視判定でライター既定モデルを確定

## スコープ外

- リカバリプロンプトの散文化（フェーズ3）、Vision QA（フェーズ4）、レガシーアセンブリ経路の変更、Stage 1/2aのモデル・プロンプト変更
