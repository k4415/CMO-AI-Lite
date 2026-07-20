# AIジョブボタン・詳細ドロワー操作競合 修正指示書

> **対象リポジトリ:** `/Users/koukamiyoshihiko/CMO-AI-Lite-main`
>
> **作成日:** 2026-07-21
>
> **状態:** 実装・TDD・ブラウザ実測・全体回帰テスト・セルフレビュー完了。最終提案どおり、単一のAIジョブボタンを詳細ヘッダーへドッキングする方式を採用した。
>
> **実装時必須:** `superpowers:test-driven-development` と `implementation-self-review-loop` を適用し、RED → GREEN → 自己レビュー → ブラウザ実測の順で進める。

## 1. Goal

詳細ドロワー内の「変更を保存」などの操作ボタンと、右下固定の「AIジョブ」ボタンが重なり、保存操作をクリックできなくなる問題を解消する。

修正後は次を両立する。

- 詳細ドロワー内の編集・保存・生成・ダウンロード等をAIジョブ導線が覆わない。
- AIジョブモニターは詳細ドロワー表示中も利用できる。
- AIジョブの状態、バッジ、警告、polling、API契約は変更しない。
- 詳細ドロワーを閉じた通常画面では、従来どおり右下固定のAIジョブボタンを表示する。
- 1つのAIジョブボタンを配置先だけ切り替え、重複したボタンや状態管理を作らない。

## 2. 現象と再現条件

### 2.1 再現手順

1. `npm run dev` で `http://localhost:5173/` を開く。
2. 「戦略」へ移動する。
3. 任意の戦略行を選択して右詳細ドロワーを開く。
4. 「編集」タブへ切り替える。
5. 詳細ドロワーを最下部までスクロールし、「変更を保存」を表示する。

### 2.2 localhost実測結果

2026-07-21、1280 × 720のviewportで現行`main`を確認した。

| 要素 | 矩形 | z-index |
| --- | --- | ---: |
| 詳細ドロワー | left 860 / right 1280 / top 0 / bottom 720 | 60 |
| AIジョブボタン | left 1147.375 / right 1260 / top 655 / bottom 700 | 145 |
| 変更を保存 | left 1192 / right 1266 / top 673.945 / bottom 701.945 | detail pane内 |

結果:

- 重なり幅: 68px
- 重なり高さ: 約26.05px
- 重なり面積: 約1,771.72px²
- 保存ボタン面積: 2,072px²
- 保存ボタンの約85%がAIジョブボタンに覆われる。
- `document.elementFromPoint()`で保存ボタン中央を調べると、最前面要素は`#aiJobMonitorButton`になる。

見た目の重なりだけではなく、クリック対象もAIジョブへ奪われている。

## 3. Root cause

### 3.1 2つの固定UIが独立している

`src/ui/styles.css`では、詳細ドロワーとAIジョブボタンが別々の固定レイヤーとして定義されている。

```css
.detailPane {
  position: fixed;
  right: 0;
  bottom: 0;
  z-index: 60;
}

.aiJobMonitorButton {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 145;
}
```

詳細ドロワーは画面右端まで使う一方、AIジョブボタンは詳細ドロワーの開閉状態を考慮せず、常にviewport右下へ残る。

### 3.2 保存ボタン固有の問題ではない

戦略編集の保存ボタンは`src/ui/app.js`の`strategyInspectorHtml()`が生成し、`.strategyInlineEdit .inlineAddButton`で右寄せされている。しかし、保存ボタンを左へ動かすだけでは、次の詳細操作でも同じ競合が再発し得る。

- 他の詳細編集フォームの保存
- バナーの画像生成・範囲指定修正・全体修正
- 参考バナーテンプレのフィールド保存
- 詳細ペイン下端に追加される将来のCTA

したがって、個別ボタンではなく、グローバルなAIジョブ導線と詳細ドロワーの配置責務を修正する。

### 3.3 z-indexだけを下げても要件を満たさない

