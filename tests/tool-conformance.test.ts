import { describe, expect, it } from "vitest";
import { codexSandbox as stepCodexSandbox, countText, gateTarget, profileUnusable, resolveStepProfile, stepToolSettings, type StepProfile } from "../src/agents/tool-gate.js";
import { isAuthError, isLimitError, isQuotaError, isTransientError } from "../src/agents/targets.js";
import { ConfigSchema } from "../src/config.js";
import type { Scope } from "../src/engine/execute.js";
import { PERMISSION_MODES, type ClaudeStep } from "../src/flow/schema.js";
import { ADAPTER_CAPABILITIES, RESTRICTIONS } from "../src/tool-profile/adapters.js";
import { legacyToolProfile, type LegacyToolSettings } from "../src/tool-profile/legacy.js";
import { assembleToolProfile, EXCESS_FIELDS, type OperationGrant } from "../src/tool-profile/resolve.js";
import { OPERATIONS, SANDBOX_FILESYSTEM, TOOL_KINDS, type ToolKind, type ToolProfile } from "../src/tool-profile/schema.js";
import {
  adapterFit, codexShellFilesystem, declaredToolProfile, FIT_OUTCOMES, FIT_RESTRICTIONS, HELD_BY, mapSessionSettings, mappedExcess, PROFILE_SOURCES, settingsExcess,
  snapshotToolProfile, toolSession, UNREADABLE, type AdapterFit, type AgentFacts, type CodexSandboxMode, type SessionMapping, type ToolSession,
} from "../src/tool-profile/session.js";
import { ToolProfileSchemaError } from "../src/tool-profile/version.js";

type Agent = "claude" | "codex";
const AGENTS: Agent[] = ["claude", "codex"];

const settings = (over: Partial<LegacyToolSettings> = {}): LegacyToolSettings => ({ permissionMode: "acceptEdits", allowedTools: [], sandbox: false, boxed: false, noTools: false, mcpServers: false, credential: "none", ...over });
const grant = (kind: ToolKind, operation: string, targets: string[] = ["*"], more: Partial<OperationGrant> = {}): OperationGrant => ({
  kind, operation, targets, dataClassification: "restricted", credential: "none", timeoutMs: null, maxConcurrent: null, outputCapBytes: null, approval: "none",
  ...(kind === "shell" ? { sandbox: { filesystem: "unrestricted", network: "unrestricted" } } : {}), ...more,
});
const profile = (entries: OperationGrant[], id = "declared") => assembleToolProfile({ id, version: "1" }, entries);
const allOps = (kind: ToolKind, more: Partial<OperationGrant> = {}) => OPERATIONS[kind].map((op) => grant(kind, op, ["*"], more));
const reviewer = (data: OperationGrant["dataClassification"] = "restricted") => profile([grant("files", "read", ["*"], { dataClassification: data }), grant("builtin", "call", ["*"], { dataClassification: data })]);

/** What the step runs with today, from the settings (the same rules as codexSandbox in tool-gate.ts). */
const todayOf = (s: LegacyToolSettings): SessionMapping => ({
  claudeSandbox: s.sandbox,
  codexSandbox: s.permissionMode === "plan" || (s.permissionMode === "dontAsk" && !s.allowedTools.some((t) => /^(Edit|Write|MultiEdit|NotebookEdit)/.test(t))) ? "read-only" : s.permissionMode === "bypassPermissions" && !s.sandbox ? "danger-full-access" : "workspace-write",
});

function factsFor(agent: Agent, s: ToolSession, today: SessionMapping, over: Partial<AgentFacts> = {}): AgentFacts {
  const mapping = mapSessionSettings(s, today);
  return agent === "claude"
    ? { agent, personalSetup: false, mapping, ...over }
    : { agent, personalSetup: false, mapping, codex: { sandbox: mapping.codexSandbox, shellFilesystem: codexShellFilesystem(mapping.codexSandbox, s.settings.boxed), noNetwork: false }, ...over };
}
const fit = (agent: Agent, s: ToolSession, today = todayOf(s.settings), over: Partial<AgentFacts> = {}): AdapterFit => adapterFit(s, factsFor(agent, s, today, over));
const text = (gaps: { kind: string; restriction: string }[]) => gaps.map((g) => `${g.kind} ${g.restriction}`);

