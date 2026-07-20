# バナー生成ジョブのサーバー再起動復旧 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ローカルサーバーが終了・再起動してもバナー生成が永久に「生成中」へ残らず、通常画像生成は安全条件を満たす場合に1回だけ自動再投入し、コピー設計と画像編集は既存成果物を守った再実行可能状態へ戻す。

**Architecture:** `banner-creatives.json` に保存済みのリース所有者PID・期限・入力ハッシュを起動時と60秒間隔で検査する。旧PIDが存在しない、またはリースが期限切れなら放棄ジョブとして原子的に引き取り、通常画像生成だけを新しいattemptで既存10並列キューへ1回再投入する。コピー設計と画像編集は自動で外部APIを再送せず、既存成果物を保持した再実行可能状態へ戻す。

**Tech Stack:** Node.js ES modules、JSON DB、`withFileLock()`、既存FIFO worker pool、`node:test`、gpt-image-2。

## Global Constraints

- `copyplan → prompt → image`の3ノードを維持する。
- 通常の画像生成だけを最大1回自動再投入する。同じHTTPリクエストの再開はできないため、新しいattemptとして扱う。
- コピー設計、範囲指定修正、全体修正は自動再送しない。旧リースを解放し、既存の再生成・修正操作ができる状態へ戻す。
- 現在も生存している別サーバーPIDのジョブを奪わない。ownerIdが不正でPID判定できない場合は、リース期限切れだけを復旧条件にする。
- 旧attemptの遅延完了が新attemptを上書きできない既存のattemptId契約を維持する。
- 自動復旧前に現在の画像入力ハッシュと旧画像ノードのinputHashを照合する。不一致なら画像APIを呼ばず、上流から再生成可能な状態へ戻す。
- 既存の`CMOAI_IMAGE_CONCURRENCY`（既定10）とファイルセマフォを利用し、新しい並列実行経路を作らない。
- UIコンポーネント、画面表示、ボタンを追加しない。
- 事実DBをバナー生成・復旧時に読み込まない。
- 個別案件JSON、生成画像、APIキー、外部APIレスポンス本文をGitへ追加しない。
- 復旧テストは注入したfake taskで行い、外部APIを呼ばない。有料実画像テストは別途ユーザー許可を得た場合だけ実行する。

---

## 1. 現象と原因

直近の停止事例では、5件の画像ジョブが旧サーバーPIDのownerIdを保持したままになった。1件は停止前に完了したが、4件は`imageGenerationStatus="generating"`、`pipelineNodes.image.status="running"`、旧attemptのリースが残った。

現在の`claimBannerImageOperation()`は、リースが期限内なら所有PIDが終了済みでも`reason="active"`として拒否する。また、サーバー起動時の自動復旧は広告テンプレ解析だけに実装されており、バナーのprompt/imageリースは走査していない。そのため、サーバー再起動後も最大15分待たされ、期限切れ後もユーザー操作なしでは再開しない。

## 2. 採用するハイブリッド復旧

| ジョブ種別 | 放棄判定後の動作 | 外部API自動再送 |
| --- | --- | --- |
| 通常画像生成 `operationKind=generate` | 入力ハッシュ一致かつ自動復旧0回なら新attemptで既存画像キューへ投入 | 1回だけ行う |
| 通常画像生成・入力変更あり | 旧リースを解放し、pipelineを再照合して再生成可能状態へ戻す | 行わない |
| 通常画像生成・自動復旧済み | `failed`へ戻し、ユーザーの再生成を可能にする | 行わない |
| 画像編集 `operationKind=edit` | 旧画像・コピー・promptを保持して編集失敗状態へ戻す | 行わない |
| コピー設計・prompt | 旧リースを解放し、該当ノードを再実行可能な失敗状態へ戻す | 行わない |

放棄条件は次のOR条件とする。

1. `expiresAt <= now`
2. ownerId先頭のPIDを取得でき、そのPIDが`ESRCH`で存在しない

`process.kill(pid, 0)`が成功、または`EPERM`なら生存扱いにする。ownerIdが空、不正、PID取得不能なら期限切れまで待つ。

## 3. 保存契約

`normalizeBanner()`で次の任意フィールドを保持する。

