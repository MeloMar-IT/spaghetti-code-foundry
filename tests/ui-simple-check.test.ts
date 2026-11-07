import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { nextStep } from "../src/next-step.js";
import { audit } from "./helpers/a11y.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let words: any;
let model: any;
let view: any;
let turn: any;
beforeAll(async () => {
  restore = installFakeDom();
  words = await import("../ui/simple-words.js" as string);
  model = await import("../ui/simple-model.js" as string);
  view = await import("../ui/simple.js" as string);
  turn = await import("../ui/simple-turn.js" as string);
});
afterAll(() => restore());

const tick = () => new Promise((r) => setTimeout(r, 0));
const box = (nodes: any[]) => {
  const root = new FakeElement("div");
  root.append(...nodes.filter(Boolean));
  return root;
};
const repo = { id: "r1", url: "https://github.com/o/app", github: "o/app" };
const run = (id: string, kind: any, over: any = {}, data: any = {}) => ({
  runId: id, flow: "issue-gitflow", task: "Show the weather\n\nShows the weather.", status: "waiting", startedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
  vars: { github_repo: "o/app" }, history: [], next: nextStep(kind, { runId: id, repo: "o/app", title: "Show the weather" } as any, data), ...over,
});
const item = (id: string, over: any = {}) => ({ key: `m-${id}`, kind: "approval", runId: id, acts: ["approve", "reject"], ...over });
const detailOf = (over: any = {}) => ({ stamp: "s1", digest: "d1", proposal: { text: "## Goal\nShow the weather today.\n\n## Plan\nDo it." }, ...over });

function page(r: any, { turns, detail = detailOf(), tryIt, actFn }: { turns?: any[]; detail?: any; tryIt?: any; actFn?: any } = {}) {
  const done = vi.fn();
  const answer: any = {
    detail: vi.fn(async (_k: string) => detail), act: actFn ?? vi.fn(async (_b: any) => ({})), done,
    approveRun: vi.fn(async () => ({})), rejectRun: vi.fn(async () => ({})), resumeRun: vi.fn(async () => ({})), tryIt, help: vi.fn(),
  };
  const m = model.projectModel(repo, [repo], [r], []);
  const draw = (t = turns ?? []) => box(view.projectView(m, { turns: t, answer }));
  return { m, draw, answer, card: m.todo[0] };
}
const btn = (p: FakeElement, label: string) => p.all("button").find((b) => b.textContent === label);
const type = (area: FakeElement, v: string) => { (area as any).value = v; area.fire("input", { target: area }); };
const forbidden = (p: FakeElement) => words.forbiddenIn(p.textContent);

describe("the model", () => {
  it("tags check cards", () => {
    expect(model.cardOf({ run: run("m1", "approval"), job: null }).approve).toBe("m1");
    expect(model.cardOf({ run: run("m2", "approve_plan"), job: null }).approve).toBe("m2");
    expect(model.cardOf({ run: run("m3", "approval", {}, { final: true }), job: null }).approve).toBeUndefined();
    expect(model.cardOf({ run: run("m4", "approve_split"), job: null }).approve).toBeUndefined();
  });

  it("marks a run no watcher follows as the person's own", () => {
    expect(model.cardOf({ run: run("m5", "approval"), job: null }).own).toBe(true);
    const watched = run("m6", "approval");
    (watched.next as any).watched = true;
    expect(model.cardOf({ run: watched, job: null }).own).toBeUndefined();
    // an issue alone does not make a run watched: the server says so
    expect(model.cardOf({ run: run("m7", "approval", { vars: { github_repo: "o/app", issue: "3" } }), job: null }).own).toBe(true);
    expect(model.cardOf({ run: run("m8", "approval", { status: "running" }), job: null }).own).toBeUndefined();
  });

  it("gives refinement runs no own decision and no resume, so they offer only Ask for help", () => {
    const r = run("rf1", "approval", { refinement: "s1" });
    expect(model.cardOf({ run: r, job: null }).own).toBeUndefined();
    const f = run("rf2", "failed", { status: "failed", state: { next: "x" }, refinement: "s1" });
    const c = model.cardOf({ run: f, job: null });
    expect(c.stuck).toBe("rf2");
    expect(c.resume).toBeUndefined();
    const p = page(f).draw([]);
    expect(btn(p, words.STUCK.again)).toBeUndefined();
    expect(btn(p, words.STUCK.help)).toBeTruthy();
  });

  it("tags failed cards and tells when they can be resumed", () => {
    const c = model.cardOf({ run: run("f1", "failed", { status: "failed", state: { next: "implement" }, finishedAt: "t1" }), job: null });
    expect(c.stuck).toBe("f1");
    expect(c.resume).toBe(true);
    expect(c.stuckAt).toBe("t1");
    expect(model.cardOf({ run: run("f2", "failed", { state: {} }), job: null }).resume).toBeUndefined();
    expect(model.cardOf({ run: run("f3", "failed", { state: { next: "x" } }, { retired: true }), job: null }).resume).toBeUndefined();
    const w = run("f4", "failed", { state: { next: "x" } });
    (w.next as any).watched = true;
    expect(model.cardOf({ run: w, job: null }).resume).toBeUndefined();
  });
});

