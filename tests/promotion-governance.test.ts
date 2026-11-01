import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { componentsCommand } from "../src/promotion/cli.js";
import { componentsView, listGoverned } from "../src/promotion/governed.js";
import {
  GovernanceBookSchema,
  governanceOrphans,
  governanceProfile,
  governanceStatus,
  MAX_GOVERNANCE_BYTES,
  readGovernanceBook,
  type GovernanceRecord,
} from "../src/promotion/governance.js";

const FLOW = "name: demo\nsteps:\n  - id: one\n    type: shell\n    run: echo one\n";
const open = { dataClassification: "internal", credential: "none", timeoutMs: null, maxConcurrent: null, outputCapBytes: null, approval: "none" };
const profile = (id: string) => ({ version: 1, profile: { id, version: "1" }, grants: [{ kind: "files", operations: ["read"], targets: ["src/*"], ...open }] });
const NOW = new Date("2026-11-01T00:00:00Z");
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 10);
const book = (components: object, extra: object = {}) => ({ version: 1, components, ...extra });
const parse = (b: unknown) => GovernanceBookSchema.safeParse(b);

let home: string;
let builtin: string;
let saved: string | undefined;
const put = (rel: string, text: string) => {
  mkdirSync(join(home, rel, ".."), { recursive: true });
  writeFileSync(join(home, rel), text);
};
const gov = (text: string) => put("promotions/governance.yaml", text);
const run = (args: string[] = []) => {
  const lines: string[] = [];
  const code = componentsCommand(args, (l) => void lines.push(l), { builtinFlowsDir: builtin, now: NOW });
  return { code, lines };
};
const tree = (dir = home): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? [d.name + "/", ...tree(join(dir, d.name)).map((x) => `${d.name}/${x}`)] : [d.name]));

beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  const base = mkdtempSync(join(tmpdir(), "governance-home-"));
  home = join(base, "home");
  builtin = join(base, "builtin");
  mkdirSync(home);
  mkdirSync(builtin);
  writeFileSync(join(builtin, "base.yaml"), FLOW.replace("demo", "base"));
  process.env.FACTORY_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(join(home, ".."), { recursive: true, force: true });
});

describe("governance schema", () => {
  it("accepts a full record and an empty one", () => {
    const full = { owner: "acme/platform", risk: "high", lifecycle: "deprecated", approved_version: "1.4.0", last_review: "2026-10-01", eval_suite: "timeout" };
    expect(parse(book({ "flow/a": full, "policy-pack/b": {} })).success).toBe(true);
  });

  it("reads versions and unquoted dates the way people write them", () => {
    const r = parse(book({ "flow/a": { approved_version: 3, last_review: "2026-01-15" } }));
    expect(r.success && r.data.components["flow/a"]!.approved_version).toBe("3");
    expect(parse(book({ "flow/a": { approved_version: "1.4.0" } })).success).toBe(true);
    expect(parse(book({ "flow/a": { approved_version: 1.4 } })).success).toBe(false);
  });

  it.each([
    ["an unknown record field", book({ "flow/a": { colour: "red" } })],
    ["an unknown top-level field", book({}, { extra: 1 })],
    ["a wrong version", { version: 2, components: {} }],
    ["no version", { components: {} }],
    ["an unknown kind", book({ "widget/a": {} })],
    ["a key with no slash", book({ flow: {} })],
    ["a key with a space", book({ "flow/a b": {} })],
    ["a bad risk", book({ "flow/a": { risk: "extreme" } })],
    ["a bad lifecycle", book({ "flow/a": { lifecycle: "gone" } })],
    ["an impossible date", book({ "flow/a": { last_review: "2026-02-30" } })],
    ["a date in another format", book({ "flow/a": { last_review: "10/01/2026" } })],
    ["an owner with a space", book({ "flow/a": { owner: "a b" } })],
    ["an owner with a newline", book({ "flow/a": { owner: "a\nb" } })],
    ["a null value", book({ "flow/a": { owner: null } })],
  ])("refuses %s", (_n, value) => {
    expect(parse(value).success).toBe(false);
  });
});

