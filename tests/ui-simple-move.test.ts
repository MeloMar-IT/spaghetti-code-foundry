import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { audit } from "./helpers/a11y.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let words: any;
let sm: any;
let view: any;
let model: any;
beforeAll(async () => {
  restore = installFakeDom();
  words = await import("../ui/simple-words.js" as string);
  sm = await import("../ui/simple-move.js" as string);
  view = await import("../ui/simple.js" as string);
  model = await import("../ui/simple-model.js" as string);
});
afterAll(() => restore());

const walk = (el: FakeElement): FakeElement[] => el.children.flatMap((c) => (c instanceof FakeElement ? [c, ...walk(c)] : []));
const all = (root: FakeElement) => [root, ...walk(root)];
const box = (nodes: any[]) => {
  const root = new FakeElement("div");
  root.append(...nodes.filter(Boolean));
  return root;
};
const texts = (root: FakeElement) => all(root).flatMap((e) => [e.children.filter((c) => typeof c === "string").join(""), e.attrs["aria-label"] ?? "", e.attrs.title ?? ""]);
const tick = () => new Promise((r) => setTimeout(r, 0));
const until = async (fn: () => boolean) => {
  for (let i = 0; i < 200 && !fn(); i++) await tick();
  expect(fn()).toBe(true);
};
const btn = (root: FakeElement, label: string) => {
  const b = root.all("button").find((x) => x.textContent === label);
  expect(b, `button ${label}`).toBeDefined();
  return b!;
};
const has = (root: FakeElement, label: string) => root.all("button").some((x) => x.textContent === label);

const dry = (over: any = {}) => ({ dryRun: true, github: "o/app", repository: "create", refs: [], stories: { plan: [{ number: 1, title: "a", state: "open", status: "create" }, { number: 2, title: "b", state: "open", status: "create" }, { number: 3, title: "c", state: "open", status: "already-moved", githubIssue: 4 }], created: [], done: [] }, ...over });
const real = { dryRun: false, github: "o/app", repoId: "new1", repository: "created", refs: [], stories: { plan: [], created: [], done: [] } };
const ctl = (a: any, kind = "token", name = "app") => {
  const c = sm.moveController({ id: "l1", a });
  c.setContext({ kind, name });
  return c;
};
const root = (c: any) => c.node as FakeElement;

describe("the words", () => {
  it("have no forbidden term, also with names that contain one", () => {
    const strings: string[] = [words.WORDS.actions.github];
    for (const [k, v] of Object.entries(words.GITHUB)) {
      if (typeof v === "string") strings.push(v);
      else for (const arg of k === "willCreate" || k === "willUse" ? ["o/app", "o/issues", "o/tokens", "o/a-story"] : [0, 1, 3]) strings.push((v as any)(arg));
    }
    for (const s of strings) expect(words.forbiddenIn(s), s).toEqual([]);
    expect(words.forbiddenIn("token")).not.toEqual([]);
    expect(words.GITHUB.willCreate("o/issues")).not.toContain("issues");
    expect(words.GITHUB.willUse("o/app")).toContain("o/app");
  });
});

describe("hasGithubSignIn and simplePlan", () => {
  it("needs a token record with a name; an App-only list is told apart", () => {
    expect(sm.hasGithubSignIn([{ method: "github-token", github: "o/a" }])).toBe(true);
    expect(sm.hasGithubSignIn([])).toBe(false);
    expect(sm.hasGithubSignIn([{ method: "github-app", github: "o/a" }])).toBe(false);
    expect(sm.hasGithubSignIn([{ method: "github-token" }])).toBe(false);
    expect(sm.hasGithubSignIn(undefined)).toBe(false);
    expect(sm.githubSignInKind([{ method: "github-app", github: "o/a" }])).toBe("app");
    expect(sm.githubSignInKind([{ method: "github-app", github: "o/a" }, { method: "github-token", github: "o/b" }])).toBe("token");
    expect(sm.githubSignInKind(undefined)).toBe("none");
  });

  it("counts the plan", () => {
    const plan = [{ status: "create" }, { status: "already-moved" }, { status: "unreadable" }, { status: "too-large" }, { status: "create" }];
    expect(sm.simplePlan({ repository: "create", github: "o/a", stories: { plan } })).toEqual({ create: true, github: "o/a", changes: 2, already: 1, blocked: 2 });
    expect(sm.simplePlan({ repository: "exists", stories: { plan: [] } }).create).toBe(false);
  });
});