describe("madeOf", () => {
  it("takes the Goal in plain words, cut at 400", () => {
    expect(turn.madeOf(detailOf(), { sentence: "S" })).toBe("Show the weather today.");
    expect(turn.madeOf({ proposal: { text: "## Goal\nOn a branch. Run it.\n## Next\nx" } }, { sentence: "S" })).toBe("Work it.");
    expect(turn.madeOf({ proposal: { text: `## Goal\n${"word ".repeat(200)}` } }, {}).length).toBeLessThanOrEqual(400);
  });
  it("falls back to the sentence, then the fixed line", () => {
    expect(turn.madeOf({ proposal: { text: "On a branch." } }, { sentence: "S" })).toBe("S");
    expect(turn.madeOf(null, {})).toBe(words.CHECK.made);
  });
});

describe("the check card", () => {
  it("keeps the link card without an item or an own run, and for the split and final cards", () => {
    const watched = run("c1", "approval");
    (watched.next as any).watched = true;
    const p = page(watched).draw([]);
    expect(p.all("a").filter((a) => a.attrs.href !== "#/home")).toHaveLength(1);
    expect(p.all("button")).toHaveLength(0);
    const split = page(run("c2", "approve_split")).draw([item("c2", { kind: "approve_split" })]);
    expect(btn(split, words.CHECK.yes)).toBeUndefined();
    const fin = page(run("c3", "approval", {}, { final: true })).draw([]);
    expect(btn(fin, words.FINAL.yes)).toBeTruthy();
  });

  it("loads the detail, shows the paragraph and approves through Your turn", async () => {
    const t = page(run("w1", "approval"), { turns: [item("w1")] });
    const p = t.draw();
    expect(p.textContent).toContain(words.CHECK.loading);
    await tick();
    expect(t.answer.detail).toHaveBeenCalledWith("m-w1");
    expect(p.textContent).toContain("Show the weather today.");
    expect(forbidden(p)).toEqual([]);
    expect(audit(p)).toEqual([]);
    btn(p, words.CHECK.yes)!.click();
    expect(btn(p, words.CHECK.yes)!.attrs.disabled).toBeDefined();
    await tick();
    expect(t.answer.act).toHaveBeenCalledWith({ key: "m-w1", action: "approve", stamp: "s1", digest: "d1" });
    expect(t.answer.done).toHaveBeenCalled();
    expect(p.textContent).toContain(words.CHECK.sent);
    expect(btn(p, words.CHECK.yes)).toBeUndefined();
  });

  it("needs text to reject, then rejects with it", async () => {
    const t = page(run("w2", "approve_plan"), { turns: [item("w2", { kind: "approve_plan" })] });
    const p = t.draw();
    await tick();
    btn(p, words.CHECK.send)!.click();
    await tick();
    expect(t.answer.act).not.toHaveBeenCalled();
    expect(p.textContent).toContain(words.CHECK.needsWhat);
    type(p.all("textarea")[0]!, "  ");
    btn(p, words.CHECK.send)!.click();
    expect(t.answer.act).not.toHaveBeenCalled();
    type(p.all("textarea")[0]!, "The colour is wrong");
    expect(turn.hasUnsentAnswers()).toBe(true);
    btn(p, words.CHECK.send)!.click();
    await tick();
    expect(t.answer.act).toHaveBeenCalledWith({ key: "m-w2", action: "reject", stamp: "s1", digest: "d1", text: "The colour is wrong" });
    expect(turn.hasUnsentAnswers()).toBe(false);
  });

  it("reloads on a 409 and keeps the text; another error frees the buttons", async () => {
    let n = 0;
    const actFn = vi.fn(async () => { n += 1; throw Object.assign(new Error("x"), { status: n === 1 ? 409 : 500 }); });
    const t = page(run("w3", "approval"), { turns: [item("w3")], actFn });
    const p = t.draw();
    await tick();
    type(p.all("textarea")[0]!, "Not good");
    btn(p, words.CHECK.send)!.click();
    await tick();
    expect(t.answer.detail).toHaveBeenCalledTimes(2);
    expect(p.textContent).toContain(words.CHECK.changed);
    expect(p.all("textarea")[0]!.value).toBe("Not good");
    btn(p, words.CHECK.yes)!.click();
    await tick();
    expect(p.textContent).toContain(words.CHECK.failed);
    expect(btn(p, words.CHECK.yes)!.attrs.disabled).toBeUndefined();
    expect(turn.hasUnsentAnswers()).toBe(true);
    expect(forbidden(p)).toEqual([]);
    expect(p.textContent).not.toContain("500");
  });

  it("offers a reload when the detail does not load", async () => {
    const t = page(run("w4", "approval"), { turns: [item("w4")] });
    t.answer.detail.mockRejectedValueOnce(new Error("no"));
    const p = t.draw();
    await tick();
    expect(p.textContent).toContain(words.CHECK.loadFailed);
    btn(p, words.CHECK.reload)!.click();
    await tick();
    expect(p.textContent).toContain("Show the weather today.");
  });

  it("stays sent when the item comes back unchanged, and resets for a new proposal", async () => {
    const t = page(run("w5", "approval"), { turns: [item("w5")] });
    const p = t.draw();
    await tick();
    btn(p, words.CHECK.yes)!.click();
    await tick();
    t.draw();
    await tick();
    const again = t.draw();
    expect(again.textContent).toContain(words.CHECK.sent);
    t.answer.detail.mockResolvedValue(detailOf({ stamp: "s2" }));
    const fresh = t.draw();
    await tick();
    expect(btn(fresh, words.CHECK.yes)).toBeTruthy();
  });

  it("decides an own run through the run calls", async () => {
    const t = page(run("o1", "approval"));
    const p = t.draw();
    await tick();
    expect(t.answer.detail).not.toHaveBeenCalled();
    type(p.all("textarea")[0]!, "Redo it");
    btn(p, words.CHECK.send)!.click();
    await tick();
    expect(t.answer.rejectRun).toHaveBeenCalledWith("o1", "Redo it");
    const t2 = page(run("o2", "approval"));
    const p2 = t2.draw();
    btn(p2, words.CHECK.yes)!.click();
    await tick();
    expect(t2.answer.approveRun).toHaveBeenCalledWith("o2", "");
    expect(t2.answer.act).not.toHaveBeenCalled();
    expect(t2.answer.done).toHaveBeenCalled();
  });

  it("shows Try it only when the page can", async () => {
    const tryIt = vi.fn();
    const a = page(run("y1", "approval"), { tryIt });
    const p = a.draw();
    btn(p, words.WORDS.actions.tryIt)!.click();
    expect(tryIt).toHaveBeenCalledWith("y1");
    expect(btn(page(run("y2", "approval")).draw(), words.WORDS.actions.tryIt)).toBeUndefined();
  });
});

