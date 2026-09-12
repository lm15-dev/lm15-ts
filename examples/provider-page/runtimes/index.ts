/**
 * A runtime executes the playground's request with one language's real
 * SDK. Three exist: JavaScript (this page's own `lm15/browser`), Python
 * (lm15-python under Pyodide), Rust (the lm15-rs codec compiled to wasm).
 * Each answers two questions with no network — what would go on the wire
 * — and one with: stream the reply. The chat keeps its transcript in the
 * TypeScript types; the other runtimes speak canonical JSON, which is the
 * contract's whole point.
 */

import type { Message, Request, Response } from "lm15/browser";
import type { Connection, Wire } from "../experience.ts";

export type RuntimeId = "javascript" | "python" | "rust";

export interface StreamOutcome {
  readonly response: Response;
}

export interface Runtime {
  readonly id: RuntimeId;
  readonly label: string;
  /** What runs: the honest one-line description shown under the Run switch. */
  readonly claim: string;
  loaded(): boolean;
  /** Fetch and start the runtime (Pyodide: ~13 MB once; the Rust codec: 1 MB). Reports progress. */
  load(report: (status: string) => void): Promise<void>;
  /** The exact request this runtime would send. No network. The key is used, never returned. */
  wire(connection: Connection, key: string | undefined, request: Request): Promise<Wire>;
  /** Send and stream. `onText` receives text as it arrives; the Response is the runtime's own, materialized. */
  stream(connection: Connection, key: string | undefined, request: Request, signal: AbortSignal, onText: (text: string) => void): Promise<Response>;
}

/** A canonical Message from a runtime that returned JSON. */
export type CanonicalMessage = ReturnType<typeof Message.toJSON>;
