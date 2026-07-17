import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathExists, readJson, withFileLock, writeJson } from "./project-store.js";
import { normalizeTemplateReadinessState } from "./template-readiness.js";

const AD_TEMPLATES_PATH = "data/ad-templates.json";

function sharedTemplatesPath() {
  return path.resolve(process.cwd(), AD_TEMPLATES_PATH);
}

export async function ensureAdTemplateData() {
  const target = sharedTemplatesPath();
  if (await pathExists(target)) return;
  await fs.mkdir(path.dirname(target), { recursive: true });
  return withFileLock(target, async () => {
    if (!(await pathExists(target))) await writeJson(path.dirname(target), path.basename(target), []);
  });
}

export async function listAdTemplates() {
  await ensureAdTemplateData();
  const target = sharedTemplatesPath();
  const templates = await readJson(path.dirname(target), path.basename(target));
  return (Array.isArray(templates) ? templates : []).map((item) => normalizeTemplate(item));
}

export async function addAdTemplate(projectRoot, input) {
  if (input.creativeType && input.creativeType !== "banner") {
    const error = new Error("広告テンプレはバナー画像のみ登録できます。");
    error.code = "UNSUPPORTED_TEMPLATE_TYPE";
    throw error;
  }
  await ensureAdTemplateData();
  return withFileLock(sharedTemplatesPath(), async () => {
    const templates = await listAdTemplates();
    const now = new Date().toISOString();
    const template = normalizeTemplate({ ...input, id: createId("tpl"), createdAt: now, updatedAt: now });
    if (!template.title) throw new Error("広告テンプレ名が必要です。");
    templates.unshift(template);
    await writeSharedTemplates(templates);
    return template;
  });
}

export async function updateAdTemplate(projectRoot, templateId, patch) {
  await ensureAdTemplateData();
  return withFileLock(sharedTemplatesPath(), async () => {
    const templates = await listAdTemplates();
    const index = templates.findIndex((item) => item.id === templateId);
    if (index < 0) throw new Error("広告テンプレが見つかりません: " + templateId);
    templates[index] = normalizeTemplate({ ...templates[index], ...patch, updatedAt: new Date().toISOString() });
    await writeSharedTemplates(templates);
    return templates[index];
  });
}

export async function claimTemplateAnalysis(projectRoot, templateId, {
  ownerId = "",
  attemptId = crypto.randomUUID(),
  leaseMs = 10 * 60 * 1000
} = {}) {
  await ensureAdTemplateData();
  return withFileLock(sharedTemplatesPath(), async () => {
    const templates = await listAdTemplates();
    const index = templates.findIndex((item) => item.id === templateId);
    if (index < 0) throw templateNotFoundError(templateId);
    const current = templates[index];
    if (["queued", "running"].includes(current.templateProcessingStatus)) {
      return { claimed: false, reason: "active", template: current };
    }
    const now = new Date().toISOString();
    templates[index] = normalizeTemplate({
      ...current,
      templateStatus: "template_generating",
      templateProcessingStatus: "queued",
      templateAnalysisAttemptId: attemptId,
      templateAnalysisQueuedAt: now,
      templateAnalysisStartedAt: "",
      templateAnalysisCompletedAt: "",
      templateAnalysisError: null,
      templateAnalysisLease: null,
      updatedAt: now
    });
    await writeSharedTemplates(templates);
    return { claimed: true, recoveredStale: false, ownerId, leaseMs, template: templates[index] };
  });
}

export async function startTemplateAnalysis(projectRoot, templateId, attemptId, {
  ownerId = "",
  leaseMs = 10 * 60 * 1000
} = {}) {
  return mutateTemplateAnalysis(templateId, (current) => {
    assertTemplateAnalysisAttempt(current, attemptId, "queued");
    const now = new Date();
    return {
      ...current,
      templateStatus: "template_generating",
      templateProcessingStatus: "running",
      templateAnalysisStartedAt: now.toISOString(),
      templateAnalysisError: null,
      templateAnalysisLease: buildTemplateAnalysisLease({ ownerId, attemptId, leaseMs, state: "running", now })
    };
  });
}

