import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getOpenAiKey } from "./settings-store.js";
import { completeBannerImageEdit, completeBannerImageGeneration, failBannerImageGeneration, updateBannerCreative } from "./banner-store.js";
import { recognizeBannerEvidence, recognizeBannerText, verifyCopyIntegrity } from "./banner-ocr.js";
import {
  buildClosedStructureInstruction,
  buildSelectedAssetOverrideInstruction,
  buildSelectedAssetOverridePolicyFromInputImages
} from "./banner-template-structure.js";
import { buildLogoVerificationPlan, resolveLogoIdentity, selectedLogoFallbackElements, verifyLogoIdentity } from "./logo-identity.js";
import { COLOR_FIELDS, normalizePalette } from "./banner-color-decision.js";

// The current guide documents multiple inputs but no numeric maximum. Keep a
// conservative application cap so recovery never creates an unbounded edit request.
const GPT_IMAGE_EDIT_MAX_INPUTS = 16;
const GPT_IMAGE_EDIT_MAX_BYTES_PER_IMAGE = 50 * 1024 * 1024;
const GPT_IMAGE_EDIT_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export async function generateBannerImageWithGptImage2(projectRoot, banner, context = {}) {
  assertBannerImageColorContract(banner);
  const { key } = await getOpenAiKey();
  if (!key) throw new Error("OpenAI APIキーが未設定です。設定画面で保存するか、OPENAI_API_KEYを設定してください。");
  const size = normalizeImageSize(banner.promptJson?.basic?.size || banner.promptJson?.basic?.aspectRatio || "1024x1024");
  const attemptId = String(context.attemptId || "");
  const fetchImpl = typeof context.fetchImpl === "function" ? context.fetchImpl : fetch;
  const ocrReader = typeof context.ocrReader === "function" ? context.ocrReader : readGeneratedImageText;
  const quality = resolveBannerImageQuality(context.quality);
  let inputImages = [];
  try {
    const sourceImages = await loadBannerInputImages(projectRoot, banner);
    await enrichLogoInputIdentity(projectRoot, sourceImages, context.product || {});
    inputImages = sourceImages;
  } catch (error) {
    const requestError = normalizeImageRequestError(error);
    if (attemptId) await failBannerImageGeneration(projectRoot, banner.id, attemptId, requestError.message);
    throw requestError;
  }
  const existingImages = Array.isArray(banner.images) && banner.images.length
    ? banner.images
    : (banner.generatedImagePath ? [banner.generatedImagePath] : []);
  const imageGenerationAudit = {
    version: 1,
    model: "gpt-image-2",
    size,
    quality,
    startedAt: new Date().toISOString(),
    selectedAttempt: null,
    attempts: []
  };
  const logoIdentities = inputImages
    .filter((image) => image.role === "brand-logo")
    .map((image) => image.logoIdentity || resolveLogoIdentity({ inputImage: image, selectedLogoCount: inputImages.filter((item) => item.role === "brand-logo").length }));
  const logoVerificationPlan = buildLogoVerificationPlan(
    banner.promptJson?.templateStructureContract,
    size,
    { selectedLogoCount: logoIdentities.length }
  );
  const logoRegions = logoVerificationPlan.regions;
  let recovery = null;

  for (let generationAttempt = 1; generationAttempt <= 2; generationAttempt += 1) {
    const requestInputImages = recovery?.kind === "logo" ? recovery.inputImages : inputImages;
    const prompt = generationAttempt === 1
      ? buildBannerImagePrompt(banner, inputImages)
      : (recovery?.kind === "logo"
        ? buildBannerLogoRecoveryPrompt(banner, inputImages, recovery.missingLogoOrdinals)
        : buildBannerImageRecoveryPrompt(banner, inputImages));
    const startedAt = new Date();
    let requestId = "";
    let relativePath = "";
    try {
      const res = await requestBannerImage({ key, prompt, size, quality, inputImages: requestInputImages, fetchImpl });
      requestId = String(res.headers?.get?.("x-request-id") || res.headers?.get?.("request-id") || "");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const error = new Error(data.error?.message || "gpt-image-2 image generation failed: " + res.status);
        error.requestId = requestId;
        throw error;
      }
      const saved = await saveGeneratedImage(projectRoot, banner.id, data.data?.[0] || {}, generationAttempt);
      relativePath = saved.relativePath;
      const ocr = await ocrReader(projectRoot, relativePath, generationAttempt, { logoRegions });
      const logoVerification = verifyLogoIdentity({
        identities: logoIdentities,
        verificationPlan: logoVerificationPlan,
        logoRegionTexts: ocr.logoRegionTexts,
        fullImageText: ocr.ocrText,
        ocrError: ocr.ocrError
      });
      const copyIntegrityCheck = verifyCopyIntegrity(banner.imageText, ocr.ocrText, { ocrError: ocr.ocrError });
      const mismatch = classifyImageOutputMismatch(copyIntegrityCheck, logoVerification);
      imageGenerationAudit.attempts.push(buildImageAttemptAudit({
        generationAttempt,
        quality,
        prompt,
        startedAt,
        requestId,
        relativePath,
        copyIntegrityCheck,
        logoVerification,
        outcome: mismatch.shouldRetry ? (mismatch.terminalFailure ? "gross_mismatch" : "logo_mismatch") : "accepted",
        retryDecision: mismatch.retryDecision,
        ...(recovery?.kind === "logo" ? {
          sourceImageHash: recovery.sourceImageHash,
          inputManifestHash: recovery.inputManifestHash
        } : {})
      }));
      if (mismatch.shouldRetry) {
        if (generationAttempt < 2) {
          if (!mismatch.terminalFailure) {
            recovery = await buildLogoRecoveryInputImages(projectRoot, relativePath, saved.generatedImageHash, inputImages, {
              missingLogoOrdinals: mismatch.missingLogoOrdinals
            });
            const validation = validateLogoRecoveryEditRequest(recovery.inputImages);
            if (!validation.ok) {
              imageGenerationAudit.selectedAttempt = generationAttempt;
              imageGenerationAudit.completedAt = new Date().toISOString();
              imageGenerationAudit.attempts.at(-1).retryDecision = "skip_recovery_input_limit";
              const patch = {
                ...normalizeBannerImageCompletionPatch({
                  relativePath,
                  banner,
                  existingImages,
                  strategyCheck: banner.strategyCheck,
                  copyIntegrityCheck,
                  logoVerification,
                  logoRecoveryWarning: validation
                }),
                generatedImageHash: saved.generatedImageHash,
                generatedImageModel: "gpt-image-2",
                generatedImageSize: size,
                imageGenerationAudit
              };
              return attemptId
                ? completeBannerImageGeneration(projectRoot, banner.id, attemptId, patch)
                : updateBannerCreative(projectRoot, banner.id, { ...patch, imageGenerationStatus: "completed" });
            }
          }
          continue;
        }
        if (mismatch.terminalFailure) {
          const error = new Error("生成画像が依頼内容と無関係だったため、短縮プロンプトで再生成しましたが改善しませんでした。");
          error.code = mismatch.code;
          await persistImageGenerationFailure(projectRoot, banner, attemptId, error, imageGenerationAudit);
          error.imageFailurePersisted = true;
          throw error;
        }
      }
      imageGenerationAudit.selectedAttempt = generationAttempt;
      imageGenerationAudit.completedAt = new Date().toISOString();
      const patch = {
        ...normalizeBannerImageCompletionPatch({ relativePath, banner, existingImages, strategyCheck: banner.strategyCheck, copyIntegrityCheck, logoVerification }),
        generatedImageHash: saved.generatedImageHash,
        generatedImageModel: "gpt-image-2",
        generatedImageSize: size,
        imageGenerationAudit
      };
      return attemptId
        ? completeBannerImageGeneration(projectRoot, banner.id, attemptId, patch)
        : updateBannerCreative(projectRoot, banner.id, { ...patch, imageGenerationStatus: "completed" });
    } catch (error) {
      if (error?.imageFailurePersisted) throw error;
      const requestError = normalizeImageRequestError(error);
      if (!imageGenerationAudit.attempts.some((item) => item.attempt === generationAttempt)) {
        imageGenerationAudit.attempts.push(buildImageAttemptAudit({
          generationAttempt,
          quality,
          prompt,
          startedAt,
          requestId: String(error?.requestId || requestId || ""),
          relativePath,
          outcome: "request_failed",
          errorMessage: requestError.message
        }));
      }
      imageGenerationAudit.completedAt = new Date().toISOString();
      await persistImageGenerationFailure(projectRoot, banner, attemptId, requestError, imageGenerationAudit);
      requestError.imageFailurePersisted = true;
      throw requestError;
    }
  }
  throw new Error("画像生成結果を確定できませんでした。");
}

