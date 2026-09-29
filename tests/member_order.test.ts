import { test } from "node:test";
import assert from "node:assert/strict";
import * as browser from "../src/browser.ts";
import {
  MEMBER_ORDER,
  copyJson,
  isIndexName,
  isStrictJson,
  memberNames,
  orderedObject,
  parseJson,
  parseJsonStrict,
  setMember,
  stringifyJson,
  type JsonObject,
} from "../src/json.ts";
import { anthropicSchema, choice, geminiSchema, judgments, judgmentsInSchema, normalizeLogprobs, parseTypeSafeResponse, score, yesNo } from "../src/judgments.ts";
import { OpenAIChatLM } from "../src/dialects/openai_chat.ts";
import { FakeResponse } from "../src/testing.ts";
import type { Transport, TransportResponse } from "../src/transport.ts";
import { Request } from "../src/types/config.ts";
import { HttpResponse, textBytes, type TransportRequest } from "../src/wire.ts";
import { installNodePlatform } from "../src/platform_node.ts";
import { adapterFor } from "../src/providers.ts";
import { Message } from "../src/types/parts.ts";

installNodePlatform();

// INV-002: an opaque object round-trips exactly, member order included. A
// JavaScript object enumerates array-index names ("10") first; lm15 keeps
// the order it read or was given under MEMBER_ORDER.
// The contract grades every wire (mapping/opaque-order.json); these pin the
// mechanism, its protocol and the paths the contract cannot reach.

test("the record is the registered symbol lm15.memberOrder, a protocol other libraries share", () => {
  assert.equal(MEMBER_ORDER, Symbol.for("lm15.memberOrder"));
  assert.equal(browser.MEMBER_ORDER, MEMBER_ORDER);
  for (const name of ["memberNames", "orderedObject", "setMember"] as const) assert.equal(typeof browser[name], "function");
});

test("array-index names are ECMA-262's: canonical digits below 2^32 - 1", () => {
  for (const name of ["0", "1", "10", "2024", "4294967294"]) assert.ok(isIndexName(name), name);
  for (const name of ["", "01", "-1", "1.0", "1e3", " 1", "4294967295", "99999999999", "a1", "\u0661"]) assert.ok(!isIndexName(name), name);
});

test("parseJson and stringifyJson keep the text's member order, at every depth, on both parsers", () => {
  const texts = [
    '{"reasoning":"x","2024":1,"1":[{"y":1,"3":2}],"n":{"10":1,"9":2}}',
    '{"logit_bias":{"1234":-100,"15":5}}',
    '{"a":{"b":{"c":{"z":1,"0":1.0}}}}', // only the innermost object needs a record
    '[{"b":1,"10":2},{"10":2,"b":1}]',
    '{"b":1,"10":12345678901234567890}',
    '{"b":1,"\\u0031\\u0030":2}', // "10" spelled with escapes
    '{ "b" : 1 ,\n\t"10" : 2 }',
  ];
  for (const text of texts) {
    const canonical = stringifyJson(JSON.parse(text)) === text ? text : stringifyJson(parseJsonStrict(text));
    assert.equal(stringifyJson(parseJson(text)), canonical, text);
    assert.equal(stringifyJson(parseJsonStrict(text)), canonical, text);
  }
  assert.equal(stringifyJson(parseJson('{"b":1,"\\u0031\\u0030":2}')), '{"b":1,"10":2}');
  assert.equal(stringifyJson(parseJson('{ "b" : 1 ,\n\t"10" : 2 }')), '{"b":1,"10":2}');
});

test("a record is made only where JavaScript's order differs from the text's", () => {
  const plain = parseJson('{"a":1,"b":{"c":2},"1":3}') as JsonObject;
  assert.equal(Object.getOwnPropertySymbols(plain).length, 1); // "1" after "a": recorded
  const inOrder = parseJson('{"1":1,"b":2,"c":{"d":3}}') as JsonObject;
  assert.equal(Object.getOwnPropertySymbols(inOrder).length, 0);
  assert.equal(Object.getOwnPropertySymbols(inOrder["c"] as object).length, 0);
  const words = parseJson('{"b":1,"a":2}') as JsonObject;
  assert.equal(Object.getOwnPropertySymbols(words).length, 0);
});

test("a repeated name keeps its first place and its last value; __proto__ is a member like any other", () => {
  assert.equal(stringifyJson(parseJson('{"b":1,"10":2,"b":3}')), '{"b":3,"10":2}');
  const proto = parseJson('{"__proto__":1,"10":2}') as JsonObject;
  assert.equal(Object.getPrototypeOf(proto), Object.prototype);
  assert.equal(stringifyJson(proto), '{"__proto__":1,"10":2}');
  assert.throws(() => parseJsonStrict('{"b":1,"10":2,"b":3}'), /duplicate member name/);
});

