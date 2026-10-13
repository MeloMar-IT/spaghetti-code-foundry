import type { SkillLibrarySource, SourceTrustTier } from "./sources.js";

/**
 * A reviewed definition of one repository a skill source may use. Pure data: no file, no network,
 * no commit. Type-only import above: a runtime import from sources.ts would make a cycle.
 */
export interface SkillSourceConnector {
  id: string;
  /** Normalised https URL. */
  repository: string;
  /** As parseRepoUrl(repository).key. */
  repositoryKey: string;
  /** Folders a source may select: each root, or a folder below it. */
  roots: string[];
  adapter: "agent-skills";
  trust: SourceTrustTier;
  licences: string[];
  /** The branch to watch; never a commit. */
  track: string;
}

export const SOURCE_CONNECTORS: readonly SkillSourceConnector[] = Object.freeze([
  Object.freeze({
    id: "awesome-copilot",
    repository: "https://github.com/github/awesome-copilot",
    repositoryKey: "github.com/github/awesome-copilot",
    roots: Object.freeze(["skills"]) as string[],
    adapter: "agent-skills" as const,
    trust: "community" as const,
    licences: Object.freeze(["MIT"]) as string[],
    track: "main",
  }),
]);

export function connectorFor(repositoryKey: string): SkillSourceConnector | undefined {
  return SOURCE_CONNECTORS.find((c) => c.repositoryKey === repositoryKey);
}

/** What is checked; a SkillLibrarySource fits. Undefined fields were already reported and are skipped. */
export interface ConnectorChecked {
  repositoryKey: string;
  paths: readonly string[];
  adapter?: string;
  trust?: string;
  licence: { allow: readonly string[] };
}

const SHOWN_MAX = 80;
const cut = (s: string) => (s.length > SHOWN_MAX ? `${s.slice(0, SHOWN_MAX)}…` : s);

/** Problems of an entry against the connector of its repository; none when there is no connector. */
export function connectorProblems(source: ConnectorChecked): string[] {
  const c = connectorFor(source.repositoryKey);
  if (!c) return [];
  const pre = `connector ${c.id}: `;
  const out: string[] = [];
  for (const p of source.paths) {
    if (!c.roots.some((r) => p === r || p.startsWith(r + "/"))) {
      out.push(`${pre}paths "${cut(p)}" is not allowed; use ${c.roots.join(", ")} or a folder below ${c.roots[0]}/`);
    }
  }
  if (source.adapter !== undefined && source.adapter !== c.adapter) out.push(`${pre}adapter must be ${c.adapter}`);
  if (source.trust !== undefined && source.trust !== c.trust) out.push(`${pre}trust must be ${c.trust}`);
  for (const l of source.licence.allow) {
    if (!c.licences.includes(l)) out.push(`${pre}licence.allow "${cut(l)}" is not accepted; accepted: ${c.licences.join(", ")}`);
  }
  return out;
}

/** A source entry for a connector at an approved commit. Does not validate; parseSources does. */
export function connectorSource(
  connector: SkillSourceConnector,
  o: { commit: string; owner: string; paths?: string[] },
): SkillLibrarySource {
  return {
    id: connector.id,
    repository: connector.repository,
    repositoryKey: connector.repositoryKey,
    status: "enabled",
    ref: { track: connector.track, approved: o.commit },
    paths: o.paths ?? [...connector.roots],
    adapter: connector.adapter,
    trust: connector.trust,
    licence: { allow: [...connector.licences] },
    update: { cadence: "manual" },
    owner: o.owner,
  };
}
