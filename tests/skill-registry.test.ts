import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import {
  BUILTIN_SKILLS,
  MAX_SKILLS_PER_ROOT,
  cachedSkillRegistry,
  clearSkillRegistryCache,
  discoverSkills,
  findSkill,
  personalAgentPath,
  pinBuiltinSkills,
  pinBuiltinSkillsAtStart,
  pinSkill,
  selectSkill,
  SkillIntegrityError,
  type SkillRegistry,
} from "../src/skills/registry.js";
import { readSkillLock, removeSkillPin } from "../src/skills/lock.js";

const tmps: string[] = [];
const modes: [string, number][] = [];
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "skillreg-")));
  tmps.push(d);
  return d;
};
afterEach(() => {
  for (const [p, m] of modes.splice(0)) chmodSync(p, m);
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
  clearSkillRegistryCache();
});

/** Writes a valid package; the folder is named like the id unless `dir` is given. */
function pkg(root: string, id: string, version = "1.0.0", dir = id): string {
  const d = join(root, dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), `---\nname: ${id}\ndescription: A test skill called ${id}.\n---\n\nDo it.\n`);
  writeFileSync(join(d, "skill.yaml"), `id: ${id}\nversion: ${version}\n`);
  return d;
}

interface Env { home: string; builtin: string; userHome: string; root: (n: number) => string }
function setup(): Env {
  const base = tmp();
  const home = join(base, "home");
  const builtin = join(base, "builtin");
  const userHome = join(base, "user");
  for (const d of [home, builtin, userHome]) mkdirSync(d);
  return { home, builtin, userHome, root: (n) => join(base, `root${n}`) };
}
const cfg = (over: Record<string, unknown> = {}) => ConfigSchema.parse({ skills: over }).skills;
const run = (e: Env, over: Record<string, unknown> = {}, extra: { repo?: string; env?: NodeJS.ProcessEnv } = {}): SkillRegistry =>
  discoverSkills(cfg(over), { home: e.home, builtinRoot: e.builtin, userHome: e.userHome, env: {}, ...extra });
const keys = (r: SkillRegistry) => r.skills.map((s) => `${s.key}@${s.label}`);
const kinds = (r: SkillRegistry) => r.problems.map((p) => p.kind);

describe("built-in skills", () => {
  it("the shipped folder loads without problems and is in the package", () => {
    const reg = discoverSkills(cfg(), { home: tmp(), env: {}, userHome: tmp() });
    expect(reg.problems).toEqual([]);
    expect(findSkill(reg, "small-changes")?.label).toBe("built-in");
    expect(findSkill(reg, "java")?.label).toBe("built-in");
    expect(findSkill(reg, "typescript")?.label).toBe("built-in");
    expect(existsSync(join(BUILTIN_SKILLS, "typescript", "REVIEW.md"))).toBe(true);
    expect(BUILTIN_SKILLS.endsWith("skills")).toBe(true);
    expect(JSON.parse(readFileSync("package.json", "utf8")).files).toContain("skills");
    expect(existsSync(join(BUILTIN_SKILLS, "small-changes", "SKILL.md"))).toBe(true);
    expect(existsSync(join(BUILTIN_SKILLS, "java", "SKILL.md"))).toBe(true);
  });

  it("builtin: false leaves the source out without a problem", () => {
    const e = setup();
    pkg(e.builtin, "one");
    const reg = run(e, { builtin: false });
    expect(reg.skills).toEqual([]);
    expect(reg.sources.map((s) => s.label)).toEqual(["data folder"]);
    expect(reg.problems).toEqual([]);
  });
});