const GENERATED: { name: string; settings: LegacyToolSettings; claude: { outcome: string; gaps: string[] }; codex: { outcome: string; gaps: string[] }; unmapped?: number }[] = (() => {
  const codexAll = ["files limit-targets", "shell deny-kind", "git deny-kind", "github deny-kind", "web deny-kind"];
  const viaShell = ["git deny-kind", "github deny-kind"];
  return [
    { name: "acceptEdits", settings: settings(), claude: { outcome: "enforced", gaps: [] }, codex: { outcome: "partial", gaps: codexAll } },
    { name: "plan", settings: settings({ permissionMode: "plan" }), claude: { outcome: "enforced", gaps: [] }, codex: { outcome: "partial", gaps: codexAll } },
    {
      name: "dontAsk + Bash(npm test:*)",
      settings: settings({ permissionMode: "dontAsk", allowedTools: ["Bash(npm test:*)"] }),
      claude: { outcome: "partial", gaps: viaShell },
      codex: { outcome: "partial", gaps: ["files limit-targets", "shell limit-targets", "git deny-kind", "github deny-kind", "web deny-kind"] },
    },
    { name: "bypassPermissions", settings: settings({ permissionMode: "bypassPermissions" }), claude: { outcome: "partial", gaps: viaShell }, codex: { outcome: "partial", gaps: viaShell } },
  ];
})();

describe("generated profiles are only recorded", () => {
  for (const c of GENERATED) {
    it(`${c.name}: the same profile for both agents, never refused`, () => {
      const s = toolSession(c.settings);
      const today = todayOf(c.settings);
      const got = { claude: fit("claude", s, today), codex: fit("codex", s, today) };
      for (const a of AGENTS) {
        expect({ outcome: got[a].outcome, gaps: text(got[a].unsupported) }, a).toEqual(c[a]);
        expect(got[a].held).toEqual([]);
      }
      expect(s.source).toBe("generated");
      expect(toolSession(c.settings).ref).toEqual(s.ref);
    });
  }

  it("a rule that has no meaning in a profile is counted, and not refused", () => {
    const s = toolSession(settings({ permissionMode: "dontAsk", allowedTools: ["Edit(src/*.ts)"] }));
    for (const a of AGENTS) {
      const f = fit(a, s);
      expect(f.unmappedRules, a).toBe(1);
      expect(f.outcome, a).not.toBe("refused");
    }
  });

  it("is never refused, and the mapping is today's, for every combination of settings", () => {
    for (const permissionMode of PERMISSION_MODES) {
      for (const [sandbox, boxed] of [[false, false], [true, false], [false, true]] as const) {
        const st = settings({ permissionMode, sandbox, boxed });
        const s = toolSession(st);
        const today = todayOf(st);
        expect(mapSessionSettings(s, today), `${permissionMode} ${sandbox} ${boxed}`).toEqual(today);
        for (const a of AGENTS) expect(fit(a, s, today, { personalSetup: true }).outcome).not.toBe("refused");
        // the sandbox Codex really runs at never asks for more than the generated shell grant says
        expect(text(fit("codex", s, today).unsupported)).not.toContain("shell sandbox-filesystem");
      }
    }
  });
});

