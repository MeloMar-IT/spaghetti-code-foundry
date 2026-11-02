import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let a: any;
beforeAll(async () => {
  restore = installFakeDom();
  a = await import("../ui/autonomy.js" as string);
});
afterAll(() => restore());

const LEVELS = ["observe", "plan-only", "guarded-write", "delivery-handoff"];
const check = (id: string, label: string, passed: boolean, value: unknown, threshold: unknown, detail = "d") => ({ id, label, passed, value, threshold, detail });
const gate = (passed: boolean) => ({
  passed,
  checks: [
    check("evidence_completeness", "Evidence completeness", passed, 0.975, 0.95),
    check("eval_pass_rate", "Eval pass rate", passed, null, 0.9),
    check("policy_conformance", "Policy conformance", passed, 0, "none"),
    check("operational_slos", "Operational SLOs", passed, 0, "none"),
    check("approval", "Approval", false, "pending", "approved"),
  ],
});
const comp = (over: Record<string, unknown> = {}): any => ({ kind: "flows", id: "delivery", name: "delivery", level: "plan-only", next: "guarded-write", gate: gate(true), ...over });
const status = (components: any[], over: Record<string, unknown> = {}): any => ({ levels: LEVELS, components, ownerName: "Olga", ...over });
const line = (over: Record<string, unknown> = {}): any => ({ time: "2026-10-01T10:00:00.000Z", actor: { type: "account", id: "u1", name: "Ann" }, action: "autonomy-promote", target: { type: "text", text: "flows:delivery" }, result: "ok", detail: "observe→plan-only", ...over });
const hist = (entries: any[] = [], more = false) => ({ entries, more });

const texts = (el: FakeElement, tag: string) => el.all(tag).map((x) => x.textContent);
const buttons = (el: FakeElement) => el.all("button").map((b) => b.textContent);
const button = (el: FakeElement, text: string): FakeElement => el.all("button").find((b) => b.textContent === text)!;

function make(over: Record<string, unknown> = {}) {
  const counts = { load: 0, history: 0 };
  const sent: any[] = [];
  const asked: any[] = [];
  const dialogs: any[] = [];
  const st = { status: status([comp()]), hist: hist(), failLoad: undefined as unknown, failHistory: undefined as unknown, full: undefined as any };
  const section = a.autonomySection({
    // the answers are read one turn late, so a test can set `st` right after make() and before the first answer
    load: async () => { counts.load++; await null; if (st.failLoad) throw st.failLoad; return st.status; },
    history: async (target?: string) => { counts.history++; await null; if (target) return st.full ?? hist(); if (st.failHistory) throw st.failHistory; return st.hist; },
    calls: {
      promote: async (b: any) => { sent.push(["promote", b]); },
      approve: async (b: any) => { sent.push(["approve", b]); },
      demote: async (b: any) => { sent.push(["demote", b]); },
    },
    note: (what: string, _e: unknown, retry: () => void) => { const n = new FakeElement("div"); n.append(`Could not load ${what}.`); n.append(button2(retry)); return n; },
    dialog: async (d: any) => { dialogs.push(d); await d.send({ to: d.levels[0], reason: "because" }); return true; },
    ask: async (o: any) => { asked.push(o); return true; },
    ...over,
  });
  return { section, counts, sent, asked, dialogs, st };
}
function button2(onClick: () => void) {
  const b = new FakeElement("button");
  b.append("Retry");
  b.addEventListener("click", onClick);
  return b;
}

