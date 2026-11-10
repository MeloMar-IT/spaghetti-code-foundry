import { readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { flowDir, loadFlow } from "../src/flow/load.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let ph: any;
let words: any;
beforeAll(async () => {
  ph = await import("../ui/phases.js" as string);
  words = await import("../ui/simple-words.js" as string);
});

const dir = flowDir("builtin", process.cwd());
const files = readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort();
const flows = files.map((f) => ({ name: f, flow: loadFlow(join(dir, f), process.cwd()).flow }));
const KEYS = ["understand", "plan", "build", "check", "deliver"];

describe("the shipped flows", () => {
  it("include the ten named flows", () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  it("have every step in the table", () => {
    for (const { name, flow } of flows) {
      for (const s of flow.steps) expect(ph.stepPhase(s.id).source, `${name}:${s.id} — add it to STEP_PHASES in ui/phases.js`).toBe("step");
    }
  });

  it("never go back a phase along the main path", () => {
    for (const { name, flow } of flows) {
      const main = flow.steps.filter((s) => !s.jump_only);
      for (let i = 1; i < main.length; i++) {
        const a = ph.stepPhase(main[i - 1]!.id);
        const b = ph.stepPhase(main[i]!.id);
        expect(b.index, `${name}: ${main[i - 1]!.id} (${a.key}) comes before ${main[i]!.id} (${b.key})`).toBeGreaterThanOrEqual(a.index);
      }
    }
  });

  it("reach all five phases in issue-gitflow", () => {
    const f = flows.find((x) => x.name === "issue-gitflow.yaml");
    expect(f).toBeTruthy();
    const keys = new Set(f!.flow.steps.filter((s) => !s.jump_only).map((s) => ph.stepPhase(s.id).key));
    expect([...keys].sort()).toEqual([...KEYS].sort());
  });
});

describe("stepPhase", () => {
  const key = (id: any, at?: any) => ph.stepPhase(id, at).key;

  it("knows the common steps", () => {
    expect([key("implement"), key("baseline_tests"), key("address_review_1"), key("docs"), key("fix_tests_2"), key("plan_check")])
      .toEqual(["build", "understand", "check", "deliver", "check", "understand"]);
  });

  it("reads the name of an unknown step", () => {
    expect(ph.stepPhase("my_unit_tests")).toMatchObject({ key: "check", source: "name" });
    expect(key("push_site")).toBe("deliver");
  });

  it("uses the position when the name says nothing", () => {
    expect(ph.stepPhase("zzz", { index: 0, total: 10 })).toMatchObject({ key: "understand", source: "position" });
    expect(ph.stepPhase("zzz", { index: 9, total: 10 })).toMatchObject({ key: "deliver", source: "position" });
  });

  it("ignores a bad position", () => {
    for (const at of [{ index: -1, total: 3 }, { index: 3, total: 3 }, { index: 1.5, total: 3 }, null, "x", 7]) {
      expect(ph.stepPhase("zzz", at)).toMatchObject({ key: "build", source: "default" });
    }
  });

  it("gives a defined phase for any input and never throws", () => {
    for (const id of ["", undefined, null, 42, {}]) expect(ph.stepPhase(id).key, String(id)).toBe("understand");
    expect(key("zzz")).toBe("build");
    for (const id of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      const p = ph.stepPhase(id, { index: 1, total: 2 });
      expect(KEYS, id).toContain(p.key);
      expect(p.source, id).not.toBe("step");
      expect(p.index).toBe(KEYS.indexOf(p.key));
    }
  });

  it("has five frozen phases in order", () => {
    expect(ph.PHASES.map((p: any) => p.key)).toEqual(KEYS);
    expect(ph.PHASES.every((p: any) => Object.isFrozen(p))).toBe(true);
    expect(Object.isFrozen(ph.PHASES)).toBe(true);
  });

  it("runPhase: the phase of a run's current step", () => {
    expect(ph.runPhase({ state: { next: "implement" } })).toMatchObject({ key: "build", word: "Build", source: "step" });
    expect(ph.runPhase({ history: [{ id: "plan" }, { id: "run_tests" }] })).toMatchObject({ key: "check", word: "Check" });
    expect(ph.runPhase({ state: { next: "plan" }, history: [{ id: "run_tests" }] }).key).toBe("plan"); // state.next wins
    const steps = ["a1", "a2", "a3", "a4", "a5"].map((id) => ({ id }));
    expect(ph.runPhase({ state: { next: "zz9" }, flowDef: { steps: [...steps, { id: "zz9" }] } })).toMatchObject({ source: "position", key: "deliver" });
    expect(ph.runPhase({ state: { next: "zz9" } }).source).toBe("default");
  });

  it("runPhase: no step, no run or a bad step gives null and never throws", () => {
    for (const r of [null, undefined, {}, { state: {} }, { history: [] }, { state: { next: 3 } }, { state: { next: "" } }, { history: [{}] }, { history: "x" }]) {
      expect(() => ph.runPhase(r)).not.toThrow();
      expect(ph.runPhase(r), JSON.stringify(r)).toBeNull();
    }
    expect(() => ph.runPhase({ state: { next: "__proto__" }, flowDef: { steps: "no" } })).not.toThrow();
    expect(ph.runPhase({ state: { next: "constructor" } }).word).toBeTruthy();
  });

  it("uses no forbidden term", () => {
    const all = [...ph.PHASES.flatMap((p: any) => [p.word, p.line, ph.phaseText(p)]), "Now", "Done"];
    for (const t of all) expect(words.forbiddenIn(t), t).toEqual([]);
  });
});
