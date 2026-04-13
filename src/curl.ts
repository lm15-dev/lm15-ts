/**
 * Dump lm15 requests as curl commands for cross-SDK testing.
 *
 * Usage:
 *   import { dumpCurl, dumpHttp } from "lm15/curl";
 *   console.log(dumpCurl("gpt-4.1-mini", "Hello."));
 *   console.log(dumpHttp("gpt-4.1-mini", "Hello."));
 */

import { resolveProvider } from "./capabilities.js";
import { buildDefault } from "./factory.js";
import type { HttpRequest } from "./transport.js";
import type {
  Config, JsonObject, LMRequest, Message, Part, Tool,
} from "./types.js";
import { Part as PartFactory } from "./types.js";

// ── Build LMRequest from high-level params ─────────────────────────

function buildLMRequest(
  model: string,
  prompt?: string | (string | Part)[],
  opts?: {
    messages?: Message[];
    system?: string;
    tools?: Tool[];
    reasoning?: boolean | JsonObject;
    prefill?: string;
    output?: string;
    promptCaching?: boolean;
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    stop?: string[];
  },
): LMRequest {
  let messages: Message[];

  if (opts?.messages) {
    messages = opts.messages;
  } else if (prompt != null) {
    if (typeof prompt === "string") {
      messages = [{ role: "user", parts: [PartFactory.text(prompt)] }];
    } else {
      const parts = prompt.map(item =>
        typeof item === "string" ? PartFactory.text(item) : item,
      );
      messages = [{ role: "user", parts }];
    }
    if (opts?.prefill) {
      messages.push({ role: "assistant", parts: [PartFactory.text(opts.prefill)] });
    }
  } else {
    throw new Error("either prompt or messages is required");
  }

  const providerCfg: JsonObject = {};
  if (opts?.promptCaching) providerCfg.prompt_caching = true;
  if (opts?.output === "image") providerCfg.output = "image";
  else if (opts?.output === "audio") providerCfg.output = "audio";

  let reasoning: JsonObject | undefined;
  if (opts?.reasoning === true) {
    reasoning = { enabled: true };
  } else if (typeof opts?.reasoning === "object") {
    reasoning = { enabled: true, ...opts.reasoning };
  }

  const config: Config = {
    max_tokens: opts?.maxTokens,
    temperature: opts?.temperature,
    top_p: opts?.topP,
    stop: opts?.stop,
    reasoning: reasoning as unknown as Config["reasoning"],
    provider: Object.keys(providerCfg).length ? providerCfg : undefined,
  };

  return {
    model,
    messages,
    system: opts?.system,
    tools: opts?.tools,
    config,
  };
}

// ── Build provider HTTP request ────────────────────────────────────

export interface BuildHttpOpts {
  stream?: boolean;
  provider?: string;
  apiKey?: string | Record<string, string>;
  env?: string;
  system?: string;
  tools?: Tool[];
  reasoning?: boolean | JsonObject;
  prefill?: string;
  output?: string;
  promptCaching?: boolean;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stop?: string[];
  messages?: Message[];
}

/**
 * Build the provider-level HttpRequest without sending it.
 */
export function buildHttpRequest(
  model: string,
  prompt?: string | (string | Part)[],
  opts?: BuildHttpOpts,
): HttpRequest {
  const lmRequest = buildLMRequest(model, prompt, opts);
  const resolvedProvider = opts?.provider ?? resolveProvider(model);

  const client = buildDefault({
    apiKey: opts?.apiKey,
    providerHint: resolvedProvider,
    env: opts?.env,
  });

  // Access the adapter via the client's internal adapters map
  const adapter = (client as any).adapters?.get(resolvedProvider);
  if (!adapter) {
    throw new Error(`no adapter for provider '${resolvedProvider}'`);
  }

  return adapter.buildRequest(lmRequest, opts?.stream ?? false);
}

// ── Convert to dict / curl ─────────────────────────────────────────

export interface HttpRequestDict {
  method: string;
  url: string;
  headers: Record<string, string>;
  params?: Record<string, string>;
  body: unknown;
}

const AUTH_HEADERS = new Set(["authorization", "x-api-key", "x-goog-api-key"]);

/**
 * Convert an HttpRequest to a JSON-serializable dict.
 * Auth headers are redacted for safe sharing.
 */
export function httpRequestToDict(req: HttpRequest): HttpRequestDict {
  let body: unknown = null;
  if (typeof req.body === "string") {
    try {
      body = JSON.parse(req.body);
    } catch {
      body = req.body;
    }
  } else if (req.body instanceof Uint8Array) {
    body = "<binary>";
  }

  const headers: Record<string, string> = { ...req.headers };
  for (const key of Object.keys(headers)) {
    if (AUTH_HEADERS.has(key.toLowerCase())) {
      headers[key] = "REDACTED";
    }
  }

  return {
    method: req.method,
    url: req.url,
    headers,
    params: req.params && Object.keys(req.params).length ? req.params : undefined,
    body,
  };
}

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Convert an HttpRequest to a curl command string.
 */
export function httpRequestToCurl(req: HttpRequest, opts?: { redactAuth?: boolean }): string {
  const redact = opts?.redactAuth !== false;
  const parts: string[] = ["curl"];

  if (req.method !== "GET") {
    parts.push(`-X ${req.method}`);
  }

  let url = req.url;
  if (req.params && Object.keys(req.params).length) {
    const qs = new URLSearchParams(req.params).toString();
    url = `${url}?${qs}`;
  }
  parts.push(shellQuote(url));

  for (const [key, value] of Object.entries(req.headers ?? {})) {
    const val = redact && AUTH_HEADERS.has(key.toLowerCase()) ? "REDACTED" : value;
    parts.push(`-H ${shellQuote(`${key}: ${val}`)}`);
  }

  if (typeof req.body === "string") {
    try {
      const parsed = JSON.parse(req.body);
      parts.push(`-d ${shellQuote(JSON.stringify(parsed, null, 2))}`);
    } catch {
      parts.push(`-d ${shellQuote(req.body)}`);
    }
  }

  return parts.join(" \\\n  ");
}

// ── Convenience functions ──────────────────────────────────────────

/**
 * Build a curl command for the given call parameters.
 */
export function dumpCurl(
  model: string,
  prompt?: string | (string | Part)[],
  opts?: BuildHttpOpts & { redactAuth?: boolean },
): string {
  const req = buildHttpRequest(model, prompt, opts);
  return httpRequestToCurl(req, { redactAuth: opts?.redactAuth });
}

/**
 * Build the HTTP request dict for cross-SDK comparison.
 */
export function dumpHttp(
  model: string,
  prompt?: string | (string | Part)[],
  opts?: BuildHttpOpts,
): HttpRequestDict {
  const req = buildHttpRequest(model, prompt, opts);
  return httpRequestToDict(req);
}
