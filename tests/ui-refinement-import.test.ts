import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
let imp: any;
let api: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/refinement.js" as string);
  imp = await import("../ui/refinement-import.js" as string);
  api = (await import("../ui/api.js" as string)).api;
});
afterAll(() => restore());

type Answer = { status: number; error: string } | "throw";
let sessions: any[];
let repos: string[];
let sent: { method: string; url: string; body: any }[];
let answers: Answer[];
let hold: { release: (a?: Answer) => void } | undefined;
let holdNext: boolean;
const realFetch = globalThis.fetch;

const session = (over: object = {}) => ({
  id: "s1",
  repo: "acme/app",
  repoAvailable: true,
  title: "My idea",
  idea: "Line one\nLine two",
  state: "exploring",
  drafts: [],
  log: [{ at: new Date().toISOString(), what: "created", who: "Ann" }],
  created: new Date().toISOString(),
  updated: new Date().toISOString(),
  mine: true,
  ...over,
});
const dropped = (over: object = {}) => session({ state: "dropped", droppedAt: new Date().toISOString(), removedOn: new Date(Date.now() + 30 * 864e5).toISOString(), ...over });

beforeEach(async () => {
  sessions = [];
  repos = ["acme/app"];
  sent = [];
  answers = [];
  hold = undefined;
  holdNext = false;
  (globalThis as any).location = { hash: "#/refinement" };
  (document as any).getElementById("modal-root").replaceChildren();
  (document as any).listeners.keydown = [];
  (document as any).getElementById("toast").textContent = "";
  const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: "x", json: async () => body });
  (globalThis as any).fetch = async (url: string, init: { method: string; body?: string }) => {
    if (init.method === "GET") {
      if (url === "/api/refinement") return reply({ sessions: [...sessions], repos });
      const found = sessions.find((s) => `/api/refinement/${s.id}` === url);
      return found ? reply(found) : reply({ error: "no such refinement session" }, 404);
    }
    const body = init.body ? JSON.parse(init.body) : undefined;
    sent.push({ method: init.method, url, body });
    let answer = answers.shift();
    if (holdNext) {
      holdNext = false;
      answer = await new Promise<Answer | undefined>((r) => (hold = { release: r }));
    }
    if (answer === "throw") throw new TypeError("fetch failed");
    if (answer) return reply({ error: answer.error }, answer.status);
    if (url === "/api/refinement") return reply(session({ id: "new1", title: "T" }), 201);
    return reply(session()); // a session without a source: the build label is gone
  };
  await ui.renderRefinement(main(), {});
  press(button(main(), "Open sessions"));
  await flush();
  sent = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const flush = () => new Promise((r) => setTimeout(r, 0));
const main = () => (document as any).getElementById("main") as FakeElement;
const root = () => (document as any).getElementById("modal-root") as FakeElement;
const toastText = () => (document as any).getElementById("toast").textContent as string;
const walk = (el: FakeElement): FakeElement[] => el.children.flatMap((c) => (c instanceof FakeElement ? [c, ...walk(c)] : []));
const field = (el: FakeElement, name: string) => walk(el).find((e) => e.attrs.name === name);
const button = (el: FakeElement, text: string) => walk(el).find((e) => e.tag === "button" && e.textContent === text);
const press = (el: FakeElement | undefined) => {
  expect(el, "control").toBeDefined();
  el!.click();
};
const bad = (el: FakeElement) => walk(el).filter((e) => e.attrs.class === "status bad").map((e) => e.textContent);
const showList = async (readOnly = false) => void (await ui.renderRefinement(main(), { readOnly }));
const showPage = async (id = "s1", admin = false) => {
  (globalThis as any).location.hash = `#/refinement/${id}`;
  await ui.renderRefinement(main(), { admin, id });
};

const SOURCE = { issue: 12, url: "https://github.com/acme/app/issues/12", title: "T", body: "", updatedAt: "2026-01-01T00:00:00.000Z" };
const WARNING = /This issue has the build label "Factory_go"/;

describe("pure functions", () => {
  it("issueNumber", () => {
    expect(imp.issueNumber("12")).toBe(12);
    expect(imp.issueNumber(" #12 ")).toBe(12);
    expect(imp.issueNumber("2147483647")).toBe(2147483647);
    for (const v of ["", "0", "1.5", "abc", "-3", "99999999999", "2147483648"]) expect(imp.issueNumber(v), v).toBeUndefined();
  });
  it("importProblem and importBody", () => {
    expect(imp.importProblem({ repo: "", issue: "1" })).toBe("Choose a repository.");
    expect(imp.importProblem({ repo: "a/b", issue: " " })).toBe("Give the issue number.");
    expect(imp.importProblem({ repo: "a/b", issue: "abc" })).toBe("The issue number is a whole number from 1, for example 12.");
    expect(imp.importProblem({ repo: "a/b", issue: "#12" })).toBe("");
    expect(imp.importBody({ repo: "acme/app", issue: "#12" })).toEqual({ repo: "acme/app", issue: 12 });
  });
  it("importLogText", () => {
    expect(imp.importLogText({ what: "imported", who: "Ann", detail: "#12" })).toBe("Ann started the session from issue #12");
    expect(imp.importLogText({ what: "source-label-removed", who: "Ann", detail: "Factory_go" })).toBe('Ann removed the build label "Factory_go" from the issue');
    expect(imp.importLogText({ what: "created" })).toBe("");
    expect(ui.logText({ what: "imported", who: "Ann", detail: "#12" })).toBe("Ann started the session from issue #12");
  });
  it("removeBuildLabel calls the route", async () => {
    await api.removeBuildLabel("a b");
    expect(sent).toEqual([{ method: "POST", url: "/api/refinement/a%20b/source/remove-build-label", body: {} }]);
  });
});

