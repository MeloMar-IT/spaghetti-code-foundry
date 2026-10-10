import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

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
const repo = (id: string, github: string) => ({ id, url: `https://github.com/${github}`, method: "none", owner: "u1", github });
const err = (message: string, status: number) => Object.assign(new Error(message), { status });

const flush = () => new Promise((r) => setTimeout(r, 0));
const find = (root: FakeElement, tag: string, attrs: Record<string, string> = {}) =>
  root.all(tag).filter((el) => Object.entries(attrs).every(([k, v]) => el.attrs[k] === v));
const one = (root: FakeElement, tag: string, attrs: Record<string, string> = {}) => {
  const [el] = find(root, tag, attrs);
  if (!el) throw new Error(`no ${tag} ${JSON.stringify(attrs)}`);
  return el;
};
const submitBtn = (root: FakeElement) => one(root, "button", { type: "submit" });
const submit = async (root: FakeElement) => {
  one(root, "form").fire("submit", { preventDefault() {} });
  await flush();
};
const radios = (root: FakeElement) => find(root, "input", { name: "flow" });
const failBoxes = (root: FakeElement) => find(root, "div", { role: "alert" });

type Answers = (unknown | undefined)[];
let main: FakeElement;
let go: ReturnType<typeof vi.fn>;
let data: { flows: any[]; repos: any[] };
let calls: { flows: number; repos: number; start: any[] };
let flowsAnswers: Answers;
let reposAnswers: Answers;
let startAnswers: Answers;
let gateFlows: (() => void) | null;
let gateRepos: (() => void) | null;
let gateStart: (() => void) | null;
let gating: { flows: boolean; repos: boolean; start: boolean };

const answer = (queue: Answers, fallback: any) => {
  const next = queue.shift();
  if (next instanceof Error) throw next;
  return next === undefined ? fallback : next;
};

const fakeApi = () => ({
  flows: async () => {
    calls.flows++;
    if (gating.flows) await new Promise<void>((r) => (gateFlows = r));
    return answer(flowsAnswers, data.flows);
  },
  repos: async () => {
    calls.repos++;
    if (gating.repos) await new Promise<void>((r) => (gateRepos = r));
    return answer(reposAnswers, data.repos);
  },
  repoMethods: async () => ({ methods: [] }),
  startRun: async (body: unknown) => {
    calls.start.push(body);
    if (gating.start) await new Promise<void>((r) => (gateStart = r));
    return answer(startAnswers, { runId: "r1", queued: true });
  },
});

async function open(opts: object = {}, wait = true) {
  main = document.createElement("div") as unknown as FakeElement;
  const p = ui.renderStart(main, { a: fakeApi(), dialog: async () => undefined, go, ...opts });
  if (!wait) return p;
  return (await p) as () => void;
}

beforeEach(() => {
  go = vi.fn();
  data = { flows: [], repos: [] };
  calls = { flows: 0, repos: 0, start: [] };
  flowsAnswers = [];
  reposAnswers = [];
  startAnswers = [];
  gateFlows = gateRepos = gateStart = null;
  gating = { flows: false, repos: false, start: false };
  (document as any).activeElement = null;
});

describe("explainStart", () => {
  it("keeps the standard sentence and adds what is kept", () => {
    const info = ui.explainStart(err("no", 403));
    expect(info.kind).toBe("permission");
    expect(info.what.startsWith(ui.START_FAILED)).toBe(true);
    expect(info.safe.endsWith(ui.START_KEPT)).toBe(true);
  });

  it("says the run may exist when there was no answer or a 5xx", () => {
    for (const e of [new TypeError("x"), err("down", 503)]) {
      const info = ui.explainStart(e);
      expect(info.safe).toBe(ui.START_UNSURE);
      expect(info.next).toBe(ui.START_UNSURE_NEXT);
      expect(info.what.startsWith(ui.START_FAILED)).toBe(true);
    }
  });
});

