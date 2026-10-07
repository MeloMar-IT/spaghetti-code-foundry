import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { askOfJob, kindOfRun } from "../src/refinement/architect.js";
import { dropDraft } from "../src/refinement/draft.js";
import { draftMark } from "../src/refinement/draft-impact.js";
import { confirmSplit } from "../src/refinement/draft-parts.js";
import { END_NO_SPLIT_DRAFT, SPLIT_OWN_MAX, SPLIT_READ_ONLY, confirmRefusal, ownWay, refuseSplit, splitRefusal, splitView, type SplitRefs } from "../src/refinement/draft-split.js";
import { OWN_WAY_HEADING, splitOf, splitText } from "../src/refinement/split-text.js";
import {
  END_BAD_FORM,
  END_ON_GITHUB,
  END_SPLIT_DURING,
  RefinementError,
  acceptAnywayOf,
  acceptSuggestionOf,
  addDraft,
  checkReadyOf,
  checkRefinements,
  confirmSplitOf,
  createSession,
  endArchitectRun,
  getSession,
  moveToNotesOf,
  refinementsPath,
  rejectSuggestionOf,
  removeAcceptedOf,
  removeDraft,
  saveDraft,
  setReviewLabelOf,
  setArchitectRun,
} from "../src/refinement/store.js";
import { emptyTalk } from "../src/refinement/talk.js";
import { TALK_FIRST_LINE, TALK_MAX_BYTES, byteLength } from "../src/refinement/talk-text.js";
import { REFINE_ROUND_FLOW } from "../src/flow/usage.js";

const ANN = "11111111-1111-4111-8111-111111111111";
const OK = { ownerOk: () => true, repoName: (_o: string, name: string) => name };
const T = { repoOk: () => true };
const ann = { id: ANN, admin: false };
let home: string;
let saved: string | undefined;
let runs = 0;

beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "refinement-split-"));
  process.env.FACTORY_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const draft = (id: string, did: string) => getSession(id)!.drafts.find((d) => d.id === did)!;
const without = (d: object, key: string) => {
  const { [key]: _gone, ...rest } = d as Record<string, unknown>;
  return rest;
};
function setup(criteria = [{ text: "It is fast" }, { text: "It exports a file" }, { text: "It is logged" }]) {
  const id = createSession(ANN, { repo: "acme/app", idea: "An idea" }, OK).id;
  const did = addDraft(ann, id, T).drafts[0]!.id;
  saveDraft(ann, id, did, { title: "Export", who: "an admin", what: "to export a report", why: "to share it", outOfScope: "Printing", criteria }, T);
  return { id, did };
}
const refsOf = (id: string, did: string): SplitRefs => ({ criteria: Object.fromEntries(draft(id, did).criteria.map((c, i) => [`C${i + 1}`, c.id])), mark: draftMark(draft(id, did)) });
const story = (title: string, criteria: string[], dependsOn: number[] = []) => ({ title, sentence: `Do ${title}.`, criteria, dependsOn });
const way = (cut = "step", over: Record<string, unknown> = {}) => ({
  cut,
  stories: [story("First part", ["C1", "C2"]), story("Second part", ["C3"], [1])],
  first: "Start with the first part.",
  unplaced: [],
  warnings: [],
  ...over,
});
const ANSWER = () => ({ ways: [way("step"), way("rule", { stories: [story("Rules", ["C1"]), story("Export", ["C2"])], unplaced: ["C3"] })] });
/** A split run of the draft, ended with this output; `refs` default to the draft as it is now. */
function split(id: string, did: string, output: unknown = ANSWER(), refs?: SplitRefs) {
  const runId = `s-${++runs}`;
  setArchitectRun(ann, id, runId, { kind: "split", draft: did });
  return endArchitectRun(id, runId, { split: output, refs: refs ?? refsOf(id, did) });
}
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof RefinementError ? e.code : e;
  }
  return undefined;
};

