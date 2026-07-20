export const CANONICAL_COPY_FIELDS = ["mainHook", "subHook", "proof", "offerBadge", "cta", "disclaimer"];

const DEFAULT_SLOT_DEFS = [
  { slotId: "default-mainHook", zoneName: "Hook", role: "main hook", messageRole: "hook", canonicalField: "mainHook", charBudget: 24, required: true, sourcePolicy: "strategy_required", emptyPolicy: "block" },
  { slotId: "default-subHook", zoneName: "Benefit visual", role: "sub hook", messageRole: "benefit", canonicalField: "subHook", charBudget: 32, required: true, sourcePolicy: "strategy_required", emptyPolicy: "block" },
  { slotId: "default-proof", zoneName: "Benefit visual", role: "proof", messageRole: "proof", canonicalField: "proof", charBudget: 28, required: false, sourcePolicy: "strategy_required", emptyPolicy: "allow" },
  { slotId: "default-offerBadge", zoneName: "CTA", role: "offer badge", messageRole: "offer", canonicalField: "offerBadge", charBudget: 18, required: false, sourcePolicy: "instruction_or_strategy", emptyPolicy: "allow" },
  { slotId: "default-cta", zoneName: "CTA", role: "cta", messageRole: "cta", canonicalField: "cta", charBudget: 18, required: false, sourcePolicy: "instruction_or_strategy", emptyPolicy: "allow" },
  { slotId: "default-disclaimer", zoneName: "CTA", role: "disclaimer", messageRole: "disclaimer", canonicalField: "disclaimer", charBudget: 24, required: false, sourcePolicy: "instruction_or_strategy", emptyPolicy: "allow" }
];

export function buildCopySlotPlan(template = null) {
  const zones = templateZones(template);
  if (!zones.length) {
    const blueprintSlots = template?.copyBlueprint?.slots || template?.templatePromptJson?.copyBlueprint?.slots || [];
    if (Array.isArray(blueprintSlots) && blueprintSlots.length) {
      const slots = blueprintSlots.map((slot, index) => ({
        slotId: String(slot?.slotId || `slot-${index + 1}`).trim(),
        zoneName: "",
        role: String(slot?.role || "").trim(),
        messageRole: String(slot?.messageRole || "").trim(),
        canonicalField: canonicalFieldFromRoleText(String(slot?.role || slot?.messageRole || "").trim()) || "mainHook",
        charBudget: positiveInteger(slot?.charBudget) || 12,
        required: slot?.required !== false,
        sourcePolicy: String(slot?.sourcePolicy || "strategy_required"),
        emptyPolicy: String(slot?.emptyPolicy || "block"),
        order: index
      }));
      return {
        templateId: template?.id || "",
        templateTitle: template?.title || "",
        isDefault: false,
        slots,
        semanticGroups: buildSemanticGroups(template, slots)
      };
    }
    const slots = DEFAULT_SLOT_DEFS.map((slot, index) => ({ ...slot, order: index }));
    return {
      templateId: template?.id || "",
      templateTitle: template?.title || "",
      isDefault: true,
      slots,
      semanticGroups: buildSemanticGroups(template, slots)
    };
  }

  const slots = [];
  const copySlots = template?.copyBlueprint?.slots || template?.templatePromptJson?.copyBlueprint?.slots || [];
  const copySlotsById = new Map((Array.isArray(copySlots) ? copySlots : []).map((slot) => [String(slot?.slotId || ""), slot]));
  for (let zoneIndex = 0; zoneIndex < zones.length; zoneIndex += 1) {
    const zone = zones[zoneIndex] || {};
    const elements = Array.isArray(zone.elements) ? zone.elements : [];
    for (let elementIndex = 0; elementIndex < elements.length; elementIndex += 1) {
      const element = elements[elementIndex] || {};
      if (String(element.type || "text").toLowerCase() !== "text") continue;
      if (isBrandOrLogoText(element)) continue;
      const canonicalField = canonicalFieldForTextElement(element);
      const charBudget = charBudgetForElement(element, canonicalField);
      const slotId = String(element.slotId || `z${zoneIndex + 1}e${elementIndex + 1}`).trim();
      const copySlot = copySlotsById.get(slotId) || {};
      const required = copySlot.required === undefined ? true : copySlot.required !== false;
      slots.push({
        slotId,
        zoneName: String(zone.name || `Zone ${zoneIndex + 1}`).trim(),
        role: String(element.role || element.name || "").trim(),
        messageRole: String(element.messageRole || "").trim(),
        canonicalField,
        charBudget: charBudget.value,
        required,
        sourcePolicy: String(copySlot.sourcePolicy || "strategy_required"),
        emptyPolicy: String(copySlot.emptyPolicy || (required ? "block" : "allow")),
        sampleContent: String(element.content || element.text || "").trim(),
        ...(charBudget.estimated ? { estimated: true } : {}),
        order: slots.length
      });
    }
  }

  if (!slots.length) return buildCopySlotPlan(null);
  return {
    templateId: template?.id || "",
    templateTitle: template?.title || "",
    isDefault: false,
    slots,
    semanticGroups: buildSemanticGroups(template, slots)
  };
}

