import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";

test("loadConfig uses the defaults", () => {
  assert.deepEqual(loadConfig({}), { host: "127.0.0.1", port: 8080 });
});

test("loadConfig reads PORT", () => {
  assert.equal(loadConfig({ PORT: "3000" }).port, 3000);
});
