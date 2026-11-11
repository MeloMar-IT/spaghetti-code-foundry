import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { nextStep } from "../src/next-step.js";
import { KINDS } from "../src/words.js";
import { audit } from "./helpers/a11y.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let words: any;
let model: any;
let view: any;
let homeMod: any;
let prefs: any;
beforeAll(async () => {
  restore = installFakeDom();
  homeMod = await import("../ui/simple-home.js" as string);
  prefs = await import("../ui/prefs.js" as string);
  words = await import("../ui/simple-words.js" as string);
  model = await import("../ui/simple-model.js" as string);
  view = await import("../ui/simple.js" as string);
});
afterAll(() => restore());

const walk = (el: FakeElement): FakeElement[] => el.children.flatMap((c) => (c instanceof FakeElement ? [c, ...walk(c)] : []));
const box = (nodes: any[]) => {
  const root = new FakeElement("div");
  root.append(...nodes.filter(Boolean));
  return root;
};
const texts = (root: FakeElement) => [root, ...walk(root)].flatMap((e) => [e.children.filter((c) => typeof c === "string").join(""), e.attrs["aria-label"] ?? "", e.attrs.title ?? ""]);

const iso = (min: number) => new Date(Date.UTC(2026, 0, 1, 12, 0) - min * 60_000).toISOString();
const run = (id: string, kind: any, over: any = {}) => ({
  runId: id, flow: "issue-gitflow", task: `Show the weather (#12)\n\n**Epic:** x\n\nShows the weather for a city. More.`, status: "running", startedAt: iso(10),
  vars: { github_repo: "o/app", issue: "12" }, history: [], next: nextStep(kind, { runId: id, repo: "o/app", title: "Show the weather (#12)" } as any), ...over,
});
const repos = [{ id: "r1", url: "https://github.com/o/app", github: "o/app" }, { id: "r2", url: "https://github.com/o/other", github: "o/other" }];

describe("the word list", () => {
  it("has a Simple entry for every kind of next step", () => {
    for (const k of KINDS) expect(typeof words.KIND_WORDS[k]?.line, k).toBe("string");
  });

  it("says the exact sentence when the project reached its daily cap (#792)", () => {
    expect(words.kindWords("project_limit", "A time limit").line).toBe("The Foundry has done enough for today; it continues tomorrow.");
  });

  it("has a button label for every kind that can wait for the person", () => {
    for (const k of ["questions", "planner_questions", "owner_action", "approve_plan", "approve_split", "approval", "stopped", "release", "failed", "monitor_needs_you", "red_base"]) {
      expect(words.KIND_WORDS[k].todo, k).toBeTruthy();
    }
    // a kind that usually goes on alone still gets a button when the record says it is the person's move
    expect(words.kindWords("interrupted", "You").todo).toBeTruthy();
    expect(words.kindWords("usage_limit", "You").todo).toBeTruthy();
    expect(words.kindWords("interrupted", "Foundry").todo).toBeUndefined();
    expect(words.kindWords("nonsense").todo).toBeTruthy();
  });

  it("uses no forbidden term in its own text", () => {
    const all = [
      ...Object.entries(words.WORDS).flatMap(([k, v]) => (typeof v === "string" ? [v] : typeof v === "function" ? [v(3)] : k === "actions" ? Object.values(v as object) : [])),
      ...Object.values<any>(words.KIND_WORDS).flatMap((w) => [w.line, w.todo ?? ""]),
      words.stateLine({ needsAnswer: true }), words.stateLine({ needs: 1 }), words.stateLine({ building: 2 }), words.stateLine({ planned: 1 }), words.stateLine({ done: 1 }), words.stateLine({}),
    ];
    for (const t of all) expect(words.forbiddenIn(t), t).toEqual([]);
  });

  it("finds forbidden terms and leaves ordinary words alone", () => {
    expect(words.forbiddenIn("story #12 failed on branch x")).toEqual(expect.arrayContaining(["story", "#12", "failed", "branch"]));
    expect(words.forbiddenIn("Running login")).toEqual([]);
  });

  it("maps Foundry terms in user text and drops text that keeps a forbidden term", () => {
    expect(words.safeText("Fix failed release")).toBe("Fix got stuck final version");
    expect(words.safeText("Shows the logs.")).toBe("");
    expect(words.safeText("Shows the logs.", "A change")).toBe("A change");
    expect(words.safeText("")).toBe("");
  });

  it("makes user text plain", () => {
    expect(words.plainText("Fix **bold** (#12) see https://x.io/a now")).toBe("Fix bold see now");
    expect(words.plainText("a".repeat(200), 10)).toBe(`${"a".repeat(9)}…`);
    expect(words.summaryOf("Title\n\n**Epic:** x\n\nShows the weather. More.")).toBe("Shows the weather.");
    expect(words.summaryOf("Title only")).toBe("");
    expect(words.summaryOf("")).toBe("");
  });

  it("no longer has the four-step phase words", () => {
    expect([words.PHASES, words.phaseOf, words.progressText]).toEqual([undefined, undefined, undefined]);
  });

  it("gives every state line", () => {
    const s = words.stateLine;
    expect(s({ needsAnswer: true, needs: 1 })).toBe("Waiting for your answer");
    expect(s({ needs: 2, building: 1 })).toBe("Ready for you to check");
    expect([s({ building: 1 }), s({ building: 2 })]).toEqual(["Building 1 thing", "Building 2 things"]);
    expect([s({ planned: 1 }), s({ planned: 3 })]).toEqual(["1 thing planned", "3 things planned"]);
    expect(s({ done: 4 })).toBe("All done");
    expect(s({})).toBe("Nothing yet");
  });
});

