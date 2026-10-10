import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installFakeDom, type FakeElement } from "./helpers/fake-dom.js";
import { alertsIn, buttonIn, click, dropBrowser, edit, escape, flowJson, held, httpError, launchApp, main, root, sidebar, toastEl } from "./helpers/flow-app.js";

// Validation, save, delete, run and "Draft with Claude" on the fake DOM: no server, no timers.

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

const doc = () => (globalThis as any).document;
const entry = (name: string) => ({ name, scope: "repo", description: "" });
const h1 = () => main().all("h1")[0]?.textContent;
const errorsBox = () => main().all("div").find((d) => d.getAttribute("class") === "errors");
const stateText = () => main().all("span").find((s) => s.getAttribute("class") === "flow-dirty")?.textContent;
const saveButton = () => buttonIn(main(), "Save")!;
const toastShown = () => toastEl().className.includes("show");
const tick = () => new Promise((r) => setTimeout(r, 0));
const trash = () => main().all("button").find((b) => b.textContent === "Delete flow")!;
const startButton = () => root().all("button").find((b) => b.textContent.startsWith("▶"))!;
const taskBox = () => root().all("textarea")[0]!;

async function open(over: Record<string, any> = {}, hash = "#/flows/a") {
  const app = await launchApp(real, hash, over);
  await vi.waitFor(() => expect(h1()).toBeDefined());
  return app;
}
const changed = (name = "a") => edit(flowJson(name, { description: "changed" }));

describe("validation", () => {
  it("stops a save with an error above the editor, focused, and no toast", async () => {
    const { api } = await open();
    api.validate.mockResolvedValue({ ok: false, error: "<flow>: steps: required" });
    saveButton().click();
    await vi.waitFor(() => expect(errorsBox()).toBeDefined());
    expect(api.saveFlow).not.toHaveBeenCalled();
    expect(errorsBox()!.textContent).toContain("Fix these errors before saving.");
    expect(errorsBox()!.textContent).toContain("steps: required");
    expect(doc().activeElement).toBe(errorsBox());
    expect(toastShown()).toBe(false);
  });

  it("puts a bad flow name in the same box", async () => {
    const { api } = await open({ flow: vi.fn(async () => ({ name: "a", scope: "repo", yaml: flowJson("my flow") })) });
    saveButton().click();
    await vi.waitFor(() => expect(errorsBox()).toBeDefined());
    expect(errorsBox()!.textContent).toContain("Flow name may only contain");
    expect(errorsBox()!.textContent).toContain("Fix these errors before saving.");
    expect(doc().activeElement).toBe(errorsBox());
    expect(api.saveFlow).not.toHaveBeenCalled();
  });

  it("saves nothing when the person types while the check runs", async () => {
    const { api } = await open();
    click(main(), "YAML");
    const gate = held<any>();
    api.validate.mockReturnValueOnce(gate.promise);
    saveButton().click();
    const ta = edit(flowJson("a", { description: "typed meanwhile" }));
    gate.resolve({ ok: true, flow: { name: "a", workspace: "worktree", vars: {} } });
    await vi.waitFor(() => expect(saveButton().disabled).toBe(false));
    expect(api.saveFlow).not.toHaveBeenCalled();
    expect(stateText()).toBe("Unsaved changes");
    expect(main().all("textarea")[0]!.value).toBe(ta.value);
  });

  it("opens no Run dialog for text that changed while the check ran", async () => {
    const { api } = await open();
    click(main(), "YAML");
    const gate = held<any>();
    api.validate.mockReturnValueOnce(gate.promise);
    click(main(), "Test run");
    edit(flowJson("a", { description: "typed meanwhile" }));
    gate.resolve({ ok: true, flow: { name: "a", workspace: "worktree", vars: {} } });
    await tick();
    await tick();
    expect(root().children).toHaveLength(0);
  });

  it("does not let an automatic check that ends late remove the explicit lead", async () => {
    const { api } = await open();
    const slow = held<any>();
    api.validate.mockReturnValueOnce(slow.promise).mockResolvedValueOnce({ ok: false, error: "E2" });
    click(main(), "YAML"); // an automatic check starts and is held
    saveButton().click(); // the explicit check answers first
    await vi.waitFor(() => expect(errorsBox()?.textContent).toContain("Fix these errors before saving."));
    slow.resolve({ ok: false, error: "E1" });
    await tick();
    expect(errorsBox()!.textContent).toContain("Fix these errors before saving.");
    expect(errorsBox()!.textContent).toContain("E2");
  });

  it("does not check a flow that was deleted while the typing check waited", async () => {
    const { api, debounced } = await open();
    trash().click();
    await vi.waitFor(() => expect(root().textContent).toContain("Delete flow?"));
    click(root(), "Delete");
    await vi.waitFor(() => expect(location.hash).toBe("#/flows"));
    api.validate.mockClear();
    expect(() => debounced.forEach((fn) => fn())).not.toThrow();
    expect(api.validate).not.toHaveBeenCalled();
  });
});