```json
{
  "jobRecoveryAudit": {
    "version": 1,
    "automaticImageRetryCount": 1,
    "lastAction": "image_requeued",
    "lastReason": "owner_process_missing",
    "lastRecoveredAt": "2026-07-20T12:28:02.000Z",
    "sourceOwnerId": "7796-uuid",
    "sourceAttemptId": "old-attempt-id",
    "recoveredAttemptId": "new-attempt-id"
  }
}
```

`lastAction`は次のいずれかに限定する。

- `image_requeued`
- `image_reset_for_manual_retry`
- `edit_reset_preserving_output`
- `prompt_reset_for_manual_retry`
- `completed_output_preserved`

履歴配列は作らず、累計回数と最終復旧だけを保存してJSON肥大化を防ぐ。APIキー、prompt本文、絶対パス、画像バイナリは保存しない。

## 4. File map

- Create: `src/core/banner-job-recovery.js` — PID生存判定、リース放棄判定、入力hash確認後のschedule判断を行う純粋関数。
- Modify: `src/core/banner-store.js` — ファイルロック下で放棄リースを新attemptへ引き継ぐか、再実行可能状態へ戻す。
- Modify: `src/server.js` — 起動時・60秒間隔の全案件走査、既存prompt/image workerへの投入、重複schedule防止。
- Modify: `docs/architecture.md` — banner lease recoveryの動作と自動再送境界。
- Modify: `docs/data-model.md` — `jobRecoveryAudit`の任意フィールド。
- Create: `tests/banner-job-recovery.test.js` — 判定・状態遷移・冪等性・PID安全性。
- Modify: `tests/job-queue.test.js` — 新attemptの所有権と旧attempt上書き拒否。
- Modify: `tests/prompt-worker.test.js` — 復旧画像ジョブも既存10並列上限を通ること。

---

### Task 1: リース所有PIDと放棄判定を純粋関数化する

**Files:**
- Create: `src/core/banner-job-recovery.js`
- Create: `tests/banner-job-recovery.test.js`

**Interfaces:**
- Produces: `parseLeaseOwnerPid(ownerId): number | null`
- Produces: `isProcessAlive(pid, signalProcess = process.kill): boolean`
- Produces: `classifyAbandonedLease(lease, options): { abandoned: boolean, reason: string }`
- Consumes: `lease.ownerId`, `lease.expiresAt`, injected `now` and `signalProcess`

- [ ] **Step 1: PIDと期限のREDテストを書く**

```js
test("死亡した旧PIDは期限内でも放棄と判定する", () => {
  const lease = { ownerId: "7796-old", expiresAt: "2099-01-01T00:00:00.000Z" };
  const result = classifyAbandonedLease(lease, {
    now: Date.parse("2026-07-20T12:30:00.000Z"),
    signalProcess: () => { const error = new Error("missing"); error.code = "ESRCH"; throw error; }
  });
  assert.deepEqual(result, { abandoned: true, reason: "owner_process_missing" });
});

test("生存PIDの期限内リースは復旧しない", () => {
  const result = classifyAbandonedLease(
    { ownerId: "65882-current", expiresAt: "2099-01-01T00:00:00.000Z" },
    { now: Date.parse("2026-07-20T12:30:00.000Z"), signalProcess: () => undefined }
  );
  assert.equal(result.abandoned, false);
});

test("ownerId不正時は期限切れだけを根拠にする", () => {
  const active = classifyAbandonedLease(
    { ownerId: "unknown", expiresAt: "2099-01-01T00:00:00.000Z" },
    { now: Date.parse("2026-07-20T12:30:00.000Z") }
  );
  assert.equal(active.abandoned, false);
});
```

- [ ] **Step 2: REDを確認する**

Run: `node --test tests/banner-job-recovery.test.js`

Expected: `ERR_MODULE_NOT_FOUND`またはexport未定義でFAIL。

- [ ] **Step 3: 最小実装を書く**

