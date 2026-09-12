/**
 * The lm15-rs wasm codec the browser loads: built from the sibling checkout
 * (`cargo build --profile wasm --lib --no-default-features --features wasm
 * --target wasm32-unknown-unknown`) and copied into `vendor/rust/`, so the
 * Rust that runs in a page is the Rust in the repository. Exports
 * `ensureRustWasm()` for the tests and the demo server; runnable as
 * `npm run rust:wasm`.
 *
 * On this machine Rust builds go through `rcargo` (the build server);
 * the tool prefers it when present and falls back to `cargo`. With
 * `rcargo`, the cdylib is not an "executable" artifact, so the tool
 * fetches it back itself over the same host.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const rustRepo = resolve(root, "..", "lm15-rs");
export const wasmDir = join(root, "vendor", "rust");
export const wasmPath = join(wasmDir, "lm15.wasm");
const BUILD_ARGS = ["build", "--locked", "--profile", "wasm", "--lib", "--no-default-features", "--features", "wasm", "--target", "wasm32-unknown-unknown"];
const ARTIFACT = "target/wasm32-unknown-unknown/wasm/lm15.wasm";

function onPath(bin: string): boolean {
  return (process.env["PATH"] ?? "").split(":").some((dir) => dir && existsSync(join(dir, bin)));
}

/** The artifact's path, building it when absent or when `force`. Returns why when it cannot be built. */
export function ensureRustWasm(force = false): { path: string } | { skip: string } {
  if (!existsSync(join(rustRepo, "Cargo.toml"))) return { skip: `lm15-rs not checked out beside this repository (${rustRepo})` };
  mkdirSync(wasmDir, { recursive: true });
  const built = join(rustRepo, ARTIFACT);
  if (!force && existsSync(wasmPath) && statSync(wasmPath).size > 0) return { path: wasmPath };
  if (force || !existsSync(built)) {
    if (onPath("rcargo")) {
      execFileSync("rcargo", BUILD_ARGS, { cwd: rustRepo, stdio: "pipe" });
      const host = process.env["RCARGO_HOST"] ?? "192.168.2.24";
      mkdirSync(join(rustRepo, "target/wasm32-unknown-unknown/wasm"), { recursive: true });
      execFileSync("rsync", ["-az", `${host}:${built}`, built], { stdio: "pipe" });
    } else if (onPath("cargo")) {
      execFileSync("cargo", BUILD_ARGS, { cwd: rustRepo, stdio: "pipe" });
    } else return { skip: "neither rcargo nor cargo is on PATH to build the lm15-rs wasm codec" };
  }
  if (!existsSync(built)) return { skip: `the build produced no ${ARTIFACT}` };
  copyFileSync(built, wasmPath);
  return { path: wasmPath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = ensureRustWasm(process.argv.includes("--force"));
  if ("skip" in result) {
    console.error(result.skip);
    process.exitCode = 1;
  } else console.log(result.path);
}
