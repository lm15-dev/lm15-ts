/**
 * Model — reusable stateful object with history and conversation memory.
 */

import { resolveProvider } from "./capabilities.js";
import type { UniversalLM } from "./client.js";
import { Result, type StartStreamFn, type OnFinishedFn } from "./result.js";
import type {
  Config, JsonObject, LMRequest, LMResponse, Message,
  Part, Tool, ToolCallInfo, ToolCallPart, Usage,
} from "./types.js";
import { Part as PartFactory, EMPTY_USAGE } from "./types.js";

type ToolInput = Tool | ((...args: unknown[]) => unknown) | string;

export interface HistoryEntry {
  readonly request: LMRequest;
  readonly response: LMResponse;
}

export interface ModelOpts {
  lm: UniversalLM;
  model: string;
  system?: string;
  tools?: ToolInput[];
  onToolCall?: (info: ToolCallInfo) => unknown;
  provider?: string;
  retries?: number;
  cache?: boolean;
  promptCaching?: boolean;
  temperature?: number;
  maxTokens?: number;
  maxToolRounds?: number;
}

export interface CallOpts {
  messages?: Message[];
  system?: string;
  tools?: ToolInput[];
  onToolCall?: (info: ToolCallInfo) => unknown;
  reasoning?: boolean | JsonObject;
  prefill?: string;
  output?: string;
  promptCaching?: boolean;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stop?: string[];
  maxToolRounds?: number;
  provider?: string;
}

/** Infer a FunctionTool from a plain function. */
function callableToTool(fn: (...args: unknown[]) => unknown): Tool {
  return {
    type: "function",
    name: fn.name || "tool",
    description: undefined,
    parameters: { type: "object", properties: {} },
    fn,
  };
}

function normalizeTools(tools: ToolInput[]): { defs: Tool[]; registry: Record<string, (...args: unknown[]) => unknown> } {
  const defs: Tool[] = [];
  const registry: Record<string, (...args: unknown[]) => unknown> = {};
  for (const t of tools) {
    if (typeof t === "object" && "type" in t) {
      defs.push(t as Tool);
      if (t.type === "function" && typeof (t as { fn?: unknown }).fn === "function") {
        registry[t.name] = (t as { fn: (...args: unknown[]) => unknown }).fn;
      }
    } else if (typeof t === "string") {
      defs.push({ type: "builtin", name: t });
    } else if (typeof t === "function") {
      const tool = callableToTool(t);
      defs.push(tool);
      registry[tool.name] = t;
    }
  }
  return { defs, registry };
}

export class Model {
  private _lm: UniversalLM;
  model: string;
  system?: string;
  provider?: string;
  retries: number;
  promptCaching: boolean;
  temperature?: number;
  maxTokens?: number;
  maxToolRounds: number;
  onToolCall?: (info: ToolCallInfo) => unknown;
  private _boundTools: ToolInput[];
  private _conversation: Message[] = [];
  private _localCache: Map<string, LMResponse> | undefined;
  private _pendingToolCalls: ToolCallPart[] = [];
  history: HistoryEntry[] = [];

  constructor(opts: ModelOpts) {
    this._lm = opts.lm;
    this.model = opts.model;
    this.system = opts.system;
    this.provider = opts.provider;
    this.retries = opts.retries ?? 0;
    this.promptCaching = opts.promptCaching ?? false;
    this.temperature = opts.temperature;
    this.maxTokens = opts.maxTokens;
    this.maxToolRounds = opts.maxToolRounds ?? 8;
    this.onToolCall = opts.onToolCall;
    this._boundTools = [...(opts.tools ?? [])];
    this._localCache = opts.cache ? new Map() : undefined;
  }