```js
export function parseLeaseOwnerPid(ownerId) {
  const match = String(ownerId || "").match(/^(\d+)-/);
  const pid = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export function isProcessAlive(pid, signalProcess = process.kill) {
  try {
    signalProcess(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") return true;
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

export function classifyAbandonedLease(lease, { now = Date.now(), signalProcess = process.kill } = {}) {
  if (!lease || typeof lease !== "object") return { abandoned: false, reason: "missing_lease" };
  const expiresAt = Date.parse(lease.expiresAt || "");
  if (Number.isFinite(expiresAt) && expiresAt <= now) return { abandoned: true, reason: "lease_expired" };
  const ownerPid = parseLeaseOwnerPid(lease.ownerId);
  if (ownerPid && !isProcessAlive(ownerPid, signalProcess)) return { abandoned: true, reason: "owner_process_missing" };
  return { abandoned: false, reason: ownerPid ? "owner_alive" : "owner_unknown" };
}
```

- [ ] **Step 4: GREENを確認する**

Run: `node --test tests/banner-job-recovery.test.js`

Expected: 3 tests PASS。

- [ ] **Step 5: Task 1をコミットする**

```bash
git add src/core/banner-job-recovery.js tests/banner-job-recovery.test.js
git commit -m "バナー復旧の放棄リース判定を追加"
```

---

### Task 2: Banner Storeへ原子的な復旧状態遷移を追加する

**Files:**
- Modify: `src/core/banner-store.js`
- Modify: `tests/banner-job-recovery.test.js`

**Interfaces:**
- Consumes: `classifyAbandonedLease()`
- Produces: `recoverAbandonedBannerJobs(projectRoot, options): Promise<RecoveryResult>`
- Produces: `RecoveryResult.imageJobs[] = { bannerId, attemptId, inputHash, previousAttemptId, reason }`
- Produces: `RecoveryResult.resetPromptIds[]`, `resetEditIds[]`, `manualImageIds[]`

- [ ] **Step 1: 4種類の状態遷移をREDテストへ追加する**

テスト用案件へ次のバナーを保存し、owner PIDは`ESRCH`を返すfakeにする。

```js
const recovery = await recoverAbandonedBannerJobs(projectRoot, {
  ownerId: "9000-new-server",
  now: Date.parse("2026-07-20T12:30:00.000Z"),
  signalProcess: () => { const error = new Error("missing"); error.code = "ESRCH"; throw error; },
  attemptIdFactory: () => "recovered-attempt"
});
```

確認事項:

1. 通常画像生成・初回復旧は、新owner/new attemptの`queued`リースへ原子的に置換される。
2. 通常画像生成・`automaticImageRetryCount=1`は`failed`になり、リースが消える。
3. 画像編集は`generatedImagePath`と`images`を保持して`completed`へ戻り、`lastImageEditError`を保存する。
4. promptはリースを解放し、実行中ノードを`failed`へ戻すが、`copyBrief`と`promptJson`を削除しない。

- [ ] **Step 2: REDを確認する**

Run: `node --test tests/banner-job-recovery.test.js`

Expected: `recoverAbandonedBannerJobs is not a function`でFAIL。

- [ ] **Step 3: `jobRecoveryAudit`をnormalize対象へ追加する**

`normalizeBanner()`へ次の正規化を追加する。

```js
jobRecoveryAudit: normalizeJobRecoveryAudit(input.jobRecoveryAudit)
```

```js
function normalizeJobRecoveryAudit(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    version: 1,
    automaticImageRetryCount: Math.max(0, Number(source.automaticImageRetryCount) || 0),
    lastAction: clean(source.lastAction),
    lastReason: clean(source.lastReason),
    lastRecoveredAt: clean(source.lastRecoveredAt),
    sourceOwnerId: clean(source.sourceOwnerId),
    sourceAttemptId: clean(source.sourceAttemptId),
    recoveredAttemptId: clean(source.recoveredAttemptId)
  };
}
```

- [ ] **Step 4: ファイルロック下で復旧する**

`recoverAbandonedBannerJobs()`は`data/banner-creatives.json`を1回だけread-modify-writeする。通常画像生成の自動復旧では、旧リースを外部から見えるnull状態にせず、同じロック内で新owner/new attemptの`queued`リースへ直接置換する。

新リースには次を保存する。

```js
{
  ownerId,
  attemptId,
  operationKind: "generate",
  state: "queued",
  queuedAt: nowIso,
  heartbeatAt: nowIso,
  expiresAt: new Date(now + leaseMs).toISOString(),
  automaticRecovery: true,
  recoveryOfAttemptId: clean(oldLease.attemptId),
  recoveryReason: decision.reason
}
```

