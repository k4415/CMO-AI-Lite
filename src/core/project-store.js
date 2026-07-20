import fs from "node:fs/promises";
import path from "node:path";

export const COLLECTIONS = [
  { id: "product-master", name: "\u5546\u54c1\u30de\u30b9\u30bf\u30fcDB", phase: "research_setup", paths: ["data/products.json", "inputs/product.md"] },
  { id: "source-materials", name: "\u5185\u90e8LP\u89e3\u6790\u30ad\u30e3\u30c3\u30b7\u30e5", phase: "research", paths: ["data/research-materials.json", "data/material-extraction-jobs.json"] },
  { id: "facts", name: "\u4e8b\u5b9fDB", phase: "research", paths: ["data/facts.json", "research/facts.md"] },
  { id: "who-what", name: "WHO-WHAT DB", phase: "strategy", paths: ["data/strategies.json", "strategy/who-what.md"] },
  { id: "expression-rules", name: "\u8868\u73fe\u30ec\u30ae\u30e5\u30ec\u30fc\u30b7\u30e7\u30f3DB", phase: "review", paths: ["regulations/expression-rules.md"] },
  { id: "banner-creatives", name: "\u30d0\u30ca\u30fc\u5236\u4f5cDB", phase: "creative", paths: ["data/banner-creatives.json", "outputs/banners"] },
  { id: "outputs", name: "\u30a2\u30a6\u30c8\u30d7\u30c3\u30c8", phase: "creative", paths: ["outputs"] },
  { id: "runs", name: "\u5b9f\u884c\u30ed\u30b0", phase: "ops", paths: ["actions/state.json", "logs/runs.md"] }
];

const REQUIRED_FILES = [
  "project.json",
  "inputs/product.md",
  "inputs/notes.md",
  "inputs/source-urls.md",
  "data/products.json",
  "data/research-materials.json",
  "data/facts.json",
  "data/material-extraction-jobs.json",
  "data/strategies.json",
  "data/banner-creatives.json",
  "research/facts.md",
  "strategy/who-what.md",
  "regulations/expression-rules.md",
  "actions/state.json",
  "logs/runs.md"
];

// Serializes read-modify-write access to a single JSON file so that concurrent
// AI generations and row edits (which each do readJson -> mutate -> writeJson)
// cannot race and silently drop each other's update. Keyed per absolute file
// path so unrelated files are never blocked by each other. Callers must not
// call withFileLock again for the same path from inside fn (that would
// deadlock); keep the locked region to just the read/modify/write step and
// run slow work (AI calls, etc.) outside of it.
// エントリはプロセス生存中はファイルパスごとに残る(解決済みPromise1個分)。
// 上限は触ったDBファイル数なのでローカル単一ユーザー用途では解放処理は不要。
const fileLocks = new Map();
const TRANSIENT_RENAME_ERROR_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);
const RENAME_RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800, 1200];

async function acquireProcessFileLock(absolutePath) {
  const lockPath = `${path.resolve(absolutePath)}.cmoai-lock`;
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const startedAt = Date.now();
  while (true) {
    try {
      await fs.mkdir(lockPath);
      return async () => fs.rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > 2 * 60 * 1000) {
          await fs.rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if (statError.code !== "ENOENT") throw statError;
      }
      if (Date.now() - startedAt > 30 * 1000) throw new Error(`ファイル更新ロックの取得がタイムアウトしました: ${absolutePath}`);
      await new Promise((resolve) => setTimeout(resolve, 25 + Math.floor(Math.random() * 50)));
    }
  }
}

export function withFileLock(absolutePath, fn) {
  const key = path.resolve(absolutePath);
  const previous = fileLocks.get(key) || Promise.resolve();
  const execute = async () => {
    const release = await acquireProcessFileLock(key);
    try {
      return await fn();
    } finally {
      await release();
    }
  };
  const run = previous.then(execute, execute);
  fileLocks.set(key, run.catch(() => {}));
  return run;
}

export async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function readText(projectRoot, relativePath) {
  return fs.readFile(path.join(projectRoot, relativePath), "utf8");
}