describe("save", () => {
  it("explains a failed save, keeps the draft, and Retry sends the same text", async () => {
    const { api } = await open();
    api.saveFlow.mockRejectedValueOnce(httpError(500));
    changed();
    const text = flowJson("a", { description: "changed" });
    saveButton().click();
    await vi.waitFor(() => expect(alertsIn(main())).toHaveLength(1));
    expect(alertsIn(main())[0]!.textContent).toContain("was not saved");
    expect(stateText()).toBe("Unsaved changes");
    expect(saveButton().disabled).toBe(false);
    click(main(), "Retry");
    await vi.waitFor(() => expect(api.saveFlow).toHaveBeenCalledTimes(2));
    expect(api.saveFlow.mock.calls[1]![1]).toBe(text);
    await vi.waitFor(() => expect(alertsIn(main())).toHaveLength(0));
    expect(toastEl().textContent).toContain("Saved a");
    expect(toastShown()).toBe(true);
    expect(stateText()).toBe("Saved");
  });

  it("does not move the address or the page when the person went to another flow during the save", async () => {
    const { api, go } = await open();
    const gate = held<any>();
    api.saveFlow.mockReturnValueOnce(gate.promise);
    saveButton().click();
    await vi.waitFor(() => expect(api.saveFlow).toHaveBeenCalled());
    await go("#/flows/other");
    await vi.waitFor(() => expect(h1()).toBe("other"));
    gate.resolve({ yaml: flowJson("a") });
    await tick();
    expect(history.replaceState).not.toHaveBeenCalledWith(null, "", "#/flows/a");
    expect(h1()).toBe("other");
    expect(location.hash).toBe("#/flows/other");
  });

  it("says Saved when the list cannot be refreshed afterwards, and marks the sidebar", async () => {
    const flows = vi.fn().mockResolvedValueOnce([entry("a")]).mockRejectedValue(httpError(500));
    const { api } = await open({ flows });
    await vi.waitFor(() => expect(sidebar().textContent).toContain("a"));
    changed();
    saveButton().click();
    await vi.waitFor(() => expect(sidebar().textContent).toContain("Could not refresh."));
    expect(api.saveFlow).toHaveBeenCalledTimes(1);
    expect(toastEl().textContent).toContain("Saved a");
    expect(alertsIn(main())).toHaveLength(0);
  });

  it("saves under the new name and says so when the old name cannot be removed", async () => {
    const { api } = await open({ deleteFlow: vi.fn().mockRejectedValue(httpError(500)) });
    changed("b");
    saveButton().click();
    await vi.waitFor(() => expect(alertsIn(main())).toHaveLength(1));
    expect(api.saveFlow.mock.calls[0]![0]).toBe("b");
    expect(alertsIn(main())[0]!.textContent).toContain("could not be removed");
    expect(toastEl().textContent).toContain("Saved b");
    expect(location.hash).toBe("#/flows/b");
  });

  it("keeps edits made while the old name is removed as unsaved", async () => {
    const gate = held<any>();
    const { api } = await open({ deleteFlow: vi.fn(() => gate.promise) });
    changed("b");
    saveButton().click();
    await vi.waitFor(() => expect(api.deleteFlow).toHaveBeenCalled());
    edit(flowJson("b", { description: "typed during cleanup" }));
    gate.resolve({});
    await vi.waitFor(() => expect(toastEl().textContent).toContain("Saved b"));
    expect(stateText()).toBe("Unsaved changes");
  });

  it("retries the removal of the old name without throwing, and keeps the alert on a second failure", async () => {
    const deleteFlow = vi.fn().mockRejectedValueOnce(httpError(500)).mockRejectedValueOnce(httpError(500)).mockResolvedValue({});
    await open({ deleteFlow });
    changed("b");
    saveButton().click();
    await vi.waitFor(() => expect(alertsIn(main())).toHaveLength(1));
    click(main(), "Retry");
    await vi.waitFor(() => expect(deleteFlow).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(alertsIn(main())).toHaveLength(1));
    click(main(), "Retry");
    await vi.waitFor(() => expect(alertsIn(main())).toHaveLength(0));
  });

  describe("overwrite", () => {
    const open2 = async () => {
      const app = await open({ flows: vi.fn(async () => [entry("a"), entry("b")]) });
      await vi.waitFor(() => expect(sidebar().textContent).toContain("b"));
      changed("b");
      saveButton().click();
      await vi.waitFor(() => expect(root().textContent).toContain("Overwrite flow?"));
      return app;
    };

    it("does not save when the person says no", async () => {
      const { api } = await open2();
      click(root(), "Cancel");
      await tick();
      expect(api.saveFlow).not.toHaveBeenCalled();
      expect(saveButton().disabled).toBe(false);
    });

    it("saves when the person agrees", async () => {
      const { api } = await open2();
      click(root(), "Overwrite");
      await vi.waitFor(() => expect(api.saveFlow).toHaveBeenCalledTimes(1));
    });

    it("looks at a fresh list first when the first load failed", async () => {
      const flows = vi.fn().mockRejectedValueOnce(httpError(500)).mockResolvedValue([entry("a"), entry("b")]);
      const { api } = await open({ flows });
      changed("b");
      saveButton().click();
      await vi.waitFor(() => expect(root().textContent).toContain("Overwrite flow?"));
      expect(api.saveFlow).not.toHaveBeenCalled();
    });

    it("asks for a target that was added after the first successful load", async () => {
      const flows = vi.fn().mockResolvedValueOnce([entry("a")]).mockResolvedValue([entry("a"), entry("b")]);
      const { api } = await open({ flows });
      await vi.waitFor(() => expect(sidebar().textContent).toContain("a"));
      changed("b");
      saveButton().click();
      await vi.waitFor(() => expect(root().textContent).toContain("Overwrite flow?"));
      expect(api.saveFlow).not.toHaveBeenCalled();
    });

    it("does not save a new name while the list cannot be checked", async () => {
      const { api } = await open({ flows: vi.fn().mockRejectedValue(httpError(500)) });
      changed("b");
      saveButton().click();
      await vi.waitFor(() => expect(alertsIn(main())).toHaveLength(1));
      expect(alertsIn(main())[0]!.textContent).toContain("could not be checked");
      expect(api.saveFlow).not.toHaveBeenCalled();
    });
  });
});

