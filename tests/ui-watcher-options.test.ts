import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let mod: any;
let form: any;
beforeAll(async () => {
  restore = installFakeDom();
  mod = await import("../ui/watcher-options.js" as string);
  form = await import("../ui/watcher-form.js" as string);
});
afterAll(() => restore());

const walk = (el: FakeElement): FakeElement[] => el.children.flatMap((c) => (c instanceof FakeElement ? [c, ...walk(c)] : []));
const o = (over: object = {}) => ({
  auto_defaults: false, wait_for_dependencies: true, comment_on_failure: true, status_comment: true, one_at_a_time: false,
  precheck_flow: "", pause_while_pr_open: "", priority_labels: "bug", dependency_done_labels: "", remove_on_done: "",
  status_labels: { working: "", done: "", needs_info: "", waiting: "", failed: "" }, ...over,
});
const FULL = {
  source: "issues", auto_defaults: true, precheck_flow: "epic-questions", priority_labels: ["urgent"], status_labels: { working: "W" },
  wait_for_dependencies: false, dependency_done_labels: ["released"], remove_on_done: ["go"], comment_on_failure: false, status_comment: false,
  one_at_a_time: true, pause_while_pr_open: "factory/daily-",
};

describe("optionsBody", () => {
  it("leaves out empty text on an add and has no null; passes the schema", async () => {
    const { RepoWatcherSchema } = await import("../src/config.js");
    const b = mod.optionsBody(o(), "issues", false);
    expect("precheck_flow" in b || "pause_while_pr_open" in b).toBe(false);
    expect(Object.values(b).includes(null)).toBe(false);
    expect(b.status_labels).toEqual({});
    const body = { id: "w", source: "issues", flow: "issue-gitflow", label: "go", every: "5m", max_per_tick: 1, enabled: true, vars: {}, ...b };
    expect(RepoWatcherSchema.safeParse(body).success).toBe(true);
  });
  it("clears with null on an edit and trims", () => {
    const b = mod.optionsBody(o(), "issues", true);
    expect([b.precheck_flow, b.pause_while_pr_open]).toEqual([null, null]);
    expect(mod.optionsBody(o({ pause_while_pr_open: " factory/daily- " }), "issues", true).pause_while_pr_open).toBe("factory/daily-");
  });
  it("sends only the filled status labels", () => {
    const s = { working: " W ", done: "", needs_info: "", waiting: "", failed: "" };
    expect(mod.optionsBody(o({ status_labels: s }), "issues", false).status_labels).toEqual({ working: "W" });
  });
  it("splits lists, and keeps an untouched stored label with a comma", () => {
    expect(mod.optionsBody(o({ priority_labels: "a, b," }), "issues", false).priority_labels).toEqual(["a", "b"]);
    expect(mod.optionsBody(o({ priority_labels: "" }), "issues", false).priority_labels).toEqual([]);
    const stored = ["customer, urgent"];
    expect(mod.optionsBody(o({ priority_labels: { text: "customer, urgent", stored } }), "issues", false).priority_labels).toBe(stored);
  });
  it("sends nothing for other sources or no options", () => {
    for (const s of ["schedule", "ci-failures", "pr-feedback"]) for (const e of [true, false]) expect(mod.optionsBody(o(), s, e)).toEqual({});
    expect(mod.optionsBody(undefined, "issues", true)).toEqual({});
  });
});

