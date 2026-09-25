/**
 * The conversation, over lm15. One `OpenAIChatLM` bound to OpenRouter's
 * access policy (its URL, bearer auth, and the two attribution headers
 * OpenRouter asks apps to send), holding the turns. Everything a page
 * shows — the model list, the request that would go on the wire, the
 * streamed reply, the usage, the error — comes from here, typed.
 *
 * Not here, on purpose: retries, a tool loop, history persistence. Those
 * are an application's decisions; this example makes none of them.
 */

import {
  LM15Error,
  Message,
  OpenAIChatLM,
  ProviderError,
  ResponseStream,
  TransportError,
  access,
  utf8Decode,
  type ModelInfo,
  type Request,
  type Response,
} from "@lm15/lm15/browser";

export interface ChatOptions {
  readonly key: string;
  /** Overrides OpenRouter's URL: a test double, a proxy. */
  readonly baseUrl?: string | undefined;
  /** OpenRouter's app attribution (`HTTP-Referer`, `X-Title`): where the requests come from. */
  readonly referer: string;
  readonly title: string;
}

/** One request as a page can show it before it is sent: the URL, the headers with the credential redacted, the body. */
export interface WirePreview {
  readonly method: string;
  readonly url: string;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly body: unknown;
}

export class Chat {
  readonly lm: OpenAIChatLM;
  readonly #messages: Message[] = [];

  constructor(opts: ChatOptions) {
    this.lm = new OpenAIChatLM({
      apiKey: opts.key,
      access: access.withHeaders(access.OPENROUTER, { "HTTP-Referer": opts.referer, "X-Title": opts.title }),
      ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    });
  }

  get messages(): readonly Message[] {
    return this.#messages;
  }

  /** The models this key can use, as OpenRouter lists them. */
  async models(): Promise<ModelInfo[]> {
    return this.lm.listModels();
  }

  request(model: string, text: string, maxTokens: number): Request {
    return { model, messages: [...this.#messages, Message.user(text)], config: { maxTokens } };
  }

  /** What `send` would put on the wire, credential redacted. Builds; does not send. */
  async preview(request: Request): Promise<WirePreview> {
    const built = await this.lm.buildRequest(request, true);
    const headers = built.headers.map(([k, v]) => [k, k.toLowerCase() === "authorization" ? "Bearer [redacted]" : v] as const);
    return { method: built.method, url: built.url, headers, body: JSON.parse(utf8Decode(built.body)) as unknown };
  }

  /** Start a streamed turn. Nothing joins the transcript until `commit`: a cancelled or failed turn leaves it as it was. */
  send(request: Request, signal: AbortSignal): ResponseStream {
    return new ResponseStream(this.lm.stream(request, { signal }), request);
  }

  /** A finished turn: the user's text and the assistant's reply, in order. Not called for a cancelled or failed turn. */
  commit(request: Request, response: Response): void {
    const user = request.messages[request.messages.length - 1]!;
    this.#messages.push(user, response.message);
  }
}

/** The user pressed Stop: the abort surfaces as a TransportError whose cause is the AbortSignal's reason. */
export function isCancellation(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted && error instanceof TransportError;
}

/** One line a person can act on, from a typed lm15 error; never the key, never a raw body. */
export function describeError(error: unknown): string {
  if (error instanceof ProviderError) {
    const where = [error.status ? `HTTP ${error.status}` : "", error.requestId ? `request ${error.requestId}` : ""].filter(Boolean).join(", ");
    const retry = error.retryAfter != null ? ` Retry after ${error.retryAfter}s.` : "";
    return `${error.name}: ${error.message}${where ? ` (${where})` : ""}.${retry}`;
  }
  if (error instanceof LM15Error) return `${error.name}: ${error.message}`;
  return `Unexpected: ${String(error)}`;
}
