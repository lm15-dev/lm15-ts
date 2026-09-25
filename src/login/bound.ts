/**
 * Model choices and the bound client (AUTH-23): port of lm15-python
 * `lm15/login/bound.py`.
 *
 * A `BoundClient` is what `connect()` returns: one connection id, one
 * generation, one route, one model. It follows that connection's renewals and
 * nothing else — a replacement or a logout makes it fail `connection_changed`
 * / `login_required` instead of quietly switching who pays (R4). It builds
 * ordinary canonical requests and returns ordinary responses through an
 * ordinary router; it keeps no conversation, runs no tool loop, retries
 * nothing.
 *
 * Model choices say where they came from (`application` = a registry the
 * caller supplied, `provider` = the account's own list fetched now,
 * `manual` = an id the caller typed) and, for a requested capability,
 * whether it is `supported`, `unsupported` or `unknown`. Nothing here ranks
 * models, probes with a paid prompt, or enables a provider policy.
 */

import { AuthOperationError } from "../errors.ts";
import { LMRouter, type RouterConfig } from "../router.ts";
import type { Request, Config } from "../types/config.ts";
import { Message } from "../types/parts.ts";
import type { ModelInfo, ModelRegistry } from "../types/model_info.ts";
import type { Response } from "../types/response.ts";
import type { StreamEvent } from "../types/stream.ts";
import type { Adaptation } from "../adaptation.ts";
import type { Auth, Connection } from "./manager.ts";

export type Capability = "reasoning" | "vision" | "structured-output";
export type CapabilityState = "supported" | "unsupported" | "unknown";

export interface ModelChoice {
  readonly provider: string;
  readonly model: string;
  readonly connectionId: string;
  readonly source: "bundled" | "cached" | "provider" | "application" | "manual";
  readonly label?: string;
  readonly fetchedAt?: string;
  readonly capabilities: Readonly<Partial<Record<Capability, CapabilityState>>>;
}

/** An exact route + model bound to one connection id and generation. */
export interface ModelSelection {
  readonly provider: string;
  readonly model: string;
  readonly connectionId: string;
  readonly identityGeneration: string;
  readonly instanceId?: string;
}

export function routed(selection: { provider: string; model: string }): string {
  return `${selection.provider}:${selection.model}`;
}

const CAPABILITIES: readonly Capability[] = ["reasoning", "vision", "structured-output"];

function capabilityOf(info: ModelInfo, name: Capability): CapabilityState {
  const inference = info.inference;
  if (!inference) return "unknown";
  if (name === "reasoning") return inference.supportsReasoning === undefined ? "unknown" : inference.supportsReasoning ? "supported" : "unsupported";
  if (name === "vision") return (inference.inputModalities ?? []).includes("image") ? "supported" : "unsupported";
  return "unknown"; // structured output is not recorded in ModelInfo; say so
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * The models the saved connection on `provider` can select. Without
 * `refresh`, only a caller-supplied registry (`application`); with it, the
 * account's own list fetched with the saved credential (`provider`; renews
 * if due; no inference). With `capability`, only `supported` choices unless
 * `includeUnknown`.
 */
export async function modelChoices(auth: Auth, provider: string, opts: {
  refresh?: boolean; capability?: Capability; includeUnknown?: boolean; registry?: ModelRegistry; routerConfig?: RouterConfig;
} = {}): Promise<ModelChoice[]> {
  if (opts.capability !== undefined && !CAPABILITIES.includes(opts.capability)) throw new RangeError(`capability must be one of ${CAPABILITIES.join(", ")}`);
  const connection = (await auth.status(provider)).connection;
  if (!connection) {
    throw new AuthOperationError(`${provider}: no saved connection to list models for`, { reason: "login_required", stage: "catalog", recovery: "restart_login", provider });
  }
  let infos: readonly ModelInfo[] = [];
  let source: ModelChoice["source"] = "application";
  let fetchedAt: string | undefined;
  if (opts.refresh) {
    const router = new LMRouter({ ...(opts.routerConfig ?? {}), auth });
    try {
      infos = await router.lm(`${connection.provider}:catalog`).listModels();
    } finally {
      await router.close();
    }
    source = "provider";
    fetchedAt = nowIso();
  } else if (opts.registry) {
    infos = opts.registry.list(connection.provider);
  }
  const choices: ModelChoice[] = [];
  for (const info of infos) {
    const capabilities = opts.capability ? { [opts.capability]: capabilityOf(info, opts.capability) } : {};
    const state = opts.capability ? capabilities[opts.capability] : undefined;
    if (state === "unsupported" || (state === "unknown" && !opts.includeUnknown)) continue;
    choices.push(Object.freeze({
      provider: connection.provider, model: info.id, connectionId: connection.id, source, label: info.id,
      ...(fetchedAt ? { fetchedAt } : {}), capabilities: Object.freeze(capabilities),
    }));
  }
  return choices;
}

