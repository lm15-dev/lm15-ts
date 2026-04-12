# lm15

[![npm](https://img.shields.io/npm/v/lm15.svg)](https://www.npmjs.com/package/lm15)
[![Node 18+](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

One interface for OpenAI, Anthropic, and Gemini. Zero dependencies.

TypeScript implementation — conforms to the [lm15 spec](https://github.com/lm15-dev/spec).

```typescript
import * as lm15 from "lm15";

const resp = await lm15.call("claude-sonnet-4-5", "Hello.").text;
console.log(resp);
```

Switch models by changing the string. Same types, same streaming, same tool calling.

## Install

```bash
npm install lm15
```

Set at least one provider key:

```bash
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...
export GEMINI_API_KEY=...
```

Or use a `.env` file:

```typescript
import * as lm15 from "lm15";

lm15.configure({ env: ".env" });
const resp = await lm15.call("gpt-4.1-mini", "Hello.").text;
```

## Usage

### Blocking

```typescript
const resp = lm15.call("gpt-4.1-mini", "Hello.");
console.log(await resp.text);
console.log(await resp.usage);
console.log(await resp.finishReason);
```

### Streaming

```typescript
for await (const text of lm15.call("gpt-4.1-mini", "Write a haiku.")) {
  process.stdout.write(text);
}
```

### Streaming events

```typescript
for await (const event of lm15.call("gpt-4.1-mini", "Write a haiku.").events()) {
  switch (event.type) {
    case "text":     process.stdout.write(event.text!); break;
    case "thinking": process.stdout.write(`💭 ${event.text}`); break;
    case "finished": console.log(`\n📊 ${JSON.stringify(event.response!.usage)}`); break;
  }
}
```

### Tools (auto-execute)

```typescript
function getWeather(args: { city: string }): string {
  return `22°C in ${args.city}`;
}

const resp = lm15.call("gpt-4.1-mini", "Weather in Montreal?", {
  tools: [getWeather],
});
console.log(await resp.text);
```

### Reusable model with memory

```typescript
const gpt = lm15.model("gpt-4.1-mini", { system: "You remember everything." });

await gpt.call("My name is Max.").text;
await gpt.call("I like chess.").text;
const resp = await gpt.call("What do you know about me?").text;
console.log(resp);
```

### Multimodal

```typescript
import { Part } from "lm15";

const resp = lm15.call("gemini-2.5-flash", [
  "Describe this image.",
  Part.image({ url: "https://example.com/cat.jpg" }),
]);
console.log(await resp.text);
```

### Reasoning

```typescript
const resp = lm15.call("claude-sonnet-4-5", "Prove √2 is irrational.", {
  reasoning: true,
});
console.log(await resp.thinking);
console.log(await resp.text);
```

### Structured output (JSON)

```typescript
const resp = lm15.call("gpt-4.1-mini", "Extract: 'Alice is 30.'.", {
  system: "Return JSON: {name, age}",
  prefill: "{",
});
const data = await resp.json;
console.log(data);
```

## Architecture

Same layered design as the [Python implementation](https://github.com/lm15-dev/lm15-python):

```
call() / model()          ← high-level surface
        │
        ▼
Result (lazy, async iterable)
        │
        ▼
LMRequest → UniversalLM → ProviderAdapter → Transport (native fetch)
                                │
                        providers/{openai,anthropic,gemini}.ts
```

## Implementation status

| Layer | Status |
|---|---|
| Types (`Part`, `Message`, `LMRequest`, etc.) | ✅ |
| Error hierarchy | ✅ |
| SSE parser | ✅ |
| Transport (`fetch`-based, zero deps) | ✅ |
| Provider adapters (OpenAI, Anthropic, Gemini) | ✅ |
| UniversalLM client | ✅ |
| Middleware (retries, cache, history) | ✅ |
| Result (lazy stream, auto tool execution) | ✅ |
| Model (stateful, conversation memory) | ✅ |
| High-level API (`call`, `model`, `stream`, `configure`) | ✅ |
| Conversation helper | ✅ |
| Factory (`buildDefault`, env file parsing) | ✅ |
| Capability resolver | ✅ |
| Live sessions (WebSocket) | ✅ |
| Serde (JSON round-tripping) | ✅ |
| Cost estimation | ✅ |
| Model discovery (live + models.dev) | ✅ |
| File upload | ✅ |

## Related

- [lm15 spec](https://github.com/lm15-dev/spec) — canonical type definitions and test fixtures
- [lm15 Python](https://github.com/lm15-dev/lm15-python) — reference implementation

## License

MIT
