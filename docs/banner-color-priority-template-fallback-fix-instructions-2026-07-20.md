# バナーカラー優先順位・テンプレフォールバック 修正指示書

> **対象リポジトリ:** `/Users/koukamiyoshihiko/CMO-AI-Lite-main`
>
> **作成日:** 2026-07-20
>
> **状態:** 実装・無料の生成前検証完了。`6bb20fe`のAIジョブモニター復旧と競合せず、有料のgpt-image-2実画像4ケースだけ未実施（ユーザー事前承認が必要）。実装結果は「21. 実装・検証結果」に記録する。
>
> **実装時必須:** `superpowers:test-driven-development` と `implementation-self-review-loop` を適用し、各TaskをRED→GREEN→自己レビューの順で進める。

## 1. Goal

バナーで使うカラーを、次の優先順位で一意かつ監査可能に決定する。

1. バナーごとの追加指示・修正指示
2. 表現レギュレーション／正式ブランド指定
3. 選択したWHO-WHATに保存されたAI配色推論
4. 上位3ソースに有効な指定がないフィールドだけテンプレカラー
5. テンプレにも有効色がないフィールドだけ安全な標準色

テンプレのレイアウト、zone、element、視線誘導、余白、影・縁取り等の構造的効果は維持する。一方、テンプレ由来のHEX、色名、配色説明、色を含む`effect`やshape説明は構造の正本にせず、最終的に確定した`colorDecision.palette`へ再バインドする。

バナー生成時に新しいAI呼び出しは追加しない。WHO-WHATからの配色推論は、既存のWHO-WHAT生成1リクエストの応答へ同梱して保存し、バナー生成時はローカルの純粋関数だけでカラーを決定する。

## 2. Architecture

`copyplan → prompt → image`の3ノードは維持する。

```text
WHO-WHAT生成（既存AI呼び出し1回）
  └─ proposal.colorInferenceを同時生成・保存
       ├─ status: inferred | insufficient
       ├─ palette: main / sub / accent / background
       ├─ reason
       └─ evidence[]

バナー生成
  ├─ additionalInstruction + revisionInstructionを構造化
  ├─ 表現レギュレーション + product.brandColorを構造化
  ├─ strategy.colorInferenceを読む（AIは呼ばない）
  ├─ template.templateColorSchemeを最終フォールバック候補として読む
  └─ resolveBannerColorDecision()
       ├─ フィールド単位で優先順位を解決
       ├─ テンプレ構造から元色の表層表現を除去
       ├─ 確定paletteをtext / shape / backgroundへ再バインド
       ├─ promptJson.colorScheme / colorDecisionを保存
       └─ gpt-image-2へ矛盾のない配色だけを渡す
```

責務を次の2モジュールへ分離する。

- `src/core/banner-color-decision.js`
  - 各ソースのパレット正規化
  - フィールド単位の優先順位解決
  - `colorDecision`監査データ生成
- `src/core/banner-template-color.js`
  - テンプレの色表現を構造情報から分離
  - テンプレ要素への`colorRole`割り当て
  - 解決済みpaletteの再バインド
  - 最終promptのカラー契約検査

## 3. 診断根拠

### 3.1 現在の色漏れ

現行実装は`templateColorScheme`のHEXを直接使わない一方、次のフィールドを画像promptへ残している。

- `templateGlobalDesign.style`
- `templateGlobalDesign.fontPolicy`
- `templateGlobalDesign.contrastPolicy`
- `templateGlobalDesign.visualStyle`
- `templateZones[].elements[].effect`
- shapeの`description` / `content`

配布テンプレ100件を調べた結果は次のとおり。

| 調査対象 | 色表現を含むテンプレ数 |
| --- | ---: |
| 保持対象の`templateGlobalDesign` | 99 / 100 |
| elementの`effect` | 86 / 100 |
| shapeの`description` / `content` | 93 / 100 |

`tpl_default_026`では、コンパイラ段階で「左上の戻る矢印」まで色を除去しても、`enforceTemplateStructure()`後に「左上のゴールドの戻る矢印」へ戻ることを確認した。原因は、shapeに新しいアクセントが明示されない場合、`projectShapeSurface()`が元テンプレの`source.content` / `source.effect`を復元するためである。

したがって、現在の`colorDecision.ignoredTemplatePalette=true`は「`templateColorScheme`を直接採用していない」ことしか表しておらず、テンプレの自然言語内の配色情報を無視した証拠にはならない。

### 3.2 速度検証

保存済み77件の`pipelineNodes` / `promptGenerationAudit`を集計した。

| 処理 | 件数 | 中央値 | P95 | 最大 |
| --- | ---: | ---: | ---: | ---: |
| copyplan | 77 | 63,049ms | 194,540ms | 201,322ms |
| 閉じたテンプレの決定論的prompt | 52 | 6ms | 16ms | 46ms |
| AIを使うStage 2 prompt | 11 | 232,292ms | 372,989ms | 475,644ms |
| 画像生成 | 42 | 48,465ms | 185,529ms | 217,631ms |

結論:

- バナー生成時にカラー推論用AI呼び出しを追加してはならない。保存済み実績では、追加1回だけで3分SLAを超え得る。
- ローカルのカラー決定処理は速度問題にならない。

最終実装を`node scripts/validate-banner-color-performance.mjs`で5回測定し、中央値を採用した結果:

- 100万回のフィールド別カラー決定: 11,291.432ms
- 1バナーあたり: 約11.291マイクロ秒
- 100テンプレ × 1,000周のneutralize + bind: 22,787.352ms
- 1テンプレあたり: 約227.874マイクロ秒
- 10バナーの追加ローカル時間推定: 約2.392ms
- 全100テンプレの構造不変: `true`
- ネットワーク呼び出し: 0回
- 性能ゲート: `pass: true`（10バナー10ms以下）

WHO-WHAT 3案へ`colorInference`を同梱する想定JSONは約497文字、概算約125出力トークンであり、追加HTTPリクエストは0回である。WHO-WHAT生成時間への小さな増加はあり得るが、バナー生成時間には加算しない。

## 4. 優先仕様と既存文書との関係

本書はカラー決定に限り、次の既存記述を更新する。

- `.agents/skills/cmoai-banner/SKILL.md` / `.claude/skills/cmoai-banner/SKILL.md`
  - 旧: `追加指示 > レギュレーション/ブランド > WHO-WHAT推論 > 安全な標準色`
  - 新: `追加指示 > レギュレーション/ブランド > 保存済みWHO-WHAT推論 > テンプレカラー > 安全な標準色`
- `config/prompts/banner.md`
  - 旧: 元テンプレのHEXを入力にも出力にも使わない。
  - 新: 元テンプレの色は上位3ソースがないフィールドのフォールバック候補としてだけ使う。具体色を含むテンプレ文章は直接使わず、`templateColorScheme`から構造化して使う。
- `docs/banner-template-closed-structure-fix-instructions-2026-07-20.md`
  - zone数、element数、type、slotId、position、size、影・縁取り等の**効果種別**は固定する。
  - 色付きeffectの**色表層**は固定しない。確定paletteへ再バインドする。
- `docs/banner-generation-latency-retry-fix-instructions-2026-07-20.md`
  - 閉じたテンプレの`modelDesignCalls=0`と決定論的compilerを維持する。

