import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { answerDialog } from "./helpers/confirm-dialog.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";
import { held } from "./helpers/flow-app.js";

// The Models list and the provider detail page on the fake DOM, with `fetch` stubbed: no server.

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
let tested: string[];
let page: any;

const provider = (over: object = {}) => ({ name: "ollama", kind: "ollama", ok: true, detail: "", agents: ["claude"], models: ["qwen3-coder"], base_url: "http://localhost:11434", ...over });
const providerList = () => [
  provider(),
  provider({ name: "claude" }),
  provider({ name: "codex" }),
  provider({ name: "px", kind: "anthropic-compatible", models: [], base_url: "http://px" }),
  provider({ name: "mine", kind: "openai", models: [], base_url: undefined, ok: false, detail: "no key", agents: ["codex"] }),
  provider({ name: "anthropic", kind: "anthropic", models: [], base_url: undefined }),
  provider({ name: "openai", kind: "openai", models: [], base_url: undefined, agents: ["codex"] }),
];
const agents = [
  { agent: "claude", installed: true, loggedIn: true, version: "1", detail: "" },
  { agent: "codex", installed: false, version: undefined, detail: "" },
];

beforeEach(async () => {
  config = {
    providers: { ollama: { kind: "ollama", base_url: "http://localhost:11434", default_model: "qwen3-coder", price: { input: 1 } }, px: { kind: "anthropic-compatible", base_url: "http://px" }, mine: { kind: "openai" } },
    default_model: "ollama:qwen3-coder",
    router: { rules: [{ step: "^review$", model: "codex" }, { step: "^fix$", min_visit: 2, model: "codex:ollama:gpt-oss:20b" }], fallback: ["ollama:x", "opus"], fallback_on: [] },
    other: { keep: true },
  };
  saved = [];
  tested = [];
  routes = {
    "GET /api/config": () => ({ body: structuredClone(config) }),
    "PUT /api/config": (b) => { saved.push(b); config = b; return { body: {} }; },
    "GET /api/providers": () => ({ body: { agents, providers: providerList() } }),
    "POST /api/providers/test": (b) => { tested.push(b.spec); return { body: { ok: true, target: b.spec, seconds: 2 } }; },
  };
  g.fetch = async (url: string, init?: { method?: string; body?: string }) => {
    const r = await routes[`${init?.method ?? "GET"} ${url}`]!(init?.body ? JSON.parse(init.body) : undefined);
    const code = r.status ?? 200;
    return { ok: code < 400, status: code, statusText: "x", json: async () => r.body };
  };
  main().replaceChildren();
  toastEl().className = "";
  vi.resetModules();
  page = await import("../ui/models.js" as string);
});
afterEach(() => { g.fetch = realFetch; });

const el = (id: string) => g.document.getElementById(id) as FakeElement;
const main = () => el("main");
const toastEl = () => el("toast");
const button = (text: string) => main().all("button").find((b) => b.textContent === text)!;
const field = (placeholder: string) => main().all("input").find((i) => i.getAttribute("placeholder") === placeholder)!;
const titles = () => main().all("h3").map((x) => x.textContent);
const testRow = () => main().querySelector("[data-model-test-row]")!;
const row = (name: string) => main().all("tr").find((r) => r.all("td")[0]?.textContent.startsWith(name))!;
const detail = (name: string, opts?: object) => page.renderModelDetail(main(), name, opts);
const alerts = () => main().all("div").filter((d) => d.getAttribute("role") === "alert");

describe("Models list", () => {
  it("links each provider and shows ready or not ready, with no Remove", async () => {
    await page.renderModels(main());
    expect(titles()).toEqual(["Coding agents", "Providers", "Routing"]);
    const link = row("ollama").all("a")[0]!;
    expect(link.getAttribute("href")).toBe("#/models/ollama");
    expect(row("ollama").textContent).toContain("ready");
    expect(row("mine").textContent).toContain("not ready");
    expect(main().all("button").some((b) => b.textContent === "Remove")).toBe(false);
    expect(main().textContent).toContain("not installed");
    expect(testRow()).toBeDefined();
    expect(button("Add provider")).toBeDefined();
  });
});

