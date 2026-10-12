import { describe, expect, it } from "vitest";
import { ToolIdentitySchema } from "../src/evidence/identity.js";
import { DenialSchema } from "../src/evidence/schema.js";
import { AGENTS, PERMISSION_MODES } from "../src/flow/schema.js";
import { REASON_CODES } from "../src/policy/reasons.js";
import { CREDENTIALS, FactsSchema } from "../src/policy/schema.js";
import { SkillToolProfileSchema } from "../src/skills/schema.js";
import { sessionTools } from "../src/skills/tool-policy.js";
import { ADAPTER_CAPABILITIES, canEnforce, CLAUDE_CODE_CAPABILITIES, CODEX_CAPABILITIES, unenforceable } from "../src/tool-profile/adapters.js";
import { LEGACY_PROFILE_IDENTITY, legacyToolProfile, meetsSkillToolProfile, skillCapabilitiesOf, type LegacyToolSettings } from "../src/tool-profile/legacy.js";
import { parseAdapterCapabilities, parseToolProfile } from "../src/tool-profile/parse.js";
import {
  checkToolCall, isAtMostAsPermissive, normalizeToolProfile, operationGrants, patternWithin, resolveToolProfile, targetCovers, toolCallDenial, toolNameOf, toolProfileExcess,
  toolProfileRef, toolProfileSha256,
} from "../src/tool-profile/resolve.js";
import { CREDENTIAL_ORDER, OPERATIONS, TOOL_KINDS, ToolProfileRefSchema, type ToolGrant, type ToolProfile } from "../src/tool-profile/schema.js";
import { ADAPTER_CAPABILITIES_VERSION, TOOL_PROFILE_VERSION, ToolProfileSchemaError } from "../src/tool-profile/version.js";

const open = { dataClassification: "restricted", credential: "none", timeoutMs: null, maxConcurrent: null, outputCapBytes: null, approval: "none" } as const;
const profile = (grants: ToolGrant[], id = "test"): ToolProfile => ({ version: 1, profile: { id, version: "1" }, grants });

/** A coder: the workspace, a few commands in a sandbox, one repository, one host, one MCP tool. */
const CODER = profile([
  { kind: "files", operations: ["read", "write"], targets: ["*"], ...open, dataClassification: "internal" },
  { kind: "shell", operations: ["run"], targets: ["npm test", "npm test *", "npm run build"], ...open, credential: "repository", timeoutMs: 600_000, maxConcurrent: 2, outputCapBytes: 60_000, sandbox: { filesystem: "workspace-write", network: "none" } },
  { kind: "git", operations: ["status", "branch", "commit"], targets: ["acme/shop"], ...open, credential: "repository" },
  { kind: "git", operations: ["push"], targets: ["acme/shop"], ...open, credential: "repository", approval: "required" },
  { kind: "github", operations: ["issue.read", "pull-request.read"], targets: ["acme/*"], ...open, credential: "repository" },
  { kind: "web", operations: ["fetch"], targets: ["docs.example.com"], ...open, dataClassification: "public" },
  { kind: "mcp", operations: ["call"], targets: ["tracker/get_issue"], ...open },
  { kind: "builtin", operations: ["call"], targets: ["TodoWrite"], ...open },
]);
/** Everything: every operation of every kind on every target, with no condition. */
const EVERYTHING = profile(
  TOOL_KINDS.map((kind) => ({ kind, operations: [...OPERATIONS[kind]], targets: [kind === "files" ? "/*" : "*"], ...open, credential: ["files", "web", "builtin"].includes(kind) ? "none" : "machine", ...(kind === "shell" ? { sandbox: { filesystem: "unrestricted", network: "unrestricted" } } : {}) }) as ToolGrant),
  "everything",
);
const NOTHING = profile([], "nothing");

const failure = (run: () => unknown): ToolProfileSchemaError => {
  try {
    run();
  } catch (e) {
    if (e instanceof ToolProfileSchemaError) return e;
    throw e;
  }
  throw new Error("expected a ToolProfileSchemaError");
};
const edit = <T>(value: T, change: (copy: any) => void): any => {
  const copy = structuredClone(value);
  change(copy);
  return copy;
};
const paths = (run: () => unknown) => failure(run).issues.map((i) => i.path);

describe("versions", () => {
  it("both contracts have their own explicit version", () => {
    expect([TOOL_PROFILE_VERSION, ADAPTER_CAPABILITIES_VERSION]).toEqual([1, 1]);
    expect(parseToolProfile(CODER).version).toBe(1);
    expect(parseAdapterCapabilities(CODEX_CAPABILITIES).version).toBe(1);
  });

  it.each([
    ["profile", parseToolProfile],
    ["capabilities", parseAdapterCapabilities],
  ] as const)("a %s record is refused without a version, with another version, or when it is not an object", (kind, parse) => {
    expect(failure(() => parse(null)).code).toBe("not-an-object");
    expect(failure(() => parse([])).code).toBe("not-an-object");
    expect(failure(() => parse({})).code).toBe("no-version");
    expect(failure(() => parse({ version: "1" })).code).toBe("no-version");
    const newer = failure(() => parse({ version: 2 }));
    expect([newer.kind, newer.code]).toEqual([kind, "unsupported-version"]);
    expect(newer.message).toContain("version 2 is not supported; this Foundry reads version 1");
  });
});

