/**
 * Anthropic provider adapter (Messages API).
 */

import {
  AuthError, BillingError, ContextLengthError, InvalidRequestError,
  ProviderError, RateLimitError, ServerError, TimeoutError,
  canonicalErrorCode, mapHttpError,
} from "../errors.js";
import type { SSEEvent } from "../sse.js";
import type { HttpRequest, HttpResponse, Transport } from "../transport.js";
import { httpResponseText } from "../transport.js";
import type {
  ErrorCode, FileUploadRequest, FileUploadResponse,
  JsonObject, LMRequest, LMResponse, Part, StreamEvent, Usage,
} from "../types.js";
import { Part as PartFactory } from "../types.js";
import { BaseProviderAdapter, type EndpointSupport, type ProviderManifest } from "./base.js";
import { dsToAnthropicSource, partsToText } from "./common.js";

const SUPPORTS: EndpointSupport = {
  complete: true, stream: true, live: false,
  embeddings: false, files: true, batches: true,
  images: false, audio: false,
};

const MANIFEST: ProviderManifest = {
  provider: "anthropic",
  supports: SUPPORTS,
  envKeys: ["ANTHROPIC_API_KEY"],
};

const ERROR_TYPE_MAP: Record<string, new (msg: string) => ProviderError> = {
  authentication_error: AuthError,
  permission_error: AuthError,
  billing_error: BillingError,
  rate_limit_error: RateLimitError,
  request_too_large: InvalidRequestError,
  not_found_error: InvalidRequestError,
  invalid_request_error: InvalidRequestError,
  api_error: ServerError,
  overloaded_error: ServerError,
  timeout_error: TimeoutError,
};

function isContextLengthMessage(msg: string): boolean {
  const m = msg.toLowerCase();
  return m.includes("prompt is too long") || m.includes("too many tokens")
    || m.includes("context window") || m.includes("context length")
    || (m.includes("token") && (m.includes("limit") || m.includes("exceed")));
}

export class AnthropicAdapter extends BaseProviderAdapter {
  readonly provider = "anthropic";
  readonly supports = SUPPORTS;
  readonly manifest = MANIFEST;
  readonly transport: Transport;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly apiVersion: string;

  constructor(opts: { apiKey: string; transport: Transport; baseUrl?: string; apiVersion?: string }) {
    super();
    this.apiKey = opts.apiKey;
    this.transport = opts.transport;
    this.baseUrl = opts.baseUrl ?? "https://api.anthropic.com/v1";
    this.apiVersion = opts.apiVersion ?? "2023-06-01";
  }

  private headers(): Record<string, string> {
    return {
      "x-api-key": this.apiKey,
      "anthropic-version": this.apiVersion,
      "content-type": "application/json",
    };
  }

  private partPayload(p: Part): JsonObject {
    if (p.type === "text") {
      const out: JsonObject = { type: "text", text: p.text ?? "" };
      const cacheMeta = p.metadata?.cache;
      if (cacheMeta === true) out.cache_control = { type: "ephemeral" };
      else if (typeof cacheMeta === "object" && cacheMeta !== null) out.cache_control = cacheMeta as JsonObject;
      return out;
    }
    if (p.type === "image" && p.source) {
      return { type: "image", source: dsToAnthropicSource(p.source) };
    }
    if (p.type === "document" && p.source) {
      return { type: "document", source: dsToAnthropicSource(p.source) };
    }
    if (p.type === "tool_result") {
      return {
        type: "tool_result",
        tool_use_id: p.id,
        is_error: !!p.is_error,
        content: [{ type: "text", text: partsToText(p.content) }],
      };
    }
    return { type: "text", text: ("text" in p ? (p.text as string) : "") ?? "" };
  }

  private buildPayload(request: LMRequest, stream: boolean): JsonObject {
    const providerCfg = (request.config?.provider ?? {}) as JsonObject;
    const promptCaching = !!providerCfg.prompt_caching;

    const messages: JsonObject[] = request.messages.map(m => ({
      role: m.role as string,
      content: m.parts.map(p => this.partPayload(p)),
    }));

    if (promptCaching && messages.length >= 2) {
      const prevContent = messages[messages.length - 2].content;
      if (Array.isArray(prevContent) && prevContent.length > 0) {
        const last = prevContent[prevContent.length - 1] as JsonObject;
        if (!last.cache_control) last.cache_control = { type: "ephemeral" };
      }
    }

    const payload: JsonObject = {
      model: request.model,
      messages,
      stream,
      max_tokens: request.config?.max_tokens ?? 1024,
    };

    if (request.system) {
      if (typeof request.system === "string") {
        if (promptCaching) {
          payload.system = [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }];
        } else {
          payload.system = request.system;
        }
      } else {
        payload.system = partsToText(request.system as Part[]);
      }
    }

    const cfg = request.config ?? {};
    if (cfg.temperature != null) payload.temperature = cfg.temperature;

    if (request.tools?.length) {
      payload.tools = request.tools
        .filter(t => t.type === "function")
        .map(t => ({
          name: t.name,
          description: t.description ?? null,
          input_schema: t.parameters ?? { type: "object", properties: {} },
        }));
    }

    if (cfg.reasoning && typeof cfg.reasoning === "object" && (cfg.reasoning as unknown as JsonObject).enabled) {
      const r = cfg.reasoning as unknown as JsonObject;
      payload.thinking = { type: "enabled", budget_tokens: r.budget ?? 1024 };
    }

