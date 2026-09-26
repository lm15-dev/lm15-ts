import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { GeminiLM, geminiOpenApiSchema } from "../src/dialects/gemini.ts";
import { Message } from "../src/types/parts.ts";
import type { JsonObject } from "../src/json.ts";

// MAP-16 over the contract's vectors, on every Gemini surface. The harness's
// mapping direction grades generateContent and cached prefixes through the
// vet shim; the Live setup frame is covered here.
const VECTORS = resolvePath(fileURLToPath(new URL(".", import.meta.url)), "../../lm15-contract/mapping/gemini-schema-field.json");
const cases: { id: string; schema: JsonObject; openapi: boolean }[] = existsSync(VECTORS) ? JSON.parse(readFileSync(VECTORS, "utf8")).cases : [];

const body = (bytes: Uint8Array | undefined) => JSON.parse(new TextDecoder().decode(bytes)) as JsonObject;

test("MAP-16: every Gemini surface puts the schema in the field the vector names, verbatim", { skip: cases.length === 0 && "sibling contract mapping vectors unavailable" }, async () => {
  const lm = new GeminiLM({ apiKey: "k" });
  for (const { id, schema, openapi } of cases) {
    assert.equal(geminiOpenApiSchema(schema), openapi, id);
    const tool = { type: "function" as const, name: "f", parameters: schema };
    const [want, other] = openapi ? ["parameters", "parametersJsonSchema"] : ["parametersJsonSchema", "parameters"];
    const built = body((await lm.buildRequest({ model: "gemini-2.5-flash", messages: [Message.user("x")], tools: [tool] }, false)).body);
    let decl = ((built["tools"] as JsonObject[])[0]!["functionDeclarations"] as JsonObject[])[0]!;
    assert.ok(!(other! in decl), id);
    assert.equal(JSON.stringify(decl[want!]), JSON.stringify(schema), id);
    const live = lm.liveSetupPayload({ model: "gemini-3.1-flash-live-preview", tools: [tool] });
    decl = (((live["setup"] as JsonObject)["tools"] as JsonObject[])[0]!["functionDeclarations"] as JsonObject[])[0]!;
    assert.ok(!(other! in decl), id);
    assert.equal(JSON.stringify(decl[want!]), JSON.stringify(schema), id);
    const format = body((await lm.buildRequest({ model: "gemini-2.5-flash", messages: [Message.user("x")], config: { responseFormat: { type: "json_schema", schema } } }, false)).body);
    const gen = format["generationConfig"] as JsonObject;
    const [wantR, otherR] = openapi ? ["responseSchema", "responseJsonSchema"] : ["responseJsonSchema", "responseSchema"];
    assert.ok(!(otherR! in gen), id);
    assert.equal(JSON.stringify(gen[wantR!]), JSON.stringify(schema), id);
  }
});
