const TEMPLATE_STRUCTURE_VERSION = 1;
const SELECTED_ASSET_POLICY_VERSION = 1;
const ELEMENT_TYPES = ["text", "image", "shape"];

export function buildTemplateStructureContract(templateZones) {
  const zones = normalizeTemplateZones(templateZones);
  const typeCounts = { text: 0, image: 0, shape: 0 };
  let elementCount = 0;
  for (const zone of zones) {
    for (const element of zone.elements) {
      elementCount += 1;
      typeCounts[element.type] = (typeCounts[element.type] || 0) + 1;
    }
  }
  return {
    version: TEMPLATE_STRUCTURE_VERSION,
    closed: zones.length > 0,
    zoneCount: zones.length,
    elementCount,
    typeCounts,
    zones: zones.map((zone, zoneIndex) => ({
      zoneIndex,
      position: zone.position,
      backgroundColorRole: zone.backgroundColorRole,
      elementCount: zone.elements.length,
      elements: zone.elements.map((element) => ({
        slotId: element.slotId,
        type: element.type,
        role: element.role,
        messageRole: element.messageRole,
        colorRole: element.colorRole,
        position: element.position,
        size: element.size,
        effect: element.effect,
        ...(element.type === "shape" && element.content ? { structuralContent: element.content } : {})
      }))
    }))
  };
}

export function enforceTemplateStructure({ templateZones, generatedZones }) {
  const sourceZones = normalizeTemplateZones(templateZones);
  const modelZones = Array.isArray(generatedZones) ? generatedZones : [];
  const contract = buildTemplateStructureContract(templateZones);
  const violations = [];
  const sourceSlotIds = new Set(sourceZones.flatMap((zone) => zone.elements.map((element) => element.slotId)));
  const generatedBySlotId = new Map();

  modelZones.forEach((zone, zoneIndex) => {
    const elements = Array.isArray(zone?.elements) ? zone.elements : [];
    if (zoneIndex >= sourceZones.length) {
      violations.push({ type: "extra_zone", zoneIndex });
    }
    elements.forEach((element, elementIndex) => {
      const slotId = deterministicSlotId(element, zoneIndex, elementIndex);
      if (!generatedBySlotId.has(slotId)) {
        generatedBySlotId.set(slotId, { element: element || {}, zoneIndex, elementIndex });
      }
      if (!sourceSlotIds.has(slotId)) {
        violations.push({ type: "extra_element", zoneIndex, elementIndex, slotId });
      }
    });
  });

  const zones = sourceZones.map((sourceZone, zoneIndex) => ({
    name: `Zone ${zoneIndex + 1}`,
    position: sourceZone.position,
    purpose: `テンプレのZone ${zoneIndex + 1}構造・視線順・要素役割を維持する`,
    background: String(modelZones[zoneIndex]?.background || ""),
    backgroundColorRole: sourceZone.backgroundColorRole,
    elements: sourceZone.elements.map((sourceElement, elementIndex) => {
      const match = generatedBySlotId.get(sourceElement.slotId);
      if (!match) {
        violations.push({ type: "missing_element", zoneIndex, elementIndex, slotId: sourceElement.slotId });
      } else {
        const generatedType = normalizeElementType(match.element?.type);
        if (generatedType !== sourceElement.type) {
          violations.push({
            type: "type_change",
            zoneIndex,
            elementIndex,
            slotId: sourceElement.slotId,
            expectedType: sourceElement.type,
            actualType: generatedType
          });
        }
        if (match.zoneIndex !== zoneIndex) {
          violations.push({
            type: "zone_move",
            zoneIndex,
            actualZoneIndex: match.zoneIndex,
            elementIndex,
            slotId: sourceElement.slotId
          });
        }
      }
      return projectElement(sourceElement, match?.element);
    })
  }));

  return {
    zones,
    contract,
    violations,
    status: violations.length ? "corrected" : "clean"
  };
}

export function assertTemplateImageCapacity({ templateZones, banner = {} }) {
  void templateZones;
  // ユーザーが明示選択した素材は、画像枠の有無・役割・個数より優先する。
  // 旧呼び出し元との互換性のため関数名は維持し、決定論的な例外ポリシーを返す。
  return buildSelectedAssetOverridePolicy(banner);
}

