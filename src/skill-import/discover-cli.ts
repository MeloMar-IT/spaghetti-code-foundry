import { resolve } from "node:path";
import { candidatesPath, DISCOVERY_ORIGIN, DiscoveryError, mergeCandidates, parseExport, readCandidates, readExport, type SourceCandidate } from "../skills/discovery.js";
import { readSources, SOURCES_FILE } from "../skills/sources.js";
import { LsRemoteError, resolveHead, type LsRemoteErrorCode } from "./ls-remote.js";

// `scf skills discover [<export-file> [<file>]]`: proposes candidate sources from a saved Skills.sh export. Each repository
// is resolved to the commit its own HEAD points at. Nothing is approved, fetched or staged; the only file written is the
// candidate list. Prints checked values only: nothing from the export is shown.

export const DISCOVER_USAGE = "usage: scf skills discover [<export-file> [<file>]]";

export type HeadResolver = (repository: string, opts: { signal: AbortSignal }) => Promise<string>;
export interface SkillDiscoverOptions {
  cwd?: string;
  now?: Date;
  resolve?: HeadResolver;
}

const syntax = (why: string) => new Error(`${why}\n${DISCOVER_USAGE}`);
const INTERRUPTED = "PROBLEM the discovery was interrupted; the candidate list was not changed";

function unresolvedSentence(code: Exclude<LsRemoteErrorCode, "no-git" | "interrupted">): string {
  switch (code) {
    case "unreachable":
      return "the repository could not be reached";
    case "timeout":
      return "git did not answer in 20 seconds";
    case "bad-answer":
      return "git gave an answer that could not be used";
  }
}

/** `scf skills discover`. `positionals` are the operands after "discover"; the syntax is checked before any read. */
export async function skillDiscoverCommand(
  args: { positionals: string[]; values: Record<string, unknown> },
  out: (line: string) => void,
  opts: SkillDiscoverOptions = {},
): Promise<number> {
  for (const [k, v] of Object.entries(args.values)) if (v !== undefined) throw syntax(`scf skills discover: unexpected option --${k}`);
  if (args.positionals.length > 2) throw syntax("scf skills discover: expects at most an export file and a source file");
  const [exportFile, file] = args.positionals;
  const cwd = opts.cwd ?? process.cwd();

  if (exportFile === undefined) {
    const stored = readCandidates();
    if (!stored.ok) {
      out(`PROBLEM the candidate list ${stored.reason}`);
      return 1;
    }
    for (const c of stored.candidates) out(`${c.repositoryKey}@${c.revision.slice(0, 12)} ${c.status} ${c.origin} ${c.foundAt}`);
    out(`OK ${stored.candidates.length} candidates`);
    return 0;
  }

  const exported = readExport(resolve(cwd, exportFile));
  if (!exported.ok) {
    out(`PROBLEM the export file ${exported.reason}`);
    return 1;
  }
  const sources = readSources(resolve(cwd, file ?? SOURCES_FILE));
  if (sources.state === "invalid") {
    for (const p of sources.problems) out(`PROBLEM ${p.where}: ${p.message}`);
    return 1;
  }
  const status = new Map<string, string>();
  if (sources.state === "none") out("NOTE no skill source list was found; nothing is treated as known");
  else for (const s of sources.manifest.sources) status.set(s.repositoryKey, s.status);
  const existing = readCandidates();
  if (!existing.ok) {
    out(`PROBLEM the candidate list ${existing.reason}`);
    return 1;
  }
  const have = new Set(existing.candidates.map((c) => c.repositoryKey));

  const aborter = new AbortController();
  const onSignal = () => aborter.abort();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    const resolver: HeadResolver = opts.resolve ?? resolveHead;
    const found: SourceCandidate[] = [];
    let known = 0;
    let already = 0;
    let unresolved = 0;
    for (const r of exported.repositories) {
      if (aborter.signal.aborted) break;
      const state = status.get(r.repositoryKey);
      if (state !== undefined) {
        known++;
        out(`KNOWN ${r.repositoryKey} is in the source list (${state})`);
        continue;
      }
      if (have.has(r.repositoryKey)) {
        already++;
        continue;
      }
      try {
        const revision = await resolver(r.repository, { signal: aborter.signal });
        found.push({
          repository: r.repository,
          repositoryKey: r.repositoryKey,
          revision,
          status: "proposed",
          origin: DISCOVERY_ORIGIN,
          listed: r.listed,
          foundAt: (opts.now ?? new Date()).toISOString(),
        });
        out(`PROPOSED ${r.repositoryKey}@${revision.slice(0, 12)} (${r.listed} listed)`);
      } catch (e) {
        if (!(e instanceof LsRemoteError)) throw e;
        if (e.code === "interrupted") break;
        if (e.code === "no-git") {
          out("PROBLEM git was not found; install git and try again");
          return 1;
        }
        unresolved++;
        out(`UNRESOLVED ${r.repositoryKey}: ${unresolvedSentence(e.code)}`);
      }
    }
    if (aborter.signal.aborted) {
      out(INTERRUPTED);
      return 1;
    }
    let merged: ReturnType<typeof mergeCandidates>;
    try {
      merged = mergeCandidates(found, new Set(status.keys()));
    } catch (e) {
      if (e instanceof DiscoveryError) {
        out(`PROBLEM ${e.message}`);
        return 1;
      }
      throw e;
    }
    if (exported.skipped > 0) out(`SKIPPED ${exported.skipped} entries without a GitHub repository`);
    if (exported.hidden > 0) out(`SKIPPED ${exported.hidden} entries that look like a credential`);
    for (const key of merged.removed) out(`REMOVED ${key} is now in the source list`);
    out(`OK ${found.length} proposed, ${already} already candidates, ${known} in the source list, ${unresolved} unresolved`);
    out(`Candidates: ${candidatesPath()}`);
    return unresolved > 0 ? 1 : 0;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
