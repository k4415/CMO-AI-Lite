import { openAiJson } from "./openai-text.js";
import { addExpressionRule } from "./research-store.js";
import { loadPrompt } from "./prompt-files.js";

const REGULATION_IMPORT_SYSTEM = loadPrompt("regulation-import");
const ALLOWED_RULE_TYPES = ["ng_word", "ng_expression", "preferred_expression", "legal_disclaimer", "tone_rule", "image_rule"];
const ALLOWED_SEVERITIES = ["high", "medium", "low"];

// 任意フォーマットの本文(NGワード一覧、社内ガイド、法務メモ、Excel/PDF/Wordの書き出し等。
// 表現レギュレーション以外の内容が混ざっていてもよい)から、AIで表現レギュレーションだけを
// 抽出・構造化して返す(DBには保存しない)。UIのファイル取り込みで編集エディタに反映する用途。
export async function extractRegulationRulesFromText({ text = "" } = {}) {
  const body = String(text || "").trim();
  if (!body) throw new Error("取り込むテキストがありません。");
  const tabularRules = extractTabularRules(body);
  if (tabularRules.length) return { rules: tabularRules, count: tabularRules.length };
  const parsed = await openAiJson({
    system: REGULATION_IMPORT_SYSTEM,
    user: buildRegulationImportPrompt(body)
  });
  const rawRules = Array.isArray(parsed)
    ? parsed
    : (parsed.rules || parsed.items || parsed.expressionRules || parsed.regulations || parsed.data?.rules || []);
  const candidates = normalizeRules(rawRules);
  if (!candidates.length) throw new Error("本文から表現レギュレーションを抽出できませんでした。");
  return { rules: candidates, count: candidates.length };
}

function extractTabularRules(body) {
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const isHeader = (line) => /NG表現|NGワード|禁止表現/.test(line) && /代替表現|言い換え|推奨表現|理由|備考|重要度/.test(line);
  const headerIndexes = lines.map((line, index) => isHeader(line) ? index : -1).filter((index) => index >= 0);
  if (!headerIndexes.length) return [];
  const extracted = [];
  for (const [position, headerIndex] of headerIndexes.entries()) {
    const delimiter = lines[headerIndex].includes("\t") ? "\t" : ",";
    const headers = parseDelimitedLine(lines[headerIndex], delimiter);
    const column = (...names) => headers.findIndex((header) => names.some((name) => header.includes(name)));
    const typeIndex = column("区分", "種別", "タイプ");
    const patternIndex = column("NG表現", "NGワード", "禁止表現");
    const replacementIndex = column("代替表現", "言い換え", "推奨表現");
    const descriptionIndex = column("理由", "備考", "補足", "説明");
    const severityIndex = column("重要度", "重大度", "優先度");
    if (patternIndex < 0) continue;
    const endIndex = headerIndexes[position + 1] || lines.length;
    for (const line of lines.slice(headerIndex + 1, endIndex)) {
      if (line.startsWith("# ")) continue;
      const cells = parseDelimitedLine(line, delimiter);
      const typeText = String(cells[typeIndex] || "");
      const pattern = cells[patternIndex] || "";
      const replacement = cells[replacementIndex] || "";
      const description = cells[descriptionIndex] || "";
      const isInstruction = /指定|注記|画像/.test(typeText) || (!pattern && Boolean(replacement));
      extracted.push({
        ruleType: /ワード/.test(typeText) ? "ng_word" : (isInstruction ? "legal_disclaimer" : "ng_expression"),
        pattern: isInstruction ? "" : pattern,
        replacement: isInstruction ? "" : replacement,
        description: isInstruction ? [replacement, description].filter(Boolean).join(" / ") : description,
        severity: /高|必須|厳守/.test(cells[severityIndex] || "") ? "high" : (/低|任意/.test(cells[severityIndex] || "") ? "low" : "medium")
      });
    }
  }
  return normalizeRules(extracted);
}

function parseDelimitedLine(line, delimiter) {
  const cells = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"' && quoted && line[i + 1] === '"') { value += '"'; i += 1; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (char === delimiter && !quoted) { cells.push(value.trim()); value = ""; continue; }
    value += char;
  }
  cells.push(value.trim());
  return cells;
}

// 上記で抽出したルールを、そのまま表現レギュレーションDBへ一括追加する。
export async function importRegulationsFromText(projectRoot, { productId = "", text = "" } = {}) {
  const { rules: candidates } = await extractRegulationRulesFromText({ text });
  const added = [];
  for (const candidate of candidates) {
    added.push(await addExpressionRule(projectRoot, { ...candidate, productId }));
  }
  return { rules: added, count: added.length };
}

function buildRegulationImportPrompt(body) {
  return [
    "# 実行タスク",
    "以下の本文から、バナー・広告文制作で守るべき表現レギュレーション(NGワード、言い換え案、指定ルール)を抽出してください。",
    "",
    "# 本文",
    body
  ].join("\n");
}

function normalizeRules(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => ({
      ruleType: ALLOWED_RULE_TYPES.includes(String(item.ruleType || "").trim()) ? String(item.ruleType).trim() : "ng_expression",
      pattern: String(item.pattern || "").trim(),
      replacement: String(item.replacement || "").trim(),
      description: String(item.description || "").trim(),
      severity: ALLOWED_SEVERITIES.includes(String(item.severity || "").trim()) ? String(item.severity).trim() : "medium",
      active: true
    }))
    .filter((item) => item.pattern || item.description);
}
