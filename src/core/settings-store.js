import fs from "node:fs/promises";
import path from "node:path";

const SETTINGS_DIR = path.resolve(process.cwd(), "local-secrets");
const OPENAI_PATH = path.join(SETTINGS_DIR, "openai.json");
const BROWSER_PATH = path.join(SETTINGS_DIR, "browser.json");

export async function getOpenAiKey() {
  if (process.env.OPENAI_API_KEY) return { key: process.env.OPENAI_API_KEY, source: "env" };
  try {
    const data = JSON.parse(await fs.readFile(OPENAI_PATH, "utf8"));
    return { key: String(data.apiKey || ""), source: "local" };
  } catch {
    return { key: "", source: "none" };
  }
}

export async function getOpenAiSettingsStatus() {
  const { key, source } = await getOpenAiKey();
  return { configured: Boolean(key), source, maskedKey: maskKey(key) };
}

export async function saveOpenAiKey(apiKey) {
  const clean = String(apiKey || "").trim();
  if (!clean) throw new Error("OpenAI APIキーを入力してください。");
  await fs.mkdir(SETTINGS_DIR, { recursive: true });
  await fs.writeFile(OPENAI_PATH, JSON.stringify({ apiKey: clean, updatedAt: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 });
  try { await fs.chmod(OPENAI_PATH, 0o600); } catch {}
  return getOpenAiSettingsStatus();
}

// スクショ取得用ブラウザの実行ファイルパス。CHROME_PATH環境変数 > 保存済みパス の優先順。
export async function getChromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  try {
    const data = JSON.parse(await fs.readFile(BROWSER_PATH, "utf8"));
    return String(data.executablePath || "");
  } catch {
    return "";
  }
}

export async function saveChromePath(executablePath) {
  const clean = String(executablePath || "").trim();
  await fs.mkdir(SETTINGS_DIR, { recursive: true });
  await fs.writeFile(BROWSER_PATH, JSON.stringify({ executablePath: clean, updatedAt: new Date().toISOString() }, null, 2) + "\n");
  return clean;
}

function maskKey(key) {
  if (!key) return "";
  if (key.length <= 10) return "********";
  return key.slice(0, 7) + "..." + key.slice(-4);
}
