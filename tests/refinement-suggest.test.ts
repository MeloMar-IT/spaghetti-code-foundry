import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  END_BAD_FORM,
  END_NO_DRAFT,
  RefinementError,
  acceptProposal,
  acceptSuggestionOf,
  addDraft,
  changeEntry,
  checkRefinements,
  createSession,
  dropSession,
  endArchitectRun,
  getSession,
  recordRound,
  refinementsPath,
  rejectSuggestionOf,
  removeDraft,
  removeEntry,
  saveDraft,
  setArchitectRun,
} from "../src/refinement/store.js";

const ANN = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const ADMIN = "33333333-3333-4333-8333-333333333333";
const OK = { ownerOk: () => true, repoName: (_o: string, name: string) => name };
const T = { repoOk: () => true };
const ann = { id: ANN, admin: false };
let home: string;
let saved: string | undefined;
let runs = 0;

beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "refinement-suggest-"));
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
const unchanged = (fn: () => unknown, c: string) => {
  const before = file();
  expect(code(fn)).toBe(c);
  expect(file()).toBe(before);
};
const whats = (id: string) => getSession(id)!.log.map((l) => l.what);

/** A session with one rule, one example and two drafts. */
function setup() {
  const id = createSession(ANN, { repo: "acme/app", idea: "An idea" }, OK).id;
  recordRound(id, "run-r", { questions: [], proposals: [{ list: "rule", text: "Only admins export." }, { list: "example", text: "An empty report." }], done: "Done." });
  for (const p of getSession(id)!.talk!.proposals) acceptProposal(ann, id, p.id, T);
  const d1 = addDraft(ann, id, T).drafts[0]!.id;
  const d2 = addDraft(ann, id, T).drafts[1]!.id;
  const talk = getSession(id)!.talk!;
  return { id, d1, d2, rule: talk.map.rules[0]!.id, example: talk.map.examples[0]!.id };
}
/** The suggestion run of a field of a draft, ended with this output. */
function suggested(id: string, draft: string, field: any, suggestions: unknown[], refs: Record<string, string> = {}) {
  const runId = `s-${++runs}`;
  setArchitectRun(ann, id, runId, { kind: "suggest", draft, field }, {});
  return endArchitectRun(id, runId, { suggested: { field, suggestions }, refs });
}
const draft = (id: string, did: string) => getSession(id)!.drafts.find((d) => d.id === did)!;
const waiting = (id: string, did: string) => draft(id, did).suggestions ?? [];

