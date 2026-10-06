import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { askOfJob, kindOfRun } from "../src/refinement/architect.js";
import { draftMark, impactView, type ImpactRefs } from "../src/refinement/draft-impact.js";
import { impactOf, impactText } from "../src/refinement/impact-text.js";
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
import { TALK_FIRST_LINE, TALK_MAX_BYTES, byteLength, reviewText } from "../src/refinement/talk-text.js";
import { END_NO_IMPACT_DRAFT } from "../src/refinement/draft-impact.js";
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
  home = mkdtempSync(join(tmpdir(), "refinement-impact-"));
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
function setup() {
  const id = createSession(ANN, { repo: "acme/app", idea: "An idea" }, OK).id;
  const did = addDraft(ann, id, T).drafts[0]!.id;
  saveDraft(ann, id, did, { title: "Export", who: "an admin", what: "to export a report", why: "to share it", outOfScope: "Printing", criteria: [{ text: "It is fast" }, { text: "It exports a file" }] }, T);
  return { id, did };
}
const ANSWER = () => ({
  areas: [{ area: "src/export", files: ["src/export/a.ts"], basis: "found", why: "The export lives here." }],
  dependsOn: [],
  dependents: [],
  risks: [{ kind: "users", basis: "estimate", text: "People see a new button." }],
  size: { size: "small", files: 2, lines: 40, why: "One page and its test." },
  overlaps: [],
  sensitive: [],
});
/** An impact run of the draft, ended with this output; `refs` default to the draft as it is now. */
function impact(id: string, did: string, output: unknown = ANSWER(), refs?: ImpactRefs) {
  const runId = `i-${++runs}`;
  setArchitectRun(ann, id, runId, { kind: "impact", draft: did });
  return endArchitectRun(id, runId, { impact: output, refs: refs ?? { drafts: {}, mark: draftMark(draft(id, did)) } });
}
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof RefinementError ? e.code : e;
  }
  return undefined;
};
const view = (id: string, did: string) => impactView(draft(id, did), getSession(id)!.drafts);

