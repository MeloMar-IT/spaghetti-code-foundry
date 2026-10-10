import { describe, expect, it } from "vitest";
import { preview, type Draft } from "../src/refinement/draft.js";
import { isReady, notReadyReason } from "../src/refinement/draft-ready.js";
import { RefinementError } from "../src/refinement/errors.js";
import { isBot, isStatusComment } from "../src/github.js";
import { changedSections, endsWithMarker, updateComment, updateMarker, chosenLabels, issueText, issueUrl, issueWithMarker, labelsFor, leftBehind, parsePublishInput, parseSourceChoice, sameVersion, versionHash, planOf, publishOrder, refinedHash, refinedHashIn, refinedMarker, withoutSplits, type LabelRules, type PlanInput } from "../src/refinement/publish.js";
import type { ReadyItem } from "../src/refinement/ready-list.js";

const LIST: ReadyItem[] = [{ id: "out-of-scope", text: "it says what is out of scope" }];
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const AT = "2026-10-07T10:00:00.000Z";

/** A draft; `ready` gives it a check of LIST with every item met (or not met). */
function mk(n: number, over: Partial<Draft> & { ready?: boolean | "not-met" } = {}): Draft {
  const { ready, ...rest } = over;
  const d: Draft = {
    id: uid(n),
    title: { text: `Story ${n}`, from: "typed" },
    who: { text: "an admin", from: "typed" },
    what: { text: "to export", from: "typed" },
    why: { text: "to share", from: "typed" },
    criteria: [{ id: uid(100 + n), text: "It exports a file", from: "typed" }],
    dependsOn: [],
    ...rest,
  };
  if (ready) d.readiness = { at: AT, items: LIST.map((i) => ({ id: i.id, text: i.text, result: ready === "not-met" ? ("not-met" as const) : ("met" as const), reason: "ok", by: "code" as const })) };
  return d;
}
const dep = (n: number) => ({ id: uid(200 + n), draft: uid(n), from: "typed" as const });
const issueDep = (n: number) => ({ id: uid(300 + n), issue: n, from: "typed" as const });
const ids = (l: Draft[]) => l.map((d) => d.id);
const base: PlanInput = { list: LIST, onGithub: new Map(), by: "Ann", date: "2026-10-07" };
const plan = (drafts: Draft[], o: Partial<PlanInput> = {}, epic?: number) => planOf({ drafts, epic }, { ...base, ...o });

describe("publishOrder", () => {
  it("keeps the session order without dependencies", () => {
    const d = [mk(1), mk(2), mk(3)];
    expect(ids(publishOrder(d))).toEqual(ids(d));
  });
  it("puts a draft after the drafts it depends on", () => {
    expect(ids(publishOrder([mk(1, { dependsOn: [dep(2)] }), mk(2)]))).toEqual([uid(2), uid(1)]);
  });
  it("is stable: of the available drafts the first of the session goes first", () => {
    expect(ids(publishOrder([mk(1, { dependsOn: [dep(3)] }), mk(2), mk(3)]))).toEqual([uid(2), uid(3), uid(1)]);
  });
  it("orders a chain", () => {
    expect(ids(publishOrder([mk(1, { dependsOn: [dep(2)] }), mk(2, { dependsOn: [dep(3)] }), mk(3)]))).toEqual([uid(3), uid(2), uid(1)]);
  });
  it("does not move a draft for an issue number", () => {
    const d = [mk(1, { dependsOn: [issueDep(7)] }), mk(2)];
    expect(ids(publishOrder(d))).toEqual(ids(d));
  });
  it("ends on a circle and lists both drafts once, after the others", () => {
    expect(ids(publishOrder([mk(1, { dependsOn: [dep(2)] }), mk(2, { dependsOn: [dep(1)] }), mk(3)]))).toEqual([uid(3), uid(1), uid(2)]);
  });
});

describe("notReadyReason", () => {
  it("says why, and is undefined exactly when isReady", () => {
    expect(notReadyReason(mk(1), LIST)).toMatch(/no readiness check/);
    expect(notReadyReason(mk(1, { ready: "not-met" }), LIST)).toBe("1 item of the Definition of Ready is not met");
    expect(notReadyReason(mk(1, { ready: "not-met" }), [LIST[0]!, { id: "x", text: "x" }])).toMatch(/changed since the check/);
    const ready = mk(1, { ready: true });
    expect(notReadyReason(ready, LIST)).toBeUndefined();
    expect(isReady(ready, LIST)).toBe(true);
    expect(notReadyReason(ready, [...LIST, { id: "b", text: "b" }])).toMatch(/changed since the check/);
    const accepted = mk(1, { ready: "not-met", acceptedAnyway: [{ id: LIST[0]!.id, text: LIST[0]!.text, reason: "fine", at: AT }] });
    expect(isReady(accepted, LIST)).toBe(true);
    expect(notReadyReason(accepted, LIST)).toBeUndefined();
  });
  it("counts several items", () => {
    const list: ReadyItem[] = [LIST[0]!, { id: "b", text: "b" }];
    const d = mk(1, { ready: "not-met" });
    d.readiness!.items.push({ id: "b", text: "b", result: "not-met", reason: "no", by: "code" });
    expect(notReadyReason(d, list)).toBe("2 items of the Definition of Ready are not met");
  });
});