test("the record is invisible to Object.keys, JSON.stringify and deep equality; copies made without lm15 are in JavaScript's order", () => {
  const value = parseJson('{"b":1,"10":2}') as JsonObject;
  assert.deepEqual(Object.keys(value), ["10", "b"]);
  assert.equal(JSON.stringify(value), '{"10":2,"b":1}');
  assert.deepStrictEqual(value, { b: 1, "10": 2 });
  assert.equal(stringifyJson({ ...value }), '{"10":2,"b":1}');
  assert.equal(stringifyJson(structuredClone(value)), '{"10":2,"b":1}');
  const copy = copyJson(value);
  assert.notEqual(copy, value);
  assert.equal(stringifyJson(copy), '{"b":1,"10":2}');
});

test("orderedObject, setMember and memberNames: a new name comes last, a replaced one keeps its place", () => {
  const obj = orderedObject([["reasoning", "r"], ["2024", 1], ["1", "x"]]);
  assert.deepEqual(memberNames(obj), ["reasoning", "2024", "1"]);
  setMember(obj, "0", "added");
  setMember(obj, "2024", 2);
  assert.equal(stringifyJson(obj), '{"reasoning":"r","2024":2,"1":"x","0":"added"}');
  delete obj["reasoning"];
  setMember(obj, "reasoning", "again");
  assert.deepEqual(memberNames(obj), ["2024", "1", "0", "reasoning"]);
  // A name added by plain assignment follows the recorded ones.
  (obj as JsonObject)["5"] = "plain";
  assert.deepEqual(memberNames(obj), ["2024", "1", "0", "reasoning", "5"]);
  // Without a record, setMember starts one when JavaScript would reorder.
  const fresh: JsonObject = { b: 1 };
  setMember(fresh, "10", 2);
  assert.equal(stringifyJson(fresh), '{"b":1,"10":2}');
  const words: JsonObject = {};
  setMember(words, "a", 1);
  setMember(words, "b", 2);
  assert.equal(Object.getOwnPropertySymbols(words).length, 0);
  const proto: JsonObject = {};
  setMember(proto, "__proto__", 1);
  assert.equal(Object.getPrototypeOf(proto), Object.prototype);
  assert.deepEqual(memberNames(proto), ["__proto__"]);
  assert.equal(stringifyJson(orderedObject([["b", 1], ["10", 2], ["b", 3]])), '{"b":3,"10":2}');
});

test("a record shared by two objects (a descriptor copy) stays right for both", () => {
  const a = orderedObject([["b", 1], ["10", 2]]);
  const b = Object.create(Object.prototype, Object.getOwnPropertyDescriptors(a)) as Record<string, number>;
  setMember(b, "c", 3);
  setMember(a, "0", 0);
  setMember(a, "c", 4);
  assert.deepEqual(memberNames(a), ["b", "10", "0", "c"]);
  assert.deepEqual(memberNames(b), ["b", "10", "c"]);
});

test("isStrictJson accepts a well-formed record only; stringifyJson refuses a malformed one", () => {
  assert.ok(isStrictJson(orderedObject([["b", 1], ["10", 2]])));
  const bad = { b: 1, "10": 2 };
  Object.defineProperty(bad, MEMBER_ORDER, { value: ["b", 10], enumerable: false, configurable: true });
  assert.ok(!isStrictJson(bad));
  assert.throws(() => stringifyJson(bad), /member order record/);
  const getter = { b: 1 };
  Object.defineProperty(getter, MEMBER_ORDER, { get: () => ["b"], enumerable: false, configurable: true });
  assert.ok(!isStrictJson(getter));
  assert.ok(!isStrictJson({ b: 1, [Symbol("other")]: 1 }));
});

// As a caller writes it: mixed value types, no annotation.
const SCHEMA = orderedObject([
  ["type", "object"],
  ["properties", orderedObject([["reasoning", { type: "string" }], ["2024", { type: "integer" }]])],
  ["required", ["reasoning", "2024"]],
]);

