/**
 * `ProviderLM`: the shared adapter base. A dialect (the subclass) bound to
 * an access policy (a value, AUTH-10). The subclass owns the pure codec —
 * payload, parse, stream events, error shape, the surface hooks — and this
 * class owns everything around it: credential resolution (AUTH-2), the host
 * rewrites and signing, the transport, the MAP-3 coalescer, and the drivers
 * for every surface (`complete`, `stream`, `listModels`, files, batches,
 * caches, generation, video).
 */

import { AdaptationScope, checkPolicy, collecting, hasClientSideStop, type Adaptation, type AdaptationPolicy } from "./adaptation.ts";
import { abortable, checkAborted } from "./async.ts";
import type { LiveSession, LiveSessionOptions } from "./live.ts";
import { BatchJob, VideoJob } from "./jobs.ts";
import { authHeader, isCloudChain, selectScheme, supportsEndpoint, type AccessPolicy } from "./auth/policy.ts";
import { endpointFromEnv, finishRequest, renderBaseUrl, resolveSettings, signRequest, utcNow, type Clock } from "./cloud/hosts.ts";
import { AuthError, LM15Error, NotConfiguredError, ProviderError, TransportError, UnsupportedFeatureError, malformedJsonError, mapHttpError, withCredentialHint } from "./errors.ts";
import { isJsonObject, parseJson, type JsonObject } from "./json.ts";
import { getDefaultPlatform, noCloudChain, noStoredCredentials, type Env, type LoadedCredential } from "./platform.ts";
import { namedMeaning, validateNamedCredential } from "./cloud/identity.ts";
import { lookup } from "./registry.ts";
import { applyClientSideStop, truncateStreamAtStopAsync } from "./stop.ts";
import { coalesceStreamAsync, materializeResponseAsync, parseSseAsync, splitLinesAsync, type SSEEvent } from "./stream.ts";
import { bufferResponse, getDefaultTransport, type Transport } from "./transport.ts";
import { AwsCredentials, CredentialSource, coerceCredential, type CredentialLike, type CredentialValue, type NamedCredential, type SourcedCredentialProvider } from "./types/credential.ts";
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
import { ErrorDetail, type Response } from "./types/response.ts";
import { captureRateLimits, millisecondsSeconds, type RateLimitHeaders } from "./rate_limits.ts";
import type { StreamEvent } from "./types/stream.ts";
import { ValueError } from "./types/validate.ts";
import { BATCH_TERMINAL_STATUSES, VIDEO_TERMINAL_STATUSES } from "./vocab.ts";
import { HttpResponse, jsonBytes, makeJsonRequest, type TransportRequest } from "./wire.ts";

