import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { skillsCommand } from "../src/skills/cli.js";
import { clearSkillRegistryCache, discoverSkills } from "../src/skills/registry.js";
import type { ApprovedRelease } from "../src/skills/release.js";
import { rawPublicKey, signApproval, type ReleaseKey } from "../src/skills/release-signature.js";
import { listStoredReleases, publishRelease, readReleaseContent, releaseStoreSettings, unstoredApproved, type StoreListing } from "../src/skills/release-store.js";
import { verifyRelease } from "../src/skills/release-verify.js";
import { artifactPathProblem } from "../src/skills/schema.js";
import { writeV2Release } from "./helpers/skill-release-v2.js";

const priv: KeyObject = generateKeyPairSync("ed25519").privateKey;
const keys: ReleaseKey[] = [{ id: "k1", ed25519: rawPublicKey(priv) }];
const signed = (a: ApprovedRelease): ApprovedRelease => ({ ...a, key: "k1", signature: signApproval(a, priv) });
const D = `sha256:${"a".repeat(64)}`;

describe("artifact path rule", () => {
  const parse = (artifact: string) => ConfigSchema.safeParse({ skills: { releases: { approved: [{ catalogue: "acme", version: "1.0.0", digest: D, artifact }] } } }).success;
  it("accepts an absolute local path", () => {
    expect(parse("/abs/x")).toBe(true);
    expect(artifactPathProblem("/abs/x")).toBeUndefined();
  });
  it("accepts an entry without artifact", () => {
    expect(ConfigSchema.safeParse({ skills: { releases: { approved: [{ catalogue: "acme", version: "1.0.0", digest: D }] } } }).success).toBe(true);
  });
  it("refuses the bad cases", () => {
    for (const p of ["https://h/x", "file:///x", "rel/x", "/a/.claude/x", "/a/.codex/x", "//srv/share", "\\\\srv\\share", "/a/\nb", "/" + "a".repeat(4096)]) {
      expect(parse(p), p).toBe(false);
      expect(artifactPathProblem(p), p).toBeTypeOf("string");
    }
  });
});

describe("unstoredApproved", () => {
  const listing = (over: Partial<StoreListing> = {}): StoreListing => ({ releases: [], hidden: 0, unreadable: 0, ...over });
  const a: ApprovedRelease = { catalogue: "acme", version: "1.0.0", digest: D };
  it("returns the missing entry, with a hint to set the artifact only when there is none", () => {
    const r = unstoredApproved(listing(), [a]);
    expect(r).toHaveLength(1);
    expect(r[0]!.text).toContain('run "scf skills release adopt acme@1.0.0"');
    expect(r[0]!.text).toContain("after you set its artifact");
    expect(unstoredApproved(listing(), [{ ...a, artifact: "/x" }])[0]!.text).not.toContain("after you set");
  });
  it("skips a stored entry", () => {
    expect(unstoredApproved(listing({ releases: [{ catalogue: "acme", version: "1.0.0", dir: "/x" }] }), [a])).toEqual([]);
  });
  it("reports nothing when the store cannot be read in full", () => {
    expect(unstoredApproved(listing({ refused: "x" }), [a])).toEqual([]);
    expect(unstoredApproved(listing({ unreadable: 1 }), [a])).toEqual([]);
  });
});