describe("administrator sources", () => {
  it("lists packages of the data folder and the configured roots, ordered and repeatable", () => {
    const e = setup();
    pkg(join(e.home, "skills"), "zeta");
    pkg(e.root(0), "alpha");
    mkdirSync(e.root(0), { recursive: true });
    const a = run(e, { roots: [e.root(0)] });
    expect(keys(a)).toEqual(["alpha@1.0.0@skills.roots[0]", "zeta@1.0.0@data folder"]);
    expect(a.byKey.get("zeta@1.0.0")?.label).toBe("data folder");
    expect(run(e, { roots: [e.root(0)] })).toEqual(a);
  });

  it("a missing configured root is a problem that names the root, not the path", () => {
    const e = setup();
    const reg = run(e, { roots: [e.root(0)] });
    expect(reg.problems).toHaveLength(1);
    expect(reg.problems[0]).toMatchObject({ kind: "root-missing", label: "skills.roots[0]", root: "skills.roots[0]" });
    expect(JSON.stringify(reg.problems)).not.toContain(e.root(0));
  });

  it("a missing data folder is not a problem", () => {
    const e = setup();
    const reg = run(e);
    expect(reg.problems).toEqual([]);
    expect(reg.sources[0]).toMatchObject({ label: "data folder", status: "missing" });
  });

  it("a root that is a file is unreadable: not a folder", () => {
    const e = setup();
    writeFileSync(e.root(0), "x");
    const reg = run(e, { roots: [e.root(0)] });
    expect(reg.problems[0]).toMatchObject({ kind: "root-unreadable", reason: "not a folder" });
  });

  it.skipIf(process.getuid?.() === 0)("a root that cannot be read is unreadable and names the error", () => {
    const e = setup();
    mkdirSync(e.root(0));
    chmodSync(e.root(0), 0);
    modes.push([e.root(0), 0o700]);
    const reg = run(e, { roots: [e.root(0)] });
    expect(reg.problems[0]).toMatchObject({ kind: "root-unreadable", reason: "EACCES" });
  });

  it("an invalid package is a problem and a valid sibling is still listed", () => {
    const e = setup();
    const root = join(e.home, "skills");
    pkg(root, "good");
    pkg(root, "badver", "one");
    pkg(root, "named", "1.0.0", "other-name");
    const reg = run(e, { builtin: false });
    expect(keys(reg)).toEqual(["good@1.0.0@data folder"]);
    expect(kinds(reg)).toEqual(["invalid-package", "invalid-package"]);
    expect(reg.problems.map((p) => p.package)).toEqual(["badver", "other-name"]);
    expect(reg.problems.every((p) => p.issues?.length)).toBe(true);
  });

  it("a symbolic link to a package is a problem and is not loaded", () => {
    const e = setup();
    const root = join(e.home, "skills");
    mkdirSync(root);
    const target = pkg(tmp(), "linked");
    symlinkSync(target, join(root, "linked"));
    const reg = run(e, { builtin: false });
    expect(reg.skills).toEqual([]);
    expect(reg.problems[0]).toMatchObject({ kind: "invalid-package", package: "linked", reason: "symbolic link, not scanned" });
  });

  it("a folder name that looks like a credential is not shown in the problem", () => {
    const e = setup();
    const root = join(e.home, "skills");
    const token = "sk-" + "ant-" + "abcdefghij" + "0123456789";
    pkg(root, "safe", "1.0.0", token);
    symlinkSync(pkg(tmp(), "linked"), join(root, token + "b"));
    const reg = run(e, { builtin: false });
    expect(reg.skills).toEqual([]);
    expect(reg.problems).toHaveLength(2);
    expect(reg.problems[0]).toMatchObject({
      kind: "invalid-package",
      package: "(name not shown)",
      issues: [{ path: "(package)", reason: "the folder name looks like a credential (Anthropic key)" }],
    });
    expect(reg.problems[1]).toMatchObject({ package: "(name not shown)", reason: "symbolic link, not scanned" });
    expect(JSON.stringify(reg.problems)).not.toContain("abcdefghij");
  });

  it("skips stray files and hidden folders silently", () => {
    const e = setup();
    const root = join(e.home, "skills");
    pkg(root, "one");
    writeFileSync(join(root, "README.md"), "x");
    mkdirSync(join(root, ".git"));
    const reg = run(e, { builtin: false });
    expect(keys(reg)).toEqual(["one@1.0.0@data folder"]);
    expect(reg.problems).toEqual([]);
  });

  it("stops at too many folders in a root", () => {
    const e = setup();
    const root = join(e.home, "skills");
    mkdirSync(root);
    for (let i = 0; i <= MAX_SKILLS_PER_ROOT; i++) mkdirSync(join(root, `d${String(i).padStart(4, "0")}`));
    const reg = run(e, { builtin: false });
    expect(kinds(reg)).toContain("too-many");
    expect(reg.problems.filter((p) => p.kind === "invalid-package")).toHaveLength(MAX_SKILLS_PER_ROOT);
  });
});

