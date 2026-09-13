import assert from "node:assert/strict";
import { test } from "node:test";
import { tokens } from "../examples/provider-page/code-view.ts";

test("code coloring preserves every character in every language, including hostile-looking text", () => {
  const examples = [
    'const request = Request.create({ system: "<script>alert(1)</script>", config: { temperature: 0.7 } });\n// next turn\n',
    'request = Request(system="a # is not a comment", config=Config(max_tokens=400))\n# comment\n',
    'let request = Request { system: Some("<img src=x onerror=alert(1)>".into()), ..Default::default() };\n',
    '{"input": "\\\"escaped\\\"", "large_id": 12345678901234567890, "scale": 1.0}\n',
    "curl -X POST 'https://example.com/' \\\n  -H 'Authorization: Bearer YOUR_API_KEY'\n",
  ];
  for (const language of ["javascript", "python", "rust", "json", "curl"]) {
    for (const source of examples) assert.equal(tokens(source, language).map((token) => token.text).join(""), source);
  }
  assert.equal(tokens('"// not a comment"', "javascript")[0]?.kind, "string");
  assert.equal(tokens('"# not a comment"', "python")[0]?.kind, "string");
  assert.equal(tokens("# a comment", "python")[0]?.kind, "comment");
  assert.deepEqual(tokens("", "javascript"), []);
});