describe("delete", () => {
  it("does nothing on Cancel", async () => {
    const { api } = await open();
    trash().click();
    await vi.waitFor(() => expect(root().textContent).toContain("Delete flow?"));
    click(root(), "Cancel");
    await tick();
    expect(api.deleteFlow).not.toHaveBeenCalled();
  });

  it("warns that unsaved changes are lost", async () => {
    await open();
    changed();
    trash().click();
    await vi.waitFor(() => expect(root().textContent).toContain("unsaved changes will be lost"));
  });

  it("explains a failure, keeps the flow and the address, and enables the button again", async () => {
    const { api } = await open();
    api.deleteFlow.mockRejectedValueOnce(httpError(500));
    trash().click();
    await vi.waitFor(() => expect(root().textContent).toContain("Delete flow?"));
    click(root(), "Delete");
    await vi.waitFor(() => expect(alertsIn(main())).toHaveLength(1));
    expect(alertsIn(main())[0]!.textContent).toContain("was not deleted");
    expect(h1()).toBe("a");
    expect(location.hash).toBe("#/flows/a");
    expect(trash().disabled).toBe(false);
    click(main(), "Retry");
    await vi.waitFor(() => expect(location.hash).toBe("#/flows"));
    expect(api.deleteFlow).toHaveBeenCalledTimes(2);
  });

  it("goes to the list on success", async () => {
    await open();
    trash().click();
    await vi.waitFor(() => expect(root().textContent).toContain("Delete flow?"));
    click(root(), "Delete");
    await vi.waitFor(() => expect(location.hash).toBe("#/flows"));
  });

  it("keeps text typed while the delete ran as a new unsaved draft", async () => {
    const { api } = await open();
    const gate = held<any>();
    api.deleteFlow.mockReturnValueOnce(gate.promise);
    trash().click();
    await vi.waitFor(() => expect(root().textContent).toContain("Delete flow?"));
    click(root(), "Delete");
    await vi.waitFor(() => expect(api.deleteFlow).toHaveBeenCalled());
    const ta = edit(flowJson("a", { description: "typed meanwhile" }));
    gate.resolve({});
    await vi.waitFor(() => expect(location.hash).toBe("#/new"));
    expect(main().all("textarea")[0]!.value).toBe(ta.value);
    expect(stateText()).toBe("Unsaved changes");
  });

  it("does not send another page to the list when the delete ends", async () => {
    const renderDashboard = vi.fn(async (box: any) => { real.dom.mount(box, real.dom.h("p", {}, "dashboard page")); });
    const app = await launchApp(real, "#/flows/a", {}, { "./dashboard.js": { renderDashboard } });
    await vi.waitFor(() => expect(h1()).toBe("a"));
    const gate = held<any>();
    app.api.deleteFlow.mockReturnValueOnce(gate.promise);
    trash().click();
    await vi.waitFor(() => expect(root().textContent).toContain("Delete flow?"));
    click(root(), "Delete");
    await vi.waitFor(() => expect(app.api.deleteFlow).toHaveBeenCalled());
    await app.go("#/dashboard");
    gate.resolve({});
    await tick();
    await tick();
    expect(location.hash).toBe("#/dashboard");
    expect(main().textContent).toContain("dashboard page");
  });

  it("shows a toast when a delete fails and the editor is not on the page", async () => {
    const renderDashboard = vi.fn(async (box: any) => { real.dom.mount(box, real.dom.h("p", {}, "dashboard page")); });
    const app = await launchApp(real, "#/flows/a", {}, { "./dashboard.js": { renderDashboard } });
    await vi.waitFor(() => expect(h1()).toBe("a"));
    const gate = held<any>();
    app.api.deleteFlow.mockReturnValueOnce(gate.promise);
    trash().click();
    await vi.waitFor(() => expect(root().textContent).toContain("Delete flow?"));
    click(root(), "Delete");
    await vi.waitFor(() => expect(app.api.deleteFlow).toHaveBeenCalled());
    await app.go("#/dashboard");
    gate.reject(httpError(500));
    await vi.waitFor(() => expect(toastShown()).toBe(true));
    expect(toastEl().textContent).toContain("was not deleted");
  });

  it("leaves another flow alone when it was opened while the delete ran", async () => {
    const { api, go } = await open();
    const gate = held<any>();
    api.deleteFlow.mockReturnValueOnce(gate.promise);
    trash().click();
    await vi.waitFor(() => expect(root().textContent).toContain("Delete flow?"));
    click(root(), "Delete");
    await vi.waitFor(() => expect(api.deleteFlow).toHaveBeenCalled());
    await go("#/flows/other");
    await vi.waitFor(() => expect(h1()).toBe("other"));
    gate.resolve({});
    await tick();
    await tick();
    expect(h1()).toBe("other");
    expect(location.hash).toBe("#/flows/other");
  });
});