async function requestBannerImage({ key, prompt, size, quality, inputImages, fetchImpl }) {
  if (inputImages.length) {
    return fetchImpl("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { "authorization": "Bearer " + key },
      body: buildBannerImageEditForm({ prompt, size, quality, inputImages }),
      signal: imageRequestSignal()
    });
  }
  return fetchImpl("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { "authorization": "Bearer " + key, "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-image-2", prompt, size, quality, n: 1 }),
    signal: imageRequestSignal()
  });
}

async function saveGeneratedImage(projectRoot, bannerId, image, generationAttempt) {
  await fs.mkdir(path.join(projectRoot, "outputs", "banners", bannerId), { recursive: true });
  if (image.b64_json) {
    const relativePath = `outputs/banners/${bannerId}/gpt-image-2-attempt-${generationAttempt}-${Date.now()}.png`;
    const outputBuffer = Buffer.from(image.b64_json, "base64");
    await fs.writeFile(path.join(projectRoot, relativePath), outputBuffer);
    return { relativePath, generatedImageHash: hashImageOutput(outputBuffer) };
  }
  if (image.url) {
    return { relativePath: image.url, generatedImageHash: hashImageOutput(Buffer.from(image.url)) };
  }
  throw new Error("gpt-image-2のレスポンスに画像データがありませんでした。");
}

function buildImageAttemptAudit({ generationAttempt, quality, prompt, startedAt, requestId = "", relativePath = "", copyIntegrityCheck = null, logoVerification = null, outcome, retryDecision = "", sourceImageHash = "", inputManifestHash = "", errorMessage = "" }) {
  const completedAt = new Date();
  return {
    attempt: generationAttempt,
    quality,
    requestId,
    promptHash: `sha256:${crypto.createHash("sha256").update(prompt).digest("hex")}`,
    promptLength: prompt.length,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
    outcome,
    ...(retryDecision ? { retryDecision } : {}),
    ...(relativePath ? { outputPath: relativePath } : {}),
    ...(copyIntegrityCheck ? {
      copyIntegrityStatus: copyIntegrityCheck.status,
      expectedCopyCount: copyIntegrityCheck.expected?.length || 0,
      missingCopyCount: copyIntegrityCheck.missing?.length || 0
    } : {}),
    ...(logoVerification?.required ? {
      logoVerificationStatus: logoVerification.status,
      expectedLogoCount: logoVerification.expected?.length || 0,
      missingLogoCount: logoVerification.missing?.length || 0,
      logoVerificationItems: Array.isArray(logoVerification.items) ? logoVerification.items : [],
      fullImageWordmarkObserved: logoVerification.fullImageWordmarkObserved === true
    } : {}),
    ...(sourceImageHash ? { sourceImageHash } : {}),
    ...(inputManifestHash ? { inputManifestHash } : {}),
    ...(errorMessage ? { errorMessage } : {})
  };
}

async function persistImageGenerationFailure(projectRoot, banner, attemptId, error, imageGenerationAudit) {
  const patch = { imageGenerationAudit };
  if (attemptId) {
    return failBannerImageGeneration(projectRoot, banner.id, attemptId, error.message, patch);
  }
  return updateBannerCreative(projectRoot, banner.id, {
    ...patch,
    imageGenerationStatus: "failed",
    lastError: error.message,
    lastErrorAt: new Date().toISOString()
  });
}

export function normalizeBannerEditMode(value, hasMask = false) {
  const text = String(value || "").trim();
  if (!text) return hasMask ? "range" : "full";
  if (text === "range" || text === "full") return text;
  throw new Error("editModeはrangeまたはfullを指定してください。");
}

export function buildBannerImageRevisionPrompt({ editMode, instruction }) {
  const cleanedInstruction = String(instruction || "").trim();
  if (editMode === "range") {
    return [
      "マスクで透明(alpha=0)にしたすべての領域を、次の指示どおりに修正してください。マスク外は完全に元のまま維持してください。",
      cleanedInstruction,
      "日本語文字は誤字なく、読みやすく配置してください。"
    ].join("\n\n");
  }
  return [
    "添付した現在のバナー画像を編集元として、次の修正指示を画像全体へ一貫して反映してください。",
    "【ユーザーの修正指示・最優先】\n" + cleanedInstruction,
    [
      "【保持条件】",
      "- ユーザー指示と矛盾しない限り、商品、人物、正式ロゴ、主要コピー、情報構造、画像サイズを維持する。",
      "- 指示されていない情報、文言、数値、ロゴ、商品を勝手に追加・削除・言い換えしない。",
      "- ユーザーが変更を明示した要素は、保持条件よりユーザー指示を優先する。",
      "- 日本語文字は誤字なく読みやすく配置し、文字切れや重なりを避ける。",
      "- 文字は後処理で合成せず、この画像編集の生成時に直接描画する。"
    ].join("\n")
  ].join("\n\n");
}