export function sanitizeCopySlotPlanForPrompt(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    templateId: String(source.templateId || ""),
    isDefault: source.isDefault === true,
    slots: (Array.isArray(source.slots) ? source.slots : []).map((slot) => ({
      slotId: String(slot?.slotId || ""),
      role: String(slot?.role || ""),
      messageRole: String(slot?.messageRole || ""),
      canonicalField: String(slot?.canonicalField || ""),
      charBudget: Number(slot?.charBudget) || 0,
      required: slot?.required !== false,
      sourcePolicy: String(slot?.sourcePolicy || ""),
      emptyPolicy: String(slot?.emptyPolicy || ""),
      ...(slot?.estimated ? { estimated: true } : {}),
      order: Number(slot?.order) || 0
    })),
    semanticGroups: (Array.isArray(source.semanticGroups) ? source.semanticGroups : []).map((group) => ({
      groupId: String(group?.groupId || ""),
      slotIds: Array.isArray(group?.slotIds) ? group.slotIds.map((slotId) => String(slotId || "")).filter(Boolean) : [],
      semanticRole: String(group?.semanticRole || ""),
      readingOrder: Number(group?.readingOrder) || 0,
      joinMode: String(group?.joinMode || ""),
      required: group?.required !== false,
      groupCharBudget: Number(group?.groupCharBudget) || 0,
      maxSemanticUnits: Number(group?.maxSemanticUnits) || 1
    }))
  };
}

export function sanitizeTemplateCopyForPrompt(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    id: String(source.id || ""),
    reuseMethod: String(source.reuseMethod || ""),
    slots: (Array.isArray(source.slots) ? source.slots : []).map((slot) => ({
      slotId: String(slot?.slotId || ""),
      role: String(slot?.role || ""),
      messageRole: String(slot?.messageRole || ""),
      charBudget: Number(slot?.charBudget) || 0
    }))
  };
}

