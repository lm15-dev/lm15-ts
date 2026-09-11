/**
 * The serde kind table (harness/PROTOCOL.md § Serde kinds): one
 * `fromJSON`/`toJSON` pair per canonical type, keyed by the protocol's kind
 * string. `toJSON(x)` / `fromJSON(kind, d)` are the generic entry points the
 * api-family names.
 */

import { canonicalKind } from "./canonical.ts";
import type { JsonObject } from "./json.ts";
import { CacheConfig, Config, Reasoning, Request, Tool, ToolChoice } from "./types/config.ts";
import { Credential, isCredentialValue } from "./types/credential.ts";
import {
  BatchEntry,
  BatchJobInfo,
  BatchRequest,
  CacheInfo,
  CachePage,
  CachedPrefix,
  FileInfo,
  FilePage,
  FileUploadRequest,
  ImageGenerationRequest,
  ImageGenerationResponse,
  SpeechGenerationRequest,
  SpeechGenerationResponse,
  VideoGenerationRequest,
  VideoJobInfo,
} from "./types/endpoints.ts";
import { AudioFormat, LiveClientEvent, LiveConfig, LiveServerEvent } from "./types/live.ts";
import { ModelInfo } from "./types/model_info.ts";
import { ContinuationState, Message, Part } from "./types/parts.ts";
import { ErrorDetail, Response, TokenLogprob, Usage } from "./types/response.ts";
import { Delta, StreamEvent } from "./types/stream.ts";
import { ValueError } from "./types/validate.ts";

export interface KindSerde<T = unknown> {
  readonly fromJSON: (d: JsonObject) => T;
  readonly toJSON: (value: T) => JsonObject;
}

function kind<T>(s: { fromJSON: (d: JsonObject) => T; toJSON: (value: T) => JsonObject }): KindSerde<T> {
  return { fromJSON: s.fromJSON, toJSON: s.toJSON };
}

/** The closed set of protocol kinds (36 as of 2026-09-03). */
export const KIND_SERDE: Readonly<Record<string, KindSerde>> = Object.freeze({
  part: kind(Part),
  message: kind(Message),
  tool: kind(Tool),
  tool_choice: kind(ToolChoice),
  reasoning: kind(Reasoning),
  config: kind(Config),
  cache_config: kind(CacheConfig),
  cache_info: kind(CacheInfo),
  cache_page: kind(CachePage),
  cached_prefix: kind(CachedPrefix),
  token_logprob: kind(TokenLogprob),
  continuation_state: kind(ContinuationState),
  error_detail: kind(ErrorDetail),
  delta: kind(Delta),
  usage: kind(Usage),
  credential: kind(Credential),
  stream_event: kind(StreamEvent),
  request: kind(Request),
  response: kind({ fromJSON: Response.fromJSON, toJSON: (r: Response) => Response.toJSON(r) }),
  model_info: kind(ModelInfo),
  batch_request: kind(BatchRequest),
  batch_job: kind(BatchJobInfo),
  batch_entry: kind(BatchEntry),
  file_upload_request: kind(FileUploadRequest),
  file_info: kind(FileInfo),
  file_page: kind(FilePage),
  image_generation_request: kind(ImageGenerationRequest),
  image_generation_response: kind(ImageGenerationResponse),
  speech_generation_request: kind(SpeechGenerationRequest),
  speech_generation_response: kind(SpeechGenerationResponse),
  video_generation_request: kind(VideoGenerationRequest),
  video_job: kind(VideoJobInfo),
  audio_format: kind(AudioFormat),
  live_config: kind(LiveConfig),
  live_client_event: kind(LiveClientEvent),
  live_server_event: kind(LiveServerEvent),
} as Record<string, KindSerde>);

export function serdeForKind(name: string): KindSerde {
  const s = Object.hasOwn(KIND_SERDE, name) ? KIND_SERDE[name] : undefined;
  if (!s) throw new ValueError(`unknown kind: ${name}`);
  return s;
}

/** Canonical JSON of a constructed value. Plain literals, copies and values from
 * another package instance must name their kind, or use `<Type>.toJSON(value)`.
 * Structural guessing is unsafe: a text Part and a live text event can be identical.
 */
export function toJSON(value: unknown, kindName?: string): JsonObject {
  if (kindName !== undefined) return serdeForKind(kindName).toJSON(value);
  if (value instanceof Response) return Response.toJSON(value);
  if (isCredentialValue(value)) return Credential.toJSON(value);
  if (typeof value !== "object" || value === null) throw new TypeError("toJSON: expected a canonical value");
  const name = canonicalKind(value);
  if (name !== undefined) return serdeForKind(name).toJSON(value);
  throw new TypeError("toJSON: the kind of this value is unknown; pass a kind or use <Type>.toJSON(x) explicitly");
}