describe("the dialog", () => {
  const open = async () => {
    await showList();
    press(button(main(), "Refine an existing issue"));
  };
  const ask = async (issue: string) => {
    await open();
    field(root(), "issue")!.value = issue;
    const go = button(root(), "Refine issue")!;
    press(go);
    await flush();
    return go;
  };
  it("is on the list, and not in a preview", async () => {
    await showList();
    expect(button(main(), "Refine an existing issue")).toBeDefined();
    await showList(true);
    expect(button(main(), "Refine an existing issue")).toBeUndefined();
  });
  it("offers the repositories", async () => {
    repos = ["a/one", "b/two"];
    await open();
    expect(walk(root()).filter((e) => e.tag === "option").map((e) => e.textContent)).toEqual(["a/one", "b/two"]);
  });
  it("shows a hint and a link when there is no repository", async () => {
    repos = [];
    await open();
    expect(root().textContent).toContain("You need a GitHub repository first.");
    expect(walk(root()).some((e) => e.tag === "a" && e.attrs.href === "#/repos")).toBe(true);
    expect(field(root(), "issue")).toBeUndefined();
  });
  it("needs a number and sends nothing without one", async () => {
    await ask("");
    expect(bad(root())).toEqual(["Give the issue number."]);
    root().replaceChildren();
    await ask("abc");
    expect(bad(root())).toEqual(["The issue number is a whole number from 1, for example 12."]);
    root().replaceChildren();
    await ask("2147483648");
    expect(bad(root())).toEqual(["The issue number is a whole number from 1, for example 12."]);
    expect(sent).toEqual([]);
  });
  it("sends the number and opens the session", async () => {
    await ask("#12");
    expect(sent).toEqual([{ method: "POST", url: "/api/refinement", body: { repo: "acme/app", issue: 12 } }]);
    expect((globalThis as any).location.hash).toBe("#/refinement/new1");
  });
  it.each([
    [409, "issue #12 cannot be refined: the Foundry is building it now"],
    [409, "issue #12 is closed; reopen it on GitHub first"],
    [404, "issue #12 does not exist in acme/app"],
    [409, 'issue #12 already has an open refinement session: "T"'],
  ])("shows the refusal %i and stays open", async (status, error) => {
    answers.push({ status, error });
    const go = await ask("12");
    expect(bad(root())).toEqual([error]);
    expect(root().children.length).toBeGreaterThan(0);
    expect(go.disabled).toBe(false);
    expect((globalThis as any).location.hash).toBe("#/refinement");
  });
  it("says when the server cannot be reached", async () => {
    answers.push("throw");
    await ask("12");
    expect(bad(root())).toEqual(["Could not reach the server."]);
  });
  it("sends one request for two clicks", async () => {
    await open();
    field(root(), "issue")!.value = "12";
    holdNext = true;
    const go = button(root(), "Refine issue");
    press(go);
    press(go);
    await flush();
    hold!.release();
    await flush();
    expect(sent).toHaveLength(1);
  });
});

describe("the source line and the warning", () => {
  it("shows where the session came from, with a link", async () => {
    sessions = [session({ source: SOURCE })];
    await showPage();
    expect(main().textContent).toContain("From issue #12");
    const a = walk(main()).find((e) => e.tag === "a" && e.attrs.href === SOURCE.url);
    expect(a?.textContent).toBe("#12");
  });
  it("shows no link for a url that is not https", async () => {
    sessions = [session({ source: { ...SOURCE, url: "javascript:alert(1)" } })];
    await showPage();
    expect(main().textContent).toContain("From issue #12");
    expect(walk(main()).some((e) => e.tag === "a" && e.textContent === "#12")).toBe(false);
  });
  it("shows nothing for a session from an idea", async () => {
    sessions = [session()];
    await showPage();
    expect(main().textContent).not.toContain("From issue");
  });
  it("warns about the build label and removes it only on the press", async () => {
    sessions = [session({ source: { ...SOURCE, buildLabel: "Factory_go" } })];
    await showPage();
    expect(main().textContent).toMatch(WARNING);
    expect(sent).toEqual([]);
    press(button(main(), "Remove the build label"));
    await flush();
    expect(sent).toEqual([{ method: "POST", url: "/api/refinement/s1/source/remove-build-label", body: {} }]);
    expect(main().textContent).not.toMatch(WARNING);
    expect(button(main(), "Remove the build label")).toBeUndefined();
    expect(toastText()).toBe("Build label removed");
  });
  it("shows no warning without the label", async () => {
    sessions = [session({ source: SOURCE })];
    await showPage();
    expect(main().textContent).not.toContain("build label");
  });
  it("shows the warning but no button to an admin who is not the owner", async () => {
    sessions = [session({ mine: false, source: { ...SOURCE, buildLabel: "Factory_go" } })];
    await showPage("s1", true);
    expect(main().textContent).toMatch(WARNING);
    expect(button(main(), "Remove the build label")).toBeUndefined();
  });
  it("shows no button for a dropped session", async () => {
    sessions = [dropped({ source: { ...SOURCE, buildLabel: "Factory_go" } })];
    await showPage();
    expect(button(main(), "Remove the build label")).toBeUndefined();
  });
  it("keeps the warning when the call fails", async () => {
    sessions = [session({ source: { ...SOURCE, buildLabel: "Factory_go" } })];
    await showPage();
    answers.push({ status: 502, error: "GitHub did not remove the label: boom" });
    press(button(main(), "Remove the build label"));
    await flush();
    expect(toastText()).toBe("GitHub did not remove the label: boom");
    expect(main().textContent).toMatch(WARNING);
  });
});
