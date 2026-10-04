import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/problems.js" as string);
});
afterAll(() => restore());

const realFetch = globalThis.fetch;
const iso = (h: number) => new Date(2026, 9, 1, h, 0, 0).toISOString();
const wait = () => new Promise((r) => setTimeout(r, 20));
let sent: { method: string; url: string }[];
let bodies: any[];
let state: any;
let fails: Record<string, string>;
let details: any;
let config: any;

const finding = (n: number, over: Record<string, unknown> = {}) => ({
  id: String(n).padStart(16, "0"), detector: "restart-loop", summary: `sentence ${n}`, severity: "critical", firstSeen: iso(9), lastSeen: iso(10), count: 3, gone: false, state: "seen", ...over,
});
const story = (issue = 12, over: Record<string, unknown> = {}) => ({ issue, url: `https://github.com/o/a/issues/${issue}`, state: "open", ...over });
const base = () => ({
  state: "on", reportTo: true, running: true, lastCheck: iso(11), perDay: 3, madeToday: 1, breaker: { open: false },
  findings: [], mutes: [],
  detectors: [
    { name: "restart-loop", key: "restart_loop", description: "Runs restart again and again.", thresholds: { resumes: 5, within_minutes: 10 }, lastFound: iso(8) },
    { name: "self-update", key: "self_update", description: "A self-update failed." },
  ],
});

beforeEach(() => {
  sent = [];
  bodies = [];
  fails = {};
  state = base();
  details = { evidence: ["Flows: issue-gitflow"], stories: [{ issue: 12, url: "https://github.com/o/a/issues/12", current: true }, { issue: 9, url: "http://x/9", current: false }], runs: [{ id: "run-1", status: "failed", startedAt: iso(9) }] };
  config = { monitor: { restart_loop: { resumes: 5, within_minutes: 10 }, report_to: "o/a" }, other: 1 };
  (globalThis as any).fetch = async (url: string, init: { method: string; body?: string }) => {
    sent.push({ method: init.method, url });
    bodies.push(init.body ? JSON.parse(init.body) : undefined);
    const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: "x", json: async () => body });
    const failed = Object.keys(fails).find((k) => `${init.method} ${url}` === k);
    if (failed) return reply({ error: fails[failed] }, 409);
    if (url === "/api/monitor") return reply(state);
    if (url.startsWith("/api/monitor/findings/")) return reply(details);
    if (url === "/api/monitor/story") return reply({ story: { made: true, issue: 31, url: "https://github.com/o/a/issues/31" } });
    if (url === "/api/config") return reply(config);
    return reply({});
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete (globalThis as any).confirm;
});

const draw = async () => {
  const main = new FakeElement("div");
  await ui.renderProblems(main);
  return main;
};
const button = (el: FakeElement, text: string) => el.all("button").find((b) => b.textContent === text);
const modalRoot = () => (globalThis as any).document.getElementById("modal-root") as FakeElement;
const rowOf = (main: FakeElement, text: string) => main.all("tr").find((r) => r.textContent.includes(text))!;
const labels = (row: FakeElement) => row.all("button").map((b) => b.textContent);
const disabled = (b: FakeElement | undefined) => b?.attrs.disabled !== undefined;

describe("monitorSentence", () => {
  const s = (over: Record<string, unknown> = {}) => ui.monitorSentence({ ...base(), ...over });
  it("says on, with the last check, the count, the limit and the breaker", () => {
    const t = s();
    expect(t).toContain("The monitor is running; bug stories are on;");
    expect(t).toContain("it made 1 bug story today (on its own at most 3 a day)");
    expect(t).toContain("the circuit breaker is closed");
    expect(t).toContain("it last checked at");
  });
  it("says when no repository is set", () => {
    expect(s({ reportTo: false })).toContain("bug stories are on, but no repository is set");
  });
  it("says quiet, off, unreadable and the circuit breaker with its reason", () => {
    expect(s({ state: "quiet", until: iso(12) })).toContain("quiet until");
    expect(s({ state: "off", since: iso(12) })).toContain("bug stories are off since");
    expect(s({ state: "unreadable" })).toContain("monitor-guard.json cannot be read");
    const b = s({ state: "breaker", since: iso(12), breaker: { open: true, why: "7 new findings within 60 minutes" } });
    expect(b).toContain("the circuit breaker is open (7 new findings within 60 minutes)");
  });
  it("keeps all the facts when the monitor is not running, and says when it never checked", () => {
    const t = s({ running: false });
    expect(t).toContain("The monitor is not running;");
    expect(t).toContain("(since the server started)");
    expect(t).toContain("1 bug story today (on its own at most 3 a day)");
    expect(t).toContain("circuit breaker is closed");
    expect(s({ lastCheck: undefined })).toContain("it has not checked since the server started");
  });
  it("allows the count to be above the limit", () => {
    expect(s({ madeToday: 4 })).toContain("it made 4 bug stories today (on its own at most 3 a day)");
  });
});

