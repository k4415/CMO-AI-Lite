# Banner Three-Minute SLA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 閉じたテンプレを使う10件のバナー制作で、品質を維持しつつ、全件を理想180秒以内、最低でも各処理開始から180秒以内に画像完成させる。

**Architecture:** Stage AのAI一括コピー生成は維持し、閉じたテンプレのStage 2だけを純粋な決定論的compilerへ置き換える。画像は`gpt-image-2`の`low`を品質ゲート付きで検証し、既存の10並列workerとプロセス間セマフォを使う。SLA判定はUIを増やさず、保存済みpipeline時刻とローカル検証ハーネスで行う。

**Tech Stack:** Node.js ES modules、`node:test`、ローカルJSON DB、Anthropic Messages API、OpenAI Images API (`gpt-image-2`)

## Global Constraints

- `copyplan → prompt → image`の3ノードを維持する。
- バナー生成時に事実DBを読まない。
- 確定`copyBrief.slotTexts`をStage 2以降で変更しない。
- テンプレにないtext / image / shapeを、ユーザー選択素材以外では追加しない。
- ユーザー選択ロゴ・商品画像・その他画像は必ず画像APIへ渡す。未選択素材は渡さない。
- 画像内文字・ロゴをHTML、CSS、Python、Pillow、canvas、スクリーンショット等で後載せしない。
- `gpt-image-2`を維持する。`low`は実画像品質ゲート合格時だけ既定採用し、不合格なら`medium`へ戻す。
- UIへ新機能・設定項目を追加しない。
- 実画像APIは新規生成・自動回復を合算して最大30回。累計到達時に停止する。
- 実画像、検証用案件、Oh my teethを含む個別案件JSONをGitへ追加しない。
- 既存の未コミット変更はユーザーの作業として保持し、広範囲のstageや上書きをしない。
- 実装はインラインで行い、サブエージェントを使用しない。

---

### Task 1: 閉じたテンプレの決定論的prompt compiler

**Files:**
- Create: `src/core/banner-prompt-compiler.js`
- Modify: `src/core/banner-ai.js`
- Create: `tests/banner-prompt-compiler.test.js`
- Modify: `tests/banner-prompt-audit.test.js`

**Interfaces:**
- Consumes: `compileClosedTemplatePromptSeed({ banner, product, strategy, template, copyBrief, copySlotPlan, creativeHypothesis, instructionPolicy })`
- Produces: `{ promptJson, reviewNotes, selectionReason }`。`normalizeBannerProposal()`へ既存Stage 2レスポンスと同じ形で渡す。
- Detection: `buildTemplateStructureContract(template?.templateZones).closed === true`。
- Audit: closed templateでは`model="deterministic-template-compiler-v1"`、`modelDesignCalls=0`、`httpAttempts=[]`。

- [x] **Step 1: compilerの期待動作を表す失敗テストを書く**

```js
test("closed template compiles promptJson without calling the Stage 2 model", async () => {
  let calls = 0;
  const proposal = await generateBannerCreativeProposal({
    banner: { id: "b1", imageSize: "1080x1080" },
    product: { id: "p1", name: "広告改善AI" },
    strategy: { id: "s1", conceptName: "制作時間を短縮", targetAttributes: "広告運用者", benefit: "検証案を早く増やせる" },
    template: {
      id: "t1",
      copyBlueprint: { slots: [{ slotId: "headline", role: "headline", canonicalField: "mainHook", charBudget: 12 }] },
      templateZones: [{ position: "top", purpose: "hook", elements: [{ type: "text", slotId: "headline", role: "headline", content: "旧コピー" }] }]
    },
    copyBrief: { version: 3, strategyId: "s1", mainHook: "3分で広告案", slotTexts: [{ slotId: "headline", text: "3分で広告案" }] },
    creativeHypothesis: { visualIntent: { scene: "広告制作", motif: "速度" } },
    jsonGenerator: async () => { calls += 1; throw new Error("must not call"); }
  });
  assert.equal(calls, 0);
  assert.equal(proposal.promptGenerationAudit.modelDesignCalls, 0);
  assert.equal(proposal.promptGenerationAudit.model, "deterministic-template-compiler-v1");
  assert.equal(proposal.promptJson.zones[0].elements[0].content, "3分で広告案");
});
```

