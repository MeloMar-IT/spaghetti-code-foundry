import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addRepo, removeRepo } from "../src/auth/repos.js";
import { StoreError, authLockHeld, withAuthLock } from "../src/auth/store.js";
import { createUser, deleteUser, hashPassword, type User } from "../src/auth/users.js";
import { jsonFiles } from "../src/home-migrate.js";
import {
  DROP_KEEP_MS,
  END_BAD_FORM,
  END_NO_QUESTION,
  END_NO_ROOM,
  RefinementError,
  checkRefinements,
  createSession,
  dropSession,
  endArchitectRun,
  noteArchitectResumed,
  setArchitectRun,
  getSession,
  listSessions,
  purgeDropped,
  refinementsPath,
  removeRefinementsLocked,
  renameSession,
  restoreSession,
} from "../src/refinement/store.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";

const ANN = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const ADMIN = "33333333-3333-4333-8333-333333333333";
const OK = { ownerOk: () => true, repoName: (_o: string, name: string) => name };
// close to the real clock, because calls without `now` use it
const T0 = new Date();
const at = (ms: number) => ({ now: () => new Date(T0.getTime() + ms) });
const owner = (id: string) => ({ id, admin: false });
const admin = { id: ADMIN, admin: true };
let home: string;
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "refinement-"));
  process.env.FACTORY_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof RefinementError ? e.code : e;
  }
  return undefined;
};
const make = (o = ANN, extra: object = {}, opts = {}) => createSession(o, { repo: "acme/app", idea: "An idea", ...extra }, { ...OK, ...at(0), ...opts });
const file = () => readFileSync(refinementsPath(), "utf8");
const edit = (fn: (f: any) => void) => {
  const f = JSON.parse(file());
  fn(f);
  writeFileSync(refinementsPath(), JSON.stringify(f));
};

describe("create", () => {
  it("starts exploring with one log entry", () => {
    const s = make();
    expect(s).toMatchObject({ owner: ANN, repo: "acme/app", state: "exploring", drafts: [], title: "An idea", idea: "An idea" });
    expect(s.log).toEqual([{ at: T0.toISOString(), by: ANN, what: "created" }]);
    expect(s.created).toBe(s.updated);
    expect(JSON.parse(file()).version).toBe(1);
    expect(statSync(refinementsPath()).mode & 0o777).toBe(0o600);
  });

  it("makes the title", () => {
    expect(make(ANN, { title: "  Mine  " }).title).toBe("Mine");
    expect(make(ANN, { title: "  ", idea: "\n\n First line \nsecond" }).title).toBe("First line");
    expect(make(ANN, { idea: "x".repeat(300) }).title).toBe("x".repeat(120));
    expect(make(ANN, { idea: "a\tb" }).title).toBe("a b");
    expect(make(ANN, { idea: "a\r\nb" }).idea).toBe("a\nb");
  });

  it("refuses bad input and writes nothing", () => {
    for (const idea of [undefined, 5, "   ", "x".repeat(10_001), "a\u0001b"]) expect(code(() => make(ANN, { idea }))).toBe("bad-idea");
    for (const title of ["x".repeat(121), "a\u0001b", 5]) expect(code(() => make(ANN, { title }))).toBe("bad-title");
    for (const repo of ["nope", 5]) expect(code(() => make(ANN, { repo }))).toBe("bad-repo");
    expect(existsSync(refinementsPath())).toBe(false);
  });

  it("checks the account and the repository under the lock", () => {
    const seen: boolean[] = [];
    expect(code(() => make(ANN, {}, { ownerOk: () => (seen.push(authLockHeld()), false) }))).toBe("no-owner");
    expect(code(() => make(ANN, {}, { repoName: () => (seen.push(authLockHeld()), undefined) }))).toBe("not-yours");
    expect(seen).toEqual([true, true]);
    expect(existsSync(refinementsPath())).toBe(false);
    expect(make(ANN, { repo: "ACME/App.git" }, { repoName: () => "acme/app" }).repo).toBe("acme/app");
  });

  it("limits the sessions of one owner", () => {
    const sessions = Array.from({ length: 200 }, (_, i) => {
      const s = make(ANN, {}, at(i));
      return s;
    });
    expect(sessions).toHaveLength(200);
    expect(code(() => make(ANN))).toBe("limit");
    expect(make(BOB).owner).toBe(BOB);
    // one dropped session that is past its 30 days frees a place
    dropSession(owner(ANN), sessions[0]!.id, at(10));
    expect(code(() => make(ANN))).toBe("limit");
    expect(make(ANN, {}, at(10 + DROP_KEEP_MS)).owner).toBe(ANN);
  });

  it("lists newest change first", () => {
    const a = make(ANN, {}, at(1));
    const b = make(ANN, {}, at(2));
    expect(listSessions().map((s) => s.id)).toEqual([b.id, a.id]);
    expect(getSession("nope")).toBeUndefined();
    expect(listSessions(BOB)).toEqual([]);
  });
});