describe("precedence", () => {
  it("the same id and version twice: the higher source stays, a duplicate problem names the other", () => {
    const e = setup();
    pkg(join(e.home, "skills"), "same");
    pkg(e.builtin, "same");
    const reg = run(e);
    expect(keys(reg)).toEqual(["same@1.0.0@data folder"]);
    expect(reg.problems).toHaveLength(1);
    expect(reg.problems[0]).toMatchObject({ kind: "duplicate", label: "built-in", package: "same" });
    expect(reg.problems[0]!.reason).toContain("data folder");
  });

  it("another version in a lower source is registered but shadowed", () => {
    const e = setup();
    pkg(join(e.home, "skills"), "multi", "2.0.0");
    pkg(e.builtin, "multi", "1.0.0");
    const reg = run(e);
    expect(reg.skills.map((s) => [s.key, s.active, s.shadowedBy])).toEqual([
      ["multi@2.0.0", true, undefined],
      ["multi@1.0.0", false, "multi@2.0.0"],
    ]);
    expect(reg.notes).toHaveLength(1);
    expect(reg.notes[0]).toMatchObject({ kind: "shadowed", label: "built-in", package: "multi" });
    expect(reg.problems).toEqual([]);
    expect(findSkill(reg, "multi")?.version).toBe("2.0.0");
    expect(findSkill(reg, "multi", "1.0.0")?.label).toBe("built-in");
    expect(findSkill(reg, "multi", "9.9.9")).toBeUndefined();
  });

  it("data folder beats roots[0], which beats roots[1], which beats built-in", () => {
    const e = setup();
    pkg(e.root(1), "p", "1.0.0");
    pkg(e.root(0), "p", "2.0.0");
    pkg(join(e.home, "skills"), "p", "3.0.0");
    pkg(e.builtin, "p", "4.0.0");
    const reg = run(e, { roots: [e.root(0), e.root(1)] });
    expect(reg.skills.map((s) => s.label)).toEqual(["data folder", "skills.roots[0]", "skills.roots[1]", "built-in"]);
    expect(reg.skills.filter((s) => s.active).map((s) => s.label)).toEqual(["data folder"]);
  });

  it("stops reading packages when the registry limit is reached", () => {
    const e = setup();
    const root = join(e.home, "skills");
    for (let i = 0; i < 3; i++) pkg(root, `p${i}`);
    const reg = discoverSkills(cfg({ builtin: false }), { home: e.home, userHome: e.userHome, env: {}, limits: { skills: 2 } });
    expect(reg.skills).toHaveLength(2);
    expect(kinds(reg)).toEqual(["too-many"]);
  });
});

describe("repository skills", () => {
  const withRepo = () => {
    const repo = tmp();
    return { repo, root: join(repo, ".claude-factory", "skills") };
  };

  it("are not read by default; a note says so", () => {
    const e = setup();
    const { repo, root } = withRepo();
    pkg(root, "mine");
    pkg(root, "broken", "x");
    const reg = run(e, { builtin: false }, { repo });
    expect(reg.skills).toEqual([]);
    expect(reg.problems).toEqual([]);
    expect(reg.sources.find((s) => s.kind === "repository")?.status).toBe("disabled");
    expect(reg.notes.map((n) => n.kind)).toEqual(["repository-disabled"]);
  });

  it("without a repository folder, no note", () => {
    const e = setup();
    const reg = run(e, { builtin: false }, { repo: tmp() });
    expect(reg.notes).toEqual([]);
  });

  it("when enabled are listed, report invalid ones, and never shadow an approved skill", () => {
    const e = setup();
    const { repo, root } = withRepo();
    pkg(root, "mine");
    pkg(root, "approved", "9.0.0");
    pkg(root, "broken", "x");
    pkg(e.builtin, "approved", "1.0.0");
    const reg = run(e, { repository: true }, { repo });
    expect(reg.byKey.get("mine@1.0.0")).toMatchObject({ source: "repository", active: true });
    expect(reg.byKey.get("approved@9.0.0")).toMatchObject({ active: false, shadowedBy: "approved@1.0.0" });
    expect(findSkill(reg, "approved")?.label).toBe("built-in");
    expect(reg.problems).toMatchObject([{ kind: "invalid-package", label: "repository", package: "broken" }]);
  });
});