export function buildBannerImageRevisionForm({ editMode, prompt, size, imageBuffer, imageFileName, imageMime, maskBuffer }) {
  const form = new FormData();
  form.append("model", "gpt-image-2");
  form.append("prompt", prompt);
  form.append("size", size);
  form.append("quality", "medium");
  form.append("n", "1");
  form.append("image[]", new Blob([imageBuffer], { type: imageMime }), imageFileName);
  if (editMode === "range") {
    if (!maskBuffer?.length) throw new Error("マスク画像がありません。");
    form.append("mask", new Blob([maskBuffer], { type: "image/png" }), "mask.png");
  }
  return form;
}

// 現在の生成画像(generatedImagePath)を入力画像として /v1/images/edits へ送り、
// rangeでは複合マスク内だけ、fullではマスクなしで画像全体を1回で修正する。
export async function editBannerImageWithGptImage2(projectRoot, banner, { editMode: editModeInput, maskBuffer, instruction, regions = [], context = {} }) {
  const { key } = await getOpenAiKey();
  if (!key) throw new Error("OpenAI APIキーが未設定です。設定画面で保存するか、OPENAI_API_KEYを設定してください。");
  if (!banner.generatedImagePath) throw new Error("修正対象の生成画像がありません。先に画像生成を行ってください。");
  const editMode = normalizeBannerEditMode(editModeInput, Boolean(maskBuffer?.length));
  if (editMode === "range" && !maskBuffer?.length) throw new Error("マスク画像がありません。");
  const cleanedInstruction = String(instruction || "").trim();
  if (!cleanedInstruction) throw new Error("修正指示を入力してください。");

  const attemptId = String(context.attemptId || "");
  const operationKind = context.operationKind === "edit" ? "edit" : "generate";

  const resolvedRoot = path.resolve(projectRoot);
  const currentImagePath = path.resolve(resolvedRoot, banner.generatedImagePath);
  if (currentImagePath !== resolvedRoot && !currentImagePath.startsWith(resolvedRoot + path.sep)) {
    throw new Error("画像パスが不正です: " + banner.generatedImagePath);
  }

  let res;
  try {
    const currentImageBuffer = await fs.readFile(currentImagePath);
    const size = normalizeImageSize(banner.promptJson?.basic?.size || banner.promptJson?.basic?.aspectRatio || "1024x1024");
    const prompt = buildBannerImageRevisionPrompt({ editMode, instruction: cleanedInstruction });
    const form = buildBannerImageRevisionForm({
      editMode,
      prompt,
      size,
      imageBuffer: currentImageBuffer,
      imageFileName: path.basename(currentImagePath),
      imageMime: mimeFor(currentImagePath),
      maskBuffer
    });
    const fetchImpl = typeof context.fetchImpl === "function" ? context.fetchImpl : fetch;
    res = await fetchImpl("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { "authorization": "Bearer " + key },
      body: form,
      signal: imageRequestSignal()
    });
  } catch (error) {
    throw normalizeImageRequestError(error);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error?.message || "gpt-image-2 image edit failed: " + res.status);
  }
  const image = data.data?.[0] || {};
  const outputDir = path.join(projectRoot, "outputs", "banners", banner.id);
  await fs.mkdir(outputDir, { recursive: true });
  let relativePath = "";
  let generatedImageHash = "";
  if (image.b64_json) {
    relativePath = `outputs/banners/${banner.id}/gpt-image-2-${editMode}-edit-${Date.now()}.png`;
    const outputBuffer = Buffer.from(image.b64_json, "base64");
    generatedImageHash = hashImageOutput(outputBuffer);
    await fs.writeFile(path.join(projectRoot, relativePath), outputBuffer);
  } else if (image.url) {
    relativePath = image.url;
    generatedImageHash = hashImageOutput(Buffer.from(image.url));
  } else {
    throw new Error("gpt-image-2のレスポンスに画像データがありませんでした。");
  }
  const priorVersions = Array.isArray(banner.images) && banner.images.length
    ? banner.images
    : (banner.generatedImagePath ? [banner.generatedImagePath] : []);
  const ocr = await readGeneratedImageText(projectRoot, relativePath);
  const copyIntegrityCheck = verifyCopyIntegrity(banner.imageText, ocr.ocrText, { ocrError: ocr.ocrError });
  const patch = {
    ...normalizeBannerImageCompletionPatch({ relativePath, banner, existingImages: priorVersions, strategyCheck: banner.strategyCheck, copyIntegrityCheck }),
    generatedImageHash,
    generatedImageModel: "gpt-image-2",
    generatedImageSize: normalizeImageSize(banner.promptJson?.basic?.size || banner.promptJson?.basic?.aspectRatio || "1024x1024"),
    lastEditMode: editMode,
    lastEditInstruction: cleanedInstruction,
    lastEditRegionCount: editMode === "range" && Array.isArray(regions) ? regions.length : 0,
    lastEditRegions: editMode === "range" && Array.isArray(regions) ? regions.map(({ number, x, y, width, height, instruction: regionInstruction }) => ({
      number,
      x,
      y,
      width,
      height,
      instruction: regionInstruction
    })) : [],
    lastError: "",
    lastErrorAt: ""
  };
  if (operationKind === "edit" && attemptId) {
    return completeBannerImageEdit(projectRoot, banner.id, attemptId, patch);
  }
  return attemptId
    ? completeBannerImageGeneration(projectRoot, banner.id, attemptId, patch)
    : updateBannerCreative(projectRoot, banner.id, { ...patch, imageGenerationStatus: "completed" });
}

function hashImageOutput(buffer) {
  return `sha256:${crypto.createHash("sha256").update(buffer).digest("hex")}`;
}

function mergeStrategyCheckNotes(existing, strategyCheck) {
  const prior = String(existing || "").replace(/\n*【WHO-WHAT整合チェック】[\s\S]*$/, "").trim();
  const result = strategyCheck.status === "warning" ? strategyCheck.warnings.join("\n") : "選択WHO-WHAT範囲外の数値・条件はありません。";
  return [prior, "【WHO-WHAT整合チェック】\n" + result, strategyCheck.note].filter(Boolean).join("\n\n");
}

function mergeCopyIntegrityNotes(existing, copyIntegrityCheck) {
  const prior = String(existing || "").replace(/\n*【コピー完全性チェック】[\s\S]*$/, "").trim();
  if (!copyIntegrityCheck) return prior;
  const result = copyIntegrityCheck.status === "passed"
    ? "確定コピーとOCR結果が一致しました。"
    : (copyIntegrityCheck.status === "not_verifiable"
      ? "OCRで確認できないため目視確認が必要です。"
      : `不足・相違: ${(copyIntegrityCheck.missing || []).join(" / ")}`);
  return [prior, "【コピー完全性チェック】\n" + result, copyIntegrityCheck.note].filter(Boolean).join("\n\n");
}

