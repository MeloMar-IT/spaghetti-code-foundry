import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BASELINE_PACK, BASELINE_POLICY_ID, baselinePack } from "../src/policy/baseline.js";
import { combineDecisions, layeredPackIds, type Layer, type LayeredDecision } from "../src/policy/compose.js";
import { evaluatePolicy } from "../src/policy/evaluate.js";
import { parsePolicyPack } from "../src/policy/parse.js";
import { OUTCOMES, type Boundary, type Facts, type Outcome, type PolicyPack } from "../src/policy/schema.js";

const T = "2026-01-31T12:00:00.000Z";
const input = (boundary: Boundary, facts: Facts) => ({ version: 1, boundary, runId: "run-1", facts }) as never;
const ask = (pack: PolicyPack, boundary: Boundary, facts: Facts) => evaluatePolicy(pack, input(boundary, facts), T);
const mk = (id: string, rule: PolicyPack["rules"][number]): PolicyPack => ({ version: 1, policy: { id, version: "1" }, mode: "observe", defaultOutcome: "allow", rules: [rule] });
const layered = (layer: Layer, pack: PolicyPack, boundary: Boundary, facts: Facts): LayeredDecision => ({ layer, decision: ask(pack, boundary, facts) });
const fake = (layer: Layer, outcome: Outcome, id = "p"): LayeredDecision => ({ layer, decision: { policy: { id, version: "1" }, outcome } as never });

describe("combineDecisions", () => {
  it("gives nothing for nothing", () => {
    expect(combineDecisions([])).toBeUndefined();
  });

  it("lets the more restrictive outcome win, for every pair", () => {
    for (const a of OUTCOMES) {
      for (const b of OUTCOMES) {
        const winner = combineDecisions([fake("optional", a), fake("optional", b)])!;
        expect(winner.decision.outcome).toBe(OUTCOMES.indexOf(a) >= OUTCOMES.indexOf(b) ? a : b);
      }
    }
  });

  it("breaks a tie by layer, whatever the order, and then by position", () => {
    const m = fake("mandatory", "deny", "m");
    const r = fake("repository", "deny", "r");
    const o = fake("optional", "deny", "o");
    expect(combineDecisions([r, o, m])).toBe(m);
    expect(combineDecisions([o, r])).toBe(r);
    const first = fake("repository", "deny", "first");
    expect(combineDecisions([first, fake("repository", "deny", "second")])).toBe(first);
  });
});

describe("precedence", () => {
  const combined = (ds: LayeredDecision[]) => combineDecisions(ds)!;

  it("never lets a repository allow loosen the baseline", () => {
    const repo = mk("repo", { id: "ok", boundaries: ["agent.write"], when: { owner: { in: ["user"] } }, outcome: "allow", reasonCode: "exception.granted" });
    const facts: Facts = { owner: "user", sandboxed: false };
    const c = combined([layered("mandatory", BASELINE_PACK, "agent.write", facts), layered("repository", repo, "agent.write", facts)]);
    expect(c.layer).toBe("mandatory");
    expect(c.decision).toMatchObject({ outcome: "deny", reasonCode: "sandbox.required" });
  });

  it("lets a repository set a lower limit than an overlay", () => {
    const overlay = mk("overlay", { id: "cost", boundaries: ["run.complete"], when: { runCostUsd: { over: 5 } }, outcome: "deny", reasonCode: "budget.run-exceeded" });
    const repo = mk("repo", { id: "cost", boundaries: ["run.complete"], when: { runCostUsd: { over: 1 } }, outcome: "deny", reasonCode: "budget.run-exceeded" });
    const at = (runCostUsd: number) => combined([layered("mandatory", overlay, "run.complete", { runCostUsd }), layered("repository", repo, "run.complete", { runCostUsd })]);
    expect(at(2)).toMatchObject({ layer: "repository", decision: { outcome: "deny" } });
    expect(at(0.5).decision.outcome).toBe("allow");
  });

  it("lets an overlay tighten the baseline", () => {
    const overlay = mk("overlay", { id: "box", boundaries: ["agent.write"], when: { sandboxed: false }, outcome: "deny", reasonCode: "sandbox.required" });
    const facts: Facts = { owner: "admin", sandboxed: false };
    const c = combined([layered("mandatory", BASELINE_PACK, "agent.write", facts), layered("mandatory", overlay, "agent.write", facts)]);
    expect(c).toMatchObject({ layer: "mandatory", decision: { policy: { id: "overlay" }, outcome: "deny" } });
  });

  it("does not depend on the order of the packs of a layer", () => {
    const rule = (outcome: Outcome) => mk("x", { id: "r", boundaries: ["run.start"], when: {}, outcome, reasonCode: "exception.granted" });
    const repos = (["allow", "warn", "deny"] as const).map((o, i) => ({ ...rule(o), policy: { id: `r${i}`, version: "1" } }));
    const opts = (["warn", "deny"] as const).map((o, i) => ({ ...rule(o), policy: { id: `o${i}`, version: "1" } }));
    const perms = <T>(l: T[]): T[][] => (l.length <= 1 ? [l] : l.flatMap((x, i) => perms([...l.slice(0, i), ...l.slice(i + 1)]).map((p) => [x, ...p])));
    const seen = new Set<string>();
    for (const rp of perms(repos)) {
      for (const op of perms(opts)) {
        const ds = [...op.map((p) => layered("optional", p, "run.start", {})), ...rp.map((p) => layered("repository", p, "run.start", {}))];
        const c = combined(ds);
        seen.add(`${c.decision.outcome}/${c.layer}`);
      }
    }
    expect([...seen]).toEqual(["deny/repository"]);
  });
});