describe("preview with a way to print a draft dependency", () => {
  it("keeps (draft) without it and prints the given text with it", () => {
    const a = mk(1, { dependsOn: [dep(2)] });
    const s = { drafts: [a, mk(2)] };
    expect(preview(a, s).body).toContain("- Story 2 (draft)");
    expect(preview(a, s, [], (o) => `see ${o.title!.text}`).body).toContain("- see Story 2");
  });
});

describe("planOf", () => {
  it("offers a ready draft", () => {
    const r = plan([mk(1, { ready: true })]);
    expect(r.items[0]).toMatchObject({ n: 1, state: "ready", title: "Story 1", labels: [], dependsOn: [] });
    expect(r.items[0]!.reason).toBeUndefined();
    expect(r.willCreate).toEqual([uid(1)]);
  });
  it("works out readiness now: no check, a reworded list, not met", () => {
    expect(plan([mk(1)]).items[0]).toMatchObject({ state: "not-ready", reason: expect.stringMatching(/no readiness check/) });
    expect(plan([mk(1, { ready: true })], { list: [{ id: "out-of-scope", text: "reworded" }] }).items[0]!.reason).toMatch(/changed since the check/);
    expect(plan([mk(1, { ready: "not-met" })]).items[0]!.reason).toBe("1 item of the Definition of Ready is not met");
    expect(plan([mk(1)]).willCreate).toEqual([]);
  });
  it("a draft without a title can be ready when the list is met", () => {
    const d = mk(1, { ready: true });
    delete d.title;
    expect(plan([d]).items[0]).toMatchObject({ state: "ready", title: "" });
  });
  it("does not offer a ready draft that depends on a draft that is not ready, and names it", () => {
    const r = plan([mk(1, { ready: true, dependsOn: [dep(2)] }), mk(2, { title: { text: "Blocker", from: "typed" } })]);
    expect(r.items.map((i) => i.draft)).toEqual([uid(2), uid(1)]);
    expect(r.items[1]).toMatchObject({ state: "not-ready" });
    expect(r.items[1]!.reason).toContain("Blocker");
    expect(r.willCreate).toEqual([]);
  });
  it("blocks over a chain", () => {
    const r = plan([mk(1, { ready: true, dependsOn: [dep(2)] }), mk(2, { ready: true, dependsOn: [dep(3)] }), mk(3)]);
    expect(r.items.map((i) => i.state)).toEqual(["not-ready", "not-ready", "not-ready"]);
    expect(r.items[2]!.reason).toContain("Story 2");
    expect(r.willCreate).toEqual([]);
  });
  it("marks a circle not ready", () => {
    const r = plan([mk(1, { ready: true, dependsOn: [dep(2)] }), mk(2, { ready: true, dependsOn: [dep(1)] })]);
    expect(r.items.map((i) => i.state)).toEqual(["not-ready", "not-ready"]);
    expect(r.willCreate).toEqual([]);
  });
  it("offers two ready drafts in order, with the dependency as a new issue", () => {
    const r = plan([mk(1, { ready: true, dependsOn: [dep(2)] }), mk(2, { ready: true })]);
    expect(r.items.map((i) => [i.n, i.draft, i.state])).toEqual([[1, uid(2), "ready"], [2, uid(1), "ready"]]);
    expect(r.willCreate).toEqual([uid(2), uid(1)]);
    expect(r.items[1]!.body).toContain("- new issue 1: Story 2");
    expect(r.items[1]!.dependsOn).toEqual([{ item: 1, title: "Story 2" }]);
  });
  it("an issue number is a dependency as it is", () => {
    const r = plan([mk(1, { ready: true, dependsOn: [issueDep(9)] })]);
    expect(r.items[0]!.dependsOn).toEqual([{ issue: 9 }]);
    expect(r.items[0]!.body).toContain("- #9");
  });
  it("a draft on GitHub has that state, and its dependants are not blocked", () => {
    const r = plan([mk(1, { ready: true, dependsOn: [dep(2)] }), mk(2)], { onGithub: new Map([[uid(2), 12]]) });
    expect(r.items[0]).toMatchObject({ draft: uid(2), state: "on-github", issue: 12, labels: [] });
    expect(r.items[1]).toMatchObject({ state: "ready", dependsOn: [{ issue: 12 }] });
    expect(r.items[1]!.body).toContain("- #12");
    expect(r.willCreate).toEqual([uid(1)]);
  });
  it("has the build label, and the review label only when the draft asks", () => {
    const r = plan([mk(1, { ready: true, addReviewLabel: true }), mk(2, { ready: true })], { buildLabel: "Factory_go", reviewLabel: "Review" });
    expect(r.items.map((i) => i.labels)).toEqual([["Factory_go", "Review"], ["Factory_go"]]);
    expect(plan([mk(1, { ready: true, addReviewLabel: true })], { buildLabel: "Factory_go" }).items[0]!.labels).toEqual(["Factory_go"]);
    expect(plan([mk(1, { ready: true, addReviewLabel: true })], { buildLabel: "Factory_go", reviewLabel: "Factory_go" }).items[0]!.labels).toEqual(["Factory_go"]);
    expect(plan([mk(1, { ready: true, addReviewLabel: true })], { buildLabel: "Factory_go", reviewLabel: "factory_GO" }).items[0]!.labels).toEqual(["Factory_go"]);
    expect(plan([mk(1, { ready: true })]).items[0]!.labels).toEqual([]);
    expect(plan([mk(1, { ready: true })], { buildLabel: "Factory_go", onGithub: new Map([[uid(1), 3]]) }).items[0]!.labels).toEqual([]);
  });
});

