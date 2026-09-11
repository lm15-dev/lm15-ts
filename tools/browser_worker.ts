/** A module worker: no DOM, the same web entry, a request built and inspected. */

import { Message, OpenAIChatLM, getDefaultPlatform, utf8Decode } from "../src/browser.ts";

const lm = new OpenAIChatLM({ apiKey: "worker-key", baseUrl: "http://localhost:1234/v1", compat: "lmstudio" });
lm.buildRequest({ model: "worker-model", messages: [Message.user("built in a worker")] }, false)
  .then((req) => {
    const body = JSON.parse(utf8Decode(req.body)) as { model: string; max_tokens?: number };
    const ok = getDefaultPlatform().name === "web" && req.url === "http://localhost:1234/v1/chat/completions" && body.model === "worker-model";
    postMessage({ ok, detail: `platform=${getDefaultPlatform().name} url=${req.url} model=${body.model}` });
  })
  .catch((e) => postMessage({ ok: false, detail: String(e) }));
