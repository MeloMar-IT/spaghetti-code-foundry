import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writable } from "../src/agents/run.js";
import { autonomyStop, stepEnv, type Engine, type Scope } from "../src/engine/execute.js";
import { dockerCommand, hookMounts, protectedBranchEnv } from "../src/engine/guards.js";
import { sandboxProfile, stepSandboxPaths } from "../src/engine/os-sandbox.js";
import { drainPushLog } from "../src/engine/policy-hooks.js";
import { explainError } from "../src/errors.js";
import { classifyFailure } from "../src/failure.js";
import { AUTONOMY_LEVELS, type AutonomyLevel } from "../src/governance/autonomy.js";
import { autonomyRefusal, autonomyRefuses, pullRequestRefusal, type AutonomyAction } from "../src/governance/autonomy-rules.js";

const ACTIONS: AutonomyAction[] = ["repo-access", "agent-write", "push", "pull-request"];
const LOWEST: Record<AutonomyAction, AutonomyLevel> = { "repo-access": "plan-only", "agent-write": "guarded-write", push: "delivery-handoff", "pull-request": "delivery-handoff" };
const WHAT: Record<AutonomyAction, string> = { "repo-access": "a repo_access shell step", "agent-write": "a writing agent step", push: "a push", "pull-request": "a pull request" };

let tmp: string;
let saved: string | undefined;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "autonomy-enforce-"));
  saved = process.env.FACTORY_HOME;
  process.env.FACTORY_HOME = join(tmp, "home");
});
afterEach(() => {
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(tmp, { recursive: true, force: true });
});

describe("the rule table", () => {
  it("refuses exactly the actions below their lowest level (all 16 pairs)", () => {
    for (const level of AUTONOMY_LEVELS) {
      for (const action of ACTIONS) {
        expect(autonomyRefuses(level, action), `${level} ${action}`).toBe(AUTONOMY_LEVELS.indexOf(level) < AUTONOMY_LEVELS.indexOf(LOWEST[action]));
      }
    }
  });

  it("reads a string that is not a level as observe", () => {
    expect(autonomyRefuses("nonsense", "repo-access")).toBe(true);
    expect(autonomyRefuses("", "push")).toBe(true);
  });

  it("gives the exact sentence for each action", () => {
    for (const action of ACTIONS) {
      expect(autonomyRefusal("observe", action)).toBe(`autonomy observe does not allow ${WHAT[action]}; next step: promote the repository or flow`);
    }
  });

  it("imports only node: modules, so the tools can load it in a container", () => {
    const src = readFileSync(join(import.meta.dirname, "../src/governance/autonomy-rules.ts"), "utf8");
    const imports = [...src.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) expect(spec, spec).toMatch(/^node:/);
  });
});

describe("pullRequestRefusal", () => {
  it("allows when the flag is unset or empty", () => {
    expect(pullRequestRefusal({})).toBeUndefined();
    expect(pullRequestRefusal({ FACTORY_NO_PUSH: "" })).toBeUndefined();
  });

  it("refuses with the sentence and adds a fifth-field line to the log", () => {
    const log = join(tmp, "pushes.log");
    expect(pullRequestRefusal({ FACTORY_NO_PUSH: "guarded-write", FACTORY_PUSH_LOG: log })).toBe(autonomyRefusal("guarded-write", "pull-request"));
    expect(readFileSync(log, "utf8")).toBe("-\t\t\t\tpull-request\n");
  });

  it("reads junk as observe and does not throw on a log that cannot be written", () => {
    expect(pullRequestRefusal({ FACTORY_NO_PUSH: "junk", FACTORY_PUSH_LOG: join(tmp, "no", "such", "dir", "log") })).toBe(autonomyRefusal("observe", "pull-request"));
  });
});

