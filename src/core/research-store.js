import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { readJson, writeJson, pathExists, withFileLock } from "./project-store.js";
import { ensureStrategyData, listStrategies } from "./strategy-store.js";
import { ensureBannerData, listBannerCreatives } from "./banner-store.js";
import { ensureAdTemplateData, listAdTemplates } from "./ad-template-store.js";
import { getChromePath } from "./settings-store.js";
import { analyzeLpScreenshots } from "./lp-vision-ai.js";
import { transcribeMaterialWithAgent } from "./codex-material-agent.js";

const PRODUCTS_PATH = "data/products.json";
const MATERIALS_PATH = "data/research-materials.json";
const FACTS_PATH = "data/facts.json";
const EXPRESSION_RULES_PATH = "data/expression-rules.json";
const EXTRACTION_JOBS_PATH = "data/material-extraction-jobs.json";

export async function ensureResearchData(projectRoot) {
  if (!(await pathExists(path.join(projectRoot, PRODUCTS_PATH)))) await writeJson(projectRoot, PRODUCTS_PATH, []);
  if (!(await pathExists(path.join(projectRoot, MATERIALS_PATH)))) await writeJson(projectRoot, MATERIALS_PATH, []);
  if (!(await pathExists(path.join(projectRoot, FACTS_PATH)))) await writeJson(projectRoot, FACTS_PATH, []);
  if (!(await pathExists(path.join(projectRoot, EXPRESSION_RULES_PATH)))) await writeJson(projectRoot, EXPRESSION_RULES_PATH, []);
  if (!(await pathExists(path.join(projectRoot, EXTRACTION_JOBS_PATH)))) await writeJson(projectRoot, EXTRACTION_JOBS_PATH, []);
  await ensureStrategyData(projectRoot);
  await ensureBannerData(projectRoot);
  await ensureAdTemplateData(projectRoot);
}

export async function getResearchWorkspace(projectRoot) {
  await ensureResearchData(projectRoot);
  const [products, materials, facts, expressionRules, extractionJobs, strategies, banners, adTemplates] = await Promise.all([
    readJson(projectRoot, PRODUCTS_PATH),
    readJson(projectRoot, MATERIALS_PATH),
    readJson(projectRoot, FACTS_PATH),
    readJson(projectRoot, EXPRESSION_RULES_PATH),
    readJson(projectRoot, EXTRACTION_JOBS_PATH),
    listStrategies(projectRoot),
    listBannerCreatives(projectRoot),
    listAdTemplates(projectRoot)
  ]);
  return { products, materials, facts: facts.map((fact) => ({ ...fact, content: stripFactReferenceMarkers(fact.content) })), expressionRules, extractionJobs, strategies, banners, adTemplates };
}

export async function getBannerImageContext(projectRoot, productId = "") {
  if (!(await pathExists(path.join(projectRoot, PRODUCTS_PATH)))) await writeJson(projectRoot, PRODUCTS_PATH, []);
  const products = await readJson(projectRoot, PRODUCTS_PATH);
  const product = products.find((item) => item.id === productId) || {};
  return { product };
}

export async function getBannerGenerationWorkspace(projectRoot) {
  if (!(await pathExists(path.join(projectRoot, PRODUCTS_PATH)))) await writeJson(projectRoot, PRODUCTS_PATH, []);
  if (!(await pathExists(path.join(projectRoot, EXPRESSION_RULES_PATH)))) await writeJson(projectRoot, EXPRESSION_RULES_PATH, []);
  const [products, expressionRules, strategies, banners, adTemplates] = await Promise.all([
    readJson(projectRoot, PRODUCTS_PATH),
    readJson(projectRoot, EXPRESSION_RULES_PATH),
    listStrategies(projectRoot),
    listBannerCreatives(projectRoot),
    listAdTemplates(projectRoot)
  ]);
  return { products, expressionRules, strategies, banners, adTemplates };
}

export async function addProduct(projectRoot, input) {
  await ensureResearchData(projectRoot);
  return withFileLock(path.join(projectRoot, PRODUCTS_PATH), async () => {
    const products = await readJson(projectRoot, PRODUCTS_PATH);
    const now = new Date().toISOString();
    const product = {
      id: createId("prod"),
      name: clean(input.name),
      officialUrl: clean(input.officialUrl),
      shortDescription: clean(input.shortDescription),
      brandColor: clean(input.brandColor),
      brandTone: clean(input.brandTone),
      images: Array.isArray(input.images) ? input.images : [],
      createdAt: now,
      updatedAt: now
    };
    if (!product.name) throw new Error("Product name is required");
    products.unshift(product);
    await writeJson(projectRoot, PRODUCTS_PATH, products);
    return product;
  });
}


export async function updateProduct(projectRoot, productId, patch) {
  await ensureResearchData(projectRoot);
  return updateById(projectRoot, PRODUCTS_PATH, productId, patch, "Row not found");
}

export async function deleteProduct(projectRoot, productId) {
  await ensureResearchData(projectRoot);
  return deleteById(projectRoot, PRODUCTS_PATH, productId, "Row not found");
}

const PRODUCT_IMAGE_ROLES = ["product", "logo", "other"];

export async function addProductImage(projectRoot, productId, { fileName, dataBase64, role, label, officialWordmark } = {}) {
  await ensureResearchData(projectRoot);
  if (!dataBase64) throw new Error("画像データがありません。");

  const imageId = createId("img");
  const safeName = path.basename(String(fileName || "image.png")).replace(/[^a-zA-Z0-9._-]/g, "_") || "image.png";
  const finalName = `${imageId}_${safeName}`;
  const relDir = `assets/products/${productId}`;
  const dir = path.join(projectRoot, ...relDir.split("/"));
  await fs.mkdir(dir, { recursive: true });
  const base64Body = String(dataBase64).replace(/^data:[^;]+;base64,/, "");
  await fs.writeFile(path.join(dir, finalName), Buffer.from(base64Body, "base64"));

  const now = new Date().toISOString();
  const image = {
    id: imageId,
    role: PRODUCT_IMAGE_ROLES.includes(role) ? role : "product",
    path: `${relDir}/${finalName}`,
    label: clean(label),
    officialWordmark: clean(officialWordmark),
    createdAt: now
  };
  return withFileLock(path.join(projectRoot, PRODUCTS_PATH), async () => {
    const products = await readJson(projectRoot, PRODUCTS_PATH);
    const index = products.findIndex((item) => item.id === productId);
    if (index < 0) throw new Error("商品が見つかりません: " + productId);
    const product = products[index];
    product.images = Array.isArray(product.images) ? [image, ...product.images] : [image];
    product.updatedAt = now;
    products[index] = product;
    await writeJson(projectRoot, PRODUCTS_PATH, products);
    return image;
  });
}

