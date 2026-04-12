# lm15

One interface for OpenAI, Anthropic, and Gemini. Zero dependencies.

TypeScript implementation — conforms to the [lm15 spec](https://github.com/lm15-dev/spec).

> 🚧 **Early development.** Types, errors, SSE, and transport are implemented. Provider adapters and high-level `call()` API coming next.

## Install

```bash
npm install lm15
```

## Status

| Layer | Status |
|---|---|
| Types (`Part`, `Message`, `LMRequest`, etc.) | ✅ |
| Error hierarchy | ✅ |
| SSE parser | ✅ |
| Transport (`fetch`-based) | ✅ |
| Provider adapters (OpenAI, Anthropic, Gemini) | 🔜 |
| High-level API (`call`, `model`, `Result`) | 🔜 |
| Live sessions (WebSocket) | 🔜 |

## Architecture

Same layered design as the [Python implementation](https://github.com/lm15-dev/lm15-python):

```
call() / model()          ← high-level surface (coming soon)
        │
        ▼
LMRequest → Adapter → Transport (native fetch)
```

## Related

- [lm15 spec](https://github.com/lm15-dev/spec) — canonical type definitions and test fixtures
- [lm15 Python](https://github.com/lm15-dev/lm15-python) — Python implementation

## License

MIT
