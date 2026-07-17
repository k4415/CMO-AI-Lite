import { getAnthropicKey } from "./settings-store.js";

const DEFAULT_TEXT_MODEL = process.env.CMOAI_BANNER_COPY_MODEL || process.env.ANTHROPIC_MODEL || "claude-opus-4-8";
const DEFAULT_MAX_TOKENS = Number(process.env.CMOAI_BANNER_COPY_MAX_TOKENS) || 12000;

export async function anthropicJson({
  system,
  user,
  model = DEFAULT_TEXT_MODEL,
  reasoningEffort = "",
  timeoutMs = 0,
  maxTokens = DEFAULT_MAX_TOKENS,
  fetchImpl = fetch
}) {
  const { key } = await getAnthropicKey();
  if (!key) {
    throw new Error("Anthropic APIキーが未設定です。設定画面で保存するか、ANTHROPIC_API_KEYを設定してください。");
  }
  const body = {
    model,
    max_tokens: Math.max(1, Number(maxTokens) || DEFAULT_MAX_TOKENS),
    system: String(system || ""),
    messages: [{ role: "user", content: String(user || "") }]
  };
  const effort = String(reasoningEffort || "").trim();
  if (effort) {
    body.thinking = { type: "adaptive" };
    body.output_config = { effort };
  }
  const res = await fetchAnthropicTextWithRetry("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(body)
  }, {
    fetchImpl,
    timeoutMs: Number(timeoutMs) > 0 ? Number(timeoutMs) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || "Anthropic JSON生成に失敗しました: " + res.status);
  if (String(data.stop_reason || "") === "refusal") {
    throw new Error(data.stop_details?.explanation || "Claudeがコピー設計リクエストを拒否しました。");
  }
  return parseJson(extractAnthropicResponseText(data));
}

export function getAnthropicRequestTimeoutMs(
  value = process.env.CMOAI_BANNER_COPY_TIMEOUT_MS || process.env.ANTHROPIC_TIMEOUT_MS
) {
  if (value === undefined || value === "") return 120000;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120000;
}

export async function fetchAnthropicTextWithRetry(url, options, {
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random = Math.random,
  maxRetries = 2,
  timeoutMs
} = {}) {
  let retryCount = 0;
  while (true) {
    const response = await fetchAnthropicTextOnce(url, options, fetchImpl, timeoutMs);
    if (!shouldRetryAnthropicStatus(response.status) || retryCount >= maxRetries) return response;
    const delayMs = retryDelayMsForResponse(response, retryCount, random);
    await response.body?.cancel?.().catch(() => null);
    retryCount += 1;
    await sleep(delayMs);
  }
}

async function fetchAnthropicTextOnce(url, options, fetchImpl, timeoutMs) {
  const effectiveTimeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : getAnthropicRequestTimeoutMs();
  try {
    return await fetchImpl(url, { ...options, signal: AbortSignal.timeout(effectiveTimeoutMs) });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new Error("Anthropicのコピー設計が時間内に完了しなかったため中断しました。再実行してください。");
    }
    throw error;
  }
}

export function shouldRetryAnthropicStatus(status) {
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

function extractAnthropicResponseText(data) {
  const chunks = [];
  for (const part of Array.isArray(data?.content) ? data.content : []) {
    if (part?.type === "text" && typeof part.text === "string") chunks.push(part.text);
  }
  return chunks.join("").trim();
}

function parseJson(content) {
  const text = String(content || "").trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error("AI応答がJSON形式ではありませんでした。");
  }
}
