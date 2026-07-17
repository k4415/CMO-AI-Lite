# バナー copyplan の Claude Opus 4.8 化 修正指示書

作成日: 2026-07-17

## 目的

- `.env.example` に追加済みの `ANTHROPIC_API_KEY` を実際の実装・UI・README・運用ドキュメントに反映する。
- バナー制作の Stage 1「コピー案生成 / copyplan」だけを Anthropic の Claude Opus 4.8 へ切り替える。
- バナー copyplan の候補生成ロジックを変更し、第1案をテンプレ文面構造ベースの baseline、第2案以降をその variation にする。
- Stage 2 の promptJson 生成、WHO-WHAT、事実抽出、テンプレ解析、画像生成(`gpt-image-2`)は現行の責務を維持する。

## 今回の前提

- 対象は「バナー制作における copyplan」のみ。バナー生成全体を Anthropic 化するタスクではない。
- 現行 UI のサーバー内蔵実行は、copyplan と Stage 2 prompt 生成をまとめて `/api/banners/generate-prompt` で進める。
- そのため、今回の変更後も UI でバナーを最後まで生成するには OpenAI と Anthropic の両方が必要になる。
- エージェントのサブスク実行モードは別系統で、ここでの主変更対象はサーバー内蔵実行とその説明文。

## 現状確認まとめ

- `.env.example` には `ANTHROPIC_API_KEY` が追加済み。
- ただしランタイム実装は Anthropic をまだ読まない。
- 設定保存は OpenAI 専用で、`src/core/settings-store.js` は `OPENAI_API_KEY` と `local-secrets/openai.json` しか扱っていない。
- 設定 API も `src/server.js` の `/api/settings/openai` のみ。
- 設定画面、オンボーディング、サイドバー状態表示も OpenAI 単独前提。
- 実際の copyplan 実行経路は `src/core/banner-store.js` -> `src/core/banner-copyplan-ai.js`。
- `src/core/banner-copyplan-ai.js` は現在 `openAiJson` を使い、モデル既定値は `CMOAI_TEXT_MODEL || OPENAI_TEXT_MODEL || "gpt-5.5"`。
- `src/core/banner-ai.js` の Stage 2 は引き続き `openAiJson` を使っている。
- README と一部 docs/skills は「AI 実行モジュール = OpenAI API」「OpenAI API キーだけで足りる」という説明のまま。

## 外部仕様メモ

