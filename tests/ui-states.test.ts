import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";
import { readUiCss } from "./helpers/ui-css.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/states.js" as string);
});
afterAll(() => restore());

const withStatus = (message: string, status: number) => Object.assign(new Error(message), { status });
const cls = (el: FakeElement) => (el.getAttribute("class") ?? "").split(" ");

describe("explainError", () => {
  it.each([
    [new TypeError("Failed to fetch"), "offline"],
    [withStatus("x", 403), "permission"],
    [withStatus("x", 404), "missing"],
    [withStatus("x", 409), "conflict"],
    [withStatus("x", 500), "server"],
    [withStatus("x", 503), "server"],
    [withStatus("x", 400), "other"],
    [withStatus("x", 401), "other"],
  ])("%s -> %s", (e, kind) => {
    expect(ui.explainError(e).kind).toBe(kind);
  });

  it("gives each kind its own safe and next sentence", () => {
    const errs = [new TypeError("x"), withStatus("x", 403), withStatus("x", 404), withStatus("x", 409), withStatus("x", 500), withStatus("x", 400)];
    const infos = errs.map((e) => ui.explainError(e));
    expect(new Set(infos.map((i: any) => i.kind)).size).toBe(6);
    expect(new Set(infos.map((i: any) => i.safe)).size).toBe(6);
    expect(new Set(infos.map((i: any) => i.next)).size).toBe(6);
    for (const i of infos) expect(i.safe && i.next).toBeTruthy();
  });

  it("keeps the caller's sentence and the server text", () => {
    const info = ui.explainError(withStatus("flow not found", 404), { what: "The flow could not be opened." });
    expect(info.what).toBe("The flow could not be opened. flow not found");
  });

  it("does not show the browser's fetch text", () => {
    const info = ui.explainError(new TypeError("Failed to fetch"), { what: "No." });
    expect(info.what).not.toContain("Failed to fetch");
    expect(info.what).toContain("could not be reached");
  });

  it("keeps the message of an error without status", () => {
    const info = ui.explainError(new Error("boom"));
    expect(info.kind).toBe("offline");
    expect(info.what).toContain("boom");
  });

  it("lets the caller's safe sentence win, but not next", () => {
    const a = ui.explainError(withStatus("x", 500), { safe: "Mine." });
    const b = ui.explainError(withStatus("x", 500));
    expect(a.safe).toBe("Mine.");
    expect(a.next).toBe(b.next);
  });

  it("does not throw without an error", () => {
    expect(ui.explainError(undefined).what).toBe("Something went wrong.");
    expect(ui.explainError({}).kind).toBe("offline");
  });

  it("does not claim that nothing was sent", () => {
    expect(ui.explainError(new TypeError("x")).safe).not.toMatch(/nothing was sent/i);
  });
});

describe("loadingState", () => {
  it("is busy and has one label", () => {
    const el = ui.loadingState("Loading runs");
    expect(el.getAttribute("aria-busy")).toBe("true");
    expect(el.textContent).toBe("Loading runs");
    expect(el.all("span").filter((s: FakeElement) => cls(s).includes("sr-only"))).toHaveLength(1);
    const rows = el.all("div");
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.getAttribute("aria-hidden")).toBe("true");
  });

  it("sets rows and shape", () => {
    const el = ui.loadingState("x", { rows: 5, shape: "table" });
    expect(el.all("div")).toHaveLength(5);
    expect(el.getAttribute("class")).toBe("skeleton skeleton-table");
    for (const s of ["list", "table", "cards", "detail"]) expect(ui.loadingState("x", { shape: s }).getAttribute("class")).toBe(`skeleton skeleton-${s}`);
  });

  it("falls back on bad input", () => {
    expect(ui.loadingState("x", { shape: "nope" }).getAttribute("class")).toContain("skeleton-list");
    const n = (rows: unknown) => ui.loadingState("x", { rows }).all("div").length;
    expect([n(0), n(-1), n(999), n("x")]).toEqual([1, 1, 20, 3]);
  });
});

