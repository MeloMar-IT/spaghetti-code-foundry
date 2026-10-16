import { canonicalFromRegistered } from "./canonical-facts.js";
import { CANONICAL_LIMITS, type CANONICAL_CONFLICTS } from "./canonical-rules.js";
import { selectCanonicalSkills, type CanonicalCandidate } from "./canonical.js";
import { byteCmp } from "./import-plan.js";
import type { RegisteredSkill } from "./registry.js";
import type { ReleaseManifestV2, ReleaseSkillV2 } from "./release.js";
import type { SkillPackage } from "./schema.js";
import { boundedList } from "./source-update.js";

// What a newer catalogue release changes: added, removed, changed and deprecated skills, and the capabilities whose canonical winner
// changes. Pure: no file system, clock or process, and the input is never changed. Every list is in byte order.

export interface ReleaseSkillRef { id: string; version: string; digest: string }
export interface CanonicalSide {
  outcome: "selected" | "conflict" | "none";
  winner?: ReleaseSkillRef;
  conflict?: (typeof CANONICAL_CONFLICTS)[number];
}
export interface CatalogueChanges {
  catalogue: string;
  /** Undefined: there is no old release. */
  from?: { version: string };
  to: { version: string };
  added: ReleaseSkillRef[];
  removed: ReleaseSkillRef[];
  changed: { id: string; old: { version: string; digest: string }; next: { version: string; digest: string } }[];
  deprecated: (ReleaseSkillRef & { on: string; reason: string; alreadyRevoked: boolean })[];
  canonical: { capability: string; old: CanonicalSide; next: CanonicalSide }[];
}
export interface ReleasePackages { old: readonly RegisteredSkill[]; next: readonly RegisteredSkill[] }

export const CATALOGUE_CHANGES_MARKDOWN_BYTES = 60000;

/** A package of a stored release as the registry sees it: admin source, approved, pinned (like asEntry in skill-eval/effect.ts). */
export function releaseEntry(pkg: SkillPackage, release: { catalogue: string; version: string }): RegisteredSkill {
  return { key: `${pkg.id}@${pkg.version}`, id: pkg.id, version: pkg.version, source: "admin", label: `release ${release.catalogue}@${release.version}`, dir: "", active: true, trust: "approved", pin: "pinned", digest: pkg.digest, pkg };
}

const ref = (s: { id: string; version: string; digest: string }): ReleaseSkillRef => ({ id: s.id, version: s.version, digest: s.digest });
const byId = <T extends { id: string }>(a: T, b: T) => byteCmp(a.id, b.id);

/** The registered package of every manifest skill (id, version and digest must match), as canonical candidates. */
function candidatesOf(m: ReleaseManifestV2, pkgs: readonly RegisteredSkill[]): CanonicalCandidate[] {
  const have = new Map(pkgs.map((p) => [`${p.id}@${p.version} ${p.digest}`, p]));
  return m.skills.map((s) => {
    const p = have.get(`${s.id}@${s.version} ${s.digest}`);
    if (!p) throw new TypeError(`the package of ${s.id}@${s.version} is missing`);
    const c = canonicalFromRegistered(p);
    return s.revoked ? { ...c, status: "revoked" } : c;
  });
}

/** Capabilities with two or more providers. */
function shared(cs: readonly CanonicalCandidate[]): Set<string> {
  const n = new Map<string, number>();
  for (const c of cs) for (const cap of new Set(c.capabilities)) n.set(cap, (n.get(cap) ?? 0) + 1);
  return new Set([...n].filter(([, k]) => k >= 2).map(([cap]) => cap));
}

type Sides = Map<string, CanonicalSide>;