describe("default checks", () => {
  let kc: FakeKeychain;
  let ann: User;
  let bob: User;
  beforeAll(async () => void (await hashPassword("test-password-12345")));
  beforeEach(async () => {
    kc = fakeKeychain();
    ann = await createUser({ name: "Ann", email: "ann@example.com", password: "test-password-12345", role: "admin" });
    bob = await createUser({ name: "Bob", email: "bob@example.com", password: "test-password-12345" });
  });
  afterEach(() => kc.remove());
  afterAll(() => {});

  it("uses the account and the repository record", () => {
    const rec = addRepo(ann.id, "acme/app");
    addRepo(ann.id, "https://gitlab.com/acme/web");
    addRepo(bob.id, "other/thing");
    expect(createSession(ann.id, { repo: "ACME/App.git", idea: "x" }).repo).toBe("acme/app");
    expect(code(() => createSession(ann.id, { repo: "acme/web", idea: "x" }))).toBe("not-yours");
    expect(code(() => createSession(ann.id, { repo: "other/thing", idea: "x" }))).toBe("not-yours");
    removeRepo(ann.id, rec.id);
    expect(code(() => createSession(ann.id, { repo: "acme/app", idea: "x" }))).toBe("not-yours");
    addRepo(bob.id, "bob/own");
    deleteUser(bob.id);
    expect(code(() => createSession(bob.id, { repo: "bob/own", idea: "x" }))).toBe("no-owner");
  });
});

describe("rename, drop, restore", () => {
  it("renames", () => {
    const s = make(ANN, {}, at(0));
    const r = renameSession(owner(ANN), s.id, " New ", at(5));
    expect(r.title).toBe("New");
    expect(r.updated).toBe(new Date(T0.getTime() + 5).toISOString());
    expect(r.log.at(-1)).toMatchObject({ what: "renamed", detail: "New", by: ANN });
    const before = file();
    renameSession(owner(ANN), s.id, "New", at(9));
    expect(file()).toBe(before);
    expect(code(() => renameSession(owner(BOB), s.id, "x"))).toBe("not-found");
    expect(code(() => renameSession(admin, s.id, "x"))).toBe("not-owner");
    expect(code(() => renameSession(owner(ANN), s.id, "  "))).toBe("bad-title");
    dropSession(owner(ANN), s.id, at(10));
    expect(code(() => renameSession(owner(ANN), s.id, "y"))).toBe("bad-state");
  });

  it("drops and restores", () => {
    const s = make(ANN, {}, at(0));
    const d = dropSession(owner(ANN), s.id, at(5));
    expect(d).toMatchObject({ state: "dropped", stateBefore: "exploring", droppedAt: new Date(T0.getTime() + 5).toISOString() });
    expect(code(() => dropSession(owner(ANN), s.id))).toBe("bad-state");
    expect(code(() => restoreSession(admin, s.id))).toBe("not-owner");
    expect(code(() => restoreSession(owner(BOB), s.id))).toBe("not-found");
    const r = restoreSession(owner(ANN), s.id, at(6));
    expect(r.state).toBe("exploring");
    const stored = JSON.parse(file()).sessions[0];
    expect(stored).not.toHaveProperty("stateBefore");
    expect(stored).not.toHaveProperty("droppedAt");
    expect(r.log.map((l) => l.what)).toEqual(["created", "dropped", "restored"]);
    expect(code(() => restoreSession(owner(ANN), s.id))).toBe("bad-state");
  });

  it("lets an admin drop another's session", () => {
    const s = make(ANN);
    const d = dropSession(admin, s.id, at(1));
    expect(d.log.at(-1)).toMatchObject({ what: "dropped", by: ADMIN });
    expect(code(() => dropSession(owner(BOB), make(ANN).id))).toBe("not-found");
  });
});