詳細ドロワーをAIジョブより前面にするだけなら保存は押せるが、AIジョブボタンがドロワーの裏へ隠れる。既存のAIジョブ復旧仕様が求める「継続的に進捗へアクセスできる」状態を失うため、最終案にはしない。

## 4. Non-negotiable constraints

- `GET /api/ai-jobs`、ETag、304、polling周期を変更しない。
- `src/core/ai-job-view.js`、`src/core/ai-job-source-cache.js`、`src/core/runtime-ai-job-registry.js`を変更しない。
- AIジョブボタン、件数バッジ、警告dotを複製しない。
- 同じIDのDOMを2つ作らない。
- AIジョブの開閉イベントを二重登録しない。
- 詳細ドロワーの幅変更機能と`--detail-width`を変更しない。
- 戦略保存API、`updateTableRow()`、`runExclusive()`を変更しない。
- 保存ボタンの文言、保存内容、保存タイミングを変更しない。
- 詳細ドロワーのスクロール領域を固定フッター化する変更は本修正に含めない。
- バナー生成の`copyplan → prompt → image`、worker、AIモデル、プロンプト、画像品質を変更しない。
- 有料AI APIを検証のために呼ばない。
- 案件JSON、バナー、戦略データを検証目的で更新しない。保存クリック確認はfixtureまたは変更を伴わないヒットテストで行う。

## 5. 解決案の比較

| 案 | 内容 | 長所 | 問題 | 判定 |
| --- | --- | --- | --- | --- |
| A | AIジョブのz-indexを詳細ドロワーより下げる | CSS変更が最小 | 詳細表示中にAIジョブへアクセスできない | 不採用 |
| B | 詳細表示中だけAIジョブを上または左へ固定移動する | 既存DOMを維持できる | 可変ドロワー幅、最大幅、1180px以下の全幅表示、将来CTAで再競合する | 不採用 |
| C | 戦略の保存ボタンだけ左寄せまたは余白追加する | 現象だけは早く消せる | 他の詳細操作へ再発し、責務が局所UIへ漏れる | 不採用 |
| D | 詳細表示中、同じAIジョブボタンを詳細ヘッダーへ移す | 1つの状態とイベントを維持し、幅・スクロールに依存しない | 小さなDOM移動処理と配置先が必要 | **採用** |

## 6. Final proposal

### 6.1 1つのボタンを2つの配置先で使う

`#aiJobMonitorButton`は複製せず、詳細ドロワーの開閉に応じて同じDOM nodeを移動する。

```text
詳細ドロワー closed
  #aiJobMonitorButtonHome
    └─ #aiJobMonitorButton  ← viewport右下 fixed

詳細ドロワー open
  #detailAiJobMonitorDock（detailPaneHeaderActions内）
    └─ #aiJobMonitorButton  ← ヘッダー内 compact button
```

DOM nodeを移すため、次はそのまま維持される。

- `click` listener
- `aria-expanded`
- `aria-controls="aiJobMonitorPanel"`
- `isActive` class
- 件数バッジ
- failed/stale警告dot
- keyboard focusability

### 6.2 ドロワー内ではコンパクト表示にする

ドロワーヘッダーへ移動したときは`.isDocked`を付け、次の見た目にする。

- 幅34〜38px程度のコンパクトボタン
- `AI`アイコンを表示
- 通常ラベル「AIジョブ」は視覚上のみ隠す
- 件数バッジと警告dotは維持
- `aria-label="AIジョブ"`と`title="AIジョブ"`を付け、ラベル非表示時も用途が分かる
- fixed、right、bottom、強いshadowを解除し、`.detailPaneHeaderActions`の通常フローへ置く

### 6.3 パネル本体は移動しない

`#aiJobMonitorPanel`は現在と同じbody直下に置く。詳細ドロワー内へ移すと、`overflow`やstacking contextによりパネルが切れるためである。

ドッキングしたボタンから開いても、AIジョブパネルは従来どおり次の表示を使う。

- デスクトップ: 右下の非モーダルパネル
- 820px以下: 下端bottom sheet

