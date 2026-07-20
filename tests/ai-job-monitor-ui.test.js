import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as aiJobMonitor from "../src/ui/ai-job-monitor.js";

const {
  aiJobStatusPresentation,
  buildAiJobViewModel,
  collectAiJobTerminalTransitions,
  fetchAiJobSnapshot,
  isAiJobSnapshotCurrent,
  pollDelayForAiJobs
} = aiJobMonitor;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("status別表示・active件数・3工程・indeterminate・空状態をview model化する", () => {
  assert.equal(aiJobStatusPresentation("failed").tone, "danger");
  assert.equal(aiJobStatusPresentation("stale").label, "中断の可能性");
  const snapshot = {
    activeCount: 1,
    jobs: [{
      id: "b1",
      status: "running",
      title: "バナー",
      statusLabel: "画像生成中",
      stage: { key: "image", label: "画像生成", determinate: true },
      steps: [
        { key: "copyplan", label: "コピー設計", status: "completed" },
        { key: "prompt", label: "プロンプト作成", status: "completed" },
        { key: "image", label: "画像生成", status: "running" }
      ]
    }]
  };
  const model = buildAiJobViewModel(snapshot);
  assert.equal(model.activeCount, 1);
  assert.equal(model.activeJobs.length, 1);
  assert.equal(model.recentJobs.length, 0);
  assert.equal(model.jobs[0].steps.length, 3);
  assert.equal(model.jobs[0].indeterminate, false);
  assert.equal(buildAiJobViewModel({ activeCount: 0, jobs: [] }).empty, true);
});

test("初回は過去完了を通知せず、同一終端を重複通知しない", () => {
  const terminal = { id: "job_1", status: "completed", title: "事実抽出" };
  assert.deepEqual(collectAiJobTerminalTransitions([], [terminal], { initialized: false, notifiedIds: new Set() }), []);
  const notifiedIds = new Set();
  const transitions = collectAiJobTerminalTransitions(
    [{ id: "job_1", status: "running" }],
    [terminal],
    { initialized: true, notifiedIds }
  );
  assert.equal(transitions.length, 1);
  assert.equal(collectAiJobTerminalTransitions([terminal], [terminal], { initialized: true, notifiedIds }).length, 0);
});

test("案件切替後の古いレスポンスを捨て、表示状態に応じてpoll間隔を変える", () => {
  assert.equal(isAiJobSnapshotCurrent({ requestGeneration: 2, currentGeneration: 3, requestProject: "a", currentProject: "a" }), false);
  assert.equal(isAiJobSnapshotCurrent({ requestGeneration: 3, currentGeneration: 3, requestProject: "a", currentProject: "b" }), false);
  assert.equal(isAiJobSnapshotCurrent({ requestGeneration: 3, currentGeneration: 3, requestProject: "a", currentProject: "a" }), true);
  assert.equal(pollDelayForAiJobs({ hidden: false, panelOpen: false, activeCount: 1 }), 3000);
  assert.equal(pollDelayForAiJobs({ hidden: false, panelOpen: true, activeCount: 0 }), 5000);
  assert.equal(pollDelayForAiJobs({ hidden: false, panelOpen: false, activeCount: 0 }), 10000);
  assert.equal(pollDelayForAiJobs({ hidden: true, panelOpen: true, activeCount: 2 }), 30000);
});

test("専用fetchは200 JSON、304 bodyなし、500 JSON、AbortErrorを区別する", async () => {
  const ok = await fetchAiJobSnapshot(async () => new Response(JSON.stringify({ ok: true, jobs: [] }), { status: 200, headers: { etag: '"v1"' } }), "/api/ai-jobs", {});
  assert.equal(ok.kind, "snapshot");
  assert.equal(ok.etag, '"v1"');
  const unchanged = await fetchAiJobSnapshot(async () => new Response(null, { status: 304, headers: { etag: '"v1"' } }), "/api/ai-jobs", {});
  assert.equal(unchanged.kind, "not_modified");
  const failed = await fetchAiJobSnapshot(async () => new Response(JSON.stringify({ ok: false, message: "取得失敗" }), { status: 500 }), "/api/ai-jobs", {});
  assert.deepEqual({ kind: failed.kind, message: failed.message }, { kind: "error", message: "取得失敗" });
  const aborted = await fetchAiJobSnapshot(async () => { throw new DOMException("aborted", "AbortError"); }, "/api/ai-jobs", {});
  assert.equal(aborted.kind, "aborted");
});

