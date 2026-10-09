import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DependantSchema,
  EVIDENCE_MAX,
  JOURNAL_MAX,
  ReplacingSchema,
  mergeJournal,
  partsOf,
  replaceStarted,
  replaceState,
  type Dependant,
} from "../src/refinement/replace-journal.js";
import {
  LOG_LIMIT,
  RefinementError,
  addDraft,
  beginPublishing,
  checkRefinements,
  createSession,
  createSessionFromIssue,
  endPublishing,
  getSession,
  recordDependantDone,
  recordDependantWrite,
  recordReplaced,
  recordReplacing,
  refinementsPath,
} from "../src/refinement/store.js";

const ANN = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const ann = { id: ANN, admin: false };
const bob = { id: BOB, admin: false };
const admin = { id: BOB, admin: true };
const OK = { ownerOk: () => true, repoName: (_o: string, name: string) => name };
const T = { repoOk: () => true };
let home: string;
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "refinement-replace-journal-"));
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
const file = () => readFileSync(refinementsPath(), "utf8");
const edit = (fn: (f: any) => void) => {
  const f = JSON.parse(file());
  fn(f);
  writeFileSync(refinementsPath(), JSON.stringify(f));
};
const padLog = (id: string, n: number) =>
  edit((f) => {
    const s = f.sessions.find((x: any) => x.id === id);
    while (s.log.length < n) s.log.push({ at: new Date().toISOString(), by: ANN, what: "renamed", detail: "x" });
  });
const unchanged = (fn: () => unknown, c: string) => {
  const before = file();
  expect(code(fn)).toBe(c);
  expect(file()).toBe(before);
  expect(() => checkRefinements()).not.toThrow();
};
const source = { issue: 12, url: "https://github.com/acme/app/issues/12", title: "T", body: "", updatedAt: "2026-01-01T00:00:00.000Z" };
const makeFromIssue = (n = 12) => createSessionFromIssue(ANN, { repo: "acme/app", title: "T", idea: "T", source: { ...source, issue: n, url: `https://github.com/acme/app/issues/${n}` } }, OK).id;
const pub = (n: number) => ({ issue: n, url: `https://github.com/acme/app/issues/${n}`, at: "2026-01-02T00:00:00.000Z" });

/** A session from issue 12 whose first draft (the mark) is split into two parts. Returns the ids. */
const makeSplit = (n = 12) => {
  const id = makeFromIssue(n);
  addDraft(ann, id, T);
  addDraft(ann, id, T);
  addDraft(ann, id, T);
  const ids = getSession(id)!.drafts.map((d) => d.id) as [string, string, string];
  edit((f) => {
    const s = f.sessions.find((x: any) => x.id === id);
    s.source.draft = ids[0];
    s.drafts[0].splitInto = [ids[1], ids[2]];
    s.drafts[1].part = { of: ids[0] };
    s.drafts[2].part = { of: ids[0] };
  });
  return { id, ids };
};
const publish = (id: string, which: number[]) =>
  edit((f) => {
    for (const i of which) f.sessions.find((x: any) => x.id === id).drafts[i].published = pub(40 + i);
  });
const dep = (issue: number, more: Partial<Dependant> = {}): Dependant => ({ issue, title: `Issue ${issue}`, ...more });
const started = (n = 12) => {
  const { id } = makeSplit(n);
  recordReplacing(ann, id, { parts: [40, 41], found: [dep(5), dep(3)] }, T);
  return id;
};

describe("the schema", () => {
  it("loads a file without the new fields, and with all of them", () => {
    const id = makeFromIssue();
    expect(() => checkRefinements()).not.toThrow();
    edit((f) => {
      f.sessions[0].source.replacing = { parts: [40], cut: true, dependants: [{ ...dep(5), byHand: true, before: "a", after: "b", rangeBefore: "c", rangeAfter: "d", outcome: "kept-as-is", done: true }] };
      f.sessions[0].source.replacedBy = [40];
      f.sessions[0].source.closed = "open";
      f.sessions[0].source.closedAt = "2026-01-03T00:00:00.000Z";
    });
    expect(() => checkRefinements()).not.toThrow();
    expect(getSession(id)!.source!.replacedBy).toEqual([40]);
  });

  it.each([
    ["1,001 dependants", { parts: [1], dependants: Array.from({ length: 1001 }, (_, i) => dep(i + 1)) }],
    ["an unknown key", { parts: [1], dependants: [{ ...dep(1), x: 1 }] }],
    ["no parts", { parts: [], dependants: [] }],
    ["a duplicate part", { parts: [1, 1], dependants: [] }],
    ["cut false", { parts: [1], cut: false, dependants: [] }],
    ["a duplicate dependant", { parts: [1], dependants: [dep(2), dep(2)] }],
  ])("refuses %s", (_n, replacing) => {
    makeFromIssue();
    edit((f) => (f.sessions[0].source.replacing = replacing));
    expect(() => checkRefinements()).toThrow();
  });

  it("refuses closed: done", () => {
    makeFromIssue();
    edit((f) => (f.sessions[0].source.closed = "done"));
    expect(() => checkRefinements()).toThrow();
  });
});

