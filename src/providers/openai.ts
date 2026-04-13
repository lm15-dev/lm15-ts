/**
 * OpenAI provider adapter (Responses API).
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
  AudioGenerationRequest, AudioGenerationResponse,
  DataSource, EmbeddingRequest, EmbeddingResponse, ErrorCode,
  FileUploadRequest, FileUploadResponse,
  ImageGenerationRequest, ImageGenerationResponse,
  JsonObject, LMRequest, LMResponse, Message, Part, StreamEvent, Usage,
} from "../types.js";
import { EMPTY_USAGE, Part as PartFactory } from "../types.js";
import { BaseProviderAdapter, type EndpointSupport, type ProviderManifest } from "./base.js";
import { messageToOpenAIInput, partToOpenAIInput } from "./common.js";

const SUPPORTS: EndpointSupport = {
  complete: true, stream: true, live: true,
  embeddings: true, files: true, batches: true,
  images: true, audio: true,
};

const MANIFEST: ProviderManifest = {
  provider: "openai",
  supports: SUPPORTS,
  envKeys: ["OPENAI_API_KEY"],
};

const ERROR_CODE_MAP: Record<string, new (msg: string) => ProviderError> = {
  context_length_exceeded: ContextLengthError,
  invalid_api_key: AuthError,
  insufficient_quota: BillingError,
  authentication_error: AuthError,
  rate_limit_error: RateLimitError,
  rate_limit_exceeded: RateLimitError,
  server_error: ServerError,
  invalid_prompt: InvalidRequestError,
};

export class OpenAIAdapter extends BaseProviderAdapter {
  readonly provider = "openai";
  readonly supports = SUPPORTS;
  readonly manifest = MANIFEST;
  readonly transport: Transport;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(opts: { apiKey: string; transport: Transport; baseUrl?: string }) {
    super();
    this.apiKey = opts.apiKey;
    this.transport = opts.transport;
    this.baseUrl = opts.baseUrl ?? "https://api.openai.com/v1";
  }

  private headers(contentType = "application/json"): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": contentType,
    };
  }

  private buildInput(messages: readonly Message[]): JsonObject[] {
    const items: JsonObject[] = [];
    for (const msg of messages) {
      if (msg.role === "tool") {
        for (const part of msg.parts) {
          if (part.type === "tool_result" && part.id) {
            const text = part.content
              .filter(x => x.type === "text" && "text" in x)
              .map(x => (x as { text: string }).text)
              .join("\n");
            items.push({
              type: "function_call_output",
              call_id: part.id,
              output: text || "",
            });
          }
        }
        continue;
      }
      const contentParts = msg.parts
        .filter(p => p.type !== "tool_call" && p.type !== "tool_result")
        .map(p => partToOpenAIInput(p));
      if (contentParts.length) {
        items.push({ role: msg.role, content: contentParts as JsonObject[] });
      }
      for (const part of msg.parts) {
        if (part.type === "tool_call" && part.id && part.name) {
          items.push({
            type: "function_call",
            call_id: part.id,
            name: part.name,
            arguments: JSON.stringify(part.input ?? {}),
          });
        }
      }
    }
    return items;
  }

  private payload(request: LMRequest, stream: boolean): JsonObject {
    const payload: JsonObject = {
      model: request.model,
      input: this.buildInput(request.messages),
      stream,
    };
    if (request.system) {
      payload.instructions = typeof request.system === "string" ? request.system : "";
    }
    const cfg = request.config ?? {};
    if (cfg.max_tokens != null) payload.max_output_tokens = cfg.max_tokens;
    if (cfg.temperature != null) payload.temperature = cfg.temperature;
    if (request.tools?.length) {
      payload.tools = request.tools
        .filter(t => t.type === "function")
        .map(t => ({
          type: "function",
          name: t.name,
          description: t.description ?? null,
          parameters: t.parameters ?? { type: "object", properties: {} },
        }));
    }
    if (cfg.response_format) Object.assign(payload, cfg.response_format);
    if (cfg.provider) {
      const pass = { ...cfg.provider };
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
      const code: string = err.code ?? "";
      const errType: string = err.type ?? "";

      if (code === "context_length_exceeded") return new ContextLengthError(msg);
      if (code === "insufficient_quota" || errType === "insufficient_quota") return new BillingError(msg);
      if (code === "invalid_api_key" || errType === "authentication_error") return new AuthError(msg);
      if (code === "rate_limit_exceeded" || errType === "rate_limit_error") return new RateLimitError(msg);

      if (code && !msg.includes(code)) msg = `${msg} (${code})`;
      return mapHttpError(status, msg);
    } catch {
      return mapHttpError(status, body.slice(0, 200) || `HTTP ${status}`);
    }
  }

  private streamError(providerCode: string, message: string): { code: ErrorCode; message: string; provider_code: string } {
    const Cls = ERROR_CODE_MAP[providerCode] ?? ProviderError;
    return {
      code: canonicalErrorCode(new Cls("")),
      message,
      provider_code: providerCode || "provider",
    };
  }

  buildRequest(request: LMRequest, stream: boolean): HttpRequest {
    return {
      method: "POST",
      url: `${this.baseUrl}/responses`,
      headers: this.headers(),
      body: JSON.stringify(this.payload(request, stream)),
      timeout: stream ? 120_000 : 60_000,
    };
  }

  parseResponse(request: LMRequest, response: HttpResponse): LMResponse {
    const data = JSON.parse(httpResponseText(response));

    // In-band error check
    if (data.error && typeof data.error === "object") {
      const code = String(data.error.code ?? "");
      const msg = String(data.error.message ?? "");
      throw (ERROR_CODE_MAP[code] ? new (ERROR_CODE_MAP[code])(msg) : new ServerError(msg));
    }

    const parts: Part[] = [];
    for (const item of data.output ?? []) {
      if (item.type === "message") {
        for (const c of item.content ?? []) {
          if (c.type === "output_text" || c.type === "text") {
            parts.push(PartFactory.text(c.text ?? ""));
          } else if (c.type === "refusal") {
            parts.push(PartFactory.refusal(c.refusal ?? ""));
          } else if (c.type === "output_image" && (c.b64_json || c.image_base64)) {
            parts.push(PartFactory.image({ data: c.b64_json ?? c.image_base64, media_type: "image/png" }));
          } else if (c.type === "output_audio") {
            const b64 = c.audio?.data ?? c.b64_json ?? "";
            if (b64) parts.push(PartFactory.audio({ data: b64, media_type: "audio/wav" }));
          }
        }
      } else if (item.type === "function_call") {
        const args = typeof item.arguments === "string" ? JSON.parse(item.arguments || "{}") : {};
        parts.push(PartFactory.toolCall(item.call_id ?? "", item.name ?? "", args));
      }
    }

    if (parts.length === 0) {
      parts.push(PartFactory.text(data.output_text ?? ""));
    }

    const u = data.usage ?? {};
    const uIn = u.input_tokens_details ?? {};
    const uOut = u.output_tokens_details ?? {};
    const usage: Usage = {
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      total_tokens: u.total_tokens ?? 0,
      reasoning_tokens: uOut.reasoning_tokens,
      cache_read_tokens: uIn.cached_tokens,
      input_audio_tokens: uIn.audio_tokens,
      output_audio_tokens: uOut.audio_tokens,
    };

    const finish: "tool_call" | "stop" = parts.some(p => p.type === "tool_call") ? "tool_call" : "stop";

    return {
      id: data.id ?? "",
      model: data.model ?? request.model,
      message: { role: "assistant", parts },
      finish_reason: finish,
      usage,
      provider: data,
    };
  }

  parseStreamEvent(request: LMRequest, rawEvent: SSEEvent): StreamEvent | undefined {
    if (!rawEvent.data) return undefined;
    if (rawEvent.data === "[DONE]") return { type: "end", finish_reason: "stop" };

    const p = JSON.parse(rawEvent.data);
    const et: string = p.type ?? "";

    if (et === "response.created") {
      return { type: "start", id: p.response?.id, model: request.model };
    }
    if (et === "response.output_text.delta" || et === "response.refusal.delta") {
      return { type: "delta", part_index: 0, delta: { type: "text", text: p.delta ?? "" } };
    }
    if (et === "response.output_audio.delta") {
      return { type: "delta", part_index: 0, delta: { type: "audio", data: p.delta ?? "" } };
    }
    if (et === "response.output_item.added") {
      const item = p.item ?? {};
      if (item.type === "function_call") {
        return {
          type: "delta",
          part_index: p.output_index ?? 0,
          delta: { type: "tool_call", id: item.call_id, name: item.name, input: item.arguments ?? "" },
        };
      }
      return undefined;
    }
    if (et === "response.function_call_arguments.delta") {
      return {
        type: "delta",
        part_index: p.output_index ?? 0,
        delta: { type: "tool_call", id: p.call_id, name: p.name, input: p.delta ?? "" },
      };
    }
    if (et === "response.completed") {
      const resp = p.response ?? {};
      const u = resp.usage ?? {};
      const uIn = u.input_tokens_details ?? {};
      const uOut = u.output_tokens_details ?? {};
      const usage: Usage = {
        input_tokens: u.input_tokens ?? 0,
        output_tokens: u.output_tokens ?? 0,
        total_tokens: u.total_tokens ?? 0,
        reasoning_tokens: uOut.reasoning_tokens,
        cache_read_tokens: uIn.cached_tokens,
        input_audio_tokens: uIn.audio_tokens,
        output_audio_tokens: uOut.audio_tokens,
      };
      const finish = (resp.output ?? []).some((i: JsonObject) => i.type === "function_call") ? "tool_call" : "stop";
      return { type: "end", finish_reason: finish, usage };
    }
    if (et === "response.error" || et === "error") {
      const err = p.error;
      const providerCode = typeof err === "object" ? String(err?.code ?? err?.type ?? "provider") : "provider";
      const message = typeof err === "object" ? String(err?.message ?? "") : String(p.message ?? "");
      return { type: "error", error: this.streamError(providerCode, message) };
    }
    return undefined;
  }

  async embeddings(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const req: HttpRequest = {
      method: "POST",
      url: `${this.baseUrl}/embeddings`,
      headers: this.headers(),
      body: JSON.stringify({ model: request.model, input: [...request.inputs], ...(request.provider ?? {}) }),
      timeout: 60_000,
    };
    const resp = await this.transport.request(req);
    if (resp.status >= 400) throw this.normalizeError(resp.status, httpResponseText(resp));
    const data = JSON.parse(httpResponseText(resp));
    const vectors = (data.data ?? []).map((item: { embedding: number[] }) => item.embedding ?? []);
    const u = data.usage ?? {};
    return {
      model: data.model ?? request.model,
      vectors,
      usage: { input_tokens: u.prompt_tokens ?? 0, output_tokens: 0, total_tokens: u.total_tokens ?? 0 },
      provider: data,
    };
  }

  async fileUpload(request: FileUploadRequest): Promise<FileUploadResponse> {
    const boundary = `lm15-${Date.now()}`;
    const parts: Uint8Array[] = [];
    const enc = new TextEncoder();

    parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nassistants\r\n`));
    parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${request.filename}"\r\nContent-Type: ${request.media_type}\r\n\r\n`));
    parts.push(request.bytes_data);
    parts.push(enc.encode(`\r\n--${boundary}--\r\n`));

    const bodyLen = parts.reduce((sum, p) => sum + p.length, 0);
    const body = new Uint8Array(bodyLen);
    let offset = 0;
    for (const p of parts) { body.set(p, offset); offset += p.length; }

    const req: HttpRequest = {
      method: "POST",
      url: `${this.baseUrl}/files`,
      headers: this.headers(`multipart/form-data; boundary=${boundary}`),
      body,
      timeout: 120_000,
    };
    const resp = await this.transport.request(req);
    if (resp.status >= 400) throw this.normalizeError(resp.status, httpResponseText(resp));
    const data = JSON.parse(httpResponseText(resp));
    return { id: data.id ?? "", provider: data };
  }

  async imageGenerate(request: ImageGenerationRequest): Promise<ImageGenerationResponse> {
    const payload: JsonObject = {
      model: request.model,
      prompt: request.prompt,
      ...(request.size ? { size: request.size } : {}),
      ...(request.provider ?? {}),
    };
    const req: HttpRequest = {
      method: "POST",
      url: `${this.baseUrl}/images/generations`,
      headers: this.headers(),
      body: JSON.stringify(payload),
      timeout: 120_000,
    };
    const resp = await this.transport.request(req);
    if (resp.status >= 400) throw this.normalizeError(resp.status, httpResponseText(resp));
    const data = JSON.parse(httpResponseText(resp));
    const images: DataSource[] = (data.data ?? []).map((d: JsonObject) => {
      if (d.b64_json) return { type: "base64" as const, media_type: "image/png", data: d.b64_json as string };
      if (d.url) return { type: "url" as const, url: d.url as string, media_type: "image/png" };
      return { type: "base64" as const, media_type: "image/png", data: "" };
    });
    return { images, provider: data };
  }

  async audioGenerate(request: AudioGenerationRequest): Promise<AudioGenerationResponse> {
    const payload: JsonObject = {
      model: request.model,
      input: request.prompt,
      voice: request.voice ?? "alloy",
      format: request.format ?? "wav",
      ...(request.provider ?? {}),
    };
    const req: HttpRequest = {
      method: "POST",
      url: `${this.baseUrl}/audio/speech`,
      headers: this.headers(),
      body: JSON.stringify(payload),
      timeout: 120_000,
    };
    const resp = await this.transport.request(req);
    if (resp.status >= 400) throw this.normalizeError(resp.status, httpResponseText(resp));

    const ctype = ((resp.headers["content-type"] ?? "audio/wav").split(";")[0]).trim();
    const b64 = Buffer.from(resp.body).toString("base64");
    return { audio: { type: "base64", media_type: ctype, data: b64 }, provider: { content_type: ctype } };
  }
}
