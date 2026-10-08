import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";
import { readUiCss } from "./helpers/ui-css.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/user/start.js" as string);
});
afterAll(() => restore());

const field = (name: string, over: object = {}) => ({ name, mode: "input", label: name, value: "", required: false, ...over });
const flow = (name: string, fields: object[] = [], over: object = {}) => ({ name, title: `Title ${name}`, description: `About ${name}`, version: 1, usesTask: true, fields, ...over });
const repo = (id: string, github?: string, connection?: { ok: boolean }) => ({ id, url: `https://github.com/${github ?? "x/y"}`, method: "none", owner: "u1", ...(github ? { github } : {}), ...(connection ? { connection } : {}) });

const flush = () => new Promise((r) => setTimeout(r, 0));
const find = (root: FakeElement, tag: string, attrs: Record<string, string> = {}) =>
  root.all(tag).filter((el) => Object.entries(attrs).every(([k, v]) => el.attrs[k] === v));
const one = (root: FakeElement, tag: string, attrs: Record<string, string> = {}) => {
  const [el] = find(root, tag, attrs);
  if (!el) throw new Error(`no ${tag} ${JSON.stringify(attrs)}`);
  return el;
};
const alertText = (root: FakeElement) => one(root, "p", { role: "alert" }).textContent;
const submitBtn = (root: FakeElement) => one(root, "button", { type: "submit" });
const submit = async (root: FakeElement) => {
  one(root, "form").fire("submit", { preventDefault() {} });
  await flush();
};

let main: FakeElement;
let calls: any;
let go: ReturnType<typeof vi.fn>;
let dialog: ReturnType<typeof vi.fn>;
let data: { flows: any[]; repos: any[]; reposAfter?: any[]; reposFail?: boolean; startFail?: unknown; hold?: boolean; holdRepos?: boolean };
let release: () => void;
let releaseRepos: () => void;

const fakeApi = () => ({
  flows: async (p?: unknown) => {
    calls.flows.push(p);
    return data.flows;
  },
  repos: async () => {
    calls.repos++;
    if (data.holdRepos) await new Promise<void>((r) => (releaseRepos = r));
    if (data.reposFail) throw Object.assign(new Error("repo list broken"), { status: 500 });
    return calls.repos > 1 && data.reposAfter ? data.reposAfter : data.repos;
  },
  repoMethods: async () => ({ methods: ["github-token"], githubApp: { available: false } }),
  startRun: async (body: unknown) => {
    calls.start.push(body);
    if (data.hold) await new Promise<void>((r) => (release = r));
    if (data.startFail) throw data.startFail;
    return { runId: "r1", queued: true };
  },
});

async function open(admin?: boolean) {
  main = document.createElement("div") as unknown as FakeElement;
  const cleanup = await ui.renderStart(main, { a: fakeApi(), dialog, go, ...(admin === undefined ? {} : { admin }) });
  return cleanup as () => void;
}

beforeEach(() => {
  calls = { repos: 0, start: [], flows: [] };
  go = vi.fn();
  dialog = vi.fn(async () => undefined);
  data = { flows: [], repos: [] };
  (document as any).activeElement = null;
});

describe("renderStart: flows", () => {
  it("says so when there are no flows", async () => {
    await open();
    expect(main.textContent).toContain(ui.NO_FLOWS);
    expect(find(main, "form")).toHaveLength(0);
    expect(calls.start).toHaveLength(0);
  });

  it("lists flows as radios with title and description, the first chosen", async () => {
    data.flows = [flow("a"), flow("b")];
    await open();
    const radios = find(main, "input", { type: "radio", name: "flow" });
    expect(radios.map((r) => r.value)).toEqual(["a", "b"]);
    expect((radios[0] as any).checked).toBe(true);
    expect(main.textContent).toContain("Title b");
    expect(main.textContent).toContain("About b");
  });

  it("redraws the fields on a flow change and brings typed values back", async () => {
    data.flows = [flow("a", [field("x", { value: "dx" })]), flow("b", [field("y")])];
    await open();
    one(main, "input", { name: "x" }).value = "typed";
    one(main, "textarea", { name: "task" }).value = "my task";
    find(main, "input", { name: "flow" })[1]!.fire("change");
    await flush();
    expect(find(main, "input", { name: "x" })).toHaveLength(0);
    expect(find(main, "input", { name: "y" })).toHaveLength(1);
    expect(one(main, "textarea", { name: "task" }).value).toBe("my task");
    find(main, "input", { name: "flow" })[0]!.fire("change");
    await flush();
    expect(one(main, "input", { name: "x" }).value).toBe("typed");
  });

  it("keeps working when the repository list fails and the flow has no repository field", async () => {
    data.flows = [flow("a")];
    data.reposFail = true;
    await open();
    expect(calls.repos).toBe(0);
    await submit(main);
    expect(calls.start).toEqual([{ flow: "a", task: "", vars: {} }]);
  });
});

