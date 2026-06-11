# lm15 (TypeScript)

TypeScript port of the lm15 canonical model, implemented from the contract
in `../lm15-contract` (spec/types.md, spec/invariants.md,
spec/vocabularies.md, harness/PROTOCOL.md and
`../lm15-python2/docs/serde-rules.md` / `docs/mapping-rules.md`).

What's here (chat core per spec/SCOPE.md):

- Canonical types as plain readonly discriminated unions (`src/types.ts`)
  with validating factory constructors enforcing the numbered invariants.
- Canonical serde (`src/serde.ts`) — the single serializer module: one
  omission rule, opaque payloads verbatim, the Number rule via a
  float-preserving JSON codec (`src/canonical-json.ts`; `1.0` never
  collapses to `1`).
- Provider adapters for `openai` (Responses), `openai_chat`
  (Chat Completions dialect: OpenAI, vLLM, SGLang, Groq, ollama, ...),
  `anthropic`, `gemini`: `build_request`, `parse_response`,
  `normalize_error`, and stream-event mapping.
- Streaming: SSE parsing (`src/sse.ts`), per-provider frame mapping
  (`src/adapters/parse-stream.ts`), and the MAP-3 coalescer +
  materializer (`src/stream.ts`) — exactly one final StreamEndEvent
  carrying finish_reason and usage; post-finish usage-only chunks
  (vLLM/SGLang/Groq `stream_options.include_usage`) are absorbed.
- Vet shim (`src/vet.ts` -> `dist/vet.js`) speaking the full
  harness/PROTOCOL.md op set: `capabilities`, `build_request`,
  `parse_response`, `replay_stream`, `normalize_error`,
  `serde_roundtrip`, `validate`, `surface_dump`.

- Client layer (`src/client.ts`): `OpenAILM`, `OpenAIChatLM`,
  `AnthropicLM`, `GeminiLM` — `complete(request): Promise<Response>` and
  `stream(request): AsyncIterable<StreamEvent>` over Node's global
  `fetch` (undici keep-alive pooling; still zero dependencies). Wire
  bodies go through the canonical number emitter.

Honest status: this port passes 304 contract checks across all five
harness directions (request 110, response 102, stream 8, error 16,
serde 68; 0 fail, 4 skip) plus live smoke tests against ollama, Groq,
and OpenAI. The non-chat endpoints (embeddings, files, batch, image,
audio) and live sessions are provisional in the contract and absent
here.

Zero runtime dependencies. Node >= 22.

## Quickstart

Mirrors the Python reference (`lm15-python2`): `Message.user(...)`,
`response.text`, `response.toolCalls`, compat presets — same names
modulo casing. This example ran live against OpenAI:

```ts
import { OpenAILM, Message, request, config } from "lm15";

const lm = new OpenAILM({ apiKey: process.env.OPENAI_API_KEY! });

const response = await lm.complete(
  request({
    model: "gpt-4.1-mini",
    system: "You are terse.",
    messages: [Message.user("Say hello in three words.")],
    config: config({ max_tokens: 50, temperature: 0.2 }),
  }),
);

console.log(response.text);          // "Hello there!"
console.log(response.finish_reason); // "stop"
console.log(response.usage.total_tokens);
```

Any OpenAI-compatible server is one compat preset away (ran live
against a local ollama):

```ts
import { OpenAIChatLM, Message, request, config } from "lm15";

const lm = new OpenAIChatLM({ apiKey: "ollama", compat: "ollama" }); // baseUrl -> http://localhost:11434/v1

const response = await lm.complete(
  request({
    model: "qwen3.5:0.8b",
    messages: [Message.user("Say hello in five words or fewer.")],
    config: config({ max_tokens: 80, extensions: { reasoning_effort: "none" } }),
  }),
);
console.log(response.text); // "Hello! How can I help?"
```

Swap `compat: "groq"` (plus your Groq key) and the same request hits
Groq (ran live with `llama-3.1-8b-instant`).

### Streaming

`stream()` yields typed events; exactly one `end` event closes the
stream, carrying `finish_reason` and `usage` (MAP-3). Ran live against
all three targets:

```ts
for await (const event of lm.stream(req)) {
  if (event.type === "delta" && event.delta.type === "text") {
    process.stdout.write(event.delta.text);
  }
}
```

To consume a stream into a full `Response`, collect the events and call
`materializeResponse(events, req)` — identical in shape to one from
`complete()`.

### Tools: the full round-trip

Ran live against OpenAI (`gpt-4.1-mini`):

```ts
import { OpenAILM, Message, request, functionTool } from "lm15";

const weatherTool = functionTool({
  name: "get_weather",
  description: "Get the current weather for a city.",
  parameters: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
});

const messages = [Message.user("What is the weather in Montreal?")];
const response = await lm.complete(
  request({ model: "gpt-4.1-mini", messages, tools: [weatherTool] }),
);

const call = response.toolCalls[0]!; // typed ToolCallPart
// -> get_weather {"city":"Montreal"}

const final = await lm.complete(
  request({
    model: "gpt-4.1-mini",
    messages: [...messages, response.message, Message.tool({ [call.id]: "Sunny and 22°C." })],
    tools: [weatherTool],
  }),
);
console.log(final.text); // "The weather in Montreal is currently sunny with a temperature of 22°C."
```

Live smoke tests (`src/tests/live.test.ts`) are env-gated: they skip
when `GROQ_API_KEY` / `OPENAI_API_KEY` are unset or local ollama is
unreachable, so CI without keys stays green.

```sh
npm run build   # tsc -> dist/ (shim entry: dist/vet.js)
npm test        # node --test dist/tests/*.test.js
npm run check   # tsc --noEmit
```

Conformance gate:

```sh
cd ../lm15-contract
../lm15-python2/.venv/bin/python harness/check.py --shim typescript --direction all
```
