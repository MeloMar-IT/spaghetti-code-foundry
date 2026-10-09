import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { nextStep } from "../src/next-step.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/health.js" as string);
});
afterAll(() => restore());

interface Call { method: string; url: string; answer: (body: unknown, ok?: boolean) => void }
let calls: Call[];
let winListeners: Record<string, ((e?: unknown) => void)[]>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  vi.useFakeTimers();
  doc().visibilityState = "visible";
  doc().activeElement = null;
  doc().getElementById("modal-root").replaceChildren();
  calls = [];
  winListeners = {};
  (globalThis as any).addEventListener = (t: string, f: (e?: unknown) => void) => (winListeners[t] ??= []).push(f);
  (globalThis as any).removeEventListener = (t: string, f: unknown) => { winListeners[t] = (winListeners[t] ?? []).filter((x) => x !== f); };
  (globalThis as any).fetch = (url: string, init?: { method?: string }) =>
    new Promise((resolve) => {
      calls.push({ method: init?.method ?? "GET", url, answer: (body, ok = true) => resolve({ ok, status: ok ? 200 : 500, statusText: "x", json: async () => body }) });
    });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  globalThis.fetch = realFetch;
  delete (globalThis as any).addEventListener;
  delete (globalThis as any).removeEventListener;
});

const doc = () => (globalThis as any).document;
const root = () => doc().getElementById("modal-root") as FakeElement;
const dialogButton = (text: string) => root().all("button").find((b) => b.textContent === text)!;
const fireDoc = (t: string) => { for (const f of [...(doc().listeners[t] ?? [])]) f(); };
const hide = () => { doc().visibilityState = "hidden"; fireDoc("visibilitychange"); };
const show = () => { doc().visibilityState = "visible"; fireDoc("visibilitychange"); };

const flush = () => vi.advanceTimersByTimeAsync(0);
const good = { ok: true, summary: "All good", problems: [], repos: [] };
const closed = nextStep("closed_elsewhere", { repo: "o/a", issue: 4, title: "Four", runId: "r1" }, { issueUrl: "https://github.com/o/a/issues/4" });
const limit = nextStep("usage_limit", {}, { limitAgent: "codex", reason: "usage limit reached — resets 11:52" });
const bad = { ok: false, summary: "2 problems", problems: [limit, closed], repos: [{ repo: "o/a", lastOk: "2026-10-01T10:00:00Z" }, { repo: "o/b" }] };
const el = () => new FakeElement("div");