パネルをユーザーが開いている間は一時的に編集面へ重なることを許容する。問題とするのは、閉じたAIジョブボタンが常時保存操作を塞ぐ状態である。パネルには既存の閉じる操作があり、閉じれば詳細操作へ戻れる。

### 6.4 移動は配置先が変わるときだけ行う

AIジョブpollingや画面再描画のたびに`appendChild()`してはならない。現在の親要素と配置先が異なる場合だけ移動する。

```js
function syncAiJobMonitorPlacement(detailOpen) {
  const button = $("#aiJobMonitorButton");
  const home = $("#aiJobMonitorButtonHome");
  const dock = $("#detailAiJobMonitorDock");
  const target = detailOpen ? dock : home;
  if (!button || !target) return;
  if (button.parentElement !== target) target.appendChild(button);
  button.classList.toggle("isDocked", detailOpen);
}
```

上記は実装意図を示す擬似コードである。既存の`$()`、初期化順、`renderInspector()`の早期returnを確認して組み込む。

## 7. Files to change

### 必須

```text
src/ui/ai-job-monitor.js
src/ui/index.html
src/ui/app.js
src/ui/styles.css
tests/ai-job-monitor-ui.test.js
```

### 原則変更しない

```text
src/server.js
src/core/ai-job-view.js
src/core/ai-job-source-cache.js
src/core/runtime-ai-job-registry.js
projects/**
data/**
```

`src/ui/ai-job-monitor.js`には配置だけを担う純粋helper `placeAiJobMonitorButton()`を追加した。AIジョブの状態判定、polling、API処理には変更を加えていない。DOM配置ロジックをテスト可能にするための最小限の追加である。

## 8. Implementation tasks

### Task 1: RED testを追加する

`tests/ai-job-monitor-ui.test.js`へ、最低限次の静的回帰テストを追加する。

- `#aiJobMonitorButtonHome`が1つある。
- `#detailAiJobMonitorDock`が`.detailPaneHeaderActions`内に1つある。
- `id="aiJobMonitorButton"`はHTML内に1つだけである。
- AIジョブボタンに`aria-label="AIジョブ"`、`aria-controls="aiJobMonitorPanel"`がある。
- `syncAiJobMonitorPlacement()`相当の関数が存在する。
- `renderInspector()`が詳細開閉状態を切り替えた直後に配置同期を行う。
- `.aiJobMonitorButton.isDocked`で`position: fixed`、`right`、`bottom`を解除する。
- ドッキング時もbadge、alert、`aria-expanded`を消す実装になっていない。
- `#aiJobMonitorPanel`をdetail paneへreparentしていない。

テスト名には、何を防ぐかが分かる日本語を使う。

```text
詳細ドロワー表示中は単一のAIジョブボタンをヘッダーへドッキングする
```

### Task 2: 配置先をHTMLへ追加する

`src/ui/index.html`を変更する。

1. 既存`#aiJobMonitorButton`を`#aiJobMonitorButtonHome`で包む。
2. `.detailPaneHeaderActions`の先頭へ`#detailAiJobMonitorDock`を追加する。
3. ボタンへ`aria-label="AIジョブ"`と`title="AIジョブ"`を追加する。
4. 表示ラベルのspanへ`.aiJobMonitorButtonLabel`を追加する。
5. `#aiJobMonitorPanel`はbody直下の現在位置から動かさない。

配置例:

```html
<div id="aiJobMonitorButtonHome" class="aiJobMonitorButtonHome">
  <button id="aiJobMonitorButton" ... aria-label="AIジョブ" title="AIジョブ">
    <span class="aiJobMonitorButtonIcon" aria-hidden="true">AI</span>
    <span class="aiJobMonitorButtonLabel">AIジョブ</span>
    ...
  </button>
</div>
```

```html
<div class="detailPaneHeaderActions">
  <span id="detailAiJobMonitorDock" class="detailAiJobMonitorDock"></span>
  ...既存の拡大・閉じるボタン...
</div>
```

