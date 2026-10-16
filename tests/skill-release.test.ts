import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { readRegular } from "../src/skills/package.js";
import {
  isUtcTime,
  matchRelease,
  readRelease,
  RELEASE_FILE,
  releaseContentProblem,
  releaseDigest,
  ReleaseManifestSchema,
  releaseProblemText,
  releaseText,
  RELEASE_DIGEST_HEADER_V2,
  type ReleaseManifest,
  type ReleaseManifestV2,
} from "../src/skills/release.js";
import { SKILL_DIGEST_RE } from "../src/skills/schema.js";

const d = (c: string) => "sha256:" + c.repeat(64);
const manifest = (over: Record<string, unknown> = {}): ReleaseManifest =>
  ({
    schema: 1,
    catalogue: "acme-skills",
    version: "1.2.3",
    createdAt: "2026-01-02T03:04:05Z",
    source: { repository: "github.com/acme/scf-skills", commit: "a".repeat(40), ref: "v1.2.3" },
    skills: [
      { id: "beta", version: "1.0.0", digest: d("b") },
      { id: "alpha", version: "2.0.0", digest: d("a") },
    ],
    ...over,
  }) as ReleaseManifest;
const ok = (m: unknown) => ReleaseManifestSchema.safeParse(m).success;

describe("release manifest schema", () => {
  it("accepts a full manifest and refuses what is wrong", () => {
    expect(ok(manifest())).toBe(true);
    expect(ok({ ...manifest(), extra: 1 })).toBe(false);
    expect(ok(manifest({ schema: 2 }))).toBe(false);
    expect(ok(manifest({ version: "1.2" }))).toBe(false);
    expect(ok(manifest({ source: { repository: "github.com/a/b", commit: "a".repeat(39) } }))).toBe(false);
    expect(ok(manifest({ source: { repository: "https://x/y", commit: "a".repeat(40) } }))).toBe(false);
    expect(ok(manifest({ source: { repository: "user@host/y", commit: "a".repeat(40) } }))).toBe(false);
    expect(ok(manifest({ skills: [] }))).toBe(false);
    const many = Array.from({ length: 501 }, (_, i) => ({ id: `s${i}`, version: "1.0.0", digest: d("a") }));
    expect(ok(manifest({ skills: many }))).toBe(false);
    expect(ok(manifest({ skills: many.slice(0, 500) }))).toBe(true);
    const dup = { id: "a", version: "1.0.0", digest: d("a") };
    expect(ok(manifest({ skills: [dup, { ...dup, version: "2.0.0" }] }))).toBe(false);
  });

  it("accepts only real UTC times", () => {
    for (const t of ["2024-02-29T00:00:00Z", "2028-02-29T12:00:00.5Z"]) expect(ok(manifest({ createdAt: t })), t).toBe(true);
    for (const t of ["2026-01-01T00:00:00", "2026-13-40T00:00:00Z", "2026-02-29T00:00:00Z", "2026-02-30T00:00:00Z", "2026-04-31T00:00:00Z", "2026-01-01T24:00:00Z"]) {
      expect(ok(manifest({ createdAt: t })), t).toBe(false);
    }
  });
});

describe("isUtcTime", () => {
  it("accepts a real UTC time and refuses the rest", () => {
    expect(isUtcTime("2026-01-31T12:00:00Z")).toBe(true);
    expect(isUtcTime("2026-01-31T12:00:00.123Z")).toBe(true);
    for (const t of ["2026-02-30T00:00:00Z", "yesterday", "2026-01-01T00:00:00", ""]) expect(isUtcTime(t)).toBe(false);
  });
});

describe("releaseDigest", () => {
  const base = releaseDigest(manifest());
  it("is a sha256 digest, stable, and fixed for one manifest", () => {
    expect(base).toMatch(SKILL_DIGEST_RE);
    expect(releaseDigest(manifest())).toBe(base);
    expect(base).toBe(releaseDigest(manifest({ skills: [...manifest().skills].reverse() })));
  });
  it("changes with any field", () => {
    const m = manifest();
    const other = [
      manifest({ version: "1.2.4" }),
      manifest({ createdAt: "2026-01-02T03:04:06Z" }),
      manifest({ catalogue: "other" }),
      manifest({ source: { ...m.source, commit: "b".repeat(40) } }),
      manifest({ source: { ...m.source, ref: "v9" } }),
      manifest({ source: { repository: m.source.repository, commit: m.source.commit } }),
      manifest({ skills: [m.skills[0], { ...m.skills[1], digest: d("c") }] }),
    ];
    for (const o of other) expect(releaseDigest(o)).not.toBe(base);
  });
});

