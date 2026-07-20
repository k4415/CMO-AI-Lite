import crypto from "node:crypto";
import { openAiJson } from "./openai-text.js";
import { loadPrompt } from "./prompt-files.js";
import { buildCopySlotPlan, copyBriefMeetsSlotRequirements, isBrandOrLogoText, normalizeSlotTexts, syncCanonicalFieldsFromSlots } from "./banner-copy-slots.js";
import { buildInstructionPolicy, ruleIsExplicitlyOverridden } from "./banner-instruction-policy.js";
import { buildBannerGenerationContract } from "./banner-generation-contract.js";
import { hashCopyBrief } from "./banner-copy-hash.js";
import { compileClosedTemplatePromptSeed } from "./banner-prompt-compiler.js";
import {
  buildClosedStructureInstruction,
  buildSelectedAssetOverridePolicy,
  buildTemplateStructureContract,
  enforceTemplateStructure
} from "./banner-template-structure.js";

export async function generateBannerCreativeProposal({
  banner,
  product,
  strategy,
  template,
  expressionRules = [],
  diversityGuidance = null,
  copyBrief = null,
  creativeHypothesis = null,
  approvedClaimSnapshot = null,
  jsonGenerator = openAiJson
}) {
  const audit = createPromptGenerationAudit();
  try {
  const instructionPolicy = banner?.instructionPolicy || buildInstructionPolicy(
    [banner?.additionalInstruction, banner?.revisionInstruction].filter(Boolean).join("\n")
  );
  const rules = classifyExpressionRules(expressionRules, product, instructionPolicy);
  const generationContext = prepareBannerGenerationContext(product, strategy);
  const copySlotPlan = buildCopySlotPlan(template);
  const generationContract = banner?.bannerGenerationContract || buildBannerGenerationContract({
    banner,
    product: generationContext.product,
    strategy: generationContext.strategy,
    template,
    extraInstruction: [banner?.additionalInstruction, banner?.revisionInstruction].filter(Boolean).join("\n"),
    instructionPolicy,
    expressionRules: rules.specifiedRules,
    creativeHypothesis,
    approvedClaimSnapshot
  });
  const lockedCopyBrief = normalizeCopyBriefForDesign(copyBrief, generationContext.strategy, copySlotPlan);
  const explicitCopyLock = instructionPolicy.protectedFields.includes("copyBrief") && Boolean(banner?.lockedContentSnapshot);
  if (!explicitCopyLock && !copyBriefMeetsSlotRequirements(lockedCopyBrief, copySlotPlan)) {
    throw new Error("copyBrief が未生成です。先にコピー開発を実行してください。");
  }

  const runDesign = async () => {
    const userPrompt = buildBannerDesignPrompt({
      banner,
      product: generationContext.product,
      strategy: generationContext.strategy,
      template,
      specifiedRules: rules.specifiedRules,
      instructionPolicy,
      diversityGuidance,
      copyBrief: lockedCopyBrief,
      copySlotPlan,
      generationContract,
      creativeHypothesis,
      approvedClaimSnapshot
    });
    audit.modelDesignCalls += 1;
    audit.inputChars += BANNER_CREATOR_SYSTEM.length + userPrompt.length;
    const callHash = sha256(`${BANNER_CREATOR_SYSTEM}\n${userPrompt}`);
    audit.inputHashes.push(callHash);
    const parsed = await jsonGenerator({
      system: BANNER_CREATOR_SYSTEM,
      user: userPrompt,
      onAttempt: (event) => {
        audit.httpAttempts.push({ ...event, designCall: audit.modelDesignCalls });
      },
      onResult: (event) => {
        audit.outputChars += Number(event?.outputChars) || 0;
        if (event?.model) audit.model = String(event.model);
        audit.resultEvents.push({ ...event, modelDesignCall: audit.modelDesignCalls });
      }
    });
    const normalized = normalizeBannerProposal(parsed, {
      banner,
      product: generationContext.product,
      strategy: generationContext.strategy,
      template,
      diversityGuidance,
      copyBrief: lockedCopyBrief,
      copySlotPlan,
      specifiedRules: rules.specifiedRules,
      instructionPolicy,
      generationContract,
      creativeHypothesis,
      approvedClaimSnapshot
    });
    const repaired = reapplyLockedSlotTexts(normalized, {
      copyBrief: lockedCopyBrief,
      copySlotPlan,
      template
    });
    audit.deterministicRepairs.push(...repaired.repairs.map((repair) => `${repair.type}:${repair.slotId}`));
    return repaired.proposal;
  };

  const closedTemplate = buildTemplateStructureContract(template?.templateZones).closed;
  const runDeterministicDesign = () => {
    const parsed = compileClosedTemplatePromptSeed({
      banner,
      product: generationContext.product,
      strategy: generationContext.strategy,
      template,
      copyBrief: lockedCopyBrief,
      creativeHypothesis,
      instructionPolicy
    });
    const serialized = JSON.stringify(parsed);
    audit.model = "deterministic-template-compiler-v1";
    audit.inputChars += serialized.length;
    audit.outputChars += serialized.length;
    audit.inputHashes.push(sha256(serialized));
    const normalized = normalizeBannerProposal(parsed, {
      banner,
      product: generationContext.product,
      strategy: generationContext.strategy,
      template,
      diversityGuidance,
      copyBrief: lockedCopyBrief,
      copySlotPlan,
      specifiedRules: rules.specifiedRules,
      instructionPolicy,
      generationContract,
      creativeHypothesis,
      approvedClaimSnapshot
    });
    const repaired = reapplyLockedSlotTexts(normalized, {
      copyBrief: lockedCopyBrief,
      copySlotPlan,
      template
    });
    audit.deterministicRepairs.push(...repaired.repairs.map((repair) => `${repair.type}:${repair.slotId}`));
    return repaired.proposal;
  };

  const normalized = closedTemplate ? runDeterministicDesign() : await runDesign();

  const result = {
    ...applyRegulationRules(normalized, rules.ngRules, instructionPolicy),
    overriddenRules: rules.overriddenRules.map((rule) => ({
      ruleId: rule.id || "",
      ruleType: rule.ruleType || "",
      pattern: rule.pattern || "",
      reason: "explicit_additional_instruction"
    }))
  };
  result.promptGenerationAudit = finalizePromptGenerationAudit(audit, "completed");
  return result;
  } catch (error) {
    error.promptGenerationAudit = finalizePromptGenerationAudit(audit, "failed", error);
    throw error;
  }
}

function createPromptGenerationAudit() {
  return {
    version: 1,
    model: process.env.CMOAI_TEXT_MODEL || process.env.OPENAI_TEXT_MODEL || "gpt-5.5",
    startedAt: new Date().toISOString(),
    outcome: "running",
    inputChars: 0,
    inputHashes: [],
    inputHash: "",
    outputChars: 0,
    modelDesignCalls: 0,
    httpAttempts: [],
    resultEvents: [],
    deterministicRepairs: []
  };
}