describe("the stuck card", () => {
  const failed = (id: string, over: any = {}) => run(id, "failed", { status: "failed", state: { next: "implement" }, finishedAt: "t1", ...over }, { reason: "Error: ENOENT step implement" });

  it("shows only the fixed sentence and never the reason", () => {
    const p = page(failed("s1")).draw();
    expect(p.textContent).toContain(words.STUCK.line);
    expect(p.textContent).not.toContain("ENOENT");
    expect(p.textContent).not.toContain("implement");
    expect(forbidden(p)).toEqual([]);
    expect(audit(p)).toEqual([]);
  });

  it("tries again through Your turn, or through resume, and asks for help", async () => {
    const t = page(failed("s2"), { turns: [{ key: "m-s2", kind: "failed", runId: "s2", acts: ["retry"] }] });
    const p = t.draw();
    btn(p, words.STUCK.again)!.click();
    await tick();
    expect(t.answer.act).toHaveBeenCalledWith({ key: "m-s2", action: "retry" });
    expect(t.answer.done).toHaveBeenCalled();
    btn(p, words.STUCK.help)!.click();
    expect(t.answer.help).toHaveBeenCalled();
    const r = page(failed("s3"));
    btn(r.draw(), words.STUCK.again)!.click();
    await tick();
    expect(r.answer.resumeRun).toHaveBeenCalledWith("s3");
  });

  it("offers only help when it cannot be tried again", () => {
    const w = failed("s4", { state: {} });
    const p = page(w).draw();
    expect(btn(p, words.STUCK.again)).toBeUndefined();
    expect(btn(p, words.STUCK.help)).toBeTruthy();
  });

  it("says the fixed failure sentence and frees the button", async () => {
    const t = page(failed("s5"));
    t.answer.resumeRun.mockRejectedValueOnce(new Error("ENOENT secret"));
    const p = t.draw();
    btn(p, words.STUCK.again)!.click();
    await tick();
    expect(p.textContent).toContain(words.STUCK.failed);
    expect(p.textContent).not.toContain("secret");
    expect(btn(p, words.STUCK.again)!.attrs.disabled).toBeUndefined();
  });

  it("offers Try again again when the same run fails a second time", async () => {
    const first = page(failed("s6"));
    btn(first.draw(), words.STUCK.again)!.click();
    await tick();
    expect(btn(first.draw(), words.STUCK.again)).toBeUndefined();
    const second = page(failed("s6", { finishedAt: "t2" }));
    expect(btn(second.draw(), words.STUCK.again)).toBeTruthy();
  });
});

