import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let entry: any;
let composer: any;
let start: any;
let draft: any;
let words: any;
beforeAll(async () => {
  restore = installFakeDom();
  entry = await import("../ui/user/start-entry.js" as string);
  composer = await import("../ui/composer.js" as string);
  start = await import("../ui/user/start.js" as string);
  draft = await import("../ui/user/start-draft.js" as string);
  words = await import("../ui/simple-words.js" as string);
});
afterAll(() => restore());

const flush = () => new Promise((r) => setTimeout(r, 0));
const find = (root: FakeElement, tag: string, attrs: Record<string, string> = {}) =>
  root.all(tag).filter((el) => Object.entries(attrs).every(([k, v]) => el.attrs[k] === v));
const one = (root: FakeElement, tag: string, attrs: Record<string, string> = {}) => {
  const [el] = find(root, tag, attrs);
  if (!el) throw new Error(`no ${tag} ${JSON.stringify(attrs)}`);
  return el;
};

const gh = { id: "r1", name: "acme/app", github: "acme/app" };
const local = { id: "l1", name: "mine", github: "" };

describe("planRepos and pickPlanRepo", () => {
  it("keeps GitHub and local records, drops others, keeps the order", () => {
    const list = entry.planRepos([
      { id: "1", github: "o/a" },
      { id: "2", url: "x" },
      { id: "3", localName: "mine" },
      null,
      { id: "4", github: "o/b", localName: "ignored" },
    ]);
    expect(list).toEqual([
      { id: "1", name: "o/a", github: "o/a" },
      { id: "3", name: "mine", github: "" },
      { id: "4", name: "o/b", github: "o/b" },
    ]);
    expect(entry.planRepos(undefined)).toEqual([]);
  });

  it("matches any case, falls back to the first and gives null for none", () => {
    const list = entry.planRepos([{ id: "1", github: "o/a" }, { id: "2", github: "o/b" }]);
    expect(entry.pickPlanRepo(list, "O/B").id).toBe("2");
    expect(entry.pickPlanRepo(list, "no/such").id).toBe("1");
    expect(entry.pickPlanRepo(list, "").id).toBe("1");
    expect(entry.pickPlanRepo([], "o/a")).toBeNull();
  });
});

describe("planProblem, planRequest and planTarget", () => {
  it("checks the text for an idea, in order", () => {
    expect(entry.planProblem({ kind: "idea", text: "   ", repo: gh })).toBe(entry.NEED_TEXT);
    expect(entry.planProblem({ kind: "idea", text: "x".repeat(10_001), repo: gh })).toContain("10001");
    expect(entry.planProblem({ kind: "idea", text: "x".repeat(10_000), repo: gh })).toBe("");
    expect(entry.planProblem({ kind: "idea", text: "ok", repo: null })).toBe(entry.NO_PLAN_REPO);
  });

  it("wants an issue number for an existing change, and a GitHub repository", () => {
    for (const text of ["abc", "#0", "", "1.5", "#"]) expect(entry.planProblem({ kind: "issue", text, repo: gh }), text).toBe(entry.NEED_ISSUE_NUMBER);
    for (const text of ["#12", "12", " 12 "]) expect(entry.planProblem({ kind: "issue", text, repo: gh }), text).toBe("");
    expect(entry.planProblem({ kind: "issue", text: "#12", repo: null })).toBe(entry.NO_PLAN_REPO);
    expect(entry.planProblem({ kind: "issue", text: "#12", repo: local })).toBe(entry.NEEDS_GITHUB);
    // a local project is fine for an idea
    expect(entry.planProblem({ kind: "idea", text: "x", repo: local })).toBe("");
  });

  it("builds the exact call and the page it opens", () => {
    expect(entry.planRequest({ kind: "idea", text: "  Do it ", repo: local })).toEqual({ call: "createChange", body: { repo: "mine", text: "Do it" } });
    expect(entry.planRequest({ kind: "issue", text: "#12", repo: gh })).toEqual({ call: "createRefinement", body: { repo: "acme/app", issue: 12 } });
    expect(entry.planTarget("idea", { id: "a b" }, {})).toBe("#/change/a%20b");
    expect(entry.planTarget("issue", gh, { id: "s/1" })).toBe("#/refinement/s%2F1");
  });

  it("reads the session of a 409 as a string id, and nothing else", () => {
    expect(entry.existingSession({ status: 409, data: { session: "abc" } })).toBe("abc");
    expect(entry.existingSession({ status: 409, data: { session: { id: "abc" } } })).toBe("");
    expect(entry.existingSession({ status: 409, data: {} })).toBe("");
    expect(entry.existingSession({ status: 500, data: { session: "abc" } })).toBe("");
    expect(entry.existingSession(undefined)).toBe("");
  });
});

