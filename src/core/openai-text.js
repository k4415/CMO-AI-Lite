import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getOpenAiKey } from "./settings-store.js";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_TEXT_MODEL = process.env.CMOAI_TEXT_MODEL || process.env.OPENAI_TEXT_MODEL || "gpt-5.5";
const DEFAULT_VISION_MODEL = process.env.CMOAI_VISION_MODEL || process.env.OPENAI_VISION_MODEL || "gpt-5.5";

export async function openAiJson({
  system,
  user,
  model = DEFAULT_TEXT_MODEL,
  reasoningEffort = "",
  timeoutMs = 0,
  fetchImpl = fetch
}) {
  const { key } = await getOpenAiKey();
  if (!key) throw new Error("OpenAI API\u30ad\u30fc\u304c\u672a\u8a2d\u5b9a\u3067\u3059\u3002\u8a2d\u5b9a\u753b\u9762\u3067\u4fdd\u5b58\u3059\u308b\u304b\u3001OPENAI_API_KEY\u3092\u8a2d\u5b9a\u3057\u3066\u304f\u3060\u3055\u3044\u3002");
  const body = {
    model,
    response_format: { type: "json_object" },
    messages: [{ role: "system", content: system }, { role: "user", content: user }]
  };
  const effort = String(reasoningEffort || "").trim();
  if (effort) body.reasoning_effort = effort;
  const res = await fetchOpenAiTextWithRetry("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer " + key, "content-type": "application/json" },
    body: JSON.stringify(body)
  }, {
    fetchImpl,
    timeoutMs: Number(timeoutMs) > 0 ? Number(timeoutMs) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || "OpenAI JSON\u751f\u6210\u306b\u5931\u6557\u3057\u307e\u3057\u305f: " + res.status);
  return parseJson(data.choices?.[0]?.message?.content || "");
}

// Web検索(ブラウジング)付きのJSON生成。Responses APIの web_search ツールでモデル自身に検索させ、
// 出力JSONをパースして返す。事実抽出など「登録資料+Web検索」を前提にする処理で使う。
// タイムアウト既定10分。CMOAI_OPENAI_WEBSEARCH_TIMEOUT_MS=0 で無制限(ハング注意)。
// ツール名は CMOAI_OPENAI_WEBSEARCH_TOOL で上書き可(既定 web_search)。
export async function openAiJsonWebSearch({ system, user, model = DEFAULT_TEXT_MODEL }) {
  const { key } = await getOpenAiKey();
  if (!key) throw new Error("OpenAI APIキーが未設定です。設定画面で保存するか、OPENAI_API_KEYを設定してください。");
  const timeoutRaw = process.env.CMOAI_OPENAI_WEBSEARCH_TIMEOUT_MS;
  const timeoutMs = timeoutRaw === undefined || timeoutRaw === "" ? 600000 : Number(timeoutRaw);
  const signal = Number.isFinite(timeoutMs) && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
  const toolType = process.env.CMOAI_OPENAI_WEBSEARCH_TOOL || "web_search";
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer " + key, "content-type": "application/json" },
    signal,
    body: JSON.stringify({
      model,
      instructions: system,
      input: user + "\n\n必ず有効なJSONオブジェクトのみを出力してください。",
      tools: [{ type: toolType }],
      max_output_tokens: Number(process.env.CMOAI_OPENAI_WEBSEARCH_MAX_OUTPUT_TOKENS || 16000)
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || "OpenAI Web検索生成に失敗しました: " + res.status);
  return parseJson(extractResponseText(data));
}

export async function openAiText({ system, user, model = DEFAULT_TEXT_MODEL }) {
  const { key } = await getOpenAiKey();
  if (!key) throw new Error("OpenAI API\u30ad\u30fc\u304c\u672a\u8a2d\u5b9a\u3067\u3059\u3002\u8a2d\u5b9a\u753b\u9762\u3067\u4fdd\u5b58\u3059\u308b\u304b\u3001OPENAI_API_KEY\u3092\u8a2d\u5b9a\u3057\u3066\u304f\u3060\u3055\u3044\u3002");
  const res = await fetchOpenAiText("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer " + key, "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: user }] })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || "OpenAI\u30c6\u30ad\u30b9\u30c8\u751f\u6210\u306b\u5931\u6557\u3057\u307e\u3057\u305f: " + res.status);
  return String(data.choices?.[0]?.message?.content || "").trim();
}

export function getTextRequestTimeoutMs(value = process.env.CMOAI_OPENAI_TEXT_TIMEOUT_MS) {
  if (value === undefined || value === "") return 600000;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 600000;
}

async function fetchOpenAiText(url, options) {
  return fetchOpenAiTextWithRetry(url, options);
}

export async function fetchOpenAiTextWithRetry(url, options, {
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random = Math.random,
  maxRetries = 2,
  timeoutMs
} = {}) {
  let retryCount = 0;
  while (true) {
    const response = await fetchOpenAiTextOnce(url, options, fetchImpl, timeoutMs);
    if (!shouldRetryOpenAiStatus(response.status) || retryCount >= maxRetries) return response;
    const delayMs = retryDelayMsForResponse(response, retryCount, random);
    await response.body?.cancel?.().catch(() => null);
    retryCount += 1;
    await sleep(delayMs);
  }
}

async function fetchOpenAiTextOnce(url, options, fetchImpl, timeoutMs) {
  const effectiveTimeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : getTextRequestTimeoutMs();
  try {
    return await fetchImpl(url, { ...options, signal: AbortSignal.timeout(effectiveTimeoutMs) });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new Error("OpenAIのコピー設計が時間内に完了しなかったため中断しました。再実行してください。");
    }
    throw error;
  }
}

export function shouldRetryOpenAiStatus(status) {
  const code = Number(status);
  return code === 408 || code === 429 || (code >= 500 && code <= 599);
}

export function retryDelayMsForResponse(response, retryCount, random = Math.random) {
  const retryAfter = String(response?.headers?.get?.("retry-after") || "").trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  const base = 1000 * (2 ** Math.max(0, Number(retryCount) || 0));
  return Math.round(base + Math.max(0, Number(random()) || 0) * 250);
}

export function getVisionJsonRequestTimeoutMs(value = process.env.CMOAI_OPENAI_VISION_TIMEOUT_MS) {
  if (value === undefined || value === "") return 600000;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 600000;
}

async function fetchOpenAiVisionJson(url, options) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(getVisionJsonRequestTimeoutMs()) });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new Error("OpenAIのテンプレート画像解析が10分以内に完了しなかったため中断しました。再実行してください。");
    }
    throw error;
  }
}

