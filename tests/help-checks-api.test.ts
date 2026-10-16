import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { auditPath } from "../src/auth/audit.js";
import { addRepo, getRepo } from "../src/auth/repos.js";
import { updateUser } from "../src/auth/users.js";
import { CHECK_LINES, OFFER_WORDS, OFFERS, checkSources, checkText, type Offer } from "../src/help/actions.js";
import { ReplySchema } from "../src/help/contract.js";
import { MESSAGE_LIMIT, addQuestion, archiveConversation, completeConversation, deleteConversation, finishTurn, getConversation, restoreConversation } from "../src/help/store.js";
import { testRepo } from "../src/server/api-repos.js";
import { guardedHelpAsync } from "../src/server/api-help.js";
import { currentAccount, helpSnapshot } from "../src/server/help-context.js";
import { CheckNotStored, runOffer, type TestFn } from "../src/server/help-evidence.js";
import { fakeGithub } from "./helpers/fake-github.js";
import { fakeGithubApp, type FakeGithubApp } from "./helpers/github-app.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { startTestServer } from "./helpers/port.js";
import { signInAs, type TestSession } from "./helpers/session.js";

const TOKEN = ["github", "pat", ""].join("_") + "Zx9".repeat(12);
const realEnv = process.env; // fakeGithub().restore() swaps in a copy; os.tmpdir() reads the real one
let snapshot: NodeJS.ProcessEnv;
let base: string;
let tmp: string;
let scratch: string;
let runsDir: string;
let saved: string | undefined;
let kc: FakeKeychain;
let fg: ReturnType<typeof fakeGithub>;
let fake: FakeGithubApp;
let started: Awaited<ReturnType<typeof startTestServer>>;
let admin: TestSession;
let admin3: TestSession;
let ann: TestSession;
let bob: TestSession;
let annRepo = "";
let bobRepo = "";

const writeRun = (id: string, owner: string, extra: Record<string, unknown> = {}) => {
  mkdirSync(join(runsDir, id), { recursive: true });
  writeFileSync(join(runsDir, id, "run.json"), JSON.stringify({ runId: id, flow: "deliver", task: "", vars: { github_repo: "acme/app" }, repo: tmp, source: "ui", status: "waiting", runDir: join(runsDir, id), owner, startedAt: "2026-01-01T00:00:00.000Z", history: [], state: { next: null, steps: {}, visits: {} }, ...extra }));
};
const asker = (who: TestSession, role: "admin" | "user" = "user") => ({ id: who.user.id, role });

/** Stores a finished reply with these offers in a new conversation of the owner. */
function keep(owner: TestSession, offers: Offer[]) {
  const turn = addQuestion(owner.user.id, { question: "Why does it wait?" });
  const reply = ReplySchema.parse({ type: "status", summary: "It waits.", explanation: "", certainty: "unverified", evidence: [], recommendations: [], links: [], drafts: [], actions: [], offers });
  finishTurn(turn.conversation.id, { message: turn.reply.id, tries: 1 }, reply);
  return { conversation: turn.conversation.id, message: turn.reply.id };
}
type At = { conversation: string; message: string };
const offerOf = (type: Offer["type"], kind: Offer["subject"]["kind"], id: string): Offer => ({ type, title: OFFERS.find((o) => o.type === type)!.title, evidence: "state-x", subject: { kind, id } });
const messagesOf = (owner: TestSession, at: At) => getConversation(owner.user.id, at.conversation).messages;
const checksOf = (owner: TestSession, at: At) => messagesOf(owner, at).filter((m) => m.role === "check");

/** The test function that counts its calls and then really tests. */
const calls: string[] = [];
const spy: TestFn = (ctx, user, id) => {
  calls.push(id);
  return testRepo(ctx, user, id);
};
/** A test function that waits for `open()`; `begun` settles when it was called. */
function gate(ok = true) {
  let open!: () => void;
  let begin!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  const begun = new Promise<void>((r) => (begin = r));
  const test: TestFn = async () => {
    calls.push("gate");
    begin();
    await wait;
    return { at: new Date().toISOString(), ok, checks: [] };
  };
  return { test, open, begun };
}