export async function removeProductImage(projectRoot, productId, imageId) {
  await ensureResearchData(projectRoot);
  const removed = await withFileLock(path.join(projectRoot, PRODUCTS_PATH), async () => {
    const products = await readJson(projectRoot, PRODUCTS_PATH);
    const index = products.findIndex((item) => item.id === productId);
    if (index < 0) throw new Error("商品が見つかりません: " + productId);
    const product = products[index];
    const images = Array.isArray(product.images) ? product.images : [];
    const imageIndex = images.findIndex((item) => item.id === imageId);
    if (imageIndex < 0) throw new Error("画像が見つかりません: " + imageId);
    const [removedImage] = images.splice(imageIndex, 1);
    product.images = images;
    product.updatedAt = new Date().toISOString();
    products[index] = product;
    await writeJson(projectRoot, PRODUCTS_PATH, products);
    return removedImage;
  });
  if (removed?.path) {
    const projectRootResolved = path.resolve(projectRoot);
    const target = path.resolve(projectRootResolved, removed.path);
    if (target === projectRootResolved || target.startsWith(projectRootResolved + path.sep)) await fs.rm(target, { force: true }).catch(() => null);
  }
  return removed;
}

export async function deleteMaterial(projectRoot, materialId) {
  await ensureResearchData(projectRoot);
  return deleteById(projectRoot, MATERIALS_PATH, materialId, "Row not found");
}

export async function updateFact(projectRoot, factId, patch) {
  await ensureResearchData(projectRoot);
  const updated = await updateById(projectRoot, FACTS_PATH, factId, patch, "Row not found");
  return normalizeFact(updated);
}

export async function deleteFact(projectRoot, factId) {
  await ensureResearchData(projectRoot);
  return deleteById(projectRoot, FACTS_PATH, factId, "Row not found");
}

export async function updateExpressionRule(projectRoot, ruleId, patch) {
  await ensureResearchData(projectRoot);
  return updateById(projectRoot, EXPRESSION_RULES_PATH, ruleId, patch, "Row not found");
}

export async function deleteExpressionRule(projectRoot, ruleId) {
  await ensureResearchData(projectRoot);
  return deleteById(projectRoot, EXPRESSION_RULES_PATH, ruleId, "Row not found");
}

export async function addMaterial(projectRoot, input) {
  await ensureResearchData(projectRoot);
  return withFileLock(path.join(projectRoot, MATERIALS_PATH), async () => {
    const materials = await readJson(projectRoot, MATERIALS_PATH);
    const now = new Date().toISOString();
    const material = {
      id: createId("mat"),
      productId: clean(input.productId),
      type: clean(input.type) || "HP",
      title: clean(input.title) || clean(input.sourceUrl) || "Untitled material",
      sourceUrl: clean(input.sourceUrl),
      manualText: clean(input.manualText),
      extractedText: "",
      screenshotUrl: "",
      screenshotUrls: [],
      screenshotSlices: [],
      screenshotStatus: input.sourceUrl ? "pending" : "not_needed",
      visualAnalysis: "",
      n1Analysis: null,
      n1AnalysisMarkdown: "",
      insightStatus: "not_analyzed",
      extractionStatus: input.manualText ? "manual_text" : (input.sourceUrl ? "pending" : "manual_text"),
      createdAt: now,
      updatedAt: now
    };
    if (!material.sourceUrl && !material.manualText) throw new Error("Source URL or manual text is required");
    materials.unshift(material);
    await writeJson(projectRoot, MATERIALS_PATH, materials);
    return material;
  });
}

