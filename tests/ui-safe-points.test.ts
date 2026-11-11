import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let sp: any;
let model: any;
let simple: any;
beforeAll(async () => {
  restore = installFakeDom();
  sp = await import("../ui/safe-points.js" as string);
  model = await import("../ui/simple-model.js" as string);
  simple = await import("../ui/simple.js" as string);
});
afterAll(() => restore());

const walk = (el: FakeElement): FakeElement[] => el.children.flatMap((c) => (c instanceof FakeElement ? [c, ...walk(c)] : []));
const box = (nodes: any[]) => {
  const root = new FakeElement("div");
  root.append(...nodes.filter(Boolean));
  return root;
};
const NOW = new Date(2026, 10, 11, 15, 0).getTime();
const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).toISOString();
const point = (over: any = {}) => ({ commit: "a".repeat(40), short: "aaaaaaa", branch: "develop", at: at(2026, 11, 11, 13, 19), release: false, changes: [{ issue: 1, title: "One" }], by: { kind: "you" }, ...over });
const answer = (points: any[], over: any = {}) => ({ branch: "develop", gitflow: true, complete: true, points, ...over });

describe("whenText", () => {
  it("says today, yesterday, a date this year, a date of another year, and nothing for a bad time", () => {
    expect(sp.whenText(at(2026, 11, 11, 13, 19), NOW)).toBe("today 13:19");
    expect(sp.whenText(at(2026, 11, 10, 9, 2), NOW)).toBe("yesterday 09:02");
    expect(sp.whenText(at(2026, 11, 3, 13, 19), NOW)).toBe("3 Nov 13:19");
    expect(sp.whenText(at(2025, 11, 3, 13, 19), NOW)).toBe("3 Nov 2025");
    expect(sp.whenText("nope", NOW)).toBe("");
    expect(sp.whenText(undefined, NOW)).toBe("");
  });
});

describe("lastGoodText", () => {
  it("is empty without an answer or a point, and says when otherwise", () => {
    expect(sp.lastGoodText(undefined, NOW)).toBe("");
    expect(sp.lastGoodText(answer([]), NOW)).toBe("");
    expect(sp.lastGoodText(answer([point()]), NOW)).toBe("Last good version: today 13:19");
  });
});

describe("pointLines", () => {
  it("shows the commit in Advanced only, and says Final version for a release without changes", () => {
    expect(sp.pointLines(point(), { simple: true, now: NOW })).toEqual({ when: "today 13:19", what: "One", who: "started by you" });
    expect(sp.pointLines(point(), { now: NOW }).commit).toBe("aaaaaaa (develop)");
    expect(sp.pointLines(point({ changes: [], release: true, tag: "v1" }), { simple: true, now: NOW }).what).toBe("Final version v1");
    expect(sp.pointLines(point({ changes: [{ title: "A" }, { title: "B" }], moreChanges: 3 }), { simple: true, now: NOW }).what).toBe("A, B and 3 more");
    expect(sp.pointLines(point({ by: { kind: "foundry" } }), { simple: true }).who).toBe("started by the Foundry");
    expect(sp.pointLines(point({ by: { kind: "person" } }), { simple: true }).who).toBe("started by someone else");
    expect(sp.pointLines(point({ by: { kind: "person", name: "Bea" } }), { simple: true }).who).toBe("started by Bea");
  });
});

describe("safePointsView", () => {
  it("shows a failed read, an empty list, an unfinished search and a list", () => {
    expect(box(sp.safePointsView(undefined)).textContent).toContain("Could not load");
    expect(box(sp.safePointsView(answer([]))).textContent).toContain("No version that worked");
    expect(box(sp.safePointsView(answer([], { complete: false }))).textContent).toContain("Not all past work was checked");
    const t = box(sp.safePointsView(answer([point({ changes: [{ title: "<b>x</b>" }] })]), { now: NOW })).textContent;
    expect(t).toContain("today 13:19");
    expect(t).toContain("<b>x</b>");
    expect(t).toContain("aaaaaaa");
  });
});

describe("safePointsPart", () => {
  it("loads, draws, and reads again after an error", async () => {
    const safePoints = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValue(answer([point()]));
    const part = sp.safePointsPart("r1", { a: { safePoints } });
    await vi.waitFor(() => expect(part.el.textContent).toContain("Could not load"));
    const button = walk(part.el).find((e) => e.tag === "button" && e.textContent === "Read again");
    expect(button).toBeDefined();
    (button as any).click();
    await vi.waitFor(() => expect(part.el.textContent).toContain("One"));
    expect(safePoints).toHaveBeenCalledTimes(2);
  });
});

const repos = [{ id: "r1", url: "https://github.com/o/app", github: "o/app" }];
const api = (safePoints?: any): any => ({ repos: vi.fn(async () => repos), runs: vi.fn(async () => []), queue: vi.fn(async () => ({ active: [], pending: [] })), run: vi.fn(), ...(safePoints ? { safePoints } : {}) });

