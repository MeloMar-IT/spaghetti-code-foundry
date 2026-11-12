import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";
import { chooseFlow, flowRadios } from "./helpers/start-flow.js";
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
let data: {
  flows: any[]; repos: any[]; reposAfter?: any[]; reposFail?: boolean; startFail?: unknown; hold?: boolean; holdRepos?: boolean; holdFlows?: boolean; refFail?: boolean; holdRef?: boolean; refRepos?: string[];
  sessions?: any[]; planFail?: unknown; holdPlan?: boolean; changes?: any[]; changesFail?: boolean;
};
let releasePlan: () => void;
let release: () => void;
let releaseRef: () => void;
let releaseRepos: () => void;
let releaseFlows: () => void;

const fakeApi = () => ({
  flows: async (p?: unknown) => {
    calls.flows.push(p);
    if (data.holdFlows) await new Promise<void>((r) => (releaseFlows = r));
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
    return { sessions: data.sessions ?? [], repos: data.refRepos ?? ["acme/app"] };
  },
  createChange: async (body: unknown) => {
    calls.plan.push(["createChange", body]);
    if (data.holdPlan) await new Promise<void>((r) => (releasePlan = r));
    if (data.planFail) throw data.planFail;
    return { id: "c1" };
  },
  createRefinement: async (body: unknown) => {
    calls.plan.push(["createRefinement", body]);
    if (data.planFail) throw data.planFail;
    return { id: "s1" };
  },
  changes: async (name: string) => {
    calls.changes.push(name);
    if (data.changesFail) throw Object.assign(new Error("no answer"), { status: 503 });
    return data.changes ?? [];
  },
  startRun: async (body: unknown) => {
    calls.start.push(body);
    if (data.hold) await new Promise<void>((r) => (release = r));
    if (data.startFail) throw data.startFail;
    return { runId: "r1", queued: true };
  },
});

async function open(admin?: boolean, plan = false) {
  main = document.createElement("div") as unknown as FakeElement;
  const cleanup = await ui.renderStart(main, { a: fakeApi(), dialog, go, ...(admin === undefined ? {} : { admin }) });
  if (!plan) {
    // the page starts without a flow ("Make a plan"): these tests are about a flow, chosen under Advanced
    const had = draft.readDraft() !== null;
    await chooseFlow(main);
    if (!had) draft.clearDraft(); // choosing the flow is not the work these tests look at
  }
  return cleanup as () => void;
}

beforeEach(() => {
  draft.clearDraft();
  fresh.clearKeptSession();
  (document as any).getElementById("modal-root").replaceChildren();
  calls = { repos: 0, start: [], flows: [], refinement: 0, plan: [], changes: [] };
  go = vi.fn();
  dialog = vi.fn(async () => undefined);
  data = { flows: [], repos: [] };
  (document as any).activeElement = null;
});

