/** Shared connection logic and executable examples for the split-view UI. */
import { Message, OpenAIChatLM, adapterFor, access, type ProviderLM } from "lm15/browser";

export interface Connection { provider: string; model: string; endpoint: string }
export type ExampleMode = "connect" | "request" | "stream" | "models";

export function createClient(connection: Connection, key?: string): ProviderLM {
  const id = connection.provider;
  if (!key && !["ollama", "custom"].includes(id)) throw new Error("Add this provider's API key in Settings first.");
  if (id === "custom") {
    const url = new URL(connection.endpoint);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("Use an HTTP(S) API root without credentials, query parameters, or fragments.");
    }
    return new OpenAIChatLM({ apiKey: key ?? "unused", baseUrl: url.href.replace(/\/$/, "") });
  }
  return adapterFor(id, {
    apiKey: key ?? "unused",
    ...(id === "anthropic" ? { access: access.withHeaders(access.ANTHROPIC_API, { "anthropic-dangerous-direct-browser-access": "true" }) } : {}),
  });
}

const indent = (text: string, level: number) => text.split("\n").map((line) => (line ? "  ".repeat(level) + line : line)).join("\n");

/** Exact canonical JSON of the transcript so far, including thinking and continuation state. */
function history(messages: readonly Message[]): string {
  return messages.map((message) => `Message.fromJSON(${JSON.stringify(Message.toJSON(message), null, 2)}),`).join("\n");
}

/**
 * The exact call the page makes: the connection, then the full request with
 * every earlier turn replayed verbatim. Credentials are always placeholders.
 */
export function example(connection: Connection, prompt: string, mode: ExampleMode, messages: readonly Message[] = []): string {
  const q = JSON.stringify;
  const imports = [connection.provider === "custom" ? "OpenAIChatLM" : "adapterFor"];
  if (connection.provider === "anthropic") imports.push("access");
  if (mode === "request" || mode === "stream") imports.push("Message");
  if (mode === "stream") imports.push("ResponseStream");
  const lines = [`import { ${imports.join(", ")} } from "lm15/browser";`, ""];
  if (connection.provider === "custom") {
    lines.push("const lm = new OpenAIChatLM({", '  apiKey: "YOUR_API_KEY", // "unused" for a keyless server', `  baseUrl: ${q(connection.endpoint)},`, "});");
  } else {
    lines.push(`const lm = adapterFor(${q(connection.provider)}, {`, `  apiKey: ${q(connection.provider === "ollama" ? "unused" : "YOUR_API_KEY")},`);
    if (connection.provider === "anthropic") lines.push('  access: access.withHeaders(access.ANTHROPIC_API, {', '    "anthropic-dangerous-direct-browser-access": "true",', "  }),");
    lines.push("});");
  }
  if (mode === "models") lines.push("", "const models = await lm.listModels();", "console.log(models.map((model) => model.id));");
  if (mode === "request" || mode === "stream") {
    lines.push("", "const request = {", `  model: ${q(connection.model)},`);
    if (messages.length) {
      lines.push("  // Earlier turns, replayed exactly as the model produced them.", "  messages: [", ...indent(history(messages), 2).split("\n"), `    Message.user(${q(prompt || "Hello!")}),`, "  ],");
    } else lines.push(`  messages: [Message.user(${q(prompt || "Hello!")})],`);
    lines.push("  config: { maxTokens: 400 },", "};");
  }
  if (mode === "request") lines.push("", "// Inspect the body locally; no inference request.", "const wire = await lm.buildRequest(request, true);", "console.log(new TextDecoder().decode(wire.body));");
  if (mode === "stream") lines.push("", "const controller = new AbortController(); // Stop calls controller.abort()", "const result = new ResponseStream(lm.stream(request, { signal: controller.signal }), request);", "for await (const text of result) console.log(text);", "", "// Keep the reply for the next turn.", "const response = await result.response();", "const messages = [...request.messages, response.message];");
  return lines.join("\n");
}

/** Stable fuzzy ranking: exact, prefix, substring, then ordered-character matches. */
export function fuzzyScore(query: string, candidate: string): number {
  const q = query.trim().toLowerCase();
  const c = candidate.toLowerCase();
  if (!q) return 0;
  if (c === q) return 10000;
  if (c.startsWith(q)) return 8000 - c.length;
  const index = c.indexOf(q);
  if (index !== -1) return 6000 - index - c.length;
  let previous = -1, gap = 0;
  for (const char of q) {
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
