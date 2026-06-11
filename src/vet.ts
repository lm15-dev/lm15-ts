/**
 * lm15 vet shim (TypeScript) — harness/PROTOCOL.md.
 *
 * One JSON object per stdin line, one JSON object per stdout line, same
 * order. Zero runtime dependencies; never touches the network. All JSON I/O
 * goes through the canonical codec so int-vs-float survives the round trip.
 *
 * Implemented: capabilities, serde_roundtrip, validate, surface_dump
 * (Stage A); normalize_error (Stage B). The remaining transform ops
 * (build_request, parse_response, replay_stream) reply ok:false /
 * "Unimplemented" until the adapter stages land.
 */

import { createInterface } from "node:readline";

import { adapterForProvider } from "./adapters/index.js";
import {
  isJsonObject,
  parseCanonicalJson,
  stringifyCanonicalJson,
  type JsonObject,
  type JsonValue,
} from "./canonical-json.js";
import { ValueError } from "./errors.js";
import { normalizeError, normalizedErrorToDict } from "./normalize-error.js";
import { requestFromDict, responseToDict, serdeForKind, streamEventToDict } from "./serde.js";
import { parseSse, splitBodyLines } from "./sse.js";
import { coalesceStream, materializeResponse } from "./stream.js";
import { surfaceDump } from "./surface.js";
import type { StreamEvent } from "./types.js";

const LANGUAGE = "typescript";
const IMPL_VERSION = "0.1.0";

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

function opBuildRequest(msg: JsonObject): JsonValue {
  const baseUrl = msg["base_url"] !== undefined && msg["base_url"] !== null
    ? String(msg["base_url"])
    : null;
  const adapter = adapterForProvider(String(msg["provider"]), String(msg["api_key"]), baseUrl);
  const request = requestFromDict(msg["canonical_request"] as JsonValue);
  const wire = adapter.buildRequest(request, Boolean(msg["stream"] ?? false));
  return {
    method: wire.method,
    url: wire.url,
    params: wire.params,
    headers: wire.headers,
    body: wire.body,
  };
}

function opParseResponse(msg: JsonObject): JsonValue {
  const baseUrl = msg["base_url"] !== undefined && msg["base_url"] !== null
    ? String(msg["base_url"])
    : null;
  // parse_response never authenticates; the key is a placeholder.
  const adapter = adapterForProvider(String(msg["provider"]), "vet-parse-only", baseUrl);
  const request = requestFromDict(msg["canonical_request"] as JsonValue);
  const bodyText = Buffer.from(String(msg["body_b64"]), "base64").toString("utf8");
  const body = parseCanonicalJson(bodyText);
  const response = adapter.parseResponse(request, Number(msg["status"]), body);
  const result: JsonObject = { canonical_response: responseToDict(response) };
  const unmapped = response.provider_data?.["_lm15_unmapped"];
  if (unmapped !== undefined) result["unmapped"] = unmapped;
  return result;
}

function opNormalizeError(msg: JsonObject): JsonValue {
  const err = normalizeError(
    String(msg["provider"]),
    Number(msg["status"]),
    String(msg["body_text"]),
  );
  return normalizedErrorToDict(err) as unknown as JsonValue;
}

function opSurfaceDump(): JsonValue {
  return surfaceDump() as unknown as JsonValue;
}

function opReplayStream(msg: JsonObject): JsonValue {
  const baseUrl = msg["base_url"] !== undefined && msg["base_url"] !== null
    ? String(msg["base_url"])
    : null;
  const adapter = adapterForProvider(String(msg["provider"]), "vet-parse-only", baseUrl);
  const request = requestFromDict(msg["canonical_request"] as JsonValue);
  const bodyText = Buffer.from(String(msg["body_b64"]), "base64").toString("utf8");
  const rawEvents: StreamEvent[] = [];
  for (const sse of parseSse(splitBodyLines(bodyText))) {
    rawEvents.push(...adapter.parseStreamEvents(request, sse));
  }
  // MAP-3: the canonical event trace is the POST-coalesce trace — exactly
  // one merged StreamEndEvent, final.
  const events = coalesceStream(rawEvents);
  const response = materializeResponse(events, request);
  const result: JsonObject = {
    events: events.map((e) => streamEventToDict(e)),
    canonical_response: responseToDict(response),
  };
  const unmapped = response.provider_data?.["_lm15_unmapped"];
  if (unmapped !== undefined) result["unmapped"] = unmapped;
  return result;
}

const HANDLERS: Record<string, Handler> = {
  capabilities: opCapabilities,
  build_request: opBuildRequest,
  parse_response: opParseResponse,
  replay_stream: opReplayStream,
  normalize_error: opNormalizeError,
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

// Run the JSONL loop only when executed as the entrypoint (node dist/vet.js),
// not when handleLine is imported by tests.
if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