describe("accept", () => {
  it("puts the text into a text field as accepted, removes the suggestion and logs it; the preview has it only then", () => {
    const { id, d1 } = setup();
    suggested(id, d1, "title", [{ text: "Export a report" }]);
    expect(draft(id, d1).title).toBeUndefined();
    const sid = waiting(id, d1)[0]!.id;
    const s = acceptSuggestionOf(ann, id, d1, sid, {}, T);
    expect(s.drafts[0]!.title).toEqual({ text: "Export a report", from: "accepted" });
    expect(s.drafts[0]!.suggestions).toBeUndefined();
    expect(s.log.at(-1)).toMatchObject({ what: "suggestion-accepted", detail: "title" });
  });

  it("records an edited text as accepted-edited, also when the text is the same", () => {
    const { id, d1 } = setup();
    suggested(id, d1, "what", [{ text: "to export" }]);
    const sid = waiting(id, d1)[0]!.id;
    expect(acceptSuggestionOf(ann, id, d1, sid, { text: "to export it" }, T).drafts[0]!.what).toEqual({ text: "to export it", from: "accepted-edited" });
    suggested(id, d1, "why", [{ text: "to share" }]);
    expect(acceptSuggestionOf(ann, id, d1, waiting(id, d1)[0]!.id, { text: "to share" }, T).drafts[0]!.why!.from).toBe("accepted-edited");
  });

  it("stores a maximum-length emoji suggestion and reason, and the file still loads", () => {
    const { id, d1 } = setup();
    const big = "😀".repeat(5000);
    suggested(id, d1, "notes", [{ text: big }]);
    expect(waiting(id, d1)[0]!.text).toBe(big);
    expect(code(() => checkRefinements())).toBeUndefined();
    rejectSuggestionOf(ann, id, d1, waiting(id, d1)[0]!.id, { reason: "😀".repeat(300) }, T);
    expect(draft(id, d1).rejected![0]).toEqual({ field: "notes", text: big, reason: "😀".repeat(300) });
    expect(code(() => checkRefinements())).toBeUndefined();
  });

  it("refuses an empty, a too long and a two-line title, and changes nothing", () => {
    const { id, d1 } = setup();
    suggested(id, d1, "title", [{ text: "Fine" }]);
    const sid = waiting(id, d1)[0]!.id;
    for (const text of ["  ", "x".repeat(121), "one\ntwo", 5]) unchanged(() => acceptSuggestionOf(ann, id, d1, sid, { text }, T), "bad-draft");
    unchanged(() => acceptSuggestionOf(ann, id, d1, sid, "x", T), "bad-draft");
  });

  it("adds a criterion with its tie; edit and accept and a typed edit keep the tie", () => {
    const { id, d1, rule, example } = setup();
    suggested(id, d1, "criteria", [{ text: "It downloads.", from: "R1" }, { text: "Empty works.", from: "E1" }], { R1: rule, E1: example });
    const [a, b] = waiting(id, d1);
    expect(a).toMatchObject({ field: "criteria", tie: rule });
    const s1 = acceptSuggestionOf(ann, id, d1, a!.id, {}, T);
    expect(s1.drafts[0]!.criteria[0]).toMatchObject({ text: "It downloads.", from: "accepted", tie: rule });
    expect(s1.drafts[0]!.criteria[0]!.id).not.toBe(a!.id);
    const s2 = acceptSuggestionOf(ann, id, d1, b!.id, { text: "Empty works well." }, T);
    expect(s2.drafts[0]!.criteria[1]).toMatchObject({ from: "accepted-edited", tie: example });
    const c = s2.drafts[0]!.criteria[0]!;
    const s3 = saveDraft(ann, id, d1, { criteria: [{ id: c.id, text: "It downloads fast." }, ...s2.drafts[0]!.criteria.slice(1)] }, T);
    expect(s3.drafts[0]!.criteria[0]).toMatchObject({ from: "accepted-edited", tie: rule });
  });

  it("refuses the 51st criterion as a limit and keeps the suggestion", () => {
    const { id, d1, rule } = setup();
    saveDraft(ann, id, d1, { criteria: Array.from({ length: 50 }, (_, i) => ({ text: `c${i}` })) }, T);
    suggested(id, d1, "criteria", [{ text: "One more.", from: "R1" }], { R1: rule });
    unchanged(() => acceptSuggestionOf(ann, id, d1, waiting(id, d1)[0]!.id, {}, T), "limit");
    expect(waiting(id, d1)).toHaveLength(1);
  });

  it("adds an issue and a draft to depends on, refuses a text, and leaves the list alone for a target that is there", () => {
    const { id, d1, d2 } = setup();
    suggested(id, d1, "dependsOn", [{ issue: 12 }, { draft: "D2" }], { D2: d2 });
    const [a, b] = waiting(id, d1);
    unchanged(() => acceptSuggestionOf(ann, id, d1, a!.id, { text: "#12" }, T), "bad-draft");
    const s = acceptSuggestionOf(ann, id, d1, a!.id, {}, T);
    expect(s.drafts[0]!.dependsOn).toMatchObject([{ issue: 12, from: "accepted" }]);
    expect(acceptSuggestionOf(ann, id, d1, b!.id, {}, T).drafts[0]!.dependsOn).toMatchObject([{ issue: 12 }, { draft: d2, from: "accepted" }]);
    saveDraft(ann, id, d1, { dependsOn: [{ issue: 7 }] }, T);
    suggested(id, d1, "dependsOn", [{ issue: 9 }]);
    saveDraft(ann, id, d1, { dependsOn: [{ issue: 7 }, { issue: 9 }] }, T);
    const before = draft(id, d1).dependsOn;
    const after = acceptSuggestionOf(ann, id, d1, waiting(id, d1)[0]!.id, {}, T);
    expect(after.drafts[0]!.dependsOn).toEqual(before);
    expect(after.drafts[0]!.suggestions).toBeUndefined();
  });
});