既存の選択素材例外は変更しない。ロゴ・商品画像・その他画像の原本色は保持し、最終paletteに合わせて再着色しない。

## 5. Non-negotiable constraints

- `copyplan → prompt → image`の3ノードを増減しない。
- バナー生成時にカラー推論用のAI呼び出しを追加しない。
- 閉じたテンプレのStage 2は`modelDesignCalls=0`を維持する。
- WHO-WHAT生成は既存の`openAiJson()` 1回だけを使い、カラー専用の2回目を呼ばない。
- 事実DBをバナー生成入力へ追加しない。
- 確定`copyBrief.slotTexts`を変更しない。
- テンプレのzone数、element数、type、slotId、position、sizeを変更しない。
- 色の置換を理由に新しいtext / image / shapeを追加しない。
- テンプレDB `data/ad-templates.json` の100件を一括書き換えない。実行時正規化で後方互換を維持する。
- 既存戦略に`colorInference`がない場合、バナー生成中にAI補完せず`insufficient`としてテンプレへフォールバックする。
- ユーザー選択ロゴ・商品画像・その他画像は原本色を維持する。
- HTML、CSS、Python、Pillow、canvas、スクリーンショット等で色や文字を後処理合成しない。
- gpt-image-2、画像品質設定、worker並列数を本修正で変更しない。
- UIへカラーピッカーや新しい入力フォームを追加しない。
- 個別案件JSONや検証画像をGitへ追加しない。
- 有料の実画像API検証は実行前にユーザーの許可を得る。

## 6. データ契約

### 6.1 共通Palette

内部では次の4フィールドだけを正とする。値は大文字`#RRGGBB`へ正規化する。

```js
{
  main: "#16324F",
  sub: "#FFFFFF",
  accent: "#F28C28",
  background: "#F7FAFC"
}
```

許可する入力:

- `#RRGGBB`
- `#RGB`（正規化時に`#RRGGBB`へ展開）
- 日本語・英語の既定色名
  - 赤 / red: `#DC2626`
  - 青 / blue: `#2563EB`
  - 緑 / green: `#16A34A`
  - 黄 / yellow: `#EAB308`
  - オレンジ / orange: `#F97316`
  - ピンク / pink: `#EC4899`
  - 紫 / purple: `#7C3AED`
  - 黒 / black: `#111827`
  - 白 / white: `#FFFFFF`
  - グレー / gray / grey: `#6B7280`

不正値、空文字、`#XXXXXX`は未指定として次順位へフォールバックする。

### 6.2 `strategy.colorInference`

新規WHO-WHATへ次を保存する。

```json
{
  "status": "inferred",
  "palette": {
    "main": "#16324F",
    "sub": "#FFFFFF",
    "accent": "#F28C28",
    "background": "#F7FAFC"
  },
  "reason": "信頼感を基調にしつつ、低リスクの初回行動を暖色で強調する",
  "evidence": [
    "判断基準: 信頼できる",
    "オファー: 無料相談から始める"
  ]
}
```

推論根拠が不足する場合:

```json
{
  "status": "insufficient",
  "palette": {},
  "reason": "WHO-WHAT内に配色判断へ接続できる根拠がない",
  "evidence": []
}
```

`status=inferred`の成立条件:

- `main` / `sub` / `accent` / `background`がすべて有効な`#RRGGBB`
- `reason`が空でない
- `evidence`が1件以上
- `evidence`が同じproposalの`targetAttributes` / `desire` / `decisionCriteria` / `productConcept` / `benefit` / `offer`のいずれかを参照している

1つでも満たさなければコード側で`insufficient`へ正規化する。テンプレ、テンプレ名、テンプレカラー、商品事実の生値を`colorInference.evidence`へ入れない。

### 6.3 `banner.colorDecision` version 2

```json
{
  "version": 2,
  "palette": {
    "main": "#003366",
    "sub": "#FFFFFF",
    "accent": "#FF6600",
    "background": "#F8FAFC"
  },
  "source": "mixed",
  "sourceByField": {
    "main": "regulation",
    "sub": "who_what_inference",
    "accent": "user_instruction",
    "background": "who_what_inference"
  },
  "reasonByField": {
    "main": "表現レギュレーションのメインカラー",
    "sub": "WHO-WHAT配色推論",
    "accent": "追加指示のアクセントカラー",
    "background": "WHO-WHAT配色推論"
  },
  "sourcesUsed": [
    "user_instruction",
    "regulation",
    "who_what_inference"
  ],
  "templateFallbackFields": [],
  "safeDefaultFields": [],
  "strategyInferenceStatus": "inferred",
  "templatePaletteAvailable": true,
  "contractReview": {
    "status": "passed",
    "unexpectedHex": [],
    "unexpectedNamedColorPaths": []
  }
}
```

`source`は4フィールドが同一ソースならそのソース名、複数なら`mixed`とする。旧`colorDecision`は読み込み可能なまま残し、新たに生成・再生成したバナーだけversion 2で保存する。

### 6.4 フィールド単位の優先順位

各フィールドを独立して次の順に解決する。

```text
user_instruction
  > regulation
  > official_brand
  > who_what_inference
  > template
  > safe_default
```

同じ階層内の規則:

- `additionalInstruction`と`revisionInstruction`は連結し、後に書かれた`revisionInstruction`を同一フィールド内で優先する。
- 表現レギュレーションに複数指定がある場合、案件内の配列順で後の有効ルールを優先する。
- 表現レギュレーションと`product.brandColor`が競合する場合、表現レギュレーションを優先する。
- `product.brandColor`に役割名がない単一色だけがある場合は`main`候補とする。
- WHO-WHATは`status=inferred`の場合だけ候補にする。
- テンプレは`template.templateColorScheme`、次に`template.templatePromptJson.colorScheme`を読む。
- テンプレの一部フィールドだけが欠落している場合、そのフィールドだけ安全な標準色へ落とす。

### 6.5 自由文カラー指定の構造化

1つの自由文から最初の1色だけを拾う現行`extractPaletteOverride()`を廃止し、役割ごとに複数色を抽出する。

次を必須対応例とする。

```text
メインカラーは#0B1F3A、アクセントは#FF6B00、背景は白
```

期待値:

```json
{
  "main": "#0B1F3A",
  "accent": "#FF6B00",
  "background": "#FFFFFF"
}
```

```text
全体は明るい白地と青のアクセント
```

期待値:

```json
{
  "accent": "#2563EB",
  "background": "#FFFFFF"
}
```

役割語のない単一色は`main`へ割り当てる。複数色があり、役割対応を一意に決められない場合は無理に割り当てず、該当フィールドを未指定として下位ソースへフォールバックする。

## 7. ファイル変更マップ

### Create

- `src/core/banner-color-decision.js`
- `src/core/banner-template-color.js`
- `tests/banner-color-decision.test.js`
- `tests/banner-template-color.test.js`
- `tests/who-what-color-inference.test.js`
- `scripts/validate-banner-color-performance.mjs`

### Modify

