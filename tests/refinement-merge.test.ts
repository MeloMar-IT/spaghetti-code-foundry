import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Draft, DraftState } from "../src/refinement/draft.js";
import { mergeDrafts } from "../src/refinement/draft-parts.js";
import { SPLIT_READ_ONLY } from "../src/refinement/draft-split.js";
import { RefinementError, addDraft, confirmSplitOf, createSession, getSession, mergeDraftsOf, refinementsPath, removeDraft, saveDraft } from "../src/refinement/store.js";

const ANN = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const OK = { ownerOk: () => true, repoName: (_o: string, name: string) => name };
const T = { repoOk: () => true };
const ann = { id: ANN, admin: false };
let home: string;
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "refinement-merge-"));
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
const message = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  return undefined;
};
const sid = () => createSession(ANN, { repo: "acme/app", idea: "An idea" }, OK).id;
const draftsOf = (id: string) => getSession(id)!.drafts;
/** Adds a draft with these fields; returns its id. */
function draft(id: string, fields: Record<string, unknown> = {}): string {
  const did = addDraft(ann, id, T).drafts.at(-1)!.id;
  saveDraft(ann, id, did, fields, T);
  return did;
}
/** Changes the stored file directly. */
function edit(id: string, fn: (drafts: any[]) => void) {
  const f = JSON.parse(readFileSync(refinementsPath(), "utf8"));
  fn(f.sessions.find((s: any) => s.id === id).drafts);
  writeFileSync(refinementsPath(), JSON.stringify(f));
}
const merge = (id: string, a: string, b: string) => mergeDraftsOf(ann, id, a, { with: b }, T);
const many = (n: number, p = "C") => Array.from({ length: n }, (_, i) => ({ text: `${p} ${i}` }));
const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** A split into three parts P1, P2, P3 (P2 depends on P1, P3 on P2), plus the original. */
function parts() {
  const id = sid();
  const did = draft(id, { title: "Big", criteria: [{ text: "one" }, { text: "two" }, { text: "three" }] });
  const c = draftsOf(id)[0]!.criteria.map((x) => x.id);
  const plan = [
    { title: "P1", criteria: [c[0]], dependsOn: [] },
    { title: "P2", criteria: [c[1]], dependsOn: [1] },
    { title: "P3", criteria: [c[2]], dependsOn: [2] },
  ];
  confirmSplitOf(ann, id, did, { parts: plan, unplaced: [] }, T);
  const d = draftsOf(id);
  return { id, did, p1: d[1]!.id, p2: d[2]!.id, p3: d[3]!.id };
}

describe("merging two ordinary drafts", () => {
  it("keeps the first, takes an empty field from the second, adds criteria and removes the second", () => {
    const id = sid();
    const a = draft(id, { title: "A", who: "an admin", what: "to export", criteria: [{ text: "one" }] });
    const b = draft(id, { title: "B", who: "a user", why: "to share it", criteria: [{ text: "two" }] });
    const before = draftsOf(id);
    const s = merge(id, a, b);
    expect(s.drafts).toHaveLength(1);
    const m = s.drafts[0]!;
    expect(m.id).toBe(a);
    expect(m.title?.text).toBe("A");
    expect(m.who?.text).toBe("an admin");
    expect(m.what?.text).toBe("to export");
    expect(m.why).toEqual(before[1]!.why);
    expect(m.criteria).toEqual([...before[0]!.criteria, ...before[1]!.criteria]);
    expect(s.log.at(-1)).toMatchObject({ what: "drafts-merged", detail: '"A" + "B"' });
    expect(s.state).toBe("drafting");
  });

  it("joins texts, keeps equal ones once and sets the source", () => {
    const id = sid();
    const a = draft(id, { notes: "Note A", outOfScope: "Same" });
    const b = draft(id, { notes: "Note B", outOfScope: "Same" });
    const m = merge(id, a, b).drafts[0]!;
    expect(m.notes).toEqual({ text: "Note A\n\nNote B", from: "typed" });
    expect(m.outOfScope).toEqual({ text: "Same", from: "typed" });
    const c = draft(id, { notes: "Note C" });
    const d = draft(id, { notes: "Note D" });
    edit(id, (ds) => (ds.find((x) => x.id === d).notes.from = "accepted"));
    expect(merge(id, c, d).drafts.find((x) => x.id === c)!.notes).toEqual({ text: "Note C\n\nNote D", from: "accepted-edited" });
    const e = draft(id, {});
    const f = draft(id, { notes: "Only" });
    expect(merge(id, e, f).drafts.find((x) => x.id === e)!.notes).toEqual({ text: "Only", from: "typed" });
  });

  it("gives a clashing criterion id a new id", () => {
    const c = (text: string) => ({ id: UUID(9), text, from: "typed" as const });
    const mk = (id: string, text: string): Draft => ({ id, criteria: [c(text)], dependsOn: [] });
    const st: DraftState = { epic: undefined, drafts: [mk(UUID(1), "same id"), mk(UUID(2), "second")] };
    const m = mergeDrafts(st, UUID(1), { with: UUID(2) }).drafts[0]!;
    expect(m.criteria.map((x) => x.text)).toEqual(["same id", "second"]);
    expect(m.criteria[0]!.id).toBe(UUID(9));
    expect(m.criteria[1]!.id).not.toBe(UUID(9));
  });
});