export function buildSelectedAssetOverridePolicy(banner = {}) {
  return createSelectedAssetOverridePolicy({
    logoPaths: uniqueImagePaths(banner.logoImagePaths, banner.logoImagePath),
    productPaths: uniqueImagePaths(banner.productImagePaths, banner.productImagePath),
    otherPaths: uniqueImagePaths(banner.otherImagePaths, banner.otherImagePath)
  });
}

export function buildSelectedAssetOverridePolicyFromInputImages(inputImages = []) {
  const source = Array.isArray(inputImages) ? inputImages : [];
  return createSelectedAssetOverridePolicy({
    logoPaths: source.filter((image) => image?.role === "brand-logo").map(inputImageIdentity),
    productPaths: source.filter((image) => image?.role === "product").map(inputImageIdentity),
    otherPaths: source.filter((image) => image?.role === "reference").map(inputImageIdentity)
  });
}

export function buildSelectedAssetOverrideInstruction(policy) {
  if (!policy?.enabled) return "";
  return [
    "【最優先・ユーザー選択素材の例外】",
    "以下のユーザー選択素材だけを、閉じたテンプレ構造に対する唯一の例外として扱う。",
    "選択された素材はすべて完成画像に必ず反映し、各素材を完成画像内で1回だけ使用する。対応する既存image枠があれば優先して使う。",
    "各素材は添付された原画像のまま使い、描き直さない。内部の文字・図形・色・縦横比・余白・輪郭を維持し、切り抜き、単色化、立体化、パッケージ化、カード化、モックアップ化をしない。",
    "同じ素材を複製、反復、分割したり、別角度・別形状・類似物・派生ビジュアルとして生成したりしない。",
    "対応枠がない、役割が異なる、または枠数が不足する場合も、選択素材に限って視線順と可読性を壊さない最小限の配置追加・置換を許可する。",
    "選択されていない素材は追加しない。選択されていないロゴ・商品画像・参考素材を追加・生成しない。",
    "選択素材を理由に、別の人物・写真・イラスト・端末・図解・アイコン・カード・バッジ・下線・背景モチーフを増やさない。",
    JSON.stringify(policy.roles, null, 2)
  ].join("\n");
}

export function buildClosedStructureInstruction(contract, selectedAssetPolicy = null) {
  if (!contract?.closed) return "";
  const counts = contract.typeCounts || {};
  const hasSelectedAssetOverride = selectedAssetPolicy?.enabled === true;
  const noImageRule = Number(counts.image || 0) === 0
    ? (hasSelectedAssetOverride
      ? "テンプレ由来の画像要素は0件。別途列挙されたユーザー選択素材だけを例外とし、それ以外のロゴ・写真・イラスト・人物・端末・図解を追加しない。"
      : "画像要素は0件。ロゴ・写真・イラスト・人物・端末・図解を追加しない。")
    : (hasSelectedAssetOverride
      ? `テンプレ由来の画像要素は${Number(counts.image || 0)}件。既存画像枠を優先し、別途列挙されたユーザー選択素材だけは枠の役割・個数を超える例外として扱う。`
      : `画像要素は${Number(counts.image || 0)}件だけ。既存画像枠の外へ画像を追加しない。`);
  return [
    "【最優先・閉じた構造契約】",
    `zoneは${Number(contract.zoneCount || 0)}件、要素は合計${Number(contract.elementCount || 0)}件（text ${Number(counts.text || 0)}件 / image ${Number(counts.image || 0)}件 / shape ${Number(counts.shape || 0)}件）に固定する。`,
    hasSelectedAssetOverride
      ? "この契約に記載されたzone・elementを基本構造とし、別途列挙されたユーザー選択素材だけを唯一の例外とする。それ以外のtext・image・shape・装飾を新規追加しない。既存要素を削除、移動、type変更しない。"
      : "この契約に記載されたzone・elementだけを使い、text・image・shape・装飾を新規追加しない。既存要素を削除、移動、type変更しない。",
    noImageRule,
    "下線、カード、バッジ、接続線、囲み、背景モチーフもshape要素であり、契約にない場合は追加しない。",
    hasSelectedAssetOverride
      ? "視覚的な工夫、visualIntent、追加指示は、既存elementと列挙済み選択素材の範囲内だけで表現する。"
      : "視覚的な工夫、visualIntent、追加指示は、既存elementの枠内でのみ表現する。"
  ].join("\n");
}