/** Original `o` split into parts `p`: the original keeps no criteria unless `over` gives some. */
function splitOf(o: number, p: number[], over: Partial<Draft> = {}): Draft[] {
  return [mk(o, { splitInto: p.map(uid), criteria: [], ...over }), ...p.map((n) => mk(n, { part: { of: uid(o) } }))];
}

describe("withoutSplits", () => {
  it("returns the same drafts without a split", () => {
    const d = [mk(1), mk(2)];
    const r = withoutSplits(d);
    expect(r).toEqual(d);
    expect(r[0]).toBe(d[0]);
  });
  it("leaves out the original and keeps the session order", () => {
    expect(ids(withoutSplits([mk(5), ...splitOf(1, [2, 3]), mk(4)]))).toEqual([uid(5), uid(2), uid(3), uid(4)]);
  });
  it("gives a dependant one item per part, with the id and from of the replaced item", () => {
    const x = mk(9, { dependsOn: [issueDep(7), { ...dep(1), from: "accepted" as const }] });
    const r = withoutSplits([...splitOf(1, [2, 3]), x]).find((d) => d.id === uid(9))!;
    expect(r.dependsOn).toEqual([issueDep(7), { id: uid(201), draft: uid(2), from: "accepted" }, { id: uid(201), draft: uid(3), from: "accepted" }]);
  });
  it("names no draft twice", () => {
    for (const dependsOn of [[dep(2), dep(1)], [dep(1), dep(2)]]) {
      const r = withoutSplits([...splitOf(1, [2, 3]), mk(9, { dependsOn })]).find((d) => d.id === uid(9))!;
      expect(r.dependsOn.map((x) => x.draft)).toEqual([uid(2), uid(3)]);
    }
  });
  it("never makes a part depend on itself", () => {
    const parts = splitOf(1, [2, 3]);
    parts[1] = mk(2, { part: { of: uid(1) }, dependsOn: [dep(1)] });
    const r = withoutSplits(parts).find((d) => d.id === uid(2))!;
    expect(r.dependsOn.map((x) => x.draft)).toEqual([uid(3)]);
  });
  it("expands two originals", () => {
    const r = withoutSplits([...splitOf(1, [2, 3]), ...splitOf(4, [5, 6]), mk(9, { dependsOn: [dep(1), dep(4)] })]).at(-1)!;
    expect(r.dependsOn.map((x) => x.draft)).toEqual([uid(2), uid(3), uid(5), uid(6)]);
  });
  it("does not change its input", () => {
    const drafts = [...splitOf(1, [2, 3]), mk(9, { dependsOn: [dep(1)] })];
    const before = JSON.stringify(drafts);
    withoutSplits(drafts);
    expect(JSON.stringify(drafts)).toBe(before);
    expect(drafts[3]!.dependsOn[0]!.draft).toBe(uid(1));
  });
});