export async function openAiVisionJson({ system, text, image, projectRoot, model = DEFAULT_VISION_MODEL }) {
  const { key } = await getOpenAiKey();
  if (!key) throw new Error("OpenAI API\u30ad\u30fc\u304c\u672a\u8a2d\u5b9a\u3067\u3059\u3002\u8a2d\u5b9a\u753b\u9762\u3067\u4fdd\u5b58\u3059\u308b\u304b\u3001OPENAI_API_KEY\u3092\u8a2d\u5b9a\u3057\u3066\u304f\u3060\u3055\u3044\u3002");
  const imageUrl = await toImageUrl(image, projectRoot);
  const res = await fetchOpenAiVisionJson("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer " + key, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      response_format: { type: "json_object" },
      messages: [{
        role: "user",
        content: [
          { type: "text", text: system + "\n\n" + text },
          { type: "image_url", image_url: { url: imageUrl } }
        ]
      }]
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || "OpenAI\u753b\u50cf\u5206\u6790\u306b\u5931\u6557\u3057\u307e\u3057\u305f: " + res.status);
  return parseJson(data.choices?.[0]?.message?.content || "");
}

export async function openAiVisionText({ system, text, image, projectRoot, model = DEFAULT_VISION_MODEL }) {
  const { key } = await getOpenAiKey();
  if (!key) throw new Error("OpenAI API\u30ad\u30fc\u304c\u672a\u8a2d\u5b9a\u3067\u3059\u3002\u8a2d\u5b9a\u753b\u9762\u3067\u4fdd\u5b58\u3059\u308b\u304b\u3001OPENAI_API_KEY\u3092\u8a2d\u5b9a\u3057\u3066\u304f\u3060\u3055\u3044\u3002");
  const imageUrl = await toImageUrl(image, projectRoot);
  // 画像文字起こしの1枚あたりの最大待ち時間(ハングした接続の保険)。既定10分。
  // CMOAI_OPENAI_VISION_TIMEOUT_MS=0 で上限を完全撤廃(無制限)にできる。ただし無制限だと
  // OpenAI側が無応答のまま切断もされないとき fetch が永久にハングし、そのジョブが実行中の
  // まま固まって再実行もできなくなる点に注意(サーバー再起動が必要になる)。
  const visionTimeoutRaw = process.env.CMOAI_OPENAI_VISION_TIMEOUT_MS;
  const visionTimeoutMs = visionTimeoutRaw === undefined || visionTimeoutRaw === "" ? 600000 : Number(visionTimeoutRaw);
  const visionSignal = Number.isFinite(visionTimeoutMs) && visionTimeoutMs > 0 ? AbortSignal.timeout(visionTimeoutMs) : undefined;
  const useResponses = String(process.env.CMOAI_OPENAI_VISION_API || "responses").toLowerCase() !== "chat";
  if (useResponses) {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer " + key, "content-type": "application/json" },
      signal: visionSignal,
      body: JSON.stringify({
        model,
        input: [{
          role: "user",
          content: [
            { type: "input_text", text: system + "\n\n" + text },
            { type: "input_image", image_url: imageUrl, detail: process.env.CMOAI_OPENAI_IMAGE_DETAIL || "original" }
          ]
        }],
        max_output_tokens: Number(process.env.CMOAI_OPENAI_VISION_MAX_OUTPUT_TOKENS || 12000)
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || "OpenAI\u753b\u50cf\u6587\u5b57\u8d77\u3053\u3057\u306b\u5931\u6557\u3057\u307e\u3057\u305f: " + res.status);
    return extractResponseText(data);
  }
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer " + key, "content-type": "application/json" },
    signal: visionSignal,
    body: JSON.stringify({
      model,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: system + "\n\n" + text },
          { type: "image_url", image_url: { url: imageUrl, detail: process.env.CMOAI_OPENAI_IMAGE_DETAIL || "high" } }
        ]
      }]
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || "OpenAI\u753b\u50cf\u6587\u5b57\u8d77\u3053\u3057\u306b\u5931\u6557\u3057\u307e\u3057\u305f: " + res.status);
  return String(data.choices?.[0]?.message?.content || "").trim();
}

