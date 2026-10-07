import { describe, expect, it } from "vitest";
import { preview, type Draft } from "../src/refinement/draft.js";
import { isReady, notReadyReason } from "../src/refinement/draft-ready.js";
import { issueText, planOf, publishOrder, type PlanInput } from "../src/refinement/publish.js";
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
