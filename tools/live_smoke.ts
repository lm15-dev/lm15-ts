/**
 * Live smoke: one `complete` and one `stream` per dialect through the
 * router, keys from the environment, receipts written with the credential
 * header redacted. Not a gate — the harness pins recorded bodies; this
 * proves the transport, the auth header and the stream assembly against
 * the real servers.
 *
 *     set -a; source ../.env; set +a
 *     node --experimental-strip-types tools/live_smoke.ts receipts/<folder>
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LMRouter, Message, ResponseStream, LiveSession, type StreamEvent } from "../src/index.ts";
import { Response } from "../src/types/response.ts";
import { stringifyJson, type JsonObject } from "../src/json.ts";
import type { Transport, TransportResponse } from "../src/transport.ts";
import type { TransportRequest } from "../src/wire.ts";
import { FetchTransport } from "../src/transport.ts";
import { lookup } from "../src/registry.ts";
import { GeminiLM } from "../src/dialects/gemini.ts";

const out = process.argv[2] ?? `receipts/${new Date().toISOString().slice(0, 10)}-live-smoke`;
mkdirSync(out, { recursive: true });

const BINDINGS: Array<[string, string]> = [
  ["openai", "gpt-4.1-mini"],
  ["anthropic", "claude-haiku-4-5"],
  ["gemini", "gemini-2.5-flash"],
  ["groq", "openai/gpt-oss-20b"],
];

/** Records every exchange, redacting the credential header to `$ENV_KEY`. */
class RecordingTransport implements Transport {
  readonly inner = new FetchTransport();
  last: { sent: JsonObject; status: number; headers: Array<[string, string]>; body: string } | undefined;

  async send(request: TransportRequest, opts?: { signal?: AbortSignal | undefined }): Promise<TransportResponse> {
    const res = await this.inner.send(request, opts);
    const bytes = await res.bytes();
    const body = new TextDecoder().decode(bytes);
    this.last = {
      sent: {
        method: request.method,
        url: request.url.replace(/([?&]key=)[^&]+/, "$1$GEMINI_API_KEY"),
        headers: Object.fromEntries(request.headers.map(([k, v]) => [k, /authorization|api-key/i.test(k) ? "$ENV_KEY" : v])),
        body: request.body.length > 0 ? new TextDecoder().decode(request.body) : null,
      },
      status: res.status,
      headers: [...res.headers] as Array<[string, string]>,
      body,
    };
    return {
      status: res.status,
      reason: res.reason,
      headers: res.headers,
      bytes: async () => bytes,
      async *chunks() {
        yield bytes;
      },
    };
  }
}

const rows: string[] = ["| Binding | Model | complete | stream | text | finish | stream usage |", "|---|---|---|---|---|---|---|"];
let failures = 0;

for (const [provider, model] of BINDINGS) {
  const envKey = lookup(provider)?.access.envKeys[0];
  if (envKey && !process.env[envKey]) {
    rows.push(`| ${provider} | ${model} | skipped (${envKey} unset) | | | | |`);
    continue;
  }
  const transport = new RecordingTransport();
  const router = new LMRouter({ transport });
  const request = { model: `${provider}:${model}`, messages: [Message.user("Reply with exactly the two words: hello world")], config: { maxTokens: 64, temperature: 0 } };
  let complete: Response | undefined;
  let streamed: Response | undefined;
  let chunks = "";
  let events: StreamEvent[] = [];
  const receipt = (op: string, lm15: unknown) => writeFileSync(join(out, `${provider}-${op}.json`), stringifyJson({ ...transport.last, lm15 }, { indent: 2 }) + "\n");
  try {
    complete = await router.complete(request);
    receipt("complete", Response.toJSON(complete));
  } catch (e) {
    receipt("complete", { error: String(e) });
    failures++;
  }
  try {
    const rs = new ResponseStream(router.stream(request), request);
    for await (const ev of rs.events()) {
      events.push(ev);
      if (ev.type === "delta" && ev.delta.type === "text") chunks += ev.delta.text;
    }
    streamed = await rs.response();
    receipt("stream", { events: events.map((e) => (e.type === "end" ? { ...e, providerData: undefined } : e)), response: Response.toJSON(streamed) });
  } catch (e) {
    receipt("stream", { error: String(e), events });
    failures++;
  }
  const ok = complete && streamed && complete.text === streamed.text && complete.finishReason === streamed.finishReason && chunks === streamed.text;
  if (complete && streamed && !ok) failures++;
  const usage = streamed?.usage;
  rows.push(
    `| ${provider} | ${model} | ${complete ? transport.last?.status ?? "?" : "FAIL"} | ${streamed ? "200" : "FAIL"} | \`${(streamed ?? complete)?.text ?? ""}\` | ${(streamed ?? complete)?.finishReason ?? ""} | ${usage ? `in ${usage.inputTokens} / out ${usage.outputTokens}${usage.reasoningTokens !== undefined ? ` (+${usage.reasoningTokens} reasoning)` : ""}` : ""} |${ok ? "" : " parity mismatch"}`,
  );
}

// One text turn over Gemini Live (websocket), when a key is present.
let liveNote = "Gemini Live: skipped (GEMINI_API_KEY unset)";
if (process.env["GEMINI_API_KEY"]) {
  try {
    const lm = new LMRouter().lm("gemini:x") as GeminiLM;
    const session = await LiveSession.open(lm, { model: "gemini-2.5-flash-native-audio-preview-12-2025" });
    await session.sendText("Say the single word: pong");
    let text = "";
    const seen: string[] = [];
    for await (const ev of session) {
      seen.push(ev.type);
      if (ev.type === "text") text += ev.text;
      if (ev.type === "turn_end" || ev.type === "error") break;
    }
    await session.close();
    liveNote = `Gemini Live: text turn over the websocket → ${JSON.stringify(text.trim())} (events: ${seen.join(", ")})`;
    writeFileSync(join(out, "gemini-live.json"), stringifyJson({ text, events: seen }, { indent: 2 }) + "\n");
  } catch (e) {
    liveNote = `Gemini Live: FAILED — ${String(e)}`;
    failures++;
  }
}

const summary = `# ${new Date().toISOString().slice(0, 10)} — live traffic through lm15-ts

\`node --experimental-strip-types tools/live_smoke.ts ${out}\`: the same request
("Reply with exactly the two words: hello world", maxTokens 64, temperature 0)
once through \`complete\` and once through \`stream\` + \`ResponseStream\`, per dialect.

${rows.join("\n")}

Checked per binding: the assembled stream's text and finish reason equal the
complete response's, and the text chunks concatenate to the assembled text.

${liveNote}

Each \`<provider>-<op>.json\` holds the request as sent (credential header
redacted to \`$ENV_KEY\`), the status, the response headers, the body, and the
canonical Response (or the error).
`;
writeFileSync(join(out, "SUMMARY.md"), summary);
console.log(summary);
process.exit(failures === 0 ? 0 : 1);
