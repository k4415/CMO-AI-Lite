import {
  bannerEditRunButtonLabel,
  buildCompositeEditInstruction,
  buildEditRegionsPayload,
  canAddSelection,
  canRunBannerEditState,
  computeCompositeMaskPixels,
  findOverlappingSelections,
  isSelectionEditable,
  isSelectionRemovable,
  normalizedRectToDisplayRect,
  normalizeDragRect,
  overlapErrorMessage,
  removeSelectionById,
  selectionDisplayNumber
} from "/core/banner-range-edit.js";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

let projects = [];
let projectDetail = null;
let research = emptyResearchWorkspace();
let selected = null;
let selectedCell = null;
const activeExtractions = new Set();
const runningActions = new Set();
const pendingBannerEdits = new Map();
let detailWidth = Number(localStorage.getItem("cmoai:detailWidth") || 420);
let sidebarAutoCollapsed = false;
let lastUiTrigger = null;
let researchWorkflowProgress = null;
const SELECTED_PROJECT_KEY = "cmoai:selectedProject";
const RECENT_PROJECTS_KEY = "cmoai:recentProjects";

function emptyResearchWorkspace() {
  return { products: [], materials: [], facts: [], expressionRules: [], extractionJobs: [], strategies: [], banners: [], adTemplates: [] };
}

// オンボーディングガイド(はじめにカード)。OpenAI設定状況はサーバー確認が
// 必要なため null(未確認)/true/false を保持し、settings取得後に反映する。
const ONBOARDING_DISMISSED_KEY = "cmoai.onboardingDismissed";
let openAiConfigured = null;

const projectSelect = $("#projectSelect");
const sidebarCollapsed = localStorage.getItem("cmoai:sidebarCollapsed") === "1" || window.matchMedia("(max-width: 820px)").matches;
document.querySelector(".appShell")?.classList.toggle("sidebarCollapsed", sidebarCollapsed);
updateSidebarToggle(sidebarCollapsed);

const MATERIAL_STATUS_OPTIONS = ["pending", "extracting", "extracted", "partial_text", "partial_visual", "manual_text", "failed"];
const STRATEGY_STATUS_OPTIONS = ["proposed", "used_in_creative", "archived"];
const BANNER_PRODUCTION_STATUS_OPTIONS = ["not_started", "prompt_queued", "generating", "prompt_generating", "prompt_ready", "sub_item_created", "needs_revision", "revising", "needs_copy_visual_review", "hypothesis_contract_failed", "copy_review_failed", "copy_communication_failed", "template_message_fit_failed", "originality_review_failed", "copy_review_error", "strategy_input_insufficient", "template_not_ready", "completed", "failed"];
const BANNER_SIZE_PRESETS = [
  { value: "1080x1080", label: "正方形 1:1(1080×1080)" },
  { value: "1200x628", label: "横長 1200×628" },
  { value: "1080x1920", label: "縦長 9:16(1080×1920)" },
  { value: "300x250", label: "レクタングル 300×250" }
];

function bannerSizeOptionsHtml(selected = "1080x1080") {
  return BANNER_SIZE_PRESETS.map((preset) =>
    '<option value="' + escapeAttr(preset.value) + '" ' + (preset.value === selected ? "selected" : "") + '>' + escapeHtml(preset.label) + '</option>'
  ).join("");
}

// 「追加して生成」時の同時生成数セレクト(上限5、既定1)。バナー案・台本案の追加モーダルで共用する。
function genCountOptionsHtml(selected = 1) {
  const options = [];
  for (let n = 1; n <= 5; n += 1) {
    options.push('<option value="' + n + '" ' + (n === Number(selected) ? "selected" : "") + '>' + n + '件</option>');
  }
  return options.join("");
}

const IMAGE_STATUS_OPTIONS = ["not_started", "queued", "generating", "completed", "failed"];
const TEMPLATE_STATUS_OPTIONS = ["not_started", "template_generating", "template_ready", "failed"];

// 戦略 view: memory-only filter/toggle state (not persisted).
let strategyProductFilter = "";
let showArchivedStrategies = false;

// 事実DB / 表現レギュレーションDB: テーブル・エディタ表示切替(メモリ内のみ)。
let factsViewMode = "editor";
let rulesViewMode = "editor";
let factsEditorProductId = "";
let rulesEditorProductId = "";
let factsEditorTrackedRows = [];
let factsContentMode = "preview";
let strategyDetailMode = "preview";
// 事実DBの区分は「特徴 → メリット → 実績 → 権威性 → オファー」の5区分固定。
// 初期化(setFactsViewMode)から参照されるため、TDZ回避のためファイル冒頭で定義する。
const FACT_CATEGORY_OPTIONS = ["特徴", "メリット", "実績", "権威性", "オファー"];
// 事実サマリーの目安件数(DESIGN.md 4-11 2026-07-08改訂)。データサマリーパネルの
// カバレッジゲージが「あと何件」を計算する基準値。将来調整できるよう定数で一元管理する。
const FACT_CATEGORY_TARGETS = { "特徴": 3, "メリット": 3, "実績": 2, "権威性": 1, "オファー": 2 };

// Banner cards view: persisted display preferences.
const BANNER_CARD_SIZE_KEY = "cmoai.bannerCardSize";
const BANNER_CARD_TEXT_MODE_KEY = "cmoai.bannerCardTextMode";
const BANNER_VIEW_MODE_KEY = "cmoai.bannerViewMode";
const BANNER_CARD_SIZE_PX = { small: "180px", medium: "240px", large: "320px" };
let bannerCardSize = BANNER_CARD_SIZE_PX[localStorage.getItem(BANNER_CARD_SIZE_KEY)] ? localStorage.getItem(BANNER_CARD_SIZE_KEY) : "medium";
let bannerCardTextMode = localStorage.getItem(BANNER_CARD_TEXT_MODE_KEY) === "1";
const BANNER_VIEW_MODES = ["table", "cards", "compare"];
let bannerViewMode = BANNER_VIEW_MODES.includes(localStorage.getItem(BANNER_VIEW_MODE_KEY)) ? localStorage.getItem(BANNER_VIEW_MODE_KEY) : "cards";
const AD_TEMPLATE_VIEW_MODE_KEY = "cmoai.adTemplateViewMode";
const AD_TEMPLATE_VIEW_MODES = ["table", "gallery"];
let adTemplateViewMode = AD_TEMPLATE_VIEW_MODES.includes(localStorage.getItem(AD_TEMPLATE_VIEW_MODE_KEY))
  ? localStorage.getItem(AD_TEMPLATE_VIEW_MODE_KEY)
  : "gallery";
// 比較モード専用の列サイズ切替(バッチY): カード表示の 小/中/大 とは独立して記憶する。
const BANNER_COMPARE_SIZE_KEY = "cmoai.bannerCompareSize";
const BANNER_COMPARE_SIZE_PX = { standard: "360px", xl: "560px" };
let bannerCompareSize = BANNER_COMPARE_SIZE_PX[localStorage.getItem(BANNER_COMPARE_SIZE_KEY)] ? localStorage.getItem(BANNER_COMPARE_SIZE_KEY) : "standard";
// 比較モード(バッチW): 画像バージョンサムネをクリックした時に「その列のプレビューだけ」
// ローカルで差し替えるための一時状態。PATCH確定するまでは generatedImagePath を書き換えない。
const bannerComparePreview = new Map();

// データサマリーパネル + ビュー切替(DESIGN.md 4-11)。対象は facts/
// strategies/banners の4ビュー。選択(summary|list)はビューごとにlocalStorageへ
// 保存し、既定はsummary。切替はhidden属性の付け替えのみで再描画は行わない。
const SUMMARY_VIEWS = ["facts", "strategies", "banners"];
const summaryViewModes = {};
for (const view of SUMMARY_VIEWS) {
  summaryViewModes[view] = localStorage.getItem("cmoai:viewMode:" + view) === "list" ? "list" : "summary";
}


on("#refreshProjects", "click", refreshAll);
on("#validate", "click", async () => selectItem("validation", await loadProjectDetail(true)));
on("#createProject", "click", createProject);
on("#newProjectProductName", "keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); createProject(); } });
on("#openProjectModal", "click", () => $("#projectModal")?.classList.remove("hidden"));
on("#closeProjectModal", "click", () => $("#projectModal")?.classList.add("hidden"));
on("#openProjectSwitcher", "click", openProjectSwitcher);
on("#closeProjectSwitcher", "click", closeProjectSwitcher);
on("#projectSwitcherModal", "click", (event) => { if (event.target.id === "projectSwitcherModal") closeProjectSwitcher(); });
on("#projectSearch", "input", renderProjectSwitcher);
on("#createProjectFromSwitcher", "click", () => { closeProjectSwitcher(); $("#projectModal")?.classList.remove("hidden"); });
on("#closeDetailModal", "click", closeDetailModal);
on("#detailModal", "click", (event) => { if (event.target.id === "detailModal") closeDetailModal(); });
on("#addBannerAndGenerate", "click", () => addBanner(true));
on("#closeBannerAddModal", "click", closeBannerAddModal);
on("#cancelBannerAdd", "click", closeBannerAddModal);
on("#bannerAddModal", "click", (event) => { if (event.target === $("#bannerAddModal")) closeBannerAddModal(); });
on("#closeBannerEditModal", "click", () => closeBannerEditModal());
on("#cancelBannerEdit", "click", () => closeBannerEditModal());
on("#bannerEditModal", "click", (event) => { if (event.target.id === "bannerEditModal") closeBannerEditModal(); });
on("#bannerEditClear", "click", clearBannerEditSelections);
on("#runBannerEdit", "click", runBannerEditAction);
on("#closeBannerFullEdit", "click", closeBannerFullEditModal);
on("#cancelBannerFullEdit", "click", closeBannerFullEditModal);
on("#runBannerFullEdit", "click", runBannerFullEditAction);
on("#bannerFullEditInstruction", "input", updateBannerFullEditRunButton);
on("#bannerFullEditModal", "click", (event) => { if (event.target.id === "bannerFullEditModal") closeBannerFullEditModal(); });
initBannerEditCanvas();
for (const button of $$(".modalOverlay header button")) {
  if (!button.getAttribute("aria-label")) button.setAttribute("aria-label", "閉じる");
}
document.addEventListener("pointerdown", (event) => {
  lastUiTrigger = event.target.closest("button, a, [tabindex]");
}, true);
const modalFocusObserver = new MutationObserver((records) => {
  for (const record of records) {
    const modal = record.target;
    if (!(modal instanceof HTMLElement) || !modal.classList.contains("modalOverlay")) continue;
    const open = !modal.classList.contains("hidden");
    if (open && modal.dataset.focusOpen !== "1") {
      modal.dataset.focusOpen = "1";
      modal._returnFocus = lastUiTrigger instanceof HTMLElement ? lastUiTrigger : null;
    } else if (!open && modal.dataset.focusOpen === "1") {
      delete modal.dataset.focusOpen;
      const target = modal._returnFocus;
      modal._returnFocus = null;
      if (target?.isConnected && !document.querySelector(".modalOverlay:not(.hidden)")) target.focus();
    }
  }
});
for (const modal of $$(".modalOverlay")) modalFocusObserver.observe(modal, { attributes: true, attributeFilter: ["class"] });
on("#closeDetailPane", "click", () => selectItem(null, null));
on("#expandDetailPane", "click", () => { if (selected) openDetailModal(selected.type, selected.payload); });
document.addEventListener("keydown", (event) => {
  const activeModal = document.querySelector(".modalOverlay:not(.hidden)");
  if (event.key === "Tab" && activeModal) {
    const focusable = [...activeModal.querySelectorAll('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')]
      .filter((item) => item.offsetParent !== null);
    if (focusable.length) {
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    return;
  }
  if (event.key !== "Escape") return;
  // 画像拡大モーダルが開いていれば最優先で閉じる
  const detailModal = $("#detailModal");
  if (detailModal && !detailModal.classList.contains("hidden")) {
    closeDetailModal();
    return;
  }
  const bannerEditModal = $("#bannerEditModal");
  if (bannerEditModal && !bannerEditModal.classList.contains("hidden")) {
    closeBannerEditModal();
    return;
  }
  const bannerFullEditModal = $("#bannerFullEditModal");
  if (bannerFullEditModal && !bannerFullEditModal.classList.contains("hidden")) {
    closeBannerFullEditModal();
    return;
  }
  if (!selected) return;
  if (activeModal || event.target.closest("input, textarea, select")) return;
  selectItem(null, null);
});
on("#addProduct", "click", addProduct);
on("#addFact", "click", addFact);
on("#toggleSidebar", "click", toggleSidebar);
on("#sidebarStatusButton", "click", () => switchView("settings"));
on("#topbarSettingsButton", "click", () => switchView("settings"));
on("#runFactExtraction", "click", runFactExtraction);
on("#openResearchSourceImport", "click", () => toggleResearchSourceImport(true));
on("#closeResearchSourceImport", "click", () => toggleResearchSourceImport(false));
on("#saveResearchSourceAndExtract", "click", saveResearchSourceAndExtract);
on("#exportFactsCsv", "click", exportFactsCsv);
on("#saveFactsEditor", "click", saveFactsEditor);
on("#saveRulesEditor", "click", saveRulesEditor);
on("#importRegulationsFile", "click", () => $("#regulationImportFile")?.click());
on("#regulationImportFile", "change", handleRegulationImportFile);
on("#runWhoWhat", "click", (event) => runWhoWhat(event.currentTarget));
on("#showArchivedStrategies", "change", () => { showArchivedStrategies = Boolean($("#showArchivedStrategies")?.checked); renderStrategies(); });
on("#bannerCardTextModeToggle", "click", toggleBannerCardTextMode);
on("#saveOpenAiSettings", "click", saveOpenAiSettings);
on("#focusBanners", "click", () => switchView("banners"));
on("#clearSelection", "click", () => selectItem(null, null));
initDetailResize();
initTableKeyboard();
document.querySelector(".appShell")?.style.setProperty("--detail-width", `${detailWidth}px`);
projectSelect?.addEventListener("change", () => selectProjectPath(projectSelect.value));

for (const button of $$(".tabButton")) button.addEventListener("click", () => switchView(button.dataset.view));
for (const button of $$(".viewModeButton[data-bannerview]")) button.addEventListener("click", () => setBannerViewMode(button.dataset.bannerview));
for (const button of $$(".viewModeButton[data-adtemplateview]")) button.addEventListener("click", () => setAdTemplateViewMode(button.dataset.adtemplateview));
for (const button of $$(".viewModeButton[data-factsview]")) button.addEventListener("click", () => setFactsViewMode(button.dataset.factsview));
for (const button of $$(".viewModeButton[data-rulesview]")) button.addEventListener("click", () => setRulesViewMode(button.dataset.rulesview));
for (const button of $$(".segmentButton[data-cardsize]")) button.addEventListener("click", () => setBannerCardSize(button.dataset.cardsize));
for (const button of $$(".segmentButton[data-comparesize]")) button.addEventListener("click", () => setBannerCompareSize(button.dataset.comparesize));
applyBannerCardSize();
applyBannerCompareSize();
applyBannerCardTextModeUi();
setBannerViewMode(bannerViewMode);
setFactsViewMode(factsViewMode);
setRulesViewMode(rulesViewMode);
for (const button of $$(`[data-workspace]`)) button.addEventListener("click", () => switchView(button.dataset.workspace));
for (const button of $$('[data-form]')) button.addEventListener("click", () => toggleForm(button.dataset.form));
document.addEventListener("click", handleGlobalUiClick);
document.addEventListener("change", handleGlobalUiChange);

for (const button of $$(".viewToggleItem[data-summary-view]")) {
  button.addEventListener("click", () => setSummaryViewMode(button.dataset.summaryView, button.dataset.summaryMode));
}
for (const button of $$('[data-facts-content-mode]')) {
  button.addEventListener("click", () => setFactsContentMode(button.dataset.factsContentMode));
}
on("#factsEditorTextarea", "input", trackFactsEditorRows);
for (const view of SUMMARY_VIEWS) applySummaryViewMode(view);
document.addEventListener("click", (event) => {
  const trigger = event.target.closest("[data-summary-action]");
  if (!trigger) return;
  const action = trigger.dataset.summaryAction;
  if (action === "runFactExtraction") $("#runFactExtraction")?.click();
  else if (action === "runWhoWhat") runWhoWhat(trigger);  else if (action === "openBannerAddModal") { switchView("banners"); openBannerAddModal(); }
});

if (projectSelect) refreshAll(); else console.error("CMOAI UI initialization failed: #projectSelect is missing.");

async function refreshAll() {
  try {
    await loadProjects();
    await refreshProjectData();
    await loadOpenAiSettings();
    writeTerminal("system", "\u30ef\u30fc\u30af\u30b9\u30da\u30fc\u30b9\u3092\u8aad\u307f\u8fbc\u307f\u307e\u3057\u305f\u3002");
  } catch (error) {
    writeTerminal("error", `\u8aad\u307f\u8fbc\u307f\u306b\u5931\u6557\u3057\u307e\u3057\u305f: ${error.message}`);
  }
}

async function loadProjects() {
  const data = await get("/api/projects");
  if (!data.ok) throw new Error(data.message || "\u6848\u4ef6API\u3092\u5229\u7528\u3067\u304d\u307e\u305b\u3093");
  const previousPath = projectSelect.value || localStorage.getItem(SELECTED_PROJECT_KEY) || "";
  projects = data.projects || [];
  projectSelect.innerHTML = "";
  const selectable = projects.filter((project) => !project.isTemplate && project.status !== "archived");
  for (const project of selectable) {
    const option = document.createElement("option");
    option.value = project.path;
    option.textContent = projectLabel(project);
    option.title = projectLabel(project);
    projectSelect.appendChild(option);
  }
  const selectedPath = selectable.some((project) => project.path === previousPath)
    ? previousPath
    : (selectable[0]?.path || "");
  if (selectedPath) projectSelect.value = selectedPath;
  if (selectedPath) localStorage.setItem(SELECTED_PROJECT_KEY, selectedPath);
  else localStorage.removeItem(SELECTED_PROJECT_KEY);
  if (selectedPath) rememberProjectPath(selectedPath);
  renderProjectSwitcher();
}

async function refreshProjectData() {
  renderSelectedProject();
  // 案件切替・初回読込で loadResearch() が走る間だけスケルトンを見せる。
  // 150ms以内に完了した場合はタイマーを止めて出さない(ちらつき防止)。
  const skeletonTimer = setTimeout(showResearchSkeleton, 150);
  try {
    await Promise.all([loadProjectDetail(false), loadResearch()]);
  } finally {
    clearTimeout(skeletonTimer);
  }
  renderResearch();
  if (selected) {
    refreshSelectedPayload();
    renderInspector();
  }
  if (hasActiveWork()) ensureLiveRefresh();
}

// スケルトンローディング(バッチV)。主要テーブルのtbodyとホームのパイプライン
// カードを、slate-100の角丸バー+subtleなpulseに差し替える。renderResearch()
// が呼ばれると各render系がtbody/カードを通常描画で上書きする。
const SKELETON_TABLE_IDS = [
  "products", "facts", "expressionRules",
  "strategies", "banners", "adTemplates"
];

function showResearchSkeleton() {
  for (const id of SKELETON_TABLE_IDS) {
    renderSkeletonRows(document.getElementById(id));
  }
  renderHomeSkeleton();
  // 「次にやること」と「最近の生成物」も旧案件の内容が残らないようにクリアする
  const nextAction = $("#homeNextAction");
  if (nextAction) nextAction.innerHTML = '<span class="skeletonBar" style="width:60%;height:16px"></span>';
  const recent = $("#homeRecentSection");
  if (recent) recent.hidden = true;
}

function renderSkeletonRows(tbody, colspan, rows = 3) {
  if (!tbody) return;
  const cols = colspan || tbody.closest("table")?.querySelectorAll("thead th").length || 1;
  const widths = [88, 72, 56];
  const rowsHtml = [];
  for (let i = 0; i < rows; i++) {
    rowsHtml.push(
      '<tr class="skeletonRow" aria-hidden="true"><td colspan="' + cols + '">'
      + '<span class="skeletonBar" style="width:' + widths[i % widths.length] + '%"></span>'
      + '</td></tr>'
    );
  }
  tbody.innerHTML = rowsHtml.join("");
}

function renderHomeSkeleton() {
  const pipeline = $("#homePipeline");
  if (!pipeline) return;
  pipeline.innerHTML = ["01", "02", "03"].map(homePipelineSkeletonCard).join("");
}

function homePipelineSkeletonCard(kicker) {
  const stat = '<div class="homeStat"><span class="skeletonBar skeletonBarValue"></span><span class="skeletonBar skeletonBarLabel"></span></div>';
  return '<div class="homePipelineCard homePipelineCardSkeleton" aria-hidden="true">'
    + '<div class="homePipelineCardHeader"><span class="skeletonBar skeletonBarKicker"></span><span class="skeletonBar skeletonBarTitle"></span></div>'
    + '<div class="homePipelineCardStats">' + stat + stat + stat + '</div>'
    + '</div>';
}

async function loadProjectDetail(showResult) {
  const project = selectedProject();
  if (!project) {
    projectDetail = null;
    return { ok: false, message: "\u6848\u4ef6\u304c\u9078\u629e\u3055\u308c\u3066\u3044\u307e\u305b\u3093" };
  }
  projectDetail = await get(`/api/project/detail?project=${encodeURIComponent(project.path)}`);
  updateProjectMeta();
  if (showResult) writeTerminal("validation", JSON.stringify(projectDetail, null, 2));
  return projectDetail;
}

async function loadResearch() {
  const project = selectedProject();
  if (!project) {
    research = emptyResearchWorkspace();
    return;
  }
  const data = await get(`/api/research?project=${encodeURIComponent(project.path)}`);
  if (!data.ok) throw new Error(data.message || "リサーチAPIを利用できません");
  research = data.workspace;
}

async function loadOpenAiSettings() {
  const status = $("#openAiStatus");
  const data = await get("/api/settings/openai").catch(() => null);
  if (status) status.textContent = data?.ok ? (data.settings.configured ? "\u8a2d\u5b9a\u6e08\u307f: " + data.settings.maskedKey : "\u672a\u8a2d\u5b9a") : "\u672a\u78ba\u8a8d";
  openAiConfigured = data?.ok ? Boolean(data.settings.configured) : null;
  updateSidebarStatusCard(openAiConfigured);
  renderOnboardingCard();
}

function updateSidebarStatusCard(configured) {
  const dot = $("#sidebarStatusDot");
  const text = $("#sidebarStatusText");
  if (!dot || !text) return;
  dot.classList.toggle("isOnline", Boolean(configured));
  text.textContent = configured === null ? "\u672a\u78ba\u8a8d" : configured ? "OpenAI\u63a5\u7d9a\u6e08\u307f" : "API\u30ad\u30fc\u672a\u8a2d\u5b9a";
}

function projectInitials(name) {
  const trimmed = (name || "").trim();
  if (!trimmed) return "?";
  return Array.from(trimmed).slice(0, 2).join("").toUpperCase();
}

function renderSelectedProject() {
  const project = selectedProject();
  const label = project ? projectLabel(project) : "案件が選択されていません";
  $("#selectedProjectLabel").textContent = label;
  const name = $("#projectSwitchName");
  const product = $("#projectSwitchProduct");
  const avatar = $("#projectSwitchAvatar");
  const button = $("#openProjectSwitcher");
  if (name) name.textContent = project ? project.name : "案件未選択";
  if (product) product.textContent = project ? (project.productName || "商品情報なし") : "案件を選択してください";
  if (avatar) avatar.textContent = project ? projectInitials(project.name) : "?";
  if (button) {
    button.title = project ? label : "案件を選択";
    button.classList.toggle("empty", !project);
  }
}

function updateProjectMeta() {
  renderSelectedProject();
  const meta = $("#projectMeta");
  if (meta) meta.textContent = "";
}

function openProjectSwitcher() {
  renderProjectSwitcher();
  $("#projectSwitcherModal")?.classList.remove("hidden");
  setTimeout(() => $("#projectSearch")?.focus(), 0);
}

function closeProjectSwitcher() {
  $("#projectSwitcherModal")?.classList.add("hidden");
  const search = $("#projectSearch");
  if (search) search.value = "";
}

function renderProjectSwitcher() {
  const allTarget = $("#allProjectsList");
  const archivedTarget = $("#archivedProjectsList");
  const archivedSection = $("#archivedProjectsSection");
  const archivedCount = $("#archivedProjectsCount");
  if (!allTarget || !archivedTarget) return;
  const query = ($("#projectSearch")?.value || "").trim().toLowerCase();
  const matchingProjects = projects
    .filter((project) => !project.isTemplate)
    .filter((project) => projectSearchText(project).includes(query));
  const visibleProjects = matchingProjects.filter((project) => project.status !== "archived");
  const archivedProjects = matchingProjects.filter((project) => project.status === "archived");
  allTarget.innerHTML = visibleProjects.length
    ? visibleProjects.map((project) => projectSwitcherRowHtml(project, false)).join("")
    : `<div class="projectListEmpty">該当する案件がありません。</div>`;
  archivedTarget.innerHTML = archivedProjects.length
    ? archivedProjects.map((project) => projectSwitcherRowHtml(project, true)).join("")
    : '<div class="projectListEmpty">アーカイブ済みの案件はありません。</div>';
  if (archivedCount) archivedCount.textContent = String(projects.filter((project) => !project.isTemplate && project.status === "archived").length);
  if (archivedSection) archivedSection.hidden = !projects.some((project) => !project.isTemplate && project.status === "archived");
  bindProjectSwitcherRows(allTarget);
  bindProjectSwitcherRows(archivedTarget);
}

function bindProjectSwitcherRows(root) {
  for (const button of root.querySelectorAll("[data-project-path]")) {
    button.addEventListener("click", () => selectProjectPath(button.dataset.projectPath));
  }
  for (const button of root.querySelectorAll("[data-project-status]")) {
    button.addEventListener("click", () => changeProjectStatus(button.dataset.projectStatusPath, button.dataset.projectStatus));
  }
}

function projectSwitcherRowHtml(project, archived) {
  const active = selectedProject()?.path === project.path;
  const updated = project.updatedAt ? formatDateTime(project.updatedAt) : "更新日なし";
  const mainContent = `
      <span class="projectListName">${escapeHtml(project.name || "案件")}</span>
      <span class="projectListProduct">${escapeHtml(project.productName || "商品情報なし")}</span>
      <span class="projectListMeta">${escapeHtml(updated)}</span>`;
  const main = archived
    ? '<div class="projectListItem projectListItemArchived">' + mainContent + '</div>'
    : '<button class="projectListItem' + (active ? ' active' : '') + '" type="button" data-project-path="' + escapeAttr(project.path) + '">' + mainContent + '</button>';
  const actionLabel = archived ? "復元" : "アーカイブ";
  const nextStatus = archived ? "draft" : "archived";
  return '<div class="projectListRow">' + main
    + '<button class="projectStatusButton' + (archived ? ' restore' : '') + '" type="button" data-project-status-path="' + escapeAttr(project.path) + '" data-project-status="' + nextStatus + '" title="' + actionLabel + '">' + actionLabel + '</button>'
    + '</div>';
}

async function changeProjectStatus(projectPath, status) {
  const project = projects.find((item) => item.path === projectPath);
  if (!project) return;
  const archiving = status === "archived";
  if (archiving && !confirm(`「${project.name}」をアーカイブしますか？\n案件データは削除されず、あとで復元できます。`)) return;
  const data = await requestJson("/api/projects/status", { method: "PATCH", body: { project: projectPath, status } });
  if (!data.ok) return showToast("error", data.message || "案件ステータスを更新できませんでした。");
  if (archiving) {
    const recent = readRecentProjectPaths().filter((path) => path !== projectPath);
    localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(recent));
  }
  await loadProjects();
  selected = null;
  selectedCell = null;
  await refreshProjectData();
  renderProjectSwitcher();
  showToast("success", archiving ? "案件をアーカイブしました。" : "案件を復元しました。");
}

async function selectProjectPath(projectPath, options = {}) {
  if (!projectPath || projectSelect.value === projectPath && options.refresh === false) {
    localStorage.setItem(SELECTED_PROJECT_KEY, projectPath || "");
    rememberProjectPath(projectPath);
    renderSelectedProject();
    renderProjectSwitcher();
    return;
  }
  projectSelect.value = projectPath;
  localStorage.setItem(SELECTED_PROJECT_KEY, projectPath);
  rememberProjectPath(projectPath);
  selected = null;
  selectedCell = null;
  if (options.closeSwitcher !== false) closeProjectSwitcher();
  if (options.refresh !== false) await refreshProjectData();
  renderProjectSwitcher();
}

function readRecentProjectPaths() {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_PROJECTS_KEY) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function rememberProjectPath(projectPath) {
  if (!projectPath) return;
  const project = projects.find((item) => item.path === projectPath);
  if (project?.isTemplate) return;
  const next = [projectPath, ...readRecentProjectPaths().filter((item) => item !== projectPath)].slice(0, 8);
  localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(next));
}

function projectSearchText(project) {
  return [project.name, project.productName, project.status, project.path].filter(Boolean).join(" ").toLowerCase();
}

function renderResearch() {
  renderHome();
  renderProductOptions();
  renderStrategyProductFilter();
  renderProducts();
  renderProductImages();
  renderFacts();
  renderExpressionRules();
  renderStrategies();
  renderBanners();
  renderBannerCards();
  renderBannerCompare();
  renderAdTemplates();
  renderFactsSummary();
  renderStrategiesSummary();
  renderBannersSummary();
  bindInlineControls(document);
  bindEditableCells(document);
  renderViewStats();
  syncWhoWhatButtons();
}

// ==========================================================================
// データサマリーパネル + ビュー切替(DESIGN.md 4-11)
// 対象: facts / strategies / banners。チャートは外部ライブラリを
// 使わず conic-gradient(ドーナツ)+ CSSバー(幅%)のみで描画する。
// ==========================================================================

function setSummaryViewMode(view, mode) {
  const normalized = mode === "list" ? "list" : "summary";
  summaryViewModes[view] = normalized;
  localStorage.setItem("cmoai:viewMode:" + view, normalized);
  applySummaryViewMode(view);
}

function applySummaryViewMode(view) {
  const mode = summaryViewModes[view] || "summary";
  const panel = $("#" + view + "Summary");
  if (panel) panel.hidden = mode !== "summary";
  if (view === "facts") {
    const table = $("#factsTableWrap");
    const editor = $("#factsEditorPanel");
    if (table) table.hidden = mode !== "list";
    if (editor) editor.hidden = mode === "list";
  }
  for (const button of $$('.viewToggleItem[data-summary-view="' + view + '"]')) {
    button.classList.toggle("active", button.dataset.summaryMode === mode);
  }
}

const SUMMARY_WARNING_ICON = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 9v4"/><circle cx="12" cy="16.5" r=".6" fill="currentColor" stroke="none"/><path d="M10.3 4.5 2.6 18a1.6 1.6 0 0 0 1.4 2.4h16a1.6 1.6 0 0 0 1.4-2.4L13.7 4.5a1.6 1.6 0 0 0-2.8 0z"/></svg>';
const SUMMARY_SUCCESS_ICON = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.5 2.5L16 9.5"/></svg>';
const CHECKLIST_DONE_ICON = '<svg class="checklistIcon checklistIconDone" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.5 2.5L16 9.5"/></svg>';
const CHECKLIST_TODO_ICON = '<svg class="checklistIcon checklistIconTodo" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/></svg>';
const CHECKLIST_WARN_ICON = '<svg class="checklistIcon checklistIconWarn" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 9v4"/><circle cx="12" cy="16.5" r=".6" fill="currentColor" stroke="none"/><path d="M10.3 4.5 2.6 18a1.6 1.6 0 0 0 1.4 2.4h16a1.6 1.6 0 0 0 1.4-2.4L13.7 4.5a1.6 1.6 0 0 0-2.8 0z"/></svg>';

// 事実DBの5区分件数。renderViewStats() のfactsチップと同じ集計ロジックを
// ここに一本化して共用する。
function factCategoryCounts() {
  const facts = research.facts || [];
  return FACT_CATEGORY_OPTIONS.map((category) => ({
    category,
    count: facts.filter((item) => mapFactCategory(item.category) === category).length
  }));
}

// チェックリスト行(✓ 達成 / ○ 未達成 / ⚠ 警告)。state: true=達成, false=未達成,
// "warn"=警告。action/actionLabelを渡すと未達成時だけ行内リンクを添える
// (data-summary-action経由でクリックを委譲するため、ここではハンドラを持たない)。
function checklistRowHtml(label, state, opts = {}) {
  const icon = state === true ? CHECKLIST_DONE_ICON : state === "warn" ? CHECKLIST_WARN_ICON : CHECKLIST_TODO_ICON;
  const rowClass = state === "warn" ? "checklistRow checklistRowWarn" : "checklistRow";
  const action = (state !== true && opts.action && opts.actionLabel)
    ? '<button type="button" class="checklistAction" data-summary-action="' + escapeAttr(opts.action) + '">' + escapeHtml(opts.actionLabel) + '</button>'
    : "";
  return '<div class="' + rowClass + '">' + icon + '<span class="checklistLabel">' + escapeHtml(label) + '</span>' + action + '</div>';
}

// 事実サマリー: 目安(FACT_CATEGORY_TARGETS)に対する達成度ゲージ。
// バーは目安到達で満タン(超過分は頭打ち)、達成時はaccent-500・未達成はslate-300。
function factGaugeRowHtml(category, count, targetCount) {
  const achieved = count >= targetCount;
  const pct = targetCount > 0 ? Math.min(100, Math.round((count / targetCount) * 100)) : (count > 0 ? 100 : 0);
  const color = achieved ? "var(--accent-500)" : "var(--slate-300)";
  const countLabel = count + "/" + targetCount + (achieved ? ' <span class="gaugeCheck">✓</span>' : "");
  return '<div class="summaryBarRow"><span class="barLabel">' + escapeHtml(category) + '</span><span class="summaryBarTrack"><span class="summaryBarFill" style="width:' + pct + '%; background:' + color + ';"></span></span><span class="barCount">' + countLabel + '</span></div>';
}

// 戦略別バナー利用数(仮説検証マップ)。0件は「未検証」のグレーラベル。
function hypothesisRowHtml(label, count, completedCount, maxCount) {
  const labelHtml = '<span class="barListLabel" title="' + escapeAttr(label) + '">' + escapeHtml(label) + '</span>';
  if (!count) {
    return '<div class="barListRow">' + labelHtml + '<div class="barListTrack"><span class="barListEmptyLabel">未検証</span></div></div>';
  }
  const pct = maxCount > 0 ? Math.max(6, Math.round((count / maxCount) * 100)) : 6;
  const countLabel = "案" + count + "・完了" + completedCount;
  return '<div class="barListRow">' + labelHtml + '<div class="barListTrack"><div class="barListFill" style="width:' + pct + '%; background:var(--accent-500);">' + escapeHtml(countLabel) + '</div></div></div>';
}

// ホームのパイプライン3カード共通: 実数ベースのミニリング背景(conic-gradient)。
// DESIGN.md 4-11(2026-07-09改訂)。segments は { value, color } の配列で、
// 円周を value の比率で分割する(等分にしたい場合は全segmentのvalueを揃える)。
// gapDeg>0 のときは各セグメントの終端に --surface 色のギャップを挟み、
// 区分同士の独立性を示す(5区分の目安達成リングで使用)。
function ringSegmentsBackground(segments, { gapDeg = 0 } = {}) {
  const total = segments.reduce((sum, seg) => sum + Math.max(0, seg.value), 0);
  if (!total) return "";
  let acc = 0;
  const stops = [];
  for (const seg of segments) {
    const value = Math.max(0, seg.value);
    if (!value) continue;
    const start = (acc / total) * 360;
    acc += value;
    const rawEnd = (acc / total) * 360;
    const end = Math.max(start, rawEnd - gapDeg);
    stops.push(seg.color + " " + start.toFixed(2) + "deg " + end.toFixed(2) + "deg");
    if (gapDeg > 0 && rawEnd > end) stops.push("var(--surface) " + end.toFixed(2) + "deg " + rawEnd.toFixed(2) + "deg");
  }
  return stops.length ? "conic-gradient(" + stops.join(", ") + ")" : "";
}

// 資料サマリー: 件数バーではなく「次にやること」が分かる素材チェックリストに
// する(DESIGN.md 4-11 2026-07-08改訂: 3テストに通らない構成バーは廃止)。
// 事実サマリー: 5区分の目安件数(FACT_CATEGORY_TARGETS)に対する達成度ゲージ。
// 「あと何件」が分かるように、最不足区分(0件優先)の警告+CTAを出す。
// 全区分達成時は警告の代わりに戦略生成への導線に切り替える。
function renderFactsSummary() {
  const target = $("#factsSummary");
  if (!target) return;
  const counts = factCategoryCounts();
  const total = counts.reduce((sum, item) => sum + item.count, 0);
  // 生成中のライブ更新は数秒間隔で renderResearch() を呼ぶ。同じ件数でDOMを
  // 作り直すとバーの登場アニメーションまで再発火するため、表示内容が変わった
  // ときだけ更新する。
  const renderSignature = counts.map((item) => `${item.category}:${item.count}`).join("|");
  if (target.dataset.renderSignature === renderSignature) return;
  target.dataset.renderSignature = renderSignature;
  if (!total) {
    target.innerHTML = '<div class="chartCard chartCardCenter"><p class="chartCardEmpty">事実がまだありません。事実抽出を実行すると5区分に整理されます。</p><button type="button" class="inlineAddButton" data-summary-action="runFactExtraction">事実抽出を実行</button></div>';
    return;
  }
  const rows = counts.map((item) => ({ ...item, targetCount: FACT_CATEGORY_TARGETS[item.category] || 1 }));
  const bars = rows.map((item) => factGaugeRowHtml(item.category, item.count, item.targetCount)).join("");
  const unmet = rows.filter((item) => item.count < item.targetCount);
  let rightCardHtml;
  if (!unmet.length) {
    rightCardHtml = '<div class="chartCard">'
      + '<div class="signalNote signalNoteSuccess">' + SUMMARY_SUCCESS_ICON + '5区分すべて目安に達しています。戦略生成に十分な材料が揃っています。</div>'
      + '<button type="button" class="inlineAddButton" data-summary-action="runWhoWhat" style="width:100%;justify-content:center;margin-top:14px;">戦略生成</button>'
    + '</div>';
  } else {
    const zeroRows = unmet.filter((item) => item.count === 0);
    const pool = zeroRows.length ? zeroRows : unmet;
    const weakest = pool.reduce((worst, item) => ((item.targetCount - item.count) > (worst.targetCount - worst.count) ? item : worst));
    const deficit = weakest.targetCount - weakest.count;
    const noteHtml = weakest.category + 'があと' + deficit + '件で目安に届きます。' + weakest.category + 'の事実を追加すると戦略の説得力が上がります。';
    rightCardHtml = '<div class="chartCard">'
      + '<div class="signalNote">' + SUMMARY_WARNING_ICON + '情報が不足している区分: ' + escapeHtml(weakest.category) + '</div>'
      + '<p style="font-size:12px;color:var(--text-secondary);line-height:1.6;margin:14px 0 14px;">' + escapeHtml(noteHtml) + '</p>'
      + '<button type="button" class="inlineAddButton" data-summary-action="runFactExtraction" style="width:100%;justify-content:center;">事実抽出を実行</button>'
    + '</div>';
  }
  target.innerHTML = '<div class="chartBand">'
    + '<div class="chartCard"><div class="chartCardTitle">区分別カバレッジ(目安達成度)</div><div class="summaryBars">' + bars + '</div></div>'
    + rightCardHtml
  + '</div>';
}

// 戦略サマリー: ステータスドーナツ(3テスト不通過のため廃止)の代わりに、
// 戦略ごとの検証状況(バナー案数)を1枚のカードにまとめた仮説検証マップ。
function renderStrategiesSummary() {
  const target = $("#strategiesSummary");
  if (!target) return;
  const allStrategies = research.strategies || [];
  if (!allStrategies.length) {
    target.innerHTML = '<div class="chartCard chartCardCenter"><p class="chartCardEmpty">戦略がまだありません。</p><button type="button" class="inlineAddButton" data-summary-action="runWhoWhat">戦略生成</button></div>';
    return;
  }
  const strategies = allStrategies.filter((item) => item.status !== "archived");
  if (!strategies.length) {
    target.innerHTML = '<div class="chartCard chartCardCenter"><p class="chartCardEmpty">すべての戦略がアーカイブされています。</p></div>';
    return;
  }
  const banners = research.banners || [];
  const usageMap = new Map();
  const completedMap = new Map();
  for (const banner of banners) {
    if (!banner.strategyId) continue;
    usageMap.set(banner.strategyId, (usageMap.get(banner.strategyId) || 0) + 1);
    if (banner.imageGenerationStatus === "completed") completedMap.set(banner.strategyId, (completedMap.get(banner.strategyId) || 0) + 1);
  }
  const verifiedCount = strategies.filter((item) => item.status === "used_in_creative" || (usageMap.get(item.id) || 0) > 0).length;
  const ranked = strategies
    .map((strategy) => ({ strategy, count: usageMap.get(strategy.id) || 0, completed: completedMap.get(strategy.id) || 0 }))
    .sort((a, b) => b.count - a.count);
  const top = ranked.slice(0, 5);
  const restCount = ranked.length - top.length;
  const maxCount = Math.max(...top.map((item) => item.count), 1);
  const rowsHtml = top.map((item) => hypothesisRowHtml(item.strategy.conceptName || "戦略仮説", item.count, item.completed, maxCount)).join("");
  const moreHtml = restCount > 0 ? '<div class="barListMoreNote">ほか' + restCount + '件</div>' : "";
  target.innerHTML = '<div class="chartCard">'
    + '<div class="chartCardTitleRow"><span class="chartCardTitle" style="margin-bottom:0;">戦略の採用状況</span><span class="chartCardTitleMeta">採用済み ' + verifiedCount + ' / 全 ' + strategies.length + ' 戦略</span></div>'
    + '<div class="barList" style="margin-top:12px;">' + rowsHtml + '</div>'
    + moreHtml
    + '<p class="chartBandCaption">採用した戦略と、各戦略から作成したバナー数を確認できます。</p>'
  + '</div>';
}

// 制作サマリー: 左は生成ファネル(現行維持)、右は「テンプレ利用状況/種別内訳」
// (3テスト不通過)を廃止し、「次に作るべきもの」(未検証の戦略・テンプレ未選択の
// バナー)に置き換える。
function renderBannersSummary() {
  const target = $("#bannersSummary");
  if (!target) return;
  const banners = research.banners || [];
  const hasAnyCreative = Boolean(banners.length);
  if (!hasAnyCreative) {
    target.innerHTML = '<div class="chartCard chartCardCenter"><p class="chartCardEmpty">バナー案を追加すると生成状況が表示されます。</p></div>';
    return;
  }
  const completed = banners.filter((item) => item.imageGenerationStatus === "completed").length;
  const completionPct = banners.length ? Math.round((completed / banners.length) * 100) : 0;
  const incomplete = banners
    .filter((item) => item.imageGenerationStatus !== "completed")
    .map((item) => {
      if (isBannerJobStale(item)) {
        return { item, label: "中断・再開可能", className: "isFailed", priority: 0 };
      }
      if (item.imageGenerationStatus === "failed" || item.productionStatus === "failed") {
        return { item, label: "再生成が必要", className: "isFailed", priority: 0 };
      }
      const blockedStatus = {
        hypothesis_contract_failed: "再生成が必要",
        copy_review_failed: "再生成が必要",
        copy_communication_failed: "再生成が必要",
        template_message_fit_failed: "再生成が必要",
        originality_review_failed: "再生成が必要",
        copy_review_error: "再生成が必要",
        strategy_input_insufficient: "再生成が必要",
        template_not_ready: "再生成が必要",
        needs_copy_visual_review: "確認が必要"
      }[item.productionStatus];
      if (blockedStatus) return { item, label: blockedStatus, className: "isFailed", priority: 0 };
      if (item.imageGenerationStatus === "queued") {
        return { item, label: "画像生成待ち", className: "isQueued", priority: 2 };
      }
      if (item.productionStatus === "prompt_queued") {
        return { item, label: "コピー設計待ち", className: "isQueued", priority: 2 };
      }
      if (item.imageGenerationStatus === "generating") {
        return { item, label: "画像生成中", className: "isRunning", priority: 1 };
      }
      if (["prompt_generating", "generating", "revising"].includes(item.productionStatus)) {
        return { item, label: "プロンプト生成中", className: "isRunning", priority: 2 };
      }
      return { item, label: "生成待ち", className: "", priority: 3 };
    })
    .sort((a, b) => a.priority - b.priority);
  const visibleIncomplete = incomplete.slice(0, 5);
  const progressHtml = '<div class="generationProgressHeader">'
    + '<strong>' + completed + ' / ' + banners.length + '</strong>'
    + '<span>完了（' + completionPct + '%）</span>'
    + '</div>'
    + '<div class="generationProgressTrack" role="progressbar" aria-label="バナー画像の生成進捗" aria-valuemin="0" aria-valuemax="' + banners.length + '" aria-valuenow="' + completed + '">'
    + '<span style="width:' + completionPct + '%"></span>'
    + '</div>';
  const incompleteHtml = incomplete.length
    ? '<div class="generationIncompleteHeader">未完了 ' + incomplete.length + '件</div>'
      + '<div class="generationActiveList">'
      + visibleIncomplete.map(({ item, label, className }) => '<div class="generationActiveRow">'
        + '<span class="generationActiveTitle" title="' + escapeAttr(item.title || "バナー案") + '">' + escapeHtml(item.title || "バナー案") + '</span>'
        + '<span class="generationStatus ' + className + '">' + (className === "isRunning" ? '<i aria-hidden="true"></i>' : '') + escapeHtml(label) + '</span>'
        + '</div>').join("")
      + (incomplete.length > visibleIncomplete.length ? '<div class="generationMore">ほか ' + (incomplete.length - visibleIncomplete.length) + '件</div>' : '')
      + '</div>'
    : '<div class="generationCompleteNote">すべてのバナー画像が完了しています。</div>';

  const nonArchivedStrategies = (research.strategies || []).filter((item) => item.status !== "archived");
  const usedStrategyIds = new Set(banners.filter((item) => item.strategyId).map((item) => item.strategyId));
  const unverifiedCount = nonArchivedStrategies.filter((item) => item.status !== "used_in_creative" && !usedStrategyIds.has(item.id)).length;
  const noTemplateCount = banners.filter((item) => !item.templateAdId).length;
  const nextRows = [
    checklistRowHtml(unverifiedCount > 0 ? "未採用の戦略: " + unverifiedCount + "件" : "すべての戦略を採用済み", unverifiedCount === 0),
    checklistRowHtml(noTemplateCount > 0 ? "テンプレ未選択のバナー: " + noTemplateCount + "件" : "テンプレ未選択のバナーはありません", noTemplateCount === 0)
  ].join("");
  const needsAction = unverifiedCount > 0 || noTemplateCount > 0;
  const nextCta = needsAction ? '<button type="button" class="inlineAddButton" data-summary-action="openBannerAddModal" style="width:100%;justify-content:center;margin-top:12px;">バナー案を追加</button>' : "";
  const secondCardHtml = '<div class="chartCard"><div class="chartCardTitle">次に作るべきもの</div><div class="checklistRows">' + nextRows + '</div>' + nextCta + '</div>';

  target.innerHTML = '<div class="chartBand">'
    + '<div class="chartCard"><div class="chartCardTitle">バナー生成状況</div>' + progressHtml + incompleteHtml + '</div>'
    + secondCardHtml
  + '</div>';
}

// 00 ホーム: 案件ダッシュボード。パイプライン進捗3カード、次にやること、
// 最近の生成物(画像完了バナー)を表示する。renderResearch() 経由で常に
// 最新のresearchデータと同時に再描画されるため、ensureLiveRefresh中の
// ポーリングでも数字が更新される。
function renderHome() {
  const pipeline = $("#homePipeline");
  const nextAction = $("#homeNextAction");
  const recentSection = $("#homeRecentSection");
  const recentGrid = $("#homeRecentGrid");
  if (!pipeline || !nextAction || !recentSection || !recentGrid) return;

  renderOnboardingCard();

  // 案件が1つもない(または案件未選択)の間は、パイプライン・次にやること・
  // 最近の生成物は表示できる中身がなく壊れた導線になるため、ワークエリア
  // 中央のはじめにカードだけを見せる(renderOnboardingCard側で処理)。
  const hasSelectableProject = projects.some((project) => !project.isTemplate);
  if (!hasSelectableProject) {
    pipeline.hidden = true;
    pipeline.innerHTML = "";
    nextAction.hidden = true;
    nextAction.innerHTML = "";
    recentSection.hidden = true;
    recentGrid.innerHTML = "";
    return;
  }
  pipeline.hidden = false;
  nextAction.hidden = false;

  pipeline.innerHTML = "";

  // 01 リサーチ: 5区分(FACT_CATEGORY_OPTIONS)の目安達成リング。
  // 事実が1件もなければリングなし(既存の「未着手」空状態のまま)。
  const factCounts = factCategoryCounts();
  const factTotal = factCounts.reduce((sum, item) => sum + item.count, 0);
  const achievedFlags = factCounts.map((item) => item.count >= (FACT_CATEGORY_TARGETS[item.category] || 1));
  const achievedCategoryCount = achievedFlags.filter(Boolean).length;
  const researchRing = factTotal
    ? {
        background: ringSegmentsBackground(
          achievedFlags.map((achieved) => ({ value: 1, color: achieved ? "var(--accent-500)" : "var(--slate-200)" })),
          { gapDeg: 3 }
        ),
        title: "区分達成 " + achievedCategoryCount + "/" + factCounts.length,
        centerValue: achievedCategoryCount + "/" + factCounts.length,
        centerLabel: "区分達成"
      }
    : null;
  const researchStats = [{ value: research.facts.length, label: "事実" }];
  const researchEmpty = !research.facts.length;
  pipeline.appendChild(homePipelineCard({
    workspace: "facts",
    kicker: "01",
    title: "リサーチ",
    stats: researchStats,
    empty: researchEmpty,
    ring: researchRing
  }));

  // 02 戦略: 非アーカイブ戦略のうち、バナー1件以上ある戦略=検証済みの仮説検証ドーナツ
  // (renderStrategiesSummary()のverifiedCountと同じ集計ロジック)。
  const proposedCount = (research.strategies || []).filter((item) => (item.status || "proposed") === "proposed").length;
  const usedCount = (research.strategies || []).filter((item) => item.status === "used_in_creative").length;
  const nonArchivedStrategies = (research.strategies || []).filter((item) => item.status !== "archived");
  const strategyUsageMap = new Map();
  for (const banner of (research.banners || [])) {
    if (banner.strategyId) strategyUsageMap.set(banner.strategyId, (strategyUsageMap.get(banner.strategyId) || 0) + 1);
  }
  const verifiedStrategyCount = nonArchivedStrategies.filter((item) => item.status === "used_in_creative" || (strategyUsageMap.get(item.id) || 0) > 0).length;
  const strategyTotal = nonArchivedStrategies.length;
  const strategyRing = strategyTotal
    ? {
        background: ringSegmentsBackground([
          { value: verifiedStrategyCount, color: "var(--accent-500)" },
          { value: strategyTotal - verifiedStrategyCount, color: "var(--slate-300)" }
        ]),
        title: "採用済み " + verifiedStrategyCount + "/" + strategyTotal,
        centerValue: verifiedStrategyCount + "/" + strategyTotal,
        centerLabel: "採用済み"
      }
    : null;
  pipeline.appendChild(homePipelineCard({
    workspace: "strategies",
    kicker: "02",
    title: "戦略",
    stats: [
      { value: proposedCount, label: "提案中" },
      { value: usedCount, label: "採用済み" }
    ],
    empty: !(research.strategies || []).length,
    ring: strategyRing
  }));

  // 03 制作: 完了/生成中/失敗の生成ステータスドーナツ(中央=完了数)。
  const bannersForHome = research.banners || [];
  const bannerCompleted = bannersForHome.filter((item) => item.imageGenerationStatus === "completed").length;
  const bannerFailed = bannersForHome.filter((item) => item.imageGenerationStatus === "failed" || item.productionStatus === "failed").length;
  const bannerGenerating = bannersForHome.filter((item) => {
    if (item.imageGenerationStatus === "completed") return false;
    if (item.imageGenerationStatus === "failed" || item.productionStatus === "failed") return false;
    if (isBannerJobStale(item)) return false;
    return ["queued", "generating"].includes(item.imageGenerationStatus) || ["prompt_queued", "generating", "prompt_generating", "sub_item_created", "revising"].includes(item.productionStatus);
  }).length;
  const productionRing = bannersForHome.length
    ? {
        background: ringSegmentsBackground([
          { value: bannerCompleted, color: "var(--accent-500)" },
          { value: bannerGenerating, color: "var(--accent-200)" },
          { value: bannerFailed, color: "var(--danger-fg)" },
          { value: bannersForHome.length - bannerCompleted - bannerGenerating - bannerFailed, color: "var(--slate-200)" }
        ]),
        title: "完了" + bannerCompleted + " / 生成中" + bannerGenerating + " / 失敗" + bannerFailed,
        centerValue: String(bannerCompleted),
        centerLabel: "完了"
      }
    : null;
  const productionStats = [{ value: bannersForHome.length, label: "バナー", note: `画像完了 ${bannerCompleted}` }];
  const productionEmpty = !bannersForHome.length;
  pipeline.appendChild(homePipelineCard({
    workspace: "banners",
    kicker: "03",
    title: "制作",
    stats: productionStats,
    empty: productionEmpty,
    ring: productionRing
  }));

  renderHomeNextAction(nextAction);
  renderHomeRecent(recentSection, recentGrid);
  animateHomeStats();
}

// ホーム数値のカウントアップ(バッチV)。パイプラインカードは renderHome() の
// たびに DOM を作り直すため、直前の値は要素ではなく statKey(workspace:label)
// をキーにした Map で保持する。初回(キー未登録)は 0→実数、以降は前回値→
// 新値へ差分アニメし、値が変わらない場合や reduced-motion 環境ではアニメしない。
const homeStatPrevValues = new Map();

function reducedMotionPreferred() {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function animateHomeStats() {
  const nodes = $$("#homePipeline [data-stat-key]");
  const reduced = reducedMotionPreferred();
  for (const node of nodes) {
    const key = node.dataset.statKey;
    const target = Number(node.dataset.statTarget) || 0;
    const start = homeStatPrevValues.has(key) ? homeStatPrevValues.get(key) : 0;
    homeStatPrevValues.set(key, target);
    if (reduced || start === target) {
      node.textContent = String(target);
      continue;
    }
    animateHomeStatNode(node, start, target);
  }
}

function animateHomeStatNode(node, start, end) {
  const duration = 400;
  const startTime = performance.now();
  function step(now) {
    const elapsed = Math.min(1, (now - startTime) / duration);
    const eased = 1 - Math.pow(1 - elapsed, 3);
    node.textContent = String(Math.round(start + (end - start) * eased));
    if (elapsed < 1 && node.isConnected) requestAnimationFrame(step);
    else node.textContent = String(end);
  }
  requestAnimationFrame(step);
}

// パイプラインカードのステージアイコン。サイドバーの各ワークスペース(nav)で
// 使っている線画SVGをそのまま再利用する(リサーチ=虫眼鏡/戦略=ターゲット/制作=ペン)。
const HOME_PIPELINE_STAGE_ICONS = {
  facts: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="10.5" cy="10.5" r="6"/><path d="m19.5 19.5-4.8-4.8"/></svg>',
  strategies: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/></svg>',
  banners: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4.5 19.5h15"/><path d="m7 16.5 9-9a1.7 1.7 0 0 1 2.4 0l.6.6a1.7 1.7 0 0 1 0 2.4l-9 9L6 20z"/></svg>'
};

function homePipelineCard({ workspace, kicker, title, stats, empty, ring }) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "homePipelineCard";
  const statsHtml = empty
    ? '<p class="homePipelineCardEmpty">未着手</p>'
    : '<div class="homePipelineCardStats">' + stats.map((stat) => {
        const statKey = `${workspace}:${stat.label}`;
        const target = Number(stat.value) || 0;
        return '<div class="homeStat"><strong data-stat-key="' + escapeHtml(statKey) + '" data-stat-target="' + target + '">0</strong><span>' + escapeHtml(stat.label) + '</span>'
          + (stat.note ? '<small>' + escapeHtml(stat.note) + '</small>' : '')
          + '</div>';
      }).join("") + '</div>';
  const iconHtml = HOME_PIPELINE_STAGE_ICONS[workspace] || "";
  // ミニリング(64px・中央実数。DESIGN.md 4-11)。空カードや対象データ0件のときは
  // ring自体がnullで渡ってくるため、装飾のためだけの円は描画しない。
  const ringHtml = ring
    ? '<span class="pipelineRingWrap"><span class="pipelineRing" style="background:' + ring.background + ';" title="' + escapeAttr(ring.title) + '">'
      + '<span class="pipelineRingCenter"><strong>' + escapeHtml(ring.centerValue) + '</strong><small>' + escapeHtml(ring.centerLabel) + '</small></span>'
      + '</span></span>'
    : '';
  card.innerHTML = '<div class="homePipelineCardHeader">'
    + (iconHtml ? '<span class="homePipelineCardIcon">' + iconHtml + '</span>' : '')
    + '<span class="homePipelineCardKicker">' + escapeHtml(kicker) + '</span><b>' + escapeHtml(title) + '</b></div>'
    + '<div class="homePipelineCardBody">' + ringHtml + statsHtml + '</div>';
  card.addEventListener("click", () => switchView(workspace));
  return card;
}

// はじめにカード(オンボーディングガイド)。フェーズ3でOpenAI APIキー案内のみに
// 縮小し、3ステップ判定(getOnboardingSteps)は廃止。案件作成後の導線は
// #homeNextAction 側の「はじめてのバナーまで」20分ガイドレールに統合した。
// 案件が1つもない/未選択のときは #homeOnboardingWrap 自体を中央大サイズに切り替え、
// 従来の「案件を選択してください」という空の状態表示を置き換える。
function onboardingStepIconHtml(done) {
  return done
    ? '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.5 2.5L16 9.5"/></svg>'
    : '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/></svg>';
}

// 「もう1つの使い方: AIエージェント」案内。完了判定のない常設セクションで、
// ホーム上部のコンパクトカードでは <details> で折りたたみ、案件未選択時の
// 中央大カードでは常に展開して見せる(collapsed引数で切り替え)。
function onboardingAgentBodyHtml() {
  return '<div class="onboardingAgentBody">'
    + '<p class="onboardingAgentIntro">このフォルダを手元のClaude Code / Codexで開くと、自然言語の指示だけで同じフローを実行できます。</p>'
    + '<pre class="onboardingAgentCode"><code>cd CMO-AI-Lite\nclaude   # または codex</code></pre>'
    + '<p class="onboardingAgentExample">例:「LP: https://example.com で案件を作ってバナー10案作って」</p>'
    + '<p class="onboardingAgentNote">テキスト生成はエージェントのサブスク内で実行され、OpenAI課金は画像生成のみ。詳しくは <a href="https://cmoai.jp/" target="_blank" rel="noopener noreferrer">CMO AI</a> の案内を参照。</p>'
    + '</div>';
}

function onboardingAgentSectionHtml(collapsed) {
  const body = onboardingAgentBodyHtml();
  if (collapsed) {
    return '<details class="onboardingAgentSection"><summary>AIエージェントから使う</summary>' + body + '</details>';
  }
  return '<div class="onboardingAgentSection onboardingAgentSectionExpanded">'
    + '<p class="onboardingAgentTitle">もう1つの使い方: AIエージェント</p>' + body + '</div>';
}

// APIキー案内行のみのHTML。設定済みなら1行の確認表示、未設定なら
// タイトル+ヒント+「設定を開く」ボタンを出す。
function onboardingApiKeyRowHtml() {
  const configured = openAiConfigured === true;
  if (configured) {
    return '<div class="onboardingApiKeyRow isDone">'
      + '<span class="onboardingStepIcon">' + onboardingStepIconHtml(true) + '</span>'
      + '<p class="onboardingApiKeyText">OpenAI APIキーは設定済みです。</p>'
      + '</div>';
  }
  return '<div class="onboardingApiKeyRow">'
    + '<span class="onboardingStepIcon">' + onboardingStepIconHtml(false) + '</span>'
    + '<div class="onboardingStepBody">'
    + '<p class="onboardingStepTitle">OpenAI APIキーを設定</p>'
    + '<p class="onboardingStepHint">UIからのAI実行と画像生成に使います。キーはローカルにのみ保存されます。</p>'
    + '</div>'
    + '<button type="button" class="secondaryButton onboardingStepAction" data-onboarding-action="apiKey">設定を開く</button>'
    + '</div>';
}

function onboardingCardHtml(centered) {
  // 案件ゼロ(中央表示)のときだけ「＋ 新規案件」を目立つ位置に併記する。
  const newProjectButtonHtml = centered
    ? '<button type="button" class="inlineAddButton onboardingNewProjectButton" data-onboarding-action="newProject">＋ 新規案件(商品を登録)</button>'
    : '';
  // 案件ゼロ(中央表示)のときは閉じるとホームが空白になるため、閉じるボタンを出さない
  return (centered ? '' : '<button type="button" class="onboardingCloseButton" id="onboardingCloseButton" aria-label="閉じる">&#215;</button>')
    + '<div class="onboardingCardHeader"><h3>CMO AI Lite をはじめよう</h3></div>'
    + onboardingApiKeyRowHtml()
    + newProjectButtonHtml
    + '<hr class="onboardingDivider" />'
    + onboardingAgentSectionHtml(!centered);
}

function renderOnboardingCard() {
  const wrap = $("#homeOnboardingWrap");
  if (!wrap) return;
  const hasSelectableProject = projects.some((project) => !project.isTemplate);
  const centered = !hasSelectableProject;
  wrap.classList.toggle("homeOnboardingWrapCentered", centered);

  // compact(案件あり)のときはAPIキー設定済みならカード自体を非表示にする。
  // centered(案件ゼロ)のときは常に表示(閉じるボタンがないため dismissed も無視)。
  if (!centered) {
    const configured = openAiConfigured === true;
    const dismissed = localStorage.getItem(ONBOARDING_DISMISSED_KEY) === "1";
    if (configured || dismissed) {
      wrap.hidden = true;
      wrap.innerHTML = "";
      return;
    }
  }

  wrap.hidden = false;
  wrap.innerHTML = '<div class="onboardingCard">' + onboardingCardHtml(centered) + '</div>';
  const card = wrap.querySelector(".onboardingCard");
  if (!card) return;
  card.querySelector("#onboardingCloseButton")?.addEventListener("click", () => {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "1");
    renderOnboardingCard();
  });
  card.querySelector('[data-onboarding-action="apiKey"]')?.addEventListener("click", () => switchView("settings"));
  card.querySelector('[data-onboarding-action="newProject"]')?.addEventListener("click", () => $("#projectModal")?.classList.remove("hidden"));
}

// 「はじめてのバナーまで(目安 約20分)」ガイドレール。6ステップの完了判定と
// 次の一手(CTA)を持つ。各ステップのdoneはステップ順に関係なく個別に評価するため、
// すでに進んでいる案件では該当ステップが自然に完了表示になる。
function homeGuideSteps() {
  return [
    {
      key: "product",
      title: "商品を登録",
      minutes: "約1分",
      done: Boolean((research.products || []).length),
      run: () => switchView("products")
    },
    {
      key: "productImage",
      title: "商品画像を追加",
      minutes: "約2分",
      done: Boolean(((research.products || [])[0]?.images || []).length),
      run: () => switchView("products")
    },
    {
      key: "research",
      title: "事実を抽出",
      minutes: "約5分",
      done: Boolean((research.facts || []).length),
      ctaLabel: "事実抽出を実行",
      run: () => runFactExtraction()
    },
    {
      key: "strategy",
      title: "戦略を生成",
      minutes: "約3分",
      done: Boolean((research.strategies || []).length),
      run: () => runWhoWhat()
    },
    {
      key: "banner",
      title: "バナー案を作る",
      minutes: "約4分",
      done: Boolean((research.banners || []).length),
      run: () => { switchView("banners"); openBannerAddModal(); }
    },
    {
      key: "image",
      title: "画像を生成",
      minutes: "約5分",
      done: (research.banners || []).some((banner) => banner.imageGenerationStatus === "completed"),
      run: () => switchView("banners")
    }
  ];
}

function homeGuideStepHtml(step, index, firstPendingIndex) {
  const state = step.done ? "done" : index === firstPendingIndex ? "active" : "upcoming";
  const iconHtml = step.done ? onboardingStepIconHtml(true) : '<span class="homeGuideStepNumber">' + (index + 1) + '</span>';
  const actionHtml = state === "active"
    ? '<button type="button" class="inlineAddButton homeGuideStepAction" data-home-guide-action>' + escapeHtml(step.ctaLabel || step.title) + '</button>'
    : '';
  return '<div class="homeGuideStep homeGuideStep--' + state + '">'
    + '<span class="homeGuideStepIcon">' + iconHtml + '</span>'
    + '<div class="homeGuideStepBody"><p class="homeGuideStepTitle">' + escapeHtml(step.title) + '</p><small class="homeGuideStepTime">' + escapeHtml(step.minutes) + '</small></div>'
    + actionHtml
    + '</div>';
}

function renderHomeNextAction(target) {
  const steps = homeGuideSteps();
  const completedCount = steps.filter((step) => step.done).length;
  const allDone = completedCount === steps.length;
  target.classList.toggle("homeNextAction--guide", !allDone);
  target.innerHTML = "";

  if (allDone) {
    const text = document.createElement("p");
    text.textContent = "リサーチと戦略が揃っています。制作を進めましょう。";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "inlineAddButton";
    button.textContent = "制作を進める";
    button.addEventListener("click", () => switchView("banners"));
    target.appendChild(text);
    target.appendChild(button);
    return;
  }

  const firstPendingIndex = steps.findIndex((step) => !step.done);
  const guide = document.createElement("div");
  guide.className = "homeGuide";
  guide.innerHTML = '<div class="homeGuideHeader"><h3>はじめてのバナーまで(目安 約20分)</h3><span class="homeGuideProgress">' + completedCount + '/' + steps.length + '</span></div>'
    + '<div class="homeGuideRail">' + steps.map((step, index) => homeGuideStepHtml(step, index, firstPendingIndex)).join("") + '</div>';
  target.appendChild(guide);
  const activeButton = guide.querySelector("[data-home-guide-action]");
  if (activeButton && firstPendingIndex >= 0) activeButton.addEventListener("click", steps[firstPendingIndex].run);
}

function renderHomeRecent(section, grid) {
  const completed = (research.banners || [])
    .filter((banner) => banner.imageGenerationStatus === "completed" && (banner.generatedImagePath || banner.images?.[0]))
    .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")))
    .slice(0, 6);
  grid.innerHTML = "";
  if (!completed.length) { section.hidden = true; return; }
  section.hidden = false;
  for (const banner of completed) {
    const image = banner.generatedImagePath || banner.images?.[0] || "";
    const card = document.createElement("button");
    card.type = "button";
    card.className = "homeRecentCard";
    card.innerHTML = '<div class="homeRecentThumb"><img src="' + escapeAttr(resolveImageSrc(image)) + '" alt="" /></div>'
      + '<p class="homeRecentTitle">' + escapeHtml(banner.title || "バナー案") + '</p>';
    card.addEventListener("click", () => { switchView("banners"); selectItem("banner", banner); });
    grid.appendChild(card);
  }
}

function renderProductOptions() {
  for (const select of [$("#materialProduct"), $("#factProduct"), $("#bannerProduct"), $("#copyProduct"), $("#scriptProduct"), $("#strategyProduct")].filter(Boolean)) {
    select.innerHTML = `<option value="">商品未選択</option>`;
    for (const product of research.products) {
      const option = document.createElement("option");
      option.value = product.id;
      option.textContent = product.name;
      select.appendChild(option);
    }
  }
}

function renderStrategyProductFilter() {
  const select = $("#strategyProductFilter");
  if (!select) return;
  select.innerHTML = `<option value="">すべての商品</option>` + research.products.map((product) => `<option value="${escapeAttr(product.id)}">${escapeHtml(product.name)}</option>`).join("");
  const valid = research.products.some((product) => product.id === strategyProductFilter);
  strategyProductFilter = valid ? strategyProductFilter : "";
  select.value = strategyProductFilter;
}

function renderProducts() {
  const target = $("#products");
  target.innerHTML = "";
  if (!research.products.length) {
    target.innerHTML = '<div class="productProfileEmpty"><div class="productProfileEmptyMark">P</div><h2>商品が登録されていません</h2><p>新しい案件を作成して、商品情報を登録してください。</p><button type="button" class="inlineAddButton" id="createProductProject">新規案件を作成</button></div>';
    target.querySelector("#createProductProject")?.addEventListener("click", () => $("#openProjectModal")?.click());
    return;
  }
  const product = research.products[0];
  const images = Array.isArray(product.images) ? product.images : [];
  const logo = images.find((image) => image.role === "logo") || null;
  const heroImage = images.find((image) => image.role === "product") || images[0] || null;
  const logoHtml = logo
    ? '<button type="button" class="productLogoPreview" data-preview-image="' + escapeAttr(resolveImageSrc(logo.path)) + '" data-preview-title="' + escapeAttr(logo.label || "ブランドロゴ") + '"><img src="' + escapeAttr(resolveImageSrc(logo.path)) + '" alt="ブランドロゴ" /></button>'
    : '<span class="productLogoEmpty">LOGO</span>';
  const heroMediaHtml = '<div class="productProfileMedia"><div class="productHeroMediaHeader"><div><span>PRODUCT IMAGE</span><strong>商品画像</strong></div><button type="button" class="tableButton" data-open-product-images="' + escapeAttr(product.id) + '">画像を管理</button></div>'
    + '<div class="productHeroMediaStage">' + (heroImage
      ? '<button type="button" class="productHeroImageButton" data-preview-image="' + escapeAttr(resolveImageSrc(heroImage.path)) + '" data-preview-title="' + escapeAttr(heroImage.label || product.name || "商品画像") + '"><img src="' + escapeAttr(resolveImageSrc(heroImage.path)) + '" alt="' + escapeAttr(heroImage.label || product.name || "商品画像") + '" /></button>'
      : '<div class="productHeroPlaceholder"><span class="productHeroPlaceholderIcon">+</span><strong>商品画像がありません</strong><small>画像タブから商品写真を追加できます</small></div>')
    + '</div><p class="productHeroMediaCaption">' + escapeHtml(heroImage?.label || heroImage?.fileName || "メインの商品写真") + '</p></div>';
  target.innerHTML = '<section class="productProfileHero">'
    + '<div class="productProfileInfo">'
    + '<div class="productProfileIdentity"><div class="productProfileLogo">' + logoHtml + '</div><div><span class="productProfileEyebrow">PRODUCT MASTER</span><h2>' + escapeHtml(product.name || "商品名未設定") + '</h2></div></div>'
    + '<div class="productProfileFields">'
    + productProfileFieldHtml(product, "name", "商品名", "text", "商品名")
    + productProfileFieldHtml(product, "officialUrl", "LP / 記事LP", "url", "https://example.com")
    + productProfileFieldHtml(product, "shortDescription", "商品説明", "textarea", "商品の特徴や用途を入力")
    + productProfileFieldHtml(product, "brandTone", "トンマナ", "textarea", "誠実、清潔感、専門的")
    + '</div><div class="productProfileNextAction"><div><strong>LP解析と網羅リサーチを開始</strong><p>商品・記事LPを文字起こししてから、8方向のWeb検索で出典付き事実を補完します。解析済みURLは再利用します。</p></div><button type="button" class="inlineAddButton" id="extractFactsFromProduct">LP解析 + 網羅リサーチ</button></div></div>' + heroMediaHtml + '</section>';

  for (const field of target.querySelectorAll("[data-product-profile-field]")) {
    field.addEventListener("change", async () => {
      const value = field.value.trim();
      if (value === String(product[field.dataset.productProfileField] || "").trim()) return;
      await updateTableRow("product", product.id, { [field.dataset.productProfileField]: value });
    });
  }
  target.querySelector("#extractFactsFromProduct")?.addEventListener("click", async () => {
    const patch = {};
    for (const field of target.querySelectorAll("[data-product-profile-field]")) {
      const value = field.value.trim();
      const key = field.dataset.productProfileField;
      if (value !== String(product[key] || "").trim()) patch[key] = value;
    }
    if (Object.keys(patch).length) await updateTableRow("product", product.id, patch);
    const url = target.querySelector('[data-product-profile-field="officialUrl"]')?.value.trim() || "";
    if (!/^https?:\/\//i.test(url)) return showToast("error", "LP / 記事LPのURLを入力してください。");
    switchView("facts");
    await runFactExtraction({ productId: product.id, webSearch: true, button: target.querySelector("#extractFactsFromProduct") });
  });
}

function toggleResearchSourceImport(show) {
  const panel = $("#researchSourceImportPanel");
  if (!panel) return;
  panel.hidden = !show;
  if (show) $("#researchSourceTitle")?.focus();
}

async function saveResearchSourceAndExtract() {
  const project = selectedProject();
  const productId = research.products[0]?.id || "";
  const title = $("#researchSourceTitle")?.value.trim() || "書き出し結果";
  const sourceUrl = $("#researchSourceUrl")?.value.trim() || "";
  const manualText = $("#researchSourceText")?.value.trim() || "";
  if (!project || !productId) return showToast("error", "商品を登録してから取り込んでください。");
  if (!manualText) return showToast("error", "根拠原文を貼り付けてください。");
  await runExclusive(`researchSourceImport:${project.path}`, $("#saveResearchSourceAndExtract"), async () => {
    const created = await post("/api/research/materials", {
      project: project.path,
      productId,
      type: "External",
      title,
      sourceUrl,
      manualText
    });
    if (!created.ok) throw new Error(created.message || "根拠原文を保存できませんでした。");
    await loadResearch();
    const extracted = await post("/api/research/facts/extract-ai", { project: project.path, productId, webSearch: false });
    if (!extracted.ok) throw new Error(extracted.message || "原文から事実を抽出できませんでした。");
    await loadResearch();
    renderResearch();
    toggleResearchSourceImport(false);
    $("#researchSourceTitle").value = "";
    $("#researchSourceUrl").value = "";
    $("#researchSourceText").value = "";
    showToast("success", `根拠原文を保存し、${extracted.added?.length || extracted.candidateCount || 0}件の事実を抽出しました。`);
  });
}

function renderProductImages() {
  const target = $("#productImages");
  if (!target) return;
  const product = research.products[0];
  if (!product) {
    target.innerHTML = '<div class="productProfileEmpty"><h2>商品が登録されていません</h2><p>商品を登録すると画像素材を追加できます。</p></div>';
    return;
  }
  const images = Array.isArray(product.images) ? product.images : [];
  const cards = images.length ? images.map((image) => productImageCardHtml(product.id, image)).join("") : '<p class="productAssetsEmpty">登録済みの画像はありません。</p>';
  target.innerHTML = '<section class="productAssetsSection productImagesBlock productImagesLibrary" data-product-id="' + escapeAttr(product.id) + '">'
    + '<div class="productAssetsHeader"><div><span class="productProfileEyebrow">IMAGE LIBRARY</span><h2>画像</h2><p>' + images.length + '枚の素材</p></div><div class="productAssetUploadActions">'
    + productAssetUploadButton(product.id, "product", "商品写真")
    + productAssetUploadButton(product.id, "logo", "ロゴ")
    + productAssetUploadButton(product.id, "other", "その他")
    + '</div></div><div class="productImageGrid productImageGridRich">' + cards + '</div></section>';
}

function productProfileFieldHtml(product, field, label, kind, placeholder) {
  const value = String(product[field] || "");
  if (kind === "textarea") {
    return '<label class="productProfileField productProfileField--textarea"><span>' + escapeHtml(label) + '</span><textarea rows="3" data-product-profile-field="' + escapeAttr(field) + '" placeholder="' + escapeAttr(placeholder) + '">' + escapeHtml(value) + '</textarea></label>';
  }
  if (kind === "colorText") {
    const swatch = /^#[0-9a-f]{6}$/i.test(value) ? value : "#dbe4f0";
    return '<label class="productProfileField"><span>' + escapeHtml(label) + '</span><div class="productColorField"><i style="background:' + escapeAttr(swatch) + '"></i><input type="text" data-product-profile-field="' + escapeAttr(field) + '" value="' + escapeAttr(value) + '" placeholder="' + escapeAttr(placeholder) + '" /></div></label>';
  }
  return '<label class="productProfileField"><span>' + escapeHtml(label) + '</span><input type="' + (kind === "url" ? "url" : "text") + '" data-product-profile-field="' + escapeAttr(field) + '" value="' + escapeAttr(value) + '" placeholder="' + escapeAttr(placeholder) + '" /></label>';
}

function productAssetUploadButton(productId, role, label) {
  return '<label class="secondaryButton productAssetUploadButton">+ ' + escapeHtml(label) + '<input type="file" accept="image/*" class="productImageFileInput" data-product-id="' + escapeAttr(productId) + '" data-role="' + escapeAttr(role) + '" hidden /></label>';
}

function latestExtractionJob(materialId) {
  return (research.extractionJobs || [])
    .filter((job) => job.materialId === materialId)
    .sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")))[0] || null;
}

// 「中断された(=止まった)」判定は、開始からの経過ではなく最後に進捗があった時刻
// (job.progressAt のハートビート)からの無進捗時間で見る。スライスを1枚処理するたびに
// progressAt が更新されるので、進んでいる限り何分かかっても中断扱いにはならない。
// 逆にサーバー再起動などで本当に止まると progressAt が更新されず、しきい値超過で復帰導線を出す。
const STALE_EXTRACTION_MS = 10 * 60 * 1000;
function isStaleExtractionJob(job) {
  if (!job || job.status !== "running") return false;
  const last = new Date(job.progressAt || job.startedAt).getTime();
  return Number.isFinite(last) && Date.now() - last > STALE_EXTRACTION_MS;
}


function renderFacts() {
  const target = $("#facts");
  target.innerHTML = "";
  if (!research.facts.length) {
    target.appendChild(emptyTableRow(7, "まだ事実がありません。「事実抽出を実行」を押すと、商品のLPとWeb検索から5区分の事実を抽出します。"));
  }
  for (const fact of research.facts) {
    const product = research.products.find((item) => item.id === fact.productId);
    const content = stripFactReferenceMarkers(fact.content);
    const tr = row([relationCellHtml("fact", fact.id, "productId", fact.productId || "", product?.name || "\u672a\u9078\u629e", "productRelation"), editableCellHtml("fact", fact.id, "category", mapFactCategory(fact.category), { kind: "select", optionsKey: "factCategory" }), editableCellHtml("fact", fact.id, "title", fact.title), editableCellHtml("fact", fact.id, "content", clip(content, 120), { kind: "textarea", rawValue: content }), editableCellHtml("fact", fact.id, "createdBy", fact.createdBy || ""), factSourceCellHtml(fact), ""], "fact", fact, true);
    tr.lastElementChild.appendChild(rowDeleteButton("fact", fact.id));
    target.appendChild(tr);
  }
  renderAddPanel("factsAddPanel", "\u4e8b\u5b9f\u3092\u8ffd\u52a0", factInputRow);
  renderFactsEditor();
}

function factSourceCellHtml(fact) {
  const value = fact.sourceUrl || fact.sourceMaterialId || fact.sourceType || "";
  const link = /^https?:\/\//i.test(value)
    ? '<a class="factSourceLink" href="' + escapeAttr(value) + '" target="_blank" rel="noopener noreferrer">引用元を開く</a>'
    : "";
  return '<div class="factSourceCell">' + link + editableCellHtml("fact", fact.id, "sourceUrl", value, { kind: "url" }) + '</div>';
}

// Matches the column order of the real Notion\u7248CMOAI \u4e8b\u5b9fDB CSV export
// (\u30ab\u30c6\u30b4\u30ea,\u5546\u54c1,\u540d\u524d,\u5185\u5bb9,\u4f5c\u6210\u65e5\u6642,\u4f5c\u6210\u8005,\u5f15\u7528\u5143) so exports/imports line up.
function exportFactsCsv() {
  const header = ["\u30ab\u30c6\u30b4\u30ea", "\u5546\u54c1", "\u540d\u524d", "\u5185\u5bb9", "\u4f5c\u6210\u65e5\u6642", "\u4f5c\u6210\u8005", "\u5f15\u7528\u5143"];
  const rows = research.facts.map((fact) => {
    const product = research.products.find((item) => item.id === fact.productId);
    return [
      fact.category || "",
      product?.name || "",
      fact.title || "",
      stripFactReferenceMarkers(fact.content) || "",
      formatDateTime(fact.createdAt) || "",
      fact.createdBy || "",
      fact.sourceUrl || fact.sourceMaterialId || fact.sourceType || ""
    ];
  });
  const csv = [header, ...rows].map((cells) => cells.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  const project = selectedProject();
  link.download = `\u4e8b\u5b9fDB_${project?.name || "\u6848\u4ef6"}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
}

function renderExpressionRules() {
  const target = $("#expressionRules");
  if (!target) return;
  target.innerHTML = "";
  if (!(research.expressionRules || []).length) {
    target.appendChild(emptyTableRow(6, "まだ表現ルールがありません。NG表現や推奨表現を登録するとバナー生成時に自動反映されます。"));
  }
  for (const rule of research.expressionRules || []) {
    const product = research.products.find((item) => item.id === rule.productId);
    const tr = row([relationCellHtml("rule", rule.id, "productId", rule.productId || "", product?.name || "\u672a\u9078\u629e", "productRelation"), editableCellHtml("rule", rule.id, "ruleType", displayValue(rule.ruleType), { kind: "select", optionsKey: "ruleType" }), editableCellHtml("rule", rule.id, "pattern", rule.pattern), editableCellHtml("rule", rule.id, "replacement", rule.replacement), editableCellHtml("rule", rule.id, "description", rule.description, { kind: "textarea" }), ""], "rule", rule, true);
    tr.lastElementChild.appendChild(rowDeleteButton("rule", rule.id));
    target.appendChild(tr);
  }
  renderAddPanel("rulesAddPanel", "\u8868\u73fe\u30eb\u30fc\u30eb\u3092\u8ffd\u52a0", expressionRuleInputRow);
  renderRulesEditor();
}

// ---- \u4e8b\u5b9fDB: \u30a8\u30c7\u30a3\u30bf\u8868\u793a(\u8aad\u3080\u30fb\u30b3\u30d4\u30fc\u3059\u308b\u7528\u9014\u304c\u4e3b) ----
// \u5546\u54c1\u3054\u3068\u306b1\u30c6\u30ad\u30b9\u30c8\u30a8\u30c7\u30a3\u30bf\u3067\u300c\u7279\u5fb4 \u2192 \u30e1\u30ea\u30c3\u30c8 \u2192 \u5b9f\u7e3e \u2192 \u6a29\u5a01\u6027 \u2192 \u30aa\u30d5\u30a1\u30fc\u300d\u306e5\u533a\u5206\u56fa\u5b9a\u9806\u306e
// \u898b\u51fa\u3057\u4ed8\u304d\u30b0\u30eb\u30fc\u30d7\u5f62\u5f0f\u306b\u3059\u308b\u3002\u898b\u51fa\u3057\u306f\u5e38\u306b5\u3064\u5168\u3066\u51fa\u3059(\u7a7a\u533a\u5206\u306f\u898b\u51fa\u3057\u3060\u3051)\u3002
function renderFactsEditor() {
  // 1案件1商品: エディタは常に唯一の商品(research.products[0])を対象に固定する。
  factsEditorProductId = research.products[0]?.id || "";
  const textarea = $("#factsEditorTextarea");
  if (!textarea) return;
  const facts = research.facts.filter((item) => item.productId === factsEditorProductId);
  textarea.value = factsToEditorText(facts);
  factsEditorTrackedRows = FACT_CATEGORY_OPTIONS.flatMap((category) => facts
    .filter((item) => mapFactCategory(item.category) === category)
    .map((item) => ({ id: item.id, category, content: stripFactReferenceMarkers(item.content) })));
  renderFactsPreview(textarea.value);
  setFactsContentMode(factsContentMode);
  renderFactsResearchEvidence(facts);
}

function setFactsContentMode(mode) {
  factsContentMode = mode === "edit" ? "edit" : "preview";
  const preview = $("#factsPreviewPanel");
  const editor = $("#factsEditPanel");
  if (preview) preview.hidden = factsContentMode !== "preview";
  if (editor) editor.hidden = factsContentMode !== "edit";
  if (factsContentMode === "preview") renderFactsPreview($("#factsEditorTextarea")?.value || "");
  for (const button of $$('[data-facts-content-mode]')) {
    const active = button.dataset.factsContentMode === factsContentMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  }
}

function renderFactsPreview(text) {
  const target = $("#factsPreviewPanel");
  if (!target) return;
  const grouped = new Map(FACT_CATEGORY_OPTIONS.map((category) => [category, []]));
  for (const item of parseFactsEditorText(text)) grouped.get(mapFactCategory(item.category))?.push(item.content);
  target.innerHTML = FACT_CATEGORY_OPTIONS.map((category) => {
    const items = grouped.get(category) || [];
    const list = items.length
      ? '<ul>' + items.map((content) => '<li>' + escapeHtml(content) + '</li>').join("") + '</ul>'
      : '<p class="structuredTextEmpty">まだ事実がありません。</p>';
    return '<section><h3>' + escapeHtml(category) + '</h3>' + list + '</section>';
  }).join("");
}

function renderFactsResearchEvidence(facts) {
  const target = $("#factsResearchEvidence");
  if (!target) return;
  const urls = [...new Set(facts.flatMap((fact) => {
    const references = Array.isArray(fact.references) ? fact.references : [];
    return [...references, fact.sourceUrl].map((value) => String(value || "").trim()).filter((value) => /^https?:\/\//i.test(value));
  }))];
  const queries = [...new Set(facts.flatMap((fact) => Array.isArray(fact.searchQueriesRun) ? fact.searchQueriesRun : []).map((value) => String(value || "").trim()).filter(Boolean))];
  const webSearchCompleted = facts.some((fact) => fact.webSearchStatus === "completed");
  if (!urls.length && !queries.length && !webSearchCompleted) {
    target.innerHTML = "";
    target.hidden = true;
    return;
  }
  const links = urls.map((url, index) => '<a href="' + escapeAttr(url) + '" target="_blank" rel="noopener noreferrer"><span>' + (index + 1) + '</span>' + escapeHtml(url) + '</a>').join("");
  target.hidden = false;
  target.innerHTML = '<div class="factsEvidenceHeader"><div><strong>参照元URL</strong><p>出典は事実本文と分けて管理しています。</p></div>'
    + '<span class="factsEvidenceStatus ' + (webSearchCompleted ? "completed" : "") + '">Web検索 ' + (webSearchCompleted ? "実行済み" : "未実行") + (queries.length ? '・' + queries.length + 'クエリ' : "") + '</span></div>'
    + '<div class="factsEvidenceLinks">' + links + '</div>';
}

function factsToEditorText(facts) {
  const grouped = new Map(FACT_CATEGORY_OPTIONS.map((category) => [category, []]));
  for (const fact of facts) {
    const category = mapFactCategory(fact.category);
    grouped.get(category).push(fact);
  }
  const blocks = FACT_CATEGORY_OPTIONS.map((category) => {
    const lines = grouped.get(category).map(factToEditorLine);
    return [`## ${category}`, ...lines].join("\n");
  });
  return blocks.join("\n\n");
}

function factToEditorLine(fact) {
  const content = stripFactReferenceMarkers(fact.content).replace(/\r?\n/g, " ").trim();
  return `- ${content}`;
}

function stripFactReferenceMarkers(value) {
  return String(value || "")
    .replace(/\s*[\(（]\s*※[0-9０-９]+(?:\s*[,、，]\s*※[0-9０-９]+)*\s*[\)）]/g, "")
    .trim();
}

function parseFactsEditorText(text) {
  const items = [];
  let currentCategory = FACT_CATEGORY_OPTIONS[0];
  for (const rawLine of String(text || "").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const headingMatch = line.match(/^#{1,6}\s*(.+)$/);
    if (headingMatch) {
      currentCategory = mapFactCategory(headingMatch[1]);
      continue;
    }
    const item = parseFactEditorLine(line, currentCategory);
    if (item) items.push(item);
  }
  return items;
}

function parseFactEditorLine(line, currentCategory) {
  const trimmed = String(line || "").trim();
  if (!trimmed) return null;
  const withoutBullet = trimmed.replace(/^[-\u30fb]\s*/, "");
  // \u65e7\u5f62\u5f0f\u300c- [\u30ab\u30c6\u30b4\u30ea] \u5185\u5bb9\u300d\u3082\u5f8c\u65b9\u4e92\u63db\u3067\u8aad\u307f\u8fbc\u3080
  const legacyMatch = withoutBullet.match(/^\[([^\]]*)\]\s*(.*)$/);
  if (legacyMatch) {
    const category = mapFactCategory(legacyMatch[1]);
    const content = legacyMatch[2].trim();
    return content ? { category, content } : null;
  }
  return withoutBullet ? { category: mapFactCategory(currentCategory), content: withoutBullet } : null;
}

function normalizeEditorText(value) {
  return String(value || "").trim().replace(/\s+/g, "");
}

function alignFactEditorRows(existing, parsed) {
  const oldKeys = existing.map((item) => normalizeEditorText(stripFactReferenceMarkers(item.content)));
  const nextKeys = parsed.map((item) => normalizeEditorText(stripFactReferenceMarkers(item.content)));
  const dp = Array.from({ length: existing.length + 1 }, () => Array(parsed.length + 1).fill(0));
  for (let oldIndex = existing.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let nextIndex = parsed.length - 1; nextIndex >= 0; nextIndex -= 1) {
      dp[oldIndex][nextIndex] = oldKeys[oldIndex] === nextKeys[nextIndex]
        ? dp[oldIndex + 1][nextIndex + 1] + 1
        : Math.max(dp[oldIndex + 1][nextIndex], dp[oldIndex][nextIndex + 1]);
    }
  }

  const exactPairs = [];
  let oldIndex = 0;
  let nextIndex = 0;
  while (oldIndex < existing.length && nextIndex < parsed.length) {
    if (oldKeys[oldIndex] === nextKeys[nextIndex]) {
      exactPairs.push([oldIndex, nextIndex]);
      oldIndex += 1;
      nextIndex += 1;
    } else if (dp[oldIndex + 1][nextIndex] >= dp[oldIndex][nextIndex + 1]) {
      oldIndex += 1;
    } else {
      nextIndex += 1;
    }
  }

  const pairs = [...exactPairs];
  const anchors = [[-1, -1], ...exactPairs, [existing.length, parsed.length]];
  for (let index = 0; index < anchors.length - 1; index += 1) {
    const [oldStart, nextStart] = anchors[index];
    const [oldEnd, nextEnd] = anchors[index + 1];
    const oldCount = oldEnd - oldStart - 1;
    const nextCount = nextEnd - nextStart - 1;
    // 同じ位置の同数行だけを本文編集として扱う。挿入・削除を類似度で推測しないため、
    // 別事実の参照元を誤って引き継がない。
    if (oldCount !== nextCount) continue;
    for (let offset = 1; offset <= oldCount; offset += 1) pairs.push([oldStart + offset, nextStart + offset]);
  }
  return pairs.sort((left, right) => left[0] - right[0]);
}

function trackFactsEditorRows() {
  const textarea = $("#factsEditorTextarea");
  if (!textarea) return;
  const parsed = parseFactsEditorText(textarea.value);
  const tracked = parsed.map((item) => ({ id: "", category: item.category, content: item.content }));
  for (const [previousIndex, parsedIndex] of alignFactEditorRows(factsEditorTrackedRows, parsed)) {
    tracked[parsedIndex].id = factsEditorTrackedRows[previousIndex]?.id || "";
  }
  factsEditorTrackedRows = tracked;
}

async function saveFactsEditor() {
  const project = selectedProject();
  const productId = factsEditorProductId || research.products[0]?.id || "";
  const textarea = $("#factsEditorTextarea");
  if (!project || !textarea) return;

  trackFactsEditorRows();
  const existing = research.facts.filter((item) => item.productId === productId);
  const existingById = new Map(existing.map((item) => [item.id, item]));
  const parsed = factsEditorTrackedRows;

  const matchedExisting = new Set();
  const matchedParsed = new Set();
  const toUpdate = [];
  parsed.forEach((next, parsedIndex) => {
    const current = existingById.get(next.id);
    if (!current) return;
    matchedExisting.add(current.id);
    matchedParsed.add(parsedIndex);
    const patch = {};
    if (normalizeEditorText(stripFactReferenceMarkers(current.content)) !== normalizeEditorText(stripFactReferenceMarkers(next.content))) patch.content = next.content;
    if (mapFactCategory(current.category) !== next.category) patch.category = next.category;
    if (Object.keys(patch).length) toUpdate.push({ item: current, patch });
  });

  const toDelete = existing.filter((item) => !matchedExisting.has(item.id));
  const toAdd = parsed.filter((item, index) => !matchedParsed.has(index));

  if (!toDelete.length && !toAdd.length && !toUpdate.length) { showToast("info", "変更はありませんでした。"); return; }
  if (!confirm(`更新${toUpdate.length}件・削除${toDelete.length}件・追加${toAdd.length}件を反映します。よろしいですか？`)) return;

  let deletedCount = 0;
  let addedCount = 0;
  let updatedCount = 0;
  const errors = [];
  for (const { item, patch } of toUpdate) {
    const data = await requestJson(`/api/research/facts/${encodeURIComponent(item.id)}?project=${encodeURIComponent(project.path)}`, { method: "PATCH", body: { project: project.path, patch } });
    if (data.ok) updatedCount += 1;
    else errors.push(`更新失敗: ${clip(item.content, 40)}（${data.message || ""}）`);
  }
  for (const item of toAdd) {
    const data = await post("/api/research/facts", {
      project: project.path,
      productId,
      title: clip(item.content, 60) || "\u4e8b\u5b9f",
      content: item.content,
      category: item.category,
      sourceType: "manual",
      confidenceScore: 0.7
    });
    if (data.ok) addedCount += 1;
    else errors.push(`\u8ffd\u52a0\u5931\u6557: ${clip(item.content, 40)}\uff08${data.message || ""}\uff09`);
  }
  if (!errors.length) {
    for (const item of toDelete) {
      const data = await requestJson(`/api/research/facts/${encodeURIComponent(item.id)}?project=${encodeURIComponent(project.path)}`, { method: "DELETE" });
      if (data.ok) deletedCount += 1;
      else errors.push(`\u524a\u9664\u5931\u6557: ${clip(item.content, 40)}\uff08${data.message || ""}\uff09`);
    }
  } else if (toDelete.length) {
    errors.push("更新または追加に失敗したため、既存事実の削除は中止しました。");
  }

  await loadResearch();
  renderResearch();
  if (errors.length) {
    writeTerminal("error", errors.join("\n"));
    showToast("error", `一部の反映に失敗しました（更新${updatedCount}件・削除${deletedCount}件・追加${addedCount}件は成功）。詳細はターミナルログを確認してください。`);
  } else {
    writeTerminal("system", `事実DBをエディタから更新しました。更新${updatedCount}件・削除${deletedCount}件・追加${addedCount}件。`);
    showToast("success", `事実DBを更新しました。更新${updatedCount}件・削除${deletedCount}件・追加${addedCount}件。`);
  }
}

// ---- \u8868\u73fe\u30ec\u30ae\u30e5\u30ec\u30fc\u30b7\u30e7\u30f3DB: \u30a8\u30c7\u30a3\u30bf\u8868\u793a + \u30d5\u30a1\u30a4\u30eb\u53d6\u308a\u8fbc\u307f ----
// NG\u7cfb\u30eb\u30fc\u30eb(ng_word/ng_expression)\u306f\u300c- NG: \u30d1\u30bf\u30fc\u30f3 => \u7f6e\u63db | \u5099\u8003\u300d\u3001
// \u305d\u308c\u4ee5\u5916(preferred_expression/legal_disclaimer/tone_rule/image_rule)\u306f\u300c- \u6307\u5b9a: \u5185\u5bb9\u300d\u3067\u8868\u793a\u3059\u308b\u3002
function isNgRuleType(ruleType) {
  const type = String(ruleType || "").toLowerCase();
  return type === "ng_word" || type === "ng_expression";
}

function renderRulesEditor() {
  // 1案件1商品: エディタは常に唯一の商品(research.products[0])を対象に固定する。
  rulesEditorProductId = research.products[0]?.id || "";
  const textarea = $("#rulesEditorTextarea");
  if (!textarea) return;
  const rules = (research.expressionRules || []).filter((item) => item.productId === rulesEditorProductId);
  textarea.value = rules.map(ruleToEditorLine).join("\n");
}

function ruleToEditorLine(rule) {
  if (isNgRuleType(rule.ruleType)) {
    let line = `- NG: ${String(rule.pattern || "").trim()}`;
    if (rule.replacement) line += ` => ${String(rule.replacement).trim()}`;
    if (rule.description) line += ` | ${String(rule.description).replace(/\r?\n/g, " ").trim()}`;
    return line;
  }
  const content = String(rule.description || rule.pattern || "").replace(/\r?\n/g, " ").trim();
  return `- \u6307\u5b9a: ${content}`;
}

function parseRuleEditorLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) return null;
  const withoutBullet = trimmed.replace(/^[-\u30fb]\s*/, "");
  const ngMatch = withoutBullet.match(/^NG\s*[:\uff1a]\s*(.*)$/i);
  if (ngMatch) {
    let rest = ngMatch[1];
    let description = "";
    const pipeIndex = rest.indexOf("|");
    if (pipeIndex >= 0) { description = rest.slice(pipeIndex + 1).trim(); rest = rest.slice(0, pipeIndex); }
    let replacement = "";
    const arrowIndex = rest.indexOf("=>");
    if (arrowIndex >= 0) { replacement = rest.slice(arrowIndex + 2).trim(); rest = rest.slice(0, arrowIndex); }
    const pattern = rest.trim();
    if (!pattern) return null;
    return { kind: "ng", ruleType: "ng_expression", pattern, replacement, description };
  }
  const specMatch = withoutBullet.match(/^\u6307\u5b9a\s*[:\uff1a]\s*(.*)$/);
  const content = (specMatch ? specMatch[1] : withoutBullet).trim();
  if (!content) return null;
  return { kind: "spec", ruleType: "tone_rule", pattern: "", replacement: "", description: content };
}

function ruleEditorKey(item) {
  return item.kind === "ng" ? `ng:${normalizeEditorText(item.pattern)}` : `spec:${normalizeEditorText(item.description || item.pattern || "")}`;
}

function ruleEditorKeyForRow(rule) {
  return isNgRuleType(rule.ruleType) ? `ng:${normalizeEditorText(rule.pattern)}` : `spec:${normalizeEditorText(rule.description || rule.pattern || "")}`;
}

async function saveRulesEditor() {
  const project = selectedProject();
  const productId = rulesEditorProductId || research.products[0]?.id || "";
  const textarea = $("#rulesEditorTextarea");
  if (!project || !textarea) return;

  const existing = (research.expressionRules || []).filter((item) => item.productId === productId);
  const seenKeys = new Set();
  const parsed = [];
  for (const line of textarea.value.split("\n")) {
    const item = parseRuleEditorLine(line);
    if (!item) continue;
    const key = ruleEditorKey(item);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    parsed.push(item);
  }

  const parsedKeys = new Set(parsed.map(ruleEditorKey));
  const existingKeys = new Set(existing.map(ruleEditorKeyForRow));
  const toDelete = existing.filter((item) => !parsedKeys.has(ruleEditorKeyForRow(item)));
  const toAdd = parsed.filter((item) => !existingKeys.has(ruleEditorKey(item)));

  if (!toDelete.length && !toAdd.length) { showToast("info", "\u5909\u66f4\u306f\u3042\u308a\u307e\u305b\u3093\u3067\u3057\u305f\u3002"); return; }
  if (!confirm(`\u524a\u9664${toDelete.length}\u4ef6\u30fb\u8ffd\u52a0${toAdd.length}\u4ef6\u3092\u53cd\u6620\u3057\u307e\u3059\u3002\u3088\u308d\u3057\u3044\u3067\u3059\u304b\uff1f`)) return;

  let deletedCount = 0;
  let addedCount = 0;
  const errors = [];
  for (const item of toDelete) {
    const data = await requestJson(`/api/research/expression-rules/${encodeURIComponent(item.id)}?project=${encodeURIComponent(project.path)}`, { method: "DELETE" });
    if (data.ok) deletedCount += 1;
    else errors.push(`\u524a\u9664\u5931\u6557: ${clip(item.pattern || item.description, 40)}\uff08${data.message || ""}\uff09`);
  }
  for (const item of toAdd) {
    const data = await post("/api/research/expression-rules", {
      project: project.path,
      productId,
      ruleType: item.ruleType,
      pattern: item.pattern || "",
      replacement: item.replacement || "",
      description: item.description || "",
      severity: "medium",
      active: true
    });
    if (data.ok) addedCount += 1;
    else errors.push(`\u8ffd\u52a0\u5931\u6557: ${clip(item.pattern || item.description, 40)}\uff08${data.message || ""}\uff09`);
  }

  await loadResearch();
  renderResearch();
  if (errors.length) {
    writeTerminal("error", errors.join("\n"));
    showToast("error", `\u4e00\u90e8\u306e\u53cd\u6620\u306b\u5931\u6557\u3057\u307e\u3057\u305f\uff08\u524a\u9664${deletedCount}\u4ef6\u30fb\u8ffd\u52a0${addedCount}\u4ef6\u306f\u6210\u529f\uff09\u3002\u8a73\u7d30\u306f\u30bf\u30fc\u30df\u30ca\u30eb\u30ed\u30b0\u3092\u78ba\u8a8d\u3057\u3066\u304f\u3060\u3055\u3044\u3002`);
  } else {
    writeTerminal("system", `\u8868\u73fe\u30ec\u30ae\u30e5\u30ec\u30fc\u30b7\u30e7\u30f3\u3092\u30a8\u30c7\u30a3\u30bf\u304b\u3089\u66f4\u65b0\u3057\u307e\u3057\u305f\u3002\u524a\u9664${deletedCount}\u4ef6\u30fb\u8ffd\u52a0${addedCount}\u4ef6\u3002`);
    showToast("success", `\u8868\u73fe\u30ec\u30ae\u30e5\u30ec\u30fc\u30b7\u30e7\u30f3\u3092\u66f4\u65b0\u3057\u307e\u3057\u305f\u3002\u524a\u9664${deletedCount}\u4ef6\u30fb\u8ffd\u52a0${addedCount}\u4ef6\u3002`);
  }
}

// \u8868\u73fe\u30ec\u30ae\u30e5\u30ec\u30fc\u30b7\u30e7\u30f3 \u30a8\u30c7\u30a3\u30bf\u3078\u306e\u30d5\u30a1\u30a4\u30eb\u53d6\u308a\u8fbc\u307f\u3002
// PDF/Excel/Word/\u30c6\u30ad\u30b9\u30c8/\u753b\u50cf\u3092\u30b5\u30fc\u30d0\u30fc\u5074(/api/research/import-file)\u3067\u6587\u5b57\u8d77\u3053\u3057\u3057\u3001
// \u305d\u306e\u751f\u30c6\u30ad\u30b9\u30c8\u3092/api/regulations/extract-text\u3067AI\u62bd\u51fa\u3057(\u8868\u73fe\u30ec\u30ae\u30e5\u30ec\u30fc\u30b7\u30e7\u30f3\u4ee5\u5916\u306e\u5185\u5bb9\u304c\u6df7\u3056\u3063\u3066\u3044\u3066\u3082OK)\u3001
// \u65e2\u5b58\u306eruleToEditorLine\u3067\u30a8\u30c7\u30a3\u30bf\u884c\u5f62\u5f0f\u306b\u5909\u63db\u3057\u3066\u8ffd\u8a18\u3059\u308b(\u4fdd\u5b58\u306f\u30e6\u30fc\u30b6\u30fc\u304c\u624b\u52d5\u3067\u5b9f\u884c)\u3002
async function handleRegulationImportFile(event) {
  const input = event.target;
  const file = input.files && input.files[0];
  input.value = "";
  if (!file) return;

  const project = selectedProject();
  if (!project) return;
  const textarea = $("#rulesEditorTextarea");
  if (!textarea) return;

  const key = `rulesImportFile:${project.path}`;
  await runExclusive(key, $("#importRegulationsFile"), async () => {
    writeTerminal("cmd", "\u8868\u73fe\u30ec\u30ae\u30e5\u30ec\u30fc\u30b7\u30e7\u30f3 \u30d5\u30a1\u30a4\u30eb\u53d6\u308a\u8fbc\u307f");
    let dataBase64;
    try {
      dataBase64 = await fileToBase64(file);
    } catch (error) {
      showToast("error", error.message || "\u30d5\u30a1\u30a4\u30eb\u306e\u8aad\u307f\u8fbc\u307f\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002");
      return;
    }
    const data = await post("/api/research/import-file", {
      project: project.path,
      fileName: file.name,
      mimeType: file.type || "",
      dataBase64
    });
    if (!data.ok) {
      writeTerminal("error", JSON.stringify(data, null, 2));
      showToast("error", data.message || "\u53d6\u308a\u8fbc\u307f\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002");
      return;
    }
    const text = String(data.text || "").trim();
    if (!text) {
      showToast("info", "\u6587\u5b57\u3092\u62bd\u51fa\u3067\u304d\u307e\u305b\u3093\u3067\u3057\u305f\uff08\u753b\u50cf\u306e\u307f\u306ePDF\u7b49\u306e\u53ef\u80fd\u6027\u304c\u3042\u308a\u307e\u3059\uff09\u3002");
      return;
    }
    writeTerminal("system", `\u30d5\u30a1\u30a4\u30eb\u304b\u3089\u6587\u5b57\u8d77\u3053\u3057\u3092\u53d6\u5f97\u3057\u307e\u3057\u305f\uff08${file.name} / ${data.method || ""}\uff09\u3002AI\u3067\u8868\u73fe\u30ec\u30ae\u30e5\u30ec\u30fc\u30b7\u30e7\u30f3\u3092\u62bd\u51fa\u3057\u307e\u3059...`);
    let extracted;
    try {
      extracted = await post("/api/regulations/extract-text", { text });
    } catch (error) {
      showToast("error", error.message || "AI\u62bd\u51fa\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002");
      return;
    }
    if (!extracted || !extracted.ok) {
      writeTerminal("error", JSON.stringify(extracted, null, 2));
      showToast("error", (extracted && extracted.message) || "AI\u306b\u3088\u308b\u8868\u73fe\u30ec\u30ae\u30e5\u30ec\u30fc\u30b7\u30e7\u30f3\u306e\u62bd\u51fa\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002");
      return;
    }
    const rules = Array.isArray(extracted.rules) ? extracted.rules : [];
    if (!rules.length) {
      showToast("info", "AI\u306f\u8868\u73fe\u30ec\u30ae\u30e5\u30ec\u30fc\u30b7\u30e7\u30f3\u3092\u62bd\u51fa\u3067\u304d\u307e\u305b\u3093\u3067\u3057\u305f\u3002");
      return;
    }
    const productId = rulesEditorProductId || research.products[0]?.id || "";
    const knownKeys = new Set(
      (research.expressionRules || [])
        .filter((item) => item.productId === productId)
        .map(ruleEditorKeyForRow)
    );
    const uniqueRules = rules.filter((rule) => {
      const key = ruleEditorKeyForRow(rule);
      if (knownKeys.has(key)) return false;
      knownKeys.add(key);
      return true;
    });
    const saved = [];
    const errors = [];
    for (const rule of uniqueRules) {
      const result = await post("/api/research/expression-rules", {
        project: project.path,
        productId,
        ruleType: rule.ruleType || "ng_expression",
        pattern: rule.pattern || "",
        replacement: rule.replacement || "",
        description: rule.description || "",
        severity: rule.severity || "medium",
        active: rule.active !== false
      });
      if (result.ok) saved.push(result.rule || rule);
      else errors.push(result.message || rule.pattern || rule.description || "\u4fdd\u5b58\u306b\u5931\u6557\u3057\u307e\u3057\u305f");
    }
    await loadResearch();
    renderResearch();
    setRulesViewMode("editor");
    const refreshedTextarea = $("#rulesEditorTextarea");
    if (refreshedTextarea) {
      refreshedTextarea.scrollTop = refreshedTextarea.scrollHeight;
      refreshedTextarea.focus({ preventScroll: true });
    }
    const lines = saved.map(ruleToEditorLine);
    const duplicateCount = rules.length - uniqueRules.length;
    writeTerminal("system", `AI\u304c\u8868\u73fe\u30ec\u30ae\u30e5\u30ec\u30fc\u30b7\u30e7\u30f3\u3092${rules.length}\u4ef6\u62bd\u51fa\u3057\u3001${saved.length}\u4ef6\u3092\u4fdd\u5b58\u3057\u307e\u3057\u305f\uff08${file.name}\uff09\u3002\n${lines.join("\n")}`);
    if (errors.length) {
      writeTerminal("error", errors.join("\n"));
      showToast("error", `${saved.length}\u4ef6\u3092\u4fdd\u5b58\u3057\u307e\u3057\u305f\u304c\u3001${errors.length}\u4ef6\u306e\u4fdd\u5b58\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002`);
    } else if (!saved.length && duplicateCount) {
      showToast("info", `\u62bd\u51fa\u3057\u305f${rules.length}\u4ef6\u306f\u3059\u3079\u3066\u767b\u9332\u6e08\u307f\u3067\u3059\u3002`);
    } else {
      showToast("success", `\u8868\u73fe\u30ec\u30ae\u30e5\u30ec\u30fc\u30b7\u30e7\u30f3\u3092${saved.length}\u4ef6\u53d6\u308a\u8fbc\u307f\u3001\u4fdd\u5b58\u3057\u307e\u3057\u305f\u3002${duplicateCount ? `\uff08\u767b\u9332\u6e08\u307f${duplicateCount}\u4ef6\u3092\u9664\u5916\uff09` : ""}`);
    }
  });
}

function renderStrategies() {
  const target = $("#strategies");
  if (!target) return;
  target.innerHTML = "";
  let strategies = research.strategies || [];
  if (strategyProductFilter) strategies = strategies.filter((item) => item.productId === strategyProductFilter);
  if (!showArchivedStrategies) strategies = strategies.filter((item) => item.status !== "archived");
  if (!strategies.length) {
    target.appendChild(emptyTableRow(5, "事実がたまったら戦略を生成しましょう。", "戦略生成", () => $("#runWhoWhat")?.click()));
  }
  if (strategyProductFilter) {
    for (const strategy of strategies) target.appendChild(strategyRow(strategy));
  } else {
    const groups = new Map();
    for (const strategy of strategies) {
      const key = strategy.productId || "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(strategy);
    }
    const orderedKeys = [...research.products.map((product) => product.id), ...[...groups.keys()].filter((key) => !research.products.some((product) => product.id === key))];
    for (const key of orderedKeys) {
      const items = groups.get(key);
      if (!items || !items.length) continue;
      const product = research.products.find((item) => item.id === key);
      target.appendChild(strategyGroupHeaderRow(product?.name || "\u5546\u54c1\u672a\u9078\u629e", items.length));
      for (const strategy of items) target.appendChild(strategyRow(strategy));
    }
  }
  renderAddPanel("strategiesAddPanel", "戦略\u3092\u8ffd\u52a0", strategyInputRow);
}

function strategyGroupHeaderRow(label, count) {
  const tr = document.createElement("tr");
  tr.className = "groupHeaderRow";
  tr.innerHTML = `<td colspan="5">${escapeHtml(label)}<span class="groupHeaderCount">${count}\u4ef6</span></td>`;
  return tr;
}

// 旧WHO-WHATの構造化フィールド(targetAttributes/desire/benefit/productConcept/usp/offer)を
// 簡易の本文に連結する。markdown未保存の手動追加戦略などで主表示セルのフォールバックとして使う。
function composeStrategyProse(strategy) {
  const parts = [
    strategy?.conceptName,
    strategy?.targetAttributes || strategy?.desire,
    strategy?.benefit || strategy?.productConcept || strategy?.usp,
    strategy?.offer
  ].filter(Boolean);
  return parts.join("\n");
}

function strategyRow(strategy) {
  const product = research.products.find((item) => item.id === strategy.productId);
  const isArchived = strategy.status === "archived";
  const proseText = strategy.markdown || composeStrategyProse(strategy);
  const tr = row([
    relationCellHtml("strategy", strategy.id, "productId", strategy.productId || "", product?.name || "\u672a\u9078\u629e", "productRelation"),
    editableCellHtml("strategy", strategy.id, "conceptName", strategy.conceptName || "戦略\u4eee\u8aac"),
    editableCellHtml("strategy", strategy.id, "markdown", clip(stripMarkdownForPreview(proseText), 220), { kind: "textarea", rawValue: proseText }),
    statusSelectHtml("strategy", strategy.id, "status", strategy.status || "proposed", STRATEGY_STATUS_OPTIONS),
    ""
  ], "strategy", strategy, true);
  if (isArchived) tr.classList.add("archivedRow");
  const actionCell = tr.lastElementChild;
  actionCell.appendChild(rowActionButton("編集", () => {
    selectItem("strategy", strategy, { strategyMode: "edit" });
  }));
  if (isArchived) {
    const restoreButton = document.createElement("button");
    restoreButton.type = "button";
    restoreButton.className = "tableButton";
    restoreButton.textContent = "\u623b\u3059";
    restoreButton.addEventListener("click", async (event) => {
      event.stopPropagation();
      await updateTableRow("strategy", strategy.id, { status: "proposed" });
      showToast("success", "戦略\u3092\u63d0\u6848\u4e2d\u306b\u623b\u3057\u307e\u3057\u305f\u3002");
    });
    actionCell.appendChild(restoreButton);
  } else {
    const archiveButton = document.createElement("button");
    archiveButton.type = "button";
    archiveButton.className = "tableButton";
    archiveButton.textContent = "\u30a2\u30fc\u30ab\u30a4\u30d6";
    archiveButton.addEventListener("click", async (event) => {
      event.stopPropagation();
      await updateTableRow("strategy", strategy.id, { status: "archived" });
      showToast("success", "戦略\u3092\u30a2\u30fc\u30ab\u30a4\u30d6\u3057\u307e\u3057\u305f\u3002");
    });
    actionCell.appendChild(archiveButton);
  }
  actionCell.appendChild(rowDeleteButton("strategy", strategy.id));
  return tr;
}

function stripMarkdownForPreview(value) {
  return String(value || "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\*\*|__/g, "")
    .replace(/^[-*+]\s+/gm, "• ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function markdownInlineHtml(value) {
  return escapeHtml(value).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function limitedMarkdownHtml(value) {
  const lines = String(value || "").replace(/\r/g, "").split("\n");
  const html = [];
  let listOpen = false;
  const closeList = () => {
    if (!listOpen) return;
    html.push("</ul>");
    listOpen = false;
  };
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) { closeList(); continue; }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = heading[1].length <= 2 ? "h3" : "h4";
      html.push("<" + level + ">" + markdownInlineHtml(heading[2]) + "</" + level + ">");
      continue;
    }
    const bullet = line.match(/^[-*+]\s+(.+)$/);
    if (bullet) {
      if (!listOpen) { html.push("<ul>"); listOpen = true; }
      html.push("<li>" + markdownInlineHtml(bullet[1]) + "</li>");
      continue;
    }
    closeList();
    html.push("<p>" + markdownInlineHtml(line) + "</p>");
  }
  closeList();
  return html.join("") || '<p class="structuredTextEmpty">戦略本文がありません。</p>';
}

function strategyInspectorHtml(strategy) {
  const product = research.products.find((item) => item.id === strategy.productId);
  const markdown = strategy.markdown || composeStrategyProse(strategy);
  const statusOptions = STRATEGY_STATUS_OPTIONS.map((value) => '<option value="' + escapeAttr(value) + '"' + (value === strategy.status ? " selected" : "") + '>' + escapeHtml(displayValue(value)) + '</option>').join("");
  return '<div class="strategyInspector" data-strategy-id="' + escapeAttr(strategy.id) + '">'
    + '<div class="contentModeTabs" role="tablist" aria-label="戦略の表示切替">'
    + '<button class="contentModeTab' + (strategyDetailMode === "preview" ? ' active' : '') + '" type="button" role="tab" data-strategy-content-mode="preview" aria-selected="' + (strategyDetailMode === "preview") + '">プレビュー</button>'
    + '<button class="contentModeTab' + (strategyDetailMode === "edit" ? ' active' : '') + '" type="button" role="tab" data-strategy-content-mode="edit" aria-selected="' + (strategyDetailMode === "edit") + '">編集</button>'
    + '</div>'
    + '<div class="strategyPreviewPanel structuredTextPreview markdownPreview"' + (strategyDetailMode === "preview" ? '' : ' hidden') + '>' + limitedMarkdownHtml(markdown) + '</div>'
    + '<form class="strategyInlineEdit"' + (strategyDetailMode === "edit" ? '' : ' hidden') + '>'
    + '<div class="strategyInlineMeta"><label><span>商品</span><input class="tableInput" value="' + escapeAttr(product?.name || "未選択") + '" disabled /></label><label><span>状態</span><select class="tableSelect" data-strategy-inline-status>' + statusOptions + '</select></label></div>'
    + '<label><span>戦略コンセプト</span><input class="tableInput" data-strategy-inline-concept value="' + escapeAttr(strategy.conceptName || "") + '" /></label>'
    + '<label><span>戦略本文</span><textarea class="tableInput strategyInlineMarkdown" data-strategy-inline-markdown spellcheck="false">' + escapeHtml(markdown) + '</textarea></label>'
    + '<p class="strategySourceNote">この戦略本文がバナー生成に使われます。</p>'
    + '<button class="inlineAddButton" type="submit">変更を保存</button>'
    + '</form></div>';
}

function bindStrategyInspector(root, strategy) {
  if (!root || !strategy?.id) return;
  for (const button of root.querySelectorAll("[data-strategy-content-mode]")) {
    button.addEventListener("click", () => {
      strategyDetailMode = button.dataset.strategyContentMode === "edit" ? "edit" : "preview";
      if (strategyDetailMode === "preview") {
        const markdown = root.querySelector("[data-strategy-inline-markdown]")?.value || "";
        const preview = root.querySelector(".strategyPreviewPanel");
        if (preview) preview.innerHTML = limitedMarkdownHtml(markdown);
      }
      root.querySelector(".strategyPreviewPanel").hidden = strategyDetailMode !== "preview";
      root.querySelector(".strategyInlineEdit").hidden = strategyDetailMode !== "edit";
      for (const tab of root.querySelectorAll("[data-strategy-content-mode]")) {
        const active = tab.dataset.strategyContentMode === strategyDetailMode;
        tab.classList.toggle("active", active);
        tab.setAttribute("aria-selected", String(active));
      }
    });
  }
  root.querySelector(".strategyInlineEdit")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const conceptName = root.querySelector("[data-strategy-inline-concept]")?.value.trim() || "";
    if (!conceptName) return showToast("error", "戦略コンセプトを入力してください。");
    const submit = event.currentTarget.querySelector('button[type="submit"]');
    const patch = {
      conceptName,
      markdown: root.querySelector("[data-strategy-inline-markdown]")?.value.trim() || "",
      status: root.querySelector("[data-strategy-inline-status]")?.value || "proposed"
    };
    if (!patch.markdown) return showToast("error", "戦略本文を入力してください。");
    await runExclusive("strategyEdit:" + strategy.id, submit, async () => {
      strategyDetailMode = "preview";
      const data = await updateTableRow("strategy", strategy.id, patch);
      showToast(data?.ok ? "success" : "error", data?.ok ? "戦略を更新しました。" : (data?.message || "戦略の保存に失敗しました。"));
    });
  });
}

function renderBanners() {
  const target = $("#banners");
  if (!target) return;
  target.innerHTML = "";
  const addTr = document.createElement("tr");
  addTr.className = "addPromptRow";
  addTr.innerHTML = '<td colspan="16"><button class="addRowButton" type="button"><span aria-hidden="true">+</span> バナー案を追加</button></td>';
  addTr.querySelector("button").addEventListener("click", openBannerAddModal);
  // 常設の追加行はデータがある時だけ表示。空の時は空状態のボタン1つだけにして重複を防ぐ。
  if ((research.banners || []).length) target.appendChild(addTr);
  if (!(research.banners || []).length) {
    target.appendChild(emptyTableRow(15, "まだバナー案がありません。「+ バナー案を追加」から作成しましょう。", "+ バナー案を追加", openBannerAddModal));
  }
  for (const banner of research.banners || []) {
    const product = research.products.find((item) => item.id === banner.productId);
    const strategy = (research.strategies || []).find((item) => item.id === banner.strategyId);
    const template = (research.adTemplates || []).find((item) => item.id === banner.templateAdId);
    const image = banner.generatedImagePath ? imageCellHtml(banner.generatedImagePath) : (banner.images?.[0] ? imageCellHtml(banner.images[0]) : bannerGenerationPlaceholderHtml(banner));
    const templateImage = template?.imageFile ? imageCellHtml(template.imageFile) : '<span class="mutedCell">未選択</span>';
    const tr = row([
      editableCellHtml("banner", banner.id, "title", banner.title || "\u30d0\u30ca\u30fc\u6848"),
      relationCellHtml("banner", banner.id, "strategyId", banner.strategyId || "", strategy?.conceptName || "\u672a\u9078\u629e", "strategyRelation"),
      relationCellHtml("banner", banner.id, "templateAdId", banner.templateAdId || "", template?.title || "\u672a\u9078\u629e", "adTemplateRelation"),
      templateImage,
      statusSelectHtml("banner", banner.id, "productionStatus", bannerListProductionStatus(banner.productionStatus), BANNER_PRODUCTION_STATUS_OPTIONS) + bannerAuditWarningHtml(banner),
      statusSelectHtml("banner", banner.id, "imageGenerationStatus", banner.imageGenerationStatus || "not_started", IMAGE_STATUS_OPTIONS),
      image,
      relationCellHtml("banner", banner.id, "productId", banner.productId || "", product?.name || "\u672a\u9078\u629e", "productRelation"),
      relationCellHtml("banner", banner.id, "productImagePath", banner.productImagePath || "", productImageLabel(product, banner.productImagePath) || "\u4f7f\u308f\u306a\u3044", "productImageRelation"),
      relationCellHtml("banner", banner.id, "logoImagePath", banner.logoImagePath || "", productImageLabel(product, banner.logoImagePath) || "\u4f7f\u308f\u306a\u3044", "productLogoRelation"),
      editableCellHtml("banner", banner.id, "additionalInstruction", clip(banner.additionalInstruction, 80), { kind: "textarea" }),
      editableCellHtml("banner", banner.id, "imageText", clip(banner.imageText, 90), { kind: "textarea" }),
      banner.promptText ? editableCellHtml("banner", banner.id, "promptText", clip(banner.promptText, 90), { kind: "textarea" }) : '<span class="mutedCell">' + escapeHtml(clip(JSON.stringify(banner.promptJson || {}), 90)) + '</span>',
      editableCellHtml("banner", banner.id, "revisionInstruction", clip(banner.revisionInstruction, 80), { kind: "textarea" }),
      ""
    ], "banner", banner, true);
    const actionCell = tr.lastElementChild;
    actionCell.appendChild(runningActionButton(bannerGenerateActionLabel(banner), "bannerImage", banner.id, (btn) => generateBannerFull(banner.id, btn), isBannerImageBusy(banner)));
    actionCell.appendChild(rowDeleteButton("banner", banner.id));
    target.appendChild(tr);
  }
}

function bannerLastErrorNoteHtml(banner) {
  if (!banner?.lastError) return "";
  return '<div class="lastErrorNote" title="' + escapeAttr(banner.lastError) + '">失敗: ' + escapeHtml(clip(banner.lastError, 60)) + '</div>';
}

const BANNER_STALE_RUNNING_MS = 15 * 60 * 1000;
const BANNER_STALE_QUEUED_MS = 90 * 60 * 1000;

function isBannerJobStale(banner) {
  const active = banner?.imageGenerationStatus === "queued"
    || banner?.imageGenerationStatus === "generating"
    || ["prompt_queued", "prompt_generating", "generating", "revising"].includes(banner?.productionStatus);
  if (!active) return false;
  const lease = ["queued", "generating"].includes(banner.imageGenerationStatus)
    ? banner.imageGenerationLease
    : banner.promptGenerationLease;
  const leaseExpiresAt = Date.parse(lease?.expiresAt || "");
  if (Number.isFinite(leaseExpiresAt)) return Date.now() > leaseExpiresAt;
  const updatedAt = Date.parse(banner.updatedAt || "");
  if (!Number.isFinite(updatedAt)) return false;
  const queued = banner.imageGenerationStatus === "queued" || banner.productionStatus === "prompt_queued";
  return Date.now() - updatedAt > (queued ? BANNER_STALE_QUEUED_MS : BANNER_STALE_RUNNING_MS);
}

function isBannerImageBusy(banner) {
  return !isBannerJobStale(banner) && (["queued", "generating"].includes(banner?.imageGenerationStatus)
    || ["prompt_queued", "prompt_generating", "generating", "revising"].includes(banner?.productionStatus));
}

function bannerImageOperationKind(banner) {
  return banner?.imageGenerationLease?.operationKind === "edit" ? "edit" : "generate";
}

function bannerImageEditLabel(banner) {
  const editMode = banner?.imageGenerationLease?.editMode;
  if (editMode === "full") return "全体修正";
  if (editMode === "range") return "範囲指定修正";
  return "画像修正";
}

function bannerGenerateActionLabel(banner) {
  if (isBannerJobStale(banner)) return "生成を再開";
  if (banner?.imageGenerationStatus === "queued" || banner?.productionStatus === "prompt_queued") {
    return bannerImageOperationKind(banner) === "edit" ? bannerImageEditLabel(banner) + "待ち" : "待機中";
  }
  if (banner?.imageGenerationStatus === "generating" || banner?.productionStatus === "prompt_generating") {
    return bannerImageOperationKind(banner) === "edit" ? bannerImageEditLabel(banner) + "中" : "生成中";
  }
  if ([
    "failed",
    "needs_revision",
    "hypothesis_contract_failed",
    "copy_review_failed",
    "copy_communication_failed",
    "template_message_fit_failed",
    "originality_review_failed",
    "copy_review_error",
    "strategy_input_insufficient",
    "template_not_ready"
  ].includes(banner?.productionStatus) || banner?.imageGenerationStatus === "failed") return "再生成";
  return banner?.imageGenerationStatus === "completed" ? "再生成" : "画像生成";
}

function bannerAuditWarningHtml(banner) {
  if (banner?.productionStatus === "needs_copy_visual_review") {
    return '<div class="factCheckWarning">確認が必要</div>';
  }
  const needsRegeneration = [
    "failed",
    "hypothesis_contract_failed",
    "copy_review_failed",
    "copy_communication_failed",
    "template_message_fit_failed",
    "originality_review_failed",
    "copy_review_error",
    "strategy_input_insufficient",
    "template_not_ready"
  ].includes(banner?.productionStatus)
    || banner?.imageGenerationStatus === "failed"
    || banner?.strategyCheck?.status === "warning"
    || banner?.copyQualityReview?.status === "failed"
    || banner?.originalityReview?.status === "failed";
  return needsRegeneration ? '<div class="factCheckWarning">再生成が必要</div>' : "";
}

function bannerListProductionStatus(value) {
  return value === "completed_with_warnings" ? "completed" : (value || "not_started");
}

function bannerWarningLabel(warning) {
  const labels = {
    ocr_mismatch: "画像内コピー不一致",
    copy_selfcheck_unresolved: "コピー自己チェック未解決",
    copy_gate_length: "文字数超過",
    copy_gate_slot: "スロット欠落",
    copy_gate_ng_word: "NGワード",
    copyplan_retry: "コピー設計リトライ",
    image_generation: "画像生成"
  };
  const type = String(warning?.type || "").trim();
  return labels[type] || (type ? type : "警告");
}

function bannerWarningsDetailHtml(banner) {
  const warnings = Array.isArray(banner?.warnings) ? banner.warnings : [];
  if (!warnings.length) return "";
  const lines = warnings.map((item) => {
    const stage = item?.stage ? `[${item.stage}] ` : "";
    return stage + bannerWarningLabel(item) + (item?.message ? " — " + item.message : "");
  });
  return outputReviewBlockHtml("警告", lines.join("\n"), { readable: true });
}

function bannerPipelineTimingHtml(banner) {
  const nodes = banner?.pipelineNodes && typeof banner.pipelineNodes === "object" ? banner.pipelineNodes : null;
  if (!nodes) return "";
  const labels = { copyplan: "コピー設計", prompt: "プロンプト", image: "画像" };
  const parts = ["copyplan", "prompt", "image"].map((node) => {
    const durationMs = Number(nodes[node]?.durationMs);
    if (!Number.isFinite(durationMs) || durationMs <= 0) return "";
    return labels[node] + " " + Math.round(durationMs / 1000) + "秒";
  }).filter(Boolean);
  if (!parts.length) return "";
  return outputReviewBlockHtml("生成所要時間", parts.join(" / "));
}

function renderBannerCards() {
  const target = $("#bannerCards");
  if (!target) return;
  target.innerHTML = "";
  const addCard = document.createElement("button");
  addCard.type = "button";
  addCard.className = "bannerCardAdd";
  addCard.innerHTML = '<span aria-hidden="true">＋</span> バナー案を追加';
  addCard.addEventListener("click", openBannerAddModal);
  if (!(research.banners || []).length) {
    target.innerHTML = emptyStateHtml("バナー案がまだありません", "「＋ バナー案を追加」から作成すると、ここにカードで表示されます。");
    target.appendChild(addCard);
    return;
  }
  applyBannerCardSize();
  for (const banner of research.banners || []) {
    const product = research.products.find((item) => item.id === banner.productId);
    const strategy = (research.strategies || []).find((item) => item.id === banner.strategyId);
    const template = (research.adTemplates || []).find((item) => item.id === banner.templateAdId);
    const image = banner.generatedImagePath || banner.images?.[0] || "";
    const hasFailed = ["failed", "hypothesis_contract_failed", "copy_review_failed", "copy_communication_failed", "template_message_fit_failed", "originality_review_failed", "copy_review_error"].includes(banner.productionStatus) || banner.imageGenerationStatus === "failed";
    const card = document.createElement("div");
    card.className = "bannerCard" + (bannerCardTextMode ? " bannerCardMinimal" : "");
    if (bannerCardTextMode) {
      const failDot = hasFailed ? '<span class="bannerCardFailDot" title="再生成が必要"></span>' : '';
      card.innerHTML = '<div class="bannerCardThumb">' + (image ? imageCellHtml(image) : bannerGenerationPlaceholderHtml(banner)) + failDot + '</div>'
        + '<div class="bannerCardBody"><h4 class="bannerCardTitleClamp">' + escapeHtml(banner.title || "バナー案") + '</h4></div>';
    } else {
      card.innerHTML = '<div class="bannerCardThumb">' + (image ? imageCellHtml(image) : bannerGenerationPlaceholderHtml(banner)) + '</div>'
        + '<div class="bannerCardBody">'
        + '<h4>' + escapeHtml(banner.title || "バナー案") + '</h4>'
        + '<div class="bannerCardTags">'
        + pill(product?.name || "商品未選択")
        + pill(strategy?.conceptName || "戦略未選択")
        + (banner.variationAxis ? pill(banner.variationAxis) : "")
        + pill(template?.title || "テンプレ未選択")
        + '</div>'
        + '<div class="bannerCardStatus">' + labeledStatusPill("制作", bannerListProductionStatus(banner.productionStatus)) + labeledStatusPill("画像", banner.imageGenerationStatus || "not_started") + '</div>'
        + bannerAuditWarningHtml(banner)
        + '</div>'
        + '<div class="bannerCardActions"></div>';
      const actionsEl = card.querySelector(".bannerCardActions");
      actionsEl.appendChild(runningActionButton(bannerGenerateActionLabel(banner), "bannerImage", banner.id, (btn) => generateBannerFull(banner.id, btn), isBannerImageBusy(banner)));
      actionsEl.appendChild(rowDeleteButton("banner", banner.id));
    }
    card.addEventListener("click", (event) => {
      if (event.target.closest("button, input, select, textarea, a")) return;
      selectItem("banner", banner);
    });
    makeCardKeyboardAccessible(card, banner);
    target.appendChild(card);
  }
  target.insertBefore(addCard, target.firstChild);
}

function bannerGenerationPlaceholderHtml(banner) {
  if (isBannerJobStale(banner)) {
    return '<span class="bannerGeneratingPlaceholder isInterrupted"><span>生成が中断しました</span><small>「生成を再開」で再実行できます</small></span>';
  }
  const queued = banner.imageGenerationStatus === "queued" || banner.productionStatus === "prompt_queued";
  const generating = banner.imageGenerationStatus === "generating"
    || ["prompt_generating", "generating", "revising"].includes(banner.productionStatus);
  const isEdit = bannerImageOperationKind(banner) === "edit";
  if (queued) {
    const label = isEdit
      ? "修正待ち"
      : (banner.imageGenerationStatus === "queued" ? "画像生成待ち" : "コピー設計待ち");
    const hint = isEdit
      ? "バックグラウンドで順次実行します"
      : "コピー設計後、画像生成へ順次進みます";
    return '<span class="bannerGeneratingPlaceholder isQueued"><span>' + label + '</span><small>' + hint + '</small></span>';
  }
  if (!generating) return '<span class="mutedCell">未生成</span>';
  const label = isEdit
    ? "修正中"
    : (banner.imageGenerationStatus === "generating" ? "画像生成中" : "生成準備中");
  return '<span class="bannerGeneratingPlaceholder"><span class="loadingSpinner" aria-hidden="true"></span><span>' + label + '</span></span>';
}

// バナー比較モード(バッチW)。画像が1枚以上あるバナー案だけを横スクロールの列に並べ、
// 列ごとにプレビュー・タイトル/コンセプト・制作ステータス・バージョンサムネを見せる。
// バージョンサムネのクリックは bannerComparePreview にローカル保存するだけで、
// 「この版を使う」ボタン(既存 data-banner-use-version 経由)を押すまでPATCHしない。
function bannerCompareImageList(banner) {
  const generatedImagePath = banner.generatedImagePath || "";
  const images = Array.isArray(banner.images) && banner.images.length
    ? banner.images
    : (generatedImagePath ? [generatedImagePath] : []);
  return { generatedImagePath, images };
}

function renderBannerCompare() {
  const row = $("#bannerCompareRow");
  const countLabel = $("#bannerCompareCount");
  if (!row) return;
  const items = (research.banners || [])
    .filter((banner) => bannerCompareImageList(banner).images.length > 0)
    .slice()
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  if (countLabel) countLabel.textContent = `比較対象 ${items.length}案`;
  row.innerHTML = "";
  if (!items.length) {
    row.innerHTML = emptyStateHtml("画像が完成した案がまだありません", "バナー案で画像を生成すると、ここに並べて比較できます。");
    return;
  }
  for (const banner of items) row.appendChild(compareCardEl(banner));
}

function compareCardEl(banner) {
  const card = document.createElement("div");
  card.className = "compareCard";
  card.dataset.bannerId = banner.id;
  card.innerHTML = compareCardInnerHtml(banner);
  card.addEventListener("click", (event) => {
    if (event.target.closest("button, input, select, textarea, a")) return;
    selectItem("banner", banner);
  });
  makeCardKeyboardAccessible(card, banner);
  return card;
}

function makeCardKeyboardAccessible(card, banner) {
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.setAttribute("aria-label", `${banner.title || "バナー案"}の詳細を開く`);
  card.addEventListener("keydown", (event) => {
    if (!(["Enter", " "].includes(event.key)) || event.target !== card) return;
    event.preventDefault();
    selectItem("banner", banner);
  });
}

function compareCardInnerHtml(banner) {
  const strategy = (research.strategies || []).find((item) => item.id === banner.strategyId);
  const { generatedImagePath, images } = bannerCompareImageList(banner);
  const overridePath = bannerComparePreview.get(banner.id);
  const previewPath = overridePath && images.includes(overridePath) ? overridePath : (generatedImagePath || images[0] || "");
  const titleText = banner.title || "バナー案";
  const galleryItems = images.map((imagePath) => resolveImageSrc(imagePath));
  const galleryJson = escapeAttr(JSON.stringify(galleryItems));
  const previewIndex = Math.max(images.indexOf(previewPath), 0);
  const previewSrc = resolveImageSrc(previewPath);
  const versionItems = images.map((imagePath) => {
    const isSelected = imagePath === previewPath;
    const isCurrent = imagePath === generatedImagePath;
    const src = resolveImageSrc(imagePath);
    const badge = isCurrent ? '<span class="versionCurrentBadge">現行版</span>' : "";
    return '<button type="button" class="creativeVersionThumb' + (isSelected ? ' isCurrent' : '') + '" data-compare-version="' + escapeAttr(banner.id) + '" data-version-path="' + escapeAttr(imagePath) + '">'
      + '<img src="' + escapeAttr(src) + '" alt="" />' + badge
      + '</button>';
  }).join("");
  const useButtonHtml = previewPath && previewPath !== generatedImagePath
    ? '<button type="button" class="tableButton actionMini versionUseButton" data-banner-use-version="' + escapeAttr(banner.id) + '" data-version-path="' + escapeAttr(previewPath) + '">この版を使う</button>'
    : "";
  return '<button type="button" class="compareCardPreview" data-preview-image="' + escapeAttr(previewSrc) + '" data-preview-title="' + escapeAttr(titleText) + '" data-preview-gallery="' + galleryJson + '" data-preview-index="' + previewIndex + '"><img src="' + escapeAttr(previewSrc) + '" alt="" /></button>'
    + '<div class="compareCardBody">'
    + '<h4 class="compareCardTitle">' + escapeHtml(titleText) + '</h4>'
    + '<div class="compareCardTags">' + pill(strategy?.conceptName || "戦略未選択") + '</div>'
    + '<div class="compareCardStatus">' + statusPill(bannerListProductionStatus(banner.productionStatus)) + '</div>'
    + bannerAuditWarningHtml(banner)
    + '<div class="creativeVersionsRow compareVersionsRow">' + versionItems + '</div>'
    + '<div class="compareCardActions">' + useButtonHtml + '</div>'
    + '</div>';
}

// バージョンサムネをクリックした時: その列(カード)だけをローカル状態で再描画する。
// 他のカードのDOMには触れないため、他列のプレビューは不変。
function selectBannerComparePreview(bannerId, imagePath) {
  if (!bannerId || !imagePath) return;
  const banner = (research.banners || []).find((item) => item.id === bannerId);
  if (!banner) return;
  bannerComparePreview.set(bannerId, imagePath);
  const card = $(`#bannerCompareRow .compareCard[data-banner-id="${bannerId}"]`);
  if (card) card.innerHTML = compareCardInnerHtml(banner);
}

// Common empty-state helper for card grids and panels.
function emptyStateHtml(title, subtext) {
  return '<div class="emptyState"><span class="emptyStateIcon" aria-hidden="true">⌕</span><b>' + escapeHtml(title) + '</b><p>' + escapeHtml(subtext) + '</p></div>';
}

// Common "0件" row for <table><tbody> lists: a single spanning row with a
// short guidance sentence and (optionally) a button that leads to the next
// action (switch tab, open a modal, trigger an AI run, ...).
function emptyTableRow(colspan, message, actionLabel, onClick) {
  const tr = document.createElement("tr");
  tr.className = "tableEmptyRow";
  const td = document.createElement("td");
  td.colSpan = colspan;
  const p = document.createElement("p");
  p.textContent = message;
  td.appendChild(p);
  if (actionLabel && onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondaryButton";
    button.textContent = actionLabel;
    button.addEventListener("click", onClick);
    td.appendChild(button);
  }
  tr.appendChild(td);
  return tr;
}

function setBannerViewMode(mode) {
  if (!BANNER_VIEW_MODES.includes(mode)) return;
  bannerViewMode = mode;
  localStorage.setItem(BANNER_VIEW_MODE_KEY, mode);
  const tableWrap = $("#bannersTableWrap");
  const cardGrid = $("#bannerCards");
  const cardControls = $("#bannerCardControls");
  const compareWrap = $("#bannerCompareWrap");
  const compareSizeControls = $("#bannerCompareSizeControls");
  if (tableWrap) tableWrap.hidden = mode !== "table";
  if (cardGrid) cardGrid.hidden = mode !== "cards";
  if (cardControls) cardControls.hidden = mode !== "cards";
  if (compareWrap) compareWrap.hidden = mode !== "compare";
  if (compareSizeControls) compareSizeControls.hidden = mode !== "compare";
  for (const button of $$(".viewModeButton[data-bannerview]")) button.classList.toggle("active", button.dataset.bannerview === mode);
  if (mode === "compare") { applyBannerCompareSize(); renderBannerCompare(); }
}

function setFactsViewMode(mode) {
  factsViewMode = mode;
  const tableWrap = $("#factsTableWrap");
  const editorPanel = $("#factsEditorPanel");
  if (tableWrap) tableWrap.hidden = mode !== "table";
  if (editorPanel) editorPanel.hidden = mode !== "editor";
  for (const button of $$(".viewModeButton[data-factsview]")) button.classList.toggle("active", button.dataset.factsview === mode);
  if (mode === "editor") renderFactsEditor();
}

function setRulesViewMode(mode) {
  rulesViewMode = mode;
  const tableWrap = $("#rulesTableWrap");
  const editorPanel = $("#rulesEditorPanel");
  if (tableWrap) tableWrap.hidden = mode !== "table";
  if (editorPanel) editorPanel.hidden = mode !== "editor";
  for (const button of $$(".viewModeButton[data-rulesview]")) button.classList.toggle("active", button.dataset.rulesview === mode);
  if (mode === "editor") renderRulesEditor();
}

function applyBannerCardSize() {
  const grid = $("#bannerCards");
  if (grid) grid.style.setProperty("--banner-card-min", BANNER_CARD_SIZE_PX[bannerCardSize] || BANNER_CARD_SIZE_PX.medium);
  for (const button of $$(".segmentButton[data-cardsize]")) button.classList.toggle("active", button.dataset.cardsize === bannerCardSize);
}

function setBannerCardSize(size) {
  if (!BANNER_CARD_SIZE_PX[size]) return;
  bannerCardSize = size;
  localStorage.setItem(BANNER_CARD_SIZE_KEY, size);
  applyBannerCardSize();
}

function applyBannerCompareSize() {
  const row = $("#bannerCompareRow");
  if (row) row.style.setProperty("--compare-card-min", BANNER_COMPARE_SIZE_PX[bannerCompareSize] || BANNER_COMPARE_SIZE_PX.standard);
  for (const button of $$(".segmentButton[data-comparesize]")) button.classList.toggle("active", button.dataset.comparesize === bannerCompareSize);
}

function setBannerCompareSize(size) {
  if (!BANNER_COMPARE_SIZE_PX[size]) return;
  bannerCompareSize = size;
  localStorage.setItem(BANNER_COMPARE_SIZE_KEY, size);
  applyBannerCompareSize();
}

function applyBannerCardTextModeUi() {
  const toggle = $("#bannerCardTextModeToggle");
  if (!toggle) return;
  toggle.classList.toggle("active", bannerCardTextMode);
  toggle.setAttribute("aria-pressed", String(bannerCardTextMode));
}

function toggleBannerCardTextMode() {
  bannerCardTextMode = !bannerCardTextMode;
  localStorage.setItem(BANNER_CARD_TEXT_MODE_KEY, bannerCardTextMode ? "1" : "0");
  applyBannerCardTextModeUi();
  renderBannerCards();
}

function renderAdTemplates() {
  renderBannerTemplates();
}

function renderBannerTemplates() {
  const target = $("#adTemplates");
  if (!target) return;
  target.innerHTML = "";
  const templates = (research.adTemplates || []).filter((item) => (item.creativeType || "banner") === "banner");
  if (!templates.length) {
    target.appendChild(emptyTableRow(6, "まだ広告テンプレがありません。参考にしたいバナーを登録してテンプレ化しましょう。"));
  }
  for (const template of templates) {
    const analysisActive = isTemplateAnalysisActive(template);
    const tr = row([
      editableCellHtml("adTemplate", template.id, "title", template.title || "広告テンプレ"),
      statusSelectHtml("adTemplate", template.id, "templateStatus", template.templateStatus || "not_started", TEMPLATE_STATUS_OPTIONS)
        + templateProcessingPill(template.templateProcessingStatus),
      adTemplateImageCellHtml(template),
      editableCellHtml("adTemplate", template.id, template.templateTextStoryboard ? "templateTextStoryboard" : "textStoryboard", clip(template.templateTextStoryboard || template.textStoryboard, 140), { kind: "textarea" }),
      editableCellHtml("adTemplate", template.id, "successFactors", clip(template.successFactors, 100), { kind: "textarea" }),
      ""
    ], "adTemplate", template, true);
    const actionCell = tr.lastElementChild;
    actionCell.appendChild(runningActionButton(analysisActive ? templateProcessingLabel(template.templateProcessingStatus) : "テンプレ化", "templateImage", template.id, (btn) => templateAdImage(template.id, btn), !template.imageFile || analysisActive));
    actionCell.appendChild(rowDeleteButton("adTemplate", template.id));
    target.appendChild(tr);
  }
  renderAddPanel("adTemplatesAddPanel", "バナーをテンプレ化", adTemplateInputRow);
  renderAdTemplateGallery(templates);
  applyAdTemplateViewMode();
}

function renderAdTemplateGallery(templates) {
  const target = $("#adTemplatesGallery");
  if (!target) return;
  target.innerHTML = "";

  if (!templates.length) {
    const empty = document.createElement("p");
    empty.className = "adTemplateGalleryEmpty";
    empty.textContent = "まだ広告テンプレがありません。参考にしたいバナーを登録しましょう。";
    target.appendChild(empty);
    return;
  }

  for (const template of templates) {
    const card = document.createElement("article");
    card.className = "adTemplateGalleryCard";
    card.setAttribute("role", "listitem");
    const title = template.title || "広告テンプレ";
    const image = template.imageFile
      ? '<button type="button" class="adTemplateGalleryImage" data-preview-image="' + escapeAttr(resolveImageSrc(template.imageFile)) + '" data-preview-title="' + escapeAttr(title) + '" aria-label="画像を拡大: ' + escapeAttr(title) + '"><img src="' + escapeAttr(resolveImageSrc(template.imageFile)) + '" alt="" loading="lazy" /></button>'
      : '<div class="adTemplateGalleryImage adTemplateGalleryImageEmpty"><span>画像なし</span></div>';
    card.innerHTML = image
      + '<div class="adTemplateGalleryBody"><div class="adTemplateGalleryTitleRow"><h3>' + escapeHtml(title) + '</h3>' + statusPill(template.templateStatus || "not_started") + templateProcessingPill(template.templateProcessingStatus) + '</div>'
      + '<p>' + escapeHtml(clip(template.successFactors || template.templateTextStoryboard || template.textStoryboard || "成功要因・字コンテは詳細から確認できます。", 90)) + '</p>'
      + '<div class="adTemplateGalleryActions"></div></div>';

    const actions = card.querySelector(".adTemplateGalleryActions");
    const detailButton = document.createElement("button");
    detailButton.type = "button";
    detailButton.className = "tableButton";
    detailButton.textContent = "詳細";
    detailButton.setAttribute("aria-label", `詳細を開く: ${title}`);
    detailButton.addEventListener("click", () => selectItem("adTemplate", template));
    actions.appendChild(detailButton);
    const analysisActive = isTemplateAnalysisActive(template);
    actions.appendChild(runningActionButton(analysisActive ? templateProcessingLabel(template.templateProcessingStatus) : "テンプレ化", "templateImage", template.id, (btn) => templateAdImage(template.id, btn), !template.imageFile || analysisActive));
    const deleteButton = rowDeleteButton("adTemplate", template.id);
    deleteButton.setAttribute("aria-label", `削除: ${title}`);
    actions.appendChild(deleteButton);
    target.appendChild(card);
  }
}

function setAdTemplateViewMode(mode) {
  if (!AD_TEMPLATE_VIEW_MODES.includes(mode)) return;
  adTemplateViewMode = mode;
  localStorage.setItem(AD_TEMPLATE_VIEW_MODE_KEY, mode);
  applyAdTemplateViewMode();
}

function applyAdTemplateViewMode() {
  const tableView = $("#adTemplatesTableView");
  const galleryView = $("#adTemplatesGallery");
  if (tableView) tableView.hidden = adTemplateViewMode !== "table";
  if (galleryView) galleryView.hidden = adTemplateViewMode !== "gallery";
  for (const button of $$(".viewModeButton[data-adtemplateview]")) {
    const active = button.dataset.adtemplateview === adTemplateViewMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

function rowActionButton(label, handler, disabled = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tableButton actionMini";
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener("click", async (event) => {
    event.stopPropagation();
    await handler(button);
  });
  return button;
}


function statusSelectHtml(type, id, field, value, options) {
  const choices = options.map((option) => '<option value="' + escapeAttr(option) + '" ' + (option === value ? 'selected' : '') + '>' + escapeHtml(displayValue(option)) + '</option>').join('');
  return '<select class="statusSelect status-' + escapeAttr(value || 'empty') + '" data-type="' + escapeAttr(type) + '" data-id="' + escapeAttr(id) + '" data-field="' + escapeAttr(field) + '">' + choices + '</select>';
}

function bindInlineControls(root) {
  for (const select of root.querySelectorAll(".statusSelect")) {
    select.addEventListener("click", (event) => event.stopPropagation());
    select.addEventListener("change", async (event) => {
      const target = event.currentTarget;
      await updateTableRow(target.dataset.type, target.dataset.id, { [target.dataset.field]: target.value });
    });
  }
}

function bindEditableCells(root) {
  for (const span of root.querySelectorAll(".editableCell")) {
    const cell = span.closest("td");
    if (cell) {
      cell.classList.add("tableEditableTd");
      cell.tabIndex = 0;
      cell.addEventListener("click", () => selectTableCell(cell));
      cell.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === "F2") {
          event.preventDefault();
          event.stopPropagation();
          selectTableCell(cell);
          startCellEdit(cell);
        }
        if (event.key === "Escape") {
          event.preventDefault();
          clearTableCellSelection();
        }
        if (event.key === "Tab") {
          event.preventDefault();
          focusSiblingEditableCell(cell, event.shiftKey ? -1 : 1);
        }
      });
    }
    span.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      selectTableCell(event.currentTarget.closest("td"));
      startCellEdit(event.currentTarget.closest("td"));
    });
  }
}

function initTableKeyboard() {
  document.addEventListener("keydown", async (event) => {
    if (imageGallery && !$("#detailModal")?.classList.contains("hidden")) {
      if (event.key === "ArrowLeft") { event.preventDefault(); stepImageGallery(-1); return; }
      if (event.key === "ArrowRight") { event.preventDefault(); stepImageGallery(1); return; }
    }
    const active = document.activeElement;
    if (active?.matches?.("input, textarea, select, [contenteditable='true']")) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c" && selectedCell) {
      const editable = selectedCell.querySelector(".editableCell");
      const value = editable?.dataset.copyValue || editable?.textContent || selectedCell.textContent || "";
      if (value.trim()) {
        event.preventDefault();
        await navigator.clipboard?.writeText(value.trim()).catch(() => null);
        selectedCell.classList.add("copiedCell");
        setTimeout(() => selectedCell?.classList.remove("copiedCell"), 700);
      }
    }
  });
}

function selectTableCell(cell) {
  if (!cell) return;
  if (selectedCell && selectedCell !== cell) selectedCell.classList.remove("selectedCell", "copiedCell");
  selectedCell = cell;
  selectedCell.classList.add("selectedCell");
}

function clearTableCellSelection() {
  selectedCell?.classList.remove("selectedCell", "copiedCell");
  selectedCell = null;
}

function focusSiblingEditableCell(cell, direction) {
  const cells = Array.from(document.querySelectorAll("td.tableEditableTd"));
  const index = cells.indexOf(cell);
  if (index < 0) return;
  const next = cells[index + direction];
  if (!next) return;
  selectTableCell(next);
  next.focus();
}

function editableCellHtml(type, id, field, value, options = {}) {
  const rawValue = options.rawValue ?? rawCellValue(type, id, field) ?? value ?? "";
  const copyValue = options.copyValue ?? rawValue;
  const attrs = [
    'data-edit-type="' + escapeAttr(type) + '"',
    'data-edit-id="' + escapeAttr(id) + '"',
    'data-edit-field="' + escapeAttr(field) + '"',
    'data-edit-raw="' + escapeAttr(rawValue) + '"',
    'data-copy-value="' + escapeAttr(copyValue) + '"'
  ];
  if (options.kind) attrs.push('data-edit-kind="' + escapeAttr(options.kind) + '"');
  if (options.optionsKey) attrs.push('data-edit-options="' + escapeAttr(options.optionsKey) + '"');
  return '<span class="editableCell" ' + attrs.join(' ') + ' title="\u30af\u30ea\u30c3\u30af\u3067\u9078\u629e / Enter\u307e\u305f\u306fF2\u3067\u7de8\u96c6 / Ctrl+C\u3067\u30b3\u30d4\u30fc">' + escapeHtml(value || '') + '</span>';
}

function relationCellHtml(type, id, field, value, label, optionsKey) {
  return editableCellHtml(type, id, field, label || "\u672a\u9078\u629e", { kind: "select", optionsKey, rawValue: value || "", copyValue: label || "" });
}

function startCellEdit(cell) {
  if (cell.querySelector("input, textarea, select")) return;
  const span = cell.querySelector(".editableCell");
  if (!span) return;
  const type = span.dataset.editType;
  const id = span.dataset.editId;
  const field = span.dataset.editField;
  const kind = span.dataset.editKind || "text";
  const oldValue = span.dataset.editRaw ?? span.textContent ?? "";
  let editor;
  if (kind === "textarea") {
    editor = document.createElement("textarea");
    editor.rows = 3;
    editor.className = "cellEditor cellEditorTextarea";
  } else if (kind === "select") {
    editor = document.createElement("select");
    editor.className = "cellEditor";
    for (const option of editOptions(span.dataset.editOptions, span)) {
      const item = document.createElement("option");
      item.value = option.value;
      item.textContent = option.label;
      item.disabled = Boolean(option.disabled);
      editor.appendChild(item);
    }
  } else {
    editor = document.createElement("input");
    editor.className = "cellEditor";
    editor.type = kind === "url" ? "url" : "text";
  }
  editor.value = oldValue;
  cell.innerHTML = "";
  cell.appendChild(editor);
  editor.focus();
  if (editor.select) editor.select();

  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const next = editor.value.trim();
    if (save && next !== oldValue) {
      await updateTableRow(type, id, { [field]: next });
    } else {
      await loadResearch();
      renderResearch();
    }
  };
  editor.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); finish(false); }
    if (event.key === "Enter" && !event.shiftKey && kind !== "textarea") { event.preventDefault(); finish(true); }
  });
  editor.addEventListener("blur", () => finish(true));
}

function editOptions(key, span) {
  if (key === "productRelation") return [{ value: "", label: "\u5546\u54c1\u672a\u9078\u629e" }, ...research.products.map((product) => ({ value: product.id, label: product.name || product.id }))];
  if (key === "strategyRelation") {
    const source = (research.banners || []).find((item) => item.id === span.dataset.editId);
    const productId = source?.productId || "";
    const strategies = (research.strategies || []).filter((item) => !productId || item.productId === productId);
    return [{ value: "", label: "戦略\u672a\u9078\u629e" }, ...strategies.map((strategy) => ({ value: strategy.id, label: strategy.conceptName || strategy.id }))];
  }
  if (key === "adTemplateRelation") return [{ value: "", label: "\u30c6\u30f3\u30d7\u30ec\u672a\u9078\u629e" }, ...(research.adTemplates || []).filter((item) => (item.creativeType || "banner") === "banner").map((template) => ({
    value: template.id,
    label: (template.title || template.id) + (isBannerTemplateReady(template) ? "" : "（要再解析）"),
    disabled: !isBannerTemplateReady(template)
  }))];
  if (key === "productImageRelation" || key === "productLogoRelation") {
    const banner = (research.banners || []).find((item) => item.id === span.dataset.editId);
    const product = research.products.find((item) => item.id === banner?.productId);
    const role = key === "productImageRelation" ? "product" : "logo";
    const images = (product?.images || []).filter((item) => item.role === role);
    return [{ value: "", label: "\u4f7f\u308f\u306a\u3044" }, ...images.map((image) => ({ value: image.path, label: image.label || image.path.split("/").pop() }))];
  }
  const map = {
    materialType: ["HP", "LP", "Interview", "Article", "Review", "Competitor", "Meeting Note"],
    factCategory: FACT_CATEGORY_OPTIONS,
    ruleType: ["ng_word", "ng_expression", "preferred_expression", "legal_disclaimer", "tone_rule", "image_rule"],
    creativeType: ["banner"],
    ownership: ["other", "own"]
  };
  return (map[key] || []).map((value) => ({ value, label: displayValue(value) }));
}

function rawCellValue(type, id, field) {
  const sources = {
    product: research.products,
    material: research.materials,
    fact: research.facts,
    rule: research.expressionRules,
    strategy: research.strategies,
    banner: research.banners,
    adTemplate: research.adTemplates
  };
  const row = (sources[type] || []).find((item) => item.id === id);
  return row?.[field] || "";
}

function rowDeleteButton(type, id) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tableButton iconDelete";
  button.title = "\u524a\u9664";
  button.setAttribute("aria-label", "\u524a\u9664");
  button.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6"/></svg>';
  button.addEventListener("click", async (event) => {
    event.stopPropagation();
    if (!confirm("\u3053\u306e\u884c\u3092\u524a\u9664\u3057\u307e\u3059\u3002\u3088\u308d\u3057\u3044\u3067\u3059\u304b\uff1f")) return;
    await deleteTableRow(type, id);
  });
  return button;
}

async function updateTableRow(type, id, patch) {
  const project = selectedProject();
  const endpoint = tableEndpoint(type, id, project.path);
  const normalizedPatch = normalizeTablePatch(type, patch);
  const data = await requestJson(endpoint.url, { method: "PATCH", body: { project: project.path, patch: normalizedPatch } });
  writeTerminal(data.ok ? "system" : "error", data.ok ? "\u884c\u3092\u66f4\u65b0\u3057\u307e\u3057\u305f\u3002" : JSON.stringify(data, null, 2));
  if (data.ok) { await loadResearch(); refreshSelectedPayload(); renderResearch(); renderInspector(); }
  return data;
}

async function deleteTableRow(type, id) {
  const project = selectedProject();
  const endpoint = tableEndpoint(type, id, project.path);
  const data = await requestJson(endpoint.url, { method: "DELETE" });
  writeTerminal(data.ok ? "system" : "error", data.ok ? "\u884c\u3092\u524a\u9664\u3057\u307e\u3057\u305f\u3002" : JSON.stringify(data, null, 2));
  if (data.ok) { await loadResearch(); renderResearch(); selectItem(null, null); }
}

function normalizeTablePatch(type, patch) {
  if (type === "banner") {
    const next = { ...patch };
    const imageFields = [["productImagePath", "productImagePaths"], ["logoImagePath", "logoImagePaths"], ["otherImagePath", "otherImagePaths"]];
    for (const [singleKey, multipleKey] of imageFields) {
      if (Object.prototype.hasOwnProperty.call(next, singleKey) && !Object.prototype.hasOwnProperty.call(next, multipleKey)) next[multipleKey] = next[singleKey] ? [next[singleKey]] : [];
    }
    if (Object.prototype.hasOwnProperty.call(next, "productId")) return { ...next, strategyId: "", productImagePath: "", productImagePaths: [], logoImagePath: "", logoImagePaths: [], otherImagePath: "", otherImagePaths: [] };
    return next;
  }
  if ((type === "copy" || type === "script" || type === "article") && Object.prototype.hasOwnProperty.call(patch, "productId")) return { ...patch, strategyId: "" };
  return patch;
}

function tableEndpoint(type, id, projectPath) {
  const encodedId = encodeURIComponent(id);
  const project = encodeURIComponent(projectPath);
  const paths = {
    product: '/api/research/products/' + encodedId + '?project=' + project,
    material: '/api/research/materials/' + encodedId + '?project=' + project,
    fact: '/api/research/facts/' + encodedId + '?project=' + project,
    rule: '/api/research/expression-rules/' + encodedId + '?project=' + project,
    strategy: '/api/strategies/' + encodedId + '?project=' + project,
    banner: '/api/banners/' + encodedId + '?project=' + project,
    adTemplate: '/api/ad-templates/' + encodedId + '?project=' + project
  };
  return { url: paths[type] };
}

function productOptionsHtml(selectedId = "") {
  return [`<option value="">&#x5546;&#x54C1;&#x672A;&#x9078;&#x629E;</option>`, ...research.products.map((product) => `<option value="${escapeAttr(product.id)}" ${product.id === selectedId ? "selected" : ""}>${escapeHtml(product.name)}</option>`)].join("");
}

// DB add forms live in a fixed panel above the table (not as a <tr> inside it),
// so a background re-render of the table never wipes out an open form, and the
// form isn't constrained by the table's column widths / horizontal scroll.
function renderAddPanel(panelId, label, rowFactory) {
  const panel = $(`#${panelId}`);
  if (!panel || panel.childElementCount) return;
  panel.appendChild(addPanelButton(panelId, label, rowFactory));
}

function resetAddPanel(panelId, label, rowFactory) {
  const panel = $(`#${panelId}`);
  if (!panel) return;
  panel.innerHTML = "";
  panel.appendChild(addPanelButton(panelId, label, rowFactory));
}

function addPanelButton(panelId, label, rowFactory) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "addRowPanelButton";
  button.innerHTML = `<span aria-hidden="true">+</span> ${escapeHtml(label)}`;
  button.addEventListener("click", () => {
    const panel = $(`#${panelId}`);
    if (!panel) return;
    panel.innerHTML = "";
    panel.appendChild(rowFactory());
  });
  return button;
}

function inlineAddFormCard(panelId, label, description, fieldsHtml, primaryLabel, onSubmit, rowFactory, gridClass = "") {
  const card = document.createElement("div");
  card.className = "inlineAddForm";
  card.innerHTML = `
    <div class="inlineAddHeader">
      <div>
        <b>${escapeHtml(label)}</b>
        <span>${escapeHtml(description)}</span>
      </div>
    </div>
    <div class="inlineAddGrid ${escapeAttr(gridClass)}">${fieldsHtml}</div>
    <div class="inlineAddActions">
      <button class="secondaryButton cancelInlineAdd" type="button">\u30ad\u30e3\u30f3\u30bb\u30eb</button>
      <button class="inlineAddButton submitInlineAdd" type="button">${escapeHtml(primaryLabel)}</button>
    </div>`;
  card.querySelector(".submitInlineAdd").addEventListener("click", onSubmit);
  card.querySelector(".cancelInlineAdd").addEventListener("click", () => resetAddPanel(panelId, label, rowFactory));
  return card;
}

function productInputRow() {
  return inlineAddFormCard("productsAddPanel", "\u5546\u54c1\u3092\u8ffd\u52a0", "\u5546\u54c1\u540d\u3001\u516c\u5f0fURL\u3001\u4e00\u8a00\u30e1\u30e2\u3092\u5165\u529b\u3057\u307e\u3059\u3002",
    `<label class="formField"><span>\u5546\u54c1\u540d</span><input id="productName" class="tableInput" placeholder="\u4f8b: \u5546\u54c1\u540d\u3092\u5165\u529b" /></label>
     <label class="formField"><span>\u516c\u5f0fURL</span><input id="productUrl" class="tableInput" placeholder="https://..." /></label>
     <label class="formField span2"><span>\u7c21\u6613\u8aac\u660e</span><textarea id="productDescription" class="tableInput compactTextArea" placeholder="\u7279\u5fb4\u3001\u30bf\u30fc\u30b2\u30c3\u30c8\u3001\u88dc\u8db3\u30e1\u30e2"></textarea></label>`,
    "\u8ffd\u52a0", addProduct, productInputRow, "threeColumn");
}

const MATERIAL_TYPE_OPTIONS = [
  ["HP", "\u516c\u5f0fHP"], ["LP", "LP"], ["Interview", "\u9867\u5ba2\u306e\u58f0"], ["Article", "\u8a18\u4e8b"],
  ["Review", "\u53e3\u30b3\u30df"], ["Competitor", "\u7af6\u5408"], ["Meeting Note", "\u8b70\u4e8b\u9332\u30fb\u30e1\u30e2"]
];


// \u30ec\u30ac\u30b7\u30fc\u306a\u30ab\u30c6\u30b4\u30ea\u5024(\u7d75\u6587\u5b57\u4ed8\u304d\u30fb\u65e7\u5206\u985e\u30fb\u81ea\u7531\u8a18\u8ff0\u306a\u3069)\u30925\u533a\u5206\u306e\u3044\u305a\u308c\u304b\u306b\u6b63\u898f\u5316\u3059\u308b\u3002
// \u90e8\u5206\u4e00\u81f4\u3067\u5224\u5b9a\u3057\u3001\u5148\u306b\u4e00\u81f4\u3057\u305f\u533a\u5206\u3092\u512a\u5148\u3059\u308b\u3002
// \u512a\u5148\u9806: \u30e1\u30ea\u30c3\u30c8\u7cfb \u2192 \u30aa\u30d5\u30a1\u30fc\u7cfb \u2192 \u5b9f\u7e3e\u7cfb \u2192 \u6a29\u5a01\u6027\u7cfb \u2192 \u7279\u5fb4\u7cfb \u2192 \u65e2\u5b9a(\u7279\u5fb4)\u3002
// ("\u5b9f\u7e3e\u30fb\u6a29\u5a01\u6027" \u306e\u3088\u3046\u306a\u30ec\u30ac\u30b7\u30fc\u5024\u306f\u300c\u5b9f\u7e3e\u300d\u306b\u5bc4\u305b\u308b\u305f\u3081\u3001\u6a29\u5a01\u6027\u3088\u308a\u5b9f\u7e3e\u306e\u5224\u5b9a\u3092\u5148\u306b\u884c\u3046)
function mapFactCategory(raw) {
  const value = String(raw || "");
  if (value.includes("\u30e1\u30ea\u30c3\u30c8") || value.includes("\u30d9\u30cd\u30d5\u30a3\u30c3\u30c8")) return "\u30e1\u30ea\u30c3\u30c8";
  if (value.includes("\u30aa\u30d5\u30a1\u30fc") || value.includes("\u4fa1\u683c") || value.includes("\u7279\u5178")) return "\u30aa\u30d5\u30a1\u30fc";
  if (value.includes("\u5b9f\u7e3e") || value.includes("\u53e3\u30b3\u30df") || value.includes("\u9867\u5ba2\u306e\u58f0") || value.includes("\u30ec\u30d3\u30e5\u30fc")) return "\u5b9f\u7e3e";
  if (value.includes("\u6a29\u5a01") || value.includes("\u4f1a\u793e") || value.includes("\u4fe1\u983c")) return "\u6a29\u5a01\u6027";
  if (value.includes("\u7279\u5fb4")) return "\u7279\u5fb4";
  return "\u7279\u5fb4";
}


function factInputRow() {
  const categoryOptionsHtml = FACT_CATEGORY_OPTIONS.map((value) => `<option value="${escapeAttr(value)}">${escapeHtml(value)}</option>`).join("");
  return inlineAddFormCard("factsAddPanel", "\u4e8b\u5b9f\u3092\u8ffd\u52a0", "\u5e83\u544a\u3084LP\u3067\u6839\u62e0\u3068\u3057\u3066\u4f7f\u3046\u60c5\u5831\u3092\u69cb\u9020\u5316\u3057\u307e\u3059\u3002",
    `<label class="formField"><span>\u30ab\u30c6\u30b4\u30ea</span><select id="factCategory" class="tableSelect">${categoryOptionsHtml}</select></label>
     <label class="formField"><span>\u540d\u524d</span><input id="factTitle" class="tableInput" placeholder="\u4f8b: \u7d2f\u8a08\u8ca9\u58f2\u6570" /></label>
     <label class="formField span2"><span>\u5185\u5bb9</span><textarea id="factContent" class="tableInput compactTextArea" placeholder="\u6570\u5024\u3001\u8868\u73fe\u3001\u6ce8\u610f\u70b9\u3092\u542b\u3081\u3066\u5165\u529b"></textarea></label>
     <label class="formField"><span>\u5f15\u7528\u5143</span><input id="factSource" class="tableInput" placeholder="URL / \u8cc7\u6599\u540d(\u8907\u6570\u53ef)" /></label>
     <label class="formField"><span>\u4f5c\u6210\u8005</span><input id="factAuthor" class="tableInput" placeholder="\u4f5c\u6210\u8005\u540d" /></label>`,
    "\u8ffd\u52a0", addFact, factInputRow, "threeColumn");
}

function expressionRuleInputRow() {
  return inlineAddFormCard("rulesAddPanel", "\u8868\u73fe\u30eb\u30fc\u30eb\u3092\u8ffd\u52a0", "NG\u8868\u73fe\u3001\u63a8\u5968\u8868\u73fe\u3001\u6ce8\u8a18\u306a\u3069\u3092\u660e\u78ba\u306b\u7ba1\u7406\u3057\u307e\u3059\u3002",
    `<label class="formField"><span>\u7a2e\u5225</span><select id="ruleType" class="tableSelect"><option value="ng_expression">NG\u8868\u73fe</option><option value="ng_word">NG\u30ef\u30fc\u30c9</option><option value="preferred_expression">\u63a8\u5968\u8868\u73fe</option><option value="legal_disclaimer">\u6ce8\u8a18</option><option value="tone_rule">\u30c8\u30f3\u30de\u30ca</option><option value="image_rule">\u753b\u50cf\u30eb\u30fc\u30eb</option></select></label>
     <label class="formField"><span>NG / \u30eb\u30fc\u30eb</span><input id="rulePattern" class="tableInput" placeholder="\u907f\u3051\u308b\u8868\u73fe\u30fb\u5fc5\u9808\u6761\u4ef6" /></label>
     <label class="formField"><span>\u4ee3\u66ff\u8868\u73fe</span><input id="ruleReplacement" class="tableInput" placeholder="\u63a8\u5968\u3059\u308b\u8a00\u3044\u63db\u3048" /></label>
     <label class="formField span2"><span>\u8aac\u660e</span><textarea id="ruleDescription" class="tableInput compactTextArea" placeholder="\u5224\u65ad\u7406\u7531\u3001\u9069\u7528\u7bc4\u56f2\u3001\u6cd5\u52d9\u30e1\u30e2"></textarea></label>`,
    "\u8ffd\u52a0", addExpressionRule, expressionRuleInputRow, "threeColumn");
}

function adTemplateOptionsHtml(selectedId = "") {
  return ['<option value="">テンプレ未選択</option>', ...(research.adTemplates || []).filter((item) => (item.creativeType || "banner") === "banner").map((template) => {
    const ready = isBannerTemplateReady(template);
    return '<option value="' + escapeAttr(template.id) + '" ' + (template.id === selectedId ? 'selected' : '') + (ready ? '' : ' disabled') + '>' + escapeHtml((template.title || '広告テンプレ') + (ready ? '' : '（要再解析）')) + '</option>';
  })].join('');
}

// バナー追加モーダル用: 複数生成時は選択順にテンプレを各案へ割り当てる。
function bannerTemplateGalleryHtml(selectedIds = []) {
  const templates = (research.adTemplates || []).filter((item) => (item.creativeType || "banner") === "banner");
  const selected = Array.isArray(selectedIds) ? selectedIds : [selectedIds].filter(Boolean);
  const noneCard = '<button type="button" class="bannerTemplateCard' + (!selected.length ? ' selected' : '') + '" data-template-id="" aria-pressed="' + String(!selected.length) + '">'
    + '<span class="bannerTemplateCardThumb bannerTemplateCardThumb--empty">選択なし</span>'
    + '<span class="bannerTemplateCardTitle">選択なし</span></button>';
  const cards = templates.map((template) => {
    const ready = isBannerTemplateReady(template);
    const selectedIndex = selected.indexOf(template.id);
    const isSelected = selectedIndex >= 0;
    const thumb = template.imageFile
      ? '<span class="bannerTemplateCardThumb"><img src="' + escapeAttr(resolveImageSrc(template.imageFile)) + '" alt="" /></span>'
      : '<span class="bannerTemplateCardThumb bannerTemplateCardThumb--empty">画像なし</span>';
    const searchText = [template.title, template.genre, template.media].filter(Boolean).join(" ").toLowerCase();
    return '<button type="button" class="bannerTemplateCard' + (isSelected ? ' selected' : '') + (ready ? '' : ' isUnavailable') + '" data-template-id="' + escapeAttr(template.id) + '" data-template-search="' + escapeAttr(searchText) + '" aria-pressed="' + String(isSelected) + '"' + (ready ? '' : ' disabled title="再解析後に選択できます"') + '>'
      + '<span class="bannerTemplateOrder"' + (isSelected ? '' : ' hidden') + '>' + (selectedIndex + 1) + '</span>'
      + thumb + '<span class="bannerTemplateCardTitle">' + escapeHtml(template.title || '広告テンプレ') + '</span>'
      + '<span class="bannerTemplateCardMeta">' + escapeHtml(ready ? [template.genre, template.media].filter(Boolean).join(" / ") : '要再解析') + '</span></button>';
  });
  return '<div class="bannerTemplateGallery">' + [noneCard, ...cards].join('') + '</div>';
}

function strategyOptionsHtml(productId = "", selectedId = "") {
  const strategies = (research.strategies || []).filter((item) => !productId || item.productId === productId);
  return ['<option value="">戦略\u672a\u9078\u629e</option>', ...strategies.map((strategy) => '<option value="' + escapeAttr(strategy.id) + '" ' + (strategy.id === selectedId ? 'selected' : '') + '>' + escapeHtml(strategy.conceptName || '戦略\u4eee\u8aac') + '</option>')].join('');
}

function strategyInputRow() {
  return inlineAddFormCard("strategiesAddPanel", "戦略\u3092\u8ffd\u52a0", "\u8ab0\u306b\u3001\u4f55\u3092\u3001\u3069\u306e\u30aa\u30d5\u30a1\u30fc\u3067\u63d0\u6848\u3059\u308b\u304b\u3092\u6574\u7406\u3057\u307e\u3059\u3002",
    `<label class="formField"><span>\u30b3\u30f3\u30bb\u30d7\u30c8\u540d</span><input id="strategyConcept" class="tableInput" placeholder="\u6226\u7565\u30b3\u30f3\u30bb\u30d7\u30c8" /></label>
     <label class="formField span2"><span>WHO</span><textarea id="strategyWho" class="tableInput compactTextArea" placeholder="\u30bf\u30fc\u30b2\u30c3\u30c8\u5c5e\u6027 / \u6b32\u6c42"></textarea></label>
     <label class="formField"><span>WHAT</span><input id="strategyBenefit" class="tableInput" placeholder="\u30d9\u30cd\u30d5\u30a3\u30c3\u30c8" /></label>
     <label class="formField"><span>\u30aa\u30d5\u30a1\u30fc</span><input id="strategyOffer" class="tableInput" placeholder="\u5272\u5f15\u3001\u7279\u5178\u3001CTA" /></label>`,
    "\u8ffd\u52a0", addStrategy, strategyInputRow, "threeColumn");
}

function openBannerAddModal() {
  const body = $("#bannerAddModalBody");
  const modal = $("#bannerAddModal");
  if (!body || !modal) return;
  const productId = research.products[0]?.id || "";
  body.innerHTML = '<div class="bannerAddSetupPane"><label class="formField span2"><span>タイトル</span><input id="bannerTitle" class="tableInput" placeholder="バナー案名" /></label>'
    + '<label class="formField"><span>戦略</span><select id="bannerStrategy" class="tableSelect">' + strategyOptionsHtml(productId) + '</select></label>'
    + '<div class="formField span2"><span>戦略プレビュー</span><div id="bannerStrategyPreview" class="strategyPreviewBox"></div></div>'
    + '<label class="formField"><span>サイズ</span><select id="bannerImageSize" class="tableSelect">' + bannerSizeOptionsHtml() + '</select></label>'
    + '<label class="formField"><span>生成数(最大5枚)</span><select id="bannerGenCount" class="tableSelect">' + genCountOptionsHtml() + '</select></label>'
    + bannerImageMultiSelectHtml(productId, "product", "商品画像", "bannerProductImages")
    + bannerImageMultiSelectHtml(productId, "logo", "ロゴ", "bannerLogoImages")
    + bannerImageMultiSelectHtml(productId, "other", "その他画像", "bannerOtherImages")
    + '<label class="formField span2"><span>追加指示(任意)</span><textarea id="bannerInstruction" class="tableInput compactTextArea" placeholder="例: 清潔感のあるトーン。"></textarea></label></div>'
    + '<div class="bannerAddTemplatePane"><div class="bannerTemplatePaneHeader"><div><strong>テンプレDB</strong><span>複数選択可・任意</span></div><input id="bannerTemplateSearch" class="tableInput" type="search" placeholder="タイトル・ジャンル・媒体で検索" /></div>'
    + bannerTemplateGalleryHtml() + '<input type="hidden" id="bannerTemplateIds" value="[]" /><p id="bannerTemplateAssignment" class="bannerTemplateAssignment">テンプレ未選択: すべてテンプレなしで生成します</p></div>';
  const strategySelect = body.querySelector("#bannerStrategy");
  strategySelect.addEventListener("change", () => updateBannerStrategyPreview(body));
  strategySelect.addEventListener("change", updateBannerAddSubmitState);
  const templateGallery = body.querySelector(".bannerTemplateGallery");
  let selectedTemplateIds = [];
  const syncTemplateSelection = () => {
    const genCount = Math.min(5, Math.max(1, Number(body.querySelector("#bannerGenCount")?.value) || 1));
    templateGallery?.querySelectorAll(".bannerTemplateCard").forEach((card) => {
      const id = card.dataset.templateId || "";
      const order = id ? selectedTemplateIds.indexOf(id) : (selectedTemplateIds.length ? -1 : 0);
      const active = order >= 0;
      card.classList.toggle("selected", active);
      card.setAttribute("aria-pressed", String(active));
      const badge = card.querySelector(".bannerTemplateOrder");
      if (badge) { badge.hidden = !active; badge.textContent = active ? String(order + 1) : ""; }
    });
    const hiddenInput = body.querySelector("#bannerTemplateIds");
    if (hiddenInput) hiddenInput.value = JSON.stringify(selectedTemplateIds);
    const names = selectedTemplateIds.map((id) => (research.adTemplates || []).find((item) => item.id === id)?.title || id);
    const assignments = Array.from({ length: genCount }, (_, index) => names.length ? `案${index + 1}: ${names[index % names.length]}` : `案${index + 1}: テンプレなし`);
    const assignment = body.querySelector("#bannerTemplateAssignment");
    if (assignment) assignment.textContent = assignments.join(" / ");
  };
  templateGallery?.addEventListener("click", (event) => {
    const card = event.target.closest(".bannerTemplateCard");
    if (!card || !templateGallery.contains(card)) return;
    const templateId = card.dataset.templateId || "";
    if (!templateId) selectedTemplateIds = [];
    else if (selectedTemplateIds.includes(templateId)) selectedTemplateIds = selectedTemplateIds.filter((id) => id !== templateId);
    else {
      const max = Math.min(5, Math.max(1, Number(body.querySelector("#bannerGenCount")?.value) || 1));
      if (selectedTemplateIds.length >= max) {
        showToast("info", `生成数${max}枚までテンプレを選択できます。`);
        return;
      }
      selectedTemplateIds.push(templateId);
    }
    syncTemplateSelection();
  });
  body.querySelector("#bannerGenCount")?.addEventListener("change", () => {
    const max = Math.min(5, Math.max(1, Number(body.querySelector("#bannerGenCount")?.value) || 1));
    if (selectedTemplateIds.length > max) selectedTemplateIds = selectedTemplateIds.slice(0, max);
    syncTemplateSelection();
  });
  body.querySelector("#bannerTemplateSearch")?.addEventListener("input", (event) => {
    const query = event.target.value.trim().toLowerCase();
    templateGallery?.querySelectorAll(".bannerTemplateCard").forEach((card) => {
      card.hidden = Boolean(query) && card.dataset.templateId !== "" && !String(card.dataset.templateSearch || "").includes(query);
    });
  });
  updateBannerStrategyPreview(body);
  syncTemplateSelection();
  updateBannerAddSubmitState();
  modal.classList.remove("hidden");
  body.querySelector("#bannerTitle")?.focus();
}

function updateBannerAddSubmitState() {
  const button = $("#addBannerAndGenerate");
  const message = $("#bannerAddValidation");
  const strategy = $("#bannerStrategy")?.value || "";
  if (!button) return;
  button.disabled = !strategy;
  button.title = strategy ? "画像生成を開始" : "戦略を選択してください";
  if (message) {
    message.textContent = strategy ? "テンプレは任意です" : "戦略を選択してください";
    message.classList.toggle("ready", Boolean(strategy));
  }
}

// 選択中の戦略の全文をプレビュー欄に反映する(商品変更・戦略変更のたびに再計算)。
function updateBannerStrategyPreview(body) {
  const previewEl = body.querySelector("#bannerStrategyPreview");
  if (!previewEl) return;
  const strategyId = body.querySelector("#bannerStrategy")?.value || "";
  const strategy = (research.strategies || []).find((item) => item.id === strategyId);
  const text = strategy ? (strategy.markdown || composeStrategyProse(strategy) || "") : "";
  previewEl.textContent = text || "戦略を選択すると全文が表示されます。";
}

function closeBannerAddModal() {
  $("#bannerAddModal")?.classList.add("hidden");
}

function adTemplateInputRow() {
  const card = inlineAddFormCard("adTemplatesAddPanel", "バナーをテンプレ化", "参考バナーを画像解析し、構造・字コンテ・成功要因を自動生成して共通テンプレDBへ保存します。",
    `<label class="formField"><span>テンプレ名</span><input id="templateTitle" class="tableInput" placeholder="テンプレ名" /></label>
     <div class="formField"><span>バナー画像</span><div class="imageUploadField"><input id="templateImage" class="tableInput" placeholder="画像を選択してください" readonly /><label class="tableButton imageUploadButton">画像を選択<input id="templateImageFile" type="file" accept="image/*" hidden /></label><span id="templateImageStatus" class="mutedCell"></span></div></div>`,
    "テンプレ化", addAdTemplate, adTemplateInputRow, "twoFields");
  card.querySelector("#templateImageFile").addEventListener("change", (event) => uploadTemplateImage(event.target.files[0], card));
  return card;
}

async function uploadTemplateImage(file, scope) {
  if (!file) return;
  const statusEl = scope.querySelector("#templateImageStatus");
  const urlInput = scope.querySelector("#templateImage");
  if (statusEl) statusEl.textContent = "アップロード中...";
  try {
    const dataBase64 = await fileToBase64(file);
    const data = await post("/api/ad-templates/upload-image", { fileName: file.name, dataBase64 });
    if (!data.ok) throw new Error(data.message || "アップロードに失敗しました。");
    if (urlInput) urlInput.value = data.url;
    if (statusEl) statusEl.textContent = "アップロード済み: " + file.name;
  } catch (error) {
    if (statusEl) statusEl.textContent = "失敗: " + error.message;
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("ファイルの読み込みに失敗しました。"));
    reader.readAsDataURL(file);
  });
}

function row(cells, type, payload, htmlCells = false) {
  const tr = document.createElement("tr");
  tr.dataset.type = type;
  tr.dataset.id = payload?.id || payload?.path || "";
  for (const value of cells) {
    const td = document.createElement("td");
    if (htmlCells) td.innerHTML = value || "";
    else td.textContent = value || "";
    tr.appendChild(td);
  }
  tr.addEventListener("click", (event) => {
    if (tr.dataset.noDetail === "true") return;
    if (event.target.closest("button, input, select, textarea, a")) return;
    const selection = window.getSelection?.();
    if (selection && String(selection).trim()) return;
    selectItem(type, payload);
  });
  return tr;
}

async function createProject() {
  // 1案件=1商品: 商品名がそのまま案件名になる(案件名の別入力は廃止)。
  const productName = $("#newProjectProductName")?.value.trim() || "";
  const body = {
    projectName: productName,
    productName,
    productUrl: $("#newProjectProductUrl")?.value.trim() || ""
  };
  const productDescription = $("#newProjectProductDesc")?.value.trim() || "";
  if (!productName) return writeTerminal("error", "商品名を入力してください。");
  writeTerminal("cmd", `案件作成: ${productName}`);
  const data = await post("/api/projects", body);
  writeTerminal(data.ok ? "system" : "error", data.ok ? `案件を作成しました: ${data.project.name}` : JSON.stringify(data, null, 2));
  if (data.ok) {
    if (data.warning) showToast("error", data.warning);
    await loadProjects();
    await selectProjectPath(data.project.path, { closeSwitcher: false, refresh: false });
    clearInputs(["#newProjectProductName", "#newProjectProductUrl", "#newProjectProductDesc"]);
    selected = null;
    await refreshProjectData();
    // 案件作成モーダルは商品登録を兼ねる(1案件1商品)。簡易説明はサーバーの自動商品作成が受け取らないため、
    // 作成直後の唯一の商品(research.products[0])へ既存のPATCH APIで反映する。
    if (productDescription && research.products[0]?.id) {
      await requestJson(`/api/research/products/${encodeURIComponent(research.products[0].id)}`, {
        method: "PATCH",
        body: { project: data.project.path, patch: { shortDescription: productDescription } }
      });
      await refreshProjectData();
    }
    $("#projectModal")?.classList.add("hidden");
  }
}

async function addProduct() {
  const project = selectedProject();
  const body = {
    project: project.path,
    name: $("#productName")?.value.trim() || "",
    officialUrl: $("#productUrl")?.value.trim() || "",
    shortDescription: $("#productDescription")?.value.trim() || ""
  };
  if (!body.name && !body.officialUrl) return writeTerminal("error", "商品名またはURLを入力してください。");
  const data = await post("/api/research/products", body);
  writeTerminal(data.ok ? "system" : "error", data.ok ? "商品を追加しました。" : JSON.stringify(data, null, 2));
  if (data.ok) {
    resetAddPanel("productsAddPanel", "商品を追加", productInputRow);
    closeForm("productFormWrap");
    await loadResearch();
    renderResearch();
    switchView("products");
    selectItem("product", data.product);
  }
}

async function addFact() {
  const project = selectedProject();
  const data = await post("/api/research/facts", {
    project: project.path,
    productId: $("#factProduct")?.value || research.products[0]?.id || "",
    title: $("#factTitle")?.value.trim() || "Fact",
    content: $("#factContent")?.value.trim() || "",
    category: $("#factCategory")?.value || FACT_CATEGORY_OPTIONS[0],
    sourceType: "manual",
    sourceUrl: $("#factSource")?.value.trim() || "",
    createdBy: $("#factAuthor")?.value.trim() || "",
    confidenceScore: 0.9
  });
  writeTerminal(data.ok ? "system" : "error", data.ok ? "事実を追加しました。" : JSON.stringify(data, null, 2));
  if (data.ok) {
    resetAddPanel("factsAddPanel", "事実を追加", factInputRow);
    closeForm("factFormWrap");
    await loadResearch();
    renderResearch();
    switchView("facts");
    selectItem("fact", data.fact);
  }
}


async function addStrategy() {
  const project = selectedProject();
  const data = await post("/api/strategies", {
    project: project.path,
    productId: $("#strategyProduct")?.value || research.products[0]?.id || "",
    conceptName: $("#strategyConcept")?.value.trim() || "戦略\u4eee\u8aac",
    targetAttributes: $("#strategyWho")?.value.trim() || "",
    desire: $("#strategyWho")?.value.trim() || "",
    benefit: $("#strategyBenefit")?.value.trim() || "",
    productConcept: $("#strategyBenefit")?.value.trim() || "",
    offer: $("#strategyOffer")?.value.trim() || "",
    status: "proposed"
  });
  writeTerminal(data.ok ? "system" : "error", data.ok ? "戦略\u3092\u8ffd\u52a0\u3057\u307e\u3057\u305f\u3002" : JSON.stringify(data, null, 2));
  if (data.ok) { resetAddPanel("strategiesAddPanel", "戦略を追加", strategyInputRow); await loadResearch(); renderResearch(); switchView("strategies"); selectItem("strategy", data.strategy); }
}

async function runWhoWhat(actionButton = null) {
  const project = selectedProject();
  const productId = productIdForAiAction();
  if (!productId) return writeTerminal("error", "\u5546\u54c1\u3092\u9078\u629e\u3057\u3066\u304b\u3089戦略\u751f\u6210\u3092\u5b9f\u884c\u3057\u3066\u304f\u3060\u3055\u3044\u3002");
  const key = "whoWhat:" + productId;
  const button = actionButton instanceof HTMLElement ? actionButton : $("#runWhoWhat");
  await runExclusive(key, button, async () => {
    syncWhoWhatButtons();
    writeTerminal("cmd", "戦略 AI\u751f\u6210");
    const data = await post("/api/strategies/generate", { project: project.path, productId });
    if (!data.ok) {
      writeTerminal("error", JSON.stringify(data, null, 2));
      return;
    }
    // \u63d0\u6848\u306f\u30b5\u30fc\u30d0\u30fc\u5074\u3067\u300c\u63d0\u6848\u4e2d\u300d\u30b9\u30c6\u30fc\u30bf\u30b9\u3068\u3057\u3066\u81ea\u52d5\u4fdd\u5b58\u3055\u308c\u308b(\u4e0d\u8981\u306a\u6848\u306f\u30a2\u30fc\u30ab\u30a4\u30d6\u3067\u6574\u7406)
    const saved = data.strategies || [];
    showToast("success", `戦略\u3092${saved.length}\u6848\u4fdd\u5b58\u3057\u307e\u3057\u305f(\u30b9\u30c6\u30fc\u30bf\u30b9: \u63d0\u6848\u4e2d)\u3002`);
    await loadResearch();
    renderResearch();
    switchView("strategies");
    if (saved[0]) selectItem("strategy", saved[0]);
  });
}

function syncWhoWhatButtons() {
  const productId = productIdForAiAction() || research.products?.[0]?.id || "";
  const running = Boolean(productId && isRunning("whoWhat:" + productId));
  const buttons = [$("#runWhoWhat"), ...$$('[data-summary-action="runWhoWhat"]')].filter(Boolean);
  for (const button of buttons) {
    button.disabled = running;
    button.classList.toggle("isRunning", running);
    button.textContent = running ? "生成中…" : "戦略生成";
  }
}

async function addBanner(startGeneration = false) {
  const project = selectedProject();
  const productId = $("#bannerProduct")?.value || research.products[0]?.id || "";
  const strategyId = $("#bannerStrategy")?.value || "";
  if (!strategyId) {
    showToast("error", "WHO-WHATを選択してください。");
    writeTerminal("error", "WHO-WHATを選択してください。");
    return;
  }
  let templateAdIds = [];
  try {
    const parsed = JSON.parse($("#bannerTemplateIds")?.value || "[]");
    if (Array.isArray(parsed)) templateAdIds = parsed.filter(Boolean);
  } catch {}
  const imageSize = $("#bannerImageSize")?.value || "1080x1080";
  const additionalInstruction = $("#bannerInstruction")?.value.trim() || "";
  const productImagePaths = selectedBannerImagePaths("bannerProductImages");
  const otherImagePaths = selectedBannerImagePaths("bannerOtherImages");
  const logoImagePaths = selectedBannerImagePaths("bannerLogoImages");
  const productImagePath = productImagePaths[0] || "";
  const otherImagePath = otherImagePaths[0] || "";
  const logoImagePath = logoImagePaths[0] || "";
  const baseTitle = $("#bannerTitle")?.value.trim() || "バナー案";
  // 「追加のみ」は常に1件。「追加して生成」は生成数セレクト(最大5)に従って同じ入力から複数件作成する。
  const genCount = startGeneration ? Math.min(5, Math.max(1, Number($("#bannerGenCount")?.value) || 1)) : 1;
  const createdBanners = [];
  for (let i = 0; i < genCount; i += 1) {
    const title = genCount > 1 ? baseTitle + " 案" + (i + 1) : baseTitle;
    const templateAdId = templateAdIds.length ? templateAdIds[i % templateAdIds.length] : "";
    const data = await post("/api/banners", { project: project.path, productId, strategyId, templateAdId, title, imageSize, additionalInstruction, revisionInstruction: "", productImagePath, productImagePaths, otherImagePath, otherImagePaths, logoImagePath, logoImagePaths, imageText: "", promptText: "", productionStatus: "not_started", imageGenerationStatus: "not_started", provider: "gpt-image-2" });
    writeTerminal(data.ok ? "system" : "error", data.ok ? "バナー案を追加しました。" : JSON.stringify(data, null, 2));
    if (data.ok) createdBanners.push(data.banner);
  }
  if (createdBanners.length) {
    const multi = createdBanners.length > 1;
    showToast("success", startGeneration
      ? (multi ? createdBanners.length + "件のバナー案を追加しました。続けて生成を開始します。" : "バナー案を追加しました。続けて生成を開始します。")
      : "バナー案を追加しました。");
    closeBannerAddModal();
    await loadResearch();
    renderResearch();
    switchView("banners");
    if (startGeneration) {
      selectItem(null, null);
    } else {
      selectItem("banner", createdBanners[createdBanners.length - 1]);
    }
    // 「追加して生成」: 複数案では先に訴求軸を分けてコピーを確定し、その後に画像生成を並列実行する。
    if (startGeneration && createdBanners.length > 1) generateBannerBatchFull(createdBanners).catch(async (error) => {
      writeTerminal("error", error?.message || String(error));
      showToast("error", "バナーの一括生成中に通信エラーが発生しました。");
      await loadResearch();
      renderResearch();
    });
    else if (startGeneration) generateBannerFull(createdBanners[0].id, null).catch(() => null);
  }
}

async function generateBannerBatchFull(banners) {
  const project = selectedProject();
  const bannerIds = banners.map((banner) => banner.id).filter(Boolean);
  if (!bannerIds.length) return;
  await runExclusive("bannerBatch:" + bannerIds.join(","), null, async () => {
    writeTerminal("cmd", `${bannerIds.length}件をバナー生成キューへ登録`);
    const data = await post("/api/banners/generate-full-batch", { project: project.path, bannerIds });
    if (!data.ok) {
      writeTerminal("error", JSON.stringify(data, null, 2));
      showToast("error", data.message || "バナー生成キューへの登録に失敗しました。");
    } else {
      const accepted = Number(data.promptQueuedCount || 0) + Number(data.imageQueuedCount || 0);
      const failed = Array.isArray(data.errors) ? data.errors.length : 0;
      writeTerminal(failed ? "error" : "system", `${accepted}件を生成キューへ登録しました。${failed ? ` ${failed}件は登録できませんでした。` : ""}`);
      showToast(failed ? "error" : "success", `${accepted}件の生成を受け付けました。待機中の案は順番に自動実行します。`);
    }
    await loadResearch();
    renderResearch();
    switchView("banners");
  });
}

async function addAdTemplate(event) {
  const project = selectedProject();
  const imageFile = $("#templateImage")?.value.trim() || "";
  if (!imageFile) {
    showToast("error", "テンプレ化するバナー画像を選択してください。");
    return;
  }
  const button = event?.currentTarget || null;
  const accepted = await runExclusive("templateImage:new", button, async () => {
    const created = await post("/api/ad-templates", {
      project: project.path,
      title: $("#templateTitle")?.value.trim() || "広告テンプレ",
      creativeType: "banner",
      ownership: "other",
      imageFile,
      templateStatus: "not_started"
    });
    if (!created.ok) {
      writeTerminal("error", JSON.stringify(created, null, 2));
      showToast("error", "広告テンプレの登録に失敗しました。");
      return null;
    }
    writeTerminal("cmd", "広告テンプレDB: 新規バナーをテンプレ化");
    const queued = await post("/api/ad-templates/template-image/enqueue", { project: project.path, templateId: created.template.id });
    writeTerminal(queued.ok ? "system" : "error", queued.ok ? "バナー画像の解析を受け付けました。" : JSON.stringify(queued, null, 2));
    if (queued.ok) resetAddPanel("adTemplatesAddPanel", "バナーをテンプレ化", adTemplateInputRow);
    return { created, queued };
  });
  if (!accepted) return;

  const { created, queued } = accepted;
  await loadResearch();
  renderResearchPreservingAdTemplateDraft();
  switchView("adTemplates");
  selectItem("adTemplate", (research.adTemplates || []).find((item) => item.id === created.template.id) || queued.template || created.template);
  if (queued.ok) {
    ensureLiveRefresh();
    showToast("success", "バナー画像の解析を受け付けました。続けて次のテンプレートを登録できます。");
  } else {
    showToast("error", "テンプレは登録されましたが、画像解析の受付に失敗しました。一覧の「テンプレ化」から再実行できます。");
  }
}

async function templateAdImage(templateId, button) {
  const project = selectedProject();
  const key = "templateImage:" + templateId;
  await runExclusive(key, button, async () => {
    writeTerminal("cmd", "広告テンプレDB: 画像テンプレ化");
    const data = await post("/api/ad-templates/template-image/enqueue", { project: project.path, templateId });
    writeTerminal(data.ok ? "system" : "error", data.ok ? "バナー画像の解析を受け付けました。" : JSON.stringify(data, null, 2));
    if (data.ok) showToast("success", "バナー画像の解析を受け付けました。バックグラウンドで実行します。");
    else if (data.errorCode === "TEMPLATE_ANALYSIS_ALREADY_ACTIVE") showToast("info", data.message || "このテンプレートは解析中です。");
    else showToast("error", data.message || "バナー画像の解析受付に失敗しました。");
    await loadResearch();
    renderResearch();
    switchView("adTemplates");
    if (data.template) selectItem("adTemplate", data.template);
    if (data.ok) ensureLiveRefresh();
  });
}

async function generateBannerPrompt(bannerId, button) {
  const project = selectedProject();
  const key = "bannerPrompt:" + bannerId;
  await runExclusive(key, button, async () => {
    const data = await post("/api/banners/generate-prompt", { project: project.path, bannerId });
    writeTerminal(data.ok ? "system" : "error", data.ok ? "バナー案の画像テキストとpromptを生成しました。" : JSON.stringify(data, null, 2));
    if (data.ok) showToast("success", "バナー案の画像テキストとpromptを生成しました。");
    await loadResearch();
    switchView("banners");
    if (data.banner) selectItem("banner", data.banner);
  });
}

async function spreadBanner(bannerId, button) {
  const project = selectedProject();
  const key = "bannerSpread:" + bannerId;
  await runExclusive(key, button, async () => {
    const data = await post("/api/banners/spread", { project: project.path, bannerId });
    writeTerminal(data.ok ? "system" : "error", data.ok ? "5案拡散を実行しました。" : JSON.stringify(data, null, 2));
    if (data.ok) showToast("success", "5案拡散を実行しました。");
    await loadResearch();
    switchView("banners");
  });
}

async function reviseBanner(bannerId, button) {
  const project = selectedProject();
  const key = "bannerRevise:" + bannerId;
  await runExclusive(key, button, async () => {
    const data = await post("/api/banners/revise", { project: project.path, bannerId });
    writeTerminal(data.ok ? "system" : "error", data.ok ? "修正指示を反映しました。" : JSON.stringify(data, null, 2));
    if (data.ok) showToast("success", "修正指示を反映しました。");
    await loadResearch();
    switchView("banners");
    if (data.banner) selectItem("banner", data.banner);
  });
}

async function generateBannerFull(bannerId, button) {
  const project = selectedProject();
  const key = "bannerImage:" + bannerId;
  await runExclusive(key, button, async () => {
    writeTerminal("cmd", "バナー生成キューへ登録");
    const data = await post("/api/banners/generate-full-batch", { project: project.path, bannerIds: [bannerId] });
    writeTerminal(data.ok ? "system" : "error", data.ok ? "バナー生成を受け付けました。" : JSON.stringify(data, null, 2));
    showToast(data.ok ? "success" : "error", data.ok ? "生成を受け付けました。コピー設計後、画像生成へ順次進みます。" : (data.message || "生成の受付に失敗しました。"));
    await loadResearch();
    switchView("banners");
  });
}

async function generateBannerImage(bannerId, button) {
  const project = selectedProject();
  const key = "bannerImage:" + bannerId;
  await runExclusive(key, button, async () => {
    writeTerminal("cmd", "gpt-image-2 \u753b\u50cf\u751f\u6210");
    const data = await post("/api/banners/generate-image", { project: project.path, bannerId });
    writeTerminal(data.ok ? "system" : "error", data.ok ? "gpt-image-2\u3067\u753b\u50cf\u751f\u6210\u304c\u5b8c\u4e86\u3057\u307e\u3057\u305f\u3002" : JSON.stringify(data, null, 2));
    if (data.ok) showToast("success", "gpt-image-2\u3067\u753b\u50cf\u751f\u6210\u304c\u5b8c\u4e86\u3057\u307e\u3057\u305f\u3002");
    await loadResearch();
    switchView("banners");
    if (data.banner) selectItem("banner", data.banner);
  });
}

// --- Banner range edit (範囲指定修正) ---
const BANNER_EDIT_SELECTION_FILL = "rgba(220, 38, 38, 0.25)";
const BANNER_EDIT_SELECTION_STROKE = "rgba(220, 38, 38, 0.95)";
const BANNER_EDIT_SELECTION_ACTIVE_STROKE = "rgba(37, 99, 235, 0.95)";
const BANNER_EDIT_DRAFT_STROKE = "rgba(220, 38, 38, 0.85)";
let bannerEditState = null;
let bannerFullEditState = null;
let bannerEditSelectionSeq = 0;

function createBannerSelectionId() {
  bannerEditSelectionSeq += 1;
  return "sel_" + Date.now().toString(36) + "_" + bannerEditSelectionSeq;
}

function initBannerEditCanvas() {
  const selectionCanvas = $("#bannerEditSelectionCanvas");
  if (!selectionCanvas) return;
  const getPos = (event) => {
    const rect = selectionCanvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const start = (event) => {
    if (!bannerEditState || bannerEditState.running || !canAddSelection(bannerEditState.selections)) return;
    event.preventDefault();
    selectionCanvas.setPointerCapture?.(event.pointerId);
    bannerEditState.drawing = true;
    bannerEditState.draftRect = { start: getPos(event), end: getPos(event) };
    redrawBannerEditSelections();
  };
  const move = (event) => {
    if (!bannerEditState?.drawing || !bannerEditState.draftRect) return;
    event.preventDefault();
    bannerEditState.draftRect.end = getPos(event);
    redrawBannerEditSelections();
  };
  const stop = (event) => {
    if (!bannerEditState?.drawing) return;
    event?.preventDefault?.();
    bannerEditState.drawing = false;
    finalizeBannerEditDraftRect();
    bannerEditState.draftRect = null;
    redrawBannerEditSelections();
  };
  selectionCanvas.addEventListener("pointerdown", start);
  selectionCanvas.addEventListener("pointermove", move);
  selectionCanvas.addEventListener("pointerup", stop);
  selectionCanvas.addEventListener("pointercancel", stop);
}

function finalizeBannerEditDraftRect() {
  if (!bannerEditState?.draftRect) return;
  const { selectionCanvas, displayWidth, displayHeight, selections } = bannerEditState;
  if (!canAddSelection(selections)) {
    setBannerEditStatus("選択できる範囲は最大5件です。");
    return;
  }
  const normalized = normalizeDragRect(
    bannerEditState.draftRect.start,
    bannerEditState.draftRect.end,
    displayWidth,
    displayHeight
  );
  if (!normalized) return;
  const selectionId = createBannerSelectionId();
  selections.push({
    selectionId,
    ...normalized,
    instruction: ""
  });
  const overlap = findOverlappingSelections(selections);
  if (overlap) {
    selections.pop();
    setBannerEditStatus(overlapErrorMessage(overlap), true);
    renderBannerEditSelectionCards();
    updateBannerEditRunButton();
    return;
  }
  bannerEditState.activeSelectionId = selectionId;
  setBannerEditStatus("");
  renderBannerEditSelectionCards();
  updateBannerEditRunButton();
}

function clearBannerEditSelections() {
  if (!bannerEditState || bannerEditState.running) return;
  bannerEditState.selections = [];
  bannerEditState.activeSelectionId = null;
  bannerEditState.draftRect = null;
  setBannerEditStatus("");
  renderBannerEditSelectionCards();
  redrawBannerEditSelections();
  updateBannerEditRunButton();
}

function removeBannerEditSelection(selectionId) {
  if (!bannerEditState || bannerEditState.running) return;
  const target = bannerEditState.selections.find((item) => item.selectionId === selectionId);
  if (!target || !isSelectionRemovable(null, bannerEditState.running)) return;
  bannerEditState.selections = removeSelectionById(bannerEditState.selections, selectionId);
  if (bannerEditState.activeSelectionId === selectionId) {
    bannerEditState.activeSelectionId = bannerEditState.selections[0]?.selectionId || null;
  }
  renderBannerEditSelectionCards();
  redrawBannerEditSelections();
  updateBannerEditRunButton();
}

function setBannerEditActiveSelection(selectionId) {
  if (!bannerEditState || bannerEditState.running) return;
  if (bannerEditState.activeSelectionId === selectionId) return;
  bannerEditState.activeSelectionId = selectionId;
  updateBannerEditActiveCardHighlight();
  redrawBannerEditSelections();
}

function updateBannerEditActiveCardHighlight() {
  const host = $("#bannerEditSelectionCards");
  if (!host || !bannerEditState) return;
  host.querySelectorAll(".bannerEditSelectionCard").forEach((card) => {
    card.classList.toggle("isActive", card.dataset.selectionId === bannerEditState.activeSelectionId);
  });
}

function setBannerEditStatus(message, isError = false) {
  const el = $("#bannerEditStatus");
  if (!el) return;
  el.textContent = message || "";
  el.classList.toggle("isError", Boolean(isError && message));
}

function setBannerEditUiLocked(locked) {
  const clearBtn = $("#bannerEditClear");
  const cancelBtn = $("#cancelBannerEdit");
  const closeBtn = $("#closeBannerEditModal");
  if (clearBtn) clearBtn.disabled = locked;
  if (cancelBtn) cancelBtn.disabled = locked;
  if (closeBtn) closeBtn.disabled = locked;
  const selectionCanvas = $("#bannerEditSelectionCanvas");
  if (selectionCanvas) selectionCanvas.style.pointerEvents = locked ? "none" : "auto";
}

function updateBannerEditRunButton() {
  const button = $("#runBannerEdit");
  if (!button || !bannerEditState) return;
  const banner = (research.banners || []).find((item) => item.id === bannerEditState.bannerId);
  const jobBusy = isBannerImageBusy(banner) || isRunning("bannerImage:" + bannerEditState.bannerId);
  const validation = canRunBannerEditState({
    selections: bannerEditState.selections,
    running: bannerEditState.running,
    jobBusy
  });
  button.disabled = !validation.ok;
  if (validation.reason === "overlap") {
    setBannerEditStatus(overlapErrorMessage(validation.overlap), true);
  }
  button.textContent = bannerEditRunButtonLabel({
    selections: bannerEditState.selections,
    running: bannerEditState.running,
    failed: bannerEditState.lastFailed
  });
}

function renderBannerEditSelectionCards() {
  const host = $("#bannerEditSelectionCards");
  if (!host || !bannerEditState) return;
  host.innerHTML = "";
  bannerEditState.selections.forEach((selection, index) => {
    const number = selectionDisplayNumber(index);
    const card = document.createElement("div");
    card.className = "bannerEditSelectionCard";
    card.dataset.selectionId = selection.selectionId;
    if (selection.selectionId === bannerEditState.activeSelectionId) card.classList.add("isActive");
    if (bannerEditState.running) card.classList.add("isRunning");

    const header = document.createElement("div");
    header.className = "bannerEditSelectionCardHeader";
    const title = document.createElement("strong");
    title.textContent = "範囲" + number + "の修正指示";
    header.append(title);

    const label = document.createElement("label");
    const textareaId = "bannerEditInstruction_" + selection.selectionId;
    label.setAttribute("for", textareaId);
    label.className = "srOnly";
    label.textContent = "範囲" + number + "の修正指示";
    const textarea = document.createElement("textarea");
    textarea.id = textareaId;
    textarea.rows = 2;
    textarea.placeholder = "例: この範囲の価格を2,980円に変える";
    textarea.value = selection.instruction || "";
    textarea.disabled = !isSelectionEditable(null, bannerEditState.running);
    textarea.addEventListener("focus", () => {
      if (bannerEditState.activeSelectionId !== selection.selectionId) {
        bannerEditState.activeSelectionId = selection.selectionId;
        updateBannerEditActiveCardHighlight();
        redrawBannerEditSelections();
      }
    });
    textarea.addEventListener("input", () => {
      selection.instruction = textarea.value;
      updateBannerEditRunButton();
    });

    const actions = document.createElement("div");
    actions.className = "bannerEditSelectionCardActions";
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "secondaryButton";
    removeBtn.textContent = "この範囲を削除";
    removeBtn.setAttribute("aria-label", "範囲" + number + "を削除");
    removeBtn.disabled = !isSelectionRemovable(null, bannerEditState.running);
    removeBtn.addEventListener("click", () => removeBannerEditSelection(selection.selectionId));

    card.addEventListener("pointerdown", (event) => {
      if (event.target.closest("textarea, button")) return;
      setBannerEditActiveSelection(selection.selectionId);
    });
    actions.append(removeBtn);
    card.append(header, label, textarea, actions);
    host.append(card);
  });
}

function drawBannerEditNumberBadge(ctx, number, rect, canvasWidth, canvasHeight) {
  const label = selectionDisplayNumber(number);
  ctx.save();
  ctx.font = "bold 13px system-ui, sans-serif";
  const padding = 4;
  const textWidth = ctx.measureText(label).width;
  const badgeWidth = textWidth + padding * 2;
  const badgeHeight = 20;
  let badgeX = rect.x + 4;
  let badgeY = rect.y + 4;
  if (badgeX + badgeWidth > canvasWidth) badgeX = Math.max(0, canvasWidth - badgeWidth - 2);
  if (badgeY + badgeHeight > canvasHeight) badgeY = Math.max(0, rect.y + rect.height - badgeHeight - 4);
  if (badgeY < 0) badgeY = 2;
  ctx.fillStyle = "rgba(220, 38, 38, 0.92)";
  ctx.beginPath();
  ctx.roundRect?.(badgeX, badgeY, badgeWidth, badgeHeight, 10);
  if (!ctx.roundRect) ctx.rect(badgeX, badgeY, badgeWidth, badgeHeight);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.textBaseline = "middle";
  ctx.fillText(label, badgeX + padding, badgeY + badgeHeight / 2);
  ctx.restore();
}

function redrawBannerEditSelections() {
  if (!bannerEditState) return;
  const { selectionCtx, selectionCanvas, displayWidth, displayHeight, selections, activeSelectionId, draftRect } = bannerEditState;
  selectionCtx.clearRect(0, 0, selectionCanvas.width, selectionCanvas.height);
  selections.forEach((selection, index) => {
    const rect = normalizedRectToDisplayRect(selection, displayWidth, displayHeight);
    const active = selection.selectionId === activeSelectionId;
    selectionCtx.save();
    selectionCtx.fillStyle = BANNER_EDIT_SELECTION_FILL;
    selectionCtx.fillRect(rect.x, rect.y, rect.width, rect.height);
    selectionCtx.lineWidth = active ? 3 : 2;
    selectionCtx.strokeStyle = active ? BANNER_EDIT_SELECTION_ACTIVE_STROKE : BANNER_EDIT_SELECTION_STROKE;
    selectionCtx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1);
    drawBannerEditNumberBadge(selectionCtx, index, rect, displayWidth, displayHeight);
    selectionCtx.restore();
  });
  if (draftRect) {
    const normalized = normalizeDragRect(draftRect.start, draftRect.end, displayWidth, displayHeight);
    const rect = normalized
      ? normalizedRectToDisplayRect(normalized, displayWidth, displayHeight)
      : {
          x: Math.min(draftRect.start.x, draftRect.end.x),
          y: Math.min(draftRect.start.y, draftRect.end.y),
          width: Math.abs(draftRect.end.x - draftRect.start.x),
          height: Math.abs(draftRect.end.y - draftRect.start.y)
        };
    selectionCtx.save();
    selectionCtx.setLineDash([6, 4]);
    selectionCtx.lineWidth = 2;
    selectionCtx.strokeStyle = BANNER_EDIT_DRAFT_STROKE;
    selectionCtx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1);
    selectionCtx.restore();
  }
}

function openBannerEditModal(bannerId) {
  const banner = (research.banners || []).find((item) => item.id === bannerId);
  const image = banner?.generatedImagePath || banner?.images?.[0];
  if (!banner || !image) return showToast("error", "修正対象の生成画像がありません。先に画像生成を行ってください。");
  const modal = $("#bannerEditModal");
  const imageCanvas = $("#bannerEditImageCanvas");
  const selectionCanvas = $("#bannerEditSelectionCanvas");
  const wrap = $("#bannerEditCanvasWrap");
  if (!modal || !imageCanvas || !selectionCanvas || !wrap) return;
  setBannerEditStatus("");
  const img = new Image();
  img.onload = () => {
    const maxSide = 640;
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const displayWidth = Math.max(1, Math.round(img.naturalWidth * scale));
    const displayHeight = Math.max(1, Math.round(img.naturalHeight * scale));
    imageCanvas.width = displayWidth;
    imageCanvas.height = displayHeight;
    selectionCanvas.width = displayWidth;
    selectionCanvas.height = displayHeight;
    wrap.style.width = displayWidth + "px";
    wrap.style.height = displayHeight + "px";
    imageCanvas.getContext("2d").drawImage(img, 0, 0, displayWidth, displayHeight);
    bannerEditState = {
      bannerId,
      imageCanvas,
      selectionCanvas,
      selectionCtx: selectionCanvas.getContext("2d"),
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      displayWidth,
      displayHeight,
      imagePath: image,
      selections: [],
      draftRect: null,
      drawing: false,
      activeSelectionId: null,
      running: false,
      lastFailed: false
    };
    renderBannerEditSelectionCards();
    redrawBannerEditSelections();
    updateBannerEditRunButton();
    setBannerEditUiLocked(false);
    modal.classList.remove("hidden");
  };
  img.onerror = () => showToast("error", "画像の読み込みに失敗しました。");
  img.src = resolveImageSrc(image);
}

function closeBannerEditModal() {
  $("#bannerEditModal")?.classList.add("hidden");
  bannerEditState = null;
  setBannerEditUiLocked(false);
}

function loadBannerEditBackgroundImage(imagePath) {
  return new Promise((resolve, reject) => {
    if (!bannerEditState) return reject(new Error("banner edit state missing"));
    const img = new Image();
    img.onload = () => {
      const { imageCanvas, displayWidth, displayHeight } = bannerEditState;
      imageCanvas.getContext("2d").drawImage(img, 0, 0, displayWidth, displayHeight);
      bannerEditState.imagePath = imagePath;
      redrawBannerEditSelections();
      resolve();
    };
    img.onerror = () => reject(new Error("画像の読み込みに失敗しました。"));
    img.src = resolveImageSrc(imagePath);
  });
}

function buildCompositeBannerEditMaskBase64(selections) {
  const { naturalWidth, naturalHeight } = bannerEditState;
  const mask = computeCompositeMaskPixels(selections, naturalWidth, naturalHeight);
  if (!mask.transparentPixels) return null;
  const canvas = document.createElement("canvas");
  canvas.width = mask.width;
  canvas.height = mask.height;
  const ctx = canvas.getContext("2d");
  const imageData = new ImageData(mask.data, mask.width, mask.height);
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png").split(",")[1];
}

function validateBannerEditRun() {
  if (!bannerEditState) return { ok: false };
  const banner = (research.banners || []).find((item) => item.id === bannerEditState.bannerId);
  return canRunBannerEditState({
    selections: bannerEditState.selections,
    running: bannerEditState.running,
    jobBusy: isBannerImageBusy(banner) || isRunning("bannerImage:" + bannerEditState.bannerId)
  });
}

async function runBannerEditAction() {
  if (!bannerEditState) return;
  const validation = validateBannerEditRun();
  if (!validation.ok) {
    if (validation.reason === "empty_instruction") return showToast("error", "すべての範囲に修正指示を入力してください。");
    if (validation.reason === "no_selections") return showToast("error", "修正したい範囲をドラッグして選択してください。");
    if (validation.reason === "overlap") return setBannerEditStatus(overlapErrorMessage(validation.overlap), true);
    if (validation.reason === "job_busy") return showToast("info", "画像生成または修正が実行中です。完了までお待ちください。");
    return;
  }
  const bannerId = bannerEditState.bannerId;
  const project = selectedProject();
  const key = "bannerImage:" + bannerId;
  const selections = bannerEditState.selections.map((item) => ({ ...item, instruction: String(item.instruction || "").trim() }));
  const regions = buildEditRegionsPayload(selections);
  const instruction = buildCompositeEditInstruction(selections);
  const maskBase64 = buildCompositeBannerEditMaskBase64(selections);
  if (!maskBase64) return showToast("error", "修正範囲のマスクを生成できませんでした。");

  bannerEditState.running = true;
  bannerEditState.lastFailed = false;
  setBannerEditUiLocked(true);
  setBannerEditStatus("");
  updateBannerEditRunButton();

  let data;
  const runButton = $("#runBannerEdit");
  try {
    await runExclusive(key, runButton, async () => {
      writeTerminal("cmd", `gpt-image-2 範囲指定修正（${selections.length}箇所をまとめて）`);
      try {
        data = await post("/api/banners/edit-image", { project: project.path, bannerId, editMode: "range", maskBase64, instruction, regions });
      } catch (error) {
        data = { ok: false, message: String(error?.message || error) };
      }
    });
  } finally {
    if (bannerEditState) {
      bannerEditState.running = false;
      setBannerEditUiLocked(false);
      updateBannerEditRunButton();
    }
  }

  if (!bannerEditState) return;
  if (data?.ok === true && data?.accepted) {
    pendingBannerEdits.set(bannerId, "range");
    showToast("success", selections.length + "箇所の範囲指定修正を受け付けました。完了すると通知します。");
    closeBannerEditModal();
    await loadResearch();
    renderResearch();
    switchView("banners");
    flushPendingBannerEditToasts();
    ensureLiveRefresh();
    writeTerminal("system", selections.length + "箇所の範囲指定修正を受け付けました。");
    return;
  }

  bannerEditState.lastFailed = true;
  const message = data?.message || data?.error || "画像修正に失敗しました。元画像は変更されていません。";
  setBannerEditStatus(message, true);
  writeTerminal("error", JSON.stringify(data, null, 2));
  updateBannerEditRunButton();
}

// --- Banner full edit (全体修正) ---
function setBannerFullEditStatus(message, isError = false) {
  const status = $("#bannerFullEditStatus");
  if (!status) return;
  status.textContent = message || "";
  status.classList.toggle("isError", Boolean(isError && message));
}

function setBannerFullEditUiLocked(locked) {
  const instruction = $("#bannerFullEditInstruction");
  const cancel = $("#cancelBannerFullEdit");
  const close = $("#closeBannerFullEdit");
  if (instruction) instruction.disabled = locked;
  if (cancel) cancel.disabled = locked;
  if (close) close.disabled = locked;
}

function updateBannerFullEditRunButton() {
  const button = $("#runBannerFullEdit");
  if (!button) return;
  const instruction = String($("#bannerFullEditInstruction")?.value || "").trim();
  const banner = (research.banners || []).find((item) => item.id === bannerFullEditState?.bannerId);
  const jobBusy = bannerFullEditState
    ? isBannerImageBusy(banner) || isRunning("bannerImage:" + bannerFullEditState.bannerId)
    : false;
  const running = Boolean(bannerFullEditState?.running);
  button.disabled = !bannerFullEditState || running || jobBusy || !instruction || instruction.length > 2000;
  button.textContent = running ? "全体修正を実行中…" : (bannerFullEditState?.lastFailed ? "もう一度全体修正" : "全体修正を実行");
}

function openBannerFullEditModal(bannerId) {
  const banner = (research.banners || []).find((item) => item.id === bannerId);
  if (!banner?.generatedImagePath) return showToast("error", "全体修正する生成画像がありません。先に画像生成を行ってください。");
  const modal = $("#bannerFullEditModal");
  const image = $("#bannerFullEditImage");
  const instruction = $("#bannerFullEditInstruction");
  if (!modal || !image || !instruction) return;
  bannerFullEditState = {
    bannerId,
    imagePath: banner.generatedImagePath,
    running: false,
    lastFailed: false
  };
  image.src = resolveImageSrc(banner.generatedImagePath);
  instruction.value = "";
  setBannerFullEditStatus("");
  setBannerFullEditUiLocked(false);
  modal.classList.remove("hidden");
  updateBannerFullEditRunButton();
  requestAnimationFrame(() => instruction.focus());
}

function closeBannerFullEditModal() {
  if (bannerFullEditState?.running) return;
  $("#bannerFullEditModal")?.classList.add("hidden");
  const image = $("#bannerFullEditImage");
  if (image) image.removeAttribute("src");
  bannerFullEditState = null;
  setBannerFullEditUiLocked(false);
}

async function runBannerFullEditAction() {
  if (!bannerFullEditState || bannerFullEditState.running) return;
  const instruction = String($("#bannerFullEditInstruction")?.value || "").trim();
  if (!instruction) return showToast("error", "全体の修正指示を入力してください。");
  if (instruction.length > 2000) return showToast("error", "修正指示を2000文字以内で入力してください。");
  const { bannerId } = bannerFullEditState;
  const banner = (research.banners || []).find((item) => item.id === bannerId);
  if (isBannerImageBusy(banner) || isRunning("bannerImage:" + bannerId)) {
    return showToast("info", "画像生成または修正が実行中です。完了までお待ちください。");
  }
  const project = selectedProject();
  const key = "bannerImage:" + bannerId;
  bannerFullEditState.running = true;
  bannerFullEditState.lastFailed = false;
  setBannerFullEditStatus("");
  setBannerFullEditUiLocked(true);
  updateBannerFullEditRunButton();

  let data;
  try {
    await runExclusive(key, $("#runBannerFullEdit"), async () => {
      writeTerminal("cmd", "gpt-image-2 全体修正");
      try {
        data = await post("/api/banners/edit-image", {
          project: project.path,
          bannerId,
          editMode: "full",
          instruction
        });
      } catch (error) {
        data = { ok: false, message: String(error?.message || error) };
      }
    });
  } finally {
    if (bannerFullEditState) {
      bannerFullEditState.running = false;
      setBannerFullEditUiLocked(false);
      updateBannerFullEditRunButton();
    }
  }

  if (!bannerFullEditState) return;
  if (data?.ok === true && data?.accepted) {
    pendingBannerEdits.set(bannerId, "full");
    showToast("success", "全体修正を受け付けました。完了すると通知します。");
    closeBannerFullEditModal();
    await loadResearch();
    renderResearch();
    switchView("banners");
    flushPendingBannerEditToasts();
    ensureLiveRefresh();
    writeTerminal("system", "全体修正を受け付けました。");
    return;
  }

  bannerFullEditState.lastFailed = true;
  const message = data?.message || data?.error || "全体修正に失敗しました。元画像は変更されていません。";
  setBannerFullEditStatus(message, true);
  writeTerminal("error", JSON.stringify(data, null, 2));
  updateBannerFullEditRunButton();
}

async function saveOpenAiSettings() {
  const value = $("#openAiKey")?.value.trim() || "";
  const data = await post("/api/settings/openai", { apiKey: value });
  const status = $("#openAiStatus"); if (status) status.textContent = data.ok ? "\u8a2d\u5b9a\u6e08\u307f: " + data.settings.maskedKey : "\u4fdd\u5b58\u5931\u6557";
  if (data.ok) {
    updateSidebarStatusCard(data.settings.configured);
    openAiConfigured = Boolean(data.settings.configured);
    renderOnboardingCard();
  }
  writeTerminal(data.ok ? "system" : "error", data.ok ? "OpenAI\u8a2d\u5b9a\u3092\u4fdd\u5b58\u3057\u307e\u3057\u305f\u3002" : JSON.stringify(data, null, 2));
  if (data.ok && $("#openAiKey")) $("#openAiKey").value = "";
}

async function addExpressionRule() {
  const project = selectedProject();
  const data = await post("/api/research/expression-rules", {
    project: project.path,
    productId: $("#ruleProduct")?.value || research.products[0]?.id || "",
    ruleType: $("#ruleType")?.value || "ng_expression",
    pattern: $("#rulePattern")?.value.trim() || "",
    replacement: $("#ruleReplacement")?.value.trim() || "",
    description: $("#ruleDescription")?.value.trim() || "",
    severity: "medium",
    active: true
  });
  writeTerminal(data.ok ? "system" : "error", data.ok ? "\u8868\u73fe\u30ec\u30ae\u30e5\u30ec\u30fc\u30b7\u30e7\u30f3\u3092\u8ffd\u52a0\u3057\u307e\u3057\u305f\u3002" : JSON.stringify(data, null, 2));
  if (data.ok) {
    resetAddPanel("rulesAddPanel", "表現ルールを追加", expressionRuleInputRow);
    await loadResearch();
    renderResearch();
    switchView("rules");
    selectItem("rule", data.rule);
  }
}

async function extractMaterial(materialId, options = {}) {
  const quiet = options.quiet === true;
  const project = selectedProject();
  const material = research.materials.find((item) => item.id === materialId);
  if (!material) return writeTerminal("error", `\u8cc7\u6599\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093: ${materialId}`);
  activeExtractions.add(materialId);
  material.extractionStatus = "extracting";
  writeTerminal("cmd", `LP\u66f8\u304d\u51fa\u3057\u958b\u59cb: ${material.title || materialId}\nURL: ${material.sourceUrl || "-"}`);
  if (!quiet) renderResearch();
  try {
    const data = await post("/api/research/materials/extract", { project: project.path, materialId });
    if (data.accepted && data.jobId) {
      if (!quiet) showToast("info", "LP書き出しを開始しました。画面を閉じても処理は継続します。");
      const completed = await pollMaterialExtraction(project.path, data.jobId, material, { quiet, onProgress: options.onProgress });
      if (completed) Object.assign(data, completed);
    }
    const result = data.material?.extractionStatus;
    if (data.ok && (result === "extracted" || result === "partial_text" || result === "partial_visual")) {
      writeTerminal("system", formatExtractionSuccess(data, material));
    } else if (data.errorCode === "ALREADY_RUNNING") {
      showToast("info", data.message || "実行中です。完了までお待ちください。");
    } else {
      writeTerminal("error", formatExtractionError(data, material));
    }
    return data;
  } catch (error) {
    writeTerminal("error", [
      `LP\u66f8\u304d\u51fa\u3057\u30ea\u30af\u30a8\u30b9\u30c8\u306b\u5931\u6557\u3057\u307e\u3057\u305f: ${material.title || materialId}`,
      `\u539f\u56e0: ${error.message}`,
      "\u30b5\u30fc\u30d0\u30fc\u304c\u505c\u6b62\u3057\u305f\u3001\u51e6\u7406\u304c\u30bf\u30a4\u30e0\u30a2\u30a6\u30c8\u3057\u305f\u3001\u307e\u305f\u306f\u30cd\u30c3\u30c8\u30ef\u30fc\u30af\u8981\u6c42\u304c\u4e2d\u65ad\u3055\u308c\u305f\u53ef\u80fd\u6027\u304c\u3042\u308a\u307e\u3059\u3002"
    ].join("\n"));
    return null;
  } finally {
    activeExtractions.delete(materialId);
    await loadResearch();
    if (!quiet) renderResearch();
  }
}

async function pollMaterialExtraction(projectPath, jobId, fallbackMaterial, options = {}) {
  while (true) {
    await new Promise((resolve) => window.setTimeout(resolve, 3000));
    const data = await get(`/api/research/materials/extract/status?project=${encodeURIComponent(projectPath)}&jobId=${encodeURIComponent(jobId)}`);
    if (!data.ok) throw new Error(data.message || data.error || "抽出状況を取得できませんでした。");
    options.onProgress?.(data);
    await loadResearch();
    if (!options.quiet) {
      refreshSelectedPayload();
      renderResearch();
      renderInspector();
    }
    const status = data.job?.status;
    if (status === "completed" || status === "failed") return { ...data, material: data.material || fallbackMaterial };
  }
}

function formatExtractionSuccess(data, fallbackMaterial) {
  const material = data.material || fallbackMaterial;
  const job = data.job || {};
  const screenshotCount = job.screenshotCount ?? (material.screenshotUrls || []).length;
  const transcribedCount = job.transcribedSliceCount ?? 0;
  const textLength = job.textLength ?? String(material.extractedText || "").length;
  const screenshotPart = screenshotCount > 0 ? ` / \u30b9\u30af\u30b7\u30e7: ${screenshotCount}\u679a\uff08\u3046\u3061${transcribedCount}\u679a\u3092\u6587\u5b57\u8d77\u3053\u3057\uff09` : "";
  return [
    `LP\u66f8\u304d\u51fa\u3057\u5b8c\u4e86: ${material.title || fallbackMaterial.id}`,
    `\u672c\u6587: ${textLength}\u6587\u5b57${screenshotPart} / \u65b9\u6cd5: ${extractionMethodLabel(job.textMethod)}`,
    `\u30b9\u30af\u30b7\u30e7\u72b6\u614b: ${displayValue(job.screenshotStatus || material.screenshotStatus || "not_needed")}`,
    job.partialReason ? `\u4e00\u90e8\u5931\u6557: ${job.partialReason}` : "",
    formatJobSteps(job)
  ].filter(Boolean).join("\n");
}

function extractionMethodLabel(method) {
  const map = { fetch: "fetch", rendered_html: "\u30ec\u30f3\u30c0\u30ea\u30f3\u30b0\u5f8cHTML", manual: "\u624b\u52d5\u5165\u529b", none: "\u53d6\u5f97\u306a\u3057" };
  return map[method] || method || "\u4e0d\u660e";
}

function formatExtractionError(data, fallbackMaterial) {
  const material = data.material || fallbackMaterial;
  const job = data.job || {};
  return [
    `LP\u66f8\u304d\u51fa\u3057\u5931\u6557: ${material.title || fallbackMaterial.id}`,
    `URL: ${material.sourceUrl || "-"}`,
    `\u72b6\u614b: ${displayValue(material.extractionStatus || job.status || "failed")}`,
    `\u539f\u56e0: ${job.errorMessage || data.message || data.error || "\u8a73\u7d30\u30a8\u30e9\u30fc\u304c\u8fd4\u3063\u3066\u3044\u307e\u305b\u3093\u3002"}`,
    material.visualAnalysis ? `\u88dc\u8db3:\n${material.visualAnalysis}` : "",
    formatJobSteps(job)
  ].filter(Boolean).join("\n");
}

function formatJobSteps(job) {
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  if (!steps.length) return "";
  return "\u51e6\u7406\u30b9\u30c6\u30c3\u30d7:\n" + steps.map((step) => `- ${step.label}: ${displayValue(step.status)}${step.detail ? " / " + step.detail : ""}`).join("\n");
}

function beginResearchWorkflowProgress() {
  researchWorkflowProgress = {
    startedAt: Date.now(),
    steps: [
      { id: "sources", label: "URL・資料確認", status: "running", detail: "商品URLと登録済み資料を確認しています" },
      { id: "transcription", label: "LP・記事LP文字起こし", status: "pending", detail: "待機中" },
      { id: "web", label: "8方向Webリサーチ", status: "pending", detail: "待機中" },
      { id: "save", label: "事実DBへ保存", status: "pending", detail: "待機中" }
    ]
  };
  renderResearchWorkflowProgress();
}

function updateResearchWorkflowStep(id, status, detail) {
  const step = researchWorkflowProgress?.steps.find((item) => item.id === id);
  if (!step) return;
  step.status = status || step.status;
  if (detail !== undefined) step.detail = detail;
  renderResearchWorkflowProgress();
}

function failResearchWorkflow(detail) {
  const running = researchWorkflowProgress?.steps.find((item) => item.status === "running");
  if (running) { running.status = "failed"; running.detail = detail || "処理に失敗しました"; }
  renderResearchWorkflowProgress();
}

function renderResearchWorkflowProgress() {
  const host = $("#researchWorkflowProgress");
  if (!host || !researchWorkflowProgress) return;
  host.hidden = false;
  const completed = researchWorkflowProgress.steps.filter((step) => step.status === "completed").length;
  host.innerHTML = '<header><div><span>RESEARCH WORKFLOW</span><strong>事実リサーチの進行状況</strong></div><b>' + completed + ' / ' + researchWorkflowProgress.steps.length + '</b></header>'
    + '<div class="researchWorkflowSteps">' + researchWorkflowProgress.steps.map((step, index) => {
      const icon = step.status === "running" ? '<span class="loadingSpinner" aria-hidden="true"></span>'
        : step.status === "completed" ? '<span class="workflowStepCheck" aria-hidden="true">✓</span>'
        : step.status === "warning" || step.status === "failed" ? '<span class="workflowStepWarn" aria-hidden="true">!</span>'
        : '<span class="workflowStepIndex" aria-hidden="true">' + (index + 1) + '</span>';
      return '<div class="researchWorkflowStep ' + escapeAttr(step.status) + '">' + icon + '<div><strong>' + escapeHtml(step.label) + '</strong><p>' + escapeHtml(step.detail || "") + '</p></div></div>';
    }).join("") + '</div>';
}

async function runFactExtraction(options = {}) {
  const opts = options && (Object.hasOwn(options, "productId") || Object.hasOwn(options, "webSearch") || Object.hasOwn(options, "ensureSources")) ? options : {};
  const project = selectedProject();
  if (!project) {
    showToast("error", "案件を選択してから事実抽出を実行してください。");
    return;
  }
  if (!research.products.length) {
    showToast("error", "商品マスターDBに商品がありません。先に商品を追加してください。");
    return;
  }
  const productId = opts.productId || (selected?.type === "product" ? selected.payload.id : (research.products[0]?.id || ""));
  const key = "factExtraction:" + (productId || "none");
  const actionButton = opts.button || $("#runFactExtraction") || $("#extractFactsFromProduct");
  await runExclusive(key, actionButton, async () => {
    switchView("facts");
    beginResearchWorkflowProgress();
    writeTerminal("cmd", "商品事実抽出AI(LP解析+8方向Web検索)");
    try {
      const sourcePreparation = opts.ensureSources === false
        ? { total: 0, cached: 0, extracted: 0, failed: [] }
        : await ensureFactResearchSources(project, productId);
      if (opts.ensureSources === false) {
        updateResearchWorkflowStep("sources", "completed", "LP解析を省略しました");
        updateResearchWorkflowStep("transcription", "completed", "登録済み情報を利用します");
      }
      updateResearchWorkflowStep("web", "running", "公式・口コミ・比較・メディア・権威性・会社・市場・リスクを検索しています");
      const data = await post("/api/research/facts/extract-ai", { project: project.path, productId, webSearch: opts.webSearch !== false });
      if (!data.ok) {
        failResearchWorkflow(data.error || data.message || "事実抽出に失敗しました");
        writeTerminal("error", JSON.stringify(data, null, 2));
        showToast("error", "事実抽出に失敗しました: " + (data.error || "不明なエラー"));
        return;
      }
      const added = data.added?.length || 0;
      const queries = data.searchQueriesRun?.length || 0;
      const proposals = data.proposals?.length || 0;
      const parts = [`追加: ${added}件`];
      if (sourcePreparation.total) parts.push(`LP解析: ${sourcePreparation.extracted}件 / キャッシュ: ${sourcePreparation.cached}件`);
      if (data.webSearchUsed) parts.push(`Web検索: ${queries}クエリ`);
      const coverageItems = Object.values(data.researchCoverage || {});
      const covered = coverageItems.filter((item) => item?.searched && item?.queries?.length).length;
      updateResearchWorkflowStep("web", data.researchCoverageStatus === "complete" ? "completed" : "warning", `確認済み ${covered}/${coverageItems.length || 8}観点・${queries}クエリ`);
      updateResearchWorkflowStep("save", "completed", `${added}件を事実DBへ追加しました`);
      if (coverageItems.length) parts.push(`調査観点: ${covered}/${coverageItems.length}`);
      if (proposals) parts.push(`提案候補: ${proposals}件`);
      const coverageComplete = data.researchCoverageStatus === "complete";
      const msg = (coverageComplete ? "網羅リサーチが完了しました。" : "事実抽出が完了しました。") + parts.join(" / ");
      const searchEvidence = data.searchQueriesRun?.length ? "\n検索クエリ:\n- " + data.searchQueriesRun.join("\n- ") : "";
      const fallbackNotice = data.webSearchStatus === "fallback" ? "\nWeb検索を実行できなかったため、商品情報と登録資料のみで抽出しました。" : "";
      const sourceFailureNotice = sourcePreparation.failed.length ? "\n解析できなかったLP: " + sourcePreparation.failed.map((item) => item.title).join("、") + "（Webリサーチは継続しました）" : "";
      const missingLabels = (data.missingDirections || []).map((key) => data.researchCoverage?.[key]?.label || key);
      const coverageNotice = data.researchCoverageStatus === "partial" ? "\n未確認の観点: " + missingLabels.join("、") : "";
      writeTerminal("system", msg + fallbackNotice + sourceFailureNotice + coverageNotice + searchEvidence + (data.summary ? "\n" + data.summary : ""));
      showToast(coverageComplete && !sourcePreparation.failed.length ? "success" : "info", msg + (sourcePreparation.failed.length ? ` LP解析失敗: ${sourcePreparation.failed.length}件` : "") + (missingLabels.length ? ` 未確認: ${missingLabels.join("、")}` : ""));
      await loadResearch();
      switchView("facts");
    } catch (error) {
      failResearchWorkflow(String(error?.message || error));
      writeTerminal("error", String(error?.message || error));
      showToast("error", "事実抽出に失敗しました: " + String(error?.message || error));
    }
  });
}

async function ensureFactResearchSources(project, productId) {
  const product = research.products.find((item) => item.id === productId) || research.products[0];
  if (!product) return { total: 0, cached: 0, extracted: 0, failed: [] };
  const officialUrl = String(product.officialUrl || "").trim();
  if (/^https?:\/\//i.test(officialUrl) && !(research.materials || []).some((item) => (!item.productId || item.productId === product.id) && item.sourceUrl === officialUrl)) {
    const created = await post("/api/research/materials", {
      project: project.path,
      productId: product.id,
      type: "LP",
      title: "商品LP: " + hostname(officialUrl),
      sourceUrl: officialUrl,
      manualText: ""
    });
    if (created.ok && created.material) research.materials.unshift(created.material);
  }
  const sourceMaterials = (research.materials || []).filter((item) =>
    (!item.productId || item.productId === product.id)
    && /^https?:\/\//i.test(String(item.sourceUrl || ""))
    && ["LP", "HP", "Article", "External"].includes(item.type || "LP"));
  const cached = sourceMaterials.filter(isMaterialReadyForFacts);
  const pending = sourceMaterials.filter((item) => !isMaterialReadyForFacts(item));
  updateResearchWorkflowStep("sources", "completed", `${sourceMaterials.length}件を確認・キャッシュ${cached.length}件`);
  updateResearchWorkflowStep("transcription", pending.length ? "running" : "completed", pending.length ? `${pending.length}件の解析を開始しています` : "すべて解析済みのためキャッシュを利用します");
  if (pending.length) showToast("info", `${pending.length}件のLP・記事LPを文字起こししています。完了後にWebリサーチを開始します。`);
  const liveDetails = new Map();
  const results = await Promise.allSettled(pending.map((material) => extractMaterial(material.id, {
    quiet: true,
    onProgress: (data) => {
      const runningStep = (data.job?.steps || []).find((step) => step.status === "running");
      liveDetails.set(material.id, `${material.title || material.sourceUrl}: ${runningStep?.label || displayValue(data.job?.status || "running")}${runningStep?.detail ? " / " + runningStep.detail : ""}`);
      updateResearchWorkflowStep("transcription", "running", [...liveDetails.values()].join("\n"));
    }
  })));
  const failed = [];
  let extracted = 0;
  results.forEach((result, index) => {
    const status = result.status === "fulfilled" ? result.value?.material?.extractionStatus : "failed";
    if (["extracted", "partial_text", "partial_visual"].includes(status)) extracted += 1;
    else failed.push({ id: pending[index].id, title: pending[index].title || pending[index].sourceUrl });
  });
  updateResearchWorkflowStep("transcription", failed.length ? "warning" : "completed", failed.length ? `完了${extracted}件・失敗${failed.length}件（Web検索は継続）` : `文字起こし完了${extracted}件・キャッシュ利用${cached.length}件`);
  await loadResearch();
  return { total: sourceMaterials.length, cached: cached.length, extracted, failed };
}

function isMaterialReadyForFacts(material) {
  return ["extracted", "partial_text", "partial_visual", "manual_text"].includes(material?.extractionStatus)
    && Boolean(String(material.extractedText || material.visualAnalysis || material.manualText || "").trim());
}

function initDetailResize() {
  const handle = $("#detailResizeHandle");
  const shell = document.querySelector(".appShell");
  if (!handle || !shell) return;
  shell.style.setProperty("--detail-width", `${detailWidth}px`);
  handle.addEventListener("mousedown", (event) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = detailWidth;
    document.body.classList.add("resizingDetailPane");
    const onMove = (moveEvent) => {
      // 幅の上限制限は撤廃。メイン領域が完全に潰れないよう最小120pxだけ残し、
      // それ以外はウィンドウ幅いっぱいまで右ペインを広げられるようにする。
      const maxWidth = Math.max(320, window.innerWidth - 120);
      const next = Math.min(Math.max(startWidth - (moveEvent.clientX - startX), 300), maxWidth);
      detailWidth = next;
      shell.style.setProperty("--detail-width", `${next}px`);
    };
    const onUp = () => {
      localStorage.setItem("cmoai:detailWidth", String(detailWidth));
      document.body.classList.remove("resizingDetailPane");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
}

function handleGlobalUiClick(event) {
  const navButton = event.target.closest("[data-gallery-nav]");
  if (navButton) {
    event.preventDefault();
    event.stopPropagation();
    stepImageGallery(Number(navButton.dataset.galleryNav));
    return;
  }
  const imageButton = event.target.closest("[data-preview-image]");
  if (imageButton) {
    event.preventDefault();
    event.stopPropagation();
    const galleryRaw = imageButton.dataset.previewGallery;
    const gallery = galleryRaw ? { items: JSON.parse(galleryRaw), index: Number(imageButton.dataset.previewIndex || 0) } : null;
    openImageModal(imageButton.dataset.previewImage, imageButton.dataset.previewTitle || "\u753b\u50cf\u30d7\u30ec\u30d3\u30e5\u30fc", gallery);
    return;
  }
  const expandButton = event.target.closest("[data-expand-output]");
  if (expandButton) {
    event.preventDefault();
    event.stopPropagation();
    const block = expandButton.closest(".outputReviewBlock");
    const title = block?.querySelector("h3")?.textContent || "アウトプット";
    const text = block?.querySelector("pre")?.textContent || "";
    openTextModal(title, text);
    return;
  }
  const copyButton = event.target.closest("[data-copy-output]");
  if (copyButton) {
    event.preventDefault();
    const block = copyButton.closest(".outputReviewBlock");
    const text = block?.querySelector("pre")?.textContent || "";
    navigator.clipboard?.writeText(text).then(() => {
      copyButton.textContent = "\u30b3\u30d4\u30fc\u6e08\u307f";
      setTimeout(() => { copyButton.textContent = "\u30b3\u30d4\u30fc"; }, 1200);
    }).catch(() => null);
    return;
  }
  const deleteImageButton = event.target.closest(".productImageDeleteButton");
  if (deleteImageButton) {
    event.preventDefault();
    removeProductImageAction(deleteImageButton.dataset.productId, deleteImageButton.dataset.imageId);
    return;
  }
  const openProductImagesButton = event.target.closest("[data-open-product-images]");
  if (openProductImagesButton) {
    event.preventDefault();
    event.stopPropagation();
    openProductImagesDetail(openProductImagesButton.dataset.openProductImages);
  }
  const useVersionButton = event.target.closest("[data-banner-use-version]");
  if (useVersionButton) {
    event.preventDefault();
    event.stopPropagation();
    useBannerImageVersion(useVersionButton.dataset.bannerUseVersion, useVersionButton.dataset.versionPath);
    return;
  }
  const compareVersionButton = event.target.closest("[data-compare-version]");
  if (compareVersionButton) {
    event.preventDefault();
    event.stopPropagation();
    selectBannerComparePreview(compareVersionButton.dataset.compareVersion, compareVersionButton.dataset.versionPath);
    return;
  }
}

function handleGlobalUiChange(event) {
  const bannerAssetInput = event.target.closest(".bannerAssetUploadInput");
  if (bannerAssetInput) {
    const file = bannerAssetInput.files[0];
    if (file) uploadBannerAssetFromModal(bannerAssetInput, file);
    return;
  }
  const fileInput = event.target.closest(".adTemplateImageFile");
  if (fileInput) {
    const templateId = fileInput.dataset.templateId;
    const file = fileInput.files[0];
    if (templateId && file) updateAdTemplateImage(templateId, file);
    return;
  }
  const productImageFileInput = event.target.closest(".productImageFileInput");
  if (productImageFileInput) {
    const productId = productImageFileInput.dataset.productId;
    const file = productImageFileInput.files[0];
    const role = productImageFileInput.dataset.role || productImageFileInput.closest(".productImagesBlock")?.querySelector(".productImageUploadRole")?.value || "product";
    if (productId && file) uploadProductImage(productId, file, role);
    return;
  }
  const roleSelect = event.target.closest(".productImageRoleSelect");
  if (roleSelect) {
    updateProductImageField(roleSelect.dataset.productId, roleSelect.dataset.imageId, { role: roleSelect.value });
    return;
  }
  const labelInput = event.target.closest(".productImageLabelInput");
  if (labelInput) {
    updateProductImageField(labelInput.dataset.productId, labelInput.dataset.imageId, { label: labelInput.value.trim() });
  }
}

async function uploadBannerAssetFromModal(input, file) {
  const project = selectedProject();
  const productId = input.dataset.productId || research.products[0]?.id || "";
  const role = input.dataset.role || "product";
  const fieldset = input.closest(".bannerAssetField");
  const selectedByName = {};
  for (const checked of $$("#bannerAddModalBody .bannerAssetChoice input:checked")) {
    (selectedByName[checked.name] ||= []).push(checked.value);
  }
  try {
    input.disabled = true;
    const dataBase64 = await fileToBase64(file);
    const data = await post("/api/research/products/upload-image", {
      project: project.path,
      productId,
      fileName: file.name,
      dataBase64,
      role,
      label: file.name.replace(/\.[^.]+$/, "")
    });
    if (!data.ok) throw new Error(data.message || "アップロードに失敗しました。");
    await loadResearch();
    const name = fieldset?.dataset.assetName || input.dataset.name || "";
    if (fieldset && name) {
      fieldset.outerHTML = bannerImageMultiSelectHtml(productId, role, bannerAssetRoleLabel(role), name);
      const keep = new Set([...(selectedByName[name] || []), data.image?.path].filter(Boolean));
      for (const checkbox of $$(`#bannerAddModalBody input[name="${name}"]`)) checkbox.checked = keep.has(checkbox.value);
    }
    showToast("success", `${bannerAssetRoleLabel(role)}を追加しました。`);
  } catch (error) {
    if (input.isConnected) input.disabled = false;
    showToast("error", "画像のアップロードに失敗しました: " + error.message);
  }
}

function bannerAssetRoleLabel(role) {
  return role === "logo" ? "ロゴ" : role === "other" ? "その他画像" : "商品画像";
}

async function updateAdTemplateImage(templateId, file) {
  try {
    const dataBase64 = await fileToBase64(file);
    const data = await post("/api/ad-templates/upload-image", { fileName: file.name, dataBase64 });
    if (!data.ok) throw new Error(data.message || "アップロードに失敗しました。");
    await updateTableRow("adTemplate", templateId, { imageFile: data.url });
  } catch (error) {
    writeTerminal("error", "画像アップロードに失敗しました: " + error.message);
  }
}

async function uploadProductImage(productId, file, role) {
  const project = selectedProject();
  try {
    const dataBase64 = await fileToBase64(file);
    const data = await post("/api/research/products/upload-image", { project: project.path, productId, fileName: file.name, dataBase64, role: role || "product", label: "" });
    if (!data.ok) throw new Error(data.message || "アップロードに失敗しました。");
    showToast("success", "商品画像を追加しました。");
    await loadResearch();
    refreshSelectedPayload();
    renderResearch();
    renderInspector();
  } catch (error) {
    showToast("error", "商品画像のアップロードに失敗しました: " + error.message);
  }
}

async function removeProductImageAction(productId, imageId) {
  if (!productId || !imageId) return;
  if (!confirm("この画像を削除します。よろしいですか？")) return;
  const project = selectedProject();
  const data = await post("/api/research/products/remove-image", { project: project.path, productId, imageId });
  if (!data.ok) { showToast("error", data.message || "削除に失敗しました。"); return; }
  showToast("success", "商品画像を削除しました。");
  await loadResearch();
  refreshSelectedPayload();
  renderResearch();
  renderInspector();
}

async function updateProductImageField(productId, imageId, patch) {
  const product = research.products.find((item) => item.id === productId);
  if (!product) return;
  const images = (product.images || []).map((image) => image.id === imageId ? { ...image, ...patch } : image);
  await updateTableRow("product", productId, { images });
}

function toggleForm(id) {
  const element = $(`#${id}`);
  if (element) element.classList.toggle("hidden");
}

function closeForm(id) {
  const element = $(`#${id}`);
  if (element) element.classList.add("hidden");
}

function toggleSidebar() {
  const shell = document.querySelector(".appShell");
  if (!shell) return;
  const collapsed = !shell.classList.contains("sidebarCollapsed");
  sidebarAutoCollapsed = false;
  shell.classList.toggle("sidebarCollapsed", collapsed);
  localStorage.setItem("cmoai:sidebarCollapsed", collapsed ? "1" : "0");
  updateSidebarToggle(collapsed);
}

function updateSidebarToggle(collapsed) {
  const button = $("#toggleSidebar");
  if (!button) return;
  // "\u2039"(\u2039)/"\u203a"(\u203a): \u5883\u754c\u30dc\u30bf\u30f3\u306echevron\u5411\u304d(\u6298\u308a\u305f\u305f\u307f\u6642\u306f\u53f3\u5411\u304d\u306b\u53cd\u8ee2)\u3002
  button.textContent = collapsed ? "\u203a" : "\u2039";
  button.setAttribute("aria-label", collapsed ? "\u30b5\u30a4\u30c9\u30d0\u30fc\u3092\u958b\u304f" : "\u30b5\u30a4\u30c9\u30d0\u30fc\u3092\u9589\u3058\u308b");
  button.title = collapsed ? "\u30b5\u30a4\u30c9\u30d0\u30fc\u3092\u958b\u304f" : "\u30b5\u30a4\u30c9\u30d0\u30fc\u3092\u9589\u3058\u308b";
}

function switchView(view) {
  if (view === "materials" || view === "interviews") view = "facts";
  const foundationViews = ["products", "rules", "images"];
  const researchViews = ["facts"];
  const group = foundationViews.includes(view) ? "foundation" : researchViews.includes(view) ? "research" : null;
  const showTabBar = Boolean(group) && group !== "research";
  const tabBar = document.querySelector(".tabBar");
  if (tabBar) tabBar.style.display = showTabBar ? "flex" : "none";
  for (const button of $(".tabButton")) {
    button.classList.toggle("active", button.dataset.view === view);
    button.style.display = group && button.dataset.group === group ? "" : "none";
  }
  for (const button of $('[data-workspace]')) {
    button.classList.toggle("active", button.dataset.workspace === view
      || (button.dataset.workspace === "products" && foundationViews.includes(view))
      || (button.dataset.workspace === "facts" && researchViews.includes(view)));
  }
  for (const panel of $(".viewPanel")) panel.classList.toggle("active", panel.dataset.panel === view);
  const labels = { home: "\u6848\u4ef6\u30db\u30fc\u30e0", products: "\u524d\u63d0\u60c5\u5831 / \u5546\u54c1\u60c5\u5831", rules: "\u524d\u63d0\u60c5\u5831 / \u8868\u73fe\u30ec\u30ae\u30e5", images: "\u524d\u63d0\u60c5\u5831 / \u753b\u50cf", facts: "\u30ea\u30b5\u30fc\u30c1", strategies: "\u6226\u7565", banners: "\u5236\u4f5c", adTemplates: "\u5e83\u544a\u30c6\u30f3\u30d7\u30ecDB", settings: "\u8a2d\u5b9a" };
  const breadcrumbs = { home: "CMO AI Lite / \u6848\u4ef6\u30db\u30fc\u30e0", products: "CMO AI Lite / \u524d\u63d0\u60c5\u5831 / \u5546\u54c1\u60c5\u5831", rules: "CMO AI Lite / \u524d\u63d0\u60c5\u5831 / \u8868\u73fe\u30ec\u30ae\u30e5", images: "CMO AI Lite / \u524d\u63d0\u60c5\u5831 / \u753b\u50cf", facts: "CMO AI Lite / \u30ea\u30b5\u30fc\u30c1", strategies: "CMO AI Lite / \u6848\u4ef6\u30da\u30fc\u30b8 / \u6226\u7565", banners: "CMO AI Lite / \u6848\u4ef6\u30da\u30fc\u30b8 / \u5236\u4f5c", adTemplates: "CMO AI Lite / \u5171\u6709\u30e9\u30a4\u30d6\u30e9\u30ea / \u5e83\u544a\u30c6\u30f3\u30d7\u30ecDB", settings: "CMO AI Lite / \u8a2d\u5b9a" };
  const h1 = document.querySelector(".workspaceHeader h1");
  const breadcrumb = document.querySelector(".breadcrumb");
  if (h1) h1.textContent = labels[view] || h1.textContent;
  if (breadcrumb) breadcrumb.textContent = breadcrumbs[view] || breadcrumb.textContent;
  if (view === "settings") loadOpenAiSettings();
  renderViewStats();
}

// ヘッダー右側の統計チップ(#viewStats)。現在のビュー(.viewPanel.active)に
// 応じてDB件数のサマリーを表示のみ行う(クリック不可)。switchView()末尾と
// renderResearch()末尾(データ再描画のたび)の両方から呼び、案件切替や
// ポーリング更新でも数字が最新化されるようにする。
function viewStatChipHtml(value, label) {
  return '<span class="viewStatChip"><b>' + (Number(value) || 0) + '</b>' + escapeHtml(label) + '</span>';
}

function renderViewStats() {
  const target = $("#viewStats");
  if (!target) return;
  const view = document.querySelector(".viewPanel.active")?.dataset.panel || "home";
  let html = "";
  if (view === "products") {
    html = viewStatChipHtml((research.products[0]?.images || []).length, "枚の画像");
  } else if (view === "images") {
    const images = research.products[0]?.images || [];
    html = viewStatChipHtml(images.filter((item) => item.role === "product").length, "商品写真")
      + viewStatChipHtml(images.filter((item) => item.role === "logo").length, "ロゴ")
      + viewStatChipHtml(images.filter((item) => item.role === "other").length, "その他");
  } else if (view === "rules") {
    html = viewStatChipHtml((research.expressionRules || []).length, "件のルール"); } else if (view === "strategies") {
    const strategies = research.strategies || [];
    const proposed = strategies.filter((item) => (item.status || "proposed") === "proposed").length;
    const used = strategies.filter((item) => item.status === "used_in_creative").length;
    const archived = strategies.filter((item) => item.status === "archived").length;
    html = viewStatChipHtml(proposed, "提案中") + viewStatChipHtml(used, "採用済み") + viewStatChipHtml(archived, "アーカイブ");
  } else if (view === "banners") {
    const banners = research.banners || [];
    const completed = banners.filter((item) => item.imageGenerationStatus === "completed").length;
    html = viewStatChipHtml(banners.length, "バナー（画像完了" + completed + "）");
  } else if (view === "adTemplates") {
    const templates = (research.adTemplates || []).filter((item) => (item.creativeType || "banner") === "banner");
    html = viewStatChipHtml(templates.length, "件のバナーテンプレ");
  }
  target.innerHTML = html;
}

function selectItem(type, payload, options = {}) {
  if (type === "strategy") {
    if (options.strategyMode) strategyDetailMode = options.strategyMode === "edit" ? "edit" : "preview";
    else if (selected?.payload?.id !== payload?.id) strategyDetailMode = "preview";
  }
  selected = type && payload ? { type, payload } : null;
  renderInspector();
}

function refreshSelectedPayload() {
  if (!selected?.payload?.id) return;
  const sources = {
    product: research.products,
    material: research.materials,
    fact: research.facts,
    rule: research.expressionRules,
    strategy: research.strategies,
    banner: research.banners,
    adTemplate: research.adTemplates
  };
  const fresh = (sources[selected.type] || []).find((item) => item.id === selected.payload.id);
  selected = fresh ? { type: selected.type, payload: fresh } : null;
}

function renderInspector() {
  const pane = $("#detailPane");
  const title = $("#detailPaneTitle");
  const kicker = $("#detailPaneKicker");
  const body = $("#detailPaneBody");
  const preview = $("#detailPanePreview");
  const statusRow = $("#detailPaneStatusRow");
  const expandButton = $("#expandDetailPane");
  const previousScrollTop = body?.scrollTop || 0;
  const openDetailIndexes = body
    ? [...body.querySelectorAll("details")].map((item, index) => item.open ? index : -1).filter((index) => index >= 0)
    : [];
  document.querySelector(".appShell")?.classList.toggle("detailOpen", Boolean(selected));
  if (!pane || !title || !kicker || !body || !preview) return;
  if (!selected) {
    pane.setAttribute("aria-hidden", "true");
    kicker.textContent = "選択";
    title.textContent = "未選択";
    body.innerHTML = '<div class="emptyDetail">行を選択すると詳細を確認できます。</div>';
    preview.innerHTML = "";
    preview.hidden = true;
    if (statusRow) statusRow.innerHTML = "";
    if (expandButton) expandButton.hidden = true;
    const quick = $("#detailQuickActions");
    if (quick) { quick.innerHTML = ""; quick.hidden = true; }
    return;
  }
  const { type, payload } = selected;
  if (expandButton) expandButton.hidden = type === "strategy";
  pane.setAttribute("aria-hidden", "false");
  kicker.textContent = typeLabel(type);
  title.textContent = displayTitle(type, payload);
  if (statusRow) statusRow.innerHTML = detailStatusPillsHtml(type, payload);
  const previewMarkup = previewHtml(type, payload);
  preview.innerHTML = previewMarkup;
  preview.hidden = !previewMarkup;
  body.innerHTML = type === "strategy" ? strategyInspectorHtml(payload) : detailModalHtml(type, payload);
  bindAdTemplateDetailEditors(body);
  if (type === "strategy") bindStrategyInspector(body, payload);
  for (const index of openDetailIndexes) {
    const detail = body.querySelectorAll("details")[index];
    if (detail) detail.open = true;
  }
  body.scrollTop = previousScrollTop;
  renderDetailQuickActions(type, payload);
}

// Status pills shown right under the kicker/title in the detail pane header
// (item A-1). Only the statuses relevant to each row type are shown, and a
// type/value with no relevant status renders nothing.
function detailStatusPillsHtml(type, value) {
  if (!value) return "";
  const pills = [];
  if (type === "material") pills.push(statusPill(value.extractionStatus || "pending"));
  if (type === "strategy") pills.push(statusPill(value.status || "proposed"));
  if (type === "banner") {
    pills.push(labeledStatusPill("制作", value.productionStatus || "not_started"));
    pills.push(labeledStatusPill("画像", value.imageGenerationStatus || "not_started"));
  }
  if (type === "copy") pills.push(pill(value.media || "generic"));
  if (type === "copy" || type === "script" || type === "article") pills.push(statusPill(value.productionStatus || "not_started"));
  if (type === "adTemplate") {
    pills.push(statusPill(value.templateStatus || "not_started"));
    pills.push(templateProcessingPill(value.templateProcessingStatus));
  }
  return pills.join("");
}

// Whether the selected row currently has an AI job running against it, so the
// preview area can show a "生成中…" placeholder instead of an empty box.
function isRowGenerating(type, value) {
  if (!value) return false;
  if (type === "banner") return !isBannerJobStale(value) && (["queued", "generating"].includes(value.imageGenerationStatus) || ["prompt_queued", "prompt_generating", "generating", "revising"].includes(value.productionStatus));
  if (type === "material") return value.extractionStatus === "extracting" || activeExtractions.has(value.id);
  if (type === "copy" || type === "script" || type === "article") return value.productionStatus === "generating";
  if (type === "adTemplate") return isTemplateAnalysisActive(value);
  return false;
}

function generatingPreviewHtml() {
  return '<div class="previewGenerating"><span class="spinner" aria-hidden="true"></span>生成中…</div>';
}

function renderDetailQuickActions(type, payload) {
  const host = $("#detailQuickActions");
  if (!host) return;
  host.innerHTML = "";
  const buttons = [];
  if (type === "banner" && payload?.id) {
    const id = payload.id;
    buttons.push(runningActionButton(bannerGenerateActionLabel(payload), "bannerImage", id, (btn) => generateBannerFull(id, btn), isBannerImageBusy(payload)));
    if (payload.generatedImagePath) {
      const editBusy = isBannerImageBusy(payload) || isRunning("bannerImage:" + id);
      buttons.push(rowActionButton("範囲指定修正", () => openBannerEditModal(id), editBusy));
      buttons.push(rowActionButton("全体修正", () => openBannerFullEditModal(id), editBusy));
      const download = document.createElement("a");
      download.className = "tableButton detailDownloadButton";
      download.href = resolveImageSrc(payload.generatedImagePath);
      download.download = bannerDownloadFileName(payload);
      download.textContent = "画像をダウンロード";
      buttons.push(download);
    }
    buttons.push(rowDeleteButton("banner", id));
  }
  if (type === "adTemplate" && payload?.id) {
    const id = payload.id;
    const analysisActive = isTemplateAnalysisActive(payload);
    buttons.push(runningActionButton(analysisActive ? templateProcessingLabel(payload.templateProcessingStatus) : "テンプレ化", "templateImage", id, (btn) => templateAdImage(id, btn), !payload.imageFile || analysisActive));
  }
  if (type === "material" && payload?.id && payload.sourceUrl) {
    buttons.push(runningActionButton("LP書き出し", "materialExtract", payload.id, () => extractMaterial(payload.id)));
  }
  if (!buttons.length) { host.hidden = true; return; }
  host.hidden = false;
  for (const b of buttons) host.appendChild(b);
}

function displayTitle(type, value) {
  if (!value) return "";
  if (type === "product") return value.name || "\u5546\u54c1";
  if (type === "material") return value.title || "\u8cc7\u6599";
  if (type === "fact") return value.title || "\u4e8b\u5b9f";
  if (type === "rule") return value.pattern || "\u8868\u73fe\u30ec\u30ae\u30e5\u30ec\u30fc\u30b7\u30e7\u30f3";
  if (type === "strategy") return value.conceptName || "戦略";
  if (type === "strategyProposal") return value.conceptName || "戦略\u63d0\u6848";
  if (type === "banner") return value.title || "\u30d0\u30ca\u30fc\u6848";
  if (type === "copy") return value.title || "\u5e83\u544a\u6587\u6848";
  if (type === "script") return value.title || "\u53f0\u672c\u6848";
  if (type === "article") return value.title || "\u8a18\u4e8bLP\u6848";
  if (type === "adTemplate") return value.title || "\u5e83\u544a\u30c6\u30f3\u30d7\u30ec";
  if (type === "database") return value.name || "\u30c7\u30fc\u30bf\u30d9\u30fc\u30b9";
  return "\u672a\u9078\u629e";
}

function previewHtml(type, value) {
  const generating = isRowGenerating(type, value);
  const bannerImage = value?.generatedImagePath || value?.images?.[0] || value?.thumbnailUrl;
  if (type === "banner" && bannerImage) return imageCellHtml(bannerImage).replace('imageCellButton', 'imageCellButton largePreviewButton');
  if (type === "banner") {
    if (generating) return generatingPreviewHtml();
    return `<div class="largeGenerated"><span>${escapeHtml(value.short || "BN")}</span><b>${escapeHtml(value.title || "バナー案")}</b><p>${escapeHtml(value.imageText || value.promptText || JSON.stringify(value.promptJson || {}, null, 2))}</p></div>`;
  }
  if (type === "material" && value.screenshotUrl) return `<button type="button" class="largePreviewImageButton" data-preview-image="${escapeAttr(value.screenshotUrl)}" data-preview-title="${escapeAttr(value.title || "スクリーンショット")}"><img class="largePreview" src="${escapeAttr(value.screenshotUrl)}" alt="" /></button>`;
  if (type === "adTemplate" && value.imageFile) return imageCellHtml(value.imageFile).replace('imageCellButton', 'imageCellButton largePreviewButton');
  if (type === "fact") return `<div class="documentPreview"><span>${escapeHtml(value.category || "Fact")}</span><h3>${escapeHtml(value.title || "Fact")}</h3><p>${escapeHtml(value.content || "")}</p></div>`;
  if (type === "product") return `<div class="documentPreview"><span>商品マスター</span><h3>${escapeHtml(value.name || "商品")}</h3><p>${escapeHtml(value.shortDescription || "")}</p></div>`;
  return generating ? generatingPreviewHtml() : "";
}

function showToast(kind, message) {
  const stack = $("#toastStack");
  let text = String(message || "");
  if (!stack || !text) return null;
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.message === "string" && parsed.message) text = parsed.message;
    } catch {}
  }
  const toast = document.createElement("div");
  toast.className = `toast toast-${kind || "info"}`;
  const body = document.createElement("span");
  body.className = "toastMessage";
  body.textContent = text;
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "toastClose";
  closeButton.setAttribute("aria-label", "通知を閉じる");
  closeButton.textContent = "×";
  closeButton.addEventListener("click", () => toast.remove());
  toast.appendChild(body);
  toast.appendChild(closeButton);
  stack.appendChild(toast);
  if (kind !== "error") setTimeout(() => toast.remove(), 7000);
  return toast;
}

// Prevents double-clicking the same AI action twice while it is in flight, and
// gives the triggering button an immediate "running" state. Keyed per
// action+target (e.g. "bannerPrompt:bn_123") so unrelated rows/products can
// still run in parallel; only the same key is serialized.
let liveRefreshTimer = null;

function hasActiveWork() {
  if (runningActions.size > 0) return true;
  if (pendingBannerEdits.size > 0) return true;
  const busyBanner = (research.banners || []).some((b) =>
    !isBannerJobStale(b) && (["queued", "generating"].includes(b.imageGenerationStatus)
    || ["prompt_queued", "prompt_generating", "generating", "revising"].includes(b.productionStatus)));
  const busyMaterial = (research.materials || []).some((m) => m.extractionStatus === "extracting");
  const busyTemplate = (research.adTemplates || []).some(isTemplateAnalysisActive);
  return busyBanner || busyMaterial || busyTemplate;
}

function hasActiveWorkExceptTemplates() {
  if (runningActions.size > 0) return true;
  return (research.banners || []).some((b) =>
    !isBannerJobStale(b) && (["queued", "generating"].includes(b.imageGenerationStatus)
    || ["prompt_queued", "prompt_generating", "generating", "revising"].includes(b.productionStatus)))
    || (research.materials || []).some((m) => m.extractionStatus === "extracting");
}

async function refreshActiveTemplateStatuses() {
  const activeIds = (research.adTemplates || []).filter(isTemplateAnalysisActive).map((item) => item.id);
  if (!activeIds.length) return { refreshed: false, completed: false };
  const data = await get("/api/ad-templates/template-image/status?templateIds=" + encodeURIComponent(activeIds.join(",")));
  if (!data.ok) throw new Error(data.message || "テンプレート解析状態を取得できませんでした。");
  const statuses = new Map((data.templates || []).map((item) => [item.templateId, item]));
  let completed = activeIds.some((templateId) => !statuses.has(templateId));
  research.adTemplates = (research.adTemplates || []).map((template) => {
    const status = statuses.get(template.id);
    if (!status) return template;
    if (isTemplateAnalysisActive(template) && !["queued", "running"].includes(status.templateProcessingStatus)) completed = true;
    return { ...template, ...status };
  });
  return { refreshed: true, completed };
}

function captureAdTemplateDraft() {
  return {
    title: $("#templateTitle")?.value || "",
    image: $("#templateImage")?.value || "",
    status: $("#templateImageStatus")?.textContent || ""
  };
}

function restoreAdTemplateDraft(draft) {
  if (!draft) return;
  if ($("#templateTitle")) $("#templateTitle").value = draft.title;
  if ($("#templateImage")) $("#templateImage").value = draft.image;
  if ($("#templateImageStatus")) $("#templateImageStatus").textContent = draft.status;
}

function renderResearchPreservingAdTemplateDraft() {
  const draft = captureAdTemplateDraft();
  renderResearch();
  restoreAdTemplateDraft(draft);
}

function isEditingNow() {
  if (document.querySelector(".cellEditor")) return true;
  const active = document.activeElement;
  return Boolean(active && active.closest && active.matches("input, textarea, select") && !active.closest("#toastStack"));
}

function flushPendingBannerEditToasts() {
  if (!pendingBannerEdits.size) return;
  for (const [bannerId, editMode] of [...pendingBannerEdits.entries()]) {
    const label = editMode === "full" ? "全体修正" : "範囲指定修正";
    const banner = (research.banners || []).find((item) => item.id === bannerId);
    if (!banner) {
      pendingBannerEdits.delete(bannerId);
      continue;
    }
    if (isBannerImageBusy(banner)) continue;
    pendingBannerEdits.delete(bannerId);
    const editError = String(banner.lastImageEditError || "").trim();
    if (editError) {
      showToast("error", label + "に失敗しました。" + editError);
      writeTerminal("error", label + "に失敗: " + editError);
      continue;
    }
    showToast("success", label + "が完了しました。");
    writeTerminal("system", label + "が完了しました。");
  }
}

function ensureLiveRefresh() {
  if (liveRefreshTimer) return;
  liveRefreshTimer = setInterval(async () => {
    if (!hasActiveWork()) {
      clearInterval(liveRefreshTimer);
      liveRefreshTimer = null;
      return;
    }
    if (isEditingNow()) return;
    try {
      const activeTemplates = (research.adTemplates || []).some(isTemplateAnalysisActive);
      if (activeTemplates && !hasActiveWorkExceptTemplates()) {
        const statusResult = await refreshActiveTemplateStatuses();
        if (statusResult.completed) await loadResearch();
      } else {
        await loadResearch();
      }
      renderResearchPreservingAdTemplateDraft();
      flushPendingBannerEditToasts();
      if (selected) { refreshSelectedPayload(); renderInspector(); }
    } catch {}
  }, 3000);
}

async function runExclusive(key, button, fn) {
  if (runningActions.has(key)) {
    showToast("info", "実行中です。完了までお待ちください。");
    return undefined;
  }
  runningActions.add(key);
  ensureLiveRefresh();
  const originalLabel = button ? button.textContent : null;
  if (button) {
    button.disabled = true;
    button.classList.add("isRunning");
    button.textContent = "実行中…";
  }
  try {
    return await fn();
  } finally {
    runningActions.delete(key);
    if (button && button.isConnected) {
      button.disabled = false;
      button.classList.remove("isRunning");
      button.textContent = originalLabel;
    }
    renderResearch();
  }
}

function isRunning(key) {
  return runningActions.has(key);
}

// Row/card action buttons are rebuilt on every renderResearch(), so their
// running state has to be recomputed here from runningActions each time
// rather than relying on the button instance runExclusive() touched.
function runningActionButton(label, keyPrefix, id, handler, extraDisabled = false) {
  const key = `${keyPrefix}:${id}`;
  const running = isRunning(key);
  return rowActionButton(running ? "実行中…" : label, handler, running || extraDisabled);
}

function writeTerminal(kind, message) {
  const text = String(message || "");
  if (kind === "error") {
    // The server responds with errorCode "ALREADY_RUNNING" when the same AI job
    // is already in flight for this row (e.g. a page reload re-fired the
    // request). That is not a failure, so surface it as an info toast rather
    // than an error toast.
    if (text.startsWith("{")) {
      try {
        const parsed = JSON.parse(text);
        if (parsed && parsed.errorCode === "ALREADY_RUNNING") {
          showToast("info", parsed.message || text);
          return null;
        }
      } catch {}
    }
    showToast("error", text);
    return null;
  }
  console.log("[CMOAI]", text);
  return null;
}

function openDetailModal(type, payload) {
  const modal = $("#detailModal");
  const title = $("#detailModalTitle");
  const kicker = $("#detailModalKicker");
  const body = $("#detailModalBody");
  if (!modal || !title || !kicker || !body) return;
  kicker.textContent = typeLabel(type);
  title.textContent = displayTitle(type, payload);
  imageGallery = null;
  body.innerHTML = '<div class="detailModalContent">' + detailModalHtml(type, payload) + '</div>';
  modal.classList.remove("hidden");
}

function screenshotThumbsHtml(screenshots, titleBase) {
  const galleryJson = escapeAttr(JSON.stringify(screenshots));
  const base = titleBase || "スクリーンショット";
  return screenshots.map((src, index) =>
    '<button type="button" class="screenshotThumb" data-preview-image="' + escapeAttr(src) + '" data-preview-title="' + escapeAttr(base + " " + (index + 1)) + '" data-preview-gallery="' + galleryJson + '" data-preview-index="' + index + '"><img src="' + escapeAttr(src) + '" alt="" /></button>'
  ).join("");
}

let imageGallery = null; // { items: string[], index: number, titleBase: string }

function openImageModal(src, titleText, gallery) {
  const modal = $("#detailModal");
  const kicker = $("#detailModalKicker");
  if (!modal || !kicker || !src) return;
  imageGallery = gallery && gallery.items.length > 1 ? { items: gallery.items, index: gallery.index, titleBase: titleText || "" } : null;
  kicker.textContent = "\u30af\u30ea\u30a8\u30a4\u30c6\u30a3\u30d6\u78ba\u8a8d";
  renderImageModalStage(src, titleText);
  modal.classList.remove("hidden");
}

// アウトプット等の長文を、詳細ペインの狭い枠ではなく大きなモーダルで読めるようにする。
// 画像モーダルと同じ #detailModal を流用し、本文を大きな pre で全画面近くに表示する。
function openTextModal(titleText, text) {
  const modal = $("#detailModal");
  const kicker = $("#detailModalKicker");
  const title = $("#detailModalTitle");
  const body = $("#detailModalBody");
  if (!modal || !kicker || !title || !body) return;
  imageGallery = null;
  kicker.textContent = "アウトプット";
  title.textContent = titleText || "アウトプット";
  body.innerHTML = '<div class="textZoomStage"><pre class="textZoomPre">' + escapeHtml(text || "") + '</pre></div>'
    + '<div class="textZoomActions"><button type="button" class="ghostButton" data-copy-text-modal>コピー</button></div>';
  const copyBtn = body.querySelector("[data-copy-text-modal]");
  if (copyBtn) {
    copyBtn.addEventListener("click", () => {
      navigator.clipboard?.writeText(text || "").then(() => {
        copyBtn.textContent = "コピー済み";
        setTimeout(() => { copyBtn.textContent = "コピー"; }, 1200);
      }).catch(() => null);
    });
  }
  modal.classList.remove("hidden");
}

function renderImageModalStage(src, titleText) {
  const title = $("#detailModalTitle");
  const body = $("#detailModalBody");
  if (!title || !body) return;
  title.textContent = titleText || "\u753b\u50cf\u30d7\u30ec\u30d3\u30e5\u30fc";
  const nav = imageGallery
    ? `<button type="button" class="imageZoomNav prev" data-gallery-nav="-1" aria-label="\u524d\u306e\u753b\u50cf">\u2039</button>
       <span class="imageZoomCounter">${imageGallery.index + 1} / ${imageGallery.items.length}</span>
       <button type="button" class="imageZoomNav next" data-gallery-nav="1" aria-label="\u6b21\u306e\u753b\u50cf">\u203a</button>`
    : "";
  body.innerHTML = '<div class="imageZoomStage">' + nav + '<img src="' + escapeAttr(src) + '" alt="" /></div>';
}

function stepImageGallery(delta) {
  if (!imageGallery) return;
  const count = imageGallery.items.length;
  imageGallery.index = (imageGallery.index + delta + count) % count;
  const nextSrc = imageGallery.items[imageGallery.index];
  renderImageModalStage(nextSrc, `${imageGallery.titleBase} ${imageGallery.index + 1}`.trim());
}

function closeDetailModal() {
  $("#detailModal")?.classList.add("hidden");
  imageGallery = null;
}

function typeLabel(type) {
  const labels = { product: "\u5546\u54c1\u30de\u30b9\u30bf\u30fc", material: "\u8cc7\u6599", fact: "\u4e8b\u5b9f", rule: "\u8868\u73fe\u30ec\u30ae\u30e5\u30ec\u30fc\u30b7\u30e7\u30f3", strategy: "戦略", strategyProposal: "戦略\u63d0\u6848", banner: "\u30d0\u30ca\u30fc", copy: "\u5e83\u544a\u6587", script: "\u53f0\u672c", article: "\u8a18\u4e8bLP", adTemplate: "\u5e83\u544a\u30c6\u30f3\u30d7\u30ec", database: "\u30c7\u30fc\u30bf\u30d9\u30fc\u30b9" };
  return labels[type] || "\u8a73\u7d30";
}

function detailModalHtml(type, value) {
  if (!value) return `<div class="emptyDetail">項目がありません</div>`;
  if (type === "material") return materialReviewDetailHtml(value);
  if (type === "product") return productDetailHtml(value);
  if (type === "fact") return factDetailHtml(value);
  if (type === "rule") return ruleDetailHtml(value);
  if (type === "strategy") return strategyDetailHtml(value);
  if (type === "strategyProposal") return strategyProposalDetailHtml(value);
  if (type === "banner") return bannerDetailHtml(value);
  if (type === "adTemplate") return adTemplateDetailHtml(value);
  return genericDetailHtml(value);
}

// 媒体別フィールド(RSA見出し15本、Meta本文等)をドロワーに表示するブロック。multipleな
// フィールドは番号付きリスト+各行に字数バッジ(超過は赤 --danger-fg)を出す。ヘッダーの
// 「コピー」ボタンはoutputReviewBlockHtmlと同じ仕組み(隠しpreの内容をコピー)で全文まとめコピーにする。
// 要件定義(requirements): Before/After心の声と構成対応表を表示する。
function articleRequirementsBlockHtml(requirements) {
  if (!requirements) return "";
  const structure = Array.isArray(requirements.structure) ? requirements.structure : [];
  const rows = structure.length
    ? structure.map((item) => '<tr><td>' + escapeHtml(String(item.no || "")) + '</td><td>' + escapeHtml(item.element || "") + '</td><td>' + escapeHtml(item.innerVoice || "") + '</td></tr>').join("")
    : '<tr><td colspan="3" class="mutedCell">構成はまだありません。</td></tr>';
  const table = '<div class="tableWrap"><table class="dataTable"><thead><tr><th>No</th><th>構成要素</th><th>読んだ瞬間の心の声</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  const summaryHtml = '<p><b>Before心の声</b>: ' + escapeHtml(requirements.beforeVoice || "") + '</p>'
    + '<p><b>After心の声</b>: ' + escapeHtml(requirements.afterVoice || "") + '</p>'
    + '<p><b>参考テンプレ選定</b>: ' + escapeHtml(requirements.templateSelection || "") + '</p>';
  return '<section class="outputReviewBlock tall"><header><h3>要件定義</h3></header>' + summaryHtml + table + '</section>';
}

// セルフレビュー(review): チェックリストと総評・合否を表示する。
function articleReviewBlockHtml(review) {
  if (!review) return "";
  const checklist = Array.isArray(review.checklist) ? review.checklist : [];
  const rows = checklist.length
    ? checklist.map((item) => '<tr><td>' + (item.ok ? "✓" : "✕") + '</td><td>' + escapeHtml(item.item || "") + '</td><td>' + escapeHtml(item.comment || "") + '</td></tr>').join("")
    : '<tr><td colspan="3" class="mutedCell">チェック項目はまだありません。</td></tr>';
  const table = '<div class="tableWrap"><table class="dataTable"><thead><tr><th></th><th>チェック項目</th><th>コメント</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  const verdictLabel = review.verdict === "revise" ? "要修正" : "合格";
  return '<section class="outputReviewBlock tall"><header><h3>セルフレビュー(' + escapeHtml(verdictLabel) + ')</h3></header><p class="mutedCell">' + escapeHtml(review.summary || "") + '</p>' + table + '</section>';
}

function productDetailHtml(value) {
  return detailSectionsHtml({
    basicRows: [
      ["商品名", value.name],
      ["LP", value.officialUrl],
      ["簡易説明", value.shortDescription],
      ["トンマナ", value.brandTone]
    ],
    extraHtml: productImagesBlockHtml(value),
    rawRows: [
      ["ID", value.id],
      ["作成日時", formatDateTime(value.createdAt)],
      ["更新日時", formatDateTime(value.updatedAt)]
    ]
  });
}

function productImagesBlockHtml(product) {
  const images = Array.isArray(product.images) ? product.images : [];
  const cards = images.length
    ? images.map((image) => productImageCardHtml(product.id, image)).join("")
    : '<p class="mutedCell">画像はまだ登録されていません。</p>';
  return '<section class="detailOutputBlock productImagesBlock" data-product-id="' + escapeAttr(product.id) + '">'
    + '<h3>商品画像・ロゴ</h3>'
    + '<div class="productImageGrid">' + cards + '</div>'
    + '<div class="productImageUploadRow">'
    + '<select class="tableSelect productImageUploadRole" data-product-id="' + escapeAttr(product.id) + '">'
    + '<option value="product">商品写真</option><option value="logo">ロゴ</option><option value="other">その他</option>'
    + '</select>'
    + '<label class="tableButton imageUploadButton">画像を追加<input type="file" accept="image/*" class="productImageFileInput" data-product-id="' + escapeAttr(product.id) + '" hidden /></label>'
    + '</div></section>';
}

function productImageCardHtml(productId, image) {
  const src = resolveImageSrc(image.path);
  const roleOptions = [["product", "商品写真"], ["logo", "ロゴ"], ["other", "その他"]]
    .map(([value, label]) => '<option value="' + value + '" ' + (image.role === value ? "selected" : "") + '>' + escapeHtml(label) + '</option>')
    .join("");
  return '<div class="productImageCard">'
    + '<button type="button" class="imageCellButton" data-preview-image="' + escapeAttr(src) + '" data-preview-title="' + escapeAttr(image.label || image.path) + '"><img src="' + escapeAttr(src) + '" alt="" /></button>'
    + '<div class="productImageMeta">'
    + '<select class="tableSelect productImageRoleSelect" data-product-id="' + escapeAttr(productId) + '" data-image-id="' + escapeAttr(image.id) + '">' + roleOptions + '</select>'
    + '<input type="text" class="tableInput productImageLabelInput" data-product-id="' + escapeAttr(productId) + '" data-image-id="' + escapeAttr(image.id) + '" value="' + escapeAttr(image.label || "") + '" placeholder="素材名（例：正面）" aria-label="素材名" />'
    + '<button type="button" class="tableButton iconDelete productImageDeleteButton" title="削除" aria-label="削除" data-product-id="' + escapeAttr(productId) + '" data-image-id="' + escapeAttr(image.id) + '"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6"/></svg></button>'
    + '</div></div>';
}

function materialReviewDetailHtml(value) {
  const product = research.products.find((item) => item.id === value.productId);
  const status = statusMeta(value.extractionStatus);
  const latestJob = latestExtractionJob(value.id);
  const steps = Array.isArray(latestJob?.steps) ? latestJob.steps : [];
  const stepText = steps.length
    ? steps.map((step) => "- " + [step.label, displayValue(step.status), step.detail].filter(Boolean).join(" / ")).join("\n")
    : "まだ抽出ジョブの詳細はありません。";
  const screenshots = Array.isArray(value.screenshotUrls) ? value.screenshotUrls : [];
  const screenshotHtml = screenshots.length
    ? '<section class="outputReviewBlock"><header><h3>スクリーンショット</h3><span>' + screenshots.length + '枚</span></header><div class="screenshotStrip">' + screenshotThumbsHtml(screenshots, value.title) + '</div></section>'
    : "";
  return detailSectionsHtml({
    basicRows: [
      ["資料名", value.title],
      ["商品", product?.name || "未選択"],
      ["分類", displayValue(value.type)],
      ["URL", value.sourceUrl],
      ["手動本文", value.manualText]
    ],
    outputBlocks: [
      outputReviewBlockHtml("アウトプット", value.extractedText || "まだアウトプットはありません。LP書き出しを実行してください。", { tall: true, readable: true }),
      outputReviewBlockHtml("画像LP分析", value.visualAnalysis || "まだ画像LP分析はありません。", { tall: true, readable: true }),
      screenshotHtml,
      outputReviewBlockHtml("抽出プロセス", stepText)
    ],
    rawRows: [
      ["ID", value.id],
      ["商品ID", value.productId],
      ["状態詳細", status.detail],
      ["スクショ状態", displayValue(value.screenshotStatus || "not_needed")],
      ["スクショ枚数", screenshots.length ? String(screenshots.length) + "枚" : ""],
      ["最新ジョブ", latestJob ? [displayValue(latestJob.status), latestJob.errorMessage].filter(Boolean).join(" / ") : "ジョブなし"],
      ["作成日時", formatDateTime(value.createdAt)],
      ["更新日時", formatDateTime(value.updatedAt)]
    ]
  });
}

function factDetailHtml(value) {
  const product = research.products.find((item) => item.id === value.productId);
  return detailSectionsHtml({
    basicRows: [
      ["商品", product?.name || "未選択"],
      ["カテゴリ", displayValue(value.category)],
      ["名前", value.title],
      ["内容", stripFactReferenceMarkers(value.content)],
      ["作成者", value.createdBy],
      ["引用元", value.sourceUrl || value.sourceMaterialId || value.sourceType],
      ["信頼度", value.confidenceScore]
    ],
    outputBlocks: [
      referenceListBlockHtml(value),
      webSearchEvidenceBlockHtml(value)
    ],
    rawRows: [
      ["ID", value.id],
      ["商品ID", value.productId],
      ["作成日時", formatDateTime(value.createdAt)]
    ]
  });
}

// 事実本文とは分けて、参照元URLを出典番号付きで表示する。
// references(配列)があればそれを、なければsourceUrlを1件のフォールバックとして表示する。両方空ならブロック自体を出さない。
function referenceListBlockHtml(value) {
  const refs = Array.isArray(value.references) ? value.references.map((item) => String(item || "").trim()).filter(Boolean) : [];
  const urls = refs.length ? refs : (value.sourceUrl ? [String(value.sourceUrl).trim()].filter(Boolean) : []);
  if (!urls.length) return "";
  const items = urls.map((url, index) => {
    const reference = /^https?:\/\//i.test(url)
      ? '<a href="' + escapeAttr(url) + '" target="_blank" rel="noopener">' + escapeHtml(url) + '</a>'
      : '<span>' + escapeHtml(url) + '</span>';
    return '<div class="referenceItem">出典' + (index + 1) + ' ' + reference + '</div>';
  }).join("");
  return '<section class="outputReviewBlock"><header><h3>参照元</h3><span>' + urls.length + '件</span></header><div class="referenceList">' + items + '</div></section>';
}

function webSearchEvidenceBlockHtml(value) {
  const status = String(value.webSearchStatus || "");
  const queries = Array.isArray(value.searchQueriesRun) ? value.searchQueriesRun.map((item) => String(item || "").trim()).filter(Boolean) : [];
  if (!status && !queries.length) return "";
  const statusLabels = {
    completed: "実行済み",
    fallback: "未実行（商品情報・登録資料のみで抽出）",
    disabled: "無効"
  };
  const queryItems = queries.map((query) => '<li>' + escapeHtml(query) + '</li>').join("");
  const queryHtml = queryItems ? '<ol class="searchEvidenceQueries">' + queryItems + '</ol>' : '<p class="searchEvidenceEmpty">検索クエリの記録はありません。</p>';
  return '<section class="outputReviewBlock searchEvidenceBlock"><header><h3>Web検索の根拠</h3><span>' + escapeHtml(statusLabels[status] || status) + '</span></header>' + queryHtml + '</section>';
}

function ruleDetailHtml(value) {
  const product = research.products.find((item) => item.id === value.productId);
  return detailSectionsHtml({
    basicRows: [
      ["商品", product?.name || "未選択"],
      ["種別", displayValue(value.ruleType)],
      ["NG / ルール", value.pattern],
      ["代替表現", value.replacement],
      ["説明", value.description],
      ["重要度", displayValue(value.severity)],
      ["有効", value.active ? "有効" : "無効"]
    ],
    rawRows: [
      ["ID", value.id],
      ["商品ID", value.productId]
    ]
  });
}

const ENUM_DETAIL_KEYS = new Set(["creativeType", "ownership", "templateStatus", "role", "type", "ruleType", "severity", "status", "extractionStatus", "insightStatus", "productionStatus", "imageGenerationStatus", "screenshotStatus"]);

function genericDetailHtml(value) {
  return detailSection(Object.entries(value).map(([key, raw]) => {
    if (typeof raw === "object" && raw !== null) return [fieldLabel(key), JSON.stringify(raw, null, 2)];
    const text = ENUM_DETAIL_KEYS.has(key) ? displayValue(raw) : raw;
    return [fieldLabel(key), text];
  }));
}

function strategyDetailHtml(value) {
  const product = research.products.find((item) => item.id === value.productId);
  return detailSectionsHtml({
    basicRows: [
      ["商品", product?.name || "未選択"],
      ["戦略コンセプト", value.conceptName]
    ],
    outputBlocks: [
      outputReviewBlockHtml("戦略本文", value.markdown || composeStrategyProse(value), { tall: true, readable: true })
    ],
    rawRows: [
      ["ターゲット属性", value.targetAttributes],
      ["欲求", value.desire],
      ["判断基準", value.decisionCriteria],
      ["想定競合", value.alternatives],
      ["商品コンセプト", value.productConcept],
      ["USP", value.usp],
      ["ベネフィット", value.benefit],
      ["実績", value.proof],
      ["オファー", value.offer],
      ["ID", value.id],
      ["商品ID", value.productId],
      ["作成日時", formatDateTime(value.createdAt)],
      ["更新日時", formatDateTime(value.updatedAt)]
    ]
  });
}

function strategyProposalDetailHtml(value) {
  return detailSectionsHtml({
    basicRows: [
      ["保存状態", "未保存のAI提案です。内容確認後に「提案を保存」を押すと戦略 DBへ保存されます。"],
      ["戦略コンセプト", value.conceptName]
    ],
    outputBlocks: [
      outputReviewBlockHtml("戦略本文", value.markdown || composeStrategyProse(value), { tall: true, readable: true })
    ],
    rawRows: [
      ["ターゲット属性", value.targetAttributes],
      ["欲求", value.desire],
      ["判断基準", value.decisionCriteria],
      ["想定競合", value.alternatives],
      ["商品コンセプト", value.productConcept],
      ["USP", value.usp],
      ["ベネフィット", value.benefit],
      ["実績", value.proof],
      ["オファー", value.offer]
    ]
  });
}

function assetThumbRowHtml(value) {
  const items = [];
  const append = (label, paths, legacyPath) => {
    const uniquePaths = [...new Set([...(Array.isArray(paths) ? paths : []), legacyPath].filter(Boolean))];
    uniquePaths.forEach((path, index) => items.push({ label: uniquePaths.length > 1 ? label + " " + (index + 1) : label, path }));
  };
  append("商品画像", value.productImagePaths, value.productImagePath);
  append("ロゴ", value.logoImagePaths, value.logoImagePath);
  append("その他画像", value.otherImagePaths, value.otherImagePath);
  if (!items.length) return "";
  return '<div class="assetThumbRow">' + items.map((item) =>
    '<figure class="assetThumb">' + imageCellHtml(item.path) + '<figcaption>' + escapeHtml(item.label) + '</figcaption></figure>'
  ).join("") + '</div>';
}

function bannerDetailHtml(value) {
  const product = research.products.find((item) => item.id === value.productId);
  const strategy = (research.strategies || []).find((item) => item.id === value.strategyId);
  const template = (research.adTemplates || []).find((item) => item.id === value.templateAdId);
  const image = value.generatedImagePath || value.images?.[0] || value.thumbnailUrl || "";
  const imageSrc = image ? resolveImageSrc(image) : "";
  const imageHtml = imageSrc
    ? '<section class="outputReviewBlock creativePreviewBlock"><header><h3>生成画像</h3><a class="tableButton detailDownloadButton" href="' + escapeAttr(imageSrc) + '" download="' + escapeAttr(bannerDownloadFileName(value)) + '">ダウンロード</a></header><button class="creativePreviewImage" type="button" data-preview-image="' + escapeAttr(imageSrc) + '" data-preview-title="' + escapeAttr(value.title || "バナー") + '"><img src="' + escapeAttr(imageSrc) + '" alt="" /></button></section>'
    : "";
  const templateImageSrc = template?.imageFile ? resolveImageSrc(template.imageFile) : "";
  const templateImageHtml = templateImageSrc
    ? '<section class="outputReviewBlock bannerTemplatePreviewBlock"><header><h3>使用テンプレ画像</h3><span>' + escapeHtml(template.title || "広告テンプレ") + '</span></header><button class="creativePreviewImage" type="button" data-preview-image="' + escapeAttr(templateImageSrc) + '" data-preview-title="' + escapeAttr(template.title || "使用テンプレ画像") + '"><img src="' + escapeAttr(templateImageSrc) + '" alt="" /></button></section>'
    : "";
  return detailSectionsHtml({
    basicRows: [
      ["商品", product?.name || "未選択"],
      ["戦略", strategy?.conceptName || "未選択"],
      ["テンプレ", template?.title || "未選択"],
      ["サイズ", value.imageSize],
      ["制作ステータス", displayValue(value.productionStatus)],
      ["画像生成ステータス", displayValue(value.imageGenerationStatus)],
      ["追加指示", value.additionalInstruction],
      ["修正指示", value.revisionInstruction]
    ],
    extraHtml: assetThumbRowHtml(value),
    outputBlocks: [
      templateImageHtml,
      imageHtml,
      bannerVersionsHtml(value),
      bannerPipelineTimingHtml(value),
      bannerWarningsDetailHtml(value),
      outputReviewBlockHtml("画像テキスト", value.imageText || "未生成", { readable: true }),
      bannerCopyBriefBlockHtml(value.copyBrief || value.promptJson?.copyBrief),
      outputReviewBlockHtml("prompt", value.promptText || JSON.stringify(value.promptJson || {}, null, 2), { tall: true }),
      structuredZonesBlockHtml(value.promptJson),
      bannerLegacyFactCheckDetailHtml(value.factCheck)
    ],
    rawRows: [
      ["ID", value.id],
      ["商品ID", value.productId],
      ["戦略 ID", value.strategyId],
      ["テンプレID", value.templateAdId],
      ["生成画像パス", image],
      ["作成日時", formatDateTime(value.createdAt)],
      ["更新日時", formatDateTime(value.updatedAt)]
    ]
  });
}

function bannerDownloadFileName(value) {
  const safeTitle = String(value?.title || "banner").replace(/[\\/:*?"<>|]+/g, "-").trim() || "banner";
  const source = value?.generatedImagePath || value?.images?.[0] || "";
  const extension = String(source).match(/\.(png|jpe?g|webp)(?:$|[?#])/i)?.[1]?.toLowerCase() || "png";
  return safeTitle + "." + extension.replace("jpeg", "jpg");
}

// 生成画像の全バージョンを新しい順に横並びサムネで表示する(バッチQ)。images[] が空で
// generatedImagePath だけ入っている旧データも、表示時に1件目として扱う互換動作にする。
function bannerVersionsHtml(value) {
  const generatedImagePath = value.generatedImagePath || "";
  const images = Array.isArray(value.images) && value.images.length
    ? value.images
    : (generatedImagePath ? [generatedImagePath] : []);
  if (!images.length) return "";
  const galleryItems = images.map((imagePath) => resolveImageSrc(imagePath));
  const galleryJson = escapeAttr(JSON.stringify(galleryItems));
  const items = images.map((imagePath, index) => {
    const isCurrent = imagePath === generatedImagePath;
    const src = resolveImageSrc(imagePath);
    const titleText = (value.title || "バナー") + " " + (index + 1);
    const badge = isCurrent ? '<span class="versionCurrentBadge">現行版</span>' : "";
    const useButton = isCurrent
      ? ""
      : '<button type="button" class="tableButton actionMini versionUseButton" data-banner-use-version="' + escapeAttr(value.id) + '" data-version-path="' + escapeAttr(imagePath) + '">この版を使う</button>';
    return '<div class="creativeVersionItem' + (isCurrent ? " isCurrent" : "") + '">'
      + '<button type="button" class="creativeVersionThumb" data-preview-image="' + escapeAttr(src) + '" data-preview-title="' + escapeAttr(titleText) + '" data-preview-gallery="' + galleryJson + '" data-preview-index="' + index + '">'
      + '<img src="' + escapeAttr(src) + '" alt="" />' + badge
      + '</button>'
      + useButton
      + '</div>';
  }).join("");
  return '<section class="outputReviewBlock creativeVersionsBlock"><header><h3>生成画像バージョン</h3><span>' + images.length + '件</span></header>'
    + '<div class="creativeVersionsRow">' + items + '</div></section>';
}

async function useBannerImageVersion(bannerId, imagePath) {
  if (!bannerId || !imagePath) return;
  await updateTableRow("banner", bannerId, { generatedImagePath: imagePath });
  bannerComparePreview.delete(bannerId);
}

function adTemplateDetailHtml(value) {
  const kind = value.creativeType || "banner";
  const outputBlocks = [];
  if (kind === "banner") {
    outputBlocks.push(adTemplateEditableBlockHtml(value, "templateTextStoryboard", "テンプレ字コンテ", value.templateTextStoryboard || value.textStoryboard || ""));
    outputBlocks.push(adTemplateEditableBlockHtml(value, "successFactors", "成功要因", value.successFactors || ""));
    if (value.adCopyTemplate) outputBlocks.push(outputReviewBlockHtml("広告文テンプレ", value.adCopyTemplate, { readable: true }));
    outputBlocks.push(structuredZonesBlockHtml(value.templatePromptJson));
    if (value.layoutBlueprint) outputBlocks.push(outputReviewBlockHtml("レイアウト設計図", JSON.stringify(value.layoutBlueprint, null, 2), { readable: true }));
    if (value.copyBlueprint) outputBlocks.push(outputReviewBlockHtml("コピー設計図", JSON.stringify(value.copyBlueprint, null, 2), { readable: true }));
  }
  if (kind === "adcopy") {
    outputBlocks.push(outputReviewBlockHtml("原文", value.sourceText || "未登録", { tall: true, readable: true }));
    outputBlocks.push(outputReviewBlockHtml("広告文テンプレ(変数化後)", value.adCopyTemplate || "未生成", { tall: true, readable: true }));
  }
  if (kind === "movie") {
    outputBlocks.push(outputReviewBlockHtml("台本", value.scriptText || "未登録", { tall: true, readable: true }));
    outputBlocks.push(outputReviewBlockHtml("テンプレ字コンテ", value.templateTextStoryboard || "未生成", { tall: true, readable: true }));
  }
  if (kind === "article") {
    outputBlocks.push(outputReviewBlockHtml("記事LP原文", value.sourceText || "未登録", { tall: true, readable: true }));
    outputBlocks.push(outputReviewBlockHtml("テンプレ本文(変数化後)", value.articleTemplateText || "未生成", { tall: true, readable: true }));
  }
  return detailSectionsHtml({
    basicRows: [
      ["タイトル", value.title],
      ["種別", displayValue(kind)],
      ["テンプレ化状態", displayValue(value.templateStatus)],
      ["解析状態", templateProcessingLabel(value.templateProcessingStatus)],
      ...(value.templateAnalysisError ? [["解析エラー", value.templateAnalysisError]] : []),
      ["生成利用可", value.templateReadiness?.readyForGeneration ? "利用可" : "要確認"],
      ...(kind === "banner" ? [] : [["成功要因", value.successFactors]])
    ],
    extraHtml: kind === "banner" && value.templateReadiness
      ? outputReviewBlockHtml("テンプレ準備状況", JSON.stringify(value.templateReadiness, null, 2), { readable: true })
      : "",
    outputBlocks,
    rawRows: [
      ["ID", value.id],
      ["作成日時", formatDateTime(value.createdAt)],
      ["更新日時", formatDateTime(value.updatedAt)]
    ]
  });
}

function adTemplateEditableBlockHtml(value, field, title, text) {
  return '<section class="outputReviewBlock adTemplateEditableBlock">'
    + '<header><h3>' + escapeHtml(title) + '</h3><button type="button" class="tableButton" data-save-ad-template-field="' + escapeAttr(field) + '" data-template-id="' + escapeAttr(value.id) + '">保存</button></header>'
    + '<textarea class="detailEditableTextarea" data-ad-template-field="' + escapeAttr(field) + '" placeholder="テンプレ化後に編集できます">' + escapeHtml(text) + '</textarea></section>';
}

function bindAdTemplateDetailEditors(body) {
  for (const button of body.querySelectorAll("[data-save-ad-template-field]")) {
    button.addEventListener("click", async () => {
      const field = button.dataset.saveAdTemplateField;
      const textarea = button.closest(".adTemplateEditableBlock")?.querySelector("[data-ad-template-field]");
      if (!field || !textarea) return;
      button.disabled = true;
      try {
        await updateTableRow("adTemplate", button.dataset.templateId, { [field]: textarea.value });
        showToast("success", field === "successFactors" ? "成功要因を保存しました。" : "テンプレ字コンテを保存しました。");
      } finally {
        button.disabled = false;
      }
    });
  }
}

function outputSummaryHtml(items) {
  return '<div class="outputSummary">' + items.map(([label, value]) => '<div><span>' + escapeHtml(label) + '</span><b>' + escapeHtml(value) + '</b></div>').join("") + '</div>';
}

function bannerGenerationAuditHtml(value) {
  const entries = [
    ["BannerGenerationContract", value.bannerGenerationContract],
    ["当たる理由の仮説", value.creativeHypothesis],
    ["カテゴリ距離", value.categoryRelation],
    ["追加指示ポリシー", value.instructionPolicy],
    ["主メッセージ設計", value.messagePlan || value.copyBrief?.messagePlan],
    ["初見伝達審査", value.communicationReview || value.copyQualityReview?.communicationReview],
    ["テンプレート適合判定", value.templateFitDecision || value.copyBrief?.templateFitDecision],
    ["コピー品質審査", value.copyQualityReview],
    ["固定コピー文字数審査", value.copyLengthReview],
    ["独自性審査", value.originalityReview],
    ["WHO-WHAT整合", value.strategyCheck],
    ["配色決定", value.colorDecision],
    ["コピー完全性", value.copyIntegrityCheck],
    ["コピー審査履歴", value.copyReviewHistory?.length ? value.copyReviewHistory : null],
    ["追加指示で上書きしたルール", value.overriddenRules?.length ? value.overriddenRules : null]
  ].filter(([, item]) => item).map(([label, item]) => `${label}:\n${JSON.stringify(item, null, 2)}`);
  return entries.length ? outputReviewBlockHtml("バナー生成監査", entries.join("\n\n"), { readable: true }) : "";
}

function bannerCommunicationReviewHtml(value) {
  const messagePlan = value?.messagePlan || value?.copyBrief?.messagePlan || null;
  const review = value?.communicationReview || value?.copyQualityReview?.communicationReview || null;
  const templateFit = value?.templateFitDecision || value?.copyBrief?.templateFitDecision || null;
  if (!messagePlan && !review && !templateFit) return "";
  const risks = Array.isArray(review?.misreadingRisks) ? review.misreadingRisks : [];
  const body = [
    messagePlan?.oneMessage ? "設計した主メッセージ: " + messagePlan.oneMessage : "",
    messagePlan?.productOrTaskAnchor ? "商品・対象業務: " + messagePlan.productOrTaskAnchor : "",
    review?.perceivedMessage ? "初見で受け取られた意味: " + review.perceivedMessage : "",
    templateFit?.status ? "テンプレート適合: " + templateFit.status + (templateFit.reason ? "（" + templateFit.reason + "）" : "") : "",
    risks.length ? "誤読リスク:\n" + risks.map((risk) => `- ${risk.message || risk.code || "要確認"}${risk.rewriteInstruction ? `\n  修正: ${risk.rewriteInstruction}` : ""}`).join("\n") : ""
  ].filter(Boolean).join("\n");
  return outputReviewBlockHtml("初見ユーザーへの伝わり方", body, { readable: true });
}

function bannerLegacyFactCheckDetailHtml(factCheck) {
  if (!factCheck) return "";
  const warnings = Array.isArray(factCheck.warnings) ? factCheck.warnings : [];
  const heading = warnings.length ? "要確認" : "問題なし";
  const body = [heading, ...warnings, factCheck.note || "", factCheck.checkedAt ? "確認日時: " + formatDateTime(factCheck.checkedAt) : ""].filter(Boolean).join("\n");
  return outputReviewBlockHtml("旧データのファクトチェック（新規生成では未使用）", body, { readable: true });
}

function bannerCopyBriefBlockHtml(copyBrief) {
  if (!copyBrief || typeof copyBrief !== "object") return "";
  const rejected = Array.isArray(copyBrief.rejectedAlternatives) ? copyBrief.rejectedAlternatives : [];
  const slotTexts = Array.isArray(copyBrief.slotTexts) ? copyBrief.slotTexts : [];
  const slotLines = slotTexts.map((slot, index) => {
    const text = String(slot?.text || "").trim();
    const charCount = copyTextCharCount(text);
    const budget = Number(slot?.charBudget) || 0;
    const maxChars = Number(slot?.maxChars) || copySlotMaxChars(budget);
    const warning = copySlotLengthWarning(charCount, budget, maxChars);
    return [
      `${index + 1}. ${slot?.zoneName || slot?.role || slot?.slotId || "slot"}${slot?.canonicalField ? ` (${slot.canonicalField})` : ""}`,
      `   ${text || "(空)"}`,
      budget ? `   文字数: ${charCount} / 基準${budget} / 上限${maxChars}${warning ? "  要確認: " + warning : ""}` : `   文字数: ${charCount}`
    ].join("\n");
  });
  const body = [
    copyBrief.appealAxis ? "訴求軸: " + copyBrief.appealAxis : "",
    copyBrief.targetMoment ? "反応瞬間: " + copyBrief.targetMoment : "",
    copyBrief.messagePlan?.oneMessage ? "主メッセージ: " + copyBrief.messagePlan.oneMessage : "",
    copyBrief.messagePlan?.productOrTaskAnchor ? "商品・対象業務: " + copyBrief.messagePlan.productOrTaskAnchor : "",
    copyBrief.readoutText ? "視線順の読み上げ: " + copyBrief.readoutText : "",
    copyBrief.templateFitDecision?.status ? "テンプレ適合: " + copyBrief.templateFitDecision.status + (copyBrief.templateFitDecision.reason ? "（" + copyBrief.templateFitDecision.reason + "）" : "") : "",
    copyBrief.templateUseNote ? "テンプレ活用メモ: " + copyBrief.templateUseNote : "",
    "",
    "採用コピー:",
    copyBrief.mainHook ? "メイン: " + copyBrief.mainHook : "",
    copyBrief.subHook ? "サブ: " + copyBrief.subHook : "",
    copyBrief.proof ? "根拠: " + copyBrief.proof : "",
    copyBrief.offerBadge ? "オファー: " + copyBrief.offerBadge : "",
    copyBrief.cta ? "CTA: " + copyBrief.cta : "",
    copyBrief.disclaimer ? "注釈: " + copyBrief.disclaimer : "",
    "",
    copyBrief.whyItStops ? "3秒テスト通過理由: " + copyBrief.whyItStops : "",
    slotLines.length ? "\nスロット別コピー:\n" + slotLines.join("\n") : "",
    "",
    rejected.length ? "不採用案:\n" + rejected.map((item, index) => `${index + 1}. ${item.text || ""}${item.reason ? `\n   理由: ${item.reason}` : ""}`).join("\n") : ""
  ].filter((line) => line !== "").join("\n");
  return outputReviewBlockHtml("コピー設計", body || JSON.stringify(copyBrief, null, 2), { readable: true });
}

function copyTextCharCount(value) {
  return String(value || "").replace(/[\s\u3000]/g, "").length;
}

function copySlotLengthWarning(charCount, budget, storedMaxChars = 0) {
  if (!budget || !charCount) return "";
  const max = Number(storedMaxChars) || copySlotMaxChars(budget);
  if (charCount > max) return `${charCount - max}字超過`;
  return "";
}

function copySlotMaxChars(budget) {
  const normalized = Math.max(0, Math.round(Number(budget) || 0));
  if (!normalized) return 0;
  return normalized <= 10 ? 13 : Math.max(1, Math.floor(normalized * 1.2));
}

// options.readable: use a normal (non-monospace) font at 13px/1.7 line-height
// for prose content (ad copy, full scripts, descriptions). JSON/YAML/process
// logs keep the default monospace pre styling.
function outputReviewBlockHtml(title, text, options = {}) {
  const classes = ["outputReviewBlock"];
  if (options.tall) classes.push("tall");
  if (options.readable) classes.push("readable");
  return '<section class="' + classes.join(" ") + '"><header><h3>' + escapeHtml(title) + '</h3><div class="outputBlockActions"><button type="button" data-expand-output>\u62e1\u5927</button><button type="button" data-copy-output>\u30b3\u30d4\u30fc</button></div></header><pre>' + escapeHtml(text || "") + '</pre></section>';
}

// Builds the 3-section detail pane body used across all row types (item A-3):
// \u57fa\u672c\u60c5\u5831(\u540d\u524d\u30fb\u95a2\u4fc2\u5148\u30fb\u72b6\u614b) -> \u751f\u6210\u7269(outputReviewGrid) -> \u8a73\u7d30\u60c5\u5831(\u6298\u308a\u305f\u305f\u307f\u3001\u751f\u306eID/\u65e5\u6642/path\u7cfb)\u3002
// Empty basic/raw rows are dropped by detailSection(); empty output sections are skipped entirely.
function detailSectionsHtml({ basicRows = [], extraHtml = "", outputBlocks = [], rawRows = [] } = {}) {
  const basicHtml = detailSection(basicRows);
  const blocks = outputBlocks.filter(Boolean);
  const outputHtml = blocks.length ? '<div class="outputReviewGrid">' + blocks.join("") + '</div>' : "";
  const hasRaw = rawRows.some(([, value]) => value !== undefined && value !== null && String(value) !== "");
  const rawHtml = hasRaw ? '<details class="detailRawInfo"><summary>\u8a73\u7d30\u60c5\u5831</summary>' + detailSection(rawRows) + '</details>' : "";
  return basicHtml + extraHtml + outputHtml + rawHtml;
}

function structuredZonesBlockHtml(promptJson) {
  const zones = Array.isArray(promptJson?.zones) ? promptJson.zones : [];
  const rawText = JSON.stringify(promptJson || {}, null, 2);
  const body = zones.length ? zones.map(zoneCardHtml).join("") : '<p class="mutedCell">\u69cb\u9020\u60c5\u5831\u306f\u307e\u3060\u3042\u308a\u307e\u305b\u3093\u3002</p>';
  return '<section class="outputReviewBlock tall"><header><h3>\u69cb\u9020(\u30be\u30fc\u30f3)</h3><button type="button" data-copy-output>\u30b3\u30d4\u30fc</button></header>'
    + '<div class="zonesPreview">' + body + '</div>'
    + '<pre hidden>' + escapeHtml(rawText) + '</pre></section>';
}

function zoneCardHtml(zone) {
  const elements = Array.isArray(zone?.elements) ? zone.elements : [];
  const elementRows = elements.map((element) => (
    '<li><span class="zoneElementType">' + escapeHtml(element.type || "text") + '</span>'
    + '<span class="zoneElementRole">' + escapeHtml(element.role || "") + '</span>'
    + '<span class="zoneElementContent">' + escapeHtml(element.content || element.description || "") + '</span></li>'
  )).join("");
  return '<div class="zoneCard">'
    + '<div class="zoneCardHeader"><b>' + escapeHtml(zone?.name || "\u30be\u30fc\u30f3") + '</b><span>' + escapeHtml(zone?.position || "") + '</span></div>'
    + (zone?.purpose ? '<p class="zoneCardPurpose">' + escapeHtml(zone.purpose) + '</p>' : '')
    + (elementRows ? '<ul class="zoneElementList">' + elementRows + '</ul>' : '')
    + '</div>';
}

function detailSection(rows) {
  return `<div class="detailModalGrid">${rows.filter(([, value]) => value !== undefined && value !== null && String(value) !== "").map(([label, value]) => {
    const text = String(value);
    const wide = text.length > 36 || text.includes("\n");
    return `<div class="detailModalRow${wide ? " wide" : ""}"><span>${escapeHtml(label)}</span><b>${escapeHtml(text)}</b></div>`;
  }).join("") || `<div class="emptyDetail">\u9805\u76ee\u304c\u3042\u308a\u307e\u305b\u3093</div>`}</div>`;
}

function statusMeta(value) {
  const map = {
    template_ready: ["テンプレ済み", "広告テンプレとして利用できます。"],
    sub_item_created: ["サブアイテム生成", "5案拡散で派生案が作成されています。"],
    proposed: ["\u63d0\u6848", "AI\u304c\u4f5c\u6210\u3057\u305f戦略\u6848\u3067\u3059\u3002"],
    used_in_creative: ["採用済み", "バナー制作に使う戦略として採用されています。"],
    approved: ["\u627f\u8a8d", "\u5236\u4f5c\u306b\u5229\u7528\u3067\u304d\u308b戦略\u3067\u3059\u3002"],
    draft: ["\u4e0b\u66f8\u304d", "\u4f5c\u6210\u9014\u4e2d\u306e\u30ec\u30b3\u30fc\u30c9\u3067\u3059\u3002"],
    archived: ["\u30a2\u30fc\u30ab\u30a4\u30d6", "\u975e\u8868\u793a\u306b\u3057\u305f戦略\u6848\u3067\u3059\u3002\u300c\u623b\u3059\u300d\u3067\u63d0\u6848\u4e2d\u306b\u623b\u305b\u307e\u3059\u3002"],
    not_started: ["\u672a\u7740\u624b", "\u307e\u3060\u751f\u6210\u51e6\u7406\u306f\u5b9f\u884c\u3055\u308c\u3066\u3044\u307e\u305b\u3093\u3002"],
    prompt_queued: ["生成中", "コピー設計を順番に実行しています。"],
    prompt_ready: ["画像生成可能", "画像を生成できます。"],
    prompt_generating: ["生成中", "バナー生成の準備を進めています。"],
    needs_revision: ["再生成が必要", "内容を調整して再生成してください。"],
    hypothesis_contract_failed: ["再生成が必要", "勝ち筋設計を作り直して再生成してください。"],
    copy_review_failed: ["再生成が必要", "内容を調整して再生成してください。"],
    copy_communication_failed: ["再生成が必要", "内容を調整して再生成してください。"],
    template_message_fit_failed: ["再生成が必要", "内容を調整して再生成してください。"],
    originality_review_failed: ["再生成が必要", "内容を調整して再生成してください。"],
    copy_review_error: ["再生成が必要", "もう一度生成してください。"],
    strategy_input_insufficient: ["再生成が必要", "内容を調整して再生成してください。"],
    template_not_ready: ["再生成が必要", "テンプレートを選び直して再生成してください。"],
    needs_copy_visual_review: ["確認が必要", "画像内コピーを確認してください。"],
    revising: ["\u4fee\u6b63\u4e2d", "\u4fee\u6b63\u6307\u793a\u3092\u53cd\u6620\u3057\u305f\u30d7\u30ed\u30f3\u30d7\u30c8\u3092\u518d\u751f\u6210\u3057\u3066\u3044\u307e\u3059\u3002"],
    generating: ["\u751f\u6210\u4e2d", "AI\u751f\u6210\u3092\u5b9f\u884c\u3057\u3066\u3044\u307e\u3059\u3002"],
    completed: ["\u5b8c\u4e86", "\u751f\u6210\u307e\u305f\u306f\u51e6\u7406\u304c\u5b8c\u4e86\u3057\u3066\u3044\u307e\u3059\u3002"],
    completed_with_warnings: ["\u5b8c\u4e86(\u8b66\u544a\u3042\u308a)", "\u751f\u6210\u306f\u5b8c\u4e86\u3057\u307e\u3057\u305f\u304c\u8b66\u544a\u304c\u3042\u308a\u307e\u3059\u3002\u8a73\u7d30\u3092\u78ba\u8a8d\u3057\u3066\u304f\u3060\u3055\u3044\u3002"],
    captured: ["\u30b9\u30af\u30b7\u30e7\u53d6\u5f97\u6e08\u307f", "\u753b\u50cfLP\u78ba\u8a8d\u7528\u306e\u30b9\u30af\u30ea\u30fc\u30f3\u30b7\u30e7\u30c3\u30c8\u3092\u4fdd\u5b58\u3057\u307e\u3057\u305f\u3002"],
    skipped_missing_dependency: ["\u30b9\u30af\u30b7\u30e7\u672a\u53d6\u5f97", "Chrome\u307e\u305f\u306fpuppeteer-core\u304c\u672a\u8a2d\u5b9a\u306e\u305f\u3081\u30b9\u30af\u30b7\u30e7\u53d6\u5f97\u3092\u30b9\u30ad\u30c3\u30d7\u3057\u307e\u3057\u305f\u3002"],
    skipped_html_available: ["HTML\u672c\u6587\u4fdd\u5b58", "\u904e\u53bb\u306e\u5b9f\u884c\u3067HTML\u672c\u6587\u304c\u4fdd\u5b58\u3055\u308c\u3066\u3044\u307e\u3059\u3002\u518d\u66f8\u304d\u51fa\u3057\u3067AI\u6587\u5b57\u8d77\u3053\u3057\u3082\u5b9f\u884c\u3057\u307e\u3059\u3002"],
    pending: ["\u672a\u7740\u624b", "URL\u306f\u767b\u9332\u6e08\u307f\u3067\u3059\u3002LP\u66f8\u304d\u51fa\u3057\u306f\u307e\u3060\u5b9f\u884c\u3055\u308c\u3066\u3044\u307e\u305b\u3093\u3002"],
    extracting: ["\u66f8\u304d\u51fa\u3057\u4e2d", "\u30ed\u30fc\u30ab\u30eb\u3067URL\u53d6\u5f97\u3068\u30b9\u30af\u30ea\u30fc\u30f3\u30b7\u30e7\u30c3\u30c8\u53d6\u5f97\u3092\u884c\u3044\u3001AI\u6587\u5b57\u8d77\u3053\u3057\u3092\u5b9f\u884c\u3057\u3066\u3044\u307e\u3059\u3002"],
    extracted: ["\u672c\u6587\u62bd\u51fa\u6e08\u307f", "\u30a2\u30a6\u30c8\u30d7\u30c3\u30c8\u5217\u306b\u62bd\u51fa\u672c\u6587\u304c\u4fdd\u5b58\u3055\u308c\u3066\u3044\u307e\u3059\u3002"],
    partial_text: ["\u672c\u6587\u306e\u307f\u62bd\u51fa", "\u672c\u6587\u306f\u53d6\u5f97\u3067\u304d\u307e\u3057\u305f\u304c\u3001\u30b9\u30af\u30ea\u30fc\u30f3\u30b7\u30e7\u30c3\u30c8\u306e\u6587\u5b57\u8d77\u3053\u3057\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002"],
    partial_visual: ["\u30b9\u30af\u30b7\u30e7\u306e\u307f\u62bd\u51fa", "\u30b9\u30af\u30ea\u30fc\u30f3\u30b7\u30e7\u30c3\u30c8\u306e\u6587\u5b57\u8d77\u3053\u3057\u306f\u3067\u304d\u307e\u3057\u305f\u304c\u3001\u672c\u6587\u53d6\u5f97\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002"],
    failed: ["\u5931\u6557", "\u51e6\u7406\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002\u5931\u6557\u7406\u7531\u306e\u30e1\u30c3\u30bb\u30fc\u30b8\u3092\u78ba\u8a8d\u3057\u3066\u518d\u5b9f\u884c\u3057\u3066\u304f\u3060\u3055\u3044\u3002"],
    manual_text: ["\u624b\u52d5\u672c\u6587", "URL\u3067\u306f\u306a\u304f\u3001\u624b\u5165\u529b\u3055\u308c\u305f\u672c\u6587\u3092\u8cc7\u6599\u3068\u3057\u3066\u4fdd\u5b58\u3057\u3066\u3044\u307e\u3059\u3002"],
    unknown: ["\u4e0d\u660e", "\u72b6\u614b\u3092\u5224\u5b9a\u3067\u304d\u307e\u305b\u3093\u3002"]
  };
  const item = map[value] || map.unknown;
  return { label: item[0], detail: item[1] };
}

function displayValue(value) {
  const map = {
    HP: "\u516c\u5f0fHP", LP: "LP", Interview: "\u9867\u5ba2\u306e\u58f0", Article: "\u8a18\u4e8b", Review: "\u53e3\u30b3\u30df", Competitor: "\u7af6\u5408", "Meeting Note": "\u8b70\u4e8b\u9332\u30fb\u30e1\u30e2",
    "Product Feature": "\u5546\u54c1\u7279\u5fb4", Benefit: "\u30d9\u30cd\u30d5\u30a3\u30c3\u30c8", Proof: "\u5b9f\u7e3e\u30fb\u8a3c\u62e0", Authority: "\u6a29\u5a01\u6027", Offer: "\u30aa\u30d5\u30a1\u30fc", Risk: "\u30ea\u30b9\u30af", Company: "\u4f1a\u793e\u60c5\u5831", Market: "\u5e02\u5834",
    ng_expression: "NG\u8868\u73fe", ng_word: "NG\u30ef\u30fc\u30c9", preferred_expression: "\u63a8\u5968\u8868\u73fe", legal_disclaimer: "\u6ce8\u8a18", tone_rule: "\u30c8\u30f3\u30de\u30ca", image_rule: "\u753b\u50cf\u30eb\u30fc\u30eb",
    low: "\u4f4e", medium: "\u4e2d", high: "\u9ad8",
    pending: "\u672a\u7740\u624b", extracting: "\u66f8\u304d\u51fa\u3057\u4e2d", extracted: "\u66f8\u304d\u51fa\u3057\u6e08\u307f", partial_text: "\u672c\u6587\u306e\u307f\u62bd\u51fa", partial_visual: "\u30b9\u30af\u30b7\u30e7\u306e\u307f\u62bd\u51fa", manual_text: "\u624b\u52d5\u5165\u529b", failed: "\u5931\u6557",
    draft: "\u4e0b\u66f8\u304d", proposed: "\u63d0\u6848\u4e2d", approved: "\u627f\u8a8d\u6e08\u307f", used_in_creative: "\u63a1\u7528\u6e08\u307f", archived: "\u30a2\u30fc\u30ab\u30a4\u30d6",
    not_started: "\u672a\u7740\u624b", queued: "画像生成待ち", generating: "\u751f\u6210\u4e2d", prompt_queued: "コピー・プロンプト作成中", prompt_generating: "コピー・プロンプト作成中", prompt_ready: "画像生成可能", sub_item_created: "\u6d3e\u751f\u6848\u3042\u308a", needs_revision: "再生成が必要", revising: "\u4fee\u6b63\u4e2d", completed: "\u5b8c\u4e86", completed_with_warnings: "\u5b8c\u4e86(\u8b66\u544a\u3042\u308a)", failed: "\u5931\u6557",
    hypothesis_contract_failed: "再生成が必要", copy_review_failed: "再生成が必要", copy_communication_failed: "再生成が必要", template_message_fit_failed: "再生成が必要", originality_review_failed: "再生成が必要", copy_review_error: "再生成が必要", strategy_input_insufficient: "再生成が必要", template_not_ready: "再生成が必要", needs_copy_visual_review: "確認が必要",
    skipped_html_available: "HTML\u672c\u6587\u4fdd\u5b58",
    template_generating: "\u30c6\u30f3\u30d7\u30ec\u4f5c\u6210\u4e2d", template_ready: "\u30c6\u30f3\u30d7\u30ec\u6e08\u307f",
    banner: "\u30d0\u30ca\u30fc", adcopy: "\u5e83\u544a\u6587", movie: "\u30b7\u30e7\u30fc\u30c8\u52d5\u753b",
    generic: "\u6c4e\u7528", google_rsa: "Google RSA", meta: "Meta", yda: "YDA", line: "LINE", pangle: "Pangle",
    own: "\u81ea\u793e", other: "\u4ed6\u793e",
    product: "\u5546\u54c1\u5199\u771f", logo: "\u30ed\u30b4",
    captured: "\u64ae\u5f71\u6e08\u307f", skipped_missing_dependency: "\u30b9\u30ad\u30c3\u30d7(Chrome\u672a\u691c\u51fa)", not_needed: "\u4e0d\u8981",
    running: "\u5b9f\u884c\u4e2d"
  };
  return map[value] || value || "-";
}

function imageCellHtml(value) {
  const src = resolveImageSrc(value);
  const title = String(value || "\u753b\u50cf");
  return '<button class="imageCellButton" type="button" aria-label="\u753b\u50cf\u3092\u62e1\u5927: ' + escapeAttr(title) + '" data-preview-image="' + escapeAttr(src) + '" data-preview-title="' + escapeAttr(title) + '"><img src="' + escapeAttr(src) + '" alt="" /></button>';
}

function productImageLabel(product, imagePath) {
  if (!imagePath) return "";
  const image = (product?.images || []).find((item) => item.path === imagePath);
  return image?.label || image?.path?.split("/").pop() || "";
}

function productImageOptionsHtml(productId, role, selectedPath = "") {
  const product = research.products.find((item) => item.id === productId);
  const images = (product?.images || []).filter((item) => item.role === role);
  const options = images.map((image) => '<option value="' + escapeAttr(image.path) + '" ' + (image.path === selectedPath ? "selected" : "") + '>' + escapeHtml(image.label || image.path.split("/").pop()) + '</option>').join("");
  return '<option value="">使わない</option>' + options;
}

function bannerImageMultiSelectHtml(productId, role, label, name) {
  const product = research.products.find((item) => item.id === productId);
  const images = (product?.images || []).filter((item) => item.role === role);
  const items = images.length ? images.map((image) => {
    const title = image.label || image.path.split("/").pop();
    return '<label class="bannerAssetChoice"><input type="checkbox" name="' + escapeAttr(name) + '" value="' + escapeAttr(image.path) + '" />'
      + '<img src="' + escapeAttr(resolveImageSrc(image.path)) + '" alt="" /><span>' + escapeHtml(title) + '</span></label>';
  }).join("") : '<span class="bannerAssetEmpty">ここで画像を追加できます</span>';
  const inputId = `bannerAssetUpload-${role}`;
  return '<fieldset class="formField bannerAssetField" data-asset-name="' + escapeAttr(name) + '"><legend><span>' + escapeHtml(label) + '<small>複数選択可</small></span><label class="bannerAssetUploadButton" for="' + escapeAttr(inputId) + '">＋ 追加</label><input id="' + escapeAttr(inputId) + '" class="bannerAssetUploadInput" type="file" accept="image/*" data-product-id="' + escapeAttr(productId) + '" data-role="' + escapeAttr(role) + '" data-name="' + escapeAttr(name) + '" /></legend><div class="bannerAssetChoices">' + items + '</div></fieldset>';
}

function selectedBannerImagePaths(name) {
  return $$('input[name="' + name + '"]:checked').map((input) => input.value).filter(Boolean);
}

// Item C: the "画像" cell in the product table always exposes a way to reach
// the upload UI (productImagesBlockHtml in the detail drawer) instead of being
// a dead-end thumbnail. Both the "未登録" label and the "+ 追加" button open
// the row's detail pane and scroll straight to the image block.
function productImagesCellHtml(product) {
  const images = Array.isArray(product.images) ? product.images : [];
  if (!images.length) {
    return '<button type="button" class="productImagesCellLink mutedCell" data-open-product-images="' + escapeAttr(product.id) + '">未登録</button>';
  }
  return '<div class="productImagesCell">' + imageCellHtml(images[0].path) + '<span class="imageCellCount">' + images.length + '枚</span>'
    + '<button type="button" class="productImagesCellAdd" data-open-product-images="' + escapeAttr(product.id) + '">+ 追加</button></div>';
}

function openProductImagesDetail(productId) {
  const product = research.products.find((item) => item.id === productId);
  if (!product) return;
  selectItem("product", product);
  requestAnimationFrame(() => {
    $("#detailPaneBody .productImagesBlock")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function adTemplateImageCellHtml(template) {
  const preview = template.imageFile ? imageCellHtml(template.imageFile) : '<span class="mutedCell">\u306a\u3057</span>';
  return '<div class="imageUploadField compact">' + preview
    + '<label class="tableButton imageUploadButton">' + (template.imageFile ? "\u5909\u66f4" : "\u30a2\u30c3\u30d7\u30ed\u30fc\u30c9")
    + '<input type="file" accept="image/*" class="adTemplateImageFile" data-template-id="' + escapeAttr(template.id) + '" hidden /></label></div>';
}

function resolveImageSrc(value) {
  const text = String(value || "");
  if (!text) return "";
  if (/^https?:\/\//i.test(text) || text.startsWith("/")) return text;
  return "/project-file?project=" + encodeURIComponent((selectedProject()?.path || "").split("/").pop()) + "&path=" + encodeURIComponent(text);
}

function fieldLabel(key) {
  const map = { id: "ID", productId: "商品ID", strategyId: "戦略 ID", templateAdId: "テンプレID", title: "タイトル", name: "名前", sourceUrl: "URL", manualText: "手動本文", extractedText: "アウトプット", visualAnalysis: "画像LP分析", extractionStatus: "状態", textStoryboard: "字コンテ", templateTextStoryboard: "テンプレ字コンテ", templatePromptJson: "画像生成プロンプトJSON", successFactors: "成功要因", imageText: "画像テキスト", promptJson: "プロンプトJSON", promptText: "プロンプト", reviewNotes: "レビュー結果", productionStatus: "制作ステータス", imageGenerationStatus: "画像生成ステータス", generatedImagePath: "生成画像", images: "商品画像", role: "役割", brandColor: "ブランドカラー", brandTone: "トンマナ", creativeType: "種別", ownership: "自社/他社", templateStatus: "テンプレ化ステータス", imageFile: "画像", createdAt: "作成日時", updatedAt: "更新日時" };
  return map[key] || key;
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("ja-JP");
}
function productIdForAiAction() {
  if (selected?.type === "product") return selected.payload.id || "";
  if (["material", "fact", "rule", "strategy", "banner"].includes(selected?.type)) return selected.payload.productId || "";
  const productIds = new Set();
  for (const row of [research.materials, research.facts, research.expressionRules, research.strategies, research.banners].flat()) {
    if (row?.productId) productIds.add(row.productId);
  }
  if (productIds.size === 1) return [...productIds][0];
  return research.products.length === 1 ? (research.products[0]?.id || "") : "";
}

function selectedProject() {
  return projects.find((project) => project.path === projectSelect.value && !project.isTemplate && project.status !== "archived") || null;
}

function projectLabel(project) {
  if (!project) return "";
  if (project.isTemplate) return "_template";
  return `${project.name || "案件"}${project.productName ? ` / ${project.productName}` : ""}`;
}

function hostname(url) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } }
function on(selector, event, handler) { const element = $(selector); if (element) element.addEventListener(event, handler); }
async function get(url) { const res = await fetch(url); return res.json(); }
async function post(url, body) { return requestJson(url, { method: "POST", body }); }
async function requestJson(url, { method = "GET", body } = {}) { const options = { method, headers: { "content-type": "application/json" } }; if (body !== undefined) options.body = JSON.stringify(body); const res = await fetch(url, options); return res.json(); }
function clearInputs(selectors) { for (const selector of selectors) { const element = $(selector); if (element) element.value = ""; } }
function clip(value, length = 90) { const text = String(value || ""); return text.length > length ? `${text.slice(0, length)}...` : text; }
function pill(value) {
  return `<span class="pill">${escapeHtml(displayValue(value))}</span>`;
}
function statusPill(value) {
  const meta = statusMeta(value);
  return `<span class="pill status ${escapeAttr(value || "unknown")}" title="${escapeAttr(meta.detail)}">${escapeHtml(meta.label)}</span>`;
}
function labeledStatusPill(label, value) {
  const meta = statusMeta(value);
  return `<span class="pill status ${escapeAttr(value || "unknown")}" title="${escapeAttr(meta.detail)}"><small>${escapeHtml(label)}</small>${escapeHtml(meta.label)}</span>`;
}
function isTemplateAnalysisActive(template) {
  return ["queued", "running"].includes(template?.templateProcessingStatus);
}
function isBannerTemplateReady(template) {
  return template?.templateProcessingStatus === "completed"
    && template?.templateReadiness?.schemaVersion === 2
    && template?.templateReadiness?.readyForGeneration === true
    && Boolean(template?.templateReadiness?.validationHash);
}
function templateProcessingLabel(value) {
  const labels = { queued: "解析待ち", running: "解析中", completed: "解析完了", failed: "解析失敗", not_started: "未着手" };
  return labels[value] || displayValue(value);
}
function templateProcessingPill(value) {
  if (!value || value === "not_started") return "";
  const details = {
    queued: "先に受け付けた解析の実行状況に応じて自動的に開始します。",
    running: "AIが参考バナーの構造とコピー枠を解析しています。",
    completed: "テンプレート解析が完了しています。",
    failed: "テンプレート解析に失敗しました。一覧から再実行できます。"
  };
  return `<span class="pill status ${escapeAttr(value)}" title="${escapeAttr(details[value] || "")}">${escapeHtml(templateProcessingLabel(value))}</span>`;
}
function escapeHtml(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }
function escapeAttr(value) { return escapeHtml(value).replaceAll("`", "&#096;"); }