describe("the ToolProfile schema", () => {
  it("reads a profile with every kind, and one that grants nothing", () => {
    expect(parseToolProfile(CODER).grants.map((g) => g.kind)).toEqual(["files", "shell", "git", "git", "github", "web", "mcp", "builtin"]);
    expect(parseToolProfile(EVERYTHING).grants).toHaveLength(TOOL_KINDS.length);
    expect(parseToolProfile(NOTHING).grants).toEqual([]);
  });

  it("refuses an unknown kind, an unknown operation and an unknown field", () => {
    const kind = failure(() => parseToolProfile(edit(CODER, (p) => (p.grants[0].kind = "database"))));
    expect(kind.issues).toEqual([{ path: "grants.0.kind", message: expect.stringContaining("must be a grant of a known kind: files, shell, git, github, web, mcp, builtin") }]);
    const operation = failure(() => parseToolProfile(edit(CODER, (p) => p.grants[2].operations.push("force-push"))));
    expect(operation.issues).toEqual([{ path: "grants.2.operations.3", message: "must be a known git operation: status, clone, fetch, branch, commit, push" }]);
    expect(paths(() => parseToolProfile(edit(CODER, (p) => (p.grants[0].operations = ["run"]))))).toEqual(["grants.0.operations.0"]);
    expect(failure(() => parseToolProfile(edit(CODER, (p) => (p.grants[0].note = "x")))).code).toBe("invalid");
    expect(failure(() => parseToolProfile(edit(CODER, (p) => (p.owner = "x")))).code).toBe("invalid");
  });

  it("every grant declares all of its conditions: nothing is optional and nothing has a default", () => {
    for (const field of ["operations", "targets", "dataClassification", "credential", "timeoutMs", "maxConcurrent", "outputCapBytes", "approval"]) {
      expect(paths(() => parseToolProfile(edit(CODER, (p) => delete p.grants[1][field]))), field).toEqual([`grants.1.${field}`]);
    }
    expect(paths(() => parseToolProfile(edit(CODER, (p) => delete p.grants[1].sandbox)))).toEqual(["grants.1.sandbox"]);
    expect(paths(() => parseToolProfile(edit(CODER, (p) => (p.grants[0].operations = []))))).toEqual(["grants.0.operations"]);
    expect(paths(() => parseToolProfile(edit(CODER, (p) => (p.grants[0].targets = []))))).toEqual(["grants.0.targets"]);
  });

  it("refuses values outside the closed lists and limits outside their range", () => {
    const bad: [string, (p: any) => void][] = [
      ["grants.0.dataClassification", (p) => (p.grants[0].dataClassification = "top-secret")],
      ["grants.1.credential", (p) => (p.grants[1].credential = "admin")],
      ["grants.1.approval", (p) => (p.grants[1].approval = "sometimes")],
      ["grants.1.sandbox.filesystem", (p) => (p.grants[1].sandbox.filesystem = "home")],
      ["grants.1.sandbox.network", (p) => (p.grants[1].sandbox.network = "lan")],
      ["grants.1.timeoutMs", (p) => (p.grants[1].timeoutMs = 0)],
      ["grants.1.timeoutMs", (p) => (p.grants[1].timeoutMs = 1.5)],
      ["grants.1.maxConcurrent", (p) => (p.grants[1].maxConcurrent = 0)],
      ["grants.1.outputCapBytes", (p) => (p.grants[1].outputCapBytes = -1)],
      ["profile.id", (p) => (p.profile.id = "Not A Slug")],
      ["profile.version", (p) => (p.profile.version = "")],
    ];
    for (const [path, change] of bad) expect(paths(() => parseToolProfile(edit(CODER, change))), path).toEqual([path]);
    expect(parseToolProfile(edit(CODER, (p) => (p.grants[1].outputCapBytes = 0))).grants[1]!.outputCapBytes).toBe(0);
  });

  it("only a shell grant has a sandbox", () => {
    expect(failure(() => parseToolProfile(edit(CODER, (p) => (p.grants[0].sandbox = { filesystem: "read-only", network: "none" })))).code).toBe("invalid");
  });

  it.each([
    ["files", ["src/*", "docs/a.md", "/*", "/opt/tools/*"], ["", "../x", "src/../x", "./x", "a//b", "//x", "/", "a\\b", "C:/x", "a\nb"]],
    ["shell", ["npm test", "git status *", "*"], ["", " npm test", "npm test ", "a\nb"]],
    ["git", ["acme/shop", "acme/*", "*"], ["Acme/shop", "acme", "acme/shop/x", "https://github.com/acme/shop", "acme/ shop"]],
    ["github", ["acme/shop", "*/*"], ["acme", "ACME/SHOP"]],
    ["web", ["example.com", "*.example.com", "*"], ["https://example.com", "example.com/path", "example.com:8080", "Example.com", "user@example.com", ""]],
    ["mcp", ["tracker/get_issue", "tracker/*", "*"], ["tracker", "tracker/get issue", "a/b/c"]],
    ["builtin", ["Task", "Todo*"], ["Task(x)", "a b", ""]],
  ] as const)("a %s target has its own form", (kind, good, bad) => {
    const at = CODER.grants.findIndex((g) => g.kind === kind);
    for (const target of good) expect(parseToolProfile(edit(CODER, (p) => (p.grants[at].targets = [target]))).grants[at]!.targets, target).toEqual([target]);
    for (const target of bad) expect(paths(() => parseToolProfile(edit(CODER, (p) => (p.grants[at].targets = [target])))), JSON.stringify(target)).toEqual([`grants.${at}.targets.0`]);
    expect(paths(() => parseToolProfile(edit(CODER, (p) => (p.grants[at].targets = ["x".repeat(256)]))))).toEqual([`grants.${at}.targets.0`]);
  });

  it("refuses the same operation or target twice, in one grant or in two grants of a kind", () => {
    expect(paths(() => parseToolProfile(edit(CODER, (p) => (p.grants[0].operations = ["read", "read"]))))).toEqual(["grants.0.operations"]);
    expect(paths(() => parseToolProfile(edit(CODER, (p) => (p.grants[0].targets = ["a", "a"]))))).toEqual(["grants.0.targets"]);
    const twice = failure(() => parseToolProfile(edit(CODER, (p) => p.grants[3].operations.push("commit"))));
    expect(twice.issues).toEqual([{ path: "grants.3.operations.1", message: "another grant of this kind already names this operation" }]);
  });

  it("refuses a sign-in on a tool that has none, and a host for a web search", () => {
    for (const at of [0, 5, 7]) expect(paths(() => parseToolProfile(edit(CODER, (p) => (p.grants[at].credential = "repository"))))).toEqual([`grants.${at}.credential`]);
    expect(paths(() => parseToolProfile(edit(CODER, (p) => p.grants[5].operations.push("search"))))).toEqual(["grants.5.targets"]);
    expect(parseToolProfile(edit(CODER, (p) => p.grants.push({ kind: "web", operations: ["search"], targets: ["*"], ...open }))).grants).toHaveLength(9);
  });

  it("an error names fields and what they must be, never the values of the record", () => {
    const e = failure(() => parseToolProfile(edit(CODER, (p) => (p.grants[1].targets = ["curl -H 'Authorization: sk-secret-value'\n"]))));
    expect(e.message).toContain("tool profile: not valid\n  - grants.1.targets.0: must be a command line on one line");
    expect(e.message).not.toContain("sk-secret-value");
  });

  it("uses the sign-ins and the reason codes of the policy contracts, and tool names evidence accepts", () => {
    expect([...CREDENTIAL_ORDER].sort()).toEqual([...CREDENTIALS].sort());
    for (const code of ["tool.not-allowed", "repository.not-allowed", "approval.required"]) expect(REASON_CODES).toContain(code);
    for (const kind of TOOL_KINDS) {
      for (const operation of OPERATIONS[kind]) {
        expect(ToolIdentitySchema.safeParse({ name: toolNameOf(kind, operation) }).success, `${kind} ${operation}`).toBe(true);
        expect(FactsSchema.safeParse({ tool: toolNameOf(kind, operation) }).success).toBe(true);
      }
    }
  });
});

