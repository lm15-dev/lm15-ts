import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  CFloat,
  isJsonObject,
  parseCanonicalJson,
  stringifyCanonicalJson,
  type JsonObject,
  type JsonValue,
} from "../canonical-json.js";
import { serdeForKind } from "../serde.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(HERE, "..", "..", "..", "lm15-contract", "serde", "canonical.json");

function deepEqual(a: JsonValue, b: JsonValue): boolean {
  if (a instanceof CFloat || b instanceof CFloat) {
    return a instanceof CFloat && b instanceof CFloat && a.value === b.value;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => deepEqual(item, b[i]!))
    );
  }
  if (isJsonObject(a) && isJsonObject(b)) {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return (
      ka.length === kb.length &&
      ka.every((k, i) => k === kb[i] && deepEqual(a[k]!, b[k]!))
    );
  }
  return a === b;
}

const corpus = parseCanonicalJson(readFileSync(VECTORS, "utf-8")) as JsonObject;
const cases = corpus["cases"] as JsonValue[];

test("contract serde vectors round-trip strictly (int != float)", () => {
  let count = 0;
  for (const c of cases) {
    const entry = c as JsonObject;
    const id = entry["id"] as string;
    const kind = entry["kind"] as string;
    const value = entry["value"] as JsonValue;
    const [fromDict, toDict] = serdeForKind(kind);
    const roundtripped = toDict(fromDict(value));
    assert.ok(
      deepEqual(value, roundtripped),
      `vector ${id} differs:\n  in:  ${stringifyCanonicalJson(value)}\n  out: ${stringifyCanonicalJson(roundtripped)}`,
    );
    count += 1;
  }
  assert.equal(count, 68);
});

test("unknown serde kind rejects", () => {
  assert.throws(() => serdeForKind("nope"), /unknown kind/);
});

test("FunctionTool.parameters is always emitted (INV-033)", () => {
  const [fromDict, toDict] = serdeForKind("tool");
  const out = toDict(fromDict({ type: "function", name: "noop", parameters: {} }));
  assert.deepEqual(out["parameters"], {});
  const defaulted = toDict(fromDict({ name: "noop" }));
  assert.deepEqual(defaulted["parameters"], { type: "object", properties: {} });
});

test("config nests reject non-objects (INV-042)", () => {
  const [fromDict] = serdeForKind("config");
  assert.throws(() => fromDict({ tool_choice: "auto" }), /must be a JSON object/);
  // null reads as absent.
  const cfg = fromDict({ tool_choice: null });
  assert.ok(cfg);
});

test("Number rule: temperature always emits as float, max_tokens as int", () => {
  const [fromDict, toDict] = serdeForKind("config");
  const out = toDict(fromDict(parseCanonicalJson('{"temperature": 1, "max_tokens": 64.0}')));
  assert.equal(stringifyCanonicalJson(out), '{"max_tokens":64,"temperature":1.0}');
});

test("Number rule: non-integral value for int field rejects", () => {
  const [fromDict] = serdeForKind("config");
  assert.throws(() => fromDict(parseCanonicalJson('{"top_k": 2.5}')));
});

test("validate rejections carry canonical error names", () => {
  const [fromDict] = serdeForKind("part");
  try {
    fromDict({ type: "refusal", text: "" });
    assert.fail("expected rejection");
  } catch (err) {
    assert.equal((err as Error).name, "ValueError");
  }
});
