import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { GeminiLM } from "../src/dialects/gemini.ts";
import { OpenAIChatLM } from "../src/dialects/openai_chat.ts";
import { OpenAILM } from "../src/dialects/openai_responses.ts";
import { XaiLM } from "../src/dialects/xai.ts";
import { ProviderError, UnsupportedFeatureError } from "../src/errors.ts";
import { RawNumber, stringifyJson, type JsonObject } from "../src/json.ts";
import { TlsEngine } from "../src/tunnel/tls.ts";
import { Adaptation } from "../src/types/adaptation.ts";
import { Config, Request, type Config as ConfigType } from "../src/types/config.ts";
import { ImageGenerationRequest } from "../src/types/endpoints.ts";
import { InferenceModelInfo, InferencePricing, ModelInfo, ModelOrigin, PricingTier } from "../src/types/model_info.ts";
import { Message, Part, data, type DataPart, type Part as PartType } from "../src/types/parts.ts";
import { Response, TokenLogprob, Usage, type Usage as UsageType } from "../src/types/response.ts";
import { Delta, StreamEvent, type Delta as DeltaType, type StreamEvent as StreamEventType } from "../src/types/stream.ts";
import { ValueError } from "../src/types/validate.ts";
import { HttpResponse } from "../src/wire.ts";

function frame(shape: string, name: unknown, omit = false): string {
  const call = { id: "call-preserved", args: { city: "Montreal" }, ...(omit ? {} : { name }) };
  return JSON.stringify(shape === "toolCall" ? { toolCall: { functionCalls: [call] } } : { serverContent: { modelTurn: { parts: [{ functionCall: call }] } } });
}

for (const shape of ["toolCall", "modelTurn"]) {
  for (const [label, name, omit] of [["missing", null, true], ["null", null, false], ["empty", "", false], ["number", 123, false]] as const) {
    test(`live ${shape}: ${label} tool name is refused, never invented`, () => {
      assert.throws(() => new GeminiLM({ apiKey: "fixture" }).decodeLiveServerEvent(frame(shape, name, omit)),
        (e: unknown) => e instanceof ProviderError && /no name/.test(e.message));
    });
  }
  for (const name of ["get_weather", "tool"]) {
    test(`live ${shape}: explicit ${name} and its correlator stay verbatim`, () => {
      assert.deepEqual(new GeminiLM({ apiKey: "fixture" }).decodeLiveServerEvent(frame(shape, name)), [
        { type: "tool_call", name, id: "call-preserved", input: { city: "Montreal" } },
      ]);
    });
  }
}

for (const [feature, field] of [["reasoning_effort_switch", "config.reasoning.effort"], ["response_format_json_schema", "config.response_format"]]) {
  test(`Tinker ${feature}: visible adaptation and strict pre-wire refusal`, async () => {
    const fixture = JSON.parse(readFileSync(new URL(`../../lm15-contract/cases/tinker/${feature}.json`, import.meta.url), "utf8"));
    const request = Request.fromJSON(fixture.canonical_request);
    const notes = await new OpenAIChatLM({ apiKey: "fixture", compat: "tinker" }).plan(request);
    assert.equal(notes.length, 1);
    assert.equal(notes[0]?.field, field);
    const expected = fixture.expect_lm15.adaptations[0];
    assert.equal(notes[0]?.action, expected.action);
    assert.deepEqual(notes[0]?.asked, expected.asked);
    if ("applied" in expected) assert.deepEqual(notes[0]?.applied, expected.applied);
    await assert.rejects(new OpenAIChatLM({ apiKey: "fixture", compat: "tinker", adaptations: "refuse" }).buildRequest(request, false),
      (e: unknown) => e instanceof UnsupportedFeatureError && e.feature === field);
  });
}

function openaiLiveFrame(name: unknown, omit = false): string {
  const item = {
    id: "item_1",
    type: "function_call",
    status: "completed",
    call_id: "call-preserved",
    arguments: '{"city":"Montreal"}',
    ...(omit ? {} : { name }),
  };
  return JSON.stringify({ type: "response.output_item.done", output_index: 0, item });
}

for (const [label, name, omit] of [["missing", null, true], ["null", null, false], ["empty", "", false], ["number", 123, false]] as const) {
  test(`OpenAI live: ${label} tool name is refused, never invented`, () => {
    assert.throws(() => new OpenAILM({ apiKey: "fixture" }).decodeLiveServerEvent(openaiLiveFrame(name, omit)),
      (e: unknown) => e instanceof ProviderError && e.provider === "openai" && /no name/.test(e.message));
  });
}

for (const name of ["get_weather", "tool"]) {
  test(`OpenAI live: explicit ${name} and its correlator stay verbatim`, () => {
    assert.deepEqual(new OpenAILM({ apiKey: "fixture" }).decodeLiveServerEvent(openaiLiveFrame(name)), [
      { type: "tool_call", name, id: "call-preserved", input: { city: "Montreal" } },
    ]);
  });
}