describe("renderStart: flows", () => {
  it("draws a skeleton under the heading while the flows load", async () => {
    data.flows = [flow("a")];
    gating.flows = true;
    const p = open({}, false);
    await flush();
    expect(one(main, "h1").textContent).toBe("Start work");
    const box = one(main, "div", { role: "status" });
    expect(box.attrs["aria-busy"]).toBe("true");
    expect(box.textContent).toContain("Loading the flows");
    expect(find(main, "form")).toHaveLength(0);
    gateFlows!();
    await p;
    expect(find(main, "form")).toHaveLength(1);
    expect(find(main, "div", { role: "status" })).toHaveLength(0);
  });

  it("explains a failing flows call, offers Retry and draws the form after it", async () => {
    data.flows = [flow("a")];
    flowsAnswers = [err("db down", 500)];
    await open();
    const box = one(main, "div", { class: "state-error" });
    expect(box.attrs["data-kind"]).toBe("server");
    expect(box.textContent).toContain(ui.FLOWS_FAILED);
    expect(box.textContent).toContain("db down");
    expect(find(main, "button")).toHaveLength(1);
    expect(find(main, "form")).toHaveLength(0);
    one(main, "button", { "data-focus": "retry" }).click();
    await flush();
    expect(calls.flows).toBe(2);
    expect(find(main, "form")).toHaveLength(1);
  });

  it("says when the server cannot be reached, and Retry works", async () => {
    data.flows = [flow("a")];
    flowsAnswers = [new TypeError("fetch failed")];
    await open();
    const box = one(main, "div", { class: "state-error" });
    expect(box.attrs["data-kind"]).toBe("offline");
    expect(box.textContent).toContain("The server could not be reached.");
    one(main, "button", { "data-focus": "retry" }).click();
    await flush();
    expect(find(main, "form")).toHaveLength(1);
  });

  it("shows a permission box without a button on a 403", async () => {
    flowsAnswers = [err("no", 403)];
    await open();
    const box = one(main, "div", { class: "state-error state-permission" });
    expect(box.textContent).toContain(ui.FLOWS_DENIED);
    expect(find(main, "button")).toHaveLength(0);
  });

  it("shows the error again when Retry fails again, and never rejects", async () => {
    flowsAnswers = [err("one", 500), err("two", 500)];
    await open();
    one(main, "button", { "data-focus": "retry" }).click();
    await flush();
    expect(one(main, "div", { class: "state-error" }).textContent).toContain("two");
  });

  it("draws nothing after cleanup when a Retry finishes late", async () => {
    flowsAnswers = [err("one", 500)];
    data.flows = [flow("a")];
    const cleanup = await open();
    gating.flows = true;
    one(main, "button", { "data-focus": "retry" }).click();
    await flush();
    expect(find(main, "div", { role: "status" })).toHaveLength(1);
    cleanup();
    gateFlows!();
    await flush();
    expect(find(main, "form")).toHaveLength(0);
    expect(find(main, "div", { role: "status" })).toHaveLength(1);
  });

  it("says what to do with no flows: a user asks the administrator", async () => {
    await open();
    expect(one(main, "div", { class: "empty" }).textContent).toContain(ui.NO_FLOWS);
    expect(find(main, "a")).toHaveLength(0);
  });

  it("links an admin to the flow editor", async () => {
    await open({ admin: true });
    expect(one(main, "div", { class: "empty" }).textContent).toContain(ui.NO_FLOWS_ADMIN);
    expect(one(main, "a", { href: "#/flows" })).toBeTruthy();
  });

  it("treats an answer that is not a list as no flows", async () => {
    flowsAnswers = [{ nope: true }];
    await open();
    expect(one(main, "div", { class: "empty" }).textContent).toContain(ui.NO_FLOWS);
  });
});

