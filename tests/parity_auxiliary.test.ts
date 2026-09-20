import assert from "node:assert/strict";
import test from "node:test";
import { LMRouter, Message, OpenAILM, ProviderError, getDefaultPlatform, image, setDefaultPlatform, webPlatform } from "../src/browser.ts";
import { FakeResponse, FakeTransport } from "../src/testing.ts";

const badReply = () => new FakeResponse({
  status: 200,
  headers: [["content-type", "text/html"], ["x-request-id", "aux-request"], ["retry-after-ms", "500"], ["x-ratelimit-remaining-requests", "-1"]],
  body: "<html>gateway was not JSON</html>",
});
const malformed = (error: unknown): boolean => {
  assert.ok(error instanceof ProviderError);
  assert.equal(error.code, "provider");
  assert.equal(error.provider, "openai");
  assert.equal(error.status, 200);
  assert.equal(error.contentType, "text/html");
  assert.equal(error.requestId, "aux-request");
  assert.equal(error.retryAfter, 0.5);
  assert.deepEqual(error.rateLimitHeaders["x-ratelimit-remaining-requests"], ["-1"]);
  assert.equal(error.retryable, false);
  return true;
};

for (const [name, invoke] of [
  ["models", (lm: OpenAILM) => lm.listModels()],
  ["file", (lm: OpenAILM) => lm.fileGet("file-id")],
  ["files", (lm: OpenAILM) => lm.fileList()],
  ["batch", (lm: OpenAILM) => lm.batchStatus("batch-id")],
  ["batches", (lm: OpenAILM) => lm.batchList()],
  ["video", (lm: OpenAILM) => lm.videoStatus("video-id")],
] as const) {
  test(`non-JSON ${name} success preserves typed reply diagnostics`, async () => {
    const lm = new OpenAILM({ apiKey: "k", transport: new FakeTransport([badReply()]) });
    await assert.rejects(invoke(lm), malformed);
  });
}

test("malformed SSE JSON is a provider fault with handshake diagnostics, not HTTP 200", async () => {
  const lm = new OpenAILM({ apiKey: "k", transport: new FakeTransport([new FakeResponse({
    headers: [["content-type", "text/event-stream"], ["x-request-id", "stream-id"]], body: "data: {\n\n",
  })]) });
  await assert.rejects(async () => {
    for await (const _ of lm.stream({ model: "gpt-5", messages: [Message.user("hi")] })) { /* drain */ }
  }, (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.requestId, "stream-id");
    assert.equal(error.status, null);
    assert.equal(error.bodyExcerpt, "{");
    return true;
  });
});

test("in-stream auth detail preserves one credential provenance line", async () => {
  const lm = new OpenAILM({ apiKey: () => "key", transport: new FakeTransport([new FakeResponse({
    headers: [["content-type", "text/event-stream"]],
    body: 'event: error\ndata: {"type":"error","code":"invalid_api_key","message":"bad credential"}\n\n',
  })]) });
  const messages: string[] = [];
  for await (const event of lm.stream({ model: "gpt-5", messages: [Message.user("hi")] })) {
    if (event.type === "error") messages.push(event.error.message);
  }
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.split("Credential came from:").length - 1, 1);
  assert.match(messages[0]!, /application-supplied callable/);
});

test("planning path-addressed media never reads a host file or environment", async () => {
  const before = getDefaultPlatform();
  setDefaultPlatform({
    ...webPlatform,
    name: "no-host-effects",
    env() { throw new Error("plan read the environment"); },
    readFile() { throw new Error("plan read a file"); },
    openCloudChain() { throw new Error("plan opened a cloud chain"); },
  });
  try {
    const router = new LMRouter();
    await router.plan({ model: "openai:gpt-5", messages: [Message.user(image({ path: "/not/read.png", mediaType: "image/png" }))] });
    await router.close();
  } finally { setDefaultPlatform(before); }
});