describe("the words", () => {
  it("are free of forbidden terms", () => {
    for (const v of [...Object.values(words.CHECK), ...Object.values(words.STUCK)]) expect(words.forbiddenIn(String(v))).toEqual([]);
  });
});

describe("the project page", () => {
  const a = (r: any, over: any = {}) => ({
    repos: async () => [repo], runs: async () => [r], queue: async () => ({ pending: [] }), myTurn: async () => ({ items: [] }),
    preview: async () => ({ status: "idle" }), startPreview: vi.fn(async () => ({ status: "starting" })), stopPreview: vi.fn(), turnDetail: vi.fn(), actTurn: vi.fn(),
    approveRun: vi.fn(), rejectRun: vi.fn(), resumeRun: vi.fn(), ...over,
  });

  it("starts Try it for the run on this computer only, and Ask for help goes to Help without a drawer", async () => {
    const main = new FakeElement("div");
    const api = a(run("pg1", "approval"));
    const off = await view.renderSimpleProject(main, { id: "r1", a: api, host: "127.0.0.1" });
    btn(main, words.CHECK.yes);
    const tryBtn = main.all("button").find((b) => b.attrs["data-focus"] === "simple-check-try-pg1")!;
    tryBtn.click();
    await tick();
    expect(api.startPreview).toHaveBeenCalledWith("r1", "checking", "pg1");
    off();
    const remote = new FakeElement("div");
    const off2 = await view.renderSimpleProject(remote, { id: "r1", a: a(run("pg2", "approval")), host: "example.org" });
    expect(remote.all("button").find((b) => b.attrs["data-focus"] === "simple-check-try-pg2")).toBeUndefined();
    off2();

    const stuck = new FakeElement("div");
    const off3 = await view.renderSimpleProject(stuck, { id: "r1", a: a(run("pg3", "failed", { status: "failed" })), host: "example.org" });
    (globalThis as any).location = (globalThis as any).location ?? { hash: "" };
    stuck.all("button").find((b) => b.textContent === words.STUCK.help)!.click();
    expect((globalThis as any).location.hash).toBe("#/help");
    off3();
  });
});
