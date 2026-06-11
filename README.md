# lm15 (TypeScript)

TypeScript port of the lm15 canonical model, implemented from the contract
in `../lm15-contract` (spec/types.md, spec/invariants.md,
spec/vocabularies.md, harness/PROTOCOL.md and
`../lm15-python2/docs/serde-rules.md`).

Status — Stage A:

- Canonical types as plain readonly discriminated unions (`src/types.ts`)
  with validating factory constructors enforcing the numbered invariants.
- Canonical serde (`src/serde.ts`) — the single serializer module: one
  omission rule, opaque payloads verbatim, the Number rule via a
  float-preserving JSON codec (`src/canonical-json.ts`; `1.0` never
  collapses to `1`).
- Vet shim (`src/vet.ts` -> `dist/vet.js`): `capabilities`,
  `serde_roundtrip`, `validate`, `surface_dump`; transform ops reply
  `Unimplemented` until the adapter stages land.

Zero runtime dependencies. Node >= 22.

```sh
npm run build   # tsc -> dist/ (shim entry: dist/vet.js)
npm test        # node --test dist/tests/*.test.js
```

Conformance gate:

```sh
cd ../lm15-contract
lm15-python2/.venv/bin/python harness/check.py --shim typescript --direction serde
```