describe("renderStart: flows", () => {
  it("shows the composer and no empty or error box with no flows; the note is inside Advanced", async () => {
    await open(undefined, true);
    expect(find(main, "textarea", { name: "task" })).toHaveLength(1);
    expect(find(main, "div", { class: "empty" })).toHaveLength(0);
    expect(find(main, "div", { role: "alert" })).toHaveLength(0);
    expect(main.textContent).not.toContain(ui.NO_FLOWS);
    const adv = one(main, "details", { class: "composer-advanced" });
    expect(adv.textContent).toContain(draft.NO_FLOWS_NOTE);
    expect(adv.attrs.open).toBeUndefined();
    expect(calls.start).toHaveLength(0);
  });

  it("lists flows under Advanced as radios with a no-flow choice first; none is chosen at first", async () => {
    data.flows = [flow("a"), flow("b")];
    await open(undefined, true);
    const all = find(main, "input", { type: "radio", name: "flow" });
    expect(all.map((r) => r.value)).toEqual(["", "a", "b"]);
    expect((all[0] as any).checked).toBe(true);
    const adv = one(main, "details", { class: "composer-advanced" });
    expect(adv.textContent).toContain(draft.FLOW_NONE);
    expect(adv.textContent).toContain("Title b");
    expect(adv.textContent).toContain("About b");
    expect(one(adv, "legend").textContent).toBe(ui.PICK_FLOW);
    expect(main.textContent).not.toMatch(/\d\. /);
  });

  it("offers the one flow under Advanced too, and sends it once it is chosen", async () => {
    data.flows = [flow("a")];
    await open();
    expect(flowRadios(main)).toHaveLength(1);
    await submit(main);
    expect(calls.start[0].flow).toBe("a");
  });

  it("redraws the fields on a flow change and brings typed values back", async () => {
    data.flows = [flow("a", [field("x", { value: "dx" })]), flow("b", [field("y")])];
    await open();
    one(main, "input", { name: "x" }).value = "typed";
    one(main, "textarea", { name: "task" }).value = "my task";
    flowRadios(main)[1]!.fire("change");
    await flush();
    expect(find(main, "input", { name: "x" })).toHaveLength(0);
    expect(find(main, "input", { name: "y" })).toHaveLength(1);
    expect(one(main, "textarea", { name: "task" }).value).toBe("my task");
    flowRadios(main)[0]!.fire("change");
    await flush();
    expect(one(main, "input", { name: "x" }).value).toBe("typed");
  });

  it("keeps working when the repository list fails and the flow has no repository field", async () => {
    data.flows = [flow("a")];
    data.reposFail = true;
    await open();
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
    flowRadios(main)[1]!.fire("change");
    await flush();
    expect(one(main, "select").value).toBe("b/b");
    one(main, "select").value = "c/c";
    flowRadios(main)[0]!.fire("change");
    await flush();
    expect(one(main, "select").value).toBe("a/a");
    flowRadios(main)[1]!.fire("change");
    await flush();
    expect(one(main, "select").value).toBe("c/c");
  });

  it("keeps Start off until the repositories of the new flow have loaded", async () => {
    // the repositories are read once, when the page opens; a flow that needs one waits for that read
    data.flows = [flow("a", [field("x")]), flow("b", [field("github_repo")])];
    data.repos = [repo("1", "a/a")];
    data.holdRepos = true;
    main = document.createElement("div") as unknown as FakeElement;
    const opening = ui.renderStart(main, { a: fakeApi(), dialog, go });
    await flush();
    await chooseFlow(main, "a");
    one(main, "input", { name: "x" }).value = "typed";
    flowRadios(main)[1]!.fire("change");
    await flush();
    expect(main.textContent).toContain("Loading your repositories");
    expect(submitBtn(main).disabled).toBe(true);
    await submit(main);
    expect(calls.start).toHaveLength(0);
    // a switch back while waiting keeps the typed value of the first flow
    flowRadios(main)[0]!.fire("change");
    await flush();
    expect(submitBtn(main).disabled).toBe(false);
    releaseRepos();
    await opening;
    await flush();
    expect(one(main, "input", { name: "x" }).value).toBe("typed");
    expect(find(main, "select", { name: "github_repo" })).toHaveLength(0);
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
    await submit(main);
    expect(calls.start[0].vars).toEqual({});
  });
});