export async function extractMaterial(projectRoot, materialId, options = {}) {
  await ensureResearchData(projectRoot);
  const initialMaterials = await readJson(projectRoot, MATERIALS_PATH);
  const initialMaterial = initialMaterials.find((item) => item.id === materialId);
  if (!initialMaterial) throw new Error(`Material not found: ${materialId}`);

  const now = new Date().toISOString();
  const material = { ...initialMaterial, extractionStatus: "extracting", updatedAt: now };
  const job = {
    id: clean(options.jobId) || createId("job"),
    materialId,
    status: "running",
    startedAt: now,
    // progressAt は「最後に進捗があった時刻」のハートビート。UI側はこれを見て、
    // 直近まで進んでいるジョブを『中断(失敗)』と誤判定しないようにする。
    progressAt: now,
    finishedAt: "",
    errorMessage: "",
    steps: []
  };

  // Re-read and merge just this material's row / this job's row against whatever is
  // currently on disk at save time, instead of rewriting a long-held array snapshot.
  // This keeps concurrent extractions on other materials in the same project from
  // clobbering each other's progress (each extraction can take minutes).
  const saveProgress = async () => {
    material.updatedAt = new Date().toISOString();
    // 保存のたびにハートビートを更新(=進捗があった証跡)。
    if (job.status === "running") job.progressAt = material.updatedAt;
    await withFileLock(path.join(projectRoot, MATERIALS_PATH), async () => {
      const currentMaterials = await readJson(projectRoot, MATERIALS_PATH);
      const materialIndex = currentMaterials.findIndex((item) => item.id === materialId);
      if (materialIndex === -1) currentMaterials.push({ ...material });
      else currentMaterials[materialIndex] = { ...currentMaterials[materialIndex], ...material };
      await writeJson(projectRoot, MATERIALS_PATH, currentMaterials);
    });

    await withFileLock(path.join(projectRoot, EXTRACTION_JOBS_PATH), async () => {
      const currentJobs = await readJson(projectRoot, EXTRACTION_JOBS_PATH);
      const jobIndex = currentJobs.findIndex((item) => item.id === job.id);
      if (jobIndex === -1) currentJobs.unshift({ ...job });
      else currentJobs[jobIndex] = { ...job };
      await writeJson(projectRoot, EXTRACTION_JOBS_PATH, currentJobs);
    });
  };
  await saveProgress();

  try {
    let htmlText = material.manualText || "";
    // 「タイトル・メタを除く実質テキスト」の長さ(SPAフォールバック判定と部分成功判定に使う)。
    let htmlBodyLength = material.manualText ? material.manualText.length : 0;
    let htmlMethod = material.manualText ? "manual" : "";
    let textError = "";
    let visualError = "";

    if (material.sourceUrl) {
      try {
        job.steps.push({ label: "HTML本文取得", status: "running", detail: material.sourceUrl });
        await saveProgress();
        const fetched = await fetchReadableText(material.sourceUrl);
        htmlText = fetched.text;
        htmlBodyLength = fetched.bodyLength;
        htmlMethod = "fetch";
        const fetchDetail = [htmlText.length + "文字"];
        if (fetched.retried) fetchDetail.push("1回リトライ");
        if (fetched.charset && fetched.charset !== "utf-8") fetchDetail.push("charset: " + fetched.charset);
        if (fetched.truncated) fetchDetail.push("50,000文字で打ち切り");
        job.steps[job.steps.length - 1] = { label: "HTML本文取得", status: "completed", detail: fetchDetail.join(" / ") };
        await saveProgress();
      } catch (error) {
        textError = error.message;
        job.steps[job.steps.length - 1] = { label: "HTML本文取得", status: "failed", detail: error.message };
        await saveProgress();
      }
    }

    let htmlOutput = material.manualText || htmlText || "";
    let screenshotText = "";
    let transcribedSliceCount = 0;
    let totalSliceCount = 0;
    material.extractedText = material.manualText || "";
    material.visualAnalysis = textError ? "HTML本文取得に失敗しました: " + textError : "";

    if (material.sourceUrl) {
      job.steps.push({ label: "スクリーンショット取得", status: "running", detail: "" });
      await saveProgress();
      const screenshot = await captureLpScreenshots(projectRoot, material).catch((error) => ({
        status: "failed",
        urls: [],
        message: error.message
      }));
      material.screenshotUrls = screenshot.urls || [];
      material.screenshotUrl = material.screenshotUrls[0] || "";
      material.screenshotSlices = screenshot.slices || [];
      material.lpDomEvidence = screenshot.domEvidence || "";
      material.lpImageInventory = screenshot.imageInventory || [];
      material.visionSliceIndexes = screenshot.visionSliceIndexes || [];
      material.screenshotStatus = screenshot.status;
      material.visualAnalysis = [material.visualAnalysis, screenshot.visualAnalysis || screenshot.message || ""].filter(Boolean).join("\n");
      const screenshotDetail = [String((screenshot.urls || []).length) + "枚"];
      if (screenshot.message) screenshotDetail.push(screenshot.message);
      if (screenshot.domFallback) screenshotDetail.push("domcontentloadedへフォールバック");
      job.steps[job.steps.length - 1] = {
        label: "スクリーンショット取得",
        status: screenshot.status,
        detail: screenshotDetail.join(" / ")
      };
      await saveProgress();

      // SPA対応: fetchで取れた本文が薄い(500文字未満)場合、スクショ取得時に得たレンダリング後HTMLから本文を補う。
      if (htmlBodyLength < 500 && screenshot.renderedHtml) {
        const rendered = htmlToLpText(screenshot.renderedHtml, material.sourceUrl);
        if (rendered.bodyLength > htmlBodyLength) {
          job.steps.push({
            label: "本文取得方法の補完",
            status: "completed",
            detail: "レンダリング後HTMLから本文を再取得しました(" + rendered.bodyLength + "文字)"
          });
          htmlText = rendered.text;
          htmlBodyLength = rendered.bodyLength;
          htmlMethod = "rendered_html";
          htmlOutput = material.manualText || htmlText || "";
          material.visualAnalysis = [material.visualAnalysis, "本文取得方法: レンダリング後HTML"].filter(Boolean).join("\n");
          await saveProgress();
        }
      }

      if ((material.screenshotUrls || []).length) {
        const extractor = String(process.env.CMOAI_MATERIAL_EXTRACTOR || "openai").toLowerCase();
        const stepLabel = extractorLabel(extractor);
        const totalShots = (material.screenshotUrls || []).length;
        job.steps.push({ label: stepLabel, status: "running", detail: "0/" + totalShots + "枚" });
        await saveProgress();
        // スライスを1枚処理するたびに進捗(N/M枚)をjob stepに反映し、ハートビートを更新する。
        // これで「実行中」の内訳が見え、かつ止まっていない限り中断扱いにならない。
        const onProgress = ({ processed, total }) => {
          const last = job.steps[job.steps.length - 1];
          if (last && last.status === "running") {
            last.detail = processed + "/" + total + "枚";
          }
          return saveProgress();
        };
        const visual = await transcribeMaterial(projectRoot, material, { htmlText: htmlOutput, extractor, onProgress }).catch((error) => ({ text: "", summary: "", analyses: [], error: error.message }));
        totalSliceCount = visual.totalSlices ?? (material.screenshotUrls || []).length;
        transcribedSliceCount = visual.processedSlices ?? 0;
        if (visual.text) {
          screenshotText = visual.text;
          material.visualAnalysis = [material.visualAnalysis, visual.summary, visual.warning].filter(Boolean).join("\n");
          const visualDetail = [visual.text.length + "文字"];
          if (totalSliceCount && transcribedSliceCount && transcribedSliceCount < totalSliceCount) {
            visualDetail.push("処理 " + transcribedSliceCount + "/" + totalSliceCount + "枚");
          }
          job.steps[job.steps.length - 1] = { label: visual.provider ? extractorLabel(visual.provider) : stepLabel, status: "completed", detail: visualDetail.join(" / ") };
          if (visual.jobRoot) job.codexJobRoot = path.relative(projectRoot, visual.jobRoot).split(path.sep).join("/");
          await saveProgress();
        } else if (visual.error) {
          visualError = visual.error;
          material.visualAnalysis = [material.visualAnalysis, stepLabel + "に失敗しました: " + visual.error].filter(Boolean).join("\n");
          job.steps[job.steps.length - 1] = { label: stepLabel, status: "failed", detail: visual.error };
          await saveProgress();
        } else {
          visualError = "スクリーンショットから文字を抽出できませんでした。";
          job.steps[job.steps.length - 1] = { label: stepLabel, status: "failed", detail: visualError };
          await saveProgress();
        }
      }
    }

    const outputSections = [];
    if (screenshotText) outputSections.push("## AI文字起こしテキスト\n\n" + screenshotText);
    if (htmlOutput) outputSections.push("## HTML本文テキスト\n\n" + htmlOutput);
    material.extractedText = outputSections.join("\n\n---\n\n");
    if (htmlOutput) {
      job.steps.push({
        label: "HTML本文保存",
        status: "completed",
        detail: htmlOutput.length + "文字" + (htmlMethod === "rendered_html" ? " / 方法: レンダリング後HTML" : "")
      });
      await saveProgress();
    }

    // 部分成功の判定: URL資料は本文取得とスクショ文字起こしの両方を試みる。
    // どちらか一方だけ成功した場合は partial_text(本文のみ)/partial_visual(スクショのみ)として区別する。
    // 両方成功=extracted、両方失敗=failed。
    // Chrome/puppeteer未設置による自動スキップ(skipped_missing_dependency)は仕様どおりの縮退動作
    // なので「スクショ失敗」に数えない(本文が取れていれば extracted のまま)。
    const visualRequired = Boolean(material.sourceUrl) && material.screenshotStatus !== "skipped_missing_dependency";
    const textOk = Boolean(htmlOutput);
    const visualOk = Boolean(screenshotText);

    let status;
    let partialReason = "";
    if (textOk && (!visualRequired || visualOk)) {
      status = "extracted";
    } else if (textOk && visualRequired && !visualOk) {
      status = "partial_text";
      const visualFailureReason = visualError || (material.screenshotStatus && material.screenshotStatus !== "captured" ? "スクリーンショットを取得できませんでした（" + material.screenshotStatus + "）" : "詳細不明");
      partialReason = "スクリーンショットの取得または文字起こしに失敗しました: " + visualFailureReason;
    } else if (!textOk && visualOk) {
      status = "partial_visual";
      partialReason = "本文取得に失敗しました: " + (textError || "詳細不明");
    } else {
      status = "failed";
    }

    material.extractionStatus = status;
    material.updatedAt = new Date().toISOString();
    job.status = status === "failed" ? "failed" : "completed";
    job.finishedAt = material.updatedAt;
    job.outputLength = material.extractedText.length;
    job.textLength = htmlOutput.length;
    job.textMethod = htmlMethod || "none";
    job.screenshotStatus = material.screenshotStatus || "not_needed";
    job.screenshotCount = (material.screenshotUrls || []).length;
    job.transcribedSliceCount = transcribedSliceCount;
    job.totalSliceCount = totalSliceCount || job.screenshotCount;
    job.partialReason = partialReason;
    if (partialReason) job.errorMessage = partialReason;
    if (status === "failed") job.errorMessage = visualError || textError || "読み取れる本文を抽出できませんでした。URL取得、スクショ取得、AI文字起こしのエラー詳細を確認してください。";
  } catch (error) {
    material.extractionStatus = "failed";
    material.updatedAt = new Date().toISOString();
    job.status = "failed";
    job.finishedAt = material.updatedAt;
    job.errorMessage = error.message;
    // 進行中(running)のステップを failed に確定させる。これをしないと、例外で中断した
    // フェーズ(多くは「画像文字起こし」)が job.steps 上で running のまま残り、
    // 全体が「失敗」なのにアウトプット欄は「実行中」と表示されて食い違う。
    const lastStep = job.steps[job.steps.length - 1];
    if (lastStep && lastStep.status === "running") {
      job.steps[job.steps.length - 1] = { ...lastStep, status: "failed", detail: error.message };
    }
    material.visualAnalysis = [material.visualAnalysis, "抽出処理が中断されました: " + error.message].filter(Boolean).join("\n");
  }

  await saveProgress();
  return { material, job };
}

