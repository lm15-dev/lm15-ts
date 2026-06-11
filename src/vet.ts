/**
 * lm15 vet shim (TypeScript) — harness/PROTOCOL.md.
 *
 * One JSON object per stdin line, one JSON object per stdout line, same
 * order. Zero runtime dependencies; never touches the network. All JSON I/O
 * goes through the canonical codec so int-vs-float survives the round trip.
 *
 * Stage A implements: capabilities, serde_roundtrip, validate,
 * surface_dump. The transform ops (build_request, parse_response,
 * replay_stream, normalize_error) reply ok:false / "Unimplemented" until
 * the adapter stages land.
 */

import { createInterface } from "node:readline";

import {
  isJsonObject,
  parseCanonicalJson,
  stringifyCanonicalJson,
  type JsonObject,
  type JsonValue,
} from "./canonical-json.js";
import { ValueError } from "./errors.js";
import { serdeForKind } from "./serde.js";
import { surfaceDump } from "./surface.js";

const LANGUAGE = "typescript";
const IMPL_VERSION = "0.1.0";

class Unimplemented extends Error {
  constructor(op: string) {
    super(`op not implemented yet: ${op}`);
    this.name = "Unimplemented";
  }
}

type Handler = (msg: JsonObject) => JsonValue;

function opCapabilities(): JsonValue {
  return {
    language: LANGUAGE,
    ops: Object.keys(HANDLERS).sort(),
    impl_version: IMPL_VERSION,
  };
}

function opSerdeRoundtrip(msg: JsonObject): JsonValue {
  const [fromDict, toDict] = serdeForKind(String(msg["kind"]));
  return { value: toDict(fromDict(msg["value"] as JsonValue)) };
}

function opValidate(msg: JsonObject): JsonValue {
  const [fromDict, toDict] = serdeForKind(String(msg["kind"]));
  const obj = fromDict(msg["value"] as JsonValue);
  return { ok: true, normalized: toDict(obj) };
}

function opSurfaceDump(): JsonValue {
  return surfaceDump() as unknown as JsonValue;
}

const unimplemented = (op: string): Handler => () => {
  throw new Unimplemented(op);
};

const HANDLERS: Record<string, Handler> = {
  capabilities: opCapabilities,
  build_request: unimplemented("build_request"),
  parse_response: unimplemented("parse_response"),
  replay_stream: unimplemented("replay_stream"),
  normalize_error: unimplemented("normalize_error"),
  serde_roundtrip: opSerdeRoundtrip,
  validate: opValidate,
  surface_dump: opSurfaceDump,
};

function errorReply(reqId: JsonValue, err: unknown): JsonObject {
  const name = err instanceof Error ? err.name : "Error";
  const message = err instanceof Error ? err.message : String(err);
  return { id: reqId, ok: false, error: { type: name, message } };
}

export function handleLine(line: string): JsonObject {
  let msg: JsonValue;
  try {
    msg = parseCanonicalJson(line);
  } catch (err) {
    return errorReply(null, err);
  }
  if (!isJsonObject(msg)) {
    return errorReply(null, new ValueError("request must be a JSON object"));
  }
  const reqId = msg["id"] ?? null;
  try {
    const op = msg["op"];
    const handler = HANDLERS[String(op)];
    if (handler === undefined) {
      throw new ValueError(`unknown op: ${String(op)}`);
    }
    return { id: reqId, ok: true, result: handler(msg) };
  } catch (err) {
    return errorReply(reqId, err);
  }
}

export function main(): void {
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line: string) => {
    if (line.trim() === "") return;
    process.stdout.write(stringifyCanonicalJson(handleLine(line)) + "\n");
  });
}

main();