describe("declared profiles", () => {
  const plan = settings({ permissionMode: "plan" });

  it("a reviewer profile is held by Claude and refused on Codex", () => {
    const s = toolSession(plan, reviewer());
    expect(s.excess).toEqual([]);
    expect(adapterFit(s).outcome).toBe("enforced");
    expect(fit("claude", s)).toMatchObject({ outcome: "enforced", unsupported: [], held: [], excess: [], unmappedRules: 0, personalSetup: false });
    const codex = fit("codex", s);
    expect(codex.outcome).toBe("refused");
    expect(text(codex.unsupported)).toEqual(["files limit-targets", "shell deny-kind", "git deny-kind", "github deny-kind", "web deny-kind"]);
    for (const a of AGENTS) expect(fit(a, s, undefined, { personalSetup: true }).outcome, a).toBe("refused");
    expect(s.ref.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is refused before routing when the settings allow more", () => {
    const s = toolSession(plan, profile([grant("files", "read", ["src/*"]), grant("builtin", "call")]));
    expect(s.excess).toEqual([{ kind: "files", operation: "read", field: "targets" }]);
    expect(adapterFit(s).outcome).toBe("refused");
    for (const a of AGENTS) expect(fit(a, s).outcome, a).toBe("refused");

    const credential = toolSession(settings({ permissionMode: "dontAsk", allowedTools: ["Bash"], credential: "machine" }), profile([grant("files", "read"), grant("builtin", "call"), grant("shell", "run", ["*"], { credential: "none" })]));
    expect(credential.excess.map((e) => e.field)).toContain("credential");
    expect(adapterFit(credential).outcome).toBe("refused");
  });

  it("is refused when an allowed tool rule has no meaning in a profile", () => {
    const s = toolSession(settings({ permissionMode: "dontAsk", allowedTools: ["Edit(src/*.ts)"] }), reviewer());
    expect(s.excess).toEqual([]);
    expect(s.unmappedRules).toBe(1);
    expect(adapterFit(s).outcome).toBe("refused");
    for (const a of AGENTS) expect(fit(a, s).outcome, a).toBe("refused");
  });

  it("is refused before routing for a data class below restricted", () => {
    const s = toolSession(plan, reviewer("public"));
    expect(text(s.dataClassGaps)).toEqual(["files data-class", "builtin data-class"]);
    const before = adapterFit(s);
    expect(before.outcome).toBe("refused");
    expect(text(before.unsupported)).toEqual(["files data-class", "builtin data-class"]);
    expect(fit("claude", toolSession(plan, reviewer())).outcome).not.toBe("refused");
  });

  it("holds a command off the network with the Codex sandbox, and only there", () => {
    const d = profile([grant("files", "read"), grant("builtin", "call"), grant("shell", "run", ["*"], { sandbox: { filesystem: "workspace-write", network: "none" } })]);
    const st = settings({ permissionMode: "dontAsk", sandbox: true });
    const s = toolSession(st, d);
    expect(s.excess).toEqual([]);
    const today = todayOf(st);
    const codex = fit("codex", s, today, { codex: { sandbox: "workspace-write", shellFilesystem: "workspace-write", noNetwork: true } });
    expect(codex.held).toEqual([{ kind: "shell", restriction: "sandbox-network", by: "codex-sandbox" }]);
    expect(text(codex.unsupported)).not.toContain("shell sandbox-network");
    expect(text(fit("claude", s, today).unsupported)).toContain("shell sandbox-network");
    expect(text(fit("codex", s, today, { codex: { sandbox: "read-only", shellFilesystem: "read-only", noNetwork: true } }).unsupported)).toContain("shell sandbox-network");
  });
});

describe("the sandboxes only get narrower", () => {
  const everything = profile([
    grant("files", "read"),
    grant("files", "write"),
    grant("shell", "run", ["*"], { sandbox: { filesystem: "read-only", network: "unrestricted" } }),
    ...allOps("git"),
    ...allOps("github"),
    grant("web", "fetch"),
    grant("web", "search"),
    grant("builtin", "call"),
  ]);
  const accept = settings();

  it("Codex runs at the level of the strictest shell grant, and the gate checks the level it really runs at", () => {
    const s = toolSession(accept, everything);
    expect(settingsExcess(s.generated, everything)).toEqual([]);
    const today = todayOf(accept);
    expect(today.codexSandbox).toBe("workspace-write");
    expect(mapSessionSettings(s, today).codexSandbox).toBe("read-only");
    expect(text(fit("codex", s, today).unsupported)).not.toContain("shell sandbox-filesystem");
    // a Codex that really runs at today's level cannot keep a command to read-only
    const wide = adapterFit(s, { agent: "codex", personalSetup: false, codex: { sandbox: "workspace-write", shellFilesystem: "workspace-write", noNetwork: false } });
    expect(text(wide.unsupported)).toContain("shell sandbox-filesystem");
    expect(wide.outcome).toBe("refused");
    const claude = fit("claude", s, today);
    expect(text(claude.unsupported)).toContain("shell sandbox-filesystem");
    expect(claude.outcome).toBe("refused");
  });

  it("narrows danger-full-access to workspace-write for a workspace-write shell grant", () => {
    const d = profile([grant("files", "read"), grant("files", "write"), grant("shell", "run", ["*"], { sandbox: { filesystem: "workspace-write", network: "unrestricted" } })]);
    const s = toolSession(settings({ permissionMode: "bypassPermissions" }), d);
    expect(mapSessionSettings(s, { claudeSandbox: false, codexSandbox: "danger-full-access" })).toEqual({ claudeSandbox: false, codexSandbox: "workspace-write" });
  });

  it("reads the level of a boxed step from the OS profile", () => {
    expect(codexShellFilesystem("read-only", true)).toBe("read-only");
    expect(codexShellFilesystem("workspace-write", true)).toBe("workspace-write");
    expect(codexShellFilesystem("danger-full-access", true)).toBe("workspace-write");
    expect(codexShellFilesystem("danger-full-access", false)).toBe("unrestricted");
    expect(codexShellFilesystem("workspace-write", false)).toBe("workspace-write");
  });

  const npmTest = profile([
    grant("files", "read"),
    grant("builtin", "call"),
    grant("shell", "run", ["npm test", "npm test *"]),
    ...allOps("git"),
    ...allOps("github"),
  ]);

  it("never turns on the sandbox of Claude, which would let it run any command", () => {
    const st = settings({ permissionMode: "dontAsk" });
    const s = toolSession(st, npmTest);
    const today = todayOf(st);
    const m = mapSessionSettings(s, today);
    expect(m.claudeSandbox).toBe(false);
    expect(mappedExcess(s, m)).toEqual([]);
    expect(legacyToolProfile({ ...st, sandbox: m.claudeSandbox }).profile.grants.some((g) => g.kind === "shell")).toBe(false);

    const on = toolSession({ ...st, sandbox: true }, npmTest);
    expect(on.excess).toEqual([{ kind: "shell", operation: "run", field: "targets" }]);
    expect(adapterFit(on).outcome).toBe("refused");
  });

  it("is refused, not quietly sandboxed, for a workspace-write shell against bypassPermissions", () => {
    const d = profile([grant("files", "read", ["/*"]), grant("files", "write", ["/*"]), grant("builtin", "call"), grant("shell", "run", ["*"], { sandbox: { filesystem: "workspace-write", network: "unrestricted" } })]);
    const s = toolSession(settings({ permissionMode: "bypassPermissions" }), d);
    expect(s.excess).toContainEqual({ kind: "shell", operation: "run", field: "sandbox.filesystem" });
    expect(adapterFit(s).outcome).toBe("refused");
  });

  const CASES: { name: string; settings: LegacyToolSettings; declared: ToolProfile }[] = [
    { name: "reviewer", settings: settings({ permissionMode: "plan" }), declared: reviewer() },
    { name: "everything", settings: accept, declared: everything },
    { name: "npm test", settings: settings({ permissionMode: "dontAsk" }), declared: npmTest },
    { name: "npm test with sandbox", settings: settings({ permissionMode: "dontAsk", sandbox: true }), declared: npmTest },
    { name: "bypass", settings: settings({ permissionMode: "bypassPermissions" }), declared: everything },
    { name: "boxed", settings: settings({ boxed: true }), declared: everything },
  ];
  const rank = (m: CodexSandboxMode) => ["read-only", "workspace-write", "danger-full-access"].indexOf(m);

  it("keeps the mapping and the checks consistent over all declared cases", () => {
    let held = 0;
    for (const c of CASES) {
      const s = toolSession(c.settings, c.declared);
      const today = todayOf(c.settings);
      const m = mapSessionSettings(s, today);
      expect(m.claudeSandbox, c.name).toBe(today.claudeSandbox);
      expect(rank(m.codexSandbox), c.name).toBeLessThanOrEqual(rank(today.codexSandbox));
      if (!c.declared.grants.some((g) => g.kind === "files" && (g.operations as readonly string[]).includes("write"))) expect(m.codexSandbox, c.name).toBe("read-only");
      for (const a of AGENTS) {
        const f = fit(a, s, today);
        if (f.outcome === "refused") continue;
        held++;
        expect(settingsExcess(legacyToolProfile({ ...c.settings, sandbox: c.settings.boxed ? false : m.claudeSandbox }).profile, c.declared), c.name).toEqual([]);
        expect([f.excess, f.unsupported, f.dataClassGaps].map((l) => l.length), c.name).toEqual([0, 0, 0]);
        expect([f.unmappedRules, f.personalSetup], c.name).toEqual([0, false]);
        if (a === "codex") {
          const level = codexShellFilesystem(m.codexSandbox, c.settings.boxed);
          for (const g of c.declared.grants) if (g.kind === "shell") expect(SANDBOX_FILESYSTEM.indexOf(g.sandbox.filesystem)).toBeGreaterThanOrEqual(SANDBOX_FILESYSTEM.indexOf(level));
        }
      }
    }
    expect(held).toBeGreaterThan(0);
  });
});

describe("reading a declared profile", () => {
  const valid = reviewer();

  it("refuses the id of generated profiles, another version and an unknown field", () => {
    const code = (raw: unknown) => {
      try {
        declaredToolProfile(raw);
      } catch (e) {
        expect(e).toBeInstanceOf(ToolProfileSchemaError);
        return (e as ToolProfileSchemaError).code;
      }
      return "none";
    };
    expect(code(profile([grant("builtin", "call")], "generated.flow-settings"))).toBe("invalid");
    expect(code({ ...valid, version: 2 })).toBe("unsupported-version");
    expect(code({ ...valid, extra: 1 })).toBe("invalid");
    expect(code(valid)).toBe("none");
  });

  it("copies a valid profile as plain JSON, and gives null for anything else", () => {
    expect(snapshotToolProfile(valid)).toEqual(valid);
    expect(JSON.parse(JSON.stringify(snapshotToolProfile(valid)))).toEqual(valid);
    const getter = Object.defineProperty({}, "version", { enumerable: true, get: () => { throw new Error("boom"); } });
    for (const raw of [() => 1, Symbol("x"), { ...valid, extra: () => 1 }, getter, { ...valid, grants: undefined }, null, undefined, "text"]) expect(snapshotToolProfile(raw)).toBeNull();
    expect(() => declaredToolProfile(snapshotToolProfile(() => 1))).toThrow(/not a JSON object/);
  });
});

describe("what a refusal says", () => {
  const config = ConfigSchema.parse({ protected_branches: [] });
  const flow = { defaults: {}, sandbox: {} } as unknown as Scope["flow"];
  const scope = { flow } as Pick<Scope, "flow">;
  const stepOf = (extra: Partial<ClaudeStep> = {}) => ({ id: "a", type: "claude", prompt: "x", ...extra }) as ClaudeStep;
  const o = { boxed: false, isolated: true };
  const resolve = (toolProfile: unknown, step = stepOf({ permission_mode: "plan" })) => resolveStepProfile(step, scope, { config, toolProfile }, o);
  const refusal = (r: ReturnType<typeof resolve>) => {
    expect("refused" in r).toBe(true);
    return (r as { refused: string }).refused;
  };
  const quiet = (t: string) => {
    expect(isLimitError(t, "")).toBe(false);
    expect(isTransientError(t, "")).toBe(false);
    expect(isAuthError(t, "")).toBe(false);
    expect(isQuotaError(t, "")).toBe(false);
    expect(/daily budget|usage limit reached|signed out —|stopped at step/.test(t)).toBe(false);
  };

  it("never repeats a key, an id, a version or the text of an exception", () => {
    const keyed = refusal(resolve({ ...reviewer(), "usage limit reached": 1 }));
    expect(keyed).toBe("tools: the declared tool profile cannot be used (invalid, 1 fields)");
    const named = { ...assembleToolProfile({ id: "quota", version: "1" }, [grant("files", "read", ["src/*"]), grant("builtin", "call")]), version: 1 };
    const withVersion = { ...named, profile: { id: "quota", version: "429" } };
    const excess = refusal(resolve(withVersion));
    expect(excess).not.toMatch(/quota|429/);
    const boom = refusal(resolve(Object.defineProperty({}, "version", { enumerable: true, get: () => { throw new Error("overloaded"); } })));
    expect(boom).toBe("tools: the declared tool profile could not be checked");
    for (const t of [keyed, excess, boom]) quiet(t);
  });

  it("says how many rules have no meaning, and caps counts", () => {
    const one = refusal(resolve(reviewer(), stepOf({ permission_mode: "dontAsk", allowed_tools: ["Edit(src/*.ts)"] })));
    expect(one).toContain("1 tool rules have no meaning in a profile");
    expect(one).not.toContain("src/");
    const many = refusal(resolve(reviewer(), stepOf({ permission_mode: "dontAsk", allowed_tools: Array.from({ length: 429 }, (_, i) => `Edit(src/${i}/*.ts)`) })));
    expect(many).toContain("many tool rules");
    expect(many).not.toMatch(/429/);
    expect(countText(99)).toBe("99");
    expect(countText(100)).toBe("many");
    quiet(one);
    quiet(many);
  });

  it("refuses null, which a profile that could not be saved leaves behind", () => {
    expect(refusal(resolve(null))).toBe("tools: the declared tool profile cannot be used (not-an-object, 0 fields)");
    expect(profileUnusable(new Error("usage limit reached")).refused).toBe("tools: the declared tool profile could not be checked");
    expect(profileUnusable(new Error("x")).event).toMatchObject({ source: "declared", unreadable: "error", outcome: "refused" });
  });

  it("does not block a flow whose rules are more than a profile can hold, but refuses a declared profile for it", () => {
    const many = stepOf({ permission_mode: "dontAsk", allowed_tools: Array.from({ length: 101 }, (_, i) => `Bash(cmd${i})`) });
    const generated = resolve(undefined, many);
    expect("refused" in generated).toBe(false);
    expect((generated as StepProfile).session.source).toBe("generated");
    expect(refusal(resolve(reviewer(), many))).toMatch(/^tools: the declared tool profile (cannot be used|could not be checked)/);
  });

  it("resolves a generated profile once, with today's sandboxes", () => {
    const r = resolve(undefined) as StepProfile;
    expect(r.session.source).toBe("generated");
    expect(r.mapping).toEqual(r.today);
    expect(r.today).toEqual({ claudeSandbox: false, codexSandbox: stepCodexSandbox(stepOf({ permission_mode: "plan" }), scope, false) });
    expect(stepToolSettings(stepOf(), scope, { config }, { boxed: true, isolated: false })).toMatchObject({ boxed: true, sandbox: false, credential: "machine", permissionMode: "acceptEdits" });
  });

  it("uses only fixed words in the lines and the refusals of a target", () => {
    const texts: string[] = [];
    const engine = { config, summary: { source: "cli" } } as unknown as Parameters<typeof gateTarget>[2]["engine"];
    const gate = (toolProfile: unknown, agent: Agent, step = stepOf({ permission_mode: "plan" })) => {
      const r = resolveStepProfile(step, scope, { config, toolProfile }, o);
      if ("refused" in r) {
        texts.push(r.refused);
        return undefined;
      }
      const g = gateTarget({ agent }, r, { step, engine, boxed: false, isolated: true, draft: false });
      texts.push(g.line);
      return g;
    };
    expect(gate(undefined, "codex")?.line).toMatch(/^tools: generated profile [0-9a-f]{12} on Codex: partial — Codex cannot hold files limit-targets, shell deny-kind, git deny-kind, github deny-kind, web deny-kind \(recorded only\)$/);
    expect(gate(undefined, "claude")?.line).toMatch(/^tools: generated profile [0-9a-f]{12} on Claude Code: enforced$/);
    expect(gate(reviewer(), "claude")?.refused).toBeUndefined();
    const codex = gate(reviewer(), "codex");
    expect(codex?.refused).toMatch(/^tools: the declared tool profile [0-9a-f]{12} cannot be held on Codex: Codex cannot hold files limit-targets/);
    expect(codex?.event).toMatchObject({ agent: "codex", outcome: "refused", source: "declared" });
    gate(reviewer("public"), "claude");
    gate({ ...reviewer(), x: 1 }, "claude");
    const personal = { ...engine, config: ConfigSchema.parse({ protected_branches: [], isolate_agents: false }) };
    const r = resolveStepProfile(stepOf({ permission_mode: "plan" }), scope, { config, toolProfile: reviewer() }, { boxed: false, isolated: false }) as StepProfile;
    const loud = gateTarget({ agent: "claude" }, r, { step: stepOf({ permission_mode: "plan" }), engine: personal as typeof engine, boxed: false, isolated: false, draft: false });
    expect(loud.refused).toContain("the session would load the personal setup");
    texts.push(loud.line);
    for (const t of texts) quiet(t);
    // every word the formats can hold is quiet too
    for (const w of [...FIT_OUTCOMES, ...PROFILE_SOURCES, ...FIT_RESTRICTIONS, ...RESTRICTIONS, ...TOOL_KINDS, ...EXCESS_FIELDS, ...UNREADABLE, ...HELD_BY, ...Object.values(OPERATIONS).flat()]) quiet(w);
    expect(Object.keys(ADAPTER_CAPABILITIES)).toEqual(AGENTS);
  });
});
