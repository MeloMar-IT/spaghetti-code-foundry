import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dependencies } from "../src/queue/deps.js";
import { preview } from "../src/refinement/draft.js";
import {
  RefinementError,
  addDraft,
  checkRefinements,
  acceptProposal,
  createSession,
  dropSession,
  endArchitectRun,
  getSession,
  recordRound,
  refinementsPath,
  removeDraft,
  restoreSession,
  saveDraft,
  setArchitectRun,
  setEpic,
} from "../src/refinement/store.js";

const ANN = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const ADMIN = "33333333-3333-4333-8333-333333333333";
const OK = { ownerOk: () => true, repoName: (_o: string, name: string) => name };
const T = { repoOk: () => true };
// close to the real clock, because calls without `now` use it
const T0 = new Date();
const at = (ms: number) => ({ ...T, now: () => new Date(T0.getTime() + ms) });
const ann = { id: ANN, admin: false };
const admin = { id: ADMIN, admin: true };
let home: string;
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "refinement-draft-"));
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
const msg = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  return "";
};
const file = () => readFileSync(refinementsPath(), "utf8");
const edit = (fn: (f: any) => void) => {
  const f = JSON.parse(file());
  fn(f);
  writeFileSync(refinementsPath(), JSON.stringify(f));
};
const make = () => createSession(ANN, { repo: "acme/app", idea: "An idea" }, OK).id;
const add = (id: string) => addDraft(ann, id, T).drafts.at(-1)!.id;
const save = (id: string, did: string, body: unknown) => saveDraft(ann, id, did, body, T);
const draft = (id: string, did: string) => getSession(id)!.drafts.find((d) => d.id === did)!;
const U = "99999999-9999-4999-8999-999999999999";
const uuid = (i: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`;
const fill = (n: number) => Array.from({ length: n }, (_, i) => ({ at: new Date().toISOString(), by: ANN, what: "renamed", detail: `t${i}` }));
const padLog = (id: string, n: number) =>
  edit((f) => {
    const s = f.sessions.find((x: any) => x.id === id);
    s.log = [...s.log, ...fill(Math.max(0, n - s.log.length))].slice(0, n);
  });
const ok = () => expect(() => checkRefinements()).not.toThrow();
const unchanged = (fn: () => unknown, c: string) => {
  const before = file();
  expect(code(fn)).toBe(c);
  expect(file()).toBe(before);
};

describe("add and remove", () => {
  it("adds an empty draft, even with a brief, a map and an idea", () => {
    const id = make();
    setArchitectRun(ann, id, "run-1", {}, {});
    endArchitectRun(id, "run-1", { brief: { text: "The brief.", at: new Date().toISOString() } });
    recordRound(id, "run-2", { questions: [], proposals: [{ list: "rule", text: "Only admins export." }], done: "Done." });
    acceptProposal(ann, id, getSession(id)!.talk!.proposals[0]!.id, T);
    const s = addDraft(ann, id, T);
    expect(s.brief).toBeDefined();
    expect(s.drafts).toEqual([{ id: s.drafts[0]!.id, criteria: [], dependsOn: [] }]);
    expect(s.state).toBe("drafting");
    expect(s.log.at(-1)).toMatchObject({ what: "draft-added", by: ANN });
    expect(addDraft(ann, id, T).state).toBe("drafting");
    ok();
  });

  it("allows 20 drafts and refuses the 21st", () => {
    const id = make();
    for (let i = 0; i < 20; i++) add(id);
    unchanged(() => addDraft(ann, id, T), "limit");
  });

  it("removes a draft, and it from the depends-on lists of the others", () => {
    const id = make();
    const a = add(id);
    const b = add(id);
    save(id, b, { title: "Second", dependsOn: [{ draft: a }, { issue: 5 }] });
    save(id, a, { title: "First" });
    const s = removeDraft(ann, id, a, T);
    expect(s.drafts).toHaveLength(1);
    expect(s.drafts[0]!.dependsOn.map((d) => d.issue)).toEqual([5]);
    expect(s.log.at(-1)).toMatchObject({ what: "draft-removed", detail: "First" });
    ok();
    const c = add(id);
    const last = removeDraft(ann, id, c, T);
    expect(last.log.at(-1)).toMatchObject({ what: "draft-removed" });
    expect(last.log.at(-1)!.detail).toBeUndefined();
    expect(removeDraft(ann, id, b, T).state).toBe("exploring");
    expect(code(() => removeDraft(ann, id, b, T))).toBe("not-found");
  });
});

describe("saving", () => {
  it("changes only the fields in the body", () => {
    const id = make();
    const d = add(id);
    save(id, d, { title: "T", who: "a user" });
    save(id, d, { what: "to sign in" });
    expect(draft(id, d)).toMatchObject({ title: { text: "T" }, who: { text: "a user" }, what: { text: "to sign in" } });
    expect(draft(id, d).why).toBeUndefined();
  });

  it("round-trips all fields, trims, and writes no log line", () => {
    const id = make();
    const d = add(id);
    const logLen = getSession(id)!.log.length;
    const before = getSession(id)!.updated;
    const body = { title: " T ", who: "a", what: "b\r\nc", why: "d", criteria: [{ text: "one" }], outOfScope: "x", dependsOn: [{ issue: 3 }], notes: "n" };
    const s = saveDraft(ann, id, d, body, at(60_000));
    const x = s.drafts[0]!;
    expect(x).toEqual({
      id: d,
      title: { text: "T", from: "typed" },
      who: { text: "a", from: "typed" },
      what: { text: "b\nc", from: "typed" },
      why: { text: "d", from: "typed" },
      criteria: [{ id: expect.any(String), text: "one", from: "typed" }],
      outOfScope: { text: "x", from: "typed" },
      notes: { text: "n", from: "typed" },
      dependsOn: [{ id: expect.any(String), issue: 3, from: "typed" }],
    });
    expect(s.log).toHaveLength(logLen);
    expect(s.updated).toBe(new Date(T0.getTime() + 60_000).toISOString());
    expect(s.updated > before).toBe(true);
    // all fields again, with the ids of the list items: nothing changes, so `updated` stays
    const bytes = file();
    saveDraft(ann, id, d, { ...body, criteria: [{ id: x.criteria[0]!.id, text: "one" }], dependsOn: [{ id: x.dependsOn[0]!.id, issue: 3 }] }, at(120_000));
    expect(file()).toBe(bytes);
    // list rule "an item without `id` is new": the same text without its id is a new item, not a mistake
    const again = saveDraft(ann, id, d, body, at(180_000));
    const y = again.drafts[0]!;
    expect(y.criteria).toHaveLength(1);
    expect(y.criteria[0]).toMatchObject({ text: "one", from: "typed" });
    expect(y.criteria[0]!.id).not.toBe(x.criteria[0]!.id);
    expect(y.dependsOn).toHaveLength(1);
    expect(y.dependsOn[0]).toMatchObject({ issue: 3, from: "typed" });
    expect(y.dependsOn[0]!.id).not.toBe(x.dependsOn[0]!.id);
    expect(again.updated).toBe(new Date(T0.getTime() + 180_000).toISOString());
  });

  it("removes an emptied field", () => {
    const id = make();
    const d = add(id);
    for (const empty of ["", "  ", null, { text: null }]) {
      save(id, d, { title: "T" });
      expect(draft(id, d).title).toBeDefined();
      save(id, d, { title: empty });
      expect("title" in draft(id, d)).toBe(false);
    }
  });
});

describe("the record of where a text came from", () => {
  it("is typed for new text and ignores a forged value", () => {
    const id = make();
    const d = add(id);
    save(id, d, { title: { text: "T", from: "accepted" }, who: "a", from: "accepted", criteria: [{ text: "c", from: "accepted" }], dependsOn: [{ issue: 1, from: "accepted" }] });
    const x = draft(id, d);
    expect(x.title!.from).toBe("typed");
    expect(x.who!.from).toBe("typed");
    expect(x.criteria[0]!.from).toBe("typed");
    expect(x.dependsOn[0]!.from).toBe("typed");
    save(id, d, { title: "T2" });
    expect(draft(id, d).title!.from).toBe("typed");
  });

  it("turns accepted into accepted-edited only when the text changes", () => {
    const id = make();
    const a = add(id);
    const b = add(id);
    save(id, a, { title: "T", criteria: [{ text: "c" }], dependsOn: [{ issue: 1 }] });
    edit((f) => {
      const x = f.sessions[0].drafts[0];
      x.title.from = "accepted";
      x.criteria[0].from = "accepted";
      x.dependsOn[0].from = "accepted";
    });
    const x = draft(id, a);
    save(id, a, { title: "T", criteria: [{ id: x.criteria[0]!.id, text: "c" }], dependsOn: [{ id: x.dependsOn[0]!.id, issue: 1 }] });
    expect(draft(id, a).title!.from).toBe("accepted");
    expect(draft(id, a).criteria[0]!.from).toBe("accepted");
    expect(draft(id, a).dependsOn[0]!.from).toBe("accepted");
    save(id, a, { title: "T!", criteria: [{ id: x.criteria[0]!.id, text: "c!" }], dependsOn: [{ id: x.dependsOn[0]!.id, draft: b }] });
    let y = draft(id, a);
    expect([y.title!.from, y.criteria[0]!.from, y.dependsOn[0]!.from]).toEqual(["accepted-edited", "accepted-edited", "accepted-edited"]);
    save(id, a, { title: "T?" });
    expect(draft(id, a).title!.from).toBe("accepted-edited");
    edit((f) => (f.sessions[0].drafts[0].title.from = "accepted"));
    save(id, a, { title: "" });
    save(id, a, { title: "again" });
    y = draft(id, a);
    expect(y.title!.from).toBe("typed");
  });

  it("is typed for new text and new items in a draft that has accepted parts", () => {
    const id = make();
    const a = add(id);
    save(id, a, { title: "T", criteria: [{ text: "c" }], dependsOn: [{ issue: 1 }] });
    edit((f) => {
      const x = f.sessions[0].drafts[0];
      x.title.from = "accepted";
      x.criteria[0].from = "accepted";
      x.dependsOn[0].from = "accepted";
    });
    const x = draft(id, a);
    save(id, a, {
      who: "w",
      what: "x",
      why: "y",
      outOfScope: "o",
      notes: "n",
      criteria: [{ id: x.criteria[0]!.id, text: "c" }, { text: "new" }],
      dependsOn: [{ id: x.dependsOn[0]!.id, issue: 1 }, { issue: 2 }],
    });
    const y = draft(id, a);
    expect([y.who, y.what, y.why, y.outOfScope, y.notes].map((f) => f!.from)).toEqual(["typed", "typed", "typed", "typed", "typed"]);
    expect(y.criteria.map((c) => c.from)).toEqual(["accepted", "typed"]);
    expect(y.dependsOn.map((c) => c.from)).toEqual(["accepted", "typed"]);
    expect(y.title!.from).toBe("accepted");
  });
});

describe("lists", () => {
  it("keeps, changes, adds and removes items", () => {
    const id = make();
    const d = add(id);
    save(id, d, { criteria: [{ text: "a" }, { text: "b" }, { text: "c" }] });
    const [a, b, c] = draft(id, d).criteria;
    const before = a;
    const s = save(id, d, { criteria: [{ id: c!.id, text: "c" }, { id: a!.id, text: "a" }, { id: b!.id, text: "b2" }, { text: "new" }, { text: "" }] });
    const list = s.drafts[0]!.criteria;
    expect(list.map((x) => x.text)).toEqual(["c", "a", "b2", "new"]);
    expect(list[1]).toEqual(before);
    expect(list[2]!.id).toBe(b!.id);
    expect(list[3]!.id).not.toBe(a!.id);
    expect(save(id, d, { criteria: [{ id: a!.id, text: "a" }] }).drafts[0]!.criteria).toHaveLength(1);
  });

  it("refuses an unknown or repeated id", () => {
    const id = make();
    const d = add(id);
    save(id, d, { criteria: [{ text: "a" }] });
    const a = draft(id, d).criteria[0]!;
    unchanged(() => save(id, d, { criteria: [{ id: U, text: "x" }] }), "bad-draft");
    unchanged(() => save(id, d, { criteria: [{ id: a.id, text: "x" }, { id: a.id, text: "y" }] }), "bad-draft");
    unchanged(() => save(id, d, { criteria: "x" }), "bad-draft");
    unchanged(() => save(id, d, { criteria: [{}] }), "bad-draft");
  });
});

describe("depends on", () => {
  it("takes issues and other drafts", () => {
    const id = make();
    const a = add(id);
    const b = add(id);
    const s = save(id, a, { dependsOn: [{ issue: 12 }, { issue: Number.MAX_SAFE_INTEGER }, { draft: b }] });
    expect(s.drafts[0]!.dependsOn.map((x) => x.issue ?? x.draft)).toEqual([12, Number.MAX_SAFE_INTEGER, b]);
    ok();
  });

  it("refuses everything else", () => {
    const id = make();
    const other = make();
    const a = add(id);
    const o = add(other);
    const b = [
      [{ draft: a }],
      [{ draft: U }],
      [{ draft: o }],
      [{ issue: 1, draft: a }],
      [{}],
      [{ issue: 0 }],
      [{ issue: -1 }],
      [{ issue: 1.5 }],
      [{ issue: "12" }],
      [{ issue: 2 ** 53 }],
      [{ issue: 1 }, { issue: 1 }],
      "x",
    ];
    for (const list of b) unchanged(() => save(id, a, { dependsOn: list }), "bad-draft");
    save(id, a, { dependsOn: [{ issue: 1 }] });
    const x = draft(id, a).dependsOn[0]!;
    const sentence = "no such depends-on item in this draft; load the session again";
    unchanged(() => save(id, a, { dependsOn: [{ id: U, issue: 2 }] }), "bad-draft");
    unchanged(() => save(id, a, { dependsOn: [{ id: x.id, issue: 1 }, { id: x.id, issue: 2 }] }), "bad-draft");
    expect(msg(() => save(id, a, { dependsOn: [{ id: U, issue: 2 }] }))).toBe(sentence);
    expect(msg(() => save(id, a, { dependsOn: [{ id: x.id, issue: 1 }, { id: x.id, issue: 2 }] }))).toBe(sentence);
    expect(msg(() => save(id, a, { dependsOn: [{ issue: 2 ** 53 }] }))).toBe("the issue number is too large");
    unchanged(() => save(id, a, { dependsOn: Array.from({ length: 21 }, (_, i) => ({ issue: i + 1 })) }), "limit");
  });
});

describe("the Epic", () => {
  it("is set, replaced and cleared", () => {
    const id = make();
    expect(setEpic(ann, id, { issue: 73 }, T).epic).toBe(73);
    expect(setEpic(ann, id, { issue: 74 }, T).epic).toBe(74);
    const bytes = file();
    setEpic(ann, id, { issue: 74 }, T);
    expect(file()).toBe(bytes);
    const s = setEpic(ann, id, { issue: null }, T);
    expect(s.epic).toBeUndefined();
    expect("epic" in s).toBe(false);
    const b2 = file();
    setEpic(ann, id, { issue: null }, T);
    expect(file()).toBe(b2);
    expect(getSession(id)!.log.slice(-3).map((l) => [l.what, l.detail])).toEqual([["epic-set", "#73"], ["epic-set", "#74"], ["epic-cleared", undefined]]);
    expect(getSession(id)!.state).toBe("exploring");
    expect(setEpic(ann, id, { issue: Number.MAX_SAFE_INTEGER }, T).epic).toBe(Number.MAX_SAFE_INTEGER);
    ok();
  });

  it("changes the state only when the draft count crosses zero", () => {
    const id = make();
    edit((f) => (f.sessions[0].state = "drafting"));
    expect(setEpic(ann, id, { issue: 1 }, T).state).toBe("drafting");
    edit((f) => (f.sessions[0].state = "ready"));
    // a new draft is not ready (it has no check), so the session is drafting again; with no draft left it is exploring
    const d = add(id);
    expect(getSession(id)!.state).toBe("drafting");
    expect(removeDraft(ann, id, d, T).state).toBe("exploring");
  });

  it("refuses a bad value", () => {
    const id = make();
    for (const v of [{}, { issue: "73" }, { issue: 0 }, { issue: 1.5 }, { issue: -1 }, { issue: 2 ** 53 }, null]) unchanged(() => setEpic(ann, id, v, T), "bad-epic");
  });
});

describe("limits and bad text", () => {
  const field = (key: string, max: number) => {
    const id = make();
    const d = add(id);
    save(id, d, { [key]: "x".repeat(max) });
    const bytes = file();
    expect(code(() => save(id, d, { [key]: "x".repeat(max + 1) }))).toBe("bad-draft");
    expect(file()).toBe(bytes);
  };
  it("checks each text", () => {
    field("title", 120);
    field("who", 500);
    field("what", 500);
    field("why", 500);
    field("outOfScope", 5000);
    field("notes", 5000);
  });
  it("counts code points", () => {
    const id = make();
    const d = add(id);
    save(id, d, { title: "😀".repeat(120) });
    unchanged(() => save(id, d, { title: "😀".repeat(121) }), "bad-draft");
  });
  it("checks criteria", () => {
    const id = make();
    const d = add(id);
    save(id, d, { criteria: [{ text: "x".repeat(500) }] });
    unchanged(() => save(id, d, { criteria: [{ text: "x".repeat(501) }] }), "bad-draft");
    save(id, d, { criteria: Array.from({ length: 50 }, (_, i) => ({ text: `c${i}` })) });
    unchanged(() => save(id, d, { criteria: Array.from({ length: 51 }, (_, i) => ({ text: `c${i}` })) }), "limit");
  });
  it("keeps the title on one line", () => {
    const id = make();
    const d = add(id);
    for (const t of ["a\nb", "a b", "a b"]) expect(msg(() => save(id, d, { title: t }))).toBe("the title must be on one line");
    for (const t of ["a\tb", "a\rb", "a\u000bb", "a\u000cb", "a\u0085b"]) expect(msg(() => save(id, d, { title: t }))).toContain("characters that are not allowed");
    save(id, d, { what: "a b" });
    expect(preview(draft(id, d), getSession(id)!).body).toContain("I want a b,");
  });
  it("refuses control characters and non-text, and stores nothing of a bad body", () => {
    const id = make();
    const d = add(id);
    for (const k of ["title", "who", "what", "why", "outOfScope", "notes"]) {
      unchanged(() => save(id, d, { [k]: "a\u0001b" }), "bad-draft");
      unchanged(() => save(id, d, { [k]: 5 }), "bad-draft");
    }
    unchanged(() => save(id, d, { who: "fine", title: "a\u0001b" }), "bad-draft");
    expect(msg(() => save(id, d, { criteria: [{ text: "a\u0001b" }] }))).toBe("the criterion has characters that are not allowed");
    expect(msg(() => save(id, d, { criteria: [{ text: 5 }] }))).toBe("each criterion needs a text");
    unchanged(() => save(id, d, { criteria: [{ text: "a\u0001b" }] }), "bad-draft");
    unchanged(() => save(id, d, { criteria: [{ text: 5 }] }), "bad-draft");
    unchanged(() => save(id, d, { criteria: [{ text: "fine" }, { text: "a\u0001b" }] }), "bad-draft");
    unchanged(() => save(id, d, { who: "fine", criteria: [{ text: 5 }] }), "bad-draft");
    expect(draft(id, d).criteria).toEqual([]);
    expect(draft(id, d).who).toBeUndefined();
    unchanged(() => save(id, d, "text"), "bad-draft");
  });
});

describe("who may", () => {
  it("lets only the owner, in an open session with its repository", () => {
    const id = make();
    const d = add(id);
    const calls = (a: { id: string; admin: boolean }, o: { repoOk?: () => boolean } = T) => [
      () => addDraft(a, id, o),
      () => saveDraft(a, id, d, { title: "x".repeat(121) }, o),
      () => removeDraft(a, id, U, o),
      () => setEpic(a, id, {}, o),
    ];
    for (const c of calls({ id: BOB, admin: false })) expect(code(c)).toBe("not-found");
    for (const c of calls(admin)) expect(code(c)).toBe("not-owner");
    for (const c of [() => addDraft(ann, id, { repoOk: () => false }), () => removeDraft(ann, id, d, { repoOk: () => false }), () => setEpic(ann, id, { issue: 1 }, { repoOk: () => false }), () => saveDraft(ann, id, d, { title: "x" }, { repoOk: () => false })]) expect(code(c)).toBe("no-repo");
    dropSession(ann, id);
    for (const c of calls(ann)) expect(code(c)).toBe("bad-state");
    restoreSession(ann, id);
    expect(code(() => addDraft(ann, id, T))).toBeUndefined();
  });
});

describe("log room", () => {
  it("refuses a line without room, but still saves", () => {
    const id = make();
    const d = add(id);
    padLog(id, 999);
    unchanged(() => addDraft(ann, id, T), "limit");
    unchanged(() => removeDraft(ann, id, d, T), "limit");
    unchanged(() => setEpic(ann, id, { issue: 1 }, T), "limit");
    expect(code(() => save(id, d, { title: "ok" }))).toBeUndefined();
    padLog(id, 998);
    expect(code(() => addDraft(ann, id, T))).toBeUndefined();
  });
});

describe("the preview", () => {
  const full = (id: string) => {
    const a = add(id);
    const b = add(id);
    save(id, b, { title: "Sign in" });
    save(id, a, {
      title: "Export",
      who: "an admin",
      what: "to export a report",
      why: "I can share it",
      criteria: [{ text: "It downloads" }, { text: "It has\na header" }],
      outOfScope: "PDF",
      notes: "Use the old API",
      dependsOn: [{ issue: 12 }, { draft: b }],
    });
    setEpic(ann, id, { issue: 73 }, T);
    return a;
  };
  it("is exact with every part", () => {
    const id = make();
    const a = full(id);
    const p = preview(draft(id, a), getSession(id)!);
    expect(p.title).toBe("Export");
    expect(p.body).toBe(
      [
        "**Epic:** #73",
        "As an admin, I want to export a report, so that I can share it.",
        "### Acceptance criteria\n- [ ] It downloads\n- [ ] It has a header",
        "### Out of scope\nPDF",
        "### Notes for the builder\nUse the old API",
        "### Depends on\n- #12\n- Sign in (draft)",
      ].join("\n\n"),
    );
    const s = getSession(id)!;
    // The plain case only. The parser gets two cases wrong: a "Depends on" or "Blocked by" line in out of scope or the notes
    // is read first (src/queue/deps.ts:10-14), and a `#n` in a draft title is read as an issue (src/queue/deps.ts:33).
    expect(dependencies(p.body, 99, [{ number: 12, title: "Other" }, { number: 40, title: "Sign in" }])).toEqual([12, 40]);
    expect(dependencies(preview(draft(id, s.drafts[1]!.id), s).body, 99, [{ number: 12, title: "Other" }])).toEqual([]);
  });
  it("is exact when everything is empty", () => {
    const id = make();
    const d = add(id);
    const p = preview(draft(id, d), getSession(id)!);
    expect(p.title).toBe("");
    expect(p.body).toBe("As …, I want …, so that ….\n\n### Acceptance criteria\n\n### Depends on\nNone (can be built on its own).");
  });
  it("adds a full stop only when the why has none", () => {
    const id = make();
    const d = add(id);
    for (const w of ["x.", "x!", "x?"]) {
      save(id, d, { why: w });
      expect(preview(draft(id, d), getSession(id)!).body).toContain(`so that ${w}\n`);
    }
  });
  it("shows an untitled draft in depends on", () => {
    const id = make();
    const a = add(id);
    const b = add(id);
    save(id, a, { dependsOn: [{ draft: b }] });
    expect(preview(draft(id, a), getSession(id)!).body).toContain("- … (draft)");
  });
});