describe("watcherOptions", () => {
  it("has four closed groups and a default in every help text", () => {
    const x = mod.watcherOptions({}, []);
    const groups = walk(x.el).filter((e) => e.tag === "details");
    expect(groups.map((g) => walk(g).find((e) => e.tag === "summary")!.textContent)).toEqual(["Labels", "Dependencies", "Comments", "Reference repositories"]);
    expect(groups.some((g) => (g as any).open)).toBe(false);
    const helps = walk(x.el).filter((e) => e.tag === "small");
    expect(helps).toHaveLength(17);
    for (const s of helps) expect(s.textContent).toContain("Default:");
    expect(helps.map((s) => s.textContent)).toContain("The Foundry answers its own questions with its recommendations, at most twice per GitHub issue; after that a person answers. Default: off.");
  });
  it("shows defaults for a watcher without the keys, and stored values otherwise", () => {
    const d = mod.watcherOptions({}, []);
    expect(d.controls.priority_labels.value).toBe("bug");
    expect(["wait_for_dependencies", "comment_on_failure", "status_comment"].map((k) => d.controls[k].checked)).toEqual([true, true, true]);
    expect(["auto_defaults", "one_at_a_time"].map((k) => d.controls[k].checked)).toEqual([false, false]);
    const x = mod.watcherOptions(FULL, [{ name: "epic-questions" }]);
    expect(x.controls.priority_labels.value).toBe("urgent");
    expect(x.controls["status_labels.working"].value).toBe("W");
    expect(x.controls.pause_while_pr_open.value).toBe("factory/daily-");
    expect(x.controls.precheck_flow.value).toBe("epic-questions");
    expect(x.controls.auto_defaults.checked).toBe(true);
    const back = mod.optionsBody(x.values(), "issues", true);
    const { source, ...rest } = FULL;
    expect(source).toBe("issues");
    expect(back).toEqual({ ...rest, reference_repos: null, reference_private_ok: null });
  });
  it("saves and loads the reference options, for every source", () => {
    const w = { reference_repos: ["acme/lib", "acme/api"], reference_private_ok: true };
    for (const source of ["issues", "schedule", "pr-feedback", "ci-failures"]) {
      const x = mod.watcherOptions({ ...w, source }, []);
      expect(x.controls.reference_repos.value).toBe("acme/lib, acme/api");
      expect(x.controls.reference_private_ok.checked).toBe(true);
      const back = mod.optionsBody(x.values(), source, true);
      expect(back.reference_repos).toEqual(["acme/lib", "acme/api"]);
      expect(back.reference_private_ok).toBe(true);
      // the issues-only options stay issues-only
      expect("auto_defaults" in back).toBe(source === "issues");
    }
  });
  it("removes a cleared reference option on an edit and leaves it out on an add", () => {
    const cleared = { reference_repos: " ", reference_private_ok: false };
    expect(mod.optionsBody(o(cleared), "schedule", true)).toEqual({ reference_repos: null, reference_private_ok: null });
    expect(mod.optionsBody(o(cleared), "schedule", false)).toEqual({});
    expect(mod.optionsBody(o(cleared), "issues", false).reference_repos).toBeUndefined();
    expect(mod.optionsBody(o({ reference_repos: "acme/lib," }), "ci-failures", false)).toEqual({ reference_repos: ["acme/lib"] });
    expect(mod.optionsBody({ reference_repos: "acme/lib" }, "monitor", true)).toEqual({});
  });
  it("a body with the reference options passes the schema", async () => {
    const { RepoWatcherSchema } = await import("../src/config.js");
    const b = mod.optionsBody({ reference_repos: "acme/lib", reference_private_ok: true }, "schedule", false);
    const body = { id: "w", source: "schedule", task: "tidy", flow: "chore", every: "1d", enabled: true, vars: {}, ...b };
    expect(RepoWatcherSchema.safeParse(body).success).toBe(true);
  });
  it("lists None, the flows and an unknown stored flow", () => {
    const x = mod.watcherOptions({ precheck_flow: "gone" }, [{ name: "a" }]);
    expect(x.controls.precheck_flow.children.map((c: FakeElement) => c.textContent)).toEqual(["None", "a", "gone"]);
  });
  it("hides the issues options for other sources without an inline style, keeps the references, and reveals one group", () => {
    const x = mod.watcherOptions({}, []);
    const groups = () => walk(x.el).filter((e) => e.tag === "details");
    const issuesPart = x.el.children[0] as FakeElement;
    const refsGroup = groups()[3]!;
    for (const s of ["schedule", "pr-feedback", "ci-failures"]) {
      x.showFor(s);
      expect(x.el.hidden).toBe(false);
      expect(issuesPart.hidden).toBe(true);
      expect(!!refsGroup.hidden).toBe(false);
    }
    expect(Object.keys(x.el.style)).toEqual([]);
    x.showFor("issues");
    expect(x.el.hidden).toBe(false);
    expect(issuesPart.hidden).toBe(false);
    x.reveal(x.controls.pause_while_pr_open);
    expect(groups().map((g) => !!(g as any).open)).toEqual([false, true, false, false]);
    x.reveal(x.controls.reference_repos);
    expect(groups().map((g) => !!(g as any).open)).toEqual([false, true, false, true]);
  });
  it("reveals through contains() when the element has it, as a browser's does", () => {
    const x = mod.watcherOptions({}, []);
    const groups = walk(x.el).filter((e) => e.tag === "details");
    for (const g of groups) {
      const inside = walk(g);
      (g as any).contains = (t: FakeElement) => inside.includes(t);
      (g as any).children = { length: g.children.length }; // no .some(), like an HTMLCollection
    }
    x.reveal(x.controls.one_at_a_time);
    expect(groups.map((g) => !!(g as any).open)).toEqual([false, true, false, false]);
  });
  it("finds the control a server message names", () => {
    const x = mod.watcherOptions({}, []);
    expect(x.fieldOf("pause_while_pr_open: x")).toBe(x.controls.pause_while_pr_open);
    expect(x.fieldOf("status_labels.needs_info: x")).toBe(x.controls["status_labels.needs_info"]);
    expect(x.fieldOf("priority_labels.0: x")).toBe(x.controls.priority_labels);
    expect(x.fieldOf("precheck_flow: x")).toBe(x.controls.precheck_flow);
    expect(x.fieldOf('reference_repos: "acme/x" is not one of the repositories')).toBe(x.controls.reference_repos);
    expect(x.fieldOf("reference_repos.0: owner/name")).toBe(x.controls.reference_repos);
    expect(x.fieldOf("reference_private_ok: x")).toBe(x.controls.reference_private_ok);
    expect(x.fieldOf("every: x")).toBeUndefined();
  });
});