describe("the pre-push hook with FACTORY_NO_PUSH", () => {
  const SHA = "a".repeat(40);
  const ZERO = "0".repeat(40);
  const URL = "https://github.com/acme/x.git";
  let pushLog: string;
  beforeEach(() => {
    pushLog = join(tmp, "push.log");
  });

  const run = (level: AutonomyLevel | undefined, input: string, extra: Record<string, string> = {}) => {
    const guard = protectedBranchEnv([], false, false, level);
    const hook = join(process.env.FACTORY_HOME!, "hooks", "pre-push");
    mkdirSync(join(tmp, "home", "hooks"), { recursive: true });
    if (!existsSync(hook)) protectedBranchEnv(["x"]); // writes the hook file
    const env: Record<string, string | undefined> = { ...process.env, ...guard, ...extra, FACTORY_PUSH_LOG: pushLog, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    if (!level) env.FACTORY_NO_PUSH = "";
    return spawnSync("sh", [hook, "origin", URL], { cwd: tmp, input, env: env as NodeJS.ProcessEnv, encoding: "utf8" });
  };
  const ref = (branch: string, local = SHA) => `refs/heads/${branch} ${local} refs/heads/${branch} ${ZERO}\n`;

  it("refuses, says why on stderr and logs a five-field line", () => {
    const r = run("guarded-write", ref("feature/x"));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`Spaghetti Code Foundry: ${autonomyRefusal("guarded-write", "push")}`);
    expect(readFileSync(pushLog, "utf8")).toBe(`feature/x\t${URL}\t\t1\tpush\n`);
  });

  it("refuses a delete too", () => {
    expect(run("observe", ref("feature/x", ZERO)).status).toBe(1);
  });

  it("is not passed by a hotfix grant token", () => {
    mkdirSync(join(tmp, "home", "hooks", "allow"), { recursive: true });
    const token = "ab".repeat(16);
    writeFileSync(join(tmp, "home", "hooks", "allow", token), "main");
    const r = run("plan-only", ref("main"), { FACTORY_PUSH_ALLOW: `main:${token}` });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("does not allow a push");
  });

  it("lets a push through with an empty flag, with the same four-field line as before", () => {
    const r = run(undefined, ref("feature/x"));
    expect(r.status).toBe(0);
    expect(readFileSync(pushLog, "utf8")).toBe(`feature/x\t${URL}\t\t1\n`);
  });

  it("exits 0 on empty stdin", () => {
    expect(run("observe", "").status).toBe(0);
  });
});

describe("protectedBranchEnv", () => {
  it("is empty with every guard off, and installs the hook and the flag for a level below delivery-handoff", () => {
    expect(protectedBranchEnv([], false, false)).toEqual({});
    const env = protectedBranchEnv([], false, false, "guarded-write");
    expect(env.GIT_CONFIG_KEY_0).toBe("core.hooksPath");
    expect(env.FACTORY_NO_PUSH).toBe("guarded-write");
    expect(existsSync(join(env.GIT_CONFIG_VALUE_0!, "pre-push"))).toBe(true);
  });
});

describe("drainPushLog", () => {
  it("reads the refused field and ignores an unknown one", () => {
    const f = join(tmp, "log");
    writeFileSync(f, "a\thttps://github.com/o/r\t\t1\tpush\n-\t\t\t\tpull-request\nb\t\t\t\tother\nc\t\t\t\n");
    const got = drainPushLog(f);
    expect(got.map((p) => [p.branch, p.refused])).toEqual([["a", "push"], ["-", "pull-request"], ["b", undefined], ["c", undefined]]);
  });
});

describe("autonomyStop", () => {
  const engine = (autonomy?: unknown) => {
    const denials: unknown[] = [];
    const lines: string[] = [];
    const e = {
      summary: { ...(autonomy === undefined ? {} : { autonomy }) },
      log: (m: string) => lines.push(m),
      evidence: { stepDenied: (_s: unknown, d: unknown) => denials.push(d) },
    } as unknown as Engine;
    return { e, denials, lines };
  };
  const id = { id: "s", visit: 1 } as never;

  it("allows everything for a run without the field", () => {
    const { e, denials } = engine();
    for (const a of ACTIONS) expect(autonomyStop(e, id, a)).toBeUndefined();
    expect(denials).toEqual([]);
  });

  it("reads an invalid field as observe", () => {
    const { e } = engine({ level: "wat" });
    expect(autonomyStop(e, id, "repo-access")?.error).toBe(autonomyRefusal("observe", "repo-access"));
  });

  it("fails the step, records the fixed denial and does not set accessFailed", () => {
    const { e, denials, lines } = engine({ level: "plan-only", flow: "plan-only" });
    const res = autonomyStop(e, id, "agent-write");
    expect(res).toEqual({ ok: false, output: autonomyRefusal("plan-only", "agent-write"), error: autonomyRefusal("plan-only", "agent-write") });
    expect(denials).toEqual([{ kind: "policy", policy: { id: "foundry.autonomy", version: "1" }, reasonCode: "autonomy.denied" }]);
    expect(lines).toEqual([`    ! ${autonomyRefusal("plan-only", "agent-write")}`]);
    expect(e.accessFailed).toBeUndefined();
  });

  it("allows an action the level permits", () => {
    const { e } = engine({ level: "plan-only", flow: "plan-only" });
    expect(autonomyStop(e, id, "repo-access")).toBeUndefined();
  });
});

