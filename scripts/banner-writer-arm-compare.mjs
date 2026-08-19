#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { applyRegulationRules, classifyExpressionRules } from "../src/core/banner-ai.js";
import { writeBannerImagePrompt } from "../src/core/banner-image-prompt-writer.js";
import { listBannerCreatives } from "../src/core/banner-store.js";
import { buildInstructionPolicy } from "../src/core/banner-instruction-policy.js";
import { listAdTemplates } from "../src/core/ad-template-store.js";
import { readJson } from "../src/core/project-store.js";
import { getAnthropicKey, getOpenAiKey } from "../src/core/settings-store.js";
import { listStrategies } from "../src/core/strategy-store.js";
import {
  buildBannerImagePrompt,
  buildBannerInputImageManifest,
  buildSelectedAssetPlacementPlan,
  generateBannerImageWithGptImage2
} from "../src/core/openai-image.js";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRITER_ARMS = ["claude-opus-5", "claude-sonnet-5"];

const USAGE = `用法:
  node scripts/banner-writer-arm-compare.mjs <projectRoot> <bannerId> [--images]

説明:
  既存バナー1件を入力に、CMOAI_PROMPT_WRITER_MODEL を claude-opus-5 / claude-sonnet-5 で切り替えて
  writeBannerImagePrompt と buildBannerImagePrompt を実行し、各アームの散文と最終プロンプトを
  <projectRoot>/outputs/arm-compare/<timestamp>/ に保存します。

引数:
  projectRoot  案件ディレクトリ（例: projects/案件名）
  bannerId     対象バナーID

オプション:
  --images     最終プロンプトから gpt-image-2 画像生成（generateBannerImageWithGptImage2）まで実行
  --help       このヘルプを表示

環境変数:
  CMOAI_PROMPT_WRITER_MODEL  各アーム実行前に一時上書きされます（比較対象外）
  ANTHROPIC_API_KEY          ライター実行に必須
  OPENAI_API_KEY             --images 指定時に必須

注意:
  --images 指定時は対象バナーの generatedImagePath が最後に実行したアームの結果で更新されます。
  生成画像は outputs/arm-compare/<timestamp>/ にもコピー保存されます。
`;

export function printUsage() {
  console.log(USAGE.trimEnd());
}

export function parseCliArgs(argv) {
  const positional = [];
  let images = false;
  let help = false;

  for (const token of argv) {
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if (token === "--images") {
      images = true;
      continue;
    }
    if (token.startsWith("--")) {
      throw new Error(`不明なオプション: ${token}`);
    }
    positional.push(token);
  }

  return {
    help,
    images,
    projectRoot: positional[0] || "",
    bannerId: positional[1] || ""
  };
}

function resolveProjectRoot(projectRoot) {
  const absolute = path.isAbsolute(projectRoot)
    ? projectRoot
    : path.resolve(APP_ROOT, projectRoot);
  return path.normalize(absolute);
}

function formatTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function applyRegulationToWriterText(writerResult, ngRules, instructionPolicy) {
  const applied = applyRegulationRules({
    writtenImagePrompt: String(writerResult?.writtenImagePrompt || ""),
    styleNotes: String(writerResult?.styleNotes || "")
  }, ngRules, instructionPolicy);
  return {
    writtenImagePrompt: applied.writtenImagePrompt,
    styleNotes: applied.styleNotes,
    writerAudit: writerResult?.writerAudit || null
  };
}

function buildDiversityGuidance(banner) {
  return {
    axisLabel: banner?.diversityReview?.axis || banner?.variationAxis || "",
    axisInstruction: banner?.diversityReview?.visualGuidance || ""
  };
}

function buildWriterInput({ banner, product, strategy, expressionRules }) {
  if (!banner?.promptJson || typeof banner.promptJson !== "object") {
    throw new Error("対象バナーに promptJson がありません。先に prompt 工程を完了してください。");
  }
  const instructionPolicy = banner.instructionPolicy || buildInstructionPolicy(banner.additionalInstruction || "");
  const { ngRules, specifiedRules } = classifyExpressionRules(expressionRules, product, instructionPolicy);
  const inputImages = buildBannerInputImageManifest(banner);
  const selectedAssetPlacements = buildSelectedAssetPlacementPlan(banner.promptJson.zones, inputImages);
  return {
    writerArgs: {
      promptJson: banner.promptJson,
      product,
      strategy,
      copyBrief: banner.copyBrief || {},
      colorDecision: banner.colorDecision || null,
      templateStructureContract: banner.promptJson.templateStructureContract || null,
      selectedAssetPlacements,
      instructionPolicy,
      diversityGuidance: buildDiversityGuidance(banner),
      expressionRules: specifiedRules
    },
    instructionPolicy,
    ngRules,
    inputImages
  };
}

async function loadBannerWorkspace(projectRoot, bannerId) {
  const absoluteProjectRoot = resolveProjectRoot(projectRoot);
  const banners = await listBannerCreatives(absoluteProjectRoot);
  const banner = banners.find((item) => item.id === bannerId);
  if (!banner) {
    throw new Error(`バナーが見つかりません: ${bannerId} (${absoluteProjectRoot})`);
  }

  const [products, strategies, expressionRules, adTemplates] = await Promise.all([
    readJson(absoluteProjectRoot, "data/products.json").catch(() => []),
    listStrategies(absoluteProjectRoot),
    readJson(absoluteProjectRoot, "data/expression-rules.json").catch(() => []),
    listAdTemplates()
  ]);

  const product = (Array.isArray(products) ? products : []).find((item) => item.id === banner.productId) || {};
  const strategy = strategies.find((item) => item.id === banner.strategyId) || {};
  const template = adTemplates.find((item) => item.id === banner.templateAdId) || null;

  return {
    projectRoot: absoluteProjectRoot,
    banner,
    product,
    strategy,
    template,
    expressionRules: Array.isArray(expressionRules) ? expressionRules : []
  };
}

