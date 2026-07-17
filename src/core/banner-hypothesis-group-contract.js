export const PATCHABLE_HYPOTHESIS_DIMENSIONS = Object.freeze({
  angle: Object.freeze(["chosenAngle"]),
  promise: Object.freeze(["primaryPromise", "supportingClaimIds", "semanticGroupMessages"]),
  proof: Object.freeze(["proofClaimIds"]),
  visual_scene: Object.freeze(["scene"]),
  visual_motif: Object.freeze(["motif"])
});

export const LOCKED_HYPOTHESIS_DIMENSIONS = Object.freeze([
  "audience",
  "target_moment",
  "barrier",
  "offer",
  "template_structure"
]);

const PATCHABLE_DIMENSION_NAMES = Object.freeze(Object.keys(PATCHABLE_HYPOTHESIS_DIMENSIONS));
const FIT_STATUSES = new Set(["fit", "adapt", "reject"]);

export function materializeHypothesisGroupPlan({
  plan,
  copySlotPlan,
  bannerIds,
  includeBaseline = true
} = {}) {
  const targetBannerIds = normalizeBannerIds(bannerIds);
  const sharedContract = normalizeSharedContract(plan?.sharedContract);
  const baselineCandidate = normalizeBaselineCandidate(plan?.baselineCandidate, copySlotPlan);
  assertBaselineMembership({ baselineCandidate, targetBannerIds, includeBaseline });
  const targetPatchBannerIds = includeBaseline ? targetBannerIds.slice(1) : targetBannerIds;
  const candidatePatches = normalizeCandidatePatches(
    plan?.candidatePatches,
    targetPatchBannerIds,
    copySlotPlan
  );
  const baselineItem = buildBaselineItem({ sharedContract, baselineCandidate, copySlotPlan });
  const variantItems = candidatePatches.map((patch) => applyCandidatePatch({
    baselineItem,
    patch,
    copySlotPlan
  }));

  return {
    sharedContract,
    baselineCandidate,
    candidatePatches,
    items: includeBaseline ? [baselineItem, ...variantItems] : variantItems
  };
}

export function deriveGroupPlanSeedFromHypothesis({ banner, copySlotPlan } = {}) {
  const hypothesis = cloneJson(banner?.creativeHypothesis || null);
  if (!clean(banner?.id) || !hypothesis || typeof hypothesis !== "object" || Array.isArray(hypothesis)) {
    throw invalid("保存済み兄弟案の勝ち筋仮説がありません。");
  }
  if (!new Set(["fit", "adapt"]).has(clean(hypothesis.templateFitDecision?.status))) {
    throw invalid("保存済み兄弟案のtemplateFitDecisionを基準として再利用できません。");
  }
  const sharedContract = normalizeSharedContract({
    audienceAttribute: hypothesis.audienceAttribute,
    targetMoment: hypothesis.targetMoment,
    barrier: hypothesis.barrier,
    offerClaimIds: hypothesis.offerClaimIds,
    templateMechanism: hypothesis.templateMechanism,
    templateFitDecision: hypothesis.templateFitDecision
  });
  const semanticGroupMessages = semanticMessagesFromSavedHypothesis(hypothesis, copySlotPlan);
  const focusDimensions = uniqueStrings(hypothesis.variationPolicy?.changedDimensions)
    .filter((dimension) => PATCHABLE_DIMENSION_NAMES.includes(dimension))
    .slice(0, 2);
  const baselineCandidate = normalizeBaselineCandidate({
    bannerId: banner.id,
    focusDimensions: focusDimensions.length ? focusDimensions : ["angle"],
    chosenAngle: hypothesis.chosenAngle,
    primaryPromise: hypothesis.primaryPromise,
    supportingClaimIds: hypothesis.supportingClaimIds,
    proofClaimIds: hypothesis.proofClaimIds,
    visualIntent: hypothesis.visualIntent,
    semanticGroupMessages
  }, copySlotPlan);

  return { sharedContract, baselineCandidate };
}

