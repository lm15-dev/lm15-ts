#!/usr/bin/env node
/**
 * lm15-vet — the lm15-ts vet shim (harness/PROTOCOL.md).
 *
 * One JSON request per stdin line, one JSON reply per stdout line, same
 * order. The shim only transforms; the harness compares and sandboxes it
 * without network. Every op calls the same public functions users call;
 * the op table lives in `vet_ops.ts`.
 */

import { createInterface } from "node:readline";
import { handleMessage } from "./vet_ops.ts";
import "./vet_adapter_ops.ts";
import { parseJson, stringifyJson, isJsonObject } from "./json.ts";

async function main(): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let reply: unknown;
    try {
      const msg = parseJson(line);
      if (!isJsonObject(msg)) throw new TypeError("request must be a JSON object");
      reply = await handleMessage(msg);
    } catch (e) {
      const err = e as Error;
      reply = { id: null, ok: false, error: { type: err?.name ?? "Error", message: String(err?.message ?? e) } };
    }
    process.stdout.write(stringifyJson(reply) + "\n");
  }
}

main().catch((e) => {
  process.stderr.write(String((e as Error).stack ?? e) + "\n");
  process.exit(1);
});
