#!/usr/bin/env node
/**
 * A static server for the examples: this repository's root on the
 * loopback, nothing else, with the MIME types a module page needs and no
 * caching. `npm run example` opens examples/openrouter-page/. Build first
 * (`npm run build`): the page imports `dist/browser.js` through its import
 * map and its own `build/` output.
 *
 * Any static host serves the same files the same way; this one exists so
 * the example needs nothing installed beyond Node.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const open = process.argv[2] ?? "";
const port = Number(process.env["PORT"] ?? 0);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  let file = resolve(root, "." + normalize(decodeURIComponent(url.pathname)));
  if (!(file === root || file.startsWith(root + sep))) {
    res.writeHead(403).end();
    return;
  }
  if (existsSync(file) && statSync(file).isDirectory()) {
    if (!url.pathname.endsWith("/")) {
      res.writeHead(301, { Location: url.pathname + "/" }).end();
      return;
    }
    file = join(file, "index.html");
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain" }).end(`not found: ${url.pathname}\n${file.endsWith("build/main.js") || file.endsWith("dist/browser.js") ? "run `npm run build` first" : ""}`);
    return;
  }
  res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
  createReadStream(file).pipe(res);
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const actual = typeof address === "object" && address ? address.port : port;
  console.log(`serving ${root}\n  http://localhost:${actual}/${open}`);
});