describe("reject", () => {
  it("removes the suggestion and keeps its text, with a reason or without", () => {
    const { id, d1 } = setup();
    suggested(id, d1, "who", [{ text: "an admin" }]);
    const s = rejectSuggestionOf(ann, id, d1, waiting(id, d1)[0]!.id, { reason: " too vague " }, T);
    expect(s.drafts[0]!.suggestions).toBeUndefined();
    expect(s.drafts[0]!.who).toBeUndefined();
    expect(s.drafts[0]!.rejected).toEqual([{ field: "who", text: "an admin", reason: "too vague" }]);
    expect(s.log.at(-1)).toMatchObject({ what: "suggestion-rejected", detail: "who" });
    suggested(id, d1, "what", [{ text: "to export" }]);
    expect(rejectSuggestionOf(ann, id, d1, waiting(id, d1)[0]!.id, undefined, T).drafts[0]!.rejected!.at(-1)).toEqual({ field: "what", text: "to export" });
  });

  it("refuses a reason that is too long, not text, or has a control character", () => {
    const { id, d1 } = setup();
    suggested(id, d1, "who", [{ text: "an admin" }]);
    const sid = waiting(id, d1)[0]!.id;
    for (const reason of ["x".repeat(301), 5, "a\u0007b"]) unchanged(() => rejectSuggestionOf(ann, id, d1, sid, { reason }, T), "bad-text");
    expect(rejectSuggestionOf(ann, id, d1, sid, { reason: "x".repeat(300) }, T).drafts[0]!.rejected).toHaveLength(1);
  });

  it("keeps the newest 30, and a depends-on suggestion as #12", () => {
    const { id, d1 } = setup();
    for (let i = 0; i < 32; i++) {
      suggested(id, d1, "notes", [{ text: `n${i}` }]);
      rejectSuggestionOf(ann, id, d1, waiting(id, d1)[0]!.id, {}, T);
    }
    const kept = draft(id, d1).rejected!;
    expect(kept).toHaveLength(30);
    expect(kept[0]!.text).toBe("n2");
    suggested(id, d1, "dependsOn", [{ issue: 12 }]);
    rejectSuggestionOf(ann, id, d1, waiting(id, d1)[0]!.id, {}, T);
    expect(draft(id, d1).rejected!.at(-1)).toEqual({ field: "dependsOn", text: "#12" });
  });
});

describe("the end of a run", () => {
  it("replaces the waiting suggestions of its field and keeps those of the others; a text field keeps 1 of 2", () => {
    const { id, d1 } = setup();
    suggested(id, d1, "who", [{ text: "a" }]);
    suggested(id, d1, "what", [{ text: "b" }]);
    suggested(id, d1, "who", [{ text: "c" }]);
    expect(waiting(id, d1).map((x) => [x.field, x.text])).toEqual([["what", "b"], ["who", "c"]]);
    const runId = "two";
    setArchitectRun(ann, id, runId, { kind: "suggest", draft: d1, field: "why" }, {});
    expect(endArchitectRun(id, runId, { suggested: { field: "why", suggestions: [{ text: "x" }, { text: "y" }] } })!.architect?.failed).toBe(END_BAD_FORM);
  });

  it("keeps at most 20 waiting per draft", () => {
    const { id, d1, rule } = setup();
    saveDraft(ann, id, d1, { dependsOn: [] }, T);
    suggested(id, d1, "dependsOn", Array.from({ length: 10 }, (_, i) => ({ issue: i + 1 })));
    suggested(id, d1, "criteria", Array.from({ length: 10 }, (_, i) => ({ text: `c${i}`, from: "R1" })), { R1: rule });
    expect(waiting(id, d1)).toHaveLength(20);
    suggested(id, d1, "notes", [{ text: "no room" }]);
    expect(waiting(id, d1)).toHaveLength(20);
    expect(waiting(id, d1).some((x) => x.field === "notes")).toBe(false);
  });

  it("leaves out what is not in the map, a draft that is unknown, itself, a target that is there, and repeats", () => {
    const { id, d1, d2, rule } = setup();
    suggested(id, d1, "criteria", [{ text: "ok", from: "R1" }, { text: "no rule", from: "R9" }, { text: "no example", from: "E7" }], { R1: rule });
    expect(waiting(id, d1).map((x) => x.text)).toEqual(["ok"]);
    saveDraft(ann, id, d1, { dependsOn: [{ issue: 5 }] }, T);
    suggested(id, d1, "dependsOn", [{ issue: 5 }, { issue: 6 }, { issue: 6 }, { draft: "D1" }, { draft: "D2" }, { draft: "D2" }, { draft: "D9" }], { D1: d1, D2: d2 });
    expect(waiting(id, d1).filter((x) => x.field === "dependsOn").map((x) => x.issue ?? x.draft)).toEqual([6, d2]);
    suggested(id, d1, "criteria", [{ text: "ok", from: "R1" }]);
    expect(waiting(id, d1).filter((x) => x.field === "criteria")).toHaveLength(0);
  });

  it("fails with the form sentence for a wrong form and changes no draft", () => {
    const { id, d1, rule } = setup();
    const before = JSON.stringify(getSession(id)!.drafts);
    const bad = (field: string, suggestions: unknown[], as = field) => {
      const runId = `b-${++runs}`;
      setArchitectRun(ann, id, runId, { kind: "suggest", draft: d1, field: field as any }, {});
      const s = endArchitectRun(id, runId, { suggested: { field: as, suggestions }, refs: { R1: rule } })!;
      expect(s.architect?.failed).toBe(END_BAD_FORM);
      endArchitectRun(id, runId, { failed: "x" });
      edit((f) => delete f.sessions[0].architect);
    };
    bad("title", [{ text: "t", from: "R1" }]);
    bad("criteria", [{ text: "c" }]);
    bad("title", [{ text: "t" }], "who");
    expect(JSON.stringify(getSession(id)!.drafts)).toBe(before);
  });

  it("fails with END_NO_DRAFT when the draft is gone or the run was a round, and a failed run changes no suggestion", () => {
    const { id, d1, d2 } = setup();
    const runId = "gone";
    setArchitectRun(ann, id, runId, { kind: "suggest", draft: d2, field: "title" }, {});
    removeDraft(ann, id, d2, T);
    expect(endArchitectRun(id, runId, { suggested: { field: "title", suggestions: [] } })!.architect?.failed).toBe(END_NO_DRAFT);
    edit((f) => delete f.sessions[0].architect);
    setArchitectRun(ann, id, "round-1", { kind: "round" }, {});
    expect(endArchitectRun(id, "round-1", { suggested: { field: "title", suggestions: [] } })!.architect?.failed).toBe(END_NO_DRAFT);
    edit((f) => delete f.sessions[0].architect);
    suggested(id, d1, "title", [{ text: "keep me" }]);
    setArchitectRun(ann, id, "f-1", { kind: "suggest", draft: d1, field: "title" }, {});
    endArchitectRun(id, "f-1", { failed: "It was cancelled" });
    expect(waiting(id, d1).map((x) => x.text)).toEqual(["keep me"]);
  });

  it("throws for a suggestion run without a draft or a field", () => {
    const { id } = setup();
    expect(() => setArchitectRun(ann, id, "x", { kind: "suggest" }, {})).toThrow();
  });
});

