/**
 * Gemini provider adapter (GenerativeLanguage API).
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
  DataSource, EmbeddingRequest, EmbeddingResponse, ErrorCode,
  FileUploadRequest, FileUploadResponse,
  ImageGenerationRequest, ImageGenerationResponse,
  AudioGenerationRequest, AudioGenerationResponse,
  JsonObject, LMRequest, LMResponse, Part, StreamEvent, Usage, Config, Message as MessageType,
} from "../types.js";
import { Part as PartFactory, EMPTY_USAGE } from "../types.js";
import { BaseProviderAdapter, type EndpointSupport, type ProviderManifest } from "./base.js";

const SUPPORTS: EndpointSupport = {
  complete: true, stream: true, live: true,
  embeddings: true, files: true, batches: true,
  images: true, audio: true,
};

const MANIFEST: ProviderManifest = {
  provider: "gemini",
  supports: SUPPORTS,
  envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
};

const ERROR_STATUS_MAP: Record<string, new (msg: string) => ProviderError> = {
  INVALID_ARGUMENT: InvalidRequestError,
  FAILED_PRECONDITION: BillingError,
  PERMISSION_DENIED: AuthError,
  NOT_FOUND: InvalidRequestError,
  RESOURCE_EXHAUSTED: RateLimitError,
  INTERNAL: ServerError,
  UNAVAILABLE: ServerError,
  DEADLINE_EXCEEDED: TimeoutError,
};

function isContextLengthMessage(msg: string): boolean {
  const m = msg.toLowerCase();
  return (m.includes("token") && (m.includes("limit") || m.includes("exceed")))
    || m.includes("too long") || m.includes("context is too long") || m.includes("context length");
}

export class GeminiAdapter extends BaseProviderAdapter {
  readonly provider = "gemini";
  readonly supports = SUPPORTS;
  readonly manifest = MANIFEST;
  readonly transport: Transport;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(opts: { apiKey: string; transport: Transport; baseUrl?: string }) {
    super();
    this.apiKey = opts.apiKey;
    this.transport = opts.transport;
    this.baseUrl = opts.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
  }

  private modelPath(model: string): string {
    return model.startsWith("models/") ? model : `models/${model}`;
  }

  private authHeaders(extra?: Record<string, string>): Record<string, string> {
    return { "x-goog-api-key": this.apiKey, ...extra };
  }

  private partPayload(p: Part): JsonObject {
    if (p.type === "text") return { text: p.text ?? "" };
    if ((p.type === "image" || p.type === "audio" || p.type === "video" || p.type === "document") && p.source) {
      const mime = p.source.media_type ?? "application/octet-stream";
      if (p.source.type === "url") return { fileData: { mimeType: mime, fileUri: p.source.url! } };
      if (p.source.type === "base64") return { inlineData: { mimeType: mime, data: p.source.data! } };
      if (p.source.type === "file") return { fileData: { mimeType: mime, fileUri: p.source.file_id! } };
    }
    if (p.type === "tool_call") {
      const fc: JsonObject = { name: p.name ?? "", args: p.input ?? {} };
      if (p.id) fc.id = p.id;
      return { functionCall: fc };
    }
    if (p.type === "tool_result") {
      const text = p.content
        .filter(x => x.type === "text" && "text" in x)
        .map(x => (x as { text: string }).text)
        .join("");
      const fr: JsonObject = { name: p.name ?? "tool", response: { result: text } };
      if (p.id) fr.id = p.id;
      return { functionResponse: fr };
    }
    return { text: ("text" in p ? (p.text as string) : "") ?? "" };
  }

  private buildPayload(request: LMRequest): JsonObject {
    const providerCfg = (request.config?.provider ?? {}) as JsonObject;

    const payload: JsonObject = {
      contents: request.messages.map(m => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: m.parts.map(p => this.partPayload(p)),
      })),
    };

    if (request.system) {
      const text = typeof request.system === "string"
        ? request.system
        : (request.system as Part[]).filter(p => p.type === "text").map(p => (p as { text: string }).text).join("\n");
      payload.systemInstruction = { parts: [{ text }] };
    }

    const cfg: JsonObject = {};
    const reqCfg = request.config ?? {};
    if (reqCfg.temperature != null) cfg.temperature = reqCfg.temperature;
    if (reqCfg.max_tokens != null) cfg.maxOutputTokens = reqCfg.max_tokens;
    if (reqCfg.stop?.length) cfg.stopSequences = [...reqCfg.stop];
    if (reqCfg.response_format) Object.assign(cfg, reqCfg.response_format);
    if (Object.keys(cfg).length) payload.generationConfig = cfg;

    if (request.tools?.length) {
      payload.tools = [{
        functionDeclarations: request.tools
          .filter(t => t.type === "function")
          .map(t => ({
            name: t.name,
            description: t.description ?? null,
            parameters: t.parameters ?? { type: "OBJECT", properties: {} },
          })),
      }];
    }

    const output = providerCfg.output as string | undefined;
    if (output === "image") {
      (payload.generationConfig as JsonObject ?? (payload.generationConfig = {})).responseModalities = ["IMAGE"];
    } else if (output === "audio") {
      (payload.generationConfig as JsonObject ?? (payload.generationConfig = {})).responseModalities = ["AUDIO"];
    }

    if (providerCfg) {
      const pass = { ...providerCfg };
      delete pass.prompt_caching;
      delete pass.output;
      Object.assign(payload, pass);
    }

    return payload;
  }

  normalizeError(status: number, body: string): ProviderError {
    try {
      const data = JSON.parse(body);
      const err = data.error ?? {};
      let msg: string = typeof err === "string" ? err : (err.message ?? "");
      const errStatus: string = typeof err === "object" ? (err.status ?? "") : "";

      if (isContextLengthMessage(msg)) return new ContextLengthError(msg);

      const Cls = ERROR_STATUS_MAP[errStatus];
      if (Cls) return new Cls(msg);

      if (errStatus && !msg.includes(errStatus)) msg = `${msg} (${errStatus})`;
      return mapHttpError(status, msg);
    } catch {
      return mapHttpError(status, body.slice(0, 200) || `HTTP ${status}`);
    }
  }

  private streamError(providerCode: string, message: string): { code: ErrorCode; message: string; provider_code: string } {
    let Cls = ERROR_STATUS_MAP[providerCode] ?? ProviderError;
    if (isContextLengthMessage(message)) Cls = ContextLengthError;
    return {
      code: canonicalErrorCode(new Cls("")),
      message,
      provider_code: providerCode || "provider",
    };
  }

  private parseCandidateParts(partsPayload: JsonObject[]): Part[] {
    const parts: Part[] = [];
    for (const p of partsPayload) {
      if ("text" in p) {
        parts.push(PartFactory.text(p.text as string));
      } else if ("functionCall" in p) {
        const fc = p.functionCall as JsonObject;
        parts.push(PartFactory.toolCall(
          (fc.id as string) ?? "fc_0",
          (fc.name as string) ?? "",
          (fc.args as JsonObject) ?? {},
        ));
      } else if ("inlineData" in p) {
        const inline = p.inlineData as JsonObject;
        const mime = (inline.mimeType as string) ?? "application/octet-stream";
        const data = (inline.data as string) ?? "";
        if (mime.startsWith("image/")) {
          parts.push(PartFactory.image({ data, media_type: mime }));
        } else if (mime.startsWith("audio/")) {
          parts.push(PartFactory.audio({ data, media_type: mime }));
        } else {
          parts.push(PartFactory.document({ data, media_type: mime }));
        }
      }
    }
    return parts;
  }

  buildRequest(request: LMRequest, stream: boolean): HttpRequest {
    const endpoint = stream ? "streamGenerateContent" : "generateContent";
    const params: Record<string, string> = {};
    if (stream) params.alt = "sse";
    return {
      method: "POST",
      url: `${this.baseUrl}/${this.modelPath(request.model)}:${endpoint}`,
      headers: this.authHeaders({ "Content-Type": "application/json" }),
      params,
      body: JSON.stringify(this.buildPayload(request)),
      timeout: stream ? 120_000 : 60_000,
    };
  }

  parseResponse(request: LMRequest, response: HttpResponse): LMResponse {
    const data = JSON.parse(httpResponseText(response));

    // In-band error
    const promptFeedback = data.promptFeedback;
    if (promptFeedback?.blockReason && promptFeedback.blockReason !== "BLOCK_REASON_UNSPECIFIED") {
      throw new InvalidRequestError(`Prompt blocked: ${promptFeedback.blockReason}`);
    }

    const candidate = (data.candidates ?? [{}])[0];
    const content = candidate.content ?? {};
    const parts = this.parseCandidateParts(content.parts ?? []);

    const um = data.usageMetadata ?? {};
    const usage: Usage = {
      input_tokens: um.promptTokenCount ?? 0,
      output_tokens: um.candidatesTokenCount ?? 0,
      total_tokens: um.totalTokenCount ?? 0,
      cache_read_tokens: um.cachedContentTokenCount,
      reasoning_tokens: um.thoughtsTokenCount,
    };

    return {
      id: data.responseId ?? "",
      model: request.model,
      message: { role: "assistant", parts: parts.length ? parts : [PartFactory.text("")] },
      finish_reason: parts.some(p => p.type === "tool_call") ? "tool_call" : "stop",
      usage,
      provider: data,
    };
  }

  parseStreamEvent(request: LMRequest, rawEvent: SSEEvent): StreamEvent | undefined {
    if (!rawEvent.data) return undefined;
    const payload = JSON.parse(rawEvent.data);

    if ("error" in payload) {
      const e = payload.error;
      const providerCode = typeof e === "object" ? String(e?.status ?? e?.code ?? "provider") : "provider";
      const message = typeof e === "object" ? String(e?.message ?? "") : "";
      return { type: "error", error: this.streamError(providerCode, message) };
    }

    const cands = payload.candidates ?? [];
    if (!cands.length) return undefined;

    const part = ((cands[0].content ?? {}).parts ?? [{}])[0];
    if ("text" in part) {
      return { type: "delta", part_index: 0, delta: { type: "text", text: part.text as string } };
    }
    if ("functionCall" in part) {
      const fc = part.functionCall;
      return {
        type: "delta",
        part_index: 0,
        delta: {
          type: "tool_call",
          id: fc.id ?? "fc_0",
          name: fc.name ?? "",
          input: JSON.stringify(fc.args ?? {}),
        },
      };
    }
    if ("inlineData" in part) {
      const inline = part.inlineData;
      const mime = (inline.mimeType ?? "application/octet-stream") as string;
      if (mime.startsWith("audio/")) {
        return { type: "delta", part_index: 0, delta: { type: "audio", data: inline.data ?? "" } };
      }
    }
    return undefined;
  }

  async embeddings(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const modelPath = this.modelPath(request.model);

    if (request.inputs.length <= 1) {
      const payload = {
        model: modelPath,
        content: { parts: [{ text: request.inputs[0] ?? "" }] },
        ...(request.provider ?? {}),
      };
      const req: HttpRequest = {
        method: "POST",
        url: `${this.baseUrl}/${modelPath}:embedContent`,
        headers: this.authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(payload),
        timeout: 60_000,
      };
      const resp = await this.transport.request(req);
      if (resp.status >= 400) throw this.normalizeError(resp.status, httpResponseText(resp));
      const data = JSON.parse(httpResponseText(resp));
      const values = (data.embedding?.values ?? []) as number[];
      return { model: request.model, vectors: [values], provider: data };
    }

    const payload = {
      requests: request.inputs.map(x => ({ model: modelPath, content: { parts: [{ text: x }] } })),
      ...(request.provider ?? {}),
    };
    const req: HttpRequest = {
      method: "POST",
      url: `${this.baseUrl}/${modelPath}:batchEmbedContents`,
      headers: this.authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
      timeout: 60_000,
    };
    const resp = await this.transport.request(req);
    if (resp.status >= 400) throw this.normalizeError(resp.status, httpResponseText(resp));
    const data = JSON.parse(httpResponseText(resp));
    const vectors = (data.embeddings ?? []).map((e: { values: number[] }) => e.values ?? []);
    return { model: request.model, vectors, provider: data };
  }

  async fileUpload(request: FileUploadRequest): Promise<FileUploadResponse> {
    const uploadBase = this.baseUrl.replace("/v1beta", "/upload/v1beta");
    const req: HttpRequest = {
      method: "POST",
      url: `${uploadBase}/files`,
      headers: this.authHeaders({
        "X-Goog-Upload-Protocol": "raw",
        "X-Goog-Upload-File-Name": request.filename,
        "Content-Type": request.media_type,
      }),
      body: request.bytes_data,
      timeout: 120_000,
    };
    const resp = await this.transport.request(req);
    if (resp.status >= 400) throw this.normalizeError(resp.status, httpResponseText(resp));
    const data = JSON.parse(httpResponseText(resp));
    const fileName = data.file?.name ?? data.name ?? "";
    return { id: fileName, provider: data };
  }

  async imageGenerate(request: ImageGenerationRequest): Promise<ImageGenerationResponse> {
    const providerCfg: JsonObject = { generationConfig: { responseModalities: ["IMAGE"] }, ...(request.provider ?? {}) };
    const lmReq: LMRequest = {
      model: request.model,
      messages: [{ role: "user", parts: [PartFactory.text(request.prompt)] }],
      config: { provider: providerCfg },
    };
    const resp = await this.complete(lmReq);
    const images = resp.message.parts
      .filter((p): p is Extract<Part, { type: "image" }> => p.type === "image" && !!p.source)
      .map(p => p.source);
    return { images, provider: resp.provider };
  }

  async audioGenerate(request: AudioGenerationRequest): Promise<AudioGenerationResponse> {
    const providerCfg: JsonObject = {
      generationConfig: { responseModalities: ["AUDIO"] },
      ...(request.provider ?? {}),
    };
    if (request.voice) {
      providerCfg.speechConfig = { voiceConfig: { prebuiltVoiceConfig: { voiceName: request.voice } } };
    }
    const lmReq: LMRequest = {
      model: request.model,
      messages: [{ role: "user", parts: [PartFactory.text(request.prompt)] }],
      config: { provider: providerCfg },
    };
    const resp = await this.complete(lmReq);
    const audioPart = resp.message.parts.find((p): p is Extract<Part, { type: "audio" }> => p.type === "audio" && !!p.source);
    if (!audioPart) throw new Error("provider did not return audio data");
    return { audio: audioPart.source, provider: resp.provider };
  }
}
