import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ms: any;
let home: any;
let adminHome: any;
let simple: any;
beforeAll(async () => {
  restore = installFakeDom();
  ms = await import("../ui/metrics-sharing.js" as string);
  home = await import("../ui/home.js" as string);
  adminHome = await import("../ui/home-admin.js" as string);
  simple = await import("../ui/simple.js" as string);
});
afterAll(() => restore());
const realFetch = globalThis.fetch;
beforeEach(() => {
  vi.useFakeTimers();
  ms.resetSharing();
  (document as any).visibilityState = "visible";
  (document as any).getElementById("modal-root").replaceChildren();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  globalThis.fetch = realFetch;
});

const flush = () => vi.advanceTimersByTimeAsync(0);
const ASKED = "Share the metrics of your runs?";
const state = (over: any = {}) => ({ allowed: true, answer: "unasked", changed: null, ...over });

/** A fake api: GET answers `current`, PUT stores the answer (or fails with `failPut`). */
function fakeApi(start: any = state()) {
  const a: any = {
    current: start,
    failPut: null as Error | null,
    puts: [] as string[],
    gets: 0,
    metricsSharing: vi.fn(async () => {
      a.gets++;
      if (a.current instanceof Error) throw a.current;
      return a.current;
    }),
    setMetricsSharing: vi.fn(async (answer: string) => {
      a.puts.push(answer);
      if (a.failPut) throw a.failPut;
      a.current = { allowed: true, answer, changed: "2026-11-20T10:00:00.000Z" };
      return a.current;
    }),
  };
  return a;
}
const card = (root: FakeElement) => root.all("section").find((s) => s.attrs.class === "card today-ask");
const button = (root: FakeElement, text: string) => root.all("button").find((b) => b.textContent === text)!;
const modalRoot = () => (document as any).getElementById("modal-root") as FakeElement;

