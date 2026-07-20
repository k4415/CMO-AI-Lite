# AIジョブ進捗モニター 復旧・再実装 修正指示書

> **対象リポジトリ:** `/Users/koukamiyoshihiko/CMO-AI-Lite-main`
>
> **作成日:** 2026-07-20
>
> **状態:** 実装前指示書 v3。現行コード、関連ドキュメント、Git履歴を確認し、AIジョブ表示によるバナー品質・速度の回帰防止レビューを3ラウンド反映済み。コード実装は未着手。
>
> **実装時必須:** `codex-autopilot`、`superpowers:test-driven-development`、`implementation-self-review-loop` を適用し、RED → GREEN → 自己レビュー → ブラウザ確認の順で進める。

> **実装開始条件:** 本書の性能非回帰ゲートを先にテスト化すること。AIジョブ監視を理由に、バナーのモデル、プロンプト、品質設定、retry、`copyplan → prompt → image`、prompt/image worker数を変更してはならない。

## 1. 結論

右下に以前あったフローティング導線は、確認できたGit履歴上では「AIジョブ」という名前の専用画面ではなく、UI内蔵の「ターミナル」だった。

コミット `ff8402d`（2026-07-02、`削除: UI内蔵ターミナル(PTY/xterm)を廃止しエージェント作業を手元ターミナルに一本化`）で、次が意図的に削除されている。

- 右下のフローティングボタン `#toggleTerminal`
- 右側の `#terminalPane`
- xterm / PTYストリーム
- `/api/terminal*`
- `@lydell/node-pty`、`@xterm/xterm`

旧パネルにはAI処理の開始・完了・失敗ログも流れていたため、ユーザーから見るとAI処理の進捗確認面としても機能していた。削除後も `writeTerminal()` の呼び出しは残っているが、現行実装はエラーをトースト表示し、それ以外を `console.log()` へ出すだけで、継続的に確認できる画面は存在しない。

したがって、PTYターミナルを復活させてはならない。現行方針を維持したまま、AI処理の状態確認だけを担う専用の「AIジョブ」モニターを右下へ新規実装する。

## 2. Goal

ユーザーが、画面遷移や再読み込みをしても、現在の案件で動いているAI処理について次を確認できるようにする。

1. 何の処理が動いているか
2. 待機中・実行中・完了・失敗・中断疑いのどれか
3. 現在どの工程か
4. 開始からどのくらい経過したか
5. 失敗した場合のユーザー向け理由
6. 複数件を並列実行している場合の件数と個別状態

対象は現行Liteの5ステップに関係するAI処理に限定する。

- 内部LP解析・OCR
- 事実抽出
- WHO-WHAT生成
- バナー画像テンプレ解析
- バナーの `copyplan → prompt → image`
- バナー画像の範囲指定修正・全体修正
- 表現レギュレーションのAI抽出・取り込み

## 3. Non-goals

今回の実装では、次を行わない。

- UI内蔵ターミナル、PTY、xterm、Codex / Claude起動機能の復活
- AIジョブ画面からのキャンセル、強制終了、再実行
- 手元ターミナルで動くCodex / Claude自体の思考・ツール実行ログの表示
- OpenAIレスポンスのトークン単位ストリーミング
- 根拠のない進捗率や残り時間の表示
- 新しい外部依存関係の追加
- プロンプト本文、AI応答本文、APIキー、Authorization header、ローカル絶対パスの表示
- バナーの `copyplan → prompt → image` という3ノード構造の変更
- 事実DBをバナー生成入力へ戻すこと
- バナー生成モデル、画像品質、プロンプト、retry条件、timeout、SLA判定の変更
- `CMOAI_PROMPT_CONCURRENCY` / `CMOAI_IMAGE_CONCURRENCY` または既存10並列上限の変更
- AIジョブGET APIからのリース更新、復旧sweep、再実行、ファイル書き込み

## 4. 現状調査

### 4.1 画面側

`src/ui/index.html` には `#toastStack` はあるが、AIジョブ一覧またはターミナルのDOMはない。

`src/ui/app.js` には以下が残っている。

- `runningActions`: 同一タブ内の同期処理を二重実行しないためのメモリ内状態
- `activeExtractions`: 同一タブ内のLP解析状態
- `pendingBannerEdits`: 画像修正完了トースト用のメモリ内状態
- `hasActiveWork()` / `ensureLiveRefresh()`: 3秒ごとに案件全体を再取得する仕組み
- `writeTerminal()`: エラーはトースト、それ以外はコンソール出力だけ

この構成には次の問題がある。

- タブ内メモリに依存するため、再読み込みすると同期AI処理の表示状態を失う。
- 処理状態は各テーブル・カード・詳細ペインに分散しており、画面をまたいで一覧できない。
- `ensureLiveRefresh()` は既知のアクティブ状態がなくなると停止するため、別タブや手元ターミナルから開始されたジョブを自動発見できない。
- 完了トーストは7秒で消えるため、後から確認できない。
- `writeTerminal()` の通常ログはユーザー画面へ出ない。

### 4.2 サーバー・データ側

すでに利用可能な状態情報は以下のとおり。

| 処理 | 現在の状態源 | 取得できる粒度 | 不足 |
| --- | --- | --- | --- |
| 内部LP解析 | `material-extraction-jobs.json`、`extractionJobs[]` | queued/running/completed/failed、`steps[]`、`progressAt`、エラー | 横断一覧UI |
| 事実抽出 | `runningJobs` のロック | 実行中かどうか | 公開API、処理名、開始時刻、完了履歴 |
| WHO-WHAT | `runningJobs` のロック | 実行中かどうか | 公開API、処理名、開始時刻、完了履歴 |
| 表現レギュ抽出 | `runningJobs` またはHTTPリクエスト | 実行中かどうか | 公開API、処理名、開始時刻、完了履歴 |
| テンプレ解析 | `ad-templates.json` | queued/running/completed/failed、開始・完了時刻、エラー | 横断一覧UI |
| バナー生成 | `banner-creatives.json` | 3ノード状態、リース、attemptId、開始・完了時刻、duration、エラー | 横断一覧UI |
| バナー画像修正 | `imageGenerationLease.operationKind/editMode`、画像状態 | queued/generating/completed/failed、修正種別 | 横断一覧UI |