describe("layeredPackIds", () => {
  it("lists mandatory, then the run's repository, then optional", () => {
    const lists = { mandatory: ["m"], repositories: { "acme/a": ["r"], "acme/b": ["x"] }, packs: ["o"] };
    expect(layeredPackIds(lists, "acme/a")).toEqual([{ id: "m", layer: "mandatory" }, { id: "r", layer: "repository" }, { id: "o", layer: "optional" }]);
    expect(layeredPackIds(lists, "acme/b").map((i) => i.id)).toEqual(["m", "x", "o"]);
    expect(layeredPackIds(lists, "acme/c").map((i) => i.id)).toEqual(["m", "o"]);
    expect(layeredPackIds(lists, undefined).map((i) => i.layer)).toEqual(["mandatory", "optional"]);
    expect(layeredPackIds({}, "acme/a")).toEqual([]);
  });

  it("keeps an id only in the first layer that lists it", () => {
    expect(layeredPackIds({ mandatory: ["a"], repositories: { "acme/a": ["a", "b"] }, packs: ["b", "c"] }, "acme/a")).toEqual([
      { id: "a", layer: "mandatory" },
      { id: "b", layer: "repository" },
      { id: "c", layer: "optional" },
    ]);
  });

  it("ignores inherited keys as a repository", () => {
    expect(layeredPackIds({ repositories: {} }, "__proto__")).toEqual([]);
    expect(layeredPackIds({ repositories: {} }, "constructor")).toEqual([]);
  });
});

describe("the baseline", () => {
  it("is a valid observe pack of the version of this build", () => {
    expect(parsePolicyPack(BASELINE_PACK)).toEqual(BASELINE_PACK);
    expect(BASELINE_PACK.policy.id).toBe(BASELINE_POLICY_ID);
    expect(BASELINE_POLICY_ID).toBe("foundry.baseline");
    expect(BASELINE_PACK.mode).toBe("observe");
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    expect(BASELINE_PACK.policy.version).toBe(pkg.version);
    expect(baselinePack("x").policy.version).toBe("x");
  });

  it("fires each rule with its facts", () => {
    expect(ask(BASELINE_PACK, "push", { secretsFound: 2, commitIdentity: true })).toMatchObject({ outcome: "deny", reasonCode: "secret.detected", rule: "secret-detected" });
    expect(ask(BASELINE_PACK, "push", { secretsFound: 0, commitIdentity: false })).toMatchObject({ outcome: "deny", reasonCode: "identity.missing", rule: "identity-missing" });
    expect(ask(BASELINE_PACK, "agent.write", { owner: "user", sandboxed: false })).toMatchObject({ outcome: "deny", reasonCode: "sandbox.required" });
    expect(ask(BASELINE_PACK, "run.start", { owner: "user", workspace: "inplace" })).toMatchObject({ outcome: "deny", reasonCode: "workspace.admin-only" });
  });

  it("allows what is fine and says when a fact is missing", () => {
    expect(ask(BASELINE_PACK, "push", { secretsFound: 0, commitIdentity: true })).toMatchObject({ outcome: "allow", reasonCode: "policy.no-rule-matched" });
    expect(ask(BASELINE_PACK, "push", {})).toMatchObject({ reasonCode: "policy.input-incomplete", rule: "secret-detected" });
    expect(ask(BASELINE_PACK, "run.start", { owner: "admin", workspace: "inplace" }).outcome).toBe("allow");
  });
});
