import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installFakeDom, type FakeElement } from "./helpers/fake-dom.js";

// The "Plugins" card of Settings, on the fake DOM. No server, no timers.

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/admin-plugins.js" as string);
});
afterAll(() => restore());

const plugin = (o: object = {}) => ({ label: "acme", module: "acme", version: "1.2.3", registered: [], ...o });

describe("registeredText", () => {
  it("joins what a plugin registered, or says nothing yet", () => {
    expect(ui.registeredText(plugin())).toBe("Nothing yet");
    expect(ui.registeredText(plugin({ registered: [{ point: "flow", name: "a" }, { point: "agent", name: "b" }] }))).toBe("flow a, agent b");
    expect(ui.registeredText(undefined)).toBe("Nothing yet");
  });
});

describe("the Settings card", () => {
  const realFetch = globalThis.fetch;
  let answers: Array<{ status?: number; body?: unknown }>;
  let calls: string[];
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const card = async () => {
    const el = ui.pluginsPanel() as FakeElement;
    await flush();
    await flush();
    return el;
  };

  beforeEach(() => {
    answers = [];
    calls = [];
    (globalThis as any).fetch = async (url: string, init: any = {}) => {
      calls.push(`${init.method ?? "GET"} ${url}`);
      const a = answers.shift() ?? { body: { apiVersion: "0.1", plugins: [], problems: [] } };
      const status = a.status ?? 200;
      return { ok: status < 400, status, statusText: "x", headers: { get: () => null }, json: async () => a.body };
    };
    return () => void ((globalThis as any).fetch = realFetch);
  });

  it("shows a loading state, then the empty note", async () => {
    const el = ui.pluginsPanel() as FakeElement;
    expect(el.textContent).toContain("Loading plugins…");
    await flush();
    await flush();
    expect(el.textContent).toContain("Set in config.yaml only");
    expect(el.textContent).toContain("No plugins.");
    expect(calls).toEqual(["GET /api/plugins"]);
  });

  it("lists the plugins and their problems", async () => {
    answers.push({ body: { plugins: [plugin(), plugin({ label: "b", module: "/p/b.mjs", version: "unknown" })], problems: [{ plugin: "config.yaml", reason: "lists other plugins" }] } });
    const el = await card();
    expect(el.textContent).toContain("1.2.3");
    expect(el.textContent).toContain("/p/b.mjs");
    expect(el.textContent).toContain("Nothing yet");
    expect(el.textContent).toContain("config.yaml: lists other plugins");
    expect(el.all("p").some((p) => p.getAttribute("role") === "alert")).toBe(true);
  });

  it("copes with an answer of an unknown shape", async () => {
    answers.push({ body: "nonsense" });
    expect((await card()).textContent).toContain("No plugins.");
  });

  it("shows an error with Retry, and loads again on Retry", async () => {
    answers.push({ status: 500, body: { error: "boom" } });
    const el = await card();
    const retry = el.all("button").find((b) => b.textContent === "Retry");
    expect(retry).toBeTruthy();
    answers.push({ body: { plugins: [plugin()], problems: [] } });
    (retry as any).click();
    await flush();
    await flush();
    expect(el.textContent).toContain("1.2.3");
  });

  it("explains a refusal", async () => {
    answers.push({ status: 403, body: { error: "forbidden" } });
    const el = await card();
    expect(el.textContent).not.toContain("Loading plugins…");
    expect(calls).toHaveLength(1);
  });
});
