import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let types: any;
beforeAll(async () => {
  restore = installFakeDom();
  types = await import("../ui/step-types.js" as string);
});
afterAll(() => restore());

const LABEL = "Needs repository access";
const body = (step: any, onChange = () => {}) => {
  const flow = { name: "t", steps: [step, { id: "z", type: "shell", run: "x" }, { id: "y", type: "shell", run: "x" }] };
  const nodes: FakeElement[] = types.stepBody(flow, step, 0, { onChange, rerender: () => {}, vars: [], earlier: [], priorClaude: [] });
  return nodes.flatMap((n) => (n.tag === "label" ? [n] : n.all("label")));
};
const labelOf = (labels: FakeElement[], text: string) => labels.find((l) => l.textContent.includes(text));

describe("step editor: repo_access", () => {
  it("shows the checkbox next to Run in Docker on a shell step", () => {
    const labels = body({ id: "a", type: "shell", run: "x" });
    expect(labelOf(labels, "Run in Docker")).toBeDefined();
    expect(labelOf(labels, LABEL)).toBeDefined();
  });

  it("ticking sets the key and unticking removes it", () => {
    const step: any = { id: "a", type: "shell", run: "x" };
    let changes = 0;
    const input = labelOf(body(step, () => changes++), LABEL)!.all("input")[0] as any;
    input.checked = true;
    input.fire("change", { target: input });
    expect(step.repo_access).toBe(true);
    input.checked = false;
    input.fire("change", { target: input });
    expect("repo_access" in step).toBe(false);
    expect(changes).toBe(2);
  });

  it("renders ticked when the step has the flag", () => {
    const input = labelOf(body({ id: "a", type: "shell", run: "x", repo_access: true }), LABEL)!.all("input")[0] as any;
    expect(input.checked).toBe(true);
  });

  it("is not offered on other step types", () => {
    for (const step of [
      { id: "a", type: "claude", prompt: "x" },
      { id: "a", type: "approval", message: "x" },
      { id: "a", type: "parallel", steps: ["z", "y"] },
      { id: "a", type: "flow", flow: "other" },
    ]) expect(labelOf(body(step), LABEL), step.type).toBeUndefined();
  });
});

describe("data-field and data-section markers", () => {
  const fieldsOf = (nodes: FakeElement[]) => nodes.flatMap((n) => [n, ...n.querySelectorAll("[data-field]")]).map((e) => e.getAttribute("data-field")).filter(Boolean);
  const stepCtx = { onChange: () => {}, rerender: () => {}, vars: [], earlier: [], priorClaude: [] };

  it("marks the controls of a shell step", () => {
    const step = { id: "a", type: "shell", run: "x" };
    const nodes: FakeElement[] = types.stepBody({ name: "t", steps: [step] }, step, 0, stepCtx);
    expect(fieldsOf(nodes)).toEqual(expect.arrayContaining(["run", "sandbox", "repo_access"]));
  });

  it("marks the controls of a claude step", () => {
    const step = { id: "a", type: "claude", prompt: "p" };
    const nodes: FakeElement[] = types.stepBody({ name: "t", steps: [step] }, step, 0, stepCtx);
    expect(fieldsOf(nodes)).toEqual(expect.arrayContaining(["prompt", "model", "agent", "permission_mode", "allowed_tools", "system_prompt"]));
  });

  it("draws a jump-only step as ticked", async () => {
    const editor: any = await import("../ui/editor.js" as string);
    const ctx = { onChange: () => {}, rerender: () => {}, onSelect: () => {} };
    const box = (on: boolean) => editor.renderEditor({ name: "t", steps: [{ id: "a", type: "shell", run: "x", ...(on ? { jump_only: true } : {}) }] }, ctx)
      .querySelectorAll("[data-field]").find((e: FakeElement) => e.getAttribute("data-field") === "jump_only") as any;
    expect(box(true).checked).toBe(true);
    expect(box(false).checked).toBeFalsy(); // h() leaves a false `checked` unset
  });

  it("refuses flows the visual editor cannot draw", async () => {
    const editor: any = await import("../ui/editor.js" as string);
    expect(editor.editable({ name: "t", steps: [{ id: "a" }], defaults: {} })).toBe(true);
    expect(editor.editable({ name: "t" })).toBe(true);
    for (const bad of [null, [], "x", { steps: "nope" }, { steps: ["a"] }, { steps: {} }, { defaults: "x" }, { vars: [] }, { publish: 3 }]) {
      expect(editor.editable(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("marks the step id and the settings sections in the editor", async () => {
    const editor: any = await import("../ui/editor.js" as string);
    const tree: FakeElement = editor.renderEditor({ name: "t", steps: [{ id: "a", type: "shell", run: "x" }] }, { onChange: () => {}, rerender: () => {}, onSelect: () => {} });
    expect(tree.querySelectorAll("[data-field]").some((e) => e.getAttribute("data-field") === "id")).toBe(true);
    const sections = tree.querySelectorAll("[data-section]").map((e) => e.getAttribute("data-section"));
    expect(sections).toEqual(["flow", "defaults", "limits sandbox", "vars", "publish"]);
  });
});
