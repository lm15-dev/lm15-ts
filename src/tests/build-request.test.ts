/** Stage C: build_request adapter tests (wire shapes pinned by contract cases). */

import assert from "node:assert/strict";
import { test } from "node:test";

import { handleLine } from "../vet.js";
import { stringifyCanonicalJson, type JsonObject } from "../canonical-json.js";

function build(fields: JsonObject): JsonObject {
  const reply = handleLine(
    stringifyCanonicalJson({ op: "build_request", id: "t", api_key: "test-key-123", ...fields }),
  );
  assert.equal(reply["ok"], true, JSON.stringify(reply));
  return reply["result"] as JsonObject;
}

const USER_HELLO = {
  model: "m",
  messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
};

test("openai responses: url, auth header, stream flag", () => {
  const r = build({ provider: "openai", canonical_request: USER_HELLO, stream: false });
  assert.equal(r["url"], "https://api.openai.com/v1/responses");
  assert.deepEqual(r["headers"], {
    authorization: "Bearer test-key-123",
    "content-type": "application/json",
  });
  const body = r["body"] as JsonObject;
  assert.equal(body["stream"], false);
  assert.deepEqual(body["input"], [
    { role: "user", content: [{ type: "input_text", text: "hi" }] },
  ]);
});

test("anthropic: max_tokens = thinking + visible arithmetic", () => {
  const r = build({
    provider: "anthropic",
    canonical_request: {
      ...USER_HELLO,
      config: { max_tokens: 400, reasoning: { effort: "medium", thinking_budget: 1024 } },
    },
    stream: false,
  });
  const body = r["body"] as JsonObject;
  assert.equal(body["max_tokens"], 1424);
  assert.deepEqual(body["thinking"], { type: "enabled", budget_tokens: 1024 });
  assert.equal((r["headers"] as JsonObject)["x-api-key"], "test-key-123");
});

test("anthropic: total_budget <= thinking_budget rejects", () => {
  const reply = handleLine(
    stringifyCanonicalJson({
      op: "build_request",
      id: "t",
      api_key: "k",
      provider: "anthropic",
      stream: false,
      canonical_request: {
        ...USER_HELLO,
        config: { reasoning: { effort: "medium", thinking_budget: 1024, total_budget: 1024 } },
      },
    }),
  );
  assert.equal(reply["ok"], false);
});

test("gemini: streaming adds alt=sse param and stream endpoint", () => {
  const r = build({ provider: "gemini", canonical_request: USER_HELLO, stream: true });
  assert.equal(
    r["url"],
    "https://generativelanguage.googleapis.com/v1beta/models/m:streamGenerateContent",
  );
  assert.deepEqual(r["params"], { alt: "sse" });
  assert.deepEqual(r["headers"], {
    "x-goog-api-key": "test-key-123",
    "content-type": "application/json",
  });
});

test("gemini: integral float knobs are sent in integer form", () => {
  const r = build({
    provider: "gemini",
    canonical_request: { ...USER_HELLO, config: { temperature: 1.0, top_p: 0.8 } },
    stream: false,
  });
  const bodyText = stringifyCanonicalJson(r["body"]!);
  assert.match(bodyText, /"temperature":1[,}]/);
  assert.match(bodyText, /"topP":0\.8/);
});

test("openai_chat: default policy uses max_completion_tokens; base_url honored", () => {
  const r = build({
    provider: "openai_chat",
    base_url: "http://192.168.2.24:8000/v1",
    canonical_request: { ...USER_HELLO, config: { max_tokens: 512 } },
    stream: false,
  });
  assert.equal(r["url"], "http://192.168.2.24:8000/v1/chat/completions");
  const body = r["body"] as JsonObject;
  assert.equal(body["max_completion_tokens"], 512);
  assert.equal(body["stream"], undefined);
  assert.equal((body["messages"] as JsonObject[])[0]!["content"], "hi");
});

test("openai_chat: streaming includes stream_options.include_usage", () => {
  const r = build({ provider: "openai_chat", canonical_request: USER_HELLO, stream: true });
  const body = r["body"] as JsonObject;
  assert.equal(body["stream"], true);
  assert.deepEqual(body["stream_options"], { include_usage: true });
});

test("openai: float config knobs keep float wire form", () => {
  const r = build({
    provider: "openai",
    canonical_request: { ...USER_HELLO, config: { temperature: 1.0 } },
    stream: false,
  });
  assert.match(stringifyCanonicalJson(r["body"]!), /"temperature":1\.0/);
});