describe("personal agent folders", () => {
  it("the config rejects them and relative paths", () => {
    for (const roots of [["/x/.claude/skills"], ["/x/.codex/skills"], ["rel/skills"]]) {
      expect(ConfigSchema.safeParse({ skills: { roots } }).success, roots[0]).toBe(false);
    }
    expect(ConfigSchema.safeParse({ skills: { roots: ["/x/.claude-factory/skills"] } }).success).toBe(true);
    expect(personalAgentPath("/x/.claude-factory/skills", {}, "/nowhere")).toBe(false);
  });

  it("a root that is a link into .claude is refused and nothing is loaded", () => {
    const e = setup();
    pkg(join(e.userHome, ".claude", "skills"), "secret");
    symlinkSync(join(e.userHome, ".claude", "skills"), e.root(0));
    const reg = run(e, { roots: [e.root(0)], builtin: false });
    expect(reg.skills).toEqual([]);
    expect(reg.problems[0]).toMatchObject({ kind: "root-refused", label: "skills.roots[0]" });
  });

  it("CLAUDE_CONFIG_DIR and CODEX_HOME are refused, also through a link and when nested", () => {
    const e = setup();
    const cc = join(tmp(), "cc");
    const ch = join(tmp(), "ch");
    pkg(join(cc, "skills"), "a");
    pkg(join(ch, "skills"), "b");
    const link = join(tmp(), "ln");
    symlinkSync(cc, link);
    const env = { CLAUDE_CONFIG_DIR: cc, CODEX_HOME: ch };
    const reg = run(e, { roots: [join(cc, "skills"), join(ch, "skills"), join(link, "skills")], builtin: false }, { env });
    expect(reg.skills).toEqual([]);
    expect(kinds(reg)).toEqual(["root-refused", "root-refused", "root-refused"]);
  });

  it("a symlinked environment folder is canonicalized too", () => {
    const e = setup();
    const real = join(tmp(), "real");
    pkg(join(real, "skills"), "a");
    const link = join(tmp(), "link");
    symlinkSync(real, link);
    const reg = run(e, { roots: [join(real, "skills")], builtin: false }, { env: { CODEX_HOME: link } });
    expect(kinds(reg)).toEqual(["root-refused"]);
  });

  it("a symlinked default ~/.codex is canonicalized", () => {
    const e = setup();
    const real = join(tmp(), "real");
    pkg(join(real, "skills"), "a");
    symlinkSync(real, join(e.userHome, ".codex"));
    const reg = run(e, { roots: [join(real, "skills")], builtin: false });
    expect(kinds(reg)).toEqual(["root-refused"]);
  });

  it("a sibling folder with the same prefix is not refused", () => {
    const e = setup();
    const cc = join(tmp(), "cc");
    pkg(join(cc + "-more", "skills"), "a");
    const reg = run(e, { roots: [join(cc + "-more", "skills")], builtin: false }, { env: { CLAUDE_CONFIG_DIR: cc } });
    expect(reg.problems).toEqual([]);
    expect(reg.skills).toHaveLength(1);
  });
});