function extractResponseText(data) {
  if (typeof data.output_text === "string" && data.output_text.trim()) return data.output_text.trim();
  const chunks = [];
  for (const item of data.output || []) {
    for (const part of item.content || []) {
      if (typeof part.text === "string") chunks.push(part.text);
    }
  }
  return chunks.join("").trim();
}

async function toImageUrl(value, projectRoot) {
  const source = String(value || "").trim();
  if (!source) throw new Error("\u753b\u50cfURL\u307e\u305f\u306f\u753b\u50cf\u30d1\u30b9\u304c\u672a\u8a2d\u5b9a\u3067\u3059\u3002");
  if (/^https?:\/\//i.test(source) || /^data:image\//i.test(source)) return source;
  if (source.startsWith("/project-file")) {
    const parsed = new URL(source, "http://local.cmoai");
    const relativePath = parsed.searchParams.get("path") || "";
    const resolvedProjectFile = path.resolve(projectRoot, relativePath);
    if (!resolvedProjectFile.startsWith(path.resolve(projectRoot))) throw new Error("\u30d7\u30ed\u30b8\u30a7\u30af\u30c8\u5916\u306e\u753b\u50cf\u30d1\u30b9\u306f\u53c2\u7167\u3067\u304d\u307e\u305b\u3093\u3002");
    const ext = path.extname(resolvedProjectFile).toLowerCase();
    const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
    const data = await fs.readFile(resolvedProjectFile);
    return `data:${mime};base64,${data.toString("base64")}`;
  }
  if (source.startsWith("/shared-file")) {
    const parsed = new URL(source, "http://local.cmoai");
    const relativePath = parsed.searchParams.get("path") || "";
    const sharedRoot = path.join(appRoot, "data");
    const resolvedSharedFile = path.resolve(sharedRoot, relativePath);
    if (!resolvedSharedFile.startsWith(sharedRoot)) throw new Error("\u5171\u6709\u30c7\u30a3\u30ec\u30af\u30c8\u30ea\u5916\u306e\u753b\u50cf\u30d1\u30b9\u306f\u53c2\u7167\u3067\u304d\u307e\u305b\u3093\u3002");
    const ext = path.extname(resolvedSharedFile).toLowerCase();
    const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
    const data = await fs.readFile(resolvedSharedFile);
    return `data:${mime};base64,${data.toString("base64")}`;
  }
  const resolved = path.resolve(projectRoot, source);
  if (!resolved.startsWith(path.resolve(projectRoot))) throw new Error("\u30d7\u30ed\u30b8\u30a7\u30af\u30c8\u5916\u306e\u753b\u50cf\u30d1\u30b9\u306f\u53c2\u7167\u3067\u304d\u307e\u305b\u3093\u3002");
  const ext = path.extname(resolved).toLowerCase();
  const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
  const data = await fs.readFile(resolved);
  return `data:${mime};base64,${data.toString("base64")}`;
}

function parseJson(content) {
  const text = String(content || "").trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  try { return JSON.parse(text); } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error("AI\u5fdc\u7b54\u304cJSON\u5f62\u5f0f\u3067\u306f\u3042\u308a\u307e\u305b\u3093\u3067\u3057\u305f\u3002");
  }
}