describe("scf skills release adopt", () => {
  let base: string;
  let home: string;
  let builtin: string;
  let userHome: string;
  let n = 0;
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "skilladopt-")));
    home = join(base, "home");
    builtin = join(base, "builtin");
    userHome = join(base, "user");
    for (const d of [home, builtin, userHome]) mkdirSync(d);
  });
  afterEach(() => {
    releaseStoreSettings.beforeVerify = undefined;
    rmSync(base, { recursive: true, force: true });
    clearSkillRegistryCache();
  });

  /** A schema-2 release folder in base/art-N; returns its root, manifest and the (unsigned) approved entry. */
  function artifact(catalogue: string, version: string, skill: string, parent = base) {
    const root = join(parent, `art-${n++}`);
    const d = join(root, skill);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "SKILL.md"), `---\nname: ${skill}\ndescription: A test skill called ${skill}.\n---\n\nDo it.\n`);
    writeFileSync(join(d, "skill.yaml"), `id: ${skill}\nversion: ${version}\n`);
    const { approved, manifest } = writeV2Release(root, { catalogue, version, attribution: { [skill]: { "LICENSE.txt": "MIT\n" } } });
    return { root, approved, manifest };
  }
  const cfg = (approved: ApprovedRelease[], k: ReleaseKey[] = keys) => ConfigSchema.parse({ skills: { roots: [], releases: { approved, keys: k } } }).skills;
  const run = async (args: string[], skills: ReturnType<typeof cfg>) => {
    const lines: string[] = [];
    const code = await skillsCommand({ positionals: ["release", ...args], values: {} }, (l) => lines.push(l), { home, skills, cwd: base, builtinRoot: builtin, userHome, env: {} });
    return { code, lines };
  };
  const storeEntries = () => (existsSync(join(home, "skill-releases")) ? readdirSync(join(home, "skill-releases")) : []);

  it("adopts two signed entries, then reports PRESENT", async () => {
    const a = artifact("acme", "1.0.0", "alpha");
    const b = artifact("beta", "2.0.0", "gamma");
    const skills = cfg([signed({ ...a.approved, artifact: a.root }), signed({ ...b.approved, artifact: b.root })]);
    const r = await run(["adopt"], skills);
    expect(r.lines).toEqual([`ADOPTED acme@1.0.0 ${a.approved.digest}`, `ADOPTED beta@2.0.0 ${b.approved.digest}`]);
    expect(r.code).toBe(0);
    const dest = join(home, "skill-releases", "acme", "1.0.0");
    const v = verifyRelease(dest);
    expect(v.ok && v.digest).toBe(a.approved.digest);
    expect(lstatSync(dest).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(dest, "catalogue-release.json")).mode & 0o777).toBe(0o600);
    const again = await run(["adopt"], skills);
    expect(again.lines).toEqual(["PRESENT acme@1.0.0", "PRESENT beta@2.0.0"]);
    expect(again.code).toBe(0);
  });

  it("handles only the named entry, and refuses one that is not approved", async () => {
    const a = artifact("acme", "1.0.0", "alpha");
    const b = artifact("beta", "2.0.0", "gamma");
    const skills = cfg([signed({ ...a.approved, artifact: a.root }), signed({ ...b.approved, artifact: b.root })]);
    expect((await run(["adopt", "beta@2.0.0"], skills)).lines).toEqual([`ADOPTED beta@2.0.0 ${b.approved.digest}`]);
    expect(storeEntries()).toEqual(["beta"]);
    const r = await run(["adopt", "zzz@1.0.0"], skills);
    expect(r.lines).toEqual(["REFUSED zzz@1.0.0: not in skills.releases.approved"]);
    expect(r.code).toBe(1);
    await expect(run(["adopt", "foo"], skills)).rejects.toThrow("the operand must be <catalogue>@<version>");
  });

  it("MISSING-ARTIFACT: exit 0 for all entries, 1 when named", async () => {
    const a = artifact("acme", "1.0.0", "alpha");
    const skills = cfg([signed(a.approved), signed({ ...a.approved, version: "9.0.0", artifact: join(base, "nope") })]);
    const all = await run(["adopt"], skills);
    expect(all.lines[0]).toMatch(/^MISSING-ARTIFACT acme@1\.0\.0: no artifact/);
    expect(all.lines[1]).toMatch(/^MISSING-ARTIFACT acme@9\.0\.0: .*does not exist/);
    expect(all.code).toBe(0);
    expect((await run(["adopt", "acme@1.0.0"], skills)).code).toBe(1);
  });

  it("an empty approved list is not an error", async () => {
    const r = await run(["adopt"], cfg([]));
    expect(r).toEqual({ code: 0, lines: ["No releases are approved"] });
  });

  describe("refusals write nothing", () => {
    const refused = async (entry: ApprovedRelease, text: string, k: ReleaseKey[] = keys) => {
      const r = await run(["adopt"], cfg([entry], k));
      expect(r.lines).toHaveLength(1);
      expect(r.lines[0]).toMatch(/^REFUSED acme@1\.0\.0: /);
      expect(r.lines[0]).toContain(text);
      expect(r.code).toBe(1);
      expect(storeEntries()).toEqual([]);
    };

    it("a file changed after the manifest was written", async () => {
      const a = artifact("acme", "1.0.0", "alpha");
      appendFileSync(join(a.root, "alpha", "SKILL.md"), "tamper\n");
      await refused(signed({ ...a.approved, artifact: a.root }), "");
    });
    it("an extra file in a package", async () => {
      const a = artifact("acme", "1.0.0", "alpha");
      writeFileSync(join(a.root, "alpha", "extra.md"), "x");
      await refused(signed({ ...a.approved, artifact: a.root }), "");
    });
    it("a schema-1 artifact", async () => {
      const a = artifact("acme", "1.0.0", "alpha");
      writeFileSync(join(a.root, "catalogue-release.json"), JSON.stringify({ schema: 1, catalogue: "acme", version: "1.0.0", createdAt: "2026-01-02T03:04:05Z", source: { repository: "github.com/a/b", commit: "a".repeat(40) }, skills: [] }));
      await refused(signed({ ...a.approved, artifact: a.root }), "");
    });
    it("another catalogue or version", async () => {
      const a = artifact("acme", "2.0.0", "alpha");
      await refused(signed({ ...a.approved, version: "1.0.0", artifact: a.root }), "the artifact holds acme@2.0.0");
    });
    it("another digest", async () => {
      const a = artifact("acme", "1.0.0", "alpha");
      await refused(signed({ ...a.approved, digest: `sha256:${"e".repeat(64)}`, artifact: a.root }), "not the approved one");
    });
    it("no keys, unsigned, unknown key, bad signature", async () => {
      const a = artifact("acme", "1.0.0", "alpha");
      await refused({ ...a.approved, artifact: a.root }, "no skills.releases.keys are set", []);
      await refused({ ...a.approved, artifact: a.root }, "is not signed by a trusted key");
      await refused({ ...a.approved, key: "k1", signature: signApproval(a.approved, priv).replace(/^./, (c) => (c === "A" ? "B" : "A")), artifact: a.root }, "signature does not verify");
      const other = generateKeyPairSync("ed25519").privateKey;
      await refused({ ...a.approved, key: "k1", signature: signApproval(a.approved, other), artifact: a.root }, "signature does not verify");
    });
    it("an artifact in a personal agent folder, also through a link", async () => {
      const a = artifact("acme", "1.0.0", "alpha", join(userHome, ".claude"));
      const link = join(userHome, "link");
      symlinkSync(a.root, link);
      await refused(signed({ ...a.approved, artifact: link }), "personal agent folder");
    });
    it("an artifact inside the release store", async () => {
      const a = artifact("acme", "1.0.0", "alpha");
      const inside = join(home, "skill-releases", ".staging", "art");
      mkdirSync(join(home, "skill-releases", ".staging"), { recursive: true });
      renameSync(a.root, inside);
      const r = await run(["adopt"], cfg([signed({ ...a.approved, artifact: inside })]));
      expect(r.lines[0]).toContain("inside the release store");
      expect(r.code).toBe(1);
      expect(listStoredReleases(home).releases).toEqual([]);
    });
    it("a relative artifact path that bypassed the schema", async () => {
      const a = artifact("acme", "1.0.0", "alpha");
      const skills = cfg([]);
      skills.releases.approved.push(signed({ ...a.approved, artifact: "rel/x" }));
      const r = await run(["adopt"], skills);
      expect(r.lines[0]).toContain("must be an absolute path");
      expect(r.code).toBe(1);
      expect(storeEntries()).toEqual([]);
    });
  });

  it("a change inside the staged copy leaves no version folder and no tmp folder", async () => {
    const a = artifact("acme", "1.0.0", "alpha");
    releaseStoreSettings.beforeVerify = (tmp) => appendFileSync(join(tmp, "alpha", "SKILL.md"), "x");
    const r = await run(["adopt"], cfg([signed({ ...a.approved, artifact: a.root })]));
    expect(r.lines[0]).toMatch(/^REFUSED acme@1\.0\.0: .*; nothing was adopted$/);
    expect(r.code).toBe(1);
    expect(existsSync(join(home, "skill-releases", "acme", "1.0.0"))).toBe(false);
    expect(storeEntries().filter((e) => e.startsWith(".tmp-"))).toEqual([]);
  });

  it("a stored release with another digest is refused and kept", async () => {
    const old = artifact("acme", "1.0.0", "alpha");
    const c = readReleaseContent(realpathSync(old.root), old.manifest)!;
    publishRelease(c as never, { home });
    const fresh = artifact("acme", "1.0.0", "alpha-two");
    const r = await run(["adopt"], cfg([signed({ ...fresh.approved, artifact: fresh.root })]));
    expect(r.lines).toEqual(["REFUSED acme@1.0.0: the release store holds acme@1.0.0 with another digest"]);
    expect(r.code).toBe(1);
    const v = verifyRelease(join(home, "skill-releases", "acme", "1.0.0"));
    expect(v.ok && v.digest).toBe(old.approved.digest);
  });

  it("a store that cannot be read gives PROBLEM", async () => {
    const a = artifact("acme", "1.0.0", "alpha");
    writeFileSync(join(home, "skill-releases"), "not a folder");
    const r = await run(["adopt"], cfg([signed({ ...a.approved, artifact: a.root })]));
    expect(r.lines).toEqual(["PROBLEM the release store cannot be read completely; nothing was adopted"]);
    expect(r.code).toBe(1);
  });

  describe("readReleaseContent", () => {
    it("round-trips through publishRelease", () => {
      const a = artifact("acme", "1.0.0", "alpha");
      const c = readReleaseContent(realpathSync(a.root), a.manifest);
      expect(typeof c).toBe("object");
      const r = publishRelease(c as never, { home });
      expect(r).toEqual({ state: "published", digest: a.approved.digest });
    });
    it("notices a truncated file", () => {
      const a = artifact("acme", "1.0.0", "alpha");
      truncateSync(join(a.root, "alpha", "SKILL.md"), 3);
      expect(readReleaseContent(realpathSync(a.root), a.manifest)).toBe("the artifact changed while it was read");
    });
    it("notices a package folder replaced by a link", () => {
      const a = artifact("acme", "1.0.0", "alpha");
      const real = realpathSync(a.root);
      const copy = join(base, "outside");
      renameSync(join(real, "alpha"), copy);
      symlinkSync(copy, join(real, "alpha"));
      expect(readReleaseContent(real, a.manifest)).toBe("the artifact changed while it was read");
    });
    it("notices a root replaced by a link", () => {
      const a = artifact("acme", "1.0.0", "alpha");
      const real = realpathSync(a.root);
      const moved = join(base, "moved");
      renameSync(real, moved);
      symlinkSync(moved, real);
      expect(readReleaseContent(real, a.manifest)).toBe("the artifact changed while it was read");
    });
  });

  describe("the scf skills problem", () => {
    const discover = (skills: ReturnType<typeof cfg>) => discoverSkills(skills, { home, builtinRoot: builtin, userHome, env: {} });
    it("names the adopt command; adopting removes it and loads the skills", async () => {
      const a = artifact("acme", "1.0.0", "alpha");
      const skills = cfg([signed({ ...a.approved, artifact: a.root })]);
      const before = discover(skills);
      const p = before.problems.find((x) => x.kind === "root-missing" && x.reason.includes("scf skills release adopt acme@1.0.0"));
      expect(p).toBeDefined();
      const listed = await skillsCommand({ positionals: [], values: {} }, () => undefined, { home, skills, builtinRoot: builtin, userHome, env: {} });
      expect(listed).toBe(1);
      expect((await run(["adopt"], skills)).code).toBe(0);
      const after = discover(skills);
      expect(after.problems.filter((x) => x.reason.includes("scf skills release adopt"))).toEqual([]);
      expect([...after.byKey.keys()]).toContain("alpha@1.0.0");
    });
    it("is raised even when a skills.roots folder serves the exact approved release", () => {
      const a = artifact("acme", "1.0.0", "alpha");
      const skills = ConfigSchema.parse({ skills: { roots: [a.root], releases: { approved: [signed(a.approved)], keys } } }).skills;
      const reg = discover(skills);
      expect(reg.problems.some((x) => x.kind === "root-missing" && x.reason.includes("scf skills release adopt acme@1.0.0"))).toBe(true);
    });
  });

  it("opens no connection", async () => {
    const net = await import("node:net");
    const orig = net.Socket.prototype.connect;
    let calls = 0;
    net.Socket.prototype.connect = function () {
      calls++;
      throw new Error("network");
    } as never;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      calls++;
      throw new Error("network");
    }) as never;
    try {
      const a = artifact("acme", "1.0.0", "alpha");
      const skills = cfg([signed({ ...a.approved, artifact: a.root })]);
      expect((await run(["adopt"], skills)).code).toBe(0);
      discoverSkills(skills, { home, builtinRoot: builtin, userHome, env: {} });
      expect(listStoredReleases(home).releases).toHaveLength(1);
    } finally {
      net.Socket.prototype.connect = orig;
      globalThis.fetch = realFetch;
    }
    expect(calls).toBe(0);
  });
});