describe("thirty days", () => {
  it("removes a dropped session at the limit", () => {
    const s = make(ANN);
    dropSession(owner(ANN), s.id, at(0));
    expect(getSession(s.id, at(DROP_KEEP_MS - 1))).toBeDefined();
    expect(listSessions(ANN, at(DROP_KEEP_MS - 1))).toHaveLength(1);
    expect(getSession(s.id, at(DROP_KEEP_MS))).toBeUndefined();
    expect(listSessions(ANN, at(DROP_KEEP_MS))).toEqual([]);
    expect(code(() => restoreSession(owner(ANN), s.id, at(DROP_KEEP_MS)))).toBe("not-found");
    expect(purgeDropped(at(DROP_KEEP_MS))).toBe(1);
    expect(JSON.parse(file()).sessions).toEqual([]);
  });

  it("a write for another session also removes it", () => {
    const s = make(ANN);
    const other = make(BOB);
    dropSession(owner(ANN), s.id, at(0));
    renameSession(owner(BOB), other.id, "Later", at(DROP_KEEP_MS));
    expect(JSON.parse(file()).sessions.map((x: any) => x.id)).toEqual([other.id]);
  });

  it("purges nothing from a missing file and creates no lock", () => {
    expect(purgeDropped()).toBe(0);
    expect(existsSync(refinementsPath())).toBe(false);
    expect(existsSync(join(home, "auth.lock"))).toBe(false);
  });
});

describe("the log", () => {
  it("loses nothing and stops when full", () => {
    const s = make();
    for (let i = 0; i < 20; i++) renameSession(owner(ANN), s.id, `T${i}`);
    const got = getSession(s.id)!;
    expect(got.log).toHaveLength(21);
    expect(got.log[0]!.what).toBe("created");

    edit((f) => {
      f.sessions[0].log = Array.from({ length: 999 }, () => ({ at: T0.toISOString(), by: ANN, what: "renamed", detail: "x" }));
    });
    const bytes = file();
    expect(code(() => renameSession(owner(ANN), s.id, "Another"))).toBe("limit");
    expect(file()).toBe(bytes);
    expect(dropSession(owner(ANN), s.id).log).toHaveLength(1000);
    expect(code(() => restoreSession(owner(ANN), s.id))).toBe("limit");
    edit((f) => f.sessions[0].log.push({ at: T0.toISOString(), by: ANN, what: "renamed" }));
    expect(() => listSessions()).toThrow(StoreError);
  });
});

