import crypto from "node:crypto";

export const TEMPLATE_READINESS_SCHEMA_VERSION = 2;

export function buildTemplateValidationHash({ imageFile = "", layoutBlueprint = null, copyBlueprint = null } = {}) {
  const payload = stableStringify({
    imageFile: String(imageFile || ""),
    layoutBlueprint: layoutBlueprint || null,
    copyBlueprint: copyBlueprint || null
  });
  return `sha256:${crypto.createHash("sha256").update(payload).digest("hex")}`;
}

export function buildTemplateReadinessState({
  imageFile = "",
  layoutBlueprint = null,
  copyBlueprint = null,
  validatedAt = new Date().toISOString()
} = {}) {
  const { layoutReady, copyReady, issues } = inspectTemplateBlueprints(layoutBlueprint, copyBlueprint);
  return {
    schemaVersion: TEMPLATE_READINESS_SCHEMA_VERSION,
    layout: layoutReady ? "ready" : "needs_review",
    copy: copyReady ? "ready" : "needs_review",
    readyForGeneration: layoutReady && copyReady,
    validatedAt: layoutReady && copyReady ? String(validatedAt || new Date().toISOString()) : "",
    validationHash: buildTemplateValidationHash({ imageFile, layoutBlueprint, copyBlueprint }),
    issues
  };
}

export function normalizeTemplateReadinessState(value, {
  imageFile = "",
  layoutBlueprint = null,
  copyBlueprint = null
} = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const structural = buildTemplateReadinessState({ imageFile, layoutBlueprint, copyBlueprint });
  const expectedHash = structural.validationHash;
  const schemaMatches = Number(source.schemaVersion) === TEMPLATE_READINESS_SCHEMA_VERSION;
  const hashMatches = String(source.validationHash || "") === expectedHash;
  const validated = source.readyForGeneration === true && schemaMatches && hashMatches && structural.readyForGeneration;
  const issues = [...structural.issues];
  if (!schemaMatches) issues.push("readiness_schema_outdated");
  if (schemaMatches && !hashMatches) issues.push("validation_hash_mismatch");
  return {
    schemaVersion: schemaMatches ? TEMPLATE_READINESS_SCHEMA_VERSION : Number(source.schemaVersion) || 0,
    layout: structural.layout,
    copy: structural.copy,
    readyForGeneration: validated,
    validatedAt: validated ? String(source.validatedAt || "") : "",
    validationHash: String(source.validationHash || expectedHash),
    issues: [...new Set(issues)]
  };
}

export function templateReadyForGeneration(template = {}) {
  const normalized = normalizeTemplateReadinessState(template.templateReadiness, template);
  return normalized.readyForGeneration;
}

function inspectTemplateBlueprints(layoutBlueprint, copyBlueprint) {
  const layoutReady = Boolean(Array.isArray(layoutBlueprint?.zones) && layoutBlueprint.zones.length);
  const slots = Array.isArray(copyBlueprint?.slots) ? copyBlueprint.slots : [];
  const sourceProfile = copyBlueprint?.sourceCategoryProfile;
  const sourceProfileReady = Boolean(sourceProfile && typeof sourceProfile === "object"
    && [sourceProfile.category, sourceProfile.subcategory, sourceProfile.audience, sourceProfile.problem, sourceProfile.solutionType, sourceProfile.purchaseContext]
      .some((item) => String(item || "").trim()));
  const copyReady = slots.length > 0
    && sourceProfileReady
    && slots.every((slot) => String(slot?.slotId || "").trim()
      && String(slot?.role || "").trim()
      && positiveInteger(slot?.charBudget));
  const issues = [];
  if (!layoutReady) issues.push("layout_blueprint_missing");
  if (!copyReady) issues.push("copy_blueprint_incomplete");
  return { layoutReady, copyReady, issues };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function positiveInteger(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : 0;
}
