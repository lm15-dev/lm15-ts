/**
 * xAI Grok (`XaiLM`): the Chat Completions dialect at api.x.ai with the
 * `oauth-unless-explicit` credential chain (AUTH-1), plus xAI's own image
 * and video wires and its MAP-8 refusals — provider facts, so they live here.
 */

import { adapt } from "../adaptation.ts";
import { XAI, type AccessPolicy } from "../auth/policy.ts";
import { ProviderError, UnsupportedFeatureError } from "../errors.ts";
import { isJsonObject, parseJson, stringifyJson, type JsonObject } from "../json.ts";
import type { Request } from "../types/config.ts";
import { ImageGenerationResponse, VideoJobInfo, type ImageGenerationRequest, type VideoGenerationRequest } from "../types/endpoints.ts";
import { normalizePart, type ImagePart, type VideoPart } from "../types/parts.ts";
import { Usage } from "../types/response.ts";
import { HttpResponse, mediaDataUri, pathId, type TransportRequest } from "../wire.ts";
import { OpenAIChatLM, type OpenAIChatLMOptions } from "./openai_chat.ts";
import { int, list, obj, str } from "./openai_shared.ts";

const VIDEO_STATUS_MAP: Readonly<Record<string, string>> = Object.freeze({ pending: "running", done: "completed", failed: "failed" });

function xaiImageInput(part: ImagePart, provider: string): JsonObject {
  if (part.url !== undefined) return { url: part.url };
  if (part.fileId !== undefined) return { file_id: part.fileId };
  if (part.data !== undefined || part.path !== undefined) return { url: mediaDataUri(part) };
  throw new UnsupportedFeatureError(`${provider}: input image carries no content`, { provider });
}

export class XaiLM extends OpenAIChatLM {
  static override readonly manifest: AccessPolicy = XAI;

  constructor(opts: OpenAIChatLMOptions = {}) {
    super({ ...opts, compat: opts.compat ?? "xai", access: opts.access ?? XAI }, XAI);
  }

  override payload(request: Request, stream: boolean): JsonObject {
    let config = request.config ?? {};
    // Grok reasoning models have no off switch. The inherited deepseek wire
    // shape (thinking={"type": "disabled"}) is accepted by api.x.ai but
    // silently ignored — verified live 2026-09-01: grok-4.6 still spent 158
    // reasoning tokens. MAP-13 (decision 2026-09-14 §4.2): the lowest level
    // is the closest and the spend shows in usage.
    if (config.reasoning?.effort === "off") {
      adapt(
        "config.reasoning.effort",
        "substituted",
        "Grok reasoning models have no off switch and api.x.ai ignores disable fields (158 reasoning tokens on an explicit off, live 2026-09-01); the lowest level was sent",
        { asked: "off", applied: "low", provider: this.provider },
      );
      config = { ...config, reasoning: { ...config.reasoning, effort: "low" } };
    }
    // docs.x.ai (models page, 2026-09-01): "logprobs and top_logprobs are not
    // supported by models grok-4.20 and newer. These fields will be silently
    // ignored if set." Verified live on grok-4.6: HTTP 200, no logprobs key.
    if (config.logprobs !== undefined) {
      adapt("config.logprobs", "dropped", "grok-4.20 and newer ignore logprobs/top_logprobs (docs.x.ai, live 2026-09-01); Response.logprobs will be absent (OpenAI and Gemini carry them)", {
        asked: config.logprobs,
        provider: this.provider,
      });
      const { logprobs: _drop, ...rest } = config;
      config = rest;
    }
    let tools = request.tools;
    let tc = config.toolChoice;
    if (tc?.allowed && tc.allowed.length > 0 && !(tc.allowed.length === 1 && tc.mode === "required")) {
      // api.x.ai accepts allowed_tools and ignores it (live 2026-09-02: with
      // {lookup} allowed and weather asked, it called weather). MAP-13
      // client_side: send only the allowed tools — what the allowlist means.
      const allowed = tc.allowed;
      const kept = (tools ?? []).filter((t) => allowed.includes(t.name));
      adapt("config.tool_choice.allowed", "client_side", "api.x.ai ignores tool_choice allowlists (live 2026-09-02); only the allowed tools were sent, which is what the allowlist means", {
        asked: [...allowed],
        applied: kept.map((t) => t.name),
        provider: this.provider,
      });
      tools = kept;
      const { allowed: _drop, ...restChoice } = tc;
      tc = restChoice;
      config = { ...config, toolChoice: tc };
    }
    if (tc?.mode === "required" && config.responseFormat !== undefined) {
      // MAP-8 rule 3 (live 2026-09-02): a forced tool next to a
      // response_format returned JSON text and no call. MAP-13 rule 4(b):
      // the program depends on the call.
      throw new UnsupportedFeatureError(
        "xai: a forced tool (mode='required') cannot be combined with response_format — api.x.ai returns JSON text and drops the call (verified live 2026-09-02)",
        { provider: this.provider, feature: "config.tool_choice.mode" },
      );
    }
    const rewritten: Request = { ...request, ...(tools !== request.tools ? { tools } : {}), config };
    return super.payload(rewritten, stream);
  }

