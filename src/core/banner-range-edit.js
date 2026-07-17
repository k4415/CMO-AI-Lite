export const BANNER_EDIT_MAX_SELECTIONS = 5;
export const BANNER_EDIT_MIN_RECT_PX = 8;
export const BANNER_EDIT_MAX_INSTRUCTION_LENGTH = 4000;
export const BANNER_EDIT_CIRCLE_NUMBERS = ["①", "②", "③", "④", "⑤"];

export function selectionDisplayNumber(index) {
  return BANNER_EDIT_CIRCLE_NUMBERS[index] ?? String(index + 1);
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function normalizeDragRect(startPx, endPx, displayWidth, displayHeight) {
  const x1 = clamp(startPx.x, 0, displayWidth);
  const y1 = clamp(startPx.y, 0, displayHeight);
  const x2 = clamp(endPx.x, 0, displayWidth);
  const y2 = clamp(endPx.y, 0, displayHeight);
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);
  if (width < BANNER_EDIT_MIN_RECT_PX || height < BANNER_EDIT_MIN_RECT_PX) return null;
  return {
    x: left / displayWidth,
    y: top / displayHeight,
    width: width / displayWidth,
    height: height / displayHeight
  };
}

export function normalizedRectToDisplayRect(rect, displayWidth, displayHeight) {
  return {
    x: rect.x * displayWidth,
    y: rect.y * displayHeight,
    width: rect.width * displayWidth,
    height: rect.height * displayHeight
  };
}

export function selectionToImagePixels(selection, naturalWidth, naturalHeight) {
  const x1 = Math.floor(selection.x * naturalWidth);
  const y1 = Math.floor(selection.y * naturalHeight);
  const x2 = Math.ceil((selection.x + selection.width) * naturalWidth);
  const y2 = Math.ceil((selection.y + selection.height) * naturalHeight);
  const left = clamp(x1, 0, naturalWidth);
  const top = clamp(y1, 0, naturalHeight);
  const right = clamp(x2, 0, naturalWidth);
  const bottom = clamp(y2, 0, naturalHeight);
  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top)
  };
}

export function computeMaskPixels(selection, naturalWidth, naturalHeight) {
  return computeCompositeMaskPixels([selection], naturalWidth, naturalHeight);
}

export function computeCompositeMaskPixels(selections, naturalWidth, naturalHeight) {
  const data = new Uint8ClampedArray(naturalWidth * naturalHeight * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 0;
    data[i + 1] = 0;
    data[i + 2] = 0;
    data[i + 3] = 255;
  }
  let transparentPixels = 0;
  for (const selection of selections) {
    const rect = selectionToImagePixels(selection, naturalWidth, naturalHeight);
    for (let row = rect.y; row < rect.y + rect.height; row++) {
      for (let col = rect.x; col < rect.x + rect.width; col++) {
        const idx = (row * naturalWidth + col) * 4 + 3;
        if (data[idx] !== 0) {
          data[idx] = 0;
          transparentPixels += 1;
        }
      }
    }
  }
  return { data, width: naturalWidth, height: naturalHeight, transparentPixels };
}

export function rectsOverlap(a, b) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > left && bottom > top;
}

export function findOverlappingSelections(selections) {
  for (let i = 0; i < selections.length; i++) {
    for (let j = i + 1; j < selections.length; j++) {
      if (rectsOverlap(selections[i], selections[j])) {
        return { indexA: i, indexB: j, selectionIdA: selections[i].selectionId, selectionIdB: selections[j].selectionId };
      }
    }
  }
  return null;
}

export function relativePositionLabel(selection) {
  const cx = selection.x + selection.width / 2;
  const cy = selection.y + selection.height / 2;
  const vertical = cy < 1 / 3 ? "上" : cy > 2 / 3 ? "下" : "";
  const horizontal = cx < 1 / 3 ? "左" : cx > 2 / 3 ? "右" : "";
  if (!vertical && !horizontal) return "中央";
  return `${vertical}${horizontal}`;
}

export function percentRangeLabel(selection) {
  const xStart = Math.round(selection.x * 100);
  const xEnd = Math.round((selection.x + selection.width) * 100);
  const yStart = Math.round(selection.y * 100);
  const yEnd = Math.round((selection.y + selection.height) * 100);
  return `x=${xStart}〜${xEnd}%, y=${yStart}〜${yEnd}%`;
}

