import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";
import { held, httpError } from "./helpers/flow-app.js";
import { loadUiSource } from "./helpers/ui-load.js";

// The Library page and "Save step as block" on the fake DOM, with the api as `vi.fn`s.

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let real: Record<string, any>;
let lib: Record<string, any>;
const api: Record<string, any> = {};
beforeAll(async () => {
  restore = installFakeDom();
  real = { dom: await import("../ui/dom.js" as string), states: await import("../ui/states.js" as string) };
  lib = await loadUiSource("library.js", {
    "/vendor/yaml/index.js": { default: { stringify: (v: unknown) => JSON.stringify(v) } },
    "./api.js": { api },
    "./dom.js": real.dom,
    "./states.js": real.states,
  }, ["renderLibrary", "saveStepAsBlock", "pickBlock"]);
});
afterAll(() => restore());

const g = globalThis as any;
const el = (id: string) => g.document.getElementById(id) as FakeElement;
const main = () => el("main");
const root = () => el("modal-root");
const toastEl = () => el("toast");
const blockOf = (id: string, over: object = {}) => ({
  id, scope: "repo", yaml: `name: ${id}`, block: { name: `Block ${id}`, category: "Custom", description: "d", steps: [{ id: "s", type: "shell" }] }, ...over,
});
const alerts = (box: FakeElement) => box.all("div").filter((d) => d.getAttribute("role") === "alert");
const btn = (box: FakeElement, text: string) => box.all("button").find((b) => b.textContent === text);
const clickIn = (box: FakeElement, text: string) => {
  const b = btn(box, text);
  if (!b) throw new Error(`no button "${text}" in ${box.textContent.slice(0, 120)}`);
  b.click();
};
const cards = () => main().all("div").filter((d) => d.getAttribute("class") === "block-item");
const busy = () => main().all("div").some((d) => d.getAttribute("aria-busy") === "true");

beforeEach(() => {
  api.blocks = vi.fn(async () => [blockOf("a"), blockOf("b")]);
  api.deleteBlock = vi.fn(async () => ({}));
  api.saveBlock = vi.fn(async () => ({}));
  main().replaceChildren();
  root().replaceChildren();
  toastEl().className = "";
  toastEl().replaceChildren();
  g.document.listeners.keydown = [];
});

describe("Library page", () => {
  it("shows a skeleton, then the cards", async () => {
    const gate = held<any[]>();
    api.blocks = vi.fn(() => gate.promise);
    const done = lib.renderLibrary(main());
    expect(busy()).toBe(true);
    gate.resolve([blockOf("a"), blockOf("b")]);
    await done;
    expect(busy()).toBe(false);
    expect(cards()).toHaveLength(2);
  });

  it("says when there are no blocks", async () => {
    api.blocks = vi.fn(async () => []);
    await lib.renderLibrary(main());
    expect(main().textContent).toContain("No blocks yet.");
  });

  it("shows an error with Retry on 500, and Retry draws the list", async () => {
    api.blocks = vi.fn().mockRejectedValueOnce(httpError(500)).mockResolvedValue([blockOf("a")]);
    await lib.renderLibrary(main());
    expect(alerts(main())).toHaveLength(1);
    clickIn(main(), "Retry");
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    expect(alerts(main())).toHaveLength(0);
  });

  it("shows the permission box on 403", async () => {
    api.blocks = vi.fn().mockRejectedValue(httpError(403, "no"));
    await lib.renderLibrary(main());
    expect(main().all("div").some((d) => d.getAttribute("data-kind") === "permission")).toBe(true);
    expect(btn(main(), "Retry")).toBeUndefined();
  });

  it("draws a late answer into its own box only", async () => {
    const gate = held<any[]>();
    api.blocks = vi.fn(() => gate.promise);
    const done = lib.renderLibrary(main());
    const other = real.dom.h("p", {}, "other page");
    real.dom.mount(main(), other);
    gate.resolve([blockOf("a")]);
    await done;
    expect(main().children).toEqual([other]);
  });

  describe("delete", () => {
    const open = async () => {
      await lib.renderLibrary(main());
      clickIn(cards()[0]!, "Delete");
    };

    it("asks first, and Cancel calls nothing", async () => {
      await open();
      expect(root().textContent).toContain('Delete block "a"?');
      clickIn(root(), "Cancel");
      await Promise.resolve();
      expect(api.deleteBlock).not.toHaveBeenCalled();
    });

    it("explains a failure, keeps the cards, and Retry deletes again without a question", async () => {
      api.deleteBlock = vi.fn().mockRejectedValueOnce(httpError(500)).mockResolvedValue({});
      await open();
      clickIn(root(), "Delete");
      await vi.waitFor(() => expect(main().textContent).toContain("was not deleted"));
      expect(cards()).toHaveLength(2);
      expect(api.blocks).toHaveBeenCalledTimes(1);
      clickIn(main(), "Retry");
      await vi.waitFor(() => expect(api.deleteBlock).toHaveBeenCalledTimes(2));
      expect(root().children).toHaveLength(0);
      await vi.waitFor(() => expect(api.blocks).toHaveBeenCalledTimes(2));
      expect(toastEl().textContent).toContain('Deleted block "a"');
    });

    it("shows a toast and loads the list again on success", async () => {
      await open();
      clickIn(root(), "Delete");
      await vi.waitFor(() => expect(api.blocks).toHaveBeenCalledTimes(2));
      expect(toastEl().textContent).toContain('Deleted block "a"');
    });
  });
});