describe("checkToolCall: closed by default", () => {
  const ask = (kind: string, operation: string, target: string, p: ToolProfile = CODER) => checkToolCall(p, { kind, operation, target });
  const deny = (refusal: string, reasonCode = "tool.not-allowed") => ({ outcome: "deny", reasonCode, refusal });

  it("allows what a grant names", () => {
    expect(ask("files", "write", "src/app/main.ts")).toEqual({ outcome: "allow" });
    expect(ask("shell", "run", "npm test -- --watch=false")).toEqual({ outcome: "allow" });
    expect(ask("git", "commit", "acme/shop")).toEqual({ outcome: "allow" });
    expect(ask("github", "issue.read", "acme/other")).toEqual({ outcome: "allow" });
    expect(ask("mcp", "call", "tracker/get_issue")).toEqual({ outcome: "allow" });
  });

  it("refuses an unknown kind, an unknown operation and a target that cannot be one", () => {
    expect(ask("database", "query", "x")).toEqual(deny("unknown-kind"));
    expect(ask("git", "force-push", "acme/shop")).toEqual(deny("unknown-operation"));
    expect(ask("files", "run", "src/a")).toEqual(deny("unknown-operation"));
    expect(ask("files", "read", "src/../../etc/passwd")).toEqual(deny("invalid-target"));
    expect(ask("git", "commit", "")).toEqual(deny("invalid-target"));
    expect(checkToolCall(CODER, { kind: 1, operation: null, target: undefined } as any)).toEqual(deny("unknown-kind"));
  });

  it("refuses a kind, an operation and a target the profile does not grant", () => {
    expect(ask("files", "read", "a", NOTHING)).toEqual(deny("kind-not-granted"));
    expect(ask("web", "search", "*")).toEqual(deny("operation-not-granted"));
    expect(ask("git", "clone", "acme/shop")).toEqual(deny("operation-not-granted"));
    expect(ask("shell", "run", "npm testx")).toEqual(deny("target-not-granted"));
    expect(ask("shell", "run", "npm run build && curl example.com")).toEqual(deny("target-not-granted"));
    // a pattern never allows a second command: only the target * does
    for (const tail of ["; curl example.com", "&& rm -rf x", "| sh", "> /etc/hosts", "$(curl example.com)", "`id`"]) expect(ask("shell", "run", `npm test ${tail}`), tail).toEqual(deny("target-not-granted"));
    expect(ask("shell", "run", "npm test; id", EVERYTHING)).toEqual({ outcome: "allow" });
    expect(ask("web", "fetch", "evil.example.org")).toEqual(deny("target-not-granted"));
    expect(ask("mcp", "call", "tracker/delete_issue")).toEqual(deny("target-not-granted"));
    expect(ask("builtin", "call", "Task")).toEqual(deny("target-not-granted"));
  });

  it("a repository that is not a target is refused with the repository reason code", () => {
    expect(ask("git", "commit", "acme/other")).toEqual(deny("target-not-granted", "repository.not-allowed"));
    expect(ask("github", "issue.read", "other/shop")).toEqual(deny("target-not-granted", "repository.not-allowed"));
  });

  it("a file of the machine is only reached by a target that names it", () => {
    expect(ask("files", "read", "/etc/passwd")).toEqual(deny("target-not-granted"));
    expect(ask("files", "read", "/etc/passwd", EVERYTHING)).toEqual({ outcome: "allow" });
    expect(ask("files", "read", "src/a.ts", EVERYTHING)).toEqual({ outcome: "allow" });
    expect(targetCovers("files", "/opt/tools/*", "opt/tools/x")).toBe(false);
  });

  it("a grant that requires approval answers require_approval", () => {
    expect(ask("git", "push", "acme/shop")).toEqual({ outcome: "require_approval", reasonCode: "approval.required" });
  });

  it("a refusal becomes the denial of an evidence event; anything else does not", () => {
    const call = { kind: "git", operation: "push", target: "acme/other" };
    const denial = toolCallDenial(call, checkToolCall(CODER, call));
    expect(denial).toEqual({ kind: "tool", tool: { name: "git.push" } });
    expect(DenialSchema.safeParse(denial).success).toBe(true);
    expect(toolCallDenial({ ...call, target: "acme/shop" }, checkToolCall(CODER, { ...call, target: "acme/shop" }))).toBeUndefined();
    expect(toolCallDenial({ kind: "database", operation: "q", target: "x" }, ask("database", "q", "x"))).toBeUndefined();
  });

  it("decides nothing on a profile that is not valid", () => {
    expect(failure(() => checkToolCall(edit(CODER, (p) => (p.version = 2)), { kind: "files", operation: "read", target: "a" })).code).toBe("unsupported-version");
  });
});

