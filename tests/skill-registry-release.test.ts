import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { clearSkillRegistryCache, discoverSkills, findSkill, pinSkill, selectSkill, unreleasedSources, type SkillRegistry } from "../src/skills/registry.js";
import { RELEASE_FILE, releaseDigest, type ReleaseManifest } from "../src/skills/release.js";
import { loadSkillPackage } from "../src/skills/package.js";
import { integrityReason, verifyRunSkillLock, type RunSkillLock } from "../src/skills/run-lock.js";
import { writeV2Release } from "./helpers/skill-release-v2.js";

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
    expect(reg.problems.filter((p) => !p.reason.includes("scf skills release adopt"))).toEqual([]);
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
    expect(reg.problems.filter((p) => !p.reason.includes("scf skills release adopt"))).toEqual([]);
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
    expect(kinds(reg)).toEqual(["root-refused", "root-missing"]);
  });

  it("allow_unreleased loads folders as before and names them", () => {
    const e = setup();
    pkg(e.root(0), "a");
    pkg(e.root(1), "b");
    release(e.root(1));
    const reg = run(e, cfg([e.root(0), e.root(1)], [], {}, true));
    expect(reg.problems.filter((p) => !p.reason.includes("scf skills release adopt"))).toEqual([]);
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

describe("schema-2 releases in the registry", () => {
  const ATTR = { a: { LICENSE: "MIT licence text\n" } };
  function v2(e: Env, opts: Parameters<typeof writeV2Release>[1] = { attribution: ATTR }, ids = ["a", "b"]) {
    for (const id of ids) pkg(e.root(0), id);
    return writeV2Release(e.root(0), opts).approved;
  }
  const keys = (r: SkillRegistry) => r.skills.map((s) => s.key);

  it("loads an approved release", () => {
    const e = setup();
    const ap = v2(e);
    const reg = run(e, cfg([e.root(0)], [ap]));
    expect(reg.problems.filter((p) => !p.reason.includes("scf skills release adopt"))).toEqual([]);
    expect(keys(reg)).toEqual(["a@1.0.0", "b@1.0.0"]);
    expect(reg.sources[1]!.release!.state).toBe("approved");
  });

  it.each([
    ["change one byte of a package file", (r: string) => writeFileSync(join(r, "a", "skill.yaml"), "id: a\nversion: 1.0.1\n")],
    ["add one byte to a package file", (r: string) => appendFileSync(join(r, "a", "SKILL.md"), "x")],
    ["remove one byte of a package file", (r: string) => truncateSync(join(r, "a", "SKILL.md"), statSync(join(r, "a", "SKILL.md")).size - 1)],
    ["change one byte of an attribution file", (r: string) => writeFileSync(join(r, ".attribution", "a", "LICENSE"), "MIT licence text!\n")],
    ["add one byte to an attribution file", (r: string) => appendFileSync(join(r, ".attribution", "a", "LICENSE"), "x")],
    ["remove one byte of an attribution file", (r: string) => truncateSync(join(r, ".attribution", "a", "LICENSE"), 16)],
    ["an unlisted file in .attribution", (r: string) => writeFileSync(join(r, ".attribution", "a", "extra"), "x")],
  ])("refuses the release: %s", (_n, mutate) => {
    const e = setup();
    const ap = v2(e);
    mutate(e.root(0));
    const reg = run(e, cfg([e.root(0)], [ap]));
    // the refused root does not serve the approved release, so it is also reported as not adopted
    expect(kinds(reg)).toEqual(["root-refused", "root-missing"]);
    expect(reg.sources[1]).toMatchObject({ status: "refused", packages: 0 });
    expect(reg.skills).toEqual([]);
    expect(JSON.stringify(reg.problems)).not.toContain(e.root(0));
  });

  it("allow_unreleased never softens a schema-2 release, approved or not", () => {
    const e = setup();
    const ap = v2(e);
    appendFileSync(join(e.root(0), ".attribution", "a", "LICENSE"), "x");
    for (const approved of [[ap], []]) {
      const reg = run(e, cfg([e.root(0)], approved, {}, true));
      expect(kinds(reg)).toEqual(approved.length ? ["root-refused", "root-missing"] : ["root-refused"]);
      expect(reg.skills).toEqual([]);
    }
  });

  it("refuses a malformed schema-2 manifest even with allow_unreleased", () => {
    const e = setup();
    v2(e);
    const path = join(e.root(0), "catalogue-release.json");
    const m = JSON.parse(readFileSync(path, "utf8"));
    delete m.skills[0].files;
    writeFileSync(path, JSON.stringify(m));
    const reg = run(e, cfg([e.root(0)], [], {}, true));
    expect(kinds(reg)).toEqual(["root-refused"]);
    expect(reg.skills).toEqual([]);
  });

  it("an intact unapproved schema-2 release still loads under allow_unreleased", () => {
    const e = setup();
    v2(e);
    const reg = run(e, cfg([e.root(0)], [], {}, true));
    expect(keys(reg)).toEqual(["a@1.0.0", "b@1.0.0"]);
    expect(unreleasedSources(reg)).toHaveLength(1);
  });

  it("a tampered schema-1 release still behaves as before under allow_unreleased", () => {
    const e = setup();
    pkg(e.root(0), "a");
    const ap = release(e.root(0));
    appendFileSync(join(e.root(0), "a", "SKILL.md"), "x");
    const reg = run(e, cfg([e.root(0)], [ap], {}, true));
    expect(reg.sources[1]!.release!.state).toBe("mismatch");
    expect(keys(reg)).toEqual(["a@1.0.0"]);
  });

  describe("revocation", () => {
    const revoked = { b: { on: "2026-03-04", reason: "unsafe advice" } };
    it("never registers a revoked skill, and notes it", () => {
      const e = setup();
      const ap = v2(e, { revoked });
      const reg = run(e, cfg([e.root(0)], [ap]));
      expect(reg.problems.filter((p) => !p.reason.includes("scf skills release adopt"))).toEqual([]);
      expect(keys(reg)).toEqual(["a@1.0.0"]);
      expect(reg.notes.filter((n) => n.kind === "revoked").map((n) => n.text)).toEqual(["b@1.0.0 is revoked by acme-skills@1.0.0 (2026-03-04) and is not loaded."]);
    });

    it("drops the same id@version from another root, and tampering with a revoked package still refuses the release", () => {
      const e = setup();
      pkg(e.root(1), "b");
      const other = release(e.root(1), "9.0.0", "other-skills");
      const ap = v2(e, { revoked });
      const reg = run(e, cfg([e.root(0), e.root(1)], [ap, other]));
      expect(keys(reg)).toEqual(["a@1.0.0"]);
      appendFileSync(join(e.root(0), "b", "SKILL.md"), "x");
      const bad = run(e, cfg([e.root(0)], [ap]));
      expect(kinds(bad)).toEqual(["root-refused", "root-missing"]);
    });

    it("stops a run that locked the revoked skill", () => {
      const e = setup();
      const ap = v2(e, { revoked });
      const reg = run(e, cfg([e.root(0)], [ap]));
      const lock = { version: 1, skills: [{ id: "b", version: "1.0.0", digest: "sha256:" + "1".repeat(64) }] } as unknown as RunSkillLock;
      const problems = verifyRunSkillLock(lock, reg);
      expect(problems.map((p) => p.code)).toEqual(["missing"]);
      expect(integrityReason(problems[0]!)).toMatch(/^skill integrity: b@1\.0\.0 is missing/);
    });

    it("ignores a revocation in a release that is not approved", () => {
      const e = setup();
      pkg(e.root(1), "b");
      const other = release(e.root(1), "9.0.0", "other-skills");
      v2(e, { revoked });
      const reg = run(e, cfg([e.root(0), e.root(1)], [other], {}, true));
      expect(keys(reg)).toContain("b@1.0.0");
      expect(reg.notes.filter((n) => n.kind === "revoked")).toEqual([]);
    });
  });
});
