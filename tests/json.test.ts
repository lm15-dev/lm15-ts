import { test } from "node:test";
import assert from "node:assert/strict";
import { RawNumber, float, isStrictJson, jsonEquals, omitEmpty, parseJson, stringifyJson } from "../src/json.ts";

test("integral float lexemes survive a parse/stringify round trip", () => {
  const text = '{"a":1.0,"b":2e3,"c":0.5,"d":7,"e":12345678901234567890,"f":[1.0,{"g":-0.0}]}';
  const value = parseJson(text) as Record<string, unknown>;
  assert.ok(value["a"] instanceof RawNumber);
  assert.equal((value["a"] as RawNumber).raw, "1.0");
  assert.equal(value["c"], 0.5); // non-integral floats stay plain numbers
  assert.equal(value["d"], 7);
  assert.equal((value["e"] as RawNumber).raw, "12345678901234567890");
  assert.equal(stringifyJson(value), text);
});

test("float() marks a typed float field: 1 → 1.0, 0.5 stays 0.5", () => {
  assert.equal(stringifyJson({ t: float(1) }), '{"t":1.0}');
  assert.equal(stringifyJson({ t: float(0.5) }), '{"t":0.5}');
  assert.equal(stringifyJson({ t: float(1e21) }), '{"t":1e+21}');
  assert.equal(float(null), null);
});

test("jsonEquals is the harness's strict typed equality", () => {
  assert.ok(!jsonEquals(1, new RawNumber("1.0")));
  assert.ok(jsonEquals(new RawNumber("1.0"), new RawNumber("1.0")));
  assert.ok(jsonEquals(new RawNumber("1.0"), float(1)));
  assert.ok(!jsonEquals(true, 1));
  assert.ok(!jsonEquals({ a: [] }, { a: {} }));
  assert.ok(!jsonEquals({ a: null }, {}));
  assert.ok(jsonEquals({ a: 1, b: undefined }, { a: 1 }));
});

test("omitEmpty drops null, empty string, empty array, empty object — its own level only", () => {
  assert.deepEqual(omitEmpty({ a: null, b: "", c: [], d: {}, e: 0, f: false, g: { h: {} } }), { e: 0, f: false, g: { h: {} } });
});

test("isStrictJson rejects what has no wire form", () => {
  assert.ok(isStrictJson({ a: [1, "x", null, true, { b: new RawNumber("1.0") }] }));
  assert.ok(!isStrictJson({ a: undefined }));
  assert.ok(!isStrictJson({ a: Number.NaN }));
  assert.ok(!isStrictJson({ a: new Date() }));
  assert.ok(!isStrictJson({ a: () => 1 }));
});

test("stringifyJson refuses non-JSON values and RawNumber refuses JSON.stringify", () => {
  assert.throws(() => stringifyJson({ a: new Map() }), TypeError);
  assert.throws(() => JSON.stringify(new RawNumber("1.0")), TypeError);
});