- [x] **Step 2: REDを確認する**

Run: `node --test tests/banner-prompt-compiler.test.js tests/banner-prompt-audit.test.js`

Expected: Stage 2の`jsonGenerator`が呼ばれ、`must not call`または`calls === 0`のassertionでFAILする。

- [x] **Step 3: 純粋compilerを最小実装する**

```js
export function compileClosedTemplatePromptSeed({
  banner = {}, product = {}, strategy = {}, template = {}, copyBrief = {},
  copySlotPlan = [], creativeHypothesis = {}, instructionPolicy = {}
} = {}) {
  const slotById = new Map((copyBrief.slotTexts || []).map((slot) => [String(slot.slotId), String(slot.text || "")]));
  const variation = [copyBrief.appealAxis, copyBrief.variationDirection, copyBrief.targetMoment].filter(Boolean).join(" / ");
  const visualIntent = [creativeHypothesis?.visualIntent?.scene, creativeHypothesis?.visualIntent?.motif].filter(Boolean).join(" / ");
  const zones = (template.templateZones || []).map((zone, zoneIndex) => ({
    position: zone.position || zone.area || "",
    purpose: zone.purpose || zone.role || "",
    background: "",
    elements: (zone.elements || []).map((element, elementIndex) => {
      const slotId = String(element.slotId || `z${zoneIndex + 1}e${elementIndex + 1}`);
      const type = String(element.type || "text").toLowerCase();
      const role = String(element.role || element.name || "");
      const content = type === "text"
        ? (slotById.get(slotId) ?? (/logo|brand/i.test(role) ? String(product.brandName || product.name || "") : ""))
        : type === "image"
          ? [role, visualIntent, variation].filter(Boolean).join("。")
          : String(element.description || element.content || "");
      return { ...element, type, slotId, role, content };
    })
  }));
  return {
    promptJson: {
      basic: { size: String(banner.imageSize || "1080x1080") },
      target: String(strategy.targetAttributes || strategy.segmentName || ""),
      desire: String(strategy.desire || ""),
      benefit: String(strategy.benefit || strategy.productConcept || ""),
      offer: String(strategy.offer || copyBrief.offerBadge || ""),
      globalDesign: {
        ...(template.templateGlobalDesign || {}),
        designRationale: [visualIntent, variation, instructionPolicy?.rawText].filter(Boolean).join(" / ")
      },
      colorScheme: template.templateGlobalDesign?.colorScheme || template.templatePromptJson?.colorScheme || {},
      zones,
      negativeRules: [],
      reviewChecklist: []
    },
    reviewNotes: "Stage 2は閉じたテンプレ契約から決定論的に生成しました。",
    selectionReason: String(copyBrief.whyItStops || "")
  };
}
```

`banner-ai.js`では、closed templateなら上記seedを`normalizeBannerProposal()`へ渡し、open/fallbackだけ既存`jsonGenerator`を実行する。既存の`applyRegulationRules()`、`reapplyLockedSlotTexts()`、contract continuityは両経路で共通利用する。

- [x] **Step 4: GREENを確認する**

Run: `node --test tests/banner-prompt-compiler.test.js tests/banner-prompt-audit.test.js tests/banner-prompt-json.test.js tests/banner-prompt-compaction.test.js`

Expected: 全テストPASS。closed templateの`modelDesignCalls=0`、fallbackの`modelDesignCalls=1`。

- [x] **Step 5: 全配布テンプレの不変条件テストを追加する**

