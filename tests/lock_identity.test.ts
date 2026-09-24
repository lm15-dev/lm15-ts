import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expandHome, lockPathFor, windowsLockIdentityKey } from "../src/auth/stores.ts";

test("store home expansion leaves symlink traversal for the filesystem", () => {
  const home = path.join(os.tmpdir(), "synthetic-home");
  assert.equal(expandHome("~/alias/../credentials.json", home), home + path.sep + "alias/../credentials.json");
});

// No backend/addon is needed. Windows symlink cases require Developer Mode;
// inability to create a link is a test failure, not silent missing coverage.
function temporary(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lm15-lock-identity-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function key(target: string): string { return path.basename(lockPathFor(target)); }

test("existing ordinary path keeps the realpath SHA-256 filename", (t) => {
  const dir = temporary(t);
  const target = path.join(dir, "credentials.json");
  fs.writeFileSync(target, "{}");
  const canonical = fs.realpathSync.native(target);
  const identity = process.platform === "win32" ? windowsLockIdentityKey(canonical) : canonical;
  assert.equal(key(target), createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 32) + ".lock");
});

test("directory aliases share locks for missing leaves and nested missing directories", (t) => {
  const dir = temporary(t);
  const real = path.join(dir, "real");
  const alias = path.join(dir, "alias");
  fs.mkdirSync(real);
  fs.symlinkSync(real, alias, "dir");
  for (const suffix of ["credentials.json", "one/two/credentials.json", "one/./two/../credentials.json"]) {
    assert.equal(key(`${alias}/${suffix}`), key(`${real}/${suffix}`));
  }
  assert.equal(key(`${alias}/one/./two/../credentials.json`), key(`${real}/one/credentials.json`));
  assert.equal(fs.existsSync(path.join(real, "one")), false);
  const before = key(path.join(alias, "credentials.json"));
  fs.writeFileSync(path.join(real, "credentials.json"), "{}");
  assert.equal(key(path.join(alias, "credentials.json")), before);
});

test("dangling credential links, link chains and absolute aliases share one identity", (t) => {
  const dir = temporary(t);
  fs.mkdirSync(path.join(dir, "real"));
  fs.symlinkSync("real/missing/credentials.json", path.join(dir, "dangling"), "file");
  fs.symlinkSync("dangling", path.join(dir, "alias"), "file");
  fs.symlinkSync(path.join(dir, "real/missing/credentials.json"), path.join(dir, "absolute"), "file");
  const expected = key(path.join(dir, "real/missing/credentials.json"));
  for (const alias of ["dangling", "alias", "absolute"]) assert.equal(key(path.join(dir, alias)), expected);
});

test("dotdot is resolved after the link, including a dangling directory target", (t) => {
  const dir = temporary(t);
  fs.mkdirSync(path.join(dir, "real/child"), { recursive: true });
  fs.symlinkSync("real/child", path.join(dir, "alias"), "dir");
  const expected = key(path.join(dir, "real/credentials.json"));
  // Do NOT path.join these suffixes: that erases the case under test.
  assert.equal(key(`${dir}/alias/../credentials.json`), expected);
  assert.equal(key(`${dir}/absent/../alias/./../credentials.json`), expected);
  assert.notEqual(expected, key(path.join(dir, "credentials.json")));
  fs.symlinkSync("real/not-created/child", path.join(dir, "dangling-dir"), "dir");
  assert.equal(key(`${dir}/dangling-dir/../credentials.json`), key(path.join(dir, "real/not-created/credentials.json")));
});

test("relative paths do not collapse symlink/dotdot", (t) => {
  const dir = temporary(t);
  fs.mkdirSync(path.join(dir, "real/child"), { recursive: true });
  fs.symlinkSync("real/child", path.join(dir, "alias"), "dir");
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    assert.equal(key("alias/../credentials.json"), key(path.join(dir, "real/credentials.json")));
  } finally { process.chdir(cwd); }
});

test("home expansion does not normalize a symlink/dotdot suffix", { skip: process.platform === "win32" }, (t) => {
  const dir = temporary(t);
  fs.mkdirSync(path.join(dir, "real/child"), { recursive: true });
  fs.symlinkSync("real/child", path.join(dir, "alias"), "dir");
  const old = process.env["HOME"];
  try {
    process.env["HOME"] = dir;
    assert.equal(key("~/alias/../credentials.json"), key(path.join(dir, "real/credentials.json")));
  } finally {
    if (old === undefined) delete process.env["HOME"];
    else process.env["HOME"] = old;
  }
});

