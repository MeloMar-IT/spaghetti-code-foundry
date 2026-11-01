import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installFakeDom, type FakeElement } from "./helpers/fake-dom.js";

// The text helpers and the "Components" card of Settings, on the fake DOM. No server, no timers.

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/admin-components.js" as string);
});
afterAll(() => restore());

const row = (o: object = {}) => ({
  kind: "flow", id: "walk", builtin: false, version: "1", owner: "team", risk: "low", lifecycle: "active",
  approvedVersion: "1", lastReview: "2026-10-01", evalSuite: "timeout", status: "ok", ...o,
});
const bare = row({ owner: null, version: null, approvedVersion: null, lastReview: null, evalSuite: null, status: "unapproved" });

describe("the text helpers", () => {
  it("names the four statuses and an unknown one", () => {
    expect(ui.statusInfo("retired")).toEqual({ label: "Retired", tone: "neutral" });
    expect(ui.statusInfo("unapproved")).toEqual({ label: "Not approved", tone: "warn" });
    expect(ui.statusInfo("review-due")).toEqual({ label: "Review due", tone: "warn" });
    expect(ui.statusInfo("ok")).toEqual({ label: "OK", tone: "ok" });
    expect(ui.statusInfo("weird")).toEqual({ label: "Unknown", tone: "warn" });
    expect(ui.statusInfo("toString").label).toBe("Unknown");
  });

  it("says No owner and Never reviewed when there is nothing", () => {
    expect(ui.ownerText({ owner: "me" })).toBe("me");
    expect(ui.ownerText({ owner: null })).toBe("No owner");
    expect(ui.reviewText({ lastReview: "2026-10-01" })).toBe("2026-10-01");
    expect(ui.reviewText({ lastReview: null })).toBe("Never reviewed");
  });
});

describe("the Settings card", () => {
  const realFetch = globalThis.fetch;
  let answers: Array<{ status?: number; body?: unknown }>;
  let calls: string[];
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const card = async () => {
    const el = ui.componentsPanel() as FakeElement;
    await flush();
    await flush();
    return el;
  };
  const buttons = (el: FakeElement) => el.all("button").map((b) => b.textContent);

  beforeEach(() => {
    answers = [];
    calls = [];
    (globalThis as any).fetch = async (url: string, init: any = {}) => {
      calls.push(`${init.method ?? "GET"} ${url}`);
      const a = answers.shift() ?? { body: { components: [], problems: [] } };
      const status = a.status ?? 200;
      return { ok: status < 400, status, statusText: "x", headers: { get: () => null }, json: async () => a.body };
    };
    return () => void ((globalThis as any).fetch = realFetch);
  });

  it("shows a loading state first, then the empty note", async () => {
    const el = ui.componentsPanel() as FakeElement;
    expect(el.textContent).toContain("Loading components…");
    await flush();
    await flush();
    expect(el.textContent).toContain("Components");
    expect(el.textContent).toContain("No components yet.");
    expect(calls).toEqual(["GET /api/admin/components"]);
  });

  it("writes a row as text, with the status as a word", async () => {
    answers.push({ body: { components: [row(), row({ id: "b", status: "review-due" })], problems: [] } });
    const el = await card();
    expect(el.all("tbody")[0]!.all("tr")).toHaveLength(2);
    const t = el.textContent;
    for (const s of ["team", "2026-10-01", "timeout", "OK", "Review due"]) expect(t).toContain(s);
  });

  it("shows No owner, Never reviewed, Not recorded and None for missing values, and marks a built-in", async () => {
    answers.push({ body: { components: [row({ ...bare, builtin: true })], problems: [] } });
    const t = (await card()).textContent;
    for (const s of ["No owner", "Never reviewed", "Not recorded", "None", "Not approved", "walk (built-in)"]) expect(t).toContain(s);
  });

  it("is a card table in a named region a keyboard can reach", async () => {
    answers.push({ body: { components: [row()], problems: [] } });
    const el = await card();
    const table = el.all("table")[0]!;
    expect(table.getAttribute("class")).toContain("cards");
    const box = table.parent!;
    expect(box.getAttribute("class")).toContain("table-box");
    expect(box.getAttribute("tabindex")).toBe("0");
    expect(box.getAttribute("role")).toBe("region");
    expect(box.getAttribute("aria-label")).toBeTruthy();
    expect(el.all("td").every((td) => td.getAttribute("data-label"))).toBe(true);
  });

  it("shows the governance problem as an alert and the other problems as lines", async () => {
    answers.push({ body: { components: [row()], problems: [{ kind: "flow", id: "bad", reason: "is not valid" }], governanceProblem: "promotions/governance.yaml is not valid" } });
    const el = await card();
    const alert = el.all("p").find((p) => p.getAttribute("role") === "alert")!;
    expect(alert.textContent).toBe("The governance records cannot be used: promotions/governance.yaml is not valid");
    expect(el.textContent).toContain("flow bad: is not valid");
  });

  it("shows the empty note, without throwing, for an answer of unknown shape", async () => {
    answers.push({ body: { surprise: true } });
    expect((await card()).textContent).toContain("No components yet.");
    answers.push({ body: null });
    expect((await card()).textContent).toContain("No components yet.");
  });

  it("shows an error with Retry, and loads again on Retry", async () => {
    answers.push({ status: 500, body: { error: "boom" } }, { body: { components: [row()], problems: [] } });
    const el = await card();
    expect(el.textContent).toContain("The components could not be loaded.");
    expect(buttons(el)).toContain("Retry");
    el.all("button").find((b) => b.textContent === "Retry")!.click();
    await flush();
    await flush();
    expect(el.all("table")).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it("shows the error state for a 403", async () => {
    answers.push({ status: 403, body: { error: "forbidden" } });
    const el = await card();
    expect(el.textContent).toContain("The components could not be loaded.");
    expect(el.all("table")).toHaveLength(0);
  });
});