describe("helpers", () => {
  it("writes values: shares as %, no value as a dash, none as text", () => {
    expect(a.gateValueText({ id: "evidence_completeness" }, 0.975)).toBe("97.5%");
    expect(a.gateValueText({ id: "eval_pass_rate" }, 0.9)).toBe("90%");
    expect(a.gateValueText({ id: "policy_conformance" }, 0)).toBe("0");
    expect(a.gateValueText({ id: "policy_conformance" }, null)).toBe("—");
    expect(a.gateValueText({ id: "policy_conformance" }, "none")).toBe("None allowed");
    expect(a.gateValueText({ id: "approval" }, "pending")).toBe("pending");
  });
  it("gives approval as Pending and the rest as Passed or Failed", () => {
    expect(a.checkResult({ id: "approval", passed: false }).label).toBe("Pending");
    expect(a.checkResult({ id: "x", passed: true }).label).toBe("Passed");
    expect(a.checkResult({ id: "x", passed: false }).label).toBe("Failed");
  });
  it("says what the gate says, without counting the approval check", () => {
    expect(a.gateText(gate(true))).toBe("The gate passes");
    expect(a.gateText(gate(false))).toBe("The gate does not pass: 4 of 4 checks fail");
  });
  it("decides which controls a component gets", () => {
    const s = status([]);
    expect(a.canPromote(comp(), s)).toBe(true);
    expect(a.canPromote(comp({ gate: gate(false) }), s)).toBe(false);
    expect(a.canPromote(comp({ next: null }), s)).toBe(false);
    expect(a.canPromote(comp({ request: { state: "pending" } }), s)).toBe(false);
    expect(a.canPromote(comp({ request: { state: "expired" } }), s)).toBe(true);
    expect(a.canPromote(comp(), status([], { problem: "x" }))).toBe(false);
    expect(a.canApprove(comp({ request: { state: "pending" }, approval: { mayApprove: true } }), s)).toBe(true);
    expect(a.canApprove(comp({ request: { state: "pending" }, approval: { mayApprove: false } }), s)).toBe(false);
    expect(a.canApprove(comp({ approval: { mayApprove: true } }), s)).toBe(false);
    expect(a.canDemote(comp({ level: "observe" }), s)).toBe(false);
    expect(a.canDemote(comp(), s)).toBe(true);
    expect(a.lowerLevels(LEVELS, "guarded-write")).toEqual(["observe", "plan-only"]);
    expect(a.lowerLevels(LEVELS, "nothing")).toEqual([]);
  });
  it("groups history by target and names a line with no account the Foundry", () => {
    const g = a.historyByTarget([line(), line({ target: { type: "text", text: "repos:r" } }), line({ target: null })]);
    expect([...g.keys()]).toEqual(["flows:delivery", "repos:r"]);
    expect(a.historyWho(line())).toBe("Ann");
    expect(a.historyWho(line({ actor: { type: "account", id: "gone" } }))).toBe("the Foundry");
    expect(a.historyWho(line({ actor: undefined }))).toBe("the Foundry");
    expect(a.actionText("autonomy-promote-request")).toBe("Promotion requested");
    expect(a.actionText("autonomy-promote")).toBe("Promoted");
    expect(a.actionText("autonomy-demote")).toBe("Demoted");
    expect(a.actionText("autonomy-auto-demote")).toBe("autonomy-auto-demote");
  });
});