describe("readRelease", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rel-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const put = (text: string) => writeFileSync(join(root, RELEASE_FILE), text);
  const invalid = (r: ReturnType<typeof readRelease>) => (r.state === "invalid" ? r.reason : `state ${r.state}`);

  it("none, ok, and a digest independent of the formatting", () => {
    expect(readRelease(root)).toEqual({ state: "none" });
    put(JSON.stringify(manifest()));
    const a = readRelease(root);
    put(JSON.stringify(manifest(), null, 4).replace(/\n/g, "\r\n"));
    const b = readRelease(root);
    expect(a.state).toBe("ok");
    expect(b).toEqual(a);
  });

  it("refuses what is not a good manifest, without repeating content or paths", () => {
    put("{ not json SECRETTEXT");
    expect(invalid(readRelease(root))).toBe("is not valid JSON");
    put(JSON.stringify({ schema: 1, note: "SECRETTEXT" }));
    expect(invalid(readRelease(root))).toBe("has the wrong format");
    put(JSON.stringify(manifest()));
    expect(invalid(readRelease(root, 10))).toBe("is larger than 10 bytes");
  });

  it("refuses a link and a folder", () => {
    rmSync(join(root, RELEASE_FILE), { force: true });
    writeFileSync(join(root, "real.json"), JSON.stringify(manifest()));
    symlinkSync(join(root, "real.json"), join(root, RELEASE_FILE));
    expect(invalid(readRelease(root))).toBe("is a symbolic link");
    rmSync(join(root, RELEASE_FILE));
    mkdirSync(join(root, RELEASE_FILE));
    expect(invalid(readRelease(root))).toBe("is not a readable regular file");
  });

  it("refuses a credential, also written with escapes, and names only the rule", () => {
    const key = "sk-ant-" + "a".repeat(20);
    for (const text of [JSON.stringify(manifest({ catalogue: key })), JSON.stringify(manifest({ catalogue: key })).replace("sk-ant", "\\u0073k-ant")]) {
      put(text);
      const r = readRelease(root);
      expect(r.state).toBe("invalid");
      const reason = invalid(r);
      expect(reason).toContain("holds what looks like a credential");
      expect(reason).not.toContain(key);
      expect(reason).not.toContain(root);
    }
    put(JSON.stringify(manifest({ skills: [{ id: key, version: "1.0.0", digest: d("a") }] })));
    expect(invalid(readRelease(root))).toContain("holds what looks like a credential");
  });

  it.skipIf(process.platform === "win32")("never waits on a pipe", () => {
    execFileSync("mkfifo", [join(root, RELEASE_FILE)]);
    expect(invalid(readRelease(root))).toBe("is not a readable regular file");
    expect(readRegular(join(root, RELEASE_FILE), 100)).toBe("other");
  });
});

describe("matchRelease and content", () => {
  const m = manifest();
  const rd = { state: "ok" as const, manifest: m, digest: releaseDigest(m) };
  const entry = { catalogue: m.catalogue, version: m.version, digest: rd.digest };
  it("passes none and invalid through", () => {
    expect(matchRelease({ state: "none" }, [entry]).state).toBe("none");
    expect(matchRelease({ state: "invalid", reason: "x" }, [entry])).toEqual({ state: "invalid", reason: "x" });
  });
  it("tells unapproved, mismatch and approved apart", () => {
    expect(matchRelease(rd, []).state).toBe("unapproved");
    expect(matchRelease(rd, [{ ...entry, version: "9.9.9" }]).state).toBe("unapproved");
    const mm = matchRelease(rd, [{ ...entry, digest: d("0") }]);
    expect(mm).toMatchObject({ state: "mismatch", reason: "has another digest than the approved one" });
    expect(releaseProblemText(mm)).toBe("acme-skills@1.2.3 has another digest than the approved one");
    expect(matchRelease(rd, [entry])).toEqual({ state: "approved", catalogue: m.catalogue, version: m.version, digest: rd.digest });
    expect(releaseProblemText(matchRelease(rd, []))).toContain("is not in skills.releases.approved");
  });
  it("compares the found packages with the list", () => {
    const found = m.skills.map((s) => ({ ...s }));
    expect(releaseContentProblem(m, found)).toBeUndefined();
    expect(releaseContentProblem(m, found.slice(1))).toContain("(beta)");
    expect(releaseContentProblem(m, [...found, { id: "zeta", version: "1.0.0", digest: d("a") }])).toContain("(zeta)");
    expect(releaseContentProblem(m, [{ ...found[0]!, digest: d("c") }, found[1]!])).toContain("(beta)");
    expect(releaseContentProblem(m, [found[0]!, { ...found[1]!, version: "2.0.1" }])).toContain("(alpha)");
  });
});

