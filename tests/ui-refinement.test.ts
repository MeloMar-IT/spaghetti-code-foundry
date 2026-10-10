import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";
import { answerDialog, autoDialog, dialogText } from "./helpers/confirm-dialog.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
let api: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/refinement.js" as string);
  api = (await import("../ui/api.js" as string)).api;
});
afterAll(() => restore());

type Answer = { status: number; error: string } | "throw";
let sessions: any[];
let repos: string[];
let sent: { method: string; url: string; body: any }[];
let gets: string[];
let answers: Answer[];
let hold: { release: (a?: Answer) => void } | undefined;
let holdNext: boolean;
const realFetch = globalThis.fetch;
let stopDialog: (() => void) | undefined;
let confirmAnswer = true;

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
  gets = [];
  answers = [];
  hold = undefined;
  holdNext = false;
  confirmAnswer = true;
  (globalThis as any).location = { hash: "#/refinement" };
  stopDialog = autoDialog(() => confirmAnswer);
  (document as any).getElementById("modal-root").replaceChildren();
  (document as any).listeners.keydown = [];
  (document as any).getElementById("toast").textContent = "";
  const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: "x", json: async () => body });
  (globalThis as any).fetch = async (url: string, init: { method: string; body?: string }) => {
    if (init.method === "GET") {
      gets.push(url);
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
    if (url === "/api/refinement") return reply(session({ id: "new1", title: body.title ?? "T" }), 201);
    return reply(session());
  };
  await ui.renderRefinement(main(), {});
  press(button(main(), "Open sessions"));
  await flush();
  sent = [];
  gets = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
  stopDialog?.();
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
const bad = (el: FakeElement) => walk(el).filter((e) => (e.attrs.class ?? "").split(" ").includes("status") && (e.attrs.class ?? "").split(" ").includes("bad")).map((e) => e.textContent);
const showList = async (admin = false) => void (await ui.renderRefinement(main(), { admin }));
const showPage = async (id = "s1", admin = false) => {
  (globalThis as any).location.hash = `#/refinement/${id}`;
  await ui.renderRefinement(main(), { admin, id });
};
const buttonsOf = () => walk(main()).filter((e) => e.tag === "button" && e.attrs.class?.includes("small")).map((e) => e.textContent);

describe("pure functions", () => {
  it("has the five states", () => {
    expect(Object.keys(ui.STATE_LABELS)).toEqual(["exploring", "drafting", "ready", "published", "dropped"]);
  });
  it("sessionProblem and sessionBody", () => {
    expect(ui.sessionProblem({ repo: "", idea: "x" })).toBe("Choose a repository.");
    expect(ui.sessionProblem({ repo: "a/b", idea: "  " })).toBe("Describe your idea.");
    expect(ui.sessionProblem({ repo: "a/b", idea: "x" })).toBe("");
    expect(ui.sessionBody({ repo: "a/b", idea: "x", title: "  " })).toEqual({ repo: "a/b", idea: "x" });
    expect(ui.sessionBody({ repo: "a/b", idea: "x", title: " T " })).toEqual({ repo: "a/b", idea: "x", title: "T" });
  });
  it("logText and errorText", () => {
    expect(ui.logText({ what: "created", who: "Ann" })).toBe("Ann started the session");
    expect(ui.logText({ what: "renamed", who: "Ann", detail: "New" })).toBe('Ann renamed it to "New"');
    expect(ui.logText({ what: "dropped", who: "an administrator" })).toBe("an administrator dropped the session");
    expect(ui.logText({ what: "restored", who: "Ann" })).toBe("Ann restored the session");
    expect(ui.logText({ what: "suggestion-asked", who: "Ann", detail: "title" })).toBe("Ann asked the architect for a suggestion for the title");
    expect(ui.logText({ what: "architect-suggested", detail: "notes" })).toBe("The architect made a suggestion for the notes");
    expect(ui.logText({ what: "suggestion-accepted", who: "Ann" })).toBe("Ann accepted a suggestion");
    expect(ui.logText({ what: "suggestion-rejected", who: "Ann", detail: "why" })).toBe("Ann rejected a suggestion for “so that …”");
    expect(ui.logText({ what: "review-asked", who: "Ann" })).toBe("Ann asked the architect to review a story draft");
    expect(ui.logText({ what: "architect-reviewed", detail: "2" })).toBe("The architect reviewed a story draft: 2 remarks");
    expect(ui.logText({ what: "moved-to-notes", who: "Ann", detail: "what" })).toBe("Ann moved “I want …” to the notes for the builder");
    expect(ui.errorText(new TypeError("x"))).toBe("Could not reach the server.");
    expect(ui.errorText(new Error("sentence"))).toBe("sentence");
    expect(ui.errorText({})).toBe("Something went wrong.");
  });
});

describe("the repository filter", () => {
  const titles = () => walk(main()).filter((e) => e.tag === "a" && (e.attrs.href ?? "").startsWith("#/refinement/s")).map((e) => e.textContent);
  const bars = () => walk(main()).filter((e) => (e.attrs.class ?? "").split(" ").includes("filter-bar"));
  const setup = () => {
    repos = ["acme/app", "acme/other"];
    sessions = [
      session({ id: "s1", title: "App open", repo: "acme/app" }),
      session({ id: "s2", title: "Other open", repo: "acme/other" }),
      dropped({ id: "s3", title: "App dropped", repo: "acme/app" }),
      dropped({ id: "s4", title: "Other dropped", repo: "acme/other" }),
    ];
  };
  const show = async (repo: string, go: (h: string) => void = () => {}) => {
    (globalThis as any).location = { hash: `#/refinement?repo=${encodeURIComponent(repo)}` };
    await ui.renderRefinement(main(), { query: { repo }, go });
  };
  const NOT_IN_LIST = "This repository is not in your list. It may have been removed, or you may not have access.";

  it("lists only that repository, open and dropped, and keeps the filter on reload", async () => {
    setup();
    await show("acme/app");
    expect(titles()).toEqual(["App open"]);
    expect(main().textContent).toContain("Repository: acme/app");
    gets = [];
    press(button(main(), "Dropped")); // reloads
    await flush();
    expect(gets).toEqual(["/api/refinement"]);
    expect(titles()).toEqual(["App dropped"]);
    expect(bars()).toHaveLength(1);
    press(button(main(), "Open sessions"));
    await flush();
  });

  it("draws the same page without a filter", async () => {
    setup();
    await showList();
    expect(bars()).toHaveLength(0);
    expect(titles()).toEqual(["App open", "Other open"]);
  });

  it("names the filter when the repository is known but the view is empty", async () => {
    repos = ["acme/app"];
    sessions = [];
    await show("acme/app");
    expect(main().textContent).toContain("No refinement sessions match Repository: acme/app.");
    press(button(main(), "Dropped"));
    await flush();
    expect(main().textContent).toContain("No dropped sessions match Repository: acme/app.");
    press(button(main(), "Open sessions"));
    await flush();
  });

  it("says the repository is not in the list, and clears without a new request", async () => {
    setup();
    const go = vi.fn();
    await show("gone/repo", go);
    expect(main().textContent).toContain(NOT_IN_LIST);
    expect(titles()).toEqual([]);
    gets = [];
    press(button(main(), "Clear filters"));
    expect(go).toHaveBeenCalledWith("#/refinement");
    expect(titles()).toEqual(["App open", "Other open"]);
    expect(bars()).toHaveLength(0);
    expect(gets).toEqual([]);
  });

  it("removes the filter with the chip's ×", async () => {
    setup();
    const go = vi.fn();
    await show("acme/app", go);
    gets = [];
    press(button(main(), "×"));
    expect(go).toHaveBeenCalledWith("#/refinement");
    expect(titles()).toEqual(["App open", "Other open"]);
    expect(gets).toEqual([]);
  });

  it("lists a repository an admin does not own when a session has it", async () => {
    setup();
    repos = ["acme/mine"];
    await show("acme/other");
    expect(titles()).toEqual(["Other open"]);
    expect(main().textContent).not.toContain(NOT_IN_LIST);
  });

  it("a filter removed while a reload runs stays removed", async () => {
    setup();
    await show("acme/app");
    const gate = (() => {
      const g: { release?: () => void; wait: Promise<void> } = { wait: Promise.resolve() };
      g.wait = new Promise<void>((r) => (g.release = r));
      return g;
    })();
    const base = (globalThis as any).fetch;
    (globalThis as any).fetch = async (url: string, init: any) => {
      await gate.wait;
      return base(url, init);
    };
    press(button(main(), "Dropped")); // reload starts and waits
    await flush();
    press(button(main(), "×"));
    gate.release!();
    await flush();
    await flush();
    expect(bars()).toHaveLength(0);
    expect(titles()).toEqual(["App dropped", "Other dropped"]);
    expect(main().textContent).not.toContain("Repository:");
    (globalThis as any).fetch = base;
    press(button(main(), "Open sessions"));
    await flush();
  });

  it("preselects the repository in the new session dialog", async () => {
    setup();
    await show("Acme/Other");
    press(button(main(), "New session"));
    expect(field(root(), "repo")!.value).toBe("acme/other");
  });

  it("starts with the first repository when the filtered one is not in the list, or without a filter", async () => {
    setup();
    await show("gone/repo");
    press(button(main(), "New session"));
    expect(field(root(), "repo")!.value).toBe("acme/app");
    root().replaceChildren();
    await showList();
    press(button(main(), "New session"));
    expect(field(root(), "repo")!.value).toBe("acme/app");
  });

  it("does not filter a session page", async () => {
    setup();
    (globalThis as any).location = { hash: "#/refinement/s2?repo=acme%2Fapp" };
    await ui.renderRefinement(main(), { id: "s2", query: { repo: "acme/app" } });
    expect(main().textContent).toContain("Other open");
    expect(bars()).toHaveLength(0);
  });

  it("accepts an address with a query and drops a late answer after leaving", async () => {
    setup();
    main().textContent = "old";
    await show("acme/app");
    expect(main().textContent).not.toBe("old");
    const base = (globalThis as any).fetch;
    let release!: () => void;
    const wait = new Promise<void>((r) => (release = r));
    (globalThis as any).fetch = async (url: string, init: any) => {
      await wait;
      return base(url, init);
    };
    const loading = ui.renderRefinement(main(), { query: { repo: "acme/app" }, go: () => {} });
    await flush();
    (globalThis as any).location = { hash: "#/runs?repo=acme%2Fapp" };
    main().textContent = "Runs page";
    release();
    await loading;
    expect(main().textContent).toBe("Runs page");
    (globalThis as any).fetch = base;
  });
});

describe("the list", () => {
  it("shows four heads to a user and the owner to an admin", async () => {
    sessions = [session({ ownerName: "Ann", mine: false })];
    await showList();
    expect(walk(main()).filter((e) => e.tag === "th").map((e) => e.textContent)).toEqual(["Title", "Repository", "State", "Last change"]);
    await showList(true);
    expect(walk(main()).filter((e) => e.tag === "th").map((e) => e.textContent)).toContain("Owner");
    expect(main().textContent).toContain("Ann");
  });
  it("shows the empty text and keeps dropped sessions out of the open list", async () => {
    await showList();
    expect(main().textContent).toContain("No refinement sessions yet.");
    sessions = [dropped({ title: "Gone" })];
    await showList();
    expect(main().textContent).not.toContain("Gone");
  });
  it("shows dropped sessions with a Restore that does not open the row", async () => {
    sessions = [dropped({ title: "Gone" }), dropped({ id: "s2", title: "Theirs", mine: false })];
    await showList();
    press(button(main(), "Dropped"));
    await flush();
    expect(main().textContent).toContain("Gone");
    expect(main().textContent).toContain("removed on");
    expect(walk(main()).filter((e) => e.textContent === "Restore")).toHaveLength(1);
    press(button(main(), "Restore"));
    await flush();
    expect(sent).toEqual([{ method: "POST", url: "/api/refinement/s1/restore", body: {} }]);
    expect((globalThis as any).location.hash).toBe("#/refinement");
    press(button(main(), "Open sessions"));
    await flush();
  });
  it("shows an error toast and loads again when a restore in the list fails", async () => {
    sessions = [dropped()];
    await showList();
    press(button(main(), "Dropped"));
    await flush();
    answers.push({ status: 500, error: "broken" });
    gets = [];
    press(button(main(), "Restore"));
    await flush();
    expect(toastText()).toBe("broken");
    expect(gets).toEqual(["/api/refinement"]);
    press(button(main(), "Open sessions"));
    await flush();
  });
  it("sends one request for two clicks on Restore", async () => {
    sessions = [dropped()];
    await showList();
    press(button(main(), "Dropped"));
    await flush();
    holdNext = true;
    const r = button(main(), "Restore");
    press(r);
    press(r);
    await flush();
    hold!.release();
    await flush();
    expect(sent).toHaveLength(1);
    press(button(main(), "Open sessions"));
    await flush();
  });
});

describe("new session", () => {
  const open = async () => {
    await showList();
    press(button(main(), "New session"));
  };
  it("offers the repositories of the answer", async () => {
    repos = ["a/one", "b/two"];
    await open();
    expect(walk(root()).filter((e) => e.tag === "option").map((e) => e.textContent)).toEqual(["a/one", "b/two"]);
  });
  it("needs an idea", async () => {
    await open();
    press(button(root(), "Start session"));
    await flush();
    expect(bad(root())).toEqual(["Describe your idea."]);
    expect(sent).toEqual([]);
  });
  it("sends repo and idea, and the title only when filled, then opens the session", async () => {
    await open();
    field(root(), "idea")!.value = "A rough idea";
    press(button(root(), "Start session"));
    await flush();
    expect(sent).toEqual([{ method: "POST", url: "/api/refinement", body: { repo: "acme/app", idea: "A rough idea" } }]);
    expect((globalThis as any).location.hash).toBe("#/refinement/new1");
    await open();
    field(root(), "idea")!.value = "Idea";
    field(root(), "title")!.value = " Title ";
    press(button(root(), "Start session"));
    await flush();
    expect(sent[1]!.body).toEqual({ repo: "acme/app", idea: "Idea", title: "Title" });
  });
  it("keeps a server error in the dialog", async () => {
    await open();
    field(root(), "idea")!.value = "x";
    answers.push({ status: 403, error: "that is not one of your GitHub repositories" });
    const start = button(root(), "Start session")!;
    press(start);
    await flush();
    expect(bad(root())).toEqual(["that is not one of your GitHub repositories"]);
    expect(start.disabled).toBe(false);
  });
  it("sends one request for two clicks", async () => {
    await open();
    field(root(), "idea")!.value = "x";
    holdNext = true;
    const start = button(root(), "Start session");
    press(start);
    press(start);
    await flush();
    hold!.release();
    await flush();
    expect(sent).toHaveLength(1);
  });
  it("still opens the new session when the dialog was closed while the request ran", async () => {
    await open();
    field(root(), "idea")!.value = "x";
    holdNext = true;
    press(button(root(), "Start session"));
    await flush();
    root().replaceChildren();
    (document as any).listeners.keydown.forEach((f: any) => f({ key: "Escape" }));
    await flush();
    hold!.release();
    await flush();
    expect((globalThis as any).location.hash).toBe("#/refinement/new1");
  });
  it("shows a hint and a link when there is no repository", async () => {
    repos = [];
    await open();
    expect(root().textContent).toContain("You need a GitHub repository first.");
    expect(walk(root()).some((e) => e.tag === "a" && e.attrs.href === "#/repos")).toBe(true);
    expect(field(root(), "idea")).toBeUndefined();
  });
});

describe("the session page", () => {
  it("shows the idea, state, drafts and log", async () => {
    sessions = [session()];
    await showPage();
    const text = main().textContent;
    expect(text).toContain("Line one\nLine two");
    expect(text).toContain("Exploring");
    expect(text).toContain("No story drafts yet.");
    expect(text).toContain("Ann started the session");
    expect(walk(main()).some((e) => e.tag === "a" && e.textContent === "← All sessions")).toBe(true);
  });
  it("lists the story drafts by their title", async () => {
    sessions = [session({ drafts: [{ id: "d1", preview: { title: "Export", body: "x" } }, { id: "d2", preview: { title: "", body: "y" } }] })];
    await showPage();
    const text = main().textContent;
    expect(text).toContain("Export");
    expect(text).toContain("Untitled draft");
    expect(text).not.toContain("No story drafts yet.");
  });
  it("says so when the story drafts are hidden", async () => {
    const s = session({ draftsHidden: true }) as any;
    delete s.drafts;
    sessions = [s];
    await showPage();
    expect(main().textContent).toContain("The story drafts are not shown while the repository is not in My repositories.");
  });
  it("writes the log lines of the drafts", () => {
    expect(ui.logText({ what: "draft-added", who: "Ann" })).toBe("Ann added a story draft");
    expect(ui.logText({ what: "draft-published", who: "Ann" })).toBe("Ann published a story draft");
    expect(ui.logText({ what: "draft-published", who: "Ann", detail: "#101 Export" })).toBe("Ann published a story draft: #101 Export");
    expect(ui.logText({ what: "draft-removed", who: "Ann" })).toBe("Ann removed a story draft");
    expect(ui.logText({ what: "draft-removed", who: "Ann", detail: "Export" })).toBe('Ann removed a story draft: "Export"');
    expect(ui.logText({ what: "epic-set", who: "Ann", detail: "#73" })).toBe("Ann set the Epic to #73");
    expect(ui.logText({ what: "epic-set", who: "Ann" })).toBe("Ann set the Epic");
    expect(ui.logText({ what: "epic-cleared", who: "Ann" })).toBe("Ann cleared the Epic");
  });
  it("follows the rules for the buttons", async () => {
    sessions = [session()];
    await showPage();
    expect(buttonsOf()).toEqual(["Rename", "Drop"]);
    sessions = [dropped()];
    await showPage();
    expect(buttonsOf()).toEqual(["Restore"]);
    sessions = [session({ mine: false, ownerName: "Ann" })];
    await showPage("s1", true);
    expect(buttonsOf()).toEqual(["Drop"]);
    sessions = [dropped({ mine: false, ownerName: "Ann" })];
    await showPage("s1", true);
    expect(buttonsOf()).toEqual([]);
  });
  it("shows a note when the repository is gone", async () => {
    sessions = [session({ repoAvailable: false })];
    await showPage();
    expect(main().textContent).toContain("not in My repositories any more");
  });
  it("renames", async () => {
    sessions = [session()];
    await showPage();
    press(button(main(), "Rename"));
    await flush();
    field(root(), "title")!.value = " New name ";
    press(button(root(), "Save"));
    await flush();
    expect(sent).toEqual([{ method: "PUT", url: "/api/refinement/s1", body: { title: "New name" } }]);
  });
  it("puts the focus on the new Rename button after a rename", async () => {
    sessions = [session()];
    await showPage();
    const old = button(main(), "Rename")!;
    old.focus();
    press(old);
    await flush();
    field(root(), "title")!.value = "New name";
    press(button(root(), "Save"));
    await flush();
    await flush();
    const now = button(main(), "Rename")!;
    expect(now).not.toBe(old);
    expect((document as any).activeElement).toBe(now);
  });
  it("lists the sessions in a scroll box with a link on the title", async () => {
    sessions = [session()];
    await showList();
    const box = walk(main()).filter((e) => (e.attrs.class ?? "").split(" ").includes("table-box"));
    expect(box).toHaveLength(1);
    expect(box[0]!.all("table")).toHaveLength(1);
    const links = walk(main()).filter((e) => e.tag === "a" && e.attrs.href === "#/refinement/s1");
    expect(links).toHaveLength(1);
  });
  it("does not send a blank title and keeps the dialog on a conflict", async () => {
    sessions = [session()];
    await showPage();
    press(button(main(), "Rename"));
    await flush();
    field(root(), "title")!.value = "  ";
    press(button(root(), "Save"));
    await flush();
    expect(sent).toEqual([]);
    field(root(), "title")!.value = "X";
    answers.push({ status: 409, error: "a dropped session cannot be renamed; restore it first" });
    const save = button(root(), "Save")!;
    press(save);
    await flush();
    expect(bad(root())).toEqual(["a dropped session cannot be renamed; restore it first"]);
    expect(save.disabled).toBe(false);
  });
  it("sends one request for two clicks on Save", async () => {
    sessions = [session()];
    await showPage();
    press(button(main(), "Rename"));
    await flush();
    field(root(), "title")!.value = "X";
    holdNext = true;
    const save = button(root(), "Save");
    press(save);
    press(save);
    await flush();
    hold!.release();
    await flush();
    expect(sent).toHaveLength(1);
  });
  it("asks before it drops", async () => {
    sessions = [session()];
    await showPage();
    confirmAnswer = false;
    press(button(main(), "Drop"));
    await flush();
    expect(sent).toEqual([]);
    confirmAnswer = true;
    press(button(main(), "Drop"));
    await flush();
    expect(sent).toEqual([{ method: "POST", url: "/api/refinement/s1/drop", body: {} }]);
  });
  describe("Undo after Drop", () => {
    const undo = () => walk((document as any).getElementById("toast")).find((e) => e.tag === "button" && e.textContent === "Undo");
    it("offers Undo on an own session; it restores and draws the session again", async () => {
      sessions = [session()];
      await showPage();
      press(button(main(), "Drop"));
      await flush();
      expect(toastText()).toContain("Session dropped");
      sessions = [dropped()];
      sent = [];
      gets = [];
      press(undo());
      await flush();
      expect(sent).toEqual([{ method: "POST", url: "/api/refinement/s1/restore", body: {} }]);
      expect(gets).toEqual(["/api/refinement/s1"]);
    });
    it("offers no Undo when an admin drops someone else's session", async () => {
      sessions = [session({ mine: false, ownerName: "Ann" })];
      await showPage("s1", true);
      press(button(main(), "Drop"));
      await flush();
      expect(toastText()).toBe("Session dropped");
      expect(undo()).toBeUndefined();
    });
    it("shows the error text when the undo fails", async () => {
      sessions = [session()];
      await showPage();
      press(button(main(), "Drop"));
      await flush();
      answers.push({ status: 409, error: "that session is not dropped" });
      press(undo());
      await flush();
      expect(toastText()).toBe("that session is not dropped");
    });
    it("draws the list, not the session page, when the person went back to the list", async () => {
      sessions = [session()];
      await showPage();
      press(button(main(), "Drop"));
      await flush();
      (globalThis as any).location.hash = "#/refinement";
      await showList();
      gets = [];
      press(undo());
      await flush();
      expect(gets).toEqual(["/api/refinement"]);
    });
    it("draws nothing when the person left Refinement", async () => {
      sessions = [session()];
      await showPage();
      press(button(main(), "Drop"));
      await flush();
      (globalThis as any).location.hash = "#/your-turn";
      gets = [];
      press(undo());
      await flush();
      expect(gets).toEqual([]);
    });
    it("a declined confirmation sends nothing and shows no toast", async () => {
      sessions = [session()];
      await showPage();
      confirmAnswer = false;
      press(button(main(), "Drop"));
      await flush();
      expect(sent).toEqual([]);
      expect(toastText()).toBe("");
    });
  });
  it("shows an error toast, loads again and enables the button when a drop fails", async () => {
    sessions = [session()];
    await showPage();
    answers.push({ status: 409, error: "that session is dropped already" });
    gets = [];
    const drop = button(main(), "Drop")!;
    press(drop);
    await flush();
    expect(toastText()).toBe("that session is dropped already");
    expect(gets).toEqual(["/api/refinement/s1"]);
    expect(button(main(), "Drop")!.disabled).toBe(false);
  });
  it("sends one request for two clicks on Drop", async () => {
    sessions = [session()];
    await showPage();
    holdNext = true;
    const drop = button(main(), "Drop");
    press(drop);
    press(drop);
    await flush();
    hold!.release();
    await flush();
    expect(sent).toHaveLength(1);
  });
  it("restores, once for two clicks, and handles a missing session", async () => {
    sessions = [dropped()];
    await showPage();
    holdNext = true;
    const r = button(main(), "Restore");
    press(r);
    press(r);
    await flush();
    hold!.release();
    await flush();
    expect(sent).toHaveLength(1);
    await showPage();
    sessions = [];
    answers.push({ status: 404, error: "no such refinement session" });
    sessions = [dropped()];
    const again = button(main(), "Restore");
    sessions = [];
    press(again);
    await flush();
    expect(toastText()).toBe("no such refinement session");
    expect(main().textContent).toContain("← All sessions");
    expect(main().textContent).toContain("no such refinement session");
  });
  it("says it when the server cannot be reached", async () => {
    sessions = [session()];
    await showPage();
    answers.push("throw");
    press(button(main(), "Drop"));
    await flush();
    expect(toastText()).toBe("Could not reach the server.");
  });
  it("does not draw a load that finishes after the person left", async () => {
    sessions = [session()];
    (globalThis as any).location.hash = "#/refinement/s1";
    const pending = ui.renderRefinement(main(), { id: "s1" });
    (globalThis as any).location.hash = "#/runs";
    await pending;
    expect(main().textContent).not.toContain("Line one");
  });
  it("ignores a list request that fails after the person left", async () => {
    const before = globalThis.fetch;
    (globalThis as any).fetch = async () => {
      await flush();
      throw new TypeError("fetch failed");
    };
    (globalThis as any).location.hash = "#/refinement";
    const pending = ui.renderRefinement(main(), {});
    (globalThis as any).location.hash = "#/runs";
    await expect(pending).resolves.toBeTypeOf("function");
    globalThis.fetch = before;
  });
});

describe("wiring", () => {
  const read = (p: string) => readFileSync(new URL(`../ui/${p}`, import.meta.url), "utf8");
  it("links the page", () => {
    expect(read("index.html")).toContain('href="#/refinement" data-nav="refinement">Refinement<');
    const app = read("app.js");
    expect(app).toContain('from "./refinement.js"');
    expect(app).toContain('section === "refinement"');
    expect(read("user/index.html")).toContain('href="#/refinement" data-nav="refinement">Refinement<');
    expect(read("user/app.js")).toContain('from "/refinement.js"');
  });
  it("uses the right routes", async () => {
    const seen: string[] = [];
    (globalThis as any).fetch = async (url: string, init: any) => {
      seen.push(`${init.method} ${url}`);
      return { ok: true, status: 200, json: async () => ({}) };
    };
    await api.refinement();
    await api.createRefinement({});
    await api.refinementSession("a b");
    await api.renameRefinement("x", { title: "t" });
    await api.dropRefinement("x");
    await api.restoreRefinement("x");
    expect(seen).toEqual([
      "GET /api/refinement",
      "POST /api/refinement",
      "GET /api/refinement/a%20b",
      "PUT /api/refinement/x",
      "POST /api/refinement/x/drop",
      "POST /api/refinement/x/restore",
    ]);
  });
});

describe("states of the list and the session", () => {
  const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: "x", json: async () => body });
  const classes = (e: FakeElement) => (e.attrs.class ?? "").split(" ");
  const withClass = (c: string) => walk(main()).filter((e) => classes(e).includes(c));
  const kind = () => walk(main()).find((e) => e.attrs["data-kind"])?.attrs["data-kind"];
  const retry = () => walk(main()).find((e) => e.tag === "button" && e.textContent === "Retry");
  const table = () => walk(main()).find((e) => e.tag === "table");
  const asGet = (list: (n: number) => Promise<ReturnType<typeof reply>>) => {
    const real = (globalThis as any).fetch;
    let n = 0;
    (globalThis as any).fetch = async (url: string, init: any) => (init.method === "GET" && url === "/api/refinement" ? list(++n) : real(url, init));
    return real;
  };

  it("draws a skeleton in the list while the first read runs", async () => {
    let release!: () => void;
    asGet(async () => {
      await new Promise<void>((r) => (release = r));
      return reply({ sessions: [session()], repos });
    });
    const shown = ui.renderRefinement(main(), {});
    await flush();
    expect(withClass("skeleton")).toHaveLength(1);
    release();
    await shown;
    expect(withClass("skeleton")).toHaveLength(0);
    expect(table()).toBeDefined();
  });
  it("shows an error state with Retry when the first read fails, and Retry loads the list", async () => {
    let fails = true;
    asGet(async () => (fails ? reply({ error: "boom" }, 500) : reply({ sessions: [session()], repos })));
    await ui.renderRefinement(main(), {});
    expect(withClass("state-error")).toHaveLength(1);
    expect(main().textContent).toContain("boom");
    expect(table()).toBeUndefined();
    fails = false;
    press(retry());
    await flush();
    expect(withClass("state-error")).toHaveLength(0);
    expect(table()).toBeDefined();
  });
  it("shows no permission as its own state, without Retry", async () => {
    asGet(async () => reply({ error: "you may not see this" }, 403));
    await ui.renderRefinement(main(), {});
    expect(kind()).toBe("permission");
    expect(retry()).toBeUndefined();
  });
  it("keeps the rows and says so when a reload fails; Retry clears the note", async () => {
    sessions = [session()];
    let fails = false;
    asGet(async () => (fails ? reply({ error: "boom" }, 500) : reply({ sessions: [session()], repos })));
    await ui.renderRefinement(main(), {});
    fails = true;
    press(button(main(), "Open sessions"));
    await flush();
    expect(table()).toBeDefined();
    expect(withClass("stale-note").filter((e) => classes(e).includes("failed"))).toHaveLength(1);
    fails = false;
    press(retry());
    await flush();
    expect(withClass("stale-note")).toHaveLength(0);
    expect(table()).toBeDefined();
  });
  it("draws the newest read when two reads answer out of order", async () => {
    const pending: ((b: unknown) => void)[] = [];
    asGet(() => new Promise((r) => pending.push((b) => r(reply(b)))));
    const shown = ui.renderRefinement(main(), {});
    await flush();
    pending[0]!({ sessions: [], repos });
    await shown;
    press(button(main(), "Open sessions"));
    await flush();
    press(button(main(), "Open sessions"));
    await flush();
    expect(pending).toHaveLength(3);
    pending[2]!({ sessions: [session({ id: "b", title: "Newer" })], repos });
    await flush();
    pending[1]!({ sessions: [session({ id: "a", title: "Older" })], repos });
    await flush();
    expect(main().textContent).toContain("Newer");
    expect(main().textContent).not.toContain("Older");
  });
  it("says it with emptyState when there is nothing", async () => {
    sessions = [];
    await ui.renderRefinement(main(), {});
    expect(withClass("empty")).toHaveLength(1);
    expect(main().textContent).toContain("No refinement sessions yet. Start one with a rough idea.");
  });

  it("draws a skeleton on the first load of a session, not on a quiet reload", async () => {
    sessions = [session()];
    let release!: () => void;
    const real = (globalThis as any).fetch;
    (globalThis as any).fetch = async (url: string, init: any) => {
      if (init.method === "GET") await new Promise<void>((r) => (release = r));
      return real(url, init);
    };
    (globalThis as any).location.hash = "#/refinement/s1";
    const first = ui.renderRefinement(main(), { id: "s1" });
    await flush();
    expect(withClass("skeleton")).toHaveLength(1);
    release();
    await first;
    expect(withClass("skeleton")).toHaveLength(0);
    const again = ui.renderRefinement(main(), { id: "s1", quiet: true });
    await flush();
    expect(withClass("skeleton")).toHaveLength(0);
    expect(main().textContent).toContain("My idea");
    release();
    await again;
  });
  it("shows a session that is not there as missing, without Retry, with a way back", async () => {
    sessions = [];
    await showPage("nope");
    expect(kind()).toBe("missing");
    expect(retry()).toBeUndefined();
    expect(walk(main()).some((e) => e.tag === "a" && e.attrs.href === "#/refinement")).toBe(true);
  });
  it("shows no permission for a session as its own state", async () => {
    const real = (globalThis as any).fetch;
    (globalThis as any).fetch = async (url: string, init: any) => (init.method === "GET" ? reply({ error: "not yours" }, 403) : real(url, init));
    await showPage("s1");
    expect(kind()).toBe("permission");
    expect(retry()).toBeUndefined();
  });
  it("offers Retry after a server failure, and Retry draws the session", async () => {
    const real = (globalThis as any).fetch;
    let fails = true;
    sessions = [session()];
    (globalThis as any).fetch = async (url: string, init: any) => (init.method === "GET" && fails ? reply({ error: "boom" }, 500) : real(url, init));
    await showPage("s1");
    expect(kind()).toBe("server");
    fails = false;
    press(retry());
    await flush();
    expect(main().textContent).toContain("My idea");
  });
  it("asks in the dialog before it drops; Cancel sends nothing", async () => {
    sessions = [session()];
    await showPage();
    stopDialog?.();
    press(button(main(), "Drop"));
    await flush();
    expect(dialogText()).toContain('Drop "My idea"');
    await answerDialog(false);
    expect(sent).toEqual([]);
    expect(dialogText()).toBeUndefined();
    press(button(main(), "Drop"));
    await flush();
    await answerDialog(true);
    await flush();
    expect(sent).toEqual([{ method: "POST", url: "/api/refinement/s1/drop", body: {} }]);
  });
});