describe("renderStart: repository", () => {
  it("has no repository step without the field", async () => {
    data.flows = [flow("a", [field("x")])];
    await open();
    expect(find(main, "select")).toHaveLength(0);
    expect(find(main, "button", { "data-focus": "add-repo" })).toHaveLength(0);
  });

  it("offers only GitHub records, with their connection status, and preselects by value", async () => {
    data.flows = [flow("a", [field("github_repo", { value: "Acme/App" })])];
    data.repos = [repo("1", "other/one", { ok: true }), repo("2"), repo("3", "acme/app", { ok: false }), repo("4", "z/z")];
    await open();
    const sel = one(main, "select", { name: "github_repo" });
    const opts = find(sel, "option");
    expect(opts.map((o) => o.textContent)).toEqual(["other/one — Connected", "acme/app — Failed", "z/z — Not tested yet"]);
    expect(sel.value).toBe("acme/app");
    await submit(main);
    expect(calls.start[0].vars).toEqual({ github_repo: "acme/app" });
  });

  it("keeps the repository choice of each flow apart, starting from each flow's default", async () => {
    data.flows = [flow("a", [field("github_repo", { value: "a/a" })]), flow("b", [field("github_repo", { value: "b/b" })])];
    data.repos = [repo("1", "a/a"), repo("2", "b/b"), repo("3", "c/c")];
    await open();
    expect(one(main, "select").value).toBe("a/a");
    find(main, "input", { name: "flow" })[1]!.fire("change");
    await flush();
    expect(one(main, "select").value).toBe("b/b");
    one(main, "select").value = "c/c";
    find(main, "input", { name: "flow" })[0]!.fire("change");
    await flush();
    expect(one(main, "select").value).toBe("a/a");
    find(main, "input", { name: "flow" })[1]!.fire("change");
    await flush();
    expect(one(main, "select").value).toBe("c/c");
  });

  it("keeps Start off and the old fields until the repositories of the new flow have loaded", async () => {
    data.flows = [flow("a", [field("x")]), flow("b", [field("github_repo")])];
    data.repos = [repo("1", "a/a")];
    await open();
    data.holdRepos = true;
    one(main, "input", { name: "x" }).value = "typed";
    find(main, "input", { name: "flow" })[1]!.fire("change");
    await flush();
    expect(submitBtn(main).disabled).toBe(true);
    await submit(main);
    expect(calls.start).toHaveLength(0);
    // a switch back while waiting keeps the typed value of the first flow
    find(main, "input", { name: "flow" })[0]!.fire("change");
    await flush();
    expect(submitBtn(main).disabled).toBe(false);
    releaseRepos();
    await flush();
    expect(one(main, "input", { name: "x" }).value).toBe("typed");
    expect(find(main, "select")).toHaveLength(0);
    await submit(main);
    expect(calls.start).toEqual([{ flow: "a", task: "", vars: { x: "typed" } }]);
  });

  it("picks the first when the default is unknown", async () => {
    data.flows = [flow("a", [field("github_repo", { value: "no/such" })])];
    data.repos = [repo("1", "a/a"), repo("2", "b/b")];
    await open();
    expect(one(main, "select").value).toBe("a/a");
  });

  it("with no repository: says so, offers Add repository and sends no github_repo when optional", async () => {
    data.flows = [flow("a", [field("github_repo")])];
    await open();
    expect(main.textContent).toContain(ui.NO_REPOS);
    expect(one(main, "button", { type: "button", "data-focus": "add-repo" }).textContent).toBe("Add repository");
    await submit(main);
    expect(calls.start[0].vars).toEqual({});
  });

  it("with no repository and a required field: asks for one and sends nothing", async () => {
    data.flows = [flow("a", [field("github_repo", { required: true })])];
    await open();
    await submit(main);
    expect(alertText(main)).toBe("Choose a repository.");
    expect(calls.start).toHaveLength(0);
    expect((document as any).activeElement.attrs["data-focus"]).toBe("add-repo");
  });

  it("shows the sentence of a failing list and still offers Add repository", async () => {
    data.flows = [flow("a", [field("github_repo")])];
    data.reposFail = true;
    await open();
    expect(main.textContent).toContain("repo list broken");
    expect(find(main, "button", { "data-focus": "add-repo" })).toHaveLength(1);
  });

  it("Add repository opens the dialog, loads again, chooses the new record and keeps typed values", async () => {
    data.flows = [flow("a", [field("github_repo"), field("x")])];
    data.repos = [repo("1", "a/a")];
    data.reposAfter = [repo("1", "a/a"), repo("2", "n/new")];
    dialog = vi.fn(async () => repo("2", "n/new"));
    await open();
    one(main, "input", { name: "x" }).value = "typed";
    one(main, "button", { "data-focus": "add-repo" }).click();
    await flush();
    expect(dialog).toHaveBeenCalledWith({ admin: false, options: { methods: ["github-token"], githubApp: { available: false } } });
    expect(calls.repos).toBe(2);
    expect(one(main, "select").value).toBe("n/new");
    expect(one(main, "input", { name: "x" }).value).toBe("typed");
  });

  it("chooses the record the dialog returned, not another one that appeared meanwhile", async () => {
    data.flows = [flow("a", [field("github_repo")])];
    data.repos = [repo("1", "a/a")];
    data.reposAfter = [repo("1", "a/a"), repo("2", "n/mine"), repo("3", "o/other-tab")];
    dialog = vi.fn(async () => repo("2", "n/mine"));
    await open();
    one(main, "button", { "data-focus": "add-repo" }).click();
    await flush();
    expect(one(main, "select").value).toBe("n/mine");
  });

  it("keeps the choice when the new record is not a GitHub one or the dialog was closed", async () => {
    data.flows = [flow("a", [field("github_repo")])];
    data.repos = [repo("1", "a/a"), repo("2", "b/b")];
    data.reposAfter = [repo("1", "a/a"), repo("2", "b/b"), repo("3")];
    dialog = vi.fn(async () => repo("3"));
    await open();
    one(main, "select").value = "b/b";
    one(main, "button", { "data-focus": "add-repo" }).click();
    await flush();
    expect(one(main, "select").value).toBe("b/b");
  });

  it("shows the sentence of a failing reload", async () => {
    data.flows = [flow("a", [field("github_repo")])];
    data.repos = [repo("1", "a/a")];
    await open();
    data.reposFail = true;
    one(main, "button", { "data-focus": "add-repo" }).click();
    await flush();
    expect(alertText(main)).toBe("repo list broken");
  });

  it("shows a fixed github_repo as text, without select, button or var", async () => {
    data.flows = [flow("a", [field("github_repo", { mode: "fixed", value: "me/fixed" })])];
    await open();
    expect(main.textContent).toContain("me/fixed");
    expect(find(main, "select")).toHaveLength(0);
    expect(find(main, "button", { type: "button" })).toHaveLength(0);
    expect(calls.repos).toBe(0);
    await submit(main);
    expect(calls.start[0].vars).toEqual({});
  });
});