describe("the model", () => {
  const group = (e: any) => model.groupOf(e);

  it("groups work by its next-step record", () => {
    expect(group({ run: run("a", "running"), job: null })).toBe("building");
    expect(group({ run: null, job: { runId: "j", next: nextStep("queued", { runId: "j" } as any) } })).toBe("planned");
    expect(group({ run: run("a", "usage_limit", { history: [{ id: "implement" }] }), job: null })).toBe("building");
    expect(group({ run: run("a", "questions"), job: null })).toBe("check");
    expect(group({ run: run("a", "done"), job: null })).toBe("done");
    expect(group({ run: run("a", "cancelled"), job: null })).toBeNull();
    expect(group({ run: run("a", "superseded"), job: null })).toBeNull();
    expect(group({ run: run("a", "epic"), job: null })).toBeNull();
    expect(group({ run: { runId: "old" }, job: null })).toBeNull();
  });

  it("builds cards from word-list text only", () => {
    const c = model.cardOf({ run: run("a", "running", { state: { next: "implement" }, history: [{ id: "plan" }] }), job: null });
    expect(c.title).toBe("Show the weather");
    expect(c.sentence).toBe("Shows the weather for a city.");
    expect(c.progress).toBe("Build: Making the change.");
    // an unknown step id takes its phase from its place in the flow
    const flowDef = { steps: Array.from({ length: 10 }, (_, i) => ({ id: i === 9 ? "zzz" : `s${i}` })) };
    const late = model.cardOf({ run: run("b", "running", { state: { next: "zzz" }, flowDef }), job: null });
    expect(late.progress).toBe("Deliver: Adding the change to your project.");
    const check = model.cardOf({ run: run("a", "approve_plan"), job: null });
    expect(check.todo).toBe("Check the plan");
    expect(Object.keys(check.link)).toEqual(["href", "external"]);
  });

  it("matches work to a project by repository, ignoring case", () => {
    const runs = [run("a", "running", { vars: { github_repo: "O/App" } }), run("b", "running", { vars: { github_repo: "o/other" } }), run("c", "done")];
    const m = model.projectModel(repos[0], repos, runs, []);
    expect(m.groups.building.map((c: any) => c.id)).toEqual(["a"]);
    expect(m.groups.done.map((c: any) => c.id)).toEqual(["c"]);
    const none = model.projectModel({ id: "L", url: "/tmp/local" }, repos, runs, []);
    expect(none.state).toBe("Nothing yet");
    expect(model.projectKey({ url: "/tmp/local" })).toBeNull();
  });

  it("gives a local project its own work, by its id", () => {
    const local = { id: "L1", url: "/tmp/notes" };
    const runs = [
      run("mine", "running", { vars: { repo_id: "L1" } }),
      run("other", "questions", { vars: { repo_id: "L2" } }),
      run("github", "done", { vars: { github_repo: "o/app" } }),
    ];
    const m = model.projectModel(local, [local, repos[0]], runs, [{ runId: "queued", repoId: "L1", next: nextStep("queued", { runId: "queued" } as any) }]);
    expect(m.name).toBe("notes");
    expect(m.groups.building.map((c: any) => c.id)).toEqual(["mine"]);
    expect(m.groups.planned.map((c: any) => c.id)).toEqual(["queued"]);
    expect(m.groups.check).toEqual([]);
    expect(m.state).toBe("Building 1 thing");
    expect(model.projectKey(local)).toBe("local:L1");
  });

  it("sorts done newest first and says when an answer is needed", () => {
    const runs = [run("old", "done", { finishedAt: iso(100) }), run("new", "done", { finishedAt: iso(1) })];
    expect(model.projectModel(repos[0], repos, runs, []).groups.done.map((c: any) => c.id)).toEqual(["new", "old"]);
    expect(model.projectModel(repos[0], repos, [run("q", "questions")], []).state).toBe("Waiting for your answer");
    expect(model.projectModel(repos[0], repos, [run("p", "approve_plan")], []).state).toBe("Ready for you to check");
  });

  it("shows work that waits in the queue and has no run yet", () => {
    const pending = [{ runId: "j", githubRepo: "o/app", task: "Add a login\n\nLets people sign in.", next: nextStep("queued", { runId: "j", repo: "o/app" } as any) }];
    const m = model.projectModel(repos[0], repos, [], pending);
    expect(m.groups.planned).toHaveLength(1);
    expect(m.state).toBe("1 thing planned");
  });

  it("gives each project one next button", () => {
    const [a, b] = model.projectsModel(repos, [run("q", "approve_plan")], []);
    expect(a.next.label).toBe("Check the plan");
    expect(b.next).toEqual({ label: "Open project", href: "#/repos/r2", external: false });
  });

  it("names projects, with the owner when two share a name", () => {
    expect(model.projectName(repos[0], repos)).toBe("app");
    const two = [{ id: "1", github: "a/x" }, { id: "2", github: "b/x" }];
    expect(model.projectName(two[0], two)).toBe("a/x");
  });
});

describe("the pages", () => {
  const forbiddenRuns = [
    run("a", "questions", { next: { ...nextStep("questions", { runId: "a", repo: "o/app" } as any), text: "waiting for you — release pull request issue #12", where: { label: "issue #12", url: "#/runs/a" } } }),
    run("b", "running", { state: { next: "implement" }, cost: 12.5, model: "opus", agent: "claude", branch: "feature/12-x" }),
    run("c", "done", { finishedAt: iso(1), label: "scf:done", transcript: "log" }),
    run("d", "approve_plan"),
  ];
  const projects = () => model.projectsModel(repos, forbiddenRuns, []);
  const pages = () => {
    const ps = projects();
    return [box(view.projectsView(ps)), box(view.projectView(ps[0], { actions: [{ id: "change", href: "#/home" }, { id: "tryIt", onClick: () => {} }, { id: "final", href: "#/home" }] }))];
  };

  it("lists one card per project with the state and a big button", () => {
    const [home] = pages();
    expect(home!.all("li").length).toBe(2);
    // the greeting of Today is the h1 of the page; My projects is a section below it, each project a heading under that
    expect(home!.all("h1")).toHaveLength(0);
    expect(home!.all("h2")[0]!.textContent).toBe("My projects");
    expect(home!.all("h3")).toHaveLength(2);
    expect(texts(home!).join("|")).toContain("Waiting for your answer");
    expect(box(view.projectsView([])).textContent).toContain("No projects yet");
  });

  it("shows what to do, the four groups and progress", () => {
    const page = box(view.projectView(model.projectsModel(repos, forbiddenRuns, [])[0], {}));
    const t = page.textContent;
    for (const s of ["What you need to do", "What is being made", "Planned", "Being built", "Ready for you to check", "Done", "Build: Making the change."]) expect(t).toContain(s);
    const calm = box(view.projectView(model.projectsModel(repos, [], [])[0], {}));
    expect(calm.textContent).toContain("Nothing — the Foundry is working.");
  });

  it("draws the action row only from the actions it gets", () => {
    const ps = projects();
    const row = (r: FakeElement) => walk(r).find((e) => e.attrs.class === "simple-actions");
    expect(row(box(view.projectView(ps[0], { actions: [] })))).toBeUndefined();
    const withActions = box(view.projectView(ps[0], { actions: [{ id: "change", href: "#/x" }, { id: "tryIt", onClick: () => {} }, { id: "final", href: "#/y" }] }));
    expect(row(withActions)!.textContent).toBe("Ask for a changeTry itMake this version final");
  });

  it("caps Done at five and keeps the rest in a details box", () => {
    const many = Array.from({ length: 8 }, (_, i) => run(`d${i}`, "done", { finishedAt: iso(i + 1) }));
    const m = model.projectsModel(repos, many, [])[0];
    const page = box(view.projectView(m, {}));
    expect(page.all("details")).toHaveLength(1);
    expect(page.textContent).toContain("Show all done (8)");
    expect(page.all("h4")).toHaveLength(8);
    expect(box(view.projectView(m, { doneOpen: true })).all("details")[0]!.attrs.open).toBe("");
  });

  it("shows no forbidden term in text, aria-label or title", () => {
    for (const p of pages()) expect(words.forbiddenIn(texts(p).join("\n")), texts(p).join("|")).toEqual([]);
  });

  it("keeps Foundry words out of the person's own titles and summaries", () => {
    const dirty = [
      run("t", "running", { task: "Fix failed release\n\nShows the logs.\n", next: { ...nextStep("running", { runId: "t" } as any), title: "Fix failed release" } }),
      run("u", "approve_plan", { task: "Branch feature/12-x\n\nCommit abc123 lands here.", next: { ...nextStep("approve_plan", { runId: "u" } as any), title: "Ship the issue" } }),
    ];
    const ps = model.projectsModel(repos, dirty, []);
    const page = box(view.projectView(ps[0], {}));
    const all = texts(page).join("\n");
    expect(all).toContain("Fix got stuck final version");
    expect(all).toContain("Ship the change");
    expect(words.forbiddenIn(all)).toEqual([]);
    expect(words.forbiddenIn(texts(box(view.projectView(ps[1] ?? ps[0], {}))).join("\n"))).toEqual([]);
  });

  it("the check catches a term (negative control)", () => {
    const p = box([new FakeElement("p")]);
    p.all("p")[0]!.setAttribute("aria-label", "see the run log");
    expect(words.forbiddenIn(texts(p).join("\n")).length).toBeGreaterThan(0);
  });

  it("passes the accessibility audit, with real links and buttons for every action", () => {
    for (const p of pages()) {
      expect(audit(p)).toEqual([]);
      for (const e of [p, ...walk(p)]) {
        if (e.listeners.click?.length) expect(["a", "button", "summary"], e.tag).toContain(e.tag);
        if (e.tag === "a") expect(e.attrs.href).toBeTruthy();
      }
      const levels = walk(p).filter((e) => /^h\d$/.test(e.tag)).map((e) => Number(e.tag[1]));
      levels.forEach((l, i) => { if (i) expect(l - levels[i - 1]!).toBeLessThanOrEqual(1); });
    }
  });

  it("always has a Get started link, with projects and without", () => {
    for (const ps of [projects(), []]) {
      const link = walk(box(view.projectsView(ps))).find((e) => e.attrs["data-focus"] === "simple-get-started");
      expect(link?.attrs.href).toBe("#/start-guide");
      expect(link?.textContent).toBe("Get started");
    }
  });

  it("opens the guide once when the first load shows no project, never with projects, and not after the page was left", async () => {
    const make = (list: any[]): any => ({ repos: vi.fn(async () => list), runs: vi.fn(async () => []), queue: vi.fn(async () => ({ active: [], pending: [] })), run: vi.fn() });
    const openGuide = vi.fn();
    (await view.renderSimpleHome(new FakeElement("div"), { a: make([]), openGuide }))();
    expect(openGuide).toHaveBeenCalledTimes(1);
    const none = vi.fn();
    (await view.renderSimpleHome(new FakeElement("div"), { a: make(repos), openGuide: none }))();
    expect(none).not.toHaveBeenCalled();
    // the person left before the empty answer came in
    const late = vi.fn();
    (await view.renderSimpleHome(new FakeElement("div"), { a: make([]), openGuide: late, alive: () => false }))();
    expect(late).not.toHaveBeenCalled();
    // a throwing callback does not break the page
    const main = new FakeElement("div");
    (await view.renderSimpleHome(main, { a: make([]), openGuide: () => { throw new Error("x"); } }))();
    expect(main.textContent).toContain("No projects yet");
  });

  it("renders My projects and the project page from the API, and shows an error state", async () => {
    const a: any = { repos: vi.fn(async () => repos), runs: vi.fn(async () => forbiddenRuns), queue: vi.fn(async () => ({ active: [], pending: [] })), run: vi.fn() };
    const main = new FakeElement("div");
    const stop = await view.renderSimpleHome(main, { a });
    expect(main.textContent).toContain("My projects");
    expect(typeof stop).toBe("function");
    stop();
    const names: string[] = [];
    const main2 = new FakeElement("div");
    (await view.renderSimpleProject(main2, { id: "r1", a, onName: (n: string) => names.push(n) }))();
    expect(names).toEqual(["app"]);
    expect(main2.textContent).toContain("What you need to do");
    const main3 = new FakeElement("div");
    (await view.renderSimpleProject(main3, { id: "nope", a }))();
    expect(main3.textContent).toContain("This project is not in your list.");
    const bad: any = { ...a, runs: vi.fn(async () => { throw new Error("boom"); }) };
    const main4 = new FakeElement("div");
    (await view.renderSimpleHome(main4, { a: bad }))();
    expect(main4.textContent).toContain("could not be loaded");
  });
});

