/** Node-only bridge: resolves identically from source, ESM and CJS builds. */
const fs = require("node:fs");
const path = require("node:path");

function credentialLockAddonPath() {
  const override = process.env["LM15_NATIVE_LOCK_PATH"];
  if (override) {
    if (!path.isAbsolute(override)) throw new Error("LM15_NATIVE_LOCK_PATH must be an absolute path");
    return override;
  }
  // Package self-reference, not a lookup relative to the caller's working directory.
  const root = path.dirname(require.resolve("lm15/package.json"));
  return path.join(root, "native", `credential_lock-${process.platform}-${process.arch}.node`);
}

exports.nativeCredentialLockPresent = function () {
  try { return fs.statSync(credentialLockAddonPath()).isFile(); }
  catch { return false; }
};

exports.loadNativeCredentialLock = function () {
  const addon = require(credentialLockAddonPath());
  if (typeof addon !== "object" || addon === null || typeof addon.openLock !== "function" || typeof addon.tryLock !== "function" || typeof addon.closeLock !== "function") {
    throw new Error("credential lock native module has an incompatible interface");
  }
  return addon;
};
