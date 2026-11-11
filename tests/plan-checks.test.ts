import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseFlow } from "../src/flow/load.js";
import { addRunCheck, checkMarksOf, checksRevision, endCheckRound, nextRoundChecks, parsePlanChecks, publicChecks, recordPlanChecks, setRunCheckMark } from "../src/engine/plan-checks.js";
import { rewriteRunMark, type RunSummary, type StepRecord } from "../src/engine/state.js";

const C = (t: string, e: string) => `- CHECK: Try: ${t} — Expect: ${e}`;

describe("parsePlanChecks", () => {
  it("reads the lines in order", () => {
    const r = parsePlanChecks(`## Try it\n${C("a", "b")}\n${C("c", "d")}\n`);
    expect(r.checks).toEqual([{ id: "plan-1", try: "a", expect: "b", source: "plan" }, { id: "plan-2", try: "c", expect: "d", source: "plan" }]);
    expect(r.problems).toEqual([]);
  });
  it("accepts other forms", () => {
    const text = ["CHECK: Try: a – Expect: b", "- CHECK: Try: c - Expect: d", "- CHECK: Try: e -- Expect: f", "- check: try: g Expect: h"].join("\r\n");
    expect(parsePlanChecks(text).checks.map((c) => [c.try, c.expect])).toEqual([["a", "b"], ["c", "d"], ["e", "f"], ["g", "h"]]);
  });
  it("ignores indented, mid-text and fenced lines", () => {
    const text = [` ${C("a", "b")}`, `see ${C("c", "d")}`, "```", C("e", "f"), "```", "~~~", C("g", "h"), "~~~"].join("\n");
    expect(parsePlanChecks(text).checks).toEqual([]);
  });
  it("drops incomplete lines with a problem", () => {
    const r = parsePlanChecks("- CHECK: Try: a\n- CHECK: Try:  — Expect: b\n");
    expect(r.checks).toEqual([]);
    expect(r.problems).toEqual(["a CHECK line has no Try or no Expect part", "a CHECK line has no Try or no Expect part"]);
  });
  it("keeps 4 and cuts long parts; control characters become spaces", () => {
    const r = parsePlanChecks([1, 2, 3, 4, 5].map((n) => C("x".repeat(n === 1 ? 400 : 2), `a\u0007b${n}`)).join("\n"));
    expect(r.checks).toHaveLength(4);
    expect(r.checks[0]!.try).toBe("x".repeat(299) + "…");
    expect(r.checks[1]!.expect).toBe("a b2");
    expect(r.problems).toEqual(["more than 4 CHECK lines; the first 4 are kept"]);
  });
  it("reads NO_CHECKS", () => {
    expect(parsePlanChecks("NO_CHECKS: refactor only")).toEqual({ checks: [], none: "refactor only", problems: [] });
    expect(parsePlanChecks("- NO_CHECKS: x").none).toBe("x");
    expect(parsePlanChecks("NO_CHECKS:  ")).toEqual({ checks: [], problems: ["the NO_CHECKS line gives no reason"] });
    const both = parsePlanChecks(`${C("a", "b")}\nNO_CHECKS: why`);
    expect(both.checks).toHaveLength(1);
    expect(both.none).toBeUndefined();
    expect(both.problems).toHaveLength(1);
    expect(parsePlanChecks("nothing")).toEqual({ checks: [], problems: [] });
  });
  it("stops at the review notes of the gate", () => {
    const text = `${C("a", "b")}\n## Review notes to work in\n- check: Try: x — Expect: y\n- NO_CHECKS: z\n`;
    expect(parsePlanChecks(text)).toEqual({ checks: [{ id: "plan-1", try: "a", expect: "b", source: "plan" }], problems: [] });
  });
});

const rec = (id: string, output: string, over: Partial<StepRecord> = {}): StepRecord => ({ id, type: "shell", visit: 1, ok: true, output, startedAt: "", durationMs: 0, logFile: "", ...over });
const flow = (f: string) => parseFlow(readFileSync(`flows/${f}.yaml`, "utf8"));
const runOf = (f: string, history: StepRecord[], extra: Partial<RunSummary> = {}) => ({ history, flowDef: flow(f), ...extra }) as unknown as RunSummary;

