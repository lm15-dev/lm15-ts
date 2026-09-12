/** Static demo server. Optional private, one-use localhost credential handoff for testing. */
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { CONNECTIONS } from "../examples/provider-page/connections.ts";
import { ensureRustWasm, wasmPath } from "./rust_wasm.ts";
import { ensureWheel, wheelDir } from "./python_wheel.ts";
import { readdirSync } from "node:fs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PYODIDE_DIR = resolve(root, "node_modules", "pyodide");

function contentType(file: string): string {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".wasm")) return "application/wasm";
  if (file.endsWith(".json")) return "application/json";
  if (file.endsWith(".whl") || file.endsWith(".zip")) return "application/zip";
  return "application/octet-stream";
}

/** `/vendor/pyodide/<file>` from the npm package; `/vendor/python/lm15.whl` and `/vendor/rust/lm15.wasm` from vendor/. Nothing else, no traversal. */
function vendoredFile(pathname: string): string | undefined {
  const pyodide = /^\/vendor\/pyodide\/([a-zA-Z0-9_.-]+)$/.exec(pathname);
  if (pyodide) {
    const file = resolve(PYODIDE_DIR, pyodide[1]!);
    return file.startsWith(PYODIDE_DIR + sep) && existsSync(file) ? file : undefined;
  }
  if (pathname === "/vendor/python/lm15.whl") {
    const wheel = existsSync(wheelDir) ? readdirSync(wheelDir).find((f) => /^lm15-.*\.whl$/.test(f)) : undefined;
    return wheel ? resolve(wheelDir, wheel) : undefined;
  }
  if (pathname === "/vendor/rust/lm15.wasm") return existsSync(wasmPath) ? wasmPath : undefined;
  return undefined;
}
export async function startDemo(options: { envFile?: string; port?: number } = {}): Promise<{ server: Server; url: string; browserUrl: string; providers: string[] }> {
  const credentials: Record<string, string> = {};
  if (options.envFile) {
    const values = parseEnv(readFileSync(options.envFile, "utf8"));
    for (const choice of CONNECTIONS) if (choice.env && values[choice.env]) credentials[choice.id] = values[choice.env]!;
  }
  const providers = Object.keys(credentials);
  const token = providers.length ? randomBytes(32).toString("base64url") : "";
  const expires = Date.now() + 30 * 60_000;
  let used = false;
  let origin = "";
  const server = createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    if (req.headers.host !== new URL(origin).host) { res.writeHead(403).end(); return; }
    const url = new URL(req.url ?? "/", origin);
    if (url.pathname === "/__lm15_test_credentials") {
      const supplied = req.headers["x-lm15-test-token"];
      const matches = typeof supplied === "string" && Buffer.byteLength(supplied) === Buffer.byteLength(token) && token !== ""
        && timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
      if (req.method !== "GET" || used || Date.now() > expires || !matches
        || (req.headers.origin !== undefined && req.headers.origin !== origin)
        || (req.headers["sec-fetch-site"] !== undefined && req.headers["sec-fetch-site"] !== "same-origin")) {
        res.writeHead(403).end(); return;
      }
      used = true;
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(credentials));
      for (const key of Object.keys(credentials)) delete credentials[key];
      return;
    }
    if (!["GET", "HEAD"].includes(req.method ?? "")) { res.writeHead(405).end(); return; }
    if (url.pathname === "/") { res.writeHead(302, { Location: "/examples/provider-page/" }).end(); return; }
    const pathname = url.pathname === "/examples/provider-page/" ? url.pathname + "index.html" : url.pathname;
    // The runtimes the page may load: Pyodide from node_modules, the wheel and the wasm codec from vendor/.
    const vendored = vendoredFile(pathname);
    if (!vendored && !/^\/dist\/[a-zA-Z0-9_./-]+\.js$/.test(pathname)
      && !/^\/examples\/provider-page\/(index\.html|app\.css|build\/[a-zA-Z0-9_./-]+\.js)$/.test(pathname)) {
      res.writeHead(404).end(); return;
    }
    try {
      const file = vendored ?? realpathSync(resolve(root, "." + pathname));
      if (!vendored && !file.startsWith(root + sep)) { res.writeHead(404).end(); return; }
      const body = readFileSync(file);
      res.setHeader("Content-Type", contentType(file));
      res.writeHead(200).end(req.method === "HEAD" ? undefined : body);
    } catch { res.writeHead(404).end("Not found. Run npm run build first."); }
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", done);
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Expected a loopback TCP address");
  origin = `http://127.0.0.1:${addr.port}`;
  const url = `${origin}/examples/provider-page/`;
  return { server, url, browserUrl: token ? `${url}#local-test=${token}` : url, providers };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const local = process.argv.includes("--local-keys");
  for (const [what, result] of [["Python wheel", ensureWheel()], ["Rust wasm codec", ensureRustWasm()]] as const) {
    if ("skip" in result) console.error(`${what}: not available (${result.skip}); that runtime will fail to load in the page.`);
  }
  const demo = await startDemo({ ...(local ? { envFile: resolve(root, "../.env") } : {}), port: Number(process.env["PORT"] ?? 0) });
  console.log(`LM15 provider demo: ${demo.url}`);
  if (local) console.log(`Private local test keys: ${demo.providers.join(", ") || "none found"}. Keys are never printed or saved in the page.`);
  if (process.argv.includes("--open")) {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
    const child = spawn(opener, [demo.browserUrl], { stdio: "ignore" });
    child.on("error", () => console.error("Could not open a browser automatically."));
  } else if (local) {
    console.log("Add --open to hand the one-use test session to your browser. The ordinary URL above does not expose keys.");
  }
}