/** The canonical winner of every capability in `scope`, from one selector call per group plus a global winners-overlap check. */
function decide(cs: readonly CanonicalCandidate[], scope: readonly string[], highRisk: readonly string[]): Sides {
  const max = CANONICAL_LIMITS.exclusive;
  const out: Sides = new Map();
  const keyOf = (c: Pick<CanonicalCandidate, "id" | "version" | "fingerprint">) => `${c.id}@${c.version} ${c.fingerprint}`;
  // Components: capabilities that one skill provides together.
  const parent = new Map(scope.map((c) => [c, c]));
  const find = (c: string): string => {
    let r = c;
    while (parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  for (const c of cs) {
    const mine = [...new Set(c.capabilities)].filter((x) => parent.has(x));
    for (let i = 1; i < mine.length; i++) {
      const a = find(mine[0]!);
      const b = find(mine[i]!);
      if (a !== b) parent.set(a, b);
    }
  }
  const comps = new Map<string, string[]>();
  for (const cap of scope) {
    const r = find(cap);
    const list = comps.get(r);
    if (list) list.push(cap);
    else comps.set(r, [cap]);
  }
  // Pack components into chunks of at most `max` capabilities; one component that is larger is cut (the check below covers the cuts).
  const chunks: string[][] = [];
  let cur: string[] = [];
  for (const comp of [...comps.values()].sort((a, b) => byteCmp(a[0]!, b[0]!))) {
    if (comp.length > max) {
      for (let i = 0; i < comp.length; i += max) chunks.push(comp.slice(i, i + max));
      continue;
    }
    if (cur.length + comp.length > max) {
      chunks.push(cur);
      cur = [];
    }
    cur.push(...comp);
  }
  if (cur.length) chunks.push(cur);
  const provided = new Map<string, string[]>();
  for (const chunk of chunks) {
    const set = new Set(chunk);
    const inChunk = cs.filter((c) => c.capabilities.some((x) => set.has(x)));
    const res = selectCanonicalSkills(inChunk, { exclusive: chunk, highRisk });
    for (const r of res.resolutions) {
      out.set(r.capability, {
        outcome: r.outcome,
        ...(r.winner ? { winner: { id: r.winner.id, version: r.winner.version, digest: r.winner.fingerprint } } : {}),
        ...(r.conflict ? { conflict: r.conflict } : {}),
      });
      if (r.winner) provided.set(keyOf(r.winner), [...(provided.get(keyOf(r.winner)) ?? []), r.capability]);
    }
  }
  // A winner has to win every capability of the scope it provides, also across chunks.
  if (chunks.length > 1) {
    for (const c of cs) {
      const won = provided.get(keyOf(c));
      if (!won) continue;
      const mine = new Set(c.capabilities);
      if (!scope.some((cap) => mine.has(cap) && !won.includes(cap))) continue;
      for (const cap of won) out.set(cap, { outcome: "conflict", conflict: "winners-overlap" });
    }
  }
  return out;
}

const sideKey = (s: CanonicalSide) => `${s.outcome} ${s.winner ? `${s.winner.id}@${s.winner.version} ${s.winner.digest}` : ""} ${s.conflict ?? ""}`;

export function catalogueChanges(old: ReleaseManifestV2 | undefined, next: ReleaseManifestV2, packages: ReleasePackages, opts: { highRisk?: readonly string[] } = {}): CatalogueChanges {
  const oldSkills = new Map<string, ReleaseSkillV2>((old?.skills ?? []).map((s) => [s.id, s]));
  const nextSkills = new Map<string, ReleaseSkillV2>(next.skills.map((s) => [s.id, s]));
  const added: ReleaseSkillRef[] = [];
  const changed: CatalogueChanges["changed"] = [];
  const deprecated: CatalogueChanges["deprecated"] = [];
  for (const s of nextSkills.values()) {
    const o = oldSkills.get(s.id);
    if (!o) added.push(ref(s));
    else if (o.version !== s.version || o.digest !== s.digest) changed.push({ id: s.id, old: { version: o.version, digest: o.digest }, next: { version: s.version, digest: s.digest } });
    if (s.revoked) deprecated.push({ ...ref(s), on: s.revoked.on, reason: s.revoked.reason, alreadyRevoked: !!o?.revoked });
  }
  const removed = [...oldSkills.values()].filter((s) => !nextSkills.has(s.id)).map(ref);

  const nextCs = candidatesOf(next, packages.next);
  const oldCs = old ? candidatesOf(old, packages.old) : [];
  const scope = [...new Set([...shared(oldCs), ...shared(nextCs)])].sort(byteCmp);
  const highRisk = opts.highRisk ?? [];
  const none: CanonicalSide = { outcome: "none" };
  const oldSides = old ? decide(oldCs, scope, highRisk) : new Map<string, CanonicalSide>();
  const nextSides = decide(nextCs, scope, highRisk);
  const canonical: CatalogueChanges["canonical"] = [];
  for (const capability of scope) {
    const o = oldSides.get(capability) ?? none;
    const n = nextSides.get(capability) ?? none;
    if (sideKey(o) !== sideKey(n)) canonical.push({ capability, old: o, next: n });
  }

  return {
    catalogue: next.catalogue,
    ...(old ? { from: { version: old.version } } : {}),
    to: { version: next.version },
    added: added.sort(byId),
    removed: removed.sort(byId),
    changed: changed.sort(byId),
    deprecated: deprecated.sort(byId),
    canonical,
  };
}

const sideText = (s: CanonicalSide): string => (s.winner ? `${s.winner.id}@${s.winner.version}` : s.outcome === "conflict" ? `conflict:${s.conflict}` : "none");

/** One line per change, in the order ADDED, REMOVED, CHANGED, DEPRECATED, CANONICAL. */
export function catalogueChangeLines(c: CatalogueChanges): string[] {
  return [
    ...c.added.map((s) => `ADDED ${s.id}@${s.version} ${s.digest}`),
    ...c.removed.map((s) => `REMOVED ${s.id}@${s.version} ${s.digest}`),
    ...c.changed.map((s) => `CHANGED ${s.id} ${s.old.version} ${s.old.digest} -> ${s.next.version} ${s.next.digest}`),
    ...c.deprecated.map((s) => `DEPRECATED ${s.id}@${s.version} ${s.digest} revoked ${s.on}: ${s.reason}${s.alreadyRevoked ? " (already revoked)" : ""}`),
    ...c.canonical.map((s) => `CANONICAL ${s.capability} ${sideText(s.old)} -> ${sideText(s.next)}`),
  ];
}

const code = (s: string): string => "`" + s.replace(/<!--/g, "<!- -").replace(/`/g, "'") + "`";
const SECTION_BYTES = 96;
const size = (s: string) => Buffer.byteLength(s);

/** The longest start of `text` that is at most `bytes` bytes: whole lines first, then whole characters. */
function fit(text: string, bytes: number): string {
  if (size(text) <= bytes) return text;
  const lines = text.split("\n");
  while (lines.length && size(lines.join("\n")) > bytes) lines.pop();
  if (lines.length) return lines.join("\n");
  let out = "";
  for (const ch of text) {
    if (size(out + ch) > bytes) break;
    out += ch;
  }
  return out;
}

/** Markdown for a pull request or comment: ids, versions, digests, capabilities, days and conflict codes only; never skill text or a reason. */
export function catalogueChangesMarkdown(c: CatalogueChanges, opts: { bytes?: number } = {}): string {
  const bytes = Math.max(0, Math.floor(opts.bytes ?? CATALOGUE_CHANGES_MARKDOWN_BYTES));
  const sections: { title: string; items: string[] }[] = [
    { title: "Added", items: c.added.map((s) => `- ${code(`${s.id}@${s.version}`)} ${code(s.digest)}`) },
    { title: "Removed", items: c.removed.map((s) => `- ${code(`${s.id}@${s.version}`)} ${code(s.digest)}`) },
    { title: "Changed", items: c.changed.map((s) => `- ${code(s.id)} ${code(s.old.version)} ${code(s.old.digest)} → ${code(s.next.version)} ${code(s.next.digest)}`) },
    { title: "Deprecated", items: c.deprecated.map((s) => `- ${code(`${s.id}@${s.version}`)} ${code(s.digest)} revoked ${s.on}${s.alreadyRevoked ? " (already revoked)" : ""}`) },
    { title: "Canonical skills", items: c.canonical.map((s) => `- ${code(s.capability)}: ${code(sideText(s.old))} → ${code(sideText(s.next))}`) },
  ].filter((s) => s.items.length > 0);
  const total = sections.reduce((n, s) => n + s.items.length, 0);
  const head = [
    `## Catalogue changes: ${code(c.catalogue)} ${c.from ? `${code(c.from.version)} → ${code(c.to.version)}` : `first release ${code(c.to.version)}`}`,
    "",
    total ? `${total} change${total === 1 ? "" : "s"}.` : "No changes.",
  ];
  const fixed = size(head.join("\n") + "\n") + sections.length * SECTION_BYTES;
  const each = sections.length ? Math.max(0, Math.floor((bytes - fixed) / sections.length)) : 0;
  const lines = [...head];
  for (const s of sections) lines.push("", `### ${s.title}`, "", ...boundedList(s.items, each));
  return fit(lines.join("\n") + "\n", bytes);
}
