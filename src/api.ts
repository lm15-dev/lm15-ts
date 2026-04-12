/**
 * High-level API surface — call(), model(), stream(), configure(), etc.
 */

import { resolveProvider } from "./capabilities.js";
import type { UniversalLM } from "./client.js";
import { buildDefault, type BuildDefaultOpts } from "./factory.js";
import { Model, type CallOpts, type ModelOpts } from "./model.js";
import { Result, type StartStreamFn } from "./result.js";
import type {
  JsonObject, LMRequest, Message, Part, Tool, ToolCallInfo, Usage,
} from "./types.js";
import { Part as PartFactory } from "./types.js";

// ── Module-level state ─────────────────────────────────────────────

const _defaults: Record<string, unknown> = {};
const _clientCache = new Map<string, UniversalLM>();

/** Set module-level defaults so you don't repeat them on every call. */
export function configure(opts: { env?: string; apiKey?: string | Record<string, string> }): void {
  for (const key of Object.keys(_defaults)) delete _defaults[key];
  _clientCache.clear();
  if (opts.env != null) _defaults.env = opts.env;
  if (opts.apiKey != null) _defaults.apiKey = opts.apiKey;
}

function resolve<T>(key: string, explicit: T | undefined): T | undefined {
  return explicit ?? (_defaults[key] as T | undefined);
}

function getClient(opts?: { apiKey?: string | Record<string, string>; providerHint?: string; env?: string }): UniversalLM {
  const apiKey = resolve("apiKey", opts?.apiKey);
  const env = resolve("env", opts?.env) as string | undefined;
  const cacheKey = JSON.stringify([apiKey, opts?.providerHint, env]);

  let client = _clientCache.get(cacheKey);
  if (client) return client;

  client = buildDefault({
    apiKey: apiKey as string | Record<string, string> | undefined,
    providerHint: opts?.providerHint,
    env,
  });
  _clientCache.set(cacheKey, client);
  return client;
}

// ── call() ─────────────────────────────────────────────────────────

export interface CallOptions extends CallOpts {
  system?: string;
  retries?: number;
  provider?: string;
  apiKey?: string | Record<string, string>;
  env?: string;
}

/**
 * One-shot call to any model. Returns a Result (streamable, awaitable).
 *
 * ```ts
 * const resp = await lm15.call("gpt-4.1-mini", "Hello.");
 * console.log(await resp.text);
 *
 * for await (const text of lm15.call("gpt-4.1-mini", "Write a haiku.")) {
 *   process.stdout.write(text);
 * }
 * ```
 */
export function call(
  modelName: string,
  prompt?: string | (string | Part)[],
  opts?: CallOptions,
): Result {
  const m = model(modelName, {
    provider: opts?.provider,
    promptCaching: opts?.promptCaching,
    system: opts?.system,
    tools: opts?.tools as ModelOpts["tools"],
    onToolCall: opts?.onToolCall,
    retries: opts?.retries ?? 0,
    maxToolRounds: opts?.maxToolRounds,
    apiKey: opts?.apiKey,
    env: opts?.env,
  });
  return m.call(prompt, opts);
}

/** Alias for call() — streaming is the default consumption mode. */
export function stream(
  modelName: string,
  prompt?: string | (string | Part)[],
  opts?: CallOptions,
): Result {
  return call(modelName, prompt, opts);
}

// ── model() ────────────────────────────────────────────────────────

export interface ModelOptions {
  system?: string;
  tools?: (Tool | ((...args: unknown[]) => unknown) | string)[];
  onToolCall?: (info: ToolCallInfo) => unknown;
  provider?: string;
  retries?: number;
  cache?: boolean;
  promptCaching?: boolean;
  temperature?: number;
  maxTokens?: number;
  maxToolRounds?: number;
  apiKey?: string | Record<string, string>;
  env?: string;
}

/**
 * Create a reusable Model object with config and conversation memory.
 *
 * ```ts
 * const gpt = lm15.model("gpt-4.1-mini", { system: "You are terse." });
 * const resp = await gpt.call("Hello!").text;
 * ```
 */
export function model(
  modelName: string,
  opts?: ModelOptions,
): Model {
  const lm = getClient({
    apiKey: resolve("apiKey", opts?.apiKey) as string | Record<string, string> | undefined,
    providerHint: opts?.provider,
    env: resolve("env", opts?.env) as string | undefined,
  });

  return new Model({
    lm,
    model: modelName,
    system: opts?.system,
    tools: opts?.tools,
    onToolCall: opts?.onToolCall,
    provider: opts?.provider,
    retries: opts?.retries ?? 0,
    cache: opts?.cache ?? false,
    promptCaching: opts?.promptCaching ?? false,
    temperature: opts?.temperature,
    maxTokens: opts?.maxTokens,
    maxToolRounds: opts?.maxToolRounds ?? 8,
  });
}

// ── prepare() / send() ─────────────────────────────────────────────

/**
 * Build an LMRequest without sending it.
 */
export function prepare(
  modelName: string,
  prompt?: string | (string | Part)[],
  opts?: CallOptions,
): LMRequest {
  const m = model(modelName, {
    provider: opts?.provider,
    promptCaching: opts?.promptCaching,
    system: opts?.system,
    apiKey: opts?.apiKey,
    env: opts?.env,
  });
  return m.prepare(prompt, opts);
}

/**
 * Send a pre-built LMRequest. Returns a Result.
 */
export function send(
  request: LMRequest,
  opts?: { provider?: string; apiKey?: string | Record<string, string>; env?: string },
): Result {
  const resolvedProvider = opts?.provider ?? resolveProvider(request.model);
  const lm = getClient({
    apiKey: resolve("apiKey", opts?.apiKey) as string | Record<string, string> | undefined,
    providerHint: resolvedProvider,
    env: resolve("env", opts?.env) as string | undefined,
  });

  const callableRegistry: Record<string, (...args: unknown[]) => unknown> = {};
  for (const tool of request.tools ?? []) {
    if (tool.type === "function" && typeof (tool as { fn?: unknown }).fn === "function") {
      callableRegistry[tool.name] = (tool as { fn: (...args: unknown[]) => unknown }).fn;
    }
  }

  const startStream: StartStreamFn = (req) => lm.stream(req, resolvedProvider);

  return new Result({
    request,
    startStream,
    callableRegistry,
  });
}

// ── providers() ────────────────────────────────────────────────────

export { providers } from "./factory.js";