describe("words", () => {
  it("stateText names all eight states and both kinds of muted", () => {
    const t = (state: string, over: Record<string, unknown> = {}) => ui.stateText({ state, story: story(12), ...over });
    expect(t("seen", { story: undefined })).toBe("seen, no story yet");
    expect(t("waiting")).toBe("bug story #12 is waiting");
    expect(t("building")).toBe("bug story #12 is being built");
    expect(t("fixed-watching")).toBe("fixed, watching");
    expect(t("came-back")).toBe("came back");
    expect(t("needs-you")).toBe("needs you");
    expect(t("gone")).toBe("gone");
    expect(t("muted", { mute: { id: "m", kind: "finding", reason: "noise" } })).toBe("muted for good: noise");
    expect(t("muted")).toBe("muted (the story was closed as not planned)");
  });
  it("storyButton covers the four cases", () => {
    expect(ui.storyButton(base())).toEqual({ label: "Make a story now", enabled: true });
    expect(ui.storyButton({ ...base(), running: false })).toEqual({ label: "Make a story now (the monitor is not running)", enabled: false });
    expect(ui.storyButton({ ...base(), state: "off" }).label).toBe("Make a story now (the monitor is off)");
    expect(ui.storyButton({ ...base(), state: "unreadable" }).label).toBe("Make a story now (the monitor is off)");
    expect(ui.storyButton({ ...base(), reportTo: false })).toEqual({ label: "Make a story now (no repository is set)", enabled: false });
  });
  it("thresholdLabel has words for known keys and a fallback", () => {
    expect(ui.thresholdLabel("within_minutes")).toBe("within minutes");
    expect(ui.thresholdLabel("checks")).toBe("checks in a row");
    expect(ui.thresholdLabel("some_new_key")).toBe("some new key");
  });
});