function mergeLogoVerificationNotes(existing, logoVerification) {
  const prior = String(existing || "").replace(/\n*【ロゴ同一性チェック】[\s\S]*$/, "").trim();
  if (!logoVerification?.required) return prior;
  const result = logoVerification.status === "verified"
    ? `正式ロゴ表記をロゴ領域で確認しました: ${(logoVerification.expected || []).join(" / ")}`
    : (logoVerification.status === "present_unlocalized"
      ? `正式ワードマーク全文は画像全体で確認できましたが、ロゴ候補領域では位置を確認できないため目視確認が必要です: ${(logoVerification.expected || []).join(" / ")}`
      : (logoVerification.status === "not_verifiable"
      ? `目視確認が必要です: ${logoVerification.note || "ロゴ領域OCRで確認できませんでした。"}`
      : `不足・相違: ${(logoVerification.missing || []).join(" / ")} / ロゴ領域OCR: ${(logoVerification.observed || []).join(" / ") || "文字を検出できませんでした"}`));
  return [prior, "【ロゴ同一性チェック】\n" + result, logoVerification.note].filter(Boolean).join("\n\n");
}

export function normalizeBannerImageCompletionPatch({ relativePath, banner = {}, existingImages = null, strategyCheck = null, copyIntegrityCheck = null, logoVerification = null, logoRecoveryWarning = null } = {}) {
  const priorImages = Array.isArray(existingImages)
    ? existingImages
    : (Array.isArray(banner.images) && banner.images.length ? banner.images : (banner.generatedImagePath ? [banner.generatedImagePath] : []));
  const hasOcrMismatch = copyIntegrityCheck && copyIntegrityCheck.status !== "passed";
  const hasLogoMismatch = Boolean(logoVerification?.required && logoVerification.status !== "verified");
  const warnings = Array.isArray(banner.warnings)
    ? banner.warnings.filter((warning) => !logoVerification || warning?.type !== "logo_mismatch")
    : [];
  if (hasOcrMismatch) {
    const message = copyIntegrityCheck.status === "not_verifiable"
      ? "OCRで確認できないため目視確認が必要です。"
      : `不足・相違: ${(copyIntegrityCheck.missing || []).join(" / ")}`;
    warnings.push({
      type: "ocr_mismatch",
      stage: "image",
      message,
      occurredAt: new Date().toISOString()
    });
  }
  if (hasLogoMismatch) {
    const slotIds = (logoVerification.regions || []).map((region) => region?.slotId).filter(Boolean).join(" / ") || "取得不能";
    const expected = (logoVerification.expected || []).join(" / ") || "未解決";
    const observed = (logoVerification.observed || []).filter(Boolean).join(" / ") || "文字を検出できませんでした";
    const message = logoVerification.status === "present_unlocalized"
      ? `画像全体では正式ロゴ表記「${expected}」を確認しましたが、ロゴ候補領域（${slotIds}）では位置を確認できないため目視確認が必要です。`
      : (logoVerification.status === "not_verifiable"
        ? `正式ロゴ表記「${expected}」を確認できません。対象ロゴ枠: ${slotIds} / ${logoVerification.note || "ロゴ領域OCRで確認できないため目視確認が必要です。"}`
        : `ロゴ枠（${slotIds}）内で正式ロゴ表記「${expected}」を確認できません。検出: ${observed}`);
    warnings.push({
      type: "logo_mismatch",
      code: logoVerification.status === "present_unlocalized"
        ? "LOGO_LOCATION_UNVERIFIED"
        : (logoVerification.items?.some((item) => item.reason === "ocr_absence_unconfirmed") ? "LOGO_PRESENCE_UNVERIFIED" : "LOGO_WORDMARK_MISMATCH"),
      stage: "image",
      message,
      occurredAt: new Date().toISOString()
    });
  }
  if (logoRecoveryWarning && logoRecoveryWarning.ok === false) {
    warnings.push({
      type: "logo_mismatch",
      code: logoRecoveryWarning.code || "LOGO_RECOVERY_INPUT_LIMIT",
      stage: "image",
      message: logoRecoveryWarning.message || "ロゴ修復用の画像入力がAPI制約を超えるため、自動修復を実行せず目視確認待ちにしました。",
      occurredAt: new Date().toISOString()
    });
  }
  return {
    generatedImagePath: relativePath,
    images: [relativePath, ...priorImages.filter((item) => item !== relativePath)],
    productionStatus: hasOcrMismatch || hasLogoMismatch || logoRecoveryWarning ? "completed_with_warnings" : "completed",
    warnings,
    strategyCheck,
    copyIntegrityCheck,
    ...(logoVerification ? { logoVerification } : {}),
    reviewNotes: mergeLogoVerificationNotes(
      mergeCopyIntegrityNotes(
        mergeStrategyCheckNotes(banner.reviewNotes, strategyCheck || { status: "passed", warnings: [], note: "" }),
        copyIntegrityCheck
      ),
      logoVerification
    ),
    provider: "gpt-image-2"
  };
}

export function classifyImageOutputMismatch(copyIntegrityCheck = null, logoVerification = null) {
  const expected = Array.isArray(copyIntegrityCheck?.expected) ? copyIntegrityCheck.expected.filter(Boolean) : [];
  const missing = Array.isArray(copyIntegrityCheck?.missing) ? copyIntegrityCheck.missing.filter(Boolean) : [];
  const actualText = String(copyIntegrityCheck?.actualText || "").trim();
  const allExpectedCopyMissing = expected.length >= 2 && missing.length === expected.length;
  const denseAlternativeContent = actualText.length >= 80 && actualText.split(/\r?\n/).filter((line) => line.trim()).length >= 3;
  const sharedBigramCount = countSharedTextBigrams(expected.join(" "), actualText);
  const grossMismatch = copyIntegrityCheck?.status === "failed"
    && allExpectedCopyMissing
    && denseAlternativeContent
    && sharedBigramCount < 2;
  const logoMismatch = Boolean(logoVerification?.required && logoVerification.status === "missing");
  const shouldRetry = grossMismatch || logoMismatch;
  const missingLogoOrdinals = (Array.isArray(logoVerification?.items) ? logoVerification.items : [])
    .filter((item) => item.mode === "template_slot" && item.status === "missing")
    .map((item) => Number(item.assetOrdinal))
    .filter(Boolean);
  return {
    shouldRetry,
    terminalFailure: grossMismatch,
    code: grossMismatch ? "IMAGE_OUTPUT_UNRELATED" : (logoMismatch ? "LOGO_WORDMARK_MISMATCH" : ""),
    missingLogoOrdinals,
    retryDecision: grossMismatch
      ? "retry_gross_mismatch"
      : (logoMismatch
        ? "retry_template_logo_missing"
        : (logoVerification?.status === "present_unlocalized"
          ? "skip_present_unlocalized"
          : (logoVerification?.status === "not_verifiable" ? "skip_not_verifiable" : "accept"))),
    sharedBigramCount,
    reason: grossMismatch
      ? "確定コピーがすべて欠落し、別内容のテキストが画像全体から検出されました。"
      : (logoMismatch ? "ロゴ領域で正式ワードマークを確認できませんでした。" : "")
  };
}