  /** Create a copy with optional overrides. */
  copy(overrides?: Partial<ModelOpts> & { history?: boolean }): Model {
    const keepHistory = overrides?.history !== false;
    const m = new Model({
      lm: this._lm,
      model: overrides?.model ?? this.model,
      system: overrides?.system !== undefined ? overrides.system : this.system,
      tools: overrides?.tools ?? [...this._boundTools],
      onToolCall: overrides?.onToolCall !== undefined ? overrides.onToolCall : this.onToolCall,
      provider: overrides?.provider !== undefined ? overrides.provider : this.provider,
      retries: overrides?.retries ?? this.retries,
      cache: !!this._localCache,
      promptCaching: overrides?.promptCaching ?? this.promptCaching,
      temperature: overrides?.temperature !== undefined ? overrides.temperature : this.temperature,
      maxTokens: overrides?.maxTokens !== undefined ? overrides.maxTokens : this.maxTokens,
      maxToolRounds: overrides?.maxToolRounds ?? this.maxToolRounds,
    });
    if (keepHistory) {
      m._conversation = [...this._conversation];
      m.history = [...this.history];
      m._pendingToolCalls = [...this._pendingToolCalls];
    }
    return m;
  }

  clearHistory(): void {
    this.history = [];
    this._conversation = [];
    this._pendingToolCalls = [];
  }

  /** Build an LMRequest without sending it. */
  prepare(
    prompt?: string | (string | Part)[],
    opts?: CallOpts,
  ): LMRequest {
    const { request } = this._buildRequest(prompt, opts);
    return request;
  }

  /** Call the model. Returns a Result (streamable, awaitable). */
  call(
    prompt?: string | (string | Part)[],
    opts?: CallOpts,
  ): Result {
    const { request, callableRegistry, updateConversation } = this._buildRequest(prompt, opts);
    const resolvedProvider = opts?.provider ?? this.provider;

    const startStream: StartStreamFn = (req) => {
      const cached = this._cacheGet(req, resolvedProvider);
      if (cached) return responseToAsyncEvents(cached);
      return this._lm.stream(req, resolvedProvider);
    };

    const onFinished: OnFinishedFn = (finalRequest, resp) => {
      this._cacheSet(finalRequest, resp, resolvedProvider);
      this.history.push({ request: finalRequest, response: resp });
      this._pendingToolCalls = resp.message.parts.filter(
        (p): p is ToolCallPart => p.type === "tool_call",
      );
      if (updateConversation) {
        this._conversation = [...finalRequest.messages, resp.message];
      }
    };

    return new Result({
      request,
      startStream,
      onFinished,
      callableRegistry,
      onToolCall: opts?.onToolCall ?? this.onToolCall,
      maxToolRounds: opts?.maxToolRounds ?? this.maxToolRounds,
      retries: this.retries,
    });
  }

  /** Submit tool results back to the model. */
  submitTools(results: Record<string, unknown>, opts?: { provider?: string }): Result {
    if (!this._pendingToolCalls.length) {
      throw new Error("no pending tool calls");
    }

    const parts: Part[] = [];
    for (const tc of this._pendingToolCalls) {
      if (!tc.id || !(tc.id in results)) continue;
      const out = results[tc.id];
      const content = typeof out === "string" ? [PartFactory.text(out)] : [PartFactory.text(String(out))];
      parts.push(PartFactory.toolResult(tc.id, content, { name: tc.name }));
    }

    const toolMessage: Message = { role: "tool", parts };
    const followMessages = [...this._conversation, toolMessage];

    const { defs: toolDefs, registry: callableRegistry } = normalizeTools(this._boundTools);

    const providerCfg: JsonObject = {};
    if (this.promptCaching) providerCfg.prompt_caching = true;

    const config: Config = {
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      provider: Object.keys(providerCfg).length ? providerCfg : undefined,
    };

    const request: LMRequest = {
      model: this.model,
      messages: followMessages,
      system: this.system,
      tools: toolDefs,
      config,
    };

    const resolvedProvider = opts?.provider ?? this.provider;

    const startStream: StartStreamFn = (req) => {
      const cached = this._cacheGet(req, resolvedProvider);
      if (cached) return responseToAsyncEvents(cached);
      return this._lm.stream(req, resolvedProvider);
    };

    const onFinished: OnFinishedFn = (finalRequest, resp) => {
      this._cacheSet(finalRequest, resp, resolvedProvider);
      this.history.push({ request: finalRequest, response: resp });
      this._pendingToolCalls = resp.message.parts.filter(
        (p): p is ToolCallPart => p.type === "tool_call",
      );
      this._conversation = [...finalRequest.messages, resp.message];
    };

    return new Result({
      request,
      startStream,
      onFinished,
      callableRegistry,
      onToolCall: this.onToolCall,
      maxToolRounds: this.maxToolRounds,
      retries: this.retries,
    });
  }