describe("planOf replaces", () => {
  const source = { issue: 12, draft: uid(1) };
  const ready = (n: number) => mk(n, { part: { of: uid(1) }, ready: true });
  const split = (parts: Draft[]) => [mk(1, { splitInto: parts.filter((p) => p.part?.of === uid(1)).map((p) => p.id), criteria: [] }), ...parts];
  it("names the leaves when all are ready", () => {
    const r = plan(split([ready(2), ready(3)]), { source });
    expect(r.replaces).toEqual({ issue: 12, parts: [{ item: 1, title: "Story 2" }, { item: 2, title: "Story 3" }], ready: true });
    expect(r).not.toHaveProperty("notChanged");
  });
  it("shows a part on GitHub as its issue", () => {
    const r = plan(split([ready(2), ready(3)]), { source, onGithub: new Map([[uid(2), 101]]) });
    expect(r.replaces).toEqual({ issue: 12, parts: [{ issue: 101 }, { item: 2, title: "Story 3" }], ready: true });
  });
  it("is not ready when a leaf is not", () => {
    expect(plan(split([ready(2), mk(3, { part: { of: uid(1) } })]), { source }).replaces!.ready).toBe(false);
  });
  it("uses the leaves of nested splits", () => {
    const drafts = [
      mk(1, { splitInto: [uid(2), uid(3)], criteria: [] }),
      ready(2),
      mk(3, { part: { of: uid(1) }, splitInto: [uid(4), uid(5)], criteria: [] }),
      mk(4, { part: { of: uid(3) }, ready: true }),
      mk(5, { part: { of: uid(3) }, ready: true }),
    ];
    const r = plan(drafts, { source });
    expect(r.replaces!.parts.map((p) => ("title" in p ? p.title : p.issue))).toEqual(["Story 2", "Story 4", "Story 5"]);
    expect(r.replaces!.ready).toBe(true);
  });
  it("gives neither replaces nor notChanged once replaced", () => {
    const r = plan(split([ready(2), ready(3)]), { source, replaced: true });
    expect(r.replaces).toBeUndefined();
    expect(r.notChanged).toBeUndefined();
  });
  it("gives notChanged only for a removed mark", () => {
    const r = plan([ready(2)], { source: { issue: 12, draft: uid(9) } });
    expect(r.notChanged).toBe(12);
    expect(r.replaces).toBeUndefined();
  });
  it("gives nothing without a source", () => {
    expect(plan(split([ready(2), ready(3)])).replaces).toBeUndefined();
  });
});

describe("leftBehind", () => {
  it("is empty without a split, and for an original without criteria", () => {
    expect(leftBehind([mk(1)])).toEqual([]);
    expect(leftBehind(splitOf(1, [2, 3]))).toEqual([]);
  });
  it("names an original with criteria, in session order", () => {
    const two = [{ id: uid(501), text: "a", from: "typed" as const }, { id: uid(502), text: "b", from: "typed" as const }];
    const untitled = splitOf(4, [5, 6], { criteria: [two[0]!] });
    delete untitled[0]!.title;
    expect(leftBehind([...splitOf(1, [2, 3], { criteria: two }), ...untitled])).toEqual([
      { draft: uid(1), title: "Story 1", criteria: 2 },
      { draft: uid(4), title: "…", criteria: 1 },
    ]);
  });
});

describe("planOf with splits", () => {
  const parts = () => [...splitOf(1, [2, 3]).slice(0, 1), mk(2, { ready: true, part: { of: uid(1) } }), mk(3, { ready: true, part: { of: uid(1) }, dependsOn: [dep(2)] })];
  it("has no item for the original and numbers the rest", () => {
    const r = plan([...parts(), mk(9, { ready: true, dependsOn: [dep(1)] })]);
    expect(r.items.map((i) => [i.n, i.draft])).toEqual([[1, uid(2)], [2, uid(3)], [3, uid(9)]]);
    expect(r.willCreate).toEqual([uid(2), uid(3), uid(9)]);
    expect(r.leftBehind).toEqual([]);
    const x = r.items[2]!;
    expect(x.dependsOn).toEqual([{ item: 1, title: "Story 2" }, { item: 2, title: "Story 3" }]);
    expect(x.body).toContain("- new issue 1: Story 2");
    expect(x.body).toContain("- new issue 2: Story 3");
    expect(x.body).not.toContain("Story 1");
  });
  it("uses the issue number of a part on GitHub", () => {
    const x = plan([...parts(), mk(9, { ready: true, dependsOn: [dep(1)] })], { onGithub: new Map([[uid(2), 12]]) }).items.find((i) => i.draft === uid(9))!;
    expect(x.dependsOn[0]).toEqual({ issue: 12 });
    expect(x.body).toContain("- #12");
  });
  it("names the part that is not ready, never the original", () => {
    const d = parts();
    d[1] = mk(2, { part: { of: uid(1) } });
    const r = plan([...d, mk(9, { ready: true, dependsOn: [dep(1)] })]);
    expect(r.items.find((i) => i.draft === uid(3))!.reason).toBe('it depends on "Story 2", which is not ready');
    expect(r.items.find((i) => i.draft === uid(9))!.reason).toMatch(/depends on "Story [23]"/);
  });
  it("finds a circle through a split", () => {
    const d = parts();
    d[1] = mk(2, { ready: true, part: { of: uid(1) }, dependsOn: [dep(9)] });
    const r = plan([...d, mk(9, { ready: true, dependsOn: [dep(1)] })]);
    for (const n of [2, 9]) expect(r.items.find((i) => i.draft === uid(n))).toMatchObject({ state: "not-ready", reason: "it depends on itself through other drafts" });
  });
  it("reports what stays behind", () => {
    expect(plan(splitOf(1, [2, 3], { title: { text: "Story O", from: "typed" } })).leftBehind).toEqual([]);
    expect(plan(splitOf(1, [2, 3], { title: { text: "Story O", from: "typed" }, criteria: [{ id: uid(501), text: "a", from: "typed" }] })).leftBehind).toEqual([{ draft: uid(1), title: "Story O", criteria: 1 }]);
  });
});

