/**
 * What the playground shares between its interface and its code panel:
 * the connection, the settings, the request they make, and the same
 * request rendered as JavaScript, Python and Rust — each the real SDK's
 * own API — plus the wire body as JSON and as a curl command.
 *
 * The rendered code is what runs: the JavaScript runtime is this page's
 * own client; the Python runtime executes the Python text below under
 * Pyodide; the Rust runtime is the compiled lm15-rs codec, driven with the
 * same request the Rust text below builds natively. Credentials are always
 * placeholders in the text.
 */

import { Message, OpenAIChatLM, RawNumber, Request as RequestNs, adapterFor, access, lookup, stringifyJson, type Config, type ProviderLM, type ReasoningEffort, type Request } from "lm15/browser";

export interface Connection { provider: string; model: string; endpoint: string }
export interface Settings { system: string; temperature: number | null; maxTokens: number; reasoning: ReasoningEffort | "" }
export type Language = "javascript" | "python" | "rust" | "json" | "curl";
export const LANGUAGES: ReadonlyArray<{ id: Language; label: string }> = [
  { id: "javascript", label: "JavaScript" },
  { id: "python", label: "Python" },
  { id: "rust", label: "Rust" },
  { id: "json", label: "JSON" },
  { id: "curl", label: "curl" },
];
export const DEFAULT_SETTINGS: Settings = { system: "", temperature: null, maxTokens: 400, reasoning: "" };

/** The Anthropic API refuses a browser origin unless the caller says it means it. */
export const ANTHROPIC_BROWSER_HEADER = ["anthropic-dangerous-direct-browser-access", "true"] as const;

export function keyless(provider: string): boolean {
  return provider === "ollama" || provider === "custom";
}

export function keyPage(provider: string): string | undefined {
  return lookup(provider)?.consoleUrl;
}

export function createClient(connection: Connection, key?: string): ProviderLM {
  const id = connection.provider;
  if (!key && !keyless(id)) throw new Error("Add this provider's API key in Settings first.");
  if (id === "custom") {
    const url = new URL(connection.endpoint);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("Use an HTTP(S) API root without credentials, query parameters, or fragments.");
    }
    return new OpenAIChatLM({ apiKey: key ?? "unused", baseUrl: url.href.replace(/\/$/, "") });
  }
  return adapterFor(id, {
    apiKey: key ?? "unused",
    ...(id === "anthropic" ? { access: access.withHeaders(access.ANTHROPIC_API, { [ANTHROPIC_BROWSER_HEADER[0]]: ANTHROPIC_BROWSER_HEADER[1] }) } : {}),
  });
}

/** The one Request every runtime sends: the transcript, the new message, the settings. */
export function buildRequest(connection: Connection, settings: Settings, messages: readonly Message[], text: string): Request {
  const config: Record<string, unknown> = { maxTokens: settings.maxTokens };
  if (settings.temperature !== null) config["temperature"] = settings.temperature;
  if (settings.reasoning) config["reasoning"] = { effort: settings.reasoning };
  return RequestNs.create({
    model: connection.model.trim(),
    ...(settings.system.trim() ? { system: settings.system.trim() } : {}),
    messages: [...messages, Message.user(text)],
    config: config as Config,
  });
}

// ─── Rendering ────────────────────────────────────────────────────────

const q = JSON.stringify;
const indent = (text: string, level: number) => text.split("\n").map((line) => (line ? "  ".repeat(level) + line : line)).join("\n");

/** Python spelling of a JSON value (True/False/None), for the replayed transcript. */
function pyLiteral(value: unknown, level = 0): string {
  const pad = "    ".repeat(level);
  const inner = "    ".repeat(level + 1);
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return String(value);
  if (value instanceof RawNumber) return value.raw; // a number as the wire spelled it (opaque payloads keep their lexeme)
  if (typeof value === "string") return q(value);
  if (Array.isArray(value)) return value.length ? `[\n${value.map((v) => inner + pyLiteral(v, level + 1)).join(",\n")},\n${pad}]` : "[]";
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length ? `{\n${entries.map(([k, v]) => `${inner}${q(k)}: ${pyLiteral(v, level + 1)}`).join(",\n")},\n${pad}}` : "{}";
}