describe("the view", () => {
  it("is plain in every phase: no forbidden term, accessible, no field for a secret", () => {
    const plan = { create: false, github: "o/issues", changes: 2, already: 1, blocked: 1 };
    for (const phase of ["idle", "connect", "name", "checking", "confirm", "moving", "done", "failed", "stopped"]) {
      for (const kind of ["token", "app"]) {
        const r = box(sm.githubMoveView({ phase, kind, name: "app", private: true, withDone: false, problem: true, plan, repoId: "new1", github: "o/app" }));
        for (const t of texts(r)) expect(words.forbiddenIn(t), `${phase}: ${t}`).toEqual([]);
        expect(audit(r), phase).toEqual([]);
        const inputs = r.all("input");
        expect(inputs.some((i) => i.attrs.type === "password")).toBe(false);
        expect(inputs.map((i) => i.attrs.type)).toEqual(phase === "name" || phase === "checking" ? ["text", "checkbox", "checkbox"] : []);
      }
    }
  });

  it("links the new project and GitHub only for a fine name", () => {
    const r = box(sm.githubMoveView({ phase: "done", repoId: "new 1", github: "o/app" }));
    expect(r.all("a").map((a) => a.attrs.href)).toEqual(["#/repos/new%201", "https://github.com/o/app"]);
    const bad = box(sm.githubMoveView({ phase: "done", repoId: "n", github: "x\" onclick=\"y" }));
    expect(bad.all("a")).toHaveLength(1);
  });
});

