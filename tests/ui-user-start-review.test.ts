import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";
import { readUiCss } from "./helpers/ui-css.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
let d: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/user/start.js" as string);
  d = await import("../ui/user/start-draft.js" as string);
});
afterAll(() => restore());

const field = (name: string, over: object = {}) => ({ name, mode: "input", label: name, value: "", required: false, ...over });
const flow = (name: string, fields: object[] = [], over: object = {}) => ({ name, title: `Title ${name}`, description: "", version: 1, usesTask: true, fields, ...over });
const repo = (id: string, github: string, connection?: { ok: boolean }) => ({ id, url: `https://github.com/${github}`, method: "none", owner: "u1", github, ...(connection ? { connection } : {}) });

const flush = () => new Promise((r) => setTimeout(r, 0));
const find = (root: FakeElement, tag: string, attrs: Record<string, string> = {}) =>
  root.all(tag).filter((el) => Object.entries(attrs).every(([k, v]) => el.attrs[k] === v));
const one = (root: FakeElement, tag: string, attrs: Record<string, string> = {}) => {
  const [el] = find(root, tag, attrs);
  if (!el) throw new Error(`no ${tag} ${JSON.stringify(attrs)}`);
  return el;
};
const review = async (root: FakeElement) => {
  one(root, "form").fire("submit", { preventDefault() {} });
  await flush();
};
const clickStart = async (root: FakeElement) => {
  one(root, "button", { "data-focus": "start-run" }).fire("click");
  await flush();
};

let main: FakeElement;
let calls: { start: any[] };
let go: ReturnType<typeof vi.fn>;
let data: { flows: any[]; repos: any[]; startFail?: unknown; hold?: boolean };
let release: () => void;

const fakeApi = () => ({
  flows: async () => data.flows,
  repos: async () => data.repos,
  repoMethods: async () => ({ methods: [] }),
  startRun: async (body: unknown) => {
    calls.start.push(body);
    if (data.hold) await new Promise<void>((r) => (release = r));
    if (data.startFail) throw data.startFail;
    return { runId: "r1", queued: true };
  },
});

async function open(opts: object = {}) {
  main = document.createElement("div") as unknown as FakeElement;
  return (await ui.renderStart(main, { a: fakeApi(), dialog: async () => undefined, go, ...opts })) as () => void;
}

beforeEach(() => {
  d.clearDraft();
  calls = { start: [] };
  go = vi.fn();
  data = { flows: [], repos: [] };
  (document as any).activeElement = null;
});

describe("reviewRows and safetyNotes", () => {
  const f = flow("a", [field("github_repo"), field("x"), field("fx", { mode: "fixed", value: "v", label: "Fixed one" })]);
  const body = (over: object = {}) => ({ flow: "a", task: "line 1\nline 2", vars: { github_repo: "o/n", x: "" }, ...over });

  it("lists flow, repository, task, inputs, then fixed values", () => {
    const rows = d.reviewRows(f, body(), []);
    expect(rows.map((r: any) => r.name)).toEqual(["flow", "github_repo", "task", "x", "fx"]);
    expect(rows[0].value).toBe("Title a");
    expect(rows[1]).toMatchObject({ value: "o/n", fixed: false });
    expect(rows[2].value).toBe("line 1\nline 2");
    expect(rows[3]).toMatchObject({ value: "", fixed: false });
    expect(rows[4]).toMatchObject({ label: "Fixed one", value: "v", fixed: true });
  });

  it("says No repository when none is sent or the flow has none", () => {
    expect(d.reviewRows(f, body({ vars: {} }), [])[1].value).toBe(d.NO_REPOSITORY);
    expect(d.reviewRows(flow("b"), { flow: "b", task: "t", vars: {} }, [])[1].value).toBe(d.NO_REPOSITORY);
  });

  it("shows a fixed repository as set by the flow and has no Task row without the task", () => {
    const g = flow("g", [field("github_repo", { mode: "fixed", value: "me/fixed" })], { usesTask: false });
    const rows = d.reviewRows(g, { flow: "g", task: "", vars: {} }, []);
    expect(rows[1]).toMatchObject({ value: "me/fixed", fixed: true });
    expect(rows.some((r: any) => r.name === "task")).toBe(false);
  });

  it("shows the admin setting in plain words", () => {
    const rows = d.reviewRows(f, body({ likeUser: true }), []);
    expect(rows[rows.length - 1]).toMatchObject({ label: "Start as", value: d.LIKE_USER_TEXT });
  });

  it("notes a failed or untested repository, an empty task, and always the fixed sentence last", () => {
    expect(d.safetyNotes(f, body(), [repo("1", "o/n", { ok: false })])).toEqual([d.NOTE_REPO_FAILED, d.NOTE_SERVER]);
    expect(d.safetyNotes(f, body(), [repo("1", "o/n")])).toEqual([d.NOTE_REPO_UNTESTED, d.NOTE_SERVER]);
    expect(d.safetyNotes(f, body(), [repo("1", "o/n", { ok: true })])).toEqual([d.NOTE_SERVER]);
    expect(d.safetyNotes(f, body({ task: "  " }), [repo("1", "o/n", { ok: true })])).toEqual([d.NOTE_TASK_EMPTY, d.NOTE_SERVER]);
    expect(d.safetyNotes(f, body({ task: "", vars: {} }), [])).toEqual([d.NOTE_TASK_EMPTY, d.NOTE_SERVER_NO_REPO]);
    expect(d.safetyNotes(flow("b", [], { usesTask: false }), { flow: "b", task: "", vars: {} }, [])).toEqual([d.NOTE_SERVER_NO_REPO]);
  });

  it("checks a fixed repository too", () => {
    const g = flow("g", [field("github_repo", { mode: "fixed", value: "me/fixed" })]);
    const v = { flow: "g", task: "t", vars: {} };
    expect(d.safetyNotes(g, v, [repo("1", "me/fixed", { ok: false })])).toEqual([d.NOTE_REPO_FAILED, d.NOTE_SERVER]);
    expect(d.safetyNotes(g, v, [repo("1", "me/fixed")])).toEqual([d.NOTE_REPO_UNTESTED, d.NOTE_SERVER]);
  });
});