async function transcribeMaterial(projectRoot, material, { htmlText = "", extractor = "openai", onProgress } = {}) {
  const providers = String(extractor || "openai")
    .split(/[,+>]/)
    .map((item) => item.trim())
    .filter(Boolean);
  const errors = [];
  for (const provider of providers.length ? providers : ["openai"]) {
    try {
      if (provider === "codex" || provider === "claude") {
        return await transcribeMaterialWithAgent(projectRoot, material, { htmlText, provider });
      }
      if (provider === "gemini" || provider === "openai") {
        const result = await analyzeLpScreenshots(projectRoot, material, { provider, onProgress });
        if (!result?.text) throw new Error(result?.error || `${extractorLabel(provider)} returned empty transcript.`);
        return { ...result, provider };
      }
      throw new Error("未対応の文字起こしプロバイダです: " + provider);
    } catch (error) {
      errors.push(`${extractorLabel(provider)}: ${error.message}`);
    }
  }
  throw new Error(errors.join("\n"));
}

function extractorLabel() {
  return "画像文字起こし";
}
export async function updateMaterial(projectRoot, materialId, patch) {
  await ensureResearchData(projectRoot);
  return withFileLock(path.join(projectRoot, MATERIALS_PATH), async () => {
    const materials = await readJson(projectRoot, MATERIALS_PATH);
    const index = materials.findIndex((item) => item.id === materialId);
    if (index < 0) throw new Error("\u8cc7\u6599\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093: " + materialId);
    materials[index] = { ...materials[index], ...patch, updatedAt: new Date().toISOString() };
    await writeJson(projectRoot, MATERIALS_PATH, materials);
    return materials[index];
  });
}
export async function addFact(projectRoot, input) {
  await ensureResearchData(projectRoot);
  return withFileLock(path.join(projectRoot, FACTS_PATH), async () => {
    const facts = await readJson(projectRoot, FACTS_PATH);
    const now = new Date().toISOString();
    const fact = normalizeFact({ ...input, id: createId("fact"), createdAt: now, updatedAt: now });
    if (!fact.title || !fact.content) throw new Error("Fact title and content are required");
    if (isDuplicateFact(facts, fact)) throw new Error("Duplicate fact already exists");
    facts.unshift(fact);
    await writeJson(projectRoot, FACTS_PATH, facts);
    return fact;
  });
}


