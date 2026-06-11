import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  CFloat,
  parseCanonicalJson,
  stringifyCanonicalJson,
} from "../canonical-json.js";

test("float tokens parse as CFloat and re-emit in float form", () => {
  const v = parseCanonicalJson('{"a": 1.0, "b": 1, "c": 1.5, "d": 2e3}') as Record<
    string,
    unknown
  >;
  assert.ok(v["a"] instanceof CFloat);
  assert.equal(typeof v["b"], "number");
  assert.equal(
    stringifyCanonicalJson(v as never),
    '{"a":1.0,"b":1,"c":1.5,"d":2000.0}',
  );
});

test("declared-float emission: integral CFloat keeps .0", () => {
  assert.equal(stringifyCanonicalJson(new CFloat(1)), "1.0");
  assert.equal(stringifyCanonicalJson(new CFloat(-3)), "-3.0");
  assert.equal(stringifyCanonicalJson(new CFloat(1.5625)), "1.5625");
  assert.equal(stringifyCanonicalJson(1), "1");
});

test("opaque payload numbers round-trip verbatim", () => {
  const text = '{"x":1,"y":4.0,"z":[0,0.5,{"k":2.0}]}';
  assert.equal(stringifyCanonicalJson(parseCanonicalJson(text)), text);
});

test("string escapes round-trip", () => {
  const text = '{"s":"a\\"b\\\\c\\n\\u00e9"}';
  const v = parseCanonicalJson(text) as Record<string, unknown>;
  assert.equal(v["s"], 'a"b\\c\né');
});

test("rejects malformed JSON", () => {
  assert.throws(() => parseCanonicalJson('{"a": }'));
  assert.throws(() => parseCanonicalJson('{"a": 1} trailing'));
  assert.throws(() => parseCanonicalJson('{"a": 01}'));
});
