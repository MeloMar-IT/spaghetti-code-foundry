import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRepo } from "../src/auth/repos.js";
import { SUGGEST_MAX_COST_USD } from "../src/refinement/architect.js";
import { endArchitectRun, setArchitectRun } from "../src/refinement/store.js";
import { TALK_FIRST_LINE } from "../src/refinement/talk-text.js";
import type { ServerOptions } from "../src/server/server.js";
import { fakeGit, fakeGithub } from "./helpers/fake-github.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { startTestServer } from "./helpers/port.js";
import { signInAs, type TestSession } from "./helpers/session.js";

let base: string;
const TOKEN = ["github", "pat", ""].join("_") + "Zx9".repeat(12);

let gh: ReturnType<typeof fakeGithub>;
let tmp: string;
let kc: FakeKeychain;
let started: Awaited<ReturnType<typeof startTestServer>> | undefined;
let ann: TestSession;
const saved: Record<string, string | undefined> = {};
const ENV = ["FACTORY_HOME", "FAKE_GH_EXPECT_TOKEN", "FAKE_GH_SLEEP", "FAKE_BRIEF", "FAKE_ROUND", "FAKE_GH_ISSUES"];
const opts = (): Omit<ServerOptions, "port"> => ({ repo: tmp, runsDir: join(tmp, "runs"), claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, refinementSweepMs: 3_600_000 });

beforeEach(async () => {
  gh = fakeGithub();
  fakeGit(gh, "https://github.com/acme/app");
  for (const k of ENV) saved[k] = process.env[k];
  tmp = mkdtempSync(join(tmpdir(), "refinement-understand-api-"));
  process.env.FACTORY_HOME = join(tmp, "home");
  process.env.FAKE_GH_EXPECT_TOKEN = TOKEN;
  for (const k of ["FAKE_GH_SLEEP", "FAKE_BRIEF", "FAKE_ROUND", "FAKE_GH_ISSUES"]) delete process.env[k];
  kc = fakeKeychain();
  started = await startTestServer(opts());
  base = started.base;
  await signInAs(base);
  ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
  addRepo(ann.user.id, { url: "acme/app", method: "github-token", token: TOKEN });
});
afterEach(async () => {
  if (!started?.ctx.scheduler.draining) await started?.ctx.scheduler.idle();
  started?.close();
  started = undefined;
  kc.remove();
  gh.restore();
  for (const k of ENV) if (saved[k] === undefined) delete process.env[k];
  rmSync(tmp, { recursive: true, force: true });
});

async function post(path: string, body?: string, headers: Record<string, string> = {}) {
  const r = await fetch(base + path, { method: "POST", headers: { ...headers, ...ann.headers("POST") }, body });
  const text = await r.text();
  return { status: r.status, json: () => JSON.parse(text) };
}
const json = { "content-type": "application/json" };
const get = async (id: string) => (await fetch(`${base}/api/refinement/${id}`, { headers: ann.headers("GET") })).json() as Promise<any>;
const create = async () => (await post("/api/refinement", JSON.stringify({ repo: "acme/app", idea: "Export a report as CSV" }), json)).json().id as string;
const runJson = (runId: string) => JSON.parse(readFileSync(join(tmp, "runs", runId, "run.json"), "utf8"));

describe.each(["round", "understand"])("POST /api/refinement/:id/%s: the body", (route) => {
  // The brief is stored directly: the server in this process reads the same file.
  const withBrief = async () => {
    const id = await create();
    setArchitectRun({ id: ann.user.id, admin: false }, id, "b0");
    endArchitectRun(id, "b0", { brief: { text: "The brief", at: "2026-01-01T00:00:00.000Z" } });
    return id;
  };

  it.runIf(route === "understand")("starts a run without a body", async () => {
    const r = await post(`/api/refinement/${await withBrief()}/${route}`);
    expect(r.status).toBe(202);
    const first = runJson(r.json().architect.runId);
    expect(first.vars).toMatchObject({ ask: route, words: "" });
    expect(first.flowDef.limits.max_cost_usd).toBe(SUGGEST_MAX_COST_USD);
    expect(first.task.split("\n")[0]).toBe(TALK_FIRST_LINE.understand);
  });

  it("passes words simple to the run", async () => {
    const r = await post(`/api/refinement/${await withBrief()}/${route}`, JSON.stringify({ words: "simple" }), json);
    expect(r.status).toBe(202);
    expect(runJson(r.json().architect.runId).vars.words).toBe("simple");
  });

  it.each([
    ["malformed JSON", "{nope", json, 400],
    ["a text body", "words=simple", { "content-type": "text/plain" }, 415],
    ["a body over the limit", JSON.stringify({ words: "x".repeat(1_000_001) }), json, 413],
    ["a word that is not simple", JSON.stringify({ words: "x" }), json, 400],
  ])("refuses %s and submits no run", async (_name, body, headers, status) => {
    const id = await create();
    const r = await post(`/api/refinement/${id}/${route}`, body, headers);
    expect(r.status).toBe(status);
    const s = await get(id);
    expect(s.architect.state).toBe("idle");
    expect(s.log.map((l: any) => l.what)).not.toContain(route === "round" ? "round-started" : "understand-asked");
  });
});