describe("storing ways", () => {
  it("stores the checked ways with criterion ids, changes no field and no state, and logs it", () => {
    const { id, did } = setup();
    const before = getSession(id)!;
    const d = draft(id, did);
    const s = split(id, did)!;
    const stored = s.drafts[0]!.split!;
    expect(stored.ways).toHaveLength(2);
    expect(stored.ways[0]!.stories[0]!.criteria).toEqual([d.criteria[0]!.id, d.criteria[1]!.id]);
    expect(stored.ways[1]!.unplaced).toEqual([d.criteria[2]!.id]);
    expect(stored.mark).toBe(draftMark(d));
    expect(without(s.drafts[0]!, "split")).toEqual(before.drafts[0]);
    expect(s.state).toBe(before.state);
    expect(s.talk).toEqual(before.talk);
    expect(s.architect).toBeUndefined();
    expect(s.log.slice(-2).map((l) => l.what)).toEqual(["split-asked", "architect-split"]);
    expect(s.log.at(-1)!.detail).toBe("2");
    expect(() => checkRefinements()).not.toThrow();
  });

  it("replaces older ways, and stores nothing without a run", () => {
    const { id, did } = setup();
    split(id, did);
    const s = split(id, did, { ways: [way("data")] })!;
    expect(s.drafts[0]!.split!.ways.map((w) => w.cut)).toEqual(["data"]);
    expect(endArchitectRun(id, "nope", { split: ANSWER(), refs: refsOf(id, did) })).toBeUndefined();
    expect(getSession(id)!.drafts[0]!.split!.ways).toHaveLength(1);
  });

  it("shows the ways without the mark, and out of date after a change of the draft", () => {
    const { id, did } = setup();
    split(id, did);
    const v = splitView(draft(id, did))!;
    expect(v).not.toHaveProperty("mark");
    expect(v.outOfDate).toBeUndefined();
    const c = draft(id, did).criteria;
    saveDraft(ann, id, did, { criteria: [{ id: c[0]!.id, text: "It is very fast" }, { id: c[1]!.id, text: c[1]!.text }, { id: c[2]!.id, text: c[2]!.text }] }, T);
    expect(splitView(draft(id, did))!.outOfDate).toBe(true);
  });

  it("is out of date after a criterion is replaced by one with the same text, and after the notes change", () => {
    const a = setup();
    split(a.id, a.did);
    saveDraft(ann, a.id, a.did, { criteria: [{ text: "It is fast" }, { text: "It exports a file" }, { text: "It is logged" }] }, T);
    expect(splitView(draft(a.id, a.did))!.outOfDate).toBe(true);
    const b = setup();
    split(b.id, b.did);
    saveDraft(ann, b.id, b.did, { notes: "A note" }, T);
    expect(splitView(draft(b.id, b.did))!.outOfDate).toBe(true);
  });

  it("is out of date when the mark of the task is older than the draft", () => {
    const { id, did } = setup();
    const refs = refsOf(id, did);
    saveDraft(ann, id, did, { why: "to share it widely" }, T);
    split(id, did, ANSWER(), refs);
    expect(splitView(draft(id, did))!.outOfDate).toBe(true);
  });
});

describe("a wrong form", () => {
  const bad = (name: string, output: unknown) =>
    it(name, () => {
      const { id, did } = setup();
      const first = split(id, did, { ways: [way("data")] })!;
      const s = split(id, did, output)!;
      expect(s.architect!.failed).toBe(END_BAD_FORM);
      expect(s.drafts[0]!.split).toEqual(first.drafts[0]!.split);
    });
  const w = way;
  const sty = story;
  bad("no ways", { ways: [] });
  bad("4 ways", { ways: [w("step"), w("interface"), w("data"), w("rule")] });
  bad("the same cut twice", { ways: [w("step"), w("step")] });
  bad("one story", { ways: [w("step", { stories: [sty("One", ["C1", "C2", "C3"])] })] });
  bad("7 stories", { ways: [w("step", { stories: Array.from({ length: 7 }, (_, i) => sty(`S${i}`, i === 0 ? ["C1", "C2", "C3"] : [])) })] });
  bad("an unknown key", { ways: [w("step", { extra: 1 })] });
  bad("an unknown key in the answer", { ways: [w("step")], more: 1 });
  bad("a title of 121 characters", { ways: [w("step", { stories: [sty("x".repeat(121), ["C1", "C2"]), sty("B", ["C3"])] })] });
  bad("two sentences in a sentence", { ways: [w("step", { stories: [{ ...sty("A", ["C1", "C2"]), sentence: "One. Two." }, sty("B", ["C3"])] })] });
  bad("a line break", { ways: [w("step", { first: "One\nTwo" })] });
  bad("a tab", { ways: [w("step", { first: "One\tTwo" })] });
  bad("two days", { ways: [w("step", { first: "It takes two days." })] });
  bad("a day", { ways: [w("step", { first: "It takes a day." })] });
  bad("a C number that is not in the refs", { ways: [w("step", { stories: [sty("A", ["C1", "C2", "C9"]), sty("B", ["C3"])] })] });
  bad("a C number in two stories", { ways: [w("step", { stories: [sty("A", ["C1", "C2"]), sty("B", ["C2", "C3"])] })] });
  bad("a C number in a story and in unplaced", { ways: [w("step", { unplaced: ["C1"] })] });
  bad("a missing C number", { ways: [w("step", { stories: [sty("A", ["C1"]), sty("B", ["C3"])] })] });
  bad("unplaced twice", { ways: [w("step", { stories: [sty("A", ["C1", "C2"]), sty("B", [])], unplaced: ["C3", "C3"] })] });
  bad("a story that depends on itself", { ways: [w("step", { stories: [sty("A", ["C1", "C2"]), sty("B", ["C3"], [2])] })] });
  bad("a story that depends on a later one", { ways: [w("step", { stories: [sty("A", ["C1", "C2"], [2]), sty("B", ["C3"])] })] });
  bad("a repeated dependency", { ways: [w("step", { stories: [sty("A", ["C1", "C2"]), sty("B", ["C3"], [1, 1])] })] });
  bad("a warning with an unknown story", { ways: [w("step", { warnings: [{ kind: "layer", story: 3, why: "It is a layer." }] })] });
  bad("same-code with the same story twice", { ways: [w("step", { warnings: [{ kind: "same-code", stories: [1, 1], why: "Same file." }] })] });

  it("accepts warnings of both kinds", () => {
    const { id, did } = setup();
    const s = split(id, did, { ways: [w("step", { warnings: [{ kind: "layer", story: 1, why: "It is a layer." }, { kind: "same-code", stories: [1, 2], why: "Same file." }] })] })!;
    expect(s.drafts[0]!.split!.ways[0]!.warnings).toHaveLength(2);
  });
});

