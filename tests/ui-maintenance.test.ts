import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/maintenance.js" as string);
});
afterAll(() => restore());

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete (globalThis as any).confirm;
});

const flush = () => new Promise((r) => setTimeout(r, 0));
const modalRoot = () => document.getElementById("modal-root") as unknown as FakeElement;
const dialog = (text: string) => modalRoot().all("button").find((b) => b.textContent === text)!;

async function render(answer: any = { workspaces: ["a", "b"], runs: ["x"], freedMb: 12, kept: ["k"] }, fail = false) {
  const calls: { url: string; method?: string; body: any }[] = [];
  (globalThis as any).fetch = async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined });
    if (fail) return { ok: false, status: 500, statusText: "x", json: async () => ({ error: "boom" }) };
    return { ok: true, status: 200, statusText: "OK", json: async () => answer };
  };
  const main = new FakeElement("main");
  await ui.renderMaintenance(main);
  const button = (t: string) => main.all("button").find((b) => b.textContent === t)!;
  return { main, calls, button };
}

describe("Maintenance", () => {
  it("renders the title, the days, two unchecked boxes and a danger Clean up", async () => {
    const { main, button } = await render();
    expect(main.all("h1")[0]!.textContent).toBe("Maintenance");
    expect(main.all("input").find((i) => i.attrs.type === "number")!.value).toBe("7");
    const boxes = main.all("input").filter((i) => i.attrs.type === "checkbox");
    expect(boxes).toHaveLength(2);
    expect(boxes.every((b: any) => !b.checked)).toBe(true);
    expect(button("Clean up").attrs.class).toBe("danger");
  });

  it("previews with dryRun true and no confirm", async () => {
    const { main, calls, button } = await render();
    button("Preview").click();
    await flush();
    expect(modalRoot().children).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/api/clean");
    expect(calls[0]!.method).toBe("POST");
    // The fake DOM leaves an unchecked box's `checked` undefined, which JSON drops; real browsers send false.
    expect(calls[0]!.body).toMatchObject({ olderThanDays: 7, dryRun: true });
    expect(calls[0]!.body.purge).toBeFalsy();
    expect(calls[0]!.body.includePaused).toBeFalsy();
    expect(main.textContent).toContain("Would remove 2 workspace(s) and 1 run(s) · 12 MB · keeping 1 paused/running");
  });

  it("previews an empty result", async () => {
    const { main, button } = await render({ workspaces: [], runs: [], freedMb: 0, kept: [] });
    button("Preview").click();
    await flush();
    expect(main.textContent).toContain("Would remove 0 workspace(s) · 0 MB");
    expect(main.textContent).not.toContain("keeping");
  });

  it("does nothing when the confirmation is declined", async () => {
    const { calls, button } = await render();
    button("Clean up").click();
    await flush();
    dialog("Cancel").click();
    await flush();
    expect(calls).toHaveLength(0);
  });

  it("cleans up after confirming, with the changed values", async () => {
    const { main, calls, button } = await render();
    main.all("input").find((i) => i.attrs.type === "number")!.value = "30";
    for (const b of main.all("input").filter((i) => i.attrs.type === "checkbox")) (b as any).checked = true;
    button("Clean up").click();
    await flush();
    expect(modalRoot().textContent).toContain("Remove these workspaces now?");
    expect(modalRoot().textContent).toContain("Branches in your repos are kept.");
    dialog("Clean up").click();
    await flush();
    expect(calls[0]!.body).toEqual({ olderThanDays: 30, purge: true, includePaused: true, dryRun: false });
    expect(main.textContent).toContain("Removed 2 workspace(s)");
  });

  it("shows an error as a toast", async () => {
    const { main, button } = await render(undefined, true);
    button("Preview").click();
    await flush();
    expect((document.getElementById("toast") as any).textContent).toBe("boom");
    expect(main.textContent).not.toContain("Would remove");
  });

  it("is wired into the router", () => {
    const app = readFileSync("ui/app.js", "utf8");
    expect(app).toContain('from "./maintenance.js"');
    expect(app).toContain('section === "maintenance"');
  });
});