export async function addExpressionRule(projectRoot, input) {
  await ensureResearchData(projectRoot);
  return withFileLock(path.join(projectRoot, EXPRESSION_RULES_PATH), async () => {
    const rules = await readJson(projectRoot, EXPRESSION_RULES_PATH);
    const now = new Date().toISOString();
    const rule = {
      id: createId("rule"),
      productId: clean(input.productId),
      ruleType: clean(input.ruleType) || "ng_expression",
      pattern: clean(input.pattern),
      replacement: clean(input.replacement),
      description: clean(input.description),
      severity: clean(input.severity) || "medium",
      active: input.active === false ? false : true,
      createdAt: now,
      updatedAt: now
    };
    if (!rule.pattern && !rule.description) throw new Error("Expression rule pattern or description is required");
    rules.unshift(rule);
    await writeJson(projectRoot, EXPRESSION_RULES_PATH, rules);
    return rule;
  });
}

export async function addFacts(projectRoot, inputs) {
  await ensureResearchData(projectRoot);
  return withFileLock(path.join(projectRoot, FACTS_PATH), async () => {
    const facts = await readJson(projectRoot, FACTS_PATH);
    const now = new Date().toISOString();
    const added = [];
    for (const input of inputs) {
      const fact = normalizeFact({ ...input, id: createId("fact"), createdAt: now, updatedAt: now });
      if (!fact.title || !fact.content) continue;
      if (isDuplicateFact([...facts, ...added], fact)) continue;
      added.push(fact);
    }
    if (added.length) await writeJson(projectRoot, FACTS_PATH, [...added, ...facts]);
    return added;
  });
}


async function updateById(projectRoot, relativePath, id, patch, notFoundMessage) {
  return withFileLock(path.join(projectRoot, relativePath), async () => {
    const rows = await readJson(projectRoot, relativePath);
    const index = rows.findIndex((item) => item.id === id);
    if (index < 0) throw new Error(notFoundMessage + ": " + id);
    rows[index] = { ...rows[index], ...patch, id: rows[index].id, updatedAt: new Date().toISOString() };
    await writeJson(projectRoot, relativePath, rows);
    return rows[index];
  });
}

async function deleteById(projectRoot, relativePath, id, notFoundMessage) {
  return withFileLock(path.join(projectRoot, relativePath), async () => {
    const rows = await readJson(projectRoot, relativePath);
    const index = rows.findIndex((item) => item.id === id);
    if (index < 0) throw new Error(notFoundMessage + ": " + id);
    const [deleted] = rows.splice(index, 1);
    await writeJson(projectRoot, relativePath, rows);
    return deleted;
  });
}

function normalizeFact(input) {
  return {
    id: input.id,
    productId: clean(input.productId),
    title: clean(input.title),
    content: stripFactReferenceMarkers(input.content),
    category: clean(input.category) || "uncategorized",
    sourceType: clean(input.sourceType) || "manual",
    sourceUrl: clean(input.sourceUrl),
    sourceMaterialId: clean(input.sourceMaterialId),
    references: Array.isArray(input.references) ? input.references.map((ref) => clean(ref)).filter(Boolean) : [],
    webSearchStatus: clean(input.webSearchStatus),
    searchQueriesRun: Array.isArray(input.searchQueriesRun) ? input.searchQueriesRun.map((query) => clean(query)).filter(Boolean) : [],
    extractedAt: input.extractedAt,
    createdBy: clean(input.createdBy),
    confidenceScore: Number(input.confidenceScore || 0.7),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt
  };
}

function isDuplicateFact(facts, fact) {
  const target = normalizeText(`${fact.title} ${fact.content}`);
  return facts.some((item) => normalizeText(`${item.title} ${item.content}`) === target);
}

function normalizeText(value) {
  return stripFactReferenceMarkers(value).toLowerCase().replace(/\s+/g, "");
}

function stripFactReferenceMarkers(value) {
  return clean(value)
    .replace(/\s*[\(（]\s*※[0-9０-９]+(?:\s*[,、，]\s*※[0-9０-９]+)*\s*[\)）]/g, "")
    .trim();
}

