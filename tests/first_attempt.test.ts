// Changes of 2026-10-10 that make a first attempt work: a budget alone fills effort
// (MAP-7 rule 3 read the other way) and a DataPart answer reads through text/json
// (types.md §Response convenience).
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeReasoning } from "../src/types/config.ts";
import { Response } from "../src/types/response.ts";

test("a thinking budget alone fills effort from the grading table", () => {
  const efforts = [512, 1024, 2047, 2048, 8192, 16384, 24576, 32768, 1e6].map((b) => normalizeReasoning({ thinkingBudget: b }).effort);
  assert.deepEqual(efforts, ["minimal", "minimal", "minimal", "low", "medium", "high", "xhigh", "max", "max"]);
  assert.equal(normalizeReasoning({ effort: "high", thinkingBudget: 1024 }).effort, "high");
  assert.throws(() => normalizeReasoning({}), /needs effort/);
  assert.throws(() => normalizeReasoning({ thinkingBudget: 0 }), /effort: "off"/);
  assert.throws(() => normalizeReasoning({ effort: "none" }), /effort: "off"/);
});

test("a DataPart answer reads through text, parseJson and json", () => {
  const response = Response.fromJSON({
    id: null, model: "m", finish_reason: "stop", usage: {},
    message: { role: "assistant", parts: [{ type: "data", value: { ok: true, n: 1 } }] },
  } as never);
  assert.equal(response.text, '{"ok":true,"n":1}');
  assert.deepEqual(response.parseJson(), { ok: true, n: 1 });
});