- `config/prompts/who-what.md`
- `config/prompts/banner.md`
- `src/core/who-what-ai.js`
- `src/core/strategy-store.js`
- `src/core/banner-ai.js`
- `src/core/banner-prompt-compiler.js`
- `src/core/banner-template-structure.js`
- `src/core/openai-image.js`
- `tests/banner-prompt-compiler.test.js`
- `tests/banner-prompt-json.test.js`
- `tests/banner-prompt-audit.test.js`
- `tests/banner-template-structure.test.js`
- `docs/data-model.md`
- `docs/agent-operations.md`
- `docs/workflow-design.md`
- `.agents/skills/cmoai-banner/SKILL.md`
- `.claude/skills/cmoai-banner/SKILL.md`
- `docs/banner-template-closed-structure-fix-instructions-2026-07-20.md`
- `docs/banner-generation-latency-retry-fix-instructions-2026-07-20.md`

### Do not modify

- `data/ad-templates.json`
- `projects/*/data/*.json`
- `src/ui/index.html`
- `src/ui/app.js`
- `src/ui/styles.css`

## 8. Task 1: カラー候補正規化・優先順位解決

**Files:**

- Create: `src/core/banner-color-decision.js`
- Create: `tests/banner-color-decision.test.js`
- Modify: `tests/banner-instruction-policy.test.js`

**Interfaces:**

```js
normalizeColorValue(value) -> "#RRGGBB" | ""
extractPaletteFromText(text) -> Partial<ColorPalette>
extractRegulationPalette(rules) -> Partial<ColorPalette>
extractOfficialBrandPalette(product) -> Partial<ColorPalette>
normalizeColorInference(value, strategy) -> ColorInference
colorReason(field, source) -> string
resolveBannerColorDecision(input) -> ColorDecisionV2
```

`resolveBannerColorDecision()`の入力:

```js
{
  userInstruction: "",
  expressionRules: [],
  product: {},
  strategy: {},
  template: {},
  safePalette: {
    main: "#1F2937",
    sub: "#FFFFFF",
    accent: "#F97316",
    background: "#F8FAFC"
  }
}
```

- [x] **Step 1: 複数色抽出とフィールド別優先順位の失敗テストを書く**

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  extractPaletteFromText,
  resolveBannerColorDecision
} from "../src/core/banner-color-decision.js";

test("追加指示の複数カラーを役割別に抽出する", () => {
  assert.deepEqual(
    extractPaletteFromText("メインカラーは#0B1F3A、アクセントは#FF6B00、背景は白"),
    { main: "#0B1F3A", accent: "#FF6B00", background: "#FFFFFF" }
  );
  assert.deepEqual(
    extractPaletteFromText("全体は明るい白地と青のアクセント"),
    { accent: "#2563EB", background: "#FFFFFF" }
  );
});

test("カラーをフィールド単位で優先順位解決する", () => {
  const decision = resolveBannerColorDecision({
    userInstruction: "アクセントは#FF6600",
    expressionRules: [{ ruleType: "image_rule", description: "メインカラーは#003366" }],
    product: {},
    strategy: {
      decisionCriteria: "信頼できる",
      colorInference: {
        status: "inferred",
        palette: { main: "#102030", sub: "#FFFFFF", accent: "#E06020", background: "#F8F5F0" },
        reason: "信頼感と行動喚起",
        evidence: ["判断基準: 信頼できる"]
      }
    },
    template: {
      templateColorScheme: { main: "#111111", sub: "#EEEEEE", accent: "#D8A514", background: "#FFFFFF" }
    }
  });

  assert.deepEqual(decision.palette, {
    main: "#003366",
    sub: "#FFFFFF",
    accent: "#FF6600",
    background: "#F8F5F0"
  });
  assert.deepEqual(decision.sourceByField, {
    main: "regulation",
    sub: "who_what_inference",
    accent: "user_instruction",
    background: "who_what_inference"
  });
  assert.equal(decision.source, "mixed");
  assert.deepEqual(decision.templateFallbackFields, []);
});

test("WHO-WHATがinsufficientならテンプレカラーへフォールバックする", () => {
  const templatePalette = { main: "#000000", sub: "#BDBDBD", accent: "#D8A514", background: "#FFFFFF" };
  const decision = resolveBannerColorDecision({
    strategy: { colorInference: { status: "insufficient", palette: {}, reason: "根拠不足", evidence: [] } },
    template: { templateColorScheme: templatePalette }
  });

  assert.deepEqual(decision.palette, templatePalette);
  assert.deepEqual(decision.templateFallbackFields, ["main", "sub", "accent", "background"]);
  assert.equal(decision.source, "template");
});
```

- [x] **Step 2: REDを確認する**

Run:

```bash
node --test tests/banner-color-decision.test.js
```

Expected: `ERR_MODULE_NOT_FOUND`または未実装exportでFAIL。

- [x] **Step 3: 純粋関数を実装する**

`src/core/banner-color-decision.js`へ次の定数とexportを置く。

```js
export const COLOR_FIELDS = Object.freeze(["main", "sub", "accent", "background"]);
export const SAFE_BANNER_PALETTE = Object.freeze({
  main: "#1F2937",
  sub: "#FFFFFF",
  accent: "#F97316",
  background: "#F8FAFC"
});

export function resolveBannerColorDecision({
  userInstruction = "",
  expressionRules = [],
  product = {},
  strategy = {},
  template = {},
  safePalette = SAFE_BANNER_PALETTE
} = {}) {
  const candidates = [
    ["user_instruction", extractPaletteFromText(userInstruction)],
    ["regulation", extractRegulationPalette(expressionRules)],
    ["official_brand", extractOfficialBrandPalette(product)],
    ["who_what_inference", normalizeColorInference(strategy.colorInference, strategy).palette],
    ["template", normalizePalette(template.templateColorScheme || template.templatePromptJson?.colorScheme)],
    ["safe_default", normalizePalette(safePalette)]
  ];
  const palette = {};
  const sourceByField = {};
  const reasonByField = {};

  for (const field of COLOR_FIELDS) {
    const winner = candidates.find(([, candidate]) => candidate[field]);
    palette[field] = winner[1][field];
    sourceByField[field] = winner[0];
    reasonByField[field] = colorReason(field, winner[0]);
  }

  const sourcesUsed = [...new Set(COLOR_FIELDS.map((field) => sourceByField[field]))];
  return {
    version: 2,
    palette,
    source: sourcesUsed.length === 1 ? sourcesUsed[0] : "mixed",
    sourceByField,
    reasonByField,
    sourcesUsed,
    templateFallbackFields: COLOR_FIELDS.filter((field) => sourceByField[field] === "template"),
    safeDefaultFields: COLOR_FIELDS.filter((field) => sourceByField[field] === "safe_default"),
    strategyInferenceStatus: normalizeColorInference(strategy.colorInference, strategy).status,
    templatePaletteAvailable: Object.keys(normalizePalette(template.templateColorScheme || template.templatePromptJson?.colorScheme)).length > 0
  };
}
```

`colorReason(field, source)`は、採用フィールドと採用元を日本語の固定文言へ変換するprivate helperとして同ファイルへ実装する。動的なAI生成文やテンプレ文章は使わない。

実装では`normalizeColorInference()`を1回だけ呼び、上の説明コードにある重複呼び出しをローカル変数へまとめる。入力objectを変更せず、戻り値はJSON serializableにする。

- [x] **Step 4: GREENを確認する**

Run:

```bash
node --test tests/banner-color-decision.test.js tests/banner-instruction-policy.test.js
```

Expected: 全件PASS。

- [x] **Step 5: Task 1自己レビューを行う**

確認項目:

- `#RGB` / `#RRGGBB` / 色名が大文字HEXへ統一される。
- 1つの文章から複数フィールドを抽出できる。
- 不明な複数色を誤って`main`へまとめない。
- 入力配列・objectを変更しない。
- 旧`extractPaletteOverride()`の「最初の1色だけ」問題を残していない。

