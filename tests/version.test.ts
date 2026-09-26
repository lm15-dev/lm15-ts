/** VERSION (User-Agent on sign-in requests, the vet shim's impl_version) is package.json's version. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VERSION } from "../src/version.ts";

test("VERSION equals package.json's version", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(VERSION, pkg.version);
});