async function captureLpScreenshots(projectRoot, material) {
  const loaded = await loadPuppeteer();
  if (!loaded.ok) return { status: "skipped_missing_dependency", urls: [], message: loaded.message };

  const dir = path.join(projectRoot, "outputs", "material-screenshots", material.id);
  await fs.mkdir(dir, { recursive: true });
  const browser = await loaded.puppeteer.launch({
    headless: true,
    executablePath: loaded.executablePath,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", ...String(process.env.CMOAI_CHROME_ARGS || "").split(/\s+/).filter(Boolean)]
  });
  try {
    const page = await browser.newPage();
    const viewportWidth = Number(process.env.CMOAI_SCREENSHOT_VIEWPORT_WIDTH || 1280);
    const viewportHeight = Number(process.env.CMOAI_SCREENSHOT_VIEWPORT_HEIGHT || 2200);
    await page.setViewport({ width: viewportWidth, height: viewportHeight, deviceScaleFactor: 1 });
    let domFallback = false;
    await page.goto(material.sourceUrl, { waitUntil: "networkidle2", timeout: 60000 }).catch(async () => {
      domFallback = true;
      await page.goto(material.sourceUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    });
    const waitSelector = String(process.env.CMOAI_SCREENSHOT_WAIT_SELECTOR || "").trim();
    if (waitSelector) {
      await page.waitForSelector(waitSelector, { timeout: 10000 }).catch(() => null);
    }
    await page.evaluate(async () => {
      await Promise.all(Array.from(document.images).filter((img) => !img.complete).slice(0, 80).map((img) => new Promise((resolve) => {
        img.addEventListener("load", resolve, { once: true });
        img.addEventListener("error", resolve, { once: true });
        setTimeout(resolve, 2500);
      })));
    }).catch(() => null);
    const extraWaitMs = Number(process.env.CMOAI_SCREENSHOT_EXTRA_WAIT_MS || process.env.CMOAI_SCREENSHOT_WAIT_MS || 3000);
    await new Promise((resolve) => setTimeout(resolve, extraWaitMs));
    // SPA(Next.js等)でもスクショ用ブラウザの1回のロードで本文を拾えるよう、レンダリング後HTMLも保持しておく。取得に失敗してもスクショ処理は続行する。
    const renderedHtml = await page.content().catch(() => null);
    const pageSnapshot = await page.evaluate(() => {
      const height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0 && rect.width > 1 && rect.height > 1;
      };
      const images = Array.from(document.images).filter(visible).map((img) => {
        const rect = img.getBoundingClientRect();
        return {
          src: img.currentSrc || img.src || "",
          alt: String(img.alt || "").trim(),
          yStart: Math.max(0, Math.round(rect.top + window.scrollY)),
          yEnd: Math.min(height, Math.round(rect.bottom + window.scrollY)),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        };
      });
      const textBlocks = Array.from(document.querySelectorAll("h1,h2,h3,h4,p,li,dt,dd,figcaption,button,a"))
        .filter(visible)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return { text: String(element.innerText || "").replace(/\s+/g, " ").trim(), yStart: Math.max(0, Math.round(rect.top + window.scrollY)), yEnd: Math.min(height, Math.round(rect.bottom + window.scrollY)) };
        })
        .filter((item) => item.text.length >= 2);
      return { height, viewportHeight: window.innerHeight, viewportWidth: window.innerWidth, images, textBlocks };
    });
    const metrics = { height: pageSnapshot.height, viewportHeight: pageSnapshot.viewportHeight, viewportWidth: pageSnapshot.viewportWidth };
    // No real content cap: capture as many slices as the page actually needs so the
    // bottom of long LPs is never silently dropped. This is only a runaway-loop guard.
    const maxSlices = Number(process.env.CMOAI_SCREENSHOT_MAX_SLICES || 500);
    const configuredOverlap = Number(process.env.CMOAI_SCREENSHOT_OVERLAP_PX || 360);
    const overlap = Math.max(0, Math.min(configuredOverlap, Math.floor(metrics.viewportHeight * 0.45)));
    const positions = buildScreenshotPositions(metrics.height, metrics.viewportHeight, overlap, maxSlices);
    const urls = [];
    const slices = [];
    for (let i = 0; i < positions.length; i += 1) {
      const yStart = positions[i];
      await page.evaluate((y) => window.scrollTo(0, y), yStart);
      await new Promise((resolve) => setTimeout(resolve, 450));
      const fileName = "slice-" + String(i + 1).padStart(2, "0") + ".png";
      await page.screenshot({ path: path.join(dir, fileName), fullPage: false });
      const rel = "outputs/material-screenshots/" + material.id + "/" + fileName;
      urls.push("/project-file?project=" + encodeURIComponent(path.basename(projectRoot)) + "&path=" + encodeURIComponent(rel));
      slices.push({
        index: i,
        fileName,
        path: rel,
        yStart,
        yEnd: Math.min(yStart + metrics.viewportHeight, metrics.height),
        pageHeight: metrics.height,
        viewportWidth: metrics.viewportWidth,
        viewportHeight: metrics.viewportHeight,
        overlapTop: i === 0 ? 0 : Math.max(0, positions[i - 1] + metrics.viewportHeight - yStart),
        overlapBottom: i === positions.length - 1 ? 0 : Math.max(0, yStart + metrics.viewportHeight - positions[i + 1])
      });
    }
    const optimization = buildVisionPlan(slices, pageSnapshot.images, pageSnapshot.textBlocks);
    return {
      status: urls.length ? "captured" : "failed",
      urls,
      slices,
      domEvidence: optimization.domEvidence,
      imageInventory: optimization.imageInventory,
      visionSliceIndexes: optimization.visionSliceIndexes,
      renderedHtml,
      domFallback,
      visualAnalysis: urls.length ? "スクリーンショットを" + urls.length + "枚保存しました。" : "スクリーンショットを保存できませんでした。"
    };
  } finally {
    await browser.close().catch(() => null);
  }
}

export function buildVisionPlan(slices, images = [], textBlocks = []) {
  const meaningfulAlt = (value) => String(value || "").replace(/\s+/g, " ").trim().length >= 8;
  const normalizeUrl = (value) => {
    try {
      const url = new URL(String(value || ""));
      url.hash = "";
      return url.href;
    } catch {
      return String(value || "").split("#")[0];
    }
  };
  const seenSources = new Set();
  const imageInventory = images.map((item) => ({ ...item, src: normalizeUrl(item.src), alt: String(item.alt || "").trim() }));
  const visionSliceIndexes = [];
  const evidence = [];
  const seenEvidenceText = new Set();
  const seenEvidenceAlt = new Set();

  for (const slice of slices) {
    const overlappingText = textBlocks.filter((item) => item.yEnd > slice.yStart && item.yStart < slice.yEnd);
    const uniqueText = [...new Set(overlappingText.map((item) => String(item.text || "").trim()).filter(Boolean))]
      .filter((text) => !seenEvidenceText.has(text));
    uniqueText.forEach((text) => seenEvidenceText.add(text));
    const domText = uniqueText.join("\n");
    const overlappingImages = imageInventory.filter((item) => item.yEnd > slice.yStart && item.yStart < slice.yEnd && item.width >= 80 && item.height >= 40);
    let hasUnexplainedImage = false;
    for (const image of overlappingImages) {
      const duplicate = image.src && seenSources.has(image.src);
      if (!duplicate && image.src) seenSources.add(image.src);
      if (!duplicate && !meaningfulAlt(image.alt)) hasUnexplainedImage = true;
    }
    const altText = [...new Set(overlappingImages.map((item) => item.alt).filter(meaningfulAlt))]
      .filter((alt) => !seenEvidenceAlt.has(alt));
    altText.forEach((alt) => seenEvidenceAlt.add(alt));
    if (domText || altText.length) {
      evidence.push([
        `## DOM / image metadata ${Number(slice.index) + 1}`,
        domText,
        ...altText.map((alt) => `[画像: ${alt}]`)
      ].filter(Boolean).join("\n"));
    }
    if (hasUnexplainedImage || (!overlappingImages.length && !overlappingText.length)) visionSliceIndexes.push(Number(slice.index));
  }

  return {
    visionSliceIndexes: [...new Set(visionSliceIndexes)],
    imageInventory,
    domEvidence: evidence.join("\n\n---\n\n")
  };
}

