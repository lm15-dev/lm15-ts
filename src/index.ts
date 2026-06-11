/**
 * lm15 — canonical model port (TypeScript).
 *
 * Stage A surface: canonical types, canonical serde, canonical JSON codec,
 * error hierarchy, surface registry. Adapters and transport land in later
 * stages.
 */

export * from "./canonical-json.js";
export * from "./errors.js";
export * from "./types.js";
export * as serde from "./serde.js";
export { surfaceDump, TYPE_FIELDS, ENUMS } from "./surface.js";
