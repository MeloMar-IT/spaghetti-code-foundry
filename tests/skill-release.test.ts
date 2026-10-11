import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { readRegular } from "../src/skills/package.js";
import {
  matchRelease,
  readRelease,
  RELEASE_FILE,
  releaseContentProblem,
  releaseDigest,
  ReleaseManifestSchema,
  releaseProblemText,
  type ReleaseManifest,
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

describe("skills.releases config", () => {
  const parse = (releases: unknown) => ConfigSchema.safeParse({ skills: { releases } });
  const e = { catalogue: "acme", version: "1.0.0", digest: d("a") };
  it("has defaults, and an older config without it parses", () => {
    expect(ConfigSchema.parse({}).skills.releases).toEqual({ allow_unreleased: false, approved: [] });
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