### Task 3: 配置同期を実装する

`src/ui/ai-job-monitor.js`へ配置を担う`placeAiJobMonitorButton()`を、`src/ui/app.js`へDOM参照を渡す`syncAiJobMonitorPlacement()`を追加する。

呼び出し条件:

- 初期化時に1回
- `renderInspector()`で`.appShell.detailOpen`を切り替えた直後
- 選択解除で詳細ドロワーを閉じたとき
- 詳細の種類が切り替わったがopen状態が続く場合は、親が同じならDOMを動かさない

状態の正は既存の`selected`と`.appShell.detailOpen`に置く。新しい独立booleanを増やさない。

禁止:

- polling内で毎回移動する
- `renderAiJobMonitor()`内で移動する
- buttonを`cloneNode()`する
- event listenerを移動のたびに再登録する
- badgeやalertを別DOMへコピーする

### Task 4: ドッキング時のCSSを追加する

`src/ui/styles.css`へ次の責務を追加する。

```css
.detailAiJobMonitorDock {
  display: flex;
  align-items: center;
}

.aiJobMonitorButton.isDocked {
  position: relative;
  right: auto;
  bottom: auto;
  width: 36px;
  min-height: 34px;
  padding: 4px;
  border-radius: var(--r-sm);
  box-shadow: none;
}

.aiJobMonitorButton.isDocked .aiJobMonitorButtonLabel {
  display: none;
}
```

数値は既存の詳細ヘッダーボタンと揃えて微調整してよい。次を満たすことを優先する。

- クリック領域は最低34 × 34px。可能なら36 × 36px。
- 閉じるボタン、拡大ボタン、タイトルと重ならない。
- active spinner、badge、alertがボタン外へ過度にはみ出さない。
- `@media (max-width: 820px)`の`[aria-expanded="true"]`非表示と競合しない。
- `prefers-reduced-motion`の既存仕様を維持する。

### Task 5: ブラウザ幾何テストを行う

テスト用案件または保存を実行しない既存データで、次の矩形を取得する。

```js
const job = document.querySelector("#aiJobMonitorButton").getBoundingClientRect();
const save = document.querySelector('.strategyInlineEdit button[type="submit"]').getBoundingClientRect();
const overlapWidth = Math.max(0, Math.min(job.right, save.right) - Math.max(job.left, save.left));
const overlapHeight = Math.max(0, Math.min(job.bottom, save.bottom) - Math.max(job.top, save.top));
```

合格条件:

```text
overlapWidth * overlapHeight === 0
```

さらに、保存ボタン中央が保存ボタン自身またはその子要素を返すことを確認する。

```js
const x = (save.left + save.right) / 2;
const y = (save.top + save.bottom) / 2;
document.elementFromPoint(x, y).closest('button[type="submit"]')
```

## 9. Responsive behavior

### 9.1 1181px以上

- 詳細ドロワーは可変幅の右drawer。
- AIジョブボタンはdrawer headerへドッキングする。
- ドロワー幅300px、既定420px、最大`window.innerWidth - 120px`の全ケースで右下に残らない。

### 9.2 1180px以下

- `.detailPane { min-width: 100%; }`により全幅表示になる。
- AIジョブボタンは同じheader actions内に残る。
- viewport外へ左移動する方式を使わない。

### 9.3 820px以下

- AIジョブボタンからパネルを開いた後は、既存仕様どおりボタンを隠し、bottom sheetを表示する。
- bottom sheetを閉じると、コンパクトボタンが詳細ヘッダーへ戻る。
- 詳細ヘッダーの閉じる操作とAIジョブ操作をキーボードで区別できる。

## 10. Accessibility

- アイコンだけのドッキング状態でもaccessible nameを「AIジョブ」にする。
- `aria-controls="aiJobMonitorPanel"`を維持する。
- `aria-expanded`は既存の開閉処理で更新する。
- ドッキング・ホーム復帰だけでfocusを奪わない。
- focus中に同じ配置先へ再appendしない。
- Tab順は「AIジョブ → 拡大（表示対象のみ）→ 詳細を閉じる」を基本とする。
- Enter / SpaceでAIジョブパネルを開ける。
- Escによる既存のパネルcloseを維持する。