describe("run", () => {
  it("stops an invalid flow above the editor and opens no dialog", async () => {
    const { api } = await open();
    api.validate.mockResolvedValue({ ok: false, error: "steps: required" });
    click(main(), "Test run");
    await vi.waitFor(() => expect(errorsBox()?.textContent).toContain("Fix these errors before running."));
    expect(root().children).toHaveLength(0);
  });

  it("asks once about an empty task, inline, and starts on the second click", async () => {
    const { api } = await open();
    click(main(), "Test run");
    await vi.waitFor(() => expect(startButton()).toBeDefined());
    startButton().click();
    expect(api.startRun).not.toHaveBeenCalled();
    expect(root().textContent).toContain("There is no task text.");
    expect(startButton().textContent).toContain("Run without a task");
    startButton().click();
    await vi.waitFor(() => expect(api.startRun).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(location.hash).toBe("#/runs/run1"));
  });

  it("asks again after the task text changes", async () => {
    const { api } = await open();
    click(main(), "Test run");
    await vi.waitFor(() => expect(startButton()).toBeDefined());
    startButton().click();
    taskBox().fire("input", { target: taskBox() });
    expect(root().textContent).not.toContain("There is no task text.");
    startButton().click();
    expect(api.startRun).not.toHaveBeenCalled();
  });

  it("cannot be closed while the run starts", async () => {
    const { api } = await open();
    const gate = held<any>();
    api.startRun.mockReturnValueOnce(gate.promise);
    click(main(), "Test run");
    await vi.waitFor(() => expect(startButton()).toBeDefined());
    taskBox().value = "do it";
    startButton().click();
    await vi.waitFor(() => expect(api.startRun).toHaveBeenCalled());
    escape();
    root().all("button").find((b) => b.getAttribute("aria-label") === "Close")!.click();
    expect(root().children).toHaveLength(1);
    gate.resolve({ runId: "run9" });
    await vi.waitFor(() => expect(location.hash).toBe("#/runs/run9"));
  });

  it("explains a failed start and keeps the task", async () => {
    const { api } = await open();
    api.startRun.mockRejectedValueOnce(httpError(500));
    click(main(), "Test run");
    await vi.waitFor(() => expect(startButton()).toBeDefined());
    taskBox().value = "my task";
    startButton().click();
    await vi.waitFor(() => expect(root().textContent).toContain("The run was not started."));
    expect(taskBox().value).toBe("my task");
    expect(taskBox().disabled).toBe(false);
    expect(startButton().disabled).toBe(false);
  });
});