/** What the click gives: the result, or the status, the sentence and the audit detail of the refusal. */
async function click(who: TestSession, role: "admin" | "user", at: At, offer = 0, test: TestFn = spy, guard = {}) {
  try {
    return await guardedHelpAsync(started.ctx, () => runOffer(started.ctx, asker(who, role), at.conversation, { message: at.message, offer }, guard, test));
  } catch (e) {
    const s = e as { status?: number; message: string };
    return { status: s.status, message: s.message, ...(e instanceof CheckNotStored ? { detail: e.detail } : {}) };
  }
}
const STALE = { status: 404, message: OFFER_WORDS.stale };
const DENIED = { status: 403, message: OFFER_WORDS.denied };
const lines = () => readFileSync(auditPath(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { action: string; result?: string; detail?: string });
const ghLog = () => fg.ghLog();

async function call(who: TestSession, method: string, path: string, body?: unknown) {
  const r = await fetch(base + path, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...who.headers(method) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, text, json: () => JSON.parse(text) as Record<string, any>, error: () => JSON.parse(text).error as string };
}

beforeAll(async () => {
  snapshot = { ...realEnv };
  saved = process.env.FACTORY_HOME;
  tmp = mkdtempSync(join(tmpdir(), "help-checks-"));
  scratch = mkdtempSync(join(tmpdir(), "help-checks-scratch-"));
  runsDir = join(tmp, "runs");
  process.env.FACTORY_HOME = join(tmp, "home");
  mkdirSync(process.env.FACTORY_HOME, { recursive: true });
  writeFileSync(join(process.env.FACTORY_HOME, "config.yaml"), "default_model: sonnet\nhelp:\n  enabled: true\n");
  kc = fakeKeychain();
  fg = fakeGithub();
  fake = fakeGithubApp();
  Object.assign(process.env, { TMPDIR: scratch, SCF_CONNECT_REMOTE: fg.remote });
  started = await startTestServer({ repo: tmp, runsDir, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, log: () => {} });
  base = started.base;
  admin = await signInAs(base);
  admin3 = await signInAs(base, { name: "Third", email: "admin3@example.com", role: "admin" });
  ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
  bob = await signInAs(base, { name: "Bob", email: "bob@example.com", role: "user" });
  writeRun("run-ann-1", ann.user.id);
  writeRun("run-bob-1", bob.user.id);
  annRepo = addRepo(ann.user.id, "annco/thing", { ownerOk: () => true }).id;
  bobRepo = addRepo(bob.user.id, "bobco/hidden-thing", { ownerOk: () => true }).id;
});
afterAll(() => {
  started?.close();
  fake.restore();
  fg.restore();
  kc.remove();
  process.env = realEnv;
  for (const k of Object.keys(realEnv)) if (!(k in snapshot)) delete realEnv[k];
  Object.assign(realEnv, snapshot);
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  rmSync(scratch, { recursive: true, force: true });
});
afterEach(() => {
  calls.length = 0;
  delete process.env.FAKE_GH_SLEEP;
});

/** Adds questions with finished answers until the conversation has `n` messages. */
function fill(owner: TestSession, at: At, n = MESSAGE_LIMIT) {
  while (messagesOf(owner, at).length + 2 <= n) {
    const t = addQuestion(owner.user.id, { conversation: at.conversation, question: "More?" });
    finishTurn(at.conversation, { message: t.reply.id, tries: 1 }, ReplySchema.parse({ type: "status", summary: "Yes.", explanation: "", certainty: "unverified", evidence: [], recommendations: [], links: [], drafts: [], actions: [], offers: [] }));
  }
}

describe("the route: a check is run, stored and audited", () => {
  const url = (id: string) => `/api/help/conversations/${id}/actions`;
  const send = (who: TestSession, at: At, offer = 0) => call(who, "POST", url(at.conversation), { message: at.message, offer });

  it("refresh-evidence reads the run again and stores the result as a check message", async () => {
    const at = keep(ann, [offerOf("refresh-evidence", "run", "run-ann-1")]);
    const r = await send(ann, at);
    expect(r.status).toBe(200);
    expect(r.json()).toMatchObject({ type: "refresh-evidence", outcome: "read" });
    const last = r.json().conversation.messages.at(-1);
    expect(last).toMatchObject({ role: "check", status: "done", replyTo: at.message });
    expect(last.check).toMatchObject({ type: "refresh-evidence", scope: "user", outcome: "read", subject: { kind: "run", id: "run-ann-1" } });
    expect(last.check.lines).toContain("status: waiting");
    expect(lines().filter((l) => l.action === "help-action").at(-1)).toMatchObject({ result: "ok", detail: "refresh-evidence; read" });
    expect(checksOf(ann, at)).toHaveLength(1);
  });

  it("test-repository tests the connection, saves it on the repository, reads it again and stores the check", async () => {
    const added = await call(ann, "POST", "/api/repos", { url: "https://github.com/acme/chk1", method: "github-token", token: TOKEN });
    expect(added.status).toBe(201);
    const id = added.json().id as string;
    const at = keep(ann, [offerOf("test-repository", "repository", id)]);
    const r = await send(ann, at);
    expect(r.status).toBe(200);
    expect(r.json()).toMatchObject({ type: "test-repository", outcome: "passed" });
    expect(getRepo(id)?.connection?.ok).toBe(true);
    const check = r.json().conversation.messages.at(-1).check;
    expect(check).toMatchObject({ type: "test-repository", outcome: "passed", scope: "user" });
    expect(check.lines.length).toBeLessThanOrEqual(CHECK_LINES);
    expect(lines().filter((l) => l.action === "help-action").at(-1)).toMatchObject({ result: "ok", detail: "test-repository; passed" });
    expect(JSON.stringify(r.json())).not.toContain(TOKEN);
  });

  it("tells the truth when the conversation changes during a real test: 409, the audit line, and the result on the repository", async () => {
    const added = await call(ann, "POST", "/api/repos", { url: "https://github.com/acme/chk2", method: "github-token", token: TOKEN });
    const id = added.json().id as string;
    const at = keep(ann, [offerOf("test-repository", "repository", id)]);
    process.env.FAKE_GH_SLEEP = "1";
    const seen = ghLog().length;
    const pending = send(ann, at);
    await vi.waitFor(() => expect(ghLog().length).toBeGreaterThan(seen));
    archiveConversation(ann.user.id, at.conversation);
    const r = await pending;
    expect([r.status, r.error()]).toEqual([409, checkText.notStored]);
    expect(lines().filter((l) => l.action === "help-action").at(-1)).toMatchObject({ result: "failed", detail: "test-repository; passed; not stored: bad-state" });
    expect(checksOf(ann, at)).toHaveLength(0);
    expect(getRepo(id)?.connection?.ok).toBe(true);
  });

  it("answers 409 with the fixed sentence and writes no audit line when a check is refused before it runs", async () => {
    const at = keep(ann, [offerOf("refresh-evidence", "run", "run-ann-1")]);
    completeConversation(ann.user.id, at.conversation);
    const before = lines().length;
    const r = await send(ann, at);
    expect([r.status, r.error()]).toEqual([409, checkText["bad-state"]]);
    expect(lines().length).toBe(before);
  });
});

describe("the authorization of refresh-evidence", () => {
  const refused = async (who: TestSession, role: "admin" | "user", offer: Offer, expected: { status: number; message: string }) => {
    const at = keep(who, [offer]);
    expect(await click(who, role, at)).toEqual(expected);
    expect(checksOf(who, at)).toHaveLength(0);
    expect(calls).toEqual([]);
  };

  it("reads the run of the account and stores the check with the scope of the role", async () => {
    const at = keep(ann, [offerOf("refresh-evidence", "run", "run-ann-1")]);
    const r = (await click(ann, "user", at)) as { outcome?: string };
    expect(r.outcome).toBe("read");
    expect(checksOf(ann, at)[0]!.check).toMatchObject({ scope: "user", outcome: "read" });
    const as = keep(admin, [offerOf("refresh-evidence", "run", "run-ann-1")]);
    await click(admin, "admin", as);
    expect(checksOf(admin, as)[0]!.check?.scope).toBe("admin");
  });

  it("is stale for the run, repository, queue entry and refinement of another account", async () => {
    await refused(ann, "user", offerOf("refresh-evidence", "run", "run-bob-1"), STALE);
    await refused(ann, "user", offerOf("refresh-evidence", "repository", bobRepo), STALE);
    await refused(ann, "user", offerOf("refresh-evidence", "queue", "run-bob-1"), STALE);
    await refused(ann, "user", offerOf("refresh-evidence", "refinement", "99999999-9999-4999-8999-999999999999"), STALE);
  });

  it("is denied for a user who reads an issue (the board is for administrators)", async () => {
    await refused(ann, "user", offerOf("refresh-evidence", "issue", "acme/app#1"), DENIED);
  });

  it("is denied for an account that is a user now: health, and stale for another account's repository", async () => {
    const at = keep(admin3, [offerOf("refresh-evidence", "health", "health"), offerOf("test-repository", "repository", bobRepo)]);
    await updateUser(admin3.user.id, { role: "user" });
    try {
      expect(await click(admin3, "admin", at, 0)).toEqual(DENIED);
      expect(await click(admin3, "admin", at, 1)).toEqual(STALE);
      expect(checksOf(admin3, at)).toHaveLength(0);
      expect(calls).toEqual([]);
    } finally {
      await updateUser(admin3.user.id, { role: "admin" });
    }
  });
});

describe("the authorization of test-repository", () => {
  it("is stale for the repository of another account, and nothing is contacted", async () => {
    const seen = ghLog();
    const at = keep(ann, [offerOf("test-repository", "repository", bobRepo)]);
    expect(await click(ann, "user", at)).toEqual(STALE);
    expect(calls).toEqual([]);
    expect(ghLog()).toBe(seen);
    expect(checksOf(ann, at)).toHaveLength(0);
  });

  it("answers 409 for a repository without a sign-in, passes the sentence on, and contacts nothing", async () => {
    const seen = ghLog();
    const at = keep(ann, [offerOf("test-repository", "repository", annRepo)]);
    const r = await click(ann, "user", at);
    expect(r).toMatchObject({ status: 409 });
    expect((r as { message: string }).message).toContain("Change authentication");
    expect(ghLog()).toBe(seen);
    expect(getRepo(annRepo)?.connection).toBeUndefined();
    expect(checksOf(ann, at)).toHaveLength(0);
  });

  it("is denied when the user is not on the App allow-list any more, with no call to GitHub", async () => {
    expect((await call(admin, "PUT", "/api/config", { github_app: fake.config() })).status).toBe(200);
    expect((await call(admin, "PUT", `/api/users/${ann.user.id}/app-repos`, { repos: ["acme/*"] })).status).toBe(200);
    const u = "https://github.com/acme/appchk";
    fake.installs.set("acme/appchk", 77);
    const added = await call(ann, "POST", "/api/repos", { url: u, method: "github-app" });
    expect(added.status).toBe(201);
    const id = added.json().id as string;
    expect((await call(admin, "PUT", `/api/users/${ann.user.id}/app-repos`, { repos: [] })).status).toBe(200);
    fake.calls.length = 0;
    const seen = ghLog();
    const at = keep(ann, [offerOf("test-repository", "repository", id)]);
    expect(await click(ann, "user", at)).toEqual(DENIED);
    expect(calls).toEqual([id]);
    expect(fake.calls).toEqual([]);
    expect(ghLog()).toBe(seen);
    expect(getRepo(id)?.connection).toBeUndefined();
    expect(checksOf(ann, at)).toHaveLength(0);
  });
});

describe("refusals before any remote call", () => {
  const offers = () => [offerOf("test-repository", "repository", annRepo)];
  const untouched = (at: At) => {
    expect(calls).toEqual([]);
    expect(checksOf(ann, at)).toHaveLength(0);
  };

  it("refuses a conversation that is completed or archived", async () => {
    const done = keep(ann, offers());
    completeConversation(ann.user.id, done.conversation);
    expect(await click(ann, "user", done)).toEqual({ status: 409, message: checkText["bad-state"] });
    untouched(done);
    const gone = keep(ann, offers());
    archiveConversation(ann.user.id, gone.conversation);
    expect(await click(ann, "user", gone)).toEqual({ status: 409, message: checkText["bad-state"] });
    untouched(gone);
  });

  it("refuses while a reply is pending", async () => {
    const at = keep(ann, offers());
    addQuestion(ann.user.id, { conversation: at.conversation, question: "And?" });
    expect(await click(ann, "user", at)).toEqual({ status: 409, message: checkText.busy });
    untouched(at);
  });

  it("refuses a conversation with no room for one more message", async () => {
    const at = keep(ann, offers());
    fill(ann, at);
    expect(messagesOf(ann, at)).toHaveLength(MESSAGE_LIMIT);
    expect(await click(ann, "user", at)).toEqual({ status: 409, message: checkText.limit });
    untouched(at);
  });

  it("refuses a second check in the conversation while the first one runs, then stores the first", async () => {
    const at = keep(ann, [...offers(), offerOf("refresh-evidence", "run", "run-ann-1")]);
    const g = gate();
    const first = click(ann, "user", at, 0, g.test);
    await g.begun;
    expect(await click(ann, "user", at, 1, spy)).toEqual({ status: 409, message: checkText.running });
    expect(await click(ann, "user", at, 0, spy)).toEqual({ status: 409, message: checkText.running });
    expect(calls).toEqual(["gate"]);
    g.open();
    expect(await first).toMatchObject({ type: "test-repository", outcome: "passed" });
    expect(checksOf(ann, at)).toHaveLength(1);
    // the guard is free again
    expect(await click(ann, "user", at, 1, spy)).toMatchObject({ outcome: "read" });
  });
});

describe("a conversation that changes while the test waits", () => {
  const offers = () => [offerOf("test-repository", "repository", annRepo)];
  /** Starts a check that waits, changes the conversation, lets the test end, and gives the answer. */
  async function interleave(change: (at: At) => void) {
    const at = keep(ann, offers());
    const g = gate();
    const answer = click(ann, "user", at, 0, g.test);
    await g.begun;
    const before = messagesOf(ann, at).length;
    change(at);
    g.open();
    return { at, before, result: await answer };
  }
  const later = (ms: number) => ({ now: () => new Date(Date.now() + ms) });
  const turn = (at: At) => addQuestion(ann.user.id, { conversation: at.conversation, question: "A new question?" });
  const answered = (at: At) => {
    const t = turn(at);
    finishTurn(at.conversation, { message: t.reply.id, tries: 1 }, ReplySchema.parse({ type: "status", summary: "Yes.", explanation: "", certainty: "unverified", evidence: [], recommendations: [], links: [], drafts: [], actions: [], offers: [] }));
  };
  const notStored = (why: string) => ({ status: 409, message: checkText.notStored, detail: `test-repository; passed; not stored: ${why}` });

  it("a question asked during the wait", async () => {
    const { at, before, result } = await interleave((a) => void turn(a));
    expect(result).toEqual(notStored("busy"));
    expect(messagesOf(ann, at)).toHaveLength(before + 2);
    expect(checksOf(ann, at)).toHaveLength(0);
  });

  it("a question that is asked and already answered during the wait", async () => {
    const { at, before, result } = await interleave(answered);
    expect(result).toEqual(notStored("changed"));
    expect(messagesOf(ann, at)).toHaveLength(before + 2);
    expect(checksOf(ann, at)).toHaveLength(0);
  });

  it("an archive during the wait", async () => {
    const { at, before, result } = await interleave((a) => void archiveConversation(ann.user.id, a.conversation));
    expect(result).toEqual(notStored("bad-state"));
    expect(messagesOf(ann, at)).toHaveLength(before);
  });

  it("an archive and a restore during the wait", async () => {
    const { at, before, result } = await interleave((a) => {
      archiveConversation(ann.user.id, a.conversation, later(60_000));
      restoreConversation(ann.user.id, a.conversation, later(120_000));
    });
    expect(result).toEqual(notStored("changed"));
    expect(messagesOf(ann, at)).toHaveLength(before);
  });

  it("filling the conversation to the limit during the wait", async () => {
    const { at, result } = await interleave((a) => fill(ann, a));
    expect(result).toEqual(notStored("changed"));
    expect(messagesOf(ann, at)).toHaveLength(MESSAGE_LIMIT);
    expect(checksOf(ann, at)).toHaveLength(0);
  });

  it("a delete during the wait answers 410 and restores nothing", async () => {
    const { at, result } = await interleave((a) => void deleteConversation(ann.user.id, a.conversation));
    expect(result).toEqual({ status: 410, message: "this conversation was deleted", detail: "test-repository; passed; not stored: deleted" });
    const c = getConversation(ann.user.id, at.conversation);
    expect(c.state).toBe("deleted");
    expect(c.messages).toEqual([]);
  });

  it("a failed test is stored as failed, with the lines of the failed checks", async () => {
    const at = keep(ann, offers());
    const test: TestFn = async () => ({ at: new Date().toISOString(), ok: false, checks: [{ check: "clone", ok: false, code: "no-clone", message: "The repository could not be cloned." }] });
    expect(await click(ann, "user", at, 0, test)).toMatchObject({ outcome: "failed" });
    expect(checksOf(ann, at)[0]!.check?.lines).toContain("Failed: clone: The repository could not be cloned.");
  });
});

describe("values that are too long, and what a later turn gets", () => {
  it("stores a valid check for a run whose text is longer than 300 characters", async () => {
    // the snapshot cuts a text to 300 characters and adds " …", which makes 302
    writeRun("run-long", ann.user.id, { status: "waiting", waiting: { stepId: "approve", message: "please look at the changes and decide ".repeat(30), since: "2026-01-01T00:00:01.000Z" }, history: [{ id: "tests", type: "shell", visit: 1, ok: false, error: "the tests broke because of ".repeat(30), startedAt: "2026-01-01T00:00:01.000Z", durationMs: 5 }] });
    const at = keep(ann, [offerOf("refresh-evidence", "run", "run-long")]);
    const r = await click(ann, "user", at);
    expect((r as { outcome?: string }).outcome).toBe("read");
    const check = checksOf(ann, at)[0]!.check!;
    expect(check.lines.length).toBeGreaterThan(0);
    for (const l of check.lines) expect(l.length).toBeLessThanOrEqual(300);
    expect(check.lines.some((l) => l.startsWith("waitingFor:") && l.endsWith(" …"))).toBe(true);
    expect(check.title.length).toBeLessThanOrEqual(500);
  });

  it("drops a check made as an administrator once the account is a user, and gives it again before", async () => {
    const at = keep(admin3, [offerOf("refresh-evidence", "queue", "queue")]);
    expect(await click(admin3, "admin", at)).toMatchObject({ outcome: "read" });
    const history = () => messagesOf(admin3, at);
    const sources = () => {
      const now = currentAccount(asker(admin3, "admin"))!;
      const role = now.role === "admin" ? "admin" : "user";
      return checkSources(history(), role, (s) => !!helpSnapshot(started.ctx, { id: now.id, role }, s));
    };
    expect(sources()).toHaveLength(1);
    expect(sources()[0]!.excerpt).toContain("waiting:");
    await updateUser(admin3.user.id, { role: "user" });
    try {
      expect(sources()).toEqual([]);
    } finally {
      await updateUser(admin3.user.id, { role: "admin" });
    }
  });

  it("keeps a name that matches a sensitive pattern out of the title, the text and the returned conversation", async () => {
    const id = addRepo(ann.user.id, "secretco/projx-hidden", { ownerOk: () => true }).id;
    const at = keep(ann, [offerOf("refresh-evidence", "repository", id)]);
    const guard = { patterns: ["projx-hidden"] };
    const r = (await click(ann, "user", at, 0, spy, guard)) as { outcome?: string; conversation?: unknown };
    expect(r.outcome).toBe("read");
    const stored = JSON.stringify(messagesOf(ann, at).filter((m) => m.role === "check"));
    expect(stored).not.toContain("projx-hidden");
    expect(JSON.stringify(r)).not.toContain("projx-hidden");
    expect(checksOf(ann, at)[0]!.check!.title.length).toBeGreaterThan(0);
  });

  it("gives a check about something that is gone no source", async () => {
    writeRun("run-soon-gone", ann.user.id);
    const at = keep(ann, [offerOf("refresh-evidence", "run", "run-soon-gone")]);
    expect(await click(ann, "user", at)).toMatchObject({ outcome: "read" });
    rmSync(join(runsDir, "run-soon-gone"), { recursive: true, force: true });
    const visible = (s: { kind: string; id: string }) => !!helpSnapshot(started.ctx, asker(ann), s);
    expect(checkSources(messagesOf(ann, at), "user", visible)).toEqual([]);
  });
});
