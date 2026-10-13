import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuditEntrySchema, auditPath } from "../src/auth/audit.js";
import { setUserLimits } from "../src/auth/limits.js";
import { ConfigSchema } from "../src/config.js";
import { KEEP_MS, addUsage, listConversations, readUsage, retentionMs, setRetentionDays, usageToday } from "../src/help/store.js";
import { REFUSAL_WORDS } from "../src/help/turn.js";
import { helpAllowed, helpTurnsOf } from "../src/server/api-help.js";
import { RULES } from "../src/server/permissions.js";
import { startServer } from "../src/server/server.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { freePort } from "./helpers/remote.js";
import { signInAs, type TestSession } from "./helpers/session.js";

let base: string;
let tmp: string;
let saved: string | undefined;
let kc: FakeKeychain;
let started: Awaited<ReturnType<typeof startServer>>;
let admin: TestSession;
let ann: TestSession;
let bob: TestSession;
const QUESTION = "What is a run? zebra-question-text";

async function call(who: TestSession | undefined, method: string, path: string, body?: unknown) {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(who ? who.headers(method) : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  return { status: r.status, text, json: () => JSON.parse(text) };
}
const help = () => started.ctx.config().help;
const auditLines = () => readFileSync(auditPath(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { action: string; by: string; result?: string; target?: string; detail?: string });
const helpLines = () => auditLines().filter((l) => l.action.startsWith("help-"));
async function ask(who: TestSession, question = QUESTION) {
  const r = await call(who, "POST", "/api/help/conversations", { question });
  await helpTurnsOf(started.ctx).idle();
  return r;
}

beforeAll(async () => {
  saved = process.env.FACTORY_HOME;
  tmp = mkdtempSync(join(tmpdir(), "help-governance-"));
  process.env.FACTORY_HOME = join(tmp, "home");
  mkdirSync(process.env.FACTORY_HOME, { recursive: true });
  writeFileSync(join(process.env.FACTORY_HOME, "config.yaml"), "default_model: sonnet\nhelp:\n  enabled: true\n");
  kc = fakeKeychain();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  started = await startServer({ repo: tmp, runsDir: join(tmp, "runs"), port, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, log: () => {} });
  admin = await signInAs(base);
  ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
  bob = await signInAs(base, { name: "Bob", email: "bob@example.com", role: "user" });
});
afterAll(() => {
  started?.close();
  kc.remove();
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("the settings of Ask SCF", () => {
  it("have safe defaults and refuse what is not a setting", () => {
    const c = ConfigSchema.parse({ default_model: "sonnet" }).help;
    expect(c).toMatchObject({ enabled: false });
    expect([c.audience, c.disabled_accounts, c.keep_days]).toEqual([undefined, undefined, undefined]);
    expect(ConfigSchema.parse({ default_model: "sonnet", help: { audience: "admins", disabled_accounts: ["11111111-1111-4111-8111-111111111111"], keep_days: 30 } }).help).toMatchObject({ audience: "admins", keep_days: 30 });
    for (const bad of [{ audience: "nobody" }, { disabled_accounts: ["ann"] }, { keep_days: 0 }, { keep_days: 1.5 }, { keep_days: 4000 }]) expect(ConfigSchema.safeParse({ default_model: "sonnet", help: bad }).success, JSON.stringify(bad)).toBe(false);
  });

  it("the retention period follows the setting, and a wrong value means the default", () => {
    setRetentionDays(7);
    expect(retentionMs()).toBe(7 * 86_400_000);
    for (const bad of [0, -1, 1.5, 4000, "7", undefined, null, Number.NaN]) {
      setRetentionDays(bad);
      expect(retentionMs()).toBe(KEEP_MS);
    }
  });
});

describe("who may ask", () => {
  it("every help call needs a session, and another account's conversation answers like an unknown one on every call that names one", async () => {
    const mine = (await ask(ann)).json().id as string;
    const rules = RULES.filter((r) => r.path.startsWith("help/"));
    expect(rules.length).toBeGreaterThanOrEqual(13);
    for (const rule of rules) {
      const path = `/api/${rule.path.replace(":id", mine)}`;
      const body = rule.method === "GET" || rule.method === "DELETE" ? undefined : rule.path === "help/context" ? { page: "#/runs" } : { question: "Another question?" };
      expect((await call(undefined, rule.method, path, body)).status, `${rule.method} ${rule.path} without a session`).toBe(401);
      if (!rule.path.includes(":id")) continue;
      for (const other of [bob, admin]) {
        const r = await call(other, rule.method, path, body);
        expect(r.status, `${rule.method} ${rule.path} as another account`).toBe(404);
        expect(r.text).not.toContain("zebra-question-text");
      }
      expect((await call(admin, rule.method, `${path}?as=${ann.user.id}`, body)).status, `${rule.method} ${rule.path} in a preview`).toBe(403);
    }
    expect((await call(ann, "GET", "/api/help/usage")).status).toBe(403);
    expect(listConversations(ann.user.id)).toHaveLength(1);
  });

  it("an account that is not in the audience, or is switched off, reads a plain sentence and no model is called", async () => {
    const before = { turns: usageToday(bob.user.id).turns, lines: helpLines().length };
    help().audience = "admins";
    try {
      const r = await ask(bob);
      expect(r.status).toBe(403);
      expect(r.json().error).toBe(REFUSAL_WORDS["not-allowed"]);
      expect((await call(bob, "POST", "/api/help/context", { page: "#/runs" })).status).toBe(403);
      expect((await ask(admin)).status).toBe(202);
    } finally {
      delete help().audience;
    }
    help().disabled_accounts = [bob.user.id];
    try {
      const r = await ask(bob);
      expect(r.status).toBe(403);
      expect(r.json().error).toBe(REFUSAL_WORDS["not-allowed"]);
      // reading, exporting and deleting stay possible
      expect((await call(bob, "GET", "/api/help/conversations")).status).toBe(200);
      expect((await call(bob, "GET", "/api/help/export")).status).toBe(200);
    } finally {
      delete help().disabled_accounts;
    }
    expect(usageToday(bob.user.id).turns).toBe(before.turns);
    expect(listConversations(bob.user.id)).toEqual([]);
    const refused = helpLines().slice(before.lines).filter((l) => l.by === bob.user.id && l.action === "help-ask");
    expect(refused).toEqual([{ time: expect.any(String), by: bob.user.id, action: "help-ask", result: "failed", target: "conversation", detail: "ask; refused: not-allowed" }, { time: expect.any(String), by: bob.user.id, action: "help-ask", result: "failed", target: "conversation", detail: "ask; refused: not-allowed" }]);
  });

  it("an account over its daily turns or its daily budget reads the limit sentence and no model is called", async () => {
    help().turns_per_user_per_day = 1;
    try {
      expect((await ask(bob)).status).toBe(202);
      const turns = usageToday(bob.user.id).turns;
      const r = await ask(bob);
      expect(r.status).toBe(429);
      expect(r.json().error).toBe(REFUSAL_WORDS.limit);
      expect(usageToday(bob.user.id).turns).toBe(turns);
    } finally {
      help().turns_per_user_per_day = 30;
    }
    setUserLimits(bob.user.id, { dailyBudgetUsd: 0.5 }, { by: admin.user.id });
    expect(helpAllowed(started.ctx, { id: bob.user.id, role: "user" })).toBeUndefined();
    addUsage(bob.user.id, { costUsd: 0.6 });
    expect(helpAllowed(started.ctx, { id: bob.user.id, role: "user" })).toBe("limit");
    const turns = usageToday(bob.user.id).turns;
    const r = await ask(bob);
    expect(r.status).toBe(429);
    expect(r.json().error).toBe(REFUSAL_WORDS.limit);
    expect(usageToday(bob.user.id).turns).toBe(turns);
    expect(helpAllowed(started.ctx, { id: ann.user.id, role: "user" })).toBeUndefined();
    expect(helpAllowed(started.ctx, { id: "99999999-9999-4999-8999-999999999999", role: "admin" })).toBe("not-allowed");
    setUserLimits(bob.user.id, null, { by: admin.user.id });
  });
});

describe("the audit lines of Ask SCF", () => {
  it("name the actor, the action, the conversation, the result and the turn, and never a text", async () => {
    const from = helpLines().length;
    const asked = await ask(ann, `${QUESTION} token ghp_${"b".repeat(36)}`);
    expect(asked.status).toBe(202);
    const c = asked.json() as { id: string; messages: { id: string; role: string }[] };
    const turn = c.messages.find((m) => m.role === "assistant")!.id;
    const exported = (await call(ann, "GET", "/api/help/export")).json() as { conversations: { id: string; messages: unknown[] }[]; retention: { keepDays: number } };
    expect(exported.retention.keepDays).toBe(90);
    expect(exported.conversations.map((x) => x.id)).toContain(c.id);
    expect(JSON.stringify(exported)).not.toContain(bob.user.id);
    expect(JSON.stringify(exported)).not.toContain("ghp_");
    expect((await call(ann, "DELETE", `/api/help/conversations/${c.id}`)).status).toBe(200);
    const lines = helpLines().slice(from);
    expect(lines.map((l) => [l.action, l.result, l.target, l.by])).toEqual([["help-ask", "ok", `conversation ${c.id}`, ann.user.id], ["help-export", "ok", "conversations", ann.user.id], ["help-delete", "ok", `conversation ${c.id}`, ann.user.id]]);
    expect(lines[0]!.detail).toBe(`ask; turn ${turn}; try 1`);
    expect(lines[1]!.detail).toMatch(/^\d+ conversation\(s\)$/);
    for (const l of lines) expect(AuditEntrySchema.safeParse(l).success).toBe(true);
    const all = readFileSync(auditPath(), "utf8");
    for (const hidden of ["zebra-question-text", "What is a run", "ghp_", "A run is one"]) expect(all, hidden).not.toContain(hidden);
    // a question that is not valid writes no line
    const n = helpLines().length;
    expect((await call(ann, "POST", "/api/help/conversations", { question: "" })).status).toBe(400);
    expect(helpLines()).toHaveLength(n);
    // an admin reads the lines through the audit log's own call, by action
    const viaApi = await call(admin, "GET", "/api/audit?action=help-ask");
    expect(viaApi.status).toBe(200);
    expect(viaApi.text).not.toContain("zebra-question-text");
    expect((await call(ann, "GET", "/api/audit?action=help-ask")).status).toBe(403);
  });

  it("export gives only the caller's own conversations, for an administrator too", async () => {
    await ask(ann, "Only Ann asks this: zebra-ann-only");
    for (const who of [bob, admin]) expect((await call(who, "GET", "/api/help/export")).text).not.toContain("zebra-ann-only");
    expect((await call(ann, "GET", "/api/help/export")).text).toContain("zebra-ann-only");
    expect((await call(undefined, "GET", "/api/help/export")).status).toBe(401);
  });
});

describe("deleting an account", () => {
  it("removes its conversations and its usage rows; only audit lines without any text stay", async () => {
    expect(listConversations(ann.user.id).length).toBeGreaterThan(0);
    expect((await call(admin, "DELETE", `/api/users/${ann.user.id}`)).status).toBe(200);
    expect(listConversations(ann.user.id)).toEqual([]);
    expect(readFileSync(join(process.env.FACTORY_HOME!, "help.json"), "utf8")).not.toContain("zebra-ann-only");
    const usage = (await call(admin, "GET", "/api/help/usage")).json() as { days: { owner: string; ownerName: string }[] };
    expect(usage.days.filter((d) => d.owner === ann.user.id)).toEqual([]);
    expect(readUsage().some((u) => u.owner === ann.user.id)).toBe(false);
    expect(readFileSync(join(process.env.FACTORY_HOME!, "help.json"), "utf8")).not.toContain(ann.user.id);
    // what stays is the audit log: ids and results, no text
    expect(helpLines().some((l) => l.by === ann.user.id)).toBe(true);
    expect(JSON.stringify(usage)).not.toContain("ann@example.com");
  });
});