describe("governance defaults and status", () => {
  it("gives risk low and lifecycle active, and nothing else", () => {
    expect(governanceProfile(undefined)).toEqual({ risk: "low", lifecycle: "active" });
    expect(governanceProfile({ owner: "me" })).toEqual({ owner: "me", risk: "low", lifecycle: "active" });
    expect(governanceProfile({ risk: "high" })).toEqual({ risk: "high", lifecycle: "active" });
  });

  const rec = (r: GovernanceRecord = {}): GovernanceRecord => ({ approved_version: "3", last_review: day(10), ...r });
  it("returns each of the four values", () => {
    expect(governanceStatus({ version: "3" }, rec(), NOW)).toBe("ok");
    expect(governanceStatus({ version: "3" }, rec({ lifecycle: "retired" }), NOW)).toBe("retired");
    expect(governanceStatus({ version: "3" }, undefined, NOW)).toBe("unapproved");
    expect(governanceStatus({ version: "3" }, rec({ last_review: day(400) }), NOW)).toBe("review-due");
  });

  it("lets retired beat unapproved and an old review", () => {
    expect(governanceStatus({ version: "9" }, { lifecycle: "retired", last_review: day(900) }, NOW)).toBe("retired");
  });

  it("is unapproved when unset, different, or the component has no version", () => {
    expect(governanceStatus({ version: "3" }, { last_review: day(1) }, NOW)).toBe("unapproved");
    expect(governanceStatus({ version: "4" }, rec(), NOW)).toBe("unapproved");
    expect(governanceStatus({}, rec(), NOW)).toBe("unapproved");
  });

  it("is due with no review and at 366 days, not at 365", () => {
    expect(governanceStatus({ version: "3" }, { approved_version: "3" }, NOW)).toBe("review-due");
    expect(governanceStatus({ version: "3" }, rec({ last_review: day(365) }), NOW)).toBe("ok");
    expect(governanceStatus({ version: "3" }, rec({ last_review: day(366) }), NOW)).toBe("review-due");
  });

  it("treats draft and deprecated like active", () => {
    for (const lifecycle of ["draft", "deprecated"] as const) {
      expect(governanceStatus({ version: "3" }, rec({ lifecycle }), NOW)).toBe("ok");
      expect(governanceStatus({ version: "3" }, rec({ lifecycle, last_review: day(366) }), NOW)).toBe("review-due");
    }
  });
});

describe("readGovernanceBook", () => {
  it("gives an empty book for a missing folder and a missing file, and writes nothing", () => {
    expect(readGovernanceBook(home)).toEqual({ ok: true, book: { version: 1, components: {} } });
    mkdirSync(join(home, "promotions"));
    expect(readGovernanceBook(home).ok).toBe(true);
    expect(tree()).toEqual(["promotions/"]);
  });

  const NOT_VALID = "promotions/governance.yaml is not valid; no record was used, fix it";
  const reason = () => {
    const r = readGovernanceBook(home);
    return r.ok ? undefined : r.reason;
  };

  it.each([
    ["broken YAML", "a: [SECRET"],
    ["a bad field", "version: 1\ncomponents:\n  flow/a:\n    risk: SECRET\n"],
    ["a duplicate key", "version: 1\ncomponents:\n  flow/a: {}\n  flow/a: {}\nSECRET: 1\n"],
    ["an empty file", ""],
    ["an unresolved tag", "version: 1\ncomponents: !foo SECRET\n"],
  ])("gives one fixed reason for %s, without the value or the path", (_n, text) => {
    gov(text);
    expect(reason()).toBe(NOT_VALID);
    expect(readFileSync(join(home, "promotions/governance.yaml"), "utf8")).toBe(text);
  });

  it("refuses a link, a folder and a large file", () => {
    mkdirSync(join(home, "promotions"));
    writeFileSync(join(home, "real.yaml"), "version: 1\ncomponents: {}\n");
    symlinkSync(join(home, "real.yaml"), join(home, "promotions/governance.yaml"));
    expect(reason()).toBe("promotions/governance.yaml is a link or not a plain file");
    rmSync(join(home, "promotions/governance.yaml"));
    mkdirSync(join(home, "promotions/governance.yaml"));
    expect(reason()).toBe("promotions/governance.yaml is a link or not a plain file");
    rmSync(join(home, "promotions/governance.yaml"), { recursive: true });
    gov("#".repeat(MAX_GOVERNANCE_BYTES + 1));
    expect(reason()).toBe("promotions/governance.yaml is larger than 1 MiB");
    gov("version: 1\ncomponents: {}\n" + "#".repeat(MAX_GOVERNANCE_BYTES - 26));
    expect(readGovernanceBook(home).ok).toBe(true);
  });

  it("refuses a linked promotions folder", () => {
    const real = join(home, "..", "elsewhere");
    mkdirSync(real);
    symlinkSync(real, join(home, "promotions"));
    expect(reason()).toBe("promotions is a link or not a folder");
  });
});

