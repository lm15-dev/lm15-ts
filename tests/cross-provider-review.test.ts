import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { GeminiLM } from "../src/dialects/gemini.ts";
import { OpenAIChatLM } from "../src/dialects/openai_chat.ts";
import { ProviderError, UnsupportedFeatureError } from "../src/errors.ts";
import { Request } from "../src/types/config.ts";

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