describe("renderStart: fields and start", () => {
  it("has a Task box when the flow uses the task or does not say, and none when it does not", async () => {
    data.flows = [flow("a", [], { usesTask: true }), flow("b", [], { usesTask: undefined }), flow("c", [field("x")], { usesTask: false })];
    await open();
    expect(find(main, "textarea")).toHaveLength(1);
    find(main, "input", { name: "flow" })[1]!.fire("change");
    await flush();
    expect(find(main, "textarea")).toHaveLength(1);
    find(main, "input", { name: "flow" })[2]!.fire("change");
    await flush();
    expect(find(main, "textarea")).toHaveLength(0);
  });

  it("sends an empty task for a flow that does not use it", async () => {
    data.flows = [flow("c", [], { usesTask: false })];
    await open();
    await submit(main);
    expect(calls.start).toEqual([{ flow: "c", task: "", vars: {} }]);
  });

  it("shows label, help, default, required mark and aria-required; fixed fields are text", async () => {
    data.flows = [flow("a", [field("x", { label: "Branch", help: "Which one", value: "main", required: true }), field("y", { mode: "fixed", label: "Fixed y", value: "v" })])];
    await open();
    const input = one(main, "input", { name: "x" });
    expect(input.value).toBe("main");
    expect(input.attrs["aria-required"]).toBe("true");
    expect(main.textContent).toContain("Branch (required)");
    expect(main.textContent).toContain("Which one");
    expect(main.textContent).toContain("Fixed y");
    expect(find(main, "input", { name: "y" })).toHaveLength(0);
  });

  it("shows nothing about costs, models or agents", async () => {
    data.flows = [flow("a", [field("github_repo"), field("x")])];
    data.repos = [repo("1", "a/a")];
    await open();
    const text = main.textContent.toLowerCase();
    for (const w of ["$", "cost", "model", "agent"]) expect(text, w).not.toContain(w);
  });

  it("sends exactly { flow, task, vars } with inputs only; an empty optional input is sent as an empty string", async () => {
    data.flows = [flow("a", [field("x", { value: "dx" }), field("o"), field("f", { mode: "fixed", value: "z" })])];
    await open();
    one(main, "textarea").value = "do it";
    one(main, "input", { name: "x" }).value = " spaced ";
    await submit(main);
    expect(calls.start).toEqual([{ flow: "a", task: "do it", vars: { x: " spaced ", o: "" } }]);
    expect(go).toHaveBeenCalledWith("#/runs/r1");
  });

  it("refuses an empty or spaces-only required input, focuses it and sends nothing", async () => {
    data.flows = [flow("a", [field("x", { label: "Branch", required: true })])];
    await open();
    one(main, "input", { name: "x" }).value = "   ";
    await submit(main);
    expect(alertText(main)).toBe('Fill in "Branch".');
    expect(calls.start).toHaveLength(0);
    expect((document as any).activeElement).toBe(one(main, "input", { name: "x" }));
  });

  it("shows the server's sentence, keeps what was typed and turns the button on again", async () => {
    data.flows = [flow("a", [field("x")])];
    data.startFail = Object.assign(new Error("you cannot start this"), { status: 403 });
    await open();
    one(main, "input", { name: "x" }).value = "keep";
    one(main, "textarea").value = "kept task";
    await submit(main);
    expect(alertText(main)).toBe("you cannot start this");
    expect(one(main, "input", { name: "x" }).value).toBe("keep");
    expect(one(main, "textarea").value).toBe("kept task");
    expect(submitBtn(main).disabled).toBe(false);
    expect(go).not.toHaveBeenCalled();
  });

  it("says when the server cannot be reached", async () => {
    data.flows = [flow("a")];
    data.startFail = new TypeError("fetch failed");
    await open();
    await submit(main);
    expect(alertText(main)).toBe("Could not reach the server.");
  });

  it("switches the button off while the call runs, ignores a second submit and keeps it off on success", async () => {
    data.flows = [flow("a")];
    data.hold = true;
    await open();
    await submit(main);
    expect(submitBtn(main).disabled).toBe(true);
    await submit(main);
    expect(calls.start).toHaveLength(1);
    release();
    await flush();
    expect(go).toHaveBeenCalledWith("#/runs/r1");
    expect(submitBtn(main).disabled).toBe(true);
  });

  it("sends with Ctrl+Enter in the Task box", async () => {
    data.flows = [flow("a")];
    await open();
    const box = one(main, "textarea");
    box.fire("keydown", { key: "Enter", ctrlKey: false, preventDefault() {} });
    await flush();
    expect(calls.start).toHaveLength(0);
    box.fire("keydown", { key: "Enter", ctrlKey: true, preventDefault() {} });
    await flush();
    expect(calls.start).toHaveLength(1);
  });

  it("gives every control a label, and the buttons the right types", async () => {
    data.flows = [flow("a", [field("github_repo"), field("x")])];
    data.repos = [repo("1", "a/a")];
    await open();
    const form = one(main, "form");
    expect(form.attrs.novalidate).toBeDefined();
    for (const el of [...find(main, "input"), ...find(main, "select"), ...find(main, "textarea")]) {
      let p = el.parent;
      while (p && p.tag !== "label") p = p.parent;
      expect(p, `${el.tag} ${el.attrs.name}`).toBeDefined();
    }
    expect(submitBtn(main).textContent).toBe("Start");
    expect(one(main, "button", { "data-focus": "add-repo" }).attrs.type).toBe("button");
  });

  it("after cleanup a finishing start only toasts", async () => {
    data.flows = [flow("a")];
    data.hold = true;
    const cleanup = await open();
    await submit(main);
    cleanup();
    release();
    await flush();
    expect(go).not.toHaveBeenCalled();
    expect(document.getElementById("toast")!.textContent).toBe("Run started");
  });
});

