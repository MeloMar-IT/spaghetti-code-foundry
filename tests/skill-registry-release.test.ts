import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { clearSkillRegistryCache, discoverSkills, findSkill, pinSkill, selectSkill, unreleasedSources, type SkillRegistry } from "../src/skills/registry.js";
import { RELEASE_FILE, releaseDigest, type ReleaseManifest } from "../src/skills/release.js";
import { loadSkillPackage } from "../src/skills/package.js";
import { verifyRunSkillLock, type RunSkillLock } from "../src/skills/run-lock.js";

const tmps: string[] = [];
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "skillrel-")));
  tmps.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
  clearSkillRegistryCache();
});

function pkg(root: string, id: string, version = "1.0.0", body = "Do it."): string {
  const d = join(root, id);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), `---\nname: ${id}\ndescription: A test skill called ${id}.\n---\n\n${body}\n`);
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

/** Writes catalogue-release.json from the packages in `root` and returns the approved entry. */
function release(root: string, version = "1.0.0", catalogue = "acme-skills", over: Partial<ReleaseManifest> = {}) {
  const skills = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const p = loadSkillPackage(join(root, d.name));
      return { id: p.id, version: p.version, digest: p.digest };
    });
  const m: ReleaseManifest = {
    schema: 1,
    catalogue,
    version,
    createdAt: "2026-01-02T03:04:05Z",
    source: { repository: "github.com/acme/scf-skills", commit: "a".repeat(40) },
    skills,
    ...over,
  };
  writeFileSync(join(root, RELEASE_FILE), JSON.stringify(m));
  return { catalogue, version, digest: releaseDigest(m) };
}
type Entry = ReturnType<typeof release>;

const cfg = (roots: string[], approved: Entry[] = [], over: Record<string, unknown> = {}, allow = false) =>
  ConfigSchema.parse({ skills: { roots, releases: { allow_unreleased: allow, approved }, ...over } }).skills;
const run = (e: Env, skills: ReturnType<typeof cfg>, limits?: { skills?: number; bytes?: number }): SkillRegistry =>
  discoverSkills(skills, { home: e.home, builtinRoot: e.builtin, userHome: e.userHome, env: {}, ...(limits ? { limits } : {}) });
const kinds = (r: SkillRegistry) => r.problems.map((p) => p.kind);

describe("administrator folders as releases", () => {
  it("loads an approved release", () => {
    const e = setup();
    pkg(e.root(0), "a");
    const ap = release(e.root(0));
    const reg = run(e, cfg([e.root(0)], [ap]));
    expect(reg.problems).toEqual([]);
    expect(reg.skills.map((s) => s.key)).toEqual(["a@1.0.0"]);
    expect(reg.sources[1]).toMatchObject({ status: "ok", packages: 1, release: { state: "approved", digest: ap.digest } });
  });

  it("loads the data folder as an approved release", () => {
    const e = setup();
    const root = join(e.home, "skills");
    pkg(root, "a");
    const ap = release(root);
    expect(run(e, cfg([], [ap])).skills.map((s) => s.key)).toEqual(["a@1.0.0"]);
  });

  it("refuses a folder without a manifest before it reads any package", () => {
    const e = setup();
    pkg(e.root(0), "a");
    mkdirSync(join(e.root(0), "broken"));
    const reg = run(e, cfg([e.root(0)]));
    expect(reg.skills).toEqual([]);
    expect(kinds(reg)).toEqual(["root-refused"]);
    expect(reg.problems[0]!.reason).toContain("no catalogue-release.json");
    expect(reg.problems[0]!.reason).not.toContain(e.root(0));
    expect(reg.sources[1]).toMatchObject({ status: "refused", packages: 0 });
  });

  it("an empty folder without a manifest is no problem; a missing data folder neither", () => {
    const e = setup();
    mkdirSync(join(e.home, "skills"));
    mkdirSync(e.root(0));
    const reg = run(e, cfg([e.root(0)]));
    expect(reg.problems).toEqual([]);
  });

  it("refuses a manifest that is not approved and names catalogue, version and digest", () => {
    const e = setup();
    pkg(e.root(0), "a");
    const ap = release(e.root(0));
    const reg = run(e, cfg([e.root(0)]));
    expect(reg.skills).toEqual([]);
    expect(reg.problems[0]!.reason).toContain(`acme-skills@1.0.0 (${ap.digest}) is not in skills.releases.approved`);
    const other = run(e, cfg([e.root(0)], [{ ...ap, digest: "sha256:" + "0".repeat(64) }]));
    expect(other.problems[0]!.reason).toContain("another digest");
  });

  it("does not repeat a catalogue name that looks like a credential", () => {
    const e = setup();
    pkg(e.root(0), "a");
    const key = "sk-ant-" + "a".repeat(20);
    release(e.root(0), "1.0.0", key);
    const reg = run(e, cfg([e.root(0)]));
    expect(reg.skills).toEqual([]);
    expect(JSON.stringify(reg.problems)).not.toContain(key);
  });

  it("refuses a release whose content changed, with an extra package, an invalid folder or a link", () => {
    const cases: [string, (root: string) => void][] = [
      ["changed file", (r) => writeFileSync(join(r, "a", "SKILL.md"), "---\nname: a\ndescription: changed.\n---\n\nother\n")],
      ["extra package", (r) => pkg(r, "extra")],
      ["invalid folder", (r) => mkdirSync(join(r, "junk"))],
      ["link", (r) => symlinkSync(join(r, "a"), join(r, "linked"))],
    ];
    for (const [name, change] of cases) {
      const e = setup();
      pkg(e.root(0), "a");
      const ap = release(e.root(0));
      change(e.root(0));
      const reg = run(e, cfg([e.root(0)], [ap]));
      expect(reg.skills, name).toEqual([]);
      expect(kinds(reg), name).toContain("root-refused");
      expect(reg.sources[1], name).toMatchObject({ status: "refused", packages: 0 });
    }
  });

  it("a refused source does not use up the registry limits of the next one", () => {
    const e = setup();
    for (const id of ["a", "b", "c"]) pkg(e.root(0), id);
    const ap0 = release(e.root(0));
    pkg(e.root(0), "extra");
    pkg(e.root(1), "z");
    const ap1 = release(e.root(1), "2.0.0");
    for (const limits of [{ skills: 2 }, { bytes: 10 }]) {
      const reg = run(e, cfg([e.root(0), e.root(1)], [ap0, ap1]), limits);
      expect(reg.skills.map((s) => s.key), JSON.stringify(limits)).toEqual(["z@1.0.0"]);
      expect(reg.problems.filter((p) => p.label === "skills.roots[1]")).toEqual([]);
    }
  });

  it("a refused source without a manifest does not use up the limits either", () => {
    const e = setup();
    for (const id of ["a", "b", "c"]) pkg(e.root(0), id);
    pkg(e.root(1), "z");
    const ap = release(e.root(1));
    pkg(e.builtin, "built");
    const reg = run(e, cfg([e.root(0), e.root(1)], [ap]), { skills: 2 });
    expect(reg.skills.map((s) => s.key).sort()).toEqual(["built@1.0.0", "z@1.0.0"]);
  });

  it("built-in skills still load", () => {
    const e = setup();
    pkg(e.builtin, "built");
    expect(run(e, cfg([])).skills.map((s) => s.trust)).toEqual(["builtin"]);
  });

  it("a refused copy does not count as a duplicate", () => {
    const e = setup();
    pkg(e.root(0), "a");
    pkg(e.root(1), "a");
    const ap = release(e.root(1));
    const reg = run(e, cfg([e.root(0), e.root(1)], [ap]));
    expect(reg.skills.map((s) => s.label)).toEqual(["skills.roots[1]"]);
    expect(kinds(reg)).toEqual(["root-refused"]);
  });

  it("allow_unreleased loads folders as before and names them", () => {
    const e = setup();
    pkg(e.root(0), "a");
    pkg(e.root(1), "b");
    release(e.root(1));
    const reg = run(e, cfg([e.root(0), e.root(1)], [], {}, true));
    expect(reg.problems).toEqual([]);
    expect(reg.skills.map((s) => s.key)).toEqual(["a@1.0.0", "b@1.0.0"]);
    expect(unreleasedSources(reg).map((s) => s.label)).toEqual(["skills.roots[0]", "skills.roots[1]"]);
  });

  it("release approval does not pin", () => {
    const e = setup();
    pkg(e.root(0), "a");
    const reg = run(e, cfg([e.root(0)], [release(e.root(0))]));
    expect(reg.skills[0]!.pin).toBe("unpinned");
  });
});