describe("the section", () => {
  it("draws the level, the newest run with its link, 'No runs yet' and all five checks", async () => {
    const { section, st } = make();
    st.status = status([
      comp({ newestRun: { runId: "run-1", level: "observe", startedAt: "2026-10-01T00:00:00.000Z" } }),
      comp({ kind: "repos", id: "r1", name: "acme/app", level: "observe", next: "plan-only" }),
    ]);
    await section.ready;
    const el = section.el as FakeElement;
    expect(texts(el, "h2")).toEqual(["Repositories", "Flows"]);
    expect(el.textContent).toContain("Accountable owner: Olga.");
    const link = el.all("a").find((x) => x.attrs.href === "#/runs/run-1")!;
    expect(link.textContent).toBe("observe");
    expect(el.textContent).toContain("No runs yet");
    const rows = el.all("table")[0]!.all("tr").map((r) => r.all("td").map((c) => c.textContent)).filter((r) => r.length);
    expect(rows.map((r) => r[0])).toEqual(["Evidence completeness", "Eval pass rate", "Policy conformance", "Operational SLOs", "Approval"]);
    expect(rows[0]!.slice(1, 4)).toEqual(["Passed", "97.5%", "95%"]);
    expect(rows[1]!.slice(1, 4)).toEqual(["Passed", "—", "90%"]);
    expect(rows[2]!.slice(1, 4)).toEqual(["Passed", "0", "None allowed"]);
    expect(rows[4]!.slice(1, 4)).toEqual(["Pending", "pending", "approved"]);
  });

  it("shows waiting requests with who asked, who may approve and the self-approval mark", async () => {
    const { section, st } = make();
    st.status = status([comp({
      request: { token: "t", from: "plan-only", to: "guarded-write", reason: "ready", state: "pending" },
      approval: { requester: { id: "o", name: "Olga" }, approvers: [{ id: "o", name: "Olga", selfApproved: true }, { id: "p", name: "Pia", selfApproved: false }], mayApprove: false },
    })]);
    await section.ready;
    const el = section.el as FakeElement;
    expect(texts(el, "h2")).toContain("Waiting for approval");
    const row = el.all("table")[0]!.all("tr").map((r) => r.all("td").map((c) => c.textContent)).find((r) => r.length)!;
    expect(row).toEqual(["delivery", "plan-only → guarded-write", "Olga", "Olga (self-approval), Pia", "ready", ""]);
  });

  it("draws Promote only when it can work, and nothing in read-only", async () => {
    const cases: [string, Record<string, unknown>, Record<string, unknown>, boolean][] = [
      ["a passing gate", {}, {}, true],
      ["a failing gate", { gate: gate(false) }, {}, false],
      ["the top level", { next: null, level: "delivery-handoff" }, {}, false],
      ["a waiting request", { request: { token: "t", to: "guarded-write", reason: "r", state: "pending" } }, {}, false],
      ["an unreadable store", {}, { problem: "x" }, false],
    ];
    for (const [name, c, s, want] of cases) {
      const { section, st } = make();
      st.status = status([comp(c)], s);
      await section.ready;
      expect(buttons(section.el).includes("Promote"), name).toBe(want);
    }
    const { section, st } = make({ readOnly: true });
    st.status = status([comp({ request: { token: "t", to: "guarded-write", reason: "r", state: "pending" }, approval: { requester: { id: "o", name: "O" }, approvers: [], mayApprove: true } })]);
    await section.ready;
    expect(buttons(section.el)).toEqual([]);
  });

  it("draws Approve only for a person who may approve", async () => {
    for (const may of [true, false]) {
      const { section, st } = make();
      st.status = status([comp({ request: { token: "t", from: "plan-only", to: "guarded-write", reason: "r", state: "pending" }, approval: { requester: { id: "o", name: "O" }, approvers: [], mayApprove: may } })]);
      await section.ready;
      expect(buttons(section.el).includes("Approve")).toBe(may);
    }
  });

  it("draws Demote with only the lower levels, and not at observe", async () => {
    const { section, st, dialogs } = make();
    st.status = status([comp({ level: "guarded-write", next: "delivery-handoff" }), comp({ id: "x", name: "x", level: "observe", next: "plan-only" })]);
    await section.ready;
    expect(buttons(section.el).filter((b) => b === "Demote")).toHaveLength(1);
    button(section.el, "Demote").click();
    await Promise.resolve();
    await vi_tick();
    expect(dialogs[0].levels).toEqual(["observe", "plan-only"]);
  });

  it("sends the right body for each action, then loads only its two answers again and keeps the page and open items", async () => {
    const { section, st, counts, sent, asked } = make();
    st.status = status([comp({ request: undefined })]);
    await section.ready;
    const el = section.el as FakeElement;
    const details = el.all("details")[0]!;
    details.setAttribute("open", "");
    details.fire("toggle");
    expect(counts).toEqual({ load: 1, history: 1 });
    button(el, "Promote").click();
    await vi_tick();
    await section.ready;
    expect(sent).toEqual([["promote", { kind: "flows", id: "delivery", to: "guarded-write", reason: "because" }]]);
    expect(counts).toEqual({ load: 2, history: 2 });
    expect(section.el).toBe(el);
    expect(el.all("details")[0]!.getAttribute("open")).toBe("");

    st.status = status([comp({ request: { token: "tok", from: "plan-only", to: "guarded-write", reason: "r", state: "pending" }, approval: { requester: { id: "o", name: "O" }, approvers: [], mayApprove: true } })]);
    await section.ready;
    sent.length = 0;
    button(el, "Demote").click();
    await vi_tick();
    await section.ready;
    expect(sent[0]).toEqual(["demote", { kind: "flows", id: "delivery", to: "observe", reason: "because" }]);
    st.status = status([comp({ request: { token: "tok", from: "plan-only", to: "guarded-write", reason: "r", state: "pending" }, approval: { requester: { id: "o", name: "O" }, approvers: [], mayApprove: true } })]);
    await section.ready;
    sent.length = 0;
    el.all("button").filter((b) => b.textContent === "Approve")[0]!.click();
    await vi_tick();
    expect(asked[0]).toMatchObject({ confirm: "Approve", danger: false });
    expect(sent).toEqual([["approve", { kind: "flows", id: "delivery", to: "guarded-write", token: "tok" }]]);
  });

  it("ignores a second click while an action runs", async () => {
    let release!: () => void;
    const gateOpen = new Promise<void>((r) => (release = r));
    const { section, sent } = make({
      dialog: async (d: any) => { await gateOpen; await d.send({ to: d.levels[0], reason: "x" }); return true; },
    });
    await section.ready;
    const b = button(section.el, "Promote");
    b.click();
    b.click();
    release();
    await vi_tick();
    await section.ready;
    expect(sent).toHaveLength(1);
  });

  it("shows a refusal of an approval and keeps the page", async () => {
    const err = Object.assign(new Error("the request has expired"), { status: 409 });
    const { section, st, counts } = make({ calls: { promote: async () => {}, demote: async () => {}, approve: async () => { throw err; } } });
    st.status = status([comp({ request: { token: "tok", from: "plan-only", to: "guarded-write", reason: "r", state: "pending" }, approval: { requester: { id: "o", name: "O" }, approvers: [], mayApprove: true } })]);
    await section.ready;
    button(section.el, "Approve").click();
    await vi_tick();
    expect((section.el as FakeElement).all("p").some((p) => p.attrs.role === "alert" && p.textContent.includes("expired"))).toBe(true);
    expect(counts.load).toBe(1);
  });

  it("groups history by component, shows a failed line, an unknown action and a line with no account", async () => {
    const { section, st } = make();
    st.hist = hist([
      line({ actor: { type: "account", id: "gone" }, action: "autonomy-auto-demote", result: "failed", detail: "guarded-write→observe" }),
      line(),
      line({ target: { type: "text", text: "repos:other" }, detail: "not mine" }),
    ]);
    await section.ready;
    const el = section.el as FakeElement;
    const rows = el.all("table").at(-1)!.all("tr").map((r) => r.all("td").map((c) => c.textContent)).filter((r) => r.length);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.slice(1, 4)).toEqual(["the Foundry", "autonomy-auto-demote", "failed"]);
    expect(rows[1]!.slice(1, 4)).toEqual(["Ann", "Promoted", "ok"]);
    expect(el.textContent).not.toContain("not mine");
  });

  it("says when the history was cut and reads one component in full on request", async () => {
    const { section, st, counts } = make();
    st.hist = hist([line({ target: { type: "text", text: "repos:other" } })], true);
    st.full = hist([line({ detail: "old one" })]);
    await section.ready;
    const el = section.el as FakeElement;
    expect(el.textContent).toContain("Showing the newest 1 changes");
    expect(el.textContent).toContain("No change of this component in the newest lines.");
    button(el, "Show the changes of this component").click();
    await vi_tick();
    expect(counts.history).toBe(2);
    expect(el.textContent).toContain("old one");
    expect(buttons(el)).not.toContain("Show the changes of this component");
    expect(el.textContent).not.toContain("Only the newest");
  });

  it("keeps the cut of a component with more than 500 changes on screen, and does not call it complete", async () => {
    const { section, st } = make();
    st.hist = hist([line({ target: { type: "text", text: "flows:delivery" } })], true);
    st.full = hist(Array.from({ length: 500 }, (_, i) => line({ detail: `d${i}` })), true);
    await section.ready;
    const el = section.el as FakeElement;
    button(el, "Show the changes of this component").click();
    await vi_tick();
    expect(el.textContent).toContain("Only the newest 500 changes of this component are shown. Older ones are not on this page.");
    expect(buttons(el)).not.toContain("Show the changes of this component");
    const rows = el.all("table").at(-1)!.all("tr").filter((r) => r.all("td").length > 0);
    expect(rows).toHaveLength(500);
  });

  it("offers Retry when the autonomy file cannot be read, and recovers once it can", async () => {
    const { section, st, counts } = make();
    st.status = status([comp()], { problem: "The autonomy file could not be read." });
    await section.ready;
    const el = section.el as FakeElement;
    expect(el.textContent).toContain("The autonomy file could not be read.");
    expect(buttons(el)).toContain("Retry");
    expect(buttons(el)).not.toContain("Promote");
    st.status = status([comp()]);
    el.all("button").find((b) => b.textContent === "Retry")!.click();
    await section.ready;
    expect(counts.load).toBe(2);
    expect(el.textContent).not.toContain("could not be read");
    expect(buttons(el)).toContain("Promote");
  });

  it("shows a note with Retry when the load fails, and Retry loads again", async () => {
    const { section, st, counts } = make();
    st.failLoad = new Error("down");
    await section.ready;
    const el = section.el as FakeElement;
    expect(el.textContent).toContain("Could not load the autonomy levels.");
    st.failLoad = undefined;
    el.all("button").find((b) => b.textContent === "Retry")!.click();
    await section.ready;
    expect(counts.load).toBe(2);
    expect(texts(el, "h2")).toContain("Repositories");
  });

  it("keeps the levels when the history fails, and says so", async () => {
    const { section, st } = make();
    st.failHistory = new Error("log broken");
    await section.ready;
    const el = section.el as FakeElement;
    expect(el.textContent).toContain("Could not load the history.");
    expect(texts(el, "h2")).toContain("Flows");
    expect(el.all("table").length).toBe(1);
    expect(el.textContent).toContain("The history is not available now.");
  });

  it("does not call a failed run list 'No runs yet'", async () => {
    const { section, st } = make();
    st.status = status([comp()], { runsProblem: "The runs could not be listed." });
    await section.ready;
    const el = section.el as FakeElement;
    expect(el.textContent).toContain("The runs could not be listed.");
    expect(el.textContent).toContain("Not known");
    expect(el.textContent).not.toContain("No runs yet");
    expect(buttons(el)).toContain("Retry");
  });

  it("draws the banner and no actions when the store could not be read", async () => {
    const { section, st } = make();
    st.status = status([comp()], { problem: "The autonomy file could not be read." });
    await section.ready;
    const el = section.el as FakeElement;
    expect(el.textContent).toContain("The autonomy file could not be read.");
    expect(buttons(el)).toEqual(["Retry"]);
  });

  it("drops a late answer, and an undefined answer does not throw", async () => {
    let n = 0;
    const releases: (() => void)[] = [];
    const { section } = make({
      load: () => new Promise((r) => { const i = ++n; releases.push(() => r(status([comp({ name: i === 1 ? "old" : "new" })]))); }),
      history: async () => hist(),
    });
    // a second load starts through Retry-like reload: use stop() for the first
    const first = section.ready;
    section.stop();
    releases[0]!();
    await first;
    expect((section.el as FakeElement).textContent).not.toContain("old");
    const empty = make({ load: async () => undefined });
    await empty.section.ready;
    expect((empty.section.el as FakeElement).textContent).toContain("Could not load the autonomy levels.");
  });

  it("uses cards tables in named regions that Tab reaches, and real buttons with a focus name", async () => {
    const { section } = make();
    await section.ready;
    const el = section.el as FakeElement;
    for (const t of el.all("table")) {
      expect(t.attrs.class).toContain("cards");
      for (const td of t.all("td")) expect(td.attrs["data-label"]).toBeTruthy();
    }
    const regions = el.all("div").filter((d) => d.attrs.role === "region");
    expect(regions.length).toBeGreaterThan(0);
    for (const r of regions) {
      expect(r.attrs.tabindex).toBe("0");
      expect(r.attrs["aria-label"]).toBeTruthy();
    }
    for (const b of el.all("button")) expect(b.attrs["data-focus"]).toBeTruthy();
    expect(JSON.stringify(el.all("div").map((d) => d.attrs.style ?? ""))).not.toContain("px");
  });
});