describe("issueText", () => {
  it("has the Epic, the accepted lines, the note, and never (draft)", () => {
    const a = mk(1, { dependsOn: [dep(2)] });
    const t = issueText(a, { drafts: [a, mk(2)], epic: 73 }, { accepted: [{ text: "item", reason: "Because" }], by: "Ann", date: "2026-10-07", numberOf: () => ({ item: 2 }) });
    expect(t.body).toContain("**Epic:** #73");
    expect(t.body).toContain("### Accepted anyway\n- item: Because");
    expect(t.body).toContain("- new issue 2: Story 2");
    expect(t.body).not.toContain("(draft)");
    expect(t.body.endsWith("\n\n---\nRefined in Spaghetti Code Foundry by Ann on 2026-10-07.")).toBe(true);
  });
  it("prints a draft that is not in the plan without a number", () => {
    const a = mk(1, { dependsOn: [dep(2)] });
    expect(issueText(a, { drafts: [a, mk(2)] }, { accepted: [], by: "Ann", date: "2026-10-07", numberOf: () => undefined }).body).toContain("- Story 2\n");
  });
  it("holds no text of the architect", () => {
    const d = mk(1, {
      ready: true,
      suggestions: [{ id: uid(900), field: "what", text: "MARK-SUGGESTION" }],
      rejected: [{ field: "why", text: "MARK-REJECTED", reason: "MARK-REJECT-REASON" }],
      review: { at: AT, remarks: [{ field: "what", kind: "vague", text: "MARK-REMARK", about: "to export" }] },
    });
    d.readiness!.items.push({ id: "z", text: "z", result: "unsure", reason: "MARK-ARCHITECT", by: "architect", field: "what", about: "MARK-ABOUT" });
    expect(plan([d]).items[0]!.body).not.toMatch(/MARK-/);
  });
});

const S = uid(900);
const rules = (over: Partial<LabelRules> = {}): LabelRules => ({ repo: "acme/app", repoLabels: ["bug", "Factory_go", "Factory_review_plan", "Area:API"], buildLabel: "Factory_go", reviewLabel: "Factory_review_plan", ...over });
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof RefinementError ? e.code : e;
  }
  return undefined;
};

describe("the hidden marker", () => {
  it("is read back from the last line only, and blank lines after it are fine", () => {
    const m = refinedMarker(S, uid(1));
    expect(refinedHashIn(`Text\n\n${m}`)).toBe(refinedHash(S, uid(1)));
    expect(refinedHashIn(`Text\n\n  ${m}  \n\n\n`)).toBe(refinedHash(S, uid(1)));
    expect(refinedHashIn(`${m}\nmore text`)).toBeUndefined();
    expect(refinedHashIn(`before ${m}`)).toBeUndefined();
    expect(refinedHashIn(`> ${m}`)).toBeUndefined();
    expect(refinedHashIn(undefined)).toBeUndefined();
    expect(refinedHashIn("")).toBeUndefined();
    expect(refinedHash(S, uid(1))).not.toBe(refinedHash(S, uid(2)));
    expect(m).not.toContain(S);
  });

  it("finds the issue of a draft: the lowest number, a safe number only", () => {
    const m = refinedMarker(S, uid(1));
    const list = [{ number: 30, body: m }, { number: 9, body: `x\n${m}` }, { number: 5, body: "no" }, { number: 0, body: m }, { number: 4, body: refinedMarker(S, uid(2)) }];
    expect(issueWithMarker(list, S, uid(1))?.number).toBe(9);
    expect(issueWithMarker(list, S, uid(3))).toBeUndefined();
  });
});