## 11. Acceptance criteria

### 必須

- 詳細ドロワーを閉じると、AIジョブボタンが従来どおり右20px・下20pxへ表示される。
- 詳細ドロワーを開くと、同じAIジョブボタンが詳細ヘッダーへ移動する。
- 詳細表示中、viewport右下にAIジョブボタンが残らない。
- 戦略編集を最下部まで表示しても、「変更を保存」とAIジョブボタンの交差面積が0である。
- 保存ボタン中央のヒットテストがAIジョブボタンを返さない。
- 詳細ペインの横幅を300px、420px、最大幅へ変更しても競合しない。
- 1280 × 720、1180 × 720、820 × 720、390 × 844で競合しない。
- AIジョブボタンはHTML上に1つだけである。
- AIジョブ件数、active spinner、警告dotがホーム状態とドッキング状態で一致する。
- ドッキング状態からAIジョブパネルを開閉できる。
- 詳細を閉じた後もAIジョブボタンのclick listenerが1回だけ動作する。
- 画面切替・案件切替・pollingでボタンが消えたり複製されたりしない。
- 詳細ドロワー内のスクロール位置と編集内容を、AIジョブボタンの配置同期だけで失わない。

### 非回帰

- `GET /api/ai-jobs`のリクエスト回数とpoll間隔が変わらない。
- ETag / 304処理が変わらない。
- AIジョブの自動open、ユーザー最小化、完了通知が変わらない。
- 戦略保存のpayloadとAPIが変わらない。
- バナー、リサーチ、テンプレ、WHO-WHATのAI処理を変更しない。
- console errorが0件である。
- 全Node testが成功する。

## 12. Verification commands

### 12.1 変更前

```bash
git status --short
git log -1 --oneline
```

既存のユーザー変更を確認し、本修正以外を上書きしない。

### 12.2 構文

```bash
node --check src/ui/app.js
node --check src/ui/ai-job-monitor.js
```

### 12.3 対象テスト

```bash
node --test --test-concurrency=1 tests/ai-job-monitor-ui.test.js
```

### 12.4 AIジョブ非回帰

```bash
node --test --test-concurrency=1 \
  tests/ai-job-view.test.js \
  tests/ai-job-source-cache.test.js \
  tests/runtime-ai-job-registry.test.js \
  tests/ai-jobs-api.test.js \
  tests/ai-job-monitor-ui.test.js \
  tests/ai-job-performance.test.js
```

### 12.5 全体

```bash
node --test --test-concurrency=1
git diff --check
```

### 12.6 ブラウザ

```bash
npm run dev
```

確認対象:

1. `http://localhost:5173/`を開く。
2. 「戦略」→戦略行選択→「編集」。
3. 「変更を保存」までスクロールする。
4. 交差面積0と中央ヒットテストを確認する。
5. 詳細ドロワーを閉じ、AIジョブボタンが右下へ戻ることを確認する。
6. 再度詳細を開き、ドッキング状態からAIジョブを開閉する。
7. ドロワー幅を最小・既定・最大へ変える。
8. 1180px、820px、390pxでも確認する。
9. console errorが0件であることを確認する。

AI処理を実行する必要はない。件数バッジの見た目を確認する場合は既存の安全なfixtureを使い、OpenAI / Anthropic / gpt-image-2を呼ばない。

## 13. Self-review

### Round 1: 原因と責務

確認:

- 保存ボタンのCSSだけを直す案になっていないか。
- z-indexだけでAIジョブを隠す案になっていないか。
- 詳細ドロワーとグローバル導線の競合として扱っているか。

結果:

- 局所修正では再発するため不採用。
- 配置責務をAIジョブ側へ寄せる方針に統一した。

### Round 2: 状態二重化

確認:

- ヘッダー用の2個目のAIジョブボタンを作っていないか。
- badge、alert、`aria-expanded`、listenerが二重化しないか。

結果:

- 同じDOM nodeをreparentする方式に変更。
- panel本体はbody直下に残し、clippingを避けた。

### Round 3: 可変幅・responsive

確認:

- `--detail-width`へ追従する左移動案は最大幅で画面外へ出ないか。
- 1180px以下の全幅detail paneで成立するか。
- 820px以下のbottom sheetと競合しないか。

結果:

- viewport座標へ逃がす案を不採用。
- drawer headerの通常フローに置くため、幅計算への依存を除いた。

### Round 4: focus・再描画

確認:

- `renderInspector()`やpollingのたびに再appendしてfocusを失わないか。
- ラベルを視覚的に隠したときaccessible nameが消えないか。

結果:

- 親が変わる場合だけDOMを移動する条件を必須化。
- `aria-label`と`title`を明示する仕様を追加。

### Round 5: スコープと検証

確認:

- AIジョブAPI、戦略保存、バナー生成へ不要な変更が広がっていないか。
- 「見た目が直った」だけで完了判定していないか。

結果:

- 必須変更をUI 4ファイルへ限定。
- 交差面積、中央ヒットテスト、4 viewport、3 drawer幅、対象test、全testを完了ゲートにした。

### 最終スコア

| 観点 | スコア | 根拠 |
| --- | ---: | --- |
| 原因特定 | 10 / 10 | DOM矩形、z-index、ヒットテストで確認 |
| 解決の一般性 | 9 / 10 | 全詳細CTAへ効き、幅計算へ依存しない |
| 状態の安全性 | 10 / 10 | 単一DOM、単一listener、単一badgeを維持 |
| responsive | 9 / 10 | desktop/full-width/mobileを受け入れ基準化 |
| accessibility | 9 / 10 | name、expanded、controls、focus条件を定義 |
| 回帰防止 | 9 / 10 | 静的test、矩形test、対象test、全testを定義 |
| スコープ管理 | 10 / 10 | backend、保存契約、AI経路を対象外に固定 |

**設計レビュー時点の総合: 9.4 / 10。実装開始を妨げる未解決事項なし。**

残る注意点は、デスクトップでAIジョブパネルを明示的に開いた間はパネル本体が編集面へ重なり得ることである。これはユーザー操作で開閉できる一時表示であり、閉じたFABが保存を常時ブロックする今回の不具合とは分離する。将来、複数のグローバルフローティングUIが増えた場合は、overlay layer policyを別タスクで共通化する。

## 14. Completion definition

次をすべて満たした時点で完了とする。

1. RED testを先に追加した。
2. 単一AIジョブボタンのhome/dock切替を実装した。
3. 詳細表示中の右下固定AIジョブボタンがなくなった。
4. 交差面積0と中央ヒットテストを確認した。
5. 4 viewportと3 drawer幅を確認した。
6. 対象testと全testが成功した。
7. console errorが0件だった。
8. `git diff --check`が成功した。
9. `implementation-self-review-loop`のしきい値を満たした。
10. 検証で案件データや有料AI APIを変更・実行していない。

## 15. 実装・レビュー結果

### 15.1 実装差分

- `src/ui/ai-job-monitor.js`: 同一ボタンをhome / dockへ移す`placeAiJobMonitorButton()`を追加。親が同一なら再appendしない。
- `src/ui/app.js`: 初期化時と`renderInspector()`の詳細開閉直後に配置を同期。
- `src/ui/index.html`: home配置先、detail dock、accessible name、視覚ラベルclassを追加。ボタンとpanelは各1つのまま維持。
- `src/ui/styles.css`: ドッキング時だけ36 × 36pxの通常フローへ変更し、fixed座標とshadowを解除。
- `tests/ai-job-monitor-ui.test.js`: 配置helper、DOM単一性、呼び出し接続、compact CSS、非表示badge/alertの回帰テストを追加。

