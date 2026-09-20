import assert from "node:assert/strict";
import test from "node:test";
import { AnthropicLM, BatchRequest, GeminiLM, Message, OpenAILM, UnsupportedFeatureError } from "../src/browser.ts";
import { FakeTransport } from "../src/testing.ts";

const batch = (model = "gpt-4.1", later = false) => BatchRequest.create({
  requests: [
    ...(later ? [{ model, messages: [Message.user("first")] }] : []),
    { model, messages: [Message.user("hi")], config: { stop: ["STOP"] } },
  ],
});
const refused = (error: unknown): boolean => {
  assert.ok(error instanceof UnsupportedFeatureError);
  assert.equal(error.feature, "config.stop");
  assert.match(error.message, /batch cannot close/);
  assert.match(error.message, /complete\(\)\/stream\(\)/);
  return true;
};

for (const adaptations of ["note", "silent", "refuse"] as const) {
  for (const later of [false, true]) {
    test(`Responses batch refuses ${adaptations}, later=${later}, before credentials/upload`, async () => {
      let credentialCalls = 0;
      const transport = new FakeTransport([]);
      const lm = new OpenAILM({ adaptations, transport, apiKey: () => {
        credentialCalls++;
        throw new Error("unexpected credential resolution");
      } });
      const request = batch("gpt-4.1", later);
      await assert.rejects(async () => lm.batchSubmit(request), refused);
      await assert.rejects(async () => lm.batchUploadRequest(request), refused);
      await assert.rejects(async () => lm.batchSubmitRequest(request, { id: "existing-upload" }), refused);
      assert.equal(credentialCalls, 0);
      assert.equal(transport.requests.length, 0);
    });
  }
  test(`native batch stops still reach Anthropic and Gemini under ${adaptations}`, async () => {
    const anthropic = new AnthropicLM({ apiKey: "synthetic", adaptations, transport: new FakeTransport([]) });
    const gemini = new GeminiLM({ apiKey: "synthetic", adaptations, transport: new FakeTransport([]) });
    const a = JSON.parse(new TextDecoder().decode((await anthropic.batchSubmitRequest(batch("claude-haiku-4-5"))).body));
    const g = JSON.parse(new TextDecoder().decode((await gemini.batchSubmitRequest(batch("gemini-2.5-flash"))).body));
    assert.deepEqual(a.requests[0].params.stop_sequences, ["STOP"]);
    assert.deepEqual(g.batch.inputConfig.requests.requests[0].request.generationConfig.stopSequences, ["STOP"]);
  });
}

test("harmless batch label mapping remains available", async () => {
  const lm = new AnthropicLM({ apiKey: "synthetic", transport: new FakeTransport([]) });
  const request = BatchRequest.create({ requests: batch("claude-haiku-4-5").requests, label: "local-label" });
  const body = JSON.parse(new TextDecoder().decode((await lm.batchSubmitRequest(request)).body));
  assert.equal(body.label, undefined);
  assert.deepEqual(body.requests[0].params.stop_sequences, ["STOP"]);
});