export interface BoundRequestFields {
  readonly system?: string;
  readonly tools?: Request["tools"];
  readonly config?: Config;
}

/** One connection, one model; canonical requests and responses. */
export class BoundClient {
  readonly auth: Auth;
  readonly selection: ModelSelection;
  readonly #router: LMRouter;

  constructor(auth: Auth, selection: ModelSelection, opts: { routerConfig?: RouterConfig } = {}) {
    const base = opts.routerConfig ?? {};
    if (base.auth !== undefined && base.auth !== auth) throw new TypeError("routerConfig.auth must be this client's Auth or undefined");
    this.auth = auth;
    this.selection = Object.freeze({ ...selection });
    this.#router = new LMRouter({ ...base, auth: auth.withPin([selection.connectionId, selection.identityGeneration]) });
  }

  get provider(): string {
    return this.selection.provider;
  }

  get model(): string {
    return this.selection.model;
  }

  /** The routed model string, `provider:model`. */
  get routed(): string {
    return routed(this.selection);
  }

  async connection(): Promise<Connection | null> {
    return (await this.auth.status(this.selection.provider)).connection;
  }

  toString(): string {
    return `BoundClient(${this.routed}, connection=${this.selection.connectionId})`;
  }

  /** An ordinary canonical Request with the selected routed model; a string is one user message. */
  request(messages: string | readonly Message[], fields: BoundRequestFields = {}): Request {
    const list = typeof messages === "string" ? [Message.user(messages)] : [...messages];
    return {
      model: this.routed, messages: list,
      ...(fields.system !== undefined ? { system: fields.system } : {}),
      ...(fields.tools !== undefined ? { tools: fields.tools } : {}),
      ...(fields.config !== undefined ? { config: fields.config } : {}),
    } as Request;
  }

  #coerce(input: Request | string | readonly Message[], fields: BoundRequestFields): Request {
    if (typeof input === "string" || Array.isArray(input)) return this.request(input as string | readonly Message[], fields);
    const request = input as Request;
    if (Object.keys(fields).length > 0) {
      throw new AuthOperationError("pass either a Request or messages with fields, not both", { reason: "selection_mismatch", stage: "dispatch", recovery: "none", provider: this.provider });
    }
    if (request.model !== this.routed && request.model !== this.model) {
      throw new AuthOperationError(`this client is bound to ${JSON.stringify(this.routed)}; the Request names ${JSON.stringify(request.model)}`, {
        reason: "selection_mismatch", stage: "dispatch", recovery: "none", provider: this.provider,
      });
    }
    return request.model === this.routed ? request : { ...request, model: this.routed };
  }

  async complete(input: Request | string | readonly Message[], fields: BoundRequestFields = {}, opts: { signal?: AbortSignal } = {}): Promise<Response> {
    return this.#router.complete(this.#coerce(input, fields), opts);
  }

  stream(input: Request | string | readonly Message[], fields: BoundRequestFields = {}, opts: { signal?: AbortSignal } = {}): AsyncIterable<StreamEvent> {
    return this.#router.stream(this.#coerce(input, fields), opts);
  }

  async plan(input: Request | string | readonly Message[], fields: BoundRequestFields = {}): Promise<readonly Adaptation[]> {
    return this.#router.plan(this.#coerce(input, fields));
  }

  /** Release this client's own transport. Not a logout; the Auth stays the caller's. */
  async close(): Promise<void> {
    await this.#router.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