test("a schema written reasoning-first goes out reasoning-first on every wire, from objects built in code", async () => {
  const wanted = '"properties":{"reasoning":{"type":"string"},"2024":{"type":"integer"}}';
  const models: Record<string, string> = { openai: "gpt-4.1-mini", "openai-chat": "gpt-4.1-mini", anthropic: "claude-sonnet-4-5", gemini: "gemini-2.5-flash" };
  for (const [provider, model] of Object.entries(models)) {
    const lm = adapterFor(provider, { apiKey: "k" });
    const tools = await lm.buildRequest({ model, messages: [Message.user("x")], tools: [{ type: "function", name: "f", parameters: SCHEMA }] }, false);
    assert.ok(new TextDecoder().decode(tools.body).includes(wanted), `${provider} tools`);
    const format = await lm.buildRequest({ model, messages: [Message.user("x")], config: { responseFormat: { type: "json_schema", schema: SCHEMA } } }, false);
    assert.ok(new TextDecoder().decode(format.body).includes(wanted), `${provider} response_format`);
  }
});

test("judgments keep their declared order through the helpers, the schema rewrites and the distribution", () => {
  const fmt = judgments(orderedObject([["quality", score("Good?", ["bad", "good"])], ["10", yesNo("Ten?")], ["year", choice("Year?", orderedObject([["2024", "now"], ["1999", "then"]]))]]));
  const schema = fmt.schema as JsonObject;
  assert.deepEqual(memberNames(schema["properties"] as JsonObject), ["quality", "10", "year"]);
  assert.deepEqual(schema["required"], ["quality", "10", "year"]);
  const found = judgmentsInSchema(schema);
  assert.deepEqual([...found.keys()], ["quality", "10", "year"]);
  assert.deepEqual(found.get("year")!.keys, ["2024", "1999"]);
  assert.deepEqual(memberNames(anthropicSchema(schema, found)["properties"] as JsonObject), ["quality", "10", "year"]);
  const gemini = geminiSchema(schema, found)["properties"] as JsonObject;
  assert.deepEqual(memberNames(gemini), ["quality", "10", "year"]);
  assert.deepEqual((gemini["year"] as JsonObject)["enum"], ["2024", "1999"]);
  assert.deepEqual(memberNames(normalizeLogprobs(orderedObject([["2024", -0.1], ["1999", -2]]))), ["2024", "1999"]);
});

// Judgments named like indexes, declared "ok" then "10": the answer lm15
// assembles (a DataPart value, its probabilities) lists them that way.
const INDEX_JUDGMENTS = judgments(orderedObject([["ok", yesNo("Fine?")], ["10", yesNo("Ten?")]]));

test("a TypeSafe answer is assembled in the declared order", () => {
  const request = Request.create({ model: "jev-latest", messages: [Message.user("note")], config: { responseFormat: INDEX_JUDGMENTS } });
  const body = '{"answers":{"10":{"type":"noul","noul":0.25},"ok":{"type":"noul","noul":0.75}}}';
  const result = parseTypeSafeResponse(request, new HttpResponse({ status: 200, headers: [["Content-Type", "application/json"]], body: textBytes(body) }));
  assert.equal(stringifyJson(result.data!), '{"ok":true,"10":false}');
  assert.deepEqual(memberNames(result.probabilities!), ["ok", "10"]);
});

class ScoringServer implements Transport {
  async send(request: TransportRequest): Promise<TransportResponse> {
    const payload = JSON.parse(new TextDecoder().decode(request.body)) as JsonObject;
    if (request.url.endsWith("/tokenize")) {
      const messages = payload["messages"] as JsonObject[];
      const answer = messages[messages.length - 1]!["content"] as string;
      const tokens = [1];
      if (answer !== "Answer:") {
        tokens.push(answer.endsWith("true") ? 10 : 11);
        if (!payload["continue_final_message"]) tokens.push(99);
      }
      return new FakeResponse({ body: JSON.stringify({ tokens }) });
    }
    const top = Object.fromEntries((payload["logprob_token_ids"] as number[]).map((id) => [`token_id:${id}`, id === 10 ? -0.1 : -2]));
    return new FakeResponse({ body: JSON.stringify({ model: "m", choices: (payload["prompt"] as number[][]).map((_p, index) => ({ index, logprobs: { top_logprobs: [top] } })) }) });
  }
}

test("a scored judgment answer (Chat Completions logprobs) is assembled in the declared order", async () => {
  const lm = new OpenAIChatLM({ apiKey: "k", compat: "vllm", baseUrl: "http://scoring/v1", transport: new ScoringServer() });
  const response = await lm.complete(Request.create({ model: "m", messages: [Message.user("x")], config: { responseFormat: INDEX_JUDGMENTS, probabilities: "required" } }));
  assert.deepEqual(memberNames(response.data as JsonObject), ["ok", "10"]);
  assert.deepEqual(memberNames(response.probabilities!), ["ok", "10"]);
  assert.deepEqual(memberNames(response.providerData!["coverage"] as JsonObject), ["ok", "10"]);
});
