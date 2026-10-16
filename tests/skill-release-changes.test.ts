import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { skillsCommand } from "../src/skills/cli.js";
import { catalogueChangeLines, catalogueChanges, catalogueChangesMarkdown, releaseEntry } from "../src/skills/release-changes.js";
import { releaseOperandsProblem } from "../src/skills/release-cli.js";
import type { ReleaseManifestV2 } from "../src/skills/release.js";
import type { SkillPackage } from "../src/skills/schema.js";
import { writeV2Release } from "./helpers/skill-release-v2.js";

interface S { id: string; version?: string; digest?: string; caps?: string[]; revoked?: boolean; risk?: "low" | "high" }
const REASON = "REASON-MARKER";
const TEXT = "BODY-MARKER";
const dig = (id: string, v: string) => `sha256:${id}-${v}`;

/** A manifest and the matching packages of one release. */
function rel(version: string, skills: S[]) {
  const m = {
    schema: 2, catalogue: "cat", version, createdAt: "2026-01-02T03:04:05Z", source: { repository: "github.com/a/b", commit: "a".repeat(40) },
    skills: skills.map((s) => ({
      id: s.id, version: s.version ?? "1.0.0", digest: s.digest ?? dig(s.id, s.version ?? "1.0.0"), files: [], provenance: {}, licences: [], attribution: [], evaluation: {},
      ...(s.revoked ? { revoked: { on: "2026-03-01", reason: REASON } } : {}),
    })),
  } as unknown as ReleaseManifestV2;
  const packages = skills.map((s) => {
    const v = s.version ?? "1.0.0";
    const pkg = { id: s.id, version: v, digest: s.digest ?? dig(s.id, v), capabilities: s.caps ?? [], category: "general", risk: s.risk ?? "low", description: TEXT, instructions: TEXT } as unknown as SkillPackage;
    return releaseEntry(pkg, { catalogue: "cat", version });
  });
  return { m, packages };
}
const diff = (o: S[] | undefined, n: S[], highRisk: string[] = []) => {
  const a = o ? rel("1.0.0", o) : undefined;
  const b = rel("1.1.0", n);
  return catalogueChanges(a?.m, b.m, { old: a?.packages ?? [], next: b.packages }, { highRisk });
};
const ids = (l: { id: string }[]) => l.map((x) => x.id);

