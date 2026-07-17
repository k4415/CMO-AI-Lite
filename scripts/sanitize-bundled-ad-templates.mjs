import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const appRoot = path.resolve(process.cwd());
const templatesPath = path.join(appRoot, "data", "ad-templates.json");
const imagesDir = path.join(appRoot, "data", "default-ad-template-images");

const removedFields = new Set([
  "adCopyTemplate",
  "sourceText",
  "scriptText",
  "articleTemplateText"
]);

const raw = JSON.parse(await fs.readFile(templatesPath, "utf8"));
if (!Array.isArray(raw)) {
  throw new Error("data/ad-templates.json は配列である必要があります。");
}

const bundled = raw.filter((template) => template.isBundled === true);
const excluded = raw.filter((template) => template.isBundled !== true);

if (bundled.length !== 100) {
  throw new Error(`bundled件数は100件である必要がありますが、${bundled.length}件でした。`);
}

const templates = bundled.map((template) => Object.fromEntries(
  Object.entries(template).filter(([key]) => !removedFields.has(key))
));

if (templates.length !== 100) {
  throw new Error(`出力件数は100件である必要がありますが、${templates.length}件でした。`);
}

const ids = new Set();
const titleNumbers = new Set();
for (const template of templates) {
  if (template.isBundled !== true) {
    throw new Error(`非bundledテンプレが混入しています: ${template.id}`);
  }
  if (template.creativeType !== "banner") {
    throw new Error(`creativeTypeがbannerではありません: ${template.id}`);
  }
  if (ids.has(template.id)) {
    throw new Error(`ID重複: ${template.id}`);
  }
  ids.add(template.id);

  const match = String(template.title || "").match(/NO\.(\d{3})/);
  if (!match) {
    throw new Error(`titleにNO.xxxがありません: ${template.title}`);
  }
  titleNumbers.add(match[1]);
  if (!template.sourceImageFile) {
    throw new Error(`sourceImageFileがありません: ${template.id}`);
  }
  const imagePath = path.join(imagesDir, template.sourceImageFile);
  try {
    await fs.access(imagePath);
  } catch {
    throw new Error(`画像が見つかりません: ${template.sourceImageFile}`);
  }
}

for (let index = 1; index <= 100; index += 1) {
  const no = String(index).padStart(3, "0");
  if (!titleNumbers.has(no)) {
    throw new Error(`NO.${no} が欠番または重複しています。`);
  }
}

await fs.writeFile(templatesPath, `${JSON.stringify(templates, null, 2)}\n`, "utf8");

console.log(`Saved ${templates.length} bundled banner templates to ${path.relative(appRoot, templatesPath)}`);
if (excluded.length) {
  console.log(`Excluded non-bundled template IDs: ${excluded.map((item) => item.id).join(", ")}`);
}