export interface LMOptions {
  /** A string, an AUTH-2 credential value, or a zero-arg (possibly async) provider. */
  readonly apiKey?: CredentialLike;
  /** One cloud identity only; mutually exclusive with apiKey. */
  readonly credential?: NamedCredential;
  /** Router-selected provenance, without credential material. */
  readonly credentialOrigin?: string | CredentialSource;
  /** Explicit host environment; an empty map keeps construction host-independent. */
  readonly env?: Env;
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
  /** MAP-13: `"note"` (default: adapt and record), `"silent"` (adapt, record nothing), `"refuse"` (every deviation refuses before the wire). */
  readonly adaptations?: AdaptationPolicy;
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

/** A built wire request with the MAP-13 record of what differs from what was asked. */
export interface BuiltRequest {
  readonly request: TransportRequest;
  readonly adaptations: readonly Adaptation[];
}

/**
 * AUTH-1: an explicit credential always wins; a stored-login policy asks the
 * host platform (AUTH-8). A host without stores refuses by name; a `key`
 * policy with nothing given refuses naming the env keys.
 */
export function loadCredential(policy: AccessPolicy, apiKey: CredentialLike | undefined, credentialsPath?: string): LoadedCredential {
  if (apiKey !== undefined) {
    if (apiKey === "") throw new NotConfiguredError(`${policy.provider}: explicit apiKey is empty; ambient credentials will not be tried`, { provider: policy.provider });
    return { credential: apiKey, source: "explicit" };
  }
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
  /** MAP-13 policy for every request this LM builds. */
  readonly adaptations: AdaptationPolicy;
  protected credential: CredentialLike | undefined;
  protected credentialSource: "explicit" | "stored" = "explicit";
  private origin: string | CredentialSource | undefined;
  private readonly requestOrigins = new WeakMap<TransportRequest, string>();

  protected constructor(manifest: AccessPolicy, dialectBaseUrl: string, opts: LMOptions) {
    const policy = opts.access ?? manifest;
    validateNamedCredential(policy, opts.credential, opts.apiKey !== undefined);
    this.access = policy;
    this.provider = policy.provider;
    this.adaptations = checkPolicy(opts.adaptations ?? "note");
    this.transport = opts.transport ?? getDefaultTransport();
    this.clock = opts.clock;
    this.accountId = opts.accountId;
    this.baseUrl = opts.baseUrl ?? dialectBaseUrl;
    this.origin = opts.credentialOrigin;
    const platform = getDefaultPlatform();
    // An explicit empty environment makes planning host-independent. Direct
    // cloud clients still honor endpoint/region environment with explicit keys.
    const needsChain = isCloudChain(policy) && opts.apiKey === undefined;
    const env = opts.env ?? (policy.host ? platform.env() : undefined);
    const values: Record<string, string> = {};
    for (const [k, v] of Object.entries(env ?? {})) if (v !== undefined) values[k] = v;
    const endpoint = policy.host ? opts.baseUrl ?? endpointFromEnv(policy.host, env) : undefined;
    const chain = needsChain ? platform.openCloudChain?.({ env: values, online: true }) : undefined;
    if (needsChain && !chain) throw noCloudChain(platform, policy, opts.credential);
    const profile = chain?.profile(policy);
    this.hostSettings = resolveSettings(policy.host, opts.settings, values, { provider: policy.provider, endpoint, ...(profile ? { profile } : {}) });
    if (chain) {
      chain.settings = this.hostSettings;
      this.credential = chain.credentialProvider(policy, opts.credential);
    } else {
      const loaded = loadCredential(policy, opts.apiKey, opts.credentialsPath);
      this.credential = loaded.credential;
      this.credentialSource = loaded.source;
      if (loaded.accountId !== undefined && this.accountId === undefined) this.accountId = loaded.accountId;
      if (loaded.credential !== undefined && typeof loaded.credential !== "function") {
        selectScheme(policy, coerceCredential(loaded.credential));
      }
    }
    if (policy.host) this.baseUrl = renderBaseUrl(policy.host, this.hostSettings, endpoint, policy.provider);
    else if (policy.baseUrl !== undefined && this.baseUrl === dialectBaseUrl) this.baseUrl = policy.baseUrl;
  }

  get supports() {
    return this.access.supports;
  }

  /** The compat preset the bound provider names in the registry (a bound policy with no `compat`). */
  protected registryCompat(): string | undefined {
    if (this.access === (this.constructor as typeof ProviderLM).manifest) return undefined;
    const compat = lookup(this.access.provider)?.compat;
    return typeof compat === "string" ? compat : undefined;
  }

  protected now(): Date {
    return this.clock ? this.clock() : utcNow();
  }

  protected base(): string {
    return this.baseUrl.replace(/\/+$/, "");
  }

  /** Router-selected env/shared-key origin; does not inspect the identity inside a callable. */
  setCredentialOrigin(origin: string | CredentialSource): void { this.origin = origin; }

  /** AUTH-1: where the last credential came from, without acquiring one. */
  credentialOrigin(): string {
    const provider = this.credential;
    if (typeof provider === "function" && "source" in provider && "named" in provider) {
      const sourced = provider as SourcedCredentialProvider;
      if (sourced.source) return sourced.source.describe(this.now());
      return sourced.named ? `named credential "${sourced.named}" (${namedMeaning(this.access, sourced.named)}; not yet resolved)` : `the ${this.access.credentialPolicy} (not yet resolved)`;
    }
    if (this.credentialSource === "stored") return `stored login for ${this.provider}`;
    if (typeof provider === "function") return "an application-supplied callable (identity not inspected by lm15)";
    if (this.origin instanceof CredentialSource) return this.origin.describe(this.now());
    return this.origin ?? "an explicit api_key";
  }

  /** Resolve the credential provider (AUTH-2: once per request, never cached here). */
  protected async resolveCredential(): Promise<CredentialValue | undefined> {
    if (this.credential === undefined) return undefined;
    const raw = typeof this.credential === "function" ? await this.credential() : this.credential;
    return coerceCredential(raw);
  }

  /** Finish a dialect-built request through the bound host (AUTH-10) and sign it. */
  protected async emit(opts: EmitOptions, { planning = false }: { planning?: boolean } = {}): Promise<TransportRequest> {
    // plan() builds and discards: no credential provider is invoked, no
    // header is signed — the record of adaptations does not depend on it.
    const credential = planning ? undefined : await this.resolveCredential();
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
    const origin = planning ? undefined : this.credentialOrigin();
    if (credential instanceof AwsCredentials) {
      const signed = await signRequest(this.access, this.hostSettings, {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: req.body,
        credential,
        now: this.now(),
      });
      req = { ...req, headers: signed };
    }
    if (origin !== undefined) this.requestOrigins.set(req, origin);
    return req;
  }

  /** Raise unless the bound access path carries `surface`. */
  protected require(surface: string): void {
    if (!supportsEndpoint(this.access.supports, surface)) {
      throw new UnsupportedFeatureError(`${this.provider}: ${SURFACE_WORD[surface] ?? surface} not supported`, { provider: this.provider });
    }
  }

  // ─── The codec every dialect implements ────────────────────────────

  /**
   * The wire request before the host finishes it: method, URL, headers,
   * payload. SYNCHRONOUS by design — it runs inside the MAP-13 adaptation
   * scope, and `adapt()` inside it records to that scope (see
   * `adaptation.ts`).
   */
  /** Normalize only this binding's prefix, once per codec boundary.
   * Drivers retain the original request so a nested colon ID is not stripped twice.
   */
  protected wireModelRequest(request: Request): Request {
    request = normalizeRequest(request);
    const colon = request.model.indexOf(":");
    if (colon > 0 && colon < request.model.length - 1 && request.model.slice(0, colon).replace(/_/g, "-") === this.provider.replace(/_/g, "-")) {
      return normalizeRequest({ ...request, model: request.model.slice(colon + 1) });
    }
    return request;
  }

  abstract wireRequest(request: Request, stream: boolean): EmitOptions;
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
    error = this.withCredentialOrigin(error);
    const hint = this.access.loginHint;
    if (hint && (this.access.credentialPolicy === "oauth" || this.credentialSource === "stored")) return withCredentialHint(error, hint);
    return error;
  }