function normalizeSharedContract(value) {
  const source = objectValue(value, "sharedContractがありません。");
  const templateFitDecision = normalizeTemplateFitDecision(source.templateFitDecision);
  const normalized = {
    audienceAttribute: clean(source.audienceAttribute),
    targetMoment: clean(source.targetMoment),
    barrier: clean(source.barrier),
    offerClaimIds: uniqueStrings(source.offerClaimIds),
    templateMechanism: clean(source.templateMechanism),
    templateFitDecision
  };
  if (!normalized.audienceAttribute || !normalized.targetMoment || !normalized.barrier || !normalized.templateMechanism) {
    throw invalid("sharedContractの必須項目が不足しています。");
  }
  return normalized;
}

function normalizeBaselineCandidate(value, copySlotPlan) {
  const source = objectValue(value, "baselineCandidateがありません。");
  const focusDimensions = normalizeChangedDimensions(source.focusDimensions, "baselineCandidate.focusDimensions");
  const normalized = {
    bannerId: clean(source.bannerId),
    focusDimensions,
    chosenAngle: clean(source.chosenAngle),
    primaryPromise: clean(source.primaryPromise),
    supportingClaimIds: uniqueStrings(source.supportingClaimIds),
    proofClaimIds: uniqueStrings(source.proofClaimIds),
    visualIntent: {
      scene: clean(source.visualIntent?.scene),
      motif: clean(source.visualIntent?.motif)
    },
    semanticGroupMessages: normalizeSemanticGroupMessages(source.semanticGroupMessages, copySlotPlan)
  };
  if (!normalized.bannerId || !normalized.chosenAngle || !normalized.primaryPromise || !normalized.supportingClaimIds.length) {
    throw invalid("baselineCandidateの必須項目が不足しています。");
  }
  if (!normalized.visualIntent.scene || !normalized.visualIntent.motif) {
    throw invalid("baselineCandidate.visualIntentの必須項目が不足しています。");
  }
  return normalized;
}

function normalizeCandidatePatches(value, targetBannerIds, copySlotPlan) {
  const patches = Array.isArray(value) ? value : [];
  if (patches.length !== targetBannerIds.length) {
    throw invalid("candidatePatchesの件数が対象bannerと一致しません。");
  }
  return patches.map((patch, index) => {
    const source = objectValue(patch, "candidatePatchの形式が不正です。");
    const bannerId = clean(source.bannerId);
    if (!bannerId || bannerId !== targetBannerIds[index]) {
      throw invalid("candidatePatchesのbannerIdまたは順番が対象と一致しません。");
    }
    const changedDimensions = normalizeChangedDimensions(source.changedDimensions, "candidatePatch.changedDimensions");
    const changes = objectValue(source.changes, "candidatePatch.changesがありません。");
    assertExactKeys(changes, changedDimensions, "candidatePatch.changes");
    const normalizedChanges = {};
    for (const dimension of changedDimensions) {
      normalizedChanges[dimension] = normalizeDimensionChange(dimension, changes[dimension], copySlotPlan);
    }
    return { bannerId, changedDimensions, changes: normalizedChanges };
  });
}

function normalizeDimensionChange(dimension, value, copySlotPlan) {
  const source = objectValue(value, `${dimension}のchangesがありません。`);
  const allowedKeys = PATCHABLE_HYPOTHESIS_DIMENSIONS[dimension];
  assertExactKeys(source, allowedKeys, `${dimension}のchanges`);
  if (dimension === "angle") {
    const chosenAngle = clean(source.chosenAngle);
    if (!chosenAngle) throw invalid("angle.chosenAngleがありません。");
    return { chosenAngle };
  }
  if (dimension === "promise") {
    const primaryPromise = clean(source.primaryPromise);
    const supportingClaimIds = uniqueStrings(source.supportingClaimIds);
    if (!primaryPromise || !supportingClaimIds.length) throw invalid("promiseの必須項目が不足しています。");
    return {
      primaryPromise,
      supportingClaimIds,
      semanticGroupMessages: normalizeSemanticGroupMessages(source.semanticGroupMessages, copySlotPlan)
    };
  }
  if (dimension === "proof") return { proofClaimIds: uniqueStrings(source.proofClaimIds) };
  if (dimension === "visual_scene") {
    const scene = clean(source.scene);
    if (!scene) throw invalid("visual_scene.sceneがありません。");
    return { scene };
  }
  if (dimension === "visual_motif") {
    const motif = clean(source.motif);
    if (!motif) throw invalid("visual_motif.motifがありません。");
    return { motif };
  }
  throw invalid(`未定義の変更dimensionです: ${dimension}`);
}