export function buildSemanticGroups(template, slots = []) {
  const normalizedSlots = Array.isArray(slots) ? slots : [];
  const slotById = new Map(normalizedSlots.map((slot) => [clean(slot?.slotId), slot]).filter(([slotId]) => slotId));
  const explicitGroups = template?.copyBlueprint?.semanticGroups
    || template?.templatePromptJson?.copyBlueprint?.semanticGroups
    || [];
  if (Array.isArray(explicitGroups) && explicitGroups.length) {
    const groups = explicitGroups
      .map((group, index) => normalizeSemanticGroup(group, index, slotById))
      .filter((group) => group.slotIds.length);
    if (groups.length) return groups;
  }

  const grouped = new Map();
  for (const slot of [...normalizedSlots].sort((left, right) => (Number(left?.order) || 0) - (Number(right?.order) || 0))) {
    const field = CANONICAL_COPY_FIELDS.includes(slot?.canonicalField) ? slot.canonicalField : "";
    const key = field || `slot:${clean(slot?.slotId)}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(slot);
  }
  return [...grouped.entries()].map(([key, groupSlots], index) => {
    const canonicalField = key.startsWith("slot:") ? "" : key;
    const slotIds = groupSlots.map((slot) => clean(slot?.slotId)).filter(Boolean);
    return {
      groupId: canonicalField ? `group-${canonicalField}` : `group-${slotIds[0] || index + 1}`,
      slotIds,
      semanticRole: semanticRoleForCanonicalField(canonicalField),
      readingOrder: index,
      joinMode: slotIds.length > 1 ? "continuous_sentence" : "single",
      required: groupSlots.some((slot) => slot?.required !== false),
      groupCharBudget: groupSlots.reduce((sum, slot) => sum + (positiveInteger(slot?.charBudget) || 0), 0),
      maxSemanticUnits: 1
    };
  });
}

function normalizeSemanticGroup(value, index, slotById) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const slotIds = [...new Set((Array.isArray(source.slotIds) ? source.slotIds : []).map(clean).filter((slotId) => slotById.has(slotId)))];
  const groupSlots = slotIds.map((slotId) => slotById.get(slotId)).filter(Boolean);
  const inferredField = groupSlots.find((slot) => CANONICAL_COPY_FIELDS.includes(slot?.canonicalField))?.canonicalField || "";
  return {
    groupId: clean(source.groupId) || `group-${index + 1}`,
    slotIds,
    semanticRole: clean(source.semanticRole) || semanticRoleForCanonicalField(inferredField),
    readingOrder: nonNegativeInteger(source.readingOrder, index),
    joinMode: clean(source.joinMode) || (slotIds.length > 1 ? "continuous_sentence" : "single"),
    required: source.required === undefined ? groupSlots.some((slot) => slot?.required !== false) : source.required !== false,
    groupCharBudget: positiveInteger(source.groupCharBudget) || groupSlots.reduce((sum, slot) => sum + (positiveInteger(slot?.charBudget) || 0), 0),
    maxSemanticUnits: positiveInteger(source.maxSemanticUnits) || 1
  };
}

function semanticRoleForCanonicalField(field) {
  if (field === "mainHook") return "primary_promise";
  if (field === "subHook") return "supporting_benefit";
  if (field === "proof") return "proof";
  if (field === "offerBadge") return "offer";
  if (field === "cta") return "action";
  if (field === "disclaimer") return "disclaimer";
  return "supporting_context";
}

export function canonicalFieldForTextElement(element = {}) {
  const visualRoleText = normalizeRoleText([element.role, element.name].filter(Boolean).join(" "));
  if (roleTextIndicatesMainHook(visualRoleText)) return "mainHook";
  const messageRole = normalizeRoleText(element.messageRole);
  const byMessageRole = canonicalFieldFromMessageRole(messageRole);
  if (byMessageRole !== undefined) return byMessageRole;
  const roleText = normalizeRoleText([element.role, element.name, element.content, element.text].filter(Boolean).join(" "));
  return canonicalFieldFromRoleText(roleText);
}

export function normalizeSlotTexts(value, copySlotPlan) {
  const planSlots = Array.isArray(copySlotPlan?.slots) ? copySlotPlan.slots : [];
  const supplied = Array.isArray(value) ? value : [];
  const byId = new Map(supplied.map((item) => [String(item?.slotId || "").trim(), item]).filter(([slotId]) => slotId));
  const sourceSlots = planSlots.length
    ? planSlots
    : supplied.map((item, index) => ({
      slotId: String(item?.slotId || `legacy-${index + 1}`).trim(),
      zoneName: String(item?.zoneName || "").trim(),
      role: String(item?.role || "").trim(),
      messageRole: String(item?.messageRole || "").trim(),
      canonicalField: CANONICAL_COPY_FIELDS.includes(item?.canonicalField) ? item.canonicalField : null,
      charBudget: positiveInteger(item?.charBudget) || countCopyChars(item?.text || item?.content),
      order: index
    }));
  return sourceSlots.map((slot, index) => {
    const source = byId.get(String(slot.slotId || "").trim()) || supplied[index] || {};
    const text = clean(source.text ?? source.content ?? "");
    const charBudget = positiveInteger(source.charBudget) || positiveInteger(slot.charBudget) || 0;
    const bounds = charBudgetBounds(charBudget);
    return {
      slotId: String(slot.slotId || source.slotId || `slot-${index + 1}`).trim(),
      zoneName: clean(slot.zoneName || source.zoneName),
      role: clean(slot.role || source.role),
      messageRole: clean(slot.messageRole || source.messageRole),
      canonicalField: CANONICAL_COPY_FIELDS.includes(slot.canonicalField) ? slot.canonicalField : null,
      text,
      charBudget,
      charCount: countCopyChars(text),
      minChars: bounds.min,
      maxChars: bounds.max,
      ...(normalizeSource(source.strategySource) ? { strategySource: normalizeSource(source.strategySource) } : {}),
      ...(normalizeSource(source.templateHowSource) ? { templateHowSource: normalizeSource(source.templateHowSource) } : {}),
      ...(normalizeSource(source.instructionSource) ? { instructionSource: normalizeSource(source.instructionSource) } : {}),
      ...(clean(source.authorizedClaimId) ? { authorizedClaimId: clean(source.authorizedClaimId) } : {}),
      ...(clean(source.hypothesisId) ? { hypothesisId: clean(source.hypothesisId) } : {}),
      ...(Array.isArray(source.claimIds) ? { claimIds: [...new Set(source.claimIds.map(clean).filter(Boolean))] } : {}),
      ...(slot.estimated || source.estimated ? { estimated: true } : {})
    };
  });
}

function normalizeSource(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value)
    .map(([key, item]) => [String(key), String(item || "").trim()])
    .filter(([, item]) => item);
  return entries.length ? Object.fromEntries(entries) : null;
}

export function syncCanonicalFieldsFromSlots(slotTexts, fallback = {}) {
  const fields = Object.fromEntries(CANONICAL_COPY_FIELDS.map((field) => [field, ""]));
  const candidatesByField = new Map();
  for (const slot of Array.isArray(slotTexts) ? slotTexts : []) {
    const field = CANONICAL_COPY_FIELDS.includes(slot?.canonicalField) ? slot.canonicalField : "";
    const text = clean(slot?.text);
    if (!field || !text) continue;
    if (!candidatesByField.has(field)) candidatesByField.set(field, []);
    candidatesByField.get(field).push(slot);
  }
  for (const field of CANONICAL_COPY_FIELDS) {
    const candidates = candidatesByField.get(field) || [];
    const selected = [...candidates].sort((left, right) => (Number(right.charBudget) || 0) - (Number(left.charBudget) || 0))[0];
    fields[field] = clean(selected?.text);
  }
  return {
    ...fields,
    ...Object.fromEntries(Object.entries(fallback).filter(([key]) => !CANONICAL_COPY_FIELDS.includes(key)))
  };
}

export function copyBriefMeetsSlotRequirements(copyBrief, copySlotPlan) {
  if (!copyBrief || typeof copyBrief !== "object") return false;
  const slots = Array.isArray(copySlotPlan?.slots) ? copySlotPlan.slots : [];
  const normalizedSlots = normalizeSlotTexts(copyBrief.slotTexts, copySlotPlan);
  const canonicalFromSlots = normalizedSlots.length ? syncCanonicalFieldsFromSlots(normalizedSlots) : {};
  const mainHook = clean(copyBrief.mainHook || canonicalFromSlots.mainHook);
  const requiresMainHook = !slots.length || slots.some((slot) => slot?.canonicalField === "mainHook" && slot.required !== false);
  if ((requiresMainHook && !mainHook) || !copyBrief.appealAxis || !copyBrief.whyItStops) return false;
  if (!slots.length) return true;
  if (!normalizedSlots.length) return false;
  const textsBySlot = new Map(normalizedSlots.map((slot) => [String(slot?.slotId || "").trim(), clean(slot?.text)]));
  return slots.every((slot) => slot.required === false || textsBySlot.get(String(slot.slotId || "").trim()));
}

export function findSlotLengthViolations(copyBrief, copySlotPlan) {
  const slotTexts = normalizeSlotTexts(copyBrief?.slotTexts, copySlotPlan);
  return slotTexts
    .map((slot) => {
      const bounds = charBudgetBounds(slot.charBudget);
      return { ...slot, minChars: bounds.min, maxChars: bounds.max };
    })
    .filter((slot) => slot.text && slot.charBudget > 0 && slot.charCount > slot.maxChars);
}

export function charBudgetBounds(charBudget) {
  const budget = positiveInteger(charBudget) || 0;
  if (!budget) return { min: 0, max: 0 };
  return {
    min: 0,
    max: budget <= 10 ? 13 : Math.max(1, Math.floor(budget * 1.2))
  };
}

export function countCopyChars(value) {
  return String(value || "").replace(/[\s\u3000]/g, "").length;
}

export function estimateTemplateTextCharCount(value) {
  const expanded = String(value || "").replace(/\{[^{}]+\}/g, "□□□□");
  return countCopyChars(expanded);
}

export function isBrandOrLogoText(element = {}) {
  const roleText = normalizeRoleText([element.messageRole, element.role, element.name].filter(Boolean).join(" "));
  return /(?:logo|brand|wordmark|ロゴ|ブランド|会社名)/.test(roleText);
}

function templateZones(template) {
  if (Array.isArray(template?.templateZones) && template.templateZones.length) return template.templateZones;
  if (Array.isArray(template?.templatePromptJson?.zones)) return template.templatePromptJson.zones;
  if (Array.isArray(template?.zones)) return template.zones;
  return [];
}

function canonicalFieldFromMessageRole(messageRole) {
  if (!messageRole) return undefined;
  if (/^(?:hook|headline|primary|main)$/.test(messageRole)) return "mainHook";
  if (/^(?:problem|empathy|solution|benefit|subheadline|body|support)$/.test(messageRole)) return "subHook";
  if (/^(?:proof|reason-to-believe|evidence|trust)$/.test(messageRole)) return "proof";
  if (/^offer$/.test(messageRole)) return "offerBadge";
  if (/^(?:cta|action)$/.test(messageRole)) return "cta";
  if (/^(?:disclaimer|note)$/.test(messageRole)) return "disclaimer";
  if (/^(?:label|caption)$/.test(messageRole)) return null;
  return undefined;
}

function canonicalFieldFromRoleText(roleText) {
  if (roleTextIndicatesMainHook(roleText)) return "mainHook";
  if (/sub|secondary|support|benefit|body|problem|empathy|solution|サブ|補足|便益|本文|課題|共感|解決/.test(roleText)) return "subHook";
  if (/proof|evidence|reason|trust|根拠|証拠|理由|実績/.test(roleText)) return "proof";
  if (/offer|badge|オファー|特典|無料|割引/.test(roleText)) return "offerBadge";
  if (/cta|button|action|ボタン|行動|申込|詳細/.test(roleText)) return "cta";
  if (/note|disclaimer|注|免責/.test(roleText)) return "disclaimer";
  return null;
}

function roleTextIndicatesMainHook(roleText) {
  return /(?:^|[\s_-])(?:main|hero|headline|hook|primary)(?:$|[\s_-])/.test(roleText)
    || /メイン|見出し|フック/.test(roleText);
}

function charBudgetForElement(element, canonicalField) {
  const explicit = positiveInteger(element.charCount) || positiveInteger(element.characterCount) || positiveInteger(element.targetChars);
  if (explicit) return { value: explicit, estimated: false };
  const estimated = estimateTemplateTextCharCount(element.content || element.text);
  return {
    value: estimated || fallbackCharBudget(canonicalField),
    estimated: true
  };
}

function fallbackCharBudget(canonicalField) {
  const match = DEFAULT_SLOT_DEFS.find((slot) => slot.canonicalField === canonicalField);
  return match?.charBudget || 12;
}

function positiveInteger(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : 0;
}

function nonNegativeInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.round(numeric) : fallback;
}

function normalizeRoleText(value) {
  return String(value || "").normalize("NFKC").trim().toLowerCase();
}

function clean(value) {
  return String(value || "").trim();
}
