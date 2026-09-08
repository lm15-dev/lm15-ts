/**
 * The adapter-driven vet ops (harness/PROTOCOL.md): build_request,
 * parse_response, replay_stream, normalize_error, the models / files /
 * batch / cache / video / generation / live surfaces. Each constructs the
 * adapter the case names, with the harness-given credential, clock, and
 * settings, and calls the same public hooks users reach.
 */

import type { ProviderLM } from "./adapter.ts";
import { StreamAssemblyError, canonicalErrorCode } from "./errors.ts";
import { isJsonObject, parseJson, type JsonObject, type JsonValue } from "./json.ts";
import { adapterFor } from "./providers.ts";
import { coalesceStream, materializeResponse, parseSse, splitLines } from "./stream.ts";
import { Credential, parseRfc3339, type CredentialLike } from "./types/credential.ts";
import { Request } from "./types/config.ts";
import {
  BatchEntry,
  BatchJobInfo,
  BatchRequest,
  CacheInfo,
  CachePage,
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
import { LiveClientEvent, LiveConfig, LiveServerEvent } from "./types/live.ts";
import { ModelInfo } from "./types/model_info.ts";
import { Part } from "./types/parts.ts";
import { StreamEvent } from "./types/stream.ts";
import { ValueError, decodeBase64, encodeBase64 } from "./types/validate.ts";
import { HttpResponse, decodeText, splitUrl, type TransportRequest } from "./wire.ts";
import { OpFailure, registerOps, responseResult, type OpHandler } from "./vet_ops.ts";

const PARSE_ONLY_KEY = "vet-parse-only";

function credentialOf(msg: JsonObject): CredentialLike {
  const cred = msg["credential"];
  if (isJsonObject(cred)) return Credential.fromJSON(cred);
  return String(msg["api_key"]);
}

function clockOf(msg: JsonObject): (() => Date) | undefined {
  const now = msg["now"];
  if (now === null || now === undefined) return undefined;
  const fixed = parseRfc3339(String(now));
  return () => fixed;
}

function settingsOf(msg: JsonObject): Record<string, string> | undefined {
  const settings = msg["settings"];
  if (!isJsonObject(settings)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(settings)) out[k] = String(v);
  return out;
}

function baseUrlOf(msg: JsonObject): string | undefined {
  const b = msg["base_url"];
  return b === null || b === undefined ? undefined : String(b);
}

function adapter(msg: JsonObject, opts: { parseOnly?: boolean } = {}): ProviderLM {
  const provider = String(msg["provider"]);
  const settings = settingsOf(msg);
  const clock = clockOf(msg);
  const baseUrl = baseUrlOf(msg);
  return adapterFor(provider, {
    apiKey: opts.parseOnly ? PARSE_ONLY_KEY : credentialOf(msg),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(settings ? { settings } : {}),
    ...(clock ? { clock } : {}),
    ...(provider.replace(/_/g, "-") === "openai-codex" ? { accountId: "test-account" } : {}),
  });
}

/** The protocol's build_request shape: decoded params, lowercased header names, JSON body when JSON. */
export function normalizeTransportRequest(req: TransportRequest): JsonObject {
  const [url, params] = splitUrl(req.url);
  const headers: Record<string, string> = {};
  for (const [k, v] of req.headers) headers[k.toLowerCase()] = v;
  const out: JsonObject = { method: req.method, url, params, headers, body: null };
  if (req.body.length > 0) {
    const contentType = headers["content-type"] ?? "";
    if (contentType.toLowerCase().includes("json")) {
      try {
        out["body"] = parseJson(decodeText(req.body));
        return out;
      } catch {
        // fall through to base64
      }
    }
    out["body_b64"] = encodeBase64(req.body);
  }
  return out;
}

function bodyBytes(msg: JsonObject): Uint8Array {
  return decodeBase64("body", String(msg["body_b64"]));
}

function bodyText(msg: JsonObject): string {
  return decodeText(bodyBytes(msg));
}

function headersList(msg: JsonObject): Array<[string, string]> {
  const headers = isJsonObject(msg["headers"]) ? msg["headers"] : {};
  return Object.entries(headers).map(([k, v]) => [k, String(v)]);
}

function requestOf(msg: JsonObject, key = "canonical_request"): Request {
  const value = msg[key];
  if (!isJsonObject(value)) throw new TypeError(`${key} must be a Request object`);
  return Request.fromJSON(value);
}

function statusOf(msg: JsonObject): number {
  return Number(msg["status"] ?? 200);
}

function raiseIfError(lm: ProviderLM, status: number, body: string): void {
  if (status >= 400) throw lm.normalizeError(status, body);
}

const ops: Record<string, OpHandler> = {
  async build_request(msg) {
    const lm = adapter(msg);
    const request = requestOf(msg);
    return normalizeTransportRequest(await lm.buildRequest(request, Boolean(msg["stream"])));
  },

  /** PROTOCOL.md § ingest_openai_chat (MAP-12): the case's provider binds the compat; no credential is read. */
  ingest_openai_chat(msg) {
    const lm = adapter(msg, { parseOnly: true });
    const ingest = (lm as ProviderLM & { requestFromOpenAIChat?: (body: unknown) => Request }).requestFromOpenAIChat;
    if (typeof ingest !== "function") throw new ValueError(`provider ${JSON.stringify(msg["provider"])} does not speak the Chat Completions wire; nothing to ingest`);
    return { canonical_request: Request.toJSON(ingest.call(lm, msg["body"])) };
  },

  parse_response(msg) {
    const lm = adapter(msg, { parseOnly: true });
    const request = requestOf(msg);
    return responseResult(lm.parseResponse(request, new HttpResponse({ status: statusOf(msg), body: bodyBytes(msg) })));
  },

  replay_stream(msg) {
    const lm = adapter(msg, { parseOnly: true });
    const request = requestOf(msg);
    const body = bodyBytes(msg);
    if (msg["framing"] === "aws-event-stream") throw new ValueError("aws-event-stream framing is phase 2 (not implemented)");
    const raw: StreamEvent[] = [];
    for (const sse of parseSse(splitLines(body))) raw.push(...lm.parseStreamEvents(request, sse));
    const events = [...coalesceStream(raw, { model: request.model })];
    const eventDicts = events.map(StreamEvent.toJSON);
    let response;
    try {
      response = materializeResponse(events, request);
    } catch (e) {
      if (e instanceof StreamAssemblyError) throw new OpFailure(e, { events: eventDicts });
      throw e;
    }
    return { events: eventDicts, ...responseResult(response) };
  },

  normalize_error(msg) {
    const lm = adapter(msg, { parseOnly: true });
    const err = lm.normalizeError(Number(msg["status"]), String(msg["body_text"]));
    return { class: err.name, code: err.code ?? canonicalErrorCode(err), provider_code: err.providerCode, message: err.message };
  },

  async build_models_request(msg) {
    return normalizeTransportRequest(await adapter(msg).modelsRequest());
  },

  parse_models_response(msg) {
    const lm = adapter(msg, { parseOnly: true });
    const body = bodyText(msg);
    raiseIfError(lm, statusOf(msg), body);
    return { models: lm.modelsFromBody(body).map(ModelInfo.toJSON) };
  },

  // ─── Generation ────────────────────────────────────────────────

  async generation_build(msg) {
    const lm = adapter(msg);
    const kind = String(msg["kind"]);
    const gen = msg["generation_request"];
    if (!isJsonObject(gen)) throw new TypeError("generation_request must be an object");
    if (kind === "image") return normalizeTransportRequest(await lm.imageGenerateRequest(ImageGenerationRequest.fromJSON(gen)));
    if (kind === "speech") return normalizeTransportRequest(await lm.speechGenerateRequest(SpeechGenerationRequest.fromJSON(gen)));
    throw new ValueError(`unknown generation kind: ${kind}`);
  },

  generation_parse(msg) {
    const lm = adapter(msg, { parseOnly: true });
    const kind = String(msg["kind"]);
    const status = statusOf(msg);
    const body = bodyBytes(msg);
    if (status >= 400) throw lm.normalizeError(status, decodeText(body));
    const resp = new HttpResponse({ status, headers: headersList(msg), body });
    const gen = msg["generation_request"];
    if (!isJsonObject(gen)) throw new TypeError("generation_request must be an object");
    if (kind === "image") return ImageGenerationResponse.toJSON(lm.imageGenerationFromResponse(ImageGenerationRequest.fromJSON(gen), resp));
    if (kind === "speech") return SpeechGenerationResponse.toJSON(lm.speechGenerationFromResponse(SpeechGenerationRequest.fromJSON(gen), resp));
    throw new ValueError(`unknown generation kind: ${kind}`);
  },

  // ─── Files ─────────────────────────────────────────────────────

  async file_op_build(msg) {
    const lm = adapter(msg);
    const op = String(msg["file_op"]);
    switch (op) {
      case "upload": {
        const up = msg["upload_request"];
        if (!isJsonObject(up)) throw new TypeError("upload_request must be an object");
        return normalizeTransportRequest(await lm.fileUploadRequest(FileUploadRequest.fromJSON(up)));
      }
      case "get":
        return normalizeTransportRequest(await lm.fileGetRequest(String(msg["file_id"])));
      case "list": {
        const cursor = msg["cursor"];
        return normalizeTransportRequest(await lm.fileListRequest(Number(msg["limit"] ?? 20), cursor === null || cursor === undefined ? undefined : String(cursor)));
      }
      case "delete":
        return normalizeTransportRequest(await lm.fileDeleteRequest(String(msg["file_id"])));
      case "download":
        return normalizeTransportRequest(await lm.fileDownloadRequest(String(msg["file_id"])));
      default:
        throw new ValueError(`unknown file_op: ${op}`);
    }
  },

  file_op_parse(msg) {
    const lm = adapter(msg, { parseOnly: true });
    const kind = String(msg["kind"]);
    const body = bodyText(msg);
    raiseIfError(lm, statusOf(msg), body);
    if (kind === "info") return { file: FileInfo.toJSON(lm.fileInfoFromBody(body)) };
    if (kind === "page") return { page: FilePage.toJSON(lm.filePageFromListBody(body)) };
    throw new ValueError(`unknown file parse kind: ${kind}`);
  },

  // ─── Caches ────────────────────────────────────────────────────

  async cache_op_build(msg) {
    const lm = adapter(msg);
    const op = String(msg["cache_op"]);
    const ttl = msg["ttl_seconds"] === null || msg["ttl_seconds"] === undefined ? undefined : Number(msg["ttl_seconds"]);
    const label = msg["label"] === null || msg["label"] === undefined ? undefined : String(msg["label"]);
    switch (op) {
      case "create": {
        const prefix = requestOf(msg, "prefix_request");
        (lm.constructor as typeof ProviderLM).checkCachePrefix(prefix, ttl);
        return normalizeTransportRequest(await lm.cacheCreateRequest(prefix, ttl, label));
      }
      case "get":
        return normalizeTransportRequest(await lm.cacheGetRequest(String(msg["cache_id"])));
      case "list": {
        const cursor = msg["cursor"];
        return normalizeTransportRequest(await lm.cacheListRequest(Number(msg["limit"] ?? 20), cursor === null || cursor === undefined ? undefined : String(cursor)));
      }
      case "delete":
        return normalizeTransportRequest(await lm.cacheDeleteRequest(String(msg["cache_id"])));
      case "update":
        return normalizeTransportRequest(await lm.cacheUpdateRequest(String(msg["cache_id"]), Number(msg["ttl_seconds"])));
      default:
        throw new ValueError(`unknown cache_op: ${op}`);
    }
  },

  cache_op_parse(msg) {
    const lm = adapter(msg, { parseOnly: true });
    const kind = String(msg["kind"]);
    const body = bodyText(msg);
    raiseIfError(lm, statusOf(msg), body);
    if (kind === "info") return { cache: CacheInfo.toJSON(lm.cacheInfoFromBody(body)) };
    if (kind === "page") return { page: CachePage.toJSON(lm.cachePageFromListBody(body)) };
    throw new ValueError(`unknown cache parse kind: ${kind}`);
  },

  // ─── Video ─────────────────────────────────────────────────────

  async video_op_build(msg) {
    const lm = adapter(msg);
    const action = String(msg["action"]);
    switch (action) {
      case "submit": {
        const vr = msg["video_request"];
        if (!isJsonObject(vr)) throw new TypeError("video_request must be an object");
        return { requests: [normalizeTransportRequest(await lm.videoSubmitRequest(VideoGenerationRequest.fromJSON(vr)))] };
      }
      case "status":
        return { requests: [normalizeTransportRequest(await lm.videoStatusRequest(String(msg["video_id"])))] };
      case "result_fetch": {
        const fetch = await lm.videoResultFetch(isJsonObject(msg["status_body"]) ? msg["status_body"] : {});
        return { requests: fetch ? [normalizeTransportRequest(fetch)] : [] };
      }
      case "list": {
        const model = msg["model"];
        return { requests: [normalizeTransportRequest(await lm.videoListRequest(Number(msg["limit"] ?? 20), model === null || model === undefined ? undefined : String(model)))] };
      }
      default:
        throw new ValueError(`unknown video action: ${action}`);
    }
  },

  video_op_parse(msg) {
    const lm = adapter(msg, { parseOnly: true });
    const kind = String(msg["kind"]);
    switch (kind) {
      case "job": {
        const body = bodyText(msg);
        raiseIfError(lm, statusOf(msg), body);
        const videoId = msg["video_id"];
        return { job: VideoJobInfo.toJSON(lm.videoJobFromBody(body, videoId === null || videoId === undefined ? undefined : String(videoId))) };
      }
      case "list":
        return { jobs: lm.videoJobsFromListBody(bodyText(msg)).map(VideoJobInfo.toJSON) };
      case "part": {
        const fetched =
          msg["fetched_b64"] === null || msg["fetched_b64"] === undefined
            ? undefined
            : new HttpResponse({ status: 200, headers: headersList(msg), body: decodeBase64("fetched", String(msg["fetched_b64"])) });
        return { part: Part.toJSON(lm.videoPart(isJsonObject(msg["status_body"]) ? msg["status_body"] : {}, fetched)) };
      }
      default:
        throw new ValueError(`unknown video parse kind: ${kind}`);
    }
  },

  // ─── Batches ───────────────────────────────────────────────────

  async batch_op_build(msg) {
    const lm = adapter(msg);
    const action = String(msg["action"]);
    const batchRequest = () => {
      const br = msg["batch_request"];
      if (!isJsonObject(br)) throw new TypeError("batch_request must be an object");
      return BatchRequest.fromJSON(br);
    };
    switch (action) {
      case "upload": {
        const upload = await lm.batchUploadRequest(batchRequest());
        return { requests: upload ? [normalizeTransportRequest(upload)] : [] };
      }
      case "submit": {
        const uploadBody = isJsonObject(msg["upload_body"]) ? msg["upload_body"] : undefined;
        return { requests: [normalizeTransportRequest(await lm.batchSubmitRequest(batchRequest(), uploadBody))] };
      }
      case "status":
        return { requests: [normalizeTransportRequest(await lm.batchStatusRequest(String(msg["batch_id"])))] };
      case "cancel":
        return { requests: [normalizeTransportRequest(await lm.batchCancelRequest(String(msg["batch_id"])))] };
      case "list":
        return { requests: [normalizeTransportRequest(await lm.batchListRequest(Number(msg["limit"] ?? 20)))] };
      case "result_fetches": {
        const fetches = await lm.batchResultFetches(isJsonObject(msg["status_body"]) ? msg["status_body"] : {});
        return { requests: fetches.map(normalizeTransportRequest) };
      }
      default:
        throw new ValueError(`unknown batch action: ${action}`);
    }
  },

  batch_op_parse(msg) {
    const lm = adapter(msg, { parseOnly: true });
    const kind = String(msg["kind"]);
    switch (kind) {
      case "job": {
        const body = bodyText(msg);
        raiseIfError(lm, statusOf(msg), body);
        return { job: BatchJobInfo.toJSON(lm.batchJobFromBody(body)) };
      }
      case "list":
        return { jobs: lm.batchJobsFromListBody(bodyText(msg)).map(BatchJobInfo.toJSON) };
      case "entries": {
        const fetched = Array.isArray(msg["fetched_b64"]) ? msg["fetched_b64"].map((b) => decodeText(decodeBase64("fetched", String(b)))) : [];
        return { entries: lm.batchEntries(isJsonObject(msg["status_body"]) ? msg["status_body"] : {}, fetched).map(BatchEntry.toJSON) };
      }
      default:
        throw new ValueError(`unknown batch parse kind: ${kind}`);
    }
  },

  // ─── Live ──────────────────────────────────────────────────────

  replay_live(msg) {
    const lm = adapter(msg, { parseOnly: true });
    const lc = msg["live_config"];
    if (!isJsonObject(lc)) throw new TypeError("live_config must be an object");
    const config = LiveConfig.fromJSON(lc);
    const encoder = lm.liveEncoder(config);
    const clientFrames = (Array.isArray(msg["client_events"]) ? msg["client_events"] : []).map((e) => encoder(LiveClientEvent.fromJSON(e as JsonObject)));
    const events = (Array.isArray(msg["server_frames_b64"]) ? msg["server_frames_b64"] : []).map((b) =>
      lm.decodeLiveServerEvent(decodeBase64("frame", String(b))).map(LiveServerEvent.toJSON),
    );
    return { setup_frames: lm.liveSetupFrames(config) as JsonValue, client_frames: clientFrames as JsonValue, events };
  },
};

registerOps(ops);

// ─── Auth, token, router ─────────────────────────────────────────────

import { explainAuth, describeReport } from "./auth/doctor.ts";
import { ChainContext, tokenExchangeBuild, tokenExchangeParse } from "./cloud/chains.ts";
import { sign as sigv4Sign } from "./cloud/sigv4.ts";
import { LM15Error } from "./errors.ts";
import { lookup } from "./registry.ts";
import { ModelRegistry } from "./types/model_info.ts";
import { resolveModel } from "./router.ts";
import { AwsCredentials } from "./types/credential.ts";

function stringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (isJsonObject(value)) for (const [k, v] of Object.entries(value)) out[k] = String(v);
  return out;
}

