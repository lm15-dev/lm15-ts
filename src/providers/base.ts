/**
 * Base provider adapter with default implementations.
 */

import type { ProviderError } from "../errors.js";
import { mapHttpError, UnsupportedFeatureError } from "../errors.js";
import type { SSEEvent } from "../sse.js";
import { parseSSE } from "../sse.js";
import type { HttpRequest, HttpResponse, Transport } from "../transport.js";
import type {
  AudioGenerationRequest, AudioGenerationResponse,
  BatchRequest, BatchResponse,
  EmbeddingRequest, EmbeddingResponse,
  FileUploadRequest, FileUploadResponse,
  ImageGenerationRequest, ImageGenerationResponse,
  LMRequest, LMResponse, LiveConfig, StreamEvent,
} from "../types.js";
import { httpResponseText } from "../transport.js";

export interface EndpointSupport {
  readonly complete: boolean;
  readonly stream: boolean;
  readonly live: boolean;
  readonly embeddings: boolean;
  readonly files: boolean;
  readonly batches: boolean;
  readonly images: boolean;
  readonly audio: boolean;
}

export const DEFAULT_SUPPORT: EndpointSupport = {
  complete: true,
  stream: true,
  live: false,
  embeddings: false,
  files: false,
  batches: false,
  images: false,
  audio: false,
};

export interface ProviderManifest {
  readonly provider: string;
  readonly supports: EndpointSupport;
  readonly envKeys: readonly string[];
}

export interface LiveSession {
  send(event: unknown): void;
  recv(): Promise<unknown>;
  close(): void;
}

export interface LMAdapter {
  readonly provider: string;
  readonly supports: EndpointSupport;
  readonly manifest: ProviderManifest;

  complete(request: LMRequest): Promise<LMResponse>;
  stream(request: LMRequest): AsyncIterable<StreamEvent>;
  live?(config: LiveConfig): Promise<LiveSession>;
  embeddings?(request: EmbeddingRequest): Promise<EmbeddingResponse>;
  fileUpload?(request: FileUploadRequest): Promise<FileUploadResponse>;
  batchSubmit?(request: BatchRequest): Promise<BatchResponse>;
  imageGenerate?(request: ImageGenerationRequest): Promise<ImageGenerationResponse>;
  audioGenerate?(request: AudioGenerationRequest): Promise<AudioGenerationResponse>;
}

/**
 * Base adapter — subclasses implement buildRequest, parseResponse, parseStreamEvent.
 */
export abstract class BaseProviderAdapter implements LMAdapter {
  abstract readonly provider: string;
  abstract readonly supports: EndpointSupport;
  abstract readonly manifest: ProviderManifest;
  abstract readonly transport: Transport;

  abstract buildRequest(request: LMRequest, stream: boolean): HttpRequest;
  abstract parseResponse(request: LMRequest, response: HttpResponse): LMResponse;
  abstract parseStreamEvent(request: LMRequest, rawEvent: SSEEvent): StreamEvent | undefined;

  normalizeError(status: number, body: string): ProviderError {
    return mapHttpError(status, body);
  }

  async complete(request: LMRequest): Promise<LMResponse> {
    const req = this.buildRequest(request, false);
    const resp = await this.transport.request(req);
    if (resp.status >= 400) {
      throw this.normalizeError(resp.status, httpResponseText(resp));
    }
    return this.parseResponse(request, resp);
  }

  async *stream(request: LMRequest): AsyncIterable<StreamEvent> {
    const req = this.buildRequest(request, true);
    for await (const raw of parseSSE(this.transport.stream(req))) {
      const evt = this.parseStreamEvent(request, raw);
      if (evt != null) yield evt;
    }
  }
}
