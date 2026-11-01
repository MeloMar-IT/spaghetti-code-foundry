import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installFakeDom, type FakeElement } from "./helpers/fake-dom.js";

// The promotion text model, the editor's notice and the "Promoted versions" card of Settings, on the fake DOM. No server, no timers.

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/promotions.js" as string);
});
afterAll(() => restore());

const REF = { kind: "flow", id: "my-flow", version: "3", sha256: "a".repeat(64) };
const block = (suite: string | undefined, code = "report-stale", remediation = "scf eval safety") => ({ code, ...(suite ? { suite } : {}), remediation });
const blocked = (...blocking: any[]) => ({ ref: REF, state: "blocked", blocking });
const LONG = `timeout-2026-01-01T00-00-00-000Z`.padEnd(150, "x");
const promoted = { ref: REF, state: "promoted", record: { reportId: LONG, reports: [], promotedAt: "x", by: "u" } };
const promotable = { ref: REF, state: "promotable", reports: [{ suite: "timeout", id: "timeout-2026-01-01T00-00-00-000Z", sha256: "b".repeat(64) }] };

describe("the text model", () => {
  it("writes the blocked line with and without a suite", () => {
    expect(ui.blockedLine(block("timeout"))).toBe("Not promoted: timeout (report-stale). scf eval safety");
    expect(ui.blockedLine(block(undefined, "not-found", "scf components flow"))).toBe("Not promoted (not-found). scf components flow");
  });

  it("summarizes each state as text", () => {
    expect(ui.promotionSummary(promoted)).toEqual({ tone: "ok", text: `Promoted: report ${LONG}`, more: 0 });
    expect(ui.promotionSummary(promotable)).toEqual({ tone: "neutral", text: "Ready to promote: every required suite holds.", more: 0 });
    expect(ui.promotionSummary(blocked(block("timeout"), block("output-caps", "suite-failed")))).toEqual({
      tone: "warn", text: "Not promoted: timeout (report-stale). scf eval safety", more: 1,
    });
    expect(ui.promotionSummary({ ref: REF, state: "weird" }).text).toBe("The promotion state could not be read.");
  });
});

describe("the editor notice", () => {
  const text = (row: any) => ui.promotionNotice(row)?.textContent;
  const links = (row: any) => (ui.promotionNotice(row).all("a") as FakeElement[]).map((a) => [a.textContent, a.getAttribute("href")]);

  it("shows nothing without a row", () => {
    expect(ui.promotionNotice(null)).toBeNull();
    expect(ui.promotionNotice(undefined)).toBeNull();
  });

  it("says the state in words, for every state", () => {
    expect(text(blocked(block("timeout")))).toContain("Not promoted: timeout (report-stale). scf eval safety");
    expect(text(promoted)).toContain(`Promoted: report ${LONG}`);
    expect(text(promotable)).toContain("Ready to promote: every required suite holds.");
    expect(text({ failed: true })).toContain("The promotion state could not be read.");
  });

  it("links to Settings for more blocks and for a promotable version", () => {
    expect(links(blocked(block("timeout")))).toEqual([]);
    expect(links(blocked(block("timeout"), block("a"), block("b")))).toEqual([["2 more blocked in Settings", "#/settings"]]);
    expect(links(promotable)).toEqual([["Promote it in Settings", "#/settings"]]);
  });

  it("uses the banner that wraps long words, with a role that tells a screen reader", () => {
    const n = ui.promotionNotice(promoted);
    expect(n.getAttribute("class")).toContain("scf-banner");
    expect(n.all("div").some((d: FakeElement) => d.getAttribute("class")?.includes("scf-banner__text"))).toBe(true);
    expect(ui.promotionNotice(blocked(block("timeout"))).getAttribute("role")).toBe("status");
  });
});

