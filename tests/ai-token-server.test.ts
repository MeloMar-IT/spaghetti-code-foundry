import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";

const TOKEN = "tok-" + "Sv4".repeat(10);
const VARS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "FACTORY_HOME"];
const lines: string[] = [];
let saved: Record<string, string | undefined>;
let kc: FakeKeychain;
let tmp: string;
let close: () => void;

describe("a server with the token in the Keychain only", () => {
  beforeAll(async () => {
    saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
    for (const k of VARS) delete process.env[k];
    tmp = mkdtempSync(join(tmpdir(), "ai-token-srv-"));
    process.env.FACTORY_HOME = join(tmp, "home"); // read at import time, so import afterwards
    kc = fakeKeychain();
    const { addItem } = await import("../src/credentials/keychain.js");
    addItem("spaghetti-code-foundry", "claude-oauth-token", TOKEN);
    const { startTestServer } = await import("./helpers/port.js");
    ({ close } = await startTestServer({ repo: tmp, runsDir: join(tmp, "runs"), claudeBin: resolve("tests/fixtures/fake-claude.mjs"), log: (m) => void lines.push(m) }));
  });
  afterAll(() => {
    close?.();
    kc.remove();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it("names the source once at its start, never the value, and hides it", async () => {
    const { redactText } = await import("../src/credentials/redact.js");
    expect(lines.filter((l) => l.startsWith("AI sign-in:"))).toEqual(["AI sign-in: from the keychain"]);
    expect(lines.join("\n")).not.toContain(TOKEN);
    expect(redactText(`x ${TOKEN} y`)).toBe("x [redacted] y");
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});
