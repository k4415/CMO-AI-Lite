import path from "node:path";

export function resolveProjectPath(projectPath) {
  const normalized = normalizeProjectPath(projectPath);
  if (!normalized) throw new Error("--project が必要です");
  return path.resolve(process.cwd(), normalized);
}

export function normalizeProjectPath(projectPath) {
  return String(projectPath || "")
    .replace(/\u3000/g, " ")
    .trim();
}

export function toPosix(filePath) {
  return filePath.split(path.sep).join("/");
}