describe("catalogueChanges", () => {
  it("lists added, removed and changed skills", () => {
    const c = diff([{ id: "a" }, { id: "b" }, { id: "c" }], [{ id: "b" }, { id: "c", version: "2.0.0" }, { id: "d" }]);
    expect(ids(c.added)).toEqual(["d"]);
    expect(ids(c.removed)).toEqual(["a"]);
    expect(c.changed).toEqual([{ id: "c", old: { version: "1.0.0", digest: dig("c", "1.0.0") }, next: { version: "2.0.0", digest: dig("c", "2.0.0") } }]);
    expect(c.from).toEqual({ version: "1.0.0" });
  });
  it("lists a skill whose digest alone differs", () => {
    const c = diff([{ id: "a" }], [{ id: "a", digest: "sha256:other" }]);
    expect(c.changed.map((x) => x.id)).toEqual(["a"]);
  });
  it("lists skills revoked in the new release, also when revoked before", () => {
    const c = diff([{ id: "a" }, { id: "b", revoked: true }, { id: "c", revoked: true }], [{ id: "a", revoked: true }, { id: "b", revoked: true }, { id: "c" }]);
    expect(c.deprecated.map((d) => [d.id, d.alreadyRevoked, d.on, d.reason])).toEqual([["a", false, "2026-03-01", REASON], ["b", true, "2026-03-01", REASON]]);
  });
  it("treats everything as added without an old release", () => {
    const c = diff(undefined, [{ id: "a", caps: ["x"] }, { id: "b", caps: ["x"] }]);
    expect(ids(c.added)).toEqual(["a", "b"]);
    expect(c.removed).toEqual([]);
    expect(c.changed).toEqual([]);
    expect(c.from).toBeUndefined();
    expect(c.canonical).toEqual([{ capability: "x", old: { outcome: "none" }, next: { outcome: "selected", winner: { id: "a", version: "1.0.0", digest: dig("a", "1.0.0") } } }]);
  });
  it("lists a capability whose winner changed", () => {
    const both = [{ id: "a", caps: ["x"] }, { id: "b", caps: ["x"] }];
    const c = diff(both, [{ id: "a", caps: ["x"], revoked: true }, { id: "b", caps: ["x"] }]);
    expect(c.canonical.map((x) => [x.capability, x.old.winner?.id, x.next.winner?.id])).toEqual([["x", "a", "b"]]);
  });
  it("does not list a capability with a single provider and the same winner", () => {
    const c = diff([{ id: "a", caps: ["x", "solo"] }, { id: "b", caps: ["x"] }], [{ id: "a", caps: ["x", "solo"] }, { id: "b", caps: ["x"] }, { id: "c" }]);
    expect(c.canonical).toEqual([]);
  });
  it("lists a capability whose winner has a new version or digest", () => {
    const o = [{ id: "a", caps: ["x"] }, { id: "b", caps: ["x"] }];
    const v = diff(o, [{ id: "a", version: "2.0.0", caps: ["x"] }, { id: "b", caps: ["x"] }]);
    expect(v.canonical.map((x) => [x.old.winner?.version, x.next.winner?.version])).toEqual([["1.0.0", "2.0.0"]]);
    const d = diff(o, [{ id: "a", digest: "sha256:other", caps: ["x"] }, { id: "b", caps: ["x"] }]);
    expect(d.canonical.map((x) => [x.old.winner?.digest, x.next.winner?.digest])).toEqual([[dig("a", "1.0.0"), "sha256:other"]]);
  });
  it("compares a capability that two packages provided in the old release only", () => {
    const c = diff([{ id: "b", caps: ["x"] }, { id: "c", caps: ["x"] }], [{ id: "c", caps: ["x"] }]);
    expect(c.canonical.map((x) => [x.old.winner?.id, x.next.winner?.id])).toEqual([["b", "c"]]);
  });
  it("shows a high-risk tie as a conflict", () => {
    const o = [{ id: "a", caps: ["payments"] }];
    const n = [{ id: "a", caps: ["payments"] }, { id: "b", caps: ["payments"] }];
    const c = diff(o, n, ["payments"]);
    expect(c.canonical).toHaveLength(1);
    expect(c.canonical[0]!.next).toEqual({ outcome: "conflict", conflict: "tie" });
    expect(diff(o, n).canonical).toEqual([]);
  });
  it("applies the winners-overlap rule across capabilities", () => {
    const c = diff(undefined, [{ id: "s1", caps: ["x", "y"] }, { id: "s2", caps: ["x"] }, { id: "s3", caps: ["y", "z"] }]);
    const next = Object.fromEntries(c.canonical.map((x) => [x.capability, x.next.winner?.id ?? x.next.conflict]));
    expect(next).toEqual({ x: "s2", y: "winners-overlap" });
  });
  it("compares more than 200 capabilities, with winners-overlap across the whole scope", () => {
    const cap = (i: number) => `cap-${String(i).padStart(3, "0")}`;
    // 15 skills with 32 capabilities each, 16 apart: 224 capabilities have two providers and form one group.
    const skills = Array.from({ length: 15 }, (_, i) => ({ id: `s${String(i).padStart(2, "0")}`, caps: Array.from({ length: 32 }, (_, j) => cap(16 * i + j)) }));
    const c = diff(undefined, skills);
    expect(c.canonical).toHaveLength(224);
    // s00 wins cap-016..cap-031 and provides nothing else in scope; every other winner loses a capability it also provides.
    const selected = c.canonical.filter((x) => x.next.outcome === "selected");
    expect(selected.map((x) => x.next.winner!.id)).toEqual(Array(16).fill("s00"));
    expect(c.canonical.filter((x) => x.next.conflict === "winners-overlap")).toHaveLength(208);
  });
  it("gives the same result for any order and leaves the input alone", () => {
    const o = [{ id: "a", caps: ["x"] }, { id: "b", caps: ["x"] }, { id: "c" }];
    const n = [{ id: "a", caps: ["x"], revoked: true }, { id: "b", caps: ["x"] }, { id: "d" }];
    const a = rel("1.0.0", o);
    const b = rel("1.1.0", n);
    const r = rel("1.0.0", [...o].reverse());
    const q = rel("1.1.0", [...n].reverse());
    const deep = (x: unknown): void => {
      if (x && typeof x === "object") for (const v of Object.values(x)) deep(v);
      Object.freeze(x);
    };
    deep(a);
    deep(b);
    expect(catalogueChanges(r.m, q.m, { old: r.packages, next: q.packages })).toEqual(catalogueChanges(a.m, b.m, { old: a.packages, next: b.packages }));
  });
  it("throws when a package is missing or has another digest", () => {
    const a = rel("1.0.0", [{ id: "a" }]);
    const b = rel("1.1.0", [{ id: "a" }, { id: "b" }]);
    expect(() => catalogueChanges(a.m, b.m, { old: a.packages, next: b.packages.slice(0, 1) })).toThrow(/b@1\.0\.0/);
    const other = rel("1.1.0", [{ id: "a" }, { id: "b", digest: "sha256:zzz" }]);
    expect(() => catalogueChanges(a.m, b.m, { old: a.packages, next: other.packages })).toThrow(TypeError);
  });
});