### 15.2 TDD結果

1. 配置helperとhome / dock接続を要求するテストを先に追加し、未実装の2件が失敗することを確認した。
2. 最小実装後、対象7テストが成功した。
3. ブラウザレビューで、詳細ヘッダーの汎用`span { display: block; }`が`hidden`中のbadge / alertを再表示する副作用を発見した。
4. `.detailPaneHeader .aiJobMonitorButton [hidden]`を要求するRED testを追加し、失敗を確認してからCSSを修正した。
5. 修正後、badge / alertは`hidden=true`かつ`display:none`になることを実ブラウザで確認した。

### 15.3 自動検証

| 検証 | 結果 |
| --- | --- |
| 指定9ファイルの`node --check` | 成功 |
| AIジョブ関連テスト | 26 / 26 成功 |
| 全Node test | 458 / 458 成功 |
| `git diff --check` | 成功 |

AIジョブ関連テストでは、read-only API、ETag / 304、source cache、runtime registry、polling UI、性能基準を含めて非回帰を確認した。

### 15.4 ブラウザ実測

戦略「無料で使えるバナー制作AI」の編集画面を使い、保存は実行せず、矩形とヒットテストだけを確認した。

| viewport | AIジョブ親要素 | 保存との交差面積 | 保存中央の最前面 |
| --- | --- | ---: | --- |
| 1280 × 720 | `#detailAiJobMonitorDock` | 0px² | 変更を保存 |
| 1180 × 720 | `#detailAiJobMonitorDock` | 0px² | 変更を保存 |
| 820 × 720 | `#detailAiJobMonitorDock` | 0px² | 変更を保存 |
| 390 × 844 | `#detailAiJobMonitorDock` | 0px² | 変更を保存 |

1280 × 720では詳細幅300px、420px、1160pxも個別に確認し、すべて交差面積0px²、保存中央の最前面は「変更を保存」だった。

追加確認:

- 詳細表示中のAIジョブボタンは1個、`position: relative`、36 × 36px、ヘッダー内に収まる。
- ドッキング状態からpanelを開閉でき、`aria-expanded`は`false → true → false`と同期する。
- panelを閉じてもボタンはdetail dockへ戻る。
- 詳細を閉じると同じボタンが`#aiJobMonitorButtonHome`へ戻り、`position: fixed; right: 20px; bottom: 20px`になる。
- console errorは0件。
- 案件データの保存、有料AI API、画像生成は実行していない。

### 15.5 最終セルフレビュー

| 観点 | スコア | 根拠 |
| --- | ---: | --- |
| 要件適合 | 9.7 / 10 | 単一ボタン、常時競合解消、AIジョブ利用継続を実測 |
| 正しさ | 9.6 / 10 | RED → GREEN、4 viewport・3詳細幅・panel開閉を確認 |
| 回帰安全性 | 9.6 / 10 | 26関連テストと458全体テストが成功、backend変更なし |
| UX・accessibility | 9.4 / 10 | accessible name、controls、expanded、クリック領域を維持 |
| 保守性 | 9.4 / 10 | 配置helperを分離し、状態やlistenerを二重化していない |

**最終総合: 9.5 / 10。完了しきい値8.5を満たし、ブロッカーなし。**

セルフレビューで見つかった非表示badge / alertのCSS競合は修正済み。残存する既知の注意点は、ユーザーがAIジョブpanelを明示的に開いた間だけpanel本体が編集面へ重なることであり、既存の閉じる操作を持つ一時表示として今回の要件どおり維持した。

### 15.6 外部レビュー実施可否

Claude CLI 2.1.205でReview Boardの30秒スモークテストを実行したが、`401 Invalid authentication credentials`で認証に失敗した。規定に従い再試行せず、correctness / requirements / verificationの外部3役レビューはスキップした。代わりに上記の厳格セルフレビュー、全体テスト、実ブラウザ幾何検証を完了した。

### 15.7 Completion definition判定

第14章の10項目はすべて達成した。本修正は完了とする。
