import test from "node:test";
import assert from "node:assert/strict";

import { fetchOpenAiTextWithRetry, openAiJson, retryDelayMsForResponse, shouldRetryOpenAiStatus } from "../src/core/openai-text.js";

process.env["OPENAI_API_KEY"] = "test-key";

test("text API retries only 408, 429, and OpenAI 5xx responses", () => {
  assert.equal(shouldRetryOpenAiStatus(408), true);
  assert.equal(shouldRetryOpenAiStatus(429), true);
  assert.equal(shouldRetryOpenAiStatus(500), true);
  assert.equal(shouldRetryOpenAiStatus(503), true);
  assert.equal(shouldRetryOpenAiStatus(400), false);
  assert.equal(shouldRetryOpenAiStatus(401), false);
});

test("Retry-After takes precedence over exponential backoff", () => {
  const response = { headers: new Headers({ "retry-after": "3" }) };
  assert.equal(retryDelayMsForResponse(response, 0, () => 0.5), 3000);
  assert.equal(retryDelayMsForResponse({ headers: new Headers() }, 1, () => 0), 2000);
});

test("text API retries at most twice and returns the successful response", async () => {
  const statuses = [429, 503, 200];
  const waits = [];
  const response = await fetchOpenAiTextWithRetry("https://example.test", {}, {
    fetchImpl: async () => new Response("{}", { status: statuses.shift() }),
    sleep: async (ms) => waits.push(ms),
    random: () => 0
  });

  assert.equal(response.status, 200);
  assert.deepEqual(waits, [1000, 2000]);
  assert.equal(statuses.length, 0);
});

test("openAiJson passes reasoning_effort and per-call timeout when provided", async () => {
  let captured = null;
  const fetchImpl = async (url, options) => {
    captured = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: "{\"ok\":true}" } }] }), { status: 200 });
  };
  const result = await openAiJson({
    system: "s", user: "u", reasoningEffort: "medium", timeoutMs: 120000, fetchImpl
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(captured.reasoning_effort, "medium");
});

test("openAiJson omits reasoning_effort by default", async () => {
  let captured = null;
  const fetchImpl = async (url, options) => {
    captured = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 });
  };
  await openAiJson({ system: "s", user: "u", fetchImpl });
  assert.equal("reasoning_effort" in captured, false);
});
