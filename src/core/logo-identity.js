const LOGO_ROLE_PATTERN = /logo|brand|ロゴ|ブランド/i;
const REGION_PADDING_PERCENT = 2;

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

export function verifyLogoIdentity({ identities = [], logoRegionTexts = [], ocrError = "" } = {}) {
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
    .flatMap((zone) => Array.isArray(zone?.elements) ? zone.elements : [])
    .filter((element) => element?.type === "image" && LOGO_ROLE_PATTERN.test(`${element?.role || ""} ${element?.messageRole || ""}`));
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