この時点では`automaticImageRetryCount`を増やさない。キュー投入前にサーバーが再び落ちた場合まで課金済み扱いにしないため、Task 3で画像API実行開始時に増やす。

ただし、`jobRecoveryAudit.sourceOwnerId`、`sourceAttemptId`、`lastReason`は新リース作成時に旧リースから保存する。`lastAction`、`lastRecoveredAt`、`recoveredAttemptId`は画像API実行開始時に確定する。

- [ ] **Step 5: GREENを確認する**

Run: `node --test tests/banner-job-recovery.test.js tests/job-queue.test.js`

Expected: 全テストPASS。

- [ ] **Step 6: Task 2をコミットする**

```bash
git add src/core/banner-store.js tests/banner-job-recovery.test.js tests/job-queue.test.js
git commit -m "放棄バナージョブを安全な状態へ復旧"
```

---

### Task 3: 復旧済み画像attemptを既存10並列キューへ投入する

**Files:**
- Modify: `src/server.js`
- Modify: `src/core/banner-store.js`
- Modify: `tests/banner-job-recovery.test.js`
- Modify: `tests/prompt-worker.test.js`

**Interfaces:**
- Consumes: `recoverAbandonedBannerJobs()`の`imageJobs`
- Produces: `recoverBannerJobQueues(): Promise<{ scannedProjects: number, imageQueued: number, resetCount: number }>`
- Modifies: `prepareBannerImageJob()`へ任意`preclaimedJob`を追加

- [ ] **Step 1: preclaimed attemptのREDテストを書く**

`prepareBannerImageJob()`または抽出したenqueue helperへ、すでにStoreがclaim済みのattemptを渡した場合に再claimせず、既存の`imageWorkerPool`とファイルセマフォを通ってtaskが1回だけ実行されることを確認する。

```js
const job = await enqueueRecoveredBannerImageJob({
  projectRoot,
  bannerId,
  attemptId: "recovered-attempt",
  taskFactory: async () => { calls += 1; return { ok: true }; }
});
await job.taskPromise;
assert.equal(calls, 1);
```

- [ ] **Step 2: REDを確認する**

Run: `node --test tests/banner-job-recovery.test.js tests/prompt-worker.test.js`

Expected: enqueue helper未定義でFAIL。

- [ ] **Step 3: 既存画像キュー処理を共通化する**

`prepareBannerImageJob()`内の「heartbeat → FIFO pool → file semaphore → start → context load → gpt-image-2 → fail/finally」を、通常claimと復旧済みclaimの両方が同じ経路を通るよう整理する。

`startBannerImageGeneration()`で`lease.automaticRecovery === true`の場合だけ、同一ファイルロック内で次を実行する。

```js
jobRecoveryAudit: {
  ...current.jobRecoveryAudit,
  automaticImageRetryCount: current.jobRecoveryAudit.automaticImageRetryCount + 1,
  lastAction: "image_requeued",
  lastReason: current.imageGenerationLease.recoveryReason,
  lastRecoveredAt: nowIso,
  sourceOwnerId: current.jobRecoveryAudit.sourceOwnerId,
  sourceAttemptId: current.imageGenerationLease.recoveryOfAttemptId,
  recoveredAttemptId: attemptId
}
```

- [ ] **Step 4: 全案件の起動時scanと定期sweepを追加する**

`listProjects()`で`_template`、`archived`、`invalid`を除外し、各案件へ`recoverAbandonedBannerJobs()`を適用する。復旧済み通常画像は`enqueueRecoveredBannerImageJob()`へ渡す。

```js
let bannerRecoveryTimer = null;

async function recoverBannerJobQueues() {
  const projects = await listProjects();
  for (const project of projects.filter((item) => item.id !== "_template" && item.status === "draft")) {
    const projectRoot = resolveProjectPath(project.path);
    const recovery = await recoverAbandonedBannerJobs(projectRoot, {
      ownerId: imageWorkerOwnerId,
      leaseMs: durationFromEnv("CMOAI_IMAGE_QUEUE_LEASE_MS", 15 * 60 * 1000)
    });
    for (const job of recovery.imageJobs) {
      const prepared = await enqueueRecoveredBannerImageJob(projectRoot, job);
      prepared.taskPromise.catch(() => null);
    }
  }
}
```