test("toJSON helpers reject unvalidated plain objects and post-construction NaN/Infinity mutations", () => {
  assert.throws(() => Config.toJSON({ temperature: 99 } as unknown as ConfigType), ValueError);
  assert.throws(() => Config.toJSON({ topK: 2.5 } as unknown as ConfigType), TypeError);
  assert.throws(() => Usage.toJSON({ inputTokens: -1 } as unknown as UsageType), ValueError);
  assert.throws(() => Usage.toJSON({ inputTokens: 2, cacheReadTokens: 5 } as unknown as UsageType), ValueError);
  assert.throws(() => Part.toJSON({ type: "image" } as unknown as PartType), ValueError);
  assert.throws(() => Delta.toJSON({ type: "citation" } as unknown as DeltaType), ValueError);
  assert.throws(() => StreamEvent.toJSON({ type: "bogus" } as unknown as StreamEventType), ValueError);
  assert.throws(() => Response.toJSON({ model: "m" } as unknown as Response), TypeError);

  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => InferencePricing.create({ inputPerMillion: bad }), ValueError);
    assert.throws(() => PricingTier.create({ aboveInputTokens: 1000, outputPerMillion: bad }), ValueError);
    assert.throws(() => TokenLogprob.create({ token: "hi", logprob: bad }), TypeError);
    assert.throws(() => Adaptation.create({ field: "config.seed", action: "dropped", reason: "r", asked: bad as unknown as number }), TypeError);
    assert.throws(() => InferencePricing.create({ dimensions: { bad } }), TypeError);
    assert.throws(() => InferenceModelInfo.create({ extensions: { bad } }), TypeError);
    assert.throws(() => ModelOrigin.create({ providerData: { bad } }), TypeError);
    assert.throws(() => ModelInfo.create({ id: "m", provider: "openai", apiFamily: "openai_responses", extensions: { bad } }), TypeError);
  }

  const ext: JsonObject = { ok: 1 };
  const cfg = Config.create({ extensions: ext });
  (ext as Record<string, unknown>)["bad"] = Number.NaN;
  assert.throws(() => Config.toJSON(cfg), TypeError);
});

test("JSON.stringify(response) serializes integral floats and 64-bit RawNumbers without crashing", () => {
  const response = new Response({
    id: "resp_1",
    model: "jev-1",
    message: Message.assistant(
      Part.create({
        type: "data",
        value: { id: new RawNumber("9007199254740993"), ratio: new RawNumber("1.0") },
        probabilities: { answer: { yes: 1, no: 0 } },
        method: "provider_classification",
      }) as DataPart,
    ),
    finishReason: "stop",
    usage: Usage.create({ inputTokens: 10, outputTokens: 2 }),
    logprobs: [TokenLogprob.create({ token: "yes", logprob: 0 })],
  });
  const canonical = stringifyJson(Response.toJSON(response));
  assert.equal(JSON.stringify(response), canonical);
  assert.equal(JSON.stringify({ response }), `{"response":${canonical}}`);
  // Direct RawNumber.toJSON still guards callers against accidental lossy serialization.
  assert.throws(() => JSON.stringify(new RawNumber("1.0")), TypeError);
  assert.equal((data({ x: 1 }).value as JsonObject)["x"], 1);
});

test("image generation records unmapped data[] items and bundled TLS wasm loads", async () => {
  const req = ImageGenerationRequest.create({ model: "gpt-image-1", prompt: "owl" });
  const body = new TextEncoder().encode(JSON.stringify({ output_format: "png", data: [{ b64_json: "YWJj" }, { revised_only: "x" }, "bad"] }));
  const resp = new HttpResponse({ status: 200, headers: [["content-type", "application/json"]], body });
  const openaiOut = new OpenAILM({ apiKey: "fixture" }).imageGenerationFromResponse(req, resp);
  assert.deepEqual(openaiOut.providerData?.["_lm15_unmapped"], [
    { path: "data[1]", type: "revised_only" },
    { path: "data[2]", type: "str" },
  ]);
  const xaiOut = new XaiLM({ apiKey: "fixture" }).imageGenerationFromResponse(req, resp);
  assert.deepEqual(xaiOut.providerData?.["_lm15_unmapped"], [
    { path: "data[1]", type: "revised_only" },
    { path: "data[2]", type: "str" },
  ]);

  const wasmBytes = readFileSync(new URL("../vendor/tls/lm15-tls.wasm", import.meta.url));
  const tls = await TlsEngine.load(wasmBytes);
  const session = tls.open("api.openai.com");
  assert.equal(session.handshaking(), true);
  session.free();
});