describe("the Today item", () => {
  it("shows for an account that has not answered, with both links and both buttons", async () => {
    const slot = new FakeElement("div");
    const stop = ms.mountSharingAsk(slot, { a: fakeApi() });
    await flush();
    const c = card(slot)!;
    expect(c.textContent).toContain(ASKED);
    expect(c.textContent).toContain("Never shared");
    const hrefs = c.all("a").map((x) => x.attrs.href);
    expect(hrefs).toEqual(["https://spaghetti-code-foundry.com/privacy/metrics/", "/privacy.html#preview"]);
    const [privacy, preview] = c.all("a");
    expect(privacy.attrs.target).toBe("_blank");
    expect(privacy.attrs.rel).toBe("noopener noreferrer");
    expect(preview.attrs.target).toBeUndefined();
    expect(button(c, "Share")).toBeDefined();
    expect(button(c, "Don't share")).toBeDefined();
    stop();
  });

  it("takes the preview address it is given", async () => {
    const slot = new FakeElement("div");
    const stop = ms.mountSharingAsk(slot, { a: fakeApi(), previewHref: "#/metrics-preview" });
    await flush();
    expect(card(slot)!.all("a").map((x) => x.attrs.href)).toContain("#/metrics-preview");
    stop();
  });

  it("opens the What is shared dialog from its link (#888)", async () => {
    const a = fakeApi();
    a.metricsSharePreview = vi.fn(() => new Promise(() => {}));
    const slot = new FakeElement("div");
    const stop = ms.mountSharingAsk(slot, { a });
    await flush();
    const link = card(slot)!.all("a").find((x) => x.textContent === "What is shared")!;
    let prevented = false;
    link.fire("click", { preventDefault: () => (prevented = true) });
    expect(prevented).toBe(true);
    expect(a.metricsSharePreview).toHaveBeenCalledTimes(1);
    expect(modalRoot().all("h2").map((x) => x.textContent)).toEqual(["What is shared"]);
    stop();
  });

  it.each([
    ["yes", state({ answer: "yes", changed: "2026-11-01T00:00:00.000Z" })],
    ["no", state({ answer: "no", changed: "2026-11-01T00:00:00.000Z" })],
    ["sharing off", state({ allowed: false })],
    ["a failed read", new Error("boom")],
    ["a bad answer", {}],
  ])("is not shown for %s", async (_name, answer) => {
    const slot = new FakeElement("div");
    const stop = ms.mountSharingAsk(slot, { a: fakeApi(answer) });
    await flush();
    expect(card(slot)).toBeUndefined();
    stop();
  });

  it("does nothing without the api call", async () => {
    const slot = new FakeElement("div");
    const stop = ms.mountSharingAsk(slot, { a: {} });
    await flush();
    expect(slot.children).toEqual([]);
    stop();
  });

  it.each([["Share", "yes"], ["Don't share", "no"]])("%s sends %s and the item goes for good", async (label, answer) => {
    const a = fakeApi();
    const slot = new FakeElement("div");
    const stop = ms.mountSharingAsk(slot, { a });
    await flush();
    button(card(slot)!, label).click();
    await flush();
    expect(a.puts).toEqual([answer]);
    expect(card(slot)).toBeUndefined();
    stop();
    // a new page reads the stored answer: no item
    const again = new FakeElement("div");
    const stop2 = ms.mountSharingAsk(again, { a });
    await flush();
    expect(card(again)).toBeUndefined();
    stop2();
  });

  it("keeps the item and shows the error when the answer is not stored", async () => {
    const a = fakeApi();
    a.failPut = new Error("the audit log cannot be written");
    const slot = new FakeElement("div");
    const stop = ms.mountSharingAsk(slot, { a });
    await flush();
    const c = card(slot)!;
    button(c, "Share").click();
    await flush();
    expect(card(slot)).toBe(c);
    expect(c.textContent).toContain("the audit log cannot be written");
    expect(button(c, "Share").disabled).toBe(false);
    expect(button(c, "Don't share").disabled).toBe(false);
    stop();
  });

  it("waits for a hidden tab to be visible before it asks the server", async () => {
    (document as any).visibilityState = "hidden";
    const a = fakeApi();
    const slot = new FakeElement("div");
    const stop = ms.mountSharingAsk(slot, { a });
    await flush();
    expect(a.gets).toBe(0);
    (document as any).visibilityState = "visible";
    for (const fn of (document as any).listeners.visibilitychange ?? []) fn();
    await flush();
    expect(a.gets).toBe(1);
    expect(card(slot)).toBeDefined();
    stop();
    expect(((document as any).listeners.visibilitychange ?? []).length).toBe(0);
  });
});

describe("changes made in another session", () => {
  it("reach an open Today item without a remount, and stop when the page is left", async () => {
    const a = fakeApi();
    const slot = new FakeElement("div");
    const stop = ms.mountSharingAsk(slot, { a });
    await flush();
    expect(card(slot)).toBeDefined();
    // an admin switches sharing off in another session
    a.current = state({ allowed: false });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(card(slot)).toBeUndefined();
    // and on again: the item comes back
    a.current = state();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(card(slot)).toBeDefined();
    stop();
    const reads = a.gets;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(a.gets).toBe(reads);
  });

  it("refresh the Account settings button without a remount", async () => {
    const a = fakeApi();
    const box = new FakeElement("span");
    const out = new FakeElement("button");
    out.textContent = "Sign out";
    box.append(out);
    const stop = ms.mountAccountSettings(box, { a });
    await flush();
    expect(box.all("button").some((b) => b.textContent === "Account settings")).toBe(true);
    a.current = state({ allowed: false });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(box.all("button").some((b) => b.textContent === "Account settings")).toBe(false);
    stop();
  });
});

describe("the disposers", () => {
  it("leave no listener after repeated mounts", async () => {
    const a = fakeApi();
    for (let i = 0; i < 5; i++) {
      const stop = ms.mountSharingAsk(new FakeElement("div"), { a });
      await flush();
      stop();
    }
    expect(ms.sharingSubscribers()).toBe(0);
  });

  it("ignore a read that finishes after the page is gone", async () => {
    let answer: (v: any) => void = () => {};
    const a = fakeApi();
    a.metricsSharing = vi.fn(() => new Promise((r) => (answer = r)));
    const slot = new FakeElement("div");
    const stop = ms.mountSharingAsk(slot, { a });
    stop();
    answer(state());
    await flush();
    expect(slot.children).toEqual([]);
  });
});