```js
test("all bundled closed templates preserve zones, element types and slot ids", async () => {
  const templates = JSON.parse(await fs.readFile("data/ad-templates.json", "utf8"));
  for (const template of templates) {
    if (!(template.templateZones || []).length) continue;
    const contract = buildTemplateStructureContract(template.templateZones);
    const seed = compileClosedTemplatePromptSeed({
      banner: { id: "test", imageSize: "1080x1080" },
      product: { id: "p1", name: "検証商品" },
      strategy: { id: "s1", targetAttributes: "広告運用者", benefit: "制作を短縮" },
      template,
      copyBrief: { slotTexts: [], appealAxis: "時短", variationDirection: "具体性" },
      creativeHypothesis: { visualIntent: { scene: "制作現場", motif: "速度" } }
    });
    const enforced = enforceTemplateStructure({ templateZones: template.templateZones, generatedZones: seed.promptJson.zones });
    assert.equal(enforced.contract.zoneCount, contract.zoneCount, template.id);
    assert.equal(enforced.contract.elementCount, contract.elementCount, template.id);
    assert.deepEqual(enforced.contract.typeCounts, contract.typeCounts, template.id);
  }
});
```

- [x] **Step 6: Task 1 checkpointを記録する**

Run: `git diff --check && node --test tests/banner-prompt-compiler.test.js tests/banner-prompt-audit.test.js tests/banner-prompt-json.test.js`

Review: closed/open分岐、コピー完全一致、選択素材ポリシー、追加指示、variation、既存dirty diffとの衝突を採点する。8.5未満なら修正して再実行する。

---

### Task 2: `gpt-image-2`品質プロファイルと監査

**Files:**
- Modify: `src/core/openai-image.js`
- Modify: `tests/openai-image-retry.test.js`
- Create: `tests/openai-image-quality.test.js`

**Interfaces:**
- `resolveBannerImageQuality(value = process.env.CMOAI_BANNER_IMAGE_QUALITY) -> "low" | "medium"`
- `requestBannerImage({ ..., quality })`
- `buildBannerImageEditForm({ prompt, size, inputImages, quality })`
- `imageGenerationAudit.quality`
- `imageGenerationAudit.attempts[].quality` / `durationMs`

- [x] **Step 1: generationとasset付きeditの品質値を表す失敗テストを書く**

```js
test("banner generation defaults to low and sends the same quality to generations and edits", async () => {
  assert.equal(resolveBannerImageQuality(undefined), "low");
  assert.equal(resolveBannerImageQuality("medium"), "medium");
  assert.equal(resolveBannerImageQuality("unexpected"), "low");
  const form = buildBannerImageEditForm({
    prompt: "p",
    size: "1024x1024",
    inputImages: [{ buffer: Buffer.from("image"), mime: "image/png", fileName: "logo.png" }],
    quality: "low"
  });
  assert.equal(form.get("quality"), "low");
});
```

fetch mockでは`/v1/images/generations`のJSON bodyと`/v1/images/edits`のFormDataを読み、両方が`low`であることをassertする。

- [x] **Step 2: REDを確認する**

Run: `node --test tests/openai-image-quality.test.js tests/openai-image-retry.test.js`

Expected: resolver未定義、または送信値が`medium`でFAILする。

- [x] **Step 3: 品質resolverと監査を実装する**

```js
export function resolveBannerImageQuality(value = process.env.CMOAI_BANNER_IMAGE_QUALITY) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "medium" ? "medium" : "low";
}
```

`generateBannerImageWithGptImage2()`の開始時に1回だけqualityを確定し、初回生成・自動回復の両方へ渡す。`buildImageAttemptAudit()`は`quality`と`completedAt-startedAt`の`durationMs`を保存する。手動の範囲・全体修正はSLA対象外なので既存`medium`を維持する。

- [x] **Step 4: GREENと回帰を確認する**

Run: `node --test tests/openai-image-quality.test.js tests/openai-image-retry.test.js tests/banner-logo-reference.test.js tests/banner-warning-completion.test.js`