function finalizePromptGenerationAudit(audit, outcome, error = null) {
  return {
    ...audit,
    outcome,
    inputHash: sha256(audit.inputHashes.join("\n")),
    ...(outcome === "completed" ? { completedAt: new Date().toISOString() } : { failedAt: new Date().toISOString() }),
    ...(error ? {
      errorCode: String(error?.code || "PROMPT_GENERATION_FAILED"),
      errorMessage: String(error?.message || error)
    } : {})
  };
}

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(String(value || "")).digest("hex")}`;
}

export function reapplyLockedSlotTexts(proposal, { copyBrief, copySlotPlan, template } = {}) {
  const promptJson = proposal?.promptJson && typeof proposal.promptJson === "object" ? proposal.promptJson : {};
  const zones = Array.isArray(promptJson.zones) ? promptJson.zones.map((zone) => ({
    ...zone,
    elements: Array.isArray(zone?.elements) ? zone.elements.map((element) => ({ ...element })) : []
  })) : [];
  const lockedSlots = normalizeSlotTexts(copyBrief?.slotTexts, copySlotPlan).filter((slot) => String(slot.text || "").trim());
  const repairs = [];
  const claimedElements = new Set();
  const allTextElements = zones.flatMap((zone) => zone.elements || [])
    .filter((element) => String(element?.type || "text").toLowerCase() === "text" && !isBrandOrLogoText(element));

  for (const slot of lockedSlots) {
    let element = allTextElements.find((candidate) => !claimedElements.has(candidate) && String(candidate.slotId || "") === slot.slotId);
    let repairType = "locked_slot_reapplied";
    if (!element) {
      element = findBestUnlockedTextElement(allTextElements, claimedElements, slot);
      repairType = "open_slot_rebound";
    }
    if (!element) {
      if (buildTemplateStructureContract(template?.templateZones).closed) {
        const error = new Error(`テンプレ構造内に確定コピースロットがありません: ${slot.slotId}`);
        error.code = "PROMPT_TEMPLATE_SLOT_MISSING";
        error.restartNode = "prompt";
        throw error;
      }
      // Fallback mode may omit a slot, but it must never grow the model-proposed structure.
      continue;
    }
    claimedElements.add(element);
    const previousSlotId = String(element.slotId || "");
    const previousContent = String(element.content || "");
    element.slotId = slot.slotId;
    element.content = slot.text;
    if (previousSlotId !== slot.slotId || previousContent !== slot.text) {
      repairs.push({ type: repairType, slotId: slot.slotId, previousSlotId });
    }
  }

  const repairedPromptJson = { ...promptJson, zones };
  const repairedProposal = {
    ...proposal,
    promptJson: repairedPromptJson,
    promptText: buildPromptText(repairedPromptJson).trim()
  };
  return { proposal: repairedProposal, repairs };
}

function findBestUnlockedTextElement(elements, claimedElements, slot) {
  const available = elements.filter((element) => !claimedElements.has(element));
  const field = String(slot?.canonicalField || "").toLowerCase();
  const roleMatch = available.find((element) => {
    const roleText = `${element?.role || ""} ${element?.messageRole || ""}`.toLowerCase();
    if (field === "mainhook") return /main|hero|headline|hook|primary|メイン|見出し/.test(roleText);
    if (field === "subhook") return /sub|secondary|support|benefit|サブ|補足|便益/.test(roleText);
    if (field === "proof") return /proof|evidence|reason|trust|根拠|証拠|実績/.test(roleText);
    if (field === "offerbadge") return /offer|badge|オファー|特典|無料|割引/.test(roleText);
    if (field === "cta") return /cta|button|action|ボタン|行動|申込|詳細/.test(roleText);
    if (field === "disclaimer") return /note|disclaimer|注|免責/.test(roleText);
    return false;
  });
  return roleMatch || available[0] || null;
}

export function prepareBannerGenerationContext(product = {}, strategy = {}) {
  const sanitizedProduct = summarizeProductIdentity(product);

  const markdown = String(strategy.markdown || "").trim();
  if (!markdown) {
    return {
      product: sanitizedProduct,
      strategy: { ...strategy, sourceMode: "structured_fallback" }
    };
  }

  return {
    product: sanitizedProduct,
    strategy: {
      id: strategy.id || "",
      productId: strategy.productId || "",
      conceptName: strategy.conceptName || "",
      segmentName: strategy.segmentName || "",
      status: strategy.status || "",
      markdown,
      sourceMode: "markdown"
    }
  };
}

export function buildBannerDesignPrompt({ banner, product, strategy, template, specifiedRules, instructionPolicy = null, diversityGuidance, copyBrief, copySlotPlan, generationContract = null, creativeHypothesis = null, approvedClaimSnapshot = null, retryReason }) {
  void generationContract;
  void retryReason;
  const stage2Input = buildBannerDesignInput({
    banner,
    product,
    strategy,
    template,
    specifiedRules,
    instructionPolicy,
    diversityGuidance,
    copyBrief,
    copySlotPlan,
    creativeHypothesis,
    approvedClaimSnapshot
  });
  const templateStructureContract = stage2Input.templateStructureContract;
  const selectedAssetPolicy = stage2Input.selectedAssetPolicy;
  return [
    "# Stage2Input",
    "以下のJSONだけを入力の正として扱う。上流データ・旧テンプレ本文・表示用テンプレ名は参照しない。",
    JSON.stringify(stage2Input),
    templateStructureContract.closed ? buildClosedStructureInstruction(templateStructureContract, selectedAssetPolicy) : "",
    selectedAssetPolicy.enabled
      ? "ユーザー選択素材だけを閉じた構造の唯一の例外とし、すべて必ず反映する。選択されていない素材を追加しない。"
      : "",
    "copyBrief.slotTextsは確定済み。zones内textは同じslotIdのtextを一字も変えずに配置し、新しいtext枠を増やさない。",
    `promptJson.basic.sizeは「${stage2Input.banner.imageSize}」に固定する。`,
    "# 出力要件",
    strategy.sourceMode === "markdown"
      ? "戦略は strategy.markdown を唯一の正として解釈すること。旧構造化項目は入力から除外済みであり、本文からターゲット・欲求・便益・オファーを読み取ること。"
      : "strategy.markdown がない旧データのため、戦略の構造化項目をフォールバックとして使うこと。",
    "JSONのみ。promptJson, promptText, reviewNotes, selectionReasonを必ず含める。creativeHypothesisとcontractRefsは出力しない。いずれもコード側で正本を固定する。imageTextはコード側で確定コピーから組み立てるため、出力しても採用されない。",
    "promptJsonは指定JSON構造（basic, globalDesign, colorScheme, zones, referenceImage, negativeRules, reviewChecklist）に合わせる。",
    "zones[].elements[] の text 要素は copyBrief.slotTexts の slotId 対応で配置する。slotTextsがない旧データの場合のみ mainHook, subHook, proof, offerBadge, cta, disclaimer の非空値を使う。新しいコピーを書かない。",
    "promptJson.target, desire, benefit, offerは戦略本文から読み取り、画像生成へ渡す完成値を必ず入れる。",
    "商品にbrandToneが設定されている場合はglobalDesign.toneに反映する。ブランドカラーは商品情報から指定せず、テンプレ構造と訴求内容に合う配色を設計する。",
    "テンプレDBがある場合は、構造レイヤー（ゾーン構成・要素配置・視線誘導・余白設計）を維持し、デザインレイヤーは参考にする。コンテンツレイヤーの新規作成とは、既存image/shape枠の内側を商品/WHO-WHAT/copyBriefに合わせることを意味する。ユーザー選択素材だけは唯一の例外として、対応枠がない場合も最小限配置できるが、それ以外の新しいelementは追加しない。",
    "テンプレにcontentArchitecture/variableDefinitionsがある場合は、訴求順序と各要素のmessageRole/source/constraintsを維持し、単純な名詞置換ではなく同じ役割を果たす配置と画像へ差し替える。",
    "各zones[].elements[]には type, role, content, position, size, targetChars, sourceReason, templateReuseLevel を入れる。",
    "テンプレ未指定の場合も、DR広告として読める構造を自分で定義する。"
  ].filter(Boolean).join("\n");
}

export function buildBannerDesignInput({ banner = {}, product = {}, strategy = {}, template = null, specifiedRules = [], instructionPolicy = null, diversityGuidance = null, copyBrief = null, copySlotPlan = null, creativeHypothesis = null, approvedClaimSnapshot = null } = {}) {
  const resolvedSlotPlan = copySlotPlan || buildCopySlotPlan(template);
  const templateStructureContract = buildTemplateStructureContract(template?.templateZones);
  const selectedAssetPolicy = buildSelectedAssetOverridePolicy(banner);
  const resolvedInstructionPolicy = instructionPolicy || buildInstructionPolicy(
    [banner?.additionalInstruction, banner?.revisionInstruction].filter(Boolean).join("\n")
  );
  return {
    version: 1,
    banner: {
      id: String(banner?.id || ""),
      imageSize: String(banner?.imageSize || "1080x1080")
    },
    productIdentity: summarizeProductIdentity(product),
    strategy,
    copyBrief: normalizeCopyBriefForDesign(copyBrief, strategy, resolvedSlotPlan),
    copySlotPlan: summarizeCopySlotPlanForPrompt(resolvedSlotPlan),
    templateId: String(template?.id || ""),
    templateStructureContract,
    selectedAssetPolicy,
    instructionPolicy: resolvedInstructionPolicy,
    creativeHypothesis: creativeHypothesis || {},
    approvedClaimSnapshotRef: {
      snapshotId: String(approvedClaimSnapshot?.snapshotId || ""),
      contentHash: String(approvedClaimSnapshot?.contentHash || "")
    },
    expressionRules: (Array.isArray(specifiedRules) ? specifiedRules : []).slice(0, 40),
    diversityReferences: compactDiversityReferences(diversityGuidance)
  };
}

function compactDiversityReferences(guidance) {
  if (!guidance || typeof guidance !== "object") return null;
  return {
    axisLabel: String(guidance.axisLabel || "").trim(),
    axisInstruction: String(guidance.axisInstruction || "").trim(),
    avoid: (Array.isArray(guidance.avoidCopies) ? guidance.avoidCopies : []).slice(-8).map((item) => ({
      candidateIdentity: String(item?.candidateIdentity || item?.id || "").trim(),
      variationAxis: String(item?.variationAxis || "").trim(),
      mainHook: String(item?.mainHook || "").trim().slice(0, 120),
      visualDirection: String(item?.visualDirection || "").trim().slice(0, 240)
    }))
  };
}

export function buildBannerDiversityInstruction(guidance) {
  if (!guidance || typeof guidance !== "object") return "";
  const previousVisuals = (Array.isArray(guidance.avoidCopies) ? guidance.avoidCopies : [])
    .map((item) => ({
      candidateIdentity: String(item?.candidateIdentity || item?.id || "").trim(),
      variationAxis: String(item?.variationAxis || "").trim(),
      mainHook: String(item?.mainHook || "").trim().slice(0, 120),
      visualDirection: String(item?.visualDirection || "").trim().slice(0, 240)
    }))
    .filter((item) => item.visualDirection || item.mainHook || item.variationAxis)
    .slice(-8);
  return [
    "# 複数案の視覚差別化要件",
    guidance.axisLabel ? `今回の訴求軸: ${guidance.axisLabel}` : "",
    guidance.axisInstruction ? `軸の実装指示: ${guidance.axisInstruction}` : "",
    "コピー差別化は Stage 1 で完了している。ここではテンプレの構造レイヤーは維持しながら、既出案と同じ被写体・利用シーン・中心モチーフの反復を避ける。",
    "選択WHO-WHATにない内容は作らず、指定された訴求軸を視覚化する別のシーンを設計する。",
    previousVisuals.length ? "既出ビジュアル（反復回避対象）:\n" + JSON.stringify(previousVisuals, null, 2) : ""
  ].filter(Boolean).join("\n");
}

export function normalizeBannerProposal(parsed, { banner, product, strategy, template, diversityGuidance = null, copyBrief = null, copySlotPlan = null, specifiedRules = [], instructionPolicy = null, generationContract = null, creativeHypothesis = null, approvedClaimSnapshot = null } = {}) {
  const plan = copySlotPlan || buildCopySlotPlan(template);
  const lockedCopyBrief = normalizeCopyBriefForDesign(copyBrief, strategy, plan);
  const contractRequired = requiresStage2Contract(lockedCopyBrief, creativeHypothesis, approvedClaimSnapshot);
  if (contractRequired) {
    assertBannerContractContinuity({
      copyBrief: lockedCopyBrief,
      creativeHypothesis,
      approvedClaimSnapshot
    });
  }
  const contractRefs = contractRequired
    ? buildPromptContractRefs(lockedCopyBrief, creativeHypothesis, approvedClaimSnapshot)
    : null;
  const imageText = buildImageTextFromCopyBrief(lockedCopyBrief, plan);
  const rawPromptJson = parsed?.promptJson || parsed?.prompt || {};
  const promptJson = rawPromptJson && typeof rawPromptJson === "object" && !Array.isArray(rawPromptJson) ? rawPromptJson : { reproductionPrompt: String(rawPromptJson || "") };
  const normalizedPromptJson = normalizePromptJson(promptJson, {
    banner: banner || {},
    product: product || {},
    strategy: strategy || {},
    template,
    imageText,
    diversityGuidance,
    copyBrief: lockedCopyBrief,
    copySlotPlan: plan,
    specifiedRules,
    instructionPolicy,
    contractRefs
  });
  if (contractRefs) assertPromptContractRefs(normalizedPromptJson, contractRefs);
  const resolvedContract = stripTemplateDisplayMetadataFromContract(generationContract || buildBannerGenerationContract({
    banner,
    product,
    strategy,
    template,
    instructionPolicy,
    expressionRules: specifiedRules,
    creativeHypothesis,
    approvedClaimSnapshot
  }));
  const resolvedHypothesis = contractRequired
    ? creativeHypothesis
    : normalizeLegacyCreativeHypothesis(parsed?.creativeHypothesis, lockedCopyBrief, resolvedContract);
  return {
    imageText,
    copyBrief: lockedCopyBrief,
    promptJson: normalizedPromptJson,
    colorDecision: resolveColorDecision({
      rawColorScheme: rawPromptJson?.colorScheme,
      palette: normalizedPromptJson.colorScheme,
      instructionPolicy,
      specifiedRules
    }),
    promptText: buildPromptText(normalizedPromptJson).trim(),
    reviewNotes: Array.isArray(parsed?.reviewNotes) ? parsed.reviewNotes.join("\n") : String(parsed?.reviewNotes || "").trim(),
    selectionReason: String(parsed?.selectionReason || "").trim(),
    bannerGenerationContract: resolvedContract,
    creativeHypothesis: resolvedHypothesis,
    visualHypothesisRef: contractRequired ? {
      hypothesisId: String(creativeHypothesis?.hypothesisId || ""),
      contentHash: String(creativeHypothesis?.contentHash || "")
    } : null
  };
}

function normalizeLegacyCreativeHypothesis(value, copyBrief, contract) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    oneMessage: String(copyBrief?.messagePlan?.oneMessage || "").trim(),
    targetMoment: String(copyBrief?.messagePlan?.targetMoment || source.targetMoment || copyBrief.targetMoment || "").trim(),
    strategyPromise: String(copyBrief?.messagePlan?.primaryPromise || source.strategyPromise || contract?.strategyWhat?.promise || contract?.strategyWhat?.markdown || "").trim(),
    templateMechanism: String(source.templateMechanism || contract?.templateHow?.hookMechanism || "").trim(),
    proofLogic: String(source.proofLogic || "").trim(),
    whyItShouldWin: String(source.whyItShouldWin || copyBrief.whyItStops || "").trim(),
    testVariable: String(source.testVariable || copyBrief.appealAxis || "").trim()
  };
}

export function assertBannerContractContinuity({
  copyBrief,
  creativeHypothesis,
  approvedClaimSnapshot
} = {}) {
  if (creativeHypothesis?.approvedClaimSnapshotId !== approvedClaimSnapshot?.snapshotId
    || creativeHypothesis?.approvedClaimSnapshotHash !== approvedClaimSnapshot?.contentHash) {
    throw contractError("HYPOTHESIS_SNAPSHOT_REF_STALE", "hypothesis", "勝ち筋仮説が現在の許可主張snapshotと一致しません。");
  }
  if (copyBrief?.hypothesisId !== creativeHypothesis?.hypothesisId
    || copyBrief?.hypothesisHash !== creativeHypothesis?.contentHash
    || copyBrief?.approvedClaimSnapshotId !== approvedClaimSnapshot?.snapshotId
    || copyBrief?.approvedClaimSnapshotHash !== approvedClaimSnapshot?.contentHash) {
    throw contractError("COPY_HYPOTHESIS_REF_STALE", "copy", "copyBriefが現在の勝ち筋仮説またはsnapshotと一致しません。");
  }
  if (!copyBrief?.copyBriefHash || copyBrief.copyBriefHash !== hashCopyBrief(copyBrief)) {
    throw contractError("COPY_BRIEF_HASH_STALE", "copy", "copyBrief本文とcopyBriefHashが一致しません。");
  }
  return true;
}

export function assertPromptContractRefs(promptJson, expectedRefs) {
  const actual = promptJson?.contractRefs;
  const fields = [
    "hypothesisId",
    "hypothesisHash",
    "approvedClaimSnapshotId",
    "approvedClaimSnapshotHash",
    "copyBriefVersion",
    "copyBriefHash"
  ];
  if (!actual || fields.some((field) => actual[field] !== expectedRefs?.[field])) {
    throw contractError("PROMPT_CONTRACT_REFS_INVALID", "prompt", "画像promptの契約参照が現在の正本と一致しません。");
  }
  return true;
}

function requiresStage2Contract(copyBrief) {
  return Number(copyBrief?.version) >= 4;
}

function buildPromptContractRefs(copyBrief, creativeHypothesis, approvedClaimSnapshot) {
  return {
    hypothesisId: String(creativeHypothesis?.hypothesisId || ""),
    hypothesisHash: String(creativeHypothesis?.contentHash || ""),
    approvedClaimSnapshotId: String(approvedClaimSnapshot?.snapshotId || ""),
    approvedClaimSnapshotHash: String(approvedClaimSnapshot?.contentHash || ""),
    copyBriefVersion: Number(copyBrief?.version) || 0,
    copyBriefHash: String(copyBrief?.copyBriefHash || "")
  };
}

function contractError(code, restartNode, message) {
  const error = new Error(message);
  error.code = code;
  error.restartNode = restartNode;
  error.productionStatus = "failed";
  return error;
}

function normalizePromptJson(promptJson, { banner, product, strategy, template, imageText, diversityGuidance, copyBrief, copySlotPlan, specifiedRules, instructionPolicy, contractRefs = null }) {
  const hasModelZones = Array.isArray(promptJson.zones) && promptJson.zones.length;
  const sanitizedTemplateZones = sanitizeTemplateZonesForDesign(template?.templateZones);
  const selectedAssetPolicy = buildSelectedAssetOverridePolicy(banner);
  const templateStructure = sanitizedTemplateZones.length
    ? enforceTemplateStructure({ templateZones: template?.templateZones, generatedZones: promptJson.zones })
    : null;
  const sourceZones = templateStructure
    ? templateStructure.zones
    : (hasModelZones ? promptJson.zones : fallbackZones({ product, strategy, copyBrief }));
  const basic = promptJson.basic && typeof promptJson.basic === "object" ? promptJson.basic : {};
  const globalDesign = promptJson.globalDesign && typeof promptJson.globalDesign === "object" ? promptJson.globalDesign : {};
  const colorScheme = promptJson.colorScheme && typeof promptJson.colorScheme === "object" ? promptJson.colorScheme : {};
  const resolvedColorScheme = applyColorPriority({
    palette: {
    main: String(colorScheme.main || SAFE_BANNER_PALETTE.main),
    sub: String(colorScheme.sub || SAFE_BANNER_PALETTE.sub),
    accent: String(colorScheme.accent || SAFE_BANNER_PALETTE.accent),
    background: String(colorScheme.background || SAFE_BANNER_PALETTE.background),
    },
    instructionPolicy,
    specifiedRules
  });
  Object.assign(resolvedColorScheme, {
    usage: colorScheme.usage || {
      main: "trust and headline",
      accent: "CTA and offer emphasis",
      background: "readability"
    },
    designNote: String(colorScheme.designNote || promptJson.colorDirection || "")
  });
  const zones = normalizeZones(sourceZones, copyBrief, copySlotPlan, product).map((zone) => ({
    ...zone,
    ...(!hasModelZones && !templateStructure ? { background: "" } : {}),
    elements: (zone.elements || []).map((element) => ({
      ...element,
      ...(!element.color ? { color: colorForElement(element, resolvedColorScheme) } : {})
    }))
  }));
  const structureSheet = templateStructure
    ? buildStructureSheet(null, zones)
    : (promptJson.structureSheet || promptJson.templateStructure || buildStructureSheet(null, zones));
  const templateDesign = sanitizeTemplateDesign(template?.templateGlobalDesign) || {};
  const requestedSize = String(banner.imageSize || "").trim();
  const resolvedVisualStyle = templateStructure?.contract?.typeCounts?.image === 0 && !selectedAssetPolicy.enabled
    ? {
        type: "text-and-existing-shapes-only",
        mood: String(globalDesign.visualStyle?.mood || templateDesign.visualStyle?.mood || "clear and restrained"),
        note: "既存のtext/shape要素だけを使用する。ロゴ、写真、イラスト、人物、端末、図解、追加装飾を描かない。"
      }
    : (selectedAssetPolicy.enabled && templateStructure?.contract?.typeCounts?.image === 0
      ? {
          type: "selected-assets-with-template-layout",
          mood: String(globalDesign.visualStyle?.mood || templateDesign.visualStyle?.mood || "clear and restrained"),
          note: "閉じたテンプレの視線順と可読性を維持し、ユーザー選択素材だけを最小限追加する。それ以外の画像・装飾は増やさない。"
        }
      : (globalDesign.visualStyle || templateDesign.visualStyle || { type: "product and benefit scene", mood: "credible", note: "avoid copying template subject matter" }));
  return {
    basic: {
      aspectRatio: requestedSize ? deriveAspectRatioLabel(requestedSize) : String(basic.aspectRatio || promptJson.aspectRatio || "1:1"),
      size: requestedSize || String(basic.size || promptJson.size || "1024x1024")
    },
    productName: product.name || "",
    strategyName: strategy.conceptName || "",
    templateAdId: template?.id || "",
    target: String(promptJson.target || strategy.targetAttributes || strategy.desire || ""),
    desire: String(promptJson.desire || strategy.desire || ""),
    benefit: String(promptJson.benefit || strategy.benefit || strategy.productConcept || ""),
    offer: String(promptJson.offer || strategy.offer || copyBrief.offerBadge || ""),
    additionalInstruction: String(instructionPolicy?.rawInstruction || promptJson.additionalInstruction || ""),
    structureSheet,
    globalDesign: {
      style: String(globalDesign.style || templateDesign.style || promptJson.style || "direct response banner"),
      tone: String(globalDesign.tone || product.brandTone || promptJson.tone || "clear, credible, action-oriented"),
      targetImpression: String(globalDesign.targetImpression || "target feels this ad is about their own situation"),
      fontPolicy: globalDesign.fontPolicy || { primary: "large readable Japanese headline", secondary: "support copy", note: "small but legible notes" },
      spacingPolicy: globalDesign.spacingPolicy || { overall: "preserve clear margins", margin: "10% or more where possible", elementGap: "avoid crowding text" },
      contrastPolicy: globalDesign.contrastPolicy || { level: "high", note: "CTA and main copy must stand out" },
      visualStyle: resolvedVisualStyle,
      gridAlignment: globalDesign.gridAlignment || { horizontal: "structured alignment", vertical: "zone based", note: "maintain template-like hierarchy" },
      designRationale: String(globalDesign.designRationale || promptJson.visualDirection || diversityGuidance?.axisInstruction || "")
    },
    colorScheme: resolvedColorScheme,
    zones,
    ...(templateStructure ? {
      templateStructureContract: templateStructure.contract,
      templateStructureReview: {
        status: templateStructure.status,
        violations: templateStructure.violations
      }
    } : {}),
    selectedAssetPolicy,
    referenceImage: {
      instruction: buildReferenceImageInstruction(banner, templateStructure?.contract, selectedAssetPolicy),
      url: ""
    },
    copyBrief: {
      strategyId: copyBrief.strategyId || strategy.id || "",
      appealAxis: copyBrief.appealAxis || "",
      variationDirection: copyBrief.variationDirection || "",
      targetMoment: copyBrief.targetMoment || "",
      mainHook: copyBrief.mainHook || "",
      whyItStops: copyBrief.whyItStops || "",
      templateUseNote: copyBrief.templateUseNote || "",
      readoutText: copyBrief.readoutText || "",
      messagePlan: copyBrief.messagePlan || null,
      templateFitDecision: copyBrief.templateFitDecision || null,
      slotTexts: Array.isArray(copyBrief.slotTexts) ? copyBrief.slotTexts : []
    },
    negativeRules: uniqueStrings(normalizeList(promptJson.negativeRules).concat([
      "効果保証",
      "過度なBefore/After",
      "医療的な治療表現",
      ...(templateStructure
        ? [selectedAssetPolicy.enabled
          ? "ユーザー選択素材以外のテンプレ構造にないtext/image/shape/装飾を追加しない"
          : "テンプレ構造にないtext/image/shape/装飾を追加しない"]
        : []),
      ...(templateStructure?.contract?.typeCounts?.image === 0 && !selectedAssetPolicy.enabled ? ["ロゴ・写真・イラスト・人物・端末・図解を追加しない"] : [])
    ])),
    reviewChecklist: normalizeReviewChecklist(promptJson.reviewChecklist),
    imageText,
    ...(contractRefs ? { contractRefs: { ...contractRefs } } : {})
  };
}

export function buildImageTextFromCopyBrief(copyBrief = {}, copySlotPlan = null) {
  if (Array.isArray(copyBrief.slotTexts) && copyBrief.slotTexts.length) {
    return normalizeSlotTexts(copyBrief.slotTexts, copySlotPlan)
      .map((slot) => String(slot.text || "").trim())
      .filter(Boolean)
      .join("\n");
  }
  return [
    copyBrief.mainHook,
    copyBrief.subHook,
    copyBrief.proof,
    copyBrief.offerBadge,
    copyBrief.cta,
    copyBrief.disclaimer
  ].map((item) => String(item || "").trim()).filter(Boolean).join("\n");
}

function normalizeCopyBriefForDesign(value, strategy = {}, copySlotPlan = null) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const slotTexts = Array.isArray(source.slotTexts)
    ? normalizeSlotTexts(source.slotTexts, Number(source.version) >= 4 ? null : copySlotPlan)
    : [];
  const canonicalFromSlots = slotTexts.length ? syncCanonicalFieldsFromSlots(slotTexts) : null;
  return {
    version: Number(source.version) || 1,
    strategyId: String(source.strategyId || strategy.id || "").trim(),
    hypothesisId: String(source.hypothesisId || "").trim(),
    hypothesisHash: String(source.hypothesisHash || "").trim(),
    approvedClaimSnapshotId: String(source.approvedClaimSnapshotId || "").trim(),
    approvedClaimSnapshotHash: String(source.approvedClaimSnapshotHash || "").trim(),
    copyBriefHash: String(source.copyBriefHash || "").trim(),
    generatedAt: String(source.generatedAt || "").trim(),
    model: String(source.model || "").trim(),
    appealAxis: String(source.appealAxis || "").trim(),
    variationDirection: String(source.variationDirection || "").trim(),
    targetMoment: String(source.targetMoment || "").trim(),
    mainHook: String(canonicalFromSlots?.mainHook || source.mainHook || "").trim(),
    subHook: String(canonicalFromSlots?.subHook || source.subHook || "").trim(),
    proof: String(canonicalFromSlots?.proof || source.proof || "").trim(),
    offerBadge: String(canonicalFromSlots?.offerBadge || source.offerBadge || "").trim(),
    cta: String(canonicalFromSlots?.cta || source.cta || "").trim(),
    disclaimer: String(canonicalFromSlots?.disclaimer || source.disclaimer || "").trim(),
    ...(slotTexts.length ? { slotTexts } : {}),
    ...(source.messagePlan && typeof source.messagePlan === "object" && !Array.isArray(source.messagePlan) ? { messagePlan: source.messagePlan } : {}),
    ...(source.templateFitDecision && typeof source.templateFitDecision === "object" && !Array.isArray(source.templateFitDecision) ? { templateFitDecision: source.templateFitDecision } : {}),
    ...(Array.isArray(source.semanticGroupReadout) ? { semanticGroupReadout: source.semanticGroupReadout } : {}),
    readoutText: String(source.readoutText || "").trim(),
    templateUseNote: String(source.templateUseNote || "").trim(),
    whyItStops: String(source.whyItStops || "").trim(),
    rejectedAlternatives: normalizeRejectedAlternatives(source.rejectedAlternatives)
  };
}

function normalizeRejectedAlternatives(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => ({
      text: String(item?.text || item || "").trim(),
      reason: String(item?.reason || "").trim()
    }))
    .filter((item) => item.text)
    .slice(0, 1);
}

function normalizeZones(zones, copyBrief, copySlotPlan = null, product = {}) {
  const hasSlotTexts = Array.isArray(copyBrief?.slotTexts) && copyBrief.slotTexts.length;
  const slotTextsById = new Map(normalizeSlotTexts(copyBrief?.slotTexts, copySlotPlan).map((slot) => [slot.slotId, slot]));
  return (zones || []).map((zone, index) => ({
    name: String(zone.name || `Zone ${index + 1}`),
    position: String(zone.position || zone.area || ""),
    purpose: String(zone.purpose || zone.role || ""),
    elements: (Array.isArray(zone.elements) ? zone.elements : []).map((element, elementIndex) => {
      const type = String(element.type || "text");
      const normalized = {
        type,
        slotId: String(element.slotId || `z${index + 1}e${elementIndex + 1}`),
        role: String(element.role || element.name || ""),
        messageRole: String(element.messageRole || ""),
        content: String(element.content || element.text || ""),
        position: element.position || {},
        size: String(element.size || ""),
        font: String(element.font || ""),
        color: String(element.color || ""),
        effect: String(element.effect || ""),
        targetChars: element.targetChars ?? element.characterCount ?? element.charCount ?? "",
        sourceReason: String(element.sourceReason || ""),
        templateReuseLevel: String(element.templateReuseLevel || "structure-only")
      };
      if (type.toLowerCase() === "text") {
        if (hasSlotTexts) {
          if (isBrandOrLogoText(normalized)) {
            normalized.content = productBrandText(product);
          } else {
            const slot = slotTextsById.get(normalized.slotId);
            if (slot) {
              normalized.content = slot.text;
              normalized.targetChars = slot.charBudget || normalized.targetChars;
            } else {
              normalized.content = "";
            }
          }
        } else {
          const roleText = `${normalized.role} ${normalized.messageRole} ${normalized.content}`.toLowerCase();
          normalized.content = copyTextForRole(roleText, copyBrief);
        }
      }
      return normalized;
    })
  }));
}

function productBrandText(product = {}) {
  return String(product.brandName || product.brand || product.name || "").trim();
}

function copyBriefEntries(copyBrief) {
  return [
    ["mainHook", copyBrief.mainHook],
    ["subHook", copyBrief.subHook],
    ["proof", copyBrief.proof],
    ["offerBadge", copyBrief.offerBadge],
    ["cta", copyBrief.cta],
    ["disclaimer", copyBrief.disclaimer]
  ].map(([key, text]) => ({ key, text: String(text || "").trim() })).filter((item) => item.text);
}

function copyTextForRole(roleText, copyBrief) {
  if (/main|hero|headline|hook|primary|メイン|見出し|フック/.test(roleText) && copyBrief.mainHook) return copyBrief.mainHook;
  if (/sub|secondary|support|benefit|サブ|補足|便益/.test(roleText) && copyBrief.subHook) return copyBrief.subHook;
  if (/proof|evidence|reason|trust|根拠|証拠|理由|実績/.test(roleText) && copyBrief.proof) return copyBrief.proof;
  if (/offer|badge|オファー|特典|無料|割引/.test(roleText) && copyBrief.offerBadge) return copyBrief.offerBadge;
  if (/cta|button|action|ボタン|行動|申込|詳細/.test(roleText) && copyBrief.cta) return copyBrief.cta;
  if (/note|disclaimer|注|免責/.test(roleText) && copyBrief.disclaimer) return copyBrief.disclaimer;
  return "";
}

function fallbackZones({ product, strategy, copyBrief }) {
  const entries = copyBriefEntries(copyBrief);
  return [
    {
      name: "Hook",
      position: "top 0-30%",
      purpose: "ターゲットの注意を止める",
      elements: [{ type: "text", role: "main hook", content: copyBrief.mainHook || strategy.conceptName || product.name || "", targetChars: 24 }]
    },
    {
      name: "Benefit visual",
      position: "middle 30-76%",
      purpose: "商品体験とベネフィットを想起させる",
      elements: [
        { type: "image", role: "product or usage scene", content: product.name || "", targetChars: 0 },
        { type: "text", role: "sub hook", content: copyBrief.subHook || entries[1]?.text || "", targetChars: 32 },
        { type: "text", role: "proof", content: copyBrief.proof || "", targetChars: 28 }
      ].filter((item) => item.type !== "text" || item.content)
    },
    {
      name: "CTA",
      position: "bottom 76-100%",
      purpose: "オファーと行動喚起",
      elements: [
        { type: "text", role: "offer badge", content: copyBrief.offerBadge || "", targetChars: 18 },
        { type: "text", role: "cta", content: copyBrief.cta || "", targetChars: 18 },
        { type: "text", role: "disclaimer", content: copyBrief.disclaimer || "", targetChars: 24 }
      ].filter((item) => item.content)
    }
  ];
}

function zonesContainText(zones, text) {
  const needle = normalizeComparable(text);
  if (!needle) return true;
  return (zones || [])
    .flatMap((zone) => zone.elements || [])
    .some((element) => String(element.type || "text").toLowerCase() === "text" && normalizeComparable(element.content).includes(needle));
}

function normalizeComparable(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

function applyColorPriority({ palette, instructionPolicy, specifiedRules }) {
  const next = { ...SAFE_BANNER_PALETTE, ...(palette || {}) };
  const regulationText = (Array.isArray(specifiedRules) ? specifiedRules : [])
    .filter((rule) => /color|colour|カラー|配色|色/i.test(`${rule?.ruleType || ""} ${rule?.description || ""} ${rule?.pattern || ""}`))
    .map((rule) => `${rule?.ruleType || ""} ${rule?.description || ""} ${rule?.pattern || ""}`)
    .join("\n");
  Object.assign(next, extractPaletteOverride(regulationText));
  if ((instructionPolicy?.explicitOverrides || []).some((item) => item?.field === "color")) {
    Object.assign(next, extractPaletteOverride(instructionPolicy.rawInstruction));
  }
  return next;
}

function extractPaletteOverride(value) {
  const text = String(value || "");
  if (!text) return {};
  const color = (text.match(/#[0-9a-f]{6}\b/i) || [])[0] || namedColorHex(text);
  if (!color) return {};
  if (/背景|background/i.test(text)) return { background: color };
  if (/サブ|補助|secondary|sub/i.test(text)) return { sub: color };
  if (/メイン|基調|primary|main/i.test(text)) return { main: color };
  if (/アクセント|cta|ボタン|accent/i.test(text)) return { accent: color };
  return { main: color };
}

function namedColorHex(value) {
  const colors = [
    [/赤|red/i, "#DC2626"],
    [/青|blue/i, "#2563EB"],
    [/緑|green/i, "#16A34A"],
    [/黄|yellow/i, "#EAB308"],
    [/オレンジ|orange/i, "#F97316"],
    [/ピンク|pink/i, "#EC4899"],
    [/紫|purple/i, "#7C3AED"],
    [/黒|black/i, "#111827"],
    [/白|white/i, "#FFFFFF"]
  ];
  return colors.find(([pattern]) => pattern.test(value))?.[1] || "";
}

function resolveColorDecision({ rawColorScheme, palette, instructionPolicy, specifiedRules }) {
  const overrides = Array.isArray(instructionPolicy?.explicitOverrides) ? instructionPolicy.explicitOverrides : [];
  const hasUserColor = overrides.some((item) => item?.field === "color");
  const colorRules = (Array.isArray(specifiedRules) ? specifiedRules : []).filter((rule) => /color|colour|カラー|配色|色/i.test(`${rule?.ruleType || ""} ${rule?.pattern || ""} ${rule?.description || ""}`));
  const hasModelPalette = rawColorScheme && typeof rawColorScheme === "object"
    && [rawColorScheme.main, rawColorScheme.sub, rawColorScheme.accent, rawColorScheme.background].some((item) => String(item || "").trim());
  const source = hasUserColor
    ? "user_instruction"
    : (colorRules.length ? "regulation" : (hasModelPalette ? "who_what_inference" : "safe_default"));
  return {
    source,
    palette,
    reason: source === "user_instruction"
      ? "明示的な追加指示を最優先した配色"
      : (source === "regulation"
        ? "表現レギュレーションまたは正式ブランド指定を反映した配色"
        : (source === "who_what_inference" ? "選択WHO-WHATとの相性から推論した配色" : "指定不足時の安全な標準配色")),
    ignoredTemplatePalette: true
  };
}

function colorForElement(element, palette) {
  if (String(element?.type || "").toLowerCase() !== "text") return "";
  const role = `${element?.role || ""} ${element?.messageRole || ""}`.toLowerCase();
  if (/cta|offer|badge|action|オファー|特典|ボタン/.test(role)) return palette.accent;
  return palette.main;
}

function summarizeTemplateForPrompt(template) {
  if (!template || typeof template !== "object") return null;
  const layoutBlueprint = sanitizeTemplateLayout(template.layoutBlueprint || template.templatePromptJson?.layoutBlueprint);
  const hasClosedTemplateZones = Array.isArray(template.templateZones) && template.templateZones.length > 0;
  return {
    id: template.id || "",
    creativeType: template.creativeType || "",
    layoutBlueprint: layoutBlueprint && hasClosedTemplateZones ? { ...layoutBlueprint, zones: [] } : layoutBlueprint,
    templateGlobalDesign: sanitizeTemplateDesign(template.templateGlobalDesign),
    templateZones: sanitizeTemplateZonesForDesign(template.templateZones)
  };
}

function summarizeBannerForPrompt(banner = {}) {
  return {
    id: banner.id || "",
    imageSize: banner.imageSize || "1080x1080",
    additionalInstruction: banner.additionalInstruction || "",
    revisionInstruction: banner.revisionInstruction || "",
    referenceImageUrl: banner.referenceImageUrl || "",
    productImagePaths: Array.isArray(banner.productImagePaths) ? banner.productImagePaths : [],
    logoImagePaths: Array.isArray(banner.logoImagePaths) ? banner.logoImagePaths : [],
    otherImagePaths: Array.isArray(banner.otherImagePaths) ? banner.otherImagePaths : []
  };
}

function summarizeProductIdentity(product = {}) {
  return {
    id: product.id || "",
    name: product.name || "",
    brandName: product.brandName || "",
    companyName: product.companyName || "",
    brandTone: product.brandTone || ""
  };
}

function sanitizeTemplateDesign(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    style: value.style || "",
    fontPolicy: value.fontPolicy || null,
    spacingPolicy: value.spacingPolicy || null,
    contrastPolicy: value.contrastPolicy || null,
    visualStyle: value.visualStyle || null,
    gridAlignment: value.gridAlignment || null
  };
}

function sanitizeTemplateZonesForDesign(zones) {
  return (Array.isArray(zones) ? zones : []).map((zone, zoneIndex) => ({
    position: zone?.position || "",
    purpose: zone?.purpose || "",
    elements: (Array.isArray(zone?.elements) ? zone.elements : []).map((element, elementIndex) => ({
      type: element?.type || "",
      slotId: element?.slotId || `z${zoneIndex + 1}e${elementIndex + 1}`,
      role: element?.role || "",
      messageRole: element?.messageRole || "",
      ...(String(element?.type || "").toLowerCase() === "shape"
        ? { structuralContent: element?.description || element?.content || "" }
        : {}),
      position: element?.position || {},
      size: element?.size || "",
      effect: element?.effect || "",
      charCount: element?.charCount || element?.characterCount || ""
    }))
  }));
}

function sanitizeTemplateLayout(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    visualHierarchy: normalizeList(value.visualHierarchy),
    eyeFlow: String(value.eyeFlow || ""),
    spacingPolicy: value.spacingPolicy && typeof value.spacingPolicy === "object" ? value.spacingPolicy : null,
    grid: value.grid && typeof value.grid === "object" ? value.grid : null,
    zones: sanitizeTemplateZonesForDesign(value.zones)
  };
}

function summarizeCopySlotPlanForPrompt(value) {
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
      order: Number(slot?.order) || 0
    })),
    semanticGroups: (Array.isArray(source.semanticGroups) ? source.semanticGroups : []).map((group) => ({
      groupId: String(group?.groupId || ""),
      slotIds: normalizeList(group?.slotIds),
      semanticRole: String(group?.semanticRole || ""),
      readingOrder: Number(group?.readingOrder) || 0,
      joinMode: String(group?.joinMode || ""),
      required: group?.required !== false,
      groupCharBudget: Number(group?.groupCharBudget) || 0,
      maxSemanticUnits: Number(group?.maxSemanticUnits) || 1
    }))
  };
}

function stripTemplateDisplayMetadataFromContract(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const templateHow = source.templateHow && typeof source.templateHow === "object" && !Array.isArray(source.templateHow)
    ? source.templateHow
    : {};
  const { templateName: _templateName, templateTitle: _templateTitle, templateLabel: _templateLabel, title: _title, name: _name, label: _label, ...safeTemplateHow } = templateHow;
  return {
    ...source,
    templateHow: safeTemplateHow
  };
}

function buildReferenceImageInstruction(banner, templateStructureContract = null, selectedAssetPolicy = buildSelectedAssetOverridePolicy(banner)) {
  const productImageCount = banner.productImagePaths?.length || (banner.productImagePath ? 1 : 0);
  const logoImageCount = banner.logoImagePaths?.length || (banner.logoImagePath ? 1 : 0);
  const otherImageCount = banner.otherImagePaths?.length || (banner.otherImagePath ? 1 : 0);
  const hasProductImage = productImageCount > 0;
  const hasLogoImage = logoImageCount > 0;
  const hasOtherImage = otherImageCount > 0;
  if (!hasProductImage && !hasLogoImage && !hasOtherImage) {
    if (templateStructureContract?.closed && Number(templateStructureContract?.typeCounts?.image || 0) === 0) {
      return "参照画像なし。閉じたテンプレ構造に画像枠がないため、ロゴ・写真・イラスト・人物・端末・図解を追加しない。";
    }
    if (templateStructureContract?.closed) {
      return "参照画像なし。画像表現はテンプレ構造にある既存image枠の内側だけで作成し、画像枠を追加しない。";
    }
    return "参照画像が添付されている場合は素材として優先反映し、テンプレの構造だけを活用する。コピーや固有商材は流用しない。";
  }
  const lines = [];
  let index = 0;
  if (hasLogoImage) { lines.push(`先頭から${logoImageCount}枚は必ず表示する正式なブランドロゴ。元画像のピクセル、文字、色、縦横比を改変・再描画せず、他の文字で代替せず、視認性の高い位置に配置する。`); index += logoImageCount; }
  if (hasProductImage) { lines.push(`${index ? "続く" : "先頭から"}${productImageCount}枚は実際の商品写真。パッケージの形状・ラベル・ロゴ表記を忠実に維持して主要被写体として配置する。`); index += productImageCount; }
  if (hasOtherImage) { lines.push(`${index ? "続く" : "先頭から"}${otherImageCount}枚はその他の選択素材(人物・背景・使用シーン等)。完成画像へ必ず反映する。`); }
  return [
    ...lines,
    templateStructureContract?.closed && selectedAssetPolicy.enabled
      ? "これらのユーザー選択素材だけは閉じたテンプレ構造の唯一の例外。対応画像枠がなくても、基本構造を崩さない最小限の位置へすべて配置する。選択されていない素材は追加しない。"
      : ""
  ].filter(Boolean).join("\n");
}

function buildStructureSheet(layout, zones) {
  if (layout?.zones?.length) {
    return {
      source: "layoutBlueprint",
      summary: layout.zones.map((zone, index) => `Zone ${index + 1}: ${typeof zone.position === "string" ? zone.position : JSON.stringify(zone.position || {})} / ${zone.purpose || ""}`).join("\n")
    };
  }
  return {
    source: "generated",
    summary: zones.map((zone) => `${zone.name}: ${zone.position} / ${zone.purpose}`).join("\n")
  };
}

function normalizeReviewChecklist(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  return {
    structure: ["ゾーン数・役割がテンプレ/設計に沿っている", "視線誘導が明確"],
    originality: ["テンプレ文言をそのまま使っていない", "被写体と配色は商品独自"],
    strategy: ["WHO-WHATのターゲットに刺さる", "オファーとCTAが一致している"],
    copyIntegrity: ["copyBriefの文言を改変していない", "mainHookが主要テキストに入っている"]
  };
}

function buildPromptText(promptJson) {
  return [
    `Create a Japanese direct-response ad banner (${promptJson.basic?.aspectRatio || "1:1"}, ${promptJson.basic?.size || "1024x1024"}).`,
    `Product: ${promptJson.productName || ""}`,
    `Strategy name: ${promptJson.strategyName || ""}`,
    `Target: ${promptJson.target || ""}`,
    `Benefit: ${promptJson.benefit || ""}`,
    `Offer: ${promptJson.offer || ""}`,
    "Image text, exact:",
    promptJson.imageText || "",
    `Copy brief: ${JSON.stringify(promptJson.copyBrief || {})}`,
    `Global design: ${JSON.stringify(promptJson.globalDesign || {})}`,
    `Color scheme: ${JSON.stringify(promptJson.colorScheme || {})}`,
    "Zones:",
    ...((promptJson.zones || []).map((zone) => `${zone.name} (${zone.position}): ${zone.purpose}; elements=${JSON.stringify(zone.elements || [])}`)),
    `Reference image instruction: ${promptJson.referenceImage?.instruction || ""}`,
    promptJson.selectedAssetPolicy?.enabled ? `Selected asset policy: ${JSON.stringify(promptJson.selectedAssetPolicy)}` : "",
    `Negative rules: ${(promptJson.negativeRules || []).join(", ")}`
  ].filter(Boolean).join("\n");
}

export function classifyExpressionRules(expressionRules, product, instructionPolicy = null) {
  const scoped = (expressionRules || []).filter((item) => item.active !== false && (!product.id || !item.productId || item.productId === product.id));
  const ngRules = [];
  const specifiedRules = [];
  const overriddenRules = [];
  for (const rule of scoped) {
    if (ruleIsExplicitlyOverridden(rule, instructionPolicy || {})) {
      overriddenRules.push(rule);
      continue;
    }
    const type = String(rule.ruleType || "").toLowerCase();
    const haystack = `${type} ${rule.pattern || ""} ${rule.description || ""}`.toLowerCase();
    if (haystack.includes("ng") || haystack.includes("禁止") || haystack.includes("avoid")) ngRules.push(rule);
    else specifiedRules.push(rule);
  }
  return { ngRules, specifiedRules, overriddenRules };
}

export function applyRegulationRules(proposal, ngRules, instructionPolicy = null) {
  const hits = [];
  let next = structuredCloneSafe(proposal);
  for (const rule of ngRules || []) {
    if (ruleIsExplicitlyOverridden(rule, instructionPolicy || {})) continue;
    const pattern = String(rule.pattern || "").trim();
    if (!pattern) continue;
    const replacement = String(rule.replacement || "").trim() || createReplacement(pattern);
    const before = JSON.stringify(next);
    next = replaceDeep(next, pattern, replacement);
    if (before !== JSON.stringify(next)) {
      hits.push({ pattern, replacement, severity: rule.severity || "medium", ruleId: rule.id || "" });
    }
  }
  next.regulationCheck = {
    status: hits.length ? "replaced" : ((ngRules || []).length ? "passed" : "no_ng_rules"),
    hits
  };
  if (hits.length) {
    next.reviewNotes = [next.reviewNotes, "表現レギュレーション置換: " + hits.map((hit) => `${hit.pattern} -> ${hit.replacement}`).join(", ")].filter(Boolean).join("\n");
  }
  return next;
}

function replaceDeep(value, pattern, replacement) {
  if (typeof value === "string") return replaceLiteral(value, pattern, replacement);
  if (Array.isArray(value)) return value.map((item) => replaceDeep(item, pattern, replacement));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceDeep(item, pattern, replacement)]));
  }
  return value;
}

function replaceLiteral(value, pattern, replacement) {
  return String(value).replace(new RegExp(escapeRegExp(pattern), "gi"), replacement);
}

function createReplacement(pattern) {
  return `${pattern}に類する断定表現を避けた表現`;
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (!value) return [];
  return [String(value).trim()].filter(Boolean);
}

function clip(value, length) {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  return text.length > length ? text.slice(0, length) + "..." : text;
}

function deriveAspectRatioLabel(size) {
  const match = /^(\d+)x(\d+)$/.exec(String(size || "").trim());
  if (!match) return "1:1";
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return "1:1";
  const divisor = gcd(width, height);
  const reducedWidth = width / divisor;
  const reducedHeight = height / divisor;
  if (reducedWidth <= 20 && reducedHeight <= 20) return `${reducedWidth}:${reducedHeight}`;
  return `${(width / height).toFixed(2)}:1`;
}

function gcd(a, b) {
  return b === 0 ? a : gcd(b, a % b);
}

function uniqueStrings(values) {
  return Array.from(new Set(values.map(String).map((item) => item.trim()).filter(Boolean)));
}

function structuredCloneSafe(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const BANNER_CREATOR_SYSTEM = loadPrompt("banner");
const SAFE_BANNER_PALETTE = Object.freeze({ main: "#1F2937", sub: "#FFFFFF", accent: "#F97316", background: "#F8FAFC" });