export async function renewTemplateAnalysisLease(projectRoot, templateId, attemptId, leaseMs = 10 * 60 * 1000) {
  return mutateTemplateAnalysis(templateId, (current) => {
    if (current.templateAnalysisAttemptId !== attemptId || current.templateProcessingStatus !== "running") return null;
    const now = new Date();
    return {
      ...current,
      templateAnalysisLease: buildTemplateAnalysisLease({
        ownerId: current.templateAnalysisLease?.ownerId || "",
        attemptId,
        leaseMs,
        state: "running",
        now
      })
    };
  });
}

export async function completeTemplateAnalysis(projectRoot, templateId, attemptId, patch = {}) {
  return mutateTemplateAnalysis(templateId, (current) => {
    assertTemplateAnalysisAttempt(current, attemptId, "running");
    return {
      ...current,
      ...patch,
      templateStatus: "template_ready",
      templateProcessingStatus: "completed",
      templateAnalysisCompletedAt: new Date().toISOString(),
      templateAnalysisError: null,
      templateAnalysisLease: null
    };
  });
}

export async function failTemplateAnalysis(projectRoot, templateId, attemptId, message) {
  return mutateTemplateAnalysis(templateId, (current) => {
    if (current.templateAnalysisAttemptId !== attemptId) return null;
    return {
      ...current,
      templateStatus: "failed",
      templateProcessingStatus: "failed",
      templateAnalysisCompletedAt: new Date().toISOString(),
      templateAnalysisError: clean(message) || "テンプレート画像の解析に失敗しました。",
      templateAnalysisLease: null
    };
  });
}

export async function recoverTemplateAnalysisJobs(projectRoot, {
  ownerId = "",
  leaseMs = 10 * 60 * 1000,
  attemptIdFactory = () => crypto.randomUUID()
} = {}) {
  await ensureAdTemplateData();
  return withFileLock(sharedTemplatesPath(), async () => {
    const templates = await listAdTemplates();
    const jobs = [];
    let changed = false;
    const now = new Date();
    for (let index = 0; index < templates.length; index += 1) {
      const current = templates[index];
      if ((current.creativeType || "banner") !== "banner") continue;
      if (current.templateProcessingStatus === "queued") {
        const attemptId = current.templateAnalysisAttemptId || attemptIdFactory();
        if (!current.templateAnalysisAttemptId) {
          templates[index] = normalizeTemplate({ ...current, templateAnalysisAttemptId: attemptId, updatedAt: now.toISOString() });
          changed = true;
        }
        jobs.push({ templateId: current.id, attemptId, recoveredStale: false, ownerId, leaseMs });
        continue;
      }
      if (current.templateProcessingStatus !== "running" || !templateAnalysisLeaseExpired(current.templateAnalysisLease, now)) continue;
      const attemptId = attemptIdFactory();
      templates[index] = normalizeTemplate({
        ...current,
        templateStatus: "template_generating",
        templateProcessingStatus: "queued",
        templateAnalysisAttemptId: attemptId,
        templateAnalysisQueuedAt: now.toISOString(),
        templateAnalysisStartedAt: "",
        templateAnalysisCompletedAt: "",
        templateAnalysisError: null,
        templateAnalysisLease: null,
        updatedAt: now.toISOString()
      });
      changed = true;
      jobs.push({ templateId: current.id, attemptId, recoveredStale: true, ownerId, leaseMs });
    }
    if (changed) await writeSharedTemplates(templates);
    return jobs;
  });
}

