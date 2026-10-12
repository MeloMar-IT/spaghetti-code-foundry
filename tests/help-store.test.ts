import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StoreError } from "../src/auth/store.js";
import { createUser, deleteUser, listUsers, usersPath } from "../src/auth/users.js";
import { checkReply, type Reply } from "../src/help/contract.js";
import { jsonFiles } from "../src/home-migrate.js";
import {
  CANCELLED_WORDS,
  CONVERSATION_LIMIT,
  DELETED_KEEP_MS,
  FAILURE_CODES,
  FAILURE_WORDS,
  HelpError,
  KEEP_MS,
  MESSAGE_LIMIT,
  QUESTION_MAX,
  addQuestion,
  archiveConversation,
  cancelTurn,
  checkContext,
  checkQuestion,
  completeConversation,
  deleteConversation,
  failTurn,
  finishTurn,
  getConversation,
  helpPath,
  listConversations,
  restoreConversation,
  retryTurn,
  settleInterrupted,
  sweepHelp,
  type Turn,
} from "../src/help/store.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";

const ANN = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const UNKNOWN = "00000000-0000-4000-8000-000000000000";
let home: string;
let saved: string | undefined;
let t: number;
const now = () => new Date(t);
const at = { now };
const DAY = 86_400_000;

beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "help-store-"));
  process.env.FACTORY_HOME = home;
  t = Date.parse("2026-03-01T10:00:00.000Z");
});
afterEach(() => {
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return e instanceof HelpError ? e.code : `other: ${(e as Error).message}`;
  }
  return undefined;
};
const reply = (summary = "A run is one start of a flow."): Reply => checkReply({ summary, drafts: [{ title: "Comment", text: "secret plan" }] }, { role: "user" })!.reply;
const ref = (turn: Turn) => ({ message: turn.reply.id, tries: turn.reply.tries! });
const ask = (owner = ANN, conversation?: string, question = "What is a run?") => addQuestion(owner, { conversation, question, context: { page: "#/runs/r1", kind: "run", id: "r1" } }, at);
const raw = () => readFileSync(helpPath(), "utf8");

