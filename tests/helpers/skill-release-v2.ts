import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadSkillPackage } from "../../src/skills/package.js";
import { RELEASE_FILE, releaseDigest, type ApprovedRelease, type ReleaseFileEntry, type ReleaseManifestV2 } from "../../src/skills/release.js";

export interface V2Options {
  catalogue?: string;
  version?: string;
  verdict?: "passed" | "failed" | "not-run";
  provenancePath?: string;
  /** Skill id → revocation. */
  revoked?: Record<string, { on: string; reason: string }>;
  /** Skill id → attribution path → content. Written to `<root>/.attribution/<id>/<path>`. */
  attribution?: Record<string, Record<string, string>>;
}

const entry = (path: string, content: Buffer): ReleaseFileEntry => ({ path, sha256: createHash("sha256").update(content).digest("hex"), bytes: content.length });

function files(base: string, rel = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(base, rel)).sort()) {
    if (name === ".DS_Store") continue;
    const p = rel ? `${rel}/${name}` : name;
    if (lstatSync(join(base, p)).isDirectory()) out.push(...files(base, p));
    else out.push(p);
  }
  return out;
}

/** Writes `catalogue-release.json` (schema 2) and the attribution files for the packages found in `root`. */
export function writeV2Release(root: string, opts: V2Options = {}): { manifest: ReleaseManifestV2; approved: ApprovedRelease } {
  const skills = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => {
      const dir = join(root, d.name);
      const p = loadSkillPackage(dir);
      const attribution = Object.entries(opts.attribution?.[p.id] ?? {}).map(([path, text]) => {
        const full = join(root, ".attribution", p.id, path);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, text);
        return entry(path, Buffer.from(text));
      });
      return {
        id: p.id,
        version: p.version,
        digest: p.digest,
        files: files(dir).map((path) => entry(path, readFileSync(join(dir, path)))),
        provenance: { source: "acme-source", repositoryKey: "github.com/acme/skills", commit: "b".repeat(40), path: opts.provenancePath ?? `skills/${p.id}`, trust: "verified" as const },
        licences: ["MIT"],
        attribution,
        evaluation: { suite: "default-suite", record: "sha256:" + "c".repeat(64), verdict: opts.verdict ?? ("passed" as const) },
        ...(opts.revoked?.[p.id] ? { revoked: opts.revoked[p.id]! } : {}),
      };
    });
  const manifest: ReleaseManifestV2 = {
    schema: 2,
    catalogue: opts.catalogue ?? "acme-skills",
    version: opts.version ?? "1.0.0",
    createdAt: "2026-01-02T03:04:05Z",
    source: { repository: "github.com/acme/scf-skills", commit: "a".repeat(40) },
    skills,
  };
  writeFileSync(join(root, RELEASE_FILE), JSON.stringify(manifest));
  return { manifest, approved: { catalogue: manifest.catalogue, version: manifest.version, digest: releaseDigest(manifest) } };
}
