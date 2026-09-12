# lm15 in the browser

`lm15/browser` is the web entry point of the same package: the whole wire,
none of the host. It runs in a page, a module worker, a PWA, an Electron
renderer, and in Node itself. A bundler that resolves the `browser`
condition gets it from `import "lm15"` without being asked.

```ts
import { OpenAIChatLM, Message, ResponseStream } from "lm15/browser";

const lm = new OpenAIChatLM({ apiKey: userKey, baseUrl: "http://localhost:1234/v1", compat: "lmstudio" });
const request = { model: "your-model-id", messages: [Message.user("hi")] };

const response = await lm.complete(request);
const rs = new ResponseStream(lm.stream(request, { signal }), request);
for await (const text of rs) render(text);
```

The essence of lm15 is faithful communication: what you mean, translated
exactly to the provider's wire and back, with differences named rather than
hidden. That part is universal. Where a credential or a file *comes from*
is the host's business, and the web entry never guesses it. This document
states the line.

## Included: the whole wire

Everything the Node entry has that is about communication:

- The canonical types with their validation, the serde, the closed vocabularies.
- Every dialect (OpenAI Responses, OpenAI Chat Completions, Anthropic, Gemini,
  xAI) and every compat preset, byte for byte the contract's.
- Request building without sending (`lm.buildRequest`), so a page can show
  what would go on the wire.
- `complete`, `stream` with cancellation, the MAP-3 coalescer, the MAP-9
  assembler, `ResponseStream`.
- The router: `provider:model` strings, catalogs, explicit `apiKeys`,
  `baseUrls`, `settings`, and `explainAuth`.
- Live sessions over the page's `WebSocket` where the provider's protocol
  allows a browser to open one.
- The other surfaces a door carries — files, batches, caches, image and
  speech generation, video jobs — from bytes you supply.
- The fetch transport, and `lm15/testing` (`FakeTransport`, `FakeLM`).

Every one of those is exercised in the web build by the same corpus that
pins the Node build, plus a real-browser run (below).

## Included: the browser's own ways to supply what the host used to