  /** Insert once, before guidance; request snapshots keep concurrent resolutions distinct. */
  protected withCredentialOrigin(error: ProviderError, request?: TransportRequest): ProviderError {
    if (!(error instanceof AuthError)) return error;
    const origin = (request && this.requestOrigins.get(request)) || this.credentialOrigin();
    error.message = credentialOriginMessage(error.message, origin);
    return error;
  }

  // ─── MAP-13: build with adaptations, plan, client-side steps ───────

  /**
   * `wireRequest` inside an adaptation scope, finished by `emit`: the wire
   * request and the record of what differs from what was asked. The one
   * place a scope is opened; builders record through `adapt()`.
   */
  async build(request: Request, stream: boolean, opts: { policy?: AdaptationPolicy; planning?: boolean } = {}): Promise<BuiltRequest> {
    request = normalizeRequest(request);
    const scope = new AdaptationScope(checkPolicy(opts.policy ?? this.adaptations), this.provider, opts.planning ?? false);
    const wire = collecting(scope, () => this.wireRequest(request, stream));
    return { request: await this.emit(wire, { planning: scope.planning }), adaptations: Object.freeze([...scope.records]) };
  }

  /** The finished wire request (params decoded by the host, headers signed). */
  async buildRequest(request: Request, stream: boolean): Promise<TransportRequest> {
    return (await this.build(request, stream)).request;
  }

