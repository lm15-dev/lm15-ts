import { test } from "node:test";
import assert from "node:assert/strict";
import { adapterFor } from "../src/providers.ts";
import { GeminiLM } from "../src/dialects/gemini.ts";
import { OpenAILM } from "../src/dialects/openai_responses.ts";
import { Message } from "../src/types/parts.ts";
import type { JsonObject, JsonValue } from "../src/json.ts";

// MAP-17: a function tool with no description reaches every wire with no
// description key, never `"description": null`. The contract's
// tool_no_description cases pin the absent wire through the vet shim; this
// adds what canonical JSON cannot carry (`""`, which serializes as absent) and
// the paths no case pins (a Gemini cached prefix, a batch body).

const SCHEMA = { type: "object", properties: { city: { type: "string" } } };
const tool = (description?: string) => ({ type: "function" as const, name: "get_weather", ...(description === undefined ? {} : { description }), parameters: SCHEMA });
const body = (bytes: Uint8Array | undefined) => JSON.parse(new TextDecoder().decode(bytes)) as JsonObject;

function declarations(value: JsonValue | undefined, out: JsonObject[] = []): JsonObject[] {
  if (Array.isArray(value)) for (const v of value) declarations(v, out);
  else if (value !== null && typeof value === "object") {
    const o = value as JsonObject;
    if (o["name"] === "get_weather" && ("parameters" in o || "input_schema" in o || "parametersJsonSchema" in o)) out.push(o);
    for (const v of Object.values(o)) declarations(v, out);
  }
  return out;
}

function only(value: JsonValue): JsonObject {
  const found = declarations(value);
  assert.equal(found.length, 1, JSON.stringify(value));
  return found[0]!;
}

for (const description of [undefined, ""]) {
  const label = description === undefined ? "absent" : "empty";
  for (const provider of ["anthropic", "openai", "openai-chat", "gemini", "groq", "xai"]) {
    test(`MAP-17: ${label} description is left off the ${provider} wire`, async () => {
      const lm = adapterFor(provider, { apiKey: "k" });
      const req = { model: "m-1", messages: [Message.user("hi")], tools: [tool(description)], config: { maxTokens: 64 } };
      const decl = only(body((await lm.buildRequest(req, false)).body));
      assert.ok(!("description" in decl), JSON.stringify(decl));
      const keys = Object.keys(decl).filter((k) => k !== "type");
      assert.equal(keys[0], "name");
    });
  }

  test(`MAP-17: ${label} description is left off both live setup frames`, () => {
    const frames: JsonValue[] = [
      ...new OpenAILM({ apiKey: "k" }).liveSetupFrames({ model: "gpt-realtime-mini", tools: [tool(description)] }),
      ...new GeminiLM({ apiKey: "k" }).liveSetupFrames({ model: "gemini-3.1-flash-live-preview", tools: [tool(description)] }),
    ];
    for (const frame of frames) assert.ok(!("description" in only(frame)));
  });

  test(`MAP-17: ${label} description is left off a Gemini cached prefix and an Anthropic batch`, async () => {
    const prefix = { model: "gemini-2.5-flash", messages: [Message.user("a long stable prefix")], tools: [tool(description)] };
    assert.ok(!("description" in only(body((await new GeminiLM({ apiKey: "k" }).cacheCreateRequest(prefix, 300)).body))));
    const nested = { model: "claude-haiku-4-5", messages: [Message.user("hi")], tools: [tool(description)], config: { maxTokens: 64 } };
    const batch = await adapterFor("anthropic", { apiKey: "k" }).batchSubmitRequest({ requests: [nested] } as never);
    assert.ok(!("description" in only(body(batch.body))));
  });
}

test("MAP-17: a present description keeps its slot right after the name", async () => {
  for (const provider of ["anthropic", "openai", "openai-chat", "gemini"]) {
    const lm = adapterFor(provider, { apiKey: "k" });
    const decl = only(body((await lm.buildRequest({ model: "m-1", messages: [Message.user("hi")], tools: [tool("Weather for a city")] }, false)).body));
    const keys = Object.keys(decl);
    assert.equal(keys[keys.indexOf("name") + 1], "description", provider);
    assert.equal(decl["description"], "Weather for a city");
  }
});
