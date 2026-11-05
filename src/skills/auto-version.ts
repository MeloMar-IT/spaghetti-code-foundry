import { compareSkillVersions } from "./schema.js";

// The version a skill gets in an automatic release (#799). Pure: the caller reads the base release and builds the digests.
//
// Per skill, in this order:
//   1. no released version yet: 1.0.0, or the version upstream declares when it is higher
//   2. the package built with the base version has the base digest: the base version (nothing changed)
//   3. upstream declares a version higher than the base: that version
//   4. a file path was added or removed: minor bump
//   5. anything else: patch bump

export interface VersionBase {
  version: string;
  digest: string;
  /** The file paths of the base package. */
  paths: readonly string[];
}

const core = (v: string): [bigint, bigint, bigint] => {
  const i = v.indexOf("-");
  const [a, b, c] = (i < 0 ? v : v.slice(0, i)).split(".").map(BigInt);
  return [a!, b!, c!];
};

/** `1.2.3` → `1.3.0`. A prerelease part is dropped. */
export function bumpMinor(v: string): string {
  const [a, b] = core(v);
  return `${a}.${b! + 1n}.0`;
}

/** `1.2.3` → `1.2.4`. A prerelease part is dropped. */
export function bumpPatch(v: string): string {
  const [a, b, c] = core(v);
  return `${a}.${b}.${c! + 1n}`;
}

export function autoSkillVersion(i: {
  base?: VersionBase;
  /** The version upstream declares; absent when it declares none. */
  declared?: string;
  /** The digest of the Foundry package built with this version. */
  digestAt: (version: string) => string;
  paths: readonly string[];
}): string {
  if (!i.base) return i.declared !== undefined && compareSkillVersions(i.declared, "1.0.0") > 0 ? i.declared : "1.0.0";
  if (i.digestAt(i.base.version) === i.base.digest) return i.base.version;
  if (i.declared !== undefined && compareSkillVersions(i.declared, i.base.version) > 0) return i.declared;
  const before = new Set(i.base.paths);
  const now = new Set(i.paths);
  const changed = [...now].some((p) => !before.has(p)) || [...before].some((p) => !now.has(p));
  return changed ? bumpMinor(i.base.version) : bumpPatch(i.base.version);
}