Expected: 全テストPASS。既存の最大2試行、OCR、正式ロゴ検証は変わらない。

- [x] **Step 5: Task 2 checkpointを記録する**

Run: `git diff --check && node --check src/core/openai-image.js`

Review: manual editのmedium維持、initial/edit/recoveryのquality一致、監査の秘密情報非保存、30回上限を外部ハーネスで数えられることを採点する。

---

### Task 3: SLA判定と10並列の決定論的検証

**Files:**
- Create: `src/core/banner-sla.js`
- Create: `tests/banner-sla.test.js`
- Modify: `tests/job-queue.test.js`

**Interfaces:**
- `evaluateBannerBatchSla({ requestStartedAt, banners, expectedCount = 10, limitMs = 180000 })`
- Returns `{ idealPassed, minimumPassed, batchMakespanMs, perBanner, completedCount, qualityFailureCount }`

- [x] **Step 1: SLA境界の失敗テストを書く**

```js
test("10 completed quality-passed banners at exactly 180 seconds pass both SLA gates", () => {
  const start = "2026-07-20T00:00:00.000Z";
  const banners = Array.from({ length: 10 }, (_, index) => ({
    id: `b${index + 1}`,
    productionStatus: "completed",
    slaQualityPassed: true,
    pipelineNodes: {
      copyplan: { startedAt: start },
      image: { completedAt: "2026-07-20T00:03:00.000Z" }
    }
  }));
  const result = evaluateBannerBatchSla({ requestStartedAt: start, banners });
  assert.equal(result.idealPassed, true);
  assert.equal(result.minimumPassed, true);
});

test("failed or quality-failed banners never count as SLA completion", () => {
  const start = "2026-07-20T00:00:00.000Z";
  const banners = Array.from({ length: 10 }, (_, index) => ({
    id: `b${index + 1}`,
    productionStatus: "completed",
    slaQualityPassed: index !== 9,
    pipelineNodes: {
      copyplan: { startedAt: start },
      image: { completedAt: "2026-07-20T00:02:00.000Z" }
    }
  }));
  const result = evaluateBannerBatchSla({ requestStartedAt: start, banners });
  assert.equal(result.completedCount, 9);
  assert.equal(result.idealPassed, false);
});
```

- [x] **Step 2: REDを確認する**

Run: `node --test tests/banner-sla.test.js`

Expected: module/function未定義でFAILする。

- [x] **Step 3: SLA evaluatorを最小実装する**

```js
export function evaluateBannerBatchSla({ requestStartedAt, banners = [], expectedCount = 10, limitMs = 180000 } = {}) {
  const requestMs = Date.parse(requestStartedAt);
  const perBanner = banners.map((banner) => {
    const nodes = banner.pipelineNodes || {};
    const processingStartMs = Date.parse(nodes.copyplan?.startedAt || nodes.prompt?.startedAt || nodes.image?.startedAt || "");
    const completedMs = Date.parse(nodes.image?.completedAt || "");
    const terminal = ["completed", "completed_with_warnings"].includes(String(banner.productionStatus || ""));
    const qualityPassed = banner.slaQualityPassed !== false;
    return {
      bannerId: String(banner.id || ""), terminal, qualityPassed,
      processingMs: completedMs - processingStartMs,
      completedMs
    };
  });
  const accepted = perBanner.filter((item) => item.terminal && item.qualityPassed && Number.isFinite(item.completedMs));
  const batchMakespanMs = accepted.length ? Math.max(...accepted.map((item) => item.completedMs)) - requestMs : Infinity;
  return {
    idealPassed: accepted.length === expectedCount && batchMakespanMs <= limitMs,
    minimumPassed: accepted.length === expectedCount && accepted.every((item) => item.processingMs <= limitMs),
    batchMakespanMs,
    perBanner,
    completedCount: accepted.length,
    qualityFailureCount: perBanner.filter((item) => !item.qualityPassed).length
  };
}
```

