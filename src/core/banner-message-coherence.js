const TEMPLATE_FIT_STATUSES = new Set(["fit", "adapt", "reject"]);
const CLAIM_SOURCE_TYPES = new Set(["strategy", "additional_instruction", "product_identity", "regulation"]);

export function normalizeAuthorizedClaimSet(value) {
  const source = asObject(value);
  const instructionIntent = asObject(source.additionalInstructionIntent);
  return {
    audienceAttribute: clean(source.audienceAttribute),
    purchaseMomentGoal: clean(source.purchaseMomentGoal),
    chosenAngle: clean(source.chosenAngle),
    coreMessage: clean(source.coreMessage),
    whyThisAngle: clean(source.whyThisAngle),
    additionalInstructionIntent: {
      priority: "highest",
      fixedCopy: normalizeStrings(instructionIntent.fixedCopy),
      requiredAngles: normalizeStrings(instructionIntent.requiredAngles),
      allowSiblingSimilarity: instructionIntent.allowSiblingSimilarity === true
    },
    templateMessagePlan: (Array.isArray(source.templateMessagePlan) ? source.templateMessagePlan : [])
      .map((item) => {
        const plan = asObject(item);
        return {
          groupId: clean(plan.groupId),
          semanticRole: clean(plan.semanticRole),
          groupMessage: clean(plan.groupMessage),
          slotIds: normalizeStrings(plan.slotIds)
        };
      })
      .filter((item) => item.groupId || item.groupMessage || item.slotIds.length),
    claims: (Array.isArray(source.claims) ? source.claims : [])
      .map((item, index) => {
        const claim = asObject(item);
        const requestedType = clean(claim.sourceType);
        return {
          claimId: clean(claim.claimId) || `claim-${index + 1}`,
          text: clean(claim.text),
          sourceType: CLAIM_SOURCE_TYPES.has(requestedType) ? requestedType : "strategy",
          numericTokens: normalizeStrings(claim.numericTokens),
          allowedUses: normalizeStrings(claim.allowedUses),
          mandatory: claim.mandatory === true
        };
      })
      .filter((item) => item.text || item.numericTokens.length),
    identityAnchors: normalizeStrings(source.identityAnchors),
    mandatorySharedAnchors: normalizeStrings(source.mandatorySharedAnchors),
    forbiddenClaims: normalizeStrings(source.forbiddenClaims)
  };
}

export function normalizeMessagePlan(value) {
  const source = asObject(value);
  return {
    targetMoment: clean(source.targetMoment),
    awarenessStage: clean(source.awarenessStage),
    productOrTaskAnchor: clean(source.productOrTaskAnchor),
    oneMessage: clean(source.oneMessage),
    primaryPromise: clean(source.primaryPromise),
    supportingProof: clean(Array.isArray(source.supportingProof) ? source.supportingProof[0] : source.supportingProof),
    offer: clean(source.offer),
    informationPriority: normalizeInformationPriority(source.informationPriority),
    numbers: normalizeNumbers(source.numbers),
    forbiddenInterpretations: normalizeStrings(source.forbiddenInterpretations)
  };
}

export function normalizeTemplateFitDecision(value) {
  const source = asObject(value);
  const requestedStatus = clean(source.status).toLowerCase();
  return {
    status: TEMPLATE_FIT_STATUSES.has(requestedStatus) ? requestedStatus : "reject",
    reason: clean(source.reason),
    roleAdjustments: normalizeRoleAdjustments(source.roleAdjustments)
  };
}

export function buildCopyReadoutText(copyBrief, copySlotPlan) {
  const slotTexts = Array.isArray(copyBrief?.slotTexts) ? copyBrief.slotTexts : [];
  const byId = new Map(slotTexts.map((slot) => [clean(slot?.slotId), clean(slot?.text)]).filter(([slotId]) => slotId));
  const orderedPlanSlots = [...(Array.isArray(copySlotPlan?.slots) ? copySlotPlan.slots : [])]
    .sort((left, right) => (Number(left?.order) || 0) - (Number(right?.order) || 0));
  const consumed = new Set();
  const texts = [];
  for (const slot of orderedPlanSlots) {
    const slotId = clean(slot?.slotId);
    const text = byId.get(slotId) || "";
    if (slotId) consumed.add(slotId);
    if (text) texts.push(text);
  }
  for (const slot of slotTexts) {
    const slotId = clean(slot?.slotId);
    const text = clean(slot?.text);
    if (text && !consumed.has(slotId)) texts.push(text);
  }
  return texts.join(" / ");
}