describe("a stored view", () => {
  it("is stored with the draft and read back; no other key changes", () => {
    const { id, did } = setup();
    const before = draft(id, did);
    const s = impact(id, did)!;
    expect(s.architect).toBeUndefined();
    expect(without(s.drafts[0]!, "impact")).toEqual(before);
    expect(s.state).toBe(getSession(id)!.state);
    expect(s.log.slice(-2).map((l) => [l.what, l.detail])).toEqual([["impact-asked", undefined], ["architect-impact", "small"]]);
    const v = view(id, did)!;
    expect(v.size).toMatchObject({ size: "small", basis: "estimate" });
    expect(v.areas[0]!.basis).toBe("found");
    expect(JSON.stringify(v)).not.toContain("mark");
    expect(v.outOfDate).toBeUndefined();
  });

  it("is replaced by a second view; there is none without a run", () => {
    const { id, did } = setup();
    expect(view(id, did)).toBeUndefined();
    impact(id, did);
    impact(id, did, { ...ANSWER(), size: { size: "medium", files: 8, lines: 100, why: "Bigger." } });
    expect(view(id, did)!.size.size).toBe("medium");
  });

  it.each([
    ["title", { title: "Other" }],
    ["who", { who: "a user" }],
    ["what", { what: "to export it all" }],
    ["why", { why: "to know" }],
    ["a criterion changed", { criteria: [{ text: "It is fast" }, { text: "It exports a CSV" }] }],
    ["a criterion added", { criteria: [{ text: "It is fast" }, { text: "It exports a file" }, { text: "More" }] }],
    ["a criterion removed", { criteria: [{ text: "It is fast" }] }],
    ["out of scope", { outOfScope: "Mail" }],
  ])("is out of date after a change of %s", (_n, fields) => {
    const { id, did } = setup();
    impact(id, did);
    saveDraft(ann, id, did, fields as never, T);
    expect(view(id, did)!.outOfDate).toBe(true);
  });

  it("is out of date when a criterion is replaced by one with the same text", () => {
    const { id, did } = setup();
    impact(id, did);
    saveDraft(ann, id, did, { criteria: [{ text: "It is fast" }, { text: "It exports a file" }] }, T);
    expect(view(id, did)!.outOfDate).toBe(true);
  });

  it("is out of date when depends-on changes, but not when the notes change", () => {
    const { id, did } = setup();
    impact(id, did);
    saveDraft(ann, id, did, { notes: "Keep it small" }, T);
    expect(view(id, did)!.outOfDate).toBeUndefined();
    saveDraft(ann, id, did, { dependsOn: [{ issue: 5 }] } as never, T);
    expect(view(id, did)!.outOfDate).toBe(true);
  });

  it("is out of date at once when the draft changed while the run was active", () => {
    const { id, did } = setup();
    const mark = draftMark(draft(id, did));
    saveDraft(ann, id, did, { why: "to know" }, T);
    impact(id, did, ANSWER(), { drafts: {}, mark });
    expect(view(id, did)!.outOfDate).toBe(true);
  });

  it("stores D numbers as draft ids and leaves out unknown, own and repeated targets", () => {
    const { id, did } = setup();
    const other = addDraft(ann, id, T).drafts[1]!.id;
    const link = (draft: string, why = "It needs it.") => ({ draft, basis: "estimate", why });
    const out = { ...ANSWER(), dependsOn: [link("D2"), link("D2"), link("D9"), link("D1"), { issue: 7, basis: "found", why: "Named." }, { issue: 7, basis: "found", why: "Again." }], dependents: [link("D2")] };
    impact(id, did, out, { drafts: { D1: did, D2: other }, mark: draftMark(draft(id, did)) });
    const v = view(id, did)!;
    expect(v.dependsOn.map((l) => l.draft ?? l.issue)).toEqual([other, 7]);
    expect(v.dependents.map((l) => l.draft)).toEqual([other]);
    removeDraft(ann, id, other, T);
    const after = view(id, did)!;
    expect(after.dependsOn.map((l) => l.draft ?? l.issue)).toEqual([7]);
    expect(after.dependents).toEqual([]);
  });

  const area = ANSWER().areas[0]!;
  it.each([
    ["an extra key", { ...ANSWER(), extra: 1 }],
    ["no size", without(ANSWER(), "size")],
    ["a basis outside the two", { ...ANSWER(), areas: [{ ...area, basis: "guess" }] }],
    ["a path with ..", { ...ANSWER(), areas: [{ ...area, area: "../x" }] }],
    ["an absolute path", { ...ANSWER(), areas: [{ ...area, area: "/etc" }] }],
    ["a why over 300 characters", { ...ANSWER(), areas: [{ ...area, why: "a".repeat(301) }] }],
    ["a why that names days", { ...ANSWER(), areas: [{ ...area, why: "It takes 3 days." }] }],
    ["16 areas", { ...ANSWER(), areas: Array.from({ length: 16 }, () => area) }],
    ["a link with issue and draft", { ...ANSWER(), dependsOn: [{ issue: 1, draft: "D1", basis: "found", why: "x" }] }],
    ["an unsafe issue number", { ...ANSWER(), dependsOn: [{ issue: 2 ** 60, basis: "found", why: "x" }] }],
    ["a found area without files", { ...ANSWER(), areas: [{ ...area, files: [] }] }],
    ["a size word that does not fit", { ...ANSWER(), size: { size: "large", files: 1, lines: 1, why: "x" } }],
    ["an overlap that is not an estimate", { ...ANSWER(), overlaps: [{ issue: 1, areas: ["src/export"], basis: "found", why: "x" }] }],
    ["an overlap with an area not in the answer", { ...ANSWER(), overlaps: [{ issue: 1, areas: ["src/other"], basis: "estimate", why: "x" }] }],
    ["a non-object", "text"],
  ])("is a bad form for %s: the old view stays", (_n, output) => {
    const { id, did } = setup();
    impact(id, did);
    const old = draft(id, did).impact;
    const s = impact(id, did, output)!;
    expect(s.architect).toMatchObject({ failed: END_BAD_FORM });
    expect(draft(id, did).impact).toEqual(old);
  });

  it("fails for a removed draft, a run of another kind and missing refs", () => {
    const { id, did } = setup();
    const r1 = `i-${++runs}`;
    setArchitectRun(ann, id, r1, { kind: "impact", draft: did });
    removeDraft(ann, id, did, T);
    expect(endArchitectRun(id, r1, { impact: ANSWER(), refs: { drafts: {}, mark: "0".repeat(64) } })!.architect!.failed).toBe(END_NO_IMPACT_DRAFT);
    const b = setup();
    const r2 = `i-${++runs}`;
    setArchitectRun(ann, b.id, r2, { kind: "review", draft: b.did });
    expect(endArchitectRun(b.id, r2, { impact: ANSWER(), refs: { drafts: {}, mark: "0".repeat(64) } })!.architect!.failed).toBe(END_NO_IMPACT_DRAFT);
    const c = setup();
    const r3 = `i-${++runs}`;
    setArchitectRun(ann, c.id, r3, { kind: "impact", draft: c.did });
    expect(endArchitectRun(c.id, r3, { impact: ANSWER() })!.architect!.failed).toBe(END_NO_IMPACT_DRAFT);
  });
});