describe("the draft store", () => {
  it("keeps copies and forgets on clear", () => {
    expect(d.readDraft()).toBeNull();
    d.writeDraft({ flow: "a", task: "t", values: { a: { x: "1" } } });
    const got = d.readDraft();
    got.values.a.x = "changed";
    expect(d.readDraft().values.a.x).toBe("1");
    d.clearDraft();
    expect(d.readDraft()).toBeNull();
  });

  it("restoreDraft: defaults, unknown flow, dropped and non-string values", () => {
    const flows = [flow("a", [field("x", { value: "dx" })]), flow("b", [field("y")])];
    expect(d.restoreDraft(flows, null)).toMatchObject({ task: "", restored: false, values: { a: { x: "dx" }, b: { y: "" } } });
    expect(d.restoreDraft(flows, null).flow).toBe(flows[0]);
    const r = d.restoreDraft(flows, { flow: "zzz", task: "kept", values: { a: { x: 5, gone: "q" }, b: { y: "yy", gone: "q" } } });
    expect(r.flow).toBe(flows[0]);
    expect(r.task).toBe("kept");
    expect(r.restored).toBe(true);
    expect(r.values).toEqual({ a: { x: "dx" }, b: { y: "yy" } });
  });
});

describe("renderStart: review", () => {
  it("opens the review without sending, with the heading focused", async () => {
    data.flows = [flow("a", [field("github_repo", { required: true }), field("fx", { mode: "fixed", value: "v" })])];
    data.repos = [repo("1", "o/n")];
    await open();
    expect(one(main, "button", { type: "submit" }).textContent).toBe("Review");
    one(main, "textarea").value = "do it";
    await review(main);
    expect(calls.start).toHaveLength(0);
    const h2 = one(main, "h2");
    expect(h2.textContent).toBe(d.REVIEW_TITLE);
    expect((document as any).activeElement).toBe(h2);
    expect(main.textContent).toContain("o/n");
    expect(main.textContent).toContain("do it");
    expect(main.textContent).toContain("Title a");
    expect(main.textContent).toContain(d.SET_BY_FLOW);
    expect(main.textContent).toContain(d.NOTE_REPO_UNTESTED);
  });

  it("shows today's problem and no review for an empty required field", async () => {
    data.flows = [flow("a", [field("x", { required: true, label: "X" })])];
    await open();
    await review(main);
    expect(find(main, "h2")).toHaveLength(0);
    expect(one(main, "p", { role: "alert" }).textContent).toBe('Fill in "X".');
  });

  it("Back returns the same form with every value in place", async () => {
    data.flows = [flow("a", [field("x", { required: true }), field("o")])];
    await open();
    const form = one(main, "form");
    one(main, "textarea").value = "task";
    one(main, "input", { name: "x" }).value = "vx";
    one(main, "input", { name: "o" }).value = "vo";
    await review(main);
    expect(find(main, "form")).toHaveLength(0);
    one(main, "button", { "data-focus": "start-back" }).fire("click");
    expect(one(main, "form")).toBe(form);
    expect(one(main, "textarea").value).toBe("task");
    expect(one(main, "input", { name: "x" }).value).toBe("vx");
    expect(one(main, "input", { name: "o" }).value).toBe("vo");
    expect((document as any).activeElement).toBe(one(main, "button", { type: "submit" }));
    expect(calls.start).toHaveLength(0);
  });

  it("sends once for two clicks, with the body shown, and then goes to the run", async () => {
    data.flows = [flow("a", [field("x")])];
    data.hold = true;
    await open();
    one(main, "textarea").value = "t";
    one(main, "input", { name: "x" }).value = "vx";
    await review(main);
    const startBtn = one(main, "button", { "data-focus": "start-run" });
    startBtn.fire("click");
    startBtn.fire("click");
    await flush();
    expect(calls.start).toEqual([{ flow: "a", task: "t", vars: { x: "vx" } }]);
    expect(startBtn.disabled).toBe(true);
    release();
    await flush();
    expect(go).toHaveBeenCalledWith("#/runs/r1");
  });

  it("sends the admin setting in the body that was shown", async () => {
    data.flows = [flow("a")];
    await open({ admin: true });
    await review(main);
    expect(main.textContent).toContain(d.LIKE_USER_TEXT);
    await clickStart(main);
    expect(calls.start).toEqual([{ flow: "a", task: "", vars: {}, likeUser: true }]);
  });

  it("returns to the form with the server's sentence and every value after a refusal", async () => {
    data.flows = [flow("a", [field("o")])];
    data.startFail = Object.assign(new Error("bad input"), { status: 400 });
    await open();
    one(main, "textarea").value = "t";
    one(main, "input", { name: "o" }).value = "vo";
    await review(main);
    await clickStart(main);
    expect(find(main, "h2").filter((h) => h.textContent === d.REVIEW_TITLE)).toHaveLength(0);
    expect(one(main, "div", { role: "alert" }).textContent).toContain("bad input");
    expect(one(main, "textarea").value).toBe("t");
    expect(one(main, "input", { name: "o" }).value).toBe("vo");
    expect(one(main, "button", { type: "submit" }).disabled).toBe(false);
    expect(one(main, "details").attrs.open).toBe("");
    expect(d.readDraft()).toBeNull();
    data.startFail = undefined;
    await review(main);
    await clickStart(main);
    expect(calls.start[1]).toEqual(calls.start[0]);
  });
});

