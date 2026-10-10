import { describe, expect, it } from "vitest";
import { SKILL_BLOCKED_PREFIX, SKILL_INTEGRITY_PREFIX } from "../src/engine/skill-lock.js";
import { evaluateSkillRun, SKILL_REFUSED_RE, SkillExpectSchema, type SkillEvalRun, type SkillExpect } from "../src/skills/eval.js";

const DIGEST = "sha256:" + "a".repeat(64);
const lockOf = (...ids: string[]) => ({
  version: 1 as const, lockDigest: DIGEST, planHash: DIGEST, createdAt: "2026-10-01T00:00:00.000Z", estimatedTokens: 100,
  skills: ids.map((id) => ({ id, version: "1.0.0", digest: DIGEST, selection: "requested" as const })),
});
type Step = { id: string; agent?: string; ids?: string[]; tokens?: number; attached?: number; state?: "loaded" | "reloaded" | "reused"; role?: "reviewer"; omitted?: string[]; none?: boolean };
function run(ids: string[], steps: Step[], extra: Partial<SkillEvalRun> = {}): SkillEvalRun {
  return {
    status: "succeeded",
    skillLock: ids.length ? lockOf(...ids) : undefined,
    history: steps.map((s) => ({
      id: s.id, type: "claude", agent: s.agent, ok: true, output: "",
      ...(s.none ? {} : { skills: { loaded: (s.ids ?? ids).map((i) => `${i}@1.0.0`), omitted: s.omitted, bytes: 1, estimatedTokens: s.tokens ?? 50, role: s.role, state: s.state ?? "loaded", attachedEstimatedTokens: s.attached } }),
    })) as unknown as SkillEvalRun["history"],
    ...extra,
  };
}
const ev = (r: SkillEvalRun, e: Partial<SkillExpect>) => evaluateSkillRun(r, SkillExpectSchema.parse(e));

describe("SkillExpectSchema", () => {
  it.each([
    [{ selected: ["a"], absent: ["a"] }],
    [{ selected: ["a"], one_of: ["a", "b"] }],
    [{ selected: ["a"], extra: 1 }],
    [{ max_tokens: -1 }],
    [{ one_of: ["a"] }],
  ])("refuses %j", (e) => {
    expect(SkillExpectSchema.safeParse(e).success).toBe(false);
  });
});