export async function buildLogoRecoveryInputImages(projectRoot, relativePath, sourceImageHash, selectedInputImages, { missingLogoOrdinals = [] } = {}) {
  const sourceBuffer = await fs.readFile(path.join(projectRoot, relativePath));
  const currentBanner = {
    role: "current-banner",
    path: relativePath,
    ordinal: 0,
    fileName: `00-current-banner-${path.basename(relativePath)}`,
    buffer: sourceBuffer,
    mime: "image/png"
  };
  const inputImages = [currentBanner, ...(Array.isArray(selectedInputImages) ? selectedInputImages : [])];
  const manifest = inputImages.map((image) => ({
    role: String(image.role || ""),
    fileName: String(image.fileName || ""),
    contentHash: hashImageOutput(image.buffer)
  }));
  return {
    kind: "logo",
    inputImages,
    missingLogoOrdinals,
    sourceImageHash,
    inputManifestHash: `sha256:${crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex")}`
  };
}

export function validateLogoRecoveryEditRequest(inputImages, {
  maxInputs = GPT_IMAGE_EDIT_MAX_INPUTS,
  maxBytesPerImage = GPT_IMAGE_EDIT_MAX_BYTES_PER_IMAGE
} = {}) {
  const images = Array.isArray(inputImages) ? inputImages : [];
  if (!images.length || images.length > maxInputs) {
    return {
      ok: false,
      code: "LOGO_RECOVERY_INPUT_LIMIT",
      message: `ロゴ修復用の画像入力${images.length}件が安全上限${maxInputs}件を超えています。選択素材を削除せず、自動修復を停止しました。`
    };
  }
  const invalid = images.find((image) => !GPT_IMAGE_EDIT_MIME_TYPES.has(String(image?.mime || ""))
    || !Buffer.isBuffer(image?.buffer)
    || image.buffer.length <= 0
    || image.buffer.length >= maxBytesPerImage);
  if (invalid) {
    return {
      ok: false,
      code: "LOGO_RECOVERY_INPUT_LIMIT",
      message: "ロゴ修復用の画像形式またはサイズがAPI制約を満たさないため、自動修復を停止しました。"
    };
  }
  return { ok: true, code: "", message: "" };
}

function countSharedTextBigrams(left, right) {
  const toBigrams = (value) => {
    const normalized = String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    const result = new Set();
    for (let index = 0; index < normalized.length - 1; index += 1) result.add(normalized.slice(index, index + 2));
    return result;
  };
  const leftBigrams = toBigrams(left);
  const rightBigrams = toBigrams(right);
  let shared = 0;
  for (const item of leftBigrams) if (rightBigrams.has(item)) shared += 1;
  return shared;
}

function imageRequestSignal() {
  return AbortSignal.timeout(getImageRequestTimeoutMs());
}

export function getImageRequestTimeoutMs(value = process.env.CMOAI_OPENAI_IMAGE_TIMEOUT_MS) {
  const configured = Number(value);
  return Number.isFinite(configured) && configured > 0 ? configured : 10 * 60 * 1000;
}

function normalizeImageRequestError(error) {
  if (error?.name === "AbortError" || error?.name === "TimeoutError") {
    return new Error("gpt-image-2の応答がタイムアウトしました。再生成してください。");
  }
  return error instanceof Error ? error : new Error(String(error || "画像生成に失敗しました。"));
}

async function readGeneratedImageText(projectRoot, relativePath, _generationAttempt = 1, { logoRegions = [] } = {}) {
  if (!relativePath || /^https?:\/\//i.test(relativePath)) {
    return { ocrText: "", logoRegionTexts: [], ocrError: "画像URL形式のためローカルOCRを実行できませんでした" };
  }
  try {
    const evidence = await recognizeBannerEvidence(path.join(projectRoot, relativePath), { regions: logoRegions });
    return { ...evidence, ocrError: "" };
  } catch (error) {
    return { ocrText: "", logoRegionTexts: [], ocrError: error.message || String(error) };
  }
}

export function logoVerificationResult(inputImages, outputText) {
  const identities = (Array.isArray(inputImages) ? inputImages : [])
    .filter((image) => image.role === "brand-logo")
    .map((image) => image.logoIdentity || { officialWordmark: image.logoText || "", source: image.logoText ? "legacy.logoText" : "unresolved" });
  return verifyLogoIdentity({
    identities,
    logoRegionTexts: identities.map((_, index) => ({ slotId: `legacy-${index + 1}`, text: String(outputText || "") }))
  });
}

// gpt-image-2 only accepts real product/logo material via /v1/images/edits (multipart,
// with input image[] parts). When the banner has no productImagePath/logoImagePath, we
// fall back to plain /v1/images/generations (no input images) further up.
export function buildBannerInputImageManifest(banner) {
  // 同じ画像が複数の役割に入っている場合も、先に列挙するロゴの役割を優先する。
  const candidates = [
    ...[...(Array.isArray(banner.logoImagePaths) ? banner.logoImagePaths : []), banner.logoImagePath].filter(Boolean).map((value) => ({ role: "brand-logo", path: value })),
    ...[...(Array.isArray(banner.productImagePaths) ? banner.productImagePaths : []), banner.productImagePath].filter(Boolean).map((value) => ({ role: "product", path: value })),
    ...[...(Array.isArray(banner.otherImagePaths) ? banner.otherImagePaths : []), banner.otherImagePath].filter(Boolean).map((value) => ({ role: "reference", path: value }))
  ];
  const seenPaths = new Set();
  const entries = candidates.filter((entry) => {
    if (seenPaths.has(entry.path)) return false;
    seenPaths.add(entry.path);
    return true;
  });
  return entries.map((entry, index) => ({
    ...entry,
    ordinal: index + 1,
    fileName: `${String(index + 1).padStart(2, "0")}-${entry.role}-${path.basename(entry.path)}`
  }));
}

export async function loadBannerInputImages(projectRoot, banner) {
  const entries = buildBannerInputImageManifest(banner);
  const resolvedRoot = path.resolve(projectRoot);
  const images = [];
  for (const entry of entries) {
    const relativePath = entry.path;
    const target = path.resolve(resolvedRoot, relativePath);
    if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
      throw new Error("画像パスが不正です: " + relativePath);
    }
    const buffer = await fs.readFile(target);
    images.push({ ...entry, buffer, mime: mimeFor(target) });
  }
  return images;
}