describe("Account settings", () => {
  const menu = () => {
    const box = new FakeElement("span");
    const out = new FakeElement("button");
    out.textContent = "Sign out";
    box.append(out);
    return box;
  };
  const accountButton = (box: FakeElement) => box.all("button").find((b) => b.textContent === "Account settings");

  it("adds the button before Sign out while sharing is allowed, and follows the admin switch", async () => {
    const a = fakeApi();
    const box = menu();
    const slot = new FakeElement("div");
    const stopMenu = ms.mountAccountSettings(box, { a });
    const stopAsk = ms.mountSharingAsk(slot, { a });
    await flush();
    expect(box.all("button").map((b) => b.textContent)).toEqual(["Account settings", "Sign out"]);
    a.current = state({ allowed: false });
    await ms.refreshSharing(a);
    expect(accountButton(box)).toBeUndefined();
    expect(card(slot)).toBeUndefined();
    a.current = state();
    await ms.refreshSharing(a);
    expect(accountButton(box)).toBeDefined();
    expect(card(slot)).toBeDefined();
    stopMenu();
    stopAsk();
  });

  it("shows the answer and its date, stores a change, and reverts on failure", async () => {
    const a = fakeApi(state({ answer: "no", changed: "2026-11-01T12:00:00.000Z" }));
    void ms.accountSettingsDialog(a);
    await flush();
    const root = modalRoot();
    const box = root.all("input")[0]!;
    expect(box.checked).toBe(false);
    expect(root.textContent).toContain("Last changed on");
    box.checked = true;
    box.fire("change");
    await flush();
    expect(a.puts).toEqual(["yes"]);
    expect(box.checked).toBe(true);
    a.failPut = new Error("nope");
    box.checked = false;
    box.fire("change");
    await flush();
    expect(box.checked).toBe(true);
    expect(root.textContent).toContain("nope");
  });

  it("its privacy link opens the website page in a new tab", async () => {
    void ms.accountSettingsDialog(fakeApi());
    await flush();
    const link = modalRoot().all("a").find((x) => x.textContent === ms.SHARING.privacy)!;
    expect(link.attrs.href).toBe("https://spaghetti-code-foundry.com/privacy/metrics/");
    expect(link.attrs.target).toBe("_blank");
    expect(link.attrs.rel).toBe("noopener noreferrer");
  });

  it("the offline privacy page keeps its anchors and links to the website page", () => {
    const html = readFileSync("ui/privacy.html", "utf8");
    expect(html).toContain('id="shared-metrics"');
    expect(html).toContain('id="preview"');
    expect(html).toContain('href="https://spaghetti-code-foundry.com/privacy/metrics/"');
  });

  it("says when there is no answer yet", async () => {
    void ms.accountSettingsDialog(fakeApi());
    await flush();
    expect(modalRoot().textContent).toContain("You have not answered yet.");
  });

  it("its What is shared link closes it and opens the What is shared dialog (#888)", async () => {
    const a = fakeApi();
    a.metricsSharePreview = vi.fn(() => new Promise(() => {}));
    const settings = ms.accountSettingsDialog(a);
    await flush();
    const link = modalRoot().all("a").find((x) => x.textContent === "What is shared")!;
    expect(link.attrs.href).toBe("/privacy.html#preview");
    link.click();
    await flush();
    await settings;
    expect(a.metricsSharePreview).toHaveBeenCalledTimes(1);
    expect(modalRoot().all("h2").map((x) => x.textContent)).toEqual(["What is shared"]);
  });

  it("shows yes after Share on Today, and Today follows an answer given in the dialog", async () => {
    const a = fakeApi();
    const slot = new FakeElement("div");
    const stop = ms.mountSharingAsk(slot, { a });
    await flush();
    button(card(slot)!, "Share").click();
    await flush();
    void ms.accountSettingsDialog(a);
    await flush();
    expect(modalRoot().all("input")[0]!.checked).toBe(true);
    stop();

    ms.resetSharing();
    const b = fakeApi();
    const slot2 = new FakeElement("div");
    const stop2 = ms.mountSharingAsk(slot2, { a: b });
    await flush();
    expect(card(slot2)).toBeDefined();
    void ms.accountSettingsDialog(b);
    await flush();
    const input = modalRoot().all("input")[0]!;
    input.checked = true;
    input.fire("change");
    await flush();
    expect(card(slot2)).toBeUndefined();
    stop2();
  });
});

