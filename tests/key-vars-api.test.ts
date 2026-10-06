import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { resetRedactCache } from "../src/credentials/redact.js";
import { runFlow } from "../src/engine/runner.js";
import { parseFlow } from "../src/flow/load.js";
import { startServer } from "../src/server/server.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { signInAs, type TestSession } from "./helpers/session.js";

const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
const A = "key-var-a-0123456789-abcdef";
const B = "key-var-b-0123456789-ghijkl";
const NAMES = ["KEY_VAR_A_FOR_TEST", "KEY_VAR_B_FOR_TEST", "KEY_VAR_SHORT_FOR_TEST"];
let tmp: string;
let close: () => void;
let kc: FakeKeychain;
let ann: TestSession;
let runId: string;
let saved: Record<string, string | undefined>;
let savedHome: string | undefined;
const logs: string[] = [];

beforeAll(async () => {
  saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
  savedHome = process.env.FACTORY_HOME;
  Object.assign(process.env, { KEY_VAR_A_FOR_TEST: A, KEY_VAR_B_FOR_TEST: B, KEY_VAR_SHORT_FOR_TEST: "abc" });
  tmp = mkdtempSync(join(tmpdir(), "key-vars-api-"));
  process.env.FACTORY_HOME = join(tmp, "home");
  mkdirSync(process.env.FACTORY_HOME, { recursive: true });
  kc = fakeKeychain();
  resetRedactCache();
  // a run record made before the server exists: its files hold the raw values
  const s = await runFlow(parseFlow('name: keys\nworkspace: empty\nsteps:\n  - {id: show, type: shell, run: \'echo "$KEY_VAR_A_FOR_TEST $KEY_VAR_B_FOR_TEST"\'}\n'), {
    task: "t",
    repo: tmp,
    runsDir: join(tmp, "runs"),
    config: ConfigSchema.parse({ protected_branches: [] }),
  });
  runId = s.id;
  writeFileSync(join(process.env.FACTORY_HOME, "config.yaml"), "providers:\n  pa: { kind: anthropic-compatible, base_url: 'http://127.0.0.1:1', api_key_env: KEY_VAR_A_FOR_TEST }\n");
  resetRedactCache(); // the run above knew nothing of the key variables; the server must register them itself
  ({ close } = await startServer({ repo: tmp, runsDir: join(tmp, "runs"), port, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, log: (m) => void logs.push(m) }));
  ann = await signInAs(base);
});
afterAll(() => {
  close();
  kc.remove();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (savedHome === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = savedHome;
  resetRedactCache();
  rmSync(tmp, { recursive: true, force: true });
});

/** The four answers that show a run: the record, the list, a transcript and the event replay. */
async function answers(): Promise<string> {
  const get = async (path: string) => (await fetch(base + path, { headers: ann.headers() })).text();
  const events = await fetch(`${base}/api/runs/${runId}/events`, { headers: ann.headers() });
  const reader = events.body!.getReader();
  let replay = "";
  // a finished run may send nothing at all: give up on a quiet stream
  for (let i = 0; i < 20 && !replay.includes('"status":"succeeded"'); i++) {
    const got = await Promise.race([reader.read(), new Promise<undefined>((r) => setTimeout(() => r(undefined), 1000))]);
    if (!got || got.done) break;
    const { value } = got;
    replay += new TextDecoder().decode(value);
  }
  await reader.cancel();
  return [await get(`/api/runs/${runId}`), await get("/api/runs"), await get(`/api/runs/${runId}/transcript/0`), replay].join("\n");
}

describe("provider key variables in API answers", () => {
  it("hides the key named when the server starts, and only that one", async () => {
    const text = await answers();
    expect(text).toContain("[redacted]");
    expect(text).not.toContain(A);
    expect(text).toContain(B);
  });

  it("hides a key named by a config reload, also in server log lines", async () => {
    const r = await fetch(`${base}/api/config`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...ann.headers("PUT") },
      body: JSON.stringify({ providers: { pa: { kind: "anthropic-compatible", base_url: "http://127.0.0.1:1", api_key_env: "KEY_VAR_A_FOR_TEST" }, pb: { kind: "anthropic-compatible", base_url: "http://127.0.0.1:1", api_key_env: "KEY_VAR_B_FOR_TEST" } } }),
    });
    expect(r.status).toBe(200);
    const text = await answers();
    expect(text).not.toContain(A);
    expect(text).not.toContain(B);
    logs.length = 0;
    // the server's own log passes the same filter
    const { redactText } = await import("../src/credentials/redact.js");
    expect(redactText(`failed with ${B}`)).toBe("failed with [redacted]");
  });

  it("names a key that is too short to hide once, also after another reload", async () => {
    const put = () =>
      fetch(`${base}/api/config`, {
        method: "PUT",
        headers: { "content-type": "application/json", ...ann.headers("PUT") },
        body: JSON.stringify({ providers: { ps: { kind: "anthropic-compatible", base_url: "http://127.0.0.1:1", api_key_env: "KEY_VAR_SHORT_FOR_TEST" } } }),
      });
    expect((await put()).status).toBe(200);
    expect((await put()).status).toBe(200);
    const lines = logs.filter((l) => l.includes("KEY_VAR_SHORT_FOR_TEST"));
    expect(lines).toEqual(["! the key in KEY_VAR_SHORT_FOR_TEST is shorter than 8 characters, so it is not hidden in output"]);
  });
});