describe("the canonical form, the hash and the reference", () => {
  const shuffled = edit(CODER, (p) => {
    p.grants.reverse();
    p.grants.find((g: any) => g.kind === "shell").targets.reverse();
    p.grants.find((g: any) => g.kind === "files").operations.reverse();
  });

  it("the hash does not depend on the order a profile was written in", () => {
    expect(toolProfileSha256(shuffled)).toBe(toolProfileSha256(CODER));
    expect(normalizeToolProfile(shuffled)).toEqual(normalizeToolProfile(CODER));
    expect(toolProfileSha256(CODER)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("two grants that say the same for two operations are one grant in the canonical form", () => {
    const split = profile([
      { kind: "files", operations: ["write"], targets: ["*"], ...open },
      { kind: "files", operations: ["read"], targets: ["*"], ...open },
    ]);
    const joined = profile([{ kind: "files", operations: ["read", "write"], targets: ["*"], ...open }]);
    expect(normalizeToolProfile(split)).toEqual(joined);
    expect(toolProfileSha256(split)).toBe(toolProfileSha256(joined));
  });

  it("any change of what is granted, and any change of the identity, changes the hash", () => {
    const changes: ((p: any) => void)[] = [
      (p) => p.grants[1].targets.push("npm ci"),
      (p) => (p.grants[1].timeoutMs = 600_001),
      (p) => (p.grants[1].sandbox.network = "unrestricted"),
      (p) => (p.grants[3].approval = "none"),
      (p) => p.grants.pop(),
      (p) => (p.profile.version = "2"),
    ];
    const hashes = new Set([toolProfileSha256(CODER), ...changes.map((c) => toolProfileSha256(edit(CODER, c)))]);
    expect(hashes.size).toBe(changes.length + 1);
  });

  it("the reference a run keeps is the id, the version and the hash, and nothing else", () => {
    const ref = toolProfileRef(CODER);
    expect(ref).toEqual({ id: "test", version: "1", sha256: toolProfileSha256(CODER) });
    expect(ToolProfileRefSchema.safeParse({ ...ref, grants: [] }).success).toBe(false);
    expect(ToolProfileRefSchema.safeParse({ ...ref, sha256: "abc" }).success).toBe(false);
    expect(toolProfileRef(shuffled)).toEqual(ref);
  });
});

describe("least privilege: comparing and resolving", () => {
  it("a profile is at most as permissive as itself and as everything, and nothing is below all", () => {
    expect(toolProfileExcess(CODER, CODER)).toEqual([]);
    expect(isAtMostAsPermissive(CODER, EVERYTHING)).toBe(true);
    expect(isAtMostAsPermissive(NOTHING, CODER)).toBe(true);
    expect(isAtMostAsPermissive(EVERYTHING, CODER)).toBe(false);
    expect(isAtMostAsPermissive(CODER, NOTHING)).toBe(false);
  });

  it.each([
    ["operation", "git", (p: any) => p.grants[2].operations.push("clone")],
    ["targets", "shell", (p: any) => p.grants[1].targets.push("npm ci")],
    ["targets", "files", (p: any) => (p.grants[0].targets = ["/*"])],
    ["dataClassification", "web", (p: any) => (p.grants[5].dataClassification = "internal")],
    ["credential", "shell", (p: any) => (p.grants[1].credential = "machine")],
    ["timeoutMs", "shell", (p: any) => (p.grants[1].timeoutMs = null)],
    ["maxConcurrent", "shell", (p: any) => (p.grants[1].maxConcurrent = 3)],
    ["outputCapBytes", "shell", (p: any) => (p.grants[1].outputCapBytes = 60_001)],
    ["approval", "git", (p: any) => (p.grants[3].approval = "none")],
    ["sandbox.filesystem", "shell", (p: any) => (p.grants[1].sandbox.filesystem = "unrestricted")],
    ["sandbox.network", "shell", (p: any) => (p.grants[1].sandbox.network = "unrestricted")],
  ] as const)("more of %s (%s) is found, and only that", (field, kind, change) => {
    const wider = edit(CODER, change);
    // one entry per operation of the grant that was widened
    expect([...new Set(toolProfileExcess(wider, CODER).map((x) => `${x.kind} ${x.field}`))]).toEqual([`${kind} ${field}`]);
    expect(isAtMostAsPermissive(CODER, wider)).toBe(true);
  });

  it("a pattern is inside another only when everything it allows is allowed", () => {
    expect(patternWithin("shell", "npm test *", "npm *")).toBe(true);
    expect(patternWithin("shell", "npm *", "npm test *")).toBe(false);
    expect(patternWithin("shell", "a*b", "a*")).toBe(true);
    expect(patternWithin("shell", "a*", "a*a")).toBe(false);
    expect(patternWithin("git", "acme/shop", "acme/*")).toBe(true);
    expect(patternWithin("files", "src/*", "/*")).toBe(true);
    expect(patternWithin("files", "/*", "*")).toBe(false);
    expect(patternWithin("files", "/opt/*", "*")).toBe(false);
  });

  const ceiling = profile(
    [
      { kind: "files", operations: ["read", "write"], targets: ["*"], ...open, dataClassification: "confidential" },
      { kind: "shell", operations: ["run"], targets: ["npm *", "git status"], ...open, credential: "repository", timeoutMs: 300_000, maxConcurrent: 4, outputCapBytes: null, approval: "required", sandbox: { filesystem: "workspace-write", network: "unrestricted" } },
      { kind: "git", operations: ["status", "commit", "push"], targets: ["acme/*"], ...open, credential: "machine" },
      { kind: "web", operations: ["fetch"], targets: ["*.example.com"], ...open },
    ],
    "ceiling",
  );

  it("resolving keeps what every profile allows, under the strictest condition of any", () => {
    const resolved = resolveToolProfile({ id: "resolved", version: "1" }, [CODER, ceiling]);
    expect(resolved.profile).toEqual({ id: "resolved", version: "1" });
    expect(resolved.grants).toEqual([
      { kind: "files", operations: ["read", "write"], targets: ["*"], ...open, dataClassification: "internal" },
      { kind: "shell", operations: ["run"], targets: ["npm run build", "npm test", "npm test *"], ...open, credential: "repository", timeoutMs: 300_000, maxConcurrent: 2, outputCapBytes: 60_000, approval: "required", sandbox: { filesystem: "workspace-write", network: "none" } },
      { kind: "git", operations: ["status", "commit"], targets: ["acme/shop"], ...open, credential: "repository" },
      { kind: "git", operations: ["push"], targets: ["acme/shop"], ...open, credential: "repository", approval: "required" },
      { kind: "web", operations: ["fetch"], targets: ["docs.example.com"], ...open, dataClassification: "public" },
    ]);
    // github, mcp and builtin are not in the ceiling
    for (const g of CODER.grants.slice(-2)) expect(checkToolCall(resolved, { kind: g.kind, operation: g.operations[0]!, target: g.targets[0]! })).toMatchObject({ outcome: "deny", refusal: "kind-not-granted" });
    expect(checkToolCall(resolved, { kind: "github", operation: "issue.read", target: "acme/shop" })).toMatchObject({ outcome: "deny", refusal: "kind-not-granted" });
    expect(toolProfileExcess(EVERYTHING, CODER).map((x) => x.field)).toContain("operation");
  });

  it("the result is at most as permissive as each profile, whatever the order, and one profile resolves to itself", () => {
    const third = edit(EVERYTHING, (p) => (p.grants[1].targets = ["npm test *", "git *"]));
    const sets = [[CODER, ceiling], [ceiling, CODER], [CODER, ceiling, third], [third, ceiling, CODER], [ceiling, third, CODER], [EVERYTHING, CODER], [CODER, NOTHING]];
    for (const set of sets) {
      const resolved = resolveToolProfile({ id: "r", version: "1" }, set);
      for (const p of set) expect(toolProfileExcess(resolved, p)).toEqual([]);
    }
    const hash = (set: ToolProfile[]) => toolProfileSha256(resolveToolProfile({ id: "r", version: "1" }, set));
    expect(hash([CODER, ceiling, third])).toBe(hash([third, ceiling, CODER]));
    expect(hash([CODER, ceiling, third])).toBe(hash([ceiling, third, CODER]));
    expect(hash([CODER, EVERYTHING])).toBe(hash([CODER]));
    expect(resolveToolProfile(CODER.profile, [CODER])).toEqual(normalizeToolProfile(CODER));
    expect(resolveToolProfile({ id: "r", version: "1" }, [CODER, NOTHING]).grants).toEqual([]);
  });

  it("targets that only overlap in part are dropped, not widened", () => {
    const a = profile([{ kind: "shell", operations: ["run"], targets: ["npm *"], ...open, sandbox: { filesystem: "read-only", network: "none" } }]);
    const b = profile([{ kind: "shell", operations: ["run"], targets: ["* --watch"], ...open, sandbox: { filesystem: "read-only", network: "none" } }]);
    expect(resolveToolProfile({ id: "r", version: "1" }, [a, b]).grants).toEqual([]);
  });

  it("refuses to resolve nothing, a profile that is not valid, or under a name that is not valid", () => {
    expect(failure(() => resolveToolProfile({ id: "r", version: "1" }, [])).issues[0]!.message).toBe("at least one profile is needed to resolve");
    expect(failure(() => resolveToolProfile({ id: "r", version: "1" }, [CODER, edit(CODER, (p) => (p.grants[0].kind = "x"))])).code).toBe("invalid");
    expect(paths(() => resolveToolProfile({ id: "Bad Id", version: "1" }, [CODER]))).toEqual(["profile.id"]);
  });
});

describe("adapter capabilities", () => {
  it("there is one honest record per agent program", () => {
    expect(Object.keys(ADAPTER_CAPABILITIES).sort()).toEqual([...AGENTS].sort());
    for (const agent of AGENTS) expect(ADAPTER_CAPABILITIES[agent].agent).toBe(agent);
  });

  it("the record is closed: every kind, known controls, known levels, no extra field", () => {
    const bad: [string, (c: any) => void][] = [
      ["kinds.mcp", (c) => delete c.kinds.mcp],
      ["kinds", (c) => (c.kinds.database = { through: "own-tools", controls: [] })],
      ["kinds.shell.controls.0", (c) => (c.kinds.shell.controls = ["audit"])],
      ["kinds.files.controls", (c) => c.kinds.files.controls.push("deny-kind")],
      ["sandbox.filesystem", (c) => (c.sandbox.filesystem = [])],
      ["sandbox.network.0", (c) => (c.sandbox.network = ["lan"])],
      ["agent", (c) => (c.agent = "other")],
      ["kinds.shell.through", (c) => (c.kinds.shell.through = "shell")],
      ["kinds.git.controls", (c) => (c.kinds.git.controls = ["deny-kind"])],
    ];
    for (const [path, change] of bad) expect(paths(() => parseAdapterCapabilities(edit(CLAUDE_CODE_CAPABILITIES, change))), path).toEqual([path]);
  });

  const gaps = (p: ToolProfile, c = CODEX_CAPABILITIES) => unenforceable(p, c).map((g) => `${g.kind}:${g.restriction}`);
  const readOnly = profile([{ kind: "files", operations: ["read"], targets: ["/*"], ...open }]);

  it("Codex cannot allow tools one by one; Claude Code can", () => {
    // a reviewer: read files, nothing else
    expect(gaps(readOnly, CLAUDE_CODE_CAPABILITIES)).toEqual([]);
    expect(gaps(readOnly)).toEqual(["shell:deny-kind", "git:deny-kind", "github:deny-kind", "web:deny-kind", "builtin:deny-kind"]);
    expect([canEnforce(readOnly, CLAUDE_CODE_CAPABILITIES), canEnforce(readOnly, CODEX_CAPABILITIES)]).toEqual([true, false]);
    // named commands, named paths and one MCP tool
    const named = profile([
      { kind: "files", operations: ["read", "write"], targets: ["src/*"], ...open },
      { kind: "shell", operations: ["run"], targets: ["npm test"], ...open, sandbox: { filesystem: "workspace-write", network: "unrestricted" } },
      { kind: "mcp", operations: ["call"], targets: ["tracker/get_issue"], ...open },
    ]);
    expect(gaps(named)).toEqual(["files:limit-targets", "shell:limit-targets", "git:deny-kind", "github:deny-kind", "web:deny-kind", "mcp:limit-targets", "builtin:deny-kind"]);
    expect(gaps(named, CLAUDE_CODE_CAPABILITIES)).toEqual(["git:deny-kind", "github:deny-kind"]);
  });

  it("a profile that restricts nothing has no gap with any adapter", () => {
    for (const agent of AGENTS) expect(unenforceable(EVERYTHING, ADAPTER_CAPABILITIES[agent])).toEqual([]);
  });

  it("repository operations cannot be held while the agent can run commands", () => {
    const withShell = profile([
      { kind: "shell", operations: ["run"], targets: ["*"], ...open, sandbox: { filesystem: "unrestricted", network: "unrestricted" } },
      { kind: "git", operations: ["status", "commit"], targets: ["acme/shop"], ...open, approval: "required" },
    ]);
    const all = ["git:limit-operations", "git:limit-targets", "git:require-approval", "github:deny-kind"];
    expect(gaps(withShell, CLAUDE_CODE_CAPABILITIES).filter((g) => g.startsWith("git"))).toEqual(all);
    const withoutShell = edit(withShell, (p) => p.grants.shift());
    expect(gaps(withoutShell, CLAUDE_CODE_CAPABILITIES).filter((g) => g.startsWith("git"))).toEqual([]);
    expect(gaps(withoutShell).filter((g) => g.startsWith("git"))).toEqual(all);
  });

  it("a sandbox level, approval and the limits of a call are gaps where the adapter does not hold them", () => {
    const strict = profile([
      ...EVERYTHING.grants.filter((g) => g.kind !== "shell"),
      { kind: "shell", operations: ["run"], targets: ["*"], ...open, timeoutMs: 1000, maxConcurrent: 1, outputCapBytes: 1000, approval: "required", sandbox: { filesystem: "read-only", network: "none" } },
    ]);
    expect(gaps(strict, CLAUDE_CODE_CAPABILITIES)).toEqual(["shell:require-approval", "shell:timeout", "shell:concurrency", "shell:output-cap", "shell:sandbox-filesystem", "shell:sandbox-network"]);
    expect(gaps(strict)).toEqual(["shell:require-approval", "shell:timeout", "shell:concurrency", "shell:output-cap", "shell:sandbox-network"]);
    const workspace = edit(strict, (p) => Object.assign(p.grants.at(-1), { ...open, sandbox: { filesystem: "workspace-write", network: "unrestricted" } }));
    for (const agent of AGENTS) expect(unenforceable(workspace, ADAPTER_CAPABILITIES[agent])).toEqual([]);
    // an adapter that can only run commands read-only holds every wider level too
    const tight = edit(CODEX_CAPABILITIES, (c) => (c.sandbox.filesystem = ["read-only"]));
    expect(unenforceable(workspace, tight)).toEqual([]);
  });

  it("answers nothing on capabilities or a profile that are not valid", () => {
    expect(failure(() => unenforceable(CODER, edit(CODEX_CAPABILITIES, (c) => (c.version = 3)))).kind).toBe("capabilities");
    expect(failure(() => unenforceable(edit(CODER, (p) => delete p.grants), CODEX_CAPABILITIES)).kind).toBe("profile");
  });
});

describe("today's flow settings as a generated profile", () => {
  const settings = (over: Partial<LegacyToolSettings> = {}): LegacyToolSettings => ({ permissionMode: "acceptEdits", allowedTools: [], sandbox: false, boxed: false, noTools: false, mcpServers: false, credential: "none", ...over });
  const granted = (s: Partial<LegacyToolSettings>) => operationGrants(legacyToolProfile(settings(s)).profile).map((e) => `${e.kind}.${e.operation} ${e.targets.join("|")}`);

  it("says the same as the skill tool check for every mode, with and without rules and sandbox", () => {
    const ruleSets = [[], ["Read", "Glob", "Grep"], ["Bash"], ["Bash(npm test:*)", "Edit"], ["WebFetch"], ["WebSearch", "Write"], ["Read", "Edit", "Bash(git status)", "WebFetch(domain:example.com)"]];
    for (const permissionMode of PERMISSION_MODES) {
      for (const allowedTools of ruleSets) {
        for (const [sandbox, boxed] of [[false, false], [true, false], [false, true]] as const) {
          const today = sessionTools({ stepId: "s", step: { permission_mode: permissionMode, allowed_tools: allowedTools }, defaults: {}, sandbox: { step: sandbox, boxed } }).capabilities;
          const generated = legacyToolProfile(settings({ permissionMode, allowedTools, sandbox, boxed }));
          expect(generated.unmapped).toEqual([]);
          expect(skillCapabilitiesOf(generated.profile), `${permissionMode} ${allowedTools.join(",")} ${sandbox} ${boxed}`).toEqual({ shell: today.shell, network: today.network, filesystem: today.filesystem });
        }
      }
    }
  });

  it("is a valid profile with the generated identity, and the same settings give the same hash", () => {
    const a = legacyToolProfile(settings({ allowedTools: ["Bash(npm test:*)", "Read"] })).profile;
    const b = legacyToolProfile(settings({ allowedTools: ["Read", "Bash(npm test:*)"] })).profile;
    expect(parseToolProfile(a).profile).toEqual(LEGACY_PROFILE_IDENTITY);
    expect(toolProfileSha256(a)).toBe(toolProfileSha256(b));
    expect(toolProfileSha256(a)).not.toBe(toolProfileSha256(legacyToolProfile(settings()).profile));
  });

  it("maps the modes", () => {
    expect(granted({ permissionMode: "plan", allowedTools: ["Bash", "Edit", "WebFetch"], sandbox: true })).toEqual(["files.read *", "builtin.call *"]);
    expect(granted({ permissionMode: "dontAsk", allowedTools: ["Read", "Grep"] })).toEqual(["files.read *", "builtin.call *"]);
    expect(granted({ permissionMode: "acceptEdits" })).toEqual(["files.read *", "files.write *", "builtin.call *"]);
    expect(granted({ permissionMode: "bypassPermissions", mcpServers: true })).toEqual(["files.read /*", "files.write /*", "shell.run *", "web.fetch *", "web.search *", "mcp.call *", "builtin.call *"]);
    expect(granted({ permissionMode: "auto" })).toEqual(["files.read *", "files.write *", "shell.run *", "web.fetch *", "web.search *", "builtin.call *"]);
    expect(granted({ noTools: true, permissionMode: "bypassPermissions" })).toEqual([]);
  });

  it("only bypassPermissions without any sandbox reaches files outside the workspace, and a sandbox holds commands to it", () => {
    const shellOf = (s: Partial<LegacyToolSettings>) => legacyToolProfile(settings({ permissionMode: "bypassPermissions", ...s })).profile.grants.find((g) => g.kind === "shell");
    expect(shellOf({})).toMatchObject({ sandbox: { filesystem: "unrestricted", network: "unrestricted" } });
    expect(shellOf({ sandbox: true })).toMatchObject({ sandbox: { filesystem: "workspace-write", network: "unrestricted" } });
    expect(shellOf({ boxed: true })).toMatchObject({ sandbox: { filesystem: "workspace-write", network: "unrestricted" } });
    expect(granted({ permissionMode: "bypassPermissions", sandbox: true })[0]).toBe("files.read *");
    expect(granted({ permissionMode: "bypassPermissions", boxed: true })[0]).toBe("files.read *");
    expect(granted({ permissionMode: "dontAsk", sandbox: true })).toContain("shell.run *");
  });

  it("maps the rules, and never more than a rule says", () => {
    expect(granted({ permissionMode: "dontAsk", allowedTools: ["Bash(npm test:*)", "Bash(git status)", "Bash(npm run *)"] })).toContain("shell.run git status|npm run *|npm test|npm test *");
    expect(granted({ permissionMode: "dontAsk", allowedTools: ["Edit(src/**)", "Write(./docs/guide.md)"] })).toContain("files.write docs/guide.md|src/*");
    expect(granted({ permissionMode: "dontAsk", allowedTools: ["WebFetch(domain:Docs.Example.com)", "WebSearch"] })).toEqual(expect.arrayContaining(["web.fetch docs.example.com", "web.search *"]));
    expect(granted({ permissionMode: "dontAsk", mcpServers: true, allowedTools: ["mcp__tracker__get_issue", "mcp__my-docs"] })).toContain("mcp.call my-docs/*|tracker/get_issue");
    const profileOf = legacyToolProfile(settings({ permissionMode: "dontAsk", allowedTools: ["Bash(npm test:*)"] })).profile;
    expect(checkToolCall(profileOf, { kind: "shell", operation: "run", target: "npm test -- a" }).outcome).toBe("allow");
    expect(checkToolCall(profileOf, { kind: "shell", operation: "run", target: "npm testing" }).outcome).toBe("deny");
  });

  it("the sign-in goes to the shell and to MCP only, and no setting grants a repository operation", () => {
    const p = legacyToolProfile(settings({ permissionMode: "bypassPermissions", mcpServers: true, credential: "machine" })).profile;
    expect(p.grants.map((g) => [g.kind, g.credential])).toEqual([["files", "none"], ["shell", "machine"], ["web", "none"], ["mcp", "machine"], ["builtin", "none"]]);
    expect(checkToolCall(p, { kind: "git", operation: "push", target: "acme/shop" })).toEqual({ outcome: "deny", reasonCode: "tool.not-allowed", refusal: "kind-not-granted" });
    expect(p.grants.every((g) => g.approval === "none" && g.timeoutMs === null && g.maxConcurrent === null && g.outputCapBytes === null && g.dataClassification === "restricted")).toBe(true);
  });

  it("a rule without a meaning in a profile grants nothing and is reported", () => {
    const rules = ["Edit(/etc/**)", "Edit(~/notes/**)", "Edit(src/*.ts)", "Edit(../x)", "Bash()", "Bash(a\nb)", "WebFetch(https://example.com)", "WebSearch(cats)", "mcp__tracker__get_issue", "not a rule", "", "Edit(src/*.ts)"];
    const out = legacyToolProfile(settings({ permissionMode: "dontAsk", allowedTools: rules }));
    expect(out.unmapped).toEqual(rules.slice(0, -1));
    expect(operationGrants(out.profile).map((e) => `${e.kind}.${e.operation}`)).toEqual(["files.read", "builtin.call"]);
    // with MCP servers loaded the MCP rule has a meaning
    expect(legacyToolProfile(settings({ permissionMode: "dontAsk", mcpServers: true, allowedTools: ["mcp__tracker__get_issue"] })).unmapped).toEqual([]);
  });

  it("the generated profile shows what each adapter cannot hold of today's settings", () => {
    const coder = legacyToolProfile(settings({ permissionMode: "acceptEdits" })).profile;
    const codex = unenforceable(coder, CODEX_CAPABILITIES).map((g) => `${g.kind}:${g.restriction}`);
    expect(codex).toEqual(["files:limit-targets", "shell:deny-kind", "git:deny-kind", "github:deny-kind", "web:deny-kind"]);
    expect(unenforceable(coder, CLAUDE_CODE_CAPABILITIES)).toEqual([]);
  });

  it("refuses settings that are not valid", () => {
    expect(paths(() => legacyToolProfile(settings({ permissionMode: "yolo" as any })))).toEqual(["settings.permissionMode"]);
    expect(paths(() => legacyToolProfile(settings({ sandbox: true, boxed: true })))).toEqual(["settings.sandbox"]);
    expect(failure(() => legacyToolProfile({ ...settings(), extra: 1 } as any)).code).toBe("invalid");
    expect(paths(() => legacyToolProfile({ permissionMode: "plan" } as any))).toHaveLength(6);
  });
});

describe("a skill's tool_profile and a ToolProfile", () => {
  it("a skill says what it needs in three words; a profile gives it or does not", () => {
    const need = (o: object) => SkillToolProfileSchema.parse(o);
    expect(skillCapabilitiesOf(CODER)).toEqual({ shell: true, network: true, filesystem: "write" });
    expect(skillCapabilitiesOf(NOTHING)).toEqual({ shell: false, network: false, filesystem: "none" });
    expect(meetsSkillToolProfile(need({ shell: true, network: true, filesystem: "write" }), CODER)).toBe(true);
    const reader = profile([{ kind: "files", operations: ["read"], targets: ["*"], ...open }]);
    expect(meetsSkillToolProfile(need({}), reader)).toBe(true);
    expect(meetsSkillToolProfile(need({ filesystem: "none" }), NOTHING)).toBe(true);
    expect(meetsSkillToolProfile(need({}), NOTHING)).toBe(false);
    expect(meetsSkillToolProfile(need({ shell: true }), reader)).toBe(false);
    expect(meetsSkillToolProfile(need({ network: true }), reader)).toBe(false);
    expect(meetsSkillToolProfile(need({ filesystem: "write" }), reader)).toBe(false);
  });
});