function buildBaselineItem({ sharedContract, baselineCandidate, copySlotPlan }) {
  return {
    bannerId: baselineCandidate.bannerId,
    audienceAttribute: sharedContract.audienceAttribute,
    targetMoment: sharedContract.targetMoment,
    barrier: sharedContract.barrier,
    chosenAngle: baselineCandidate.chosenAngle,
    primaryPromise: baselineCandidate.primaryPromise,
    supportingClaimIds: [...baselineCandidate.supportingClaimIds],
    proofClaimIds: [...baselineCandidate.proofClaimIds],
    offerClaimIds: [...sharedContract.offerClaimIds],
    templateMechanism: sharedContract.templateMechanism,
    visualIntent: cloneJson(baselineCandidate.visualIntent),
    semanticGroupPlan: buildSemanticGroupPlan(baselineCandidate.semanticGroupMessages, copySlotPlan),
    templateFitDecision: cloneJson(sharedContract.templateFitDecision),
    variationPolicy: {
      role: "baseline",
      changedDimensions: [...baselineCandidate.focusDimensions],
      preservedDimensions: preservedDimensionsFor(baselineCandidate.focusDimensions)
    }
  };
}

function applyCandidatePatch({ baselineItem, patch, copySlotPlan }) {
  const item = cloneJson(baselineItem);
  item.bannerId = patch.bannerId;
  item.variationPolicy = {
    role: "variant",
    changedDimensions: [...patch.changedDimensions],
    preservedDimensions: preservedDimensionsFor(patch.changedDimensions)
  };
  for (const dimension of patch.changedDimensions) {
    const change = patch.changes[dimension];
    if (dimension === "angle") item.chosenAngle = change.chosenAngle;
    if (dimension === "promise") {
      item.primaryPromise = change.primaryPromise;
      item.supportingClaimIds = [...change.supportingClaimIds];
      item.semanticGroupPlan = buildSemanticGroupPlan(change.semanticGroupMessages, copySlotPlan);
    }
    if (dimension === "proof") item.proofClaimIds = [...change.proofClaimIds];
    if (dimension === "visual_scene") item.visualIntent.scene = change.scene;
    if (dimension === "visual_motif") item.visualIntent.motif = change.motif;
  }
  return item;
}

function preservedDimensionsFor(changedDimensions) {
  const changed = new Set(changedDimensions);
  return [
    ...LOCKED_HYPOTHESIS_DIMENSIONS,
    ...PATCHABLE_DIMENSION_NAMES.filter((dimension) => !changed.has(dimension))
  ];
}

function normalizeSemanticGroupMessages(value, copySlotPlan) {
  const expectedGroups = Array.isArray(copySlotPlan?.semanticGroups) ? copySlotPlan.semanticGroups : [];
  const supplied = Array.isArray(value) ? value : [];
  if (supplied.length !== expectedGroups.length) {
    throw invalid("semanticGroupMessagesの件数がcopySlotPlanと一致しません。");
  }
  const byId = new Map(supplied.map((item) => [clean(item?.groupId), item]));
  return expectedGroups.map((group) => {
    const groupId = clean(group?.groupId);
    const message = byId.get(groupId);
    const intendedMessage = clean(message?.intendedMessage);
    if (!groupId || !intendedMessage) throw invalid(`semanticGroupMessagesが不足しています: ${groupId}`);
    return { groupId, intendedMessage };
  });
}