export async function getAdTemplateStatuses(projectRoot, templateIds = []) {
  const ids = new Set((Array.isArray(templateIds) ? templateIds : []).map(String).filter(Boolean));
  const templates = await listAdTemplates();
  return templates
    .filter((item) => !ids.size || ids.has(item.id))
    .map((item) => ({
      templateId: item.id,
      templateProcessingStatus: item.templateProcessingStatus,
      templateStatus: item.templateStatus,
      templateAnalysisAttemptId: item.templateAnalysisAttemptId,
      templateAnalysisQueuedAt: item.templateAnalysisQueuedAt,
      templateAnalysisStartedAt: item.templateAnalysisStartedAt,
      templateAnalysisCompletedAt: item.templateAnalysisCompletedAt,
      templateAnalysisError: item.templateAnalysisError
    }));
}

export async function deleteAdTemplate(projectRoot, templateId) {
  await ensureAdTemplateData();
  return withFileLock(sharedTemplatesPath(), async () => {
    const templates = await listAdTemplates();
    const index = templates.findIndex((item) => item.id === templateId);
    if (index < 0) throw new Error("Row not found: " + templateId);
    const [deleted] = templates.splice(index, 1);
    await writeSharedTemplates(templates);
    return deleted;
  });
}

async function writeSharedTemplates(templates) {
  const target = sharedTemplatesPath();
  await writeJson(path.dirname(target), path.basename(target), templates);
}

function normalizeTemplate(input) {
  const templatePromptJson = normalizeTemplatePromptJson(input.templatePromptJson);
  const templateZones = Array.isArray(input.templateZones)
    ? normalizeTemplateZones(input.templateZones)
    : (Array.isArray(templatePromptJson?.zones) ? normalizeTemplateZones(templatePromptJson.zones) : []);
  const layoutBlueprint = normalizeBlueprint(input.layoutBlueprint || templatePromptJson?.layoutBlueprint);
  const copyBlueprint = normalizeBlueprint(input.copyBlueprint || templatePromptJson?.copyBlueprint);
  const templateReadiness = normalizeTemplateReadinessState(input.templateReadiness, {
    imageFile: clean(input.imageFile),
    layoutBlueprint,
    copyBlueprint
  });
  return {
    id: clean(input.id),
    title: clean(input.title),
    creativeType: clean(input.creativeType) || "banner",
    ownership: clean(input.ownership) || "other",
    templateStatus: clean(input.templateStatus) || "not_started",
    templateProcessingStatus: normalizeTemplateProcessingStatus(input),
    templateReadiness,
    media: clean(input.media),
    genre: clean(input.genre),
    sourceId: clean(input.sourceId),
    sourceImageFile: clean(input.sourceImageFile),
    isBundled: Boolean(input.isBundled),
    imageFile: clean(input.imageFile),
    textStoryboard: clean(input.textStoryboard),
    templateTextStoryboard: clean(input.templateTextStoryboard),
    templatePromptJson,
    layoutBlueprint,
    copyBlueprint,
    structureSheet: input.structureSheet || templatePromptJson?.structureSheet || buildStructureSheet(input),
    templateZones,
    templateGlobalDesign: input.templateGlobalDesign || templatePromptJson?.globalDesign || null,
    templateColorScheme: input.templateColorScheme || templatePromptJson?.colorScheme || null,
    templateReusePolicy: clean(input.templateReusePolicy) || "構造レイヤーは維持し、デザインレイヤーは参考、コンテンツレイヤーは商品/WHO-WHATから新規作成する。",
    imageText: clean(input.imageText),
    successFactors: clean(input.successFactors),
    templateAnalysisAttemptId: clean(input.templateAnalysisAttemptId),
    templateAnalysisQueuedAt: clean(input.templateAnalysisQueuedAt),
    templateAnalysisStartedAt: clean(input.templateAnalysisStartedAt),
    templateAnalysisCompletedAt: clean(input.templateAnalysisCompletedAt),
    templateAnalysisError: input.templateAnalysisError == null ? null : clean(input.templateAnalysisError),
    templateAnalysisLease: normalizeTemplateAnalysisLease(input.templateAnalysisLease),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt
  };
}

