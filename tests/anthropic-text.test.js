import test from "node:test";
import assert from "node:assert/strict";

import {
  anthropicJson,
  fetchAnthropicTextWithRetry,
  getAnthropicRequestTimeoutMs,
  retryDelayMsForResponse,
  shouldRetryAnthropicStatus
} from "../src/core/anthropic-text.js";

process.env["ANTHROPIC_API_KEY"] = "test-key";

test("Anthropic API retries only 408, 429, and 5xx responses", () => {
  assert.equal(shouldRetryAnthropicStatus(408), true);
  assert.equal(shouldRetryAnthropicStatus(429), true);
  assert.equal(shouldRetryAnthropicStatus(500), true);
  assert.equal(shouldRetryAnthropicStatus(503), true);
  assert.equal(shouldRetryAnthropicStatus(400), false);
  assert.equal(shouldRetryAnthropicStatus(401), false);
});

test("Anthropic Retry-After takes precedence over exponential backoff", () => {
  const response = { headers: new Headers({ "retry-after": "3" }) };
  assert.equal(retryDelayMsForResponse(response, 0, () => 0.5), 3000);
  assert.equal(retryDelayMsForResponse({ headers: new Headers() }, 1, () => 0), 2000);
});

test("Anthropic API retries at most twice and returns the successful response", async () => {
  const statuses = [429, 503, 200];
  const waits = [];
  const response = await fetchAnthropicTextWithRetry("https://example.test", {}, {
    fetchImpl: async () => new Response("{}", { status: statuses.shift() }),
    sleep: async (ms) => waits.push(ms),
    random: () => 0
  });

  assert.equal(response.status, 200);
  assert.deepEqual(waits, [1000, 2000]);
  assert.equal(statuses.length, 0);
});

test("anthropicJson passes adaptive thinking and output_config when effort is provided", async () => {
  let captured = null;
  const fetchImpl = async (_url, options) => {
    captured = JSON.parse(options.body);
    return new Response(JSON.stringify({ content: [{ type: "text", text: "{\"ok\":true}" }] }), { status: 200 });
  };
  const result = await anthropicJson({
    system: "s",
    user: "u",
    reasoningEffort: "high",
    timeoutMs: 120000,
    fetchImpl
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(captured.thinking, { type: "adaptive" });
  assert.deepEqual(captured.output_config, { effort: "high" });
});

test("anthropicJson omits thinking fields by default", async () => {
  let captured = null;
  const fetchImpl = async (_url, options) => {
    captured = JSON.parse(options.body);
    return new Response(JSON.stringify({ content: [{ type: "text", text: "{}" }] }), { status: 200 });
  };
  await anthropicJson({ system: "s", user: "u", fetchImpl });
  assert.equal("thinking" in captured, false);
  assert.equal("output_config" in captured, false);
});

test("Anthropic timeout helper falls back to 120000ms", () => {
  assert.equal(getAnthropicRequestTimeoutMs("2500"), 2500);
  assert.equal(getAnthropicRequestTimeoutMs(""), 120000);
});
