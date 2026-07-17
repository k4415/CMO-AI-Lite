import { readJson, readText, validateProject } from "./project-store.js";
import { getResearchWorkspace } from "./research-store.js";

export async function resolveContext(projectRoot) {
  const validation = await validateProject(projectRoot);
  if (!validation.ok) {
    return {
      ok: false,
      projectRoot,
      validation,
      warnings: validation.missing.map((file) => "必須ファイルがありません: " + file)
    };
  }

  const [project, product, notes, sourceUrls, facts, whoWhat, rules, researchWorkspace] = await Promise.all([
    readJson(projectRoot, "project.json"),
    readText(projectRoot, "inputs/product.md"),
    readText(projectRoot, "inputs/notes.md"),
    readText(projectRoot, "inputs/source-urls.md"),
    readText(projectRoot, "research/facts.md"),
    readText(projectRoot, "strategy/who-what.md"),
    readText(projectRoot, "regulations/expression-rules.md"),
    getResearchWorkspace(projectRoot)
  ]);

  const warnings = [];
  if (!researchWorkspace.products.length && !hasUserContent(product)) warnings.push("商品マスターDBが未登録です。");
  if (!researchWorkspace.facts.length && !hasUserContent(facts)) warnings.push("事実DBが未整理です。");
  if (!hasUserContent(whoWhat)) warnings.push("WHO-WHATが未整理です。");

  return {
    ok: true,
    projectRoot,
    project,
    researchWorkspace,
    documents: { product, notes, sourceUrls, facts, whoWhat, rules },
    warnings
  };
}

function hasUserContent(markdown) {
  return String(markdown || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("status:"))
    .some((line) => !/ここに|未入力|未整理|未作成/.test(line));
}

function hasListItem(markdown) {
  return String(markdown || "").split(/\r?\n/).some((line) => /^-\s+\S/.test(line.trim()));
}