describe("Draft with Claude", () => {
  const ask = async () => {
    const app = await open();
    click(main(), "✨ Ask Claude");
    await vi.waitFor(() => expect(root().all("textarea")).toHaveLength(1));
    return app;
  };

  it("blocks while Claude works", async () => {
    const { api } = await ask();
    const gate = held<any>();
    api.generate.mockReturnValueOnce(gate.promise);
    taskBox().value = "add lint";
    click(root(), "✨ Apply");
    escape();
    expect(root().children).toHaveLength(1);
    expect(root().textContent).toContain("Claude is drafting");
    gate.resolve({ yaml: flowJson("a", { description: "drafted" }), costUsd: 0.1 });
    await vi.waitFor(() => expect(root().children).toHaveLength(0));
  });

  it("explains a failure and keeps the text", async () => {
    const { api } = await ask();
    api.generate.mockRejectedValueOnce(httpError(500));
    taskBox().value = "add lint";
    click(root(), "✨ Apply");
    await vi.waitFor(() => expect(alertsIn(root())).toHaveLength(1));
    expect(alertsIn(root())[0]!.textContent).toContain("Claude could not draft the flow.");
    expect(taskBox().value).toBe("add lint");
    expect(taskBox().disabled).toBe(false);
  });
});

export type { FakeElement };
