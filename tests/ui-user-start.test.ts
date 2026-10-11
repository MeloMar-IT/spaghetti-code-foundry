import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";
import { readUiCss } from "./helpers/ui-css.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
let draft: any;
let fresh: any;
let entry: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/user/start.js" as string);
  fresh = await import("../ui/refinement-new.js" as string);
  entry = await import("../ui/user/start-entry.js" as string);
  draft = await import("../ui/user/start-draft.js" as string);
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
  // "Review" opens the review; "Start" there sends
  const start = find(root, "button", { "data-focus": "start-run" })[0];
  if (start) {
    start.fire("click");
    await flush();
  }
};

let main: FakeElement;
let calls: any;
let go: ReturnType<typeof vi.fn>;
let dialog: ReturnType<typeof vi.fn>;
let data: { flows: any[]; repos: any[]; reposAfter?: any[]; reposFail?: boolean; startFail?: unknown; hold?: boolean; holdRepos?: boolean; refFail?: boolean; holdRef?: boolean; refRepos?: string[] };
let release: () => void;
let releaseRef: () => void;
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
  refinement: async () => {
    calls.refinement++;
    if (data.holdRef) await new Promise<void>((r) => (releaseRef = r));
    if (data.refFail) throw Object.assign(new Error("GitHub could not be reached"), { status: 502 });
    return { sessions: [], repos: data.refRepos ?? ["acme/app"] };
  },
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
  draft.clearDraft();
  fresh.clearKeptSession();
  (document as any).getElementById("modal-root").replaceChildren();
  calls = { repos: 0, start: [], flows: [], refinement: 0 };
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
    expect(one(main, "legend").textContent).toBe(ui.PICK_FLOW);
    expect(main.textContent).not.toMatch(/\d\. /);
  });

  it("draws no picker and no flow name with one flow, and still sends that flow", async () => {
    data.flows = [flow("a")];
    await open();
    expect(find(main, "input", { name: "flow" })).toHaveLength(0);
    expect(find(main, "legend")).toHaveLength(0);
    expect(main.textContent).not.toContain("Title a");
    expect(main.textContent).not.toContain("About a");
    await submit(main);
    expect(calls.start[0].flow).toBe("a");
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

  it("keeps Start off until the repositories of the new flow have loaded", async () => {
    data.flows = [flow("a", [field("x")]), flow("b", [field("github_repo")])];
    data.repos = [repo("1", "a/a")];
    await open();
    data.holdRepos = true;
    one(main, "input", { name: "x" }).value = "typed";
    find(main, "input", { name: "flow" })[1]!.fire("change");
    await flush();
    expect(main.textContent).toContain("Loading your repositories");
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
    // the group that holds the sentence and the Add repository button is marked and focused
    const group = one(main, "div", { role: "group", "aria-label": "Repository" });
    expect((document as any).activeElement).toBe(group);
    expect(group.attrs["aria-invalid"]).toBe("true");
    expect(group.attrs["aria-describedby"]).toBe("start-error");
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
    // the last known list stays, and the step explains the failure with Retry
    expect(one(main, "select").value).toBe("a/a");
    expect(one(main, "div", { class: "state-error" }).textContent).toContain("repo list broken");
    expect(find(main, "button", { "data-focus": "retry-repos" })).toHaveLength(1);
    data.reposFail = false;
    one(main, "button", { "data-focus": "retry-repos" }).click();
    await flush();
    expect(find(main, "div", { class: "state-error" })).toHaveLength(0);
    expect(one(main, "select").value).toBe("a/a");
  });

  it("shows a fixed github_repo as text, without select, button or var", async () => {
    data.flows = [flow("a", [field("github_repo", { mode: "fixed", value: "me/fixed" })])];
    await open();
    expect(main.textContent).toContain("me/fixed");
    expect(find(main, "select")).toHaveLength(0);
    expect(find(main, "button", { type: "button" }).map((b) => b.textContent)).toEqual(["Clear"]);
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
    expect(one(main, "details").textContent).toContain("Fixed y");
    expect(find(one(main, "details"), "input", { name: "x" })).toHaveLength(0);
  });

  it("shows nothing about costs, models, agents, steps or YAML, for a user and an admin", async () => {
    data.flows = [flow("a", [field("github_repo"), field("x"), field("f", { mode: "fixed", value: "v" })])];
    data.repos = [repo("1", "a/a")];
    for (const admin of [false, true]) {
      await open(admin);
      const text = main.textContent.toLowerCase();
      for (const w of ["$", "cost", "model", "agent", "step", "yaml"]) expect(text, w).not.toContain(w);
    }
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
    const input = one(main, "input", { name: "x" });
    expect(input.attrs["aria-invalid"]).toBe("true");
    expect(input.attrs["aria-describedby"]).toBe("start-error");
    expect(one(main, "p", { role: "alert" }).attrs.id).toBe("start-error");
  });

  it("takes the mark off when the field is edited, and the next submit sends", async () => {
    data.flows = [flow("a", [field("x", { label: "Branch", required: true })])];
    await open();
    await submit(main);
    const input = one(main, "input", { name: "x" });
    expect(input.attrs["aria-invalid"]).toBe("true");
    input.value = "main";
    input.fire("input", { target: input });
    expect(input.attrs["aria-invalid"]).toBeUndefined();
    expect(input.attrs["aria-describedby"]).toBeUndefined();
    expect(alertText(main)).toBe("");
    await submit(main);
    expect(calls.start).toHaveLength(1);
  });

  it("marks and focuses only the first of two empty required inputs", async () => {
    data.flows = [flow("a", [field("x", { required: true }), field("y", { required: true })])];
    await open();
    await submit(main);
    expect(one(main, "input", { name: "x" }).attrs["aria-invalid"]).toBe("true");
    expect(one(main, "input", { name: "y" }).attrs["aria-invalid"]).toBeUndefined();
    expect((document as any).activeElement).toBe(one(main, "input", { name: "x" }));
  });

  it("clears the mark and the message when another flow is chosen", async () => {
    data.flows = [flow("a", [field("x", { required: true })]), flow("b", [field("z")])];
    await open();
    await submit(main);
    expect(alertText(main)).not.toBe("");
    find(main, "input", { name: "flow" })[1]!.fire("change");
    await flush();
    expect(alertText(main)).toBe("");
    expect(find(main, "input").some((el) => "aria-invalid" in el.attrs)).toBe(false);
  });

  it("shows the server's sentence, keeps what was typed and turns the button on again", async () => {
    data.flows = [flow("a", [field("x")])];
    data.startFail = Object.assign(new Error("you cannot start this"), { status: 403 });
    await open();
    one(main, "input", { name: "x" }).value = "keep";
    one(main, "textarea").value = "kept task";
    await submit(main);
    const box = one(main, "div", { role: "alert" });
    expect(box.attrs["data-kind"]).toBe("permission");
    expect(box.textContent).toContain("The run could not be started. you cannot start this");
    expect(box.textContent).toContain(ui.START_KEPT);
    expect(alertText(main)).toBe("");
    expect(find(main, "input").some((el) => "aria-invalid" in el.attrs)).toBe(false);
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
    const box = one(main, "div", { role: "alert" });
    expect(box.textContent).toContain("The server could not be reached.");
    expect(box.textContent).toContain(ui.START_UNSURE);
    expect(one(box, "p", { class: "state-next" }).textContent).toBe(ui.START_UNSURE_NEXT);
  });

  it("switches Start and Back off while the call runs, sends once for two clicks and keeps the form off on success", async () => {
    data.flows = [flow("a")];
    data.hold = true;
    await open();
    await submit(main);
    const startBtn = one(main, "button", { "data-focus": "start-run" });
    startBtn.fire("click");
    startBtn.fire("click");
    await flush();
    expect(startBtn.disabled).toBe(true);
    expect(one(main, "button", { "data-focus": "start-back" }).disabled).toBe(true);
    expect(calls.start).toHaveLength(1);
    release();
    await flush();
    expect(go).toHaveBeenCalledWith("#/runs/r1");
    expect(startBtn.disabled).toBe(true);
  });

  it("opens the review with Ctrl+Enter in the Task box", async () => {
    data.flows = [flow("a")];
    await open();
    const box = one(main, "textarea");
    box.fire("keydown", { key: "Enter", ctrlKey: false, preventDefault() {} });
    await flush();
    expect(calls.start).toHaveLength(0);
    box.fire("keydown", { key: "Enter", ctrlKey: true, preventDefault() {} });
    await flush();
    expect(calls.start).toHaveLength(0);
    one(main, "button", { "data-focus": "start-run" }).fire("click");
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
    expect(submitBtn(main).textContent).toBe("Review");
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

describe("renderStart: required first, More options", () => {
  const mixed = () => flow("a", [field("o"), field("github_repo", { value: "a/a" }), field("x", { required: true }), field("f", { mode: "fixed", value: "v" })]);

  it("shows the repository, Task and required inputs outside the disclosure, each marked", async () => {
    data.flows = [mixed()];
    data.repos = [repo("1", "a/a")];
    await open();
    const more = one(main, "details");
    expect(find(more, "select")).toHaveLength(0);
    expect(find(more, "textarea")).toHaveLength(0);
    expect(find(more, "input", { name: "x" })).toHaveLength(0);
    expect(find(more, "input", { name: "o" })).toHaveLength(1);
    for (const t of ["Repository (required)", "Task (required)", "x (required)"]) expect(main.textContent).toContain(t);
    expect(one(main, "textarea").attrs["aria-required"]).toBeUndefined();
    expect(one(main, "input", { name: "x" }).attrs["aria-required"]).toBe("true");
  });

  it("closes the disclosure at first and says how many options it holds", async () => {
    data.flows = [mixed()];
    data.repos = [repo("1", "a/a")];
    await open();
    const more = one(main, "details");
    expect(more.attrs.open).toBeUndefined();
    expect(one(more, "summary").textContent).toBe(ui.moreSummary(1, 1));
  });

  it("draws no disclosure when nothing is optional or fixed, and no Task without usesTask", async () => {
    data.flows = [flow("a", [field("x", { required: true })], { usesTask: false })];
    await open();
    expect(find(main, "details")).toHaveLength(0);
    expect(find(main, "textarea")).toHaveLength(0);
    data.flows = [flow("a")];
    await open();
    expect(find(main, "details")).toHaveLength(0);
    await submit(main);
    expect(calls.start).toHaveLength(1);
  });

  it("opens the disclosure after the server refuses, with the typed values in place", async () => {
    data.flows = [flow("a", [field("o")])];
    data.startFail = Object.assign(new Error("bad"), { status: 400 });
    await open();
    const input = one(main, "input", { name: "o" });
    input.value = "typed";
    await submit(main);
    expect(one(main, "details").attrs.open).toBe("");
    expect(one(main, "input", { name: "o" })).toBe(input);
    expect(input.value).toBe("typed");
    expect(submitBtn(main).disabled).toBe(false);
    await submit(main);
    expect(calls.start).toHaveLength(2);
    expect(calls.start[1]).toEqual(calls.start[0]);
  });

  it("does not open the disclosure for a field problem", async () => {
    data.flows = [flow("a", [field("x", { required: true }), field("o")])];
    await open();
    await submit(main);
    expect(one(main, "details").attrs.open).toBeUndefined();
    expect(calls.start).toHaveLength(0);
  });

  it("closes it again on a flow change", async () => {
    data.flows = [flow("a", [field("o")]), flow("b", [field("p")])];
    data.startFail = Object.assign(new Error("bad"), { status: 400 });
    await open();
    await submit(main);
    expect(one(main, "details").attrs.open).toBe("");
    find(main, "input", { name: "flow" })[1]!.fire("change");
    expect(one(main, "details").attrs.open).toBeUndefined();
  });

  it("keeps the flow picker off while sending, so a late refusal opens the sent flow's options", async () => {
    data.flows = [flow("a", [field("o")]), flow("b", [field("p")])];
    data.startFail = Object.assign(new Error("bad"), { status: 400 });
    data.hold = true;
    await open();
    one(main, "input", { name: "o" }).value = "typed";
    const radios = find(main, "input", { name: "flow" });
    const sent = submit(main);
    await flush();
    expect(radios.every((r) => (r as any).disabled)).toBe(true);
    radios[1]!.fire("change");
    expect(find(main, "input", { name: "p" })).toHaveLength(0);
    await sent;
    release();
    await flush();
    expect(one(main, "details").attrs.open).toBe("");
    expect(one(main, "input", { name: "o" }).value).toBe("typed");
    expect(find(main, "input", { name: "flow" }).every((r) => !(r as any).disabled)).toBe(true);
  });

  it("shows a note with a link to My repositories for a failed repository, following the selection", async () => {
    data.flows = [flow("a", [field("github_repo", { value: "a/a" })])];
    data.repos = [repo("1", "a/a", { ok: true }), repo("2", "b/b", { ok: false })];
    await open();
    expect(main.textContent).not.toContain(ui.REPO_FAILED_NOTE);
    const sel = one(main, "select");
    sel.value = "b/b";
    sel.fire("change");
    const link = one(main, "a", { href: "#/repos" });
    expect(link.textContent).toBe("My repositories");
    expect(main.textContent).toContain(ui.REPO_FAILED_NOTE);
    sel.value = "a/a";
    sel.fire("change");
    expect(find(main, "a", { href: "#/repos" })).toHaveLength(0);
  });

  it("shows the note at once when the preselected repository failed", async () => {
    data.flows = [flow("a", [field("github_repo", { value: "b/b" })])];
    data.repos = [repo("1", "a/a"), repo("2", "b/b", { ok: false })];
    await open();
    expect(find(main, "a", { href: "#/repos" })).toHaveLength(1);
  });

  it("names the repository while it loads", async () => {
    data.flows = [flow("a", [field("github_repo")])];
    data.holdRepos = true;
    const opened = open();
    await flush();
    expect(main.textContent).toContain("Repository (required)");
    releaseRepos();
    await opened;
  });

  it("puts a fixed repository into the disclosure, without a select", async () => {
    data.flows = [flow("a", [field("github_repo", { mode: "fixed", value: "me/fixed" })])];
    await open();
    expect(one(main, "details").textContent).toContain("me/fixed");
    expect(find(main, "select")).toHaveLength(0);
  });

  it("draws the disclosure but no Start button in the read-only preview", async () => {
    data.flows = [flow("a", [field("o")])];
    main = document.createElement("div") as unknown as FakeElement;
    await ui.renderStart(main, { a: fakeApi(), dialog, go, readOnly: true });
    expect(find(main, "details")).toHaveLength(1);
    expect(find(main, "button", { type: "submit" })).toHaveLength(0);
  });
});

describe("helpers", () => {
  it("splitFields puts the repository first, then required inputs, optional inputs and fixed values apart", () => {
    const f = (name: string, over: object = {}) => field(name, over);
    const parts = ui.splitFields(flow("a", [f("o"), f("x", { required: true }), f("github_repo"), f("fx", { mode: "fixed" })]));
    expect(parts.required.map((x: any) => x.name)).toEqual(["github_repo", "x"]);
    expect(parts.optional.map((x: any) => x.name)).toEqual(["o"]);
    expect(parts.fixed.map((x: any) => x.name)).toEqual(["fx"]);
    expect(ui.splitFields(flow("a", [f("github_repo", { mode: "fixed" })])).fixed).toHaveLength(1);
    expect(ui.splitFields({})).toEqual({ required: [], optional: [], fixed: [] });
  });

  it("moreSummary counts the parts and leaves out zeros", () => {
    expect(ui.moreSummary(2, 1)).toBe("More options: 2 optional fields, 1 fixed value");
    expect(ui.moreSummary(1, 0)).toBe("More options: 1 optional field");
    expect(ui.moreSummary(0, 2)).toBe("More options: 2 fixed values");
  });

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
  it("startProblem checks the repository first, as the page shows it, whatever the metadata order", async () => {
    const f = flow("a", [field("x", { required: true }), field("github_repo", { required: true })]);
    expect(ui.startProblem(f, {})).toEqual({ field: "github_repo", text: "Choose a repository." });
    data.flows = [f];
    await open();
    await submit(main);
    expect(alertText(main)).toBe("Choose a repository.");
    expect((document as any).activeElement.attrs["aria-label"]).toBe("Repository");
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

describe("renderStart: a wish from the command palette", () => {
  let wishes: any;
  beforeAll(async () => {
    wishes = await import("../ui/palette-data.js" as string);
  });
  beforeEach(() => {
    wishes.resetWishes();
    data.flows = [flow("a"), flow("b")];
  });
  const checkedIn = (root: FakeElement) => find(root, "input", { name: "flow" }).filter((r) => r.checked).map((r) => r.value);
  const checked = () => checkedIn(main);

  it("chooses the flow that was wished before the page was drawn", async () => {
    wishes.sendWish("start", { flow: "b" });
    await open();
    expect(checked()).toEqual(["b"]);
    expect(wishes.takeWish("start")).toBeNull();
  });

  it("falls back to the first flow for an unknown name, and uses the wish up when there are no flows", async () => {
    wishes.sendWish("start", { flow: "nope" });
    await open();
    expect(checked()).toEqual(["a"]);
    data.flows = [];
    wishes.sendWish("start", { flow: "b" });
    await open();
    expect(wishes.takeWish("start")).toBeNull();
  });

  it("switches the flow on the open page, keeps the typed text and checks the radio, also for an admin", async () => {
    for (const admin of [false, true]) {
      await open(admin);
      one(main, "textarea", { name: "task" }).value = "my text";
      wishes.sendWish("start", { flow: "b" });
      await flush();
      expect(checked()).toEqual(["b"]);
      expect(one(main, "textarea", { name: "task" }).value).toBe("my text");
      wishes.sendWish("start", { flow: "b" });
      wishes.sendWish("start", { flow: "nope" });
      await flush();
      expect(checked()).toEqual(["b"]);
    }
  });

  it("does not lose a wish that arrives while repositories are loading", async () => {
    data.flows = [flow("a", [field("github_repo")]), flow("b")];
    data.holdRepos = true;
    const opening = open();
    await flush();
    wishes.sendWish("start", { flow: "b" });
    releaseRepos();
    await opening;
    expect(checked()).toEqual(["b"]);
  });

  it("frees the slot when the page is left", async () => {
    const cleanup = await open();
    cleanup();
    wishes.sendWish("start", { flow: "b" });
    expect(wishes.takeWish("start")).toEqual({ flow: "b" });
  });

  it("lets only the newest render take the wish and own the handler, whatever order they finish in", async () => {
    let finishOld!: () => void;
    const slow = { ...fakeApi(), flows: () => new Promise<any[]>((r) => { finishOld = () => r(data.flows); }) };
    const mainOld = document.createElement("div") as unknown as FakeElement;
    wishes.sendWish("start", { flow: "b" });
    const oldRender = ui.renderStart(mainOld, { a: slow, dialog, go });
    await open();
    expect(checked()).toEqual(["b"]);
    finishOld();
    const cleanOld = await oldRender;
    // the older render did not take the wish: it shows the first flow
    expect(checkedIn(mainOld)).toEqual(["a"]);
    cleanOld();
    // the older render's cleanup does not remove the handler of the newer page
    wishes.sendWish("start", { flow: "a" });
    await flush();
    expect(checked()).toEqual(["a"]);
  });
});

describe("renderStart: entry choices", () => {
  const group = (root: FakeElement) => find(root, "div", { role: "group", "aria-label": "How do you want to begin?" });
  const texts = (root: FakeElement) => [...find(group(root)[0]!, "button"), ...find(group(root)[0]!, "a")].map((e) => e.textContent);
  const modalRoot = () => (document as any).getElementById("modal-root") as FakeElement;
  const choice = (name: string) => one(main, "button", { "data-focus": name });
  const toastText = () => (document as any).getElementById("toast").textContent as string;
  const realFetch = globalThis.fetch;
  const posts: any[] = [];
  const stubPost = (status = 201, body: unknown = { id: "new1", title: "T" }) => {
    posts.length = 0;
    (globalThis as any).fetch = async (url: string, init: any) => {
      posts.push({ url, method: init.method, body: JSON.parse(init.body) });
      return { ok: status < 400, status, statusText: "x", json: async () => body };
    };
  };
  const reset = () => { globalThis.fetch = realFetch; };
  const radio = (kind: string) => modalRoot().all("input").find((e) => e.attrs.name === "kind" && e.value === kind)!;
  const press = (el: FakeElement | undefined) => {
    expect(el, "control").toBeDefined();
    el!.click();
  };

  it("comes before the form with the four choices in order, and asks for nothing yet", async () => {
    data.flows = [flow("a")];
    await open();
    expect(group(main)).toHaveLength(1);
    const children = main.children as FakeElement[];
    expect(children.indexOf(group(main)[0]!)).toBeLessThan(children.indexOf(one(main, "form")));
    expect(texts(main)).toEqual([entry.ENTRY_TASK, entry.ENTRY_IDEA, entry.ENTRY_ISSUE, entry.ENTRY_CONTINUE]);
    expect(choice("entry-task").attrs["aria-current"]).toBe("true");
    expect(calls.refinement).toBe(0);
  });

  it("is also there with no flows and when the flows fail, without the task choice", async () => {
    await open();
    expect(texts(main)).toEqual([entry.ENTRY_IDEA, entry.ENTRY_ISSUE, entry.ENTRY_CONTINUE]);
    expect(main.textContent).toContain(ui.NO_FLOWS);
    const failing = { ...fakeApi(), flows: async () => { throw Object.assign(new Error("x"), { status: 500 }); } };
    main = document.createElement("div") as unknown as FakeElement;
    await ui.renderStart(main, { a: failing, dialog, go });
    expect(texts(main)).toEqual([entry.ENTRY_IDEA, entry.ENTRY_ISSUE, entry.ENTRY_CONTINUE]);
  });

  it("starts a refinement from the no-flows page", async () => {
    await open();
    press(choice("entry-issue"));
    await flush();
    expect(radio("issue").checked).toBe(true);
  });

  it("is on the form again after Back and not on the review", async () => {
    data.flows = [flow("a")];
    await open();
    one(main, "textarea", { name: "task" }).value = "t";
    one(main, "form").fire("submit", { preventDefault() {} });
    await flush();
    expect(group(main)).toHaveLength(0);
    one(main, "button", { "data-focus": "start-back" }).click();
    expect(group(main)).toHaveLength(1);
    expect(find(main, "form")).toHaveLength(1);
  });

  it("says a kept draft is carried on, until Clear", async () => {
    data.flows = [flow("a")];
    draft.writeDraft({ flow: "a", task: "kept task", values: { a: {} } });
    await open();
    expect(choice("entry-task").textContent).toBe(entry.ENTRY_TASK_DRAFT);
    expect(one(main, "textarea", { name: "task" }).value).toBe("kept task");
    one(main, "button", { type: "button" }).click();
    expect(choice("entry-task").textContent).toBe(entry.ENTRY_TASK);
  });

  it("moves the focus into the form on Start a task now", async () => {
    data.flows = [flow("a")];
    await open();
    press(choice("entry-task"));
    expect((document as any).activeElement).toBe(one(main, "textarea", { name: "task" }));
  });

  it("opens the idea form after one read, and goes to the session after Start session", async () => {
    data.flows = [flow("a")];
    stubPost();
    try {
      await open();
      press(choice("entry-idea"));
      await flush();
      expect(calls.refinement).toBe(1);
      expect(radio("idea").checked).toBe(true);
      one(modalRoot(), "textarea", { name: "idea" }).value = "An idea";
      press(find(modalRoot(), "button").find((b) => b.textContent === "Start session"));
      await flush();
      expect(posts).toEqual([{ url: "/api/refinement", method: "POST", body: { repo: "acme/app", idea: "An idea" } }]);
      expect(go).toHaveBeenCalledWith("#/refinement/new1");
    } finally {
      reset();
    }
  });

  it("opens the issue form", async () => {
    data.flows = [flow("a")];
    await open();
    press(choice("entry-issue"));
    await flush();
    expect(radio("issue").checked).toBe(true);
    expect(find(modalRoot(), "input", { name: "issue" })).toHaveLength(1);
  });

  it("links to the refinement sessions", async () => {
    data.flows = [flow("a")];
    await open();
    expect(one(main, "a", { href: "#/refinement" }).textContent).toBe(entry.ENTRY_CONTINUE);
  });

  it("shows a failed read as a toast, opens nothing and works again", async () => {
    data.flows = [flow("a")];
    await open();
    data.refFail = true;
    press(choice("entry-idea"));
    await flush();
    expect(toastText()).toContain("GitHub could not be reached");
    expect(modalRoot().children).toHaveLength(0);
    data.refFail = false;
    press(choice("entry-idea"));
    await flush();
    expect(modalRoot().children.length).toBeGreaterThan(0);
  });

  it("reads once for two fast presses", async () => {
    data.flows = [flow("a")];
    data.holdRef = true;
    await open();
    press(choice("entry-idea"));
    press(choice("entry-idea"));
    releaseRef();
    await flush();
    expect(calls.refinement).toBe(1);
  });

  it("opens no dialog when the page was left before the answer", async () => {
    data.flows = [flow("a")];
    data.holdRef = true;
    const cleanup = await open();
    press(choice("entry-idea"));
    cleanup();
    releaseRef();
    await flush();
    expect(modalRoot().children).toHaveLength(0);
  });

  it("has no entry that makes a session in a preview and reads nothing", async () => {
    data.flows = [flow("a")];
    main = document.createElement("div") as unknown as FakeElement;
    await ui.renderStart(main, { a: fakeApi(), dialog, go, readOnly: true });
    expect(texts(main)).toEqual([entry.ENTRY_CONTINUE]);
    expect(calls.refinement).toBe(0);
  });

  it("keeps the typed text when the form is closed and opened again from the page", async () => {
    data.flows = [flow("a")];
    await open();
    press(choice("entry-idea"));
    await flush();
    const area = one(modalRoot(), "textarea", { name: "idea" });
    area.value = "Typed";
    area.fire("input");
    (document as any).listeners.keydown.forEach((f: any) => f({ key: "Escape" }));
    press(choice("entry-issue"));
    await flush();
    expect(radio("issue").checked).toBe(true);
    radio("idea").checked = true;
    radio("idea").fire("change");
    expect(one(modalRoot(), "textarea", { name: "idea" }).value).toBe("Typed");
  });

  it("opens no dialog when the address changed before the answer, also while the flows still load", async () => {
    (globalThis as any).location = { hash: "#/start" };
    data.flows = [flow("a")];
    data.holdRef = true;
    let finishFlows!: () => void;
    const slow = { ...fakeApi(), flows: () => new Promise<any[]>((r) => { finishFlows = () => r(data.flows); }) };
    main = document.createElement("div") as unknown as FakeElement;
    const rendering = ui.renderStart(main, { a: slow, dialog, go });
    press(choice("entry-idea")); // pressed while the flows load
    (globalThis as any).location.hash = "#/runs";
    releaseRef();
    await flush();
    expect(modalRoot().children).toHaveLength(0);
    finishFlows();
    await rendering;
    expect(modalRoot().children).toHaveLength(0);
    (globalThis as any).location.hash = "#/start";
  });

  it("does not go to a session when the address changed while it was made", async () => {
    (globalThis as any).location = { hash: "#/start" };
    data.flows = [flow("a")];
    stubPost();
    try {
      await open();
      press(choice("entry-idea"));
      await flush();
      one(modalRoot(), "textarea", { name: "idea" }).value = "An idea";
      (globalThis as any).location.hash = "#/runs";
      press(find(modalRoot(), "button").find((b) => b.textContent === "Start session"));
      await flush();
      expect(go).not.toHaveBeenCalled();
      expect(toastText()).toContain("Refinement session started");
    } finally {
      reset();
      (globalThis as any).location.hash = "#/start";
    }
  });

  it("keeps the page and the kept idea when the session ended while the repositories were read", async () => {
    const reload = vi.fn();
    (globalThis as any).location = { hash: "#/start", reload };
    data.flows = [flow("a")];
    const { api } = await import("../ui/api.js" as string);
    (globalThis as any).fetch = async () => ({ ok: false, status: 401, statusText: "x", json: async () => ({ error: "Sign in again." }) });
    try {
      main = document.createElement("div") as unknown as FakeElement;
      await ui.renderStart(main, { a: { ...fakeApi(), refinement: api.refinement }, dialog, go });
      press(choice("entry-idea"));
      await flush();
      expect(reload).toHaveBeenCalled(); // nothing is kept yet: a 401 may reload
      reload.mockClear();
      // an idea is kept: open the form through the API-free path, type, close, then the 401 must not reload
      (globalThis as any).fetch = async () => ({ ok: true, status: 200, statusText: "x", json: async () => ({ sessions: [], repos: ["acme/app"] }) });
      press(choice("entry-idea"));
      await flush();
      const area = one(modalRoot(), "textarea", { name: "idea" });
      area.value = "Kept idea";
      area.fire("input");
      (document as any).listeners.keydown.forEach((f: any) => f({ key: "Escape" }));
      (globalThis as any).fetch = async () => ({ ok: false, status: 401, statusText: "x", json: async () => ({ error: "Sign in again." }) });
      press(choice("entry-idea"));
      await flush();
      expect(reload).not.toHaveBeenCalled();
      expect(toastText()).toContain("Sign in again.");
      expect(fresh.keptSession()).toMatchObject({ idea: "Kept idea" });
    } finally {
      reset();
    }
  });

  it("keeps the page and the text when the session ended during Start session", async () => {
    data.flows = [flow("a")];
    const reload = vi.fn();
    (globalThis as any).location = { hash: "#/start", reload };
    stubPost(401, { error: "Sign in again." });
    try {
      await open();
      press(choice("entry-idea"));
      await flush();
      one(modalRoot(), "textarea", { name: "idea" }).value = "Typed";
      press(find(modalRoot(), "button").find((b) => b.textContent === "Start session"));
      await flush();
      expect(reload).not.toHaveBeenCalled();
      expect(modalRoot().textContent).toContain("Sign in again.");
      expect(one(modalRoot(), "textarea", { name: "idea" }).value).toBe("Typed");
    } finally {
      reset();
    }
  });
});

describe("renderStart: the repository context", () => {
  it("loads the switcher again after the Add dialog: none, one, many; no navigation", async () => {
    const context: any = await import("../ui/context.js" as string);
    const reposUi: any = await import("../ui/repos.js" as string);
    const { api } = (await import("../ui/api.js" as string)) as any;
    const gh = (github: string) => ({ github, owner: "u1", account: null });
    const lists = [[], [gh("o/a")], [gh("o/a"), gh("o/b")]];
    const a = { repos: vi.fn(async () => (lists.length > 1 ? lists.shift() : lists[0])) };
    const ctxGo = vi.fn();
    const memory = { getItem: () => null, setItem: () => undefined };
    const ctx = context.initContext("user", { id: "u1" }, { a, go: ctxGo, notify: vi.fn(), store: context.contextStore("u1", memory), where: () => "#/start" });
    const realAdd = api.addRepo;
    const text = () => (document as any).getElementById("context").textContent as string;
    const modalRoot = () => (document as any).getElementById("modal-root") as FakeElement;
    try {
      await ctx.ready;
      expect(text()).toContain("No repository yet.");
      let n = 0;
      api.addRepo = async (body: any) => ({ id: `n${++n}`, url: body.url, method: body.method });
      data.flows = [flow("a", [field("github_repo")])];
      data.repos = [];
      dialog = reposUi.repoDialog;
      await open();
      const addOnce = async () => {
        one(main, "button", { "data-focus": "add-repo" }).click();
        await flush();
        one(modalRoot(), "input", { name: "url" }).value = `https://github.com/o/r${n}`;
        one(modalRoot(), "input", { name: "token" }).value = "t".repeat(40);
        find(modalRoot(), "button").find((b) => b.textContent === "Add repository")!.click();
        await flush();
        await flush();
      };
      await addOnce();
      expect(a.repos).toHaveBeenCalledTimes(2);
      expect(text()).toContain("o/a");
      expect(find((document as any).getElementById("context"), "button", { "data-focus": "context-btn" })).toHaveLength(0);
      await addOnce();
      expect(a.repos).toHaveBeenCalledTimes(3);
      expect(find((document as any).getElementById("context"), "button", { "data-focus": "context-btn" })).toHaveLength(1);
      expect(ctxGo).not.toHaveBeenCalled();
    } finally {
      ctx.stop();
      api.addRepo = realAdd;
    }
  });
});