describe("stepEnv", () => {
  it("never passes FACTORY_NO_PUSH from the server's environment", () => {
    process.env.FACTORY_NO_PUSH = "observe";
    try {
      const engine = { baseEnv: {}, summary: { history: [] }, config: { help: { sensitive_patterns: [] } } } as unknown as Engine;
      const scope = { flow: { steps: [] }, ctx: { vars: {}, steps: {}, run: {} }, visits: {}, prefix: "", depth: 0 } as unknown as Scope;
      expect(stepEnv(scope, engine).FACTORY_NO_PUSH).toBe("");
    } finally {
      delete process.env.FACTORY_NO_PUSH;
    }
  });
});

describe("how a refusal is explained", () => {
  const error = autonomyRefusal("observe", "push");
  it("tells a person and a user", () => {
    const person = explainError(`step "push" failed: ${error}`, "run");
    expect(person.what).toBe("The step push failed");
    expect(person.why).toBe("its autonomy level observe does not allow a push");
    expect(person.todo).toBe("Promote the repository or flow, then start a new run");
    expect(person.startOver).toBe(true);
    const user = explainError(error, "run", true);
    expect(user.limit).toBe(true);
    expect(user.why).toBe("the administrator's limit was reached");
  });

  it("is a limit, not a fault", () => {
    const history = [{ id: "push", type: "shell", ok: false, output: "", error, visit: 1 }] as never;
    expect(classifyFailure({ status: "failed", reason: `step "push" failed: ${error}`, history })).toMatchObject({ cause: "limit" });
  });
});

describe("containers", () => {
  it("mounts the hook folder read-only and the push-log folder writable, only for a run that may not push", () => {
    const hooks = join(tmp, "hooks");
    const logs = join(tmp, "pushes");
    mkdirSync(hooks);
    mkdirSync(logs);
    const env = { FACTORY_NO_PUSH: "observe", FACTORY_PUSH_LOG: join(logs, "s-1.log"), GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: hooks };
    expect(hookMounts(env)).toEqual([{ path: hooks, writable: false }, { path: logs, writable: true }]);
    expect(hookMounts({ ...env, FACTORY_NO_PUSH: "" })).toEqual([]);
    const { args } = dockerCommand("img", tmp, "true", [], hookMounts(env));
    expect(args).toContain(`${hooks}:${hooks}:ro`);
    expect(args).toContain(`${logs}:${logs}:rw`);
  });

  it("leaves out a mount that is not on the host", () => {
    const { args } = dockerCommand("img", tmp, "true", [], [{ path: join(tmp, "missing"), writable: true }]);
    expect(args.some((a) => a.includes("missing"))).toBe(false);
  });
});

describe("a read-only agent session can record a refusal", () => {
  it("lists the push-log folder as writable", () => {
    expect(writable({ FACTORY_PUSH_LOG: join(tmp, "pushes", "s-1.log") })).toEqual([join(tmp, "pushes")]);
    expect(writable({})).toBeUndefined();
  });

  it("lets the read-only profile write there and nowhere else new", () => {
    const runDir = join(tmp, "runs", "r1");
    const logs = join(runDir, "pushes");
    mkdirSync(logs, { recursive: true });
    const base = { runDir, learnings: join(runDir, "learn", "l.md"), workspaceReadOnly: true };
    const real = (p: string) => p;
    const without = sandboxProfile(stepSandboxPaths(base), real);
    const withLog = sandboxProfile(stepSandboxPaths({ ...base, pushLogDir: logs }), real);
    expect(without).not.toContain(`(allow file-write* (subpath "${logs}"))`);
    expect(withLog).toContain(`(allow file-write* (subpath "${logs}"))`);
    const added = withLog.split("\n").filter((l) => !without.split("\n").includes(l));
    expect(added).toEqual([`(allow file-write* (subpath "${logs}"))`]);
  });
});
