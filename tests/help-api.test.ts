import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_ONLY_KEYS, checkReply } from "../src/help/contract.js";
import { FAILURE_WORDS, addQuestion, failTurn, finishTurn, getConversation, helpPath, type Turn } from "../src/help/store.js";
import { NOT_IN_PREVIEW } from "../src/server/api-help.js";
import { startServer } from "../src/server/server.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { freePort } from "./helpers/remote.js";
import { signInAs, type TestSession } from "./helpers/session.js";

let base: string;
let port: number;
let tmp: string;
let saved: string | undefined;
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

beforeAll(async () => {
  saved = process.env.FACTORY_HOME;
  tmp = mkdtempSync(join(tmpdir(), "help-api-"));
  process.env.FACTORY_HOME = join(tmp, "home");
  kc = fakeKeychain();
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  await boot();
  admin = await signInAs(base);
  ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
  bob = await signInAs(base, { name: "Bob", email: "bob@example.com", role: "user" });
});
afterAll(() => {
  started?.close();
  kc.remove();
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(tmp, { recursive: true, force: true });
});

async function call(who: TestSession, method: string, path: string) {
  const r = await fetch(base + path, { method, headers: who.headers(method) });
  const text = await r.text();
  return { status: r.status, text, json: () => JSON.parse(text), error: () => JSON.parse(text).error as string };
}
const ref = (turn: Turn) => ({ message: turn.reply.id, tries: turn.reply.tries! });
const reply = (summary: string) => checkReply({ summary }, { role: "user" })!.reply;
/** A stored conversation of `who` with one answered question. */
function seeded(who: TestSession, question = "What is a run?"): string {
  const turn = addQuestion(who.user.id, { question, context: { page: "#/runs" } });
  finishTurn(turn.conversation.id, ref(turn), reply("A run is one start of a flow."));
  return turn.conversation.id;
}
const keys = (v: unknown): string[] => (v !== null && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [k, ...keys(x)]) : []);

describe("reading conversations", () => {
  it("lists and reads your own, without the owner and without anything for administrators", async () => {
    const id = seeded(ann);
    const list = (await call(ann, "GET", "/api/help/conversations")).json();
    expect(list.limits).toEqual({ conversations: 100, messages: 100, questionChars: 4000, keepDays: 90, deletedKeepDays: 30 });
    expect(list.conversations.find((c: { id: string }) => c.id === id)).toEqual({ id, title: "What is a run?", state: "active", messages: 2, waiting: false, created: expect.any(String), updated: expect.any(String), expiresOn: expect.any(String) });
    const r = await call(ann, "GET", `/api/help/conversations/${id}`);
    expect(r.status).toBe(200);
    const c = r.json();
    expect(Object.keys(c).sort()).toEqual(["created", "expiresOn", "id", "messages", "state", "title", "updated"]);
    expect(c.messages.map((m: { role: string; status: string }) => `${m.role} ${m.status}`)).toEqual(["user done", "assistant done"]);
    expect(c.messages[0].context).toEqual({ page: "#/runs" });
    expect(c.messages[1].reply.summary).toBe("A run is one start of a flow.");
    expect(c.messages[1].text).toContain("A run is one start of a flow.");
    expect(keys(c).filter((k) => ADMIN_ONLY_KEYS.includes(k) || k === "owner")).toEqual([]);
    expect(r.text).not.toContain(ann.user.id);
  });

  it("gives a user every text of a plan step: instructions, what to expect, the failure signal and the fallback", async () => {
    const turn = addQuestion(ann.user.id, { question: "How do I fix it?" });
    const withPlan = checkReply({
      summary: "Steps.",
      plan: [{ kind: "check", title: "Look at the log", instructions: "Read the last lines.", evidence: [], expected: "You see a copy.", failure: "It is empty.", fallback: "Leave it." }],
    }, { role: "user" })!.reply;
    finishTurn(turn.conversation.id, ref(turn), withPlan);
    const c = (await call(ann, "GET", `/api/help/conversations/${turn.conversation.id}`)).json();
    expect(c.messages[1].reply.plan[0]).toMatchObject({ kind: "check", instructions: "Read the last lines.", expected: "You see a copy.", failure: "It is empty.", fallback: "Leave it." });
  });

  it("answers another account's conversation exactly like an unknown one, to a user and to an administrator", async () => {
    const id = seeded(ann, "Ann's private question");
    const before = readFileSync(helpPath(), "utf8");
    for (const who of [bob, admin]) {
      expect((await call(who, "GET", "/api/help/conversations")).json().conversations).toEqual([]);
      expect((await call(who, "GET", "/api/help/conversations?archived=1")).json().conversations).toEqual([]);
      const calls: [string, string][] = [["GET", ""], ["DELETE", ""], ["POST", "/complete"], ["POST", "/archive"], ["POST", "/restore"]];
      for (const [method, tail] of calls) {
        const theirs = await call(who, method, `/api/help/conversations/${id}${tail}`);
        const unknown = await call(who, method, `/api/help/conversations/${UNKNOWN}${tail}`);
        expect(theirs.status, `${who.user.name} ${method} ${tail}`).toBe(404);
        expect(theirs.text).toBe(unknown.text);
        expect(theirs.text).not.toContain("private");
      }
    }
    expect(readFileSync(helpPath(), "utf8")).toBe(before);
    expect((await call(ann, "GET", `/api/help/conversations/${id}`)).status).toBe(200);
  });

  it("shows nothing in an administrator's view of a user's display", async () => {
    const id = seeded(ann);
    const view = await fetch(`${base}/api/admin/view-as`, { method: "POST", headers: { "content-type": "application/json", ...admin.headers("POST") }, body: JSON.stringify({ userId: ann.user.id }) });
    expect(view.status).toBe(200);
    // the view is running: the user's own runs are shown, the conversations are not
    expect((await call(admin, "GET", `/api/runs?as=${ann.user.id}`)).status).toBe(200);
    for (const path of ["/api/help/conversations", `/api/help/conversations/${id}`]) {
      const r = await call(admin, "GET", `${path}?as=${ann.user.id}`);
      expect(r.status, path).toBe(403);
      expect(r.error()).toBe(NOT_IN_PREVIEW);
      expect(r.text).not.toContain("What is a run?");
    }
    expect((await call(admin, "DELETE", "/api/admin/view-as")).status).toBe(200);
  });

  it("needs a session", async () => {
    expect((await fetch(`${base}/api/help/conversations`)).status).toBe(401);
  });
});