  /**
   * What a call with this request WOULD adapt, with no network and no
   * credential invoked (offline, like `resolveModel`). Throws what the call
   * would throw (a refusal under any policy, or every deviation under
   * `"refuse"`). Returns the full record under every policy, `"silent"`
   * included: a preview that hid what it saw would be no preview.
   */
  async plan(request: Request, opts: { policy?: AdaptationPolicy } = {}): Promise<readonly Adaptation[]> {
    return (await this.build(request, false, { ...(opts.policy !== undefined ? { policy: opts.policy } : {}), planning: true })).adaptations;
  }

  /** What the response carries: everything under "note" (and "refuse"), nothing under "silent". Behaviour is decided from the full record, never from this. */
  protected visible(adaptations: readonly Adaptation[]): readonly Adaptation[] {
    return this.adaptations === "silent" ? [] : adaptations;
  }

  /** Stamp the visible record on the response and apply client-side steps. */
  protected finishResponse(request: Request, response: Response, adaptations: readonly Adaptation[]): Response {
    if (hasClientSideStop(adaptations)) response = applyClientSideStop(response, request.config?.stop);
    const visible = this.visible(adaptations);
    if (visible.length > 0 && response.adaptations.length === 0) response = response.with({ adaptations: visible });
    return response;
  }

  // ─── Drivers: complete / stream ────────────────────────────────────

  async complete(request: Request, opts: { signal?: AbortSignal } = {}): Promise<Response> {
    checkAborted(opts.signal);
    request = normalizeRequest(request);
    const building = this.build(request, false);
    const built = await (opts.signal ? abortable(building, opts.signal) : building);
    if (hasClientSideStop(built.adaptations)) {
      // A stop sequence the wire cannot take is honoured by streaming under
      // the hood and closing the connection at the cut (stop.ts). A stream
      // that never hits the sequence completes normally, usage included.
      return materializeResponseAsync(this.stream(request, opts), request);
    }
    const resp = await this.send(built.request, opts.signal);
    if (resp.status >= 400) throw attachErrorMetadata(this.withCredentialOrigin(this.normalizeError(resp.status, resp.text()), built.request), resp);
    try {
      return this.finishResponse(request, this.parseResponse(request, resp), built.adaptations);
    } catch (error) {
      if (error instanceof ProviderError) {
        (error as { provider: string | null }).provider ??= this.provider;
        throw attachErrorMetadata(this.withCredentialOrigin(error, built.request), resp);
      }
      throw error;
    }
  }

  /** The canonical event stream: exactly one `start`, deltas, exactly one final `end` (MAP-3/4). */
  stream(request: Request, opts: { signal?: AbortSignal } = {}): AsyncIterable<StreamEvent> {
    return this.streamWithRecord(request, opts.signal);
  }

  private async *streamWithRecord(request: Request, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    checkAborted(signal);
    request = normalizeRequest(request);
    const building = this.build(request, true);
    const built = await (signal ? abortable(building, signal) : building);
    let events: AsyncIterable<StreamEvent> = coalesceStreamAsync(this.streamRaw(request, built.request, signal), {
      model: this.wireModelRequest(request).model,
      adaptations: this.visible(built.adaptations),
    });
    if (hasClientSideStop(built.adaptations)) events = truncateStreamAtStopAsync(events, request.config?.stop);
    yield* events;
  }

  protected async *streamRaw(request: Request, req: TransportRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    let res;
    try {
      res = await this.transport.send(req, { signal });
    } catch (e) {
      throw wrapTransport(e);
    }
    if (res.status >= 400) {
      const buffered = await bufferResponse(res);
      throw attachErrorMetadata(this.withCredentialOrigin(this.normalizeError(buffered.status, buffered.text()), req), buffered);
    }
    const handshake = new HttpResponse({ status: res.status, headers: res.headers, body: new Uint8Array() });
    try {
      for await (const sse of parseSseAsync(splitLinesAsync(res.chunks()))) {
        let events: StreamEvent[];
        try { events = this.parseStreamEvents(request, sse); }
        catch (cause) {
          if (!(cause instanceof SyntaxError)) throw cause;
          const excerpt = new TextDecoder().decode(new TextEncoder().encode(sse.data).subarray(0, 200));
          // The handshake succeeded; do not label an in-stream fault HTTP 200.
          throw new ProviderError(`SSE event data is not valid JSON (first 200 bytes: ${JSON.stringify(excerpt)})`, {
            provider: this.provider, contentType: handshake.header("content-type"), bodyExcerpt: excerpt, cause,
          });
        }
        for (let event of events) {
          if (event.type === "error" && event.error.code === "auth") {
            const origin = this.requestOrigins.get(req) ?? this.credentialOrigin();
            event = { ...event, error: ErrorDetail.create({ ...event.error, message: credentialOriginMessage(event.error.message, origin) }) };
          }
          yield streamErrorMetadata(event, handshake);
        }
      }
    } catch (error) {
      if (error instanceof ProviderError) throw attachErrorMetadata(error, handshake);
      throw error;
    }
  }