describe("the architect's run", () => {
  const BRIEF = { text: "## What already exists\n- x", at: T0.toISOString(), branch: "main" };
  const logLength = (n: number) => edit((f) => (f.sessions[0].log = Array.from({ length: n }, () => ({ at: T0.toISOString(), by: ANN, what: "renamed", detail: "x" }))));
  const whats = (id: string) => getSession(id)!.log.map((l) => l.what);

  it("loads a file without and with the new fields; refuses an unknown field and a brief that is too long", () => {
    const s = make();
    expect(getSession(s.id)!.brief).toBeUndefined();
    setArchitectRun(owner(ANN), s.id, "run-1");
    endArchitectRun(s.id, "run-1", { brief: BRIEF });
    expect(getSession(s.id)!.brief).toMatchObject({ text: BRIEF.text, branch: "main", runId: "run-1" });
    edit((f) => (f.sessions[0].brief.extra = 1));
    expect(() => listSessions()).toThrow(StoreError);
    edit((f) => {
      delete f.sessions[0].brief.extra;
      f.sessions[0].brief.text = "x".repeat(60_001);
    });
    expect(() => listSessions()).toThrow(StoreError);
  });

  it("setArchitectRun sets the run, logs it and keeps the brief", () => {
    const s = make();
    setArchitectRun(owner(ANN), s.id, "run-1");
    endArchitectRun(s.id, "run-1", { brief: BRIEF });
    const got = setArchitectRun(owner(ANN), s.id, "run-2");
    expect(got.architect).toMatchObject({ runId: "run-2" });
    expect(got.brief?.runId).toBe("run-1");
    expect(whats(s.id)).toEqual(["created", "architect-started", "architect-brief", "architect-started"]);
  });

  it("setArchitectRun refuses a dropped session, another account, an admin who is not the owner and a log with no room", () => {
    const s = make();
    expect(code(() => setArchitectRun(owner(BOB), s.id, "r"))).toBe("not-found");
    expect(code(() => setArchitectRun(admin, s.id, "r"))).toBe("not-owner");
    logLength(998);
    expect(code(() => setArchitectRun(owner(ANN), s.id, "r"))).toBe("limit");
    logLength(997);
    expect(setArchitectRun(owner(ANN), s.id, "r").log).toHaveLength(998);
    edit((f) => (f.sessions[0].log = f.sessions[0].log.slice(0, 5)));
    dropSession(owner(ANN), s.id);
    expect(code(() => setArchitectRun(owner(ANN), s.id, "r2"))).toBe("bad-state");
  });

  it("endArchitectRun with a brief stores it, clears the run and logs; a long brief is cut", () => {
    const s = make();
    setArchitectRun(owner(ANN), s.id, "run-1");
    const got = endArchitectRun(s.id, "run-1", { brief: { ...BRIEF, text: "y".repeat(60_050) } })!;
    expect(got.architect).toBeUndefined();
    expect(got.brief).toMatchObject({ cut: true, runId: "run-1" });
    expect(got.brief!.text).toHaveLength(60_000);
    expect(whats(s.id).at(-1)).toBe("architect-brief");
  });

  it("endArchitectRun writes nothing for another run id or an unknown session", () => {
    const s = make();
    setArchitectRun(owner(ANN), s.id, "run-1");
    const bytes = file();
    expect(endArchitectRun(s.id, "run-0", { brief: BRIEF })).toBeUndefined();
    expect(endArchitectRun("44444444-4444-4444-8444-444444444444", "run-1", { failed: "x" })).toBeUndefined();
    expect(file()).toBe(bytes);
  });

  it("endArchitectRun failed keeps the brief, and the same reason a second time writes nothing", () => {
    const s = make();
    setArchitectRun(owner(ANN), s.id, "run-1");
    endArchitectRun(s.id, "run-1", { brief: BRIEF });
    setArchitectRun(owner(ANN), s.id, "run-2");
    const got = endArchitectRun(s.id, "run-2", { failed: "It was cancelled" })!;
    expect(got.architect).toMatchObject({ runId: "run-2", failed: "It was cancelled" });
    expect(got.brief?.runId).toBe("run-1");
    const bytes = file();
    expect(endArchitectRun(s.id, "run-2", { failed: "It was cancelled" })).toBeUndefined();
    expect(file()).toBe(bytes);
  });

  it("a full log still stores the brief, without a log entry", () => {
    const s = make();
    setArchitectRun(owner(ANN), s.id, "run-1");
    logLength(999);
    edit((f) => (f.sessions[0].architect = { runId: "run-1", at: T0.toISOString() }));
    const got = endArchitectRun(s.id, "run-1", { brief: BRIEF })!;
    expect(got.brief?.runId).toBe("run-1");
    expect(got.log).toHaveLength(999);
  });

  it("keeps the slot for dropping: start, resumes and the end fit from 997 entries", () => {
    const s = make();
    logLength(997);
    setArchitectRun(owner(ANN), s.id, "run-1");
    expect(getSession(s.id)!.log).toHaveLength(998);
    for (let i = 0; i < 3; i++) noteArchitectResumed(s.id, "run-1");
    expect(getSession(s.id)!.log).toHaveLength(998);
    endArchitectRun(s.id, "run-1", { failed: "It was cancelled" });
    expect(getSession(s.id)!.log).toHaveLength(999);
    expect(dropSession(owner(ANN), s.id).log).toHaveLength(1000);
    expect(getSession(s.id)!.state).toBe("dropped");
  });

  it("noteArchitectResumed writes nothing and does not throw from 998 and 999 entries", () => {
    const s = make();
    setArchitectRun(owner(ANN), s.id, "run-1");
    for (const n of [998, 999]) {
      logLength(n);
      edit((f) => (f.sessions[0].architect = { runId: "run-1", at: T0.toISOString(), failed: "x" }));
      const bytes = file();
      expect(() => noteArchitectResumed(s.id, "run-1")).not.toThrow();
      // the failed mark goes away, the log stays
      expect(getSession(s.id)!.log).toHaveLength(n);
      expect(getSession(s.id)!.architect?.failed).toBeUndefined();
      expect(file()).not.toBe(bytes);
    }
  });
});