async function mutateTemplateAnalysis(templateId, mutator) {
  await ensureAdTemplateData();
  return withFileLock(sharedTemplatesPath(), async () => {
    const templates = await listAdTemplates();
    const index = templates.findIndex((item) => item.id === templateId);
    if (index < 0) throw templateNotFoundError(templateId);
    const next = mutator(templates[index]);
    if (!next) return null;
    templates[index] = normalizeTemplate({ ...next, updatedAt: new Date().toISOString() });
    await writeSharedTemplates(templates);
    return templates[index];
  });
}

function assertTemplateAnalysisAttempt(template, attemptId, expectedStatus) {
  if (template.templateAnalysisAttemptId === attemptId && template.templateProcessingStatus === expectedStatus) return;
  const error = new Error("テンプレート解析は別の実行へ移りました。");
  error.code = "TEMPLATE_ANALYSIS_ATTEMPT_REPLACED";
  throw error;
}

function buildTemplateAnalysisLease({ ownerId, attemptId, leaseMs, state, now = new Date() }) {
  const duration = Math.max(60_000, Number(leaseMs) || 10 * 60 * 1000);
  return {
    ownerId: clean(ownerId),
    attemptId: clean(attemptId),
    state: clean(state) || "running",
    heartbeatAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + duration).toISOString()
  };
}

function normalizeTemplateAnalysisLease(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const attemptId = clean(value.attemptId);
  const expiresAt = clean(value.expiresAt);
  if (!attemptId || !expiresAt) return null;
  return {
    ownerId: clean(value.ownerId),
    attemptId,
    state: clean(value.state) || "running",
    heartbeatAt: clean(value.heartbeatAt),
    expiresAt
  };
}

function normalizeTemplateProcessingStatus(input = {}) {
  const explicit = clean(input.templateProcessingStatus);
  if (["not_started", "queued", "running", "completed", "failed"].includes(explicit)) return explicit;
  const legacyStatus = clean(input.templateStatus);
  if (legacyStatus === "template_generating") return "running";
  if (legacyStatus === "template_ready") return "completed";
  if (legacyStatus === "failed") return "failed";
  return "not_started";
}

function templateAnalysisLeaseExpired(lease, now = new Date()) {
  const expiresAt = Date.parse(lease?.expiresAt || "");
  return !Number.isFinite(expiresAt) || expiresAt <= now.getTime();
}

function templateNotFoundError(templateId) {
  const error = new Error("広告テンプレが見つかりません: " + templateId);
  error.code = "TEMPLATE_NOT_FOUND";
  return error;
}

function normalizeBlueprint(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function normalizeTemplatePromptJson(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    ...value,
    ...(Array.isArray(value.zones) ? { zones: normalizeTemplateZones(value.zones) } : {})
  };
}

function normalizeTemplateZones(zones) {
  return (Array.isArray(zones) ? zones : []).map((zone) => ({
    ...zone,
    elements: (Array.isArray(zone?.elements) ? zone.elements : []).map((element) => {
      if (String(element?.type || "text").toLowerCase() !== "text") return element;
      const charCount = positiveInteger(element.charCount ?? element.characterCount);
      return {
        ...element,
        ...(charCount ? { charCount } : {})
      };
    })
  }));
}

function buildStructureSheet(input) {
  const templateText = clean(input.templateTextStoryboard || input.textStoryboard);
  if (templateText) return { source: "templateTextStoryboard", summary: templateText };
  if (Array.isArray(input.templatePromptJson?.zones)) {
    return {
      source: "templatePromptJson.zones",
      summary: input.templatePromptJson.zones.map((zone) => `${zone.name || ""}: ${zone.position || ""} / ${zone.purpose || ""}`).join("\n")
    };
  }
  return null;
}

function clean(value) {
  return String(value || "").trim();
}

function positiveInteger(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : 0;
}

function createId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
