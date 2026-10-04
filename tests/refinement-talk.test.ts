import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StoreError } from "../src/auth/store.js";
import {
  ASKED_LOG_LINES,
  ROUND_LOG_LINES,
  RefinementError,
  acceptProposal,
  answerQuestion,
  changeEntry,
  checkRefinements,
  createSession,
  dropSession,
  getSession,
  listSessions,
  recordAsked,
  recordRound,
  refinementsPath,
  rejectProposal,
  removeEntry,
} from "../src/refinement/store.js";

const ANN = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const ADMIN = "33333333-3333-4333-8333-333333333333";
const OK = { ownerOk: () => true, repoName: (_o: string, name: string) => name };
const TALK = { repoOk: () => true };
const owner = (id: string) => ({ id, admin: false });
const admin = { id: ADMIN, admin: true };
let home: string;
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "refinement-talk-"));
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
const make = () => createSession(ANN, { repo: "acme/app", idea: "An idea" }, OK);
const file = () => readFileSync(refinementsPath(), "utf8");
const edit = (fn: (f: any) => void) => {
  const f = JSON.parse(file());
  fn(f);
  writeFileSync(refinementsPath(), JSON.stringify(f));
};
const fill = (n: number) => Array.from({ length: n }, (_, i) => ({ at: new Date().toISOString(), by: ANN, what: "renamed", detail: `t${i}` }));
/** Sets the log of a session (the last one made when no id is given) to exactly n entries. */
const padLog = (n: number, id?: string) =>
  edit((f) => {
    const s = id ? f.sessions.find((x: any) => x.id === id) : f.sessions[f.sessions.length - 1];
    s.log = [...s.log, ...fill(Math.max(0, n - s.log.length))].slice(0, n);
  });
