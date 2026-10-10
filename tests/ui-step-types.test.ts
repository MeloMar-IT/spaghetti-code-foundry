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
    const box = (on: boolean) => editor.renderEditor({ name: "t", steps: [{ id: "a", type: "shell", run: "x", ...(on ? { jump_only: true } : {}) }] }, { ...ctx, selected: 0 })
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
    const ctx = { onChange: () => {}, rerender: () => {}, onSelect: () => {} };
    const flow = () => ({ name: "t", steps: [{ id: "a", type: "shell", run: "x" }] });
    const step: FakeElement = editor.renderEditor(flow(), { ...ctx, selected: 0 });
    expect(step.querySelectorAll("[data-field]").some((e) => e.getAttribute("data-field") === "id")).toBe(true);
    const tree: FakeElement = editor.renderEditor(flow(), ctx);
    const sections = tree.querySelectorAll("[data-section]").map((e) => e.getAttribute("data-section"));
    expect(sections).toEqual(["flow", "defaults", "limits sandbox", "vars", "publish"]);
  });
});

describe("stepMain and stepGroups", () => {
  const ctx = { onChange: () => {}, rerender: () => {}, vars: [], earlier: [] };
  const mk = (step: any) => ({ name: "t", steps: [step, { id: "z", type: "shell", run: "x" }, { id: "y", type: "claude", prompt: "p" }] });
  const text = (nodes: FakeElement[]) => nodes.filter(Boolean).map((n) => n.textContent).join("|");
  const main = (step: any) => text(types.stepMain(mk(step), step, 0, ctx));
  const groups = (step: any, flow: any = mk(step)) => types.stepGroups(flow, step, 0, ctx);
  const everything = (step: any) => text(groups(step).flatMap((g: any) => g.nodes));
  const claude = () => ({ id: "a", type: "claude", prompt: "p" });

  it("shows the essentials of each type and nothing else", () => {
    const cases: Array<[any, string[], string[]]> = [
      [claude(), ["Prompt", "Model"], ["Agent", "Allowed tools", "Command"]],
      [{ id: "a", type: "shell", run: "x" }, ["Command"], ["Run in Docker", "Model"]],
      [{ id: "a", type: "approval", message: "?" }, ["Question for the approver"], ["Command", "Model", "Prompt"]],
      [{ id: "a", type: "parallel", steps: [] }, ["Run these steps at the same time"], ["Command", "Model"]],
      [{ id: "a", type: "flow", flow: "f" }, ["Flow to run"], ["Command", "Model"]],
    ];
    for (const [step, has, hasNot] of cases) {
      const t = main(step);
      for (const s of has) expect(t, `${step.type} has ${s}`).toContain(s);
      for (const s of hasNot) expect(t, `${step.type} has not ${s}`).not.toContain(s);
    }
  });

  it("gives the groups by type", () => {
    const ids = (step: any) => groups(step).map((g: any) => g.id);
    expect(ids(claude())).toEqual(["routing", "limits", "sandbox", "model"]);
    expect(ids({ id: "a", type: "shell", run: "x" })).toEqual(["routing", "limits", "sandbox"]);
    for (const step of [{ id: "a", type: "approval" }, { id: "a", type: "parallel", steps: [] }, { id: "a", type: "flow", flow: "f" }]) {
      expect(ids(step)).toEqual(["routing", "limits"]);
    }
    expect(ids({ id: "a", type: "weird" })).toEqual([]);
  });

  it("keeps repository access to shell and budget to agent steps", () => {
    expect(everything({ id: "a", type: "shell", run: "x" })).toContain("Needs repository access");
    expect(everything(claude())).not.toContain("Needs repository access");
    expect(everything(claude())).toContain("Budget ($)");
    expect(everything({ id: "a", type: "shell", run: "x" })).not.toContain("Budget ($)");
    expect(everything({ id: "a", type: "approval" })).not.toContain("Budget ($)");
  });

  it("shows each pattern field of a parallel or sub-flow step only when it holds a value", () => {
    for (const type of ["parallel", "flow"]) {
      const base: any = { id: "a", type, steps: [], flow: "f" };
      expect(everything(base)).not.toContain("Pass only if");
      expect(everything(base)).not.toContain("Fail if");
      expect(everything({ ...base, pass_if: "x" })).toContain("Pass only if");
      expect(everything({ ...base, pass_if: "x" })).not.toContain("Fail if");
      expect(everything({ ...base, fail_if: "x" })).toContain("Fail if");
      expect(everything({ ...base, fail_if: "x" })).not.toContain("Pass only if");
      expect(everything({ ...base, pass_if: "x", fail_if: "y" })).toMatch(/Pass only if.*Fail if|Fail if.*Pass only if/);
    }
    for (const step of [claude(), { id: "a", type: "shell", run: "x" }, { id: "a", type: "approval" }]) {
      expect(everything(step)).toContain("Pass only if");
      expect(everything(step)).toContain("Fail if");
    }
  });

  it("keeps a stored pattern editable on a parallel step", () => {
    const step: any = { id: "a", type: "parallel", steps: [], pass_if: "x" };
    const input = groups(step)[0].nodes.flatMap((n: FakeElement) => n.querySelectorAll("[data-field]")).find((e: FakeElement) => e.attrs["data-field"] === "pass_if");
    input.value = "y";
    input.fire("input", { target: input });
    expect(step.pass_if).toBe("y");
  });

  it("closes the groups of a blank step and opens one that holds a value", () => {
    const open = (step: any, flow?: any) => groups(step, flow).filter((g: any) => g.open).map((g: any) => g.id);
    expect(open(claude())).toEqual([]);
    const cases: Array<[any, string]> = [
      [{ on_failure: "end" }, "routing"], [{ on_success: "end" }, "routing"], [{ routes: [{ if: "x", goto: "end" }] }, "routing"],
      [{ jump_only: true }, "routing"], [{ resume_from: "z" }, "routing"], [{ pass_if: "x" }, "routing"],
      [{ max_visits: 3 }, "limits"], [{ timeout_sec: 5 }, "limits"], [{ max_budget_usd: 1 }, "limits"],
      [{ sandbox: false }, "sandbox"], [{ repo_access: true }, "sandbox"],
      [{ allowed_tools: ["Read"] }, "model"], [{ resume: "z" }, "model"], [{ effort: "high" }, "model"], [{ skill_role: "reviewer" }, "model"],
      [{ agent: "codex" }, "model"], [{ provider: "x" }, "model"], [{ permission_mode: "plan" }, "model"], [{ system_prompt: "s" }, "model"],
    ];
    for (const [extra, group] of cases) expect(open({ ...claude(), ...extra }), JSON.stringify(extra)).toEqual([group]);
  });

  it("shows effort and skill role in the model group", () => {
    const t = everything(claude());
    expect(t).toContain("Effort");
    expect(t).toContain("Skill role");
  });

  it("wraps a group in details with its id and title", () => {
    const g = types.groupBox({ id: "limits", title: "Limits", open: true, nodes: [] });
    expect(g.tag).toBe("details");
    expect(g.attrs["data-group"]).toBe("limits");
    expect(g.textContent).toBe("Limits");
  });

  it("marks route entries, the parallel picker and sub-flow variables for problem links", () => {
    const fieldsOf = (nodes: FakeElement[]) => nodes.flatMap((n) => [n, ...n.querySelectorAll("[data-field]")]).map((e) => e.getAttribute("data-field"));
    const routed: any = { ...claude(), routes: [{ if: "a", goto: "end" }, { if: "b", goto: "end" }] };
    expect(fieldsOf(groups(routed)[0].nodes)).toEqual(expect.arrayContaining(["routes", "routes.1.if", "routes.1.goto"]));
    expect(fieldsOf(types.stepMain(mk({ id: "a", type: "parallel", steps: [] }), { id: "a", type: "parallel", steps: [] }, 0, ctx))).toContain("steps");
    const sub: any = { id: "a", type: "flow", flow: "f", vars: { k: "v" } };
    expect(fieldsOf(types.stepMain(mk(sub), sub, 0, ctx))).toEqual(expect.arrayContaining(["vars", "vars.k"]));
  });

  it("keeps stepBody and stepAdvanced as wrappers", () => {
    const step = claude();
    const flow = mk(step);
    expect(types.stepBody(flow, step, 0, ctx)).toHaveLength(types.stepMain(flow, step, 0, ctx).length + 4);
    expect(types.stepAdvanced(flow, step, ctx).attrs["data-group"]).toBe("routing");
    const odd: any = { id: "a", type: "weird" };
    expect(types.stepAdvanced(mk(odd), odd, ctx)).toBeNull();
  });
});
