import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeCandidatePackage } from "../src/skill-eval/package.js";
import type { NormalizedSkill } from "../src/skills/normalize.js";
import { foundryPackageFiles, parseSkillPackage, skillDigest } from "../src/skills/package.js";
import { publishRelease, ReleaseStoreError, releaseStoreSettings, releasesDir, type ReleaseContent, type ReleaseFile } from "../src/skills/release-store.js";
import { RELEASE_FILE, releaseDigest, type ReleaseFileEntry, type ReleaseManifestV2 } from "../src/skills/release.js";
import { verifyRelease } from "../src/skills/release-verify.js";

const enc = (s: string) => new TextEncoder().encode(s);
const entry = (f: ReleaseFile): ReleaseFileEntry => ({ path: f.path, sha256: createHash("sha256").update(f.content).digest("hex"), bytes: f.content.byteLength });

function fpkg(id: string, body: string): ReleaseFile[] {
  const md = `---\nname: ${id}\ndescription: A tiny example skill used only in tests.\n---\n\n# ${id}\n\n${body}\n`;
  const pkg = parseSkillPackage([
    { path: "SKILL.md", content: enc(md) },
    { path: "skill.yaml", content: enc(`id: ${id}\nversion: 0.1.0\n`) },
    { path: "references/notes.md", content: enc(`notes of ${id}\n`) },
  ]);
  return foundryPackageFiles(pkg);
}

function content(o: { body?: string; version?: string; order?: "ab" | "ba"; catalogue?: string } = {}): ReleaseContent {
  const body = o.body ?? "Keep changes small.";
  const ids = o.order === "ba" ? ["b", "a"] : ["a", "b"];
  const packages = new Map<string, ReleaseFile[]>();
  const attribution = new Map<string, ReleaseFile[]>();
  attribution.set("a", [
    { path: "LICENSE.txt", content: enc("MIT licence text\n") },
    { path: "docs/NOTICE", content: enc("notice\n") },
  ]);
  const skills = ids.map((id) => {
    const files = fpkg(id, body);
    packages.set(id, files);
    return {
      id,
      version: "0.1.0",
      digest: skillDigest(files),
      files: files.map(entry),
      provenance: { source: "acme-source", repositoryKey: "github.com/acme/skills", commit: "b".repeat(40), path: `skills/${id}`, trust: "verified" as const },
      licences: ["MIT"],
      attribution: (attribution.get(id) ?? []).map(entry),
      evaluation: { suite: "default-suite", record: "sha256:" + "c".repeat(64), verdict: "passed" as const },
    };
  });
  const manifest: ReleaseManifestV2 = {
    schema: 2,
    catalogue: o.catalogue ?? "acme-skills",
    version: o.version ?? "1.0.0",
    createdAt: "2026-01-02T03:04:05Z",
    source: { repository: "github.com/acme/scf-skills", commit: "a".repeat(40) },
    skills,
  };
  return { manifest, packages, attribution };
}

interface Node { path: string; type: string; mode: number; data?: string }
function snapshot(home: string): Node[] {
  const out: Node[] = [];
  const walk = (abs: string, rel: string) => {
    for (const name of readdirSync(abs).sort()) {
      const full = join(abs, name);
      const st = lstatSync(full);
      const path = `${rel}/${name}`;
      const type = st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : "file";
      out.push({ path, type, mode: st.mode & 0o777, data: type === "file" ? readFileSync(full, "utf8") : undefined });
      if (type === "dir") walk(full, path);
    }
  };
  walk(releasesDir(home), "");
  return out;
}
const tmpLeft = (home: string) => readdirSync(releasesDir(home)).filter((n) => n.startsWith(".tmp-"));
const mode = (p: string) => lstatSync(p).mode & 0o777;

const made: string[] = [];
let home: string;
const realRename = releaseStoreSettings.rename;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skillrelease-store-")));
  made.push(home);
});
afterEach(() => {
  releaseStoreSettings.rename = realRename;
  delete releaseStoreSettings.beforeVerify;
  for (const d of made.splice(0)) {
    try {
      chmodSync(releasesDir(d), 0o700);
    } catch {
      // gone
    }
    rmSync(d, { recursive: true, force: true });
  }
});

const versionDir = (v = "1.0.0") => join(releasesDir(home), "acme-skills", v);