Invalid date、件数不足、181秒、キュー待ちだけ長いケースを追加する。

- [x] **Step 4: worker 10並列のcharacterization testを追加する**

```js
test("FifoWorkerPool starts 10 jobs concurrently and queues the eleventh", async () => {
  const pool = new FifoWorkerPool(10);
  let active = 0;
  let peak = 0;
  const release = deferred();
  const jobs = Array.from({ length: 11 }, () => pool.run(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await release.promise;
    active -= 1;
  }));
  await waitUntil(() => peak === 10);
  assert.equal(peak, 10);
  release.resolve();
  await Promise.all(jobs);
});
```

このテストが既存実装でPASSする場合、worker本体は変更せず「10並列は既存動作」と記録する。

- [x] **Step 5: GREENを確認する**

Run: `node --test tests/banner-sla.test.js tests/job-queue.test.js tests/prompt-worker.test.js`

Expected: SLA境界とworker上限が全てPASSする。

- [x] **Step 6: Task 3 checkpointを記録する**

Review: ideal/minimumの時刻境界、キュー除外、品質不合格の除外、exactly 180000ms、11件目待機を採点する。

---

### Task 4: 実画像SLAハーネス

**Files:**
- Create: `scripts/validate-banner-sla.mjs`
- Create: `tests/banner-sla-script.test.js`
- Modify: `.gitignore` only if the harness output path is not already ignored

**Interfaces:**
- CLI: `node scripts/validate-banner-sla.mjs --base-url http://localhost:5176 --project ./projects/banner-sla-validation-20260720 --banner-ids-file .codex-validation/round-1-banner-ids.json --max-paid-requests 30 --round 1`
- Output: JSON report under a temporary or ignored validation directory, plus one-line terminal summary.
- Exit 0: 10件terminalかつ品質レビュー入力済みでidealまたはminimum PASS。
- Exit 1: generation failure、timeout、quality FAIL、SLA未達、paid cap到達。

- [x] **Step 1: 引数・上限・ポーリングの失敗テストを書く**

```js
test("validator rejects a batch other than 10 before issuing a paid request", async () => {
  let calls = 0;
  await assert.rejects(() => runBannerSlaValidation({
    bannerIds: ["b1"],
    maxPaidRequests: 30,
    fetchImpl: async () => { calls += 1; return new Response("{}"); }
  }), /10件/);
  assert.equal(calls, 0);
});

test("validator stops before request 31 including recovery attempts", async () => {
  const budget = createPaidRequestBudget(30);
  for (let i = 0; i < 30; i += 1) budget.consume();
  assert.throws(() => budget.consume(), /30/);
});
```

- [x] **Step 2: REDを確認する**

Run: `node --test tests/banner-sla-script.test.js`

Expected: harness module未定義でFAILする。

- [x] **Step 3: ハーネスを実装する**

実行内容を次に固定する。

```js
const requestedAt = new Date().toISOString();
await postJson(`${baseUrl}/api/banners/generate-full-batch`, { project, bannerIds });
const terminal = await poll(async () => {
  const research = await getJson(`${baseUrl}/api/research?project=${encodeURIComponent(project)}`);
  return selectBanners(research.workspace.banners, bannerIds);
}, { timeoutMs: 20 * 60 * 1000, intervalMs: 1000 });
const report = evaluateBannerBatchSla({ requestStartedAt: requestedAt, banners: terminal });
```

生成後の目視レビューは`--quality-review .codex-validation/round-1-quality-review.json`で10件分のPASS/WARN/FAILを読み込み、未入力をPASS扱いしない。レポートには案件名・商品名を含めず、banner ID、template ID、時刻、duration、status、quality判定だけを保存する。

- [x] **Step 4: GREENを確認する**

Run: `node --test tests/banner-sla-script.test.js tests/banner-sla.test.js`

Expected: 10件制約、30回制約、terminal polling、匿名化、exit判定がPASSする。