describe("evaluateSkillRun", () => {
  it("positive: selected and loaded", () => {
    const r = ev(run(["kafka"], [{ id: "impl" }]), { selected: ["kafka"] });
    expect(r.ok).toBe(true);
    expect(r.activation.status).toBe("loaded");
    expect(r.selection.selected).toEqual(["kafka@1.0.0"]);
  });

  it("indirect: a dependency is selected and loaded", () => {
    expect(ev(run(["http", "json"], [{ id: "impl" }]), { selected: ["http", "json"] }).ok).toBe(true);
  });

  it("negative: nothing selected, status none; unrelated skills do not matter", () => {
    const r = ev(run([], []), { absent: ["kafka"] });
    expect(r.ok).toBe(true);
    expect(r.activation.status).toBe("none");
    expect(ev(run(["other"], [{ id: "impl" }]), { absent: ["kafka"] }).ok).toBe(true);
  });

  it("negative, wrong: a run that succeeded still fails on selection and activation", () => {
    const r = ev(run(["kafka"], [{ id: "impl" }]), { absent: ["kafka"] });
    expect(r.selection.ok).toBe(false);
    expect(r.selection.unexpected).toEqual(["kafka"]);
    expect(r.activation.ok).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("ambiguous: exactly one of the ids", () => {
    expect(ev(run(["kafka"], [{ id: "impl" }]), { one_of: ["kafka", "rabbit"] }).ok).toBe(true);
    const none = ev(run([], []), { one_of: ["kafka", "rabbit"] });
    expect(none.selection.ok).toBe(false);
    expect(none.selection.ambiguous).toEqual([]);
    const both = ev(run(["kafka", "rabbit"], [{ id: "impl" }]), { one_of: ["kafka", "rabbit"] });
    expect(both.selection.ambiguous).toEqual(["kafka", "rabbit"]);
  });

  it("conflict: selection from the plan, activation refused", () => {
    const r = ev(
      {
        status: "failed", reason: "skills not resolved: rabbit conflicts with kafka", history: [],
        skillPlan: { version: 1, role: "coder", action: "stop", selected: [{ id: "kafka", version: "1.0.0", digest: DIGEST }], unresolved: [{ id: "rabbit", code: "conflict" }], warnings: [], gate: "risk_gate", at: "x", checks: 1 } as never,
      },
      { selected: ["kafka"], absent: ["rabbit"] },
    );
    expect(r.selection.ok).toBe(true);
    expect(r.selection.unresolved).toEqual([{ id: "rabbit", code: "conflict" }]);
    expect(r.activation.status).toBe("refused");
    expect(r.ok).toBe(false);
  });

  it("tamper: selection stays ok, activation is refused with the reason", () => {
    const r = ev(run(["kafka"], [{ id: "impl", none: true }], { status: "failed", reason: `${SKILL_INTEGRITY_PREFIX}SKILL.md of kafka changed` }), { selected: ["kafka"] });
    expect(r.selection.ok).toBe(true);
    expect(r.activation.status).toBe("refused");
    expect(r.activation.reason).toContain("changed");
  });

  it("resume: a reused session adds nothing; a reloaded one counts again", () => {
    const reused = run(["kafka"], [{ id: "impl", tokens: 50 }, { id: "fix", tokens: 50, state: "reused", attached: 0 }]);
    expect(ev(reused, { selected: ["kafka"], max_attached_tokens: 50 }).ok).toBe(true);
    const reloaded = run(["kafka"], [{ id: "impl", tokens: 50 }, { id: "fix", tokens: 50, state: "reloaded" }]);
    const r = ev(reloaded, { selected: ["kafka"], max_attached_tokens: 50 });
    expect(r.context.ok).toBe(false);
    expect(r.context.attachedTokens).toBe(100);
    expect(r.selection.ok && r.activation.ok).toBe(true);
  });

  it("fallback and local targets are listed per session", () => {
    const codex = ev(run(["kafka"], [{ id: "impl", agent: "codex:openai:gpt-5", state: "reloaded" }]), { selected: ["kafka"] });
    expect(codex.ok).toBe(true);
    expect(codex.activation.sessions[0]).toMatchObject({ agent: "codex:openai:gpt-5", state: "reloaded" });
    expect(ev(run(["kafka"], [{ id: "impl", agent: "claude:ollama:qwen3-coder" }]), { selected: ["kafka"] }).ok).toBe(true);
  });

  it("fallback, lost: the only agent step has no skills record", () => {
    const r = ev(run(["kafka"], [{ id: "impl", agent: "codex:openai:gpt-5", none: true }]), { selected: ["kafka"] });
    expect(r.activation.status).toBe("not-loaded");
    expect(r.activation.notLoaded).toEqual(["kafka"]);
  });

  it("a later coder session that lost the skill fails activation", () => {
    const r = ev(run(["kafka"], [{ id: "impl" }, { id: "fix", ids: ["other"] }]), { selected: ["kafka"] });
    expect(r.activation.status).toBe("not-loaded");
  });

  it("a later agent step without a skills record (a Codex coder) fails activation; a reviewer step does not", () => {
    const mixed = run(["kafka"], [{ id: "impl" }, { id: "fix", agent: "codex:openai:gpt-5", none: true }]);
    const r = ev(mixed, { selected: ["kafka"] });
    expect(r.activation.status).toBe("not-loaded");
    expect(r.activation.sessions.map((s) => s.step)).toEqual(["impl", "fix"]);
    expect(ev(run(["kafka"], [{ id: "impl" }, { id: "review", none: true }]), { selected: ["kafka"] }).ok).toBe(true);
  });

  it("a step failure that wraps the skill refusal is still a refusal", () => {
    const r = ev(run(["kafka"], [{ id: "impl", none: true }], { status: "failed", reason: `step "impl" failed: ${SKILL_INTEGRITY_PREFIX}SKILL.md changed` }), { selected: ["kafka"] });
    expect(r.activation.status).toBe("refused");
  });

  it("budget: max_tokens is the largest block", () => {
    const base = run(["kafka"], [{ id: "impl", tokens: 50 }]);
    const small = ev(base, { selected: ["kafka"], max_tokens: 49 });
    expect(small.context.ok).toBe(false);
    expect(small.selection.ok && small.activation.ok).toBe(true);
    expect(ev(base, { selected: ["kafka"], max_tokens: 50 }).ok).toBe(true);
  });

  it("an old run without skill fields does not throw", () => {
    const old: SkillEvalRun = { status: "succeeded", history: [] };
    expect(ev(old, { selected: ["x"] }).selection.missing).toEqual(["x"]);
    expect(ev(old, {}).ok).toBe(true);
  });

  it("a reviewer record is no activation, but its tokens count as attached", () => {
    const r = ev(run(["kafka"], [{ id: "review", role: "reviewer", tokens: 30 }]), { selected: ["kafka"], max_attached_tokens: 100 });
    expect(r.activation.status).toBe("not-loaded");
    expect(r.context.attachedTokens).toBe(30);
  });

  it("an expected skill in omitted is reported", () => {
    const r = ev(run(["kafka"], [{ id: "impl", ids: [], omitted: ["kafka@1.0.0"] }]), { selected: ["kafka"] });
    expect(r.activation.omitted).toEqual(["kafka"]);
    expect(r.activation.ok).toBe(false);
  });

  it("SKILL_REFUSED_RE matches the engine's stop reasons", () => {
    for (const p of [SKILL_INTEGRITY_PREFIX, SKILL_BLOCKED_PREFIX, "skills not resolved: "]) expect(SKILL_REFUSED_RE.test(p + "x")).toBe(true);
    expect(SKILL_REFUSED_RE.test("step failed")).toBe(false);
  });
});