describe("depends-on", () => {
  it("takes the union without doubles and without the two drafts, and re-points others", () => {
    const id = sid();
    const a = draft(id, { dependsOn: [{ issue: 1 }, { issue: 2 }] });
    const b = draft(id, { dependsOn: [{ issue: 2 }, { issue: 3 }] });
    const c = draft(id, { dependsOn: [{ draft: b }] });
    const d = draft(id, { dependsOn: [{ draft: a }, { draft: b }] });
    const linkId = draftsOf(id)[2]!.dependsOn[0]!.id;
    const s = merge(id, a, b);
    expect(s.drafts.map((x) => x.id)).toEqual([a, c, d]);
    expect(s.drafts[0]!.dependsOn.map((x) => x.issue)).toEqual([1, 2, 3]);
    expect(s.drafts[1]!.dependsOn).toEqual([{ id: linkId, draft: a, from: "typed" }]);
    expect(s.drafts[2]!.dependsOn.map((x) => x.draft)).toEqual([a]);
  });

  it("removes links between the two drafts in both directions", () => {
    const id = sid();
    const a = draft(id, {});
    const b = draft(id, { dependsOn: [{ draft: a }] });
    saveDraft(ann, id, a, { dependsOn: [{ issue: 5 }] }, T);
    expect(merge(id, a, b).drafts[0]!.dependsOn.map((x) => x.issue)).toEqual([5]);
    const c = draft(id, {});
    const d = draft(id, {});
    saveDraft(ann, id, c, { dependsOn: [{ draft: d }] }, T);
    expect(merge(id, c, d).drafts.find((x) => x.id === c)!.dependsOn).toEqual([]);
  });

  it("removes a waiting depends-on suggestion of another draft that names the second", () => {
    const id = sid();
    const a = draft(id, {});
    const b = draft(id, {});
    const c = draft(id, {});
    edit(id, (ds) => (ds[2].suggestions = [{ id: UUID(7), field: "dependsOn", draft: b }]));
    expect(merge(id, a, b).drafts.find((x) => x.id === c)!.suggestions).toBeUndefined();
  });

  it("allows exactly 20 and refuses 21", () => {
    const id = sid();
    const issues = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ issue: from + i }));
    const a = draft(id, { dependsOn: issues(1, 10) });
    const b = draft(id, { dependsOn: issues(11, 10) });
    expect(merge(id, a, b).drafts[0]!.dependsOn).toHaveLength(20);
    const c = draft(id, { dependsOn: issues(1, 11) });
    const d = draft(id, { dependsOn: issues(12, 10) });
    const before = readFileSync(refinementsPath(), "utf8");
    expect(code(() => merge(id, c, d))).toBe("limit");
    expect(readFileSync(refinementsPath(), "utf8")).toBe(before);
  });
});