export function evaluateMessagePlanGate({ brief, copyLocked = false } = {}) {
  const source = asObject(brief);
  const isWinningDesignContract = Number(source.version) >= 4;
  const hasAuthorizedClaimSet = Boolean(source.authorizedClaimSet && typeof source.authorizedClaimSet === "object" && !Array.isArray(source.authorizedClaimSet));
  const hasMessagePlan = Boolean(source.messagePlan && typeof source.messagePlan === "object" && !Array.isArray(source.messagePlan));
  const hasTemplateFit = Boolean(source.templateFitDecision && typeof source.templateFitDecision === "object" && !Array.isArray(source.templateFitDecision));
  const messagePlan = normalizeMessagePlan(source.messagePlan);
  const authorizedClaimSet = normalizeAuthorizedClaimSet(source.authorizedClaimSet);
  const templateFitDecision = normalizeTemplateFitDecision(source.templateFitDecision);
  const issues = [];
  if (isWinningDesignContract) {
    if (!clean(source.hypothesisId)) issues.push("hypothesis_id_missing");
    if (!clean(source.approvedClaimSnapshotId)) issues.push("approved_claim_snapshot_id_missing");
    const semanticGroups = Array.isArray(source.semanticGroupReadout) ? source.semanticGroupReadout : [];
    if (!semanticGroups.length) issues.push("semantic_group_readout_missing");
    if (semanticGroups.length && !semanticGroups.some((group) => clean(group?.visibleText))) issues.push("semantic_group_not_understood");
  } else {
    if (!hasAuthorizedClaimSet) issues.push("authorized_claim_set_missing");
    if (hasAuthorizedClaimSet && !authorizedClaimSet.audienceAttribute) issues.push("audience_attribute_missing");
    if (hasAuthorizedClaimSet && !authorizedClaimSet.purchaseMomentGoal) issues.push("purchase_moment_goal_missing");
    if (hasAuthorizedClaimSet && !authorizedClaimSet.chosenAngle) issues.push("chosen_angle_missing");
    if (hasAuthorizedClaimSet && !authorizedClaimSet.coreMessage) issues.push("core_message_missing");
    if (hasAuthorizedClaimSet && !authorizedClaimSet.templateMessagePlan.length) issues.push("template_message_plan_missing");
  }
  if (!hasMessagePlan) issues.push("message_plan_missing");
  if (hasMessagePlan && !messagePlan.productOrTaskAnchor) issues.push("product_or_task_anchor_missing");
  if (hasMessagePlan && !messagePlan.oneMessage) issues.push("one_message_missing");
  if (hasMessagePlan && !messagePlan.primaryPromise) issues.push("primary_promise_missing");
  const readoutText = clean(source.readoutText || buildCopyReadoutText(source, null));
  if (hasMessagePlan && /[0-9０-９]/.test(readoutText)) {
    if (!messagePlan.numbers.length) {
      issues.push("number_context_missing");
    } else if (messagePlan.numbers.some((number) => !number.value || !number.meaning || !number.owner || !number.minimumContext)) {
      issues.push("number_context_incomplete");
    }
  }
  if (!hasTemplateFit) issues.push("template_fit_decision_missing");
  if (hasTemplateFit && templateFitDecision.status === "reject") issues.push("template_message_fit_failed");

  if (copyLocked) {
    return {
      status: issues.length ? "warning" : "passed",
      authorizedClaimSet,
      messagePlan,
      templateFitDecision,
      failures: [],
      warnings: issues
    };
  }
  return {
    status: issues.length ? "failed" : "passed",
    authorizedClaimSet,
    messagePlan,
    templateFitDecision,
    failures: issues,
    warnings: []
  };
}

function normalizeNumbers(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => {
      const source = asObject(item);
      return {
        value: clean(source.value),
        meaning: clean(source.meaning),
        owner: clean(source.owner),
        polarity: clean(source.polarity),
        minimumContext: clean(source.minimumContext)
      };
    })
    .filter((item) => item.value || item.meaning || item.minimumContext);
}

function normalizeInformationPriority(value) {
  const source = asObject(value);
  return {
    mustShow: normalizeStrings(source.mustShow),
    support: normalizeStrings(source.support),
    drop: normalizeStrings(source.drop)
  };
}

function normalizeRoleAdjustments(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => {
      const source = asObject(item);
      return {
        slotId: clean(source.slotId),
        fromRole: clean(source.fromRole),
        toRole: clean(source.toRole),
        reason: clean(source.reason)
      };
    })
    .filter((item) => item.slotId || item.toRole || item.reason);
}

function normalizeStrings(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(clean).filter(Boolean))];
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function clean(value) {
  return String(value ?? "").trim();
}
