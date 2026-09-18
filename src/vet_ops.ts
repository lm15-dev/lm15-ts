/**
 * The vet protocol op table (harness/PROTOCOL.md § Ops). Pure functions
 * over JSON: each op parses its inputs with the public serde, calls the
 * public library, and serializes the result. No harness-only code paths.
 */

import { isJsonObject, type JsonObject, type JsonValue } from "./json.ts";
import { AmbiguousModelError, CapabilityError, LM15Error, StreamAssemblyError, UnknownModelError, UnsupportedFeatureError } from "./errors.ts";
import { serdeForKind } from "./serde.ts";
import { Response } from "./types/response.ts";
import { VOCABULARIES } from "./vocab.ts";
import { SURFACE_TYPES } from "./surface.ts";
import { VERSION } from "./version.ts";

export type OpHandler = (msg: JsonObject) => JsonValue | Promise<JsonValue>;

/** An op failure carrying extra fields for the error reply (e.g. the MAP-9 event trace). */
export class OpFailure extends Error {
  readonly cause_: unknown;
  readonly extra: JsonObject;

  constructor(cause: unknown, extra: JsonObject) {
    super(String((cause as Error)?.message ?? cause));
    this.name = "OpFailure";
    this.cause_ = cause;
    this.extra = extra;
  }
}

const handlers: Record<string, OpHandler> = {
  capabilities: () => ({ language: "typescript", ops: Object.keys(handlers).sort(), impl_version: VERSION }),

  serde_roundtrip(msg) {
    const { fromJSON, toJSON } = serdeForKind(String(msg["kind"]));
    if (!isJsonObject(msg["value"])) throw new TypeError("value must be a JSON object");
    return { value: toJSON(fromJSON(msg["value"])) };
  },

  validate(msg) {
    const { fromJSON, toJSON } = serdeForKind(String(msg["kind"]));
    if (!isJsonObject(msg["value"])) throw new TypeError("value must be a JSON object");
    return { ok: true, normalized: toJSON(fromJSON(msg["value"])) };
  },

  surface_dump() {
    const types: JsonObject = {};
    for (const [name, fields] of Object.entries(SURFACE_TYPES)) types[name] = { fields: [...fields] };
    const enums: JsonObject = {};
    for (const [name, values] of Object.entries(VOCABULARIES)) enums[name] = [...values];
    return { types, enums };
  },
};

export const HANDLERS: Readonly<Record<string, OpHandler>> = handlers;

/** Register an op (used by the modules that implement later directions). */
export function registerOps(ops: Record<string, OpHandler>): void {
  Object.assign(handlers, ops);
}

export function responseResult(response: Response): JsonObject {
  const result: JsonObject = { canonical_response: Response.toJSON(response) };
  const unmapped = response.providerData?.["_lm15_unmapped"];
  if (Array.isArray(unmapped)) result["unmapped"] = [...unmapped];
  return result;
}

function errorReply(id: JsonValue, error: unknown): JsonObject {
  let extra: JsonObject = {};
  let exc = error;
  if (exc instanceof OpFailure) {
    extra = exc.extra;
    exc = exc.cause_;
  }
  const err = exc as Error;
  const out: JsonObject = { type: err?.name ?? "Error", message: String(err?.message ?? exc) };
  if (exc instanceof LM15Error) {
    out["code"] = exc.code;
    if (exc instanceof CapabilityError && exc.feature) out["feature"] = exc.feature;
    if (exc instanceof StreamAssemblyError && exc.partial) out["partial_response"] = Response.toJSON(exc.partial);
    if (exc instanceof UnknownModelError || exc instanceof AmbiguousModelError) {
      out["model"] = exc.model;
      if (exc instanceof AmbiguousModelError) out["providers"] = [...exc.providers];
    }
  }
  Object.assign(out, extra);
  return { id, ok: false, error: out };
}

export async function handleMessage(msg: JsonObject): Promise<JsonObject> {
  const id = msg["id"] ?? null;
  try {
    const op = String(msg["op"]);
    const handler = handlers[op];
    if (!handler) throw new UnsupportedFeatureError(`unknown op: ${op}`);
    const result = await handler(msg);
    return { id, ok: true, result };
  } catch (e) {
    return errorReply(id, e);
  }
}