describe("limits", () => {
  it("allows 25 + 25 criteria and refuses 30 + 21", () => {
    const id = sid();
    const a = draft(id, { criteria: many(25) });
    const b = draft(id, { criteria: many(25, "D") });
    expect(merge(id, a, b).drafts[0]!.criteria).toHaveLength(50);
    const c = draft(id, { criteria: many(30) });
    const d = draft(id, { criteria: many(21, "D") });
    const before = readFileSync(refinementsPath(), "utf8");
    expect(code(() => merge(id, c, d))).toBe("limit");
    expect(readFileSync(refinementsPath(), "utf8")).toBe(before);
  });

  it("allows exactly 5000 characters of notes and refuses more", () => {
    const id = sid();
    const a = draft(id, { notes: "a".repeat(2499), outOfScope: "a".repeat(2499) });
    const b = draft(id, { notes: "b".repeat(2499), outOfScope: "b".repeat(2499) });
    const m = merge(id, a, b).drafts[0]!;
    expect([...m.notes!.text]).toHaveLength(5000);
    expect([...m.outOfScope!.text]).toHaveLength(5000);
    const c = draft(id, { notes: "a".repeat(3000) });
    const d = draft(id, { notes: "b".repeat(3000) });
    expect(code(() => merge(id, c, d))).toBe("bad-draft");
    const e = draft(id, { outOfScope: "a".repeat(3000) });
    const f = draft(id, { outOfScope: "b".repeat(3000) });
    expect(code(() => merge(id, e, f))).toBe("bad-draft");
  });
});

describe("merging parts of a split", () => {
  it("removes the second part from splitInto and keeps part and copied texts", () => {
    const { id, did, p1, p2, p3 } = parts();
    edit(id, (ds) => ds.forEach((d) => d.part && (d.notes = { text: "Shared", from: "typed" })));
    const s = merge(id, p2, p3);
    expect(s.drafts.find((d) => d.id === did)!.splitInto).toEqual([p1, p2]);
    const m = s.drafts.find((d) => d.id === p2)!;
    expect(m.part?.of).toBe(did);
    expect(m.notes?.text).toBe("Shared");
    expect(m.criteria.map((c) => c.text)).toEqual(["two", "three"]);
    expect(s.drafts.some((d) => d.id === p3)).toBe(false);
    expect(() => getSession(id)).not.toThrow();
  });

  it("removes splitInto when the last part goes, as an ordinary draft is merged with it", () => {
    const id = sid();
    const did = draft(id, { criteria: many(2) });
    const c = draftsOf(id)[0]!.criteria.map((x) => x.id);
    const plan = [
      { title: "P1", criteria: [c[0]], dependsOn: [] },
      { title: "P2", criteria: [c[1]], dependsOn: [] },
    ];
    confirmSplitOf(ann, id, did, { parts: plan, unplaced: [] }, T);
    const [p1, p2] = [draftsOf(id)[1]!.id, draftsOf(id)[2]!.id];
    removeDraft(ann, id, p2, T);
    const plain = draft(id, { title: "Plain" });
    const s = merge(id, plain, p1);
    expect(s.drafts.find((d) => d.id === did)!.splitInto).toBeUndefined();
    expect(s.drafts.find((d) => d.id === plain)!.part).toBeUndefined();
  });

  it("removes a link that would make a part depend on a later part, and names it", () => {
    const { id, p1, p2, p3 } = parts();
    const s = merge(id, p1, p3);
    expect(s.drafts.find((d) => d.id === p1)!.dependsOn).toEqual([]);
    expect(s.drafts.find((d) => d.id === p2)!.dependsOn.map((x) => x.draft)).toEqual([p1]);
    expect(s.log.at(-1)!.detail).toBe('"P1" + "P3"; removed "P1" → "P2"');
    expect(() => getSession(id)).not.toThrow();
  });

  it("names every removed link, also when the log line is longer than 120 characters, and stores it", () => {
    const id = sid();
    const did = draft(id, { title: "Big", criteria: many(4) });
    const c = draftsOf(id)[0]!.criteria.map((x) => x.id);
    const name = (n: number) => `Long part title number ${n}`;
    const plan = [1, 2, 3, 4].map((n) => ({ title: name(n), criteria: [c[n - 1]], dependsOn: n === 4 ? [2, 3] : [] }));
    confirmSplitOf(ann, id, did, { parts: plan, unplaced: [] }, T);
    const [p1, p4] = [draftsOf(id)[1]!.id, draftsOf(id)[4]!.id];
    const s = merge(id, p1, p4);
    expect(s.drafts.find((d) => d.id === p1)!.dependsOn).toEqual([]);
    const detail = s.log.at(-1)!.detail!;
    expect(detail.length).toBeGreaterThan(120);
    expect(detail).toBe('"Long part title numb" + "Long part title numb"; removed "Long part title numb" → "Long part title numb", "Long part title numb" → "Long part title numb"');
    expect(getSession(id)!.log.at(-1)!.detail).toBe(detail);
  });

  it("removes a link to the original and names it", () => {
    const { id, did, p1 } = parts();
    const plain = draft(id, { title: "Plain", dependsOn: [{ draft: did }] });
    const s = merge(id, p1, plain);
    expect(s.drafts.find((d) => d.id === p1)!.dependsOn).toEqual([]);
    expect(s.log.at(-1)!.detail).toContain("removed");
  });
});