describe("renderHealth", () => {
  it("says All good", () => {
    const e = el();
    ui.renderHealth(e, good);
    expect(e.textContent).toBe("All good");
    expect(e.attrs.class).toBe("health ok");
    expect(e.hidden).toBe(false);
    expect(e.all("ul")).toHaveLength(0);
    expect(e.all("button")).toHaveLength(0);
  });

  it("lists skill problems with the label and reason, and counts the rest", () => {
    const e = el();
    ui.renderHealth(e, { ...good, ok: false, summary: "3 problems", skillProblems: [{ source: "admin", root: "skills.roots[0]", package: "x", reason: "bad version" }, { source: "admin", root: "built-in", reason: "ENOENT" }], skillProblemsMore: 1 });
    const items = e.all("li");
    expect(items).toHaveLength(3);
    expect(items[0]!.textContent).toBe("Skills (skills.roots[0] / x): bad version");
    expect(items[1]!.textContent).toBe("Skills (built-in): ENOENT");
    expect(items[2]!.textContent).toContain("1 more skill problem");
    const plain = el();
    ui.renderHealth(plain, good);
    expect(plain.all("ul")).toHaveLength(0);
  });

  it("lists each problem with its action, reason and link", () => {
    const e = el();
    ui.renderHealth(e, bad);
    expect(e.attrs.class).toBe("health bad");
    expect(e.textContent).toContain("2 problems");
    const items = e.all("li");
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain(limit.action);
    expect(items[0]!.textContent).toContain("The Codex usage limit is reached");
    expect(items[0]!.textContent).toContain("Continues: 11:52");
    expect(items[0]!.all("a")[0]!.attrs.href).toBe("#/runs");
  });

  it("has one Cancel run button, only for a closed issue, and it calls onCancel", () => {
    const e = el();
    const onCancel = vi.fn();
    ui.renderHealth(e, bad, { onCancel });
    const buttons = e.all("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.textContent).toBe("Cancel run");
    expect(e.all("li")[1]!.all("button")).toHaveLength(1);
    buttons[0]!.click();
    expect(onCancel).toHaveBeenCalledWith("r1");
  });

  it("shows the last successful check of each repository, also when all is good", () => {
    for (const h of [bad, { ...good, repos: bad.repos }]) {
      const e = el();
      ui.renderHealth(e, h);
      expect(e.textContent).toContain("o/a");
      expect(e.textContent).toContain("last successful check");
      expect(e.textContent).toContain("o/b · no successful check yet");
      expect(e.all("details")).toHaveLength(0);
    }
  });

  it("says when the server does not answer", () => {
    const e = el();
    ui.renderHealth(e, null);
    expect(e.textContent).toBe("The Foundry server does not answer. Check that it is still running.");
    expect(e.attrs.class).toBe("health bad");
    expect(e.all("b")[0]!.attrs.role).toBe("alert");
    const ok = el();
    ui.renderHealth(ok, good);
    expect(ok.all("b")[0]!.attrs.role).toBeUndefined();
  });
});

describe("loadHealth", () => {
  it("draws a good answer, and the no-answer text when the request fails", async () => {
    const e = el();
    const p = ui.loadHealth(e);
    calls[0]!.answer(good);
    await p;
    expect(e.textContent).toBe("All good");
    const q = ui.loadHealth(e);
    calls[1]!.answer({}, false);
    await q;
    expect(e.textContent).toContain("does not answer");
  });

  it("the newer of two requests wins", async () => {
    const e = el();
    const a = ui.loadHealth(e);
    const b = ui.loadHealth(e);
    calls[1]!.answer(good);
    await b;
    calls[0]!.answer(bad);
    await a;
    expect(e.textContent).toBe("All good");
  });

  const openCancel = async (e: FakeElement) => {
    const p = ui.loadHealth(e);
    calls[0]!.answer(bad);
    await p;
    const btn = e.all("button")[0]!;
    btn.focus();
    btn.click();
    await flush();
    return btn;
  };

  it("Keep running posts nothing", async () => {
    const e = el();
    const btn = await openCancel(e);
    expect(root().textContent).toContain("Cancel this run?");
    expect(root().textContent).toContain("You can resume it later.");
    expect(dialogButton("Cancel the run")).toBeDefined();
    dialogButton("Keep running").click();
    await flush();
    expect(calls).toHaveLength(1);
    expect(root().children).toHaveLength(0);
    expect(doc().activeElement).toBe(btn);
  });

  it("Cancel the run posts the cancel, then asks health again", async () => {
    const e = el();
    await openCancel(e);
    dialogButton("Cancel the run").click();
    await flush();
    expect(calls[1]).toMatchObject({ method: "POST", url: "/api/runs/r1/cancel" });
    calls[1]!.answer({});
    await flush();
    expect(calls[2]).toMatchObject({ url: "/api/health" });
  });

  it("a failed cancel still asks health again", async () => {
    const e = el();
    await openCancel(e);
    dialogButton("Cancel the run").click();
    await flush();
    calls[1]!.answer({}, false);
    await flush();
    expect(calls[2]).toMatchObject({ url: "/api/health" });
  });
});

describe("startHealth", () => {
  it("asks at once, once at a time, on a page change and every 30 seconds, until stopped", async () => {
    const stop = ui.startHealth(el());
    try {
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe("/api/health");
      winListeners.hashchange![0]!();
      expect(calls).toHaveLength(1);
      calls[0]!.answer(good);
      await flush();
      expect(calls).toHaveLength(2);
      calls[1]!.answer(good);
      await flush();
      await vi.advanceTimersByTimeAsync(29_000);
      expect(calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(calls).toHaveLength(3);
    } finally {
      stop();
    }
    expect(winListeners.hashchange).toHaveLength(0);
    expect(doc().listeners.visibilitychange ?? []).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(3);
  });

  it("draws the no-answer node once while the failure lasts", async () => {
    const e = el();
    const stop = ui.startHealth(e);
    try {
      calls[0]!.answer({}, false);
      await flush();
      const b = e.all("b")[0]!;
      await vi.advanceTimersByTimeAsync(30_000);
      calls[1]!.answer({}, false);
      await flush();
      expect(e.all("b")[0]).toBe(b);
      expect(doc().getElementById("health-btn").textContent).toBe("No answer");
    } finally {
      stop();
    }
  });

  it("does not redraw an unchanged answer", async () => {
    const e = el();
    const stop = ui.startHealth(e);
    try {
      calls[0]!.answer(bad);
      await flush();
      const first = e.children[0];
      await vi.advanceTimersByTimeAsync(30_000);
      calls[1]!.answer(bad);
      await flush();
      expect(e.children[0]).toBe(first);
      await vi.advanceTimersByTimeAsync(30_000);
      calls[2]!.answer(good);
      await flush();
      expect(e.textContent).toBe("All good");
    } finally {
      stop();
    }
  });

  it("loadHealth goes through the poller; after stop it asks at once", async () => {
    const e = el();
    const stop = ui.startHealth(e);
    try {
      ui.loadHealth(e);
      ui.loadHealth(e);
      expect(calls).toHaveLength(1);
      calls[0]!.answer(good);
      await flush();
      expect(calls).toHaveLength(2);
      calls[1]!.answer(good);
      await flush();
    } finally {
      stop();
    }
    const p = ui.loadHealth(e);
    expect(calls).toHaveLength(3);
    calls[2]!.answer(bad);
    await p;
    expect(e.textContent).toContain("2 problems");
  });

  it("a one-off answer does not draw over the poller", async () => {
    const e = el();
    ui.loadHealth(e);
    const stop = ui.startHealth(e);
    try {
      calls[1]!.answer(good);
      await flush();
      calls[0]!.answer(bad);
      await flush();
      expect(e.textContent).toBe("All good");
    } finally {
      stop();
    }
  });

  it("starting twice stops the first one: one listener set, one toggle per click", async () => {
    const chip = doc().getElementById("health-btn") as FakeElement;
    chip.listeners = {};
    const e = el();
    const stop1 = ui.startHealth(e);
    const stop2 = ui.startHealth(e);
    try {
      expect(winListeners.hashchange).toHaveLength(1);
      expect(chip.listeners.click).toHaveLength(1);
      expect(doc().listeners.visibilitychange).toHaveLength(1);
      calls[calls.length - 1]!.answer(good);
      await flush();
      chip.click();
      expect(e.hidden).toBe(false);
    } finally {
      stop1();
      stop2();
    }
    expect(winListeners.hashchange).toHaveLength(0);
    expect(chip.listeners.click).toHaveLength(0);
  });

  it("a hidden tab makes no request; returning makes one", async () => {
    doc().visibilityState = "hidden";
    const stop = ui.startHealth(el());
    try {
      expect(calls).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(90_000);
      winListeners.hashchange![0]!();
      expect(calls).toHaveLength(0);
      show();
      await flush();
      expect(calls).toHaveLength(1);
      calls[0]!.answer(good);
      await flush();
      hide();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it("does not redraw while a dialog is open, then draws the held answer", async () => {
    const e = el();
    const chip = doc().getElementById("health-btn") as FakeElement;
    const stop = ui.startHealth(e);
    try {
      calls[0]!.answer(bad);
      await flush();
      chip.click();
      const btn = e.all("button")[0]!;
      btn.focus();
      btn.click();
      await flush();
      await vi.advanceTimersByTimeAsync(30_000);
      calls[1]!.answer({ ...bad, summary: "3 problems" });
      await flush();
      expect(e.textContent).toContain("2 problems");
      expect(root().children.length).toBeGreaterThan(0);
      dialogButton("Keep running").click();
      await vi.advanceTimersByTimeAsync(250);
      expect(e.textContent).toContain("3 problems");
      expect(doc().activeElement.attrs["data-focus"]).toBe("health-cancel-r1");
    } finally {
      stop();
    }
  });
});

describe("renderHealth: version and update", () => {
  it("shows the running version and the update line, and no problem", () => {
    const e = el();
    const commit = "0123456789abcdef0123456789abcdef01234567";
    ui.renderHealth(e, { ...good, version: { commit, date: "2026-10-01T10:00:00Z" }, update: { waiting: true, commit, text: "An update is waiting (abcdef0): the checkout has local changes." } });
    const line = e.all("span").find((s) => s.attrs.class === "health-version muted")!;
    expect(line.textContent).toContain("Version 0123456 · ");
    expect(line.textContent).toContain("An update is waiting (abcdef0): the checkout has local changes.");
    expect(e.attrs.class).toBe("health ok");
  });

  it("shows nothing extra without them", () => {
    const e = el();
    ui.renderHealth(e, good);
    expect(e.all("span").filter((s) => s.attrs.class === "health-version muted")).toHaveLength(0);
  });
});

describe("the link to the Problems page", () => {
  const link = (monitorFindings?: unknown) => {
    const e = el();
    ui.renderHealth(e, { ...good, ...(monitorFindings ? { monitorFindings } : {}) });
    return e.all("a").find((a) => a.attrs.href === "#/problems");
  };
  it("counts the open findings", () => {
    expect(link({ open: 1, total: 1 })!.textContent).toBe("1 open finding of the monitor");
    expect(link({ open: 2, total: 5 })!.textContent).toBe("2 open findings of the monitor");
  });
  it("says none are open", () => {
    expect(link({ open: 0, total: 3 })!.textContent).toBe("Findings of the monitor (none open)");
  });
  it("says when the file cannot be read", () => {
    expect(link({ open: 0, total: 0, unreadable: true })!.textContent).toBe("Findings of the monitor (the file cannot be read)");
  });
  it("is not there without the field", () => {
    expect(link()).toBeUndefined();
  });
});

describe("the health chip", () => {
  const chipEl = () => (globalThis as any).document.getElementById("health-btn") as FakeElement;

  it("showHealth hides the line when all is good and not asked for", () => {
    const e = el();
    const chip = el();
    ui.showHealth(e, chip, good);
    expect(e.hidden).toBe(true);
    expect(chip.textContent).toBe("All good");
    expect(chip.attrs.class).toBe("health-chip ok");
    expect(chip.attrs["aria-expanded"]).toBe("false");
    ui.showHealth(e, chip, good, true);
    expect(e.hidden).toBe(false);
    expect(chip.attrs["aria-expanded"]).toBe("true");
  });

  it("showHealth shows the line when not ok, or when the server is silent", () => {
    const e = el();
    const chip = el();
    // A problem only turns the chip red; Home lists it. The line opens when asked for.
    ui.showHealth(e, chip, bad);
    expect(e.hidden).toBe(true);
    expect(chip.attrs.class).toBe("health-chip bad");
    ui.showHealth(e, chip, bad, true);
    expect(e.hidden).toBe(false);
    ui.showHealth(e, chip, null);
    expect(e.hidden).toBe(false);
    expect(chip.textContent).toBe("No answer");
    expect(() => ui.showHealth(e, null, good)).not.toThrow();
  });

  it("loadHealth sets line and chip; an older answer wins on neither", async () => {
    const e = el();
    const a = ui.loadHealth(e);
    const b = ui.loadHealth(e);
    calls[1]!.answer(good);
    await b;
    calls[0]!.answer(bad);
    await a;
    expect(e.textContent).toBe("All good");
    expect(e.hidden).toBe(true);
    expect(chipEl().textContent).toBe("All good");
    expect(chipEl().attrs.class).toBe("health-chip ok");
  });

  it("the chip opens and closes the line; stop removes the one listener", async () => {
    const chip = chipEl();
    chip.listeners = {};
    const e = el();
    const stop = ui.startHealth(e);
    expect(chip.listeners.click).toHaveLength(1);
    calls[0]!.answer(good);
    await flush();
    expect(e.hidden).toBe(true);
    chip.click();
    expect(e.hidden).toBe(false);
    expect(chip.attrs["aria-expanded"]).toBe("true");
    chip.click();
    expect(e.hidden).toBe(true);
    stop();
    expect(chip.listeners.click).toHaveLength(0);
  });
});