describe("the file", () => {
  it("refuses an impact run without a draft, and records with the wrong shape", () => {
    const { id, did } = setup();
    expect(String(code(() => setArchitectRun(ann, id, "x-1", { kind: "impact" })))).toContain("needs a draft");
    impact(id, did);
    const edit = (fn: (f: any) => void) => {
      const f = JSON.parse(readFileSync(refinementsPath(), "utf8"));
      fn(f);
      writeFileSync(refinementsPath(), JSON.stringify(f));
    };
    const original = readFileSync(refinementsPath(), "utf8");
    edit((f) => (f.sessions[0].drafts[0].impact.mark = "nope"));
    expect(code(() => checkRefinements())).toBeDefined();
    writeFileSync(refinementsPath(), original);
    edit((f) => delete f.sessions[0].drafts[0].impact);
    expect(getSession(id)!.drafts[0]!.impact).toBeUndefined();
    edit((f) => (f.sessions[0].architect = { runId: "r-1", at: "2026-01-01T00:00:00.000Z", kind: "impact" }));
    expect(code(() => getSession(id))).toBeDefined();
    edit((f) => (f.sessions[0].architect = { runId: "r-1", at: "2026-01-01T00:00:00.000Z", kind: "impact", draft: did, field: "who" }));
    expect(code(() => getSession(id))).toBeDefined();
  });
});

describe("the task", () => {
  const two = () => {
    const { id, did } = setup();
    const o = addDraft(ann, id, T).drafts[1]!.id;
    saveDraft(ann, id, o, { title: "Import" }, T);
    return { id, did, o, s: getSession(id)! };
  };

  it("has four head lines, names the other drafts by position and round-trips", () => {
    const { did, o, s } = two();
    const d = s.drafts[0]!;
    const text = impactText({ idea: s.idea, brief: "The brief", talk: emptyTalk(), draft: d, drafts: s.drafts });
    expect(text.split("\n").slice(0, 4)).toEqual([TALK_FIRST_LINE.impact, `Draft: ${did}`, `Ids: D2=${o}`, `Asked: ${draftMark(d)}`]);
    expect(text).toContain("D2: Import");
    expect(impactOf(text)).toEqual({ draft: did, refs: { drafts: { D2: o }, mark: draftMark(d) } });
  });

  it("is not read from a review task or a damaged head", () => {
    const { did, s } = two();
    const d = s.drafts[0]!;
    expect(impactOf(reviewText({ idea: "x", talk: emptyTalk(), draft: d }))).toBeUndefined();
    const text = impactText({ idea: s.idea, talk: emptyTalk(), draft: d, drafts: s.drafts });
    expect(impactOf(text.replace(`Draft: ${did}`, "Draft: nope"))).toBeUndefined();
    expect(impactOf(text.replace(/Asked: .*/, "Asked: 12"))).toBeUndefined();
  });

  it("cuts a long brief and keeps the mark of the full draft", () => {
    const { s } = two();
    const d = s.drafts[0]!;
    const text = impactText({ idea: s.idea, brief: "word ".repeat(40_000), talk: emptyTalk(), draft: d, drafts: s.drafts });
    expect(byteLength(text)).toBeLessThanOrEqual(TALK_MAX_BYTES);
    expect(text).toContain("## Left out");
    expect(impactOf(text)!.refs.mark).toBe(draftMark(d));
  });

  it("knows its kind from the run and from the job", () => {
    const { did, s } = two();
    expect(kindOfRun({ flow: REFINE_ROUND_FLOW, vars: { ask: "impact" } })).toBe("impact");
    const text = impactText({ idea: s.idea, talk: emptyTalk(), draft: s.drafts[0]!, drafts: s.drafts });
    expect(askOfJob(REFINE_ROUND_FLOW, "impact", text)).toEqual({ kind: "impact", draft: did });
    expect(askOfJob(REFINE_ROUND_FLOW, undefined, text)).toEqual({ kind: "impact", draft: did });
    expect(askOfJob(REFINE_ROUND_FLOW, "impact", "nonsense")).toEqual({ kind: "impact" });
  });
});