describe("renderStart: the draft", () => {
  const two = () => [flow("a", [field("github_repo", { value: "a/a" }), field("x")]), flow("b", [field("github_repo", { value: "b/b" }), field("y")])];

  it("survives cleanup and a second renderStart, with the draft line", async () => {
    data.flows = two();
    data.repos = [repo("1", "a/a"), repo("2", "b/b"), repo("3", "c/c")];
    const cleanup = await open();
    find(main, "input", { name: "flow" })[1]!.fire("change");
    await flush();
    const sel = one(main, "select");
    sel.value = "c/c";
    sel.fire("change");
    const y = one(main, "input", { name: "y" });
    y.value = "vy";
    y.fire("input");
    const t = one(main, "textarea");
    t.value = "my task";
    t.fire("input");
    cleanup();
    await open();
    expect(main.textContent).toContain(d.DRAFT_LINE);
    expect((find(main, "input", { name: "flow" })[1] as any).checked).toBe(true);
    expect(one(main, "select").value).toBe("c/c");
    expect(one(main, "input", { name: "y" }).value).toBe("vy");
    expect(one(main, "textarea").value).toBe("my task");
  });

  it("keeps a draft when the page is left while the repositories still load", async () => {
    data.flows = two();
    let gate!: () => void;
    const a = { ...fakeApi(), repos: async () => { await new Promise<void>((r) => (gate = r)); return data.repos; } };
    data.repos = [repo("1", "a/a")];
    main = document.createElement("div") as unknown as FakeElement;
    const opening = ui.renderStart(main, { a, dialog: async () => undefined, go });
    await flush();
    const t = one(main, "textarea");
    t.value = "early";
    t.fire("input");
    expect(d.readDraft().task).toBe("early");
    gate();
    (await opening)();
  });

  it("shows no draft line when nothing was changed", async () => {
    data.flows = two();
    data.repos = [repo("1", "a/a")];
    (await open())();
    expect(d.readDraft()).toBeNull();
    await open();
    expect(main.textContent).not.toContain(d.DRAFT_LINE);
  });

  it("keeps a repository chosen through Add repository", async () => {
    data.flows = [flow("a", [field("github_repo")])];
    data.repos = [repo("1", "a/a")];
    const created = repo("2", "n/new");
    const dialog = vi.fn(async () => {
      data.repos = [repo("1", "a/a"), created];
      return created;
    });
    main = document.createElement("div") as unknown as FakeElement;
    const cleanup = await ui.renderStart(main, { a: fakeApi(), dialog, go });
    one(main, "button", { "data-focus": "add-repo" }).fire("click");
    await flush();
    await flush();
    expect(one(main, "select").value).toBe("n/new");
    cleanup();
    await open();
    expect(one(main, "select").value).toBe("n/new");
  });

  it("clears the draft after a successful start and does not bring it back", async () => {
    data.flows = two();
    data.repos = [repo("1", "a/a")];
    const cleanup = await open();
    const t = one(main, "textarea");
    t.value = "gone soon";
    t.fire("input");
    expect(d.readDraft()).not.toBeNull();
    await review(main);
    await clickStart(main);
    expect(d.readDraft()).toBeNull();
    cleanup();
    expect(d.readDraft()).toBeNull();
    await open();
    expect(one(main, "textarea").value).toBe("");
    expect(main.textContent).not.toContain(d.DRAFT_LINE);
  });

  it("a late success does not erase newer work of a later page", async () => {
    data.flows = two();
    data.repos = [repo("1", "a/a")];
    data.hold = true;
    const first = await open();
    const t = one(main, "textarea");
    t.value = "sent";
    t.fire("input");
    await review(main);
    await clickStart(main);
    first();
    await open();
    const t2 = one(main, "textarea");
    t2.value = "newer";
    t2.fire("input");
    release();
    await flush();
    expect(d.readDraft().task).toBe("newer");
  });

  it("a late success clears the draft that came back unchanged after leaving and returning", async () => {
    data.flows = two();
    data.repos = [repo("1", "a/a")];
    data.hold = true;
    const first = await open();
    const t = one(main, "textarea");
    t.value = "sent";
    t.fire("input");
    await review(main);
    await clickStart(main);
    first();
    await open();
    await review(main);
    expect(d.readDraft().task).toBe("sent");
    release();
    await flush();
    expect(d.readDraft()).toBeNull();
  });

  it("keeps the draft after a failed start", async () => {
    data.flows = [flow("a")];
    data.startFail = Object.assign(new Error("no"), { status: 400 });
    await open();
    const t = one(main, "textarea");
    t.value = "keep me";
    t.fire("input");
    await review(main);
    await clickStart(main);
    expect(d.readDraft().task).toBe("keep me");
  });

  it("Clear empties the form, the line, the alert and the draft", async () => {
    data.flows = two();
    data.repos = [repo("1", "a/a")];
    d.writeDraft({ flow: "b", task: "old", values: { b: { y: "yy" } } });
    await open();
    expect(main.textContent).toContain(d.DRAFT_LINE);
    const clear = find(main, "button").find((b) => b.textContent === "Clear")!;
    clear.fire("click");
    await flush();
    expect(d.readDraft()).toBeNull();
    expect(one(main, "textarea").value).toBe("");
    expect((find(main, "input", { name: "flow" })[0] as any).checked).toBe(true);
    expect(main.textContent).not.toContain(d.DRAFT_LINE);
    expect(find(main, "input", { name: "y" })).toHaveLength(0);
  });

  it("falls back for a stale flow (task kept) and a stale repository", async () => {
    data.flows = two();
    data.repos = [repo("1", "a/a"), repo("2", "b/b")];
    d.writeDraft({ flow: "gone", task: "kept text", values: {} });
    await open();
    expect((find(main, "input", { name: "flow" })[0] as any).checked).toBe(true);
    expect(one(main, "textarea").value).toBe("kept text");
    d.writeDraft({ flow: "b", task: "", values: { b: { github_repo: "gone/x" } } });
    await open();
    expect(one(main, "select").value).toBe("b/b");
    data.flows = [flow("b", [field("github_repo", { value: "unlisted/z" })])];
    await open();
    expect(one(main, "select").value).toBe("a/a");
  });

  it("readOnly neither reads nor writes the draft and has no Review, Clear or Start", async () => {
    data.flows = two();
    data.repos = [repo("1", "a/a")];
    d.writeDraft({ flow: "b", task: "mine", values: {} });
    const cleanup = await open({ readOnly: true });
    expect(main.textContent).not.toContain(d.DRAFT_LINE);
    expect(one(main, "textarea").value).toBe("");
    expect(find(main, "button").map((b) => b.textContent)).not.toContain("Review");
    expect(find(main, "button").map((b) => b.textContent)).not.toContain("Clear");
    const t = one(main, "textarea");
    t.value = "typed";
    t.fire("input");
    cleanup();
    expect(d.readDraft()).toEqual({ flow: "b", task: "mine", values: {} });
  });

  it("styles the review so long values wrap", () => {
    expect(readUiCss()).toMatch(/\.start-review dd \{[^}]*overflow-wrap: anywhere/);
  });
});