describe("catalogueChangeLines", () => {
  it("prints one line per change in a fixed order", () => {
    const c = diff(
      [{ id: "a" }, { id: "b" }, { id: "r", revoked: true }, { id: "p", caps: ["payments"] }, { id: "q", caps: ["x"] }, { id: "w", caps: ["x"] }],
      [{ id: "b", version: "1.0.1" }, { id: "r", revoked: true }, { id: "p", caps: ["payments"] }, { id: "p2", caps: ["payments"] }, { id: "q", caps: ["x"], revoked: true }, { id: "w", caps: ["x"], revoked: true }, { id: "n" }],
      ["payments"],
    );
    expect(catalogueChangeLines(c)).toEqual([
      `ADDED n@1.0.0 ${dig("n", "1.0.0")}`,
      `ADDED p2@1.0.0 ${dig("p2", "1.0.0")}`,
      `REMOVED a@1.0.0 ${dig("a", "1.0.0")}`,
      `CHANGED b 1.0.0 ${dig("b", "1.0.0")} -> 1.0.1 ${dig("b", "1.0.1")}`,
      `DEPRECATED q@1.0.0 ${dig("q", "1.0.0")} revoked 2026-03-01: ${REASON}`,
      `DEPRECATED r@1.0.0 ${dig("r", "1.0.0")} revoked 2026-03-01: ${REASON} (already revoked)`,
      `DEPRECATED w@1.0.0 ${dig("w", "1.0.0")} revoked 2026-03-01: ${REASON}`,
      "CANONICAL payments p@1.0.0 -> conflict:tie",
      "CANONICAL x q@1.0.0 -> none",
    ]);
  });
});

describe("catalogueChangesMarkdown", () => {
  it("shows ids, versions and digests but no text or reason", () => {
    const c = diff([{ id: "a" }, { id: "x1", caps: ["x"] }], [{ id: "b" }, { id: "x1", caps: ["x"], revoked: true }]);
    const md = catalogueChangesMarkdown(c);
    expect(md).toContain("`b@1.0.0`");
    expect(md).toContain(dig("b", "1.0.0"));
    expect(md).toContain("### Deprecated");
    expect(md).not.toContain(REASON);
    expect(md).not.toContain(TEXT);
  });
  it("says so when nothing changed", () => {
    expect(catalogueChangesMarkdown(diff([{ id: "a" }], [{ id: "a" }]))).toContain("No changes.");
  });
  it("never goes over the byte limit, and ends a long list with a count", () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ id: `s${i}` }));
    const c = diff([], many);
    const md = catalogueChangesMarkdown(c, { bytes: 2000 });
    expect(Buffer.byteLength(md)).toBeLessThanOrEqual(2000);
    expect(md).toMatch(/- … and \d+ more/);
  });
  it("keeps to any limit, also with all five sections", () => {
    const o = [{ id: "a" }, { id: "b" }, { id: "p", caps: ["x"] }, { id: "q", caps: ["x"] }];
    const n = [{ id: "b", version: "2.0.0" }, { id: "c" }, { id: "p", caps: ["x"], revoked: true }, { id: "q", caps: ["x"] }];
    const c = diff(o, n);
    expect(c.added.length && c.removed.length && c.changed.length && c.deprecated.length && c.canonical.length).toBeTruthy();
    for (const bytes of [0, 1, 10, 100, 999, 1000, 5000]) {
      const md = catalogueChangesMarkdown(c, { bytes });
      expect(Buffer.byteLength(md)).toBeLessThanOrEqual(bytes);
    }
    const full = catalogueChangesMarkdown(c, { bytes: 5000 });
    for (const t of ["### Added", "### Removed", "### Changed", "### Deprecated", "### Canonical skills"]) expect(full).toContain(t);
    expect(catalogueChangesMarkdown(c, { bytes: 0 })).toBe("");
  });
});

