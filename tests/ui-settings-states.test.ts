import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
// The states of the Settings page: loading, saving, saved, not saved, and the clean-up dialog.
let restore: () => void;
let admin: any;
beforeAll(async () => {
  restore = installFakeDom();
  admin = await import("../ui/admin.js" as string);
});
afterAll(() => restore());

const config = ConfigSchema.parse({ providers: { local: { kind: "ollama" } } });
const info = { configPath: "/x/config.yaml", spentToday: 0, listening: "127.0.0.1" };
const realFetch = globalThis.fetch;
let sent: { method: string; url: string; body: any }[];
let configGate: Promise<void> | undefined;
let saveGate: Promise<void> | undefined;
let saveError: string | undefined;

beforeEach(() => {
  sent = [];
  configGate = undefined;
  saveGate = undefined;
  saveError = undefined;
  document.getElementById("modal-root")!.replaceChildren();
  document.getElementById("toast")!.textContent = "";
  const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: "x", json: async () => body });
  (globalThis as any).fetch = async (url: string, init: { method: string; body?: string }) => {
    if (init.method === "GET") {
      if (configGate) await configGate;
      return url === "/api/config" ? reply(config) : reply(info);
    }
    sent.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined });
    if (url === "/api/clean") return reply({ workspaces: [], runs: [], kept: [], freedMb: 0 });
    if (saveGate) await saveGate;
    return saveError ? reply({ error: saveError }, 400) : reply({});
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const flush = () => new Promise((r) => setTimeout(r, 5));
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
};
const toastText = () => document.getElementById("toast")!.textContent as string;
const root = () => document.getElementById("modal-root") as unknown as FakeElement;
const button = (el: FakeElement, text: string) => el.all("button").find((b) => b.textContent === text)!;
const status = (main: FakeElement) => main.all("span").find((s) => (s.attrs.class ?? "").startsWith("status") && s.attrs.role === "status")!;
const draw = async () => {
  const main = new FakeElement("div");
  await admin.renderSettings(main);
  return main;
};

describe("loading", () => {
  it("draws a skeleton while /api/config is held", async () => {
    const g = gate();
    configGate = g.promise;
    const main = new FakeElement("div");
    const done = admin.renderSettings(main);
    await flush();
    expect(main.all("div").some((d) => d.attrs["aria-busy"] === "true")).toBe(true);
    expect(main.textContent).toContain("Loading settings…");
    g.release();
    await done;
    expect(main.all("div").some((d) => d.attrs["aria-busy"] === "true")).toBe(false);
  });
  it("rejects when /api/config fails, so the router draws the error", async () => {
    (globalThis as any).fetch = async () => ({ ok: false, status: 500, statusText: "x", json: async () => ({ error: "down" }) });
    await expect(admin.renderSettings(new FakeElement("div"))).rejects.toThrow("down");
  });
});

describe("save", () => {
  it("shows Saving… with the button disabled, then Saved at … and a toast", async () => {
    const main = await draw();
    const g = gate();
    saveGate = g.promise;
    button(main, "Save").click();
    await flush();
    expect(status(main).textContent).toBe("Saving…");
    expect(button(main, "Save").disabled).toBe(true);
    g.release();
    await flush();
    expect(status(main).textContent).toMatch(/^Saved at /);
    expect(status(main).attrs.class).toBe("status ok");
    expect(button(main, "Save").disabled).toBe(false);
    expect(toastText()).toBe("Settings saved");
  });
  it("shows Not saved. next to the button, the server's sentence, the field and an enabled button when the save fails", async () => {
    const main = await draw();
    saveError = 'invalid config: {"path": ["concurrency"]} concurrency must be at least 1';
    button(main, "Save").click();
    await flush();
    expect(status(main).textContent).toBe("Not saved.");
    expect(status(main).attrs.class).toBe("status bad");
    expect(main.all("div").find((d) => d.attrs.class === "errors")!.textContent).toContain("concurrency must be at least 1");
    expect(main.all("input").filter((i) => i.attrs["aria-invalid"] === "true").length).toBeGreaterThan(0);
    expect(button(main, "Save").disabled).toBe(false);
  });
});

describe("clean up", () => {
  it("Preview opens no dialog; Clean up asks first", async () => {
    const main = await draw();
    button(main, "Preview").click();
    await flush();
    expect(root().children).toHaveLength(0);
    expect(sent.map((s) => s.body?.dryRun)).toEqual([true]);
    button(main, "Clean up").click();
    await flush();
    expect(root().textContent).toContain("Remove these workspaces now?");
    button(root(), "Cancel").click();
    await flush();
    expect(sent).toHaveLength(1);
    button(main, "Clean up").click();
    await flush();
    button(root(), "Clean up").click();
    await flush();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.body.dryRun).toBe(false);
  });
});
