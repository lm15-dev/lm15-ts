import assert from "node:assert/strict";
import { inspect } from "node:util";
import test from "node:test";
import { startXaiDeviceLogin } from "../src/auth/stores.ts";

test("AUTH-5: device codes stay usable but are absent from ordinary diagnostics", async (t) => {
  const deviceCode = "fixture-device-code-not-for-logs";
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    device_code: deviceCode,
    user_code: "SHOW-THIS",
    verification_uri: "https://auth.x.ai/activate",
    verification_uri_complete: "https://auth.x.ai/activate?user_code=SHOW-THIS",
    expires_in: 600,
    interval: 5,
  }), { status: 200, headers: { "Content-Type": "application/json" } }));
  const auth = await startXaiDeviceLogin();
  assert.equal(auth.deviceCode, deviceCode);
  assert.equal(auth.userCode, "SHOW-THIS");
  assert.equal(auth.intervalS, 5);
  assert.ok(Object.isFrozen(auth));
  assert.ok(!Object.keys(auth).includes("deviceCode"));
  for (const text of [String(auth), inspect(auth), JSON.stringify(auth), JSON.stringify({ ...auth })]) {
    assert.ok(!text.includes(deviceCode));
    assert.ok(text.includes("SHOW-THIS"));
  }
});