registerOps({
  explain_auth(msg) {
    const provider = String(msg["provider"]);
    const sentinel = String(msg["sentinel"]);
    const env = stringMap(msg["env"]);
    const providers = Array.isArray(msg["api_keys_providers"]) ? msg["api_keys_providers"].map(String) : [];
    const apiKeys = providers.length > 0 ? Object.fromEntries(providers.map((p) => [p, sentinel])) : undefined;
    const files = isJsonObject(msg["files"]) ? stringMap(msg["files"]) : undefined;
    const settings = isJsonObject(msg["settings"]) ? stringMap(msg["settings"]) : undefined;
    const credentialsPath = msg["credentials_path"] === null || msg["credentials_path"] === undefined ? undefined : String(msg["credentials_path"]);
    const canonical = provider.replace(/_/g, "-");
    const report = explainAuth(provider, {
      env,
      ...(apiKeys ? { apiKeys } : {}),
      ...(files ? { files } : {}),
      ...(env["HOME"] ? { home: env["HOME"] } : {}),
      ...(settings ? { settings } : {}),
      ...(credentialsPath !== undefined
        ? canonical === "claude-code"
          ? { claudeCredentialsPath: credentialsPath }
          : canonical === "xai"
            ? { xaiCredentialsPath: credentialsPath }
            : { codexAuthPath: credentialsPath }
        : {}),
    });
    return {
      configured: report.configured,
      steps: report.steps.map((s) => ({ kind: s.kind, state: s.state })),
      report_text: [describeReport(report), JSON.stringify(report.steps.map((s) => ({ ...s })))].join("\n"),
    };
  },

  token_exchange_build(msg) {
    const definition = lookup(String(msg["provider"]));
    if (!definition) throw new ValueError(`unknown provider: ${String(msg["provider"])}`);
    const inputs: JsonObject = { ...(isJsonObject(msg["input"]) ? msg["input"] : isJsonObject(msg["credential"]) ? msg["credential"] : {}) };
    const env = stringMap(inputs["env"]);
    const files: Record<string, string> = {};
    if (inputs["certificate_pem"] && env["AZURE_CLIENT_CERTIFICATE_PATH"]) {
      files[env["AZURE_CLIENT_CERTIFICATE_PATH"]] = `${String(inputs["certificate_pem"])}\n${String(inputs["private_key_pem"] ?? "")}`;
    }
    const fixed = parseRfc3339(String(msg["now"]));
    const ctx = new ChainContext({ env, files: Object.keys(files).length > 0 ? files : undefined, now: () => fixed, settings: stringMap(inputs["settings"] ?? msg["settings"]) });
    return tokenExchangeBuild(definition.access, String(msg["rung"]), inputs, ctx);
  },

  token_exchange_parse(msg) {
    const definition = lookup(String(msg["provider"]));
    if (!definition) throw new ValueError(`unknown provider: ${String(msg["provider"])}`);
    const fixed = parseRfc3339(String(msg["now"]));
    let body = msg["body"];
    if ((body === null || body === undefined) && msg["body_b64"] !== undefined) body = parseJson(decodeText(decodeBase64("body", String(msg["body_b64"]))));
    const ctx = new ChainContext({ env: {}, now: () => fixed });
    try {
      const credential = tokenExchangeParse(definition.access, String(msg["rung"]), Number(msg["status"] ?? 200), isJsonObject(body) ? body : {}, ctx);
      return { ok: true, credential: Credential.toJSON(credential) };
    } catch (e) {
      if (e instanceof LM15Error) return { ok: false, error: { class: e.name, code: e.code } };
      throw e;
    }
  },

  sigv4_sign(msg) {
    const credential = Credential.fromJSON(msg["credential"] as JsonObject);
    if (!(credential instanceof AwsCredentials)) throw new ValueError("sigv4_sign needs an aws credential");
    const req = msg["request"] as JsonObject;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(isJsonObject(req["headers"]) ? req["headers"] : {})) {
      if (["host", "x-amz-date", "x-amz-security-token"].includes(k.toLowerCase())) continue;
      headers[k] = Array.isArray(v) ? v.map(String).join(",") : String(v);
    }
    const signature = sigv4Sign({
      method: String(req["method"]),
      url: String(req["url"]),
      headers,
      payload: new TextEncoder().encode(String(req["body"] ?? "")),
      credentials: credential,
      region: String(msg["region"]),
      service: String(msg["service"]),
      now: parseRfc3339(String(msg["now"])),
    });
    return { canonical_request: signature.canonicalRequest, string_to_sign: signature.stringToSign, authorization: signature.authorization, headers: signature.headers };
  },

  resolve_model(msg) {
    const env = stringMap(msg["env"]);
    let registry: ModelRegistry | undefined;
    if ("catalog" in msg) {
      registry = new ModelRegistry();
      for (const entry of Array.isArray(msg["catalog"]) ? msg["catalog"] : []) registry.add(ModelInfo.fromJSON(entry as JsonObject), { replace: false });
    }
    const resolution = resolveModel(String(msg["model"]), { env, ...(registry ? { registry } : {}) });
    return { provider: resolution.provider, model: resolution.model, source: resolution.source };
  },
});