## 9. Task 2: WHO-WHAT生成時の配色推論同梱

**Files:**

- Modify: `config/prompts/who-what.md`
- Modify: `src/core/who-what-ai.js`
- Modify: `src/core/strategy-store.js`
- Create: `tests/who-what-color-inference.test.js`

**Interfaces:**

```js
normalizeWhoWhatColorInference(value, proposal) -> ColorInference
generateWhoWhatProposals(context, { jsonGenerator? }) -> existing result shape
strategy.colorInference -> persisted object
```

- [x] **Step 1: 正常推論・棄権・保存の失敗テストを書く**

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeWhoWhatColorInference } from "../src/core/who-what-ai.js";
import { addStrategy, listStrategies } from "../src/core/strategy-store.js";

test("根拠付き4色だけをinferredとして受理する", () => {
  const proposal = { decisionCriteria: "信頼できる", offer: "無料相談から始める" };
  assert.deepEqual(normalizeWhoWhatColorInference({
    status: "inferred",
    palette: { main: "#16324f", sub: "#fff", accent: "#f28c28", background: "#f7fafc" },
    reason: "信頼感と低リスク行動",
    evidence: ["判断基準: 信頼できる", "オファー: 無料相談から始める"]
  }, proposal), {
    status: "inferred",
    palette: { main: "#16324F", sub: "#FFFFFF", accent: "#F28C28", background: "#F7FAFC" },
    reason: "信頼感と低リスク行動",
    evidence: ["判断基準: 信頼できる", "オファー: 無料相談から始める"]
  });
});

test("色不足または根拠なしをinsufficientへ落とす", () => {
  const actual = normalizeWhoWhatColorInference({
    status: "inferred",
    palette: { accent: "#F28C28" },
    reason: "なんとなく",
    evidence: []
  }, { benefit: "制作を短縮する" });
  assert.equal(actual.status, "insufficient");
  assert.deepEqual(actual.palette, {});
});