describe("governanceOrphans", () => {
  const b = (...keys: string[]) => ({ version: 1 as const, components: Object.fromEntries(keys.map((k) => [k, {}])) });
  const found = [{ kind: "flow" as const, id: "a" }];
  const all = ["flow", "tool-profile"] as const;

  it("names records with no component, only for the listed kinds", () => {
    expect(governanceOrphans(b("flow/a", "flow/gone", "tool-profile/gone"), found, [], ["flow"])).toEqual([{ kind: "flow", id: "gone", reason: "governance record names no component" }]);
  });

  it("does not call a component that failed to load an orphan", () => {
    expect(governanceOrphans(b("tool-profile/bad"), [], [{ kind: "tool-profile", id: "bad", reason: "x" }], all)).toEqual([]);
  });

  it("skips a kind whose folder failed, but not for a bad file name", () => {
    expect(governanceOrphans(b("tool-profile/gone"), [], [{ kind: "tool-profile", id: "(tool-profiles)", reason: "x" }], all)).toEqual([]);
    expect(governanceOrphans(b("tool-profile/gone"), [], [{ kind: "tool-profile", id: "(file)", reason: "x" }], all)).toHaveLength(1);
  });
});

describe("scf components with governance records", () => {
  const GOV = " owner=- risk=low lifecycle=active status=unapproved";

  it("shows the values of a record on the right line", () => {
    gov(stringify(book({ "flow/base": { owner: "team", risk: "high", approved_version: 0, last_review: day(5) }, "model-routes/default": { lifecycle: "retired" } })));
    const { code, lines } = run();
    expect(code).toBe(0);
    expect(lines[0]).toMatch(/ builtin owner=team risk=high lifecycle=active status=ok$/);
    expect(lines[2]).toMatch(/ unrecorded owner=- risk=low lifecycle=retired status=retired$/);
  });

  it("applies a record to a policy pack", () => {
    gov(stringify(book({ "policy-pack/foundry.baseline": { owner: "sec" } })));
    expect(run(["policy-pack"]).lines[0]).toMatch(/ owner=sec risk=low /);
  });

  it("uses one record for a home flow and a built-in flow of the same id", () => {
    put("flows/base.yaml", FLOW.replace("demo", "base").replace("echo one", "echo home"));
    gov(stringify(book({ "flow/base": { owner: "team" } })));
    const lines = run(["flow"]).lines;
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(l).toContain(" owner=team ");
  });

  it("prints defaults and keeps the exit code when there is no file", () => {
    const { code, lines } = run();
    expect(code).toBe(0);
    for (const l of lines) expect(l.endsWith(GOV)).toBe(true);
    expect(tree()).toEqual([]);
  });

  it("prints one line for a bad file, lists everything with defaults, and exits 1", () => {
    gov("a: [SECRET");
    const { code, lines } = run();
    expect(code).toBe(1);
    expect(lines).toHaveLength(4);
    expect(lines.slice(0, 3).every((l) => l.endsWith(GOV))).toBe(true);
    expect(lines[3]).toBe("! promotions/governance.yaml is not valid; no record was used, fix it");
    expect(lines.join("\n")).not.toContain("SECRET");
    expect(lines.join("\n")).not.toContain(home);
  });

  it("reports a record that names nothing, and only for the listed kinds", () => {
    gov(stringify(book({ "flow/gone": {} })));
    const all = run();
    expect(all.code).toBe(1);
    expect(all.lines).toContain("! flow gone: governance record names no component");
    const other = run(["tool-profile"]);
    expect(other.code).toBe(0);
    expect(other.lines.join("\n")).not.toContain("gone");
  });

  it("does not call an unloadable component an orphan, nor hide orphans behind a bad file name", () => {
    put("tool-profiles/bad.yaml", "not: a profile");
    gov(stringify(book({ "tool-profile/bad": {}, "tool-profile/gone": {} })));
    let lines = run(["tool-profile"]).lines;
    expect(lines).toContain("! tool-profile gone: governance record names no component");
    expect(lines.filter((l) => l.includes("names no component"))).toHaveLength(1);
    put("tool-profiles/Bad Id.yaml", JSON.stringify(profile("x")));
    lines = run(["tool-profile"]).lines;
    expect(lines).toContain("! tool-profile gone: governance record names no component");
  });

  it("gives no orphans when a folder cannot be listed", () => {
    const real = join(home, "..", "elsewhere");
    mkdirSync(real);
    symlinkSync(real, join(home, "tool-profiles"));
    gov(stringify(book({ "tool-profile/gone": {} })));
    expect(run(["tool-profile"]).lines.join("\n")).not.toContain("names no component");
  });

  it("never changes a hash, a version or the version book", () => {
    put("tool-profiles/p.yaml", stringify(profile("p")));
    run(["record"]);
    const versions = readFileSync(join(home, "promotions/versions.json"), "utf8");
    const key = (l: string) => l.split(" ").slice(0, 5).join(" ");
    const before = run().lines.map(key);
    gov(stringify(book({ "tool-profile/p": { owner: "team", approved_version: 1 }, "flow/base": { risk: "high" } })));
    expect(run().lines.map(key)).toEqual(before);
    gov(stringify(book({ "tool-profile/p": { owner: "other", risk: "medium" } })));
    expect(run().lines.map(key)).toEqual(before);
    expect(run(["record"]).lines.map(key)).toEqual(before);
    expect(readFileSync(join(home, "promotions/versions.json"), "utf8")).toBe(versions);
  });
});