  // ── Private ────────────────────────────────────────────────────

  private _buildRequest(
    prompt?: string | (string | Part)[],
    opts?: CallOpts,
  ): { request: LMRequest; callableRegistry: Record<string, (...args: unknown[]) => unknown>; updateConversation: boolean } {
    const messages = opts?.messages;
    if (prompt != null && messages != null) {
      throw new Error("prompt and messages are mutually exclusive");
    }

    let updateConversation = false;
    let turnMessages: Message[];

    if (messages != null) {
      turnMessages = messages;
    } else {
      if (prompt == null) throw new Error("either prompt or messages is required");
      if (typeof prompt === "string") {
        turnMessages = [{ role: "user", parts: [PartFactory.text(prompt)] }];
      } else {
        const parts = prompt.map(item =>
          typeof item === "string" ? PartFactory.text(item) : item,
        );
        turnMessages = [{ role: "user", parts }];
      }
      if (opts?.prefill) {
        turnMessages.push({ role: "assistant", parts: [PartFactory.text(opts.prefill)] });
      }
      updateConversation = true;
    }

    const finalMessages = updateConversation
      ? [...this._conversation, ...turnMessages]
      : turnMessages;

    const toolsInput = opts?.tools ?? this._boundTools;
    const { defs: toolDefs, registry: callableRegistry } = normalizeTools(toolsInput);

    const providerCfg: JsonObject = {};
    const pc = opts?.promptCaching ?? this.promptCaching;
    if (pc) providerCfg.prompt_caching = true;
    if (opts?.output === "image") providerCfg.output = "image";
    else if (opts?.output === "audio") providerCfg.output = "audio";

    let reasoning: JsonObject | undefined;
    if (opts?.reasoning === true) {
      reasoning = { enabled: true };
    } else if (typeof opts?.reasoning === "object") {
      reasoning = { enabled: true, ...opts.reasoning };
    }

    const config: Config = {
      max_tokens: opts?.maxTokens ?? this.maxTokens,
      temperature: opts?.temperature ?? this.temperature,
      top_p: opts?.topP,
      stop: opts?.stop,
      reasoning: reasoning as Config["reasoning"],
      provider: Object.keys(providerCfg).length ? providerCfg : undefined,
    };

    const request: LMRequest = {
      model: this.model,
      messages: finalMessages,
      system: opts?.system ?? this.system,
      tools: toolDefs,
      config,
    };

    return { request, callableRegistry, updateConversation };
  }

  private _cacheKey(request: LMRequest, provider?: string): string {
    return JSON.stringify([provider ?? resolveProvider(request.model), request]);
  }

  private _cacheGet(request: LMRequest, provider?: string): LMResponse | undefined {
    return this._localCache?.get(this._cacheKey(request, provider));
  }

  private _cacheSet(request: LMRequest, response: LMResponse, provider?: string): void {
    this._localCache?.set(this._cacheKey(request, provider), response);
  }
}

// ── Helper ─────────────────────────────────────────────────────────

async function* responseToAsyncEvents(response: LMResponse): AsyncIterable<import("./types.js").StreamEvent> {
  yield { type: "start", id: response.id, model: response.model };
  for (let idx = 0; idx < response.message.parts.length; idx++) {
    const part = response.message.parts[idx];
    if ((part.type === "text" || part.type === "refusal") && "text" in part) {
      yield { type: "delta", part_index: idx, delta: { type: "text", text: part.text as string } };
    } else if (part.type === "thinking" && "text" in part) {
      yield { type: "delta", part_index: idx, delta: { type: "thinking", text: part.text as string } };
    } else if (part.type === "tool_call") {
      yield {
        type: "delta", part_index: idx,
        delta: { type: "tool_call", id: part.id, name: part.name, input: JSON.stringify(part.input ?? {}) },
      };
    }
  }
  yield { type: "end", finish_reason: response.finish_reason, usage: response.usage };
}