describe("the Settings card", () => {
  const realFetch = globalThis.fetch;
  let answers: Array<{ status?: number; body: unknown }>;
  let calls: Array<{ method: string; url: string; body?: any }>;
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const card = async (readOnly = false) => {
    const el = ui.promotionPanel({ readOnly }) as FakeElement;
    await flush();
    await flush();
    return el;
  };
  const buttons = (el: FakeElement) => el.all("button").map((b) => b.textContent);

  beforeEach(() => {
    answers = [];
    calls = [];
    (globalThis as any).fetch = async (url: string, init: any = {}) => {
      calls.push({ method: init.method ?? "GET", url, ...(init.body ? { body: JSON.parse(init.body) } : {}) });
      const a = answers.shift() ?? { body: { components: [], problems: [] } };
      const status = a.status ?? 200;
      return { ok: status < 400, status, statusText: "x", json: async () => a.body };
    };
    return () => void ((globalThis as any).fetch = realFetch);
  });

  it("shows a loading state first, and an empty note when there is nothing", async () => {
    const el = ui.promotionPanel() as FakeElement;
    expect(el.textContent).toContain("Loading promoted versions…");
    await flush();
    await flush();
    expect(el.textContent).toContain("Promoted versions");
    expect(el.textContent).toContain("No published flows or other components to promote yet.");
  });

  it("shows an error with Retry, and loads again on Retry", async () => {
    answers.push({ status: 500, body: { error: "boom" } });
    const el = await card();
    expect(el.textContent).toContain("The promoted versions could not be loaded.");
    expect(buttons(el)).toContain("Retry");
    answers.push({ body: { components: [promoted], problems: [] } });
    el.all("button").find((b) => b.textContent === "Retry")!.click();
    await flush();
    await flush();
    expect(el.textContent).toContain("flow my-flow v3");
    expect(calls.map((c) => c.url)).toEqual(["/api/promotions", "/api/promotions"]);
  });

  it("writes each row as text: the component, the state and, for several blocks, all of them", async () => {
    answers.push({ body: { components: [promoted, blocked(block("timeout"), block("output-caps", "suite-failed")), promotable], problems: [{ kind: "flow", id: "bad", reason: "is not valid" }], recordProblem: "promotions/records.json is not valid" } });
    const el = await card();
    const t = el.textContent;
    expect(t).toContain(`Promoted: report ${LONG}`);
    expect(t).toContain("Not promoted: timeout (report-stale). scf eval safety");
    expect(t).toContain("Not promoted: output-caps (suite-failed). scf eval safety");
    expect(t).toContain("Ready to promote: every required suite holds.");
    expect(t).toContain("flow bad is not valid");
    expect(t).toContain("The promotion records cannot be used: promotions/records.json is not valid");
    expect(el.all("details")).toHaveLength(1);
    expect(el.all("ul")[0]!.getAttribute("class")).toContain("scf-list");
  });

  it("promotes with the first report and loads the list again", async () => {
    answers.push({ body: { components: [promotable], problems: [] } }, { body: { component: promoted } }, { body: { components: [promoted], problems: [] } });
    const el = await card();
    el.all("button").find((b) => b.textContent === "Promote")!.click();
    await flush();
    await flush();
    await flush();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET /api/promotions", "POST /api/promotions", "GET /api/promotions"]);
    expect(calls[1]!.body).toEqual({ kind: "flow", id: "my-flow", reportId: "timeout-2026-01-01T00-00-00-000Z" });
    expect(buttons(el)).not.toContain("Promote");
    expect(el.textContent).toContain("Promoted: report");
  });

  it("reloads after a refusal, and shows the server's message", async () => {
    answers.push({ body: { components: [promotable], problems: [] } }, { status: 409, body: { error: "not promoted", blocking: [block("timeout", "suite-failed")] } }, { body: { components: [blocked(block("timeout", "suite-failed"))], problems: [] } });
    const el = await card();
    el.all("button").find((b) => b.textContent === "Promote")!.click();
    await flush();
    await flush();
    await flush();
    expect(calls).toHaveLength(3);
    expect(el.textContent).toContain("Not promoted: timeout (suite-failed). scf eval safety");
    expect(buttons(el)).not.toContain("Promote");
  });

  it("draws no Promote button when read-only", async () => {
    answers.push({ body: { components: [promotable], problems: [] } });
    const el = await card(true);
    expect(el.textContent).toContain("Ready to promote");
    expect(buttons(el)).not.toContain("Promote");
  });
});
