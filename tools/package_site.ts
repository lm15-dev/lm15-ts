/** Assemble only public files into a standalone, versioned GitHub Pages release. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const siteDir = join(root, "_site");
const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Refusing symlink: ${path}`);
    return entry.isDirectory() ? filesUnder(path) : entry.isFile() ? [path] : [];
  }).sort();
}

export function packageSite(): string {
  const pins = JSON.parse(readFileSync(join(root, "site/sources.json"), "utf8")) as Record<string, string>;
  const revision = (dir: string) => execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  for (const [port, repo] of [["python", "lm15-python"], ["rust", "lm15-rs"], ["contract", "lm15-contract"]]) {
    if (revision(join(root, "..", repo!)) !== pins[port!]) throw new Error(`${repo} does not match site/sources.json; update the pin deliberately`);
  }
  rmSync(siteDir, { recursive: true, force: true });
  const staging = join(siteDir, "assets/staging");
  mkdirSync(staging, { recursive: true });
  const copy = (source: string, target: string) => {
    mkdirSync(dirname(join(staging, target)), { recursive: true });
    copyFileSync(join(root, source), join(staging, target));
  };
  // An allowlist, not a copy of the repository: no .env, test server, credentials,
  // .git, node_modules tree, receipts, or private local-test handoff files.
  for (const dir of ["dist", "examples/provider-page/build"]) {
    for (const file of filesUnder(join(root, dir))) {
      const path = relative(root, file);
      if (path.endsWith(".js") && !path.startsWith("dist/cjs/")) copy(path, path);
    }
  }
  copy("examples/provider-page/app.css", "examples/provider-page/app.css");
  const wheels = readdirSync(join(root, "vendor/python")).filter((name) => /^lm15-.*-py3-none-any\.whl$/.test(name));
  if (wheels.length !== 1) throw new Error("Expected exactly one freshly built Python wheel");
  copy(`vendor/python/${wheels[0]}`, "vendor/python/lm15.whl");
  copy("vendor/rust/lm15.wasm", "vendor/rust/lm15.wasm");
  if (!readFileSync(join(staging, "vendor/rust/lm15.wasm")).subarray(0, 4).equals(Buffer.from([0, 97, 115, 109]))) throw new Error("Invalid wasm artifact");
  for (const name of ["pyodide.mjs", "pyodide.asm.js", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"]) {
    copy(`node_modules/pyodide/${name}`, `vendor/pyodide/${name}`);
  }
  copy("LICENSE", "licenses/lm15-typescript.txt");
  copy("../lm15-python/LICENSE", "licenses/lm15-python.txt");
  copy("../lm15-rs/LICENSE", "licenses/lm15-rust.txt");
  for (const file of filesUnder(join(root, "site/licenses"))) copy(relative(root, file), `licenses/${relative(join(root, "site/licenses"), file)}`);
  copy("vendor/rust/THIRD_PARTY_LICENSES.txt", "licenses/rust-dependencies.txt");
  const provenance = {
    typescript: revision(root), ...pins,
    pyodide: JSON.parse(readFileSync(join(root, "node_modules/pyodide/package.json"), "utf8")).version as string,
  };
  writeFileSync(join(staging, "sources.json"), JSON.stringify(provenance, null, 2) + "\n");
  const files = Object.fromEntries(filesUnder(staging).map((path) => [relative(staging, path), sha256(readFileSync(path))]));
  const release = sha256(JSON.stringify(files)).slice(0, 20);
  const prefix = `/assets/${release}`;
  renameSync(staging, join(siteDir, prefix));
  let html = readFileSync(join(root, "examples/provider-page/index.html"), "utf8");
  const oldMap = html.match(/<script type="importmap">(.*?)<\/script>/)?.[1];
  if (!oldMap) throw new Error("Missing import map");
  const newMap = JSON.stringify({ imports: { "lm15/browser": `${prefix}/dist/browser.js` } });
  const cspHash = (text: string) => createHash("sha256").update(text).digest("base64");
  const oldHash = `'sha256-${cspHash(oldMap)}'`;
  if (!html.includes(oldHash)) throw new Error("The original import map is not covered by the CSP");
  html = html.replace(oldMap, newMap).replace(oldHash, `'sha256-${cspHash(newMap)}'`)
    .replace('href="./app.css"', `href="${prefix}/examples/provider-page/app.css"`)
    .replace('src="./build/main.js"', `src="${prefix}/examples/provider-page/build/main.js"`)
    .replace("connect-src 'self' https: http://localhost:* http://127.0.0.1:*", "connect-src 'self' https:")
    .replace("</head>", '<meta name="description" content="Explore LM15: one model request across JavaScript, Python and Rust, running directly in your browser.">\n<link rel="canonical" href="https://lm15.dev/">\n</head>')
    .replace("</body>", '<footer class="site-footer"><a href="https://github.com/lm15-dev/lm15-ts">Source code</a> · <a href="./about.html">Privacy, licenses &amp; hosting</a></footer>\n</body>');
  writeFileSync(join(siteDir, "index.html"), html);
  const about = readFileSync(join(root, "site/about.html"), "utf8").replaceAll("__ASSETS__", prefix);
  writeFileSync(join(siteDir, "about.html"), about);
  writeFileSync(join(siteDir, "404.html"), '<!doctype html><meta charset="utf-8"><title>Not found — lm15</title><h1>Page not found</h1><p><a href="https://lm15.dev/">Go to the playground</a></p>\n');
  writeFileSync(join(siteDir, ".nojekyll"), "");
  writeFileSync(join(siteDir, "CNAME"), "lm15.dev\n");
  writeFileSync(join(siteDir, "release.json"), JSON.stringify({ release, ...provenance, files }, null, 2) + "\n");
  console.log(`Packaged ${Object.keys(files).length} public assets as ${release} in ${siteDir}`);
  return release;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) packageSite();