describe("a conversation and its messages", () => {
  it("stores a question and the reply that is waited for, with stable ids, times and the page context", () => {
    const turn = ask();
    expect(turn.conversation).toMatchObject({ owner: ANN, title: "What is a run?", state: "active", created: "2026-03-01T10:00:00.000Z" });
    expect(turn.question).toMatchObject({ role: "user", status: "done", text: "What is a run?", context: { page: "#/runs/r1", kind: "run", id: "r1" } });
    expect(turn.reply).toMatchObject({ role: "assistant", status: "pending", text: "", replyTo: turn.question.id, tries: 1 });
    t += 1000;
    const done = finishTurn(turn.conversation.id, ref(turn), reply(), at)!;
    expect(done.messages.map((m) => m.id)).toEqual([turn.question.id, turn.reply.id]);
    expect(done.messages[1]).toMatchObject({ status: "done", updated: "2026-03-01T10:00:01.000Z" });
    expect(getConversation(ANN, done.id, at)).toEqual(done);
    expect(statSync(helpPath()).mode & 0o777).toBe(0o600);
    expect(readdirSync(home).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps the structured reply apart from the text a person reads, and writes that text itself", () => {
    const turn = ask();
    const r = reply();
    const m = finishTurn(turn.conversation.id, ref(turn), r, at)!.messages[1]!;
    expect(m.reply).toEqual(r);
    expect(m.reply!.evidence).toEqual([]);
    expect(m.reply!.actions).toEqual([]);
    expect(m.text).toContain("A run is one start of a flow.");
    expect(m.text).toContain("Draft (not sent): Comment");
    expect(m.text).toContain("could not check");
    // a reply that did not pass the contract's check is not stored
    expect(() => finishTurn(turn.conversation.id, ref(turn), { ...r, actions: [{ id: "x" }] } as unknown as Reply, at)).toThrow();
    expect(() => finishTurn(turn.conversation.id, ref(turn), { ...r, evidence: [{ id: "S1", kind: "state", title: "t", ref: "r" }] } as unknown as Reply, at)).toThrow();
  });

  it("goes on in the same conversation, and not while a reply is waited for", () => {
    const first = ask();
    expect(code(() => ask(ANN, first.conversation.id, "And a flow?"))).toBe("busy");
    finishTurn(first.conversation.id, ref(first), reply(), at);
    const second = ask(ANN, first.conversation.id, "And a flow?");
    expect(second.conversation.messages).toHaveLength(4);
    expect(second.conversation.title).toBe("What is a run?");
    expect(listConversations(ANN, at)).toHaveLength(1);
  });

  it("checks the question and the page context", () => {
    expect(checkQuestion("  hi\r\nthere  ")).toBe("hi\nthere");
    for (const bad of [undefined, 5, "", "   ", "a\u0000b", "x".repeat(QUESTION_MAX + 1)]) expect(code(() => checkQuestion(bad)), JSON.stringify(bad)?.slice(0, 20)).toBe("bad-question");
    expect(checkContext(undefined)).toBeUndefined();
    expect(checkContext({ page: "#/repos" })).toEqual({ page: "#/repos" });
    for (const bad of ["#/runs", { page: "https://example.com" }, { page: "#/runs?q=secret" }, { page: "#/runs", kind: "run" }, { page: "#/runs", kind: "user", id: "1" }, { page: "#/runs", html: "<b>" }, { page: "#/runs", kind: "run", id: "a\nb" }]) {
      expect(code(() => checkContext(bad)), JSON.stringify(bad)).toBe("bad-context");
    }
    expect(existsSync(helpPath())).toBe(false);
  });

  it("stops at the limits", () => {
    for (let i = 0; i < CONVERSATION_LIMIT; i++) ask(ANN, undefined, `q${i}`);
    expect(code(() => ask())).toBe("limit");
    expect(ask(BOB).conversation.owner).toBe(BOB);
    const c = listConversations(ANN, at)[0]!;
    deleteConversation(ANN, c.id, at);
    let turn = ask();
    for (let i = 2; i < MESSAGE_LIMIT; i += 2) {
      finishTurn(turn.conversation.id, ref(turn), reply(), at);
      turn = ask(ANN, turn.conversation.id);
    }
    finishTurn(turn.conversation.id, ref(turn), reply(), at);
    expect(getConversation(ANN, turn.conversation.id, at).messages).toHaveLength(MESSAGE_LIMIT);
    expect(code(() => ask(ANN, turn.conversation.id))).toBe("limit");
  });
});

describe("whose conversation it is", () => {
  it("gives an account only its own: another account's id is like an unknown one, for every call", () => {
    const turn = ask(ANN);
    const id = turn.conversation.id;
    finishTurn(id, ref(turn), reply(), at);
    expect(listConversations(BOB, at)).toEqual([]);
    const before = raw();
    const calls: [string, () => unknown][] = [
      ["get", () => getConversation(BOB, id, at)],
      ["ask", () => ask(BOB, id)],
      ["retry", () => retryTurn(BOB, id, at)],
      ["cancel", () => cancelTurn(BOB, id, at)],
      ["complete", () => completeConversation(BOB, id, at)],
      ["archive", () => archiveConversation(BOB, id, at)],
      ["restore", () => restoreConversation(BOB, id, at)],
      ["delete", () => deleteConversation(BOB, id, at)],
    ];
    for (const [name, fn] of calls) {
      expect(code(fn), name).toBe("not-found");
      expect(code(() => (name === "get" ? getConversation(BOB, UNKNOWN, at) : fn())), name).toBe("not-found");
    }
    expect(raw()).toBe(before);
    expect(getConversation(ANN, id, at).messages).toHaveLength(2);
  });

  it("removes every conversation of a deleted account, and leaves the others", async () => {
    const kc: FakeKeychain = fakeKeychain();
    try {
      await createUser({ name: "Root", email: "root@example.com", password: "test-password-12345", role: "admin" });
      const ann = await createUser({ name: "Ann", email: "ann@example.com", password: "test-password-12345" });
      const bob = await createUser({ name: "Bob", email: "bob@example.com", password: "test-password-12345" });
      // an install that never used Ask SCF: deleting an account makes no help file
      const cy = await createUser({ name: "Cy", email: "cy@example.com", password: "test-password-12345" });
      deleteUser(cy.id);
      expect(existsSync(helpPath())).toBe(false);
      ask(ann.id);
      deleteConversation(ann.id, ask(ann.id).conversation.id, at);
      const kept = ask(bob.id).conversation.id;
      // a help file that cannot be read stops the delete before anything changes
      const good = raw();
      const users = readFileSync(usersPath());
      writeFileSync(helpPath(), "not json");
      expect(() => deleteUser(ann.id)).toThrow(StoreError);
      expect(readFileSync(usersPath())).toEqual(users);
      writeFileSync(helpPath(), good);
      deleteUser(ann.id);
      expect(raw()).not.toContain(ann.id);
      expect(JSON.parse(raw()).conversations.map((c: { id: string }) => c.id)).toEqual([kept]);
      expect(listUsers().map((u) => u.id)).not.toContain(ann.id);
    } finally {
      kc.remove();
    }
  });
});

describe("a turn that fails or is interrupted", () => {
  it("is tried again in the same two messages: nothing is added", () => {
    const turn = ask();
    const id = turn.conversation.id;
    t += 1000;
    const failed = failTurn(id, ref(turn), { code: "timeout", retry: true }, at)!;
    expect(failed.state).toBe("failed");
    expect(failed.messages[1]).toMatchObject({ status: "failed", failure: { code: "timeout", retry: true }, text: FAILURE_WORDS.timeout });
    t += 1000;
    const again = retryTurn(ANN, id, at);
    expect(again.conversation.state).toBe("active");
    expect(again.conversation.messages.map((m) => m.id)).toEqual([turn.question.id, turn.reply.id]);
    expect(again.question).toEqual(turn.question);
    expect(again.reply).toMatchObject({ id: turn.reply.id, status: "pending", text: "", tries: 2 });
    expect(again.reply.failure).toBeUndefined();
    expect(code(() => retryTurn(ANN, id, at))).toBe("busy");
    const done = finishTurn(id, ref(again), reply(), at)!;
    expect(done.messages).toHaveLength(2);
    expect(done.messages[1]).toMatchObject({ status: "done", tries: 2 });
    expect(code(() => retryTurn(ANN, id, at))).toBe("bad-state");
  });

  it("never stores the result of an earlier try, of a stopped turn or of a turn that is gone", () => {
    const turn = ask();
    const id = turn.conversation.id;
    const stopped = cancelTurn(ANN, id, at);
    expect(stopped.message).toBe(turn.reply.id);
    expect(stopped.conversation.state).toBe("cancelled");
    expect(stopped.conversation.messages[1]).toMatchObject({ status: "cancelled", text: CANCELLED_WORDS });
    expect(code(() => cancelTurn(ANN, id, at))).toBe("bad-state");
    let before = raw();
    expect(finishTurn(id, ref(turn), reply("late"), at)).toBeUndefined();
    expect(failTurn(id, ref(turn), { code: "provider", retry: true }, at)).toBeUndefined();
    expect(raw()).toBe(before);
    const again = retryTurn(ANN, id, at);
    before = raw();
    // the first try ends only now: its result is for try 1, and try 2 is the one that is waited for
    expect(finishTurn(id, ref(turn), reply("late"), at)).toBeUndefined();
    expect(raw()).toBe(before);
    expect(finishTurn(id, ref(again), reply("in time"), at)!.messages[1]!.text).toContain("in time");
    expect(finishTurn(UNKNOWN, ref(again), reply(), at)).toBeUndefined();
  });

  it("marks what a stopped server left unfinished as interrupted, and that can be tried again", () => {
    const one = ask(ANN, undefined, "one");
    const two = ask(BOB, undefined, "two");
    const three = ask(ANN, undefined, "three");
    finishTurn(three.conversation.id, ref(three), reply(), at);
    expect(settleInterrupted(new Set([two.reply.id]), at)).toBe(1);
    expect(getConversation(ANN, one.conversation.id, at)).toMatchObject({ state: "failed", messages: [{}, { status: "failed", failure: { code: "interrupted", retry: true }, text: FAILURE_WORDS.interrupted }] });
    expect(getConversation(BOB, two.conversation.id, at).messages[1]!.status).toBe("pending");
    expect(getConversation(ANN, three.conversation.id, at).state).toBe("active");
    const before = raw();
    expect(settleInterrupted(new Set([two.reply.id]), at)).toBe(0);
    expect(raw()).toBe(before);
    expect(settleInterrupted(new Set(), at)).toBe(1);
    expect(retryTurn(ANN, one.conversation.id, at).conversation.messages).toHaveLength(2);
  });

  it("goes on with a new question after a failure, and has a plain sentence for every reason", () => {
    const turn = ask();
    failTurn(turn.conversation.id, ref(turn), { code: "quota", retry: false }, at);
    const next = ask(ANN, turn.conversation.id, "Another one");
    expect(next.conversation.state).toBe("active");
    expect(next.conversation.messages.map((m) => m.status)).toEqual(["done", "failed", "done", "pending"]);
    for (const c of FAILURE_CODES) {
      expect(FAILURE_WORDS[c], c).toMatch(/^[A-Z].*\.$/);
      expect(FAILURE_WORDS[c], c).not.toMatch(/claude|codex|anthropic|openai|model|\$|token|429|5\d\d/i);
    }
  });
});

describe("the states of a conversation", () => {
  it("completes, archives and restores, and takes no question while completed or archived", () => {
    const turn = ask();
    const id = turn.conversation.id;
    expect(code(() => completeConversation(ANN, id, at))).toBe("busy");
    expect(code(() => archiveConversation(ANN, id, at))).toBe("busy");
    finishTurn(id, ref(turn), reply(), at);
    expect(completeConversation(ANN, id, at).state).toBe("completed");
    expect(completeConversation(ANN, id, at).state).toBe("completed");
    expect(code(() => ask(ANN, id))).toBe("bad-state");
    expect(code(() => restoreConversation(ANN, id, at))).toBe("bad-state");
    expect(archiveConversation(ANN, id, at)).toMatchObject({ state: "archived", stateBefore: "completed" });
    expect(listConversations(ANN, at)).toEqual([]);
    expect(listConversations(ANN, { ...at, archived: true }).map((c) => c.id)).toEqual([id]);
    expect(code(() => ask(ANN, id))).toBe("bad-state");
    expect(code(() => completeConversation(ANN, id, at))).toBe("bad-state");
    const back = restoreConversation(ANN, id, at);
    expect(back.state).toBe("completed");
    expect(back.stateBefore).toBeUndefined();
    expect(back.messages).toHaveLength(2);
  });

  it("keeps a failed turn through the archive, so it can still be tried again", () => {
    const turn = ask();
    const id = turn.conversation.id;
    failTurn(id, ref(turn), { code: "provider", retry: true }, at);
    expect(archiveConversation(ANN, id, at).stateBefore).toBe("failed");
    expect(code(() => retryTurn(ANN, id, at))).toBe("bad-state");
    expect(restoreConversation(ANN, id, at).state).toBe("failed");
    expect(retryTurn(ANN, id, at).reply.tries).toBe(2);
  });
});

describe("deleting and expiring", () => {
  it("removes the title, the messages and their context at once, and keeps only an empty record", () => {
    const turn = ask(ANN, undefined, "Why did my run r1 for the client fail?");
    const id = turn.conversation.id;
    finishTurn(id, ref(turn), reply("It failed at the tests."), at);
    const other = addQuestion(BOB, { question: "Bob's question", context: { page: "#/repos" } }, at).conversation.id;
    t += 1000;
    const gone = deleteConversation(ANN, id, at);
    expect(gone.pending).toBeUndefined();
    expect(gone.conversation).toEqual({ id, owner: ANN, title: "", state: "deleted", deletedAt: "2026-03-01T10:00:01.000Z", deletedBy: "owner", messages: [], created: "2026-03-01T10:00:00.000Z", updated: "2026-03-01T10:00:01.000Z" });
    for (const word of ["client", "It failed", "secret plan", "#/runs/r1", turn.question.id]) expect(raw(), word).not.toContain(word);
    expect(raw()).toContain("Bob's question");
    expect(listConversations(ANN, at)).toEqual([]);
    expect(listConversations(ANN, { ...at, archived: true })).toEqual([]);
    expect(getConversation(ANN, id, at).state).toBe("deleted");
    for (const fn of [() => ask(ANN, id), () => retryTurn(ANN, id, at), () => restoreConversation(ANN, id, at), () => archiveConversation(ANN, id, at), () => deleteConversation(ANN, id, at)]) expect(code(fn)).toBe("deleted");
    expect(code(() => getConversation(BOB, id, at))).toBe("not-found");
    expect(getConversation(BOB, other, at).messages).toHaveLength(2);
  });

  it("stops the turn of a deleted conversation: its late reply is not stored", () => {
    const turn = ask();
    const id = turn.conversation.id;
    expect(deleteConversation(ANN, id, at).pending).toBe(turn.reply.id);
    const before = raw();
    expect(finishTurn(id, ref(turn), reply("late and private"), at)).toBeUndefined();
    expect(failTurn(id, ref(turn), { code: "timeout", retry: true }, at)).toBeUndefined();
    expect(raw()).toBe(before);
  });

  it("removes the empty record after 30 days", () => {
    const id = ask().conversation.id;
    deleteConversation(ANN, id, at);
    t += DELETED_KEEP_MS - 1;
    expect(sweepHelp(at)).toEqual({ expired: 0, removed: 0 });
    expect(getConversation(ANN, id, at).state).toBe("deleted");
    t += 1;
    expect(code(() => getConversation(ANN, id, at))).toBe("not-found");
    expect(sweepHelp(at)).toEqual({ expired: 0, removed: 1 });
    expect(JSON.parse(raw()).conversations).toEqual([]);
  });

  it("expires a conversation that was not changed for 90 days, also before the sweep ran", () => {
    const turn = ask(ANN, undefined, "An old question");
    const id = turn.conversation.id;
    finishTurn(id, ref(turn), reply(), at);
    archiveConversation(ANN, id, at);
    const fresh = ask(BOB, undefined, "A new one");
    t += KEEP_MS - 1;
    expect(getConversation(ANN, id, at).state).toBe("archived");
    finishTurn(fresh.conversation.id, ref(fresh), reply(), at);
    t += 1;
    // read: already gone, though the file still holds it
    expect(raw()).toContain("An old question");
    expect(getConversation(ANN, id, at)).toMatchObject({ state: "deleted", deletedBy: "expired", title: "", messages: [] });
    expect(listConversations(ANN, { ...at, archived: true })).toEqual([]);
    expect(code(() => restoreConversation(ANN, id, at))).toBe("deleted");
    expect(sweepHelp(at)).toEqual({ expired: 1, removed: 0 });
    expect(raw()).not.toContain("An old question");
    expect(raw()).toContain("A new one");
    expect(sweepHelp(at)).toEqual({ expired: 0, removed: 0 });
    t += DELETED_KEEP_MS;
    expect(sweepHelp(at).removed).toBe(1);
    expect(getConversation(BOB, fresh.conversation.id, at).state).toBe("active");
  });

  it("wipes what expired on any write, so no old text rides along", () => {
    ask(ANN, undefined, "An old question");
    t += KEEP_MS + DAY;
    ask(BOB, undefined, "A new one");
    expect(raw()).not.toContain("An old question");
  });
});

describe("the file, older installs and newer versions", () => {
  // What the first version of the store wrote: the fields it had, and nothing more.
  const FIRST = {
    version: 1,
    conversations: [
      {
        id: "33333333-3333-4333-8333-333333333333",
        owner: ANN,
        title: "What is a run?",
        state: "failed",
        messages: [
          { id: "44444444-4444-4444-8444-444444444444", role: "user", at: "2026-02-28T09:00:00.000Z", status: "done", text: "What is a run?" },
          { id: "55555555-5555-4555-8555-555555555555", role: "assistant", at: "2026-02-28T09:00:00.000Z", status: "failed", text: FAILURE_WORDS.timeout, replyTo: "44444444-4444-4444-8444-444444444444", failure: { code: "timeout", retry: true }, tries: 1 },
        ],
        created: "2026-02-28T09:00:00.000Z",
        updated: "2026-02-28T09:00:05.000Z",
      },
    ],
  };

  it("reads nothing, and writes nothing, on an install that has no help file", () => {
    expect(listConversations(ANN, at)).toEqual([]);
    expect(code(() => getConversation(ANN, UNKNOWN, at))).toBe("not-found");
    expect(sweepHelp(at)).toEqual({ expired: 0, removed: 0 });
    expect(settleInterrupted(new Set(), at)).toBe(0);
    expect(existsSync(helpPath())).toBe(false);
  });

  it("reads a file of the first version and goes on with it", () => {
    writeFileSync(helpPath(), JSON.stringify(FIRST));
    const c = getConversation(ANN, FIRST.conversations[0]!.id, at);
    expect(c.messages).toHaveLength(2);
    const again = retryTurn(ANN, c.id, at);
    expect(again.reply.tries).toBe(2);
    expect(JSON.parse(raw()).version).toBe(1);
    expect(finishTurn(c.id, ref(again), reply(), at)!.state).toBe("active");
  });

  it("refuses a file of a newer version, a broken one and one with unknown fields, and leaves each as it is", () => {
    const cases = [JSON.stringify({ ...FIRST, version: 2 }), "not json", JSON.stringify({ version: 1, conversations: [{ ...FIRST.conversations[0], secretNote: "x" }] }), JSON.stringify({ version: 1 })];
    for (const text of cases) {
      writeFileSync(helpPath(), text);
      for (const fn of [() => listConversations(ANN, at), () => ask(), () => sweepHelp(at), () => deleteConversation(ANN, FIRST.conversations[0]!.id, at), () => finishTurn(UNKNOWN, { message: UNKNOWN, tries: 1 }, reply(), at)]) {
        expect(fn).toThrow(StoreError);
      }
      expect(raw()).toBe(text);
    }
  });

  it("refuses a record that breaks a rule of the store", () => {
    const c = FIRST.conversations[0]!;
    const broken = [
      { ...c, state: "deleted" }, // deleted, but with content and no time
      { ...c, state: "archived" }, // archived without the state before
      { ...c, messages: [c.messages[1], c.messages[0]] }, // a reply before its question
      { ...c, messages: [c.messages[0], { ...c.messages[1], status: "done" }] }, // answered without a reply
      { ...c, messages: [c.messages[0], { ...c.messages[1], status: "pending", failure: undefined }, { ...c.messages[0], id: UNKNOWN }] }, // a waited-for reply that is not the last
    ];
    for (const conv of broken) {
      writeFileSync(helpPath(), JSON.stringify({ version: 1, conversations: [conv] }));
      expect(() => listConversations(ANN, at), JSON.stringify(conv).slice(0, 80)).toThrow(StoreError);
    }
  });

  it("touches no other file of the data folder, and the data-folder move copies it unchanged", () => {
    mkdirSync(join(home, "runs", "old"), { recursive: true });
    writeFileSync(join(home, "runs", "old", "run.json"), '{"id":"old"}');
    writeFileSync(join(home, "refinements.json"), '{"version":1,"sessions":[]}');
    const turn = ask();
    finishTurn(turn.conversation.id, ref(turn), reply(), at);
    deleteConversation(ANN, turn.conversation.id, at);
    expect(readFileSync(join(home, "runs", "old", "run.json"), "utf8")).toBe('{"id":"old"}');
    expect(readFileSync(join(home, "refinements.json"), "utf8")).toBe('{"version":1,"sessions":[]}');
    expect(readdirSync(home).sort()).toEqual(["help.json", "refinements.json", "runs"]);
    // a question may hold text that looks like a path: the move must not rewrite it
    expect(jsonFiles(home)).toEqual([join(home, "runs", "old", "run.json")]);
  });
});