- [x] **Step 5: Task 4 checkpointを記録する**

Review: APIを通じた保存、JSON直接編集禁止、秘密・個別案件情報の非保存、有料上限、未レビュー画像を合格にしないことを採点する。

---

### Task 5: 自動テスト・構文・ローカル統合確認

**Files:**
- Modify only files implicated by failing tests after root-cause analysis

- [x] **Step 1: 対象テストを一括実行する**

Run:

```bash
node --test \
  tests/banner-prompt-compiler.test.js \
  tests/banner-prompt-audit.test.js \
  tests/banner-prompt-json.test.js \
  tests/banner-prompt-compaction.test.js \
  tests/openai-image-quality.test.js \
  tests/openai-image-retry.test.js \
  tests/banner-sla.test.js \
  tests/banner-sla-script.test.js \
  tests/job-queue.test.js
```

Expected: failures 0。

- [x] **Step 2: 全テストを実行する**

Run: `npm test`

Expected: failures 0。失敗時はスタックトレースを読み、再現テスト→単一原因→最小修正の順でTask 1〜4へ戻る。

- [x] **Step 3: AGENTS指定の構文確認を実行する**

Run:

```bash
node --check src/server.js
node --check src/ui/app.js
node --check src/core/openai-text.js
node --check src/core/who-what-ai.js
node --check src/core/banner-ai.js
node --check src/core/banner-prompt-compiler.js
node --check src/core/banner-sla.js
node --check src/core/template-ai.js
node --check src/core/product-research-ai.js
node --check src/core/lp-vision-ai.js
node --check src/core/openai-image.js
```

Expected: 全コマンドexit 0。

- [x] **Step 4: ローカルサーバーを専用ポートで起動・確認する**

Run: `PORT=5176 CMOAI_BANNER_IMAGE_QUALITY=low CMOAI_PROMPT_CONCURRENCY=10 CMOAI_IMAGE_CONCURRENCY=10 npm run dev`

Verify: `curl -fsS http://localhost:5176/api/projects` と `curl -fsS "http://localhost:5176/api/project/detail?project=..."` が200。

- [x] **Step 5: checkpoint self-reviewを行う**

Rubric: correctness 0-3、reliability 0-2、quality 0-2、verification 0-2、operability 0-1。8.5未満なら具体的gapを修正してStep 1から再実行する。

---

### Task 6: 実画像10件×最大3ラウンド

**Files:**
- Create: ignored quality-review JSON and generated report outside tracked project data
- Modify production/test files only after a failed round has a reproduced root cause

- [ ] **Step 1: 検証用案件と10件をAPI経由で準備する**

3種類以上のclosed templateを使い、次を10件へ配分する。

- 画像枠なし・選択素材なし
- ロゴ選択あり
- ロゴと商品画像選択あり
- 追加指示あり
- baselineと複数variation
- 異なるWHO-WHAT

検証用画像素材は役割ラベルが明確な共通または検証専用素材だけを使い、Oh my teeth案件を流用しない。

- [ ] **Step 2: Round 1を10件同時実行する**

Run:

```bash
node scripts/validate-banner-sla.mjs \
  --base-url http://localhost:5176 \
  --project ./projects/banner-sla-validation-20260720 \
  --banner-ids-file .codex-validation/round-1-banner-ids.json \
  --max-paid-requests 30 \
  --round 1
```

10画像を目視し、品質review JSONへ各観点のPASS/WARN/FAILと理由を保存して再集計する。

- [ ] **Step 3: Round 1をレビューする**

判定順:

1. 実画像API累計が30以下か。
2. 10件すべてterminalか。
3. 10件すべて品質PASSまたは目視上問題のない根拠付きWARNか。
4. ideal / minimumのどちらを満たしたか。
5. copyplan、prompt compiler、image API、OCRのどこが時間を使ったか。

PASSならRound 2/3を実行せずTask 7へ進む。FAILなら原因を1件ずつ再現し、失敗テストを追加してTask 1〜4の該当箇所へ戻る。

