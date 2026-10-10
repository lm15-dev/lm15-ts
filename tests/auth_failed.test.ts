// MAP-18: a provider's "this key is not valid" is AuthError, whatever the status
// (lm15-contract spec/auth-failed.json, 2026-10-10).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { AUTH_FAILED_FORMS, googleErrorReasons, isPinnedAuthFailure } from "../src/errors.ts";

const contract = process.env["LM15_CONTRACT_DIR"] ?? fileURLToPath(new URL("../../lm15-contract/", import.meta.url));
const spec = resolvePath(contract, "spec/auth-failed.json");

test("the forms are the contract's, verbatim", { skip: !existsSync(spec) }, () => {
  const forms = (JSON.parse(readFileSync(spec, "utf8")) as { forms: Record<string, unknown>[] }).forms;
  const pinned = forms.map((f) => Object.fromEntries(Object.entries(f).filter(([k]) => k !== "providers" && k !== "evidence")));
  assert.deepEqual(AUTH_FAILED_FORMS.map((f) => ({ ...f })), pinned);
});

test("a reason counts only from a google.rpc.ErrorInfo detail", () => {
  const help = { details: [{ "@type": "type.googleapis.com/google.rpc.Help", reason: "API_KEY_INVALID" }] };
  assert.deepEqual(googleErrorReasons(help), []);
  const info = { details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" }] };
  assert.deepEqual(googleErrorReasons(info), ["API_KEY_INVALID"]);
  assert.equal(isPinnedAuthFailure("INVALID_ARGUMENT", "API key not valid.", googleErrorReasons(help)), false);
  assert.equal(isPinnedAuthFailure("INVALID_ARGUMENT", "anything", googleErrorReasons(info)), true);
});
