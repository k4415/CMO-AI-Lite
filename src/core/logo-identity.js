const LOGO_ROLE_PATTERN = /logo|brand|ロゴ|ブランド/i;
const REGION_PADDING_PERCENT = 2;
const TEMPLATE_LOGO_OCR_MISMATCH_CONFIDENCE_MIN = 75;

export function normalizeLogoWordmark(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

export function resolveLogoIdentity({ inputImage = {}, product = {}, selectedLogoCount = 0, observedInputText = "" } = {}) {
  const asset = inputImage.asset && typeof inputImage.asset === "object" ? inputImage.asset : {};
  const assetWordmark = cleanWordmark(asset.officialWordmark);
  const brandName = cleanWordmark(product.brandName);
  const productName = cleanWordmark(product.name);
  let officialWordmark = "";
  let source = "unresolved";

  if (assetWordmark) {
    officialWordmark = assetWordmark;
    source = "asset_metadata";
  } else if (Number(selectedLogoCount) === 1 && brandName) {
    officialWordmark = brandName;
    source = "product_brand_name";
  } else if (Number(selectedLogoCount) === 1 && productName) {
    officialWordmark = productName;
    source = "single_product_name";
  }

  return {
    assetPath: String(inputImage.path || ""),
    assetId: String(asset.id || ""),
    officialWordmark,
    normalizedWordmark: normalizeLogoWordmark(officialWordmark),
    source,
    verifiable: Boolean(officialWordmark),
    observedInputText: String(observedInputText || "").trim()
  };
}

export function verifyLogoIdentity({ identities = [], logoRegionTexts = [], ocrError = "", verificationPlan = null, fullImageText = "", fullOcrText = "" } = {}) {
  if (verificationPlan?.items && Array.isArray(verificationPlan.items)) {
    return verifyLogoIdentityByPlan({
      identities,
      logoRegionTexts,
      ocrError,
      verificationPlan,
      fullImageText: fullImageText || fullOcrText
    });
  }
  const normalizedIdentities = Array.isArray(identities) ? identities : [];
  const required = normalizedIdentities.length > 0;
  const expected = normalizedIdentities.map((identity) => cleanWordmark(identity?.officialWordmark)).filter(Boolean);
  const observed = (Array.isArray(logoRegionTexts) ? logoRegionTexts : []).map((region) => String(region?.text || "").trim());
  const base = { required, expected, missing: [], observed, regions: Array.isArray(logoRegionTexts) ? logoRegionTexts : [] };

  if (!required) return { ...base, status: "not_verifiable", note: "確認対象ロゴなし" };
  if (ocrError) return { ...base, status: "not_verifiable", ocrError: String(ocrError), note: "ロゴ領域OCRを実行できませんでした。" };
  if (expected.length !== normalizedIdentities.length) {
    return { ...base, status: "not_verifiable", note: "正式ロゴ表記を解決できない選択ロゴがあります。" };
  }
  if (observed.length < normalizedIdentities.length) {
    return { ...base, status: "not_verifiable", note: "テンプレートのロゴ領域を取得できませんでした。" };
  }
  if (observed.slice(0, normalizedIdentities.length).some((text) => !text)) {
    return { ...base, status: "not_verifiable", note: "ロゴ領域OCRで文字を検出できませんでした。" };
  }

  const missing = expected.filter((wordmark, index) => {
    const normalizedExpected = normalizeLogoWordmark(wordmark);
    const normalizedObserved = normalizeLogoWordmark(observed[index]);
    return !normalizedObserved.includes(normalizedExpected);
  });
  return {
    ...base,
    status: missing.length ? "missing" : "verified",
    missing,
    note: missing.length ? "ロゴ領域で正式ワードマークを確認できませんでした。" : "ロゴ領域で正式ワードマークを確認しました。"
  };
}

export function buildLogoVerificationPlan(contract, generatedImageSize, { selectedLogoCount = 0 } = {}) {
  const dimensions = parseImageSize(generatedImageSize);
  const count = Math.max(0, Number(selectedLogoCount) || 0);
  if (!dimensions || !count) return { version: 1, regions: [], items: [] };
  const templateLogoElements = contract?.closed ? logoElementsFromContract(contract) : [];
  const templateAssignmentCount = Math.min(count, templateLogoElements.length);
  const overrideCount = Math.max(0, count - templateAssignmentCount);
  const nativeRegions = templateLogoElements.slice(0, templateAssignmentCount)
    .map((element, index) => regionFromElement(element, dimensions, index))
    .filter(Boolean);
  const recommended = overrideCount ? selectedLogoFallbackElements(contract, count) : [];
  const deterministicCandidates = overrideCount ? [
    ...recommended,
    candidateLogoElement("selected-logo-candidate-top-left", 3, 3, 29, 12),
    candidateLogoElement("selected-logo-candidate-top-right", 3, 68, 29, 12),
    candidateLogoElement("selected-logo-candidate-bottom-left", 85, 3, 29, 12),
    candidateLogoElement("selected-logo-candidate-bottom-right", 85, 68, 29, 12),
    candidateLogoElement("selected-logo-candidate-top-edge", 2, 20, 60, 14),
    candidateLogoElement("selected-logo-candidate-bottom-edge", 84, 20, 60, 14)
  ] : [];
  const overrideRegions = deterministicCandidates
    .map((element, index) => regionFromElement(element, dimensions, nativeRegions.length + index))
    .filter(Boolean);
  const regions = dedupeLogoRegions([...nativeRegions, ...overrideRegions]).slice(0, 8);
  const availableRegionIds = new Set(regions.map((region) => region.slotId));
  const overrideRegionIds = overrideRegions.map((region) => region.slotId).filter((slotId) => availableRegionIds.has(slotId));
  const items = Array.from({ length: count }, (_, index) => {
    const nativeRegion = nativeRegions[index];
    return {
      assetOrdinal: index + 1,
      mode: nativeRegion ? "template_slot" : "selected_asset_override",
      regionIds: nativeRegion && availableRegionIds.has(nativeRegion.slotId) ? [nativeRegion.slotId] : overrideRegionIds
    };
  });
  return { version: 1, regions, items };
}

function verifyLogoIdentityByPlan({ identities, logoRegionTexts, ocrError, verificationPlan, fullImageText }) {
  const normalizedIdentities = Array.isArray(identities) ? identities : [];
  const regions = Array.isArray(logoRegionTexts) ? logoRegionTexts : [];
  const regionById = new Map(regions.map((region) => [String(region?.slotId || ""), region]));
  const usedEvidenceRegionIds = new Set();
  const fullNormalized = normalizeLogoWordmark(fullImageText);
  const items = normalizedIdentities.map((identity, index) => {
    const expected = cleanWordmark(identity?.officialWordmark);
    const normalizedExpected = normalizeLogoWordmark(expected);
    const planItem = verificationPlan.items[index] || {
      assetOrdinal: index + 1,
      mode: "selected_asset_override",
      regionIds: []
    };
    const candidateRegions = (Array.isArray(planItem.regionIds) ? planItem.regionIds : [])
      .map((regionId) => regionById.get(String(regionId)))
      .filter(Boolean);
    const evidence = normalizedExpected ? candidateRegions.find((region) => (
      !usedEvidenceRegionIds.has(String(region.slotId || ""))
      && normalizeLogoWordmark(region.text).includes(normalizedExpected)
    )) : null;
    if (evidence) {
      const regionId = String(evidence.slotId || "");
      usedEvidenceRegionIds.add(regionId);
      return logoVerificationItem(planItem, expected, "verified", "region_match", [regionId]);
    }
    if (!expected) return logoVerificationItem(planItem, expected, "not_verifiable", "official_wordmark_unresolved", []);
    if (ocrError) return logoVerificationItem(planItem, expected, "not_verifiable", "ocr_unavailable", []);
    const hasRegionText = candidateRegions.some((region) => String(region?.text || "").trim());
    if (planItem.mode === "template_slot") {
      if (!hasRegionText) return logoVerificationItem(planItem, expected, "not_verifiable", "template_slot_ocr_empty", []);
      const hasConfidentMismatch = candidateRegions.some((region) => {
        if (!String(region?.text || "").trim()) return false;
        const confidence = Number(region?.confidence);
        return !Number.isFinite(confidence) || confidence >= TEMPLATE_LOGO_OCR_MISMATCH_CONFIDENCE_MIN;
      });
      return hasConfidentMismatch
        ? logoVerificationItem(planItem, expected, "missing", "template_slot_mismatch", [])
        : logoVerificationItem(planItem, expected, "not_verifiable", "template_slot_ocr_low_confidence", []);
    }
    if (fullNormalized.includes(normalizedExpected)) {
      return logoVerificationItem(planItem, expected, "present_unlocalized", "full_ocr_only", []);
    }
    return logoVerificationItem(planItem, expected, "not_verifiable", "ocr_absence_unconfirmed", []);
  });
  const expected = normalizedIdentities.map((identity) => cleanWordmark(identity?.officialWordmark)).filter(Boolean);
  const missing = items.filter((item) => item.status === "missing").map((item) => item.expected).filter(Boolean);
  const status = items.some((item) => item.mode === "template_slot" && item.status === "missing")
    ? "missing"
    : (items.some((item) => item.status === "present_unlocalized")
      ? "present_unlocalized"
      : (items.some((item) => item.status === "not_verifiable") ? "not_verifiable" : "verified"));
  const note = status === "verified"
    ? "ロゴ候補領域で正式ワードマークを確認しました。"
    : (status === "missing"
      ? "テンプレートのロゴ領域で正式ワードマークを確認できませんでした。"
      : (status === "present_unlocalized"
        ? "画像全体では正式ワードマークを確認しましたが、ロゴ候補領域では位置を確認できませんでした。"
        : "OCRだけでは選択ロゴの配置を確認できないため目視確認が必要です。"));
  return {
    required: normalizedIdentities.length > 0,
    expected,
    missing,
    observed: regions.map((region) => String(region?.text || "").trim()),
    regions,
    items,
    status,
    note,
    fullImageWordmarkObserved: items.some((item) => item.reason === "full_ocr_only"),
    ...(ocrError ? { ocrError: String(ocrError) } : {})
  };
}

function logoVerificationItem(planItem, expected, status, reason, evidenceRegionIds) {
  return {
    assetOrdinal: Number(planItem?.assetOrdinal) || 0,
    mode: planItem?.mode === "template_slot" ? "template_slot" : "selected_asset_override",
    expected,
    status,
    reason,
    evidenceRegionIds
  };
}

function candidateLogoElement(slotId, top, left, width, height) {
  return {
    slotId,
    type: "image",
    role: "logo",
    position: { top: `${top}%`, left: `${left}%` },
    size: `${width}% width x ${height}% height`
  };
}

function dedupeLogoRegions(regions) {
  const seen = new Set();
  return regions.filter((region) => {
    const rectangle = region?.rectangle || {};
    const key = [rectangle.left, rectangle.top, rectangle.width, rectangle.height].join(":");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function logoRegionsFromContract(contract, generatedImageSize, { selectedLogoCount = 0 } = {}) {
  const dimensions = parseImageSize(generatedImageSize);
  if (!dimensions) return [];
  const templateLogoElements = contract?.closed ? logoElementsFromContract(contract) : [];
  return [...templateLogoElements, ...selectedLogoFallbackElements(contract, selectedLogoCount)]
    .map((element, index) => regionFromElement(element, dimensions, index))
    .filter(Boolean);
}

export function selectedLogoFallbackElements(contract, selectedLogoCount = 0) {
  const existingLogoElements = contract?.closed ? logoElementsFromContract(contract) : [];
  const existingLogoCount = existingLogoElements.length;
  const missingCount = Math.max(0, Number(selectedLogoCount) - existingLogoCount);
  const candidates = [
    { top: 3, left: 68 },
    { top: 85, left: 68 },
    { top: 3, left: 3 },
    { top: 85, left: 3 },
    { top: 43, left: 68 },
    { top: 43, left: 3 }
  ];
  const occupied = existingLogoElements.map(percentBoxFromElement).filter(Boolean);
  return Array.from({ length: missingCount }, (_, offset) => {
    const candidate = candidates.find((item) => !occupied.some((box) => percentBoxesOverlap(box, { ...item, width: 29, height: 12 })))
      || { top: Math.min(85, 3 + offset * 15), left: Math.max(3, 68 - Math.floor(offset / 4) * 32) };
    const element = {
      slotId: `selected-logo-fallback-${existingLogoCount + offset + 1}`,
      type: "image",
      role: "logo",
      messageRole: "selected-logo-override",
      position: { top: `${candidate.top}%`, left: `${candidate.left}%` },
      size: "29% width x 12% height"
    };
    occupied.push({ ...candidate, width: 29, height: 12 });
    return element;
  });
}

function logoElementsFromContract(contract) {
  return (Array.isArray(contract?.zones) ? contract.zones : [])
    .flatMap((zone) => {
      const elements = Array.isArray(zone?.elements) ? zone.elements : [];
      const logoImages = elements.filter((element) => (
        element?.type === "image"
        && LOGO_ROLE_PATTERN.test(`${element?.role || ""} ${element?.messageRole || ""}`)
      ));
      const logoTexts = elements.filter((element) => (
        element?.type === "text"
        && LOGO_ROLE_PATTERN.test(`${element?.role || ""} ${element?.messageRole || ""}`)
      ));
      return logoImages.map((element) => expandLogoElementWithCompanionText(element, logoTexts));
    });
}

function expandLogoElementWithCompanionText(element, logoTexts) {
  const logoBox = percentBoxFromElement(element);
  if (!logoBox) return element;
  const relatedBoxes = (Array.isArray(logoTexts) ? logoTexts : [])
    .map(percentBoxFromElement)
    .filter((box) => box && logoBoxesShareRow(logoBox, box));
  if (!relatedBoxes.length) return element;
  const boxes = [logoBox, ...relatedBoxes];
  const top = Math.min(...boxes.map((box) => box.top));
  const left = Math.min(...boxes.map((box) => box.left));
  const right = Math.max(...boxes.map((box) => box.left + box.width));
  const bottom = Math.max(...boxes.map((box) => box.top + box.height));
  return {
    ...element,
    position: { top: `${top}%`, left: `${left}%` },
    size: `${right - left}% width x ${bottom - top}% height`
  };
}

function logoBoxesShareRow(left, right) {
  const overlap = Math.min(left.top + left.height, right.top + right.height) - Math.max(left.top, right.top);
  if (overlap > 0) return true;
  const gap = Math.max(left.top, right.top) - Math.min(left.top + left.height, right.top + right.height);
  return gap <= Math.max(4, Math.min(left.height, right.height));
}

function percentBoxFromElement(element) {
  const top = percentNumber(element?.position?.top);
  const left = percentNumber(element?.position?.left);
  const sizeParts = String(element?.size || "").match(/-?\d+(?:\.\d+)?\s*%/g) || [];
  const width = percentNumber(sizeParts[0]);
  const height = percentNumber(sizeParts[1]);
  return [top, left, width, height].every(Number.isFinite) && width > 0 && height > 0
    ? { top, left, width, height }
    : null;
}

function percentBoxesOverlap(a, b) {
  return a.left < b.left + b.width
    && a.left + a.width > b.left
    && a.top < b.top + b.height
    && a.top + a.height > b.top;
}

function regionFromElement(element, dimensions, index) {
  const top = percentNumber(element?.position?.top);
  const left = percentNumber(element?.position?.left);
  const sizeParts = String(element?.size || "").match(/-?\d+(?:\.\d+)?\s*%/g) || [];
  const width = percentNumber(sizeParts[0]);
  const height = percentNumber(sizeParts[1]);
  if (![top, left, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;

  const paddedLeft = Math.max(0, left - REGION_PADDING_PERCENT);
  const paddedTop = Math.max(0, top - REGION_PADDING_PERCENT);
  const paddedRight = Math.min(100, left + width + REGION_PADDING_PERCENT);
  const paddedBottom = Math.min(100, top + height + REGION_PADDING_PERCENT);
  const rectangle = {
    left: Math.floor(dimensions.width * paddedLeft / 100),
    top: Math.floor(dimensions.height * paddedTop / 100),
    width: Math.max(1, Math.ceil(dimensions.width * (paddedRight - paddedLeft) / 100)),
    height: Math.max(1, Math.ceil(dimensions.height * (paddedBottom - paddedTop) / 100))
  };
  return { slotId: String(element?.slotId || `logo-${index + 1}`), rectangle };
}

function parseImageSize(value) {
  const match = String(value || "").match(/^(\d+)x(\d+)$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

function percentNumber(value) {
  const match = String(value ?? "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : Number.NaN;
}

function cleanWordmark(value) {
  return String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ");
}
