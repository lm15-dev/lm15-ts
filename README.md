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

Honest status: this port passes 304 contract checks across all five
harness directions (request 110, response 102, stream 8, error 16,
serde 68; 0 fail, 4 skip). It covers the pure chat core only — live
transport, file upload, batch, embeddings and the other endpoints are
NOT implemented yet.

Zero runtime dependencies. Node >= 22.

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