    if (providerCfg) {
      const pass = { ...providerCfg };
      delete pass.prompt_caching;
      Object.assign(payload, pass);
    }

    return payload;
  }

  normalizeError(status: number, body: string): ProviderError {
    try {
      const data = JSON.parse(body);
      const err = data.error ?? {};
      let msg: string = typeof err === "string" ? err : (err.message ?? "");
      const errType: string = typeof err === "object" ? (err.type ?? "") : "";

      if (errType === "invalid_request_error" && isContextLengthMessage(msg)) {
        return new ContextLengthError(msg);
      }

      const Cls = ERROR_TYPE_MAP[errType];
      if (Cls) return new Cls(msg);

      if (errType && !msg.includes(errType)) msg = `${msg} (${errType})`;
      return mapHttpError(status, msg);
    } catch {
      return mapHttpError(status, body.slice(0, 200) || `HTTP ${status}`);
    }
  }

  private streamError(providerCode: string, message: string): { code: ErrorCode; message: string; provider_code: string } {
    let Cls = ERROR_TYPE_MAP[providerCode] ?? ProviderError;
    if (providerCode === "invalid_request_error" && isContextLengthMessage(message)) {
      Cls = ContextLengthError;
    }
    return {
      code: canonicalErrorCode(new Cls("")),
      message,
      provider_code: providerCode || "provider",
    };
  }

  buildRequest(request: LMRequest, stream: boolean): HttpRequest {
    return {
      method: "POST",
      url: `${this.baseUrl}/messages`,
      headers: this.headers(),
      body: JSON.stringify(this.buildPayload(request, stream)),
      timeout: stream ? 120_000 : 60_000,
    };
  }

  parseResponse(request: LMRequest, response: HttpResponse): LMResponse {
    const data = JSON.parse(httpResponseText(response));

    const parts: Part[] = [];
    for (const block of data.content ?? []) {
      if (block.type === "text") {
        parts.push(PartFactory.text(block.text ?? ""));
      } else if (block.type === "tool_use") {
        parts.push(PartFactory.toolCall(block.id ?? "", block.name ?? "", block.input ?? {}));
      } else if (block.type === "thinking") {
        parts.push(PartFactory.thinking(block.thinking ?? ""));
      } else if (block.type === "redacted_thinking") {
        parts.push(PartFactory.thinking("[redacted]", { redacted: true }));
      }
    }

    const finish = parts.some(p => p.type === "tool_call") ? "tool_call" as const : "stop" as const;
    const u = data.usage ?? {};
    const usage: Usage = {
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      total_tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
      cache_read_tokens: u.cache_read_input_tokens,
      cache_write_tokens: u.cache_creation_input_tokens,
    };

    return {
      id: data.id ?? "",
      model: data.model ?? request.model,
      message: { role: "assistant", parts: parts.length ? parts : [PartFactory.text("")] },
      finish_reason: finish,
      usage,
      provider: data,
    };
  }

  parseStreamEvent(request: LMRequest, rawEvent: SSEEvent): StreamEvent | undefined {
    if (!rawEvent.data) return undefined;
    const p = JSON.parse(rawEvent.data);
    const et: string = p.type ?? "";

    if (et === "message_start") {
      const msg = p.message ?? {};
      return { type: "start", id: msg.id, model: msg.model };
    }
    if (et === "content_block_start") {
      const block = p.content_block ?? {};
      if (block.type === "tool_use") {
        return {
          type: "delta",
          part_index: p.index ?? 0,
          delta: {
            type: "tool_call",
            id: block.id,
            name: block.name,
            input: typeof block.input === "object" ? JSON.stringify(block.input) : (block.input ?? ""),
          },
        };
      }
      return { type: "part_start", part_index: p.index ?? 0, part_type: block.type };
    }
    if (et === "content_block_delta") {
      const delta = p.delta ?? {};
      if (delta.type === "text_delta") {
        return { type: "delta", part_index: p.index ?? 0, delta: { type: "text", text: delta.text ?? "" } };
      }
      if (delta.type === "input_json_delta") {
        return { type: "delta", part_index: p.index ?? 0, delta: { type: "tool_call", input: delta.partial_json ?? "" } };
      }
      if (delta.type === "thinking_delta") {
        return { type: "delta", part_index: p.index ?? 0, delta: { type: "thinking", text: delta.thinking ?? "" } };
      }
      return undefined;
    }
    if (et === "content_block_stop") {
      return { type: "part_end", part_index: p.index ?? 0 };
    }
    if (et === "message_stop") {
      return { type: "end", finish_reason: "stop" };
    }
    if (et === "error") {
      const e = p.error;
      const providerCode = typeof e === "object" ? String(e?.type ?? e?.code ?? "provider") : "provider";
      const message = typeof e === "object" ? String(e?.message ?? "") : String(p.message ?? "");
      return { type: "error", error: this.streamError(providerCode, message) };
    }
    return undefined;
  }

  async fileUpload(request: FileUploadRequest): Promise<FileUploadResponse> {
    const req: HttpRequest = {
      method: "POST",
      url: `${this.baseUrl}/files`,
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": this.apiVersion,
        "content-type": request.media_type,
        "x-filename": request.filename,
      },
      body: request.bytes_data,
      timeout: 120_000,
    };
    const resp = await this.transport.request(req);
    if (resp.status >= 400) throw this.normalizeError(resp.status, httpResponseText(resp));
    const data = JSON.parse(httpResponseText(resp));
    const fileId = data.id ?? data.file?.id ?? "";
    return { id: fileId, provider: data };
  }
}