describe("publishRelease", () => {
  it("writes a release that verifies, with private modes and no tmp folder", () => {
    const c = content({ order: "ba" });
    const want = releaseDigest(c.manifest);
    expect(publishRelease(c, { home })).toEqual({ state: "published", digest: want });
    const v = verifyRelease(versionDir());
    expect(v).toMatchObject({ ok: true, digest: want });
    for (const d of [releasesDir(home), join(releasesDir(home), "acme-skills"), versionDir(), join(versionDir(), "a", "references"), join(versionDir(), ".attribution", "a", "docs")]) {
      expect(mode(d)).toBe(0o700);
    }
    const sorted = { ...c.manifest, skills: [...c.manifest.skills].sort((x, y) => (x.id < y.id ? -1 : 1)) };
    expect(readFileSync(join(versionDir(), RELEASE_FILE), "utf8")).toBe(JSON.stringify(sorted, null, 2) + "\n");
    for (const n of snapshot(home)) if (n.type === "file") expect(n.mode).toBe(0o600);
    expect(tmpLeft(home)).toEqual([]);
  });

  it("gives unchanged for the same content and changes nothing", () => {
    publishRelease(content(), { home });
    const before = snapshot(home);
    expect(publishRelease(content(), { home })).toEqual({ state: "unchanged", digest: releaseDigest(content().manifest) });
    expect(snapshot(home)).toEqual(before);
  });

  it("refuses other content at the same version and changes nothing", () => {
    const first = content();
    publishRelease(first, { home });
    const before = snapshot(home);
    const other = content({ body: "Something else." });
    const r = publishRelease(other, { home });
    expect(r).toMatchObject({ state: "refused", why: "other-digest", digest: releaseDigest(other.manifest) });
    expect((r as { detail?: string }).detail).toContain(releaseDigest(first.manifest));
    expect(snapshot(home)).toEqual(before);
    expect(tmpLeft(home)).toEqual([]);
  });

  it("refuses a link, a file and an empty folder at the version path", () => {
    publishRelease(content({ version: "2.0.0" }), { home });
    const cat = join(releasesDir(home), "acme-skills");
    symlinkSync(join(cat, "2.0.0"), join(cat, "1.0.0"));
    expect(publishRelease(content(), { home })).toMatchObject({ state: "refused", why: "not-a-release" });
    expect(lstatSync(join(cat, "1.0.0")).isSymbolicLink()).toBe(true);
    rmSync(join(cat, "1.0.0"));
    writeFileSync(join(cat, "1.0.0"), "stray");
    const before = snapshot(home);
    expect(publishRelease(content(), { home })).toMatchObject({ state: "refused", why: "not-a-release" });
    expect(snapshot(home)).toEqual(before);
    rmSync(join(cat, "1.0.0"));
    mkdirSync(join(cat, "1.0.0"), { mode: 0o700 });
    expect(publishRelease(content(), { home })).toMatchObject({ state: "refused", why: "not-a-release" });
    expect(readdirSync(join(cat, "1.0.0"))).toEqual([]);
    expect(tmpLeft(home)).toEqual([]);
  });

  it("needs plain 0700 folders", () => {
    mkdirSync(releasesDir(home), { mode: 0o755 });
    chmodSync(releasesDir(home), 0o755);
    expect(() => publishRelease(content(), { home })).toThrow(/mode 0700/);
    expect(mode(releasesDir(home))).toBe(0o755);
    rmSync(releasesDir(home), { recursive: true });
    const elsewhere = join(home, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, releasesDir(home));
    expect(() => publishRelease(content(), { home })).toThrow(/not a plain folder/);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("leaves nothing when the rename fails", () => {
    releaseStoreSettings.rename = () => {
      throw Object.assign(new Error(`boom ${home}`), { code: "EIO" });
    };
    let err: unknown;
    try {
      publishRelease(content(), { home });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ReleaseStoreError);
    expect((err as Error).message).toMatch(/EIO/);
    expect((err as Error).message).not.toContain(home);
    expect(readdirSync(join(releasesDir(home), "acme-skills"))).toEqual([]);
    expect(tmpLeft(home)).toEqual([]);
  });

  it("leaves nothing when the written release does not verify", () => {
    releaseStoreSettings.beforeVerify = (tmp) => appendFileSync(join(tmp, "a", "SKILL.md"), "x");
    let err: unknown;
    try {
      publishRelease(content(), { home });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ReleaseStoreError);
    expect((err as Error).message).toMatch(/does not verify/);
    expect((err as Error).message).not.toContain(home);
    expect(readdirSync(join(releasesDir(home), "acme-skills"))).toEqual([]);
    expect(tmpLeft(home)).toEqual([]);
  });

  it("handles a competing publish that wins the race", () => {
    for (const [competing, state] of [[content({ body: "Competitor." }), "refused"], [content(), "unchanged"]] as const) {
      const h = realpathSync(mkdtempSync(join(tmpdir(), "skillrelease-race-")));
      made.push(h);
      releaseStoreSettings.rename = (from, to) => {
        releaseStoreSettings.rename = realRename;
        publishRelease(competing, { home: h });
        renameSync(from, to);
      };
      const r = publishRelease(content(), { home: h });
      expect(r.state).toBe(state);
      if (r.state === "refused") expect(r.why).toBe("other-digest");
      expect(verifyRelease(join(releasesDir(h), "acme-skills", "1.0.0"))).toMatchObject({ ok: true, digest: releaseDigest(competing.manifest) });
      expect(tmpLeft(h)).toEqual([]);
    }
  });

  it("accepts parent folders that already exist as plain 0700 folders", () => {
    // Same state a concurrent publisher leaves behind; the EEXIST re-check in plainDir ends in the same plain-folder check.
    mkdirSync(releasesDir(home), { mode: 0o700 });
    mkdirSync(join(releasesDir(home), "acme-skills"), { mode: 0o700 });
    expect(publishRelease(content(), { home }).state).toBe("published");
    expect(publishRelease(content({ version: "1.0.1" }), { home }).state).toBe("published");
  });

  it("checks the content before it creates anything", () => {
    const extra = content();
    extra.packages.get("a")!.push({ path: "extra.md", content: enc("x") });
    expect(() => publishRelease(extra, { home })).toThrow(/does not match/);
    const missing = content();
    missing.packages.delete("b");
    expect(() => publishRelease(missing, { home })).toThrow(ReleaseStoreError);
    for (const map of ["packages", "attribution"] as const) {
      const odd = content();
      odd[map].set(`${home}/evil\n`, [{ path: "x.md", content: enc("x") }]);
      let err: unknown;
      try {
        publishRelease(odd, { home });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ReleaseStoreError);
      expect((err as Error).message).toMatch(/does not list/);
      expect((err as Error).message).not.toContain(home);
      expect((err as Error).message).not.toContain("evil");
    }
    const bad = content({ catalogue: "../x" });
    expect(() => publishRelease(bad, { home })).toThrow(/wrong format/);
    expect(() => lstatSync(releasesDir(home))).toThrow();
  });
});

describe("foundryPackageFiles", () => {
  const md = "---\nname: full\ndescription: A full example skill used only in tests.\nlicense: MIT\nmetadata:\n  team: core\n---\n\n# Full\n\nBody text.\n";
  const entries = [
    { path: "SKILL.md", content: enc(md) },
    { path: "skill.yaml", content: enc("id: full\nversion: 1.2.3\n") },
    { path: "REVIEW.md", content: enc("Review notes.\n") },
    { path: "references/notes.md", content: new Uint8Array([0, 1, 2, 255, 10]) },
  ];

  it("loads again with the same digest as writeCandidatePackage", () => {
    const pkg = parseSkillPackage(entries);
    const files = foundryPackageFiles(pkg);
    const back = parseSkillPackage(files);
    expect(back).toMatchObject({ id: "full", version: "1.2.3", review: "Review notes." });
    expect(back.digest).toBe(skillDigest(files));
    const dir = mkdtempSync(join(tmpdir(), "skillrelease-pkg-"));
    made.push(dir);
    const written = writeCandidatePackage({ package: { ...pkg, extraFiles: [{ path: "scripts-extra.txt", content: enc("x") }] } } as unknown as NormalizedSkill, dir);
    expect(written).toMatchObject({ digest: back.digest });
  });

  it("writes fixed bytes: optional fields, REVIEW.md, nested bytes, no extraFiles", () => {
    const files = foundryPackageFiles(parseSkillPackage(entries));
    const by = Object.fromEntries(files.map((f) => [f.path, Buffer.from(f.content)]));
    expect(Object.keys(by)).toEqual(["SKILL.md", "skill.yaml", "REVIEW.md", "references/notes.md"]);
    expect(by["SKILL.md"]!.toString()).toBe("---\nname: full\ndescription: A full example skill used only in tests.\nlicense: MIT\nmetadata:\n  team: core\n---\n\n# Full\n\nBody text.\n");
    expect(by["REVIEW.md"]!.toString()).toBe("Review notes.\n");
    expect([...by["references/notes.md"]!]).toEqual([0, 1, 2, 255, 10]);
    expect(by["skill.yaml"]!.toString().startsWith("id: full\nversion: 1.2.3\ncategory:")).toBe(true);
    expect(by["skill.yaml"]!.toString().endsWith("\n")).toBe(true);
  });
});
