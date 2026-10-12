import { createHash } from "node:crypto";
import { canonicalJson, plainProblem } from "./normalize-values.js";
import { splitFrontmatter } from "./package.js";

/** First bytes of what `skillFingerprint` hashes. Changing it changes every fingerprint. */
export const SKILL_FINGERPRINT_HEADER = "scf-skill-content-v1\n";
/** File name endings read as documents (line endings and a BOM are ignored), outside `scripts/` and `assets/`. */
export const SKILL_TEXT_EXTENSIONS = [".md", ".txt"] as const;
export const SKILL_RELATIONS = ["same-artifact", "same-content", "version-conflict", "other-version", "distinct"] as const;
export type SkillRelation = (typeof SKILL_RELATIONS)[number];

export interface SkillIdentity {
  schema: 1;
  /** Source-qualified id; equals the package id. */
  id: string;
  source: string;
  repositoryKey: string;
  /** `<repositoryKey>#<name>`: the same for every source record of one repository. */
  upstream: string;
  /** The name the skill declares in SKILL.md. */
  name: string;
  version: string;
  versionDeclared: boolean;
  /** Canonical content digest. Holds no provenance. */
  fingerprint: string;
  /** Raw package digest (`skillDigest`), as used by pins and locks. */
  digest: string;
}

type FileEntry = { path: string; content: Uint8Array };

const MODE_RAW = 0;
const MODE_PARSED = 1;
const MODE_TEXT = 2;

const SKILL_MD = "SKILL.md";
const MANIFEST = "skill.yaml";
const IGNORED = ".DS_Store";

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const decode = (bytes: Uint8Array): string | undefined => {
  try {
    return decoder.decode(bytes);
  } catch {
    return undefined;
  }
};

function isDocument(path: string): boolean {
  if (path.startsWith("scripts/") || path.startsWith("assets/")) return false;
  const last = path.slice(path.lastIndexOf("/") + 1);
  return SKILL_TEXT_EXTENSIONS.some((e) => last.endsWith(e));
}

/** Frontmatter as canonical JSON, a newline and the body as it is. Undefined when SKILL.md does not parse as plain data. */
function canonicalSkillMd(text: string): Buffer | undefined {
  try {
    const { data, body } = splitFrontmatter(text);
    if (plainProblem(data) !== undefined) return undefined;
    return Buffer.from(canonicalJson(data) + "\n" + body, "utf8");
  } catch {
    return undefined;
  }
}

function canonicalText(text: string): Buffer {
  return Buffer.from(text.replace(/^﻿/, "").replace(/\r\n/g, "\n"), "utf8");
}

function canonicalFile(path: string, bytes: Uint8Array): { mode: number; content: Buffer } {
  const raw = { mode: MODE_RAW, content: Buffer.from(bytes) };
  if (bytes.includes(0)) return raw;
  const text = decode(bytes);
  if (text === undefined) return raw;
  if (path === SKILL_MD) {
    const parsed = canonicalSkillMd(text);
    if (parsed) return { mode: MODE_PARSED, content: parsed };
    return { mode: MODE_TEXT, content: canonicalText(text) };
  }
  if (isDocument(path)) return { mode: MODE_TEXT, content: canonicalText(text) };
  return raw;
}

const len = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

/** Content digest that ignores provenance, `skill.yaml`, `.DS_Store`, file order and text encodings that do not change meaning. */
export function skillFingerprint(files: readonly FileEntry[]): string {
  const entries = files
    .map((f) => ({ name: f.path.normalize("NFC"), content: f.content }))
    .filter((f) => f.name !== MANIFEST && f.name.slice(f.name.lastIndexOf("/") + 1) !== IGNORED)
    .map((f) => ({ path: Buffer.from(f.name, "utf8"), ...canonicalFile(f.name, f.content) }))
    .sort((a, b) => Buffer.compare(a.path, b.path) || a.mode - b.mode || Buffer.compare(a.content, b.content));
  const h = createHash("sha256");
  h.update(SKILL_FINGERPRINT_HEADER);
  for (const e of entries) {
    h.update(len(e.path.length));
    h.update(e.path);
    h.update(Uint8Array.of(e.mode));
    h.update(len(e.content.length));
    h.update(e.content);
  }
  return "sha256:" + h.digest("hex");
}

export function upstreamIdentity(repositoryKey: string, name: string): string {
  return `${repositoryKey}#${name}`;
}

export function buildSkillIdentity(input: {
  id: string;
  source: string;
  repositoryKey: string;
  name: string;
  version: string;
  versionDeclared: boolean;
  digest: string;
  files: readonly FileEntry[];
}): SkillIdentity {
  return {
    schema: 1,
    id: input.id,
    source: input.source,
    repositoryKey: input.repositoryKey,
    upstream: upstreamIdentity(input.repositoryKey, input.name),
    name: input.name,
    version: input.version,
    versionDeclared: input.versionDeclared,
    fingerprint: skillFingerprint(input.files),
    digest: input.digest,
  };
}

export function relateSkills(a: SkillIdentity, b: SkillIdentity): SkillRelation {
  const sameUpstream = a.upstream === b.upstream;
  const sameVersion = a.version === b.version;
  if (a.fingerprint === b.fingerprint) return sameUpstream && sameVersion ? "same-artifact" : "same-content";
  if (sameUpstream) return sameVersion ? "version-conflict" : "other-version";
  return "distinct";
}