`GET /api/research?project=...` で案件内データは取得できるが、AIジョブ専用の正規化レスポンスはない。テンプレ解析だけは `GET /api/ad-templates/template-image/status` がある。

### 4.3 重要な診断

処理基盤そのものが消えたわけではない。長時間処理の状態やリースは現行コードに残っており、バナーとテンプレでは再起動復旧も強化中である。欠けているのは、異なる保存形式を1つのユーザー向けジョブ一覧へ正規化する読み取り面である。

## 5. Architecture

状態の正本を新しい `ai-jobs.json` に二重保存しない。既存の各DB、パイプラインノード、リース、実行ロックを正本とする。ただし、2〜30秒ごとのpollingで大容量JSONを毎回読み直すことは禁止する。読み取り専用キャッシュを挟み、ファイルが変化した場合だけ再読込・再正規化する。

```text
material-extraction-jobs.json ─┐
research-materials.json ───────┤
banner-creatives.json ─────────┼→ stat(mtimeMs + ctimeMs + size + ino) → changed sourceだけread/parse
data/ad-templates.json ─────────┘                         ↓
                                                  aiJobSourceCache
runtime AI job registry ─────────────────────────────────┤
                                                        ↓
                                             buildAiJobSnapshot()
                                                        ↓
                                               GET /api/ai-jobs
                                                        ↓
                                              右下「AIジョブ」モニター
```

新規ファイル:

```text
src/core/ai-job-view.js
src/core/ai-job-source-cache.js
src/core/runtime-ai-job-registry.js
```

責務:

- 既存レコードをユーザー向けジョブ形式へ正規化する
- アクティブジョブと直近の終端ジョブを集約する
- リース期限切れやハートビート停止を「中断の可能性」として判定する
- 内部エラーを安全なユーザー向け文へ変換する
- 並び順、件数制限、直近表示期間を一元管理する

`src/server.js` はルーティングと実行中ジョブの登録だけを担当し、表示用の判定ロジックを増やさない。

### 5.1 読み取りキャッシュの必須仕様

`src/core/ai-job-source-cache.js` に、AIジョブ表示専用の読み取りキャッシュを実装する。

- キャッシュキーは絶対ファイルパス。APIレスポンスへ絶対パスを含めない。
- ファイル識別子は `mtimeMs + ctimeMs + size + ino`。`ino`を利用できない環境では0としてよい。原子的renameで同一ms・同一サイズの更新が起きても見落としにくくする。識別子が前回値と同じなら `readFile()` / `JSON.parse()` / 全件normalizeを実行しない。
- 初回、識別子変更時、ファイル消失・再作成時だけ対象ファイルを読み直す。
- 同一ファイルの再読込Promiseを共有し、同時pollで二重解析しない。
- source変更時に、UI表示へ必要なID・状態・時刻・タイトル・安全化前エラーだけを軽量projectionへ変換して保持する。raw JSON全体をリクエストごとに再normalizeしない。
- JSONは現行`readJson()`と同じくBOMを許容する。原子的rename直後の一時的な読込失敗は既存方針に合わせて再試行する。
- 前回成功スナップショットがある状態で一時的な読込エラーが起きた場合、API全体を500にせず、前回値と`sourceWarning`を返す。初回読込失敗時だけ500にする。
- 一時的読込失敗時は失敗した識別子を成功扱いで保存せず、次回pollで再試行する。
- キャッシュは読み取り最適化であり正本ではない。サーバー再起動時は空から再構築する。
- runtime registryはファイルキャッシュと分離し、リクエストごとに最新Mapをマージする。
- キャッシュ上限は共有テンプレ1件と案件別ソースを直近5案件まで。案件切替で無制限に保持しない。
- source projectionとruntime terminal jobのstale化時刻、リース期限、recent表示終了時刻のうち最短値を `nextTimeBoundaryAt` として保持する。ファイル未変更でもこの境界を超えた場合だけ軽量projection/Mapから再判定し、stale/recentを更新する。

`GET /api/ai-jobs` の定常キャッシュヒット経路では、次を禁止する。

- `getResearchWorkspace()` / `getBannerGenerationWorkspace()` / `listAdTemplates()` の呼び出し
- JSON DBへの書き込み、`withFileLock()`、リース更新、復旧sweep
- OpenAI / Anthropic / Gemini / Codexの呼び出し
- prompt/image/template worker poolまたはファイルセマフォの取得
- バナーprompt、画像、copyBrief、pipeline hashの再計算・変更

### 5.2 現行データで確認済みの性能基準

2026-07-20時点の実データでは、`data/ad-templates.json` は約8.24MB、対象案件の `banner-creatives.json` は約2.92MB、`GET /api/research` 相当の整形レスポンスは約11.69MiBだった。案件全量の読込・正規化・整形JSON化は約60ms/回である。

この数値は実装時のベンチマークfixtureへ固定し、AIジョブAPIが同規模データで毎poll全件解析する実装を不合格にする。数値はマシン性能で変わるため、絶対時間だけでなく「ファイル未変更時のread/parse回数が0」であることを主判定にする。

現行速度改善の基準点として、実装前レビュー時に次の26テストは全件PASSしている。

```bash
node --test tests/banner-sla.test.js tests/job-queue.test.js tests/prompt-worker.test.js
```

AIジョブ実装の前後で同じコマンドを実行し、件数・合否を維持する。これは外部AI実時間の証明ではなく、180秒SLA境界、10並列上限、FIFO、リース競合、attempt保護のcharacterization baselineである。

## 6. API contract

追加:

```http
GET /api/ai-jobs?project=./projects/{project-name}&recentLimit=20
```

レスポンス例:

```json
{
  "ok": true,
  "serverTime": "2026-07-20T12:00:00.000Z",
  "snapshotVersion": "jobview_xxx",
  "activeCount": 3,
  "sourceWarning": "",
  "jobs": [
    {
      "id": "banner:ban_xxx:attempt_xxx",
      "kind": "banner_generation",
      "scope": "project",
      "targetId": "ban_xxx",
      "title": "バナー案 01",
      "status": "running",
      "statusLabel": "画像生成中",
      "stage": {
        "key": "image",
        "label": "画像生成",
        "index": 3,
        "total": 3,
        "determinate": true
      },
      "steps": [
        { "key": "copyplan", "label": "コピー設計", "status": "completed" },
        { "key": "prompt", "label": "プロンプト作成", "status": "completed" },
        { "key": "image", "label": "画像生成", "status": "running" }
      ],
      "startedAt": "2026-07-20T11:57:00.000Z",
      "updatedAt": "2026-07-20T11:59:50.000Z",
      "finishedAt": "",
      "elapsedMs": 180000,
      "errorMessage": "",
      "canRetry": false
    }
  ]
}
```

### 6.1 共通status

外部へ返す状態は次に限定する。

```text
queued
running
completed
completed_with_warnings
failed
stale
```

`stale` の表示文言は「中断の可能性」。DBをこのGET APIで変更したり、自動再実行したりしない。復旧は既存のテンプレ・バナー復旧処理へ委ねる。

### 6.2 件数と期間

- アクティブジョブは件数制限せず、すべて返す。
- 終端ジョブは既定60分以内、最大20件。
- `recentLimit` は0〜50へ丸める。
- 古い完了レコードを毎回全件返さない。
- 並び順は `stale → failed → running → queued → completed_with_warnings → completed`、同一状態内は更新時刻の降順。

### 6.3 安全なエラー表示

`safeJobError()` を `src/core/ai-job-view.js` に実装する。

- 最大300文字
- APIキーらしい文字列をマスクする
- `Authorization:` をマスクする
- `/Users/...`、Windowsドライブ等の絶対パスを表示しない
- JSONリクエスト本文やプロンプト本文を表示しない
- 空の場合は処理種別ごとの既定文を返す

### 6.4 キャッシュとHTTP条件付き取得

- `snapshotVersion` はsource識別子、runtime registryの単調増加version、時間境界version、案件ID、`recentLimit` から生成する。レスポンス全体を毎回`JSON.stringify()`してhashしない。
- `ETag` は `snapshotVersion` から生成し、`If-None-Match` が一致する場合はbodyなしの304を返す。
- `Cache-Control: no-cache, private` を返す。ブラウザや中間層へ古い状態を固定保存させない。
- 304判定のために大容量JSONを読み直してはならない。先にsource cacheの識別子、runtime registryのversion、`nextTimeBoundaryAt`を確認する。
- `sourceWarning` は前回成功値を返した場合だけ安全な固定文を設定し、ファイルパスや例外全文を含めない。

## 7. Runtime AI job registry

事実抽出、WHO-WHAT、表現レギュレーション抽出は、現状の永続レコードだけでは実行中状態を再構成できない。`src/server.js` の `runningJobs` をロック専用のまま使い、表示用メタデータを持つ別Mapを追加する。

```js
const runtimeAiJobs = new Map();
```

必要なhelper:

```js
beginRuntimeAiJob(meta)
updateRuntimeAiJob(jobId, patch)
completeRuntimeAiJob(jobId, patch)
failRuntimeAiJob(jobId, error)
listRuntimeAiJobs({ projectRoot, recentSince })
pruneRuntimeAiJobs()
withRuntimeAiJob(meta, handler, options)
```

保持条件:

- アクティブジョブは完了まで保持する。
- 終端ジョブは60分または50件の早い方で削除する。
- サーバー再起動で履歴が消えてよい。進捗の正本ではなく、永続状態を持たない同期処理の補助表示である。
- `runningJobs` のロック解除と `runtimeAiJobs` の終端更新は別責務にする。
- runtime registryのmutationごとに単調増加する `runtimeAiJobsVersion` を更新し、ETag判定へ使う。
- pruneはbegin/terminal更新時と最大1分に1回だけ行い、pollごとの全Map整理をしない。
- runtime registryの表示補助更新に失敗しても、本来のAI処理、保存結果、HTTP statusを失敗へ変えない。registry helperは例外を外へ漏らさない。

既存の `withJobLock()` はシグネチャ、二重実行防止キー、catch、finallyを変更しない。ロックの内側で、実際にAI処理へ入る直前だけ `withRuntimeAiJob()` を呼ぶ。

```js
return withJobLock(res, lockKey, async () => {
  // 400を返す入力・案件検証はruntime job開始前に完了させる。
  const result = await withRuntimeAiJob({
    kind: "fact_extraction",
    projectRoot,
    targetId: body.productId,
    title: "商品事実抽出"
  }, async () => extractProductFactsWithAi(projectRoot, options));
  // extractProductFactsWithAi()はDB保存完了後にresolveするため、ここでcompletedにできる。
  return sendJson(res, { ok: true, ...result });
});
```

WHO-WHATのように生成と保存がroute内で分かれている処理だけ、生成後・保存前に `update({ stageLabel: "保存処理中" })` を呼び、全提案の保存完了後にhandlerをresolveする。

`withRuntimeAiJob()` の責務:

1. handler実行直前にrunningを登録する。
2. handlerが正常resolveした場合だけcompletedへする。
3. handlerがthrowした場合はfailedへして同じ例外を再throwする。HTTP 500化は既存`withJobLock()`へ委ねる。
4. `options.isSuccess(result)` がfalseの場合はfailedへする。`runAction()`のように例外ではなく`{ ok:false }`を返す処理に使う。
5. registry更新失敗はログだけに留め、handler結果を上書きしない。
6. handlerが完了してもterminal更新されていない場合、finallyの防御処理でfailedへする。ただしcompletedをfailedへ上書きしない。

入力不正、案件構造不正、`ALREADY_RUNNING`など、AI呼び出し前に確定する4xxはruntime jobとして登録しない。APIが400/409を返しただけの処理を「完了」と表示してはならない。

登録対象:

- `/api/research/facts/extract-ai`
- `/api/strategies/generate`
- `/api/regulations/import-text`
- `/api/regulations/extract-text`。UIは既存bodyへ`project`を追加する。後方互換のためproject未指定呼び出しは従来どおり実行するがruntime登録しない。
- `/api/run` の `research.extract_facts` と `strategy.create_who_what`。`dryRun=true`は登録しない。`runAction()` が `{ ok:false }` を返した場合はfailedへする。

`/api/research/materials/extract`、テンプレ解析、バナー処理、`/api/run` の `content.banner_create` は既存の永続状態から取得できるため、runtime registryへ二重登録しない。`project.resolve_context` はAIを呼ばないため登録しない。

同期AI処理は内部工程のハートビートを持たないため、偽の進捗率を返さない。`stage.determinate=false`、状態は「AI応答待ち」または「保存処理中」、経過時間だけを表示する。

## 8. ジョブ正規化ルール

### 8.1 内部LP解析

入力:

- `aiJobSourceCache` が `material-extraction-jobs.json` から作ったjob projection
- `aiJobSourceCache` が `research-materials.json` から作った `id/title/sourceUrl` だけのmaterial projection。本文、OCR全文、スクリーンショット配列は保持しない

ID:

```text
material:{job.id}
```

表示:

- タイトルは資料名またはURLホスト名
- `steps[]` の最後のrunning工程を現在工程にする
- runningがなければ最後のcompleted/failed工程を表示する
- `progressAt` から10分以上更新がないrunningジョブは `stale`
- percentは出さない。工程名と「処理済みスライス数 / 総スライス数」がある場合だけ件数を出す

### 8.2 事実抽出・WHO-WHAT・表現レギュレーション

入力:

- `runtimeAiJobs`

表示:

- 事実抽出: 「商品事実を抽出中」
- WHO-WHAT: 「WHO-WHATを生成中」
- 表現レギュ: 「表現レギュレーションを抽出中」
- determinate progressは表示しない
- HTTP成功は保存完了後にcompletedへする
- 例外時はfailedへし、安全化したエラーを表示する

### 8.3 テンプレ解析

入力:

- `aiJobSourceCache` が `data/ad-templates.json` から作った軽量projection

ID:

```text
template:{template.id}:{templateAnalysisAttemptId}
```

表示:

- `templateProcessingStatus` を共通statusへ変換する
- queuedは「解析待ち」、runningは「構造・コピー枠を解析中」
- `templateAnalysisQueuedAt` / `StartedAt` / `CompletedAt` を使う
- runningでリース期限切れなら `stale`
- 共通DBのため `scope="shared"`、補助ラベルは「共通テンプレDB」

### 8.4 バナー生成

入力:

- `banner.pipelineNodes.copyplan/prompt/image`
- `productionStatus`
- `imageGenerationStatus`
- `promptGenerationLease`
- `imageGenerationLease`
- `lastError` / `lastErrorAt`
- `jobRecoveryAudit` が存在する場合は回復状態の補助表示に使う

ID:

```text
banner:{banner.id}:{activeAttemptId}
```

`activeAttemptId` は現在ノードのattemptId、なければ対応リースのattemptId、終端履歴では最後のノードattemptIdを使う。

表示工程:

```text
1. copyplan  コピー設計
2. prompt    プロンプト作成
3. image     画像生成
```

ルール:

- `prompt_queued` は現在ノードに応じて「コピー設計待ち」または「プロンプト作成待ち」
- `prompt_generating` は現在ノードに応じた実行中表示
- `imageGenerationStatus=queued` は「画像生成待ち」
- `imageGenerationStatus=generating` は「画像生成中」
- `completed_with_warnings` は終端として扱う
- ノードの `durationMs` がある場合、完了工程の実時間を詳細へ表示できる
- リース期限切れは `stale`。GET API内ではレコードを書き換えない
- `jobRecoveryAudit.lastAction=image_requeued` は「サーバー再起動後に画像生成を再開」と補助表示する
- `prompt_reset_for_manual_retry` / `image_reset_for_manual_retry` はfailedまたはstaleの理由として表示する

### 8.5 バナー画像修正

`imageGenerationLease.operationKind === "edit"` の場合、通常画像生成ではなく次のkindへする。

```text
banner_image_edit
```

`editMode` の表示:

- `range`: 範囲指定修正
- `full`: 全体修正

画像修正はバナー生成の3工程とは別の1工程として表示し、copyplan/promptを再実行しているように見せない。

## 9. UI specification

変更:

```text
src/ui/index.html
src/ui/app.js
src/ui/styles.css
```

### 9.1 右下フローティングボタン

常時表示する。

```html
<button id="aiJobMonitorToggle" class="aiJobMonitorFab" ...>
  <span>AIジョブ</span>
  <b id="aiJobActiveCount">0</b>
</button>
```

仕様:

- 右20px、下20px
- アクティブ0件でもボタンは表示する
- アクティブ時は件数バッジと小さなspinnerを表示する
- failed/staleが新着の場合は警告色のdotを表示する
- `aria-expanded`、`aria-controls`、明確な日本語ラベルを付ける
- 旧ターミナルのロボットアイコンや「起動」操作は復活させない

### 9.2 パネル

デスクトップ:

- 右下に固定
- 幅380px前後、最大幅は `calc(100vw - 32px)`
- 最大高さは `min(70vh, 640px)`
- フローティングボタンの上へ開く
- 非モーダル。画面本体の操作を妨げない

モバイル（820px以下）:

- 下端のbottom sheet
- 幅100%
- 最大高さ70vh
- 閉じるボタンと見出しを常に表示

パネル構成:

```text
AIジョブ
現在の案件名              更新

実行中・待機中 3
  [画像生成中] バナー案 01      2分31秒
  コピー設計 ✓ → prompt ✓ → 画像生成 ●

  [解析中] 参考バナー NO.012    45秒
  構造・コピー枠を解析中

最近完了
  [完了] WHO-WHAT生成           1分12秒
  [失敗] 商品事実抽出           理由を表示
```

### 9.3 表示ルール