  protected async send(request: TransportRequest, signal?: AbortSignal): Promise<HttpResponse> {
    try {
      return await bufferResponse(await this.transport.send(request, { signal }));
    } catch (e) {
      throw wrapTransport(e);
    }
  }

  protected async sendOk(request: TransportRequest, signal?: AbortSignal): Promise<HttpResponse> {
    const resp = await this.send(request, signal);
    if (resp.status >= 400) throw attachErrorMetadata(this.withCredentialOrigin(this.normalizeError(resp.status, resp.text()), request), resp);
    return resp;
  }

  /** Parse JSON auxiliary replies with the same fault/diagnostic boundary as chat. */
  protected parseReply<T>(response: HttpResponse, parse: (response: HttpResponse) => T, json = true): T {
    try {
      if (json) response.json();
      return parse(response);
    } catch (cause) {
      const error = cause instanceof SyntaxError ? malformedJsonError(response, cause, this.provider) : cause;
      if (error instanceof ProviderError) {
        const context = error as { provider: string | null; status: number | null };
        context.provider ??= this.provider;
        if (error.code === "provider") context.status ??= response.status;
        throw attachErrorMetadata(this.withLoginHint(error), response);
      }
      throw error;
    }
  }

  protected async sendParsed<T>(request: TransportRequest, parse: (response: HttpResponse) => T, json = true, signal?: AbortSignal): Promise<T> {
    return this.parseReply(await this.sendOk(request, signal), parse, json);
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
    return this.sendParsed(await this.modelsRequest(), resp => this.modelsFromBody(resp.text()));
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
    return this.sendParsed(await this.fileUploadRequest(request), resp => this.fileInfoFromBody(resp.text()));
  }
  async fileGet(fileId: string): Promise<FileInfo> {
    this.require("files");
    return this.sendParsed(await this.fileGetRequest(fileId), resp => this.fileInfoFromBody(resp.text()));
  }
  async fileList(limit = 20, cursor?: string): Promise<FilePage> {
    this.require("files");
    return this.sendParsed(await this.fileListRequest(limit, cursor), resp => this.filePageFromListBody(resp.text()));
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
  /** Plan all items before credentials or paid work; direct hooks use this too. */
  protected batchPreflight(request: BatchRequest): void {
    for (const nested of request.requests) {
      const normalized = normalizeRequest(nested);
      const scope = new AdaptationScope("note", this.provider, true);
      collecting(scope, () => this.wireRequest(normalized, false));
      if (hasClientSideStop(scope.records)) {
        throw new UnsupportedFeatureError(`${this.provider}: batch cannot close the generation source at a client-side stop cut; use a dialect with native stop support or individual complete()/stream() calls`, { provider: this.provider, feature: "config.stop" });
      }
      if (this.adaptations === "refuse") {
        collecting(new AdaptationScope("refuse", this.provider, true), () => this.wireRequest(normalized, false));
      }
    }
  }
  /** Optional pre-submit upload step (OpenAI's JSONL file); `undefined` = single-step. */
  batchUploadRequest(request: BatchRequest): Promise<TransportRequest | undefined> {
    this.batchPreflight(request);
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
    this.batchPreflight(request);
    let uploadBody: JsonObject | undefined;
    const upload = await this.batchUploadRequest(request);
    if (upload) {
      const body = await this.sendParsed(upload, resp => resp.json());
      uploadBody = isJsonObject(body) ? body : undefined;
    }
    return this.sendParsed(await this.batchSubmitRequest(request, uploadBody), resp => this.batchJobFromBody(resp.text()));
  }
  async batchStatus(batchId: string): Promise<BatchJobInfo> {
    this.require("batches");
    return this.sendParsed(await this.batchStatusRequest(batchId), resp => this.batchJobFromBody(resp.text()));
  }
  /** Entries in submission order; throws while the job runs. */
  async batchResults(batchId: string): Promise<BatchEntry[]> {
    this.require("batches");
    const resp = await this.sendOk(await this.batchStatusRequest(batchId));
    const job = this.parseReply(resp, reply => this.batchJobFromBody(reply.text()));
    if (!(BATCH_TERMINAL_STATUSES as readonly string[]).includes(job.status)) {
      throw new ValueError(`batch ${batchId} is not finished (status=${JSON.stringify(job.status)}); poll batchStatus() until done`);
    }
    const statusBody = resp.json() as JsonObject;
    const texts: string[] = [];
    for (const fetch of await this.batchResultFetches(statusBody)) {
      texts.push(await this.sendParsed(fetch, reply => {
        const text = reply.text();
        for (const line of text.split(/\r?\n/)) if (line.trim()) parseJson(line);
        return text;
      }, false));
    }
    return this.parseReply(resp, () => this.batchEntries(statusBody, texts), false);
  }
  async batchCancel(batchId: string): Promise<BatchJobInfo> {
    this.require("batches");
    return this.sendParsed(await this.batchCancelRequest(batchId), resp => this.batchJobFromBody(resp.text()));
  }
  async batchList(limit = 20): Promise<BatchJobInfo[]> {
    this.require("batches");
    return this.sendParsed(await this.batchListRequest(limit), resp => this.batchJobsFromListBody(resp.text()));
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
    return this.sendParsed(await this.cacheCreateRequest(prefix, opts.ttlSeconds, opts.label), resp => this.cacheInfoFromBody(resp.text()));
  }
  async cacheGet(cacheId: string): Promise<CacheInfo> {
    this.require("caches");
    return this.sendParsed(await this.cacheGetRequest(cacheId), resp => this.cacheInfoFromBody(resp.text()));
  }
  async cacheList(limit = 20, cursor?: string): Promise<CachePage> {
    this.require("caches");
    return this.sendParsed(await this.cacheListRequest(limit, cursor), resp => this.cachePageFromListBody(resp.text()));
  }
  async cacheDelete(cacheId: string): Promise<void> {
    this.require("caches");
    await this.sendOk(await this.cacheDeleteRequest(cacheId));
  }
  async cacheUpdate(cacheId: string, ttlSeconds: number): Promise<CacheInfo> {
    this.require("caches");
    if (typeof ttlSeconds !== "number" || !Number.isInteger(ttlSeconds) || ttlSeconds <= 0) throw new ValueError("ttl_seconds must be a positive int");
    return this.sendParsed(await this.cacheUpdateRequest(cacheId, ttlSeconds), resp => this.cacheInfoFromBody(resp.text()));
  }
  /** Make a prompt beginning reusable with the best tier this provider has. */
  async cache(prefix: Request, opts: { ttlSeconds?: number; label?: string } = {}): Promise<CachedPrefixValue> {
    const wire = this.wireModelRequest(prefix);
    const provider = wire.model !== prefix.model ? this.provider : undefined;
    if (this.supports.caches) return CachedPrefix.create({ prefix: wire, resource: await this.cacheCreate(wire, opts), provider });
    ProviderLM.checkCachePrefix(wire, opts.ttlSeconds);
    return CachedPrefix.create({ prefix: wire, provider });
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
    return this.sendParsed(await this.imageGenerateRequest(request), resp => this.imageGenerationFromResponse(request, resp), false);
  }
  async speechGenerate(request: SpeechGenerationRequest): Promise<SpeechGenerationResponse> {
    this.require("speech");
    request = normalizeSpeechGenerationRequest(request);
    return this.sendParsed(await this.speechGenerateRequest(request), resp => this.speechGenerationFromResponse(request, resp), false);
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
    return this.sendParsed(await this.videoSubmitRequest(request), resp => this.videoJobFromBody(resp.text()));
  }
  async videoStatus(videoId: string): Promise<VideoJobInfo> {
    this.require("video");
    return this.sendParsed(await this.videoStatusRequest(videoId), resp => this.videoJobFromBody(resp.text(), videoId));
  }
  async videoResult(videoId: string): Promise<VideoPart> {
    this.require("video");
    const resp = await this.sendOk(await this.videoStatusRequest(videoId));
    const job = this.parseReply(resp, reply => this.videoJobFromBody(reply.text(), videoId));
    if (!(VIDEO_TERMINAL_STATUSES as readonly string[]).includes(job.status)) {
      throw new ValueError(`video ${videoId} is not finished (status=${JSON.stringify(job.status)}); poll videoStatus() until done`);
    }
    const statusBody = resp.json() as JsonObject;
    const fetch = await this.videoResultFetch(statusBody);
    const fetched = fetch ? await this.sendOk(fetch) : undefined;
    return this.parseReply(fetched ?? resp, () => this.videoPart(statusBody, fetched), false);
  }
  async videoList(limit = 20, model?: string): Promise<VideoJobInfo[]> {
    this.require("video");
    return this.sendParsed(await this.videoListRequest(limit, model), resp => this.videoJobsFromListBody(resp.text()));
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

function credentialOriginMessage(message: string, origin: string): string {
  const marker = "\nCredential came from: ";
  const guidanceAt = message.indexOf("\n\n  To fix:");
  const base = guidanceAt < 0 ? message : message.slice(0, guidanceAt);
  const guidance = guidanceAt < 0 ? "" : message.slice(guidanceAt);
  const prior = base.indexOf(marker);
  return (prior < 0 ? base : base.slice(0, prior)) + marker + origin + guidance;
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
export const REQUEST_ID_HEADERS: readonly string[] = Object.freeze(["x-request-id", "request-id", "x-amzn-requestid", "x-amz-request-id", "x-ms-request-id", "apim-request-id", "x-typesafe-request-id"]);

/**
 * Fill HTTP diagnostics the error body did not say; never invent absent
 * fields. A valid body-derived retryAfter wins; an invalid one is dropped
 * before the header is consulted. A body request id is never replaced.
 */
export function attachErrorMetadata(error: ProviderError, resp: HttpResponse): ProviderError {
  const mutable = error as { retryAfter: number | null; requestId: string | null; rateLimitHeaders: RateLimitHeaders };
  mutable.rateLimitHeaders = captureRateLimits(resp.headers);
  const bodyHint = retryAfterSeconds(error.retryAfter);
  mutable.retryAfter = bodyHint ?? null;
  if (bodyHint === undefined) {
    const header = retryAfterSeconds(resp.header("retry-after"));
    if (header !== undefined) mutable.retryAfter = header;
    else {
      for (const name of ["retry-after-ms", "x-ms-retry-after-ms"]) {
        const seconds = millisecondsSeconds(resp.header(name));
        if (seconds !== undefined) { mutable.retryAfter = seconds; break; }
      }
    }
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

function streamErrorMetadata(event: StreamEvent, response: HttpResponse): StreamEvent {
  if (event.type !== "error") return event;
  const error = attachErrorMetadata(new ProviderError(), response);
  const http: JsonObject = {};
  if (error.requestId !== null) http["request_id"] = error.requestId;
  if (error.retryAfter !== null) http["retry_after"] = error.retryAfter;
  if (Object.keys(error.rateLimitHeaders).length)
    http["rate_limit_headers"] = Object.fromEntries(Object.entries(error.rateLimitHeaders).map(([k, v]) => [k, [...v]]));
  if (!Object.keys(http).length) return event;
  return { ...event, error: ErrorDetail.create({ ...event.error, httpResponse: http }) };
}

/** Wrap a decoded batch entry body for the frozen parse path. */
export function batchEntryHttp(body: JsonObject, status = 200): HttpResponse {
  return new HttpResponse({ status, body: jsonBytes(body) });
}