describe("Provider detail", () => {
  it("shows its cards, pre-filled fields, and saves the whole config changed only in the provider (keeps price)", async () => {
    await detail("ollama");
    expect(titles()).toEqual(["Settings", "Try a model", "Use in routing", "Danger"]);
    expect(field("qwen3-coder").value).toBe("qwen3-coder");
    expect(field("http://localhost:11434").value).toBe("http://localhost:11434");
    field("qwen3-coder").value = "gpt-oss:20b";
    button("Save provider").click();
    await vi.waitFor(() => expect(saved).toHaveLength(1));
    const want = structuredClone(config);
    expect(saved[0].providers.ollama).toEqual({ kind: "ollama", base_url: "http://localhost:11434", default_model: "gpt-oss:20b", price: { input: 1 } });
    delete want.providers.ollama;
    delete saved[0].providers.ollama;
    expect(saved[0]).toEqual(want);
  });

  it("drops a cleared Base URL from the body", async () => {
    await detail("ollama");
    field("http://localhost:11434").value = "";
    button("Save provider").click();
    await vi.waitFor(() => expect(saved).toHaveLength(1));
    expect("base_url" in saved[0].providers.ollama).toBe(false);
  });

  it("keeps the kind of a built-in provider that is saved as an override", async () => {
    await detail("openai");
    expect(titles()).toEqual(["Settings", "Try a model", "Use in routing"]);
    expect(main().textContent).toContain("Built-in provider");
    expect(button("Save provider")).toBeUndefined();
    const before = structuredClone(config);
    field("qwen3-coder").value = "gpt-5";
    button("Save override").click();
    await vi.waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].providers.openai).toEqual({ kind: "openai", default_model: "gpt-5" });
    delete saved[0].providers.openai;
    expect(saved[0]).toEqual(before);
  });

  it("explains a failed save, marks the field and keeps the typed values", async () => {
    await detail("ollama");
    routes["PUT /api/config"] = () => ({ status: 400, body: { error: "providers.ollama.base_url: not a URL" } });
    field("http://localhost:11434").value = "nope";
    button("Save provider").click();
    await vi.waitFor(() => expect(toastEl().className).toContain("error"));
    expect(field("http://localhost:11434").getAttribute("aria-invalid")).toBe("true");
    expect(field("http://localhost:11434").value).toBe("nope");
  });

  it("names the provider in the test spec, also for custom providers of kind anthropic and openai", async () => {
    const run = async (name: string, extra: object = {}) => {
      await detail(name);
      expect((testRow().all("input")[0] as FakeElement).value).toBe(extra as any as string);
    };
    await run("ollama", "claude:ollama:qwen3-coder" as any);
    await run("claude", "claude:claude:qwen3-coder" as any);
    await run("codex", "claude:codex:qwen3-coder" as any);
    await run("px", "claude:px" as any);
    await run("mine", "codex:mine" as any);
    await run("anthropic", "claude:anthropic:haiku" as any);
    await run("openai", "codex:openai" as any);
    await detail("px");
    button("Test").click();
    await vi.waitFor(() => expect(testRow().textContent).toContain("works"));
    expect(tested).toEqual(["claude:px"]);
  });

  it("does not show a test result or error of another page, and keeps the list history", async () => {
    await page.renderModels(main());
    button("Test").click();
    await vi.waitFor(() => expect(testRow().textContent).toContain("works"));
    await detail("px");
    expect(testRow().textContent).not.toContain("works");
    expect((testRow().all("input")[0] as FakeElement).value).toBe("claude:px");
    await page.renderModels(main());
    expect(testRow().textContent).toContain("works");
    expect(row("ollama").textContent).toContain("Last test: works");
  });

  it("does not let a held test or a slow load of one provider reach the next", async () => {
    const gate = held<Reply>();
    const slow = held<Reply>();
    routes["POST /api/providers/test"] = () => gate.promise;
    await detail("px");
    button("Test").click();
    routes["GET /api/config"] = () => slow.promise;
    const late = detail("ollama");
    routes["GET /api/config"] = () => ({ body: structuredClone(config) });
    await detail("mine");
    gate.resolve({ body: { ok: true, target: "claude:px", seconds: 1 } });
    slow.resolve({ body: structuredClone(config) });
    await late;
    await new Promise((r) => setTimeout(r, 0));
    expect(main().all("h1").map((x) => x.textContent)).toEqual(["mine"]);
    expect(testRow().textContent).not.toContain("works");
    routes["POST /api/providers/test"] = (b) => ({ body: { ok: true, target: b.spec, seconds: 1 } });
    button("Test").click();
    await vi.waitFor(() => expect(testRow().textContent).toContain("works"));
    expect(testRow().textContent).toContain("codex:mine");
  });

  it("draws the answer of a test held across Reload into the new page", async () => {
    const gate = held<Reply>();
    routes["POST /api/providers/test"] = () => gate.promise;
    await detail("px");
    button("Test").click();
    main().all("button").find((b) => b.getAttribute("aria-label") === "Reload")!.click();
    await vi.waitFor(() => expect(main().all("h1")[0]?.textContent).toBe("px"));
    gate.resolve({ body: { ok: true, target: "claude:px", seconds: 3 } });
    await vi.waitFor(() => expect(testRow().textContent).toContain("works"));
  });

  it("lists where routing uses the provider", async () => {
    const uses = async (name: string) => {
      await detail(name);
      return main().all("li").map((l) => l.textContent);
    };
    expect(await uses("ollama")).toEqual(["Default model: ollama:qwen3-coder", "Rule 2: ^fix$ · any flow · from visit 2 → codex:ollama:gpt-oss:20b", "Fallback 1: ollama:x"]);
    expect(await uses("openai")).toEqual(["Rule 1: ^review$ · any flow → codex"]);
    expect(await uses("anthropic")).toEqual(["Fallback 2: opus"]);
    await detail("px");
    expect(main().textContent).toContain("No default, rule or fallback uses this provider.");
  });

  it("maps a spec to its provider", () => {
    const names = ["ollama", "my-proxy", "anthropic", "openai"];
    const of = (s: string | undefined) => page.providerOfSpec(s, names);
    expect(of("sonnet")).toBe("anthropic");
    expect(of("codex")).toBe("openai");
    expect(of("codex:gpt-5")).toBe("openai");
    expect(of("ollama:qwen3-coder:30b")).toBe("ollama");
    expect(of("codex:ollama:gpt-oss:20b")).toBe("ollama");
    expect(of("claude:my-proxy:x")).toBe("my-proxy");
    expect(of("")).toBeUndefined();
    expect(of(undefined)).toBeUndefined();
  });
});