function configLines(settings: Settings, lang: "javascript" | "python" | "rust"): string[] {
  const entries: Array<[string, string]> = [];
  if (lang === "javascript") {
    entries.push(["maxTokens", String(settings.maxTokens)]);
    if (settings.temperature !== null) entries.push(["temperature", String(settings.temperature)]);
    if (settings.reasoning) entries.push(["reasoning", `{ effort: ${q(settings.reasoning)} }`]);
    return [`  config: { ${entries.map(([k, v]) => `${k}: ${v}`).join(", ")} },`];
  }
  if (lang === "python") {
    entries.push(["max_tokens", String(settings.maxTokens)]);
    if (settings.temperature !== null) entries.push(["temperature", String(settings.temperature)]);
    if (settings.reasoning) entries.push(["reasoning", `Reasoning(effort=${q(settings.reasoning)})`]);
    return [`    config=Config(${entries.map(([k, v]) => `${k}=${v}`).join(", ")}),`];
  }
  entries.push(["max_tokens", `Some(${settings.maxTokens})`]);
  if (settings.temperature !== null) entries.push(["temperature", `Some(${settings.temperature})`]);
  if (settings.reasoning) entries.push(["reasoning", `Some(Reasoning::new(${q(settings.reasoning)}.parse()?))`]);
  return [`    config: Config { ${entries.map(([k, v]) => `${k}: ${v}`).join(", ")}, ..Default::default() },`];
}

export function exampleJavascript(connection: Connection, settings: Settings, messages: readonly Message[], prompt: string): string {
  const imports = [connection.provider === "custom" ? "OpenAIChatLM" : "adapterFor", "Message", "Request", "ResponseStream"];
  if (connection.provider === "anthropic") imports.splice(1, 0, "access");
  const lines = [`import { ${imports.join(", ")} } from "lm15/browser";`, ""];
  if (connection.provider === "custom") {
    lines.push("const lm = new OpenAIChatLM({", '  apiKey: "YOUR_API_KEY", // "unused" for a keyless server', `  baseUrl: ${q(connection.endpoint)},`, "});");
  } else {
    lines.push(`const lm = adapterFor(${q(connection.provider)}, {`, `  apiKey: ${q(keyless(connection.provider) ? "unused" : "YOUR_API_KEY")},`);
    if (connection.provider === "anthropic") lines.push("  // A page must say it means to call Anthropic directly.", "  access: access.withHeaders(access.ANTHROPIC_API, {", `    ${q(ANTHROPIC_BROWSER_HEADER[0])}: ${q(ANTHROPIC_BROWSER_HEADER[1])},`, "  }),");
    lines.push("});");
  }
  lines.push("", "const request = Request.create({", `  model: ${q(connection.model)},`);
  if (settings.system.trim()) lines.push(`  system: ${q(settings.system.trim())},`);
  if (messages.length) {
    lines.push("  // Earlier turns, replayed exactly as the model produced them.", "  messages: [", ...indent(messages.map((m) => `Message.fromJSON(${stringifyJson(Message.toJSON(m), { indent: 2 })}),`).join("\n"), 2).split("\n"), `    Message.user(${q(prompt)}),`, "  ],");
  } else lines.push(`  messages: [Message.user(${q(prompt)})],`);
  lines.push(...configLines(settings, "javascript"), "});", "", "const controller = new AbortController(); // Stop calls controller.abort()", "const result = new ResponseStream(lm.stream(request, { signal: controller.signal }), request);", "for await (const text of result) process.stdout.write(text);", "", "// Keep the reply for the next turn.", "const response = await result.response();", "const messages = [...request.messages, response.message];");
  return lines.join("\n");
}

const PY_CLASS: Record<string, string> = { "openai-responses": "AsyncOpenAILM", "openai-chat": "AsyncOpenAIChatLM", anthropic: "AsyncAnthropicLM", gemini: "AsyncGeminiLM" };

/** The Python that runs under Pyodide in this page, and on CPython without the transport line. */
export function examplePython(connection: Connection, settings: Settings, messages: readonly Message[], prompt: string): string {
  const definition = lookup(connection.provider);
  const cls = connection.provider === "custom" ? "AsyncOpenAIChatLM" : (PY_CLASS[definition?.dialect ?? "openai-chat"] ?? "AsyncOpenAIChatLM");
  const names = [cls, "AsyncResponseStream", "Config", "Message", "Request"];
  if (settings.reasoning) names.push("Reasoning");
  const lines = [`from lm15 import ${names.sort().join(", ")}`];
  if (connection.provider === "anthropic") lines.push("from lm15.access import ANTHROPIC_API");
  if (messages.length) lines.push("from lm15.serde import message_from_dict");
  lines.push("from lm15.transports import FetchTransport  # in a page (Pyodide); on CPython drop this and transport=", "", `lm = ${cls}(`, `    api_key=${q(keyless(connection.provider) ? "unused" : "YOUR_API_KEY")},`);
  if (connection.provider === "custom") lines.push(`    base_url=${q(connection.endpoint)},`);
  else if (definition?.bound) lines.push(`    compat=${q(connection.provider)},`);
  if (connection.provider === "anthropic") lines.push("    # A page must say it means to call Anthropic directly.", `    access=ANTHROPIC_API.with_headers({${q(ANTHROPIC_BROWSER_HEADER[0])}: ${q(ANTHROPIC_BROWSER_HEADER[1])}}),`);
  lines.push("    transport=FetchTransport(),", ")", "", "request = Request(", `    model=${q(connection.model)},`);
  if (settings.system.trim()) lines.push(`    system=${q(settings.system.trim())},`);
  if (messages.length) {
    lines.push("    # Earlier turns, replayed exactly as the model produced them.", "    messages=(", ...messages.map((m) => `        message_from_dict(${pyLiteral(Message.toJSON(m), 2)}),`), `        Message.user(${q(prompt)}),`, "    ),");
  } else lines.push(`    messages=(Message.user(${q(prompt)}),),`);
  lines.push(...configLines(settings, "python"), ")", "", "result = AsyncResponseStream(lm.stream(request), request)  # Stop closes the stream", "async for text in result:", '    print(text, end="", flush=True)', "", "# Keep the reply for the next turn.", "response = await result.response()", "messages = (*request.messages, response.message)");
  return lines.join("\n");
}