test("詳細ドロワー表示中は単一のAIジョブボタンをヘッダーへドッキングする", () => {
  assert.equal(typeof aiJobMonitor.placeAiJobMonitorButton, "function");
  const home = createPlacementHost("home");
  const dock = createPlacementHost("dock");
  const classes = new Set();
  const button = {
    parentElement: home,
    classList: {
      toggle(name, force) {
        if (force) classes.add(name);
        else classes.delete(name);
      }
    }
  };

  assert.equal(aiJobMonitor.placeAiJobMonitorButton({ button, home, dock, detailOpen: true }), "docked");
  assert.equal(button.parentElement, dock);
  assert.equal(dock.appendCount, 1);
  assert.equal(classes.has("isDocked"), true);

  aiJobMonitor.placeAiJobMonitorButton({ button, home, dock, detailOpen: true });
  assert.equal(dock.appendCount, 1, "同じ配置先では再appendしない");

  assert.equal(aiJobMonitor.placeAiJobMonitorButton({ button, home, dock, detailOpen: false }), "home");
  assert.equal(button.parentElement, home);
  assert.equal(home.appendCount, 1);
  assert.equal(classes.has("isDocked"), false);
});

test("AIジョブボタンのhome・detail dockとcompact表示がUIへ接続される", async () => {
  const [html, app, css] = await Promise.all([
    fs.readFile(path.join(repoRoot, "src", "ui", "index.html"), "utf8"),
    fs.readFile(path.join(repoRoot, "src", "ui", "app.js"), "utf8"),
    fs.readFile(path.join(repoRoot, "src", "ui", "styles.css"), "utf8")
  ]);
  assert.equal((html.match(/id="aiJobMonitorButton"/g) || []).length, 1);
  assert.match(html, /id="aiJobMonitorButtonHome"/);
  assert.match(html, /class="detailPaneHeaderActions">[\s\S]*id="detailAiJobMonitorDock"/);
  assert.match(html, /id="aiJobMonitorButton"[\s\S]*aria-label="AIジョブ"[\s\S]*aria-controls="aiJobMonitorPanel"/);
  assert.match(app, /function syncAiJobMonitorPlacement\(/);
  assert.match(app, /classList\.toggle\("detailOpen", Boolean\(selected\)\);\s*syncAiJobMonitorPlacement\(Boolean\(selected\)\);/);
  assert.match(css, /\.aiJobMonitorButton\.isDocked\s*\{[\s\S]*position:\s*relative;[\s\S]*right:\s*auto;[\s\S]*bottom:\s*auto;/);
  assert.match(css, /\.aiJobMonitorButton\.isDocked\s+\.aiJobMonitorButtonLabel\s*\{\s*display:\s*none;/);
  assert.match(css, /\.detailPaneHeader\s+\.aiJobMonitorButton\s+\[hidden\]\s*\{\s*display:\s*none;/);
});

test("DOM・recursive polling・表現レギュ案件指定・バナー非待機接続が実装される", async () => {
  const [html, app, css] = await Promise.all([
    fs.readFile(path.join(repoRoot, "src", "ui", "index.html"), "utf8"),
    fs.readFile(path.join(repoRoot, "src", "ui", "app.js"), "utf8"),
    fs.readFile(path.join(repoRoot, "src", "ui", "styles.css"), "utf8")
  ]);
  assert.match(html, /id="aiJobMonitorButton"/);
  assert.match(html, /id="aiJobMonitorPanel"/);
  assert.match(html, /aria-controls="aiJobMonitorPanel"/);
  assert.match(app, /function scheduleAiJobPoll/);
  assert.match(app, /setTimeout\(runAiJobPoll/);
  assert.doesNotMatch(app, /aiJobPollTimer\s*=\s*setInterval/);
  assert.match(app, /\/api\/regulations\/extract-text", \{ text, project: project\.path \}/);
  assert.match(app, /void requestAiJobPollSoon\(\)/);
  assert.match(css, /\.aiJobMonitorButton/);
  assert.match(css, /\.aiJobMonitorPanel/);
  assert.match(app, /className = "aiJobErrorToggle"/);
  assert.match(app, /現在実行中のAI処理はありません/);
  assert.match(app, /createAiJobSectionLabel\("最近完了"\)/);
  assert.match(css, /\.aiJobMonitorError\.isExpanded/);
  assert.match(css, /@media \(max-width: 820px\)[\s\S]*\.aiJobMonitorPanel/);
  assert.match(css, /\.aiJobMonitorButton\[aria-expanded="true"\]\s*\{\s*display:\s*none/);
});

function createPlacementHost(name) {
  return {
    name,
    appendCount: 0,
    appendChild(node) {
      this.appendCount += 1;
      node.parentElement = this;
    }
  };
}