describe("the page", () => {
  const withFindings = () => {
    state.findings = [
      finding(1),
      finding(2, { state: "waiting", story: story(12) }),
      finding(3, { state: "needs-you", needsYou: true, story: story(13, { state: "closed" }) }),
      finding(4, { state: "muted", mute: { id: "m1", kind: "finding", reason: "noise" } }),
      finding(5, { state: "muted", detector: "slow-step", mute: { id: "m2", kind: "detector", reason: "known" } }),
      finding(6, { state: "muted", story: story(14, { state: "not_planned" }) }),
      finding(7, { state: "gone", gone: true }),
      finding(8, { state: "fixed-watching", story: story(15, { state: "closed" }) }),
    ];
  };

  it("draws the sentence, the rows in server order and the right buttons", async () => {
    withFindings();
    const main = await draw();
    expect(main.textContent).toContain("The monitor is running; bug stories are on;");
    const rows = main.all("table")[0]!.all("tr").slice(1);
    expect(rows.map((r) => /sentence (\d)/.exec(r.textContent)![1])).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    const l = (n: number) => labels(rowOf(main, `sentence ${n}`));
    expect(l(1)).toEqual(["Details", "Make a story now", "Mute", "This is not a problem"]);
    expect(l(2)).toEqual(["Details", "Mute", "This is not a problem"]);
    expect(l(3)).toEqual(["Details", "Try again", "Mute", "This is not a problem"]);
    expect(l(4)).toEqual(["Details", "End mute"]);
    expect(l(5)).toEqual(["Details", "End mute of detector slow-step"]);
    expect(l(6)).toEqual(["Details"]);
    expect(l(7)).toEqual(["Details"]);
    expect(l(8)).toEqual(["Details", "Mute", "This is not a problem"]);
    expect(rowOf(main, "sentence 2").textContent).toContain("seen in 3 checks");
  });

  it("says when there are no findings", async () => {
    expect((await draw()).textContent).toContain("No findings.");
  });

  it("warns instead of saying no findings when the file cannot be read", async () => {
    state.findingsUnreadable = true;
    const t = (await draw()).textContent;
    expect(t).toContain("cannot be read");
    expect(t).not.toContain("No findings.");
  });

  it("the switch button sends off or on and reloads", async () => {
    let main = await draw();
    sent = [];
    button(main, "Switch the monitor off")!.click();
    await wait();
    expect(sent[0]).toEqual({ method: "POST", url: "/api/monitor/off" });
    expect(sent.some((s) => s.url === "/api/monitor")).toBe(true);
    state = { ...base(), state: "off", since: iso(12) };
    main = await draw();
    sent = [];
    button(main, "Switch the monitor on")!.click();
    await wait();
    expect(sent[0]!.url).toBe("/api/monitor/on");
  });

  it("Details loads the finding once and shows evidence, story links and run links", async () => {
    withFindings();
    const main = await draw();
    sent = [];
    button(rowOf(main, "sentence 2"), "Details")!.click();
    await wait();
    expect(sent.filter((s) => s.url.startsWith("/api/monitor/findings/"))).toEqual([{ method: "GET", url: "/api/monitor/findings/0000000000000002" }]);
    const text = main.textContent;
    expect(text).toContain("Flows: issue-gitflow");
    expect(main.all("a").some((a) => a.attrs.href === "https://github.com/o/a/issues/12")).toBe(true);
    expect(main.all("a").some((a) => a.attrs.href === "http://x/9")).toBe(false);
    expect(text).toContain("#9 (earlier)");
    expect(main.all("a").some((a) => a.attrs.href === "#/runs/run-1")).toBe(true);
    button(rowOf(main, "sentence 2"), "Hide")!.click();
    button(rowOf(main, "sentence 2"), "Details")!.click();
    await wait();
    expect(sent.filter((s) => s.url.startsWith("/api/monitor/findings/"))).toHaveLength(1);
  });

  it("Details says what is missing, and shows a failed load", async () => {
    withFindings();
    details = { evidence: [], stories: [], runs: [] };
    let main = await draw();
    button(rowOf(main, "sentence 1"), "Details")!.click();
    await wait();
    for (const t of ["No evidence was recorded.", "No bug story yet.", "No run yet."]) expect(main.textContent).toContain(t);
    fails["GET /api/monitor/findings/0000000000000003"] = "unknown finding";
    main = await draw();
    button(rowOf(main, "sentence 3"), "Details")!.click();
    await wait();
    expect(main.textContent).toContain("unknown finding");
  });

  it("Make a story now posts the finding and reloads; it is disabled when the monitor is off", async () => {
    withFindings();
    const main = await draw();
    sent = [];
    bodies = [];
    button(rowOf(main, "sentence 1"), "Make a story now")!.click();
    await wait();
    expect(sent[0]).toEqual({ method: "POST", url: "/api/monitor/story" });
    expect(bodies[0]).toEqual({ finding: "0000000000000001" });
    expect(sent.some((s) => s.url === "/api/monitor")).toBe(true);
    state.state = "off";
    state.since = iso(12);
    const off = await draw();
    const b = button(rowOf(off, "sentence 1"), "Make a story now (the monitor is off)");
    expect(disabled(b)).toBe(true);
  });

  it("a refused story does not break the page", async () => {
    withFindings();
    fails["POST /api/monitor/story"] = "this finding is muted";
    const main = await draw();
    sent = [];
    button(rowOf(main, "sentence 1"), "Make a story now")!.click();
    await wait();
    expect(sent.some((s) => s.url === "/api/monitor")).toBe(true);
  });

  it("This is not a problem sends the finding and a reason without hours; an empty reason sends nothing", async () => {
    withFindings();
    const main = await draw();
    button(rowOf(main, "sentence 1"), "This is not a problem")!.click();
    expect(modalRoot().textContent).toContain("The monitor still records it, but never makes a bug story for it.");
    expect(modalRoot().all("select")).toHaveLength(0);
    sent = [];
    bodies = [];
    button(modalRoot(), "This is not a problem")!.click();
    await wait();
    expect(modalRoot().textContent).toContain("Give a reason.");
    expect(sent).toEqual([]);
    modalRoot().all("input")[0]!.value = "  by design  ";
    button(modalRoot(), "This is not a problem")!.click();
    await wait();
    expect(sent[0]).toEqual({ method: "POST", url: "/api/monitor/mutes" });
    expect(bodies[0]).toEqual({ finding: "0000000000000001", reason: "by design" });
  });

  it("Mute, End mute and Try again send their calls", async () => {
    withFindings();
    const main = await draw();
    sent = [];
    button(rowOf(main, "sentence 3"), "Try again")!.click();
    await wait();
    expect(sent[0]).toEqual({ method: "POST", url: "/api/monitor/retry" });
    sent = [];
    button(rowOf(main, "sentence 4"), "End mute")!.click();
    await wait();
    expect(sent[0]).toEqual({ method: "DELETE", url: "/api/monitor/mutes/m1" });
    sent = [];
    button(rowOf(main, "sentence 2"), "Mute")!.click();
    modalRoot().all("input")[0]!.value = "noise";
    button(modalRoot(), "Mute")!.click();
    await wait();
    expect(sent[0]).toEqual({ method: "POST", url: "/api/monitor/mutes" });
  });

  it("the detectors table shows description, inputs with values, none and the last found", async () => {
    const main = await draw();
    const d = main.all("table").at(-1)!;
    const r = rowOf(d, "restart-loop");
    expect(r.textContent).toContain("Runs restart again and again.");
    expect(r.all("input").map((i) => i.value)).toEqual(["5", "10"]);
    expect(r.textContent).toContain("within minutes");
    expect(r.textContent).toContain(new Date(iso(8)).toLocaleString());
    expect(rowOf(d, "self-update").textContent).toContain("none");
    expect(rowOf(d, "self-update").textContent).toContain("nothing in the last 30 days");
  });

  it("Save reads the config and sends only the changed threshold; an empty input sends nothing", async () => {
    const main = await draw();
    const r = rowOf(main.all("table").at(-1)!, "restart-loop");
    r.all("input")[0]!.value = "8";
    sent = [];
    bodies = [];
    button(r, "Save")!.click();
    await wait();
    expect(sent.slice(0, 2)).toEqual([{ method: "GET", url: "/api/config" }, { method: "PUT", url: "/api/config" }]);
    expect(bodies[1]).toEqual({ monitor: { restart_loop: { resumes: 8, within_minutes: 10 }, report_to: "o/a" }, other: 1 });
    const again = rowOf((await draw()).all("table").at(-1)!, "restart-loop");
    again.all("input")[1]!.value = "";
    sent = [];
    button(again, "Save")!.click();
    await wait();
    expect(again.textContent).toContain("Give a number.");
    expect(sent).toEqual([]);
  });

  it("a server error on Save is shown in the row", async () => {
    fails["PUT /api/config"] = "resumes must be at most 49";
    const r = rowOf((await draw()).all("table").at(-1)!, "restart-loop");
    button(r, "Save")!.click();
    await wait();
    expect(r.textContent).toContain("resumes must be at most 49");
  });

  it("draws 100 of 150 findings and Show 50 more draws the rest", async () => {
    // other tests opened the details of findings 1 to 3 (open rows are kept on purpose): use other ids
    state.findings = Array.from({ length: 150 }, (_, i) => finding(i + 1000));
    const main = await draw();
    const rows = () => main.all("table")[0]!.all("tr").length - 1;
    expect(rows()).toBe(100);
    button(main, "Show 50 more")!.click();
    expect(rows()).toBe(150);
  });

  it("shows the error when the monitor cannot be read", async () => {
    fails["GET /api/monitor"] = "no";
    expect((await draw()).textContent).toContain("no");
  });
});

describe("the pages", () => {
  it("the admin page links to Problems and the user page does not", () => {
    expect(readFileSync("ui/index.html", "utf8")).toContain('<a href="#/problems" data-nav="problems">Problems</a>');
    expect(readFileSync("ui/user/index.html", "utf8")).not.toContain("#/problems");
  });
});
