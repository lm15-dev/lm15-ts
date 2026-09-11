import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockPathFor, withFileLock } from "../src/auth/stores.ts";
import { LockTimeoutError, NotConfiguredError } from "../src/errors.ts";

const linux = process.platform === "linux";
const hasPython = spawnSync("python3", ["--version"]).status === 0;

test("kernel lock interoperates with Python and survives a persistent lock file", { skip: !linux || !hasPython, timeout: 5000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "lm15-lock-"));
  const old = process.env["LM15_LOCK_DIR"];
  process.env["LM15_LOCK_DIR"] = join(dir, "locks");
  t.after(() => { if (old === undefined) delete process.env["LM15_LOCK_DIR"]; else process.env["LM15_LOCK_DIR"] = old; rmSync(dir, { recursive: true, force: true }); });
  const target = join(dir, "credentials.json");
  const probe = () => spawnSync("python3", ["-c", 'import fcntl,sys\nf=open(sys.argv[1],"a")\ntry: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(75)', lockPathFor(target)]).status;
  await withFileLock(target, async () => { assert.equal(probe(), 75); });
  assert.ok(existsSync(lockPathFor(target)));
  assert.equal(probe(), 0);
  await assert.rejects(withFileLock(target, async () => { throw new Error("callback failed"); }), /callback failed/);
  assert.equal(probe(), 0);
});

test("process death releases the kernel lock without deleting a file", { skip: !linux, timeout: 10_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "lm15-lock-crash-"));
  const old = process.env["LM15_LOCK_DIR"];
  process.env["LM15_LOCK_DIR"] = join(dir, "locks");
  const target = join(dir, "credentials.json");
  const moduleUrl = new URL("../src/auth/stores.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `import {withFileLock} from ${JSON.stringify(moduleUrl)}; await withFileLock(${JSON.stringify(target)}, async()=>{console.log('held');await new Promise(()=>{setInterval(()=>{},1000)});});`], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { child.kill("SIGKILL"); if (old === undefined) delete process.env["LM15_LOCK_DIR"]; else process.env["LM15_LOCK_DIR"] = old; rmSync(dir, { recursive: true, force: true }); });
  const [ready] = await once(child.stdout!, "data");
  assert.match(String(ready), /held/);
  await assert.rejects(withFileLock(target, async () => {}, { timeoutMs: 25 }), LockTimeoutError);
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  await withFileLock(target, async () => {});
  assert.ok(existsSync(lockPathFor(target)));
});

test("missing targets behind directory symlinks share the same lock; missing flock fails closed", { skip: !linux }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "lm15-lock-path-"));
  const oldLock = process.env["LM15_LOCK_DIR"];
  const oldPath = process.env["PATH"];
  t.after(() => {
    if (oldLock === undefined) delete process.env["LM15_LOCK_DIR"]; else process.env["LM15_LOCK_DIR"] = oldLock;
    if (oldPath === undefined) delete process.env["PATH"]; else process.env["PATH"] = oldPath;
    rmSync(dir, { recursive: true, force: true });
  });
  process.env["LM15_LOCK_DIR"] = join(dir, "locks");
  symlinkSync(dir, join(dir, "alias"));
  assert.equal(lockPathFor(join(dir, "alias", "missing", "file")), lockPathFor(join(dir, "missing", "file")));
  process.env["PATH"] = "";
  let called = false;
  await assert.rejects(withFileLock(join(dir, "target"), async () => { called = true; }), NotConfiguredError);
  assert.equal(called, false);
});