function buildScreenshotPositions(pageHeight, viewportHeight, overlap, maxSlices) {
  const height = Math.max(0, Number(pageHeight || 0));
  const viewport = Math.max(1, Number(viewportHeight || 1));
  const limit = Math.max(1, Number(maxSlices || 1));
  const step = Math.max(1, viewport - Math.max(0, Number(overlap || 0)));
  const maxStart = Math.max(0, height - viewport);
  const positions = [];

  for (let y = 0; y <= maxStart && positions.length < limit; y += step) {
    positions.push(Math.round(y));
  }

  if (positions.length && positions[positions.length - 1] !== maxStart) {
    if (positions.length < limit) {
      positions.push(maxStart);
    } else {
      positions[positions.length - 1] = maxStart;
    }
  }

  return positions.length ? [...new Set(positions)] : [0];
}

async function loadPuppeteer() {
  try {
    const puppeteer = await import("puppeteer-core");
    const executablePath = await findChromeExecutable();
    if (!executablePath) return { ok: false, message: "Chrome\u5b9f\u884c\u30d5\u30a1\u30a4\u30eb\u304c\u898b\u3064\u304b\u3089\u306a\u3044\u305f\u3081\u30b9\u30af\u30b7\u30e7\u53d6\u5f97\u3092\u30b9\u30ad\u30c3\u30d7\u3057\u307e\u3057\u305f\u3002npm run setup-browser \u3092\u5b9f\u884c\u3059\u308b\u304b\u3001CHROME_PATH\u3092\u8a2d\u5b9a\u3057\u3066\u304f\u3060\u3055\u3044\u3002" };
    return { ok: true, puppeteer: puppeteer.default || puppeteer, executablePath };
  } catch {
    return { ok: false, message: "puppeteer-core\u304c\u672a\u5c0e\u5165\u306e\u305f\u3081\u30b9\u30af\u30b7\u30e7\u53d6\u5f97\u3092\u30b9\u30ad\u30c3\u30d7\u3057\u307e\u3057\u305f\u3002npm install puppeteer-core \u3092\u5b9f\u884c\u3059\u308b\u3068\u753b\u50cfLP\u5bfe\u5fdc\u304c\u6709\u52b9\u306b\u306a\u308a\u307e\u3059\u3002" };
  }
}

async function findChromeExecutable() {
  // CMOAIがnpm install時に調達・保存したブラウザパスを最優先で使う。
  const savedPath = await getChromePath().catch(() => "");
  if (savedPath) {
    try { await fs.access(savedPath); return savedPath; } catch {}
  }
  const candidates = [
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium"
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { await fs.access(candidate); return candidate; } catch {}
  }
  // Playwright/Puppeteer同梱のchromium(PLAYWRIGHT_BROWSERS_PATH配下など)を走査する。
  // 標準ブラウザが無い環境(CI・リモート実行)でもスクショ取得を有効化するための保険。
  const bundled = await findBundledChromium();
  if (bundled) return bundled;
  return "";
}