describe("the architect's round and answer", () => {
  const BRIEF = { text: "## What already exists\n- x", at: T0.toISOString() };
  const logLength = (n: number) => edit((f) => (f.sessions[0].log = Array.from({ length: n }, () => ({ at: T0.toISOString(), by: ANN, what: "renamed", detail: "x" }))));
  const whats = (id: string) => getSession(id)!.log.map((l) => l.what);
  const q = (i: number) => ({ view: "need", text: `Question ${i}?`, why: "It matters.", options: [{ text: "A", tradeoff: "a" }, { text: "B", tradeoff: "b" }], recommended: 1 });
  const ROUND = { questions: [q(1), q(2), q(3)], proposals: [{ list: "rule", text: "A rule" }], done: "" };
  /** A round of 5 questions, 20 proposals and done, for a session that already waits on 40 proposals: 10 do not fit. */
  const fullRound = () => {
    edit((f) => {
      f.sessions[0].talk = { rounds: [], proposals: Array.from({ length: 40 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, list: "rule", text: `Old ${i}` })), map: { rules: [], examples: [], open: [] }, asked: [] };
    });
    return { questions: [1, 2, 3, 4, 5].map(q), proposals: Array.from({ length: 20 }, (_, i) => ({ list: "rule", text: `Rule ${i}` })), done: "Nothing is left." };
  };
  const withBrief = () => {
    const s = make();
    setArchitectRun(owner(ANN), s.id, "run-0");
    endArchitectRun(s.id, "run-0", { brief: BRIEF });
    return s;
  };

  it("loads a file with kind and question; refuses an unknown kind", () => {
    const s = make();
    setArchitectRun(owner(ANN), s.id, "run-1", { kind: "question", question: "Why?" });
    expect(getSession(s.id)!.architect).toMatchObject({ runId: "run-1", kind: "question", question: "Why?" });
    edit((f) => (f.sessions[0].architect.kind = "other"));
    expect(() => listSessions()).toThrow(StoreError);
  });

  it("setArchitectRun for a round logs round-started and needs room for 9 entries", () => {
    const s = make();
    logLength(991);
    expect(code(() => setArchitectRun(owner(ANN), s.id, "r", { kind: "round" }))).toBe("limit");
    logLength(990);
    const got = setArchitectRun(owner(ANN), s.id, "r", { kind: "round" });
    expect(got.architect).toMatchObject({ runId: "r", kind: "round" });
    expect(got.log.at(-1)).toMatchObject({ what: "round-started", detail: "r" });
  });

  it("setArchitectRun for a question stores it and logs asked", () => {
    const s = make();
    const got = setArchitectRun(owner(ANN), s.id, "r", { kind: "question", question: "Is it so?" });
    expect(got.architect).toMatchObject({ kind: "question", question: "Is it so?" });
    expect(got.log.at(-1)).toMatchObject({ what: "asked", detail: "Is it so?" });
  });

  it("noteArchitectResumed keeps kind and question", () => {
    const s = make();
    setArchitectRun(owner(ANN), s.id, "r", { kind: "question", question: "Is it so?" });
    noteArchitectResumed(s.id, "r");
    expect(getSession(s.id)!.architect).toMatchObject({ kind: "question", question: "Is it so?" });
  });

  it("a paused round at the log boundary: no resume line at 990 entries, and the end still fits", () => {
    const s = withBrief();
    logLength(990);
    setArchitectRun(owner(ANN), s.id, "r", { kind: "round" });
    expect(getSession(s.id)!.log).toHaveLength(991);
    noteArchitectResumed(s.id, "r");
    expect(whats(s.id)).not.toContain("architect-resumed");
    const many = fullRound();
    endArchitectRun(s.id, "r", { round: many });
    const got = getSession(s.id)!;
    expect(got.architect).toBeUndefined();
    expect(got.talk!.rounds).toHaveLength(1);
    expect(got.log).toHaveLength(999);
    expect(whats(s.id)).toContain("proposals-left-out");
    expect(whats(s.id)).toContain("round-done");
  });

  it("a paused round with 989 entries writes the resume line and the end still fits", () => {
    const s = withBrief();
    logLength(989);
    setArchitectRun(owner(ANN), s.id, "r", { kind: "round" });
    noteArchitectResumed(s.id, "r");
    expect(whats(s.id).at(-1)).toBe("architect-resumed");
    const many = fullRound();
    endArchitectRun(s.id, "r", { round: many });
    expect(getSession(s.id)!.log).toHaveLength(999);
    expect(getSession(s.id)!.architect).toBeUndefined();
  });

  it("other changes cannot use the log room a running round still needs", () => {
    const s = withBrief();
    logLength(989);
    setArchitectRun(owner(ANN), s.id, "r", { kind: "round" });
    expect(renameSession(owner(ANN), s.id, "One").log).toHaveLength(991);
    expect(code(() => renameSession(owner(ANN), s.id, "Two"))).toBe("limit");
    expect(getSession(s.id)!.log).toHaveLength(991);
    endArchitectRun(s.id, "r", { round: fullRound() });
    expect(getSession(s.id)!.talk!.rounds).toHaveLength(1);
    expect(getSession(s.id)!.architect).toBeUndefined();
    expect(getSession(s.id)!.log).toHaveLength(999);
  });

  it("a brief and a question still write the resume line up to 997 entries", () => {
    for (const ask of [{ kind: "brief" as const }, { kind: "question" as const, question: "Why?" }]) {
      const s = make();
      logLength(996);
      setArchitectRun(owner(ANN), s.id, "r", ask);
      noteArchitectResumed(s.id, "r");
      expect(whats(s.id).at(-1)).toBe("architect-resumed");
      expect(getSession(s.id)!.log).toHaveLength(998);
      rmSync(refinementsPath());
    }
  });

  it("endArchitectRun with a round stores the talk, clears the run and logs the lines", () => {
    const s = withBrief();
    setArchitectRun(owner(ANN), s.id, "r1", { kind: "round" });
    const got = endArchitectRun(s.id, "r1", { round: { ...ROUND, done: "Enough." } })!;
    expect(got.architect).toBeUndefined();
    expect(got.talk!.rounds[0]!.questions).toHaveLength(3);
    expect(got.talk!.proposals).toHaveLength(1);
    expect(whats(s.id).slice(-6)).toEqual(["round-started", "question", "question", "question", "round-done", "architect-round"]);
    expect(got.log.find((l) => l.what === "round-done")!.detail).toBe("Enough.");
  });

  it("a round with a bad form or no room is marked failed and changes nothing else", () => {
    const s = withBrief();
    setArchitectRun(owner(ANN), s.id, "r1", { kind: "round" });
    const before = getSession(s.id)!;
    const bad = endArchitectRun(s.id, "r1", { round: { questions: [{ view: "x" }], proposals: [], done: "" } })!;
    expect(bad.architect).toMatchObject({ runId: "r1", failed: END_BAD_FORM });
    expect(bad.talk).toEqual(before.talk);
    logLength(999);
    edit((f) => (f.sessions[0].architect = { runId: "r1", at: T0.toISOString(), kind: "round" }));
    const full = endArchitectRun(s.id, "r1", { round: ROUND })!;
    expect(full.architect).toMatchObject({ failed: END_NO_ROOM });
    expect(full.talk).toBeUndefined();
    expect(full.log).toHaveLength(999);
  });

  it("an answer is stored in talk.asked and only architect-answered is logged", () => {
    const s = make();
    setArchitectRun(owner(ANN), s.id, "r1", { kind: "question", question: "Is it so?" });
    const got = endArchitectRun(s.id, "r1", { answer: "Yes (README.md)." })!;
    expect(got.architect).toBeUndefined();
    expect(got.talk!.asked).toMatchObject([{ runId: "r1", question: "Is it so?", answer: "Yes (README.md)." }]);
    expect(whats(s.id)).toEqual(["created", "asked", "architect-answered"]);
  });

  it("an answer without a stored question or with 50 kept is marked failed", () => {
    const s = make();
    setArchitectRun(owner(ANN), s.id, "r1", { kind: "question" });
    expect(endArchitectRun(s.id, "r1", { answer: "x" })!.architect).toMatchObject({ failed: END_NO_QUESTION });
    const t = make();
    edit((f) => {
      f.sessions[1].talk = { rounds: [], proposals: [], map: { rules: [], examples: [], open: [] }, asked: Array.from({ length: 50 }, (_, i) => ({ runId: `old-${i}`, at: T0.toISOString(), question: "q", answer: "a" })) };
    });
    setArchitectRun(owner(ANN), t.id, "r2", { kind: "question", question: "One more?" });
    expect(endArchitectRun(t.id, "r2", { answer: "x" })!.architect).toMatchObject({ failed: END_NO_ROOM });
  });

  it("the same run id twice writes nothing the second time", () => {
    const s = withBrief();
    setArchitectRun(owner(ANN), s.id, "r1", { kind: "round" });
    endArchitectRun(s.id, "r1", { round: ROUND });
    const bytes = file();
    expect(endArchitectRun(s.id, "r1", { round: ROUND })).toBeUndefined();
    expect(file()).toBe(bytes);
  });
});