`server.listen()`成功後、テンプレ解析復旧と並列に1回実行し、その後60秒間隔でsweepする。重複sweepは`projectRoot:bannerId:attemptId`のSetで防ぎ、task終了時に削除する。

- [ ] **Step 5: GREENと10並列上限を確認する**

Run: `node --test tests/banner-job-recovery.test.js tests/job-queue.test.js tests/prompt-worker.test.js`

Expected:

- 10件までは同時実行、11件目は待機。
- 同じrecovered attemptは1回しかtaskを開始しない。
- 生存PIDのジョブは0件requeue。
- 死亡PIDの通常画像ジョブは起動直後にrequeue。

- [ ] **Step 6: Task 3をコミットする**

```bash
git add src/server.js src/core/banner-store.js tests/banner-job-recovery.test.js tests/job-queue.test.js tests/prompt-worker.test.js
git commit -m "再起動後の画像ジョブを既存キューへ自動復旧"
```

---

### Task 4: 入力変更・旧attempt・二重課金防止のハードゲートを追加する

**Files:**
- Modify: `src/server.js`
- Modify: `src/core/banner-store.js`
- Modify: `tests/banner-job-recovery.test.js`
- Modify: `tests/job-queue.test.js`

**Interfaces:**
- Consumes: `reconcileBannerPipeline(projectRoot, bannerId, workspace)`
- Requires: `pipeline.nextNode === "image"`
- Requires: `pipeline.expectedInputHashes.image === recoveryJob.inputHash`
- Produces: `scheduleRecoveredImageJob({ recoveryJob, reconcile, enqueue, reset }): Promise<{ action: string }>`

- [ ] **Step 1: stale inputと2回目復旧のREDテストを書く**

```js
test("旧リース後にテンプレまたは追加指示が変わった場合は画像APIへ進めない", async () => {
  const result = await scheduleRecoveredImageJob({
    recoveryJob: { inputHash: "old-hash" },
    reconcile: async () => ({ nextNode: "prompt", expectedInputHashes: { image: "new-hash" } }),
    enqueue: async () => { throw new Error("must not enqueue"); }
  });
  assert.equal(result.action, "reset_for_manual_retry");
});
```

自動復旧開始済みのジョブをもう一度死亡PID状態にし、2回目は`imageGenerationStatus="failed"`、`imageGenerationLease=null`となることも確認する。

- [ ] **Step 2: REDを確認する**

Run: `node --test tests/banner-job-recovery.test.js tests/job-queue.test.js`

Expected: stale inputがenqueueされる、または復旧回数上限がなくFAIL。

- [ ] **Step 3: schedule前にpipelineを再照合する**

復旧候補ごとに最新workspaceで`reconcileBannerPipeline()`を呼ぶ。`nextNode !== "image"`またはhash不一致なら、新attemptを開始せずStoreへ`resetRecoveredImageForManualRetry()`を依頼する。

`src/core/banner-job-recovery.js`へ、外部依存をcallbackで受ける次のcoordinatorを追加する。これにより`src/server.js`をimportしてlisten副作用を起こさずにテストできる。

```js
export async function scheduleRecoveredImageJob({ recoveryJob, reconcile, enqueue, reset }) {
  const pipeline = await reconcile(recoveryJob.bannerId);
  const currentHash = String(pipeline?.expectedInputHashes?.image || "");
  if (pipeline?.nextNode !== "image" || !currentHash || currentHash !== recoveryJob.inputHash) {
    await reset(recoveryJob, { reason: "pipeline_input_changed" });
    return { action: "reset_for_manual_retry" };
  }
  await enqueue(recoveryJob);
  return { action: "image_requeued" };
}
```

ユーザー向け内部エラーは次で統一する。

```text
サーバー再起動中に入力が変更されたため、古い画像生成を再開しませんでした。内容を確認して再生成してください。
```

- [ ] **Step 4: 旧attemptの完了拒否を維持する**

復旧前attemptで`completeBannerImageGeneration()`を呼ぶテストを追加し、`IMAGE_ATTEMPT_REPLACED`で拒否され、新attemptのlease・status・成果物が変わらないことを確認する。