describe("cache and config", () => {
  it("keeps the result for a minute, then rebuilds; a different config rebuilds at once", () => {
    const e = setup();
    const c = cfg({ builtin: false });
    const a = cachedSkillRegistry(c, 1000, 60_000, { home: e.home });
    expect(cachedSkillRegistry(c, 30_000, 60_000, { home: e.home })).toBe(a);
    expect(cachedSkillRegistry(c, 62_000, 60_000, { home: e.home })).not.toBe(a);
    const b = cachedSkillRegistry(c, 62_500, 60_000, { home: e.home });
    expect(cachedSkillRegistry(cfg({ builtin: true }), 63_000, 60_000, { home: e.home })).not.toBe(b);
  });

  it("an old config gets the defaults; an unknown key is rejected", () => {
    expect(ConfigSchema.parse({}).skills).toEqual({
      builtin: true, roots: [], repository: false, catalogue: { max_candidates: 20, max_tokens: 2000, include: [], exclude: [] },
      selection: { max_skills: 6, max_skill_tokens: 5000, max_tokens: 15000, include: [], exclude: [] },
      review: { max_tokens: 3000, max_skill_tokens: 1000 },
      unresolved: {
        unknown: "stop", missing: "stop", untrusted: "stop", conflict: "stop", oversized: "stop",
        high_risk: ["migration", "migrations", "security", "messaging", "kafka", "rabbitmq", "amqp", "queue", "outbox"],
      },
    });
    expect(ConfigSchema.safeParse({ skills: { nope: 1 } }).success).toBe(false);
  });
});

