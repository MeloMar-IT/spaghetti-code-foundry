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
beforeAll(async () => {
  restore = installFakeDom();
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
      ...words.PHASES.map((_: string, i: number) => words.progressText(i)),
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

  it("names the phase of a step", () => {
    const p = words.phaseOf;
    expect([p("implement"), p("fix_tests_2"), p("review_1"), p("plan"), p("pull_ticket"), p("commit")]).toEqual([1, 2, 2, 0, 0, 3]);
    // steps that come before the work starts, in the real issue flow
    expect([p("plan_review"), p("baseline_tests"), p("fetch_main")]).toEqual([0, 0, 0]);
    expect(p("x")).toBe(3);
    expect(p("")).toBe(0);
    expect(words.progressText(1)).toBe("Step 2 of 4: building");
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
    expect(c.progress).toBe("Step 2 of 4: building");
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
    expect(home!.all("h1")[0]!.textContent).toBe("My projects");
    expect(texts(home!).join("|")).toContain("Waiting for your answer");
    expect(box(view.projectsView([])).textContent).toContain("No projects yet");
  });

  it("shows what to do, the four groups and progress", () => {
    const page = box(view.projectView(model.projectsModel(repos, forbiddenRuns, [])[0], {}));
    const t = page.textContent;
    for (const s of ["What you need to do", "What is being made", "Planned", "Being built", "Ready for you to check", "Done", "Step 2 of 4: building"]) expect(t).toContain(s);
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

describe("the Help page", () => {
  const page = (contact?: string) => box(view.helpView(contact));
  const heads = (p: FakeElement, tag: string) => p.all(tag).map((e) => e.textContent);

  it("has a meaning for every Simple word, and no forbidden term in its own text", () => {
    expect(words.termWords()).toEqual([...new Set(Object.values(words.TERMS))]);
    for (const w of words.termWords()) expect(words.TERM_MEANINGS[w], w).toMatch(/\S/);
    const all = [words.HELP.title, words.HELP.wordsTitle, words.HELP.wordsIntro, words.HELP.howTitle, words.HELP.contactTitle,
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