- アクティブセクションは常に上
- アクティブ0件なら「現在実行中のAI処理はありません」
- recentも0件なら空状態説明を表示
- queued/runningはspinner、completedはcheck、failed/staleは警告アイコン
- 経過時間はクライアントで1秒ごとに再計算してよいが、`.aiJobElapsed`の`textContent`だけを更新し、パネル全体・案件画面を再renderしない。アクティブ0件では1秒timerを停止する
- バナーだけ3ステップの進捗バーを表示する
- 工程数が不明な処理には進捗バーを表示せず、spinnerと現在工程だけを表示する
- エラー詳細は2行まで。展開ボタンで全文を確認できる
- 初回スナップショット取得時に過去の完了ジョブ通知を大量表示しない

### 9.4 開閉

- 既定は閉じた状態
- ユーザーがUIから新しいAI処理を開始した直後は自動で開く
- ユーザーが明示的に最小化したセッション中は、新しいジョブでも勝手に再度開かない
- 開閉状態は同一タブのメモリで十分。永続化は不要
- 案件切替時は古い案件の表示を即座に消し、新案件を取得する

## 10. Polling and synchronization

`GET /api/ai-jobs` 専用のpollerを追加する。`loadResearch()` の案件全量取得をAIジョブパネルのためだけに増やさない。

推奨周期:

- アクティブあり: 3秒
- パネルopen、アクティブなし: 5秒
- パネルclosed、アクティブなし: 10秒
- `document.hidden`: 30秒

実装条件:

- `setInterval` の多重起動を避け、1回のfetch完了後に `setTimeout` で次回を予約する
- `aiJobPollInFlight` で重複fetchを防ぐ
- 案件切替時はgeneration tokenまたはAbortControllerで古いレスポンスを破棄する
- `If-None-Match` を送り、304ではDOM再構築と通知判定を行わず、経過時間表示だけ更新する
- 既存の `get()` は常に`res.json()`するためAIジョブpollerでは使わない。専用`fetchAiJobSnapshot()`で304をbody parseせず処理し、200時だけJSONを読む
- APIエラー時はパネルを消さず、「更新できませんでした。再試行します」と最終成功時刻を表示する
- 失敗時は指数バックオフし、最大30秒
- 終端遷移を検知したとき、既存`liveRefreshTimer`が動作中または`hasActiveWork()`がtrueなら、新しい全量取得を追加せず既存`ensureLiveRefresh()`へ反映を委ねる
- 既存ライブ更新が動いていない外部開始ジョブの終端だけ、`isEditingNow()` を尊重しつつ `loadResearch()` / `renderResearch()` を750ms debounceし、同一バッチの複数完了を1回へまとめる
- debounce待機中に編集が始まった場合は破棄せず、編集終了後に1回だけ再予約する
- 初回ロードでもidle pollingを開始し、別タブ・手元ターミナルから開始した処理を発見する

既存の `ensureLiveRefresh()` は直ちに削除しない。ただし、AIジョブpollerとの併存を理由に案件全量取得を増やさない。併存期間のAIジョブpollerは5.1のキャッシュヒット経路を必須とし、追加負荷を `stat + 小さい304/JSONレスポンス` に限定する。画面本体の全量polling整理は別PRとする。

バナー生成速度を守るため、次を同一PRで変更してはならない。

- `ensureLiveRefresh()` の3秒周期、`hasActiveWork()` の判定、既存バナー完了反映ロジックの全面置換
- prompt/image worker pool、グローバルファイルセマフォ、リースheartbeat
- バナー生成受付からbackground task開始までの制御フロー

AIジョブUIは既存生成経路の観測者に限定する。AIジョブpollerの完了を待ってからバナー生成APIを呼ぶ、またはバナー生成受付を待たせる実装は禁止する。

## 11. Completion notifications

クライアント内に前回スナップショットを保持し、同一job IDの状態遷移だけを通知する。

```text
queued/running → completed
queued/running → completed_with_warnings
queued/running → failed
queued/running → stale
```

通知例:

- `バナー案 01の画像生成が完了しました。`
- `参考バナー NO.012のテンプレ解析に失敗しました。`
- `商品LP解析が10分以上更新されていません。中断の可能性があります。`

初回ロード時のcompleted/failedレコードは通知しない。ポーリングごとに同じ終端通知を繰り返さない。

## 12. 実装対象ファイル

### 新規

```text
src/core/ai-job-view.js
src/core/ai-job-source-cache.js
src/core/runtime-ai-job-registry.js
tests/ai-job-view.test.js
tests/ai-job-source-cache.test.js
tests/ai-jobs-api.test.js
tests/ai-job-monitor-ui.test.js
tests/ai-job-performance.test.js
tests/runtime-ai-job-registry.test.js
```

### 変更

```text
src/server.js
src/ui/index.html
src/ui/app.js
src/ui/styles.css
docs/architecture.md
docs/data-model.md
DESIGN.md
```

`package.json` のdependencyは変更しない。

## 13. Implementation tasks

### Task 1: 正規化関数をTDDで作る

対象:

```text
src/core/ai-job-view.js
tests/ai-job-view.test.js
```

先に失敗テストを書く。

- LP解析running + steps
- LP解析heartbeat stale
- テンプレqueued/running/completed/failed
- バナーcopyplan/prompt/imageの各工程
- バナー画像修正range/full
- `completed_with_warnings`
- リース期限切れ
- `jobRecoveryAudit` の補助表示
- recent cutoffとlimit
- 安全なエラーマスク
- アクティブ優先ソート

### Task 2: Runtime AI job registryを追加する

対象:

```text
src/server.js
src/core/runtime-ai-job-registry.js
tests/runtime-ai-job-registry.test.js
```

`createRuntimeAiJobRegistry()` と `withRuntimeAiJob()` を実装し、既存`withJobLock()`の内側から事実抽出、WHO-WHAT、表現レギュレーション、対象AI actionを登録する。`withJobLock()`自体は変更しない。

注意:

- 既存の二重実行防止キーを変えない
- 既存`withJobLock()`のシグネチャ、catch、finally、HTTP応答処理を変えない
- HTTP statusとレスポンス形式を変えない
- エラー時もロックを必ず解除する
- job IDは `job_${crypto.randomUUID()}` を使う
- projectRootの絶対パスをAPIへ返さない
- 4xx事前条件エラーをcompletedとして登録しない
- `runAction()` の `{ ok:false }` をcompletedとして登録しない
- WHO-WHATは全提案の保存完了後、事実抽出・取り込みはDB保存完了後にcompletedへする
- `/api/regulations/extract-text` のUI bodyへ案件pathを追加するが、project未指定の既存クライアントを壊さない