const uuid = (i: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`;

const q = (over: Record<string, unknown> = {}) => ({
  view: "need",
  text: "Who uses it?",
  why: "It sets the value.",
  options: [
    { text: "Everyone", tradeoff: "Broad" },
    { text: "Admins", tradeoff: "Narrow" },
  ],
  recommended: 1,
  ...over,
});
const p = (list: string, text: string) => ({ list, text });
const round = (n = 3, proposals: unknown[] = [p("rule", "Only admins export."), p("example", "An empty report exports a header.")]) => ({ questions: Array.from({ length: n }, (_, i) => q({ text: `Question ${i + 1}?` })), proposals, done: "" });
const seed = (r: object = round()) => {
  const s = make();
  return { id: s.id, s: recordRound(s.id, "run-1", r, {})! };
};
const talk = (id: string) => getSession(id)!.talk!;
const lastLines = (id: string, n: number) => getSession(id)!.log.slice(-n);

describe("storing a round", () => {
  it("stores questions and proposals", () => {
    const { id, s } = seed();
    const t = s.talk!;
    expect(t.rounds[0]!.questions).toHaveLength(3);
    expect(t.rounds[0]!.questions[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(t.proposals).toHaveLength(2);
    expect(t.map).toEqual({ rules: [], examples: [], open: [] });
    const lines = lastLines(id, 3);
    expect(lines.map((l) => [l.what, l.by, l.detail])).toEqual([1, 2, 3].map((n) => ["question", ANN, `Question ${n}?`]));
    expect(JSON.parse(file()).version).toBe(1);
  });

  it("does nothing for the same run id or an unknown session", () => {
    const { id } = seed();
    const before = file();
    expect(recordRound(id, "run-1", round())).toBeUndefined();
    expect(recordRound(uuid(1), "run-2", round())).toBeUndefined();
    expect(file()).toBe(before);
  });

  it("has no round limit", () => {
    const { id } = seed({ questions: [], done: "x" });
    for (let i = 0; i < 101; i++) expect(recordRound(id, `r-${i}`, { questions: [], done: "enough" })).toBeDefined();
    expect(talk(id).rounds).toHaveLength(102);
  });

  it("refuses a bad form and writes nothing", () => {
    const s = make();
    const before = file();
    const bad = (r: unknown, run = "run-x") => code(() => recordRound(s.id, run, r as never));
    expect(bad(round(6))).toBe("bad-round");
    expect(bad(round(1, Array.from({ length: 21 }, () => p("rule", "x"))))).toBe("bad-round");
    expect(bad({ questions: [q({ options: [{ text: "a", tradeoff: "b" }] })] })).toBe("bad-round");
    expect(bad({ questions: [q({ options: Array.from({ length: 5 }, () => ({ text: "a", tradeoff: "b" })) })] })).toBe("bad-round");
    expect(bad({ questions: [q({ recommended: 3 })] })).toBe("bad-round");
    expect(bad({ questions: [q({ view: "x" })] })).toBe("bad-round");
    expect(bad({ questions: [q()], proposals: [p("nope", "x")] })).toBe("bad-round");
    expect(bad({ questions: [], done: "" })).toBe("bad-round");
    expect(bad({ questions: "x" })).toBe("bad-round");
    expect(bad(round(1), "bad run")).toBe("bad-round");
    expect(file()).toBe(before);
    expect(recordRound(s.id, "run-d", { questions: [], done: "Done." })!.log).toHaveLength(1);
  });

  it("counts characters, not UTF-16 units", () => {
    const s = make();
    const text = (r: ReturnType<typeof talk>) => r.rounds[0]!.questions[0]!.text;
    recordRound(s.id, "a", { questions: [q({ text: "x".repeat(600) })] });
    expect([...text(talk(s.id))]).toHaveLength(500);
    recordRound(s.id, "b", { questions: [q({ text: "😀".repeat(500) })] });
    expect(text({ ...talk(s.id), rounds: [talk(s.id).rounds[1]!] })).toBe("😀".repeat(500));
    recordRound(s.id, "c", { questions: [q({ text: "😀".repeat(600) })] });
    expect(talk(s.id).rounds[2]!.questions[0]!.text).toBe("😀".repeat(500));
    expect(listSessions()).toHaveLength(1);
  });

  it("takes what the round check of part 3a prints", () => {
    const long = (c: string, n: number) => c.repeat(n);
    const raw = {
      questions: Array.from({ length: 5 }, (_, i) =>
        q({
          text: i % 2 ? long("😀", 600) : long("é", 600),
          why: long("w", 600),
          options: Array.from({ length: 4 }, () => ({ text: long("o", 400), tradeoff: long("😀", 400) })),
          recommended: 4,
        }),
      ),
      proposals: Array.from({ length: 20 }, (_, i) => p(["rule", "example", "open"][i % 3]!, i % 2 ? long("😀", 700) : long("p", 700))),
      done: "😀".repeat(700),
    };
    const r = spawnSync(process.execPath, [resolve("tools/refine-round-check")], { env: { ...process.env, FACTORY_OUT_ROUND: JSON.stringify(raw) }, encoding: "utf8" });
    expect(r.status).toBe(0);
    const checked = JSON.parse(r.stdout);
    const s = make();
    recordRound(s.id, "run-1", checked);
    const t = talk(s.id);
    expect(t.rounds[0]!.questions.map(({ id: _id, ...x }) => x)).toEqual(checked.questions);
    expect(t.proposals.map(({ id: _id, ...x }) => x)).toEqual(checked.proposals.slice(0, 20));
    expect(t.rounds[0]!.done).toBe(checked.done);
    expect(listSessions()).toHaveLength(1);
  });

  it("keeps what fits when there are too many waiting proposals", () => {
    const { id } = seed(round(1, []));
    edit((f) => (f.sessions[0].talk.proposals = Array.from({ length: 48 }, (_, i) => ({ id: uuid(i), list: "rule", text: `w${i}` }))));
    recordRound(id, "run-2", round(5, Array.from({ length: 5 }, (_, i) => p("rule", `n${i}`))));
    expect(talk(id).proposals).toHaveLength(50);
    expect(getSession(id)!.log.at(-1)).toMatchObject({ what: "proposals-left-out", detail: "3" });
    recordRound(id, "run-3", round(1, [p("rule", "z"), p("rule", "y")]));
    expect(talk(id).proposals).toHaveLength(50);
    expect(getSession(id)!.log.at(-1)).toMatchObject({ what: "proposals-left-out", detail: "2" });
  });
});

describe("answers", () => {
  const first = (id: string) => talk(id).rounds[0]!.questions[0]!;
  it("answers by option", () => {
    const { id } = seed();
    answerQuestion(owner(ANN), id, first(id).id, { option: 2 }, TALK);
    expect(first(id).answer).toMatchObject({ option: 2 });
    expect(lastLines(id, 1)[0]).toMatchObject({ what: "answered", detail: "Admins", by: ANN });
  });

  it("trims an own answer", () => {
    const { id } = seed();
    answerQuestion(owner(ANN), id, first(id).id, { text: "  line1\r\nline2 " }, TALK);
    expect(first(id).answer!.text).toBe("line1\nline2");
    const s2 = seed();
    answerQuestion(owner(ANN), s2.id, first(s2.id).id, { text: "😀".repeat(2000) }, TALK);
    expect(lastLines(s2.id, 1)[0]!.detail).toBe("😀".repeat(2000));
    expect(listSessions()).toHaveLength(2);
  });

  it("turns I do not know into an open question", () => {
    const { id } = seed();
    const s = answerQuestion(owner(ANN), id, first(id).id, { unknown: true }, TALK);
    expect(s.talk!.map.open).toEqual([{ id: expect.any(String), text: "Question 1?", at: expect.any(String) }]);
    expect(s.talk!.map.open[0]!.id).not.toBe(first(id).id);
    expect(lastLines(id, 2).map((l) => [l.what, l.list])).toEqual([["answered", undefined], ["open-added", "open"]]);
  });

  it("answers once, and refuses bad answers", () => {
    const { id } = seed();
    const qid = first(id).id;
    for (const bad of [{}, { option: 1, text: "x" }, { option: 0 }, { option: 3 }, { option: 1.5 }, { text: " " }, { text: "x".repeat(2001) }, { text: "a\u0001b" }, { unknown: false }, null, "x"]) {
      const before = file();
      expect(code(() => answerQuestion(owner(ANN), id, qid, bad, TALK))).toBe("bad-answer");
      expect(file()).toBe(before);
    }
    answerQuestion(owner(ANN), id, qid, { option: 1 }, TALK);
    expect(code(() => answerQuestion(owner(ANN), id, qid, { option: 1 }, TALK))).toBe("bad-state");
    expect(code(() => answerQuestion(owner(ANN), id, uuid(9), { option: 1 }, TALK))).toBe("not-found");
  });
});

describe("the map", () => {
  it("accepts and rejects proposals", () => {
    const { id, s } = seed();
    const [a, b] = s.talk!.proposals;
    const r = acceptProposal(owner(ANN), id, a!.id, TALK);
    expect(r.talk!.map.rules).toEqual([{ id: a!.id, text: "Only admins export.", at: expect.any(String) }]);
    expect(r.talk!.proposals).toHaveLength(1);
    expect(lastLines(id, 1)[0]).toMatchObject({ what: "entry-accepted", detail: "Only admins export.", list: "rule" });
    rejectProposal(owner(ANN), id, b!.id, TALK);
    expect(talk(id).proposals).toEqual([]);
    expect(talk(id).map.examples).toEqual([]);
    expect(lastLines(id, 1)[0]).toMatchObject({ what: "entry-rejected", detail: "An empty report exports a header.", list: "example" });
    expect(code(() => acceptProposal(owner(ANN), id, uuid(1), TALK))).toBe("not-found");
    expect(code(() => rejectProposal(owner(ANN), id, uuid(1), TALK))).toBe("not-found");
  });

  it("changes and removes entries", () => {
    const { id, s } = seed();
    const eid = s.talk!.proposals[0]!.id;
    acceptProposal(owner(ANN), id, eid, TALK);
    changeEntry(owner(ANN), id, eid, "  Changed ", TALK);
    expect(talk(id).map.rules[0]!.text).toBe("Changed");
    expect(lastLines(id, 1)[0]).toMatchObject({ what: "entry-changed", detail: "Changed", list: "rule" });
    const before = file();
    changeEntry(owner(ANN), id, eid, "Changed", TALK);
    expect(file()).toBe(before);
    for (const bad of [5, " ", "x".repeat(501), "a\u0001b"]) expect(code(() => changeEntry(owner(ANN), id, eid, bad, TALK))).toBe("bad-text");
    expect(changeEntry(owner(ANN), id, eid, "😀".repeat(500), TALK)).toBeDefined();
    expect(code(() => changeEntry(owner(ANN), id, eid, "😀".repeat(501), TALK))).toBe("bad-text");
    removeEntry(owner(ANN), id, eid, TALK);
    expect(talk(id).map.rules).toEqual([]);
    expect(lastLines(id, 1)[0]).toMatchObject({ what: "entry-removed", list: "rule" });
    expect(code(() => removeEntry(owner(ANN), id, eid, TALK))).toBe("not-found");
    expect(code(() => changeEntry(owner(ANN), id, uuid(1), "x", TALK))).toBe("not-found");
  });

  it("changes and removes an open question from I do not know", () => {
    const { id } = seed();
    answerQuestion(owner(ANN), id, talk(id).rounds[0]!.questions[0]!.id, { unknown: true }, TALK);
    const eid = talk(id).map.open[0]!.id;
    changeEntry(owner(ANN), id, eid, "Better?", TALK);
    expect(talk(id).map.open[0]!.text).toBe("Better?");
    removeEntry(owner(ANN), id, eid, TALK);
    expect(talk(id).map.open).toEqual([]);
  });
});

describe("limits", () => {
  const entries = (n: number) => Array.from({ length: n }, (_, i) => ({ id: uuid(i + 1), text: `e${i}`, at: new Date().toISOString() }));
  it("refuses a full list", () => {
    const { id, s } = seed();
    edit((f) => (f.sessions[0].talk.map.rules = entries(100)));
    const before = file();
    expect(code(() => acceptProposal(owner(ANN), id, s.talk!.proposals[0]!.id, TALK))).toBe("limit");
    expect(file()).toBe(before);
    edit((f) => (f.sessions[0].talk.map.open = entries(100)));
    const b2 = file();
    expect(code(() => answerQuestion(owner(ANN), id, s.talk!.rounds[0]!.questions[0]!.id, { unknown: true }, TALK))).toBe("limit");
    expect(file()).toBe(b2);
  });

  it("keeps the last log slot for dropping", () => {
    const { id, s } = seed();
    const qs = s.talk!.rounds[0]!.questions;
    padLog(999);
    expect(code(() => answerQuestion(owner(ANN), id, qs[0]!.id, { option: 1 }, TALK))).toBe("limit");
    expect(dropSession(owner(ANN), id).state).toBe("dropped");
    const b = seed();
    padLog(998);
    expect(code(() => answerQuestion(owner(ANN), b.id, b.s.talk!.rounds[0]!.questions[0]!.id, { unknown: true }, TALK))).toBe("limit");
  });

  it("fits at the edge", () => {
    const { id, s } = seed();
    const qs = s.talk!.rounds[0]!.questions;
    padLog(998, id);
    answerQuestion(owner(ANN), id, qs[0]!.id, { option: 1 }, TALK);
    expect(getSession(id)!.log).toHaveLength(999);
    padLog(997, id);
    expect(getSession(id)!.log).toHaveLength(997);
    answerQuestion(owner(ANN), id, qs[1]!.id, { unknown: true }, TALK);
    expect(getSession(id)!.log).toHaveLength(999);
  });

  it("refuses a round or an own question that does not fit in the log, whole", () => {
    expect([ROUND_LOG_LINES, ASKED_LOG_LINES]).toEqual([6, 2]);
    const s = make();
    padLog(996);
    expect(recordRound(s.id, "a", round(3, []))!.log).toHaveLength(999);
    const t = make();
    padLog997(t.id);
    const before = file();
    expect(code(() => recordRound(t.id, "a", round(3, [])))).toBe("limit");
    expect(file()).toBe(before);
    const u = make();
    expect(u.log).toHaveLength(1);
    expect(recordRound(u.id, "d", { questions: [], done: "x" })!.log).toHaveLength(1);
  });

  function padLog997(id: string) {
    edit((f) => {
      const s = f.sessions.find((x: any) => x.id === id);
      s.log = [...s.log, ...fill(997 - s.log.length)];
    });
  }

  it("counts the proposals that do not fit in the lines", () => {
    const { id } = seed(round(1, []));
    edit((f) => {
      f.sessions[0].talk.proposals = Array.from({ length: 48 }, (_, i) => ({ id: uuid(i), list: "rule", text: `w${i}` }));
      f.sessions[0].log = [...f.sessions[0].log, ...fill(996 - f.sessions[0].log.length)];
    });
    const before = file();
    expect(code(() => recordRound(id, "r2", round(3, Array.from({ length: 5 }, () => p("rule", "n")))))).toBe("limit");
    expect(file()).toBe(before);
  });
});

describe("who may do what", () => {
  it("checks the account, the state and the repository", () => {
    const { id, s } = seed();
    const qid = s.talk!.rounds[0]!.questions[0]!.id;
    const pid = s.talk!.proposals[0]!.id;
    const calls = (who: { id: string; admin: boolean }, opts: object = TALK) => [
      () => answerQuestion(who, id, qid, { option: 1 }, opts),
      () => acceptProposal(who, id, pid, opts),
      () => rejectProposal(who, id, pid, opts),
      () => changeEntry(who, id, uuid(1), "x", opts),
      () => removeEntry(who, id, uuid(1), opts),
    ];
    for (const f of calls(owner(BOB))) expect(code(f)).toBe("not-found");
    for (const f of calls(admin)) expect(code(f)).toBe("not-owner");
    for (const f of calls(owner(ANN), { repoOk: () => false })) expect(code(f)).toBe("no-repo");
    dropSession(owner(ANN), id);
    for (const f of calls(owner(ANN))) expect(code(f)).toBe("bad-state");
  });
});

describe("own questions", () => {
  it("keeps the question and the answer whole, the log lines cut", () => {
    const s = make();
    const r = recordAsked(s.id, "a1", { question: "q".repeat(2500), answer: "a".repeat(2500) })!;
    expect(r.talk!.asked[0]).toMatchObject({ question: "q".repeat(2500), answer: "a".repeat(2500) });
    expect(r.log.slice(-2).map((l) => [l.what, l.detail!.length])).toEqual([["asked", 2000], ["architect-answered", 2000]]);
  });

  it("has bounds", () => {
    const s = make();
    expect(recordAsked(s.id, "a1", { question: "😀".repeat(10_000), answer: "😀".repeat(8000) })).toBeDefined();
    expect(listSessions()).toHaveLength(1);
    expect(recordAsked(s.id, "a2", { question: " spaced ", answer: "😀".repeat(8100) })!.talk!.asked[1]).toMatchObject({ question: " spaced ", answer: "😀".repeat(8000) });
    const before = file();
    expect(code(() => recordAsked(s.id, "a3", { question: "x".repeat(10_001), answer: "a" }))).toBe("bad-round");
    expect(code(() => recordAsked(s.id, "a3", { question: "", answer: "a" }))).toBe("bad-round");
    expect(code(() => recordAsked(s.id, "a3", { question: "q", answer: " " }))).toBe("bad-round");
    expect(recordAsked(s.id, "a1", { question: "q", answer: "a" })).toBeUndefined();
    expect(file()).toBe(before);
  });

  it("stops at 50 and when the log is full", () => {
    const s = make();
    edit((f) => (f.sessions[0].talk = { rounds: [], proposals: [], map: { rules: [], examples: [], open: [] }, asked: Array.from({ length: 50 }, (_, i) => ({ runId: `r${i}`, at: new Date().toISOString(), question: "q", answer: "a" })) }));
    expect(code(() => recordAsked(s.id, "new", { question: "q", answer: "a" }))).toBe("limit");
    const t = make();
    edit((f) => (f.sessions[1].log = [...f.sessions[1].log, ...fill(996)]));
    expect(recordAsked(t.id, "x", { question: "q", answer: "a" })!.log).toHaveLength(999);
    const u = make();
    edit((f) => (f.sessions[2].log = [...f.sessions[2].log, ...fill(997)]));
    const before = file();
    expect(code(() => recordAsked(u.id, "x", { question: "q", answer: "a" }))).toBe("limit");
    expect(file()).toBe(before);
  });
});

describe("the file format", () => {
  it("loads an old file unchanged", () => {
    const s = make();
    expect(getSession(s.id)!.talk).toBeUndefined();
    const before = file();
    checkRefinements();
    expect(file()).toBe(before);
    expect(JSON.parse(file()).version).toBe(1);
  });

  it("keeps the 120 characters of the old kinds and allows 2,000 for the new", () => {
    const s = make();
    const set = (what: string, detail: string) => edit((f) => (f.sessions[0].log = [{ ...f.sessions[0].log[0], what, detail }]));
    set("renamed", "x".repeat(120));
    expect(() => checkRefinements()).not.toThrow();
    set("renamed", "x".repeat(121));
    expect(() => checkRefinements()).toThrow(StoreError);
    set("question", "x".repeat(2000));
    expect(() => checkRefinements()).not.toThrow();
    set("question", "😀".repeat(2000));
    expect(() => checkRefinements()).not.toThrow();
    set("question", "x".repeat(2001));
    expect(() => checkRefinements()).toThrow(StoreError);
    expect(s.id).toBeDefined();
  });

  it("refuses unknown fields, six options and bad ids in the talk", () => {
    const { id } = seed();
    const good = file();
    const bad = (fn: (t: any) => void) => {
      writeFileSync(refinementsPath(), good);
      edit((f) => fn(f.sessions[0].talk));
      expect(() => checkRefinements()).toThrow(StoreError);
    };
    bad((t) => (t.extra = 1));
    bad((t) => (t.rounds[0].questions[0].options = Array.from({ length: 6 }, () => ({ text: "a", tradeoff: "b" }))));
    bad((t) => (t.rounds[0].questions[0].id = "not-a-uuid"));
    bad((t) => (t.proposals[0].id = "x"));
    const at = new Date().toISOString();
    bad((t) => (t.rounds[0].questions[0].answer = { at }));
    bad((t) => (t.rounds[0].questions[0].answer = { at, option: 1, text: "x" }));
    bad((t) => (t.rounds[0].questions[0].answer = { at, text: "x", unknown: true }));
    bad((t) => (t.rounds[0].questions[0].answer = { at, option: 3 }));
    writeFileSync(refinementsPath(), good);
    expect(getSession(id)!.talk!.rounds).toHaveLength(1);
  });

  it("keeps the talk after a restart of the module state", () => {
    const { id } = seed();
    const before = getSession(id);
    expect(listSessions()[0]).toEqual(before);
  });
});