const file = (path: string, c = "a") => ({ path, sha256: c.repeat(64), bytes: 10 });
const v2 = (): ReleaseManifestV2 => ({
  schema: 2,
  catalogue: "acme-skills",
  version: "1.2.3",
  createdAt: "2026-01-02T03:04:05Z",
  source: { repository: "github.com/acme/scf-skills", commit: "a".repeat(40), ref: "v1.2.3" },
  skills: [
    {
      id: "beta",
      version: "1.0.0",
      digest: d("b"),
      files: [file("SKILL.md"), file("references/x.md", "b")],
      provenance: { source: "acme", repositoryKey: "github.com/acme/skills", commit: "c".repeat(40), path: "skills/beta", trust: "verified", review: { by: "@marcel", on: "2026-01-01", commit: "c".repeat(40), licence: "MIT" } },
      licences: ["MIT", "Apache-2.0"],
      attribution: [file("LICENSE", "c"), file("NOTICE", "d")],
      evaluation: { suite: "default", record: d("e"), verdict: "passed" },
      revoked: { on: "2026-02-01", reason: "gives wrong advice" },
    },
    {
      id: "alpha",
      version: "2.0.0",
      digest: d("a"),
      files: [file("SKILL.md")],
      provenance: { source: "acme", repositoryKey: "github.com/acme/skills", commit: "c".repeat(40), path: ".", trust: "community" },
      licences: ["MIT"],
      attribution: [],
      evaluation: { suite: "default", record: d("f"), verdict: "not-run" },
    },
  ],
});
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const mutate = (f: (m: any) => void) => {
  const m = clone(v2());
  f(m);
  return m;
};