export async function writeText(projectRoot, relativePath, content) {
  const target = path.join(projectRoot, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

export async function readJson(projectRoot, relativePath) {
  const delays = [0, 25, 75, 150];
  let lastError = null;
  for (const delay of delays) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      const text = await readText(projectRoot, relativePath);
      return JSON.parse(text.replace(/^\uFEFF/, ""));
    } catch (error) {
      if (!isTransientJsonReadError(error)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

export async function writeJson(projectRoot, relativePath, value) {
  const target = path.join(projectRoot, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tempPath = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await replaceFileWithRetry(tempPath, target);
}

// WindowsではDefenderやエディタが保存先を一時的に開いていると、既存ファイルを
// 置換するrenameがEPERM/EACCES/EBUSYになる。原子的置換を維持したまま短時間だけ
// 再試行し、成功・失敗にかかわらず未使用の一時ファイルを残さない。
export async function replaceFileWithRetry(tempPath, target, options = {}) {
  const rename = options.rename || fs.rename;
  const remove = options.remove || fs.rm;
  const sleep = options.sleep || ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const retryDelays = Array.isArray(options.retryDelays) ? options.retryDelays : RENAME_RETRY_DELAYS_MS;
  let retryIndex = 0;
  try {
    while (true) {
      try {
        await rename(tempPath, target);
        return;
      } catch (error) {
        if (!TRANSIENT_RENAME_ERROR_CODES.has(error?.code) || retryIndex >= retryDelays.length) throw error;
        await sleep(retryDelays[retryIndex]);
        retryIndex += 1;
      }
    }
  } finally {
    await remove(tempPath, { force: true }).catch(() => {});
  }
}

function isTransientJsonReadError(error) {
  if (!(error instanceof SyntaxError)) return false;
  return /Unexpected end|Unterminated string|Unexpected token/i.test(error.message || "");
}

export async function listProjects(projectsRoot = path.resolve(process.cwd(), "projects")) {
  await fs.mkdir(projectsRoot, { recursive: true });
  const entries = await fs.readdir(projectsRoot, { withFileTypes: true });
  const projects = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const projectRoot = path.join(projectsRoot, entry.name);
    const projectJsonPath = path.join(projectRoot, "project.json");
    if (!(await pathExists(projectJsonPath))) continue;

    let project = null;
    try {
      project = JSON.parse((await fs.readFile(projectJsonPath, "utf8")).replace(/^\uFEFF/, ""));
    } catch {
      project = { projectName: entry.name, status: "invalid" };
    }

    projects.push({
      id: entry.name,
      name: project.projectName || entry.name,
      productName: project.product?.name || project.productName || "",
      status: project.status || "draft",
      path: `./projects/${entry.name}`,
      isTemplate: entry.name === "_template",
      updatedAt: project.updatedAt || ""
    });
  }

  return projects.sort((a, b) => Number(b.isTemplate) - Number(a.isTemplate) || a.name.localeCompare(b.name, "ja"));
}

const MUTABLE_PROJECT_STATUSES = new Set(["draft", "archived"]);

export async function updateProjectStatus(projectRoot, status) {
  const normalizedStatus = String(status || "").trim();
  if (!MUTABLE_PROJECT_STATUSES.has(normalizedStatus)) {
    const error = new Error("案件ステータスは draft または archived を指定してください。");
    error.code = "INVALID_PROJECT_STATUS";
    throw error;
  }

  const projectJsonPath = path.join(projectRoot, "project.json");
  if (!(await pathExists(projectJsonPath))) {
    const error = new Error("案件が見つかりません。");
    error.code = "PROJECT_NOT_FOUND";
    throw error;
  }

  return withFileLock(projectJsonPath, async () => {
    const project = await readJson(projectRoot, "project.json");
    project.status = normalizedStatus;
    project.updatedAt = new Date().toISOString();
    await writeJson(projectRoot, "project.json", project);
    return project;
  });
}

export async function createProject(projectRoot, options = {}) {
  const templateRoot = path.resolve(process.cwd(), "projects/_template");
  if (await pathExists(projectRoot)) {
    throw new Error(`\u30d7\u30ed\u30b8\u30a7\u30af\u30c8\u306f\u65e2\u306b\u5b58\u5728\u3057\u307e\u3059: ${projectRoot}`);
  }

  await copyDirectory(templateRoot, projectRoot);
  const now = new Date().toISOString();
  const project = await readJson(projectRoot, "project.json");
  project.projectName = options.projectName || path.basename(projectRoot);
  project.status = "draft";
  project.createdAt = now;
  project.updatedAt = now;
  project.product = {
    ...(project.product || {}),
    name: options.productName || project.product?.name || project.productName || "",
    officialUrl: options.officialUrl || project.product?.officialUrl || project.officialUrl || ""
  };
  project.productName = project.product.name;
  project.officialUrl = project.product.officialUrl;
  project.collections = COLLECTIONS.map(({ id, name, phase, paths }) => ({ id, name, phase, paths }));
  await writeJson(projectRoot, "project.json", project);
  return project;
}

async function copyDirectory(source, destination) {
  await fs.mkdir(destination, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const destPath = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyDirectory(sourcePath, destPath);
    else await fs.copyFile(sourcePath, destPath);
  }
}

export async function validateProject(projectRoot) {
  await ensureRuntimeFiles(projectRoot);
  const missing = [];
  const empty = [];
  for (const relativePath of REQUIRED_FILES) {
    const fullPath = path.join(projectRoot, relativePath);
    if (!(await pathExists(fullPath))) {
      missing.push(relativePath);
      continue;
    }
    const stat = await fs.stat(fullPath);
    if (stat.size === 0) empty.push(relativePath);
  }

  let project = null;
  try {
    project = await readJson(projectRoot, "project.json");
  } catch {
    missing.push("project.json(valid json)");
  }

  return {
    ok: missing.length === 0,
    projectRoot,
    project,
    missing,
    empty,
    requiredFiles: REQUIRED_FILES
  };
}


async function ensureRuntimeFiles(projectRoot) {
  const defaults = new Map([
    ["data/strategies.json", []],
    ["data/banner-creatives.json", []],
  ]);
  for (const [relativePath, value] of defaults) {
    const fullPath = path.join(projectRoot, relativePath);
    if (!(await pathExists(fullPath))) await writeJson(projectRoot, relativePath, value);
  }
}

export async function listProjectCollections(projectRoot) {
  const collections = [];
  for (const collection of COLLECTIONS) {
    const files = [];
    for (const relativePath of collection.paths) {
      const fullPath = path.join(projectRoot, relativePath);
      const exists = await pathExists(fullPath);
      let size = 0;
      let type = "file";
      if (exists) {
        const stat = await fs.stat(fullPath);
        size = stat.size;
        type = stat.isDirectory() ? "directory" : "file";
      }
      files.push({ path: relativePath, exists, size, type });
    }
    collections.push({
      ...collection,
      files,
      ok: files.every((file) => file.exists),
      emptyCount: files.filter((file) => file.exists && file.type === "file" && file.size === 0).length
    });
  }
  return collections;
}

export async function appendRunLog(projectRoot, message) {
  const current = await readText(projectRoot, "logs/runs.md").catch(() => "# 実行ログ\n");
  const next = `${current.trim()}\n\n- ${new Date().toISOString()} ${message}\n`;
  await writeText(projectRoot, "logs/runs.md", next);
}

export async function loadState(projectRoot) {
  try {
    return await readJson(projectRoot, "actions/state.json");
  } catch {
    return { schemaVersion: "1.0.0", runs: [] };
  }
}

export async function saveRun(projectRoot, run) {
  await writeJson(projectRoot, `actions/runs/${run.runId}.json`, run);
  const state = await loadState(projectRoot);
  state.runs = [run, ...(state.runs || []).filter((item) => item.runId !== run.runId)].slice(0, 100);
  await writeJson(projectRoot, "actions/state.json", state);
}