/** The Rust of the same call; in this page the compiled lm15-rs codec runs it (the network is the page's). */
export function exampleRust(connection: Connection, settings: Settings, messages: readonly Message[], prompt: string): string {
  const imports = ["Config", "LMRouter", "Message", "Request", "ResponseStream", "RouterConfig"];
  if (settings.reasoning) imports.push("Reasoning");
  if (messages.length) imports.push("Canonical");
  const lines = ["use futures_util::StreamExt;", `use lm15::{${imports.sort().join(", ")}};`, ""];
  const provider = connection.provider === "custom" ? "openai-chat" : connection.provider;
  lines.push("let router = LMRouter::with_config(", "    RouterConfig::new()", `        .api_key(${q(provider)}, ${q(keyless(connection.provider) ? "unused" : "YOUR_API_KEY")})`);
  if (connection.provider === "custom") lines.push(`        .base_url(${q(provider)}, ${q(connection.endpoint)})`);
  lines.push(")?;", "", "let request = Request {", `    model: ${q(`${provider}:${connection.model}`)}.into(),`);
  if (settings.system.trim()) lines.push(`    system: Some(${q(settings.system.trim())}.into()),`);
  if (messages.length) {
    lines.push("    // Earlier turns, replayed exactly as the model produced them.", "    messages: vec![", ...messages.map((m) => `        Message::from_json(&serde_json::json!(${stringifyJson(Message.toJSON(m))}))?,`), `        Message::user(${q(prompt)})?,`, "    ],");
  } else lines.push(`    messages: vec![Message::user(${q(prompt)})?],`);
  lines.push(...configLines(settings, "rust"), "    ..Default::default()", "};", "", "let mut result = ResponseStream::new(router.stream(&request), &request); // drop it to stop", "while let Some(text) = result.text_chunks().next().await {", '    print!("{}", text?);', "}", "", "// Keep the reply for the next turn.", "let response = result.response().await?;", "let mut messages = request.messages.clone();", "messages.push(response.message.clone());");
  return lines.join("\n");
}

export interface Wire { method: string; url: string; headers: Array<[string, string]>; body: string }

export function exampleCurl(wire: Wire): string {
  const lines = [`curl -X ${wire.method} ${shellQuote(wire.url)} \\`];
  for (const [name, value] of wire.headers) lines.push(`  -H ${shellQuote(`${name}: ${name.toLowerCase() === "authorization" || name.toLowerCase().includes("api-key") ? value.replace(/\S+$/, "YOUR_API_KEY") : value}`)} \\`);
  lines.push(`  --data-binary ${shellQuote(wire.body)}`);
  return lines.join("\n");
}

export function exampleJson(wire: Wire): string {
  try {
    return JSON.stringify(JSON.parse(wire.body), null, 2);
  } catch {
    return wire.body;
  }
}

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** Stable fuzzy ranking: exact, prefix, substring, then ordered-character matches. */
export function fuzzyScore(query: string, candidate: string): number {
  const qq = query.trim().toLowerCase();
  const c = candidate.toLowerCase();
  if (!qq) return 0;
  if (c === qq) return 10000;
  if (c.startsWith(qq)) return 8000 - c.length;
  const index = c.indexOf(qq);
  if (index !== -1) return 6000 - index - c.length;
  let previous = -1, gap = 0;
  for (const char of qq) {
    const found = c.indexOf(char, previous + 1);
    if (found === -1) return -Infinity;
    gap += found - previous - 1;
    previous = found;
  }
  return 2000 - gap - c.length;
}

export type PickerKind = "commands" | "provider" | "model";
export function slashCommand(text: string): { kind: PickerKind; query: string } | undefined {
  if (!text.startsWith("/") || text.includes("\n")) return undefined;
  const command = /^\/(provider|model)(?:\s+(.*))?$/.exec(text);
  if (command) return { kind: command[1] as "provider" | "model", query: command[2] ?? "" };
  return { kind: "commands", query: text.slice(1) };
}