- [ ] **Step 5: GREENを確認する**

Run: `node --test tests/banner-job-recovery.test.js tests/job-queue.test.js`

Expected: 全テストPASS。

- [ ] **Step 6: Task 4をコミットする**

```bash
git add src/server.js src/core/banner-store.js tests/banner-job-recovery.test.js tests/job-queue.test.js
git commit -m "復旧ジョブの入力整合と再試行上限を強制"
```

---

### Task 5: 無課金の再起動統合テストを追加する

**Files:**
- Modify: `tests/banner-job-recovery.test.js`
- Modify: `src/core/banner-job-recovery.js`

**Interfaces:**
- Consumes: injected `recover`, `reconcile`, `enqueue`, `reset`
- Produces: 外部APIを使わない再起動シナリオの決定論的証拠

- [ ] **Step 1: 実事例と同じ5件シナリオを書く**

1件completed、4件は同じ死亡PID・期限内leaseで`generating`にする。coordinatorを1回実行し、4件が同じ時刻帯に既存poolへ入り、fake taskが4回だけ実行されることを確認する。

```js
assert.equal(summary.imageQueued, 4);
assert.equal(summary.completedPreserved, 1);
assert.equal(fakeImageCalls, 4);
assert.ok(maxActive <= 10);
```

- [ ] **Step 2: 多重sweepの冪等テストを書く**

同じcoordinatorを同時に2回実行し、同じ`bannerId:attemptId`が2回enqueueされず、fake画像呼び出しが4回のままであることを確認する。

- [ ] **Step 3: server停止・再起動相当をテストする**

1回目coordinatorのtask開始前に旧ownerを死亡扱いにし、2回目coordinatorで新attemptを取得する。新attempt完了後に旧attemptの完了を送っても保存されないことを確認する。

- [ ] **Step 4: 統合テストを実行する**

Run: `node --test tests/banner-job-recovery.test.js tests/job-queue.test.js tests/prompt-worker.test.js`

Expected: 外部API呼び出し0、全テストPASS。

- [ ] **Step 5: Task 5をコミットする**

```bash
git add src/server.js tests/banner-job-recovery.test.js tests/job-queue.test.js tests/prompt-worker.test.js
git commit -m "サーバー再起動時のバナー復旧を回帰テスト"
```

---

### Task 6: ドキュメント・全回帰・ローカル再起動検証を完了する

**Files:**
- Modify: `docs/architecture.md`
- Modify: `docs/data-model.md`
- Modify: `docs/superpowers/plans/2026-07-20-banner-job-recovery-after-server-restart.md`（実装結果追記時のみ）

**Interfaces:**
- Documents: 復旧対象、1回上限、編集非自動再送、PID/期限判定、監査フィールド

- [ ] **Step 1: ドキュメントを更新する**

`docs/architecture.md`のバナー生成パイプラインへ次を追記する。

```text
サーバー起動時と60秒ごとにバナーリースを検査する。死亡PIDまたは期限切れの通常画像生成は、入力ハッシュ一致かつ自動復旧未実施の場合だけ、新attemptとして既存画像キューへ1回再投入する。コピー設計と画像編集は自動再送せず、既存成果物を保護して再実行可能状態へ戻す。
```

`docs/data-model.md`へ`jobRecoveryAudit` schemaと`automaticImageRetryCount`の意味を追加する。

- [ ] **Step 2: 対象テストと全テストを実行する**

```bash
node --test tests/banner-job-recovery.test.js tests/job-queue.test.js tests/prompt-worker.test.js
npm test
```

Expected: 全件PASS、外部API呼び出し0。

- [ ] **Step 3: AGENTS.md指定の構文チェックを実行する**

```bash
node --check src/server.js
node --check src/ui/app.js
node --check src/core/openai-text.js
node --check src/core/who-what-ai.js
node --check src/core/banner-ai.js
node --check src/core/template-ai.js
node --check src/core/product-research-ai.js
node --check src/core/lp-vision-ai.js
node --check src/core/banner-job-recovery.js
git diff --check
```

Expected: 全コマンドexit 0。

- [ ] **Step 4: 無課金のローカル再起動確認を行う**

テスト用案件にfake executorで`generating`リースを作り、サーバーを停止・再起動する。確認項目:

