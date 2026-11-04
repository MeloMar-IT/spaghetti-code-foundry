import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// A plugin whose register(api) never finishes must end the process with a message and a failure code, not silently with 0.
// Run in a child process: in the test runner other handles would keep the loop alive and hide the problem.

const SCRIPT = `
const { loadPlugins } = await import(process.env.LOAD_JS);
try {
  await loadPlugins([{ module: process.env.PLUGIN, options: {} }], { blockedDirs: [], timeoutMs: 200 });
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
`;

describe("a plugin that hangs at start", () => {
  it("makes the process exit non-zero and name the plugin", () => {
    const plugin = resolve("tests/fixtures/plugins/hangs.mjs");
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", SCRIPT], {
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, LOAD_JS: pathToFileURL(resolve("dist/plugins/load.js")).href, PLUGIN: plugin },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`plugin "${plugin}"`);
    expect(r.stderr).toContain("did not finish within");
  });
});
