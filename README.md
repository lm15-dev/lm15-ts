# lm15-ts

TypeScript port of lm15, rebuilt module-by-module against the
[lm15-contract](https://github.com/lm15-dev/lm15-contract) corpus after the
stale v1 implementation was removed (2026-08-31). Zero runtime
dependencies.

## Status

| Module | Contract surface | State |
|---|---|---|
| `src/auth.ts` | spec/auth.md AUTH-1/2/5/7 + AUTH-8 read side | fixture-verified (`conformance/auth_resolution.json`) |
| everything else | — | not yet rebuilt |

The auth module ships: the `Credential` type (static string or zero-arg
provider callable), the resolution chain + `explainAuth` doctor report, and
read-only borrowed-credential loaders for the Claude Code and Codex CLI
files (token material in true `#private` fields; toString/inspect/JSON all
redacted). Not yet implemented (stated, not absorbed): the AUTH-3/4 write
side (locked double-checked refresh, atomic 0600 writes) and the AUTH-9
login primitives.

```bash
npm install   # dev tooling only (typescript, @types/node)
npm run check # tsc --noEmit
npm test      # node --experimental-strip-types --test
```