describe("changeDialog", () => {
  const open = async (send: (v: any) => Promise<void>, levels = ["plan-only"]) => {
    const root = (document as any).getElementById("modal-root") as FakeElement;
    root.replaceChildren();
    const done = a.changeDialog({ title: "Promote x", levels, confirm: "Go", send });
    await vi_tick();
    const form = root.all("form")[0]!;
    const reason = root.all("textarea")[0]!;
    const alert = root.all("p").find((p) => p.attrs.role === "alert")!;
    return { root, done, form, reason, alert };
  };

  it("sends nothing for an empty reason", async () => {
    let called = 0;
    const d = await open(async () => { called++; });
    d.form.fire("submit", { preventDefault() {} });
    await vi_tick();
    expect(called).toBe(0);
    expect(d.alert.textContent).toBe("Give a reason.");
    expect(d.reason.attrs.maxlength).toBe("200");
    d.root.all("button").find((b) => b.textContent === "Not now")!.click();
    expect(await d.done).toBe(false);
  });

  it("sends the level and the trimmed reason, and resolves true", async () => {
    const got: any[] = [];
    const d = await open(async (v) => { got.push(v); });
    d.reason.value = "  ready now ";
    d.form.fire("submit", { preventDefault() {} });
    expect(await d.done).toBe(true);
    expect(got).toEqual([{ to: "plan-only", reason: "ready now" }]);
  });

  it("offers a choice of levels when there are several", async () => {
    const got: any[] = [];
    const d = await open(async (v) => { got.push(v); }, ["observe", "plan-only"]);
    const select = d.root.all("select")[0]!;
    expect(texts(select, "option")).toEqual(["observe", "plan-only"]);
    select.value = "plan-only";
    d.reason.value = "why";
    d.form.fire("submit", { preventDefault() {} });
    await d.done;
    expect(got[0].to).toBe("plan-only");
  });

  it("keeps the dialog open and shows the sentence when the server refuses", async () => {
    const d = await open(async () => { throw Object.assign(new Error("the gate does not pass"), { status: 409 }); });
    d.reason.value = "why";
    d.form.fire("submit", { preventDefault() {} });
    await vi_tick();
    expect(d.alert.textContent).toContain("the gate does not pass");
    expect(d.root.all("form")).toHaveLength(1);
    d.root.all("button").find((b) => b.textContent === "Not now")!.click();
    expect(await d.done).toBe(false);
  });
});