describe("Save step as block", () => {
  const flow = { vars: {} };
  const step = { id: "my_step", type: "shell", run: "x" };
  const label = (text: string) => root().all("label").find((l) => l.all("span")[0]?.textContent === text)!.all("input")[0]!;
  const form = async () => { await vi.waitFor(() => expect(btn(root(), "Save block")).toBeDefined()); };

  it("saves a new id once and shows a toast", async () => {
    const done = lib.saveStepAsBlock(flow, step);
    await form();
    clickIn(root(), "Save block");
    await done;
    expect(api.saveBlock).toHaveBeenCalledTimes(1);
    expect(api.saveBlock.mock.calls[0][0]).toBe("my-step");
    expect(toastEl().textContent).toContain("my-step");
  });

  it("asks before it overwrites, and Cancel reopens the form with the same values", async () => {
    api.blocks = vi.fn(async () => [blockOf("my-step")]);
    const done = lib.saveStepAsBlock(flow, step);
    await form();
    label("Name").value = "Typed name";
    clickIn(root(), "Save block");
    await vi.waitFor(() => expect(root().textContent).toContain("Overwrite block?"));
    clickIn(root(), "Cancel");
    await form();
    expect(label("Id (file name)").value).toBe("my-step");
    expect(label("Name").value).toBe("Typed name");
    expect(api.saveBlock).not.toHaveBeenCalled();
    clickIn(root(), "Save block");
    await vi.waitFor(() => expect(root().textContent).toContain("Overwrite block?"));
    clickIn(root(), "Overwrite");
    await done;
    expect(api.saveBlock).toHaveBeenCalledTimes(1);
  });

  it("reopens the form with the typed values and an alert when the save fails", async () => {
    api.saveBlock = vi.fn().mockRejectedValueOnce(httpError(500)).mockResolvedValue({});
    const done = lib.saveStepAsBlock(flow, step);
    await form();
    label("Name").value = "Typed name";
    clickIn(root(), "Save block");
    await vi.waitFor(() => expect(alerts(root())).toHaveLength(1));
    expect(alerts(root())[0]!.textContent).toContain("was not saved");
    expect(label("Name").value).toBe("Typed name");
    clickIn(root(), "Save block");
    await done;
    expect(api.saveBlock).toHaveBeenCalledTimes(2);
  });

  it("does not replace another dialog when the save fails", async () => {
    const gate = held<any>();
    api.saveBlock = vi.fn(() => gate.promise);
    const done = lib.saveStepAsBlock(flow, step);
    await form();
    clickIn(root(), "Save block");
    await vi.waitFor(() => expect(api.saveBlock).toHaveBeenCalled());
    const other = real.dom.h("p", {}, "another dialog");
    root().replaceChildren(other);
    gate.reject(httpError(500));
    await done;
    expect(root().children).toEqual([other]);
    expect(toastEl().textContent).toContain("was not saved");
  });

  it("has no native confirm", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("ui/library.js", "utf8")).not.toMatch(/\bconfirm\(/);
  });
});
