import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";
import { held } from "./helpers/flow-app.js";

// The Models page on the fake DOM, with `fetch` stubbed as in tests/ui-audit.test.ts: no server.

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
beforeAll(() => { restore = installFakeDom(); });
afterAll(() => restore());

const g = globalThis as any;
const realFetch = globalThis.fetch;
type Reply = { status?: number; body?: unknown };
let routes: Record<string, (body?: any) => Reply | Promise<Reply>>;
let config: any;
let saved: any[];
let page: any;

const provider = (over: object = {}) => ({
  name: "ollama", kind: "ollama", ok: true, detail: "", agents: ["claude"], models: ["qwen3-coder"], base_url: "http://localhost:11434", ...over,
});
const status = (over: object = {}) => ({ agents: [{ agent: "claude", installed: true, loggedIn: true, version: "1", detail: "" }], providers: [provider(), provider({ name: "other", models: [] })], ...over });

beforeEach(async () => {
  config = { providers: { ollama: { kind: "ollama" } }, router: { rules: [], fallback: [], fallback_on: [] } };
  saved = [];
  routes = {
    "GET /api/config": () => ({ body: structuredClone(config) }),
    "PUT /api/config": (b) => { saved.push(b); config = b; return { body: {} }; },
    "GET /api/providers": () => ({ body: status({ providers: [...Object.keys(config.providers).map((name) => provider({ name })), provider({ name: "other", models: [] })] }) }),
    "POST /api/providers/test": () => ({ body: { ok: true, target: "claude:ollama:qwen3-coder", seconds: 2 } }),
  };
  g.fetch = async (url: string, init?: { method?: string; body?: string }) => {
    const r = await routes[`${init?.method ?? "GET"} ${url}`]!(init?.body ? JSON.parse(init.body) : undefined);
    const code = r.status ?? 200;
    return { ok: code < 400, status: code, statusText: "x", json: async () => r.body };
  };
  main().replaceChildren();
  toastEl().className = "";
  vi.resetModules(); // the last model test is module state: every test starts without one
  page = await import("../ui/models.js" as string);
});
afterEach(() => { g.fetch = realFetch; });

const el = (id: string) => g.document.getElementById(id) as FakeElement;
const main = () => el("main");
const toastEl = () => el("toast");
const button = (text: string) => main().all("button").find((b) => b.textContent === text)!;
const reload = () => main().all("button").find((b) => b.getAttribute("aria-label") === "Reload")!;
const alerts = () => main().all("div").filter((d) => d.getAttribute("role") === "alert");
const field = (placeholder: string) => main().all("input").find((i) => i.getAttribute("placeholder") === placeholder)!;
const row = (name: string) => main().all("tr").find((r) => r.all("td")[0]?.textContent.startsWith(name))!;
const testRow = () => main().querySelector("[data-model-test-row]")!;
const titles = () => main().all("h3").map((x) => x.textContent);
const show = () => page.renderModels(main());

describe("Models page states", () => {
  it("shows a skeleton, then three cards", async () => {
    const gate = held<Reply>();
    routes["GET /api/config"] = () => gate.promise;
    const done = show();
    expect(main().all("div").some((d) => d.getAttribute("aria-busy") === "true")).toBe(true);
    gate.resolve({ body: structuredClone(config) });
    await done;
    expect(titles()).toEqual(["Coding agents", "Providers", "Routing"]);
  });

  it("keeps Routing usable when the providers cannot be checked", async () => {
    routes["GET /api/providers"] = () => ({ status: 500, body: { error: "down" } });
    await show();
    expect(titles()).toEqual(["Providers", "Routing"]);
    expect(button("Save routing")).toBeDefined();
    expect(alerts()[0]?.textContent).toContain("could not be checked");
    routes["GET /api/providers"] = () => ({ body: status() });
    button("Retry").click();
    await vi.waitFor(() => expect(main().all("table").some((t) => t.getAttribute("aria-label") === "Providers")).toBe(true));
    expect(titles()).toEqual(["Coding agents", "Providers", "Routing"]);
  });

  it("shows a page error with Retry when the config fails, and a permission box on 403", async () => {
    routes["GET /api/config"] = () => ({ status: 500, body: { error: "down" } });
    await show();
    expect(alerts()).toHaveLength(1);
    expect(titles()).toEqual([]);
    routes["GET /api/config"] = () => ({ status: 403, body: { error: "no" } });
    button("Retry").click();
    await vi.waitFor(() => expect(main().querySelector("div[data-kind]")?.getAttribute("data-kind")).toBe("permission"));
    expect(buttonOrNone("Retry")).toBeUndefined();
  });

  it("says when there are no providers", async () => {
    routes["GET /api/providers"] = () => ({ body: status({ providers: [] }) });
    await show();
    expect(main().textContent).toContain("No providers.");
  });

  it("does not let a late answer draw into a page that was replaced", async () => {
    const gate = held<Reply>();
    routes["GET /api/config"] = () => gate.promise;
    const done = show();
    const other = g.document.getElementById("other") as FakeElement;
    main().replaceChildren(other);
    gate.resolve({ body: structuredClone(config) });
    await done;
    expect(main().children).toEqual([other]);
  });
});

const buttonOrNone = (text: string) => main().all("button").find((b) => b.textContent === text);