describe("the Simple pages", () => {
  it("shows Versions that worked on the project page", async () => {
    const main = new FakeElement("div");
    (await simple.renderSimpleProject(main, { id: "r1", a: api(async () => answer([point()])) }))();
    expect(main.textContent).toContain("Versions that worked");
    expect(main.textContent).toContain("One");
    expect(main.textContent).not.toContain("aaaaaaa");
  });
  it("still draws the page when the read fails or there is no such call", async () => {
    for (const a of [api(async () => { throw new Error("x"); }), api()]) {
      const main = new FakeElement("div");
      (await simple.renderSimpleProject(main, { id: "r1", a }))();
      expect(main.textContent).toContain("What you need to do");
      expect(main.textContent).toContain("Could not load the versions that worked.");
    }
  });
  it("shows the last good version on the home, and no line without a point", async () => {
    const main = new FakeElement("div");
    (await simple.renderSimpleHome(main, { a: api(async () => answer([point({ at: new Date().toISOString() })])) }))();
    expect(main.textContent).toContain("Last good version: today ");
    const none = new FakeElement("div");
    (await simple.renderSimpleHome(none, { a: api(async () => answer([])) }))();
    expect(none.textContent).not.toContain("Last good version");
    const failed = new FakeElement("div");
    (await simple.renderSimpleHome(failed, { a: api(async () => { throw new Error("x"); }) }))();
    expect(failed.textContent).not.toContain("Last good version");
  });
});

describe("homeModel", () => {
  it("gives the text only for the project the answer is about", () => {
    const projects = model.projectsModel(repos, [], []);
    const safe = (id: string) => ({ id, answer: answer([point()]) });
    expect(model.homeModel([], [], repos, projects, { now: NOW, safe: safe("other") }).project.lastGood).toBe("");
    expect(model.homeModel([], [], repos, projects, { now: NOW, safe: safe("r1") }).project.lastGood).toBe("Last good version: today 13:19");
  });
});

const PREVIEW = { commit: "a".repeat(40), takenBack: ["Two", "<i>Three</i>"], more: 2, others: "Other later changes are taken back too.", notUndone: "Restoring does not undo data.", confirm: { token: "tok", expiresAt: 1 } };
const buttonOf = (el: FakeElement, text: string) => walk(el).find((e) => e.tag === "button" && e.textContent === text) as any;

describe("restorePreview", () => {
  it("shows the titles as text, 'at least N more' and the two sentences", () => {
    const t = box(sp.restorePreview(PREVIEW)).textContent;
    for (const s of ["Two", "<i>Three</i>", "and at least 2 more", "Other later changes are taken back too.", "Restoring does not undo data."]) expect(t).toContain(s);
  });
  it("says that nothing is known when no change is listed", () => {
    expect(box(sp.restorePreview({ ...PREVIEW, takenBack: [], more: 0 })).textContent).toContain("No change of the Foundry is known");
  });
});

describe("restoreControl", () => {
  it("shows the preview, opens the change on confirm and links to it", async () => {
    const restoreSafePoint = vi.fn(async (_id: string, b: any) => (b.dryRun ? PREVIEW : { issue: 7, url: "https://github.com/o/app/issues/7" }));
    const el = sp.restoreControl("t1", point(), { a: { restoreSafePoint } });
    buttonOf(el, "Restore").click();
    await vi.waitFor(() => expect(el.textContent).toContain("Restoring does not undo data."));
    expect(restoreSafePoint).toHaveBeenCalledWith("t1", { commit: "a".repeat(40), dryRun: true });
    buttonOf(el, "Yes, open the change").click();
    await vi.waitFor(() => expect(el.textContent).toBe("Opened change #7"));
    expect(restoreSafePoint).toHaveBeenLastCalledWith("t1", { commit: "a".repeat(40), confirm: "tok" });
  });
  it("closes the preview on Cancel", async () => {
    const el = sp.restoreControl("t2", point(), { a: { restoreSafePoint: vi.fn(async () => PREVIEW) } });
    buttonOf(el, "Restore").click();
    await vi.waitFor(() => expect(buttonOf(el, "Cancel")).toBeDefined());
    buttonOf(el, "Cancel").click();
    expect(buttonOf(el, "Restore")).toBeDefined();
    expect(el.textContent).not.toContain("Restoring does not undo");
  });
  it("shows the sentence of the server on an error and tries again", async () => {
    const restoreSafePoint = vi.fn().mockRejectedValueOnce(new Error("Nothing was opened: no watcher")).mockResolvedValue(PREVIEW);
    const el = sp.restoreControl("t3", point(), { a: { restoreSafePoint } });
    buttonOf(el, "Restore").click();
    await vi.waitFor(() => expect(el.textContent).toContain("Nothing was opened: no watcher"));
    buttonOf(el, "Try again").click();
    await vi.waitFor(() => expect(el.textContent).toContain("Yes, open the change"));
  });
  it("gives the same element again, so a redraw keeps an open preview", () => {
    const a = { restoreSafePoint: vi.fn() };
    expect(sp.restoreControl("t4", point(), { a })).toBe(sp.restoreControl("t4", point(), { a }));
  });
});

describe("Restore in the lists", () => {
  it("is only in a list that is given the project", () => {
    expect(box(sp.safePointsView(answer([point()]), { now: NOW })).textContent).not.toContain("Restore");
    expect(box(sp.safePointsView(answer([point()]), { now: NOW, restore: { id: "t5", a: { restoreSafePoint: vi.fn() } } })).textContent).toContain("Restore");
  });
  it("is on the Simple project page and not on the Simple home", async () => {
    const main = new FakeElement("div");
    (await simple.renderSimpleProject(main, { id: "r1", a: api(async () => answer([point({ commit: "b".repeat(40) })])) }))();
    expect(main.textContent).toContain("Restore");
    const home = new FakeElement("div");
    (await simple.renderSimpleHome(home, { a: api(async () => answer([point()])) }))();
    expect(home.textContent).not.toContain("Restore");
  });
});