describe("issueUrl", () => {
  it("keeps the link of this repository and number, also in another case", () => {
    expect(issueUrl("acme/app", 7, "https://github.com/acme/app/issues/7")).toBe("https://github.com/acme/app/issues/7");
    expect(issueUrl("acme/app", 7, "https://github.com/Acme/App/issues/7")).toBe("https://github.com/Acme/App/issues/7");
  });
  it("builds the link from the repository and number for anything else", () => {
    for (const bad of ["https://github.com/other/thing/issues/7", "https://github.com/acme/app/issues/8", "javascript:alert(1)", 7, undefined]) {
      expect(issueUrl("acme/app", 7, bad)).toBe("https://github.com/acme/app/issues/7");
    }
  });
});

describe("parsePublishInput", () => {
  const drafts = [mk(1), mk(2)];
  it("gives no choices for a missing drafts, and fills the defaults", () => {
    expect(parsePublishInput({}, drafts).size).toBe(0);
    expect([...parsePublishInput({ drafts: [{ draft: uid(1) }] }, drafts)]).toEqual([[uid(1), { labels: [], startBuilding: false }]]);
  });
  it("trims labels and collapses duplicates of any case to the first", () => {
    const c = parsePublishInput({ drafts: [{ draft: uid(1), labels: [" bug ", "BUG", "Area:API"], startBuilding: true }] }, drafts);
    expect(c.get(uid(1))).toEqual({ labels: ["bug", "Area:API"], startBuilding: true });
  });
  it("refuses what is not allowed", () => {
    const bad = (input: unknown) => code(() => parsePublishInput(input, drafts));
    for (const input of [null, [], "x", { drafts: {} }, { drafts: [1] }, { drafts: [{}] }, { drafts: [{ draft: uid(9) }] }, { drafts: [{ draft: uid(1) }, { draft: uid(1) }] }]) expect(bad(input)).toBe("bad-draft");
    for (const labels of ["x", [1], [""], ["  "], ["a".repeat(51)], ["a\nb"], Array.from({ length: 21 }, (_, i) => `l${i}`)]) {
      expect(bad({ drafts: [{ draft: uid(1), labels }] })).toBe("bad-draft");
    }
    expect(bad({ drafts: [{ draft: uid(1), startBuilding: "yes" }] })).toBe("bad-draft");
    expect(bad({ drafts: [{ draft: uid(1), labels: Array.from({ length: 20 }, (_, i) => `l${i}`) }] })).toBeUndefined();
  });
});

describe("versions of an issue", () => {
  it("hashes the canonical form: stable, 64 hex characters, different for a different title or text", () => {
    const v = { title: "a", body: "b\nc" };
    expect(versionHash(v)).toMatch(/^[0-9a-f]{64}$/);
    expect(versionHash({ ...v })).toBe(versionHash(v));
    expect(versionHash({ ...v, title: "x" })).not.toBe(versionHash(v));
    expect(versionHash({ ...v, body: "x" })).not.toBe(versionHash(v));
    expect(versionHash({ title: "a", body: "b\nc" })).not.toBe(versionHash({ title: "a\nb", body: "c" }));
  });
  it("sameVersion ignores line ends and surrounding white space, and the hash agrees", () => {
    const a = { title: "T", body: "one\ntwo" };
    const b = { title: "T ", body: "one\r\ntwo\r\n" };
    expect(sameVersion(a, b)).toBe(true);
    expect(versionHash(a)).toBe(versionHash(b));
    expect(sameVersion(a, { ...a, title: "Other" })).toBe(false);
    expect(sameVersion(a, { ...a, body: "one\ntwo!" })).toBe(false);
  });
  const seen = "a".repeat(64);
  it("parseSourceChoice: nothing without source, both keeps accepted", () => {
    expect(parseSourceChoice({})).toBeUndefined();
    expect(parseSourceChoice({ source: { keep: "mine", seen } })).toEqual({ keep: "mine", seen });
    expect(parseSourceChoice({ source: { keep: "github", seen, extra: 1 } })).toEqual({ keep: "github", seen });
  });
  it("parseSourceChoice refuses what is not a choice", () => {
    for (const source of [null, "mine", [], {}, { keep: "both", seen }, { keep: "mine" }, { keep: "mine", seen: "abc" }, { keep: "mine", seen: "A".repeat(64) }, { keep: "mine", seen: 1 }]) {
      expect(code(() => parseSourceChoice({ source }))).toBe("bad-draft");
    }
  });
  it("parsePublishInput ignores source", () => {
    expect(parsePublishInput({ source: { keep: "mine", seen } }, [mk(1)]).size).toBe(0);
  });
});