describe("listGoverned and componentsView", () => {
  const list = (o: Parameters<typeof listGoverned>[0] = {}) => listGoverned({ builtinFlowsDir: builtin, now: NOW, ...o });
  const keys = ["kind", "id", "builtin", "version", "owner", "risk", "lifecycle", "approvedVersion", "lastReview", "evalSuite", "status"];

  it("gives rows in the order of `scf components`, and honours kinds", () => {
    put("tool-profiles/p.yaml", stringify(profile("p")));
    const l = list();
    const lines = run().lines.filter((x) => !x.startsWith("!"));
    expect(l.rows.map((r) => r.component.id)).toEqual(lines.map((x) => x.split(" ")[2]));
    expect(l.rows.find((r) => r.component.id === "base")?.mark).toBe("builtin");
    expect(l.rows.find((r) => r.component.id === "p")?.mark).toBe("unrecorded");
    expect(list({ kinds: ["tool-profile"] }).rows.map((r) => r.component.kind)).toEqual(["tool-profile"]);
  });

  it("writes nothing by default, and the version book when record is true", () => {
    put("tool-profiles/p.yaml", stringify(profile("p")));
    const before = tree();
    list();
    expect(tree()).toEqual(before);
    const l = list({ record: true });
    expect(tree()).toContain("promotions/versions.json");
    expect(l.rows.find((r) => r.component.id === "p")?.component.version).toBe("1");
  });

  it("keeps a counted component as a row with a fixed reason when the version book is bad", () => {
    put("tool-profiles/p.yaml", stringify(profile("p")));
    put("promotions/versions.json", "not json SECRET");
    const l = list();
    expect(l.rows.find((r) => r.component.id === "p")?.versionFailed).toBe(true);
    expect(l.rows.some((r) => r.component.kind === "flow")).toBe(true);
    const reason = l.problems.find((x) => x.id === "p")?.reason;
    expect(reason).toBeTruthy();
    expect(reason).not.toContain("SECRET");
    const view = componentsView(l);
    expect(view.components.find((c) => c.id === "p")).toMatchObject({ version: null, status: "unapproved" });
    expect(view.problems.find((x) => x.id === "p")?.reason).toBe(reason);
    expect(run().lines.filter((x) => !x.startsWith("!")).join("\n")).not.toContain("tool-profile p");
  });

  it("gives a book problem and default rows for a bad governance file", () => {
    gov("a: [SECRET");
    const l = list();
    expect(l.bookProblem).toBe("promotions/governance.yaml is not valid; no record was used, fix it");
    expect(l.rows.every((r) => r.record === undefined)).toBe(true);
  });

  it("lists an orphan record as a problem", () => {
    gov(stringify(book({ "flow/gone": {} })));
    expect(list().problems).toContainEqual({ kind: "flow", id: "gone", reason: "governance record names no component" });
  });

  it("maps a full record", () => {
    gov(stringify(book({ "flow/base": { owner: "team", risk: "high", lifecycle: "deprecated", approved_version: "0", last_review: day(3), eval_suite: "timeout" } })));
    const row = componentsView(list()).components.find((c) => c.id === "base");
    expect(row).toEqual({ kind: "flow", id: "base", builtin: true, version: "0", owner: "team", risk: "high", lifecycle: "deprecated", approvedVersion: "0", lastReview: day(3), evalSuite: "timeout", status: "ok" });
  });

  it("gives null for no record, fixed keys, and no hash", () => {
    const v = componentsView(list());
    expect(v.components.length).toBeGreaterThan(0);
    for (const c of v.components) expect(Object.keys(c)).toEqual(keys);
    expect(v.components[0]).toMatchObject({ owner: null, risk: "low", lifecycle: "active", approvedVersion: null, lastReview: null, evalSuite: null, status: "unapproved" });
    expect(typeof v.components[0]!.builtin).toBe("boolean");
    expect(JSON.stringify(v)).not.toContain("sha256");
    expect("governanceProblem" in v).toBe(false);
  });

  it("holds only kind, id and reason in a problem, and the governance problem only when set", () => {
    put("tool-profiles/bad.yaml", "not: a profile");
    gov("a: [");
    const v = componentsView(list());
    expect(v.problems.length).toBeGreaterThan(0);
    for (const p of v.problems) expect(Object.keys(p).sort()).toEqual(["id", "kind", "reason"]);
    expect(v.governanceProblem).toContain("promotions/governance.yaml");
  });
});