describe("recordPlanChecks", () => {
  const log = () => { const l: string[] = []; return { l, f: (m: string) => l.push(m) }; };
  it("stores the checks of risk_gate and of post_plan", () => {
    for (const [f, id] of [["issue-gitflow", "risk_gate"], ["issue-plan", "post_plan"]] as const) {
      const run = runOf(f, [rec("plan", ""), rec(id, `## Try it\n${C("a", "b")}\n`)]);
      const g = log();
      recordPlanChecks(run, id, g.f);
      expect(run.checks).toEqual([{ id: "plan-1", try: "a", expect: "b", source: "plan" }]);
      expect(g.l).toEqual(["    · checks a person can try: 1 from the plan"]);
    }
  });
  it("post_plan prints only the CHECK lines of the plan (fence-aware, not its text) and not Codex's notes", () => {
    const steps = flow("issue-plan").steps!;
    const gate = steps.find((s) => s.id === "post_plan")!;
    const run = gate.type === "shell" ? gate.run : "";
    expect(run).toContain("awk");
    expect(run).toContain("(- )?(check|no_checks)");
    expect(run.indexOf("awk")).toBeGreaterThan(run.indexOf("posted=$("));
    expect(run.indexOf("awk")).toBeLessThan(run.lastIndexOf('printf \'%s\\n\' "$posted"'));
  });
  it("stores NO_CHECKS and clears on neither", () => {
    const run = runOf("issue-gitflow", [rec("risk_gate", "NO_CHECKS: refactor")]);
    const g = log();
    recordPlanChecks(run, "risk_gate", g.f);
    expect(run.checks).toEqual([]);
    expect(run.checksNone).toBe("refactor");
    expect(g.l).toEqual(["    · checks a person can try: none — refactor"]);
    run.history = [rec("risk_gate", "no lines")];
    recordPlanChecks(run, "risk_gate", g.f);
    expect(run.checks).toBeUndefined();
    expect(run.checksNone).toBeUndefined();
    expect(g.l.at(-1)).toBe("⚠ the plan lists no checks a person can try and does not say why");
  });
  it("a second gate replaces the first", () => {
    const run = runOf("issue-gitflow", [rec("risk_gate", C("a", "b"))], { checks: [{ id: "plan-9", try: "old", expect: "old", source: "plan" }] });
    run.history.push(rec("plan", ""), rec("risk_gate", C("c", "d")));
    recordPlanChecks(run, "risk_gate", () => {});
    expect(run.checks).toEqual([{ id: "plan-1", try: "c", expect: "d", source: "plan" }]);
  });
  it("changes nothing for other steps, a gate that is not final, or a flow without the check", () => {
    const old = [{ id: "plan-1", try: "o", expect: "o", source: "plan" as const }];
    const a = runOf("issue-gitflow", [rec("risk_gate", C("a", "b"))], { checks: old });
    recordPlanChecks(a, "plan", () => {});
    const b = runOf("issue-gitflow", [rec("risk_gate", C("a", "b")), rec("plan", "")], { checks: old });
    recordPlanChecks(b, "risk_gate", () => {});
    const c = runOf("issue-gitflow", [rec("risk_gate", C("a", "b"))], { checks: old });
    c.flowDef = { steps: [{ id: "risk_gate", type: "shell", run: "echo" }] } as never;
    recordPlanChecks(c, "risk_gate", () => {});
    for (const r of [a, b, c]) expect(r.checks).toBe(old);
  });
  it("does not throw for odd output", () => {
    for (const out of ["", "\u0000\u0001�".repeat(1000), undefined as unknown as string]) {
      expect(() => recordPlanChecks(runOf("issue-gitflow", [rec("risk_gate", out)]), "risk_gate", () => {})).not.toThrow();
    }
  });
  it("drops the marks of an older plan, with checks and with NO_CHECKS", () => {
    const marks = { "plan-1": { mark: "works" as const, at: "t", by: "u" } };
    for (const out of [C("a", "b"), "NO_CHECKS: x"]) {
      const run = runOf("issue-gitflow", [rec("risk_gate", out)], { checkMarks: marks });
      recordPlanChecks(run, "risk_gate", () => {});
      expect(run.checkMarks).toBeUndefined();
    }
  });
});