export function buildCompositeEditInstruction(selections) {
  const lines = [
    "以下の指定範囲を、この1回の編集ですべて修正してください。",
    "各指示は対応する範囲だけへ適用し、別の範囲へ混ぜないでください。",
    ""
  ];
  selections.forEach((selection, index) => {
    const number = selectionDisplayNumber(index);
    lines.push(`【範囲${number}】${relativePositionLabel(selection)}（${percentRangeLabel(selection)}）`);
    lines.push(`指示: ${String(selection.instruction || "").trim()}`);
    lines.push("");
  });
  lines.push(
    "共通保持条件:",
    "- 範囲外のレイアウト、背景、色、ロゴ、人物、商品、文字を変更しない。",
    "- 指示されていない文字を追加・削除・言い換えしない。",
    "- 日本語を正確に読みやすく表示する。"
  );
  return lines.join("\n").slice(0, BANNER_EDIT_MAX_INSTRUCTION_LENGTH);
}

export function buildEditRegionsPayload(selections) {
  return selections.map((selection, index) => ({
    number: index + 1,
    selectionId: selection.selectionId,
    x: selection.x,
    y: selection.y,
    width: selection.width,
    height: selection.height,
    instruction: String(selection.instruction || "").trim()
  }));
}

export function normalizeEditRegionsFromBody(regionsInput) {
  if (!Array.isArray(regionsInput)) return [];
  return regionsInput.map((item, index) => ({
    selectionId: String(item.selectionId || item.id || `region-${index + 1}`),
    number: Number(item.number) || index + 1,
    x: Number(item.x),
    y: Number(item.y),
    width: Number(item.width),
    height: Number(item.height),
    instruction: String(item.instruction || "").trim()
  }));
}

export function validateEditRegions(regions) {
  if (!regions.length || regions.length > BANNER_EDIT_MAX_SELECTIONS) return { ok: false, reason: "count" };
  for (let i = 0; i < regions.length; i++) {
    const region = regions[i];
    if (region.number !== i + 1) return { ok: false, reason: "number" };
    if (!Number.isFinite(region.x) || !Number.isFinite(region.y) || !Number.isFinite(region.width) || !Number.isFinite(region.height)) {
      return { ok: false, reason: "coords" };
    }
    if (region.width <= 0 || region.height <= 0 || region.x < 0 || region.y < 0 || region.x + region.width > 1.000001 || region.y + region.height > 1.000001) {
      return { ok: false, reason: "coords" };
    }
    if (!region.instruction) return { ok: false, reason: "instruction" };
    if (region.instruction.length > BANNER_EDIT_MAX_INSTRUCTION_LENGTH) return { ok: false, reason: "instruction_length" };
  }
  const overlap = findOverlappingSelections(regions);
  if (overlap) return { ok: false, reason: "overlap", overlap };
  return { ok: true };
}

export function canAddSelection(selections) {
  return selections.length < BANNER_EDIT_MAX_SELECTIONS;
}

export function removeSelectionById(selections, selectionId) {
  return selections.filter((item) => item.selectionId !== selectionId);
}

export function canRunBannerEditState({ selections, running, jobBusy }) {
  if (running) return { ok: false, reason: "running" };
  if (jobBusy) return { ok: false, reason: "job_busy" };
  if (!selections.length) return { ok: false, reason: "no_selections" };
  for (const item of selections) {
    if (!String(item.instruction || "").trim()) return { ok: false, reason: "empty_instruction" };
  }
  const overlap = findOverlappingSelections(selections);
  if (overlap) return { ok: false, reason: "overlap", overlap };
  return { ok: true };
}

export function bannerEditRunButtonLabel({ selections, running, failed }) {
  const count = selections.length;
  if (running) {
    if (count <= 1) return "1箇所を修正中…";
    return `${count}箇所をまとめて修正中…`;
  }
  if (failed) return "もう一度まとめて修正";
  if (count <= 1) return "1箇所を修正";
  return `${count}箇所をまとめて修正`;
}

export function isSelectionEditable(_status, running) {
  return !running;
}

export function isSelectionRemovable(_status, running) {
  return !running;
}

export function overlapErrorMessage(overlap) {
  if (!overlap) return "";
  return `範囲${selectionDisplayNumber(overlap.indexA)}と範囲${selectionDisplayNumber(overlap.indexB)}が重なっています。重ならないように選び直してください。`;
}
