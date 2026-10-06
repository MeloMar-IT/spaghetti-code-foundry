import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reviewView } from "../src/refinement/draft-review.js";
import {
  END_BAD_FORM,
  END_NO_REVIEW_DRAFT,
  LOG_LIMIT,
  RefinementError,
  addDraft,
  checkRefinements,
  createSession,
  dropSession,
  endArchitectRun,
  getSession,
  moveToNotesOf,
  refinementsPath,
  removeDraft,
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
  home = mkdtempSync(join(tmpdir(), "refinement-review-"));
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
const draft = (id: string, did: string) => getSession(id)!.drafts.find((d) => d.id === did)!;
const crit = (id: string, did: string, i = 0) => draft(id, did).criteria[i]!;

/** A session with one draft that has every reviewed field and two criteria, and a brief-less talk. */
function setup() {
  const id = createSession(ANN, { repo: "acme/app", idea: "An idea" }, OK).id;
  const did = addDraft(ann, id, T).drafts[0]!.id;
  saveDraft(ann, id, did, { title: "Export", who: "an admin", what: "to export a report", why: "to share it", outOfScope: "Printing", criteria: [{ text: "It is fast" }, { text: "It exports a file" }] }, T);
  return { id, did, c1: crit(id, did, 0).id, c2: crit(id, did, 1).id };
}
const textsOf = (id: string, did: string) => {
  const d = draft(id, did);
  const refs: Record<string, { id?: string; text: string }> = {};
  for (const k of ["title", "who", "what", "why", "outOfScope"] as const) if (d[k]) refs[k] = { text: d[k]!.text };
  d.criteria.forEach((c, i) => (refs[`C${i + 1}`] = { id: c.id, text: c.text }));
  return refs;
};
/** A review run of the draft, ended with this output; `refs` are the texts as they were when it was asked (default: as they are now). */
function reviewed(id: string, did: string, remarks: unknown, refs = textsOf(id, did)) {
  const runId = `v-${++runs}`;
  setArchitectRun(ann, id, runId, { kind: "review", draft: did });
  return endArchitectRun(id, runId, { reviewed: { remarks }, refs });
}
const remark = (field: string, kind: string, text = "A remark.", item?: string) => ({ field, kind, text, ...(item ? { item } : {}) });
const without = (d: object, key: string) => {
  const { [key]: _gone, ...rest } = d as Record<string, unknown>;
  return rest;
};

describe("a stored review", () => {
  it("is stored with the draft, and no other key of the draft changes", () => {
    const { id, did } = setup();
    const before = draft(id, did);
    const s = reviewed(id, did, [remark("what", "how", "It says how."), remark("criteria", "uncheckable", "Nobody can check it.", "C1")])!;
    expect(s.architect).toBeUndefined();
    const after = s.drafts[0]!;
    expect(without(after, "review")).toEqual(before);
    expect(after.review!.remarks).toEqual([
      { field: "what", kind: "how", text: "It says how.", about: "to export a report" },
      { field: "criteria", item: crit(id, did).id, kind: "uncheckable", text: "Nobody can check it.", about: "It is fast" },
    ]);
    expect(s.log.slice(-2).map((l) => [l.what, l.detail])).toEqual([["review-asked", undefined], ["architect-reviewed", "2"]]);
  });

  it("stores all five kinds", () => {
    const { id, did } = setup();
    const kinds = ["uncheckable", "vague", "contradiction", "how", "plan"];
    reviewed(id, did, kinds.map((k) => (k === "uncheckable" ? remark("criteria", k, "Text.", "C1") : remark("why", k))));
    expect(draft(id, did).review!.remarks.map((r) => r.kind)).toEqual(kinds);
  });

  it("replaces the old review, and an empty review is stored as an empty list", () => {
    const { id, did } = setup();
    reviewed(id, did, [remark("what", "how")]);
    reviewed(id, did, [remark("why", "vague"), remark("title", "plan")]);
    expect(draft(id, did).review!.remarks.map((r) => r.field)).toEqual(["why", "title"]);
    reviewed(id, did, []);
    expect(draft(id, did).review!.remarks).toEqual([]);
    expect(getSession(id)!.log.at(-1)).toMatchObject({ what: "architect-reviewed", detail: "0" });
  });

  it.each([
    ["21 remarks", Array.from({ length: 21 }, () => remark("what", "how"))],
    ["a text of 301 characters", [remark("what", "how", "a".repeat(301))]],
    ["a text of three sentences", [remark("what", "how", "One. Two. Three.")]],
    ["a text with a line break", [remark("what", "how", "One.\nTwo.")]],
    ["an unknown kind", [remark("what", "nope")]],
    ["uncheckable on a text field", [remark("why", "uncheckable")]],
    ["an unknown field", [remark("notes", "how")]],
    ["an item on a text field", [remark("what", "how", "Text.", "C1")]],
    ["a criterion without an item", [remark("criteria", "how")]],
    ["an item that is not a number", [remark("criteria", "how", "Text.", "x1")]],
    ["an extra key", [{ ...remark("what", "how"), extra: 1 }]],
    ["no text", [remark("what", "how", "")]],
    ["a remark that is no object", ["what"]],
  ])("is a bad form for %s: nothing changes", (_n, remarks) => {
    const { id, did } = setup();
    reviewed(id, did, [remark("what", "how")]);
    const runId = "bad";
    setArchitectRun(ann, id, runId, { kind: "review", draft: did });
    const before = draft(id, did);
    const s = endArchitectRun(id, runId, { reviewed: { remarks }, refs: textsOf(id, did) })!;
    expect(s.architect).toMatchObject({ failed: END_BAD_FORM });
    expect(s.drafts[0]).toEqual(before);
  });

  it("is a bad form when the answer has other keys or is no object", () => {
    const { id, did } = setup();
    for (const out of [{ remarks: [], extra: 1 }, { remarks: "x" }, "x", null]) {
      setArchitectRun(ann, id, "o", { kind: "review", draft: did });
      expect(endArchitectRun(id, "o", { reviewed: out, refs: {} })!.architect).toMatchObject({ failed: END_BAD_FORM });
      edit((f) => delete f.sessions[0].architect);
    }
    expect(draft(id, did).review).toBeUndefined();
  });

  it("leaves out a remark whose text was not in the task", () => {
    const { id, did } = setup();
    const refs = textsOf(id, did);
    delete refs.why;
    delete refs.C2;
    reviewed(id, did, [remark("why", "vague"), remark("criteria", "how", "Text.", "C2"), remark("criteria", "how", "Text.", "C9"), remark("what", "how")], refs);
    expect(draft(id, did).review!.remarks.map((r) => r.field)).toEqual(["what"]);
  });

  it("is stale for a text that changed after the review was asked, also when the run ends later", () => {
    const { id, did } = setup();
    const asked = textsOf(id, did);
    const runId = "late";
    setArchitectRun(ann, id, runId, { kind: "review", draft: did });
    saveDraft(ann, id, did, { what: "to export it all", criteria: [{ id: crit(id, did, 1).id, text: "It exports a file" }] }, T);
    endArchitectRun(id, runId, { reviewed: { remarks: [remark("what", "how"), remark("why", "vague"), remark("criteria", "uncheckable", "Text.", "C1")] }, refs: asked });
    const v = reviewView(draft(id, did))!;
    expect(v.remarks.map((r) => [r.field, r.stale])).toEqual([["what", true], ["why", undefined], ["criteria", true]]);
  });
});

describe("the view of a review", () => {
  it("is fresh, has no about, then is stale after a change, after the criterion is removed, and when the field is emptied", () => {
    const { id, did, c1 } = setup();
    reviewed(id, did, [remark("why", "vague"), remark("criteria", "uncheckable", "Text.", "C1")]);
    const v = reviewView(draft(id, did))!;
    expect(v.remarks).toEqual([
      { field: "why", kind: "vague", text: "A remark." },
      { field: "criteria", item: c1, kind: "uncheckable", text: "Text." },
    ]);
    expect(JSON.stringify(v)).not.toContain("about");
    saveDraft(ann, id, did, { why: "to share it widely" }, T);
    expect(reviewView(draft(id, did))!.remarks.map((r) => r.stale)).toEqual([true, undefined]);
    saveDraft(ann, id, did, { criteria: [{ id: crit(id, did, 1).id, text: "It exports a file" }] }, T);
    expect(reviewView(draft(id, did))!.remarks.map((r) => r.stale)).toEqual([true, true]);
    saveDraft(ann, id, did, { why: null }, T);
    expect(reviewView(draft(id, did))!.remarks[0]!.stale).toBe(true);
  });

  it("is undefined without a review", () => {
    const { id, did } = setup();
    expect(reviewView(draft(id, did))).toBeUndefined();
  });
});

describe("a run that does not end in a review", () => {
  it("fails with END_NO_REVIEW_DRAFT when the draft is gone or the run was not a review", () => {
    const { id, did } = setup();
    setArchitectRun(ann, id, "gone", { kind: "review", draft: did });
    removeDraft(ann, id, did, T);
    expect(endArchitectRun(id, "gone", { reviewed: { remarks: [] } })!.architect).toMatchObject({ failed: END_NO_REVIEW_DRAFT });
    const other = setup();
    setArchitectRun(ann, other.id, "round", { kind: "round" });
    expect(endArchitectRun(other.id, "round", { reviewed: { remarks: [] } })!.architect).toMatchObject({ failed: END_NO_REVIEW_DRAFT });
  });

  it("keeps the old review when the run failed", () => {
    const { id, did } = setup();
    reviewed(id, did, [remark("what", "how")]);
    setArchitectRun(ann, id, "f", { kind: "review", draft: did });
    const s = endArchitectRun(id, "f", { failed: "It was cancelled" })!;
    expect(s.drafts[0]!.review!.remarks).toHaveLength(1);
    expect(s.architect).toMatchObject({ kind: "review", failed: "It was cancelled" });
  });

  it("is refused to start without a draft", () => {
    const { id } = setup();
    expect(() => setArchitectRun(ann, id, "x", { kind: "review" })).toThrow();
  });
});

describe("the file", () => {
  it("loads a session without a review, and refuses a bad review run or review", () => {
    const { id, did } = setup();
    expect(() => checkRefinements()).not.toThrow();
    setArchitectRun(ann, id, "r", { kind: "review", draft: did });
    expect(() => checkRefinements()).not.toThrow();
    edit((f) => (f.sessions[0].architect.field = "title"));
    expect(() => checkRefinements()).toThrow();
    edit((f) => {
      delete f.sessions[0].architect.field;
      delete f.sessions[0].architect.draft;
    });
    expect(() => checkRefinements()).toThrow();
    edit((f) => delete f.sessions[0].architect);
    reviewed(id, did, [remark("what", "how")]);
    edit((f) => (f.sessions[0].drafts[0].review.remarks = Array.from({ length: 21 }, () => f.sessions[0].drafts[0].review.remarks[0])));
    expect(() => checkRefinements()).toThrow();
  });
});

describe("move to notes", () => {
  it("moves a typed text into empty notes as a Wish line, stays typed, and logs it", () => {
    const { id, did } = setup();
    saveDraft(ann, id, did, { what: "to edit src/a.ts" }, T);
    const s = moveToNotesOf(ann, id, did, { field: "what" }, T);
    const d = s.drafts[0]!;
    expect(d.what).toBeUndefined();
    expect(d.notes).toEqual({ text: "Wish: to edit src/a.ts", from: "typed" });
    expect(s.log.at(-1)).toMatchObject({ what: "moved-to-notes", detail: "what" });
  });

  it("adds to typed notes on a new line and stays typed; a multi-line text becomes one line", () => {
    const { id, did } = setup();
    saveDraft(ann, id, did, { notes: "Old note", outOfScope: "Use src/a.ts\nand src/b.ts" }, T);
    const d = moveToNotesOf(ann, id, did, { field: "outOfScope" }, T).drafts[0]!;
    expect(d.outOfScope).toBeUndefined();
    expect(d.notes).toEqual({ text: "Old note\nWish: Use src/a.ts and src/b.ts", from: "typed" });
  });

  it("is accepted-edited when the text or the notes were accepted", () => {
    const { id, did } = setup();
    saveDraft(ann, id, did, { what: "to edit src/a.ts" }, T);
    edit((f) => (f.sessions[0].drafts[0].what.from = "accepted"));
    expect(moveToNotesOf(ann, id, did, { field: "what" }, T).drafts[0]!.notes!.from).toBe("accepted-edited");
    const two = setup();
    saveDraft(ann, two.id, two.did, { what: "to edit src/a.ts", notes: "Old" }, T);
    edit((f) => (f.sessions[1].drafts[0].notes.from = "accepted"));
    expect(moveToNotesOf(ann, two.id, two.did, { field: "what" }, T).drafts[0]!.notes!.from).toBe("accepted-edited");
  });

  it("moves a criterion out of the list, and keeps the review as it was", () => {
    const { id, did, c2 } = setup();
    saveDraft(ann, id, did, { criteria: [{ id: crit(id, did, 0).id, text: "It is fast" }, { id: c2, text: "It calls saveDraft()" }] }, T);
    reviewed(id, did, [remark("criteria", "how", "Text.", "C2")]);
    const before = draft(id, did).review;
    const d = moveToNotesOf(ann, id, did, { field: "criteria", item: c2 }, T).drafts[0]!;
    expect(d.criteria.map((c) => c.text)).toEqual(["It is fast"]);
    expect(d.notes!.text).toBe("Wish: It calls saveDraft()");
    expect(d.review).toEqual(before);
    expect(reviewView(d)!.remarks[0]!.stale).toBe(true);
  });

  it("is allowed by a fresh review plan remark, and by a fresh review how remark", () => {
    const { id, did } = setup();
    reviewed(id, did, [remark("why", "plan"), remark("what", "how")]);
    expect(moveToNotesOf(ann, id, did, { field: "why" }, T).drafts[0]!.notes!.text).toBe("Wish: to share it");
    expect(moveToNotesOf(ann, id, did, { field: "what" }, T).drafts[0]!.notes!.text).toBe("Wish: to share it\nWish: to export a report");
  });

  it("is allowed by a plan remark of the code checks", () => {
    const { id, did } = setup();
    saveDraft(ann, id, did, { why: "see src/a.ts" }, T);
    expect(moveToNotesOf(ann, id, did, { field: "why" }, T).drafts[0]!.notes!.text).toBe("Wish: see src/a.ts");
  });

  it("is refused without a remark, and for a vague or uncheckable remark, a stale how remark, and a text that was moved", () => {
    const { id, did, c1 } = setup();
    unchanged(() => moveToNotesOf(ann, id, did, { field: "what" }, T), "bad-state");
    reviewed(id, did, [remark("what", "vague"), remark("criteria", "uncheckable", "Text.", "C1"), remark("why", "how")]);
    unchanged(() => moveToNotesOf(ann, id, did, { field: "what" }, T), "bad-state");
    unchanged(() => moveToNotesOf(ann, id, did, { field: "criteria", item: c1 }, T), "bad-state");
    saveDraft(ann, id, did, { why: "to share it more" }, T);
    unchanged(() => moveToNotesOf(ann, id, did, { field: "why" }, T), "bad-state");
    expect(draft(id, did).notes).toBeUndefined();
  });

  it("is refused for a bad request", () => {
    const { id, did } = setup();
    reviewed(id, did, [remark("what", "how")]);
    for (const input of [null, {}, { field: "notes" }, { field: "dependsOn" }, { field: "what", item: "x" }, { field: "criteria" }, { field: 5 }]) {
      unchanged(() => moveToNotesOf(ann, id, did, input, T), "bad-draft");
    }
    unchanged(() => moveToNotesOf(ann, id, did, { field: "criteria", item: "00000000-0000-4000-8000-000000000000" }, T), "not-found");
    unchanged(() => moveToNotesOf(ann, id, "00000000-0000-4000-8000-000000000000", { field: "what" }, T), "not-found");
    saveDraft(ann, id, did, { what: null }, T);
    unchanged(() => moveToNotesOf(ann, id, did, { field: "what" }, T), "not-found");
  });

  it("is refused when the notes have no room", () => {
    const { id, did } = setup();
    reviewed(id, did, [remark("what", "how")]);
    saveDraft(ann, id, did, { notes: "n".repeat(4995) }, T);
    unchanged(() => moveToNotesOf(ann, id, did, { field: "what" }, T), "limit");
  });

  it("is for the owner only, in an open session with a log that has room", () => {
    const { id, did } = setup();
    reviewed(id, did, [remark("what", "how")]);
    unchanged(() => moveToNotesOf({ id: BOB, admin: false }, id, did, { field: "what" }, T), "not-found");
    unchanged(() => moveToNotesOf({ id: ADMIN, admin: true }, id, did, { field: "what" }, T), "not-owner");
    unchanged(() => moveToNotesOf(ann, id, did, { field: "what" }, { repoOk: () => false }), "no-repo");
    edit((f) => {
      const log = f.sessions[0].log;
      while (log.length < LOG_LIMIT - 1) log.push({ ...log[0], what: "renamed", detail: "x" });
    });
    unchanged(() => moveToNotesOf(ann, id, did, { field: "what" }, T), "limit");
    edit((f) => f.sessions[0].log.length = 3);
    dropSession(ann, id);
    unchanged(() => moveToNotesOf(ann, id, did, { field: "what" }, T), "bad-state");
  });
});