describe("releaseOperandsProblem diff", () => {
  it("accepts two releases of one catalogue", () => {
    expect(releaseOperandsProblem(["diff", "a@1.0.0", "a@1.1.0"])).toBeUndefined();
    for (const bad of [["diff", "a@1.0.0", "b@1.1.0"], ["diff", "a@1.0.0"], ["diff", "a@1.0.0", "nope"], ["diff", "a@1.0.0", "a@1.1.0", "a@1.2.0"]]) {
      expect(releaseOperandsProblem(bad)).toMatch(/release diff: expects/);
    }
    expect(releaseOperandsProblem(["list"])).toBeUndefined();
    expect(releaseOperandsProblem(["publish", "a@1.0.0"])).toBeUndefined();
    expect(releaseOperandsProblem(["bogus"])).toContain('"list"');
  });
});

describe("scf skills release diff", () => {
  let base: string;
  let home: string;
  let n = 0;
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "reldiff-")));
    home = join(base, "home");
    mkdirSync(home);
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  function store(version: string, skills: Record<string, { v: string; caps?: string[] }>, revoked: Record<string, { on: string; reason: string }> = {}): void {
    const scratch = join(base, `scratch-${n++}`);
    for (const [id, s] of Object.entries(skills)) {
      const d = join(scratch, id);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "SKILL.md"), `---\nname: ${id}\ndescription: A test skill called ${id}.\n---\n\nDo it.\n`);
      writeFileSync(join(d, "skill.yaml"), `id: ${id}\nversion: ${s.v}\n${s.caps ? `capabilities: [${s.caps.join(", ")}]\n` : ""}`);
    }
    writeV2Release(scratch, { catalogue: "acme-skills", version, revoked });
    const dest = join(home, "skill-releases", "acme-skills", version);
    mkdirSync(join(dest, ".."), { recursive: true });
    cpSync(scratch, dest, { recursive: true });
  }
  const run = async (...operands: string[]) => {
    const lines: string[] = [];
    const skills = ConfigSchema.parse({ skills: { roots: [] } }).skills;
    const code = await skillsCommand({ positionals: ["release", "diff", ...operands], values: {} }, (l) => void lines.push(l), { home, builtinRoot: join(base, "builtin"), userHome: join(base, "user"), env: {}, skills });
    return { code, lines };
  };

  it("prints every kind of change, the same way twice", async () => {
    store("1.0.0", { a: { v: "1.0.0", caps: ["x"] }, b: { v: "1.0.0", caps: ["x"] }, c: { v: "1.0.0" } });
    store("1.1.0", { b: { v: "1.0.1", caps: ["x"] }, c: { v: "1.1.0" }, d: { v: "1.0.0" } }, { b: { on: "2026-03-01", reason: "bad" } });
    const first = await run("acme-skills@1.0.0", "acme-skills@1.1.0");
    expect(first.code).toBe(0);
    const kinds = first.lines.map((l) => l.split(" ")[0]);
    expect(kinds).toEqual(["ADDED", "REMOVED", "CHANGED", "CHANGED", "DEPRECATED", "CANONICAL", "DIFF"]);
    expect(first.lines[0]).toMatch(/^ADDED d@1\.0\.0 sha256:/);
    expect(first.lines[1]).toMatch(/^REMOVED a@1\.0\.0 /);
    expect(first.lines[4]).toMatch(/^DEPRECATED b@1\.0\.1 sha256:[0-9a-f]+ revoked 2026-03-01: bad$/);
    expect(first.lines[5]).toBe("CANONICAL x a@1.0.0 -> none");
    expect(first.lines[6]).toMatch(/^DIFF acme-skills@1\.0\.0 sha256:\S+ -> acme-skills@1\.1\.0 sha256:\S+: 6 changes$/);
    expect(await run("acme-skills@1.0.0", "acme-skills@1.1.0")).toEqual(first);
  });
  it("reports a release that is not stored", async () => {
    store("1.0.0", { a: { v: "1.0.0" } });
    const r = await run("acme-skills@1.0.0", "acme-skills@9.9.9");
    expect(r.code).toBe(1);
    expect(r.lines).toEqual(["PROBLEM release acme-skills@9.9.9 is not in the release store"]);
  });
  it("reports a stored release that was changed", async () => {
    store("1.0.0", { a: { v: "1.0.0" } });
    store("1.1.0", { a: { v: "1.1.0" } });
    writeFileSync(join(home, "skill-releases", "acme-skills", "1.1.0", "a", "SKILL.md"), "changed\n");
    const r = await run("acme-skills@1.0.0", "acme-skills@1.1.0");
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/^PROBLEM release acme-skills@1\.1\.0 invalid: /);
  });
});