async function enrichLogoInputIdentity(projectRoot, inputImages, product) {
  const logoImages = inputImages.filter((item) => item.role === "brand-logo");
  const productImages = Array.isArray(product?.images) ? product.images : [];
  for (const image of logoImages) {
    const asset = productImages.find((item) => String(item?.path || "") === String(image.path || "")) || {};
    let observedInputText = "";
    if (!String(asset.officialWordmark || "").trim() && !String(product?.brandName || product?.name || "").trim()) {
      try {
        observedInputText = await recognizeBannerText(path.join(projectRoot, image.path));
      } catch {}
    }
    image.asset = asset;
    image.logoIdentity = resolveLogoIdentity({
      inputImage: image,
      product,
      selectedLogoCount: logoImages.length,
      observedInputText
    });
    image.logoText = image.logoIdentity.officialWordmark;
  }
}

export function extractLogoWordmark(value) {
  const candidates = String(value || "").toUpperCase().match(/[A-Z0-9][A-Z0-9._-]{2,}/g) || [];
  return candidates.sort((a, b) => b.length - a.length)[0] || "";
}

export function buildBannerImageEditForm({ prompt, size, inputImages, quality = resolveBannerImageQuality() }) {
  const form = new FormData();
  form.append("model", "gpt-image-2");
  form.append("prompt", prompt);
  form.append("size", size);
  form.append("quality", resolveBannerImageQuality(quality));
  form.append("n", "1");
  for (const image of inputImages) {
    form.append("image[]", new Blob([image.buffer], { type: image.mime }), image.fileName);
  }
  return form;
}

export function resolveBannerImageQuality(value = process.env.CMOAI_BANNER_IMAGE_QUALITY) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "medium" ? "medium" : "low";
}

function mimeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "application/octet-stream";
}

export function buildBannerImagePrompt(banner, inputImages = buildBannerInputImageManifest(banner)) {
  assertBannerImageColorContract(banner);
  const json = banner.promptJson || {};
  const basic = json.basic || {};
  const zones = Array.isArray(json.zones) ? json.zones : [];
  const selectedAssetPolicy = buildSelectedAssetOverridePolicyFromInputImages(inputImages);
  const templateStructureInstruction = buildClosedStructureInstruction(json.templateStructureContract, selectedAssetPolicy);
  const hasLogoInput = inputImages.some((image) => image.role === "brand-logo");
  const selectedAssetPlacements = buildSelectedAssetPlacementPlan(zones, inputImages);
  const placementBySlotId = new Map(selectedAssetPlacements.map((placement) => [placement.slotId, placement]));
  const finalLogoInstruction = hasLogoInput
    ? "【最終優先・ロゴ原本】ブランド名を文字で打ち直さず、添付された正式ロゴ画像そのものを欠落・改変・再描画せず表示する。対応する既存logo image枠があれば優先し、ない場合もユーザー選択素材の例外として視線順を壊さない最小限の位置へ必ず表示する。後から別画像を合成する前提にしない。"
    : "";
  const zoneInstructions = zones.map((zone, index) => {
    const textElements = (zone.elements || []).filter((element) => String(element?.type || "text").toLowerCase() === "text");
    const allTextSlotsEmpty = textElements.length > 0 && textElements.every((element) => !String(element?.content || "").trim());
    const elements = (zone.elements || []).map((element) => {
      const selectedLogoSlot = hasLogoInput && isLogoElement(element);
      const emptyTextSlot = String(element?.type || "text").toLowerCase() === "text" && !String(element?.content || "").trim();
      const imageSlotId = String(element?.slotId || "");
      const selectedAssetPlacement = placementBySlotId.get(imageSlotId);
      const isImageSlot = String(element?.type || "").toLowerCase() === "image";
      return [
        `- ${element.type || "element"} / slot: ${imageSlotId || "none"} / role: ${element.role || ""}`,
        element.content && !selectedLogoSlot && !selectedAssetPlacement ? `exact content: ${element.content}` : "",
        emptyTextSlot && !selectedLogoSlot ? "content state: EMPTY; render zero glyphs" : "",
        selectedLogoSlot ? "content policy: use the attached official logo image itself; do not typeset, redraw, recolor, crop, stylize, or replace the brand mark" : "",
        selectedAssetPlacement ? `content policy: use attached image ${selectedAssetPlacement.ordinal} only, once, as the original flat asset; do not redraw or derive it` : "",
        isImageSlot && selectedAssetPlacements.length && !selectedAssetPlacement ? "content policy: do not use or imitate any selected attached asset in this slot" : "",
        element.position ? `position: ${JSON.stringify(element.position)}` : "",
        element.size ? `size: ${element.size}` : "",
        element.font && !selectedLogoSlot ? `font: ${element.font}` : "",
        element.color && !selectedLogoSlot ? `color: ${element.color}` : "",
        element.effect && !selectedLogoSlot ? `effect: ${element.effect}` : "",
        element.targetChars && !selectedLogoSlot ? `target chars: ${element.targetChars}` : "",
        element.sourceReason ? `reason: ${element.sourceReason}` : ""
      ].filter(Boolean).join("; ");
    });
    return [
      `Zone ${index + 1}: ${zone.name || ""}`,
      `Position: ${zone.position || ""}`,
      `Purpose: ${allTextSlotsEmpty ? "reserved whitespace only" : (zone.purpose || "")}`,
      "Elements:",
      ...elements
    ].filter(Boolean).join("\n");
  }).join("\n\n");
  const imageText = removeLogoElementText(banner.imageText || collectZoneText(zones), zones, hasLogoInput);
  return [
    "日本語のダイレクト広告バナーを制作してください。",
    "モデルはgpt-image-2を使用しています。",
    templateStructureInstruction,
    buildAttachedImageInstruction(inputImages, json.templateStructureContract, selectedAssetPlacements),
    "画像内テキストは後処理で合成せず、画像生成時点で自然に配置してください。",
    "ただし日本語は読みやすさを最優先し、文字化け、崩れ、重なり、切れを避けてください。",
    "基本仕様: " + JSON.stringify(basic),
    "商品: " + (json.productName || ""),
    "戦略名: " + (json.strategyName || ""),
    "目的: " + (json.objective || "広告クリック率を高める"),
    "ターゲット: " + (json.target || ""),
    "欲求: " + (json.desire || ""),
    "ベネフィット: " + (json.benefit || ""),
    "オファー: " + (json.offer || ""),
    json.additionalInstruction ? "追加指示（最優先）: " + json.additionalInstruction : "",
    "バナー内テキスト:",
    imageText,
    "構造シート:",
    formatStructureSheet(json.structureSheet),
    "グローバルデザイン:",
    JSON.stringify(json.globalDesign || {}, null, 2),
    "配色設計:",
    JSON.stringify(json.colorScheme || {}, null, 2),
    "ゾーン別レイアウト指示:",
    zoneInstructions,
    "参照画像指示:",
    [json.referenceImage?.instruction, json.referenceImage?.url ? "Reference URL/path: " + json.referenceImage.url : ""].filter(Boolean).join("\n"),
    "禁止事項:",
    normalizeList(json.negativeRules).join("、"),
    "【最終優先・確定コピー】画像内に描く文字は「バナー内テキスト」に列挙した行だけに限定する。空欄text slotを推測で補完しない。テンプレのpurpose・role・見本も文字の根拠にしない。列挙されていない注釈、限定、終了、CTA、商品名を追加しない。",
    "最終品質条件: 余白を確保し、視線誘導を明確にし、CTAを読みやすく目立たせる。効果保証や医療的治療断定は避ける。",
    finalLogoInstruction,
    json.additionalInstruction ? "【追加指示原文・既存要素内で反映】" + json.additionalInstruction : "",
    json.templateStructureContract?.closed ? "【最終優先・構造再確認】追加指示は既存elementの色・書体・余白・内容表現の範囲で反映し、契約にない線・下線・カード・バッジ・画像・装飾を増やさない。" : "",
    buildFinalSelectedAssetInstruction(inputImages, selectedAssetPlacements)
  ].filter(Boolean).join("\n");
}