describe("the map and other drafts", () => {
  it("removeEntry strips the tie and removes waiting suggestions from that entry in one write; changeEntry keeps the tie", () => {
    const { id, d1, rule, example } = setup();
    suggested(id, d1, "criteria", [{ text: "from rule", from: "R1" }, { text: "from example", from: "E1" }], { R1: rule, E1: example });
    acceptSuggestionOf(ann, id, d1, waiting(id, d1)[0]!.id, {}, T);
    changeEntry(ann, id, rule, "Only admins may export.", T);
    expect(draft(id, d1).criteria[0]!.tie).toBe(rule);
    const s = removeEntry(ann, id, rule, T);
    expect(s.drafts[0]!.criteria[0]).toMatchObject({ text: "from rule" });
    expect(s.drafts[0]!.criteria[0]!.tie).toBeUndefined();
    expect(s.drafts[0]!.suggestions).toMatchObject([{ text: "from example", tie: example }]);
    expect(code(() => checkRefinements())).toBeUndefined();
    const t = removeEntry(ann, id, example, T);
    expect(t.drafts[0]!.suggestions).toBeUndefined();
  });

  it("removeDraft removes the suggestions in other drafts that name it", () => {
    const { id, d1, d2 } = setup();
    suggested(id, d1, "dependsOn", [{ draft: "D2" }, { issue: 3 }], { D2: d2 });
    removeDraft(ann, id, d2, T);
    expect(waiting(id, d1)).toMatchObject([{ issue: 3 }]);
    expect(code(() => checkRefinements())).toBeUndefined();
  });

  it("ignores suggestions and rejected in a typed save", () => {
    const { id, d1 } = setup();
    suggested(id, d1, "title", [{ text: "kept" }]);
    saveDraft(ann, id, d1, { suggestions: [], rejected: [{ field: "who", text: "x" }], title: "mine" }, T);
    expect(waiting(id, d1)).toHaveLength(1);
    expect(draft(id, d1).rejected).toBeUndefined();
  });
});