describe("failures", () => {
  it("fails with a fixed sentence when the draft is gone, the refs are missing or the run is of another kind", () => {
    const a = setup();
    setArchitectRun(ann, a.id, "g-1", { kind: "split", draft: a.did });
    removeDraft(ann, a.id, a.did, T);
    expect(endArchitectRun(a.id, "g-1", { split: ANSWER(), refs: { criteria: {}, mark: "0".repeat(64) } })!.architect!.failed).toBe(END_NO_SPLIT_DRAFT);
    const b = setup();
    setArchitectRun(ann, b.id, "g-2", { kind: "split", draft: b.did });
    expect(endArchitectRun(b.id, "g-2", { split: ANSWER() })!.architect!.failed).toBe(END_NO_SPLIT_DRAFT);
    setArchitectRun(ann, b.id, "g-3", { kind: "impact", draft: b.did });
    expect(endArchitectRun(b.id, "g-3", { split: ANSWER(), refs: refsOf(b.id, b.did) })!.architect!.failed).toBe(END_NO_SPLIT_DRAFT);
  });
});

describe("the file", () => {
  it("needs a draft for a split run", () => {
    const { id } = setup();
    expect(() => setArchitectRun(ann, id, "n-1", { kind: "split" })).toThrow(/needs a draft/);
  });

  it("refuses a stored mark that is wrong, and an architect of kind split without a draft or with a field", () => {
    const { id, did } = setup();
    split(id, did);
    const path = refinementsPath();
    const f = JSON.parse(readFileSync(path, "utf8"));
    f.sessions[0].drafts[0].split.mark = "nope";
    writeFileSync(path, JSON.stringify(f));
    expect(() => checkRefinements()).toThrow();
    f.sessions[0].drafts[0].split.mark = "0".repeat(64);
    f.sessions[0].architect = { runId: "r-1", at: "2026-01-01T00:00:00.000Z", kind: "split" };
    writeFileSync(path, JSON.stringify(f));
    expect(() => checkRefinements()).toThrow();
    f.sessions[0].architect = { runId: "r-1", at: "2026-01-01T00:00:00.000Z", kind: "split", draft: did, field: "who" };
    writeFileSync(path, JSON.stringify(f));
    expect(() => checkRefinements()).toThrow();
    f.sessions[0].architect = { runId: "r-1", at: "2026-01-01T00:00:00.000Z", kind: "split", draft: did };
    writeFileSync(path, JSON.stringify(f));
    expect(() => checkRefinements()).not.toThrow();
  });

  it("loads without a split, and a file from before this change is read unchanged", () => {
    const { id, did } = setup();
    const before = getSession(id)!;
    split(id, did);
    const path = refinementsPath();
    const f = JSON.parse(readFileSync(path, "utf8"));
    delete f.sessions[0].drafts[0].split;
    f.sessions[0].log = f.sessions[0].log.filter((l: any) => !["split-asked", "architect-split"].includes(l.what));
    f.sessions[0].updated = before.updated;
    writeFileSync(path, JSON.stringify(f));
    expect(() => checkRefinements()).not.toThrow();
    expect(getSession(id)).toEqual(before);
  });
});

describe("ownWay and splitRefusal", () => {
  it("passes nothing, an empty text, a good text and line breaks, and refuses the rest", () => {
    expect(ownWay(undefined)).toBeUndefined();
    expect(ownWay("  ")).toBeUndefined();
    expect(code(() => ownWay(null))).toBe("bad-text");
    expect(code(() => ownWay(5))).toBe("bad-text");
    expect(code(() => ownWay("x".repeat(SPLIT_OWN_MAX + 1)))).toBe("bad-text");
    expect(code(() => ownWay("a\u0000b"))).toBe("bad-text");
    expect(ownWay(`${"x".repeat(SPLIT_OWN_MAX - 3)}\nab`)).toHaveLength(SPLIT_OWN_MAX);
    expect(ownWay("  a\r\nb  ")).toBe("a\nb");
  });

  it("needs 2 criteria", () => {
    expect(splitRefusal({ criteria: [] })).toMatch(/at least 2/);
    expect(splitRefusal({ criteria: [{ id: "a", text: "x" }] })).toMatch(/at least 2/);
    expect(splitRefusal({ criteria: [{ id: "a", text: "x" }, { id: "b", text: "y" }] })).toBeUndefined();
  });
});

// ---- confirming a split -----------------------------------------------------------------------------