describe("helpers", () => {
  it("githubRepos keeps records with a github name", () => {
    expect(ui.githubRepos([repo("1", "a/a"), repo("2"), { id: "3", github: "" }]).map((r: any) => r.id)).toEqual(["1"]);
    expect(ui.githubRepos(undefined)).toEqual([]);
  });
  it("pickRepo prefers the wanted name in any case, then the first, then nothing", () => {
    const list = [repo("1", "a/a"), repo("2", "b/b")];
    expect(ui.pickRepo(list, "B/B")).toBe("b/b");
    expect(ui.pickRepo(list, "zz")).toBe("a/a");
    expect(ui.pickRepo([], "a/a")).toBe("");
  });
  it("addedRepo gives the created record's name when listed", () => {
    const after = [repo("1", "a/a"), repo("2", "b/b")];
    expect(ui.addedRepo(repo("2", "b/b"), after)).toBe("b/b");
    expect(ui.addedRepo(repo("9", "c/c"), after)).toBe("");
    expect(ui.addedRepo(undefined, after)).toBe("");
    expect(ui.addedRepo(repo("2"), after)).toBe("");
  });
  it("startProblem finds the first empty required input", () => {
    const f = flow("a", [field("x", { label: "X", required: true }), field("y", { label: "Y", required: true }), field("z", { mode: "fixed", required: true })]);
    expect(ui.startProblem(f, { x: "ok", y: " " })).toEqual({ field: "y", text: 'Fill in "Y".' });
    expect(ui.startProblem(f, { x: "ok", y: "ok" })).toBeNull();
    expect(ui.startProblem(flow("b", [field("github_repo", { required: true })]), {})).toEqual({ field: "github_repo", text: "Choose a repository." });
  });
  it("startBody holds only inputs that have a value", () => {
    const f = flow("a", [field("x"), field("y"), field("f", { mode: "fixed" })]);
    expect(ui.startBody(f, "t", { x: " v ", f: "no" })).toEqual({ flow: "a", task: "t", vars: { x: " v " } });
    expect(ui.startBody(flow("c", [], { usesTask: false }), "t", {}).task).toBe("");
  });
});