describe("replaceState and replaceStarted", () => {
  it("is undefined without a source, for a draft that is not split, and without a mark", () => {
    const plain = createSession(ANN, { repo: "acme/app", idea: "An idea" }, OK).id;
    expect(replaceState(getSession(plain)!)).toBeUndefined();
    expect(replaceStarted(getSession(plain)!)).toBe(false);
    const id = makeFromIssue();
    addDraft(ann, id, T);
    expect(replaceState(getSession(id)!)).toBeUndefined();
    edit((f) => (f.sessions[1].drafts[0].published = pub(50)));
    expect(replaceStarted(getSession(id)!)).toBe(false);
    edit((f) => {
      delete f.sessions[1].source.draft;
      f.sessions[1].log.push({ at: new Date().toISOString(), by: ANN, what: "draft-removed" });
    });
    expect(replaceState(getSession(id)!)).toBeUndefined();
  });

  it("waits until every part is published, then is due", () => {
    const { id } = makeSplit();
    expect(replaceState(getSession(id)!)).toBe("waiting");
    expect(replaceStarted(getSession(id)!)).toBe(false);
    publish(id, [1]);
    expect(replaceState(getSession(id)!)).toBe("waiting");
    expect(replaceStarted(getSession(id)!)).toBe(true);
    publish(id, [1, 2]);
    expect(replaceState(getSession(id)!)).toBe("due");
  });

  it("is done when replacedBy is set, also when the draft is no longer split", () => {
    const { id } = makeSplit();
    edit((f) => {
      f.sessions[0].source.replacedBy = [41, 42];
      delete f.sessions[0].drafts[0].splitInto;
      delete f.sessions[0].drafts[1].part;
      delete f.sessions[0].drafts[2].part;
    });
    expect(replaceState(getSession(id)!)).toBe("done");
  });

  it("is started with a journal", () => {
    expect(replaceStarted(getSession(started())!)).toBe(true);
  });

  it("counts only the leaves of a nested split (partsOf, on a synthetic graph)", () => {
    const d = (id: string, more: object = {}) => ({ id, criteria: [], dependsOn: [], ...more }) as any;
    const drafts = [d("a", { splitInto: ["b", "c"] }), d("b", { splitInto: ["d", "e"] }), d("c"), d("d"), d("e"), d("x")];
    expect(partsOf(drafts, "a").map((p) => p.id)).toEqual(["d", "e", "c"]);
    expect(partsOf(drafts, "c")).toEqual([]);
    expect(partsOf(drafts, "missing")).toEqual([]);
    const loop = [d("a", { splitInto: ["b", "a", "zz"] }), d("b", { splitInto: ["a"] })];
    expect(partsOf(loop, "a")).toEqual([]);
  });
});