describe("renderStart: repositories", () => {
  it("shows a skeleton in the repository part, keeps Start off and typed values", async () => {
    data.flows = [flow("a", [field("github_repo"), field("x")])];
    data.repos = [repo("1", "a/a")];
    gating.repos = true;
    const p = open({}, false);
    await flush();
    expect(find(main, "form")).toHaveLength(1);
    expect(one(main, "div", { role: "status" }).textContent).toContain("Loading your repositories");
    expect(submitBtn(main).disabled).toBe(true);
    const input = one(main, "input", { name: "x" });
    input.value = "typed";
    one(main, "textarea").value = "task";
    await submit(main);
    expect(calls.start).toHaveLength(0);
    gateRepos!();
    await p;
    expect(find(main, "div", { role: "status" })).toHaveLength(0);
    expect(one(main, "select").value).toBe("a/a");
    expect(one(main, "input", { name: "x" })).toBe(input);
    expect(input.value).toBe("typed");
    expect(one(main, "textarea").value).toBe("task");
    expect(submitBtn(main).disabled).toBe(false);
  });

  it("says what to do with no repository, with Add repository inside the repository part", async () => {
    data.flows = [flow("a", [field("github_repo")])];
    await open();
    const box = one(main, "div", { class: "empty" });
    expect(box.textContent).toContain(ui.NO_REPOS);
    expect(find(box, "button", { "data-focus": "add-repo" })).toHaveLength(1);
  });

  it("explains a failed list in the repository part only; other flows still start", async () => {
    data.flows = [flow("a", [field("github_repo")]), flow("b")];
    reposAnswers = [err("repo list broken", 500)];
    await open();
    const box = one(main, "div", { class: "state-error" });
    expect(box.textContent).toContain(ui.REPOS_FAILED);
    expect(box.textContent).toContain(ui.REPOS_FAILED_SAFE);
    expect(find(box, "button", { "data-focus": "retry-repos" })).toHaveLength(1);
    expect(main.textContent).not.toContain(ui.NO_REPOS);
    expect(radios(main)).toHaveLength(2);
    radios(main)[1]!.fire("change");
    await flush();
    await submit(main);
    expect(calls.start).toEqual([{ flow: "b", task: "", vars: {} }]);
  });

  it("Retry on the list shows the skeleton, then the repositories, and keeps typed values", async () => {
    data.flows = [flow("a", [field("github_repo"), field("x")])];
    data.repos = [repo("1", "a/a")];
    reposAnswers = [err("broken", 500)];
    await open();
    one(main, "input", { name: "x" }).value = "typed";
    gating.repos = true;
    one(main, "button", { "data-focus": "retry-repos" }).click();
    await flush();
    expect(main.textContent).toContain("Loading your repositories");
    expect(submitBtn(main).disabled).toBe(true);
    gateRepos!();
    await flush();
    expect(calls.repos).toBe(2);
    expect(one(main, "select").value).toBe("a/a");
    expect(one(main, "input", { name: "x" }).value).toBe("typed");
    expect(submitBtn(main).disabled).toBe(false);
  });

  it("shows the skeleton and keeps Start off while the list reloads after Add repository", async () => {
    data.flows = [flow("a", [field("github_repo"), field("x")])];
    data.repos = [repo("1", "a/a")];
    const created = repo("2", "n/new");
    await open({ dialog: async () => created });
    one(main, "input", { name: "x" }).value = "typed";
    gating.repos = true;
    reposAnswers = [undefined];
    data.repos = [repo("1", "a/a"), created];
    one(main, "button", { "data-focus": "add-repo" }).click();
    await flush();
    expect(main.textContent).toContain("Loading your repositories");
    expect(submitBtn(main).disabled).toBe(true);
    await submit(main);
    expect(calls.start).toHaveLength(0);
    gateRepos!();
    await flush();
    expect(one(main, "select").value).toBe("n/new");
    expect(one(main, "input", { name: "x" }).value).toBe("typed");
    expect(submitBtn(main).disabled).toBe(false);
  });

  it("asks again when a flow is chosen after a failed list", async () => {
    data.flows = [flow("a"), flow("b", [field("github_repo")])];
    data.repos = [repo("1", "a/a")];
    reposAnswers = [err("broken", 500)];
    await open();
    radios(main)[1]!.fire("change");
    await flush();
    expect(calls.repos).toBe(1);
    expect(find(main, "div", { class: "state-error" })).toHaveLength(1);
    radios(main)[0]!.fire("change");
    radios(main)[1]!.fire("change");
    await flush();
    expect(calls.repos).toBe(2);
    expect(one(main, "select").value).toBe("a/a");
  });

  it("asks once for two quick switches while the list is pending", async () => {
    data.flows = [flow("a"), flow("b", [field("github_repo")])];
    data.repos = [repo("1", "a/a")];
    await open();
    gating.repos = true;
    radios(main)[1]!.fire("change");
    radios(main)[0]!.fire("change");
    radios(main)[1]!.fire("change");
    await flush();
    expect(calls.repos).toBe(1);
    gateRepos!();
    await flush();
    expect(one(main, "select").value).toBe("a/a");
  });
});