describe("the Simple Home is Today with My projects below it", () => {
  const api = (runs: any[], list: any[] = repos): any => ({ repos: vi.fn(async () => list), runs: vi.fn(async () => runs), queue: vi.fn(async () => ({ active: [], pending: [] })), run: vi.fn() });
  const open = async (runs: any[], opts: any = {}) => {
    const main = new FakeElement("div");
    const stop = await view.renderSimpleHome(main, { a: api(runs), openGuide: vi.fn(), ...opts });
    return { main, stop };
  };
  const stuck = (id: string, flags: any = {}) => run(id, "failed", { status: "failed", next: { ...nextStep("failed", { runId: id, repo: "o/app", title: "Fix the colours" } as any), why: "The branch could not be merged; the tests failed.", ...flags } });
  const sections = (root: FakeElement) => root.all("h2").map((e) => e.textContent);
  const forbiddenRuns = [
    run("a", "questions", { next: { ...nextStep("questions", { runId: "a", repo: "o/app" } as any), text: "waiting for you — release pull request issue #12", where: { label: "issue #12", url: "#/runs/a" } } }),
    run("b", "running", { state: { next: "implement" }, cost: 12.5, model: "opus", agent: "claude", branch: "feature/12-x" }),
    run("c", "done", { finishedAt: iso(1), label: "scf:done", transcript: "log" }),
    run("d", "approve_plan"),
  ];

  it("shows the greeting, Today and then My projects with the project headings", async () => {
    const { main, stop } = await open([run("q", "approve_plan"), run("b", "running", { state: { next: "implement" } }), run("d", "done", { finishedAt: new Date().toISOString() })]);
    expect(main.all("h1").map((e) => e.textContent)).toEqual([expect.stringMatching(/^Good /)]);
    expect(sections(main)).toEqual(["What do you want to build?", "Needs you", "Running now", "Your project", "My projects"]);
    expect(main.all("section").find((s) => s.attrs.class?.includes("simple-home-project"))!.all("ol")[0]!.attrs.class).toContain("scf-phase-strip");
    expect(main.all("a").filter((a) => a.attrs.href === "#/start").map((a) => a.textContent)).toEqual(["Start"]);
    expect(main.all("h3").map((e) => e.textContent)).toEqual(expect.arrayContaining(["app", "other"]));
    expect(main.all("ol")[0]!.attrs.class).toContain("scf-phase-strip");
    expect(main.all("p").find((p) => p.attrs.class === "today-summary")!.textContent).toBe("1 thing needs you, 1 change is being built, 1 finished today");
    stop();
  });

  it("links the work and the card button to the project page, and the counters to lists on Home", async () => {
    const { main, stop } = await open([run("q", "approve_plan")]);
    const card = main.all("li").find((l) => l.attrs.class?.includes("today-card"))!;
    expect(card.all("a").find((a) => a.attrs.class === "btn primary")!.attrs.href).toBe("#/repos/r1");
    expect(main.all("nav")[0]!.all("a").map((a) => a.attrs.href)).toEqual(["#/home?list=check", "#/home?list=building", "#/home?list=ready", "#/home?list=published-week"]);
    stop();
  });

  it("opens the list a counter points to, without leaving Simple", async () => {
    const { main, stop } = await open([run("b", "running")], { list: "building" });
    const section = main.all("section").find((s) => s.attrs.class === "today-list")!;
    expect(section.all("h2")[0]!.textContent).toBe("Running");
    expect(section.all("li")).toHaveLength(1);
    expect(section.all("a").some((a) => a.attrs.href === "#/home")).toBe(true);
    stop();
  });

  it("still opens the lists of the old addresses, and none for an unknown key", async () => {
    for (const [key, title] of [["waiting", "Planned"], ["finished", "Done"], ["finished-today", "Done today"], ["ready", "Ready to check"]]) {
      const { main, stop } = await open([run("d", "done", { finishedAt: new Date().toISOString() })], { list: key });
      expect(main.all("section").find((s) => s.attrs.class === "today-list")!.all("h2")[0]!.textContent).toBe(title);
      stop();
    }
    const { main, stop } = await open([], { list: "bogus" });
    expect(main.all("section").some((s) => s.attrs.class === "today-list")).toBe(false);
    stop();
  });

  it("does not show work of a project that is not in the list", async () => {
    const { main, stop } = await open([run("x", "approve_plan", { vars: { github_repo: "o/stranger" } })]);
    expect(main.all("li").filter((l) => l.attrs.class?.includes("today-card"))).toHaveLength(0);
    expect(main.all("p").find((p) => p.attrs.class === "today-summary")!.textContent).toBe("Nothing needs you");
    stop();
  });

  it("gives a stuck change a card with plain words, and no card or count for one that is closed or put aside", async () => {
    const { main, stop } = await open([stuck("s"), stuck("c", { issueClosed: true }), stuck("n", { notNow: true })]);
    const cards = main.all("li").filter((l) => l.attrs.class?.includes("today-card"));
    expect(cards).toHaveLength(1);
    expect(cards[0]!.textContent).toContain("This got stuck");
    expect(main.all("nav")[0]!.all("a")[0]!.textContent).toBe("1 Needs you");
    stop();
  });

  it("shows no forbidden term in any text, aria-label or title of the whole Home", async () => {
    const { main, stop } = await open([...forbiddenRuns, stuck("s"), run("b2", "running", { state: { next: "implement" }, task: "Fix failed release", next: { ...nextStep("running", { runId: "b2", repo: "o/app" } as any), title: "Fix failed release" } })]);
    expect(words.forbiddenIn(texts(main).join("\n")), texts(main).join("|")).toEqual([]);
    expect(main.all("button").filter((b) => b.attrs.class?.includes("help-mark"))).toEqual([]);
    expect(main.textContent).not.toContain("Open the run");
    stop();
  });

  it("passes the audit and its headings step by one", async () => {
    const { main, stop } = await open([...forbiddenRuns, stuck("s")]);
    expect(audit(main)).toEqual([]);
    const levels = walk(main).filter((e) => /^h\d$/.test(e.tag)).map((e) => Number(e.tag[1]));
    levels.forEach((l, i) => { if (i) expect(l - levels[i - 1]!).toBeLessThanOrEqual(1); });
    const names = walk(main).filter((e) => e.tag === "a" || e.tag === "summary").map((e) => e.attrs["data-focus"]);
    expect(names.every(Boolean)).toBe(true);
    expect(new Set(names).size).toBe(names.length);
    stop();
  });

  it("with no project it still shows Today, My projects and the guide opens once", async () => {
    const openGuide = vi.fn();
    const main = new FakeElement("div");
    (await view.renderSimpleHome(main, { a: api([], []), openGuide }))();
    expect(openGuide).toHaveBeenCalledTimes(1);
    expect(main.all("h1")).toHaveLength(1);
    expect(sections(main)).toEqual(["What do you want to build?", "Running now", "My projects"]);
    expect(main.textContent).toContain("No projects yet");
  });
});