test("strategy storeがcolorInferenceを保存・再読込する", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cmoai-strategy-color-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "data"), { recursive: true });
  const colorInference = {
    status: "inferred",
    palette: { main: "#16324F", sub: "#FFFFFF", accent: "#F28C28", background: "#F7FAFC" },
    reason: "信頼感を基調にする",
    evidence: ["判断基準: 信頼できる"]
  };
  const saved = await addStrategy(root, {
    productId: "product-1",
    conceptName: "信頼起点",
    decisionCriteria: "信頼できる",
    colorInference
  });
  const loaded = (await listStrategies(root)).find((item) => item.id === saved.id);
  assert.deepEqual(loaded.colorInference, colorInference);
});
```

- [x] **Step 2: REDを確認する**

Run:

```bash
node --test tests/who-what-color-inference.test.js
```

Expected: normalizer未export、保存時フィールド欠落のいずれかでFAIL。

- [x] **Step 3: WHO-WHAT出力契約を更新する**

`config/prompts/who-what.md`と`buildWhoWhatPrompt()`へ次の意味を追加する。

```json
{
  "colorInference": {
    "status": "inferred | insufficient",
    "palette": {
      "main": "#RRGGBB",
      "sub": "#RRGGBB",
      "accent": "#RRGGBB",
      "background": "#RRGGBB"
    },
    "reason": "",
    "evidence": []
  }
}
```

プロンプトへ次を明記する。

- 各proposalのWHO-WHAT内容だけから配色を推論する。
- テンプレートや参考バナーを推論根拠にしない。
- 表現レギュレーションやブランド色を`colorInference`へ混ぜない。これらはバナー生成時の上位ソースで別途適用する。
- 戦略的な色判断へ接続できる根拠がなければ`insufficient`を返す。
- `inferred`では4色・reason・evidenceを必須とする。
- 色は視認性とコントラストを確保し、背景とmainを同一色にしない。

- [x] **Step 4: AI呼び出し回数を増やさず正規化・保存する**

`generateWhoWhatProposals()`は現在の`openAiJson()` 1回を維持する。テスト注入用に`options.jsonGenerator || openAiJson`を使えるようにし、2回目を追加しない。

`normalizeProposals()`で各proposalへ次を追加する。

```js
colorInference: normalizeWhoWhatColorInference(item.colorInference, item)
```

`strategy-store.js`の`normalizeStrategy()`へ次を追加する。

```js
colorInference: normalizeStoredColorInference(input.colorInference)
```

`normalizeStoredColorInference()`はJSON objectだけを受け、未知キーを落として`status` / `palette` / `reason` / `evidence`だけを返す。旧戦略で未設定の場合はフィールド自体を`null`にせず、`{status:"insufficient",palette:{},reason:"legacy_or_manual_strategy",evidence:[]}`として扱う。

- `addStrategy()` / `upsertStrategyFromAction()` / `updateStrategy()`では、正規化後の値を保存する。
- `listStrategies()`では読込結果を`normalizeStrategy()`へ通し、旧レコードをメモリ上で`insufficient`へ補完して返す。
- 旧JSONファイルを一括更新するmigrationは作らない。既存レコードが明示的に更新された時だけ、新形式で再保存される。

- [x] **Step 5: 1リクエストだけであることをテストする**

`tests/who-what-color-inference.test.js`へ、`jsonGenerator`の呼び出し回数が1で、2〜3proposalの`colorInference`が正規化されるテストを追加する。

Run:

```bash
node --test tests/who-what-color-inference.test.js
```

Expected: 全件PASS、`jsonGenerator`呼び出し1回。

## 10. Task 3: テンプレカラーの構造分離と再バインド

**Files:**

- Create: `src/core/banner-template-color.js`
- Create: `tests/banner-template-color.test.js`
- Modify: `src/core/banner-template-structure.js`
- Modify: `tests/banner-prompt-compiler.test.js`

**Interfaces:**

```js
buildColorNeutralTemplateDesign(templateGlobalDesign) -> object
buildColorNeutralTemplateZones(templateZones, templateColorScheme) -> zones with colorRole
bindResolvedPaletteToZones(zones, palette) -> zones
auditPromptColorContract({ promptJson, templateColorScheme, colorDecision }) -> review
```

- [x] **Step 1: 現在のゴールド復元を表す失敗テストを書く**

```js
test("色指定なしでも構造正規化後に元テンプレ色語を復元しない", () => {
  const templateZones = [{
    position: "top",
    elements: [
      { type: "shape", role: "icon", description: "左上のゴールドの戻る矢印" },
      { type: "text", role: "headline", color: "#000000", effect: "白い縁取り、黒い影" }
    ]
  }];
  const neutral = buildColorNeutralTemplateZones(templateZones, {
    main: "#000000", sub: "#BDBDBD", accent: "#D8A514", background: "#FFFFFF"
  });
  const enforced = enforceTemplateStructure({
    templateZones: neutral,
    generatedZones: neutral
  });
  const serialized = JSON.stringify(enforced.zones);
  assert.doesNotMatch(serialized, /ゴールド|黒い|白い|#000000|#D8A514/);
  assert.match(serialized, /戻る矢印|縁取り|影/);
});

test("確定paletteをcolorRoleへ再バインドする", () => {
  const zones = [{
    elements: [
      { type: "shape", role: "icon", colorRole: "accent", content: "戻る矢印" },
      { type: "text", role: "headline", colorRole: "main", content: "見出し" },
      { type: "shape", role: "background", colorRole: "background", content: "全面背景" }
    ]
  }];
  const bound = bindResolvedPaletteToZones(zones, {
    main: "#16324F", sub: "#FFFFFF", accent: "#2563EB", background: "#F7FAFC"
  });
  assert.equal(bound[0].elements[0].color, "#2563EB");
  assert.equal(bound[0].elements[1].color, "#16324F");
  assert.equal(bound[0].elements[2].color, "#F7FAFC");
});
```

- [x] **Step 2: REDを確認する**

Run:

```bash
node --test tests/banner-template-color.test.js tests/banner-prompt-compiler.test.js
```

Expected: 新module未実装または元色復元でFAIL。

- [x] **Step 3: 色表層と構造的effectを分離する**

色除去対象を単一の共有定数へ集約する。

```js
export const TEMPLATE_COLOR_TOKEN_PATTERN = /(?:#[0-9a-f]{3,8}|ゴールド|金色|黄色|イエロー|オレンジ|橙色|赤色?|レッド|青色?|ブルー|シアン|水色|緑色?|グリーン|紫色?|パープル|ピンク|桃色|黒色?|ブラック|白色?|ホワイト|グレー|灰色|ベージュ|ネイビー)/gi;
```

`buildColorNeutralTemplateDesign()`は、`style` / `fontPolicy` / `contrastPolicy` / `visualStyle` / `gridAlignment`の文字列を再帰的に処理する。色名だけを削除して不自然な文を残すのではなく、句点・読点単位で色指定が主目的の節を除外する。`spacingPolicy`、書体種別、視線誘導、余白、質感、ムードは残す。

`buildColorNeutralTemplateZones()`は次を行う。

- zoneの`background`値を削除し、`backgroundColorRole="background"`へ置き換える。
- elementの`color`値を削除し、元の`templateColorScheme`との完全一致またはrole規則から`colorRole`を付ける。
- shapeの`description` / `content`から色語・HEXだけを除き、図形の種類を残す。
- `effect`から色語・HEXを除き、縁取り、影、グロー、ぼかし、立体感などの効果種別を残す。
- text / image / shapeのtype、slotId、role、messageRole、position、sizeは変更しない。

既定`colorRole`:

| element | colorRole |
| --- | --- |
| CTA / offer / badge / action / button | accent |
| headline / body / caption / disclaimer / brand text | main |
| sub / secondary / divider / muted | sub |
| background / backdrop | background |
| その他shape / icon | accent |
| image / photo / illustration / logo / product | none（再着色しない） |

元element.colorが`templateColorScheme`のいずれかと完全一致する場合は、role規則よりそのpalette keyを優先する。

- [x] **Step 4: 構造強制処理が元色を復元しないよう変更する**

`banner-template-structure.js`は、生の`template.templateZones`ではなく`buildColorNeutralTemplateZones()`後のzonesを受け取る契約にする。`projectShapeSurface()`の「アクセントがなければ元`source.content` / `source.effect`を返す」分岐を廃止し、neutral sourceを常に正とする。

閉じた構造契約に`colorRole`を含めるが、具体HEXは含めない。構造hashも具体色ではなく`colorRole`で安定させる。

- [x] **Step 5: 全100テンプレの不変条件テストを追加する**

各テンプレで次をassertする。

- neutralize前後でzone数が同じ。
- element数とtype別数が同じ。
- slotId、position、sizeが同じ。
- neutralized JSONに元テンプレの4つのHEXが残らない。
- neutralized JSONの構造フィールドに既知色名が残らない。
- bind後の明示HEXが解決済みpaletteの4色部分集合である。
- image / logo / product要素へ`color`を追加しない。

Run:

```bash
node --test tests/banner-template-color.test.js tests/banner-template-structure.test.js tests/banner-prompt-compiler.test.js
```

Expected: 全件PASS。

## 11. Task 4: バナー生成パイプラインへ統合

**Files:**

- Modify: `src/core/banner-ai.js`
- Modify: `src/core/banner-prompt-compiler.js`
- Modify: `config/prompts/banner.md`
- Modify: `tests/banner-prompt-json.test.js`
- Modify: `tests/banner-prompt-compaction.test.js`

**Interfaces:**

- `normalizePromptJson()`は最終paletteを自作せず、`resolveBannerColorDecision()`の結果を使う。
- `compileClosedTemplatePromptSeed()`は具体色を決めず、色中立のstructure seedを返す。
- `normalizeBannerProposal()`は`promptJson.colorScheme`と`colorDecision`を同じpaletteから生成する。

- [x] **Step 1: 4ソースとテンプレフォールバックの統合失敗テストを書く**

`tests/banner-prompt-json.test.js`へ次の4ケースを追加する。

1. `tpl_default_026` + 青アクセント追加指示
   - accentは`#2563EB`
   - templateのゴールド`#D8A514`と「ゴールド」が最終promptへ残らない
2. `tpl_default_032` + 表現レギュレーション
   - 指定フィールドはregulation由来
   - 指定外フィールドはWHO-WHAT推論、次にtemplateへ落ちる
3. 有効な`strategy.colorInference`
   - user / regulation未指定時に4色すべて`who_what_inference`
4. `strategy.colorInference.status=insufficient`
   - 4色すべてtemplate由来
   - `templateFallbackFields`が4件

各ケースで`promptJson.colorScheme`と`colorDecision.palette`の完全一致をassertする。

- [x] **Step 2: REDを確認する**

Run:

```bash
node --test tests/banner-prompt-json.test.js tests/banner-prompt-compaction.test.js
```

Expected: テンプレ色漏れ、safe default採用、`colorDecision`旧形式のいずれかでFAIL。

- [x] **Step 3: `banner-ai.js`の旧色決定を置き換える**

削除対象:

- `applyColorPriority()`
- `extractPaletteOverride()`
- `namedColorHex()`
- 旧`resolveColorDecision()`
- `SAFE_BANNER_PALETTE`のローカル定義

`normalizePromptJson()`の前半で次を一度だけ実行する。

```js
const colorDecision = resolveBannerColorDecision({
  userInstruction: [banner.additionalInstruction, banner.revisionInstruction].filter(Boolean).join("\n"),
  expressionRules: specifiedRules,
  product,
  strategy,
  template
});
const neutralTemplateZones = buildColorNeutralTemplateZones(
  template?.templateZones,
  template?.templateColorScheme || template?.templatePromptJson?.colorScheme
);
const neutralTemplateDesign = buildColorNeutralTemplateDesign(template?.templateGlobalDesign);
```

テンプレ構造の強制には`neutralTemplateZones`を渡す。`normalizeZones()`後、`bindResolvedPaletteToZones(zones, colorDecision.palette)`を適用する。

戻り値:

```js
{
  ...existingProposal,
  promptJson: {
    ...existingPromptJson,
    globalDesign: resolvedColorNeutralGlobalDesign,
    colorScheme: {
      ...colorDecision.palette,
      usage: buildPaletteUsage(colorDecision),
      designNote: buildColorDecisionNote(colorDecision)
    },
    zones: colorBoundZones
  },
  colorDecision
}
```

Stage 2モデルが返した`rawPromptJson.colorScheme`は最終決定ソースとして採用しない。新規WHO-WHATでは保存済み`strategy.colorInference`を使い、旧戦略ではtemplateへフォールバックする。これにより、モデル出力の有無で優先順位が変わらないようにする。

- [x] **Step 4: 決定論的compilerから色判断を外す**

`banner-prompt-compiler.js`の次を削除する。

- `resolveColorDirective()`
- `rewriteShapeColor()`
- compiler内の`colorScheme.background` / `accent`決定

compilerは`additionalInstruction`原文を保持するが、色の解釈は`resolveBannerColorDecision()`だけに任せる。shape / effectは`buildColorNeutralTemplateZones()`の結果を使う。

- [x] **Step 5: `config/prompts/banner.md`を更新する**

次の優先順位へ変更する。

```text
追加指示・修正指示
> 表現レギュレーション／正式ブランド指定
> 保存済みWHO-WHAT colorInference
> templateColorScheme
> safe default
```

Stage 2モデルへは、`colorDecision`で確定済みのpaletteを変更・補完・再推論しないよう指示する。テンプレの自然言語内にある色名、元HEX、色付きeffectは生成根拠にしない。

- [x] **Step 6: GREENを確認する**

Run:

```bash
node --test \
  tests/banner-color-decision.test.js \
  tests/banner-template-color.test.js \
  tests/banner-prompt-compiler.test.js \
  tests/banner-prompt-json.test.js \
  tests/banner-prompt-compaction.test.js
```

Expected: 全件PASS。

## 12. Task 5: 最終画像promptのカラー契約と保存監査

**Files:**

- Modify: `src/core/openai-image.js`
- Modify: `src/core/banner-store.js`
- Modify: `tests/banner-prompt-json.test.js`
- Modify: `tests/banner-prompt-audit.test.js`

**Interfaces:**

```js
auditPromptColorContract({ promptJson, templateColorScheme, colorDecision })
  -> { status, unexpectedHex, unexpectedNamedColorPaths }
```

- [x] **Step 1: 最終promptの矛盾を検出する失敗テストを書く**

検査対象を次の構造パスだけに限定する。

- `globalDesign.style`
- `globalDesign.fontPolicy.*`
- `globalDesign.contrastPolicy.*`
- `globalDesign.visualStyle.*`
- `zones[].background`
- `zones[].elements[].color`
- `zones[].elements[].effect`
- shape要素の`content`

ターゲット、商品名、確定コピー、選択画像の説明は検査しない。「White」等を含む固有名詞やロゴ原本色を誤検出しないためである。

テストでは、解決済みpaletteが青系のときに`globalDesign.style="ゴールド基調"`を混ぜ、`status=failed`、`unexpectedNamedColorPaths`へ`globalDesign.style`が入ることをassertする。

- [x] **Step 2: REDを確認する**

Run:

```bash
node --test tests/banner-prompt-json.test.js tests/banner-prompt-audit.test.js
```

Expected: audit未実装でFAIL。

- [x] **Step 3: 保存前にカラー契約を検査する**

`normalizeBannerProposal()`で最終`promptJson`構築後に`auditPromptColorContract()`を実行し、結果を`colorDecision.contractReview`へ保存する。

`status=failed`の場合は次で停止する。

```js
const error = new Error("画像生成promptに解決済みpalette外のテンプレ色が残っています。");
error.code = "PROMPT_COLOR_CONTRACT_VIOLATION";
error.restartNode = "prompt";
error.productionStatus = "failed";
throw error;
```

selected logo / product / other imageは検査対象外とし、色変更もしない。

- [x] **Step 4: `colorDecision` version 2を保存・再読込する**

`banner-store.js`は既にobjectを保存できるため、version 2を包み直さず同階層で保持する。旧version 1または未設定も正常に読み込む回帰テストを置く。

`promptJson.colorScheme`と`colorDecision.palette`が不一致の場合は保存前に`PROMPT_COLOR_DECISION_MISMATCH`で停止する。

- [x] **Step 5: 画像promptへ確定済みpaletteだけを渡す**

`buildBannerImagePrompt()`は`promptJson.colorScheme`を従来どおり渡す。ただし、`colorDecision.contractReview.status !== "passed"`の場合はAPI送信前に停止する。画像APIへ送信後の修正や再解釈は行わない。

- [x] **Step 6: GREENを確認する**

Run:

```bash
node --test tests/banner-prompt-json.test.js tests/banner-prompt-audit.test.js tests/banner-logo-reference.test.js
```

Expected: 全件PASS。

## 13. Task 6: 性能ゲート

**Files:**

- Create: `scripts/validate-banner-color-performance.mjs`
- Modify: `tests/banner-prompt-compiler.test.js`
- Modify: `tests/who-what-color-inference.test.js`
- Verify: `tests/ai-job-performance.test.js`

### 13.1 AI呼び出し数ゲート

- [x] **Step 1: 閉じたテンプレのprompt AI呼び出し0回を維持する**

既存テストを維持し、カラー決定後も次をassertする。

```js
assert.equal(proposal.promptGenerationAudit.model, "deterministic-template-compiler-v1");
assert.equal(proposal.promptGenerationAudit.modelDesignCalls, 0);
assert.deepEqual(proposal.promptGenerationAudit.httpAttempts, []);
```

- [x] **Step 2: WHO-WHAT生成AI呼び出し1回を固定する**

`jsonGenerator` spyを使い、3proposalの`colorInference`を作っても呼び出しが1回であることをassertする。

### 13.2 ローカル性能ゲート

- [x] **Step 3: 性能検証スクリプトを実装する**

`scripts/validate-banner-color-performance.mjs`は次を行う。

1. `data/ad-templates.json`の100件を読む。
2. `resolveBannerColorDecision()`を100万回実行する。
3. 100テンプレのneutralize + bindを1,000周、合計100,000回実行する。
4. 5回測定し、中央値を採用する。
5. 次をJSONで標準出力する。

```json
{
  "resolverIterations": 1000000,
  "resolverMedianMs": 0,
  "resolverUsPerBanner": 0,
  "templateIterations": 100000,
  "templateMedianMs": 0,
  "templateUsPerTemplate": 0,
  "estimatedAddedMsFor10Banners": 0,
  "pass": true
}
```

合格条件:

- `estimatedAddedMsFor10Banners <= 10`
- 全100テンプレでzone数・element数不変
- ネットワーク呼び出し0回

数値フィールドの`0`はフォーマット例であり、実行時は`performance.now()`から計算した実測値を出力する。

- [x] **Step 4: 性能ゲートを実行する**

Run:

```bash
node scripts/validate-banner-color-performance.mjs
```

Expected: `pass: true`、10バナーの追加ローカル時間10ms以下。

### 13.3 既存3分SLAとの統合

- [x] **Step 5: 既存SLAテストを実行する**

Run:

```bash
node --test tests/banner-sla.test.js tests/banner-prompt-compiler.test.js tests/prompt-worker.test.js tests/ai-job-performance.test.js
```

Expected: 全件PASS。カラー修正を理由にworker数、画像品質、retry回数が変化していない。AIジョブ監視あり／なしのworker総時間差が3%未満、worker開始P95差が50ms未満である。

## 14. Task 7: ドキュメント・スキル同期

**Files:**

- Modify: `docs/data-model.md`
- Modify: `docs/agent-operations.md`
- Modify: `docs/workflow-design.md`
- Modify: `.agents/skills/cmoai-banner/SKILL.md`
- Modify: `.claude/skills/cmoai-banner/SKILL.md`
- Modify: `docs/banner-template-closed-structure-fix-instructions-2026-07-20.md`
- Modify: `docs/banner-generation-latency-retry-fix-instructions-2026-07-20.md`

- [x] **Step 1: データモデルを更新する**

次を追記する。

- `strategy.colorInference`
- `banner.colorDecision` version 2
- フィールド別優先順位
- 既存戦略は`insufficient`としてテンプレへフォールバック
- 選択素材の原本色は再着色対象外

- [x] **Step 2: 運用資料とスキルを更新する**

配色優先順位を次へ統一する。

```text
追加指示・修正指示
> 表現レギュレーション／正式ブランド指定
> 保存済みWHO-WHAT colorInference
> テンプレカラー
> safe default
```

`.agents/skills/cmoai-banner/SKILL.md`と`.claude/skills/cmoai-banner/SKILL.md`はbyte単位で同一にする。

- [x] **Step 3: 既存指示書へ優先注記を追加する**

closed-structure指示書へ「effectの種類は固定、色表層は本書のcolorDecisionへ再バインド」と明記する。レイテンシ指示書へ「カラー決定でStage 2モデル呼び出しを復活させない」と明記する。

- [x] **Step 4: 配布範囲テストを実行する**

Run:

```bash
cmp -s .agents/skills/cmoai-banner/SKILL.md .claude/skills/cmoai-banner/SKILL.md
node --test tests/lite-distribution-scope.test.js
```

Expected: `cmp` exit 0、テストPASS。

## 15. Task 8: 自動テスト・構文確認・実画像検証

### 15.1 自動テスト

- [x] **Step 1: カラー関連テストをまとめて実行する**

```bash
node --test \
  tests/who-what-color-inference.test.js \
  tests/banner-color-decision.test.js \
  tests/banner-template-color.test.js \
  tests/banner-instruction-policy.test.js \
  tests/banner-template-structure.test.js \
  tests/banner-prompt-compiler.test.js \
  tests/banner-prompt-json.test.js \
  tests/banner-prompt-compaction.test.js \
  tests/banner-prompt-audit.test.js \
  tests/banner-logo-reference.test.js
```

Expected: 全件PASS。

- [x] **Step 2: 全テストを実行する**

```bash
npm test
```

Expected: failure 0。

- [x] **Step 3: 指定構文確認を実行する**

```bash
node --check src/server.js
node --check src/ui/app.js
node --check src/core/openai-text.js
node --check src/core/who-what-ai.js
node --check src/core/strategy-store.js
node --check src/core/banner-color-decision.js
node --check src/core/banner-template-color.js
node --check src/core/banner-ai.js
node --check src/core/banner-prompt-compiler.js
node --check src/core/banner-template-structure.js
node --check src/core/openai-image.js
node --check src/core/template-ai.js
node --check src/core/product-research-ai.js
node --check src/core/lp-vision-ai.js
git diff --check
```

Expected: すべてexit 0。

### 15.2 無料の生成前統合検証

- [x] **Step 4: 4シナリオのpromptJsonを生成する**

実画像APIを呼ばず、次を検証する。

| シナリオ | テンプレ | 上位ソース | 期待source |
| --- | --- | --- | --- |
| 追加指示 | `tpl_default_026` | 白背景・青アクセント | user_instruction + 下位補完 |
| レギュレーション | `tpl_default_032` | main / accent指定 | regulation + 下位補完 |
| WHO-WHAT推論 | `tpl_default_071` | inferred 4色 | who_what_inference |
| テンプレfallback | `tpl_default_026` | inference insufficient | template |

各シナリオで次を確認する。

- `promptGenerationAudit.modelDesignCalls === 0`
- `promptJson.colorScheme`と`colorDecision.palette`が一致
- `contractReview.status === "passed"`
- 上位ソース採用時、非採用テンプレのHEX・色名が構造フィールドへ残っていない
- fallback時、`templateColorScheme`の4色が採用されている
- zone数・element数・type別数が元テンプレと一致
- 選択画像がある場合、その画像の再着色指示がない

### 15.3 有料実画像検証

- [ ] **Step 5: ユーザー承認後だけ4枚生成する（未実施: 有料APIの追加承認なし）**

上記4シナリオでgpt-image-2を各1枚、合計4枚だけ生成する。検証用案件はAPI経由で作成し、案件JSONを直接編集しない。API累計は4回を上限とし、自動回復が発生する場合も累計へ含める。4回に達したら追加生成を停止する。

目視確認:

- 追加指示ケース: 青アクセントで、元テンプレのゴールド装飾が残らない。
- レギュレーションケース: 指定ブランド配色が優先され、テンプレの黄色・ピンク等に戻らない。
- WHO-WHATケース: 保存済み推論paletteが反映され、テンプレ固有色に戻らない。
- fallbackケース: テンプレカラーが意図どおり使われる。
- 4ケース共通: レイアウト、zone、要素数、コピー、選択素材の原本色が維持される。

gpt-image-2の確率的な色揺らぎと、promptに競合色が残るコード不具合を区別する。`promptJson`と最終画像promptに競合色がなく、画像だけが微妙に変化した場合はモデル揺らぎとして記録する。promptに競合色が残る場合はコード不具合としてFAILにする。

## 16. Acceptance criteria

次をすべて満たした場合だけ完了とする。

1. カラー優先順位がフィールド単位で`user > regulation > official_brand > who_what > template > safe`になっている。
2. 追加指示からmain / sub / accent / backgroundの複数指定を同時抽出できる。
3. WHO-WHATの`colorInference`が既存1回のAI応答へ同梱され、追加HTTP呼び出しがない。
4. `status=insufficient`または旧戦略では、バナー生成時にAIを呼ばずテンプレカラーへフォールバックする。
5. 閉じたテンプレの`promptGenerationAudit.modelDesignCalls`が0のままである。
6. `promptJson.colorScheme`と`colorDecision.palette`が常に一致する。
7. 上位ソース採用時、テンプレ由来の非採用HEX・色名・色付きeffectが最終画像promptへ残らない。
8. テンプレfallback時、`templateColorScheme`の有効4色が採用される。
9. テンプレのzone数、element数、type、slotId、position、size、効果種別が変わらない。
10. selected logo / product / other imageの原本色を変更しない。
11. 全100テンプレのneutralize + bind不変条件テストがPASSする。
12. カラー決定による10バナーの追加ローカル時間が10ms以下で、AIジョブ監視あり／なしのworker総時間差が3%未満、開始P95差が50ms未満である。
13. カラー関連テスト、全テスト、指定構文確認、`git diff --check`がPASSする。
14. 有料実画像検証を実施する場合、事前承認と4回上限を守る。
15. 実装後の`implementation-self-review-loop`が8.5/10以上、P0/P1なしである。

## 17. Non-goals

- UIへのカラーピッカー追加
- テンプレDB100件の再テンプレ化・一括移行
- バナー生成時の追加AI推論
- 事実DBをバナー生成入力へ戻す変更
- Stage 2モデル呼び出しの復活
- テンプレのレイアウト・要素数変更
- ロゴ・商品画像・その他選択素材の再着色
- 画像生成モデル、画質、worker数、retry予算の変更
- HTML / CSS / Python等による画像への色・文字の後処理

## 18. 実装順序

依存関係を守り、次の順で実行する。

```text
Task 1 カラー決定純粋関数
  → Task 2 WHO-WHAT inference保存
  → Task 3 テンプレ色分離・再バインド
  → Task 4 バナーパイプライン統合
  → Task 5 最終prompt契約・保存監査
  → Task 6 性能ゲート
  → Task 7 docs / skills同期
  → Task 8 全検証・承認後の実画像確認
```

各Task終了時に対象テストと`git diff --check`を実行する。Task 4完了前に`banner-ai.js`の旧色決定関数を残したまま新resolverを併存させない。二重決定は原因追跡を困難にするため、統合Task内で完全に置き換える。

## 19. 実装者向け最終報告フォーマット

実装完了時は日本語で次を報告する。

```text
変更概要:
- カラー優先順位:
- WHO-WHAT colorInference:
- テンプレ色分離:
- 既存戦略互換:

速度:
- 追加AI呼び出し数:
- resolver 100万回中央値:
- 10バナー追加推定時間:
- closed prompt modelDesignCalls:

検証:
- カラー関連テスト:
- 全テスト:
- 全100テンプレ不変条件:
- 構文確認:
- 実画像4ケース:

自己レビュー:
- スコア:
- P0/P1:
- 残余リスク:
```

## 20. 指示書セルフレビュー

初回セルフレビュー: **9.5 / 10、実装着手可、P0/P1なし**。

- 要件網羅: ユーザー承認済みの4段階優先順位に、テンプレ欠損時だけの技術的safe defaultを追加し、全経路を定義した。
- 根本原因対応: `templateColorScheme`だけでなく、`globalDesign`、`effect`、shape説明、closed structure復元からの色漏れを対象化した。
- 速度: バナー生成時の追加AI呼び出しを禁止し、WHO-WHAT既存応答への同梱と純粋関数だけに限定した。
- 検証可能性: 4ソース別ケース、全100テンプレ不変条件、AI呼び出し数、ローカル性能、最終prompt、実画像を別々に判定できる。
- 後方互換: 旧戦略は`insufficient`としてテンプレへ落とし、旧バナーの`colorDecision`は読み込み可能なままにした。
- 残余リスク: gpt-image-2は確率的であり、promptで指定したHEXとピクセル値の完全一致は保証できない。コード完了条件は「競合色がpromptへ残らないこと」、実画像完了条件は「意図した色系統が視覚的に優先されること」と分けて判定する。

## 21. 実装・検証結果

### 21.1 実装結果

- `colorDecision` version 2を導入し、`main` / `sub` / `accent` / `background`を`user_instruction > regulation > official_brand > who_what_inference > template > safe_default`で独立解決するようにした。
- WHO-WHATの既存1リクエストへ`colorInference`を同梱し、根拠付き4色だけを`inferred`として保存する。旧戦略・不完全な推論はファイルを一括更新せず、読込時に`insufficient`として扱う。
- 閉じたテンプレのzone / element構造は維持し、具体色だけを除去して`colorRole`へ確定paletteを再バインドする。色名除去後も「背景」「文字」「帯」「縁取り」「影」等の構造語を残し、不自然な接続語を除去する。
- 最終promptでpalette不一致または構造フィールド内の競合色を検出した場合、画像API送信前に`PROMPT_COLOR_DECISION_MISMATCH` / `PROMPT_COLOR_CONTRACT_VIOLATION`で停止する。
- 選択ロゴ・商品画像・その他画像はカラー監査と再着色の対象外とし、原本色を維持する。
- `copyplan → prompt → image`、事実DB非参照、閉じたテンプレの`modelDesignCalls=0`、画像品質・worker数・retry予算を維持した。
- ベースコミット`6bb20fe`のAIジョブ進捗モニター復旧と責務の競合はなく、同機能の性能回帰テストも合格した。UI、共通テンプレDB、個別案件JSONは変更していない。

### 21.2 検証結果

| 検証 | 結果 |
| --- | --- |
| カラー関連テスト | 89 / 89 PASS |
| 全テスト `npm test` | 456 / 456 PASS |
| 全100テンプレ neutralize + bind | 構造不変、競合色なし |
| 無料の4シナリオ統合検証 | 4 / 4 PASS、`modelDesignCalls=0` |
| 既存SLA・AIジョブ性能 | 17 / 17 PASS、worker総時間差0.54%、開始P95差0.10ms |
| 配布範囲 | 9 / 9 PASS、`.agents` / `.claude`スキル一致 |
| 構文確認・`git diff --check` | すべてexit 0 |
| 有料実画像4ケース | 未実施（gpt-image-2の追加承認なし） |

最終性能計測:

```json
{
  "resolverIterations": 1000000,
  "resolverMedianMs": 11291.431583,
  "resolverUsPerBanner": 11.291432,
  "templateIterations": 100000,
  "templateMedianMs": 22787.352125,
  "templateUsPerTemplate": 227.873521,
  "estimatedAddedMsFor10Banners": 2.39165,
  "topologyInvariant": true,
  "networkCalls": 0,
  "pass": true
}
```

### 21.3 実装セルフレビュー

最終スコア: **9.5 / 10、P0/P1なし**。

- correctness 3.0 / 3.0: 優先順位、fallback、保存契約、画像前停止を独立テストと4シナリオ統合テストで確認した。
- reliability 1.8 / 2.0: 旧戦略、欠損色、不正推論、競合色、複合色、誤検出語を確認した。未知の自由文色表現は下位ソースへ安全にfallbackする。
- quality 1.8 / 2.0: 色決定とテンプレ中立化を別の純粋関数へ分離し、旧二重決定を削除した。自己レビューで不自然な色除去断片を発見し、構造語保持と接続語清掃を追加した。
- verification 2.0 / 2.0: 456件の全回帰、100テンプレ、性能、構文、配布範囲を確認した。
- operability 0.9 / 1.0: prompts、docs、両スキルを同期した。有料実画像だけは事前承認待ちである。

Claude CLI外部Review Boardは、`claude -p --model opus --allowedTools "" --output-format json`の30秒スモークテストが`401 Invalid authentication credentials`（`is_error: true`、exit 1）で終了したため実行不可とした。認証エラーは再試行対象外のため、correctness / requirements / verificationの各roleは未実施とし、その代わり全差分の厳格自己レビューと追加境界値テストを行った。

残余リスクは、gpt-image-2の確率的な色揺らぎと、辞書にない自由文の色表現である。前者は承認後の実画像4ケース、後者は`contractReview`による画像API前停止とテンプレfallbackで切り分ける。