describe("the file", () => {
  it("loads an old session unchanged", () => {
    const id = make();
    edit((f) => {
      f.sessions[0].drafts = [];
      delete f.sessions[0].epic;
    });
    const bytes = file();
    checkRefinements();
    expect(file()).toBe(bytes);
    expect(getSession(id)!.drafts).toEqual([]);
  });

  it("survives a re-read", () => {
    const id = make();
    const d = add(id);
    save(id, d, { title: "T", criteria: [{ text: "c" }] });
    setEpic(ann, id, { issue: 5 }, T);
    expect(getSession(id)!.epic).toBe(5);
    expect(draft(id, d).title!.text).toBe("T");
  });

  const wrong: Record<string, (s: any) => void> = {
    "empty object": (s) => (s.drafts = [{}]),
    "unknown key": (s) => (s.drafts[0].extra = 1),
    "bad from": (s) => (s.drafts[0].title = { text: "T", from: "other" }),
    "title with newline": (s) => (s.drafts[0].title = { text: "a\nb", from: "typed" }),
    "both keys": (s) => (s.drafts[0].dependsOn = [{ id: uuid(1), issue: 1, draft: s.drafts[1].id, from: "typed" }]),
    "missing draft": (s) => (s.drafts[0].dependsOn = [{ id: uuid(1), draft: U, from: "typed" }]),
    "itself": (s) => (s.drafts[0].dependsOn = [{ id: uuid(1), draft: s.drafts[0].id, from: "typed" }]),
    "same draft id": (s) => (s.drafts[1].id = s.drafts[0].id),
    "same criterion id": (s) => (s.drafts[0].criteria = [1, 2].map((i) => ({ id: uuid(1), text: `c${i}`, from: "typed" }))),
    "same depends-on id": (s) => (s.drafts[0].dependsOn = [1, 2].map((i) => ({ id: uuid(1), issue: i, from: "typed" }))),
    "same issue twice": (s) => (s.drafts[0].dependsOn = [1, 2].map((i) => ({ id: uuid(i), issue: 1, from: "typed" }))),
    "same draft twice": (s) => (s.drafts[0].dependsOn = [1, 2].map((i) => ({ id: uuid(i), draft: s.drafts[1].id, from: "typed" }))),
    "21 drafts": (s) => (s.drafts = Array.from({ length: 21 }, (_, i) => ({ id: uuid(i), criteria: [], dependsOn: [] }))),
    "epic 0": (s) => (s.epic = 0),
  };
  for (const [name, fn] of Object.entries(wrong)) {
    it(`refuses: ${name}`, () => {
      const id = make();
      add(id);
      add(id);
      edit((f) => fn(f.sessions.find((x: any) => x.id === id)));
      expect(() => checkRefinements()).toThrow();
    });
  }
});