describe("release manifest schema 2", () => {
  it("accepts a full manifest, and v1 stays as it is", () => {
    expect(ok(v2())).toBe(true);
    expect(ok(manifest())).toBe(true);
    expect(releaseText(manifest()).startsWith("scf-skill-catalogue-release-v1\n")).toBe(true);
  });
  it("starts the canonical text with the v2 header", () => {
    expect(releaseText(v2()).startsWith(RELEASE_DIGEST_HEADER_V2)).toBe(true);
    expect(RELEASE_DIGEST_HEADER_V2).toBe("scf-skill-catalogue-release-v2\n");
  });
  it.each<[string, (m: any) => void]>([
    ["extra key at the top", (m) => (m.extra = 1)],
    ["extra key in a skill", (m) => (m.skills[0].extra = 1)],
    ["extra key in a file", (m) => (m.skills[0].files[0].extra = 1)],
    ["extra key in provenance", (m) => (m.skills[0].provenance.extra = 1)],
    ["sha256 with a prefix", (m) => (m.skills[0].files[0].sha256 = "sha256:" + "a".repeat(64))],
    ["upper-case sha256", (m) => (m.skills[0].files[0].sha256 = "A".repeat(64))],
    ["negative bytes", (m) => (m.skills[0].files[0].bytes = -1)],
    ["fractional bytes", (m) => (m.skills[0].files[0].bytes = 1.5)],
    ["a file over the file limit", (m) => (m.skills[0].files[0].bytes = 262145)],
    ["a total over the package limit", (m) => (m.skills[0].files = Array.from({ length: 9 }, (_, i) => ({ ...file(`f${i}`), bytes: 262144 })))],
    ["a duplicate path, case-insensitive", (m) => m.skills[0].files.push(file("skill.md"))],
    ["a path that leaves the package", (m) => (m.skills[0].files[0].path = "../x")],
    ["an absolute path", (m) => (m.skills[0].files[0].path = "/x")],
    ["a path with a newline", (m) => (m.skills[0].files[0].path = "a\nb")],
    ["a .DS_Store path", (m) => (m.skills[0].files[0].path = "references/.DS_Store")],
    ["a path with a lone surrogate", (m) => (m.skills[0].files[0].path = "a\ud801")],
    ["a glob in the provenance path", (m) => (m.skills[0].provenance.path = "skills/*")],
    [".git in the provenance path", (m) => (m.skills[0].provenance.path = "a/.git")],
    ["no files", (m) => (m.skills[0].files = [])],
    ["no licences", (m) => (m.skills[0].licences = [])],
    ["a duplicate licence", (m) => (m.skills[0].licences = ["MIT", "MIT"])],
    ["a bad licence id", (m) => (m.skills[0].licences = ["M IT"])],
    ["more than 20 attribution files", (m) => (m.skills[0].attribution = Array.from({ length: 21 }, (_, i) => file(`n${i}`)))],
    ["an unknown trust", (m) => (m.skills[0].provenance.trust = "trusted")],
    ["an unknown verdict", (m) => (m.skills[0].evaluation.verdict = "ok")],
    ["a revocation on 30 February", (m) => (m.skills[0].revoked.on = "2026-02-30")],
    ["an empty revocation reason", (m) => (m.skills[0].revoked.reason = "")],
    ["a revocation reason with a newline", (m) => (m.skills[0].revoked.reason = "a\nb")],
    ["a long revocation reason", (m) => (m.skills[0].revoked.reason = "x".repeat(201))],
    ["a padded revocation reason", (m) => (m.skills[0].revoked.reason = " x")],
    ["a revocation reason with a lone surrogate", (m) => (m.skills[0].revoked.reason = "\ud800")],
    ["a skill listed twice", (m) => m.skills.push(clone(m.skills[0]))],
  ])("refuses %s", (_n, f) => expect(ok(mutate(f))).toBe(false));

  it("two lone surrogates would hash the same, so the parse refuses both", () => {
    const a = mutate((m) => (m.skills[0].revoked.reason = "\ud800"));
    const b = mutate((m) => (m.skills[0].revoked.reason = "\ud801"));
    expect(releaseDigest(a)).toBe(releaseDigest(b));
    expect(ok(a) || ok(b)).toBe(false);
  });

  it("does not change with key order, white space or the order of items", () => {
    const m = v2();
    const base = releaseDigest(m);
    const shuffled = clone(m) as any;
    shuffled.skills.reverse();
    shuffled.skills[1].files.reverse();
    shuffled.skills[1].licences.reverse();
    shuffled.skills[1].attribution.reverse();
    const reorder = (o: any): any => (Array.isArray(o) ? o.map(reorder) : o && typeof o === "object" ? Object.fromEntries(Object.entries(o).reverse().map(([k, v]) => [k, reorder(v)])) : o);
    const parsed = ReleaseManifestSchema.parse(JSON.parse(JSON.stringify(reorder(shuffled), null, 4)));
    expect(releaseDigest(parsed)).toBe(base);
  });

  it("changes with every single field", () => {
    const base = releaseDigest(v2());
    const mutators: ((m: any) => void)[] = [
      (m) => (m.catalogue = "other"),
      (m) => (m.version = "1.2.4"),
      (m) => (m.createdAt = "2026-01-02T03:04:06Z"),
      (m) => (m.source.repository = "github.com/acme/other"),
      (m) => (m.source.commit = "b".repeat(40)),
      (m) => delete m.source.ref,
      (m) => (m.skills[0].id = "gamma"),
      (m) => (m.skills[0].version = "1.0.1"),
      (m) => (m.skills[0].digest = d("0")),
      (m) => (m.skills[0].files[0].path = "SKILL2.md"),
      (m) => (m.skills[0].files[0].sha256 = "0".repeat(64)),
      (m) => (m.skills[0].files[0].bytes = 11),
      (m) => (m.skills[0].provenance.source = "other"),
      (m) => (m.skills[0].provenance.repositoryKey = "github.com/acme/other"),
      (m) => (m.skills[0].provenance.commit = "d".repeat(40)),
      (m) => (m.skills[0].provenance.path = "skills/other"),
      (m) => (m.skills[0].provenance.trust = "community"),
      (m) => delete m.skills[0].provenance.review,
      (m) => (m.skills[0].provenance.review.by = "@other"),
      (m) => (m.skills[0].provenance.review.on = "2026-01-02"),
      (m) => (m.skills[0].provenance.review.commit = "d".repeat(40)),
      (m) => (m.skills[0].provenance.review.licence = "ISC"),
      (m) => (m.skills[0].licences = ["MIT"]),
      (m) => (m.skills[0].attribution[0].path = "LICENSE2"),
      (m) => (m.skills[0].attribution[0].sha256 = "0".repeat(64)),
      (m) => (m.skills[0].attribution[0].bytes = 11),
      (m) => m.skills[0].attribution.pop(),
      (m) => (m.skills[0].evaluation.suite = "other"),
      (m) => (m.skills[0].evaluation.record = d("0")),
      (m) => (m.skills[0].evaluation.verdict = "failed"),
      (m) => delete m.skills[0].revoked,
      (m) => (m.skills[0].revoked.on = "2026-02-02"),
      (m) => (m.skills[0].revoked.reason = "other"),
      (m) => (m.skills[1].revoked = { on: "2026-02-02", reason: "x" }),
    ];
    const seen = new Set<string>([base]);
    for (const [i, f] of mutators.entries()) {
      const digest = releaseDigest(mutate(f));
      expect(seen.has(digest), `mutator ${i}`).toBe(false);
      seen.add(digest);
    }
  });

  describe("reading", () => {
    const dirs: string[] = [];
    afterEach(() => {
      for (const x of dirs.splice(0)) rmSync(x, { recursive: true, force: true });
    });
    const write = (text: string) => {
      const dir = mkdtempSync(join(tmpdir(), "skillrel2-"));
      dirs.push(dir);
      writeFileSync(join(dir, RELEASE_FILE), text);
      return dir;
    };
    it("reads a v2 file, and a v2 file larger than the v1 limit", () => {
      expect(readRelease(write(JSON.stringify(v2())))).toMatchObject({ state: "ok" });
      const text = JSON.stringify(v2()) + " ".repeat(262144);
      expect(readRelease(write(text))).toMatchObject({ state: "ok" });
    });
    it("keeps the v1 limit and reason, and refuses a v2 file over 2 MiB", () => {
      const v1 = JSON.stringify(manifest()) + " ".repeat(262144);
      expect(readRelease(write(v1))).toEqual({ state: "invalid", reason: "is larger than 262144 bytes" });
      expect(readRelease(write(JSON.stringify(v2()) + " ".repeat(2097152))).state).toBe("invalid");
    });
    it("refuses a credential in a revocation reason", () => {
      const m = mutate((x) => (x.skills[0].revoked.reason = "sk-ant-" + "a".repeat(30)));
      const r = readRelease(write(JSON.stringify(m)));
      expect(r).toMatchObject({ state: "invalid" });
      expect((r as { reason: string }).reason).toContain("holds what looks like a credential");
    });
  });
});

describe("skills.releases config", () => {
  const parse = (releases: unknown) => ConfigSchema.safeParse({ skills: { releases } });
  const e = { catalogue: "acme", version: "1.0.0", digest: d("a") };
  it("has defaults, and an older config without it parses", () => {
    expect(ConfigSchema.parse({}).skills.releases).toEqual({ allow_unreleased: false, approved: [], keys: [] });
    expect(ConfigSchema.parse({ skills: { builtin: false } }).skills.releases.allow_unreleased).toBe(false);
  });
  it("refuses bad entries", () => {
    expect(parse({ approved: [e] }).success).toBe(true);
    expect(parse({ approved: [{ ...e, digest: "sha256:zz" }] }).success).toBe(false);
    expect(parse({ approved: [e, { ...e, digest: d("b") }] }).success).toBe(false);
    expect(parse({ nope: 1 }).success).toBe(false);
    expect(parse({ approved: Array.from({ length: 51 }, (_, i) => ({ ...e, version: `1.0.${i}` })) }).success).toBe(false);
  });
});
