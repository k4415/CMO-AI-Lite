import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_GEMINI_VISION_MODEL =
  process.env.CMOAI_GEMINI_VISION_MODEL ||
  process.env.GEMINI_VISION_MODEL ||
  process.env.CMOAI_GEMINI_MODEL ||
  process.env.GEMINI_MODEL ||
  "gemini-2.5-flash";

export function getGeminiKey() {
  return process.env.AI_API_KEY || process.env.GEMINI_API_KEY || readEnvValue("AI_API_KEY") || readEnvValue("GEMINI_API_KEY") || "";
}

export async function geminiVisionText({
  system,
  text,
  images = [],
  projectRoot,
  model = DEFAULT_GEMINI_VISION_MODEL,
  maxOutputTokens = Number(process.env.CMOAI_GEMINI_MAX_OUTPUT_TOKENS || 12000)
}) {
  const key = getGeminiKey();
  if (!key) throw new Error("Gemini APIキーが未設定です。GEMINI_API_KEY または AI_API_KEY を設定してサーバーを再起動してください。");
  const parts = [{ text: [system, text].filter(Boolean).join("\n\n") }];
  for (const image of images) {
    parts.push(await toInlineImagePart(image, projectRoot));
  }
  return callGeminiParts({ key, model, parts, maxOutputTokens });
}

async function callGeminiParts({ key, model, parts, maxOutputTokens }) {
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature: 0,
      topK: 1,
      topP: 0.95,
      maxOutputTokens
    }
  };
  const maxAttempts = 3;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": key
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Number(process.env.CMOAI_GEMINI_TIMEOUT_MS || 180000))
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error?.message || `Gemini API error: ${res.status}`);
      }
      const candidate = data.candidates?.[0] || {};
      const text = (candidate.content?.parts || []).map((part) => part.text || "").join("").trim();
      return {
        text,
        finishReason: candidate.finishReason || null,
        usage: data.usageMetadata || null,
        model
      };
    } catch (error) {
      lastError = error;
      if (!shouldRetryGeminiError(error) || attempt >= maxAttempts) break;
      await sleep(800 * attempt);
    }
  }
  throw lastError;
}

async function toInlineImagePart(value, projectRoot) {
  const source = String(value || "").trim();
  if (!source) throw new Error("画像パスが未設定です。");
  if (/^data:image\//i.test(source)) {
    const match = source.match(/^data:([^;]+);base64,(.+)$/i);
    if (!match) throw new Error("data URL画像を解析できません。");
    return { inlineData: { mimeType: match[1], data: match[2] } };
  }
  const imagePath = resolveImagePath(source, projectRoot);
  const buffer = await fs.readFile(imagePath);
  return {
    inlineData: {
      mimeType: mimeTypeForPath(imagePath),
      data: buffer.toString("base64")
    }
  };
}

function resolveImagePath(source, projectRoot) {
  if (source.startsWith("/project-file")) {
    const url = new URL(source, "http://localhost");
    const relativePath = url.searchParams.get("path") || "";
    if (!relativePath) throw new Error("スクリーンショットの保存パスを解決できません。");
    return path.resolve(projectRoot, relativePath);
  }
  if (source.startsWith("file:")) return fileURLToPath(source);
  if (path.isAbsolute(source)) return source;
  return path.resolve(projectRoot, source.replace(/^[/\\]+/, ""));
}

function mimeTypeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

function shouldRetryGeminiError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return (
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("econnreset") ||
    message.includes("etimedout") ||
    message.includes("timeout") ||
    message.includes("temporarily unavailable") ||
    message.includes(" 429") ||
    message.includes(" 500") ||
    message.includes(" 502") ||
    message.includes(" 503") ||
    message.includes(" 504")
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readEnvValue(name) {
  for (const filePath of envFileCandidates()) {
    try {
      if (!fsSync.existsSync(filePath)) continue;
      const text = fsSync.readFileSync(filePath, "utf8");
      const value = parseEnvValue(text, name);
      if (value) return value;
    } catch {}
  }
  return "";
}

function envFileCandidates() {
  return [
    path.resolve(process.cwd(), ".env.local"),
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "..", ".env.local"),
    path.resolve(process.cwd(), "..", ".env")
  ];
}

function parseEnvValue(text, name) {
  const pattern = new RegExp("^\\s*" + escapeRegExp(name) + "\\s*=\\s*(.*?)\\s*$", "m");
  const match = String(text || "").match(pattern);
  if (!match) return "";
  return String(match[1] || "").trim().replace(/^['"]|['"]$/g, "");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