describe("Model test", () => {
  const test = async () => {
    button("Test").click();
    await vi.waitFor(() => expect(testRow().textContent).toMatch(/works|failed|could not/));
  };

  it("keeps a good result in the row and in the provider row, also after Reload, Add and Remove", async () => {
    await show();
    await test();
    expect(testRow().textContent).toContain("works");
    expect(testRow().textContent).toContain("claude:ollama:qwen3-coder");
    expect(testRow().textContent).toContain("ollama:qwen3-coder");
    const mark = () => main().querySelectorAll("[data-model-test]");
    expect(row("ollama").querySelectorAll("[data-model-test]")[0]?.textContent).toContain("Last test: works");
    expect(row("other").querySelectorAll("[data-model-test]")).toHaveLength(0);
    expect(mark()).toHaveLength(1);

    reload().click();
    await vi.waitFor(() => expect(row("ollama")).toBeDefined());
    expect(testRow().textContent).toContain("works");
    expect(row("ollama").querySelectorAll("[data-model-test]")).toHaveLength(1);

    field("my-proxy").value = "extra";
    button("Add provider").click();
    await vi.waitFor(() => expect(saved).toHaveLength(1));
    await vi.waitFor(() => expect(row("extra")).toBeDefined());
    expect(testRow().textContent).toContain("works");

    row("ollama").all("button").find((b) => b.textContent === "Remove")!.click();
    await vi.waitFor(() => expect(saved).toHaveLength(2));
    await vi.waitFor(() => expect(testRow().textContent).toContain("works"));
    expect(saved[1].providers.ollama).toBeUndefined();
  });

  it("keeps a failed result and its reason after Reload", async () => {
    routes["POST /api/providers/test"] = () => ({ body: { ok: false, target: "claude:ollama:qwen3-coder", seconds: 1, error: "model not found" } });
    await show();
    await test();
    expect(testRow().textContent).toContain("failed");
    expect(testRow().textContent).toContain("model not found");
    reload().click();
    await vi.waitFor(() => expect(testRow().textContent).toContain("model not found"));
  });

  it("keeps the message when the test request fails", async () => {
    routes["POST /api/providers/test"] = () => ({ status: 500, body: { error: "oops" } });
    await show();
    await test();
    expect(testRow().textContent).toContain("The model could not be tested.");
    reload().click();
    await vi.waitFor(() => expect(testRow().textContent).toContain("The model could not be tested."));
  });

  it("draws the answer of a test that was held while the page was reloaded into the new page", async () => {
    const gate = held<Reply>();
    routes["POST /api/providers/test"] = () => gate.promise;
    await show();
    button("Test").click();
    reload().click();
    await vi.waitFor(() => expect(row("ollama")).toBeDefined());
    expect(button("Test").disabled).toBe(true);
    gate.resolve({ body: { ok: true, target: "claude:ollama:qwen3-coder", seconds: 3 } });
    await vi.waitFor(() => expect(testRow().textContent).toContain("works"));
    expect(button("Test").disabled).toBe(false);
  });
});

describe("Config changes", () => {
  it("explains a failed Remove with a toast and keeps the row", async () => {
    await show();
    routes["PUT /api/config"] = () => ({ status: 500, body: { error: "disk full" } });
    row("ollama").all("button").find((b) => b.textContent === "Remove")!.click();
    await vi.waitFor(() => expect(toastEl().className).toContain("error"));
    expect(toastEl().textContent).toContain("disk full");
    expect(row("ollama")).toBeDefined();
  });

  it("explains a failed Add and keeps the typed values", async () => {
    await show();
    routes["PUT /api/config"] = () => ({ status: 400, body: { error: 'providers.p2.base_url: not a URL' } });
    field("my-proxy").value = "p2";
    field("http://localhost:11434").value = "nope";
    button("Add provider").click();
    await vi.waitFor(() => expect(toastEl().className).toContain("error"));
    expect(field("my-proxy").value).toBe("p2");
    expect(field("http://localhost:11434").value).toBe("nope");
  });

  it("explains a failed Save routing (read and write) and keeps the typed values", async () => {
    await show();
    field("Claude Code's default").value = "opus";
    routes["GET /api/config"] = () => ({ status: 500, body: { error: "read failed" } });
    button("Save routing").click();
    await vi.waitFor(() => expect(toastEl().textContent).toContain("read failed"));
    routes["GET /api/config"] = () => ({ body: structuredClone(config) });
    routes["PUT /api/config"] = () => ({ status: 400, body: { error: "default_model: unknown" } });
    toastEl().className = "";
    button("Save routing").click();
    await vi.waitFor(() => expect(toastEl().textContent).toContain("default_model: unknown"));
    expect(field("Claude Code's default").value).toBe("opus");
  });

  it("saves what was typed when the button was pressed, and does not let two changes overwrite each other", async () => {
    await show();
    const gate = held<Reply>();
    let first = true;
    routes["GET /api/config"] = () => {
      if (first) { first = false; return gate.promise; }
      return { body: structuredClone(config) };
    };
    const model = field("Claude Code's default");
    model.value = "opus";
    button("Save routing").click();
    model.value = "changed later";
    field("my-proxy").value = "extra";
    button("Add provider").click();
    gate.resolve({ body: structuredClone(config) });
    await vi.waitFor(() => expect(saved).toHaveLength(2));
    expect(saved[0].default_model).toBe("opus");
    expect(saved[1].default_model).toBe("opus");
    expect(saved[1].providers.extra).toBeDefined();
  });
});