- Anthropic 公式 docs を 2026-07-17 時点で確認した結果、Claude Opus 4.8 の Claude API 上のモデル ID は `claude-opus-4-8`。
- 同 migration guide では、Claude Opus 4.8 で `temperature` / `top_p` / `top_k` の非既定値を送ると 400 になるため、OpenAI 向けのリクエスト形を流用しないこと。
- 実装時の参照先:
  - [Models overview](https://platform.claude.com/docs/en/home)
  - [Model IDs and versioning](https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions)
  - [Migration guide](https://platform.claude.com/docs/en/about-claude/models/migration-guide)

## 変更方針

1. OpenAI の共通テキストモデル変数 `CMOAI_TEXT_MODEL` を流用して copyplan のプロバイダ切替をしない。
2. copyplan 専用のモデル設定を新設し、WHO-WHAT / 事実抽出 / Stage 2 / 画像生成への波及を防ぐ。
3. 設定状態は「OpenAI 設定済みか」ではなく「OpenAI」「Anthropic」を別々に持つ。
4. UI では Anthropic 未設定でも研究や WHO-WHAT は使える状態を保つ。copyplan が必要なタイミングだけ Anthropic 必須にする。
5. `.claude/skills/` と `.agents/skills/` は同文維持。片方だけ直さない。
6. copyplan の sibling 候補は「全部別角度をゼロベース生成」ではなく、第1案 baseline と第2案以降 variation の親子関係で作る。

## copyplan 候補生成の新要件

### 基本ルール

- 第1案は baseline とする。
- baseline は、テンプレートの `copyBlueprint` / `templateZones` / `slotTexts` 構造を前提に、テンプレの文面構造と売れているコピーの型をできるだけ踏襲する。
- ただしテンプレの変数部分は、選択 WHO-WHAT の戦略内容に合わせて差し替える。
- テンプレ構造をそのまま移すと文脈的に不自然な箇所は調整してよい。
- テンプレの title/name/label や見本コピー原文の丸写しは禁止、ただし「文面構造」「型」「意味の流れ」は baseline で最大限利用する。

### variation の定義

- 第2案以降は、baseline の variation とする。
- 変えてよい軸:
  - フック
  - 切り口
  - 言い回し
  - 読み順
- 維持する軸:
  - 同一テンプレ
  - 同一主約束
  - baseline の基本メッセージ構造
  - テンプレが持つコピー型の骨格
- variation は baseline を壊して別広告にしない。baseline からの差分として説明できる範囲にとどめる。

### 実装上の意味

- 現在の「N案それぞれに distinct angle を割り当てる」要件は緩める必要がある。
- 今後は
  - `candidateIndex=0`: template-anchored baseline
  - `candidateIndex>=1`: baseline-preserving variations
  という生成契約に変更する。
- `angle` は sibling 全件で完全重複禁止でなくてもよいが、variation ごとの差分理由は説明可能であること。
- diversity は「別物を作る」ではなく、「baseline から比較検討しやすい variation を作る」方向へ再定義する。

## 必須修正ファイル

### 1. Anthropic 実行層

- `src/core/anthropic-text.js` を新規追加する。
- 役割は OpenAI 用 `openai-text.js` と同じく「JSON 応答を返す薄いラッパー」に限定する。
- 実装要件:
  - `ANTHROPIC_API_KEY` を読む。
  - 既定モデルは `claude-opus-4-8`。
  - Messages API を使う。
  - JSON 専用出力を前提にレスポンス本文をパースする。
  - OpenAI 固有の `reasoning_effort` は送らない。
  - `temperature` / `top_p` / `top_k` は送らない。
  - timeout / retry は `openai-text.js` と同程度の堅さを持たせる。

### 2. copyplan 専用設定

- `src/core/banner-copyplan-ai.js` を Anthropic 既定へ切り替える。
- 同ファイルの候補生成契約も、第1案 baseline / 第2案以降 variation 前提へ更新する。
- ここで新設する環境変数候補:
  - `CMOAI_BANNER_COPY_MODEL` 既定 `claude-opus-4-8`
  - `CMOAI_BANNER_COPY_TIMEOUT_MS`
  - `CMOAI_BANNER_COPY_EFFORT` または同等の Anthropic 用思考深度設定
- `CMOAI_TEXT_MODEL` は他モジュールの OpenAI 系上書きとして残す。
- `buildCopyBriefFromCandidate()` が保存する `copyBrief.model` も `claude-opus-4-8` になるよう揃える。
- `buildCopyplanUserPrompt()` と `validateBatchResponse()` も新契約へ合わせて見直す。

### 2.5. copyplan prompt / hypothesis 契約

- `config/prompts/banner-copy.md` を更新する。
- 必須変更:
  - 第1案を template-anchored baseline として作る指示
  - 第2案以降を baseline variation として作る指示
  - テンプレ文面構造を踏襲してよい範囲
  - 丸写し禁止と、文脈不整合の調整許可
  - variation ごとに何を変え、何を維持したかを自己チェックさせる
- 必要に応じて `config/prompts/banner-hypothesis.md` も見直す。
- 理由:
  - 現在の Preflight / copyplan 周りは「兄弟案間で angle は重複禁止」「各案は独立訴求軸」と読む余地が強い。
  - これを baseline + variation 契約へ寄せないと、実装だけ直しても prompt 側が逆方向に引っ張る。

### 3. API キー管理と設定 API

- `src/core/settings-store.js` に Anthropic 用の取得・保存・状態取得を追加する。
- 推奨保存先:
  - `local-secrets/openai.json`
  - `local-secrets/anthropic.json`
- `src/server.js` に Anthropic 設定 API を追加する。
- 推奨形:
  - `GET /api/settings/openai`
  - `POST /api/settings/openai`
  - `GET /api/settings/anthropic`
  - `POST /api/settings/anthropic`
- 既存 API を壊さず、OpenAI 側の挙動は後方互換を保つ。

### 4. UI 設定画面と状態表示

- `src/ui/index.html`
- `src/ui/app.js`
- 必要なら `src/ui/styles.css`

修正内容:

- 設定画面を OpenAI 単独から「OpenAI」「Anthropic」の 2 カードまたは 2 セクションへ拡張する。
- `openAiConfigured` の単一 boolean 管理をやめ、provider ごとの状態へ分離する。
- サイドバー状態表示は単一の「OpenAI 接続済み」では不足するため、次のどちらかに変える。
  - `OpenAI: 設定済み / Anthropic: 未設定`
  - または provider ごとの個別ステータス表示
- オンボーディング文言も更新し、バナーの copyplan には Anthropic が必要だと明記する。
- 重要:
  - Anthropic 未設定でも研究・WHO-WHAT までをブロックしない。
  - copyplan 実行時の失敗メッセージだけを Anthropic 依存にする。

### 5. README / ドキュメント

#### README

- `README.md`

修正内容:

- 必要環境を「OpenAI API キーのみ」から更新する。
- セットアップ手順に Anthropic キーの設定先を追加する。
- 「OpenAI APIキー（テキスト生成と gpt-image-2 画像生成に使用）」という説明を分解する。
- 環境変数表へ以下を反映する。
  - `ANTHROPIC_API_KEY`
  - `CMOAI_BANNER_COPY_MODEL`
  - 必要なら `CMOAI_BANNER_COPY_TIMEOUT_MS`
  - 必要なら `CMOAI_BANNER_COPY_EFFORT`
- トラブルシューティングに Anthropic 未設定時の症状を追加する。
- 重要な説明:
  - 事実抽出 / WHO-WHAT / Stage 2 / 画像生成は引き続き OpenAI 系
  - バナー Stage 1 copyplan は Anthropic 系
  - UI でバナーを通し生成するには両方必要

#### 必須で更新する docs

- `docs/agent-operations.md`
- `docs/ai-skills-map.md`

更新理由:

- `docs/agent-operations.md` は API 実行モードの説明が「サーバーが OpenAI を呼ぶ」のままで不正確になる。
- `docs/ai-skills-map.md` は「AI実行モジュール = OpenAI APIを使う実行本体」という説明が崩れる。

#### 更新推奨 docs

- `docs/architecture.md`
- `docs/master-cmoai-system.md`

更新内容:

- バナー生成パイプラインの provider 境界を一行だけでも明示する。
- 例:
  - Stage 1 copyplan = Claude Opus 4.8
  - Stage 2 promptJson = 既存 OpenAI 系
  - Stage 3 image = `gpt-image-2`

### 6. スキル文書

- `.claude/skills/cmoai-banner/SKILL.md`
- `.agents/skills/cmoai-banner/SKILL.md`

修正内容:

- API 実行モードの説明を OpenAI 単独前提から修正する。
- 「UIと同じで」の意味が、copyplan は Anthropic、画像は OpenAI、Stage 2 は現状の OpenAI 系であることを明記する。
- Stage 1 copyplan の sibling 生成が「第1案 baseline / 第2案以降 variation」であることを明記する。
- `.claude` と `.agents` の内容差分を作らない。

## 確認は必要だが、必須修正ではないファイル

### `src/core/banner-copy-ai.js`

- 現行の UI 経路では使っていない。
- ただし Stage 1 copy 生成の旧モジュールとして `DEFAULT_TEXT_MODEL = gpt-5.5` を保持している。
- 方針を決めること:
  - 今回は未使用として据え置く
  - もしくは将来の混乱防止のため Anthropic 前提へ揃える
- 据え置くなら、今回の実装 PR で「未使用のため対象外」と明記すること。

### `package.json` / `package-lock.json`

- Anthropic SDK を入れるなら更新が必要。
- ただしこの repo は OpenAI/Gemini とも軽量ラッパーで実装しているため、今回の推奨は SDK 追加なし、`fetch` 実装で統一。
- `fetch` 実装にするなら `package.json` / `package-lock.json` は無変更でよい。

## 実装順

1. `src/core/anthropic-text.js` を追加
2. `src/core/banner-copyplan-ai.js` を copyplan 専用モデル設定へ切替
3. `src/core/settings-store.js` と `src/server.js` に Anthropic 設定 API を追加
4. `src/ui/index.html` / `src/ui/app.js` / `src/ui/styles.css` の設定画面と状態表示を更新
5. `README.md` と必須 docs を更新
6. `cmoai-banner` の両スキルを同期更新
7. テスト追加・更新

## テスト修正 / 追加

### 必須

- `tests/banner-copyplan-ai.test.js`
  - 既定モデルが `claude-opus-4-8` になること
  - `jsonGenerator` 注入時に既存の retry / validation が壊れていないこと
  - `candidateIndex=0` が baseline 前提の入力・検証になること
  - 2案目以降が baseline variation 契約で扱われること
- Anthropic 実行層の新規テスト
  - 例: `tests/anthropic-text.test.js`
  - キー未設定
  - JSON parse
  - retry / timeout

### 必要に応じて

- `tests/banner-diversity.test.js`
  - copyplan を「多様性のための独立 sibling 群」ではなく「baseline + variations」として見直した影響確認
- `tests/banner-copy-ai.test.js`
  - 旧モジュールも揃える場合のみ
- 設定 API のテスト
  - `GET/POST /api/settings/anthropic`
- UI テスト
  - 既存テスト基盤で settings view を持っているなら、Anthropic セクション描画と状態反映を最低限確認

### 注意

- `.claude` / `.agents` を両方更新すると `tests/lite-distribution-scope.test.js` は既存のままで通る想定。
- 片方だけ更新するとこのテストが落ちる。

## 実装時の落とし穴

- `CMOAI_TEXT_MODEL` を `claude-opus-4-8` にすると、WHO-WHAT や事実抽出まで OpenAI 用クライアントで Anthropic モデル名を送る事故が起きる。
- OpenAI 用 `reasoning_effort` を Anthropic 実装へそのまま移植しない。
- UI の「APIキー設定済み」表示を Anthropic も含む全体準備完了と誤認させない。
- バナーの再生成でも、保存済み `copyBrief` を再利用するケースでは Anthropic が不要な場合がある。設定不足時のブロック条件を広くしすぎない。
- `README.md` の「`.env` は自動読み込みされない」という前提は維持する。`.env.example` を増やしただけで動くようにはならない。
- 現在の `banner-copy.md` は sibling 差分を「独立 angle」で作る前提が強い。prompt と validator を両方直さないと、baseline/variation 契約が中途半端になる。
- variation を強くしすぎると baseline のコピー型が崩れ、弱すぎると差分が見えない。保存前に「何を維持し、何を変えたか」を review で読めるようにする。

## 完了条件

- copyplan 実行時のみ Claude Opus 4.8 (`claude-opus-4-8`) が使われる。
- 第1案がテンプレ文面構造ベースの baseline として生成される。
- 第2案以降が baseline の variation として生成され、比較可能な差分を持つ。
- WHO-WHAT / 事実抽出 / Stage 2 / 画像生成の既存経路は壊れない。
- UI で必要キーが誤解なく分かる。
- README / docs / skills / 実装の provider 説明が一致する。
- 既存構文チェックと関連テストが通る。

## 今回の結論

- 修正対象は「コード 4か所だけ」ではなく、実装層・設定層・UI・README・エージェント docs / skills まで横断で発生する。
- 特に重要なのは、copyplan だけを Anthropic 化する以上、「OpenAI を残す箇所」と「Anthropic に切り替える箇所」を明示的に分離すること。
- その分離を入れずに `CMOAI_TEXT_MODEL` だけで済ませる実装は避ける。