const PUBLISHED = { issue: 12, url: "https://github.com/acme/app/issues/12", at: "2026-01-01T00:00:00.000Z" };
const confirm = (id: string, did: string, body: unknown) => confirmSplitOf(ann, id, did, body, T);
const ids = (id: string, did: string) => draft(id, did).criteria.map((c) => c.id);
/** The plan of way 0 in the form of the body. */
const planOf = (id: string, did: string, over: Record<string, unknown> = {}) => {
  const [c1, c2, c3] = ids(id, did);
  return {
    way: 0,
    parts: [
      { title: "First part", sentence: "Do First part.", criteria: [c1, c2], dependsOn: [] },
      { title: "Second part", sentence: "Do Second part.", criteria: [c3], dependsOn: [1] },
    ],
    unplaced: [],
    ...over,
  };
};
const edit = (fn: (f: any) => void) => {
  const f = JSON.parse(readFileSync(refinementsPath(), "utf8"));
  fn(f);
  writeFileSync(refinementsPath(), JSON.stringify(f));
};
const message = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  return undefined;
};
const pt = (over: Record<string, unknown> = {}) => ({ title: "T", criteria: [] as unknown[], dependsOn: [] as unknown[], ...over });

describe("confirming a split", () => {
  it("makes a draft per part, keeps the original, and marks the sources of a way", () => {
    const { id, did } = setup();
    split(id, did);
    const orig = draft(id, did);
    const s = confirm(id, did, planOf(id, did));
    expect(s.drafts).toHaveLength(3);
    const [o, p1, p2] = s.drafts;
    expect(o!.id).toBe(did);
    expect(o!.criteria).toEqual([]);
    expect(o!.split).toBeUndefined();
    expect(o!.splitInto).toEqual([p1!.id, p2!.id]);
    expect(p1!.title).toEqual({ text: "First part", from: "accepted" });
    expect(p1!.criteria).toEqual(orig.criteria.slice(0, 2));
    expect(p2!.criteria).toEqual(orig.criteria.slice(2));
    expect(p1!.outOfScope).toEqual(orig.outOfScope);
    expect(p1!.who).toBeUndefined();
    expect(p1!.what).toBeUndefined();
    expect(p1!.why).toBeUndefined();
    expect(p1!.part).toEqual({ of: did, hint: "Do First part." });
    expect(p2!.dependsOn).toEqual([{ id: expect.any(String), draft: p1!.id, from: "accepted" }]);
    expect(s.log.at(-1)).toMatchObject({ what: "draft-split", detail: "2" });
    expect(s.architect).toBeUndefined();
    expect(() => checkRefinements()).not.toThrow();
  });

  it("marks edited titles and links, parts beyond the way, and typed plans", () => {
    const { id, did } = setup();
    split(id, did);
    const [c1, c2, c3] = ids(id, did);
    const s = confirm(id, did, { way: 1, parts: [pt({ title: "Rules!", criteria: [c1] }), pt({ title: "Export", criteria: [c2] }), pt({ title: "Extra", dependsOn: [1, 2] })], unplaced: [c3] });
    const [o, a, b, c] = s.drafts;
    expect(a!.title!.from).toBe("accepted-edited");
    expect(b!.title!.from).toBe("accepted");
    expect(c!.title!.from).toBe("accepted-edited");
    expect(c!.dependsOn.map((x) => x.from)).toEqual(["accepted-edited", "accepted-edited"]);
    expect(a!.part).toEqual({ of: did });
    expect(o!.criteria.map((x) => x.id)).toEqual([c3]);
    const t = setup();
    split(t.id, t.did);
    const typed = confirm(t.id, t.did, planOf(t.id, t.did, { way: undefined }));
    expect(typed.drafts[1]!.title!.from).toBe("typed");
    expect(typed.drafts[2]!.dependsOn[0]!.from).toBe("typed");
  });

  it("keeps the old order of unplaced criteria", () => {
    const { id, did } = setup([{ text: "a" }, { text: "b" }, { text: "c" }]);
    const [c1, c2, c3] = ids(id, did);
    const s = confirm(id, did, { parts: [pt({ criteria: [c2] }), pt()], unplaced: [c3, c1] });
    expect(s.drafts[0]!.criteria.map((c) => c.id)).toEqual([c1, c3]);
  });

  it("gives the first part the dependencies of the original", () => {
    const { id, did } = setup();
    const other = addDraft(ann, id, T).drafts[1]!.id;
    saveDraft(ann, id, did, { dependsOn: [{ issue: 7 }, { draft: other }] }, T);
    const orig = draft(id, did);
    const s = confirm(id, did, planOf(id, did, { way: undefined }));
    const p1 = s.drafts[2]!;
    expect(p1.dependsOn.map((x) => [x.issue, x.draft, x.from])).toEqual(orig.dependsOn.map((x) => [x.issue, x.draft, x.from]));
    expect(p1.dependsOn.some((x) => orig.dependsOn.some((y) => y.id === x.id))).toBe(false);
    expect(draft(id, did).dependsOn).toEqual(orig.dependsOn);
    expect(() => checkRefinements()).not.toThrow();
  });

  it("works for a draft with one or no criterion", () => {
    const one = setup([{ text: "only" }]);
    const [c] = ids(one.id, one.did);
    expect(confirm(one.id, one.did, { parts: [pt({ criteria: [c] }), pt()], unplaced: [] }).drafts).toHaveLength(3);
    const none = setup([]);
    expect(confirm(none.id, none.did, { parts: [pt(), pt()], unplaced: [] }).drafts).toHaveLength(3);
    expect(() => checkRefinements()).not.toThrow();
  });

  it("refuses a wrong plan and leaves the file as it was", () => {
    const { id, did } = setup();
    split(id, did);
    const ok = planOf(id, did);
    const [c1, c2, c3] = ids(id, did);
    const refuse = (body: unknown, msg: string | RegExp, kind = "bad-draft") => {
      const before = readFileSync(refinementsPath(), "utf8");
      let err: unknown;
      try {
        confirm(id, did, body);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(RefinementError);
      expect((err as RefinementError).code).toBe(kind);
      expect((err as Error).message).toMatch(msg);
      expect(readFileSync(refinementsPath(), "utf8")).toBe(before);
    };
    const rest = { unplaced: [c1, c2, c3] };
    for (const parts of [undefined, "x", [pt()], Array.from({ length: 7 }, () => pt()), [pt(), 5]]) refuse({ ...rest, parts }, /^a split has 2 to 6 parts$/);
    for (const title of ["", "  ", undefined, 5]) refuse({ ...rest, parts: [pt({ title }), pt()] }, /^each part needs a title$/);
    refuse({ ...rest, parts: [pt({ title: "a\nb" }), pt()] }, /one line/);
    refuse({ ...rest, parts: [pt({ title: "x".repeat(121) }), pt()] }, /at most 120/);
    refuse({ parts: [pt(), pt()] }, /unplaced must be a list/);
    refuse({ ...rest, unplaced: "x", parts: [pt(), pt()] }, /unplaced must be a list/);
    for (const w of [2, 3, -1, 1.5, "0", null]) refuse({ ...ok, way: w }, /^no such way; ask for ways to split again$/);
    for (const dependsOn of [[3], [0], ["1"]]) refuse({ ...rest, parts: [pt(), pt({ dependsOn })] }, /^no such part$/);
    refuse({ ...rest, parts: [pt(), pt({ dependsOn: [2] })] }, /^a part cannot depend on itself$/);
    refuse({ ...rest, parts: [pt({ dependsOn: [2] }), pt()] }, /^a part cannot depend on a later part$/);
    refuse({ ...rest, parts: [pt(), pt(), pt({ dependsOn: [1, 1] })] }, /twice/);
    const stranger = "99999999-9999-4999-8999-999999999999";
    refuse({ ...ok, parts: [{ ...ok.parts[0], criteria: [stranger, c2] }, ok.parts[1]] }, /^a criterion of the plan is not in this draft$/);
    refuse({ ...ok, parts: [{ ...ok.parts[0], criteria: [5, c2] }, ok.parts[1]] }, /^a criterion of the plan is not in this draft$/);
    refuse({ ...ok, parts: [{ ...ok.parts[0], criteria: [c1, c2, c3] }, ok.parts[1]] }, '"It is logged"');
    refuse({ ...ok, unplaced: [c1] }, 'a criterion is in the plan twice: "It is fast"');
    refuse({ ...ok, parts: [{ ...ok.parts[0], criteria: [c1] }, ok.parts[1]] }, 'a criterion is missing from the plan: "It exports a file"');
    refuse([], /send the plan as an object/);
  });

  it("shows a long criterion on one line, cut to 60 characters", () => {
    const { id, did } = setup([{ text: `${"a".repeat(30)}\n${"b".repeat(50)}` }, { text: "two" }]);
    const [, c2] = ids(id, did);
    const msg = message(() => confirm(id, did, { parts: [pt({ criteria: [c2] }), pt()], unplaced: [] }));
    expect(msg).toBe(`a criterion is missing from the plan: "${"a".repeat(30)} ${"b".repeat(29)}"`);
  });

  it("refuses more than 20 drafts", () => {
    const { id, did } = setup();
    for (let i = 0; i < 18; i++) addDraft(ann, id, T);
    expect(getSession(id)!.drafts).toHaveLength(19);
    const body = { parts: [pt({ criteria: ids(id, did) }), pt()], unplaced: [] };
    expect(code(() => confirm(id, did, body))).toBe("limit");
    expect(message(() => confirm(id, did, body))).toBe("at most 20 story drafts");
  });

  it("refuses a split draft, a part, a published draft and an unknown draft", () => {
    const { id, did } = setup();
    const s = confirm(id, did, planOf(id, did, { way: undefined }));
    const part = s.drafts[1]!.id;
    expect(code(() => confirm(id, did, {}))).toBe("bad-state");
    expect(message(() => confirm(id, did, {}))).toBe(SPLIT_READ_ONLY);
    expect(message(() => confirm(id, part, {}))).toBe("a part of a split cannot be split again");
    expect(code(() => confirm(id, "nope", {}))).toBe("not-found");
    expect(splitRefusal(draft(id, did))).toBe(SPLIT_READ_ONLY);
    expect(splitRefusal(draft(id, part))).toBe("a part of a split cannot be split again");
    const other = setup();
    edit((f) => (f.sessions[1].drafts[0].published = PUBLISHED));
    // The store refuses a published draft first; the rule of the split itself holds for the state too.
    expect(code(() => confirm(other.id, other.did, {}))).toBe("bad-state");
    expect(message(() => confirm(other.id, other.did, {}))).toMatch(/on GitHub as issue #12/);
    const st = { drafts: getSession(other.id)!.drafts, epic: undefined };
    expect(message(() => confirmSplit(st, other.did, {}))).toBe("a published draft cannot be split");
    expect(splitRefusal(draft(other.id, other.did))).toBe("a published draft cannot be split");
    expect(confirmRefusal({ splitInto: undefined, part: undefined, published: undefined })).toBeUndefined();
  });

  it("makes a late split run fail, and the file stays valid", () => {
    const { id, did } = setup();
    setArchitectRun(ann, id, "late-1", { kind: "split", draft: did });
    const refs = refsOf(id, did);
    confirm(id, did, planOf(id, did, { way: undefined }));
    expect(endArchitectRun(id, "late-1", { split: ANSWER(), refs }).architect?.failed).toBe(END_NO_SPLIT_DRAFT);
    expect(draft(id, did).split).toBeUndefined();
    expect(() => checkRefinements()).not.toThrow();
    const b = setup();
    setArchitectRun(ann, b.id, "late-2", { kind: "split", draft: b.did });
    const refs2 = refsOf(b.id, b.did);
    edit((f) => (f.sessions[1].drafts[0].published = PUBLISHED));
    expect(endArchitectRun(b.id, "late-2", { split: ANSWER(), refs: refs2 }).architect?.failed).toBe(END_ON_GITHUB);
    expect(draft(b.id, b.did).split).toBeUndefined();
    expect(() => checkRefinements()).not.toThrow();
  });
});

describe("removing and editing the drafts of a split", () => {
  it("shrinks splitInto, removes the key, and frees the original", () => {
    const { id, did } = setup();
    const [, p1, p2] = confirm(id, did, planOf(id, did, { way: undefined })).drafts;
    const after = removeDraft(ann, id, p1!.id, T);
    expect(after.drafts[0]!.splitInto).toEqual([p2!.id]);
    expect(after.drafts[1]!.dependsOn).toEqual([]);
    const last = removeDraft(ann, id, p2!.id, T);
    expect("splitInto" in last.drafts[0]!).toBe(false);
    expect(splitRefusal(draft(id, did))).toMatch(/at least 2/);
    expect(() => checkRefinements()).not.toThrow();
  });

  it("strips part from the parts when the original is removed", () => {
    const { id, did } = setup();
    confirm(id, did, planOf(id, did, { way: undefined }));
    const after = removeDraft(ann, id, did, T);
    expect(after.drafts).toHaveLength(2);
    expect(after.drafts.every((d) => !("part" in d))).toBe(true);
    expect(() => checkRefinements()).not.toThrow();
  });

  it("does not remove a published part, and the original keeps its parts then", () => {
    const { id, did } = setup();
    const p2 = confirm(id, did, planOf(id, did, { way: undefined })).drafts[2]!.id;
    edit((f) => (f.sessions[0].drafts[2].published = PUBLISHED));
    expect(code(() => removeDraft(ann, id, p2, T))).toBe("bad-state");
    // Removing the original would change the published part (it loses `part`), which the store does not allow.
    expect(code(() => removeDraft(ann, id, did, T))).toBe("bad-state");
    expect(draft(id, did).splitInto).toHaveLength(2);
    expect(() => checkRefinements()).not.toThrow();
  });

  it("dropDraft itself refuses a published part", () => {
    const { id, did } = setup();
    const s = confirm(id, did, planOf(id, did, { way: undefined }));
    const drafts = s.drafts.map((d, i) => (i === 2 ? { ...d, published: PUBLISHED } : d));
    expect(message(() => dropDraft({ drafts, epic: undefined }, drafts[2]!.id))).toBe("this part is on GitHub; it cannot be removed");
  });

  it("refuses a part that depends on a later part or on its original", () => {
    const { id, did } = setup();
    const [, p1, p2] = confirm(id, did, planOf(id, did, { way: undefined })).drafts;
    expect(message(() => saveDraft(ann, id, p1!.id, { dependsOn: [{ draft: p2!.id }] }, T))).toBe("a part cannot depend on a later part");
    expect(message(() => saveDraft(ann, id, p2!.id, { dependsOn: [{ draft: did }] }, T))).toBe("a part cannot depend on the draft it was split from");
    expect(code(() => saveDraft(ann, id, p2!.id, { dependsOn: [{ draft: p1!.id }] }, T))).toBeUndefined();
    const sid = "22222222-2222-4222-8222-222222222222";
    for (const target of [p2!.id, did]) {
      edit((f) => (f.sessions[0].drafts[1].suggestions = [{ id: sid, field: "dependsOn", draft: target }]));
      expect(code(() => acceptSuggestionOf(ann, id, p1!.id, sid, {}, T))).toBe("bad-draft");
    }
  });
});

describe("a split original is read-only", () => {
  const SID = "22222222-2222-4222-8222-222222222222";
  const confirmed = () => {
    const { id, did } = setup();
    const s = confirm(id, did, planOf(id, did, { way: undefined }));
    return { id, did, parts: s.drafts.slice(1).map((d) => d.id) };
  };
  const stateOf = (id: string) => {
    const s = getSession(id)!;
    return { drafts: s.drafts, epic: s.epic } as any;
  };

  it("refuseSplit throws for a split draft and does nothing for others", () => {
    const { id, did, parts } = confirmed();
    expect(code(() => refuseSplit(stateOf(id), did))).toBe("bad-state");
    expect(message(() => refuseSplit(stateOf(id), did))).toBe(SPLIT_READ_ONLY);
    expect(code(() => refuseSplit(stateOf(id), parts[0]!))).toBeUndefined();
    expect(code(() => refuseSplit(stateOf(id), "nope"))).toBeUndefined();
    const plain = setup();
    expect(code(() => refuseSplit(stateOf(plain.id), plain.did))).toBeUndefined();
  });

  it("refuses each change of the original and writes nothing", () => {
    const { id, did } = confirmed();
    const before = readFileSync(refinementsPath(), "utf8");
    const calls: [string, () => unknown][] = [
      ["saveDraft", () => saveDraft(ann, id, did, { title: "New" }, T)],
      ["acceptSuggestionOf", () => acceptSuggestionOf(ann, id, did, SID, {}, T)],
      ["rejectSuggestionOf", () => rejectSuggestionOf(ann, id, did, SID, {}, T)],
      ["moveToNotesOf", () => moveToNotesOf(ann, id, did, { field: "what" }, T)],
      ["setReviewLabelOf", () => setReviewLabelOf(ann, id, did, {}, T)],
      ["checkReadyOf", () => checkReadyOf(ann, id, did, T)],
      ["acceptAnywayOf", () => acceptAnywayOf(ann, id, did, "value", { reason: "x" }, T)],
      ["removeAcceptedOf", () => removeAcceptedOf(ann, id, did, "value", T)],
    ];
    for (const [name, fn] of calls) {
      expect([name, code(fn), message(fn)]).toEqual([name, "bad-state", SPLIT_READ_ONLY]);
    }
    expect(readFileSync(refinementsPath(), "utf8")).toBe(before);
    expect(code(() => saveDraft(ann, id, "nope", {}, T))).toBe("not-found");
  });

  it("can still remove the original", () => {
    const { id, did } = confirmed();
    expect(removeDraft(ann, id, did, T).drafts).toHaveLength(2);
  });

  it("can be edited again after the last part is removed", () => {
    const { id, did, parts } = confirmed();
    removeDraft(ann, id, parts[0]!, T);
    expect(code(() => saveDraft(ann, id, did, { title: "Again" }, T))).toBe("bad-state");
    removeDraft(ann, id, parts[1]!, T);
    saveDraft(ann, id, did, { title: "Again" }, T);
    expect(draft(id, did).title).toMatchObject({ text: "Again" });
  });

  it("does not refuse a part", () => {
    const { id, parts } = confirmed();
    saveDraft(ann, id, parts[0]!, { title: "Changed" }, T);
    expect(draft(id, parts[0]!).title).toMatchObject({ text: "Changed" });
    expect(checkReadyOf(ann, id, parts[0]!, T).drafts.find((d) => d.id === parts[0])!.readiness).toBeDefined();
  });

  it("does not store the result of a run that ends after the split", () => {
    const kinds: [string, any][] = [
      ["suggest", { suggested: {} }],
      ["review", { reviewed: {} }],
      ["impact", { impact: {} }],
      ["ready", { judged: {} }],
    ];
    for (const [kind, end] of kinds) {
      const { id, did } = setup();
      setArchitectRun(ann, id, `late-${kind}`, { kind, draft: did, field: "who" } as any);
      confirm(id, did, planOf(id, did, { way: undefined }));
      const s = endArchitectRun(id, `late-${kind}`, end);
      expect([kind, s?.architect?.failed]).toEqual([kind, END_SPLIT_DURING]);
      expect(() => checkRefinements()).not.toThrow();
    }
  });
});

describe("loading splits", () => {
  const OTHER = "33333333-3333-4333-8333-333333333333";
  const broken = (fn: (drafts: any[]) => void) => {
    const { id, did } = setup();
    confirm(id, did, planOf(id, did, { way: undefined }));
    edit((f) => fn(f.sessions[0].drafts));
    expect(() => checkRefinements()).toThrow();
    rmSync(refinementsPath(), { force: true });
  };

  it("refuses broken pairs", () => {
    broken((d) => (d[0].splitInto[0] = OTHER));
    broken((d) => delete d[1].part);
    broken((d) => delete d[0].splitInto);
    broken((d) => (d[2].part.of = d[1].id));
    broken((d) => (d[0].splitInto = []));
    broken((d) => (d[0].splitInto = Array.from({ length: 7 }, (_, i) => `4444444${i}-4444-4444-8444-444444444444`)));
    broken((d) => (d[1].part.extra = 1));
    broken((d) => (d[0].splitInto = [d[1].id, d[1].id]));
  });

  it("refuses a part that depends on a later part or on its original", () => {
    broken((d) => d[1].dependsOn.push({ id: OTHER, draft: d[2].id, from: "typed" }));
    broken((d) => d[2].dependsOn.push({ id: OTHER, draft: d[0].id, from: "typed" }));
  });

  it("refuses a split draft that is a part or published", () => {
    broken((d) => (d[0].published = PUBLISHED));
    broken((d) => (d[0].part = { of: d[0].id }));
  });

  it("loads split next to splitInto, and a file from before this change", () => {
    const { id, did } = setup();
    const before = getSession(id)!;
    split(id, did);
    const ways = JSON.parse(readFileSync(refinementsPath(), "utf8")).sessions[0].drafts[0].split;
    confirm(id, did, planOf(id, did));
    edit((f) => (f.sessions[0].drafts[0].split = ways));
    expect(() => checkRefinements()).not.toThrow();
    edit((f) => {
      const s = f.sessions[0];
      s.drafts = [s.drafts[0]];
      delete s.drafts[0].split;
      delete s.drafts[0].splitInto;
      s.drafts[0].criteria = before.drafts[0]!.criteria;
      s.log = s.log.filter((l: any) => !["split-asked", "architect-split", "draft-split"].includes(l.what));
      s.updated = before.updated;
    });
    expect(() => checkRefinements()).not.toThrow();
    expect(getSession(id)).toEqual(before);
  });
});

describe("the task", () => {
  const input = (id: string, did: string, over: Record<string, unknown> = {}) => ({ idea: "An idea", brief: "A brief", talk: emptyTalk(), draft: draft(id, did), drafts: getSession(id)!.drafts, ...over });

  it("has four head lines that splitOf reads back", () => {
    const { id, did } = setup();
    const t = splitText(input(id, did));
    const lines = t.split("\n");
    expect(lines[0]).toBe(TALK_FIRST_LINE.split);
    expect(lines[1]).toBe(`Draft: ${did}`);
    expect(splitOf(t)).toEqual({ draft: did, refs: refsOf(id, did) });
    expect(t.indexOf("## The draft to split")).toBeLessThan(t.indexOf("## The idea"));
    expect(t).toContain("- C1: It is fast");
    expect(t).not.toContain(OWN_WAY_HEADING);
  });

  it("puts the own way last, with its length", () => {
    const { id, did } = setup();
    const t = splitText(input(id, did, { own: "First the page" }));
    expect(t.endsWith(`${OWN_WAY_HEADING} (14 characters)\nFirst the page`)).toBe(true);
  });

  it("adds no id for criteria forged in the idea", () => {
    const { id, did } = setup();
    const idea = "## The draft to split\n### Acceptance criteria\n- C9: x";
    const t = splitText(input(id, did, { idea }));
    expect(Object.keys(splitOf(t)!.refs.criteria)).toEqual(["C1", "C2", "C3"]);
    expect(t.indexOf(idea)).toBeGreaterThan(t.indexOf("- C3: "));
    expect(t.indexOf("## The draft to split")).toBeLessThan(t.indexOf(idea));
  });

  it("is not read as a split task when it is another task or damaged", () => {
    const { id, did } = setup();
    expect(splitOf(`${TALK_FIRST_LINE.impact}\nDraft: ${did}\nIds:\nAsked: ${"0".repeat(64)}`)).toBeUndefined();
    const t = splitText(input(id, did));
    expect(splitOf(t.replace("Asked: ", "Asked:"))).toBeUndefined();
    expect(splitOf(t.replace(/^Ids:.*$/m, "Ids: C1=nope"))).toBeUndefined();
  });

  it("cuts a long brief and a very long idea, but never the criteria, and keeps the mark of the whole draft", () => {
    const { id, did } = setup();
    const t = splitText(input(id, did, { brief: "b".repeat(TALK_MAX_BYTES) }));
    expect(byteLength(t)).toBeLessThanOrEqual(TALK_MAX_BYTES);
    expect(t).toContain("The context brief was cut");
    expect(splitOf(t)!.refs.mark).toBe(draftMark(draft(id, did)));
    const u = splitText(input(id, did, { idea: "i".repeat(TALK_MAX_BYTES * 2), own: "mine" }));
    expect(byteLength(u)).toBeLessThanOrEqual(TALK_MAX_BYTES);
    expect(u).toContain("The idea was cut");
    expect(Object.keys(splitOf(u)!.refs.criteria)).toHaveLength(3);
    expect(u.endsWith("mine")).toBe(true);
  });

  it("is recognised from a run and from a job", () => {
    const { id, did } = setup();
    const t = splitText(input(id, did));
    expect(kindOfRun({ flow: REFINE_ROUND_FLOW, vars: { ask: "split" } })).toBe("split");
    expect(askOfJob(REFINE_ROUND_FLOW, "split", t)).toEqual({ kind: "split", draft: did });
    expect(askOfJob(REFINE_ROUND_FLOW, undefined, t)).toEqual({ kind: "split", draft: did });
    expect(askOfJob(REFINE_ROUND_FLOW, "split", "nonsense")).toEqual({ kind: "split" });
  });
});
