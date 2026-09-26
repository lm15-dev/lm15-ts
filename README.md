# lm15 for TypeScript and JavaScript

One request and response model for every major AI model provider. Write a
request once and send it to OpenAI, Anthropic, Gemini, xAI, Groq, DeepSeek,
OpenRouter, Z.AI, Moonshot, Meta, a cloud (Azure, Bedrock, Vertex) or a
model on your own machine: change the model string, keep the program.

```ts
import { LMRouter, Message } from "@lm15/lm15";

const router = new LMRouter(); // keys from the environment
const response = await router.complete({
  model: "anthropic:claude-haiku-4-5",
  messages: [Message.user("What eats acorns at night?")],
});
console.log(response.text);
```

- **No runtime dependencies.** Node.js 22 or newer, ESM and CommonJS, with
  type declarations; a browser entry point (`@lm15/lm15/browser`) for pages,
  workers and Electron renderers.
- **Low-level on purpose.** Typed requests, responses, stream events, tools,
  media, errors and exact JSON. No hidden tool loop, no retries you did not
  ask for: the library you build on top decides those.
- **The same behavior in every language.** lm15 exists for Python,
  TypeScript, Rust and Go, graded by one shared
  [contract](https://github.com/lm15-dev/lm15-contract).

Documentation: **[lm15.dev](https://lm15.dev/docs/)**, with TypeScript
examples on every page, and a [playground](https://lm15.dev/playground/)
that runs this package in your browser.

## Install

```bash
npm install @lm15/lm15
```

**1.0.0-rc.1 is a release candidate**: the API intended for 1.0, published
to be tried first. Pin the exact version in applications. Python's lm15 1.0
is stable; Rust and Go are release candidates too.

Set the key of the provider you call (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `GEMINI_API_KEY`, ...). Examples use `await` at the top
level, so run them as ES modules (`"type": "module"` in `package.json`, or a
`.mts` file); Node 22.18+ runs `.ts` files directly.

## Guide

### Ask, stream, continue

```ts
import { LMRouter, Message, ResponseStream } from "@lm15/lm15";

const router = new LMRouter();
const request = {
  model: "gpt-4.1-mini", // or "claude-haiku-4-5", "gemini:gemini-2.5-flash", "ollama:qwen3.5:0.8b"
  system: "Answer in one sentence.",
  messages: [Message.user("What eats acorns at night?")],
  config: { maxTokens: 200 },
};

const response = await router.complete(request);
console.log(response.text, response.finishReason, response.usage.outputTokens);

// Streaming: text as it arrives, then the same Response complete() returns.
const stream = new ResponseStream(router.stream(request), request);
for await (const text of stream) process.stdout.write(text);
const final = await stream.response();

// A conversation is the messages so far, plus the reply.
const next = { ...request, messages: [...request.messages, final.message, Message.user("And by day?")] };
```

A model string is `provider:model` or a bare name the router recognizes.
`router.resolve("grok-4")` shows how one is routed, without any network.

### Tools

lm15 returns the model's tool calls; your program runs them and answers.

```ts
import { tool } from "@lm15/lm15";

const weather = tool("get_weather", {
  description: "Current weather for a city.",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
});
const ask = { model: "claude-haiku-4-5", messages: [Message.user("Weather in Oslo?")], tools: [weather] };
const turn = await router.complete(ask);
const results = Object.fromEntries(turn.toolCalls.map((call) => [call.id, lookUpWeather(call.input.city)]));
const answer = await router.complete({ ...ask, messages: [...ask.messages, turn.message, Message.tool(results)] });
```

### Structured output

```ts
const reply = await router.complete({
  model: "gpt-4.1-mini",
  messages: [Message.user("A bat and a ball cost $1.10 in total. The bat costs $1.00 more. How much is the ball?")],
  config: {
    responseFormat: {
      type: "json_schema",
      name: "worked_answer",
      schema: {
        type: "object",
        properties: { reasoning: { type: "string" }, answer: { type: "string" } },
        required: ["reasoning", "answer"],
        additionalProperties: false,
      },
    },
  },
});
console.log(JSON.parse(reply.text!).answer);
```

The schema is sent as written, keys in your order: a model fills a
structured answer in the order its schema lists the fields.

### Images and documents

```ts
import { image, text } from "@lm15/lm15";

const photo = image({ path: "camera-trap.jpg" }); // or { url }, { data }, { fileId }
await router.complete({ model: "gpt-4.1-mini", messages: [Message.user([text("What animal is this?"), photo])] });
```

### When a provider can't do what you asked

Change the model and the program keeps working: when a provider can't take
a setting as asked, lm15 adapts the request and records what it changed,
on the response, never silently.

```ts
const r = await router.complete({ model: "claude-haiku-4-5", messages: [Message.user("hi")], config: { seed: 7, temperature: 1.5 } });
for (const a of r.adaptations) console.log(a.field, a.action, a.reason);
// config.seed dropped — the Messages API has no seed field
// config.temperature clamped — the Messages API accepts temperature in [0, 1]
await router.plan(request);             // the same record, with no network and no key
new LMRouter({ adaptations: "refuse" }); // or: throw before sending instead
```

### Errors

Every failure is an `LM15Error` subclass (`RateLimitError`, `AuthError`,
`ContextLengthError`, `UnsupportedFeatureError`, ...) with the provider's
code and message, and rate-limit evidence (`retryAfter`,
`rateLimitHeaders`) when the provider sent it.

### Judgments

Declared answers in, a probability for each out, where the provider can
measure them:

```ts
import { judgments, choice, yesNo } from "@lm15/lm15";

const verdict = await router.complete({
  model: "typesafe:jev-latest", // or any chat model: the pick, without the numbers
  messages: [Message.user("Ripe blackberry, firm tannins, long finish.")],
  config: {
    responseFormat: judgments({ style: choice("Dominant style?", ["fruit", "oak", "mineral"]), ages: yesNo("Will it improve with age?") }),
    probabilities: "if_available",
  },
});
verdict.data;          // { style: "fruit", ages: true }
verdict.probabilities; // { style: { fruit: 0.9, oak: 0.08, mineral: 0.02 }, ages: { true: 0.97, false: 0.03 } }
```

### In a browser

```ts
import { OpenAIChatLM, Message, ResponseStream } from "@lm15/lm15/browser";

const lm = new OpenAIChatLM({ apiKey: userKey, baseUrl: "http://localhost:1234/v1", compat: "lmstudio" });
const request = { model: "your-model-id", messages: [Message.user("hi")] };
for await (const text of new ResponseStream(lm.stream(request, { signal }), request)) render(text);
```

The browser entry is the Node entry without the host services (environment
variables, files, CLI logins, cloud credential chains); each refuses by name
instead of being skipped. A credential in a page is explicit: the user's
own, or a short-lived token from your backend. See
[docs/browser.md](docs/browser.md).

### Sign in once, use everywhere

Besides API keys, lm15 can use an account you sign in to (a ChatGPT, Claude,
xAI, GitHub Copilot, Kimi Code or OpenRouter login), saved in one file every
lm15 language shares: `Auth`, `connect()` and `new LMRouter({ auth })`.
It is in this repository's source and ships in the next release (it is not
in 1.0.0-rc.1). Sign-in is **provisional**. See
[docs/managed-login.md](docs/managed-login.md).

### More

Reasoning controls, prompt caching, built-in provider tools (web search,
code execution), files and batches, image and speech generation, video,
realtime sessions, the model catalog, `explainAuth` (why a key is or isn't
used, without printing it), and reading an OpenAI Chat Completions request
into lm15: see the [guides](https://lm15.dev/docs/).

## Stability

The chat core is stable in 1.x once 1.0.0 is released: requests, responses,
streaming, tools, structured output, media inside messages, reasoning,
errors, credentials and model listing. These ship as **provisional** and may
still change in 1.x, with a notice in the contract: files, batches, media
generation, stored caches, realtime sessions, Chat Completions ingest and
sign-in.

## Conformance

Graded by [lm15-contract](https://github.com/lm15-dev/lm15-contract) at the
commit in `CONTRACT_PIN`: every check passes (1,788 of 1,788 on
2026-09-26), the same as Python, Rust and Go at theirs. The checks compare
the exact requests lm15 builds and the responses it reads against recorded
provider traffic. The package's own tests also replay the corpus through
the browser entry in a realm with only web globals.

TypeScript-specific differences from the Python reference, the source
layout, and the development gates: [docs/port-notes.md](docs/port-notes.md).

## Development

```bash
npm install          # dev tooling only
npm run build        # dist/ (ESM, CJS, types)
npm test
cd ../lm15-contract && python3 harness/check.py --shim typescript --direction all
```

The website, documentation and playground live in the
[website](https://github.com/lm15-dev/website) repository.

## License

MIT. See [LICENSE](LICENSE).