  override normalizeError(status: number, body: string): ProviderError {
    // xAI's own envelope is {"code": str, "error": str}; refold into the OpenAI shape so the wire code survives as provider_code.
    try {
      const data = parseJson(body);
      if (isJsonObject(data) && typeof data["error"] === "string") body = stringifyJson({ error: { message: data["error"], code: data["code"] ?? null } });
    } catch {
      // not JSON
    }
    return super.normalizeError(status, body);
  }

  // ─── Images ──────────────────────────────────────────────────────

  override imageGenerateRequest(request: ImageGenerationRequest): Promise<TransportRequest> {
    const payload: JsonObject = { model: request.model, prompt: request.prompt, ...(request.extensions ?? {}) };
    if (request.size !== undefined) {
      throw new UnsupportedFeatureError("xai: size has no wire slot; use extensions for xAI's quality/resolution fields", { provider: this.provider });
    }
    if (!request.images || request.images.length === 0) return this.emit({ method: "POST", url: `${this.base()}/images/generations`, headers: this.headers(), payload });
    if (request.images.length > 1) throw new UnsupportedFeatureError("xai: image edits take exactly one input image; the wire has no slot for more", { provider: this.provider });
    payload["image"] = xaiImageInput(request.images[0]!, this.provider);
    return this.emit({ method: "POST", url: `${this.base()}/images/edits`, headers: this.headers(), payload });
  }

  override imageGenerationFromResponse(_request: ImageGenerationRequest, resp: HttpResponse): ImageGenerationResponse {
    const data = obj(resp.json());
    const images: ImagePart[] = [];
    for (const item of list(data["data"])) {
      if (!isJsonObject(item)) continue;
      const mime = item["mime_type"];
      const mediaType = typeof mime === "string" && mime ? mime : "application/octet-stream";
      if (item["b64_json"]) images.push(normalizePart({ type: "image", mediaType, data: str(item["b64_json"]) }) as ImagePart);
      else if (item["url"]) images.push(normalizePart({ type: "image", mediaType, url: str(item["url"]) }) as ImagePart);
    }
    if (images.length === 0) throw new ProviderError("xai: image response carries no images", { provider: this.provider });
    return ImageGenerationResponse.create({ images, usage: Usage.empty, providerData: data });
  }

  // ─── Video (grok-imagine) ────────────────────────────────────────

  override videoSubmitRequest(request: VideoGenerationRequest): Promise<TransportRequest> {
    if (request.seconds !== undefined) throw new UnsupportedFeatureError("xai: video duration has no wire slot", { provider: this.provider });
    if (request.images && request.images.length > 0) {
      throw new UnsupportedFeatureError("xai: video input images are not mapped yet; use extensions until the mapping is live-receipted", { provider: this.provider });
    }
    const payload: JsonObject = { model: request.model, prompt: request.prompt, ...(request.extensions ?? {}) };
    return this.emit({ method: "POST", url: `${this.base()}/videos/generations`, headers: this.headers(), payload });
  }

  override videoJobFromBody(body: string, videoId?: string): VideoJobInfo {
    const data = obj(parseJson(body));
    const requestId = data["request_id"];
    if (typeof requestId === "string" && requestId) return VideoJobInfo.create({ id: requestId, status: "queued", providerData: data });
    if (videoId === undefined) throw new ProviderError("xai: video body carries no request_id", { provider: this.provider });
    const wireStatus = str(data["status"]);
    const status = VIDEO_STATUS_MAP[wireStatus];
    if (!status) throw new ProviderError(`xai: unknown video status ${JSON.stringify(wireStatus)}`, { provider: this.provider });
    return VideoJobInfo.create({
      id: videoId,
      status,
      progress: int(data["progress"]),
      model: typeof data["model"] === "string" ? data["model"] : undefined,
      providerData: data,
    });
  }

  override videoStatusRequest(videoId: string): Promise<TransportRequest> {
    return this.emit({ method: "GET", url: `${this.base()}/videos/${pathId(videoId)}`, headers: this.headers() });
  }

  override videoListRequest(): Promise<TransportRequest> {
    throw new UnsupportedFeatureError("xai: the wire has no video list endpoint (probed 2026-09-01: 404) — the ticket you stored is the only copy", {
      provider: this.provider,
    });
  }

  override async videoResultFetch(): Promise<TransportRequest | undefined> {
    return undefined; // the terminal body carries a public URL
  }

  override videoPart(statusBody: JsonObject): VideoPart {
    const url = obj(statusBody["video"])["url"];
    if (typeof url !== "string" || !url) throw new ProviderError("xai: terminal video carries no url", { provider: this.provider });
    return normalizePart({ type: "video", mediaType: "video/mp4", url }) as VideoPart;
  }
}
