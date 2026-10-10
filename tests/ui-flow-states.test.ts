import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installFakeDom } from "./helpers/fake-dom.js";
import { alertsIn, buttonIn, click, edit, flowJson, held, httpError, launchApp, main, root, sidebar } from "./helpers/flow-app.js";
import { dropBrowser } from "./helpers/flow-app.js";
import { loadUiSource } from "./helpers/ui-load.js";

// The flow list, opening a flow and the discard question, on the fake DOM: no server, no timers.

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let real: Record<string, any>;
beforeAll(async () => {
  restore = installFakeDom();
  real = {
    dom: await import("../ui/dom.js" as string),
    states: await import("../ui/states.js" as string),
    ia: await import("../ui/ia.js" as string),
    auth: await import("../ui/auth.js" as string),
  };
});
afterAll(() => restore());
afterEach(() => dropBrowser());

const busy = (box: any) => box.all("div").some((d: any) => d.getAttribute("aria-busy") === "true");
const entry = (name: string) => ({ name, scope: "repo", description: "" });
const kinds = (box: any) => box.all("div").map((d: any) => d.getAttribute("data-kind")).filter(Boolean);
const links = (box: any) => box.all("a").map((a: any) => a.getAttribute("href"));

describe("loadUiSource", () => {
  it("fails loudly on an import form it does not know", () => {
    expect(() => loadUiSource("x.js", {}, [], 'import * as x from "y";\n')).toThrow(/not supported/);
  });

  it("fails loudly on an import without a stub", () => {
    expect(() => loadUiSource("x.js", {}, [], 'import { a } from "y";\n')).toThrow(/no stub/);
  });
});

describe("flow list", () => {
  it("shows a skeleton while the list loads, and the page is routed already", async () => {
    const gate = held<any[]>();
    await launchApp(real, "#/flows", { flows: vi.fn(() => gate.promise) });
    expect(busy(sidebar())).toBe(true);
    expect(main().textContent).toContain("Welcome");
    gate.resolve([entry("a"), entry("b")]);
    await vi.waitFor(() => expect(links(sidebar())).toEqual(expect.arrayContaining(["#/flows/a", "#/flows/b"])));
    expect(busy(sidebar())).toBe(false);
  });

  it("still routes when the list fails, and Retry fills it", async () => {
    const flows = vi.fn().mockRejectedValueOnce(httpError(500)).mockResolvedValue([entry("a")]);
    await launchApp(real, "#/flows", { flows });
    await vi.waitFor(() => expect(alertsIn(sidebar())).toHaveLength(1));
    expect(main().textContent).toContain("Welcome");
    click(sidebar(), "Retry");
    await vi.waitFor(() => expect(links(sidebar())).toContain("#/flows/a"));
    expect(alertsIn(sidebar())).toHaveLength(0);
  });

  it("shows the permission box on 403", async () => {
    await launchApp(real, "#/flows", { flows: vi.fn().mockRejectedValue(httpError(403, "no")) });
    await vi.waitFor(() => expect(kinds(sidebar())).toContain("permission"));
  });

  it("says when there are no flows", async () => {
    await launchApp(real, "#/flows");
    await vi.waitFor(() => expect(sidebar().textContent).toContain("No flows yet."));
  });

  it("keeps the old entries with a failed note and Retry when a reload fails", async () => {
    const flows = vi.fn().mockResolvedValueOnce([entry("a")]).mockRejectedValueOnce(httpError(500)).mockResolvedValue([entry("a"), entry("b")]);
    const { mod } = await launchApp(real, "#/flows", { flows });
    await vi.waitFor(() => expect(links(sidebar())).toContain("#/flows/a"));
    expect(await mod.refreshFlows()).toBe(false);
    expect(links(sidebar())).toContain("#/flows/a");
    expect(sidebar().textContent).toContain("Could not refresh.");
    expect(alertsIn(sidebar())).toHaveLength(0);
    click(sidebar(), "Retry");
    await vi.waitFor(() => expect(links(sidebar())).toContain("#/flows/b"));
    expect(sidebar().textContent).not.toContain("Could not refresh.");
  });

  it("does not let an older failure replace a newer answer", async () => {
    const first = held<any[]>();
    const flows = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue([entry("a")]);
    const { mod } = await launchApp(real, "#/flows", { flows });
    expect(await mod.refreshFlows()).toBe(true);
    first.reject(httpError(500));
    await new Promise((r) => setTimeout(r, 0));
    expect(links(sidebar())).toContain("#/flows/a");
    expect(alertsIn(sidebar())).toHaveLength(0);
    expect(sidebar().textContent).not.toContain("Could not refresh.");
  });
});