describe("trust, pins and the gate", () => {
  let saved: string | undefined;
  let e: Env;
  beforeEach(() => {
    saved = process.env.FACTORY_HOME;
    e = setup();
    process.env.FACTORY_HOME = e.home;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.FACTORY_HOME;
    else process.env.FACTORY_HOME = saved;
  });
  const lockFile = () => join(e.home, "skills.lock.json");
  const lockBytes = () => readFileSync(lockFile());
  const get = (reg: SkillRegistry, key: string) => reg.byKey.get(key)!;
  const tamper = (dir: string) => {
    mkdirSync(join(dir, "references"), { recursive: true });
    writeFileSync(join(dir, "references", "x.md"), "changed");
  };
  const pinIt = (key: string, over: Record<string, unknown> = {}) => {
    const reg = run(e, over);
    return pinSkill(reg, key, get(reg, key).digest);
  };
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      return (err as { code?: string }).code ?? (err as Error).name;
    }
    return "no error";
  };
  const startOpts = () => ({ home: e.home, builtinRoot: e.builtin, userHome: e.userHome, env: {} as NodeJS.ProcessEnv });

  it("gives each source its trust, creates no lock file, and starts unpinned", () => {
    pkg(join(e.home, "skills"), "a");
    pkg(e.root(0), "r");
    pkg(e.builtin, "b");
    const repo = tmp();
    pkg(join(repo, ".claude-factory", "skills"), "p");
    const reg = run(e, { roots: [e.root(0)], repository: true }, { repo });
    expect(["a", "r", "b", "p"].map((id) => get(reg, `${id}@1.0.0`).trust)).toEqual(["approved", "approved", "builtin", "unapproved"]);
    expect(reg.skills.every((s) => s.pin === "unpinned")).toBe(true);
    expect(existsSync(lockFile())).toBe(false);
    expect(code(() => selectSkill(reg, "a", "1.0.0"))).toBe("unpinned");
    expect(code(() => selectSkill(reg, "p", "1.0.0"))).toBe("unapproved");
  });

  it("pins with the listed digest, and a repeat changes nothing", () => {
    pkg(join(e.home, "skills"), "a");
    expect(pinIt("a@1.0.0")).toBe("pinned");
    const reg = run(e);
    expect(get(reg, "a@1.0.0").pin).toBe("pinned");
    expect(selectSkill(reg, "a", "1.0.0").key).toBe("a@1.0.0");
    const before = lockBytes();
    const d = get(reg, "a@1.0.0").digest;
    expect(pinSkill(reg, "a@1.0.0", d, { now: new Date(Date.now() + 1e7) })).toBe("unchanged");
    expect(pinSkill(reg, "a@1.0.0", d, { replace: true, now: new Date(Date.now() + 2e7) })).toBe("unchanged");
    expect(lockBytes()).toEqual(before);
  });

  it("refuses a bad request and writes nothing", () => {
    pkg(join(e.home, "skills"), "a");
    const repo = tmp();
    pkg(join(repo, ".claude-factory", "skills"), "p");
    const reg = run(e, { repository: true }, { repo });
    const d = get(reg, "a@1.0.0").digest;
    expect(code(() => pinSkill(reg, "zz@1.0.0", d))).toBe("unknown");
    expect(code(() => pinSkill(reg, "nope", d))).toBe("bad-key");
    expect(code(() => pinSkill(reg, "a@1.0.0", "sha256:zz"))).toBe("bad-digest");
    expect(code(() => pinSkill(reg, "p@1.0.0", get(reg, "p@1.0.0").digest))).toBe("unapproved");
    expect(code(() => pinSkill(reg, "a@1.0.0", "sha256:" + "0".repeat(64)))).toBe("digest-mismatch");
    expect(existsSync(lockFile())).toBe(false);
  });

  it("a package that changed after the pin is a mismatch with both digests", () => {
    const dir = pkg(join(e.home, "skills"), "a");
    pinIt("a@1.0.0");
    const old = get(run(e), "a@1.0.0").digest;
    tamper(dir);
    const reg = run(e);
    const s = get(reg, "a@1.0.0");
    expect(s.pin).toBe("mismatch");
    const p = reg.problems.find((x) => x.kind === "integrity")!;
    expect(p.integrity).toEqual({ id: "a", version: "1.0.0", source: "admin", label: "data folder", expected: old, actual: s.digest });
    for (const part of ["a@1.0.0", "admin", "data folder", old, s.digest]) expect(p.reason).toContain(part);
    let err: unknown;
    try {
      selectSkill(reg, "a", "1.0.0");
    } catch (x) {
      err = x;
    }
    expect(err).toBeInstanceOf(SkillIntegrityError);
    expect((err as SkillIntegrityError).failure).toEqual(p.integrity);
    const before = lockBytes();
    expect(code(() => pinSkill(reg, "a@1.0.0", s.digest))).toBe("already-pinned");
    expect(lockBytes()).toEqual(before);
    expect(pinSkill(reg, "a@1.0.0", s.digest, { replace: true })).toBe("replaced");
    expect(get(run(e), "a@1.0.0").pin).toBe("pinned");
  });

  it("a reused version is a mismatch, a new version is unpinned", () => {
    const dir = pkg(join(e.home, "skills"), "x");
    pinIt("x@1.0.0");
    rmSync(dir, { recursive: true });
    const gone = readSkillLock(e.home);
    expect(gone.ok && Object.keys(gone.pins)).toContain("x@1.0.0");
    const again = pkg(join(e.home, "skills"), "x");
    writeFileSync(join(again, "SKILL.md"), "---\nname: x\ndescription: Other.\n---\n\nOther instructions.\n");
    expect(get(run(e), "x@1.0.0").pin).toBe("mismatch");
    rmSync(again, { recursive: true });
    pkg(join(e.home, "skills"), "x", "1.0.1");
    expect(get(run(e), "x@1.0.1").pin).toBe("unpinned");
  });

  it("the same content in another source stays pinned, and the order of roots does not matter", () => {
    const dir = pkg(e.root(0), "x");
    pinIt("x@1.0.0", { roots: [e.root(0)] });
    expect(get(run(e, { roots: [e.root(0)] }), "x@1.0.0").pin).toBe("pinned");
    mkdirSync(join(e.home, "skills"), { recursive: true });
    renameSync(dir, join(e.home, "skills", "x"));
    const reg = run(e, { roots: [e.root(0)] });
    expect(get(reg, "x@1.0.0")).toMatchObject({ pin: "pinned", label: "data folder" });
    pkg(e.root(1), "y");
    pinIt("y@1.0.0", { roots: [e.root(0), e.root(1)] });
    expect(get(run(e, { roots: [e.root(1), e.root(0)] }), "y@1.0.0").pin).toBe("pinned");
  });

  it("another source with the same key but other content is a mismatch", () => {
    const dir = pkg(e.root(0), "x");
    pinIt("x@1.0.0", { roots: [e.root(0)] });
    rmSync(dir, { recursive: true });
    tamper(pkg(e.builtin, "x"));
    expect(get(run(e, { roots: [e.root(0)] }), "x@1.0.0")).toMatchObject({ source: "builtin", pin: "mismatch" });
  });

  it("selects the exact version only", () => {
    const two = pkg(e.root(0), "x", "2.0.0");
    pkg(e.builtin, "x", "1.0.0");
    const over = { roots: [e.root(0)] };
    pinIt("x@2.0.0", over);
    pinIt("x@1.0.0", over);
    expect(selectSkill(run(e, over), "x", "2.0.0").version).toBe("2.0.0");
    tamper(two);
    expect(() => selectSkill(run(e, over), "x", "2.0.0")).toThrow(SkillIntegrityError);
    rmSync(two, { recursive: true });
    const reg = run(e, over);
    expect(findSkill(reg, "x")?.version).toBe("1.0.0");
    expect(code(() => selectSkill(reg, "x", "2.0.0"))).toBe("unknown");
    expect(selectSkill(reg, "x", "1.0.0").version).toBe("1.0.0");
    expect(code(() => selectSkill(reg, "x", ""))).toBe("unknown");
  });

  it("a symlinked file makes the package invalid and unselectable", () => {
    const dir = pkg(e.root(0), "x", "2.0.0");
    pkg(e.builtin, "x", "1.0.0");
    const over = { roots: [e.root(0)] };
    pinIt("x@2.0.0", over);
    pinIt("x@1.0.0", over);
    mkdirSync(join(dir, "references"));
    symlinkSync(join(e.home, "elsewhere"), join(dir, "references", "l.md"));
    const reg = run(e, over);
    expect(reg.byKey.has("x@2.0.0")).toBe(false);
    expect(kinds(reg)).toContain("invalid-package");
    expect(code(() => selectSkill(reg, "x", "2.0.0"))).toBe("unknown");
  });

  it("cannot pin a symlinked package folder", () => {
    const real = pkg(tmp(), "x");
    mkdirSync(e.root(0));
    symlinkSync(real, join(e.root(0), "x"));
    const reg = run(e, { roots: [e.root(0)] });
    expect(code(() => pinSkill(reg, "x@1.0.0", "sha256:" + "0".repeat(64)))).toBe("unknown");
  });

  it("a repository skill with the key of a stored pin gives no integrity problem", () => {
    pkg(join(e.home, "skills"), "x");
    pinIt("x@1.0.0");
    rmSync(join(e.home, "skills", "x"), { recursive: true });
    const repo = tmp();
    tamper(pkg(join(repo, ".claude-factory", "skills"), "x"));
    const reg = run(e, { repository: true }, { repo });
    expect(kinds(reg)).not.toContain("integrity");
    expect(get(reg, "x@1.0.0").pin).toBe("unpinned");
  });

  it("pinBuiltinSkills pins built-ins only and never replaces a pin", () => {
    pkg(e.builtin, "one");
    pkg(e.builtin, "two");
    pkg(join(e.home, "skills"), "adm");
    expect(pinBuiltinSkills(run(e))).toEqual({ pinned: ["one@1.0.0", "two@1.0.0"], mismatched: [] });
    expect(get(run(e), "adm@1.0.0").pin).toBe("unpinned");
    expect(pinBuiltinSkills(run(e))).toEqual({ pinned: [], mismatched: [] });
    removeSkillPin("two@1.0.0");
    tamper(join(e.builtin, "one"));
    const digestOf = () => {
      const r = readSkillLock(e.home);
      return r.ok ? r.pins["one@1.0.0"]!.digest : "";
    };
    const before = digestOf();
    expect(pinBuiltinSkills(run(e))).toEqual({ pinned: ["two@1.0.0"], mismatched: ["one@1.0.0"] });
    expect(digestOf()).toBe(before);
  });

  it("a corrupt lock leaves every approved and built-in entry unverified and blocks the writers", () => {
    pkg(join(e.home, "skills"), "a");
    pkg(e.builtin, "b");
    writeFileSync(lockFile(), "{");
    const reg = run(e);
    expect(reg.skills.map((s) => s.pin)).toEqual(["unverified", "unverified"]);
    const lock = reg.problems.filter((p) => p.kind === "lock");
    expect(lock).toHaveLength(1);
    expect(lock[0]!.label).toBe("skill lock");
    expect(lock[0]!.reason).not.toContain(e.home);
    expect(code(() => selectSkill(reg, "a", "1.0.0"))).toBe("unverified");
    expect(() => pinSkill(reg, "a@1.0.0", get(reg, "a@1.0.0").digest)).toThrow();
    expect(() => pinBuiltinSkills(reg)).toThrow();
    expect(readFileSync(lockFile(), "utf8")).toBe("{");
  });

  describe("pinBuiltinSkillsAtStart", () => {
    it("pins and logs", () => {
      pkg(e.builtin, "one");
      const log: string[] = [];
      pinBuiltinSkillsAtStart(cfg(), (m) => log.push(m), startOpts());
      expect(log).toEqual(["pinned the built-in skills: one@1.0.0"]);
      expect(readFileSync(lockFile(), "utf8")).toContain("one@1.0.0");
    });
    it("warns about a mismatch and changes nothing", () => {
      pkg(e.builtin, "one");
      pinBuiltinSkillsAtStart(cfg(), () => {}, startOpts());
      tamper(join(e.builtin, "one"));
      const before = lockBytes();
      const log: string[] = [];
      pinBuiltinSkillsAtStart(cfg(), (m) => log.push(m), startOpts());
      expect(log.join("\n")).toMatch(/do not match their pin.*one@1\.0\.0/);
      expect(lockBytes()).toEqual(before);
    });
    it("warns about a corrupt lock and does not throw", () => {
      pkg(e.builtin, "one");
      writeFileSync(lockFile(), "{");
      const log: string[] = [];
      expect(() => pinBuiltinSkillsAtStart(cfg(), (m) => log.push(m), startOpts())).not.toThrow();
      expect(log.join("\n")).toContain("were not pinned");
      expect(readFileSync(lockFile(), "utf8")).toBe("{");
    });
  });
});

