import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { askOfJob, kindOfRun } from "../src/refinement/architect.js";
import { draftMark } from "../src/refinement/draft-impact.js";
import { END_NO_SPLIT_DRAFT, SPLIT_OWN_MAX, ownWay, splitRefusal, splitView, type SplitRefs } from "../src/refinement/draft-split.js";
import { OWN_WAY_HEADING, splitOf, splitText } from "../src/refinement/split-text.js";
import {
  END_BAD_FORM,
  RefinementError,
  addDraft,
  checkRefinements,
  createSession,
  endArchitectRun,
  getSession,
  refinementsPath,
  removeDraft,
  saveDraft,
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
