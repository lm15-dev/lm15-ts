import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CredentialFileStore, credentialLockingDetail, getClaudeCodeAccessToken,
  lockPathFor, withFileLock,
} from "../src/auth/stores.ts";
import { LockTimeoutError, NotConfiguredError } from "../src/errors.ts";

// These tests deliberately DO NOT skip macOS/Windows when the addon is missing.
// A portable-lock CI job must package/build the native prerequisite first.
const supported = ["linux", "darwin", "win32"].includes(process.platform);
const python = process.env["LM15_LOCK_TEST_PYTHON"];

function temporary(t: TestContext, children: ChildProcess[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "lm15-portable-lock-"));
  const old = process.env["LM15_LOCK_DIR"];
  process.env["LM15_LOCK_DIR"] = join(dir, "locks");
  t.after(async () => {
    // Close native Windows handles before attempting to remove the directory,
    // including when an assertion fails while a child still holds the lock.
    for (const child of children) {
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    }
    if (old === undefined) delete process.env["LM15_LOCK_DIR"];
    else process.env["LM15_LOCK_DIR"] = old;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function overrideNative(t: TestContext, file: string): void {
  const old = process.env["LM15_NATIVE_LOCK_PATH"];
  process.env["LM15_NATIVE_LOCK_PATH"] = file;
  t.after(() => {
    if (old === undefined) delete process.env["LM15_NATIVE_LOCK_PATH"];
    else process.env["LM15_NATIVE_LOCK_PATH"] = old;
  });
}

test("missing native module fails closed but fresh stored reads remain usable", async (t) => {
  const dir = temporary(t);
  overrideNative(t, join(dir, "does-not-exist.node"));
  let called = false;
  await assert.rejects(withFileLock(join(dir, "target"), async () => { called = true; }), NotConfiguredError);
  assert.equal(called, false);
  assert.match(credentialLockingDetail(), /UNAVAILABLE/);
  const credential = join(dir, "claude.json");
  writeFileSync(credential, JSON.stringify({ claudeAiOauth: { accessToken: "fixture-token", expiresAt: Date.now() + 3_600_000 } }));
  assert.equal(await getClaudeCodeAccessToken(credential), "fixture-token");
  assert.doesNotMatch(credentialLockingDetail(), /fixture-token/);
});

test("native overrides must be absolute; load errors never fall back to Linux flock", async (t) => {
  const dir = temporary(t);
  overrideNative(t, "relative.node");
  await assert.rejects(withFileLock(join(dir, "target"), async () => assert.fail("must not run")), NotConfiguredError);
});

test("native interface mismatch is a configuration error before the callback", async (t) => {
  const dir = temporary(t);
  const module = join(dir, "incompatible.cjs");
  writeFileSync(module, "module.exports = {};\n");
  overrideNative(t, module);
  await assert.rejects(withFileLock(join(dir, "target"), async () => assert.fail("must not run")), NotConfiguredError);
});

test("doctor does not execute an installed native loader; native faults close handles without callbacks", async (t) => {
  const dir = temporary(t);
  const loaded = join(dir, "loaded");
  const closed = join(dir, "closed");
  const module = join(dir, "fault.cjs");
  writeFileSync(module, `
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(loaded)}, 'yes');
    exports.openLock = () => ({});
    exports.tryLock = () => { throw new Error('kernel failure fixture'); };
    exports.closeLock = () => fs.writeFileSync(${JSON.stringify(closed)}, 'yes');
  `);
  overrideNative(t, module);
  assert.match(credentialLockingDetail(), /loadability not probed/);
  assert.equal(existsSync(loaded), false);
  await assert.rejects(withFileLock(join(dir, "target"), async () => assert.fail("must not run")), NotConfiguredError);
  assert.equal(existsSync(loaded), true);
  assert.equal(existsSync(closed), true);
});

test("timeout validation precedes native loading", async (t) => {
  const dir = temporary(t);
  overrideNative(t, join(dir, "missing.node"));
  for (const timeoutMs of [-1, NaN, Infinity]) {
    await assert.rejects(withFileLock(join(dir, "target"), async () => {}, { timeoutMs }), RangeError);
  }
});

test("portable kernel lock is exclusive, retryable, persistent, and released on exceptions", { skip: !supported }, async (t) => {
  const dir = temporary(t);
  const target = join(dir, "target.json");
  let calls = 0;
  await withFileLock(target, async () => {
    calls++;
    await assert.rejects(withFileLock(target, async () => { calls++; }, { timeoutMs: 0 }), (error: unknown) => {
      assert.ok(error instanceof LockTimeoutError);
      assert.equal(error.path, target);
      assert.equal(error.lockPath, lockPathFor(target));
      assert.match(error.message, /Do not delete/);
      return true;
    });
  }, { timeoutMs: 0 });
  assert.equal(calls, 1);
  assert.ok(existsSync(lockPathFor(target)));
  const inode = statSync(lockPathFor(target)).ino;
  await assert.rejects(withFileLock(target, async () => { throw new Error("callback fixture failure"); }), /callback fixture failure/);
  await withFileLock(target, async () => { calls++; });
  assert.equal(calls, 2);
  assert.equal(statSync(lockPathFor(target)).ino, inode);
});

test("portable store mutations serialize read/modify/write without losing entries", { skip: !supported }, async (t) => {
  const dir = temporary(t);
  const store = new CredentialFileStore(join(dir, "credentials.json"));
  await Promise.all(Array.from({ length: 8 }, (_, i) => store.write(`provider-${i}`, { access: "fixture" })));
  assert.equal(store.list().length, 8);
  assert.equal(Object.keys(JSON.parse(readFileSync(store.path, "utf8"))).length, 8);
});

test("native or util-linux lock releases on holder process death", { skip: !supported, timeout: 15_000 }, async (t) => {
  const children: ChildProcess[] = [];
  const dir = temporary(t, children);
  const target = join(dir, "credentials.json");
  const module = new URL("../src/auth/stores.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
    `import {withFileLock} from ${JSON.stringify(module)}; await withFileLock(${JSON.stringify(target)}, async()=>{ console.log('held'); await new Promise(()=>setInterval(()=>{},1000)); });`,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  const [ready] = await once(child.stdout!, "data");
  assert.match(String(ready), /held/);
  await assert.rejects(withFileLock(target, async () => assert.fail("holder still alive"), { timeoutMs: 0 }), LockTimeoutError);
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  await withFileLock(target, async () => {}, { timeoutMs: 5000 });
  assert.ok(existsSync(lockPathFor(target)));
});

test("nonexistent targets behind directory symlinks select the same kernel lock", { skip: process.platform === "win32" || !supported }, async (t) => {
  const dir = temporary(t);
  symlinkSync(dir, join(dir, "alias"));
  const real = join(dir, "missing", "target");
  const alias = join(dir, "alias", "missing", "target");
  assert.equal(lockPathFor(real), lockPathFor(alias));
  await withFileLock(real, async () => {
    await assert.rejects(withFileLock(alias, async () => assert.fail("same target"), { timeoutMs: 0 }), LockTimeoutError);
  });
});

// Opt-in cross-language test: no top-level executable probe or hidden Python
// dependency. Set LM15_LOCK_TEST_PYTHON to the desired Python executable.
test("portable kernel lock and canonical lock name interoperate with Python in both directions", { skip: !supported || !python, timeout: 15_000 }, async (t) => {
  const children: ChildProcess[] = [];
  const dir = temporary(t, children);
  const target = join(dir, "credentials.json");
  writeFileSync(target, "{}");
  const canonical = spawnSync(python!, ["-c", "import os,sys,hashlib; print(hashlib.sha256(os.path.realpath(sys.argv[1]).encode('utf-8')).hexdigest()[:32]+'.lock')", target], { encoding: "utf8" });
  assert.equal(canonical.status, 0, canonical.stderr);
  assert.equal(lockPathFor(target), join(dir, "locks", canonical.stdout.trim()));
  const script = [
    "import os,sys,time",
    "f=open(sys.argv[1], 'a+b')",
    "f.seek(0)",
    "try:",
    " if os.name == 'nt':",
    "  import msvcrt; msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)",
    " else:",
    "  import fcntl; fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)",
    "except OSError: sys.exit(75)",
    "print('held', flush=True)",
    "if len(sys.argv)>2: time.sleep(30)",
  ].join("\n");
  const probe = () => spawnSync(python!, ["-c", script, lockPathFor(target)]).status;
  await withFileLock(target, async () => { assert.equal(probe(), 75); });
  assert.equal(probe(), 0);
  const child = spawn(python!, ["-c", script, lockPathFor(target), "hold"], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  const [ready] = await once(child.stdout!, "data");
  assert.match(String(ready), /held/);
  await assert.rejects(withFileLock(target, async () => assert.fail("Python holds lock"), { timeoutMs: 0 }), LockTimeoutError);
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  await withFileLock(target, async () => {}, { timeoutMs: 5000 });
});