describe("openSessions", () => {
  it("drops dropped, published and not-mine sessions and sorts the newest first", () => {
    const out = entry.openSessions({
      sessions: [
        { id: "a", state: "open", updated: "2026-01-01T00:00:00Z" },
        { id: "b", state: "open", updated: "2026-03-01T00:00:00Z", mine: true },
        { id: "c", state: "dropped", updated: "2026-04-01T00:00:00Z" },
        { id: "d", state: "published", updated: "2026-04-01T00:00:00Z" },
        { id: "e", state: "open", updated: "2026-05-01T00:00:00Z", mine: false },
      ],
    });
    expect(out.map((s: any) => s.id)).toEqual(["b", "a"]);
    expect(entry.openSessions(null)).toEqual([]);
  });
});

describe("restoreDraft keeps the starting point", () => {
  it("copies kind and repo through the draft store", () => {
    draft.writeDraft({ flow: "", task: "t", kind: "issue", repo: "o/r", values: {} });
    expect(draft.readDraft()).toMatchObject({ flow: "", kind: "issue", repo: "o/r" });
    draft.clearDraft();
  });
});

describe("composerBox and advancedBox", () => {
  it("makes a labelled box; Ctrl+Enter and Meta+Enter submit, plain Enter does not", () => {
    const onSubmit = vi.fn();
    const c = composer.composerBox({ id: "t", onSubmit, hint: "A hint" });
    expect(c.field.textContent).toContain(composer.COMPOSER.what);
    expect(c.field.textContent).toContain("A hint");
    expect(c.box.attrs.id).toBe("t");
    const key = (mods: object) => c.box.fire("keydown", { key: "Enter", preventDefault() {}, ...mods });
    key({});
    key({ shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    key({ ctrlKey: true });
    key({ metaKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("keeps the value, and tells input", () => {
    const onInput = vi.fn();
    const c = composer.composerBox({ value: "kept", onInput });
    expect(c.box.value).toBe("kept");
    c.box.fire("input");
    expect(onInput).toHaveBeenCalledTimes(1);
  });

  it("starts closed, with a summary, and tells a toggle", () => {
    const onToggle = vi.fn();
    const adv = composer.advancedBox(document.createElement("div"), { onToggle });
    expect(adv.tag).toBe("details");
    expect(adv.attrs.open).toBeUndefined();
    expect(one(adv, "summary").textContent).toBe("Advanced");
    adv.fire("toggle", { target: { open: true } });
    expect(onToggle).toHaveBeenCalledWith(true);
    expect(composer.advancedBox(document.createElement("div"), { open: true }).attrs.open).toBe("");
  });
});

describe("renderStart in Simple", () => {
  let main: FakeElement;
  let go: ReturnType<typeof vi.fn>;
  let calls: { flows: number; created: any[] };
  let repos: any[];
  let failRepos: Error | null;
  let failCreate: Error | null;
  beforeEach(() => {
    draft.clearDraft();
    go = vi.fn();
    calls = { flows: 0, created: [] };
    repos = [{ id: "r1", github: "acme/app" }];
    failRepos = null;
    failCreate = null;
    (document as any).activeElement = null;
  });
  const api = () => ({
    flows: async () => { calls.flows++; return []; },
    repos: async () => { if (failRepos) throw failRepos; return repos; },
    createChange: async (body: unknown) => { calls.created.push(body); if (failCreate) throw failCreate; return { id: "c1" }; },
    changes: async () => { throw new Error("no answer"); },
    refinement: async () => ({ sessions: [] }),
  });
  const open = async () => {
    main = document.createElement("div") as unknown as FakeElement;
    return (await start.renderStart(main, { a: api(), go, simple: true, dialog: async () => undefined })) as () => void;
  };
  const type = (text: string) => {
    const box = one(main, "textarea", { name: "task" });
    box.value = text;
    box.fire("input");
  };
  const plan = async () => {
    one(main, "form").fire("submit", { preventDefault() {} });
    await flush();
  };

  it("shows the composer with only a new idea: no starting points, no Advanced, no flows asked for", async () => {
    await open();
    expect(find(main, "input", { name: "start-point" })).toHaveLength(0);
    expect(find(main, "details")).toHaveLength(0);
    expect(calls.flows).toBe(0);
    expect(one(main, "label", { class: "field composer" }).textContent).toContain("What would you like to change?");
    expect(main.textContent).toContain("In app");
    expect(words.forbiddenIn(main.textContent)).toEqual([]);
    type("Add a footer");
    await plan();
    expect(calls.created).toEqual([{ repo: "acme/app", text: "Add a footer" }]);
    expect(go).toHaveBeenCalledWith("#/change/r1");
  });

  it("offers a Project choice with two projects, and none with one", async () => {
    repos = [{ id: "r1", github: "acme/app" }, { id: "r2", github: "acme/shop" }];
    await open();
    const label = one(main, "label", { class: "field" });
    expect(label.textContent).toContain("Project");
    expect(one(main, "select", { name: "plan_repo" }).all("option").map((o) => o.textContent)).toEqual(["app", "shop"]);
    expect(words.forbiddenIn(main.textContent)).toEqual([]);
  });

  it("says to add a project, in project words, only after the button is pressed", async () => {
    repos = [];
    await open();
    expect(main.textContent).not.toContain(entry.NO_PLAN_PROJECT);
    type("An idea");
    await plan();
    expect(main.textContent).toContain(entry.NO_PLAN_PROJECT);
    expect(one(main, "a", { href: "#/home" })).toBeDefined();
    expect(words.forbiddenIn(main.textContent)).toEqual([]);
    expect(calls.created).toHaveLength(0);
  });

  it("uses fixed plain words when the projects cannot be loaded, whatever the server says", async () => {
    failRepos = Object.assign(new Error("the repository list is broken, run issue #4"), { status: 500 });
    await open();
    expect(main.textContent).toContain("Your projects could not be loaded.");
    expect(main.textContent).not.toContain("broken");
    expect(words.forbiddenIn(main.textContent)).toEqual([]);
    expect(one(main, "button", { "data-focus": "retry-repos" })).toBeDefined();
  });

  it("uses fixed plain words when the plan is refused, and keeps the text", async () => {
    failCreate = Object.assign(new Error("repository has no run, issue #4 failed"), { status: 400 });
    await open();
    type("Keep this");
    await plan();
    expect(one(main, "div", { role: "alert" }).textContent).toContain("The plan could not be started.");
    expect(main.textContent).not.toContain("issue #4");
    expect(words.forbiddenIn(main.textContent)).toEqual([]);
    expect(one(main, "textarea", { name: "task" }).value).toBe("Keep this");
    expect(draft.readDraft()?.task).toBe("Keep this");
  });

  it("uses fixed plain words when it cannot be told if the plan was saved", async () => {
    failCreate = Object.assign(new Error("repository down"), { status: 503 });
    await open();
    type("Maybe");
    await plan();
    expect(main.textContent).toContain("may have been started");
    expect(words.forbiddenIn(main.textContent)).toEqual([]);
    expect(calls.created).toHaveLength(1);
    await plan(); // reads again first: it still cannot be told, so nothing new is sent
    expect(calls.created).toHaveLength(1);
  });
});