describe("ui/style.css", () => {
  const css = readUiCss();
  it("is one column and lets fieldsets shrink", () => {
    const form = css.slice(css.indexOf(".start-form { display: grid;"));
    expect(form.slice(0, form.indexOf("}"))).not.toContain("grid-template-columns");
    expect(css).toMatch(/\.start-form fieldset \{[^}]*min-width: 0/);
  });
});

describe("renderStart: admin", () => {
  it("asks for the published list only as an admin", async () => {
    await open(true);
    expect(calls.flows).toEqual([true]);
    await open();
    expect(calls.flows).toEqual([true, undefined]);
  });

  it("says to publish a flow when there are none", async () => {
    await open(true);
    expect(main.textContent).toContain(ui.NO_FLOWS_ADMIN);
    expect(main.textContent).not.toContain(ui.NO_FLOWS);
  });

  it("sends likeUser: true and goes to the run page", async () => {
    data.flows = [flow("a", [field("x")])];
    await open(true);
    await submit(main);
    expect(calls.start).toEqual([{ flow: "a", task: "", vars: { x: "" }, likeUser: true }]);
    expect(go).toHaveBeenCalledWith("#/runs/r1");
  });

  it("passes admin to the repository dialog", async () => {
    data.flows = [flow("a", [field("github_repo")])];
    for (const admin of [true, false]) {
      await open(admin);
      one(main, "button", { type: "button", "data-focus": "add-repo" }).fire("click");
      await flush();
      expect(dialog).toHaveBeenLastCalledWith({ admin, options: expect.anything() });
    }
  });
});
