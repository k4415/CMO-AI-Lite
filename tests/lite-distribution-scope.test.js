import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function fileExists(relativePath) {
  try {
    await fs.access(path.join(root, relativePath));
    return true;
  } catch {
    return false;
  }
}

async function readText(relativePath) {
  return fs.readFile(path.join(root, relativePath), "utf8");
}

async function readJson(relativePath) {
  return JSON.parse(await readText(relativePath));
}

async function listDir(relativePath) {
  return fs.readdir(path.join(root, relativePath));
}

async function walkFiles(relativeDir, extensions = null) {
  const results = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (!extensions || extensions.some((ext) => entry.name.endsWith(ext))) {
        results.push(fullPath);
      }
    }
  }
  await walk(path.join(root, relativeDir));
  return results;
}

const removedFiles = [
  "src/core/article-ai.js",
  "src/core/article-store.js",
  "src/core/article-template-ai.js",
  "src/core/copy-ai.js",
  "src/core/copy-store.js",
  "src/core/script-ai.js",
  "src/core/script-store.js",
  "src/core/movie-template-ai.js",
  "src/core/insight-ai.js",
  "src/core/media-specs.js",
  "src/actions/create-n1-analysis.js",
  "src/actions/create-creative-guideline.js",
  "config/prompts/ad-copy.md",
  "config/prompts/article-lp.md",
  "config/prompts/n1-insight.md",
  "config/prompts/script.md",
  "config/prompts/template-ad-copy.md",
  "config/prompts/template-article.md",
  "config/prompts/template-movie-storyboard.md",
  "config/prompts/template-movie-text-storyboard.md",
  "config/prompts/template-text-storyboard.md",
  "docs/notion-ai-skills-audit.md",
  "docs/notion-prompt-porting.md",
  "src/ui/design-preview.html"
];

const requiredInternalResearchFragments = [
  "research-materials.json",
  "material-extraction-jobs.json",
  "/api/research/materials",
  "/api/research/materials/extract",
  "/api/research/materials/extract/status"
];

const removedRouteFragments = [
  "/api/copies",
  "/api/scripts",
  "/api/articles",
  "/api/research/interviews/analyze",
  "/api/ad-templates/template-storyboard",
  "/api/ad-templates/template-adcopy",
  "/api/ad-templates/template-movie-script",
  "/api/ad-templates/template-article",
  "/design-preview.html"
];

const forbiddenContentPatterns = [
  /Notion版/,
  /notion\./,
  /N=1/,
  /\/api\/copies/,
  /\/api\/scripts/,
  /\/api\/articles/,
  /template-adcopy/,
  /template-movie-script/,
  /template-article/
];

const scanDirs = ["src", "config", "docs", "tests", "AGENTS.md", "CLAUDE.md", "DESIGN.md", "README.md", ".agents", ".claude", "projects/_template"];

test("removed Pro/N=1 files are absent", async () => {
  for (const file of removedFiles) {
    assert.equal(await fileExists(file), false, `expected removed: ${file}`);
  }
});

test("internal LP research fragments remain in core modules", async () => {
  const projectStore = await readText("src/core/project-store.js");
  const researchStore = await readText("src/core/research-store.js");
  const server = await readText("src/server.js");
  const combined = `${projectStore}\n${researchStore}\n${server}`;
  for (const fragment of requiredInternalResearchFragments) {
    assert.match(combined, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `missing fragment: ${fragment}`);
  }
});

test("removed routes are absent from server.js", async () => {
  const server = await readText("src/server.js");
  for (const route of removedRouteFragments) {
    assert.doesNotMatch(server, new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `route still present: ${route}`);
  }
});

test("ad-templates.json has exactly 100 bundled banner templates NO.001-100", async () => {
  const templates = await readJson("data/ad-templates.json");
  assert.ok(Array.isArray(templates));
  assert.equal(templates.length, 100);
  const numbers = templates.map((template) => {
    assert.equal(template.isBundled, true);
    assert.equal(template.creativeType, "banner");
    assert.ok(template.templatePromptJson && Object.keys(template.templatePromptJson).length > 0);
    assert.ok(Array.isArray(template.templateZones) && template.templateZones.length > 0);
    assert.ok(template.copyBlueprint && Object.keys(template.copyBlueprint).length > 0);
    assert.ok(template.layoutBlueprint && Object.keys(template.layoutBlueprint).length > 0);
    assert.ok(template.templateReadiness && Object.keys(template.templateReadiness).length > 0);
    assert.equal("adCopyTemplate" in template, false);
    assert.equal("sourceText" in template, false);
    assert.equal("scriptText" in template, false);
    assert.equal("articleTemplateText" in template, false);
    const match = String(template.title || "").match(/NO\.(\d{3})/);
    assert.ok(match, `title missing NO.xxx: ${template.title}`);
    return Number(match[1]);
  });
  assert.deepEqual([...new Set(numbers)].sort((a, b) => a - b), Array.from({ length: 100 }, (_, index) => index + 1));
});

test("projects root contains only _template", async () => {
  const entries = await listDir("projects");
  assert.deepEqual(entries.sort(), ["_template"]);
});

test("distribution skills are exactly four and match across providers", async () => {
  const agentSkills = (await listDir(".agents/skills")).sort();
  const claudeSkills = (await listDir(".claude/skills")).sort();
  assert.deepEqual(agentSkills, ["cmoai-banner", "cmoai-research", "cmoai-template", "cmoai-who-what"]);
  assert.deepEqual(claudeSkills, agentSkills);
  for (const skill of agentSkills) {
    const agentText = await readText(path.join(".agents/skills", skill, "SKILL.md"));
    const claudeText = await readText(path.join(".claude/skills", skill, "SKILL.md"));
    assert.equal(agentText, claudeText, `skill mismatch: ${skill}`);
  }
});

test("active source and docs avoid removed Notion/N=1 references", async () => {
  const files = [];
  for (const target of scanDirs) {
    const fullPath = path.join(root, target);
    try {
      const stat = await fs.stat(fullPath);
      if (stat.isDirectory()) {
        const walked = await walkFiles(target, [".js", ".md", ".html", ".css", ".json"]);
        files.push(...walked);
      } else {
        files.push(fullPath);
      }
    } catch {
      // ignore missing optional paths during transition
    }
  }
  for (const file of files) {
    if (file.includes(`${path.sep}docs${path.sep}superpowers${path.sep}`)) continue;
    const relative = path.relative(root, file);
    if (relative === "tests/lite-distribution-scope.test.js") continue;
    const content = await fs.readFile(file, "utf8");
    for (const pattern of forbiddenContentPatterns) {
      assert.doesNotMatch(content, pattern, `${relative} contains forbidden pattern ${pattern}`);
    }
  }
});
