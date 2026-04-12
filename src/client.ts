/**
 * UniversalLM — routes requests to the correct provider adapter.
 */

import { ProviderError, UnsupportedFeatureError } from "./errors.js";
import { resolveProvider } from "./capabilities.js";
import type { LMAdapter } from "./providers/base.js";
import type {
  AudioGenerationRequest, AudioGenerationResponse,
  BatchRequest, BatchResponse,
  EmbeddingRequest, EmbeddingResponse,
  FileUploadRequest, FileUploadResponse,
  ImageGenerationRequest, ImageGenerationResponse,
  LMRequest, LMResponse, StreamEvent,
} from "./types.js";

export class UniversalLM {
  private adapters = new Map<string, LMAdapter>();

  register(adapter: LMAdapter): void {
    this.adapters.set(adapter.provider, adapter);
  }

  private adapter(model: string, provider?: string): LMAdapter {
    const p = provider ?? resolveProvider(model);
    const adapter = this.adapters.get(p);
    if (!adapter) {
      const registered = [...this.adapters.keys()];
      throw new ProviderError(
        `no adapter registered for provider '${p}'\n\n` +
        `  Registered providers: ${registered.join(", ") || "(none)"}\n` +
        `\n` +
        `  To fix, do one of:\n` +
        `    1. Set the API key: export ${p.toUpperCase()}_API_KEY=...\n` +
        `    2. Pass it directly: lm15.call(..., { apiKey: '...' })\n` +
        `    3. Add it to your .env file\n`,
      );
    }
    return adapter;
  }

  async complete(request: LMRequest, provider?: string): Promise<LMResponse> {
    const a = this.adapter(request.model, provider);
    if (!a.supports.complete) throw new UnsupportedFeatureError(`${a.provider}: complete not supported`);
    return a.complete(request);
  }

  async *stream(request: LMRequest, provider?: string): AsyncIterable<StreamEvent> {
    const a = this.adapter(request.model, provider);
    if (a.supports.stream) {
      yield* a.stream(request);
      return;
    }
    // Fallback to complete
    const response = await a.complete(request);
    yield* responseToEvents(response);
  }

  async embeddings(request: EmbeddingRequest, provider?: string): Promise<EmbeddingResponse> {
    const a = this.adapter(request.model, provider);
    if (!a.supports.embeddings || !a.embeddings) throw new UnsupportedFeatureError(`${a.provider}: embeddings not supported`);
    return a.embeddings(request);
  }

  async fileUpload(request: FileUploadRequest, provider: string): Promise<FileUploadResponse> {
    const a = this.adapter(request.model ?? "", provider);
    if (!a.supports.files || !a.fileUpload) throw new UnsupportedFeatureError(`${a.provider}: files not supported`);
    return a.fileUpload(request);
  }

  async batchSubmit(request: BatchRequest, provider?: string): Promise<BatchResponse> {
    const a = this.adapter(request.model, provider);
    if (!a.supports.batches || !a.batchSubmit) throw new UnsupportedFeatureError(`${a.provider}: batches not supported`);
    return a.batchSubmit(request);
  }

  async imageGenerate(request: ImageGenerationRequest, provider?: string): Promise<ImageGenerationResponse> {
    const a = this.adapter(request.model, provider);
    if (!a.supports.images || !a.imageGenerate) throw new UnsupportedFeatureError(`${a.provider}: images not supported`);
    return a.imageGenerate(request);
  }

  async audioGenerate(request: AudioGenerationRequest, provider?: string): Promise<AudioGenerationResponse> {
    const a = this.adapter(request.model, provider);
    if (!a.supports.audio || !a.audioGenerate) throw new UnsupportedFeatureError(`${a.provider}: audio not supported`);
    return a.audioGenerate(request);
  }
}

function* responseToEvents(response: LMResponse): Iterable<StreamEvent> {
  yield { type: "start", id: response.id, model: response.model };
  for (let idx = 0; idx < response.message.parts.length; idx++) {
    const part = response.message.parts[idx];
    if ((part.type === "text" || part.type === "refusal") && part.text != null) {
      yield { type: "delta", part_index: idx, delta: { type: "text", text: part.text } };
    } else if (part.type === "thinking" && part.text != null) {
      yield { type: "delta", part_index: idx, delta: { type: "thinking", text: part.text } };
    } else if (part.type === "tool_call") {
      yield {
        type: "delta", part_index: idx,
        delta: { type: "tool_call", id: part.id, name: part.name, input: JSON.stringify(part.input ?? {}) },
      };
    }
  }
  yield { type: "end", finish_reason: response.finish_reason, usage: response.usage };
}