function normalizeTemplateZones(templateZones) {
  return (Array.isArray(templateZones) ? templateZones : []).map((zone, zoneIndex) => ({
    position: String(zone?.position || zone?.area || ""),
    purpose: String(zone?.purpose || zone?.role || ""),
    backgroundColorRole: String(zone?.backgroundColorRole || ""),
    elements: (Array.isArray(zone?.elements) ? zone.elements : []).map((element, elementIndex) => ({
      type: normalizeElementType(element?.type),
      slotId: deterministicSlotId(element, zoneIndex, elementIndex),
      role: String(element?.role || element?.name || ""),
      messageRole: String(element?.messageRole || ""),
      colorRole: String(element?.colorRole || ""),
      content: String(element?.type === "shape" ? (element?.description || element?.content || "") : ""),
      position: clonePlainObject(element?.position),
      size: String(element?.size || ""),
      effect: String(element?.effect || ""),
      targetChars: element?.charCount ?? element?.characterCount ?? ""
    }))
  }));
}

function projectElement(source, generated = {}) {
  const type = source.type;
  const generatedContent = String(generated?.content || generated?.description || "");
  const projectedShape = type === "shape" ? projectShapeSurface(source, generatedContent, generated?.effect) : null;
  return {
    type,
    slotId: source.slotId,
    role: source.role,
    messageRole: source.messageRole,
    colorRole: source.colorRole,
    content: type === "shape" ? projectedShape.content : generatedContent,
    position: clonePlainObject(source.position),
    size: source.size,
    font: type === "text" ? String(generated?.font || "") : "",
    color: type === "text" ? String(generated?.color || "") : "",
    effect: type === "shape" ? projectedShape.effect : source.effect,
    targetChars: source.targetChars,
    sourceReason: String(generated?.sourceReason || ""),
    templateReuseLevel: "closed-structure"
  };
}

function projectShapeSurface(source, generatedContent, generatedEffect) {
  const generated = `${generatedContent || ""} ${generatedEffect || ""}`;
  const accent = generated.match(/色は\s*([^\s。;\n]+)/)?.[1]?.trim() || "";
  if (!accent) return { content: source.content, effect: source.effect };
  const stripColor = (value) => String(value || "")
    .replace(/(?:ゴールド|金色|黄色|イエロー|オレンジ|橙色|赤色?|レッド|青色?|ブルー|シアン|水色|緑色?|グリーン|紫色?|パープル|ピンク|桃色|黒色?|ブラック|白色?|ホワイト|グレー|灰色)の?/gi, "")
    .replace(/の{2,}/g, "の")
    .trim();
  return {
    content: `${stripColor(source.content)}。色は${accent}`,
    effect: source.effect ? `${stripColor(source.effect)}。色は${accent}` : ""
  };
}

function deterministicSlotId(element, zoneIndex, elementIndex) {
  return String(element?.slotId || `z${zoneIndex + 1}e${elementIndex + 1}`);
}

function normalizeElementType(value) {
  const type = String(value || "text").toLowerCase();
  return ELEMENT_TYPES.includes(type) ? type : "text";
}

function uniqueImagePaths(values, value) {
  return [...new Set([...(Array.isArray(values) ? values : []), value].filter(Boolean).map(String))];
}

function createSelectedAssetOverridePolicy({ logoPaths = [], productPaths = [], otherPaths = [] }) {
  const roles = {
    logo: selectedAssetRole(logoPaths),
    product: selectedAssetRole(productPaths),
    other: selectedAssetRole(otherPaths)
  };
  const totalCount = roles.logo.count + roles.product.count + roles.other.count;
  return {
    version: SELECTED_ASSET_POLICY_VERSION,
    mode: "selected-assets-override-template",
    enabled: totalCount > 0,
    totalCount,
    unselectedAssetsAllowed: false,
    roles
  };
}

function selectedAssetRole(paths) {
  const uniquePaths = [...new Set((Array.isArray(paths) ? paths : []).filter(Boolean).map(String))];
  return {
    count: uniquePaths.length,
    paths: uniquePaths,
    required: uniquePaths.length > 0
  };
}

function inputImageIdentity(image) {
  return String(image?.path || image?.fileName || "");
}

function clonePlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
}