test("loops and non-directory ancestors fail closed", (t) => {
  const dir = temporary(t);
  fs.symlinkSync("loop-b", path.join(dir, "loop-a"), "file");
  fs.symlinkSync("loop-a", path.join(dir, "loop-b"), "file");
  assert.throws(() => key(path.join(dir, "loop-a")), { code: "ELOOP" });
  fs.writeFileSync(path.join(dir, "file"), "{}");
  for (const suffix of ["child", "../credentials.json", "./credentials.json"]) {
    assert.throws(() => key(`${dir}/file/${suffix}`), { code: "ENOTDIR" });
  }
});

test("non-Unicode symlink targets are not hashed with replacement characters", { skip: process.platform === "win32" }, (t) => {
  const dir = temporary(t);
  fs.symlinkSync(Buffer.from([0x66, 0xff]), path.join(dir, "invalid"));
  assert.throws(() => key(path.join(dir, "invalid")), /valid Unicode/);
});

test("Windows canonical-key vectors run on every platform", () => {
  const vectors = [
    [String.raw`C:\Users\MAX\Auth.JSON`, String.raw`c:\users\max\auth.json`],
    [String.raw`\\?\C:\Users\MAX\Auth.JSON`, String.raw`c:\users\max\auth.json`],
    ["C:/Users/MAX/Auth.JSON", String.raw`c:\users\max\auth.json`],
    [String.raw`\\?\UNC\Server\Share\Auth.JSON`, String.raw`\\server\share\auth.json`],
    [String.raw`\\SERVER\SHARE\Auth.JSON`, String.raw`\\server\share\auth.json`],
    ["\\\\?\\UNC\\Server\\Share\\", "\\\\server\\share\\"],
    [String.raw`C:\ÉCOLE\İ\ΟΣ\Auth.JSON`, "c:\\école\\i\u0307\\ος\\auth.json"],
  ] as const;
  for (const [raw, expected] of vectors) assert.equal(windowsLockIdentityKey(raw), expected);
});

test("Windows prefix/case/separator aliases share a missing leaf lock before and after creation", { skip: process.platform !== "win32" }, (t) => {
  const dir = temporary(t);
  const real = path.join(dir, "MixedCase");
  fs.mkdirSync(real);
  const target = path.join(real, "Auth.JSON");
  const expected = key(target);
  assert.equal(key(target.toUpperCase()), expected);
  assert.equal(key("\\\\?\\" + target), expected);
  assert.equal(key(target.replaceAll("\\", "/")), expected);
  fs.writeFileSync(target, "{}");
  assert.equal(key(target.toUpperCase()), expected);
  const unicodeFile = path.join(real, "ΟΣ.json");
  fs.writeFileSync(unicodeFile, "{}");
  assert.equal(key(path.join(real, "οσ.json")), key(unicodeFile));
  // Final sigma: whether the volume's upcase table folds "ς" to "Σ" varies (the
  // GitHub Windows runner's NTFS does not: "ος.json" is another, missing file
  // there). The safety property is never a DIFFERENT lock for what may be the
  // same file: the same lock, or a refusal (a missing non-ASCII name).
  let other: string | undefined;
  try {
    other = key(path.join(real, "ος.json"));
  } catch (error) {
    assert.ok(error instanceof TypeError, String(error));
  }
  if (other !== undefined) assert.equal(other, key(unicodeFile));
});

test("Windows ambiguous missing names and unsupported namespaces fail closed", { skip: process.platform !== "win32" }, (t) => {
  const dir = temporary(t);
  for (const name of ["ΟΣ.json", "οσ.json", "trailing. ", "file:stream", "NUL"]) {
    assert.throws(() => key(path.join(dir, name)), TypeError);
  }
  for (const target of [String.raw`C:relative.json`, String.raw`\\.\NUL`, String.raw`\\?\GLOBALROOT\Device\X`]) {
    assert.throws(() => key(target), TypeError);
  }
});