先に次の失敗テストを書く。

- 正常resolveはcompleted、throwはfailedかつ元の例外を再throwする
- `isSuccess(result) === false` はfailedで、呼び出し元へ元resultを返す
- registryの補助更新失敗がhandler結果とHTTP statusを変えない
- 別案件のruntime jobをlistしない
- versionはmutation時だけ増え、read時は増えない
- pruneでactive jobを削除せず、期限切れterminalだけ削除する
- 4xx事前検証、`dryRun`、非AI action、永続バナーactionはruntime登録0件

### Task 3: 統合APIを追加する

対象:

```text
src/server.js
src/core/ai-job-view.js
src/core/ai-job-source-cache.js
tests/ai-job-source-cache.test.js
tests/ai-jobs-api.test.js
```

`GET /api/ai-jobs` を追加し、次を検証する。

- project未指定・不正パスは400
- 別案件のruntime jobを返さない
- 共通テンプレのactive jobを返す
- APIは読み取り専用で、JSONファイルを変更しない
- 50件超のrecentLimitを丸める
- 200レスポンスに秘密情報・絶対パスを含めない
- 同じsource識別子の連続取得ではread/parseが増えない
- source変更時だけ該当ファイルを1回再読込する
- 同時リクエストでも同じファイルの再読込Promiseを共有する
- `If-None-Match` 一致時は304かつbodyなし
- 200/304の両方で正しい`ETag`と`Cache-Control: no-cache, private`を返す
- キャッシュヒット経路でworker、semaphore、file lock、復旧処理を呼ばない
- 前回成功値がある一時的読込失敗は200 + 安全な`sourceWarning`、初回失敗は500

### Task 4: 右下UIを追加する

対象:

```text
src/ui/index.html
src/ui/app.js
src/ui/styles.css
tests/ai-job-monitor-ui.test.js
```

静的なDOM存在確認だけで終わらせず、純粋関数へ分けてテストする。

- status別の表示
- active count
- バナー3工程
- indeterminate処理
- safe error text
- 空状態
- 初回ロードで過去完了通知を出さない
- 同一終端通知を重複しない
- 案件切替後の古いレスポンスを捨てる
- 専用`fetchAiJobSnapshot()`が200 JSON、304 bodyなし、500 JSON、AbortErrorを区別する
- 表現レギュレーション抽出requestへ現在案件pathを追加し、未選択時は従来のエラー導線を壊さない

### Task 5: 既存ライブ更新と接続する

- UIの各AI実行受付後にジョブスナップショットを即時再取得する
- 同期APIは受付レスポンスを待つと処理完了後になってしまうため、`runExclusive()` の開始時点でパネルを開き、直ちにpollingする
- バナー一括生成、テンプレ解析、LP解析の202受付直後にqueued状態を表示する
- 同期処理はruntime registryのrunning状態を表示する
- 終端遷移時だけ案件データを再読込する
- 入力・セル編集中に `renderResearch()` で内容を失わない
- 同一バッチの複数終端遷移は750ms debounceで全量再取得1回にまとめる
- `liveRefreshTimer`動作中は終端通知から追加の`loadResearch()`を起動しない
- バナー生成APIの開始・受付・background dispatchはAIジョブfetchをawaitしない

### Task 6: ドキュメントを更新する

- `docs/architecture.md`: AIジョブ読み取り面を追加
- `docs/data-model.md`: 状態の正本は既存DBであり、統合APIはread modelであることを明記
- `DESIGN.md`: 右下FAB、パネル、mobile bottom sheet、状態色、空状態を追加
- `AGENTS.md` の「UI内蔵ターミナルは廃止」を変更しない

## 14. Acceptance criteria

### 必須

- 右下に「AIジョブ」ボタンが常時表示される。
- アクティブ件数がバッジに出る。
- パネルを開くと現在案件のアクティブジョブが一覧できる。
- バナーは `コピー設計 → プロンプト作成 → 画像生成` の現在位置が分かる。
- LP解析は現在のstepが分かる。
- テンプレ解析は待機中と解析中を区別できる。
- 事実抽出とWHO-WHATは再読み込み後も、同じサーバープロセスで動作中なら実行中と分かる。
- 画面を再読み込みしても、永続状態を持つLP・テンプレ・バナージョブが復元表示される。
- 別タブまたは手元ターミナルから開始したジョブを10秒以内に発見する。
- failed/staleの理由を安全な日本語で確認できる。
- AI呼び出し前の4xxは完了履歴へ出ず、AI/保存中の例外と`runAction()`の`ok:false`はfailedとして出る。
- WHO-WHAT、事実抽出、表現レギュレーションは保存完了後だけcompletedになる。
- 完了・失敗の通知を同じジョブで重複表示しない。
- 旧ターミナル、PTY、xterm、`/api/terminal*` は復活していない。

### 品質

- ジョブAPIのために案件全量をブラウザへ返さない。
- 同一source識別子の定常pollingでは大容量JSONのread/parse回数が0である。
- 8.24MBテンプレ + 2.92MBバナーfixtureのキャッシュヒットp95が10ms以下である。
- 2.92MBバナーfixtureの識別子が毎回変わる更新集中ケースでも、再読込・projection更新のp95が25ms以下である。共有テンプレが未変更なら8.24MBテンプレのread/parse回数は増えない。
- AIジョブ200レスポンスは通常100KB以下、未変更時は304 bodyなしである。
- アクティブ0件のidle時に高頻度pollingしない。
- APIレスポンスにプロンプト、応答本文、キー、絶対パスがない。
- 既存のバナーキュー・テンプレ復旧・LP抽出・WHO-WHAT生成の挙動を変えない。
- AIジョブ監視の有無でprompt/image worker上限10、FIFO、リース、heartbeatが変わらない。
- モニター有効時もバナー生成APIの202受付とbackground dispatchがAIジョブfetchに依存しない。
- 決定論的worker試験で、モニター無効時に対するjob開始遅延のp95差が50ms未満、総完了時間の差が3%未満である。
- 既存のバナーSLA評価、copyBrief、promptJson、generated image quality監査の保存内容が変わらない。
- モバイルでパネルが画面外へはみ出さない。
- キーボードだけで開閉できる。