describe("optionNotes", () => {
  it("is empty at the defaults and for other sources", () => {
    expect(mod.optionNotes({ source: "issues" })).toEqual([]);
    expect(mod.optionNotes({ source: "issues", priority_labels: ["bug"], status_labels: { working: "factory:working" }, status_comment: true })).toEqual([]);
    expect(mod.optionNotes({ ...FULL, source: "schedule" })).toEqual([]);
  });
  it("names each option that is not at its default", () => {
    expect(mod.optionNotes(FULL)).toEqual([
      "answers its own questions (at most twice per GitHub issue)", "questions check: epic-questions", "labels that go first: urgent", "status labels: working → W",
      "does not wait for dependencies", "labels that count as done: released", "removes on success: go", "no comment on failure", "no status comment", "one run at a time",
    ]);
    expect(mod.optionNotes({ source: "issues", priority_labels: [] })).toEqual(["no label goes first"]);
  });
  it("names the reference options for every source", () => {
    const w = { reference_repos: ["acme/lib"], reference_private_ok: true };
    expect(mod.optionNotes({ ...w, source: "schedule" })).toEqual(["reads acme/lib (read only)", "may read private references"]);
    expect(mod.optionNotes({ ...w, source: "issues", one_at_a_time: true })).toEqual(["one run at a time", "reads acme/lib (read only)", "may read private references"]);
  });
});

describe("status label defaults", () => {
  it("are the names the engine uses", async () => {
    const { STATUS_LABELS } = await import("../src/queue/watcher.js");
    const engine = Object.fromEntries(Object.entries(STATUS_LABELS).map(([k, v]) => [k === "needsInfo" ? "needs_info" : k, v.name]));
    expect(mod.STATUS_DEFAULTS).toEqual(engine);
  });
});

describe("the form body", () => {
  it("repoWatcherBody adds the options", () => {
    const v = { id: "w", source: "issues", flow: "f", label: "go", every: "5m", max: "1", enabled: true, vars: {}, exclude: "", options: o() };
    expect(form.repoWatcherBody(v, false).auto_defaults).toBe(false);
    expect(form.repoWatcherBody({ ...v, source: "schedule" }, false).auto_defaults).toBeUndefined();
  });

  it("repoWatcherBody sends release_build for a schedule watcher only", () => {
    const v = { id: "w", source: "schedule", flow: "f", label: "go", every: "7d", max: "1", enabled: true, vars: {}, exclude: "", options: o() };
    expect(form.repoWatcherBody({ ...v, releaseBuild: true }, false).release_build).toBe(true);
    expect(form.repoWatcherBody({ ...v, releaseBuild: false }, false).release_build).toBe(false);
    expect("release_build" in form.repoWatcherBody({ ...v, source: "issues", releaseBuild: true }, false)).toBe(false);
    expect(form.repoWatcherBody({ ...v, source: "issues", releaseBuild: true }, true).release_build).toBeNull();
  });
});
