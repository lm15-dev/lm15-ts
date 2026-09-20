import assert from "node:assert/strict";
import test from "node:test";
import { ProviderError } from "../src/errors.ts";
import { foldJudgment, scoresFromBody, tokensFromBody } from "../src/dialects/token_trie.ts";
import { Usage } from "../src/types/response.ts";

for (const tokens of ['[-1]', '[true]', '["1"]', '[9007199254740993]', '[null]']) {
  test(`tokenization rejects invalid ids ${tokens} as provider faults`, () => {
    assert.throws(() => tokensFromBody(`{"tokens":${tokens}}`), ProviderError);
  });
}

test("scoring requires every prompt index exactly once", () => {
  for (const choices of [[], [{ index: 0 }, { index: 0 }], [{ index: 1 }, { index: 2 }], [{}, {}]]) {
    assert.throws(() => scoresFromBody(JSON.stringify({ choices }), 2), ProviderError);
  }
});

test("scoring never fabricates measurements or usage", () => {
  for (const score of [null, true, "-1", 0.1]) {
    assert.throws(() => scoresFromBody(JSON.stringify({ choices: [{ index: 0, logprobs: { top_logprobs: [{ "token_id:1": score }] } }] }), 1), ProviderError);
  }
  const result = scoresFromBody('{"choices":[{"index":0,"logprobs":{"top_logprobs":[{"token_id:1":-1.0}]}}]}', 1);
  assert.equal(result.scores[0]!.get(1), -1);
  assert.deepEqual(Usage.toJSON(result.usage), {});
  assert.equal(scoresFromBody('{"choices":[{"index":0}]}', 1).scores[0]!.size, 0);
  assert.throws(() => scoresFromBody('{"choices":[{"index":0}],"usage":{"prompt_tokens":true}}', 1), ProviderError);
});

test("all-zero candidate likelihood cannot produce NaN certainty", () => {
  const paths = new Map([["a", [1]], ["b", [2]]]);
  const table = new Map([["", new Map([[1, -Infinity], [2, -Infinity]])]]);
  assert.throws(() => foldJudgment(paths, table), ProviderError);
});
