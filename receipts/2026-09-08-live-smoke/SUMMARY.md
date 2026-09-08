# 2026-09-08 — live traffic through lm15-ts

`node --experimental-strip-types tools/live_smoke.ts receipts/2026-09-08-live-smoke`: the same request
("Reply with exactly the two words: hello world", maxTokens 64, temperature 0)
once through `complete` and once through `stream` + `ResponseStream`, per dialect.

| Binding | Model | complete | stream | text | finish | stream usage |
|---|---|---|---|---|---|---|
| openai | gpt-4.1-mini | 200 | 200 | `hello world` | stop | in 16 / out 3 (+0 reasoning) |
| anthropic | claude-haiku-4-5 | 200 | 200 | `hello world` | stop | in 16 / out 5 |
| gemini | gemini-2.5-flash | 200 | 200 | `hello world` | stop | in 10 / out 2 (+32 reasoning) |
| groq | openai/gpt-oss-20b | 200 | 200 | `hello world` | length | in 80 / out 64 (+53 reasoning) |

Checked per binding: the assembled stream's text and finish reason equal the
complete response's, and the text chunks concatenate to the assembled text.

Gemini Live: text turn over the websocket → "**Delivering The Response**\n\nI've got it; the task is clear. My objective is straightforward: to generate the word \"pong.\" I am prepared to provide the exact requested output, as I was instructed.\n\n\npong" (events: text, text, audio, turn_end)

Each `<provider>-<op>.json` holds the request as sent (credential header
redacted to `$ENV_KEY`), the status, the response headers, the body, and the
canonical Response (or the error).