async function assertAnthropicKeyConfigured() {
  const { key } = await getAnthropicKey();
  if (!key) {
    throw new Error("Anthropic APIキーが未設定です。設定画面で保存するか、ANTHROPIC_API_KEYを設定してください。");
  }
}

async function assertOpenAiKeyConfigured() {
  const { key } = await getOpenAiKey();
  if (!key) {
    throw new Error("OpenAI APIキーが未設定です。設定画面で保存するか、OPENAI_API_KEYを設定してください。");
  }
}

async function copyGeneratedImage(projectRoot, sourceRelativePath, destinationPath) {
  const sourceAbsolute = path.join(projectRoot, sourceRelativePath);
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.copyFile(sourceAbsolute, destinationPath);
}

export async function runWriterArmCompare({
  projectRoot,
  bannerId,
  images = false,
  now = () => new Date()
} = {}) {
  await assertAnthropicKeyConfigured();
  if (images) await assertOpenAiKeyConfigured();

  const workspace = await loadBannerWorkspace(projectRoot, bannerId);
  const { writerArgs, instructionPolicy, ngRules, inputImages } = buildWriterInput(workspace);
  const timestamp = formatTimestamp(now());
  const outputDir = path.join(workspace.projectRoot, "outputs", "arm-compare", timestamp);
  await fs.mkdir(outputDir, { recursive: true });

  const previousWriterModel = process.env.CMOAI_PROMPT_WRITER_MODEL;
  const armResults = [];

  try {
    for (const model of WRITER_ARMS) {
      process.env.CMOAI_PROMPT_WRITER_MODEL = model;
      const writerResult = await writeBannerImagePrompt(writerArgs);
      const regulated = applyRegulationToWriterText(writerResult, ngRules, instructionPolicy);
      const assemblyBanner = {
        ...workspace.banner,
        writtenImagePrompt: regulated.writtenImagePrompt,
        styleNotes: regulated.styleNotes
      };
      const finalPrompt = buildBannerImagePrompt(assemblyBanner, inputImages);
      const armDir = path.join(outputDir, model);
      await fs.mkdir(armDir, { recursive: true });

      await fs.writeFile(path.join(armDir, "written-image-prompt.txt"), `${regulated.writtenImagePrompt}\n`, "utf8");
      await fs.writeFile(path.join(armDir, "style-notes.txt"), `${regulated.styleNotes}\n`, "utf8");
      await fs.writeFile(path.join(armDir, "final-prompt.txt"), `${finalPrompt}\n`, "utf8");

      const armRecord = {
        model,
        writerAudit: regulated.writerAudit,
        writtenImagePromptChars: regulated.writtenImagePrompt.length,
        styleNotesChars: regulated.styleNotes.length,
        finalPromptChars: finalPrompt.length,
        files: {
          writtenImagePrompt: path.relative(workspace.projectRoot, path.join(armDir, "written-image-prompt.txt")),
          styleNotes: path.relative(workspace.projectRoot, path.join(armDir, "style-notes.txt")),
          finalPrompt: path.relative(workspace.projectRoot, path.join(armDir, "final-prompt.txt"))
        }
      };

      if (images) {
        const generated = await generateBannerImageWithGptImage2(workspace.projectRoot, assemblyBanner, {
          product: workspace.product
        });
        const generatedRelativePath = generated.generatedImagePath || generated.images?.at(-1) || "";
        if (generatedRelativePath) {
          const imageDestination = path.join(armDir, "generated-image.png");
          await copyGeneratedImage(workspace.projectRoot, generatedRelativePath, imageDestination);
          armRecord.generatedImage = path.relative(workspace.projectRoot, imageDestination);
          armRecord.generatedImageSource = generatedRelativePath;
        }
      }

      armResults.push(armRecord);
    }
  } finally {
    if (previousWriterModel === undefined) delete process.env.CMOAI_PROMPT_WRITER_MODEL;
    else process.env.CMOAI_PROMPT_WRITER_MODEL = previousWriterModel;
  }

  const summary = {
    schemaVersion: 1,
    createdAt: now().toISOString(),
    projectRoot: workspace.projectRoot,
    bannerId: workspace.banner.id,
    bannerTitle: workspace.banner.title || "",
    productId: workspace.product.id || workspace.banner.productId || "",
    strategyId: workspace.strategy.id || workspace.banner.strategyId || "",
    templateAdId: workspace.banner.templateAdId || "",
    images,
    arms: armResults,
    outputDir: path.relative(workspace.projectRoot, outputDir)
  };

  await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return summary;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  if (!args.projectRoot || !args.bannerId) {
    printUsage();
    throw new Error("projectRoot と bannerId を指定してください。");
  }

  const summary = await runWriterArmCompare({
    projectRoot: args.projectRoot,
    bannerId: args.bannerId,
    images: args.images
  });

  console.log(JSON.stringify({
    outputDir: summary.outputDir,
    bannerId: summary.bannerId,
    images: summary.images,
    arms: summary.arms.map((arm) => ({
      model: arm.model,
      writtenImagePromptChars: arm.writtenImagePromptChars,
      finalPromptChars: arm.finalPromptChars,
      writerOutcome: arm.writerAudit?.outcome || "",
      generatedImage: arm.generatedImage || null
    }))
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`banner-writer-arm-compare error: ${error.message}`);
    process.exitCode = 1;
  });
}