function buildSemanticGroupPlan(messages, copySlotPlan) {
  const byId = new Map(messages.map((item) => [item.groupId, item.intendedMessage]));
  return (copySlotPlan?.semanticGroups || []).map((group) => ({
    groupId: clean(group?.groupId),
    semanticRole: clean(group?.semanticRole),
    intendedMessage: byId.get(clean(group?.groupId)) || "",
    slotIds: uniqueStrings(group?.slotIds),
    readingOrder: Number(group?.readingOrder) || 0,
    joinMode: clean(group?.joinMode)
  }));
}

function semanticMessagesFromSavedHypothesis(hypothesis, copySlotPlan) {
  const expectedGroups = Array.isArray(copySlotPlan?.semanticGroups) ? copySlotPlan.semanticGroups : [];
  const supplied = Array.isArray(hypothesis?.semanticGroupPlan) ? hypothesis.semanticGroupPlan : [];
  if (supplied.length !== expectedGroups.length) {
    throw invalid("保存済みsemanticGroupPlanの件数がcopySlotPlanと一致しません。");
  }
  const byId = new Map(supplied.map((group) => [clean(group?.groupId), group]));
  const messages = expectedGroups.map((expected) => {
    const groupId = clean(expected?.groupId);
    const current = byId.get(groupId);
    if (!current || clean(current.intendedMessage) === "") {
      throw invalid(`保存済みsemanticGroupPlanが不足しています: ${groupId}`);
    }
    if (JSON.stringify(uniqueStrings(current.slotIds)) !== JSON.stringify(uniqueStrings(expected.slotIds))
      || clean(current.joinMode) !== clean(expected.joinMode)) {
      throw invalid(`保存済みsemanticGroupPlanの構造が変わっています: ${groupId}`);
    }
    return { groupId, intendedMessage: clean(current.intendedMessage) };
  });
  return normalizeSemanticGroupMessages(messages, copySlotPlan);
}

function normalizeTemplateFitDecision(value) {
  const source = objectValue(value, "templateFitDecisionがありません。");
  const status = clean(source.status);
  if (!FIT_STATUSES.has(status)) throw invalid("templateFitDecision.statusがfit、adapt、rejectのいずれでもありません。");
  return {
    status,
    reason: clean(source.reason),
    roleAdjustments: Array.isArray(source.roleAdjustments) ? cloneJson(source.roleAdjustments) : []
  };
}

function normalizeChangedDimensions(value, label) {
  const dimensions = uniqueStrings(value);
  if (dimensions.length < 1 || dimensions.length > 2) {
    throw invalid(`${label}は1〜2件必要です。`);
  }
  if (dimensions.some((dimension) => !PATCHABLE_DIMENSION_NAMES.includes(dimension))) {
    throw invalid(`${label}に変更禁止dimensionが含まれています。`);
  }
  return dimensions;
}

function assertBaselineMembership({ baselineCandidate, targetBannerIds, includeBaseline }) {
  if (!targetBannerIds.length) throw invalid("対象bannerIdがありません。");
  if (includeBaseline && baselineCandidate.bannerId !== targetBannerIds[0]) {
    throw invalid("baselineCandidateが対象bannerの先頭と一致しません。");
  }
  if (!includeBaseline && targetBannerIds.includes(baselineCandidate.bannerId)) {
    throw invalid("部分再実行のbaselineCandidateが対象bannerに含まれています。");
  }
}

function normalizeBannerIds(value) {
  const bannerIds = Array.isArray(value) ? value.map(clean).filter(Boolean) : [];
  if (bannerIds.length !== new Set(bannerIds).size) throw invalid("対象bannerIdが重複しています。");
  return bannerIds;
}

function assertExactKeys(value, expectedKeys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw invalid(`${label}のキーがchangedDimensionsと一致しません。`);
  }
}

function objectValue(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(message);
  return value;
}

function invalid(message) {
  const error = new Error(message);
  error.code = "HYPOTHESIS_PATCH_INVALID";
  return error;
}

function uniqueStrings(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(clean).filter(Boolean))];
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function clean(value) {
  return String(value ?? "").trim();
}