| The Node host supplies | The page supplies instead |
|---|---|
| `process.env` keys | an explicit credential: `apiKey`, `RouterConfig.apiKeys`, or a `CredentialProvider` callback (a user's own key from an OAuth/PKCE exchange, a short-lived token from your token endpoint) |
| a path to read | the bytes: a `File`, a `Blob`'s bytes, an IndexedDB or OPFS read, as `data` on the part or `bytes` on the upload |
| a stored CLI login | nothing by default; an application with a bridge (an Electron preload, a host extension) installs a `Platform` that answers |
| a cloud credential chain | an explicit `BearerToken` from the application's own token endpoint |
| SigV4 over `node:crypto` | nothing yet; a `Platform.signSigV4` over Web Crypto is the extension point |
| a header-capable `WebSocket` | the provider's client-token scheme, or a header-capable `WebSocket` passed in `LiveSessionOptions` |

A local endpoint — LM Studio, ollama, a vLLM box, a future local model that
offers itself to pages — is an ordinary destination, not an exception.

## Refused, by name

Each of these is a typed error whose message names the platform and the fix.
None is skipped silently; none succeeds by pretending.

- A stored-login policy with no explicit credential:
  `NotConfiguredError: claude-code: no credential given, and stored logins are not available on the web platform …`
- A path-addressed part or upload:
  `UnsupportedFeatureError: path "/x.png": the web platform has no filesystem; supply the bytes …`
- A cloud chain door with no explicit credential:
  `NotConfiguredError: bedrock-chat: the aws-chain credential chain is not available on the web platform …`
- `AwsCredentials` on a SigV4 door:
  `NotConfiguredError: bedrock-chat: SigV4 signing is not available on the web platform …`
- A live session whose protocol needs a request header on the websocket:
  `UnsupportedFeatureError: openai: live sessions need request headers on the websocket, which the web platform's WebSocket cannot send …`
- A bare model with no `apiKeys`: the router's ordinary `NotConfiguredError`
  naming `apiKeys` — there is no environment to read.

The doctor (`explainAuth`) reports the same rungs absent that the router
skips, so a page can show a user *why* nothing is configured.

## Not lm15's job, on either host

No automatic tool loop, retries, fallbacks, model ranking, conversation
storage, credential persistence, model downloads, or UI. An application
builds those on lm15; lm15 never decides them.

## What a page cannot promise

Two facts sit outside this package and no packaging changes them:

- **CORS.** A browser sends a cross-origin request only where the server's
  headers permit it. Some providers permit it (OpenRouter's Chat Completions
  door answers the preflight for any origin, observed 2026-09-11); some do
  not. A local server permits what its operator configures.
- **A secret in a page is not a secret.** A key embedded in a public site is
  every visitor's. The browser-appropriate shapes are the user's own
  credential, obtained by the user (OAuth/PKCE), and short-lived tokens
  minted by your backend. lm15 accepts both; it stores neither.

"Runs in a browser" and "can reach provider X from a browser" are separate
claims with separate evidence.

## The boundary as code

`src/platform.ts` is the interface; `webPlatform` is the default (no
services; the safe direction, so a bundle that never loads the Node entry
cannot read a file by accident); `src/platform_node.ts` is Node's, installed
by `import "lm15"`. An application installs its own with
`setDefaultPlatform(...)`; the default is process-wide, like the default
transport.

```ts
interface Platform {
  readonly name: string;
  env(): Env;
  readonly readFile?: (path: string) => Uint8Array;
  readonly storedCredentials?: StoredCredentials;       // AUTH-8
  readonly openCloudChain?: (opts) => CloudChain;       // AUTH-11
  readonly signSigV4?: (input) => Headers | Promise<Headers>;
  readonly webSocketHeaders: boolean;
}
```

## The examples

`examples/provider-page/` is the playground: choose a provider, supply
your own key (**Get a key ↗** opens the provider's key page from the
registry), and chat — with the exact request beside you in JavaScript,
Python, Rust, JSON and curl, and a **Run in** switch that sends the turn
through the real SDK of each language: this entry point, lm15-python
under Pyodide, or lm15-rs compiled to wasm32. After a turn the page
builds the request in every loaded runtime and confirms the bytes match.
`npm run example` opens it; `npm run example:local` enables a private,
one-use localhost handoff of keys from `../.env` for testing. Its README
lists what building it surfaced, including a silent-omission bug in the
reference that only three languages side by side could show.

`examples/openrouter-page/` is a static page — no backend — that signs in
to OpenRouter with PKCE (lm15's `generatePkce`), lists models, streams
replies and cancels them, through this entry point. `npm run example:openrouter`
serves it; `npm run test:example` drives its modules through a real
redirect against a fake OpenRouter in Chromium and Firefox, and with
`--live` and `OPENROUTER_API_KEY`, against the real one — the receipt of
2026-09-11 (`receipts/2026-09-11-browser-openrouter-live/`) has 24 of 24
checks passing in both browsers, live. Its README lists what building it
surfaced.

## Evidence

Three tests, each a different kind:

1. `tests/browser_entry.test.ts` — static. Walks the web entry's runtime
   import graph with the TypeScript compiler: no `node:*` module, no bare
   import, no `Buffer`/`process`/`require`. The same auditor is pointed at
   the Node entry and must report its `node:*` imports, or its clean bill
   means nothing. Plus every refusal above, by name; plus the byte codec
   against `Buffer` on every length.
2. `tests/web_realm.test.ts` — dynamic, Node only. Evaluates the web entry
   inside a `vm` realm holding only web globals (no `process`, no `Buffer`)
   and replays the corpus: 342 canonical requests build to the same bytes as
   on the Node host, 337 pinned bodies (39 streams) parse to the same
   canonical response; the 20 SigV4 cases are the one stated difference —
   signed on Node, refused by name on the web. Node's agreement with the
   contract is pinned separately; the web entry's follows.
3. `tools/browser_smoke.ts` (`npm run test:browser`) — real engines. A
   loopback server serves the sources as JavaScript (types stripped on the
   fly; no bundler) and plays a Chat Completions door. Chromium 152 and
   Firefox 155, headless: `complete`, a three-chunk stream, a mid-stream
   cancel the server observes as a closed socket, a 401 arriving as
   `AuthError` with its status, a module worker, and every refusal. It found
   the one bug the other two could not: `fetch` called as a method of the
   transport is an "Illegal invocation" in a browser and fine in Node
   (fixed; pinned by a Node test with a receiver-checking fetch).

Not exercised: a live session from a page (Gemini Live puts the key in the
URL and should work; OpenAI Realtime needs a header the page cannot send —
refused by name), SigV4 over Web Crypto (not implemented), Safari/WebKit (no
engine on the machine that ran this).
