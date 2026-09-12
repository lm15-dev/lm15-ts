/**
 * The lm15-python wheel the browser (Pyodide) loads: built from the sibling
 * checkout into `vendor/python/`, so the Python that runs in a page is the
 * Python in the repository, not a copy. Exports `ensureWheel()` for the
 * tests and the demo server; runnable as `npm run python:wheel`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const pythonRepo = resolve(root, "..", "lm15-python");
export const wheelDir = join(root, "vendor", "python");

function onPath(bin: string): boolean {
  return (process.env["PATH"] ?? "").split(":").some((dir) => dir && existsSync(join(dir, bin)));
}

/** The wheel's path, building it when absent or when `force`. Returns undefined, saying why, when it cannot be built. */
export function ensureWheel(force = false): { path: string } | { skip: string } {
  if (!existsSync(join(pythonRepo, "pyproject.toml"))) return { skip: `lm15-python not checked out beside this repository (${pythonRepo})` };
  const existing = () => readdirSync(wheelDir).filter((f) => /^lm15-.*-py3-none-any\.whl$/.test(f)).map((f) => join(wheelDir, f));
  mkdirSync(wheelDir, { recursive: true });
  if (!force && existing().length === 1) return { path: existing()[0]! };
  for (const file of existing()) rmSync(file);
  if (onPath("uv")) {
    execFileSync("uv", ["build", "--wheel", "--out-dir", wheelDir, pythonRepo], { stdio: "pipe" });
  } else if (onPath("python3")) {
    try {
      execFileSync("python3", ["-m", "build", "--wheel", "--outdir", wheelDir, pythonRepo], { stdio: "pipe" });
    } catch {
      return { skip: "neither uv nor python3 -m build can build the lm15-python wheel here" };
    }
  } else return { skip: "no uv and no python3 to build the lm15-python wheel" };
  const built = existing();
  return built.length === 1 ? { path: built[0]! } : { skip: "the wheel build produced nothing" };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = ensureWheel(process.argv.includes("--force"));
  if ("skip" in result) {
    console.error(result.skip);
    process.exitCode = 1;
  } else console.log(result.path);
}