- [ ] **Step 4: 必要な場合だけRound 2を実行する**

修正後に対象テストと全テストを再実行し、別の10件で同じ品質・SLA判定を行う。API累計はRound 1から引き継ぐ。

- [ ] **Step 5: 必要な場合だけRound 3を実行する**

Round 2の根本原因修正後に最終10件を実行する。API累計30へ達したら新規・回復リクエストを停止し、外部モデル制約かコード問題かを証拠付きで分類する。

---

### Task 7: 最終レビューと引き渡し

**Files:**
- Modify: `docs/superpowers/specs/2026-07-20-banner-three-minute-sla-design.md` only to append anonymized implementation/validation results
- Update: `.codex-handoff.md`

- [ ] **Step 1: 最新の全検証を再実行する**

Run: `npm test`、AGENTS指定の全`node --check`、`git diff --check`、SLA report再集計。

- [ ] **Step 2: Claude Review Board smoke testを実行する**

Run with 30-second deadline:

```bash
claude -p --model opus --allowedTools "" --output-format json 'Return JSON only: {"ok":true}'
```

利用可能なら`correctness`、`requirements`、`verification`の3役を独立実行する。認証エラー等で利用不可なら具体的理由を記録し、最終スコア上限解除のskip evidenceとする。

- [ ] **Step 3: Review Board findingsを分類・修正する**

各findingを`accepted` / `needs-user-input` / `rejected`に分類する。acceptedは失敗テスト追加→修正→全検証を行う。needs-user-inputは挙動を推測で変更しない。

- [ ] **Step 4: 最終セルフレビューする**

8.5 / 10以上、P0/P1なしを必須とする。SLA未達の場合はスコアで隠さず、外部画像API時間、品質不合格、必要な次の製品判断を明記する。

- [ ] **Step 5: 関連ファイルだけを明示stageしてコミットする**

```bash
git add -- \
  docs/superpowers/plans/2026-07-20-banner-three-minute-sla.md \
  docs/superpowers/specs/2026-07-20-banner-three-minute-sla-design.md \
  src/core/banner-ai.js \
  src/core/banner-prompt-compiler.js \
  src/core/banner-sla.js \
  src/core/openai-image.js \
  scripts/validate-banner-sla.mjs \
  tests/banner-prompt-compiler.test.js \
  tests/banner-prompt-audit.test.js \
  tests/banner-prompt-json.test.js \
  tests/openai-image-quality.test.js \
  tests/openai-image-retry.test.js \
  tests/banner-sla.test.js \
  tests/banner-sla-script.test.js \
  tests/job-queue.test.js
git diff --cached --check
git diff --cached --stat
git commit -m "バナー10件3分SLA向けに生成経路を高速化"
```

個別案件データ、生成画像、既存の無関係なdirty fileをstageしない。

- [ ] **Step 6: 最終報告する**

理想/最低SLA、10件の実時間、実画像API使用回数、品質判定、並列数、全テスト件数、Review Board、commit、残余リスクを日本語で報告する。

## Plan Self-Review

- Spec coverage: Stage 2決定論化、コピー維持、low品質ゲート、10並列、SLA式、最大30件、3テンプレ、素材、追加指示、多様性、UI据え置き、個別案件除外をTask 1〜7へ割り当てた。
- Placeholder scan: `TBD`、`TODO`、`implement later`、抽象的な「適切に処理」は使用していない。実画像のIDはAPI作成後に`.codex-validation/round-1-banner-ids.json`へ保存し、コマンド引数を固定した。
- Type consistency: compiler、quality resolver、SLA evaluator、CLI引数の名前を全Taskで統一した。
- Scope control: copyplanモデルやUIは変更せず、観測済みボトルネックのStage 2と画像quality、検証契約だけを変更する。
- Execution choice: ユーザーが同一セッションでの反復実行を明示したため、Inline Executionを選択する。