describe("renderStart: fields and start", () => {
  it("has a Task box when the flow uses the task or does not say, and none when it does not", async () => {
    data.flows = [flow("a", [], { usesTask: true }), flow("b", [], { usesTask: undefined }), flow("c", [field("x")], { usesTask: false })];
    await open();
    expect(find(main, "textarea")).toHaveLength(1);
    flowRadios(main)[1]!.fire("change");
    await flush();
    expect(find(main, "textarea")).toHaveLength(1);
    flowRadios(main)[2]!.fire("change");
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
    expect(one(main, "details", { class: "start-more" }).textContent).toContain("Fixed y");
    expect(find(one(main, "details", { class: "start-more" }), "input", { name: "x" })).toHaveLength(0);
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
    flowRadios(main)[1]!.fire("change");
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
    expect(submitBtn(main).textContent).toBe("Make a plan");
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
    const more = one(main, "details", { class: "start-more" });
    expect(find(more, "select")).toHaveLength(0);
    expect(find(more, "textarea")).toHaveLength(0);
    expect(find(more, "input", { name: "x" })).toHaveLength(0);
    expect(find(more, "input", { name: "o" })).toHaveLength(1);
    for (const t of ["Repository (required)", "What would you like to change?", "x (required)"]) expect(main.textContent).toContain(t);
    expect(one(main, "textarea").attrs["aria-required"]).toBeUndefined();
    expect(one(main, "input", { name: "x" }).attrs["aria-required"]).toBe("true");
  });

  it("closes the disclosure at first and says how many options it holds", async () => {
    data.flows = [mixed()];
    data.repos = [repo("1", "a/a")];
    await open();
    const more = one(main, "details", { class: "start-more" });
    expect(more.attrs.open).toBeUndefined();
    expect(one(more, "summary").textContent).toBe(ui.moreSummary(1, 1));
  });

  it("draws no disclosure when nothing is optional or fixed, and no Task without usesTask", async () => {
    data.flows = [flow("a", [field("x", { required: true })], { usesTask: false })];
    await open();
    expect(find(main, "details", { class: "start-more" })).toHaveLength(0);
    expect(find(main, "textarea")).toHaveLength(0);
    data.flows = [flow("a")];
    await open();
    expect(find(main, "details", { class: "start-more" })).toHaveLength(0);
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
    expect(one(main, "details", { class: "start-more" }).attrs.open).toBe("");
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
    expect(one(main, "details", { class: "start-more" }).attrs.open).toBeUndefined();
    expect(calls.start).toHaveLength(0);
  });

  it("closes it again on a flow change", async () => {
    data.flows = [flow("a", [field("o")]), flow("b", [field("p")])];
    data.startFail = Object.assign(new Error("bad"), { status: 400 });
    await open();
    await submit(main);
    expect(one(main, "details", { class: "start-more" }).attrs.open).toBe("");
    flowRadios(main)[1]!.fire("change");
    expect(one(main, "details", { class: "start-more" }).attrs.open).toBeUndefined();
  });

  it("keeps the flow picker off while sending, so a late refusal opens the sent flow's options", async () => {
    data.flows = [flow("a", [field("o")]), flow("b", [field("p")])];
    data.startFail = Object.assign(new Error("bad"), { status: 400 });
    data.hold = true;
    await open();
    one(main, "input", { name: "o" }).value = "typed";
    const radios = flowRadios(main);
    const sent = submit(main);
    await flush();
    expect(radios.every((r) => (r as any).disabled)).toBe(true);
    radios[1]!.fire("change");
    expect(find(main, "input", { name: "p" })).toHaveLength(0);
    await sent;
    release();
    await flush();
    expect(one(main, "details", { class: "start-more" }).attrs.open).toBe("");
    expect(one(main, "input", { name: "o" }).value).toBe("typed");
    expect(flowRadios(main).every((r) => !(r as any).disabled)).toBe(true);
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
    main = document.createElement("div") as unknown as FakeElement;
    const opened = ui.renderStart(main, { a: fakeApi(), dialog, go });
    await flush();
    await chooseFlow(main);
    expect(main.textContent).toContain("Repository (required)");
    releaseRepos();
    await opened;
  });

  it("puts a fixed repository into the disclosure, without a select", async () => {
    data.flows = [flow("a", [field("github_repo", { mode: "fixed", value: "me/fixed" })])];
    await open();
    expect(one(main, "details", { class: "start-more" }).textContent).toContain("me/fixed");
    expect(find(main, "select")).toHaveLength(0);
  });

  it("draws the disclosure but no Start button in the read-only preview", async () => {
    data.flows = [flow("a", [field("o")])];
    main = document.createElement("div") as unknown as FakeElement;
    await ui.renderStart(main, { a: fakeApi(), dialog, go, readOnly: true });
    await chooseFlow(main);
    expect(find(main, "details", { class: "start-more" })).toHaveLength(1);
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
    await open(true, true);
    expect(main.textContent).toContain(draft.NO_FLOWS_NOTE);
    expect(one(main, "a", { href: "#/flows" }).textContent).toBe("Open the flow editor");
    expect(find(main, "div", { class: "empty" })).toHaveLength(0);
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
  const checkedIn = (root: FakeElement) => find(root, "input", { name: "flow" }).filter((r) => (r as any).checked).map((r) => (r as any).value);
  const checked = () => checkedIn(main);

  it("chooses the flow that was wished before the page was drawn", async () => {
    wishes.sendWish("start", { flow: "b" });
    await open(undefined, true);
    expect(checked()).toEqual(["b"]);
    expect(one(main, "details", { class: "composer-advanced" }).attrs.open).toBe("");
    expect(wishes.takeWish("start")).toBeNull();
  });

  it("makes a plan for an unknown name, and uses the wish up when there are no flows", async () => {
    wishes.sendWish("start", { flow: "nope" });
    await open(undefined, true);
    expect(checked()).toEqual([""]);
    data.flows = [];
    wishes.sendWish("start", { flow: "b" });
    await open(undefined, true);
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
    const opening = open(undefined, true);
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
    await open(undefined, true);
    expect(checked()).toEqual(["b"]);
    finishOld();
    const cleanOld = await oldRender;
    // the older render did not take the wish: it makes a plan
    expect(checkedIn(mainOld)).toEqual([""]);
    cleanOld();
    // the older render's cleanup does not remove the handler of the newer page
    wishes.sendWish("start", { flow: "a" });
    await flush();
    expect(checked()).toEqual(["a"]);
  });
});

describe("renderStart: make a plan", () => {
  const press = (el: FakeElement | undefined) => {
    expect(el, "control").toBeDefined();
    el!.click();
  };
  const type = (text: string) => {
    const box = one(main, "textarea", { name: "task" });
    box.value = text;
    box.fire("input");
  };
  const kind = (k: string) => {
    const r = find(main, "input", { name: "start-point" }).find((x) => x.value === k)!;
    (r as any).checked = true;
    r.fire("change");
  };
  const plan = async () => {
    one(main, "form").fire("submit", { preventDefault() {} });
    await flush();
  };
  const advanced = () => one(main, "details", { class: "composer-advanced" });
  const unsure = () => Object.assign(new Error("down"), { status: 503 });

  it("draws the composer before the flows or the repositories have answered", async () => {
    data.flows = [flow("a")];
    data.holdRepos = true;
    main = document.createElement("div") as unknown as FakeElement;
    let finishFlows!: () => void;
    const slow = { ...fakeApi(), flows: () => new Promise<any[]>((r) => { finishFlows = () => r(data.flows); }) };
    const opening = ui.renderStart(main, { a: slow, dialog, go });
    expect(one(main, "textarea", { name: "task" })).toBeDefined();
    expect(one(main, "label", { class: "field composer" }).textContent).toContain("What would you like to change?");
    expect(submitBtn(main).textContent).toBe("Make a plan");
    expect(find(main, "input", { name: "start-point" }).map((r) => r.value)).toEqual(["idea", "issue", "conversation"]);
    expect(find(main, "div", { class: "empty" })).toHaveLength(0);
    expect(find(main, "div", { role: "alert" })).toHaveLength(0);
    finishFlows();
    releaseRepos();
    await opening;
  });

  it("a new idea sends the change request and opens the change page of the repository", async () => {
    data.repos = [repo("r1", "acme/app")];
    await open(undefined, true);
    expect(main.textContent).toContain("In acme/app");
    type("  Add dark mode  ");
    await plan();
    expect(calls.plan).toEqual([["createChange", { repo: "acme/app", text: "Add dark mode" }]]);
    expect(go).toHaveBeenCalledWith("#/change/r1");
    expect(draft.readDraft()).toBeNull();
  });

  it("asks for text first, and for nothing else before there is text", async () => {
    data.repos = [repo("r1", "acme/app")];
    await open(undefined, true);
    await plan();
    expect(one(main, "p", { role: "alert" }).textContent).toBe(entry.NEED_TEXT);
    expect(calls.plan).toHaveLength(0);
  });

  it("an existing change sends the issue number and opens the session; a 409 opens the existing one", async () => {
    data.repos = [repo("r1", "acme/app")];
    await open(undefined, true);
    kind("issue");
    type("#12");
    await plan();
    expect(calls.plan).toEqual([["createRefinement", { repo: "acme/app", issue: 12 }]]);
    expect(go).toHaveBeenCalledWith("#/refinement/s1");
    // the server answers 409 with the id of the session that is there (a string)
    go.mockClear();
    data.planFail = Object.assign(new Error("exists"), { status: 409, data: { error: "exists", session: "old 1" } });
    await open(undefined, true);
    kind("issue");
    type("12");
    await plan();
    expect(go).toHaveBeenCalledWith("#/refinement/old%201");
    expect(document.getElementById("toast")!.textContent).toBe(entry.SESSION_EXISTS);
  });

  it("refuses a text that is not an issue number, and a local repository for an issue", async () => {
    data.repos = [{ id: "l1", url: "/x", method: "local", owner: "u1", localName: "mine" }];
    await open(undefined, true);
    kind("issue");
    type("abc");
    await plan();
    expect(one(main, "p", { role: "alert" }).textContent).toBe(entry.NEED_ISSUE_NUMBER);
    type("#0");
    await plan();
    expect(one(main, "p", { role: "alert" }).textContent).toBe(entry.NEED_ISSUE_NUMBER);
    type("#5");
    await plan();
    expect(one(main, "p", { role: "alert" }).textContent).toBe(entry.NEEDS_GITHUB);
    expect(advanced().attrs.open).toBe("");
    expect(calls.plan).toHaveLength(0);
  });

  it("a conversation lists the open sessions as links and has no Make a plan; a failed list has Retry", async () => {
    data.repos = [repo("r1", "acme/app")];
    data.sessions = [
      { id: "s1", title: "Old", state: "open", updated: "2026-01-01T00:00:00Z", mine: true },
      { id: "s2", title: "New", state: "open", updated: "2026-02-01T00:00:00Z", mine: true },
      { id: "s3", title: "Gone", state: "dropped", updated: "2026-03-01T00:00:00Z" },
      { id: "s4", title: "Not mine", state: "open", mine: false },
    ];
    await open(undefined, true);
    kind("conversation");
    await flush();
    expect(find(main, "a").filter((x) => String(x.attrs.href).startsWith("#/refinement/")).map((x) => [x.attrs.href, x.textContent])).toEqual([["#/refinement/s2", "New"], ["#/refinement/s1", "Old"]]);
    expect(find(main, "button", { type: "submit" })).toHaveLength(0);
    expect(find(main, "textarea")).toHaveLength(0);
    data.refFail = true;
    kind("idea");
    kind("conversation");
    await flush();
    expect(one(main, "button", { "data-focus": "retry" }).textContent).toBe("Retry");
    data.refFail = false;
    one(main, "button", { "data-focus": "retry" }).click();
    await flush();
    expect(find(main, "a", { href: "#/refinement/s2" })).toHaveLength(1);
  });

  it("starts in the repository of the top bar; Change opens Advanced at the repository choice", async () => {
    data.repos = [repo("r1", "acme/one"), repo("r2", "acme/two")];
    main = document.createElement("div") as unknown as FakeElement;
    await ui.renderStart(main, { a: fakeApi(), dialog, go, contextRepo: () => "ACME/two" });
    expect(main.textContent).toContain("In acme/two");
    expect(advanced().attrs.open).toBeUndefined();
    const select = one(main, "select", { name: "plan_repo" });
    expect(select.value).toBe("acme/two");
    press(one(main, "button", { "data-focus": "change-repo" }));
    expect(advanced().attrs.open).toBe("");
    expect((document as any).activeElement).toBe(select);
    select.value = "acme/one";
    select.fire("change");
    expect(main.textContent).toContain("In acme/one");
    type("x");
    await plan();
    expect(calls.plan[0][1].repo).toBe("acme/one");
  });

  it("says to add the repository only after Make a plan is pressed, and Add repository chooses the new one", async () => {
    data.repos = [];
    data.reposAfter = [repo("n1", "new/repo")];
    dialog = vi.fn(async () => ({ id: "n1", github: "new/repo" }));
    await open(undefined, true);
    expect(main.textContent).not.toContain(entry.NO_PLAN_REPO);
    type("An idea");
    await plan();
    expect(main.textContent).toContain(entry.NO_PLAN_REPO);
    expect(calls.plan).toHaveLength(0);
    press(one(main, "button", { "data-focus": "add-repo" }));
    await flush();
    await flush();
    expect(main.textContent).toContain("In new/repo");
    expect(one(main, "textarea", { name: "task" }).value).toBe("An idea");
    await plan();
    expect(calls.plan).toEqual([["createChange", { repo: "new/repo", text: "An idea" }]]);
  });

  it("keeps the text and turns the button on again when the plan is refused", async () => {
    data.repos = [repo("r1", "acme/app")];
    data.planFail = Object.assign(new Error("not allowed"), { status: 403 });
    await open(undefined, true);
    type("Keep me");
    await plan();
    expect(one(main, "div", { role: "alert" }).textContent).toContain(entry.PLAN_FAILED);
    expect(one(main, "textarea", { name: "task" }).value).toBe("Keep me");
    expect(submitBtn(main).disabled).toBe(false);
    expect(draft.readDraft()?.task).toBe("Keep me");
    expect(go).not.toHaveBeenCalled();
  });

  it("sends once for two presses", async () => {
    data.repos = [repo("r1", "acme/app")];
    data.holdPlan = true;
    await open(undefined, true);
    type("Once");
    await plan();
    expect(submitBtn(main).disabled).toBe(true);
    await plan();
    releasePlan();
    await flush();
    expect(calls.plan).toHaveLength(1);
    expect(go).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+Enter in the text box makes the plan", async () => {
    data.repos = [repo("r1", "acme/app")];
    await open(undefined, true);
    type("By key");
    one(main, "textarea", { name: "task" }).fire("keydown", { key: "Enter", ctrlKey: true, preventDefault() {} });
    await flush();
    expect(calls.plan).toHaveLength(1);
  });

  it("has no Make a plan in the read-only preview", async () => {
    data.repos = [repo("r1", "acme/app")];
    main = document.createElement("div") as unknown as FakeElement;
    await ui.renderStart(main, { a: fakeApi(), dialog, go, readOnly: true });
    expect(find(main, "button", { type: "submit" })).toHaveLength(0);
    type("preview");
    expect(draft.readDraft()).toBeNull();
  });

  it("keeps kind, repository and text across a new page, and Clear empties them", async () => {
    data.repos = [repo("r1", "acme/one"), repo("r2", "acme/two")];
    const cleanup = await open(undefined, true);
    kind("issue");
    one(main, "select", { name: "plan_repo" }).value = "acme/two";
    one(main, "select", { name: "plan_repo" }).fire("change");
    type("#7");
    cleanup();
    await open(undefined, true);
    expect(draft.readDraft()).toMatchObject({ kind: "issue", repo: "acme/two", task: "#7", flow: "" });
    expect(find(main, "input", { name: "start-point" }).filter((r) => (r as any).checked).map((r) => r.value)).toEqual(["issue"]);
    expect(one(main, "textarea", { name: "task" }).value).toBe("#7");
    expect(main.textContent).toContain("In acme/two");
    press(find(main, "button", { type: "button" }).find((b) => b.textContent === "Clear"));
    expect(draft.readDraft()).toBeNull();
    expect(one(main, "textarea", { name: "task" }).value).toBe("");
  });

  it("follows a change request the server saved although the answer was lost, and never makes a second one", async () => {
    data.repos = [repo("r1", "acme/app")];
    data.planFail = unsure();
    data.changes = [{ id: "c9", state: "questions", text: "Lost answer", updated: "2026-01-01T00:00:00Z" }];
    await open(undefined, true);
    type("Lost answer");
    await plan();
    expect(calls.plan).toHaveLength(1);
    expect(calls.changes).toEqual(["acme/app"]);
    expect(go).toHaveBeenCalledWith("#/change/r1");
  });

  it("keeps the text and reads again before another request when the outcome is not known", async () => {
    data.repos = [repo("r1", "acme/app")];
    data.planFail = unsure();
    data.changesFail = true;
    await open(undefined, true);
    type("Maybe saved");
    await plan();
    expect(one(main, "div", { role: "alert" }).textContent).toContain(ui.PLAN_UNSURE);
    expect(one(main, "textarea", { name: "task" }).value).toBe("Maybe saved");
    expect(draft.readDraft()?.task).toBe("Maybe saved");
    // pressing again does not create a second request while it cannot be told
    await plan();
    expect(calls.plan).toHaveLength(1);
    // nothing was saved: now it may be sent again
    data.changesFail = false;
    data.changes = [];
    data.planFail = undefined;
    await plan();
    expect(calls.plan).toHaveLength(2);
    expect(go).toHaveBeenCalledWith("#/change/r1");
  });

  it("a page that leaves late does not remove the guard of the page that replaced it", async () => {
    const reload = vi.fn();
    (globalThis as any).location = { hash: "#/start", reload };
    const { api, keepPage } = await import("../ui/api.js" as string);
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => ({ ok: false, status: 401, statusText: "x", json: async () => ({ error: "Sign in again." }) });
    try {
      const releaseOld = keepPage(() => false);
      const releaseNew = keepPage(() => true); // the newer page is typing
      releaseOld(); // the old page leaves late
      await api.repos().catch(() => undefined);
      expect(reload).not.toHaveBeenCalled();
      releaseNew();
      await api.repos().catch(() => undefined);
      expect(reload).toHaveBeenCalled();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("Clear cancels a flow restored from the cleared draft, even when the flows arrive later", async () => {
    data.repos = [repo("r1", "acme/app")];
    data.flows = [flow("f1")];
    draft.writeDraft({ flow: "f1", task: "Typed", kind: "idea", repo: "acme/app", values: {} });
    data.holdFlows = true;
    main = document.createElement("div") as unknown as FakeElement;
    const opening = ui.renderStart(main, { a: fakeApi(), dialog, go });
    await flush();
    press(find(main, "button", { type: "button" }).find((b) => b.textContent === "Clear"));
    releaseFlows();
    await opening;
    expect(flowRadios(main).some((r) => (r as any).checked)).toBe(false);
    expect(submitBtn(main).textContent).toBe("Make a plan");
  });

  it("does not reload the page on a 401 of a background read while text is typed", async () => {
    const reload = vi.fn();
    (globalThis as any).location = { hash: "#/start", reload };
    const { api } = await import("../ui/api.js" as string);
    const realFetch = globalThis.fetch;
    let answer!: () => void;
    (globalThis as any).fetch = () => new Promise((r) => { answer = () => r({ ok: false, status: 401, statusText: "x", json: async () => ({ error: "Sign in again." }) }); });
    try {
      main = document.createElement("div") as unknown as FakeElement;
      const opening = ui.renderStart(main, { a: { ...fakeApi(), repos: api.repos }, dialog, go });
      await flush();
      type("Typed before the answer");
      answer();
      const cleanup = await opening;
      expect(reload).not.toHaveBeenCalled();
      expect(one(main, "textarea", { name: "task" }).value).toBe("Typed before the answer");
      cleanup();
      // after the page is left the guard is off again
      const late = api.repos().catch(() => undefined);
      answer();
      await late;
      expect(reload).toHaveBeenCalled();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("does not go to the new page when the address changed while the plan was made", async () => {
    (globalThis as any).location = { hash: "#/start" };
    data.repos = [repo("r1", "acme/app")];
    data.holdPlan = true;
    await open(undefined, true);
    type("Slow");
    await plan();
    (globalThis as any).location.hash = "#/runs";
    releasePlan();
    await flush();
    expect(go).not.toHaveBeenCalled();
    expect(document.getElementById("toast")!.textContent).toBe("Your change was sent");
    (globalThis as any).location.hash = "#/start";
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
        find(modalRoot(), "button").find((b) => b.textContent === "Next")!.click();
        one(modalRoot(), "input", { name: "token" }).value = "t".repeat(40);
        find(modalRoot(), "button").find((b) => b.textContent === "Add repository")!.click();
        await flush();
        await flush();
        // this fetch has no test route: the test cannot run, and the dialog still resolves with the record
        find(modalRoot(), "button").find((b) => b.textContent === "Done")!.click();
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