describe("a broken file", () => {
  it("is not JSON", () => {
    writeFileSync(refinementsPath(), "nope");
    const kind = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return e instanceof StoreError ? e.kind : e;
      }
    };
    expect(kind(() => listSessions())).toBe("not-json");
    expect(kind(() => make())).toBe("not-json");
    expect(kind(() => checkRefinements())).toBe("not-json");
  });

  it("has the wrong format", () => {
    const s = make();
    dropSession(owner(ANN), make().id);
    const good = JSON.parse(file());
    const cases: ((f: any) => void)[] = [
      (f) => (f.extra = 1),
      (f) => (f.version = 2),
      (f) => (f.sessions[1].id = f.sessions[0].id),
      (f) => delete f.sessions[1].droppedAt,
      (f) => (f.sessions[0].droppedAt = T0.toISOString()),
      (f) => (f.sessions[0].drafts = [{}]),
      (f) => (f.sessions[0].repo = "nope"),
      (f) => (f.sessions[0].state = "unknown"),
    ];
    for (const c of cases) {
      const f = structuredClone(good);
      c(f);
      writeFileSync(refinementsPath(), JSON.stringify(f));
      try {
        listSessions();
        expect.unreachable();
      } catch (e) {
        expect((e as StoreError).kind).toBe("wrong-format");
      }
    }
    expect(s.id).toBeTruthy();
  });

  it("checkRefinements accepts a missing and a good file and writes nothing", () => {
    checkRefinements();
    expect(existsSync(refinementsPath())).toBe(false);
    make();
    const bytes = file();
    checkRefinements();
    expect(file()).toBe(bytes);
  });
});

describe("removeRefinementsLocked", () => {
  it("needs the lock, removes one owner's sessions and writes nothing when there are none", () => {
    expect(() => removeRefinementsLocked(ANN)).toThrow();
    make(ANN);
    make(BOB);
    expect(withAuthLock(() => removeRefinementsLocked(ANN))).toBe(1);
    expect(listSessions().map((s) => s.owner)).toEqual([BOB]);
    const bytes = file();
    expect(withAuthLock(() => removeRefinementsLocked(ANN))).toBe(0);
    expect(file()).toBe(bytes);
  });
});

describe("moving the data folder", () => {
  it("copies refinements.json unchanged but not other json files at the top", () => {
    mkdirSync(join(home, "runs", "x"), { recursive: true });
    writeFileSync(join(home, "refinements.json"), "{}");
    writeFileSync(join(home, "runs", "x", "refinements.json"), "{}");
    expect(jsonFiles(home)).toEqual([join(home, "runs", "x", "refinements.json")]);
  });
});
