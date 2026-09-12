# lm15-ts

The TypeScript port of lm15: one canonical request/response model over every
provider the [lm15-contract](https://github.com/lm15-dev/lm15-contract) names,
byte-exact against its corpus. Async only, `fetch` + `WebSocket` (Node 22+),
zero npm runtime dependencies. The same package has a web entry point,
`lm15/browser` — the whole wire, none of the host — for pages, workers,
PWAs and Electron renderers ([docs/browser.md](docs/browser.md)). Stored-credential refresh/writes require Linux
and util-linux `flock`; explicit credentials work without it. One npm package serves TypeScript and plain
JavaScript (ESM and CommonJS, with `.d.ts`).

The contract commit this port is built against is in `CONTRACT_PIN`;
`harness/check.py` refuses to grade the port against any other commit.

## Status

**Passing the pinned corpus, not a claim of SDK or release completeness.**
Every harness direction is green at the pin, with zero failures and no skips
added; the two skips are corpus gaps (`openai.computer_use` has no canonical
request and no golden). Runtime correctness is tested separately; see
[the correctness review and remaining work](docs/runtime-correctness.md).

| Direction | Contract surface | Result |
|---|---|---|
| `serde` | spec/types.md, spec/vocabularies.md, spec/invariants.md, docs/serde-rules.md; all 36 kinds | 115 / 0 |
| `error` | ErrorCode + class hierarchy; `normalizeError` per provider | 84 / 0 |
| `auth` | spec/auth.md AUTH-1/2/5/7/8/10 and the three cloud chains (AUTH-11) | 37 / 0 |
| `token` | SigV4 (34 vectors), RS256 JWTs, token exchanges | 43 / 0 |
| `request` | the four dialects, request side; MAP-5..8, MAP-10; hosts, presets | 365 / 0 (1 skip) |
| `response` | the four dialects, response side; MAP-1..4 | 302 / 0 (1 skip) |
| `stream` | SSE decoding, MAP-3/4 coalescing, MAP-9 assembly and its refusal | 40 / 0 |
| `router` | the three rungs, precedence, `unknown_model` / `ambiguous_model` | 22 / 0 |
| `models` | `listModels` on every provider | 34 / 0 |
| `files`, `batch`, `cache` | the three surfaces, multipart byte for byte, MAP-11 id escaping | 48 / 0, 41 / 0, 11 / 0 |
| `generation`, `video` | image and speech generation, video jobs (MAP-11) | 20 / 0, 27 / 0 |
| `live` | the websocket codec (OpenAI Realtime, Gemini Live) | 24 / 0 |
| `ingest` | MAP-12: a Chat Completions request body → `Request` under one preset's spellings; the 118 recorded chat bodies round-trip (21 pinned lossy), 42 foreign shapes (11 refusals; the SDK's and litellm's dumped message objects, `annotations` → CitationPart). Provisional; module 4b | 160 / 0 |

Beyond the harness: `npm test` (node:test) covers the JSON
fidelity layer, every INV-* invariant, the coalescer and the MAP-9 assembler,
credential secrecy, the lock and atomic writes, the doctor, the router, an
end-to-end call through a fake transport, and a replay of the sibling corpus
through the library directly (serde, errors, SigV4, router, every pinned
request, body and stream with a golden, and every chat body read back
through `requestFromOpenAIChat`). Runtime regression tests additionally cover
generic serialization, unsafe integers, direct-provider validation, stream
pause/drain/cancellation, real local HTTP cancellation, timeouts, websocket
failure paths, Python/Node lock exclusion, and lock release after process death.
The Python interoperability check skips if Python is unavailable; kernel-lock
tests skip off Linux.

Outside the corpus: `tools/differential.py` (194 request comparisons against
the reference, zero differences — the Rust port's 30 probes plus ten
JavaScript-specific ones: integral floats, opaque-payload numbers, unicode,
empty strings) and `tools/differential_surfaces.py` (177 files / batch /
cache / generation / video / live comparisons, zero differences).

Live proof, keys from the environment (`receipts/2026-09-08-live-smoke/`):
one `complete` and one `stream` per dialect through the router (OpenAI,
Anthropic, Gemini, Groq — token counts identical to the Rust port's receipts
of 2026-09-07), and one text turn over Gemini Live through `LiveSession`.
Every one worked on first contact with the real server.

### Not exercised live, stated

Files, batches, caches, image/video generation, the cloud credential chains
(no AWS / Azure / GCP account on this machine), the OAuth refresh wire, the
xAI device-code login, and OpenAI Realtime. The harness pins recorded
lifecycles, token vectors and transcripts for all of them. Those fixtures prove
recorded wire behavior, not working network lifecycles or release readiness.

## Gates

```bash
npm install                    # dev tooling only: typescript, @types/node
npm run build                  # regenerates src/surface.ts, emits dist/ (ESM + CJS + d.ts)
npm test                       # node:test; replays ../lm15-contract when present
npm run differential           # both probes against ../lm15-python
npm run test:browser           # the web entry in Chromium and Firefox, headless (needs the browsers)
npm run test:example           # the example page's modules through a real PKCE redirect, same browsers
npm run example                # open the provider-neutral page; enter your own API key
npm run example:local          # opt in to private localhost test keys from ../.env
npm run example:openrouter     # the separate OpenRouter OAuth protocol example
npm run test:providers         # provider selection, key isolation, and the private handoff tests
cd ../lm15-contract && python3 harness/check.py --shim typescript --direction all
```

`npm test` also evaluates the web entry inside a realm with only web globals
and replays the corpus through it (`tests/web_realm.test.ts`).

## Quick start

```ts
import { LMRouter, Message, ResponseStream, tool } from "lm15";

const router = new LMRouter(); // keys from the environment (AUTH-1)
const request = {
  model: "groq:openai/gpt-oss-20b", // or "claude-haiku-4-5", "gpt-4.1-mini", "gemini-2.5-flash"
  messages: [Message.user("hi")],
  config: { maxTokens: 100 },
};

// One call.
const response = await router.complete(request);
console.log(response.text);

// Streamed: text as it arrives, then the same Response `complete` returns.
const rs = new ResponseStream(router.stream(request), request);
for await (const text of rs) process.stdout.write(text);
const streamed = await rs.response();

// How was it routed? `resolve` is pure: no network, no files, no secrets.
console.log(router.resolve("grok-4"));

// Tools: the schema is written by you; the loop is yours.
const weather = tool("get_weather", {
  description: "Current weather for a city",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
});
const turn = await router.complete({ model: "claude-haiku-4-5", messages: [Message.user("Weather in Oslo?")], tools: [weather] });
for (const call of turn.toolCalls) {
  const result = await lookUp(call.input);
  const next = await router.complete({
    model: "claude-haiku-4-5",
    messages: [Message.user("Weather in Oslo?"), turn.message, Message.tool(call.id, JSON.stringify(result))],
    tools: [weather],
  });
}

// Explicit configuration.
const configured = new LMRouter({
  apiKeys: { anthropic: process.env.MY_KEY! },
  settings: { "bedrock-chat": { region: "us-east-1" } },
});

// Providers, direct.
import { OpenAILM, AnthropicLM, GeminiLM, OpenAIChatLM, XaiLM, ClaudeCodeLM, OpenAICodexLM } from "lm15";
const lm = new AnthropicLM({ apiKey: process.env.ANTHROPIC_API_KEY! });
await lm.listModels();

// Why is my key (not) being used? No secrets are printed.
import { explainAuth, describeReport } from "lm15";
console.log(describeReport(explainAuth("groq")));
```

Plain JavaScript users import the same package; the types are optional.

## In a browser

```ts
import { OpenAIChatLM, Message, ResponseStream } from "lm15/browser";

const lm = new OpenAIChatLM({ apiKey: userKey, baseUrl: "http://localhost:1234/v1", compat: "lmstudio" });
const request = { model: "your-model-id", messages: [Message.user("hi")] };
const rs = new ResponseStream(lm.stream(request, { signal }), request);
for await (const text of rs) render(text);
```

The web entry is the Node entry minus the host services: no `process.env`,
no files, no CLI login stores, no cloud credential chains, no SigV4. Each of
those refuses by name (`NotConfiguredError` / `UnsupportedFeatureError`
naming the web platform and the fix) rather than being skipped. A
credential is explicit — the user's own, from an OAuth/PKCE exchange, or a
short-lived token from your backend; a file is bytes you supply. A bundler
resolving the `browser` condition gets this entry from `import "lm15"`.
The line, what a page cannot promise (CORS; a key in a page is not a
secret), and the evidence behind the claim — the corpus replayed in a
web-only realm, Chromium and Firefox headless — are in
[docs/browser.md](docs/browser.md). The default
[provider-neutral example](examples/provider-page/README.md) takes your own
API key and connects directly to your chosen provider. The separate
[OpenRouter OAuth example](examples/openrouter-page/README.md) tests PKCE
sign-in; it is not required to use LM15.

## Stated deviations

Each row names the rule it deviates from (playbooks/port.md rule 8).

- **Integral floats inside opaque payloads authored in JavaScript** (docs/
  serde-rules.md, Number rule 4). JavaScript has one number type: a literal
  `{ extensions: { x: 1.0 } }` is `1` by the time lm15 sees it and is emitted
  as the integer `1`. Wire-originated payloads keep their form: `parseJson`
  preserves integral-float and big-integer lexemes as `RawNumber`, so
  `serde_roundtrip` and every response are byte-exact. Typed float fields
  (`temperature`, `top_p`, `logprob`, pricing) are always emitted as floats.
  Use `new RawNumber("1.0")` to force a float lexeme by hand.
- **Shared credential locking requires Linux and util-linux `flock`**
  (spec/auth.md AUTH-4). The utility locks a descriptor inherited from Node;
  Node retains the kernel lock after the utility exits. The `<digest>.lock`
  path and primitive match Python/Rust; process death releases the lock.
  Missing utility or unsupported platform fails explicitly, with no fallback.
  Existing processes using the old `.node.lock` implementation must be stopped
  before upgrading. Foreign CLIs still do not cooperate with lm15's lock.
- **Typed integers must fit JavaScript's safe integer range.** Larger counters
  and overflowing computed totals are rejected, never rounded. Opaque JSON
  payloads still preserve arbitrarily large integer lexemes using `RawNumber`.
- **Generic serialization does not guess a plain object's type.** Factory-made
  canonical values remember their kind out of band. Use `toJSON(value, "delta")`
  or `Delta.toJSON(value)` for literals, copied objects, or values from another
  package instance. A text part, text delta and live text event can share a shape.
- **Platform fetch cannot separately configure connection timing or proxies.**
  `FetchTransport` exposes header-wait and per-chunk idle deadlines (60s each;
  streaming provider requests set a 120s read deadline), plus an optional total
  deadline. A request's `readTimeout` overrides the transport default. Supply a
  configured fetch/Transport for connection-specific settings, TLS and proxies.
  An unsupported request-level `connectTimeout` is rejected, not ignored.
- **No schema derivation from a function signature** (api-family.md § Tools):
  `tool(name, { parameters })` takes the JSON Schema you write. Stated once
  for all three non-Python ports.
- **Job handles and live turns** (api-family § Beyond chat, 2026-09-11,
  pending ratification): `lm.batch(...)` / `batchJob(id)` / `batches()` →
  `BatchJob`; `lm.videoGenerate(...)` / `videoJob(id)` / `videoJobs()` →
  `VideoJob`; `wait({ pollEveryMs, timeoutMs, signal })` is the only thing
  that waits, and a deadline that elapses throws a `DOMException` named
  `TimeoutError` (the caller's own deadline; no lm15 code). `session.turn()`
  iterates one turn (LIVE-1) and `await turn.result()` materializes it with
  the bill summed per LIVE-2. The pure verbs are unchanged and are what the
  harness pins.
- **Post-completion stream failures are reported with `process.emitWarning`**
  (contract `changes/2026-09-11-stream-completion-and-error-metadata.md` § 2;
  Python: `StreamCleanupWarning`). The warning's `type` is
  `StreamCleanupWarning`; `ResponseStream.cleanupErrors` holds the failures.
  Outside Node (no `process.emitWarning`) it falls back to `console.warn`.
- **The router's rung 0** (a `provider` attribute on a `str` subclass) is a
  Python idiom with no TypeScript equivalent; `provider:model` and catalogs
  cover the same ground (spec/vocabularies.md names only the three rungs the
  harness pins).
- **`surface_dump` is reflection at build time**, not at call time
  (harness/PROTOCOL.md): TypeScript erases types, so `tools/gen_surface.ts`
  reads the compiler's view of `src/types/*.ts` and writes `src/surface.ts`
  on every build. It is never edited by hand.
- **`aws-event-stream` framing** (phase 2, `bedrock` Converse) is not
  implemented, exactly as in the reference; the request refuses with
  `UnsupportedFeatureError` and `replay_stream` refuses the framing.

## Layout

| Path | What |
|---|---|
| `src/json.ts` | JSON with number fidelity: `RawNumber`, `parseJson`, `stringifyJson`, `float` |
| `src/types/` | every canonical type: interface, validating constructor, `fromJSON`/`toJSON` |
| `src/vocab.ts`, `src/errors.ts` | the closed vocabularies; the error hierarchy |
| `src/platform.ts`, `src/platform_node.ts` | the host boundary: the `Platform` interface and the web default; Node's services, installed by the `lm15` entry |
| `src/browser.ts`, `src/bytes.ts` | the web entry point (`lm15/browser`); base64/UTF-8 without `Buffer` |
| `src/auth/` | access policies (AUTH-10), stored credentials and the lock (AUTH-3/4/8/9), the doctor (AUTH-7), JWT claims (`jwt.ts`) |
| `src/cloud/` | the three cloud chains (AUTH-1/11), SigV4, RS256, host rewrites |
| `src/compat.ts`, `src/registry.ts` | compat presets and the provider table, copied as data |
| `src/adapter.ts`, `src/dialects/` | the shared adapter base; OpenAI Responses, OpenAI Chat, Anthropic, Gemini, xAI |
| `src/stream.ts` | SSE, the MAP-3/4 coalescer, the MAP-9 accumulator, `ResponseStream` |
| `src/router.ts`, `src/live.ts` | `LMRouter`; `LiveSession` over the platform WebSocket |
| `src/testing.ts` | `lm15/testing`: `FakeLM`, `FakeTransport`, `FakeResponse` |
| `src/canonical.ts` | Out-of-band type identity for generic serialization |
| `src/vet.ts`, `src/vet_*.ts` | the vet shim (`node dist/vet.js`) |
| `examples/openrouter-page/` | the browser example: PKCE sign-in, models, streaming, cancel; its README lists what building it surfaced |
| `tools/` | surface generator, differential probes, live smoke, the headless harness (`headless.ts`), the SDK and example browser smokes, the static server |
| `receipts/` | live evidence, secrets redacted (`tools/check_secrecy.py` passes) |