describe("Remove provider", () => {
  it("sends nothing when the question is cancelled", async () => {
    const go = vi.fn();
    await detail("px", { go });
    button("Remove provider").click();
    await answerDialog(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(saved).toEqual([]);
    expect(go).not.toHaveBeenCalled();
  });

  it("removes only that provider after a yes and goes to the list", async () => {
    const go = vi.fn();
    const before = structuredClone(config);
    await detail("px", { go });
    button("Remove provider").click();
    await answerDialog(true);
    await vi.waitFor(() => expect(go).toHaveBeenCalledWith("#/models"));
    delete before.providers.px;
    expect(saved).toEqual([before]);
  });

  it("explains a failed Remove and stays", async () => {
    const go = vi.fn();
    await detail("px", { go });
    routes["PUT /api/config"] = () => ({ status: 500, body: { error: "disk full" } });
    button("Remove provider").click();
    await answerDialog(true);
    await vi.waitFor(() => expect(toastEl().className).toContain("error"));
    expect(toastEl().textContent).toContain("disk full");
    expect(go).not.toHaveBeenCalled();
    expect(button("Remove provider")).toBeDefined();
  });
});

describe("Provider detail states", () => {
  it("says when the provider is not set up and links back", async () => {
    await detail("nope");
    expect(main().textContent).toContain("This provider is not set up.");
    expect(main().all("a").some((a) => a.getAttribute("href") === "#/models")).toBe(true);
  });

  it("shows a permission box on 403", async () => {
    routes["GET /api/config"] = () => ({ status: 403, body: { error: "no" } });
    await detail("px");
    expect(main().querySelector("div[data-kind]")?.getAttribute("data-kind")).toBe("permission");
  });

  it("shows an error with Retry when the config fails, and Retry draws the page", async () => {
    routes["GET /api/config"] = () => ({ status: 500, body: { error: "down" } });
    await detail("px");
    expect(alerts()).toHaveLength(1);
    routes["GET /api/config"] = () => ({ body: structuredClone(config) });
    button("Retry").click();
    await vi.waitFor(() => expect(titles()).toContain("Settings"));
  });

  it("says the provider could not be checked when that call fails", async () => {
    routes["GET /api/providers"] = () => ({ status: 500, body: { error: "down" } });
    await detail("px");
    expect(alerts()[0]?.textContent).toContain("could not be checked");
    expect(button("Retry")).toBeDefined();
  });

  it("does not draw a late answer into a replaced page", async () => {
    const gate = held<Reply>();
    routes["GET /api/config"] = () => gate.promise;
    const done = detail("px");
    const other = g.document.getElementById("other") as FakeElement;
    main().replaceChildren(other);
    gate.resolve({ body: structuredClone(config) });
    await done;
    expect(main().children).toEqual([other]);
  });
});