describe("emptyState", () => {
  it("shows the text and no button without an action", () => {
    const el = ui.emptyState("Nothing here");
    expect(cls(el)).toContain("empty");
    expect(el.textContent).toBe("Nothing here");
    expect(el.all("button")).toHaveLength(0);
  });

  it("draws a primary action", () => {
    const onClick = vi.fn();
    const el = ui.emptyState("None", { label: "Add one", onClick });
    const [b] = el.all("button");
    expect(cls(b)).toContain("primary");
    expect(b.textContent).toBe("Add one");
    b.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("errorState", () => {
  const info = { kind: "server", what: "W", safe: "S", next: "N" };

  it("has an alert role and three parts in order", () => {
    const el = ui.errorState(info);
    expect(el.getAttribute("role")).toBe("alert");
    expect(el.getAttribute("data-kind")).toBe("server");
    expect(el.all("p").map((p: FakeElement) => p.textContent)).toEqual(["W", "S", "N"]);
    expect(el.all("button")).toHaveLength(0);
    expect(el.all("a")).toHaveLength(0);
  });

  it("calls onRetry once per click, without arguments", () => {
    const onRetry = vi.fn();
    const [b] = ui.errorState(info, { onRetry }).all("button");
    expect(b.textContent).toBe("Retry");
    b.click();
    expect(onRetry).toHaveBeenCalledTimes(1);
    b.click();
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0]).toEqual([]);
  });

  it("shows a back link, alone or with Retry", () => {
    const back = { href: "#/runs", label: "Back to runs" };
    const a = ui.errorState(info, { back }).all("a");
    expect(a).toHaveLength(1);
    expect(a[0].getAttribute("href")).toBe("#/runs");
    expect(a[0].textContent).toBe("Back to runs");
    const both = ui.errorState(info, { back, onRetry: () => {} });
    expect(both.all("a")).toHaveLength(1);
    expect(both.all("button")).toHaveLength(1);
  });
});

describe("permissionState", () => {
  it("shows the text without an alert role", () => {
    const el = ui.permissionState("You cannot open this.");
    expect(el.getAttribute("data-kind")).toBe("permission");
    expect(el.getAttribute("role")).toBeNull();
    expect(el.textContent).toContain("You cannot open this.");
    expect(el.all("a")).toHaveLength(0);
  });

  it("has a back link when given", () => {
    const el = ui.permissionState("No.", { href: "#/home", label: "Home" });
    expect(el.all("a")[0].getAttribute("href")).toBe("#/home");
  });
});

describe("staleNote", () => {
  const at = Date.UTC(2026, 9, 9, 12, 3);
  const expected = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  it("says when the data was updated", () => {
    const el = ui.staleNote(at);
    expect(el.textContent).toBe(`Updated ${expected}`);
    expect(el.all("button")).toHaveLength(0);
    expect(el.getAttribute("role")).toBeNull();
  });

  it("says that a refresh failed, with Retry", () => {
    const onRetry = vi.fn();
    const el = ui.staleNote(at, { failed: true, onRetry });
    expect(el.textContent).toContain(`Could not refresh. Showing data from ${expected}.`);
    expect(el.getAttribute("role")).toBe("status");
    expect(cls(el)).toContain("failed");
    el.all("button")[0].click();
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(ui.staleNote(at, { failed: true }).all("button")).toHaveLength(0);
  });

  it("accepts a Date, an ISO string and a number", () => {
    for (const v of [new Date(at), new Date(at).toISOString(), at]) expect(ui.staleNote(v).textContent).toBe(`Updated ${expected}`);
  });

  it("handles an invalid time", () => {
    expect(ui.staleNote("nope")).toBeNull();
    expect(ui.staleNote(undefined)).toBeNull();
    expect(ui.staleNote("nope", { failed: true }).textContent).toBe("Could not refresh.");
  });
});

describe("module and styles", () => {
  const src = readFileSync("ui/states.js", "utf8");
  it("imports only dom.js, sets no inline style and exports the six functions", () => {
    expect([...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1])).toEqual(["./dom.js"]);
    expect(src).not.toContain("style:");
    expect([...src.matchAll(/^export function (\w+)/gm)].map((m) => m[1]).sort()).toEqual(
      ["emptyState", "errorState", "explainError", "loadingState", "permissionState", "staleNote"]);
  });

  it("keeps the old rules and adds the new ones", () => {
    const css = readUiCss(); // ui/style.css only imports the files under ui/css/
    for (const c of [".empty {", ".errors {", ".spinner {", ".sr-only {", ".skeleton {", ".stale-note {"]) expect(css).toContain(c);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^}]*\.skeleton-row \{ animation: none/);
    // the status pill with the same class name must not get the box styles
    expect(css).toContain(".state-error:not(.pill) {");
    expect(css).not.toMatch(/^\.state-error \{/m);
  });
});