describe("rounds: what worked, and the person's own checks", () => {
  const P = (id: string, t: string, e: string, extra: Record<string, unknown> = {}) => ({ id, try: t, expect: e, source: "plan" as const, ...extra });
  const mine = (n: number, extra: Record<string, unknown> = {}) => ({ id: `person-${n}`, try: `my ${n}`, expect: `my e${n}`, source: "person" as const, by: "u", at: "t0", ...extra });
  const works = (at: string) => ({ mark: "works" as const, at });

  it("without a plan: a works mark becomes worked, not-quite drops it, an unmarked check keeps it", () => {
    const checks = [P("plan-1", "a", "b"), P("plan-2", "c", "d", { worked: "old" }), P("plan-3", "e", "f", { worked: "old" })];
    const out = nextRoundChecks(checks, { "plan-1": works("t1"), "plan-2": { mark: "not-quite", at: "t2" } });
    expect(out.map((c) => [c.id, c.try, c.worked])).toEqual([["plan-1", "a", "t1"], ["plan-2", "c", undefined], ["plan-3", "e", "old"]]);
    expect("worked" in out[1]!).toBe(false);
    expect(nextRoundChecks(undefined, undefined)).toEqual([]);
  });
  it("with a plan: the plan first, then what worked, then the person's checks", () => {
    const checks = [P("plan-1", "a", "b"), P("plan-2", "c", "d"), P("plan-3", "x", "y"), mine(2)];
    const plan = [P("plan-1", "a", "b"), P("plan-2", "new", "new")];
    const out = nextRoundChecks(checks, { "plan-1": works("t1"), "plan-2": works("t2"), "plan-3": works("t3") }, plan);
    expect(out.map((c) => [c.id, c.try, c.worked])).toEqual([["plan-1", "a", "t1"], ["plan-2", "new", undefined], ["kept-1", "c", "t2"], ["kept-2", "x", "t3"], ["person-2", "my 2", undefined]]);
    expect(out[4]).toMatchObject({ source: "person", by: "u" });
  });
  it("keeps every earlier success over three rounds, even more than four", () => {
    let checks = [1, 2, 3, 4].map((n) => P(`plan-${n}`, `t${n}`, `e${n}`));
    const marks = (cs: { id: string }[]) => Object.fromEntries(cs.map((c) => [c.id, works("tm")]));
    checks = nextRoundChecks(checks, marks(checks), [1, 2, 3, 4].map((n) => P(`plan-${n}`, `r2-${n}`, `e${n}`)));
    expect(checks).toHaveLength(8);
    checks = nextRoundChecks(checks, marks(checks), [1, 2, 3, 4].map((n) => P(`plan-${n}`, `r3-${n}`, `e${n}`)));
    expect(checks).toHaveLength(12);
    expect(checks.filter((c) => c.id.startsWith("kept-")).map((c) => c.id)).toEqual(Array.from({ length: 8 }, (_, i) => `kept-${i + 1}`));
    expect(new Set(checks.map((c) => `${c.try}|${c.expect}`)).size).toBe(12);
    // a check marked works again in the plan is not kept twice
    const again = nextRoundChecks(checks, {}, [P("plan-1", "t1", "e1")]);
    expect(again.filter((c) => c.try === "t1")).toHaveLength(1);
  });
  it("endCheckRound moves the marks into worked, never throws", () => {
    const run = { checks: [P("plan-1", "a", "b")], checkMarks: { "plan-1": works("t1") } } as unknown as RunSummary;
    endCheckRound(run);
    expect(run.checks![0]!.worked).toBe("t1");
    expect(run.checkMarks).toBeUndefined();
    const none = { checkMarks: {} } as unknown as RunSummary;
    endCheckRound(none);
    expect(none.checks).toBeUndefined();
    expect(() => endCheckRound({ checks: "x", checkMarks: null } as unknown as RunSummary)).not.toThrow();
  });
  it("recordPlanChecks keeps the person's checks over a plan, NO_CHECKS and neither", () => {
    for (const out of [C("a", "b"), "NO_CHECKS: x", "nothing"]) {
      const run = runOf("issue-gitflow", [rec("risk_gate", out)], { checks: [P("plan-1", "old", "old"), mine(1)], checksNone: "z", checkMarks: { "plan-1": works("t1") } } as Partial<RunSummary>);
      const g: string[] = [];
      recordPlanChecks(run, "risk_gate", (m) => g.push(m));
      expect(run.checks!.map((c) => c.id)).toEqual(out === C("a", "b") ? ["plan-1", "kept-1", "person-1"] : ["kept-1", "person-1"]);
      expect(run.checksNone).toBeUndefined();
      expect(run.checkMarks).toBeUndefined();
      expect(g.join("\n")).toContain(", 2 kept");
    }
    const run = runOf("issue-gitflow", [rec("risk_gate", C("a", "b"))], { checks: [mine(1)] } as Partial<RunSummary>);
    const g: string[] = [];
    recordPlanChecks(run, "risk_gate", (m) => g.push(m));
    expect(g).toEqual(["    · checks a person can try: 1 from the plan, 1 kept"]);
  });
  it("publicChecks leaves out by and at; no source reads as plan", () => {
    expect(publicChecks([mine(1, { worked: "w" }), { id: "x", try: "t", expect: "e" } as never])).toEqual([
      { id: "person-1", try: "my 1", expect: "my e1", source: "person", worked: "w" },
      { id: "x", try: "t", expect: "e", source: "plan" },
    ]);
    expect(publicChecks(undefined)).toEqual([]);
  });

  describe("addRunCheck", () => {
    const dirs: string[] = [];
    const make = (over: Record<string, unknown> = {}) => {
      const dir = mkdtempSync(join(tmpdir(), "add-"));
      dirs.push(dir);
      writeFileSync(join(dir, "run.json"), JSON.stringify({ runId: "r", status: "waiting", checksNone: "why", ...over }, null, 2));
      return dir;
    };
    const read = (dir: string) => JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
    const meta = { by: "u1", at: "2026-01-01T00:00:00.000Z" };
    afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

    it("adds person-1, then person-2, counting from the highest left; refuses a fifth", () => {
      const dir = make();
      expect(addRunCheck(dir, { try: "a", expect: "b" }, meta)).toEqual({ id: "person-1" });
      expect(read(dir).checks).toEqual([{ id: "person-1", try: "a", expect: "b", source: "person", ...meta }]);
      expect(read(dir).checksNone).toBeUndefined();
      expect(addRunCheck(dir, { try: "c", expect: "d" }, meta)).toEqual({ id: "person-2" });
      const dir2 = make({ checks: [mine(3)] });
      expect(addRunCheck(dir2, { try: "c", expect: "d" }, meta)).toEqual({ id: "person-4" });
      const full = make({ checks: [1, 2, 3, 4].map((n) => mine(n)) });
      expect(addRunCheck(full, { try: "c", expect: "d" }, meta)).toBe("full");
    });
    it("refuses a run that does not wait, a stale revision and a missing file", () => {
      expect(addRunCheck(make({ status: "running" }), { try: "a", expect: "b" }, meta)).toBe("refused");
      const dir = make({ checks: [P("plan-1", "a", "b")] });
      expect(addRunCheck(dir, { try: "c", expect: "d" }, meta, "stale")).toBe("refused");
      expect(addRunCheck(dir, { try: "c", expect: "d" }, meta, checksRevision([P("plan-1", "a", "b")]))).toEqual({ id: "person-1" });
      expect(addRunCheck(join(tmpdir(), "nowhere-at-all"), { try: "a", expect: "b" }, meta)).toBe("refused");
    });
  });
});