export function assertBannerImageColorContract(banner = {}) {
  const decision = banner?.colorDecision;
  if (!decision || Number(decision.version) !== 2) return true;
  const promptPalette = normalizePalette(banner?.promptJson?.colorScheme);
  const decisionPalette = normalizePalette(decision.palette);
  if (COLOR_FIELDS.some((field) => promptPalette[field] !== decisionPalette[field])) {
    const error = new Error("画像生成promptのcolorSchemeとcolorDecision.paletteが一致しません。");
    error.code = "PROMPT_COLOR_DECISION_MISMATCH";
    error.restartNode = "prompt";
    error.productionStatus = "failed";
    throw error;
  }
  if (decision.contractReview?.status !== "passed") {
    const error = new Error("画像生成promptのカラー契約が未検証または不合格です。");
    error.code = "PROMPT_COLOR_CONTRACT_VIOLATION";
    error.restartNode = "prompt";
    error.productionStatus = "failed";
    throw error;
  }
  return true;
}

export function buildBannerImageRecoveryPrompt(banner, inputImages = buildBannerInputImageManifest(banner)) {
  const json = banner.promptJson || {};
  const zones = Array.isArray(json.zones) ? json.zones : [];
  const selectedAssetPolicy = buildSelectedAssetOverridePolicyFromInputImages(inputImages);
  const templateStructureInstruction = buildClosedStructureInstruction(json.templateStructureContract, selectedAssetPolicy);
  const hasLogoInput = inputImages.some((image) => image.role === "brand-logo");
  const selectedAssetPlacements = buildSelectedAssetPlacementPlan(zones, inputImages);
  const imageText = removeLogoElementText(banner.imageText || collectZoneText(zones), zones, hasLogoInput);
  const zoneSummary = zones.map((zone, index) => {
    const elements = (zone.elements || []).map((element) => {
      const content = element.content && !(hasLogoInput && isLogoElement(element)) ? `「${element.content}」` : "";
      return `${element.role || element.type || "要素"}${content}`;
    }).filter(Boolean).join("、");
    return `${index + 1}. ${zone.position || zone.name || "指定位置"}: ${zone.purpose || ""}${elements ? ` / ${elements}` : ""}`;
  }).join("\n");
  return [
    "【再生成専用・最優先】以下の商品だけを扱う、日本語のダイレクト広告バナーを1枚制作してください。",
    "教育ポスター、百科事典風の解説図、学習教材、英語主体のインフォグラフィック、雲・脳・物語構造など依頼と無関係なテーマを生成しないでください。",
    templateStructureInstruction,
    buildAttachedImageInstruction(inputImages, json.templateStructureContract, selectedAssetPlacements),
    `商品: ${json.productName || ""}`,
    `対象: ${json.target || ""}`,
    `伝える便益: ${json.benefit || ""}`,
    "画像内に入れる確定コピー（表記を変えず、この順で使用）:",
    imageText,
    `サイズ: ${json.basic?.size || json.basic?.aspectRatio || "1024x1024"}`,
    `デザイン方針: ${compactJson(json.globalDesign, 1200)}`,
    `配色方針: ${compactJson(json.colorScheme, 600)}`,
    "配置:",
    zoneSummary,
    "コピーは画像生成時に直接描画し、読みやすい日本語、明確な視線誘導、十分な余白を確保してください。",
    hasLogoInput
      ? "対応する既存logo image枠があれば優先し、なくてもユーザー選択素材の例外として、添付された正式ロゴ画像を改変・再描画せず必ず表示してください。"
      : ""
  ].filter(Boolean).join("\n");
}

export function buildBannerLogoRecoveryPrompt(banner, selectedInputImages = buildBannerInputImageManifest(banner), missingLogoOrdinals = []) {
  const json = banner.promptJson || {};
  const shiftedInputs = (Array.isArray(selectedInputImages) ? selectedInputImages : []).map((image, index) => ({
    ...image,
    ordinal: index + 2
  }));
  const missingSet = new Set((Array.isArray(missingLogoOrdinals) ? missingLogoOrdinals : []).map(Number));
  const targetWordmarks = shiftedInputs
    .filter((image) => image.role === "brand-logo" && (!missingSet.size || missingSet.has(Number(image.ordinal) - 1)))
    .map(logoWordmarkForInput)
    .filter(Boolean);
  return [
    "【ロゴ特化編集・最優先】1枚目の現在のバナーを編集元として使い、欠落した正式ロゴだけを修復してください。バナー全体を新規制作し直さないでください。",
    `修復対象ロゴordinal: ${(Array.isArray(missingLogoOrdinals) ? missingLogoOrdinals : []).join(" / ") || "指定ロゴ"}`,
    targetWordmarks.length ? `修復対象の正式ワードマーク: ${targetWordmarks.join(" / ")}` : "",
    buildAttachedImageInstruction(shiftedInputs, json.templateStructureContract),
    "ロゴ以外の文字、人物、商品、背景、配色、レイアウト、余白を1枚目のバナーから変更しないでください。",
    "正式ロゴ原本を対応する既存logo image枠へ表示し、文字で打ち直さず、原本の全文・比率・色・シンボル形状を維持してください。",
    "新しい装飾、アイコン、文字、画像を追加しないでください。ロゴと文字を後処理で合成せず、この画像編集の生成時に直接描画してください。",
    `画像内の確定コピーは一文字も変更しない: ${String(banner.imageText || "").replace(/\n/g, " / ")}`
  ].filter(Boolean).join("\n\n");
}