describe("Make this version final (a local project)", () => {
  const LOCAL = "local:demo-0123abcd";
  const local = [{ id: "r3", url: "/home/me/demo", method: "local", localName: LOCAL }];
  const message = "Make this version final?\nThese finished changes go to main:\n- #1 Build me\n- #2 Fix the colours of the page";
  const finalRun = (over: any = {}) => ({
    runId: "f1", flow: "release-daily", task: "daily", status: "waiting", startedAt: iso(5), vars: { github_repo: LOCAL }, history: [],
    waiting: { stepId: "make_final", message, since: iso(5) },
    next: nextStep("approval", { runId: "f1", repo: LOCAL, title: "Make this version final" } as any, { message, final: true }), ...over,
  });
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("matches a local project's run by its local name and builds the card", () => {
    const m = model.projectsModel(local, [finalRun()], [])[0];
    expect(m.todo).toHaveLength(1);
    const c = m.todo[0];
    expect(c).toMatchObject({ todo: "Make this version final", decide: "f1", items: ["Build me", "Fix the colours of the page"] });
    expect(c.items.join(" ")).not.toMatch(/#/);
    expect(c.link).toBeUndefined();
    expect(m.next).toEqual({ label: "Make this version final", href: "#/repos/r3", external: false });
    // another project's runs do not show here
    expect(model.projectsModel([{ id: "r9", url: "/x/other", method: "local", localName: "local:other-aaaaaaaa" }], [finalRun()], [])[0].todo).toEqual([]);
  });

  it("draws the button, a Not yet box with an optional reason, and answers through onDecide", async () => {
    const calls: any[] = [];
    const onDecide = vi.fn(async (...a: any[]) => { calls.push(a); return true; });
    const page = box(view.projectView(model.projectsModel(local, [finalRun()], [])[0], { onDecide }));
    expect(page.textContent).toContain("A new version of your project is ready.");
    expect(page.textContent).toContain("Build me");
    const buttons = page.all("button");
    const yes = buttons.find((b) => b.textContent === "Make this version final")!;
    expect(page.all("details")[0]!.all("summary")[0]!.textContent).toBe("Not yet");
    const area = page.all("textarea")[0]!;
    const keep = buttons.find((b) => b.textContent === "Keep it as it is")!;
    yes.click();
    await tick();
    expect(calls[0]).toEqual(["f1", true, ""]);
    expect(page.textContent).toContain("Thank you. The Foundry goes on by itself.");
    (area as any).value = "Wait for the logo";
    keep.click();
    await tick();
    expect(calls[1]).toEqual(["f1", false, "Wait for the logo"]);
  });

  it("says so when the answer did not work", async () => {
    const page = box(view.projectView(model.projectsModel(local, [finalRun()], [])[0], { onDecide: async () => false }));
    page.all("button").find((b) => b.textContent === "Make this version final")!.click();
    await tick();
    expect(page.textContent).toContain("That did not work. Try again.");
  });

  it("keeps the typed reason and the open Not yet box when the page is drawn again", async () => {
    const onDecide = vi.fn(async () => true);
    const model0 = model.projectsModel(local, [finalRun()], [])[0];
    const first = box(view.projectView(model0, { onDecide }));
    const area = first.all("textarea")[0]!;
    (area as any).value = "Wait for the logo";
    area.fire("input", { target: area });
    first.all("details")[0]!.fire("toggle", { target: { open: true } });
    // the poll draws the same project again (the data changed somewhere else)
    const again = box(view.projectView(model.projectsModel(local, [finalRun()], [])[0], { onDecide }));
    expect(again.all("textarea")[0]!.value).toBe("Wait for the logo");
    expect(again.all("details")[0]!.attrs.open).toBe("");
    // the answer goes through and the draft is gone
    again.all("button").find((b) => b.textContent === "Make this version final")!.click();
    await tick();
    expect(onDecide).toHaveBeenCalledWith("f1", true, "");
    const later = box(view.projectView(model.projectsModel(local, [finalRun()], [])[0], { onDecide }));
    expect(later.all("textarea")[0]!.value).toBe("");
    expect(later.all("details")[0]!.attrs.open).toBeUndefined();
  });

  it("uses only words of the list", () => {
    for (const v of Object.values<string>(words.FINAL)) expect(words.forbiddenIn(v), v).toEqual([]);
    const page = box(view.projectView(model.projectsModel(local, [finalRun()], [])[0], { onDecide: async () => true }));
    expect(words.forbiddenIn(texts(page).join("\n"))).toEqual([]);
  });
});

describe("the Simple home layouts", () => {
  const LOOKS: string[] = ["calm", "midnight", "friendly", "editorial", "bento"];
  const rich = [
    run("a", "questions"), run("p", "approve_plan"), run("s", "failed", { status: "failed" }),
    run("b", "running", { state: { next: "implement" } }), run("d", "done", { finishedAt: new Date().toISOString(), history: [{ id: "merge", ok: true }] }),
  ];
  const hm = (runs: any[] = rich, opts: any = {}) => model.homeModel(runs, [], repos, model.projectsModel(repos, runs, []), opts);
  const signature = (root: FakeElement) => ({
    controls: walk(root).filter((e) => e.tag === "a" || e.tag === "button").map((e) => JSON.stringify([e.tag, e.attrs.href ?? "", e.textContent])).sort(),
    h3: walk(root).filter((e) => e.tag === "h3").map((e) => e.textContent),
  });
  const on = (id: string, repo: string, kind: any, over: any = {}) => run(id, kind, { vars: { github_repo: repo, issue: "1" }, ...over });
  const paused = (id: string, repo: string, over: any = {}) => run(id, "dependency", { status: "waiting", vars: { github_repo: repo, issue: "1" }, history: [{ id: "implement" }], state: { next: "implement" }, ...over });

  it("has words that pass the forbidden-term check", () => {
    for (const v of Object.values<any>(words.HOME)) {
      for (const t of typeof v === "string" ? [v] : typeof v === "function" ? [v(3)] : Object.values<string>(v)) expect(words.forbiddenIn(t), t).toEqual([]);
    }
  });

  it("maps every look to a layout, and an unknown or inherited name to cards", () => {
    expect([...prefs.LOOKS]).toEqual(LOOKS);
    expect(Object.keys(homeMod.LAYOUT_OF_LOOK).sort()).toEqual([...LOOKS].sort());
    expect(["calm", "friendly"].map(homeMod.layoutOf)).toEqual(["cards", "cards"]);
    expect(["midnight", "editorial"].map(homeMod.layoutOf)).toEqual(["list", "list"]);
    expect(homeMod.layoutOf("bento")).toBe("tiles");
    for (const x of ["x", undefined, null, "", "constructor", "toString", "__proto__", "hasOwnProperty", 3]) expect(homeMod.layoutOf(x), String(x)).toBe("cards");
  });

  it("reads the look from the page and falls back to calm", () => {
    expect(homeMod.currentLook({ getAttribute: () => "bento" })).toBe("bento");
    const bad: any[] = [{ getAttribute: () => "nope" }, { getAttribute: () => null }, { getAttribute: () => "constructor" }, {}, undefined, null, { getAttribute: () => { throw new Error("x"); } }];
    for (const root of bad) expect(homeMod.currentLook(root)).toBe("calm");
  });

  it("builds the counters with their keys, labels, counts and addresses", () => {
    const m = hm();
    expect(m.counters.map((c: any) => [c.key, c.label, c.count, c.href])).toEqual([
      ["check", "Needs you", 3, "#/home?list=check"], ["building", "Running", 1, "#/home?list=building"],
      ["ready", "Ready to check", 1, "#/home?list=ready"], ["published-week", "Published this week", 1, "#/home?list=published-week"],
    ]);
    expect(m.counters[0].count).toBe(m.attention.length);
    expect(m.summary).toBe("3 things need you, 1 change is being built, 1 finished today");
  });

  it("keeps a known list and drops an unknown one", () => {
    expect(hm(rich, { list: "bogus" }).list).toBe("");
    expect(hm(rich, { list: "constructor" }).list).toBe("");
    expect(hm(rich, { list: "waiting" }).list).toBe("waiting");
    expect(hm(rich, { list: "ready" })).toMatchObject({ list: "ready", listTitle: "Ready to check" });
  });

  it("picks the current project: newest running work, else the first card, else the first project, else none", () => {
    const running = [on("a", "o/app", "running", { startedAt: iso(30), state: { next: "plan" } }), on("b", "o/other", "running", { startedAt: iso(5), state: { next: "implement" } }), on("q", "o/app", "approve_plan")];
    const m = hm(running);
    expect(m.project).toMatchObject({ id: "r2", name: "other", href: "#/repos/r2" });
    expect(m.project.phase).toBe(m.building.find((b: any) => b.id === "b").phase.index);
    expect(m.project.phase).toBeGreaterThan(0);
    expect(hm([on("q", "o/other", "approve_plan")]).project).toMatchObject({ id: "r2", phase: null });
    expect(hm([]).project).toMatchObject({ id: "r1", phase: null });
    expect(model.homeModel([], [], [], [], {}).project).toBeNull();
  });

  it("does not let paused work be the current project or give it a phase", () => {
    const go = on("go", "o/app", "running", { startedAt: iso(60), state: { next: "plan" } });
    // a newer paused item does not win over an older running one
    expect(hm([go, paused("p", "o/other", { startedAt: iso(1) })]).project.id).toBe("r1");
    // a project with only paused work has no current phase, and the first card decides the project
    const only = hm([paused("p", "o/app")]);
    expect(only.building).toHaveLength(1);
    expect(only.project).toMatchObject({ id: "r1", phase: null });
    expect(hm([paused("p", "o/app"), on("q", "o/other", "approve_plan")]).project).toMatchObject({ id: "r2", phase: null });
  });

  it("draws the cards layout, in order, for every look", () => {
    const pages = [...["calm", "friendly", "bento"].map((look) => box(homeMod.homeLayout(hm(), look))), box(homeMod.drawLayout(hm(), "cards"))];
    for (const page of pages) {
      const wrap = page.all("div")[0]!;
      expect(wrap.attrs.class).toBe("simple-home");
      expect(wrap.attrs["data-layout"]).toBe("cards");
      const order = wrap.children.filter((c: any) => c instanceof FakeElement).map((c: any) => c.tag + (c.attrs.class ? "." + c.attrs.class.split(" ")[0] : ""));
      expect(order).toEqual(["h1.today-greeting", "p.today-summary", "section.simple-card", "nav.today-counters", "section.today-attention", "section.today-building", "section.simple-card"]);
      expect(page.all("a").filter((a) => a.attrs.href === "#/start")).toHaveLength(1);
      expect(page.all("nav")[0]!.all("a").map((a) => a.attrs.href)).toEqual(["#/home?list=check", "#/home?list=building", "#/home?list=ready", "#/home?list=published-week"]);
      expect(page.all("nav")[0]!.all("a").map((a) => a.textContent)).toEqual(["3 Needs you", "1 Running", "1 Ready to check", "1 Published this week"]);
      expect(page.all("section").find((s) => s.attrs.class?.includes("today-attention"))!.all("a").filter((a) => a.attrs.class === "btn primary")).toHaveLength(3);
      expect(page.all("section").find((s) => s.attrs.class?.includes("today-building"))!.all("ol")).toHaveLength(1);
      expect(page.all("section").find((s) => s.attrs.class?.includes("simple-home-project"))!.all("ol")[0]!.all("li")).toHaveLength(5);
    }
  });

  it("dispatches by layout name, and falls back to cards where there is no view yet", () => {
    expect(box(homeMod.drawLayout(hm(), "list")).all("div")[0]!.attrs["data-layout"]).toBe("list");
    for (const layout of ["cards", "tiles", "nope", undefined, "constructor"]) {
      expect(box(homeMod.drawLayout(hm(), layout)).all("div")[0]!.attrs["data-layout"], String(layout)).toBe("cards");
    }
    // a view that is added later is used for its layout, and only for it
    homeMod.VIEWS.tiles = (m: any) => [homeMod.cardsLayout(m)[0]];
    try {
      expect(box(homeMod.drawLayout(hm(), "tiles")).all("div")[0]!.attrs["data-layout"]).toBe("tiles");
      expect(box(homeMod.homeLayout(hm(), "bento")).all("div")[0]!.attrs["data-layout"]).toBe("tiles");
      expect(box(homeMod.homeLayout(hm(), "midnight")).all("div")[0]!.attrs["data-layout"]).toBe("list");
      expect(box(homeMod.homeLayout(hm(), "calm")).all("div")[0]!.attrs["data-layout"]).toBe("cards");
    } finally {
      delete homeMod.VIEWS.tiles;
    }
  });

  it("has the same items and buttons under every look and every layout", async () => {
    const seen: any[] = [];
    const expected: any = { calm: "cards", friendly: "cards", midnight: "list", editorial: "list", bento: "cards" };
    for (const look of LOOKS) {
      const main = new FakeElement("div");
      const a: any = { repos: async () => repos, runs: async () => rich, queue: async () => ({ active: [], pending: [] }), run: () => {} };
      (await view.renderSimpleHome(main, { a, openGuide: () => {}, look: () => look }))();
      seen.push(signature(main));
      expect(main.all("div").find((d) => d.attrs["data-layout"])!.attrs["data-layout"]).toBe(expected[look]);
    }
    for (const s of seen) expect(s).toEqual(seen[0]);
    expect(seen[0].controls.length).toBeGreaterThan(8);
    const direct = ["cards", "list", "tiles"].map((l) => signature(box(homeMod.drawLayout(hm(), l))));
    for (const s of direct) expect(s).toEqual(direct[0]);
    // with an opened list, and with more items than are shown
    const many = [...rich, ...["m1", "m2", "m3", "m4"].map((id) => run(id, "questions"))];
    for (const m of [hm(rich, { list: "check" }), hm(many)]) {
      const sigs = ["cards", "list", "tiles"].map((l) => signature(box(homeMod.drawLayout(m, l))));
      for (const s of sigs) expect(s).toEqual(sigs[0]);
    }
  });

  it("has no forbidden term, passes the audit and has unique focus names on the whole home", () => {
    const page = box([...homeMod.homeLayout(hm(rich, { list: "check" }), "bento"), ...view.projectsView(model.projectsModel(repos, rich, []))]);
    expect(words.forbiddenIn(texts(page).join("\n"))).toEqual([]);
    expect(audit(page)).toEqual([]);
    const levels = walk(page).filter((e) => /^h\d$/.test(e.tag)).map((e) => Number(e.tag[1]));
    levels.forEach((l, i) => { if (i) expect(l - levels[i - 1]!).toBeLessThanOrEqual(1); });
    const names = walk(page).filter((e) => e.tag === "a" || e.tag === "summary").map((e) => e.attrs["data-focus"]);
    expect(names.every(Boolean)).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("the Help page", () => {
  const page = (contact?: string) => box(view.helpView(contact));
  const heads = (p: FakeElement, tag: string) => p.all(tag).map((e) => e.textContent);

  it("has a meaning for every Simple word, and no forbidden term in its own text", () => {
    expect(words.termWords()).toEqual([...new Set(Object.values(words.TERMS))]);
    for (const w of words.termWords()) expect(words.TERM_MEANINGS[w], w).toMatch(/\S/);
    const all = [words.HELP.title, words.HELP.wordsTitle, words.HELP.wordsIntro, words.HELP.howTitle, words.HELP.contactTitle,
      words.HELP.agentsTitle, words.HELP.agentsText, words.HELP.agentsLink,
      ...words.HELP.howtos.flatMap((t: any) => [t.q, t.a]), ...Object.values<string>(words.TERM_MEANINGS), ...words.termWords()];
    for (const t of all) expect(words.forbiddenIn(t), t).toEqual([]);
  });

  it("lists the words and both how-tos, and no Foundry term that is forbidden", () => {
    const p = page();
    expect(heads(p, "dt")).toEqual(words.termWords());
    expect(heads(p, "h3")).toEqual(["How do I change the colours?", "How do I make it public?"]);
    expect(heads(p, "h1")).toEqual(["Help"]);
    for (const k of Object.keys(words.TERMS)) if (words.forbiddenIn(k).length) expect(heads(p, "dt")).not.toContain(k);
  });

  it("links to the Claude and Codex page", () => {
    const links = page().all("a").filter((l) => l.getAttribute("href") === "#/agents");
    expect(links.map((l) => l.textContent)).toEqual([words.HELP.agentsLink]);
  });

  it("does not promise a fixed way to make a project public", () => {
    const a = words.HELP.howtos[1].a as string;
    expect(a).toContain("depends on how it was set up");
    expect(a).not.toContain("Check the result");
  });

  it("leaves out the contact line when the text is empty or only spaces", () => {
    for (const c of [undefined, "", "   ", null]) {
      const p = page(c as any);
      expect(p.textContent, String(c)).not.toContain("Who to ask");
      expect(p.all("section").some((s) => s.classList?.contains?.("simple-help-contact") || s.attrs.class?.includes("simple-help-contact"))).toBe(false);
    }
  });

  it("shows the contact line as text, never as HTML", () => {
    const p = page("  Ann Lee, ann@example.com ");
    expect(heads(p, "h2")).toContain("Who to ask");
    expect(p.textContent).toContain("Ann Lee, ann@example.com");
    const q = page("<b>Ann</b>");
    expect(q.all("b")).toHaveLength(0);
    expect(q.all("p").map((e) => e.textContent)).toContain("<b>Ann</b>");
  });

  it("shows no forbidden term, passes the audit and steps its headings by one", () => {
    const p = page("Ask Ann");
    expect(words.forbiddenIn(texts(p).join("\n")), texts(p).join("|")).toEqual([]);
    expect(audit(p)).toEqual([]);
    const levels = walk(p).filter((e) => /^h\d$/.test(e.tag)).map((e) => Number(e.tag[1]));
    levels.forEach((l, i) => { if (i) expect(l - levels[i - 1]!).toBeLessThanOrEqual(1); });
  });

  it("renderSimpleHelp reads the contact from the view answer, and never rejects", async () => {
    const draw = async (myView: () => Promise<unknown>) => {
      const main = new FakeElement("div");
      const stop = await view.renderSimpleHelp(main, { a: { myView } });
      expect(typeof stop).toBe("function");
      stop();
      return main;
    };
    expect((await draw(async () => ({ helpContact: "Ask Ann" }))).textContent).toContain("Ask Ann");
    for (const bad of [async () => { throw new Error("boom"); }, async () => ({ helpContact: 5 }), async () => null]) {
      const main = await draw(bad);
      expect(main.textContent).toContain("Help");
      expect(main.textContent).not.toContain("Who to ask");
    }
  });
});

describe("Try it", () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 300 && !cond(); i++) await tick();
    expect(cond()).toBe(true);
  };
  const URL_OK = "http://127.0.0.1:5173/";
  const labels = (p: FakeElement) => p.all("button").map((b) => b.textContent);
  const btn = (p: FakeElement, text: string) => p.all("button").find((b) => b.textContent === text)!;

  it("uses only words of the list", () => {
    for (const [k, v] of Object.entries<any>(words.TRY)) expect(words.forbiddenIn(typeof v === "function" ? v("Show the weather") : v), k).toEqual([]);
  });

  it("draws every phase of tryItView in plain words and passes the audit", () => {
    const choices = [{ runId: "a", title: "Show the weather" }];
    const one = (s: any, o: any = {}) => box(view.tryItView(s, { local: true, choices, ...o }));
    expect(labels(one({ phase: "idle" }))).toEqual(["Try it"]);
    const starting = one({ phase: "starting" });
    expect(starting.textContent).toContain("Starting…");
    expect(labels(starting)).toEqual(["Stop"]);
    const ready = one({ phase: "ready", url: URL_OK });
    const link = ready.all("a")[0]!;
    expect(link.attrs.href).toBe(URL_OK);
    expect(link.attrs.target).toBe("_blank");
    expect(link.attrs.rel).toBe("noopener noreferrer");
    expect(link.textContent).toBe("Open it (opens in a new tab)");
    expect(labels(ready)).toEqual(["Stop"]);
    const failed = one({ phase: "failed" });
    expect(failed.textContent).toContain("It could not start. The Foundry will look into it.");
    expect(labels(failed)).toEqual(["Try it"]);
    const choosing = one({ phase: "choosing" });
    expect(labels(choosing)).toEqual(["The current version", "The version being checked", "Not now"]);
    expect(choosing.textContent).toContain("Which version do you want to open?");
    expect(labels(one({ phase: "choosing" }, { choices: [{ runId: "a", title: "One" }, { runId: "b", title: "Two" }] }))).toEqual(
      ["The current version", "The version being checked: One", "The version being checked: Two", "Not now"]);
    const away = one({ phase: "idle" }, { local: false });
    expect(away.textContent).toBe("Try it works on the computer where the Foundry is installed.");
    expect(away.all("button")).toHaveLength(0);
    expect(one({ phase: "idle", error: true }).textContent).toContain("That did not work. Try again.");
    expect(btn(one({ phase: "starting", busy: true }), "Stop").attrs.disabled).toBe("");
    for (const s of [{ phase: "idle" }, { phase: "starting" }, { phase: "ready", url: URL_OK }, { phase: "failed", error: true }, { phase: "choosing" }]) {
      const p = one(s);
      expect(audit(p)).toEqual([]);
      expect(words.forbiddenIn(texts(p).join("\n"))).toEqual([]);
    }
  });

  it("maps the server's view to a phase and trusts only the loopback address", () => {
    const p = view.phaseOfPreview;
    expect(p({ state: "ready", url: "http://127.0.0.1:4000/" })).toBe("ready");
    expect(p({ state: "ready", url: "http://evil.example/" })).toBe("failed");
    expect(p({ state: "ready", url: "javascript:alert(1)" })).toBe("failed");
    expect(p({ state: "ready" })).toBe("failed");
    expect(p({ state: "failed" })).toBe("failed");
    expect(p({ state: "starting" })).toBe("starting");
    expect(p({ state: "stopped" })).toBe("idle");
    expect(p(undefined)).toBe("idle");
  });

  it("knows the computer of the Foundry by the host name", () => {
    for (const h of ["localhost", "127.0.0.1", "[::1]", "::1", "LOCALHOST"]) expect(view.isLocalHost(h), h).toBe(true);
    for (const h of ["foundry.example.com", "", undefined, "127.0.0.1.evil.com"]) expect(view.isLocalHost(h), String(h)).toBe(false);
  });

  it("marks a real run that waits for a check, not a final card or a queued job", () => {
    expect(model.cardOf({ run: run("a", "approve_plan"), job: null }).tryRun).toBe("a");
    expect(model.cardOf({ run: run("a", "approval"), job: null }).tryRun).toBe("a");
    expect(model.cardOf({ run: run("a", "running"), job: null }).tryRun).toBeUndefined();
    expect(model.cardOf({ run: null, job: { runId: "j", next: nextStep("queued", { runId: "j" } as any) } }).tryRun).toBeUndefined();
    const message = "Make this version final?\n- #1 Build me";
    const fin = { runId: "f1", flow: "release-daily", task: "daily", status: "waiting", startedAt: iso(5), vars: { github_repo: "o/app" }, history: [], waiting: { stepId: "make_final", message, since: iso(5) },
      next: nextStep("approval", { runId: "f1", repo: "o/app", title: "Make this version final" } as any, { message, final: true }) };
    expect(model.cardOf({ run: fin, job: null }).tryRun).toBeUndefined();
  });

  /** The project page "r1" with a fake API; `preview` answers come from the `answers` list (the last one repeats; an Error is thrown). */
  const open = async (o: { runs?: any[]; answers?: any[]; host?: string; start?: any; stop?: any; withPreview?: boolean } = {}) => {
    const answers = [...(o.answers ?? [{ state: "stopped" }])];
    const a: any = {
      repos: vi.fn(async () => repos), runs: vi.fn(async () => o.runs ?? []), queue: vi.fn(async () => ({ active: [], pending: [] })), run: vi.fn(),
      preview: vi.fn(async () => { const x = answers.length > 1 ? answers.shift() : answers[0]; if (x instanceof Error) throw x; return x; }),
      startPreview: o.start ?? vi.fn(async () => ({ state: "starting" })),
      stopPreview: o.stop ?? vi.fn(async () => ({ state: "stopped" })),
    };
    if (o.withPreview === false) { delete a.preview; delete a.startPreview; delete a.stopPreview; }
    const main = new FakeElement("div");
    const off = await view.renderSimpleProject(main, { id: "r1", a, host: o.host ?? "127.0.0.1", tryEvery: 1 });
    return { a, main, off, answers };
  };
  const waiting = () => [run("w", "approval")];

  it("starts the current version, shows Starting…, then the link, and stops reading", async () => {
    const { a, main, off } = await open({ answers: [{ state: "stopped" }, { state: "starting" }, { state: "starting" }, { state: "ready", url: URL_OK, output: "SECRET" }] });
    expect(main.textContent).toContain("Try it");
    btn(main, "Try it").click();
    await until(() => main.textContent.includes("Starting…"));
    expect(a.startPreview).toHaveBeenCalledWith("r1", "develop", undefined);
    await until(() => main.all("a").some((l) => l.attrs.href === URL_OK));
    const link = main.all("a").find((l) => l.attrs.href === URL_OK)!;
    expect(link.attrs.rel).toBe("noopener noreferrer");
    expect(link.attrs.target).toBe("_blank");
    expect(main.textContent).not.toContain("SECRET");
    const reads = a.preview.mock.calls.length;
    for (let i = 0; i < 10; i++) await tick();
    expect(a.preview.mock.calls.length).toBe(reads);
    off();
  });

  it("stops the preview and brings the Try it button back", async () => {
    const { a, main, off } = await open({ answers: [{ state: "ready", url: URL_OK }] });
    await until(() => labels(main).includes("Stop"));
    btn(main, "Stop").click();
    await until(() => labels(main).includes("Try it"));
    expect(a.stopPreview).toHaveBeenCalledWith("r1");
    off();
  });

  it("shows a preview that is already running when the page opens", async () => {
    const { main, off } = await open({ answers: [{ state: "ready", url: URL_OK }] });
    await until(() => main.all("a").some((l) => l.attrs.href === URL_OK));
    off();
  });

  it("shows none of the output, reason or detail when it failed", async () => {
    const { main, off } = await open({ answers: [{ state: "failed", reason: "exited", detail: "code 9", output: "SECRET <b>x</b> log" }] });
    await until(() => main.textContent.includes("It could not start. The Foundry will look into it."));
    for (const bad of ["SECRET", "exited", "code 9", " log"]) expect(main.textContent).not.toContain(bad);
    expect(labels(main)).toContain("Try it");
    off();
  });

  it("asks which version to open when a change waits, and sends the right body", async () => {
    const { a, main, off } = await open({ runs: waiting() });
    btn(main, "Try it").click();
    await until(() => main.textContent.includes("Which version do you want to open?"));
    expect(a.startPreview).not.toHaveBeenCalled();
    btn(main, "The version being checked").click();
    await until(() => a.startPreview.mock.calls.length === 1);
    expect(a.startPreview).toHaveBeenLastCalledWith("r1", "checking", "w");
    await until(() => labels(main).includes("Stop") && !btn(main, "Stop").attrs.disabled);
    btn(main, "Stop").click();
    await until(() => labels(main).includes("Try it"));
    btn(main, "Try it").click();
    await until(() => labels(main).includes("The current version"));
    btn(main, "The current version").click();
    await until(() => a.startPreview.mock.calls.length === 2);
    expect(a.startPreview).toHaveBeenLastCalledWith("r1", "develop", undefined);
    off();
  });

  it("goes back to the Try it button when Not now is pressed", async () => {
    const { a, main, off } = await open({ runs: waiting() });
    btn(main, "Try it").click();
    await until(() => labels(main).includes("Not now"));
    btn(main, "Not now").click();
    await until(() => labels(main).includes("Try it"));
    expect(a.startPreview).not.toHaveBeenCalled();
    off();
  });

  it("names each waiting change when there are several", async () => {
    const two = [run("w1", "approval", { task: "One (#1)\n\nx.", next: nextStep("approval", { runId: "w1", repo: "o/app", title: "One" } as any) }),
      run("w2", "approve_plan", { task: "Two (#2)\n\nx.", next: nextStep("approve_plan", { runId: "w2", repo: "o/app", title: "Two" } as any) })];
    const { main, off } = await open({ runs: two });
    btn(main, "Try it").click();
    await until(() => labels(main).includes("Not now"));
    expect(labels(main).filter((l) => l?.startsWith("The version being checked: "))).toEqual(["The version being checked: One", "The version being checked: Two"]);
    off();
  });

  it("a refused start of the checked version (no branch) says so in plain words and offers the choice again", async () => {
    const start = vi.fn(async (_id: string, version: string) => {
      if (version === "checking") throw Object.assign(new Error("this run has no branch to try"), { status: 409 });
      return { state: "starting" };
    });
    const { a, main, off } = await open({ runs: waiting(), start });
    btn(main, "Try it").click();
    await until(() => labels(main).includes("The version being checked"));
    btn(main, "The version being checked").click();
    await until(() => main.textContent.includes("That did not work. Try again."));
    expect(main.textContent).not.toContain("no branch");
    expect(labels(main)).toContain("The current version");
    btn(main, "The current version").click();
    await until(() => main.textContent.includes("Starting…"));
    expect(a.startPreview).toHaveBeenLastCalledWith("r1", "develop", undefined);
    off();
  });

  it("a refused start keeps the Try it button; a refused stop keeps the preview", async () => {
    const { main, off } = await open({ start: vi.fn(async () => { throw new Error("no"); }) });
    btn(main, "Try it").click();
    await until(() => main.textContent.includes("That did not work. Try again."));
    expect(labels(main)).toEqual(["Try it"]);
    off();
    const r = await open({ answers: [{ state: "ready", url: URL_OK }], stop: vi.fn(async () => { throw new Error("no"); }) });
    await until(() => labels(r.main).includes("Stop"));
    btn(r.main, "Stop").click();
    await until(() => r.main.textContent.includes("That did not work. Try again."));
    expect(r.main.all("a").some((l) => l.attrs.href === URL_OK)).toBe(true);
    expect(labels(r.main)).toEqual(["Stop"]);
    r.off();
  });

  it("sends one start for a double click, and disables the controls while it is on its way", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const start = vi.fn(async () => { await gate; return { state: "starting" }; });
    const { main, off } = await open({ start, answers: [{ state: "stopped" }, { state: "ready", url: URL_OK }] });
    const b = btn(main, "Try it");
    b.click();
    b.click();
    await until(() => start.mock.calls.length === 1);
    expect(btn(main, "Stop").attrs.disabled).toBe("");
    release();
    await until(() => main.all("a").some((l) => l.attrs.href === URL_OK));
    expect(start).toHaveBeenCalledTimes(1);
    off();
  });

  it("a read that was on its way does not replace the answer of a Stop", async () => {
    let letRead!: (v: any) => void;
    let n = 0;
    const a: any = {
      repos: async () => repos, runs: async () => [], queue: async () => ({ active: [], pending: [] }), run: vi.fn(),
      preview: vi.fn(() => (++n === 1 ? Promise.resolve({ state: "starting" }) : new Promise((r) => { letRead = r; }))),
      startPreview: vi.fn(), stopPreview: vi.fn(async () => ({ state: "stopped" })),
    };
    const main = new FakeElement("div");
    const off = await view.renderSimpleProject(main, { id: "r1", a, host: "localhost", tryEvery: 1 });
    await until(() => a.preview.mock.calls.length === 2);
    btn(main, "Stop").click();
    await until(() => labels(main).includes("Try it"));
    letRead({ state: "ready", url: URL_OK });
    for (let i = 0; i < 10; i++) await tick();
    expect(labels(main)).toEqual(["Try it"]);
    expect(main.all("a").some((l) => l.attrs.href === URL_OK)).toBe(false);
    off();
  });

  it("keeps reading after a failed read while it starts, and recovers", async () => {
    const { a, main, off } = await open({ answers: [{ state: "starting" }, new Error("down"), new Error("down"), { state: "ready", url: URL_OK }] });
    await until(() => main.textContent.includes("That did not work. Try again."));
    expect(main.textContent).toContain("Starting…");
    await until(() => main.all("a").some((l) => l.attrs.href === URL_OK));
    expect(main.textContent).not.toContain("That did not work");
    expect(a.preview.mock.calls.length).toBeGreaterThanOrEqual(4);
    off();
  });

  it("reads the preview after a retry when the first project list read failed", async () => {
    let listFails = true;
    const a: any = {
      repos: vi.fn(async () => { if (listFails) throw new Error("down"); return repos; }),
      runs: vi.fn(async () => []), queue: vi.fn(async () => ({ active: [], pending: [] })), run: vi.fn(),
      preview: vi.fn(async () => ({ state: "ready", url: URL_OK })),
      startPreview: vi.fn(), stopPreview: vi.fn(async () => ({ state: "stopped" })),
    };
    const main = new FakeElement("div");
    const off = await view.renderSimpleProject(main, { id: "r1", a, host: "127.0.0.1", tryEvery: 1 });
    expect(a.preview).not.toHaveBeenCalled();
    listFails = false;
    const retry = main.all("button").find((b) => b.textContent === "Retry")!;
    retry.click();
    await until(() => main.all("a").some((l) => l.attrs.href === URL_OK));
    expect(a.preview).toHaveBeenCalledTimes(1);
    off();
  });

  it("keeps the Try it button when the first read fails", async () => {
    const { a, main, off } = await open({ answers: [new Error("down")] });
    await until(() => a.preview.mock.calls.length === 1);
    await tick();
    expect(labels(main)).toEqual(["Try it"]);
    off();
  });

  it("stops reading when the page is left, also with a read on its way", async () => {
    let letRead!: (v: any) => void;
    let n = 0;
    const a: any = {
      repos: async () => repos, runs: async () => [], queue: async () => ({ active: [], pending: [] }), run: vi.fn(),
      preview: vi.fn(() => (++n < 3 ? Promise.resolve({ state: "starting" }) : new Promise((r) => { letRead = r; }))),
    };
    const main = new FakeElement("div");
    const off = await view.renderSimpleProject(main, { id: "r1", a, host: "127.0.0.1", tryEvery: 1 });
    await until(() => a.preview.mock.calls.length === 3);
    off();
    letRead({ state: "starting" });
    const reads = a.preview.mock.calls.length;
    for (let i = 0; i < 10; i++) await tick();
    expect(a.preview.mock.calls.length).toBe(reads);
  });

  it("shows a note and no button on another computer, and reads nothing", async () => {
    const { a, main, off } = await open({ host: "foundry.example.com" });
    expect(main.textContent).toContain("Try it works on the computer where the Foundry is installed.");
    expect(labels(main)).toEqual([]);
    expect(a.preview).not.toHaveBeenCalled();
    off();
  });

  it("still draws the button when the API has no preview calls", async () => {
    const { main, off } = await open({ withPreview: false });
    expect(labels(main)).toEqual(["Try it"]);
    btn(main, "Try it").click();
    await until(() => main.textContent.includes("That did not work. Try again."));
    off();
  });

  it("keeps the other actions of the caller and puts Try it between them", async () => {
    const a: any = { repos: async () => repos, runs: async () => [], queue: async () => ({ active: [], pending: [] }), run: vi.fn() };
    const main = new FakeElement("div");
    const off = await view.renderSimpleProject(main, { id: "r1", a, host: "localhost", actions: [{ id: "final", href: "#/y" }, { id: "change", href: "#/x" }] });
    const row = walk(main).find((e) => e.attrs.class === "simple-actions")!;
    expect(row.textContent).toBe("Ask for a changeTry itMake this version final");
    off();
  });
});