describe("cleared and kept", () => {
  const rej = (n: number, p: string) => Array.from({ length: n }, (_, i) => ({ field: "who", text: `${p}${i}` }));

  it("clears suggestions, review, impact, split and readiness; keeps accepted-anyway; sets the label", () => {
    const id = sid();
    const a = draft(id, { title: "A" });
    const b = draft(id, { title: "B" });
    edit(id, (ds) => {
      ds[0].suggestions = [{ id: UUID(5), field: "who", text: "x" }];
      ds[0].readiness = { at: "2026-01-01T00:00:00.000Z", items: [] };
      ds[0].acceptedAnyway = [{ id: "value", text: "t", reason: "r", at: "2026-01-01T00:00:00.000Z" }];
      ds[1].addReviewLabel = true;
    });
    const m = merge(id, a, b).drafts[0]!;
    for (const k of ["suggestions", "review", "impact", "split", "readiness"]) expect(m).not.toHaveProperty(k);
    expect(m.acceptedAnyway).toHaveLength(1);
    expect(m.addReviewLabel).toBe(true);
  });

  it("keeps rejected suggestions of both, the last 30", () => {
    const id = sid();
    const a = draft(id, {});
    const b = draft(id, {});
    edit(id, (ds) => {
      ds[0].rejected = rej(20, "a");
      ds[1].rejected = rej(20, "b");
    });
    const r = merge(id, a, b).drafts[0]!.rejected!;
    expect(r).toHaveLength(30);
    expect(r[0]!.text).toBe("a10");
    expect(r.at(-1)!.text).toBe("b19");
  });

  it("clears the readiness of a third draft whose link was re-pointed", () => {
    const id = sid();
    const a = draft(id, {});
    const b = draft(id, {});
    const c = draft(id, { dependsOn: [{ draft: b }] });
    edit(id, (ds) => (ds[2].readiness = { at: "2026-01-01T00:00:00.000Z", items: [] }));
    expect(merge(id, a, b).drafts.find((d) => d.id === c)!.readiness).toBeUndefined();
  });
});

describe("refusals", () => {
  it("refuses a split original as first and as second", () => {
    const { id, did, p1 } = parts();
    for (const [x, y] of [[did, p1], [p1, did]] as const) {
      expect(code(() => merge(id, x, y))).toBe("bad-state");
      expect(message(() => merge(id, x, y))).toBe(SPLIT_READ_ONLY);
    }
  });

  it("refuses itself, unknown drafts and a wrong body", () => {
    const id = sid();
    const a = draft(id, {});
    expect(code(() => merge(id, a, a))).toBe("bad-draft");
    expect(code(() => merge(id, UUID(1), a))).toBe("not-found");
    expect(code(() => merge(id, a, UUID(1)))).toBe("not-found");
    for (const body of [null, {}, { with: 1 }]) expect(code(() => mergeDraftsOf(ann, id, a, body, T))).toBe("bad-draft");
  });

  it("refuses a published first or second draft, and a published third that would change", () => {
    const id = sid();
    const a = draft(id, {});
    const b = draft(id, {});
    const c = draft(id, { dependsOn: [{ draft: b }] });
    const pub = { issue: 9, url: "https://github.com/acme/app/issues/9", at: "2026-01-01T00:00:00.000Z" };
    edit(id, (ds) => (ds[2].published = pub));
    const before = readFileSync(refinementsPath(), "utf8");
    expect(code(() => merge(id, a, b))).toBe("bad-state");
    expect(code(() => merge(id, c, a))).toBe("bad-state");
    expect(code(() => merge(id, a, c))).toBe("bad-state");
    expect(readFileSync(refinementsPath(), "utf8")).toBe(before);
  });

  it("is for the owner only", () => {
    const id = sid();
    const a = draft(id, {});
    const b = draft(id, {});
    expect(code(() => mergeDraftsOf({ id: BOB, admin: false }, id, a, { with: b }, T))).toBe("not-found");
    expect(code(() => mergeDraftsOf({ id: BOB, admin: true }, id, a, { with: b }, T))).toBe("not-owner");
  });
});
