import { existsSync, readFileSync, readdirSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { nextStep } from "../src/next-step.js";
import { audit, auditHtml, parseHtml, type Violation } from "./helpers/a11y.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";
import { click as flowClick, dropBrowser, edit as flowEdit, flowJson, launchApp, main as flowMain } from "./helpers/flow-app.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
// The critical-journey gate: the screens of each journey are drawn in order inside the real page shell of each role,
// and the whole page is audited. A "serious" violation fails the test.
//
// A NEW SURFACE (the palette, tabs and drawers of #325–#330, or the redesign Work page) must add its screen to
// JOURNEYS below. Nothing here runs in a browser or with a screen reader; audit() is the small checker of
// tests/helpers/a11y.ts, not axe.
let restore: () => void;
const m: Record<string, any> = {};
beforeAll(async () => {
  restore = installFakeDom();
  for (const [k, f] of Object.entries({
    dom: "dom", shell: "shell", ia: "ia", auth: "auth", runs: "runs", board: "board", repos: "repos", users: "users",
  })) m[k] = await import(`../ui/${f}.js` as string);
  m.states = await import("../ui/states.js" as string);
  m.editor = await import("../ui/editor.js" as string);
  m.graph = await import("../ui/graph.js" as string);
  m.start = await import("../ui/user/start.js" as string);
  m.mine = await import("../ui/user/runs.js" as string);
});
afterAll(() => restore());

const read = (p: string) => readFileSync(p, "utf8");
const doc = () => (globalThis as any).document;
const realFetch = globalThis.fetch;
const REPO = "https://github.com/MeloMar-IT/spaghetti-code-foundry";

// ---- harness ------------------------------------------------------------------------------------

let answers: Record<string, unknown>;
let esHandlers: Record<string, (e: { data: string }) => void>;
const stops: (() => void)[] = [];

beforeEach(() => {
  restore();
  restore = installFakeDom();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
  answers = {};
  esHandlers = {};
  (globalThis as any).addEventListener = () => {};
  (globalThis as any).removeEventListener = () => {};
  (globalThis as any).EventSource = class {
    static CLOSED = 2;
    readyState = 1;
    addEventListener(type: string, fn: (e: { data: string }) => void) { esHandlers[type] = fn; }
    close() {}
  };
  (globalThis as any).fetch = async (url: string) => {
    const key = url.split("?")[0]!;
    if (!(key in answers)) throw new Error(`unexpected call: ${url}`);
    return { ok: true, status: 200, statusText: "OK", json: async () => answers[key] };
  };
});
afterEach(() => {
  for (const s of stops.splice(0)) s();
  dropBrowser();
  vi.unstubAllGlobals();
  vi.clearAllTimers();
  vi.useRealTimers();
  globalThis.fetch = realFetch;
  delete (globalThis as any).addEventListener;
  delete (globalThis as any).removeEventListener;
  delete (globalThis as any).EventSource;
});

const flush = () => vi.advanceTimersByTimeAsync(0);
const mkMedia = (matches: boolean) => Object.assign(new FakeElement("media"), { matches });
const mkStore = (value: string | null) => ({ getItem: () => value, setItem: () => {} });
const connect = (el: FakeElement) => { (el as any).isConnected = true; return el; };

type Shell = { body: FakeElement; main: FakeElement; byId: Map<string, FakeElement> };

/** The page file of a role, as the browser starts it, with the shell drawn and a destination shown. */
function mountShell(role: "admin" | "user", hash: string): Shell {
  const html = parseHtml(read(role === "admin" ? "ui/index.html" : "ui/user/index.html"));
  const body = html.all("body")[0]!;
  const byId = new Map<string, FakeElement>();
  const index = (el: FakeElement) => {
    if (el.attrs.id) byId.set(el.attrs.id, el);
    for (const c of el.children) if (c instanceof FakeElement) index(c);
  };
  index(body);
  const d = doc();
  const auto = d.getElementById.bind(d);
  d.body = body;
  d.getElementById = (id: string) => byId.get(id) ?? auto(id);
  d.querySelectorAll = (s: string) => body.querySelectorAll(s);
  stops.push(m.shell.initShell(role, { store: mkStore(null), media: mkMedia(false), user: { name: "Ann" } }));
  m.shell.showPage(role, m.ia.resolve(role, hash));
  return { body, main: connect(byId.get("main")!), byId };
}

/** Violations the gate fails on. Only the runs-table row click is exempt, and only while its link exists (see below). */
function serious(body: FakeElement): Violation[] {
  const rowHasLink = (tr: FakeElement) => {
    const first = tr.children.find((c): c is FakeElement => c instanceof FakeElement);
    return !!first && first.all("a").some((a) => "href" in a.attrs);
  };
  // One exemption per qualifying row (a "link" row with a clickable link in its first cell). A violation on a row beyond
  // that count — a second row with no link — is kept.
  let allowed = body.all("tr").filter((tr) => rowHasLink(tr) && (tr.attrs.class ?? "").includes("link") && tr.listeners.click?.length).length;
  return audit(body).filter((v) => {
    if (v.severity !== "serious") return false;
    if (v.rule === "click-needs-key" && v.element.startsWith("tr") && allowed > 0) { allowed--; return false; }
    return true;
  });
}

/** A screen counts only if it really drew: `marker` must be on the page, so an error state cannot pass. */
function gate(shell: Shell, marker: string) {
  expect(shell.body.textContent, `the screen shows "${marker}"`).toContain(marker);
  expect(serious(shell.body)).toEqual([]);
}
const press = (root: FakeElement, text: string) => root.all("button").find((b) => b.textContent.trim() === text)!.click();
const stopper = async <T>(r: T | Promise<T>) => { const s = await r; if (typeof s === "function") stops.push(s as () => void); return s; };

// ---- data ---------------------------------------------------------------------------------------

const RUN = (id: string, over: Record<string, unknown> = {}) => ({
  runId: id, flow: `flow-${id}`, status: "waiting", startedAt: new Date().toISOString(), history: [], totalCostUsd: 0, task: "do it", vars: {},
  next: nextStep("approval", { repo: "o/r", runId: id }, {}), ...over,
});
const myRun = (id: string, over: Record<string, unknown> = {}) => ({
  runId: id, flow: `flow-${id}`, task: "t", status: "running", startedAt: new Date().toISOString(), vars: {}, history: [],
  next: nextStep("running", { runId: id }, {}), ...over,
});
const COLS = ["your_turn", "waiting", "queued", "planning", "coding", "reviewing", "merging", "done", "failed"];
const card = (issue: number) => ({ key: `acme/app#${issue}`, issue, title: `Story ${issue}`, column: "waiting", runId: `r${issue}`, after: [], chain: [], watcher: "w1",
  next: nextStep("dependency", { repo: "acme/app", issue, title: `Story ${issue}`, runId: `r${issue}` }, { watched: true, blockers: [{ issue: 88 }] }),
});
const user = (over: object = {}) => ({ id: "u1", name: "Ann", email: "ann@example.com", role: "user", status: "active", created: new Date().toISOString(), lastSignIn: null, runs: 0, hasPassword: true, lockedUntil: null, ...over });
const repo = { id: "r1", url: "https://github.com/acme/app", method: "ssh-deploy-key", publicKey: "ssh-ed25519 AAAA", account: { name: "Ann", email: "a@example.com", status: "active", role: "user" }, connection: { ok: true, at: new Date().toISOString(), checks: [] }, settings: {} };
const startApi = {
  flows: async () => [{ name: "a", title: "A", description: "d", version: 1, usesTask: true, fields: [{ name: "branch", mode: "input", label: "branch", value: "", required: true, help: "Name" }] }],
  repos: async () => [{ id: "1", url: "https://github.com/o/r", method: "none", owner: "u", github: "o/r" }],
  repoMethods: async () => ({ methods: [], githubApp: { available: false } }),
  startRun: async () => ({ runId: "r1" }),
};

// ---- the journeys -------------------------------------------------------------------------------

type Role = "admin" | "user";
interface Journey { title: string; roles: Role[]; hash: Record<Role, string>; run: (role: Role, s: Shell) => Promise<void> }
const BOTH: Role[] = ["admin", "user"];

const JOURNEYS: Journey[] = [
  {
    title: "Sign in", roles: BOTH, hash: { admin: "#/home", user: "#/home" },
    async run(_role, s) {
      const SESSION = { user: { id: "u1", name: "Ann", email: "ann@example.com", role: "admin" }, csrfToken: "c", setupNeeded: false };
      const fakeApi = (session: unknown, over: object = {}) => ({
        session: async () => session, signIn: async () => ({}), signOut: async () => ({}), setup: async () => ({}), setPassword: async () => ({}), changePassword: async () => ({}), ...over,
      });
      vi.stubGlobal("location", { reload: () => {} });
      vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
      // The sign-in form, then a refused sign-in read out as an alert.
      void m.auth.ensureSignedIn(fakeApi({ user: null, setupNeeded: false }, { signIn: async () => { throw new Error("wrong e-mail or password"); } }), () => {});
      await flush();
      const form = s.main.all("form")[0]!;
      gate(s, "Sign in");
      form.all("input").forEach((i, n) => (i.value = ["ann@example.com", "bad"][n]!));
      form.fire("submit", { preventDefault() {} });
      await flush();
      gate(s, "wrong e-mail or password");
      // Signed in: the account menu.
      s.main.replaceChildren();
      await m.auth.ensureSignedIn(fakeApi(SESSION), () => {});
      const account = s.byId.get("account")!;
      account.attrs.open = "";
      gate(s, "Accessibility");
      const link = account.all("a").find((a) => a.textContent === "Accessibility")!;
      expect(link.attrs.href).toBe("/accessibility.html");
    },
  },
  {
    title: "Start work", roles: BOTH, hash: { admin: "#/start", user: "#/start" },
    async run(role, s) {
      await m.start.renderStart(s.main, { a: startApi, admin: role === "admin", go: () => {} });
      gate(s, "branch");
      s.main.all("form")[0]!.fire("submit", { preventDefault() {} });
      await flush();
      gate(s, "Fill in");
    },
  },
  {
    title: "Follow a run and read its log", roles: BOTH, hash: { admin: "#/runs", user: "#/runs" },
    async run(role, s) {
      if (role === "admin") {
        answers["/api/runs"] = [RUN("r1")];
        answers["/api/queue"] = { pending: [], active: [], concurrency: 2 };
        answers["/api/run-owners"] = [{ id: "u1", name: "Ann", runs: 1 }];
        await stopper(m.runs.renderRunsList(s.main));
        gate(s, "flow-r1");
        s.main.replaceChildren();
        await stopper(m.runs.renderRunDetail(s.main, "r1"));
        esHandlers.update!({ data: JSON.stringify({ summary: RUN("r1", { status: "running", next: nextStep("running", { runId: "r1" }, {}) }) }) });
      } else {
        const a = { runs: async () => [myRun("r1")], queue: async () => ({ pending: [] }) };
        await stopper(m.mine.renderMyRuns(s.main, { a }));
        gate(s, "flow-r1");
        s.main.replaceChildren();
        const b = { run: async () => myRun("r1"), queue: async () => ({ pending: [] }), events: () => ({ addEventListener: (t: string, f: any) => { esHandlers[t] = f; }, close() {}, readyState: 1 }) };
        await stopper(m.mine.renderMyRun(s.main, "r1", { a: b }));
        await flush();
      }
      esHandlers.log!({ data: JSON.stringify({ line: "▶ first" }) });
      s.main.all("button").find((b) => b.attrs["data-tab"] === "log")!.click();
      gate(s, "▶ first");
    },
  },
  {
    title: "Approve or reject", roles: BOTH, hash: { admin: "#/runs", user: "#/runs" },
    async run(role, s) {
      if (role === "admin") {
        await stopper(m.runs.renderRunDetail(s.main, "r1"));
        esHandlers.update!({ data: JSON.stringify({ summary: RUN("r1") }) });
        expect(s.main.all("button").some((b) => b.attrs["data-focus"] === "act-approve")).toBe(true);
        expect(s.main.all("button").some((b) => b.attrs["data-focus"] === "act-reject")).toBe(true);
        gate(s, "flow-r1");
      } else {
        const waiting = myRun("r1", { status: "waiting", next: nextStep("approval", { runId: "r1" }, {}) });
        const b = { run: async () => waiting, queue: async () => ({ pending: [] }), events: () => ({ addEventListener() {}, close() {}, readyState: 1 }), approveRun: async () => ({}), rejectRun: async () => ({}) };
        await stopper(m.mine.renderMyRun(s.main, "r1", { a: b }));
        await flush();
        gate(s, "flow-r1");
      }
      for (const kind of ["approve", "reject"]) {
        void m.mine.decisionDialog(kind, async () => ({}));
        await flush();
        gate(s, kind === "approve" ? "Approve" : "Reject");
        s.byId.get("modal-root")!.replaceChildren();
      }
    },
  },
  {
    title: "Answer planner questions", roles: BOTH, hash: { admin: "#/runs", user: "#/runs" },
    async run(_role, s) {
      const asking = myRun("r1", { status: "stopped", questions: "Q1?", canAnswer: true, next: nextStep("planner_questions", { runId: "r1" }, { answerHere: true }) });
      const b = { run: async () => asking, queue: async () => ({ pending: [] }), events: () => ({ addEventListener() {}, close() {}, readyState: 1 }), answerRun: async () => ({}) };
      await stopper(m.mine.renderMyRun(s.main, "r1", { a: b }));
      await flush();
      gate(s, "Q1?");
      s.main.all("form").find((f) => f.attrs.class === "run-answer")!.fire("submit", { preventDefault() {} });
      await flush();
      gate(s, "Write your answer first.");
    },
  },
  {
    title: "Open a board card", roles: ["admin"], hash: { admin: "#/board", user: "#/runs" },
    async run(_role, s) {
      answers["/api/board"] = { repos: [{ repo: "acme/app", columns: COLS.map((id) => ({ id, title: id, cards: id === "waiting" ? [card(89)] : [] })) }] };
      await stopper(m.board.renderBoard(s.main, "acme/app"));
      await flush();
      gate(s, "Story 89");
    },
  },
  {
    title: "Edit and save a flow", roles: ["admin"], hash: { admin: "#/flows", user: "#/runs" },
    async run(_role, s) {
      const real = { dom: m.dom, states: m.states, ia: m.ia, auth: m.auth };
      const app = await launchApp(real, "#/flows/my-flow", {}, { "./editor.js": m.editor, "./graph.js": m.graph });
      await vi.waitFor(() => expect(flowMain().all("h1")[0]).toBeDefined());
      // The form editor.
      gate(s, "Save");
      // The overview with the graph.
      flowClick(flowMain(), "Overview");
      expect(flowMain().all("svg").some((g) => g.attrs["aria-label"] === "Flow steps"), "the graph is drawn").toBe(true);
      gate(s, "Overview");
      // The YAML editor, then a refused save (validation) and a good one.
      flowClick(flowMain(), "YAML");
      gate(s, "Save");
      flowEdit(flowJson("my-flow", { description: "changed" }));
      gate(s, "Save");
      app.api.validate.mockResolvedValueOnce({ ok: false, error: "<flow>: steps: required" });
      flowClick(flowMain(), "Save");
      await vi.waitFor(() => expect(flowMain().textContent).toContain("Fix these errors before saving."));
      gate(s, "steps: required");
      flowClick(flowMain(), "Save");
      await vi.waitFor(() => expect(app.api.saveFlow).toHaveBeenCalled());
      await flush();
      gate(s, "Save");
      dropBrowser();
    },
  },
  {
    title: "Add a repository", roles: BOTH, hash: { admin: "#/repos", user: "#/repos" },
    async run(role, s) {
      answers["/api/repos"] = [repo];
      answers["/api/repos/methods"] = { methods: ["ssh-deploy-key", "https-token"] };
      await m.repos.renderRepos(s.main, { admin: role === "admin" });
      gate(s, "acme/app");
      void m.repos.repoDialog({ admin: role === "admin" });
      await flush();
      const modal = s.byId.get("modal-root")!;
      press(modal, "Add repository");
      await flush();
      expect(serious(s.body)).toEqual([]);
      expect(modal.all("input").some((i) => i.attrs["aria-invalid"] === "true")).toBe(true);
    },
  },
  {
    title: "Add a user", roles: ["admin"], hash: { admin: "#/users", user: "#/runs" },
    async run(_role, s) {
      answers["/api/users"] = [user({ id: "me", name: "Root", role: "admin" }), user()];
      answers["/api/users/limits"] = { defaults: {}, users: {} };
      await m.users.renderUsers(s.main, { me: "me", page: { origin: () => "https://x", clipboard: () => undefined, reload: () => {}, go: () => {} } });
      gate(s, "Ann");
      press(s.main, "+ Add user");
      await flush();
      gate(s, "Add user");
    },
  },
];

describe.each(JOURNEYS)("journey: $title", (j) => {
  it.each(j.roles)("has no serious violation for the %s display", async (role) => {
    await j.run(role, mountShell(role, j.hash[role]));
  });
});

describe("the gate", () => {
  it("fails for a control without a name", async () => {
    const s = mountShell("admin", "#/home");
    gate(s, "Accessibility");
    s.main.append(m.dom.h("button"));
    expect(serious(s.body).map((v) => v.rule)).toContain("control-name");
  });
  it("exempts the runs row click only while its link exists", () => {
    const row = (withLink: boolean) => {
      const tr = m.dom.h("tr", { class: "link" }, m.dom.h("td", {}, withLink ? m.dom.h("a", { href: "#/runs/r1" }, "r1") : "r1"));
      tr.addEventListener("click", () => {});
      return m.dom.h("table", { "aria-label": "Runs" }, m.dom.h("tbody", {}, tr));
    };
    expect(serious(row(true))).toEqual([]);
    expect(serious(row(false)).map((v) => v.rule)).toContain("click-needs-key");
  });
  it("keeps the violation of a second row that has no link", () => {
    const row = (withLink: boolean) => {
      const tr = m.dom.h("tr", { class: "link" }, m.dom.h("td", {}, withLink ? m.dom.h("a", { href: "#/runs/r1" }, "r1") : "r2"));
      tr.addEventListener("click", () => {});
      return tr;
    };
    const table = m.dom.h("table", { "aria-label": "Runs" }, m.dom.h("tbody", {}, row(true), row(false)));
    expect(serious(table).map((v) => v.rule)).toEqual(["click-needs-key"]);
  });
  it("gives only the journeys of the admin display an admin-only page", () => {
    for (const j of JOURNEYS.filter((x) => x.roles.length === 1)) expect(m.auth.isUserHash(j.hash.admin)).toBe(false);
  });
});

// ---- the statement ------------------------------------------------------------------------------

const bugs = JSON.parse(read("package.json")).bugs.url as string;
const page = read("ui/accessibility.html");

describe("the accessibility page", () => {
  it("passes the checker, has one h1 and only local assets", () => {
    expect(auditHtml(page)).toEqual([]);
    expect(page.match(/<h1\b/g)).toHaveLength(1);
    const refs = [...page.matchAll(/<(?:link|script)\b[^>]*\b(?:href|src)="([^"]+)"/g)].map((r) => r[1]!);
    expect(refs).toHaveLength(3);
    for (const r of refs) expect(r.startsWith("/")).toBe(true);
  });
  it("names WCAG 2.2 AA and the reporting address from package.json", () => {
    expect(page).toContain("WCAG 2.2 AA");
    for (const w of page.match(/WCAG \d\.\d/g) ?? []) expect(w).toBe("WCAG 2.2");
    expect(page).toContain("accessibility");
    expect(page.match(/<a\b[^>]*href="(https?:[^"]+)"/g)?.map((a) => /href="([^"]+)"/.exec(a)![1])).toEqual([bugs]);
    expect(bugs.startsWith(REPO)).toBe(true);
  });
  it("is linked from the account menu of both displays", () => {
    for (const f of ["ui/index.html", "ui/user/index.html"]) {
      const account = parseHtml(read(f)).all("details").find((d) => d.attrs.id === "account")!;
      expect(account.all("a").some((a) => a.attrs.href === "/accessibility.html" && a.textContent === "Accessibility"), f).toBe(true);
    }
  });
});

describe.skipIf(!existsSync("docs/ACCESSIBILITY.md"))("docs/ACCESSIBILITY.md", () => {
  const docText = existsSync("docs/ACCESSIBILITY.md") ? read("docs/ACCESSIBILITY.md") : "";
  const plain = docText.replace(/`/g, "").replace(/\*\*/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ");
  it("states the same standard and reporting address as the page", () => {
    expect(docText).toContain("WCAG 2.2 AA");
    for (const w of docText.match(/WCAG \d\.\d/g) ?? []) expect(w).toBe("WCAG 2.2");
    expect(docText).toContain(bugs);
    expect(docText).toContain("accessibility");
  });
  it("has every paragraph and list item of the page, word for word", () => {
    const main = parseHtml(page).all("main")[0]!;
    const texts = [...main.all("p"), ...main.all("li")].map((e) => e.textContent.replace(/\s+/g, " ").trim()).filter((t) => t !== "Back to Spaghetti Code Foundry");
    expect(texts.length).toBeGreaterThan(5);
    for (const t of texts) expect(plain, t).toContain(t);
  });
  it("names every accessibility test file, and only files that exist", () => {
    for (const f of docText.match(/tests\/[\w.-]+\.test\.ts/g) ?? []) expect(existsSync(f), f).toBe(true);
    for (const f of readdirSync("tests").filter((x) => /^ui-a11y.*\.test\.ts$/.test(x))) expect(docText, f).toContain(`tests/${f}`);
  });
});

describe.skipIf(!existsSync("docs/ACCESSIBILITY_SCRIPTS.md"))("docs/ACCESSIBILITY_SCRIPTS.md", () => {
  const text = existsSync("docs/ACCESSIBILITY_SCRIPTS.md") ? read("docs/ACCESSIBILITY_SCRIPTS.md") : "";
  const sections = text.split(/^## (?=\d+\. )/m).slice(1);
  it("has a section for every journey of the test, in order", () => {
    expect(sections.map((s) => s.split("\n")[0]!.replace(/^\d+\.\s*/, "").trim())).toEqual(JOURNEYS.map((j) => j.title));
  });
  it("has keyboard and screen-reader steps with expected results, and a results table", () => {
    for (const [i, s] of sections.entries()) {
      for (const part of ["Keyboard", "Screen reader"]) {
        const body = s.split(`### ${part}`)[1]?.split(/^### /m)[0] ?? "";
        const steps = body.split("\n").filter((l) => /^\d+\./.test(l));
        expect(steps.length, `${JOURNEYS[i]!.title}: ${part}`).toBeGreaterThanOrEqual(3);
        for (const st of steps) expect(st).toContain("**Expect:**");
      }
      expect(s).toContain("| Date | Browser | Screen reader | Pass/fail |");
      expect(/Admin only/.test(s), JOURNEYS[i]!.title).toBe(JOURNEYS[i]!.roles.length === 1);
    }
  });
});