describe("the api calls", () => {
  it("builds the URLs and sends the bodies", async () => {
    const calls: [string, string, unknown][] = [];
    const saved = globalThis.fetch;
    (globalThis as any).fetch = async (url: string, init: { method: string; body?: string }) => {
      calls.push([init.method, url, init.body ? JSON.parse(init.body) : undefined]);
      return { ok: true, status: 200, statusText: "x", json: async () => ({}), headers: { get: () => null } };
    };
    try {
      const { api } = await import("../ui/api.js" as string);
      await api.autonomy();
      await api.autonomyHistory();
      await api.autonomyHistory("flows:a b");
      await api.promoteAutonomy({ kind: "flows", id: "x", to: "plan-only", reason: "r" });
      await api.approveAutonomy({ kind: "flows", id: "x", to: "plan-only", token: "t" });
      await api.demoteAutonomy({ kind: "flows", id: "x", to: "observe", reason: "r" });
    } finally {
      globalThis.fetch = saved;
    }
    expect(calls).toEqual([
      ["GET", "/api/autonomy", undefined],
      ["GET", "/api/autonomy/history", undefined],
      ["GET", "/api/autonomy/history?target=flows%3Aa%20b", undefined],
      ["POST", "/api/autonomy/promote", { kind: "flows", id: "x", to: "plan-only", reason: "r" }],
      ["POST", "/api/autonomy/approve", { kind: "flows", id: "x", to: "plan-only", token: "t" }],
      ["POST", "/api/autonomy/demote", { kind: "flows", id: "x", to: "observe", reason: "r" }],
    ]);
  });
});

/** Lets the promises of a click settle (the handlers await a few steps). */
async function vi_tick() {
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
}