describe("open a flow", () => {
  const h1 = () => main().all("h1")[0]?.textContent;

  it("shows a skeleton, then the toolbar with the flow name", async () => {
    const gate = held<any>();
    await launchApp(real, "#/flows/a", { flow: vi.fn(() => gate.promise) });
    expect(busy(main())).toBe(true);
    gate.resolve({ name: "a", scope: "repo", yaml: flowJson("a") });
    await vi.waitFor(() => expect(h1()).toBe("a"));
    expect(busy(main())).toBe(false);
  });

  it("explains a 500 with one alert and Retry, and Retry opens the flow", async () => {
    const flow = vi.fn().mockRejectedValueOnce(httpError(500)).mockResolvedValue({ name: "a", scope: "repo", yaml: flowJson("a") });
    await launchApp(real, "#/flows/a", { flow });
    await vi.waitFor(() => expect(alertsIn(main())).toHaveLength(1));
    click(main(), "Retry");
    await vi.waitFor(() => expect(h1()).toBe("a"));
    expect(flow).toHaveBeenCalledTimes(2);
    expect(alertsIn(main())).toHaveLength(0);
  });

  it("says there is no such flow on 404, with a link to the list and no Retry", async () => {
    await launchApp(real, "#/flows/zzz", { flow: vi.fn().mockRejectedValue(httpError(404, 'flow "zzz" not found')) });
    await vi.waitFor(() => expect(main().textContent).toContain("There is no flow named"));
    expect(links(main())).toContain("#/flows");
    expect(buttonIn(main(), "Retry")).toBeUndefined();
  });

  it("shows the permission box on 403", async () => {
    await launchApp(real, "#/flows/a", { flow: vi.fn().mockRejectedValue(httpError(403, "no")) });
    await vi.waitFor(() => expect(kinds(main())).toContain("permission"));
  });

  it("does not draw a late answer over the page that took over", async () => {
    const gate = held<any>();
    const renderDashboard = vi.fn(async (box: any) => { real.dom.mount(box, real.dom.h("p", {}, "dashboard page")); });
    const { go } = await launchApp(real, "#/flows/a", { flow: vi.fn(() => gate.promise) }, { "./dashboard.js": { renderDashboard } });
    await go("#/dashboard");
    expect(main().textContent).toContain("dashboard page");
    gate.resolve({ name: "a", scope: "repo", yaml: flowJson("a") });
    await new Promise((r) => setTimeout(r, 0));
    expect(main().textContent).toContain("dashboard page");
    expect(h1()).toBeUndefined();
  });
});

describe("discard on navigation", () => {
  const dirty = async (hash = "#/flows/a") => {
    const app = await launchApp(real, hash);
    await vi.waitFor(() => expect(main().all("h1")[0]?.textContent).toBe("a"));
    edit(flowJson("a", { description: "changed" }));
    return app;
  };
  const asked = () => root().textContent.includes("Discard unsaved changes?");

  it("asks, and puts the old address back while it asks", async () => {
    const { go } = await dirty();
    void go("#/flows/other");
    await vi.waitFor(() => expect(asked()).toBe(true));
    expect(history.replaceState).toHaveBeenCalledWith(null, "", "#/flows/a");
    expect(location.hash).toBe("#/flows/a");
  });

  it("does not open the other flow on Cancel", async () => {
    const { go, api } = await dirty();
    void go("#/flows/other");
    await vi.waitFor(() => expect(asked()).toBe(true));
    click(root(), "Cancel");
    await new Promise((r) => setTimeout(r, 0));
    expect(api.flow).toHaveBeenCalledTimes(1);
    expect(location.hash).toBe("#/flows/a");
    expect(main().all("h1")[0]?.textContent).toBe("a");
  });

  it("opens the other flow on Discard, and ignores a second hashchange while it asks", async () => {
    const { go, api } = await dirty();
    void go("#/flows/other");
    await vi.waitFor(() => expect(asked()).toBe(true));
    await go("#/flows/third");
    expect(location.hash).toBe("#/flows/a");
    expect(asked()).toBe(true);
    click(root(), "Discard");
    await vi.waitFor(() => expect(api.flow).toHaveBeenCalledWith("other"));
    expect(history.replaceState).toHaveBeenCalledWith(null, "", "#/flows/other");
    expect(api.flow).not.toHaveBeenCalledWith("third");
    await vi.waitFor(() => expect(main().all("h1")[0]?.textContent).toBe("other"));
  });

  it("does not ask again when Retry follows a failed open after Discard", async () => {
    const { go, api } = await dirty();
    api.flow.mockRejectedValueOnce(httpError(500)).mockResolvedValue({ name: "other", scope: "repo", yaml: flowJson("other") });
    void go("#/flows/other");
    await vi.waitFor(() => expect(asked()).toBe(true));
    click(root(), "Discard");
    await vi.waitFor(() => expect(alertsIn(main())).toHaveLength(1));
    click(main(), "Retry");
    await vi.waitFor(() => expect(main().all("h1")[0]?.textContent).toBe("other"));
    expect(asked()).toBe(false);
  });

  it("leaves a dialog that is open alone when the address changes", async () => {
    const { go } = await dirty();
    click(main(), "▶ Run");
    await vi.waitFor(() => expect(root().textContent).toContain("Run "));
    await go("#/flows/other");
    expect(location.hash).toBe("#/flows/a");
    expect(root().textContent).toContain("Run ");
  });

  it("asks before a blank flow replaces a draft", async () => {
    const { go } = await dirty();
    await go("#/flows");
    expect(main().textContent).toContain("Welcome");
    click(main(), "+ Blank flow");
    await vi.waitFor(() => expect(asked()).toBe(true));
    click(root(), "Cancel");
    await new Promise((r) => setTimeout(r, 0));
    expect(location.hash).toBe("#/flows");
  });
});

describe("source", () => {
  it("uses no native confirm and keeps the beforeunload guard", () => {
    for (const f of ["ui/app.js", "ui/flow-page.js", "ui/library.js"]) expect(readFileSync(f, "utf8")).not.toMatch(/\bconfirm\(/);
    expect(readFileSync("ui/app.js", "utf8")).toContain('window.addEventListener("beforeunload"');
  });
});