describe("the controller", () => {
  it("says how to connect and calls nothing without a sign-in", () => {
    const a = { moveToGithub: vi.fn() };
    const c = ctl(a, "none");
    btn(root(c), words.WORDS.actions.github).click();
    expect(root(c).textContent).toContain(words.GITHUB.connect);
    expect(a.moveToGithub).not.toHaveBeenCalled();
    btn(root(c), "Not now").click();
    expect(has(root(c), words.WORDS.actions.github)).toBe(true);
  });

  it("tells an App-only account the way to an existing project", () => {
    const c = ctl({ moveToGithub: vi.fn() }, "app");
    btn(root(c), words.WORDS.actions.github).click();
    expect(root(c).textContent).toContain(words.GITHUB.connectApp);
    expect(root(c).textContent).not.toContain(words.GITHUB.connect);
  });

  it("goes name → check → put it on GitHub → done", async () => {
    const a = { moveToGithub: vi.fn(async (_i: string, b: any) => (b.dryRun ? dry() : real)) };
    const c = ctl(a, "token", "my app");
    btn(root(c), words.WORDS.actions.github).click();
    const input = root(c).all("input")[0]!;
    expect(input.value).toBe("my-app");
    btn(root(c), "Next").click();
    await until(() => root(c).textContent.includes("Step 2 of 2"));
    expect(a.moveToGithub).toHaveBeenCalledWith("l1", { target: { create: { name: "my-app", private: true } }, includeClosed: false, dryRun: true });
    const t = root(c).textContent;
    expect(t).toContain(words.GITHUB.willCreate("o/app"));
    expect(t).toContain("2 changes go along.");
    expect(t).toContain("1 change is on GitHub already.");
    btn(root(c), "Put it on GitHub").click();
    btn(root(c), "Put it on GitHub").click();
    await until(() => root(c).textContent.includes(words.GITHUB.done));
    expect(a.moveToGithub.mock.calls.filter((x) => !x[1].dryRun)).toHaveLength(1);
    expect(a.moveToGithub).toHaveBeenLastCalledWith("l1", { target: { create: { name: "my-app", private: true } }, includeClosed: false, dryRun: false });
    expect(root(c).all("a").map((x) => x.attrs.href)).toEqual(["#/repos/new1", "https://github.com/o/app"]);
    expect(c.isDone()).toBe(true);
  });

  it("refuses a bad name without a call, and sends the ticked options", async () => {
    const a = { moveToGithub: vi.fn(async () => dry()) };
    const c = ctl(a);
    btn(root(c), words.WORDS.actions.github).click();
    const [name, priv, done] = root(c).all("input") as FakeElement[];
    name!.value = "a b";
    name!.fire("input");
    btn(root(c), "Next").click();
    expect(root(c).textContent).toContain(words.GITHUB.nameProblem);
    expect(a.moveToGithub).not.toHaveBeenCalled();
    expect(done).toBeDefined();
    const [name2, priv2, done2] = root(c).all("input") as FakeElement[]; // the step was drawn again
    name2!.value = "app";
    name2!.fire("input");
    priv2!.checked = false;
    priv2!.fire("change");
    done2!.checked = true;
    done2!.fire("change");
    expect(priv).toBeDefined();
    btn(root(c), "Next").click();
    await until(() => a.moveToGithub.mock.calls.length === 1);
    expect(a.moveToGithub).toHaveBeenCalledWith("l1", { target: { create: { name: "app", private: false } }, includeClosed: true, dryRun: true });
  });

  it("sends one call for two clicks on Next", async () => {
    const a = { moveToGithub: vi.fn(async () => dry()) };
    const c = ctl(a);
    btn(root(c), words.WORDS.actions.github).click();
    const next = btn(root(c), "Next");
    next.click();
    next.click();
    await until(() => root(c).textContent.includes("Step 2 of 2"));
    expect(a.moveToGithub).toHaveBeenCalledTimes(1);
  });

  it("keeps an existing place's own setting in plain words, and hides the button for a blocked change", async () => {
    const exists = dry({ repository: "exists" });
    const c = ctl({ moveToGithub: vi.fn(async () => exists) });
    btn(root(c), words.WORDS.actions.github).click();
    btn(root(c), "Next").click();
    await until(() => root(c).textContent.includes("Step 2 of 2"));
    expect(root(c).textContent).toContain(words.GITHUB.willUse("o/app"));
    expect(root(c).textContent).toContain(words.GITHUB.keepsSeeing);
    const blocked = dry({ stories: { plan: [{ number: 1, title: "x", state: "unknown", status: "unreadable", reason: "r" }] } });
    const d = ctl({ moveToGithub: vi.fn(async () => blocked) });
    btn(root(d), words.WORDS.actions.github).click();
    btn(root(d), "Next").click();
    await until(() => root(d).textContent.includes("Step 2 of 2"));
    expect(has(root(d), "Put it on GitHub")).toBe(false);
    expect(root(d).textContent).toContain("1 change cannot go along");
  });

  it("sends 'connect GitHub first' to the connect text", async () => {
    const c = ctl({ moveToGithub: vi.fn(async () => { throw new Error("connect GitHub first: add a GitHub repository with a token"); }) });
    btn(root(c), words.WORDS.actions.github).click();
    btn(root(c), "Next").click();
    await until(() => root(c).textContent.includes(words.GITHUB.connect));
    expect(root(c).textContent).not.toContain("token");
  });

  it("does not show the server's text; a failed check can be tried again", async () => {
    const c = ctl({ moveToGithub: vi.fn(async () => { throw new Error("boom: secret reason about branch main"); }) });
    btn(root(c), words.WORDS.actions.github).click();
    btn(root(c), "Next").click();
    await until(() => root(c).textContent.includes(words.GITHUB.failed));
    expect(root(c).textContent).not.toContain("boom");
    btn(root(c), "Try again").click();
    expect(root(c).textContent).toContain("Step 1 of 2");
  });

  it("does not offer a retry after a failed move, and tells what to do", async () => {
    const a = { moveToGithub: vi.fn(async (_i: string, b: any) => { if (b.dryRun) return dry(); throw new Error("story #1 was created as issue #9"); }) };
    const c = ctl(a);
    btn(root(c), words.WORDS.actions.github).click();
    btn(root(c), "Next").click();
    await until(() => has(root(c), "Put it on GitHub"));
    btn(root(c), "Put it on GitHub").click();
    await until(() => root(c).textContent.includes(words.GITHUB.stopped));
    expect(has(root(c), "Try again")).toBe(false);
    expect(has(root(c), "Put it on GitHub")).toBe(false);
    expect(root(c).textContent).not.toContain("#9");
    // stopped is kept on the page too, so the recovery text survives a poll that drops the local record
    expect(c.keepsPage()).toBe(true);
  });

  it("drops an answer after stop()", async () => {
    let release!: (v: any) => void;
    const a = { moveToGithub: vi.fn(() => new Promise((r) => { release = r; })) };
    const c = ctl(a);
    btn(root(c), words.WORDS.actions.github).click();
    btn(root(c), "Next").click();
    await tick();
    c.stop();
    release(dry());
    await tick();
    expect(root(c).textContent).not.toContain("Step 2 of 2");
  });
});