async function findBundledChromium() {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(process.env.HOME || "", ".cache", "ms-playwright"),
    path.join(process.env.HOME || "", ".cache", "puppeteer"),
    path.join(process.env.LOCALAPPDATA || "", "ms-playwright")
  ].filter(Boolean);
  // OSごとの実行ファイル相対パス候補(Linux/Mac/Win)。
  const relPaths = [
    ["chrome-linux", "chrome"],
    ["chrome-linux", "headless_shell"],
    ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"],
    ["chrome-win", "chrome.exe"]
  ];
  for (const root of roots) {
    let entries;
    try { entries = await fs.readdir(root); } catch { continue; }
    // chromium* ディレクトリを新しい順(バージョン降順)に見る。
    const dirs = entries.filter((name) => /chromium/i.test(name)).sort().reverse();
    for (const dir of dirs.length ? dirs : [""]) {
      for (const rel of relPaths) {
        const candidate = path.join(root, dir, ...rel);
        try { await fs.access(candidate); return candidate; } catch {}
      }
    }
  }
  return "";
}
// \u4e00\u822c\u7684\u306a\u30d6\u30e9\u30a6\u30b6\u76f8\u5f53\u306eUA\u3067\u30ea\u30af\u30a8\u30b9\u30c8\u3059\u308b(\u30b5\u30fc\u30d0\u30fc\u5074\u306e\u30d6\u30e9\u30a6\u30b6\u5224\u5b9a\u3067\u30d6\u30ed\u30c3\u30af\u3055\u308c\u308b\u8cc7\u6599DB\u30b5\u30a4\u30c8\u5bfe\u7b56)\u3002
// URLから可読テキストを抽出する(記事LPテンプレのURL取り込み等で使う)。資料DBのLP書き出しと
// 同じ fetchReadableText を流用する。スクショや画像分析は行わずHTML本文テキストのみ返す。
export async function extractTextFromUrl(url) {
  const target = String(url || "").trim();
  if (!/^https?:\/\//i.test(target)) throw new Error("有効なURL(http/https)を入力してください。");
  const result = await fetchReadableText(target);
  return { text: result.text || "", bodyLength: result.bodyLength || 0 };
}

const FETCH_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const FETCH_MAX_CHARS = 50000;
const FETCH_TRUNCATION_NOTE = "\n\n[\u6ce8: \u672c\u6587\u304c\u9577\u3044\u305f\u3081" + FETCH_MAX_CHARS.toLocaleString("en-US") + "\u6587\u5b57\u3067\u6253\u3061\u5207\u308a\u307e\u3057\u305f]";

async function fetchReadableText(url) {
  const performRequest = () => fetch(url, {
    headers: {
      "user-agent": FETCH_USER_AGENT,
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7"
    },
    signal: AbortSignal.timeout(30000)
  });

  // \u30cd\u30c3\u30c8\u30ef\u30fc\u30af\u30a8\u30e9\u30fc/\u30bf\u30a4\u30e0\u30a2\u30a6\u30c8/5xx\u306f2\u79d2\u5f85\u3063\u30661\u56de\u3060\u3051\u518d\u8a66\u884c\u3059\u308b\u30024xx\u306f\u518d\u8a66\u884c\u3057\u306a\u3044\u3002
  let res;
  let retried = false;
  try {
    res = await performRequest();
    if (res.status >= 500 && res.status < 600) throw new Error(`URL fetch failed: ${res.status}`);
  } catch {
    retried = true;
    await new Promise((resolve) => setTimeout(resolve, 2000));
    res = await performRequest();
  }
  if (!res.ok) throw new Error(`URL fetch failed: ${res.status}`);

  const contentType = res.headers.get("content-type") || "";
  const buffer = await res.arrayBuffer();
  const { text: raw, charset } = decodeHttpBody(buffer, contentType);

  if (!contentType.includes("html")) {
    const cleaned = cleanWhitespace(raw);
    return finalizeFetchedText(cleaned, cleaned.length, charset, retried);
  }
  const converted = htmlToLpText(raw, url);
  return finalizeFetchedText(converted.text, converted.bodyLength, charset, retried);
}

function finalizeFetchedText(text, bodyLength, charset, retried) {
  const truncated = text.length > FETCH_MAX_CHARS;
  const finalText = truncated ? text.slice(0, FETCH_MAX_CHARS) + FETCH_TRUNCATION_NOTE : text;
  return { text: finalText, bodyLength, truncated, charset, retried, method: "fetch" };
}

// Content-Type\u30d8\u30c3\u30c0\u2192<meta charset>\u2192\u65e2\u5b9autf-8\u306e\u9806\u3067\u6587\u5b57\u30b3\u30fc\u30c9\u3092\u5224\u5b9a\u3057\u3066\u30c7\u30b3\u30fc\u30c9\u3059\u308b\u3002
// \u4e0d\u660e\u306a\u30e9\u30d9\u30eb\u304c\u6765\u305f\u5834\u5408\u306futf-8\u306b\u30d5\u30a9\u30fc\u30eb\u30d0\u30c3\u30af\u3059\u308b(TextDecoder\u304c\u672a\u5bfe\u5fdc\u30e9\u30d9\u30eb\u3067\u4f8b\u5916\u3092\u6295\u3052\u308b\u305f\u3081)\u3002
function decodeHttpBody(buffer, contentType) {
  const headerCharset = firstMatch(contentType, /charset=["']?([\w-]+)["']?/i);
  let label = headerCharset;
  if (!label) {
    const headBytes = buffer.slice(0, Math.min(4096, buffer.byteLength));
    const head = Buffer.from(headBytes).toString("latin1");
    label = extractCharsetFromMetaTag(head);
  }
  label = normalizeCharsetLabel(label) || "utf-8";
  try {
    return { text: new TextDecoder(label).decode(buffer), charset: label };
  } catch {
    return { text: new TextDecoder("utf-8").decode(buffer), charset: "utf-8" };
  }
}

function extractCharsetFromMetaTag(head) {
  let match = head.match(/<meta[^>]+charset=["']?([\w-]+)["']?/i);
  if (match) return match[1];
  match = head.match(/<meta[^>]+http-equiv=["']?content-type["']?[^>]*content=["'][^"']*charset=([\w-]+)[^"']*["']/i);
  if (match) return match[1];
  return "";
}

function normalizeCharsetLabel(label) {
  const value = String(label || "").trim().toLowerCase();
  if (!value) return "";
  const key = value.replace(/[-_]/g, "");
  const aliases = {
    shiftjis: "shift-jis", sjis: "shift-jis", xsjis: "shift-jis", cp932: "shift-jis", ms932: "shift-jis", windows31j: "shift-jis",
    eucjp: "euc-jp", xeucjp: "euc-jp"
  };
  return aliases[key] || value;
}

function htmlToLpText(html, pageUrl) {
  const title = firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const description = firstMatch(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["'][^>]*>/i) || firstMatch(html, /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["'][^>]*>/i);
  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    // \u8868\u306e\u30bb\u30eb\u5185\u5bb9\u3092\u884c\u3068\u3057\u3066\u6b8b\u3059(\u53b3\u5bc6\u306amarkdown\u8868\u5316\u306f\u3057\u306a\u3044)\u3002
    .replace(/<\/(td|th)>/gi, " | ")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<img\b[^>]*alt=["']([^"']+)["'][^>]*>/gi, "\n[\u753b\u50cf: $1]\n")
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi, "\n[\u30ea\u30f3\u30af: $1] ")
    .replace(/<(h[1-6]|p|li|dt|dd|blockquote|figcaption|button|section|article|div|br)\b[^>]*>/gi, "\n")
    .replace(/<\/(h[1-6]|p|li|dt|dd|blockquote|figcaption|button|section|article|div)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const bodyText = cleanWhitespace(decodeEntities(body));
  const parts = [];
  parts.push(`URL: ${pageUrl}`);
  if (title) parts.push(`\u30bf\u30a4\u30c8\u30eb: ${decodeEntities(title)}`);
  if (description) parts.push(`\u8aac\u660e: ${decodeEntities(description)}`);
  parts.push("\u672c\u6587:");
  parts.push(bodyText);
  return { text: parts.filter(Boolean).join("\n"), bodyLength: bodyText.length };
}

function firstMatch(value, pattern) {
  const match = String(value || "").match(pattern);
  return match ? cleanWhitespace(decodeEntities(match[1] || "")) : "";
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(parseInt(num, 10)));
}
function cleanWhitespace(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function clean(value) {
  return String(value || "").trim();
}

function createId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