describe("mergeJournal", () => {
  it("takes the scan for an open entry and keeps rangeBefore", () => {
    const stored = [dep(1, { byHand: true, before: "old", after: "old2", rangeBefore: "r", outcome: "x" })];
    const r = mergeJournal(stored, [{ issue: 1, title: "New", after: "n" }]);
    expect(r).toEqual({ dependants: [{ issue: 1, title: "New", after: "n", rangeBefore: "r", outcome: "x" }] });
    expect("cut" in r).toBe(false);
  });

  it("keeps entries with rangeAfter or done, found or not, and keeps open ones that are gone", () => {
    const a = dep(1, { rangeAfter: "ra", title: "A" });
    const b = dep(2, { done: true, outcome: "ok", title: "B" });
    const c = dep(3);
    const r = mergeJournal([a, b, c], [{ issue: 1, title: "Z" }]);
    expect(r.dependants).toEqual([a, b, c]);
    expect(r.dependants[2]).toBe(c);
  });

  it("keeps a missing open entry through repeated merges, and keeps it once it is done", () => {
    const c = dep(3);
    const once = mergeJournal([c], []).dependants;
    expect(mergeJournal(once, []).dependants).toEqual([c]);
    const done = { ...c, outcome: "by-hand", done: true as const };
    expect(mergeJournal([done], []).dependants).toEqual([done]);
  });

  it("adds new entries after the stored ones, by number, once", () => {
    const r = mergeJournal([dep(9, { done: true })], [dep(7), dep(3), { issue: 3, title: "again" }, dep(5)]);
    expect(r.dependants.map((d) => d.issue)).toEqual([9, 3, 5, 7]);
    expect(r.dependants[1]!.title).toBe("Issue 3");
  });

  it("collapses a duplicate number in the stored journal", () => {
    expect(mergeJournal([dep(1), dep(1, { title: "other" })], [dep(1)]).dependants).toHaveLength(1);
  });

  it("does not change its input", () => {
    const stored = [dep(1, { rangeBefore: "r" }), dep(2, { done: true })];
    const found = [dep(9), dep(1, { byHand: true })];
    const s0 = structuredClone(stored);
    const f0 = structuredClone(found);
    mergeJournal(stored, found);
    expect(stored).toEqual(s0);
    expect(found).toEqual(f0);
  });

  it("cuts at the limit and the result still passes the schema", () => {
    const stored = Array.from({ length: 998 }, (_, i) => dep(i + 1, i % 2 ? { rangeAfter: "r" } : {}));
    const found = [...stored.map((d) => ({ issue: d.issue, title: d.title })), ...[2000, 1500, 1600, 1700, 1800].map((n) => dep(n))];
    const r = mergeJournal(stored, found);
    expect(r.dependants).toHaveLength(JOURNAL_MAX);
    expect(r.cut).toBe(true);
    const nums = r.dependants.map((d) => d.issue);
    expect(stored.every((d) => nums.includes(d.issue))).toBe(true);
    expect(nums.slice(998)).toEqual([1500, 1600]);
    expect(ReplacingSchema.safeParse({ parts: [1], cut: true, dependants: r.dependants }).success).toBe(true);
  });

  it("keeps entries at the evidence limit valid", () => {
    const long = "x".repeat(EVIDENCE_MAX);
    expect(DependantSchema.safeParse(dep(1, { before: long, after: long, rangeBefore: long, rangeAfter: long })).success).toBe(true);
    expect(DependantSchema.safeParse(dep(1, { before: long + "x" })).success).toBe(false);
  });
});

describe("recordReplacing", () => {
  it("stores parts and journal, merges on a second call, and keeps cut", () => {
    const { id } = makeSplit();
    const s = recordReplacing(ann, id, { parts: [40, 41], found: [dep(5), dep(3)] }, T);
    expect(s.source!.replacing).toEqual({ parts: [40, 41], dependants: [dep(3), dep(5)] });
    const s2 = recordReplacing(ann, id, { parts: [40, 41], found: [dep(3, { title: "N" }), dep(8)], cut: true }, T);
    expect(s2.source!.replacing).toEqual({ parts: [40, 41], cut: true, dependants: [dep(3, { title: "N" }), dep(5), dep(8)] });
    expect(recordReplacing(ann, id, { parts: [40, 41], found: [dep(3)] }, T).source!.replacing!.cut).toBe(true);
    expect(() => checkRefinements()).not.toThrow();
  });

  it("makes cut sticky when the merge cuts", () => {
    const { id } = makeSplit();
    recordReplacing(ann, id, { parts: [40], found: Array.from({ length: 1001 }, (_, i) => dep(i + 1)) }, T);
    const s = recordReplacing(ann, id, { parts: [40], found: [] }, T);
    expect(s.source!.replacing!.cut).toBe(true);
  });

  it("refuses without a source, after replacedBy, and with invalid parts", () => {
    const plain = createSession(ANN, { repo: "acme/app", idea: "An idea" }, OK).id;
    unchanged(() => recordReplacing(ann, plain, { parts: [1], found: [] }, T), "bad-state");
    const { id } = makeSplit(13);
    unchanged(() => recordReplacing(ann, id, { parts: [], found: [] }, T), "bad-state");
    unchanged(() => recordReplacing(ann, id, { parts: [1, 1], found: [] }, T), "bad-state");
    edit((f) => (f.sessions.find((x: any) => x.id === id).source.replacedBy = [40]));
    unchanged(() => recordReplacing(ann, id, { parts: [40], found: [] }, T), "bad-state");
  });
});

