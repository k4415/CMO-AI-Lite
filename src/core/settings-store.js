import fs from "node:fs/promises";
import path from "node:path";

const SETTINGS_DIR = path.resolve(process.cwd(), "local-secrets");
const OPENAI_PATH = path.join(SETTINGS_DIR, "openai.json");
const ANTHROPIC_PATH = path.join(SETTINGS_DIR, "anthropic.json");
const BROWSER_PATH = path.join(SETTINGS_DIR, "browser.json");

export async function getOpenAiKey() {
  return readApiKey({
    envKey: "OPENAI_API_KEY",
    filePath: OPENAI_PATH
  });
}

export async function getOpenAiSettingsStatus() {
  const { key, source } = await getOpenAiKey();
  return { configured: Boolean(key), source, maskedKey: maskKey(key) };
}

export async function saveOpenAiKey(apiKey) {
  await saveApiKey(apiKey, OPENAI_PATH, "OpenAI APIキーを入力してください。");
  return getOpenAiSettingsStatus();
}

export async function getAnthropicKey() {
  return readApiKey({
    envKey: "ANTHROPIC_API_KEY",
    filePath: ANTHROPIC_PATH
  });
}

export async function getAnthropicSettingsStatus() {
  const { key, source } = await getAnthropicKey();
  return { configured: Boolean(key), source, maskedKey: maskKey(key) };
}

export async function saveAnthropicKey(apiKey) {
  await saveApiKey(apiKey, ANTHROPIC_PATH, "Anthropic APIキーを入力してください。");
  return getAnthropicSettingsStatus();
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

async function readApiKey({ envKey, filePath }) {
  if (process.env[envKey]) return { key: process.env[envKey], source: "env" };
  try {
    const data = JSON.parse(await fs.readFile(filePath, "utf8"));
    return { key: String(data.apiKey || ""), source: "local" };
  } catch {
    return { key: "", source: "none" };
  }
}

async function saveApiKey(apiKey, filePath, emptyMessage) {
  const clean = String(apiKey || "").trim();
  if (!clean) throw new Error(emptyMessage);
  await fs.mkdir(SETTINGS_DIR, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify({ apiKey: clean, updatedAt: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 });
  try { await fs.chmod(filePath, 0o600); } catch {}
}