describe("check marks", () => {
  const checks = [1, 2].map((n) => ({ id: `plan-${n}`, try: `t${n}`, expect: `e${n}`, source: "plan" as const }));
  const meta = { by: "u1", at: "2026-01-01T00:00:00.000Z" };
  const dirs: string[] = [];
  const make = (over: Record<string, unknown> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "marks-"));
    dirs.push(dir);
    writeFileSync(join(dir, "run.json"), JSON.stringify({ runId: "r", status: "waiting", other: 1, checks, ...over }, null, 2));
    return dir;
  };
  const read = (dir: string) => JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
  afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

  it("sets, repeats, replaces and removes a mark", () => {
    const dir = make();
    expect(setRunCheckMark(dir, "plan-1", "works", meta)).toBe("done");
    expect(read(dir)).toMatchObject({ other: 1, status: "waiting", checks, checkMarks: { "plan-1": { mark: "works", at: meta.at, by: "u1" } } });
    const before = statSync(join(dir, "run.json")).ino;
    expect(setRunCheckMark(dir, "plan-1", "works", { by: "u2", at: "later" })).toBe("same");
    expect(statSync(join(dir, "run.json")).ino).toBe(before);
    expect(read(dir).checkMarks["plan-1"].by).toBe("u1");
    expect(setRunCheckMark(dir, "plan-1", "not-quite", meta)).toBe("done");
    expect(read(dir).checkMarks["plan-1"].mark).toBe("not-quite");
    expect(setRunCheckMark(dir, "plan-1", null, meta)).toBe("done");
    expect("checkMarks" in read(dir)).toBe(false);
    expect(setRunCheckMark(dir, "plan-1", null, meta)).toBe("same");
  });
  it("refuses what it must not change, and never throws", () => {
    expect(setRunCheckMark(make({ status: "running" }), "plan-1", "works", meta)).toBe("refused");
    expect(setRunCheckMark(make({ status: "succeeded" }), "plan-1", "works", meta)).toBe("refused");
    expect(setRunCheckMark(make(), "plan-9", "works", meta)).toBe("refused");
    expect(setRunCheckMark(make({ checks: undefined }), "plan-1", "works", meta)).toBe("refused");
    const bad = make();
    writeFileSync(join(bad, "run.json"), "{ nope");
    expect(setRunCheckMark(bad, "plan-1", "works", meta)).toBe("refused");
    expect(setRunCheckMark(join(bad, "missing"), "plan-1", "works", meta)).toBe("refused");
  });
  it("refuses a request made against another set of checks", () => {
    const dir = make();
    const rev = checksRevision(checks);
    expect(setRunCheckMark(dir, "plan-1", "works", meta, "stale")).toBe("refused");
    expect(setRunCheckMark(dir, "plan-1", "works", meta, rev)).toBe("done");
    expect(checksRevision([{ ...checks[0]!, try: "other" }, checks[1]!])).not.toBe(rev);
  });
  it("does not replace run.json when it changes while the mark is written", () => {
    const dir = make();
    let changed = false;
    const done = rewriteRunMark(dir, (s) => ({ ...s, checkMarks: { "plan-1": { mark: "works", at: "t" } } }), {
      beforeSwap: () => { changed = true; writeFileSync(join(dir, "run.json"), JSON.stringify({ ...read(dir), engine: true })); },
    });
    expect(changed).toBe(true);
    expect(done).toBe(false);
    expect(read(dir)).toMatchObject({ engine: true });
    expect("checkMarks" in read(dir)).toBe(false);
  });
  it("checkMarksOf keeps only valid marks of known checks, without who", () => {
    const m = { "plan-1": { mark: "works", at: "t", by: "u" }, "plan-2": { mark: "bad", at: "t" }, "plan-9": { mark: "works", at: "t" }, constructor: { mark: "works", at: "t" } };
    expect(checkMarksOf({ checks, checkMarks: m as never })).toEqual({ "plan-1": { mark: "works", at: "t" } });
    expect(checkMarksOf({ checks, checkMarks: { "plan-1": { mark: "works" } } as never })).toEqual({});
    expect(checkMarksOf({ checkMarks: m as never })).toEqual({});
    expect(checkMarksOf({ checks })).toEqual({});
  });
});

describe("the built flows ask for checks", () => {
  for (const f of ["issue-plan", "issue-gitflow"]) {
    it(f, () => {
      const steps = flow(f).steps!;
      const prompt = (id: string) => { const s = steps.find((x) => x.id === id)!; return s.type === "claude" ? s.prompt : ""; };
      for (const id of ["plan", "revise_plan"]) {
        for (const t of ["- CHECK: Try: <what to do> — Expect: <what they should see>", "NO_CHECKS: <one line why>", "2 to 4", "## Try it"]) expect(prompt(id), `${id}: ${t}`).toContain(t);
      }
      expect(prompt("plan_review")).toContain("CHECK lines");
    });
  }
});