describe("chosenLabels", () => {
  const choice = (labels: string[] = [], startBuilding = false) => ({ labels, startBuilding });
  it("gives the labels in the spelling of the repository, and needs no draft", () => {
    expect(chosenLabels(undefined, rules())).toEqual([]);
    expect(chosenLabels(choice(["area:api", "BUG"]), rules())).toEqual(["Area:API", "bug"]);
  });
  it("refuses a label the repository does not have", () => {
    expect(code(() => chosenLabels(choice(["nope"]), rules()))).toBe("bad-draft");
  });
  it("refuses the build label and the review label as a chosen label", () => {
    expect(code(() => chosenLabels(choice(["factory_go"]), rules()))).toBe("bad-draft");
    expect(code(() => chosenLabels(choice(["Factory_review_plan"]), rules()))).toBe("bad-draft");
  });
  it("refuses startBuilding with no build label, or with one the repository does not have", () => {
    expect(code(() => chosenLabels(choice([], true), rules({ buildLabel: undefined })))).toBe("bad-draft");
    expect(code(() => chosenLabels(choice([], true), rules({ repoLabels: ["bug"] })))).toBe("bad-draft");
    expect(chosenLabels(choice([], true), rules())).toEqual([]);
  });
});

describe("labelsFor", () => {
  const choice = (labels: string[] = [], startBuilding = false) => ({ labels, startBuilding });
  it("adds the build label only with startBuilding, and the review label only for a draft that asks", () => {
    expect(labelsFor(choice(["bug"]), mk(1), rules())).toEqual(["bug"]);
    expect(labelsFor(choice(["bug"], true), mk(1), rules())).toEqual(["bug", "Factory_go"]);
    expect(labelsFor(choice(), mk(1, { addReviewLabel: true }), rules())).toEqual(["Factory_review_plan"]);
    expect(labelsFor(undefined, mk(1), rules())).toEqual([]);
  });
  it("refuses the review label when there is none or the repository does not have it", () => {
    expect(code(() => labelsFor(choice(), mk(1, { addReviewLabel: true }), rules({ reviewLabel: undefined })))).toBe("bad-draft");
    expect(code(() => labelsFor(choice(), mk(1, { addReviewLabel: true }), rules({ repoLabels: ["bug"] })))).toBe("bad-draft");
  });
  it("needs startBuilding when the review label is the build label, and sends the label once", () => {
    const same = rules({ reviewLabel: "factory_go" });
    expect(code(() => labelsFor(choice(), mk(1, { addReviewLabel: true }), same))).toBe("bad-draft");
    expect(labelsFor(choice([], true), mk(1, { addReviewLabel: true }), same)).toEqual(["Factory_go"]);
  });
});

describe("planOf with the issue a session came from", () => {
  const src = (draft?: string) => ({ source: { issue: 12, ...(draft ? { draft } : {}) } });
  it("shows the marked draft as updating the issue, and keeps it out of willCreate", () => {
    const p = plan([mk(1, { ready: true }), mk(2, { ready: true, dependsOn: [dep(1)] })], src(uid(1)));
    expect(p.items.map((i) => i.updates)).toEqual([12, undefined]);
    expect(p.willUpdate).toEqual([uid(1)]);
    expect(p.willCreate).toEqual([uid(2)]);
    expect(p.notChanged).toBeUndefined();
    expect(p.items[1]!.dependsOn).toEqual([{ issue: 12 }]);
    expect(p.items[1]!.body).toContain("- #12");
  });
  it("does not offer the marked draft when it is not ready, and blocks the one that depends on it", () => {
    const p = plan([mk(1), mk(2, { ready: true, dependsOn: [dep(1)] })], src(uid(1)));
    expect(p.willUpdate).toEqual([]);
    expect(p.items[0]!.updates).toBe(12);
    expect(p.items[1]!.state).toBe("not-ready");
    expect(p.willCreate).toEqual([]);
  });
  it("waits with the marked draft when it depends on a draft that is not on GitHub yet", () => {
    const p = plan([mk(1, { ready: true, dependsOn: [dep(2)] }), mk(2, { ready: true })], src(uid(1)));
    expect(p.willUpdate).toEqual([]);
    expect(p.willCreate).toEqual([uid(2)]);
    expect(p.items.find((i) => i.draft === uid(1))!.reason).toMatch(/publish that first/);
    const later = plan([mk(1, { ready: true, dependsOn: [dep(2)] }), mk(2, { ready: true })], { ...src(uid(1)), onGithub: new Map([[uid(2), 40]]) });
    expect(later.willUpdate).toEqual([uid(1)]);
    expect(later.items.find((i) => i.draft === uid(1))!.dependsOn).toEqual([{ issue: 40 }]);
  });
  it("says the issue is not changed when the marked draft is gone or split, or there is no mark", () => {
    const gone = plan([mk(2, { ready: true })], src(uid(1)));
    expect(gone.notChanged).toBe(12);
    expect(gone.willUpdate).toEqual([]);
    expect(gone.willCreate).toEqual([uid(2)]);
    const split = plan([mk(1, { splitInto: [uid(3)] }), mk(3, { ready: true })], src(uid(1)));
    // A split mark is replaced by its parts, so it is not "not changed".
    expect(split.notChanged).toBeUndefined();
    expect(split.replaces?.issue).toBe(12);
    expect(split.items.some((i) => i.updates !== undefined)).toBe(false);
    expect(plan([mk(2, { ready: true })], src()).notChanged).toBe(12);
  });
  it("leaves a published marked draft as on GitHub", () => {
    const p = plan([mk(1, { ready: true })], { ...src(uid(1)), onGithub: new Map([[uid(1), 12]]) });
    expect(p.items[0]).toMatchObject({ state: "on-github", issue: 12 });
    expect(p.items[0]!.updates).toBeUndefined();
    expect(p.notChanged).toBeUndefined();
    expect(p.willUpdate).toEqual([]);
  });
  it("has no update and no notChanged without a source", () => {
    const p = plan([mk(1, { ready: true })]);
    expect(p.willUpdate).toEqual([]);
    expect("notChanged" in p).toBe(false);
  });
});