function compactJson(value, maxLength) {
  const text = JSON.stringify(value || {});
  return text.length > maxLength ? text.slice(0, maxLength) + "…" : text;
}

function isLogoElement(element) {
  return /logo|brand/i.test(`${element?.type || ""} ${element?.role || ""}`);
}

function removeLogoElementText(text, zones, enabled) {
  if (!enabled) return text;
  const logoTexts = new Set((zones || [])
    .flatMap((zone) => zone.elements || [])
    .filter(isLogoElement)
    .map((element) => String(element.content || "").trim())
    .filter(Boolean));
  return String(text || "")
    .split(/\r?\n/)
    .filter((line) => !logoTexts.has(line.trim()))
    .join("\n");
}

function buildAttachedImageInstruction(inputImages, templateStructureContract = null, placements = []) {
  if (!inputImages.length) return "";
  const selectedAssetPolicy = buildSelectedAssetOverridePolicyFromInputImages(inputImages);
  const placementByOrdinal = new Map((Array.isArray(placements) ? placements : []).map((placement) => [Number(placement.ordinal), placement]));
  const rows = inputImages.map((image) => {
    const position = `${image.ordinal || inputImages.indexOf(image) + 1}枚目（${image.fileName || path.basename(image.path || "image")}）`;
    const placement = placementByOrdinal.get(Number(image.ordinal || inputImages.indexOf(image) + 1));
    const placementText = placement ? ` placement target: image slot ${placement.slotId} only.` : "";
    if (image.role === "brand-logo") {
      const officialWordmark = logoWordmarkForInput(image);
      const wordmark = officialWordmark ? ` 正式ワードマークは「${officialWordmark}」。検証用の同一性情報として扱い、この綴りを1文字も変更せず、別の語を付加しない。ワードマークを新規に組版せず、添付画像内の原本を使う。` : "";
      return `- ${position}: 正式なブランドロゴ。バナー内に1回だけ、判読できる大きさで必ず表示する。文字・図形・色・縦横比・余白を変更せず、切り抜き・単色化・再描画・類似ロゴへの置換・複製を禁止する。${wordmark}`;
    }
    if (image.role === "product") return `- ${position}: ユーザー選択の商品素材。商品カテゴリや用途を推測しない。添付された原画像全体を平面素材として1回だけ使用し、形状・文字・色・縦横比・余白を維持する。ボトル・箱・容器・立体パッケージへ変換しない。カード化・再描画・複製もしない。${placementText}`;
    return `- ${position}: その他の選択参考素材。人物・背景・使用シーン等の役割と原画像を維持し、再描画・派生・複製せず、完成画像内で1回だけ使用する。${placementText}`;
  });
  const hasLogo = inputImages.some((image) => image.role === "brand-logo");
  const fallbackLogoElements = selectedLogoFallbackElements(
    templateStructureContract,
    inputImages.filter((image) => image.role === "brand-logo").length
  );
  const fallbackLogoInstructions = fallbackLogoElements.map((element) => (
    `- ${element.slotId}: 対応するテンプレlogo枠がない選択ロゴを、top ${element.position.top} / left ${element.position.left} / width 29% / height 12% の検証可能な領域へ配置する。背景とのコントラストを確保し、他要素を増やさない。`
  ));
  const logoWords = inputImages.filter((image) => image.role === "brand-logo").map(logoWordmarkForInput).filter(Boolean);
  return [
    buildSelectedAssetOverrideInstruction(selectedAssetPolicy),
    "【添付画像の役割と必須条件】",
    ...rows,
    ...fallbackLogoInstructions,
    hasLogo
      ? (templateStructureContract?.closed
        ? "最優先条件: 対応する既存logo image枠があれば優先する。枠がない場合も、ユーザー選択素材の例外としてブランドロゴを省略しない。"
        : "最優先条件: ブランドロゴを省略しない。ロゴの忠実な表示が、装飾・他の参考画像より優先される。")
      : "",
    logoWords.length ? `正式ワードマーク: ${logoWords.join(" / ")}。商品カテゴリへの置換・追記は禁止。正式ワードマーク自体に「FC」が含まれない場合、ロゴ名の末尾へ「FC」を絶対に追加しない。` : ""
  ].filter(Boolean).join("\n");
}

function buildFinalSelectedAssetInstruction(inputImages, placements = []) {
  if (!Array.isArray(inputImages) || !inputImages.length) return "";
  const targets = (Array.isArray(placements) ? placements : []).map((placement) => (
    `attached image ${placement.ordinal} -> image slot ${placement.slotId} only`
  )).join("; ");
  return [
    "【最終優先・全選択素材原本】添付された各素材は、それぞれ原画像全体を平面のまま完成画像内で1回だけ使う。素材を商品のボトル・箱・容器・パッケージ・モックアップへ変換しない。同じロゴや商品素材を別位置へ複製せず、素材から派生した類似ロゴ・類似商品も生成しない。",
    targets ? `Exclusive placement map: ${targets}. All other image slots must not contain, imitate, or derive these attached assets.` : ""
  ].filter(Boolean).join("\n");
}

export function buildSelectedAssetPlacementPlan(zones, inputImages) {
  const assignableAssets = (Array.isArray(inputImages) ? inputImages : [])
    .filter((image) => image?.role === "product" || image?.role === "reference");
  const imageSlots = (Array.isArray(zones) ? zones : [])
    .flatMap((zone) => Array.isArray(zone?.elements) ? zone.elements : [])
    .filter((element) => String(element?.type || "").toLowerCase() === "image" && !isLogoElement(element));
  const preferredSlots = [...imageSlots].reverse();
  return assignableAssets.map((image, index) => {
    const target = preferredSlots[index] || null;
    return {
      ordinal: Number(image?.ordinal || index + 1),
      role: String(image?.role || "reference"),
      slotId: String(target?.slotId || `selected-${image?.role || "asset"}-fallback-${index + 1}`),
      fallback: !target
    };
  });
}

function logoWordmarkForInput(image) {
  return String(image?.logoIdentity?.officialWordmark || image?.logoText || "").trim();
}

function normalizeImageSize(value) {
  const text = String(value || "").trim();
  if (/^\d+x\d+$/.test(text)) {
    const [w, h] = text.split("x").map(Number);
    const snap = (n) => Math.max(256, Math.round(n / 16) * 16);
    return snap(w) + "x" + snap(h);
  }
  if (text === "4:5") return "1024x1536";
  if (text === "3:4") return "1024x1536";
  if (text === "16:9") return "1536x1024";
  if (text === "9:16") return "1024x1536";
  return "1024x1024";
}

function collectZoneText(zones) {
  return (zones || [])
    .flatMap((zone) => zone.elements || [])
    .filter((element) => String(element.type || "text") === "text" && element.content)
    .map((element) => element.content)
    .join("\n");
}

function formatStructureSheet(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (!value) return [];
  return [String(value)];
}