describe("the project page", () => {
  const localRepo = { id: "l1", url: "/home/me/app", method: "local", localName: "local:app-1" };
  const tokenRepo = { id: "g9", url: "https://github.com/o/z", method: "github-token", github: "o/z" };
  const open = async (o: { admin?: boolean; repos?: any[]; move?: any } = {}) => {
    let list = o.repos ?? [localRepo, tokenRepo];
    const a: any = {
      repos: vi.fn(async () => list), runs: vi.fn(async () => []), queue: vi.fn(async () => ({ active: [], pending: [] })), run: vi.fn(),
      preview: vi.fn(async () => ({ state: "stopped" })),
      moveToGithub: o.move ?? vi.fn(async (_i: string, b: any) => (b.dryRun ? dry() : real)),
    };
    const main = new FakeElement("div");
    const off = await view.renderSimpleProject(main, { id: "l1", a, admin: o.admin ?? true, host: "elsewhere.example" });
    // a new poll, as a tab that becomes visible again starts one
    const poll = async () => {
      const n = a.repos.mock.calls.length;
      for (const fn of (document as any).listeners.visibilitychange ?? []) fn({});
      await until(() => a.repos.mock.calls.length > n);
      await tick();
    };
    return { a, main, off, poll, set: (l: any[]) => { list = l; } };
  };

  it("sets `local` on the project model only for a local record", () => {
    expect(model.projectsModel([localRepo, tokenRepo], [], []).map((p: any) => p.local)).toEqual([true, false]);
  });

  it("shows the action to an admin for a local project only", async () => {
    const yes = await open();
    expect(has(yes.main, "Put this project on GitHub")).toBe(true);
    yes.off();
    const user = await open({ admin: false });
    expect(has(user.main, "Put this project on GitHub")).toBe(false);
    user.off();
    const github = await open({ repos: [{ id: "l1", url: "https://github.com/o/app", method: "github-token", github: "o/app" }] });
    expect(has(github.main, "Put this project on GitHub")).toBe(false);
    github.off();
  });

  it("without a token sign-in it says how to connect and calls nothing", async () => {
    const p = await open({ repos: [localRepo] });
    btn(p.main, "Put this project on GitHub").click();
    expect(p.main.textContent).toContain(words.GITHUB.connect);
    expect(p.a.moveToGithub).not.toHaveBeenCalled();
    expect(p.main.all("input").some((i) => i.attrs.type === "password")).toBe(false);
    p.off();
  });

  it("keeps the done screen when the project is gone from the list", async () => {
    const p = await open();
    btn(p.main, "Put this project on GitHub").click();
    btn(p.main, "Next").click();
    await until(() => has(p.main, "Put it on GitHub"));
    btn(p.main, "Put it on GitHub").click();
    await until(() => p.main.textContent.includes(words.GITHUB.done));
    p.set([{ id: "new1", url: "https://github.com/o/app", method: "github-token", github: "o/app" }, tokenRepo]);
    await p.poll();
    expect(p.main.textContent).not.toContain("This project is not in your list.");
    expect(p.main.all("a").map((a) => a.attrs.href)).toContain("#/repos/new1");
    p.off();
  });

  it("keeps the box when the list drops the project before the move answer arrives", async () => {
    let release!: (v: any) => void;
    const move = vi.fn((_i: string, b: any) => (b.dryRun ? Promise.resolve(dry()) : new Promise((r) => { release = r; })));
    const p = await open({ move });
    btn(p.main, "Put this project on GitHub").click();
    btn(p.main, "Next").click();
    await until(() => has(p.main, "Put it on GitHub"));
    btn(p.main, "Put it on GitHub").click();
    await until(() => p.main.textContent.includes("Putting your project on GitHub…"));
    // the poll sees the removed record: the box (and its status) must stay on the page
    p.set([tokenRepo]);
    await p.poll();
    expect(p.main.textContent).not.toContain("This project is not in your list.");
    expect(p.main.textContent).toContain("Putting your project on GitHub…");
    release(real);
    await until(() => p.main.textContent.includes(words.GITHUB.done));
    p.off();
  });

  it("keeps the stopped text when a move answer is lost and the poll finds no local record", async () => {
    const move = vi.fn((_i: string, b: any) => (b.dryRun ? Promise.resolve(dry()) : Promise.reject(new Error("the server closed the connection"))));
    const p = await open({ move });
    btn(p.main, "Put this project on GitHub").click();
    btn(p.main, "Next").click();
    await until(() => has(p.main, "Put it on GitHub"));
    btn(p.main, "Put it on GitHub").click();
    await until(() => p.main.textContent.includes(words.GITHUB.stopped));
    // the server finished the move; the next poll no longer lists the local record
    p.set([tokenRepo]);
    await p.poll();
    expect(p.main.textContent).toContain(words.GITHUB.stopped);
    expect(p.main.textContent).not.toContain("This project is not in your list.");
    p.off();
  });

  it("still says a missing project is not in the list", async () => {
    const a: any = { repos: vi.fn(async () => [tokenRepo]), runs: vi.fn(async () => []), queue: vi.fn(async () => ({ active: [], pending: [] })), run: vi.fn() };
    const main = new FakeElement("div");
    (await view.renderSimpleProject(main, { id: "l1", a, admin: true, host: "elsewhere.example" }))();
    expect(main.textContent).toContain("This project is not in your list.");
  });
});