上記の速度判定はmock workerとfixtureで必ず自動化する。外部AIの応答時間は変動が大きいため、実画像A/Bだけを合否根拠にしない。有料の実画像10件SLA確認はユーザー許可がある場合だけ行い、許可がなければ未実施と明記する。

## 15. Verification

### 15.1 静的確認

```bash
node --check src/server.js
node --check src/ui/app.js
node --check src/core/ai-job-view.js
node --check src/core/ai-job-source-cache.js
node --check src/core/runtime-ai-job-registry.js
node --check src/core/openai-text.js
node --check src/core/who-what-ai.js
node --check src/core/banner-ai.js
node --check src/core/template-ai.js
node --check src/core/product-research-ai.js
node --check src/core/lp-vision-ai.js
```

### 15.2 対象テスト

```bash
node --test \
  tests/ai-job-view.test.js \
  tests/ai-job-source-cache.test.js \
  tests/runtime-ai-job-registry.test.js \
  tests/ai-jobs-api.test.js \
  tests/ai-job-monitor-ui.test.js \
  tests/template-analysis-api.test.js \
  tests/template-analysis-queue.test.js \
  tests/banner-prompt-queue.test.js \
  tests/job-queue.test.js \
  tests/prompt-worker.test.js \
  tests/banner-sla.test.js
```

`tests/ai-job-performance.test.js` は最低限次を検証する。

1. 8.24MBテンプレ、2.92MBバナー、LPジョブfixtureを初回読込する。
2. source未変更のまま100回スナップショットを取得する。
3. read/parse回数が初回から増えないことをassertする。
4. 100回のキャッシュヒットp95が10ms以下であることをassertする。
5. 2.92MBバナーfixtureだけを毎回更新した20回のcold refreshでp95 25ms以下、未変更の8.24MBテンプレread/parseが増えないことをassertする。
6. 10件のmock prompt/image jobを既存workerへ投入し、同時に3秒相当のmonitor pollを実行する。
7. monitorなしとの比較でworker開始遅延p95差50ms未満、総完了時間差3%未満、最大並列数10をassertする。
8. GET経路からOpenAI/Anthropic、worker、semaphore、file lock、復旧関数が0回であることをspyでassertする。
9. 性能ファイルだけは `node --test --test-concurrency=1 tests/ai-job-performance.test.js` で単独実行し、他テストとのCPU競合を測定へ混ぜない。

### 15.3 全体テスト

```bash
node --test --test-concurrency=1 tests
```

### 15.4 ブラウザ確認

実装時、`localhost:5173` が別チェックアウトの可能性を必ず確認する。

```bash
lsof -nP -iTCP:5173 -sTCP:LISTEN
lsof -a -p <PID> -d cwd -Fn
```

本書作成時点では、5173番ポートのlistenerは対象リポジトリではなく `/Users/koukamiyoshihiko/CMOAI` で動作していた。HTTP 200だけで対象実装を確認したことにしない。

正しいcheckoutを起動後、次を実操作する。

1. 内部LP解析を開始し、queued → running → completedを確認
2. 事実抽出を開始し、実行中と経過時間を確認
3. WHO-WHAT生成を開始し、実行中と完了を確認
4. テンプレ解析を2件開始し、待機/並列実行/完了または失敗を確認
5. バナーを3件生成し、案ごとのcopyplan/prompt/image進行を確認
6. バナー範囲指定修正を開始し、「画像生成」ではなく「範囲指定修正」と出ることを確認
7. 実行中に画面を再読み込みし、状態が復元されることを確認
8. 別タブから処理を開始し、元タブが自動発見することを確認
9. パネルを閉じても処理が継続し、badgeが更新されることを確認
10. 幅390pxでbottom sheet、幅1440pxで右下パネルを確認

有料AI呼び出しを伴う実操作は、実装者がユーザーの許可を得てから行う。許可がない場合はfixtureまたは失敗系APIでUI遷移を検証し、実AI未確認を明記する。

## 16. Baseline and worktree protection

最終レビュー中の2026-07-20 22:05 JSTに、バナー3分SLA、テキスト・画像retry、サーバー再起動後のバナージョブ復旧はcommit `0df1537`（`バナー生成改善をmainへ統合`）としてmainへ統合された。現時点のworktreeは本指示書以外cleanであり、速度改善の基準点はこのcommitである。

AIジョブ実装は `0df1537` 以降を前提とする。実装開始時にHEADが進んでいる場合は、最新`src/server.js`、保護対象、26件baseline testを再確認し、古い差分で上書きしない。特に次は共有面として競合しやすい。

```text
src/server.js
src/core/banner-store.js
tests/job-queue.test.js
docs/superpowers/plans/2026-07-20-banner-job-recovery-after-server-restart.md
```

実装前に必ず `git status --short`、`git log -1 --oneline`、`git diff` を確認し、既存変更を上書き・巻き戻ししない。AIジョブモニターは、統合済みの再起動復旧実装が保存する `jobRecoveryAudit` とリース状態を読み取る側として実装する。

### 16.1 バナー品質・速度ファイルのscope freeze

AIジョブ対応が統合済み速度改善へ混入していないことを確実にするため、実装開始前に次の保護対象のSHA-256を `.codex-validation/ai-job-protected-before.sha256` へ保存し、完了時に同じ一覧を `ai-job-protected-after.sha256` へ出して完全一致を確認する。

保護対象:

```text
config/prompts/banner-category-relation.md
config/prompts/banner-claim-alignment.md
config/prompts/banner-copy-review.md
config/prompts/banner-copy.md
config/prompts/banner-hypothesis.md
config/prompts/banner.md
src/core/anthropic-text.js
src/core/openai-text.js
src/core/openai-image.js
src/core/banner-ai.js
src/core/banner-copy-ai.js
src/core/banner-copyplan-ai.js
src/core/banner-store.js
src/core/banner-ocr.js
src/core/banner-prompt-compiler.js
src/core/banner-sla.js
src/core/banner-job-recovery.js
scripts/validate-banner-sla.mjs
tests/banner-sla.test.js
tests/banner-sla-script.test.js
tests/job-queue.test.js
tests/prompt-worker.test.js
tests/openai-image-quality.test.js
tests/openai-image-retry.test.js
tests/openai-text-retry.test.js
```

AIジョブ実装でこれらを変更する必要はない。before/afterが不一致なら今回実装のscope違反として不合格にし、AIジョブ対応が触った箇所を取り除いてから再検証する。`src/server.js`は今回も速度改善も変更する共有面なのでhash保護せず、次のcharacterization testで守る。

実装開始前:

```bash
mkdir -p .codex-validation
{
  find config/prompts -maxdepth 1 -type f -name 'banner*.md'
  printf '%s\n' \
    src/core/anthropic-text.js src/core/openai-text.js src/core/openai-image.js \
    src/core/banner-ai.js src/core/banner-copy-ai.js src/core/banner-copyplan-ai.js \
    src/core/banner-store.js src/core/banner-ocr.js src/core/banner-prompt-compiler.js \
    src/core/banner-sla.js src/core/banner-job-recovery.js scripts/validate-banner-sla.mjs \
    tests/banner-sla.test.js tests/banner-sla-script.test.js tests/job-queue.test.js \
    tests/prompt-worker.test.js tests/openai-image-quality.test.js \
    tests/openai-image-retry.test.js tests/openai-text-retry.test.js
} | sort > .codex-validation/ai-job-protected-files.txt
xargs shasum -a 256 < .codex-validation/ai-job-protected-files.txt > .codex-validation/ai-job-protected-before.sha256
```

実装完了後:

```bash
xargs shasum -a 256 < .codex-validation/ai-job-protected-files.txt > .codex-validation/ai-job-protected-after.sha256
diff -u .codex-validation/ai-job-protected-before.sha256 .codex-validation/ai-job-protected-after.sha256
```

- prompt/image concurrencyは既定10、上限10
- prompt/image workerはFIFOで11件目を待機
- `withGlobalTextSlot()` とimage file semaphoreをAIジョブGETが使わない
- `runFullBannerBatchInBackground()` のready item早期dispatchを変更しない
- banner生成202レスポンス後のbackground開始順を変更しない

さらに、非破壊ブラウザ確認の前後で対象案件の `banner-creatives.json`、`material-extraction-jobs.json`、共有`ad-templates.json`のhashとmtimeを比較し、AIジョブGET/pollingだけでは1byteも更新されないことを確認する。

```bash
target_project='projects/oh-my-teeth-20260720'
stat -f '%m %z %N' "$target_project/data/banner-creatives.json" "$target_project/data/material-extraction-jobs.json" data/ad-templates.json > .codex-validation/ai-job-db-before.stat
shasum -a 256 "$target_project/data/banner-creatives.json" "$target_project/data/material-extraction-jobs.json" data/ad-templates.json > .codex-validation/ai-job-db-before.sha256
# 正しいcheckoutのUIでAI処理を開始せず、パネルを開閉し60秒以上pollingさせる。
stat -f '%m %z %N' "$target_project/data/banner-creatives.json" "$target_project/data/material-extraction-jobs.json" data/ad-templates.json > .codex-validation/ai-job-db-after.stat
shasum -a 256 "$target_project/data/banner-creatives.json" "$target_project/data/material-extraction-jobs.json" data/ad-templates.json > .codex-validation/ai-job-db-after.sha256
diff -u .codex-validation/ai-job-db-before.stat .codex-validation/ai-job-db-after.stat
diff -u .codex-validation/ai-job-db-before.sha256 .codex-validation/ai-job-db-after.sha256
```

## 17. Self-review gate

実装完了前に `implementation-self-review-loop` で次を採点する。

| 観点 | 配点 |
| --- | ---: |
| ユーザーが進捗を横断確認できる | 20 |
| 状態の正本を二重化せず、再読み込み・別タブで復元できる | 15 |
| runtime jobの成功・失敗・案件scopeが正しい | 15 |
| polling、キャッシュ、worker非干渉の性能ゲートを満たす | 20 |
| バナーの品質入力・3ノード・retry・SLA成果物を変えていない | 15 |
| failed/staleの安全表示、UI、アクセシビリティ | 5 |
| 対象/全体テストと正しいcheckoutでのブラウザ確認 | 10 |

完了条件は90点以上、P0/P1なし。未達項目を具体的に修正してから完了報告する。

点数に関係なく、次は即時不合格とする。

- scope freeze対象のhash不一致
- キャッシュ未変更時のread/parse増加、性能閾値超過、worker上限/FIFO回帰
- AIジョブGETによるDB更新、リース更新、復旧、外部AI呼び出し
- バナーのモデル、prompt、copyBrief、promptJson、画像quality、retry、3ノードの変更
- 既存速度改善が入った`src/server.js`のprompt/image dispatch順序の変更
- ユーザー許可なしの有料AI実画像呼び出し

## 18. 推奨実装順

```text
1. git status/diff確認、scope freeze hash、現行banner SLA/worker baseline test
2. ai-job-source-cacheのRED testと性能fixture
3. ai-job-viewのpure function + unit test
4. runtime registry + lifecycle test
5. GET /api/ai-jobs + API/cache/304 test
6. 右下FAB/パネルの静的UI
7. poller・案件切替・通知・既存live refresh非重複test
8. docs更新
9. scope freeze hash再照合、対象テスト、性能テスト、全体テスト
10. 正しいcheckoutで非破壊ブラウザ確認
11. ユーザー許可がある場合だけ実AI動作確認
12. implementation-self-review-loop（90点以上、P0/P1なし）
```

旧 `ff8402d` をrevertしたり、旧ターミナルDOMをコピーしたりしないこと。復旧するのは「AI処理の状態をユーザーが確認できる体験」であり、OS依存のターミナル実行環境ではない。