describe("renderStart: a failed start", () => {
  const setup = async () => {
    data.flows = [flow("a", [field("github_repo"), field("x")]), flow("b")];
    data.repos = [repo("1", "a/a"), repo("2", "b/b")];
    await open();
    one(main, "input", { name: "x" }).value = "typed";
    one(main, "textarea").value = "my task";
    one(main, "select").value = "b/b";
  };

  it("explains the failure, keeps every value and sends the same body again", async () => {
    startAnswers = [err("bad input", 400)];
    await setup();
    await submit(main);
    const boxes = failBoxes(main).filter((b) => b.tag === "div");
    expect(boxes).toHaveLength(1);
    const box = boxes[0]!;
    expect(one(box, "p", { class: "state-what" }).textContent).toContain("bad input");
    expect(one(box, "p", { class: "state-safe" })).toBeTruthy();
    expect(one(box, "p", { class: "state-next" })).toBeTruthy();
    expect(find(box, "button")).toHaveLength(0);
    expect(one(main, "textarea").value).toBe("my task");
    expect(one(main, "input", { name: "x" }).value).toBe("typed");
    expect(one(main, "select").value).toBe("b/b");
    expect(radios(main)[0]!.checked).toBe(true);
    expect(submitBtn(main).disabled).toBe(false);
    gating.start = true;
    await submit(main);
    expect(failBoxes(main).filter((b) => b.tag === "div")).toHaveLength(0);
    gateStart!();
    await flush();
    expect(calls.start[1]).toEqual(calls.start[0]);
    expect(go).toHaveBeenCalledWith("#/runs/r1");
  });

  it("says the run may have started when there was no answer or a 500", async () => {
    startAnswers = [new TypeError("x"), err("boom", 500)];
    await setup();
    for (let i = 0; i < 2; i++) {
      await submit(main);
      const box = failBoxes(main).find((b) => b.tag === "div")!;
      expect(one(box, "p", { class: "state-safe" }).textContent).toBe(ui.START_UNSURE);
      expect(one(box, "p", { class: "state-next" }).textContent).toBe(ui.START_UNSURE_NEXT);
    }
  });

  it("clears the explanation on a flow change", async () => {
    startAnswers = [err("bad input", 400)];
    await setup();
    await submit(main);
    radios(main)[1]!.fire("change");
    expect(failBoxes(main).filter((b) => b.tag === "div")).toHaveLength(0);
  });

  it("shows a field problem in its own line, not in the explanation", async () => {
    startAnswers = [err("bad input", 400)];
    data.flows = [flow("a", [field("x", { required: true, label: "Ticket" })])];
    await open();
    one(main, "input", { name: "x" }).value = "v";
    await submit(main);
    expect(failBoxes(main).filter((b) => b.tag === "div")).toHaveLength(1);
    one(main, "input", { name: "x" }).value = "";
    await submit(main);
    expect(one(main, "p", { role: "alert" }).textContent).toBe('Fill in "Ticket".');
    expect(failBoxes(main).filter((b) => b.tag === "div")).toHaveLength(0);
  });

  it("sends likeUser as an admin, also the second time", async () => {
    startAnswers = [err("bad input", 400)];
    data.flows = [flow("a")];
    await open({ admin: true });
    await submit(main);
    await submit(main);
    expect(calls.start.map((b) => b.likeUser)).toEqual([true, true]);
  });
});

describe("renderStart: read-only preview", () => {
  const noButtons = () => {
    expect(find(main, "button", { type: "submit" })).toHaveLength(0);
    expect(find(main, "button", { "data-focus": "add-repo" })).toHaveLength(0);
  };

  it("shows no Start and no Add repository in any state", async () => {
    gating.flows = true;
    data.flows = [flow("a", [field("github_repo")])];
    const p = open({ readOnly: true }, false);
    await flush();
    noButtons();
    gating.flows = false;
    gateFlows!();
    await p;
    noButtons();
    await submit(main);
    expect(calls.start).toHaveLength(0);

    data.repos = [];
    await open({ readOnly: true });
    noButtons();

    data.flows = [];
    await open({ readOnly: true });
    noButtons();

    data.flows = [flow("a", [field("github_repo")])];
    reposAnswers = [err("broken", 500)];
    await open({ readOnly: true });
    noButtons();
    expect(find(main, "button", { "data-focus": "retry-repos" })).toHaveLength(1);
  });
});
