import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_ONLY_KEYS, CERTAINTY_WORDS } from "../src/help/contract.js";
import { FAILURE_WORDS } from "../src/help/store.js";
import { REFUSAL_WORDS } from "../src/help/turn.js";
import { NOT_IN_PREVIEW, helpTurnsOf } from "../src/server/api-help.js";
import { startServer } from "../src/server/server.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { freePort } from "./helpers/remote.js";
import { signInAs, type TestSession } from "./helpers/session.js";

let base: string;
let port: number;
let tmp: string;
let saved: Record<string, string | undefined>;
let kc: FakeKeychain;
let started: Awaited<ReturnType<typeof startServer>> | undefined;
let admin: TestSession;
let ann: TestSession;
let bob: TestSession;
const logs: string[] = [];
const UNKNOWN = "00000000-0000-4000-8000-000000000000";

const boot = async () => {
  started = await startServer({ repo: tmp, runsDir: join(tmp, "runs"), port, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, log: (m) => void logs.push(m) });
};
const settings = (text: string) => writeFileSync(join(process.env.FACTORY_HOME!, "config.yaml"), text);

beforeAll(async () => {
  saved = { home: process.env.FACTORY_HOME, help: process.env.FAKE_HELP, gh: process.env.GH_TOKEN };
  delete process.env.FAKE_HELP;
  tmp = mkdtempSync(join(tmpdir(), "help-turn-api-"));
  process.env.FACTORY_HOME = join(tmp, "home");
  mkdirSync(process.env.FACTORY_HOME, { recursive: true });
  settings("default_model: sonnet\nhelp:\n  enabled: true\n  turns_per_user_per_day: 6\n");
  kc = fakeKeychain();
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  await boot();
  admin = await signInAs(base);
  ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
  bob = await signInAs(base, { name: "Bob", email: "bob@example.com", role: "user" });
});
afterEach(() => {
  delete process.env.FAKE_HELP;
});
afterAll(() => {
  started?.close();
  kc.remove();
  for (const [k, env] of [["home", "FACTORY_HOME"], ["help", "FAKE_HELP"], ["gh", "GH_TOKEN"]] as const) {
    if (saved[k] === undefined) delete process.env[env];
    else process.env[env] = saved[k];
  }
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function call(who: TestSession, method: string, path: string, body?: unknown) {
  const r = await fetch(base + path, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...who.headers(method) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, text, json: () => JSON.parse(text), error: () => JSON.parse(text).error as string };
}
const idle = () => helpTurnsOf(started!.ctx).idle();
const keys = (v: unknown): string[] => (v !== null && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [k, ...keys(x)]) : []);
/** Asks, waits for the turn and returns the conversation as its owner reads it. */
async function asked(who: TestSession, question: string, conversation?: string) {
  const r = await call(who, "POST", conversation ? `/api/help/conversations/${conversation}/messages` : "/api/help/conversations", { question, context: { page: "#/runs" } });
  expect(r.status, r.text).toBe(202);
  await idle();
  return (await call(who, "GET", `/api/help/conversations/${r.json().id}`)).json();
}

describe("asking a question", () => {
  it("answers 202 with the waited-for reply, and the conversation holds the checked answer afterwards", async () => {
    const r = await call(ann, "POST", "/api/help/conversations", { question: "What is a run?", context: { page: "#/runs/r1", kind: "run", id: "r1" } });
    expect(r.status).toBe(202);
    const first = r.json();
    expect(first.messages.map((m: { status: string }) => m.status)).toEqual(["done", "pending"]);
    await idle();
    const c = (await call(ann, "GET", `/api/help/conversations/${first.id}`)).json();
    expect(c.state).toBe("active");
    expect(c.messages[1]).toMatchObject({ status: "done", reply: { summary: "A run is one start of a flow.", certainty: "unverified", links: [{ label: "Runs", to: "#/runs" }], actions: [] } });
    expect(c.messages[1].text).toContain(CERTAINTY_WORDS.unverified);
    // the next question goes into the same conversation
    const more = await asked(ann, "And a flow?", first.id);
    expect(more.messages).toHaveLength(4);
    expect((await call(ann, "GET", "/api/help/conversations")).json().enabled).toBe(true);
  });

  it("refuses a bad question, another account's conversation and a second turn at the same time", async () => {
    expect((await call(ann, "POST", "/api/help/conversations", {})).status).toBe(400);
    expect((await call(ann, "POST", "/api/help/conversations", { question: "x", context: { page: "https://example.com" } })).status).toBe(400);
    const mine = await asked(ann, "What is a flow?");
    for (const who of [bob, admin]) {
      for (const tail of ["messages", "retry", "cancel"]) {
        const r = await call(who, "POST", `/api/help/conversations/${mine.id}/${tail}`, { question: "Let me in" });
        expect(r.status, `${who.user.name} ${tail}`).toBe(404);
        expect(r.text).toBe((await call(who, "POST", `/api/help/conversations/${UNKNOWN}/${tail}`, { question: "Let me in" })).text);
      }
    }
    expect((await call(ann, "POST", `/api/help/conversations/${mine.id}/cancel`)).status).toBe(409);
    expect((await call(ann, "POST", `/api/help/conversations/${mine.id}/retry`)).status).toBe(409);
    expect((await call(ann, "GET", `/api/help/conversations/${mine.id}`)).json().messages).toHaveLength(2);
  });

  it("gives the agent no tools and no GitHub token", async () => {
    process.env.GH_TOKEN = "ghp_secret";
    process.env.FAKE_HELP = "ECHO";
    try {
      const c = await asked(admin, "What is a run?");
      const echo = c.messages[1].reply.explanation as string;
      expect(echo).toMatch(/--tools  /);
      expect(echo).toContain("--strict-mcp-config");
      expect(echo).toContain("--permission-mode dontAsk");
      expect(echo).toMatch(/gh_token=none$/);
    } finally {
      delete process.env.GH_TOKEN;
    }
  });

  it("says a provider at its limit and a provider that fails in plain words, and tries again in the same messages", async () => {
    const quota = await asked(bob, "CLAUDE_LIMIT");
    expect(quota.state).toBe("failed");
    expect(quota.messages[1]).toMatchObject({ status: "failed", text: FAILURE_WORDS.quota, failure: { code: "quota", retry: false } });
    const down = await asked(bob, "CLAUDE_OVERLOADED");
    expect(down.messages[1]).toMatchObject({ text: FAILURE_WORDS.provider, failure: { code: "provider", retry: true } });
    expect(JSON.stringify([quota, down])).not.toMatch(/hit your limit|529|overloaded_error|Amsterdam/);
    const again = await call(bob, "POST", `/api/help/conversations/${down.id}/retry`);
    expect(again.status).toBe(202);
    expect(again.json().messages.map((m: { status: string }) => m.status)).toEqual(["done", "pending"]);
    await idle();
    const after = (await call(bob, "GET", `/api/help/conversations/${down.id}`)).json();
    expect(after.messages).toHaveLength(2);
    expect(after.messages[1]).toMatchObject({ id: down.messages[1].id, status: "failed", tries: 2 });
  });
});

describe("who sees the provider and the usage", () => {
  it("shows a user no model, provider, cost or token count: not in a conversation and not in the list", async () => {
    process.env.FAKE_HELP = JSON.stringify({ summary: "I am sonnet by anthropic and this cost $0.003." });
    const c = await asked(ann, "Which model are you?");
    expect(c.messages[1].reply.summary).toBe("I am the AI model by the AI model and this cost $0.003.");
    const list = (await call(ann, "GET", "/api/help/conversations")).json();
    for (const seen of [c, list]) {
      expect(keys(seen).filter((k) => ADMIN_ONLY_KEYS.includes(k))).toEqual([]);
      expect(JSON.stringify(seen)).not.toMatch(/sonnet|anthropic|costUsd|inputTokens/i);
    }
  });

  it("refuses the usage to a user, and to a view of a user's display", async () => {
    const r = await call(ann, "GET", "/api/help/usage");
    expect(r.status).toBe(403);
    expect(r.text).not.toMatch(/sonnet|anthropic|costUsd/);
    const view = await call(admin, "POST", "/api/admin/view-as", { userId: ann.user.id });
    expect(view.status).toBe(200);
    const through = await call(admin, "GET", `/api/help/usage?as=${ann.user.id}`);
    expect(through.status).toBe(403);
    expect([NOT_IN_PREVIEW, "not allowed for your role"]).toContain(through.error());
    await call(admin, "DELETE", "/api/admin/view-as");
  });

  it("shows an administrator the provider, the limits and the usage per account, without any question or answer", async () => {
    const r = await call(admin, "GET", "/api/help/usage");
    expect(r.status).toBe(200);
    const u = r.json();
    expect(u.enabled).toBe(true);
    expect(u.provider).toEqual({ ok: true, target: "claude:anthropic:sonnet", agent: "claude", provider: "anthropic", model: "sonnet", free: false });
    expect(u.limits).toEqual({ timeoutSeconds: 60, maxParallel: 1, maxQueued: 10, turnsPerUserPerDay: 6, maxCostUsdPerTurn: 0.1, dailyBudgetUsd: null, costLimits: true });
    expect(u.now).toEqual({ running: 0, queued: 0 });
    const row = u.days.find((d: { owner: string }) => d.owner === ann.user.id);
    expect(row).toMatchObject({ ownerName: "Ann", failed: 0 });
    expect(row.turns).toBeGreaterThanOrEqual(3);
    expect(row.costUsd).toBeGreaterThan(0);
    expect(u.days.find((d: { owner: string }) => d.owner === bob.user.id)).toMatchObject({ ownerName: "Bob", turns: 3, failed: 3 });
    expect(u.today.turns).toBe(u.days.reduce((n: number, d: { turns: number }) => n + d.turns, 0));
    expect(r.text).not.toMatch(/What is a run|A run is one start|Which model/);
  });
});

describe("limits and the off switch", () => {
  it("refuses with 429 and a plain sentence when the turns of the day are used", async () => {
    // Bob used 3 of his 6
    for (const q of ["four", "five", "six"]) await asked(bob, q);
    const r = await call(bob, "POST", "/api/help/conversations", { question: "seven" });
    expect(r.status).toBe(429);
    expect(r.error()).toBe(REFUSAL_WORDS.limit);
    expect((await call(admin, "POST", "/api/help/conversations", { question: "The administrator still can" })).status).toBe(202);
    await idle();
  });

  it("refuses every question with 503 while Ask SCF is switched off, and still shows the stored conversations", async () => {
    settings("default_model: codex\n");
    started!.ctx.reloadConfig();
    try {
      const r = await call(ann, "POST", "/api/help/conversations", { question: "Anyone there?" });
      expect(r.status).toBe(503);
      expect(r.error()).toBe(REFUSAL_WORDS.off);
      const list = (await call(ann, "GET", "/api/help/conversations")).json();
      expect(list.enabled).toBe(false);
      expect(list.conversations.length).toBeGreaterThan(0);
      const u = (await call(admin, "GET", "/api/help/usage")).json();
      expect(u.enabled).toBe(false);
      expect(u.provider.ok).toBe(false);
      expect(u.provider.problem).toContain("cannot run without tools");
    } finally {
      settings("default_model: sonnet\nhelp:\n  enabled: true\n");
      started!.ctx.reloadConfig();
    }
  });
});