- 新サーバー起動後60秒以内に放棄リースを検出する。
- 生存中の別PIDが所有するリースは変更しない。
- 通常生成は既存10並列キューへ1回だけ入る。
- 編集は元画像を保持して再操作可能になる。
- UIに新しいボタン・モーダル・設定が増えていない。
- `/`と`/api/projects`がHTTP 200。
- listener cwdが`/Users/koukamiyoshihiko/CMO-AI-Lite-main`。

- [ ] **Step 5: 実装自己レビューを行う**

`implementation-self-review-loop`で次を確認し、8.5/10未満またはcritical gapが1件以上なら修正してTask 2から再検証する。

- correctness: 死亡PID・期限切れ・生存PID・不正ownerを区別できる。
- idempotency: 同じジョブを2回自動投入しない。
- billing safety: 自動画像再送は最大1回、prompt/editは0回。
- data safety: copyBrief、promptJson、既存画像履歴を失わない。
- concurrency: 既存10並列上限を迂回しない。
- observability: 最終復旧理由・旧attempt・新attempt・回数を追跡できる。

- [ ] **Step 6: Task 6をコミットする**

```bash
git add docs/architecture.md docs/data-model.md docs/superpowers/plans/2026-07-20-banner-job-recovery-after-server-restart.md
git commit -m "バナージョブ復旧仕様と検証結果を記録"
```

## 5. Acceptance criteria

- サーバー起動時、死亡PIDが所有する期限内リースを待たずに検出できる。
- サーバー稼働中にownerが死亡した場合も、60秒以内のsweepで検出できる。
- 生存PIDが所有する期限内リースは変更しない。
- ownerId不正の場合は、期限切れ前に復旧しない。
- 通常画像生成は最新入力ハッシュ一致時だけ自動再投入する。
- 自動画像再投入はバナーごとに最大1回。
- copyplan/promptと画像編集は外部APIを自動再送しない。
- 画像編集の停止時も、最後の生成画像、画像履歴、copyBrief、promptJsonを保持する。
- 旧attempt完了は新attemptのstatus・lease・画像を上書きしない。
- 同時sweep・複数サーバーでも同じattemptを二重scheduleしない。
- 復旧画像生成は既存の最大10並列を超えない。
- `jobRecoveryAudit`で回数、理由、旧attempt、新attemptを確認できる。
- UI変更なし、3ノード維持、事実DB非参照、個別案件データ非追跡を守る。
- 対象テスト、全テスト、構文、`git diff --check`、localhost疎通がすべて通る。

## 6. Non-goals

- gpt-image-2側で完了したがローカル保存前に接続が切れた画像を、providerから後取得する機能。
- HTTPリクエスト自体の途中再開。
- Redis、外部キュー、SQLiteなど新しい永続基盤の導入。
- コピー設計の自動再送。
- 画像編集の自動再送。
- 新しいUI、通知センター、復旧履歴画面。
- 外部APIの180秒SLA保証。

## 7. Known residual risk

プロセス終了直前に外部画像APIが受理済みだった場合、ローカルはそのレスポンスを後から取得できない。自動再投入により同じ画像生成が二重課金になる可能性は完全には除去できない。本計画は、PID確認・入力ハッシュ照合・自動復旧1回上限・監査保存によってこのリスクを限定する。

## 8. Plan self-review

- Spec coverage: 起動時検出、60秒sweep、自動画像復旧、prompt/editの手動復旧、PID安全性、入力hash、1回上限、監査、10並列、UI据え置きを各Taskへ割り当て済み。
- Placeholder scan: 未確定項目、曖昧な後回し指示、定義のない参照なし。
- Type consistency: `recoverAbandonedBannerJobs()`、`scheduleRecoveredImageJob()`、`enqueueRecoveredBannerImageJob()`、`resetRecoveredImageForManualRetry()`の入出力名を全Taskで統一。
- Scope: バナーのprompt/image leaseだけを対象とし、外部キュー導入、UI追加、provider結果の後取得を除外。
- Review score: 9.4 / 10。P0/P1なし。残存リスクはprovider受理後・ローカル保存前のプロセス停止による二重課金可能性のみで、完全排除にはprovider側の取得可能なjob IDが必要。