describe("the file", () => {
  it("loads a session without the new keys", () => {
    setup();
    expect(code(() => checkRefinements())).toBeUndefined();
    expect(file()).not.toContain("suggestions");
  });

  it("refuses a suggestion with both issue and draft, a criterion suggestion without a tie, 21 suggestions and an unknown draft", () => {
    const { id, d1, d2, rule } = setup();
    const uuid = (i: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`;
    const put = (suggestions: unknown[]) => edit((f) => (f.sessions[0].drafts[0].suggestions = suggestions));
    const ok = { id: uuid(1), field: "title", text: "t" };
    put([ok]);
    expect(code(() => checkRefinements())).toBeUndefined();
    for (const bad of [
      [{ id: uuid(1), field: "dependsOn", issue: 1, draft: d2 }],
      [{ id: uuid(1), field: "criteria", text: "no tie" }],
      Array.from({ length: 21 }, (_, i) => ({ id: uuid(i + 1), field: "title", text: "t" })),
      [{ id: uuid(1), field: "dependsOn", draft: uuid(99) }],
      [{ id: uuid(1), field: "criteria", text: "x", tie: uuid(98) }],
    ]) {
      put(bad);
      expect(() => checkRefinements()).toThrow();
    }
    put([{ id: uuid(1), field: "criteria", text: "x", tie: rule }]);
    expect(code(() => checkRefinements())).toBeUndefined();
    edit((f) => delete f.sessions[0].talk);
    expect(() => checkRefinements()).toThrow();
    expect(d1).toBeDefined();
  });

  it("refuses a suggest run without draft or field, and a round with a field", () => {
    const { id } = setup();
    const at = new Date().toISOString();
    edit((f) => (f.sessions[0].architect = { runId: "r", at, kind: "suggest" }));
    expect(() => checkRefinements()).toThrow();
    edit((f) => (f.sessions[0].architect = { runId: "r", at, kind: "round", field: "title" }));
    expect(() => checkRefinements()).toThrow();
    expect(id).toBeDefined();
  });

  it("gives a new id on accept: a suggestion with the id of a criterion still loads, and the file loads after", () => {
    const { id, d1, rule } = setup();
    saveDraft(ann, id, d1, { criteria: [{ text: "first" }] }, T);
    const cid = draft(id, d1).criteria[0]!.id;
    edit((f) => (f.sessions[0].drafts[0].suggestions = [{ id: cid, field: "criteria", text: "same id", tie: rule }]));
    expect(code(() => checkRefinements())).toBeUndefined();
    acceptSuggestionOf(ann, id, d1, cid, {}, T);
    const ids = draft(id, d1).criteria.map((c) => c.id);
    expect(new Set(ids).size).toBe(2);
    expect(code(() => checkRefinements())).toBeUndefined();
  });
});

describe("who may", () => {
  it("another user gets not-found, an admin not-owner, a dropped session bad-state, a gone repository no-repo", () => {
    const { id, d1 } = setup();
    suggested(id, d1, "title", [{ text: "t" }]);
    const sid = waiting(id, d1)[0]!.id;
    for (const call of [
      (a: any, o: any = T) => acceptSuggestionOf(a, id, d1, sid, {}, o),
      (a: any, o: any = T) => rejectSuggestionOf(a, id, d1, sid, {}, o),
    ]) {
      unchanged(() => call({ id: BOB, admin: false }), "not-found");
      unchanged(() => call({ id: ADMIN, admin: true }), "not-owner");
      unchanged(() => call(ann, { repoOk: () => false }), "no-repo");
    }
    dropSession(ann, id);
    unchanged(() => acceptSuggestionOf(ann, id, d1, sid, {}, T), "bad-state");
    unchanged(() => rejectSuggestionOf(ann, id, d1, sid, {}, T), "bad-state");
  });

  it("needs a log line: refused when the log is full", () => {
    const { id, d1 } = setup();
    suggested(id, d1, "title", [{ text: "t" }]);
    const sid = waiting(id, d1)[0]!.id;
    edit((f) => {
      const s = f.sessions[0];
      s.log = [...s.log, ...Array.from({ length: 999 - s.log.length }, () => ({ at: new Date().toISOString(), by: ANN, what: "renamed", detail: "x" }))];
    });
    unchanged(() => acceptSuggestionOf(ann, id, d1, sid, {}, T), "limit");
    unchanged(() => rejectSuggestionOf(ann, id, d1, sid, {}, T), "limit");
  });
});