describe("changing conversations", () => {
  it("completes, archives, restores and deletes, and says 409 with a reason for a wrong state", async () => {
    const id = seeded(ann);
    const post = (act: string) => call(ann, "POST", `/api/help/conversations/${id}/${act}`);
    expect((await post("restore")).status).toBe(409);
    expect((await post("complete")).json().state).toBe("completed");
    const archived = (await post("archive")).json();
    expect(archived).toMatchObject({ state: "archived", stateBefore: "completed" });
    expect((await call(ann, "GET", "/api/help/conversations")).json().conversations.some((c: { id: string }) => c.id === id)).toBe(false);
    expect((await call(ann, "GET", "/api/help/conversations?archived=1")).json().conversations.map((c: { id: string }) => c.id)).toContain(id);
    const complete = await post("complete");
    expect(complete.status).toBe(409);
    expect(complete.error()).toBe("restore the conversation first");
    expect((await post("restore")).json().state).toBe("completed");
    expect((await post("nonsense")).status).toBe(404);

    const gone = await call(ann, "DELETE", `/api/help/conversations/${id}`);
    expect(gone.status).toBe(200);
    expect(gone.json()).toEqual({ id, title: "", state: "deleted", deletedAt: expect.any(String), deletedBy: "owner", messages: [], created: expect.any(String), updated: expect.any(String) });
    expect(readFileSync(helpPath(), "utf8")).not.toContain(`"${id}",\n      "owner": "${ann.user.id}",\n      "title": "What`);
    for (const [method, tail] of [["GET", ""], ["DELETE", ""], ["POST", "/restore"], ["POST", "/archive"]] as const) {
      const r = await call(ann, method, `/api/help/conversations/${id}${tail}`);
      expect(r.status, `${method} ${tail}`).toBe(410);
      expect(r.error()).toBe("this conversation was deleted");
    }
    expect((await call(bob, "GET", `/api/help/conversations/${id}`)).status).toBe(404);
  });

  it("wants the CSRF token for a change", async () => {
    const id = seeded(ann);
    const r = await fetch(`${base}/api/help/conversations/${id}`, { method: "DELETE", headers: { cookie: ann.cookie } });
    expect(r.status).toBe(403);
    expect(getConversation(ann.user.id, id).state).toBe("active");
  });
});

describe("the server and the file", () => {
  it("marks a reply that a stopped server left unfinished as interrupted, at its start", async () => {
    const waiting = addQuestion(ann.user.id, { question: "Will this survive a restart?" });
    const failed = addQuestion(bob.user.id, { question: "Already failed" });
    failTurn(failed.conversation.id, ref(failed), { code: "timeout", retry: true });
    started!.close();
    await boot();
    const c = (await call(ann, "GET", `/api/help/conversations/${waiting.conversation.id}`)).json();
    expect(c.state).toBe("failed");
    expect(c.messages[1]).toMatchObject({ id: waiting.reply.id, status: "failed", failure: { code: "interrupted", retry: true }, text: FAILURE_WORDS.interrupted });
    expect(getConversation(bob.user.id, failed.conversation.id).messages[1]!.failure!.code).toBe("timeout");
  });

  it("answers a plain 500 and logs only the file name and the kind when the file is broken", async () => {
    const good = readFileSync(helpPath(), "utf8");
    writeFileSync(helpPath(), `{"version":1,"conversations":[{"title":"a private title"`);
    try {
      logs.length = 0;
      for (const who of [ann, admin]) {
        const r = await call(who, "GET", "/api/help/conversations");
        expect(r.status).toBe(500);
        expect(r.error()).toBe("Ask SCF is not working; see the server log");
      }
      expect((await call(ann, "DELETE", `/api/help/conversations/${UNKNOWN}`)).status).toBe(500);
      expect(logs.filter((l) => l.includes("help"))).toEqual(["help: help.json not-json", "help: help.json not-json", "help: help.json not-json"]);
      expect(logs.join("\n")).not.toContain("private");
    } finally {
      writeFileSync(helpPath(), good);
    }
    expect((await call(ann, "GET", "/api/help/conversations")).status).toBe(200);
  });
});