describe("changedSections", () => {
  const story = (crit: string, extra = "") => `As a, I want b, so that c.\n\n### Acceptance criteria\n- [ ] ${crit}\n${extra}`;
  it("is empty for the same text, also with markers and the refined note", () => {
    const a = story("one");
    expect(changedSections(a, a)).toEqual([]);
    expect(changedSections(a, `${a}\n---\nRefined in Spaghetti Code Foundry by Ann on 2026-01-01.\n\n${refinedMarker("s", "d")}`)).toEqual([]);
  });
  it("names a changed, a new and a removed section", () => {
    expect(changedSections(story("one"), story("two"))).toEqual(["Acceptance criteria"]);
    expect(changedSections(story("one"), story("one", "\n### Out of scope\nx"))).toEqual(["Out of scope (new)"]);
    expect(changedSections(story("one", "\n### Out of scope\nx"), story("one"))).toEqual(["Out of scope (removed)"]);
  });
  it("calls a plain old text Story and the new sections new", () => {
    expect(changedSections("Please fix it.", story("one"))).toEqual(["Story", "Acceptance criteria (new)"]);
  });
  it("does not take a heading inside a code fence", () => {
    const fenced = "As a, I want b, so that c.\n\n```\n### Not a heading\n```\n\n### Acceptance criteria\n- [ ] one";
    expect(changedSections(fenced, fenced.replace("Not a heading", "Still not"))).toEqual(["Story"]);
  });
});

describe("updateComment", () => {
  const o = { by: "Ann", date: "2026-10-07", oldTitle: "Old", oldBody: "Please fix it.", newTitle: "New", newBody: "As a, I want b, so that c.\n\n### Acceptance criteria\n- [ ] one", marker: updateMarker("s", "d") };
  it("says who, what changed, and folds the old title and text", () => {
    const c = updateComment(o);
    expect(c).toContain("by Ann on 2026-10-07");
    expect(c).toContain("- Title: changed");
    expect(c).toContain("- Sections changed: Story, Acceptance criteria (new)");
    expect(c).toContain("<details>");
    expect(c).toContain("```text\nOld\n```");
    expect(c).toContain("```text\nPlease fix it.\n```");
    expect(updateComment({ ...o, newTitle: "Old" })).toContain("- Title: not changed");
    expect(updateComment({ ...o, oldBody: o.newBody, newBody: o.newBody })).toContain("- Sections changed: none");
  });
  it("ends with the marker, which is ours and not a status comment, whatever the old text ends with", () => {
    const c = updateComment({ ...o, oldBody: "text\n<!-- claude-factory status -->" });
    expect(c.trimEnd().split("\n").at(-1)).toBe(o.marker);
    expect(isBot({ body: c })).toBe(true);
    expect(isStatusComment({ body: c })).toBe(false);
    expect(endsWithMarker(c, o.marker)).toBe(true);
    expect(endsWithMarker(`> ${o.marker}\nthanks`, o.marker)).toBe(false);
  });
  it("uses a longer fence than any in the old text", () => {
    const c = updateComment({ ...o, oldBody: "a ```` b\n```js\nx\n```" });
    expect(c).toContain("`````text\na ```` b");
  });
  it("keeps the marker of the update apart from the one of the issue", () => {
    expect(updateMarker("s", "d")).not.toBe(refinedMarker("s", "d"));
    expect(refinedHashIn(updateMarker("s", "d"))).toBeUndefined();
  });
});