describe("recordDependantWrite", () => {
  const ev = { before: "b", after: "a", rangeBefore: "rb", rangeAfter: "ra" };
  it("stores the evidence on the right entry only", () => {
    const id = started();
    const s = recordDependantWrite(ann, id, 5, ev, T);
    expect(s.source!.replacing!.dependants).toEqual([dep(3), dep(5, ev)]);
    expect(() => checkRefinements()).not.toThrow();
  });

  it("is a no-op for the same evidence and refuses other evidence", () => {
    const id = started();
    recordDependantWrite(ann, id, 5, ev, T);
    const before = file();
    recordDependantWrite(ann, id, 5, ev, T);
    expect(file()).toBe(before);
    unchanged(() => recordDependantWrite(ann, id, 5, { ...ev, rangeAfter: "other" }, T), "bad-state");
  });

  it("refuses without a journal, an unknown issue, a done entry and too long text", () => {
    const { id } = makeSplit();
    unchanged(() => recordDependantWrite(ann, id, 5, ev, T), "bad-state");
    const id2 = started(13);
    unchanged(() => recordDependantWrite(ann, id2, 99, ev, T), "not-found");
    unchanged(() => recordDependantWrite(ann, id2, 5, { ...ev, before: "x".repeat(EVIDENCE_MAX + 1) }, T), "bad-state");
    recordDependantDone(ann, id2, 3, "kept", T);
    unchanged(() => recordDependantWrite(ann, id2, 3, ev, T), "bad-state");
  });
});

describe("recordDependantDone", () => {
  it("sets outcome and done together; the same call again changes nothing; another outcome is refused", () => {
    const id = started();
    const s = recordDependantDone(ann, id, 3, "rewritten", T);
    expect(s.source!.replacing!.dependants[0]).toEqual(dep(3, { outcome: "rewritten", done: true }));
    const before = file();
    recordDependantDone(ann, id, 3, "rewritten", T);
    expect(file()).toBe(before);
    unchanged(() => recordDependantDone(ann, id, 3, "other", T), "bad-state");
  });

  it("refuses an unknown issue and a bad outcome", () => {
    const id = started();
    unchanged(() => recordDependantDone(ann, id, 99, "ok", T), "not-found");
    unchanged(() => recordDependantDone(ann, id, 3, "Not OK!", T), "bad-state");
  });
});

describe("recordReplaced", () => {
  it.each(["not_planned", "other", "open"] as const)("ends the replacement (%s)", (closed) => {
    const id = started();
    const logBefore = getSession(id)!.log.length;
    const s = recordReplaced(ann, id, { closed, closedAt: "2026-02-01T00:00:00.000Z" }, T);
    expect(s.source!.replacedBy).toEqual([40, 41]);
    expect(s.source!.closed).toBe(closed);
    expect(s.source!.closedAt).toBe("2026-02-01T00:00:00.000Z");
    expect(s.source!.replacing).toBeUndefined();
    expect(s.log).toHaveLength(logBefore + 1);
    expect(s.log.at(-1)).toMatchObject({ what: "issue-replaced", detail: "#12: #40, #41", by: ANN });
    expect(s.updated >= s.created).toBe(true);
    const before = file();
    recordReplaced(ann, id, { closed }, T);
    expect(file()).toBe(before);
    expect(() => checkRefinements()).not.toThrow();
  });

  it("leaves closedAt out when not given", () => {
    const id = started();
    expect("closedAt" in recordReplaced(ann, id, { closed: "open" }, T).source!).toBe(false);
  });

  it("refuses without a journal and a bad closedAt", () => {
    const { id } = makeSplit();
    unchanged(() => recordReplaced(ann, id, { closed: "open" }, T), "bad-state");
    const id2 = started(13);
    unchanged(() => recordReplaced(ann, id2, { closed: "open", closedAt: "yesterday" }, T), "bad-state");
  });

  it("refuses when the log is full", () => {
    const id = started();
    padLog(id, LOG_LIMIT - 1);
    unchanged(() => recordReplaced(ann, id, { closed: "open" }, T), "limit");
  });
});

describe("who may write", () => {
  it("all four work while the session is being published", () => {
    const { id } = makeSplit();
    expect(beginPublishing(id)).toBe(true);
    try {
      recordReplacing(ann, id, { parts: [40, 41], found: [dep(3)] }, T);
      recordDependantWrite(ann, id, 3, { before: "b", after: "a", rangeBefore: "x", rangeAfter: "y" }, T);
      recordDependantDone(ann, id, 3, "ok", T);
      expect(recordReplaced(ann, id, { closed: "open" }, T).source!.replacedBy).toEqual([40, 41]);
    } finally {
      endPublishing(id);
    }
    expect(() => checkRefinements()).not.toThrow();
  });

  it("refuses a stranger and an admin who is not the owner", () => {
    const id = started();
    const all = (a: { id: string; admin: boolean }) => [
      () => recordReplacing(a, id, { parts: [1], found: [] }, T),
      () => recordDependantWrite(a, id, 3, { before: "", after: "", rangeBefore: "", rangeAfter: "" }, T),
      () => recordDependantDone(a, id, 3, "ok", T),
      () => recordReplaced(a, id, { closed: "open" }, T),
    ];
    for (const f of all(bob)) unchanged(f, "not-found");
    for (const f of all(admin)) unchanged(f, "not-owner");
  });
});
