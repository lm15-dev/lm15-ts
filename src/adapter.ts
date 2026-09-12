/**
 * `ProviderLM`: the shared adapter base. A dialect (the subclass) bound to
 * an access policy (a value, AUTH-10). The subclass owns the pure codec —
 * payload, parse, stream events, error shape, the surface hooks — and this
 * class owns everything around it: credential resolution (AUTH-2), the host
 * rewrites and signing, the transport, the MAP-3 coalescer, and the drivers
 * for every surface (`complete`, `stream`, `listModels`, files, batches,
 * caches, generation, video).
 */

import { abortable, checkAborted } from "./async.ts";
import type { LiveSession, LiveSessionOptions } from "./live.ts";
import { BatchJob, VideoJob } from "./jobs.ts";
import { authHeader, selectScheme, supportsEndpoint, type AccessPolicy } from "./auth/policy.ts";
import { finishRequest, renderBaseUrl, resolveSettings, signRequest, utcNow, type Clock } from "./cloud/hosts.ts";
import { AuthError, LM15Error, NotConfiguredError, ProviderError, TransportError, UnsupportedFeatureError, mapHttpError, withCredentialHint } from "./errors.ts";
import { isJsonObject, type JsonObject } from "./json.ts";
import { getDefaultPlatform, noStoredCredentials, type LoadedCredential } from "./platform.ts";
import { lookup } from "./registry.ts";
import { coalesceStreamAsync, parseSseAsync, splitLinesAsync, type SSEEvent } from "./stream.ts";
import { bufferResponse, getDefaultTransport, type Transport } from "./transport.ts";
import { AwsCredentials, coerceCredential, type CredentialLike, type CredentialValue } from "./types/credential.ts";
import { isDefaultConfig, normalizeRequest, type Request } from "./types/config.ts";
import type {
  BatchEntry,
  BatchJobInfo,
  BatchRequest,
  CacheInfo,
  CachePage,
  CachedPrefix as CachedPrefixValue,
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
import { CachedPrefix, normalizeFileUploadRequest, normalizeBatchRequest, normalizeImageGenerationRequest, normalizeSpeechGenerationRequest, normalizeVideoGenerationRequest } from "./types/endpoints.ts";
import type { LiveConfig, LiveClientEvent, LiveServerEvent } from "./types/live.ts";
import type { ModelInfo } from "./types/model_info.ts";
import type { VideoPart } from "./types/parts.ts";
import type { Response } from "./types/response.ts";
import type { StreamEvent } from "./types/stream.ts";
import { ValueError } from "./types/validate.ts";
import { BATCH_TERMINAL_STATUSES, VIDEO_TERMINAL_STATUSES } from "./vocab.ts";
import { HttpResponse, jsonBytes, makeJsonRequest, type TransportRequest } from "./wire.ts";

export interface LMOptions {
  /** A string, an AUTH-2 credential value, or a zero-arg (possibly async) provider. */
  readonly apiKey?: CredentialLike;
  readonly baseUrl?: string;
  /** The access policy to bind (default: the dialect's own manifest). */
  readonly access?: AccessPolicy;
  /** Host settings (AUTH-10): region, resource, project, location, … */
  readonly settings?: Readonly<Record<string, string>>;
  /** The clock every time-dependent byte reads from (tests, the harness). */
  readonly clock?: Clock;
  readonly transport?: Transport;
  /** Override of the borrowed credential file path (AUTH-8). */
  readonly credentialsPath?: string;
  /** ChatGPT account id (Codex backend). */
  readonly accountId?: string;
}

const SURFACE_WORD: Readonly<Record<string, string>> = Object.freeze({
  files: "files",
  batches: "batch",
  images: "image generation",
  speech: "speech generation",
  video: "video generation",
  live: "live",
  caches: "caches",
  models: "model listing",
});

export interface EmitOptions {
  readonly method: string;
  readonly url: string;
  readonly headers?: Record<string, string> | undefined;
  readonly params?: Record<string, string | number | boolean | null | undefined> | undefined;
  readonly payload?: unknown;
  readonly body?: Uint8Array | undefined;
  readonly endpoint?: string | undefined;
  readonly stream?: boolean | undefined;
  readonly model?: string | undefined;
}

/**
 * AUTH-1: an explicit credential always wins; a stored-login policy asks the
 * host platform (AUTH-8). A host without stores refuses by name; a `key`
 * policy with nothing given refuses naming the env keys.
 */
export function loadCredential(policy: AccessPolicy, apiKey: CredentialLike | undefined, credentialsPath?: string): LoadedCredential {
  if (apiKey !== undefined && apiKey !== "") return { credential: apiKey, source: "explicit" };
  const platform = getDefaultPlatform();
  if (policy.credentialPolicy !== "key" && platform.storedCredentials) return platform.storedCredentials.load(policy, credentialsPath);
  if (policy.credentialPolicy !== "key") throw noStoredCredentials(platform, policy);
  throw new NotConfiguredError(
    `${policy.provider}: no credential given` + (policy.envKeys.length > 0 ? `; set ${policy.envKeys.join(" or ")} or pass apiKey` : "; pass apiKey"),
    { provider: policy.provider, envKeys: policy.envKeys, credentialHint: policy.loginHint ?? null },
  );
}

export abstract class ProviderLM {
  /** The class's default policy. */
  static readonly manifest: AccessPolicy;
  /** The dialect's own default base URL. */
  protected abstract readonly dialectBaseUrl: string;
  /** The header an ApiKey travels under when the policy says `x-api-key`. */
  protected readonly apiKeyHeader: string = "x-api-key";

  readonly access: AccessPolicy;
  readonly provider: string;
  baseUrl: string;
  readonly hostSettings: Readonly<Record<string, string>>;
  readonly clock: Clock | undefined;
  transport: Transport;
  accountId: string | undefined;
  protected credential: CredentialLike | undefined;
  protected credentialSource: "explicit" | "stored" = "explicit";

  protected constructor(manifest: AccessPolicy, dialectBaseUrl: string, opts: LMOptions) {
    const policy = opts.access ?? manifest;
    this.access = policy;
    this.provider = policy.provider;
    this.transport = opts.transport ?? getDefaultTransport();
    this.clock = opts.clock;
    this.accountId = opts.accountId;
    this.baseUrl = opts.baseUrl ?? dialectBaseUrl;
    const loaded = loadCredential(policy, opts.apiKey, opts.credentialsPath);
    this.credential = loaded.credential;
    this.credentialSource = loaded.source;
    if (loaded.accountId !== undefined && this.accountId === undefined) this.accountId = loaded.accountId;
    if (loaded.credential !== undefined && typeof loaded.credential !== "function") {
      // A static credential of the wrong kind for this door fails now, not on the first request.
      selectScheme(policy, coerceCredential(loaded.credential));
    }
    this.hostSettings = resolveSettings(policy.host, opts.settings, undefined, { provider: policy.provider });
    if (policy.host) {
      if (opts.baseUrl === undefined || this.baseUrl === dialectBaseUrl) this.baseUrl = renderBaseUrl(policy.host, this.hostSettings);
    } else if (policy.baseUrl !== undefined && this.baseUrl === dialectBaseUrl) {
      this.baseUrl = policy.baseUrl;
    }
  }

  get supports() {
    return this.access.supports;
  }

  /** The compat preset the bound provider names in the registry (a bound policy with no `compat`). */
  protected registryCompat(): string | undefined {
    if (this.access === (this.constructor as typeof ProviderLM).manifest) return undefined;
    return lookup(this.access.provider)?.compat;
  }

  protected now(): Date {
    return this.clock ? this.clock() : utcNow();
  }

  protected base(): string {
    return this.baseUrl.replace(/\/+$/, "");
  }

  /** Resolve the credential provider (AUTH-2: once per request, never cached here). */
  protected async resolveCredential(): Promise<CredentialValue | undefined> {
    if (this.credential === undefined) return undefined;
    const raw = typeof this.credential === "function" ? await this.credential() : this.credential;
    return coerceCredential(raw);
  }

  /** Finish a dialect-built request through the bound host (AUTH-10) and sign it. */
  protected async emit(opts: EmitOptions): Promise<TransportRequest> {
    const credential = await this.resolveCredential();
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (credential !== undefined && !(credential instanceof AwsCredentials)) {
      const pair = authHeader(this.access, credential, this.apiKeyHeader);
      if (pair && !Object.keys(headers).some((k) => k.toLowerCase() === pair[0].toLowerCase())) headers[pair[0]] = pair[1];
    }
    const finished = finishRequest(this.access, this.hostSettings, {
      baseUrl: this.baseUrl,
      url: opts.url,
      headers,
      payload: opts.payload,
      params: opts.params,
      endpoint: opts.endpoint,
      stream: opts.stream ?? false,
      model: opts.model,
      credential,
    });
    let req = makeJsonRequest({
      method: opts.method,
      url: finished.url,
      headers: finished.headers,
      params: Object.keys(finished.params).length > 0 ? finished.params : undefined,
      payload: finished.payload,
      body: opts.body,
    });
    if (opts.stream) req = { ...req, readTimeout: 120 };
    if (credential instanceof AwsCredentials) {
      const signed = await signRequest(this.access, this.hostSettings, {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: req.body,
        credential,
        now: this.now(),
      });
      return { ...req, headers: signed };
    }
    return req;
  }

  /** Raise unless the bound access path carries `surface`. */
  protected require(surface: string): void {
    if (!supportsEndpoint(this.access.supports, surface)) {
      throw new UnsupportedFeatureError(`${this.provider}: ${SURFACE_WORD[surface] ?? surface} not supported`, { provider: this.provider });
    }
  }

  // ─── The codec every dialect implements ────────────────────────────

  abstract buildRequest(request: Request, stream: boolean): Promise<TransportRequest>;
  abstract parseResponse(request: Request, response: HttpResponse): Response;
  abstract parseStreamEvents(request: Request, event: SSEEvent): StreamEvent[];

  normalizeError(status: number, body: string): ProviderError {
    return this.withLoginHint(mapHttpError(status, body.trim().slice(0, 500) || `HTTP ${status}`, { provider: this.provider, envKeys: this.access.envKeys }));
  }

  protected providerError<E extends ProviderError>(
    cls: new (message: string, meta: { provider?: string | null; providerCode?: string | null; status?: number | null; requestId?: string | null; retryAfter?: number | null; envKeys?: readonly string[] }) => E,
    message: string,
    meta: { status?: number; providerCode?: string | null; requestId?: string | null; retryAfter?: number | null } = {},
  ): ProviderError {
    const m = {
      provider: this.provider,
      providerCode: meta.providerCode || null,
      status: meta.status ?? null,
      requestId: meta.requestId || null,
      retryAfter: meta.retryAfter ?? null,
    };
    if (cls === (AuthError as unknown) || cls.prototype instanceof AuthError) {
      return this.withLoginHint(new cls(message, { ...m, envKeys: this.access.envKeys }));
    }
    return new cls(message, m);
  }

  /** Auth errors guide the user to re-login when the credential is a local login. */
  protected withLoginHint(error: ProviderError): ProviderError {
    const hint = this.access.loginHint;
    if (hint && (this.access.credentialPolicy === "oauth" || this.credentialSource === "stored")) return withCredentialHint(error, hint);
    return error;
  }

  // ─── Drivers: complete / stream ────────────────────────────────────

  async complete(request: Request, opts: { signal?: AbortSignal } = {}): Promise<Response> {
    checkAborted(opts.signal);
    request = normalizeRequest(request);
    const building = this.buildRequest(request, false);
    const req = await (opts.signal ? abortable(building, opts.signal) : building);
    const resp = await this.send(req, opts.signal);
    if (resp.status >= 400) throw attachErrorMetadata(this.normalizeError(resp.status, resp.text()), resp);
    return this.parseResponse(request, resp);
  }

  /** The canonical event stream: exactly one `start`, deltas, exactly one final `end` (MAP-3/4). */
  stream(request: Request, opts: { signal?: AbortSignal } = {}): AsyncIterable<StreamEvent> {
    return coalesceStreamAsync(this.streamRaw(request, opts.signal), { model: request.model });
  }

  protected async *streamRaw(request: Request, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    checkAborted(signal);
    request = normalizeRequest(request);
    const building = this.buildRequest(request, true);
    const req = await (signal ? abortable(building, signal) : building);
    let res;
    try {
      res = await this.transport.send(req, { signal });
    } catch (e) {
      throw wrapTransport(e);
    }
    if (res.status >= 400) {
      const buffered = await bufferResponse(res);
      throw attachErrorMetadata(this.normalizeError(buffered.status, buffered.text()), buffered);
    }
    for await (const sse of parseSseAsync(splitLinesAsync(res.chunks()))) {
      for (const event of this.parseStreamEvents(request, sse)) yield event;
    }
  }

  protected async send(request: TransportRequest, signal?: AbortSignal): Promise<HttpResponse> {
    try {
      return await bufferResponse(await this.transport.send(request, { signal }));
    } catch (e) {
      throw wrapTransport(e);
    }
  }

  protected async sendOk(request: TransportRequest): Promise<HttpResponse> {
    const resp = await this.send(request);
    if (resp.status >= 400) throw attachErrorMetadata(this.normalizeError(resp.status, resp.text()), resp);
    return resp;
  }

  // ─── Model listing ─────────────────────────────────────────────────

  modelsRequest(): Promise<TransportRequest> {
    throw new UnsupportedFeatureError(`${this.provider}: model listing not supported`, { provider: this.provider });
  }
  modelsFromBody(_body: string): ModelInfo[] {
    throw new UnsupportedFeatureError(`${this.provider}: model listing not supported`, { provider: this.provider });
  }

  async listModels(): Promise<ModelInfo[]> {
    this.require("models");
    const resp = await this.sendOk(await this.modelsRequest());
    return this.modelsFromBody(resp.text());
  }

  // ─── Live ──────────────────────────────────────────────────────────

  async live(config: LiveConfig, opts: LiveSessionOptions = {}): Promise<LiveSession> {
    const { LiveSession } = await import("./live.ts");
    return LiveSession.open(this, config, opts);
  }

  liveSetupFrames(_config: LiveConfig): JsonObject[] {
    throw new UnsupportedFeatureError(`${this.provider}: live not supported`, { provider: this.provider });
  }
  liveEncoder(_config: LiveConfig): (event: LiveClientEvent) => JsonObject[] {
    throw new UnsupportedFeatureError(`${this.provider}: live not supported`, { provider: this.provider });
  }
  decodeLiveServerEvent(_raw: Uint8Array | string): LiveServerEvent[] {
    throw new UnsupportedFeatureError(`${this.provider}: live not supported`, { provider: this.provider });
  }

  // ─── Files ─────────────────────────────────────────────────────────

  protected filesUnsupported(): UnsupportedFeatureError {
    return new UnsupportedFeatureError(`${this.provider}: files not supported`, { provider: this.provider });
  }
  fileUploadRequest(_request: FileUploadRequest): Promise<TransportRequest> {
    throw this.filesUnsupported();
  }
  fileInfoFromBody(_body: string): FileInfo {
    throw this.filesUnsupported();
  }
  fileGetRequest(_fileId: string): Promise<TransportRequest> {
    throw this.filesUnsupported();
  }
  fileListRequest(_limit: number, _cursor?: string): Promise<TransportRequest> {
    throw this.filesUnsupported();
  }
  filePageFromListBody(_body: string): FilePage {
    throw this.filesUnsupported();
  }
  fileDeleteRequest(_fileId: string): Promise<TransportRequest> {
    throw this.filesUnsupported();
  }
  fileDownloadRequest(_fileId: string): Promise<TransportRequest> {
    throw this.filesUnsupported();
  }

  async fileUpload(request: FileUploadRequest): Promise<FileInfo> {
    this.require("files");
    request = normalizeFileUploadRequest(request);
    return this.fileInfoFromBody((await this.sendOk(await this.fileUploadRequest(request))).text());
  }
  async fileGet(fileId: string): Promise<FileInfo> {
    this.require("files");
    return this.fileInfoFromBody((await this.sendOk(await this.fileGetRequest(fileId))).text());
  }
  async fileList(limit = 20, cursor?: string): Promise<FilePage> {
    this.require("files");
    return this.filePageFromListBody((await this.sendOk(await this.fileListRequest(limit, cursor))).text());
  }
  /** Returning without an exception IS the confirmation. */
  async fileDelete(fileId: string): Promise<void> {
    this.require("files");
    await this.sendOk(await this.fileDeleteRequest(fileId));
  }
  async fileDownload(fileId: string): Promise<Uint8Array> {
    this.require("files");
    return (await this.sendOk(await this.fileDownloadRequest(fileId))).body;
  }
  /** Poll until the file leaves `pending`; returns the terminal snapshot. */
  async fileWaitReady(fileId: string, opts: { pollEveryMs?: number; timeoutMs?: number } = {}): Promise<FileInfo> {
    this.require("files");
    const deadline = opts.timeoutMs !== undefined ? Date.now() + opts.timeoutMs : undefined;
    let info = await this.fileGet(fileId);
    while ((info.readiness ?? "ready") === "pending") {
      if (deadline !== undefined && Date.now() >= deadline) throw new TransportError(`file ${fileId} still pending after ${opts.timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, opts.pollEveryMs ?? 2000));
      info = await this.fileGet(fileId);
    }
    return info;
  }

  // ─── Batches ───────────────────────────────────────────────────────

  protected batchUnsupported(): UnsupportedFeatureError {
    return new UnsupportedFeatureError(`${this.provider}: batch not supported`, { provider: this.provider });
  }
  /** Optional pre-submit upload step (OpenAI's JSONL file); `undefined` = single-step. */
  batchUploadRequest(_request: BatchRequest): Promise<TransportRequest | undefined> {
    return Promise.resolve(undefined);
  }
  batchSubmitRequest(_request: BatchRequest, _uploadBody?: JsonObject): Promise<TransportRequest> {
    throw this.batchUnsupported();
  }
  batchJobFromBody(_body: string): BatchJobInfo {
    throw this.batchUnsupported();
  }
  batchStatusRequest(_batchId: string): Promise<TransportRequest> {
    throw this.batchUnsupported();
  }
  batchCancelRequest(_batchId: string): Promise<TransportRequest> {
    throw this.batchUnsupported();
  }
  batchResultFetches(_statusBody: JsonObject): Promise<TransportRequest[]> {
    throw this.batchUnsupported();
  }
  batchEntries(_statusBody: JsonObject, _fetched: readonly string[]): BatchEntry[] {
    throw this.batchUnsupported();
  }
  batchListRequest(_limit: number): Promise<TransportRequest> {
    throw this.batchUnsupported();
  }
  batchJobsFromListBody(_body: string): BatchJobInfo[] {
    throw this.batchUnsupported();
  }

  async batchSubmit(request: BatchRequest): Promise<BatchJobInfo> {
    this.require("batches");
    request = normalizeBatchRequest(request);
    let uploadBody: JsonObject | undefined;
    const upload = await this.batchUploadRequest(request);
    if (upload) {
      const body = (await this.sendOk(upload)).json();
      uploadBody = isJsonObject(body) ? body : undefined;
    }
    return this.batchJobFromBody((await this.sendOk(await this.batchSubmitRequest(request, uploadBody))).text());
  }
  async batchStatus(batchId: string): Promise<BatchJobInfo> {
    this.require("batches");
    return this.batchJobFromBody((await this.sendOk(await this.batchStatusRequest(batchId))).text());
  }
  /** Entries in submission order; throws while the job runs. */
  async batchResults(batchId: string): Promise<BatchEntry[]> {
    this.require("batches");
    const resp = await this.sendOk(await this.batchStatusRequest(batchId));
    const job = this.batchJobFromBody(resp.text());
    if (!(BATCH_TERMINAL_STATUSES as readonly string[]).includes(job.status)) {
      throw new ValueError(`batch ${batchId} is not finished (status=${JSON.stringify(job.status)}); poll batchStatus() until done`);
    }
    const statusBody = resp.json() as JsonObject;
    const texts: string[] = [];
    for (const fetch of await this.batchResultFetches(statusBody)) texts.push((await this.sendOk(fetch)).text());
    return this.batchEntries(statusBody, texts);
  }
  async batchCancel(batchId: string): Promise<BatchJobInfo> {
    this.require("batches");
    return this.batchJobFromBody((await this.sendOk(await this.batchCancelRequest(batchId))).text());
  }
  async batchList(limit = 20): Promise<BatchJobInfo[]> {
    this.require("batches");
    return this.batchJobsFromListBody((await this.sendOk(await this.batchListRequest(limit))).text());
  }

  // Job handles (api-family § Beyond chat): sugar over the four verbs above.

  /** Submit and wrap the ticket in a `BatchJob` handle. */
  async batch(request: BatchRequest): Promise<BatchJob> {
    return new BatchJob(this, await this.batchSubmit(request));
  }
  /** Re-attach to an existing job by id alone (the primary pattern for real workloads). */
  async batchJob(batchId: string): Promise<BatchJob> {
    return new BatchJob(this, await this.batchStatus(batchId));
  }
  async batches(limit = 20): Promise<BatchJob[]> {
    return (await this.batchList(limit)).map((info) => new BatchJob(this, info));
  }

  // ─── Caches (the stored tier of MAP-6) ─────────────────────────────

  protected cachesUnsupported(): UnsupportedFeatureError {
    return new UnsupportedFeatureError(`${this.provider}: stored caches not supported`, { provider: this.provider });
  }
  cacheCreateRequest(_prefix: Request, _ttlSeconds?: number, _label?: string): Promise<TransportRequest> {
    throw this.cachesUnsupported();
  }
  cacheInfoFromBody(_body: string): CacheInfo {
    throw this.cachesUnsupported();
  }
  cacheGetRequest(_cacheId: string): Promise<TransportRequest> {
    throw this.cachesUnsupported();
  }
  cacheListRequest(_limit: number, _cursor?: string): Promise<TransportRequest> {
    throw this.cachesUnsupported();
  }
  cachePageFromListBody(_body: string): CachePage {
    throw this.cachesUnsupported();
  }
  cacheDeleteRequest(_cacheId: string): Promise<TransportRequest> {
    throw this.cachesUnsupported();
  }
  cacheUpdateRequest(_cacheId: string, _ttlSeconds: number): Promise<TransportRequest> {
    throw this.cachesUnsupported();
  }

  static checkCachePrefix(prefix: Request, ttlSeconds?: number): void {
    if (!isDefaultConfig(prefix.config)) {
      throw new ValueError("cache_create: the prefix Request must carry a default Config (a stored cache has no generation settings)");
    }
    if (ttlSeconds !== undefined && (typeof ttlSeconds !== "number" || !Number.isInteger(ttlSeconds) || ttlSeconds <= 0)) {
      throw new ValueError("ttl_seconds must be a positive int");
    }
  }

  async cacheCreate(prefix: Request, opts: { ttlSeconds?: number; label?: string } = {}): Promise<CacheInfo> {
    this.require("caches");
    prefix = normalizeRequest(prefix);
    ProviderLM.checkCachePrefix(prefix, opts.ttlSeconds);
    return this.cacheInfoFromBody((await this.sendOk(await this.cacheCreateRequest(prefix, opts.ttlSeconds, opts.label))).text());
  }
  async cacheGet(cacheId: string): Promise<CacheInfo> {
    this.require("caches");
    return this.cacheInfoFromBody((await this.sendOk(await this.cacheGetRequest(cacheId))).text());
  }
  async cacheList(limit = 20, cursor?: string): Promise<CachePage> {
    this.require("caches");
    return this.cachePageFromListBody((await this.sendOk(await this.cacheListRequest(limit, cursor))).text());
  }
  async cacheDelete(cacheId: string): Promise<void> {
    this.require("caches");
    await this.sendOk(await this.cacheDeleteRequest(cacheId));
  }
  async cacheUpdate(cacheId: string, ttlSeconds: number): Promise<CacheInfo> {
    this.require("caches");
    if (typeof ttlSeconds !== "number" || !Number.isInteger(ttlSeconds) || ttlSeconds <= 0) throw new ValueError("ttl_seconds must be a positive int");
    return this.cacheInfoFromBody((await this.sendOk(await this.cacheUpdateRequest(cacheId, ttlSeconds))).text());
  }
  /** Make a prompt beginning reusable with the best tier this provider has. */
  async cache(prefix: Request, opts: { ttlSeconds?: number; label?: string } = {}): Promise<CachedPrefixValue> {
    prefix = normalizeRequest(prefix);
    if (this.supports.caches) return CachedPrefix.create({ prefix, resource: await this.cacheCreate(prefix, opts) });
    ProviderLM.checkCachePrefix(prefix, opts.ttlSeconds);
    return CachedPrefix.create({ prefix });
  }

  // ─── Generation ────────────────────────────────────────────────────

  protected generationUnsupported(kind: string): UnsupportedFeatureError {
    return new UnsupportedFeatureError(`${this.provider}: ${kind} generation not supported`, { provider: this.provider });
  }
  imageGenerateRequest(_request: ImageGenerationRequest): Promise<TransportRequest> {
    throw this.generationUnsupported("image");
  }
  imageGenerationFromResponse(_request: ImageGenerationRequest, _resp: HttpResponse): ImageGenerationResponse {
    throw this.generationUnsupported("image");
  }
  speechGenerateRequest(_request: SpeechGenerationRequest): Promise<TransportRequest> {
    throw this.generationUnsupported("speech");
  }
  speechGenerationFromResponse(_request: SpeechGenerationRequest, _resp: HttpResponse): SpeechGenerationResponse {
    throw this.generationUnsupported("speech");
  }

  async imageGenerate(request: ImageGenerationRequest): Promise<ImageGenerationResponse> {
    this.require("images");
    request = normalizeImageGenerationRequest(request);
    return this.imageGenerationFromResponse(request, await this.sendOk(await this.imageGenerateRequest(request)));
  }
  async speechGenerate(request: SpeechGenerationRequest): Promise<SpeechGenerationResponse> {
    this.require("speech");
    request = normalizeSpeechGenerationRequest(request);
    return this.speechGenerationFromResponse(request, await this.sendOk(await this.speechGenerateRequest(request)));
  }

  // ─── Video ─────────────────────────────────────────────────────────

  protected videoUnsupported(): UnsupportedFeatureError {
    return new UnsupportedFeatureError(`${this.provider}: video generation not supported`, { provider: this.provider });
  }
  videoSubmitRequest(_request: VideoGenerationRequest): Promise<TransportRequest> {
    throw this.videoUnsupported();
  }
  videoJobFromBody(_body: string, _videoId?: string): VideoJobInfo {
    throw this.videoUnsupported();
  }
  videoStatusRequest(_videoId: string): Promise<TransportRequest> {
    throw this.videoUnsupported();
  }
  /** Optional download step; `undefined` = the terminal body carries the URL. */
  videoResultFetch(_statusBody: JsonObject): Promise<TransportRequest | undefined> {
    throw this.videoUnsupported();
  }
  videoPart(_statusBody: JsonObject, _fetched?: HttpResponse): VideoPart {
    throw this.videoUnsupported();
  }
  videoListRequest(_limit: number, _model?: string): Promise<TransportRequest> {
    throw this.videoUnsupported();
  }
  videoJobsFromListBody(_body: string): VideoJobInfo[] {
    throw this.videoUnsupported();
  }

  async videoSubmit(request: VideoGenerationRequest): Promise<VideoJobInfo> {
    this.require("video");
    request = normalizeVideoGenerationRequest(request);
    return this.videoJobFromBody((await this.sendOk(await this.videoSubmitRequest(request))).text());
  }
  async videoStatus(videoId: string): Promise<VideoJobInfo> {
    this.require("video");
    return this.videoJobFromBody((await this.sendOk(await this.videoStatusRequest(videoId))).text(), videoId);
  }
  async videoResult(videoId: string): Promise<VideoPart> {
    this.require("video");
    const resp = await this.sendOk(await this.videoStatusRequest(videoId));
    const job = this.videoJobFromBody(resp.text(), videoId);
    if (!(VIDEO_TERMINAL_STATUSES as readonly string[]).includes(job.status)) {
      throw new ValueError(`video ${videoId} is not finished (status=${JSON.stringify(job.status)}); poll videoStatus() until done`);
    }
    const statusBody = resp.json() as JsonObject;
    const fetch = await this.videoResultFetch(statusBody);
    const fetched = fetch ? await this.sendOk(fetch) : undefined;
    return this.videoPart(statusBody, fetched);
  }
  async videoList(limit = 20, model?: string): Promise<VideoJobInfo[]> {
    this.require("video");
    return this.videoJobsFromListBody((await this.sendOk(await this.videoListRequest(limit, model))).text());
  }

  /** Submit and wrap the ticket in a `VideoJob` handle. */
  async videoGenerate(request: VideoGenerationRequest): Promise<VideoJob> {
    return new VideoJob(this, await this.videoSubmit(request));
  }
  /** Re-attach to an existing job by id alone; on xAI the id you stored is the only copy (no list endpoint). */
  async videoJob(videoId: string): Promise<VideoJob> {
    return new VideoJob(this, await this.videoStatus(videoId));
  }
  /** This credential's video jobs as handles, where the wire lists them (OpenAI account-wide; Gemini per `model`; xAI raises). */
  async videoJobs(limit = 20, model?: string): Promise<VideoJob[]> {
    return (await this.videoList(limit, model)).map((info) => new VideoJob(this, info));
  }
}

function wrapTransport(e: unknown): LM15Error {
  if (e instanceof LM15Error) return e;
  if (e instanceof Error && e.name === "AbortError") return new TransportError("request aborted", { cause: e });
  return new TransportError(e instanceof Error ? e.message : String(e), { cause: e });
}

/**
 * A retry hint as seconds: delta-seconds, or an HTTP-date measured from now
 * (never negative). A hint that is not finite, is negative, or does not
 * parse is DROPPED, never stored: an infinite or NaN retryAfter becomes an
 * infinite sleep in the first caller that trusts it (contract
 * 2026-09-11-stream-completion-and-error-metadata § 3).
 */
export function retryAfterSeconds(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return undefined;
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value !== "string") return undefined;
  const n = Number(value);
  if (value.trim() !== "" && Number.isFinite(n)) return n >= 0 ? n : undefined;
  const when = Date.parse(value);
  if (Number.isNaN(when)) return undefined;
  return Math.max(0, (when - Date.now()) / 1000);
}

/** The response headers a provider's request id lives in when its error body carried none, in the order they are tried. */
export const REQUEST_ID_HEADERS: readonly string[] = Object.freeze(["x-request-id", "request-id", "x-amzn-requestid", "x-amz-request-id", "x-ms-request-id"]);

/**
 * Fill HTTP diagnostics the error body did not say; never invent absent
 * fields. A valid body-derived retryAfter wins; an invalid one is dropped
 * before the header is consulted. A body request id is never replaced.
 */
export function attachErrorMetadata(error: ProviderError, resp: HttpResponse): ProviderError {
  const mutable = error as { retryAfter: number | null; requestId: string | null };
  const bodyHint = retryAfterSeconds(error.retryAfter);
  mutable.retryAfter = bodyHint ?? null;
  if (bodyHint === undefined) {
    const header = retryAfterSeconds(resp.header("retry-after"));
    if (header !== undefined) mutable.retryAfter = header;
  }
  if (error.requestId === null || error.requestId === undefined || error.requestId === "") {
    for (const name of REQUEST_ID_HEADERS) {
      const value = resp.header(name);
      if (value) {
        mutable.requestId = value;
        break;
      }
    }
  }
  return error;
}

/** Wrap a decoded batch entry body for the frozen parse path. */
export function batchEntryHttp(body: JsonObject, status = 200): HttpResponse {
  return new HttpResponse({ status, body: jsonBytes(body) });
}