describe("scf skills", () => {
  const cli = (home: string, args: string[] = [], cwd?: string) => {
    const file = resolve("dist/cli.js");
    if (!existsSync(file)) throw new Error("dist/cli.js is missing — run `npm run build` first");
    return spawnSync(process.execPath, [file, "skills", ...args], { encoding: "utf8", cwd, env: { ...process.env, FACTORY_HOME: home } });
  };

  it("reads the repository skills of the current folder without --repo", () => {
    const home = tmp();
    const repo = tmp();
    writeFileSync(join(home, "config.yaml"), "skills:\n  repository: true\n");
    pkg(join(repo, ".claude-factory", "skills"), "mine");
    const r = cli(home, [], repo);
    expect(r.stdout).toContain("mine");
    expect(r.stdout).toContain("[repository]");
  });

  it("lists the built-in skill and exits 0", () => {
    const r = cli(tmp());
    expect(r.stdout).toContain("small-changes");
    expect(r.stdout).toContain("[built-in]");
    expect(r.status).toBe(0);
  });

  it("exits 1 and prints the problem when a configured root is missing", () => {
    const home = tmp();
    const missing = join(tmp(), "nope");
    writeFileSync(join(home, "config.yaml"), `skills:\n  roots:\n    - ${missing}\n`);
    const r = cli(home);
    expect(r.stdout).toContain("small-changes");
    expect(r.stdout).toContain(`PROBLEM skills.roots[0] ${missing}:`);
    expect(r.status).toBe(1);
  });
});