describe("the Today pages", () => {
  const base = (a: any) => Object.assign(a, { runs: async () => [], queue: async () => ({ pending: [], active: [] }), myTurn: async () => ({ items: [] }), repos: async () => [] });

  it("Advanced Today shows the item first and its cleanup removes the listener", async () => {
    const a = base(fakeApi());
    const main = new FakeElement("main");
    const off = await home.renderHome(main, { a });
    await flush();
    expect(card(main)).toBeDefined();
    expect(main.textContent.indexOf(ASKED)).toBeLessThan(main.textContent.indexOf("Good "));
    off();
    expect(ms.sharingSubscribers()).toBe(0);
  });

  it("Simple Today shows the item and its cleanup removes the listener", async () => {
    const a = base(fakeApi());
    const main = new FakeElement("main");
    const off = await simple.renderSimpleHome(main, { a });
    await flush();
    expect(card(main)).toBeDefined();
    off();
    expect(ms.sharingSubscribers()).toBe(0);
  });

  it("Admin Today shows the item and its cleanup removes the listener", async () => {
    globalThis.fetch = (async (url: string) => {
      const path = url.split("?")[0];
      const body: any = path === "/api/account/metrics-sharing" ? state() : path === "/api/runs" ? [] : path === "/api/queue" ? { pending: [], active: [] } : path === "/api/health" ? { ok: true, summary: "ok", problems: [] } : path === "/api/your-turn" ? { count: 0, groups: [], dismissed: 0, empty: "Nothing" } : {};
      return { ok: true, status: 200, statusText: "OK", headers: { get: () => null }, json: async () => body };
    }) as any;
    const main = new FakeElement("main");
    const off = await adminHome.renderAdminHome(main, {});
    await flush();
    expect(card(main)).toBeDefined();
    off();
    expect(ms.sharingSubscribers()).toBe(0);
  });

  it("an answered account sees no item on any page", async () => {
    const a = base(fakeApi(state({ answer: "yes", changed: "2026-11-01T00:00:00.000Z" })));
    const main = new FakeElement("main");
    const off = await home.renderHome(main, { a });
    await flush();
    expect(card(main)).toBeUndefined();
    off();
  });
});

describe("enterDisplay", () => {
  it("adds Account settings for the own account, never in an admin's preview of another one", async () => {
    const auth = await import("../ui/auth.js" as string);
    const box = (document as any).getElementById("user") as FakeElement;
    const names = () => box.all("button").map((b) => b.textContent);
    box.replaceChildren();
    const a = fakeApi();
    await auth.enterDisplay("user", { signIn: async () => ({ role: "user", view: "advanced" }), go: vi.fn(), hash: () => "", a });
    await flush();
    expect(names()).toContain("Account settings");
    ms.resetSharing();
    box.replaceChildren();
    const b = fakeApi();
    await auth.enterDisplay("user", { signIn: async () => ({ role: "admin", view: "admin" }), go: vi.fn(), hash: () => "", viewAs: "u1", a: b });
    await flush();
    expect(b.gets).toBe(0);
    expect(names()).not.toContain("Account settings");
  });
});

describe("the words", () => {
  it("never say issue", () => {
    const words = Object.values(ms.SHARING).join(" ") + readFileSync("ui/privacy.html", "utf8").replace(/<[^>]+>/g, " ");
    expect(words.toLowerCase()).not.toMatch(/\bissues?\b/);
  });
});