describe("upgrade and resume", () => {
  const two = () => {
    const e = setup();
    pkg(e.root(0), "rel-a", "1.1.0");
    pkg(e.root(1), "rel-a", "1.0.0");
    const n = release(e.root(0), "2.0.0");
    const o = release(e.root(1), "1.0.0");
    return { e, n, o };
  };

  it("the newer version is active, the older stays selectable and its lock verifies until it is withdrawn", () => {
    const { e, n, o } = two();
    const saved = process.env.FACTORY_HOME;
    process.env.FACTORY_HOME = e.home;
    try {
      body(e, n, o);
    } finally {
      if (saved === undefined) delete process.env.FACTORY_HOME;
      else process.env.FACTORY_HOME = saved;
    }
  });

  const body = (e: Env, n: Entry, o: Entry) => {
    const full = cfg([e.root(0), e.root(1)], [n, o]);
    const reg = run(e, full);
    for (const k of ["rel-a@1.1.0", "rel-a@1.0.0"]) pinSkill(reg, k, reg.byKey.get(k)!.digest, {});
    const pinned = run(e, full);
    expect(findSkill(pinned, "rel-a")!.version).toBe("1.1.0");
    expect(selectSkill(pinned, "rel-a", "1.0.0").version).toBe("1.0.0");
    const lock = { version: 1, skills: [{ id: "rel-a", version: "1.0.0", digest: pinned.byKey.get("rel-a@1.0.0")!.digest }] } as unknown as RunSkillLock;
    const check = (skills: ReturnType<typeof cfg>) => verifyRunSkillLock(lock, run(e, skills));
    expect(check(full)).toEqual([]);
    expect(check(cfg([e.root(0), e.root(1)], [n])).map((p) => p.code)).toEqual(["missing"]);
    expect(check(cfg([e.root(0)], [n, o])).map((p) => p.code)).toEqual(["missing"]);
  };

  it("two releases with the same id@version and other bytes: the first wins and the other is named", () => {
    const e = setup();
    pkg(e.root(0), "x", "1.0.0", "one");
    pkg(e.root(1), "x", "1.0.0", "two");
    const a = release(e.root(0), "1.0.0");
    const b = release(e.root(1), "2.0.0");
    const reg = run(e, cfg([e.root(0), e.root(1)], [a, b]));
    expect(reg.byKey.get("x@1.0.0")!.label).toBe("skills.roots[0]");
    expect(reg.problems.find((p) => p.kind === "duplicate")!.reason).toContain("with another digest");
  });
});
