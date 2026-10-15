import { opendirSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, type Config } from "../config.js";
import { collectLicenceEvidence } from "../skills/licence.js";
import { prepareImport, SkillImportError } from "../skills/import-plan.js";
import { emptyImportLines, frontendEvidence, frontendProfileFor, repoScanGaps } from "../skills/frontend-connector.js";
import { buildRepoProfile } from "../skills/repo-profile.js";
import { discoverSkills } from "../skills/registry.js";
import { SKILL_ID_RE } from "../skills/schema.js";
import { evaluateSource, evaluationFailed, evaluationLines } from "../skills/source-evaluation.js";
import { readScanExceptions, SCAN_EXCEPTIONS_FILE } from "../skills/scan-exceptions.js";
import { readSources, SOURCES_FILE } from "../skills/sources.js";
import { gitSentence } from "./cli.js";
import { GitTreeError, openGitTree } from "./git-tree.js";

// `scf skills evaluate <source-id> [<technology>@<version> ...]`: fetches the approved commit of an enabled source into a
// temporary git folder and reports compatibility, tools, access, licence and overlap. Stages and writes nothing else.

export const EVALUATE_USAGE = "usage: scf skills evaluate <source-id> [<technology>@<version> ... | --repo <dir>]";
const MAX_TECHNOLOGIES = 8;
const TECH_RE = /^([a-z0-9]+(?:-[a-z0-9]+)*)@(\d{1,6}(?:\.\d{1,6}){0,2})$/;

export interface SkillEvaluateOptions {
  cwd?: string;
  home?: string;
  /** Tests: a local repository used instead of the https address. */
  remote?: string;
  env?: NodeJS.ProcessEnv;
  open?: typeof openGitTree;
  skills?: Config["skills"];
  now?: Date;
}

const syntax = (why: string) => new Error(`${why}\n${EVALUATE_USAGE}`);

export async function skillEvaluateCommand(
  args: { positionals: string[]; values: Record<string, unknown> },
  out: (line: string) => void,
  opts: SkillEvaluateOptions = {},
): Promise<number> {
  for (const [k, v] of Object.entries(args.values)) if (v !== undefined && k !== "repo") throw syntax(`scf skills evaluate: unexpected option --${k}`);
  const repo = args.values.repo;
  if (repo !== undefined && (typeof repo !== "string" || repo === "")) throw syntax("scf skills evaluate: --repo needs a folder");
  const [id, ...operands] = args.positionals;
  if (id === undefined) throw syntax("scf skills evaluate: expects a source id");
  if (!SKILL_ID_RE.test(id)) throw syntax("scf skills evaluate: the source id must be a lower-case slug");
  if (operands.length > MAX_TECHNOLOGIES) throw syntax(`scf skills evaluate: at most ${MAX_TECHNOLOGIES} technologies`);
  if (repo !== undefined && operands.length) throw syntax("scf skills evaluate: give technologies or --repo, not both");
  let project: { name: string; version: string }[] = [];
  for (const op of operands) {
    const m = TECH_RE.exec(op);
    if (!m) throw syntax("scf skills evaluate: a technology must look like oracle@19");
    if (project.some((p) => p.name === m[1])) throw syntax(`scf skills evaluate: ${m[1]} is given twice`);
    project.push({ name: m[1]!, version: m[2]! });
  }

  const now = opts.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const cwd = opts.cwd ?? process.cwd();
  const read = readSources(resolve(cwd, SOURCES_FILE));
  if (read.state === "none") {
    out("PROBLEM the skill source file does not exist");
    return 1;
  }
  if (read.state === "invalid") {
    for (const p of read.problems) out(`PROBLEM ${p.where}: ${p.message}`);
    return 1;
  }
  const source = read.manifest.sources.find((s) => s.id === id);
  if (!source) {
    out(`PROBLEM no source with the id ${id}`);
    return 1;
  }
  if (source.status !== "enabled") {
    out(`PROBLEM the source ${id} is ${source.status}; only an enabled source can be evaluated`);
    return 1;
  }
  const commit = source.ref.approved;
  if (commit === undefined) {
    out(`PROBLEM the source ${id} has no approved commit (ref.approved)`);
    return 1;
  }
  const profile = frontendProfileFor(source.repositoryKey);
  if (profile && source.scope) {
    out(`PROBLEM the source ${id} uses the reviewed profile ${profile.id}, so it cannot have a scope`);
    return 1;
  }
  if (repo !== undefined) {
    if (!profile) {
      out("PROBLEM --repo needs a source with a reviewed profile; give technologies as <technology>@<version>");
      return 1;
    }
    let scan;
    try {
      const abs = resolve(cwd, repo as string);
      opendirSync(abs).closeSync();
      scan = buildRepoProfile(abs);
    } catch {
      out("PROBLEM the folder given with --repo cannot be read");
      return 1;
    }
    const gaps = repoScanGaps(scan);
    if (gaps.length) {
      out(`PROBLEM the folder given with --repo could not be read completely (${gaps.join(", ")}); give technologies as <technology>@<version>`);
      return 1;
    }
    project = frontendEvidence(profile, scan);
  }
  const exc = readScanExceptions(resolve(cwd, SCAN_EXCEPTIONS_FILE), today);
  if (exc.state === "invalid") {
    for (const p of exc.problems) out(`PROBLEM ${p.where}: ${p.message}`);
    return 1;
  }
  const exceptions = exc.state === "ok" ? exc.manifest.exceptions : [];

  const aborter = new AbortController();
  const onSignal = () => aborter.abort();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    let fetched: { prep: ReturnType<typeof prepareImport>; evidence: ReturnType<typeof collectLicenceEvidence> } | undefined;
    let failed: unknown;
    try {
      const tree = await (opts.open ?? openGitTree)(source, commit, { remote: opts.remote, env: opts.env, signal: aborter.signal });
      try {
        const prep = prepareImport(source, tree);
        const evidence = collectLicenceEvidence({ repositoryKey: prep.record.repositoryKey, commit: prep.record.commit }, prep.record.skills.map((s) => s.root), tree);
        fetched = { prep, evidence };
      } finally {
        tree.close();
      }
    } catch (e) {
      failed = e;
    }
    if (failed !== undefined && !(failed instanceof GitTreeError) && !(failed instanceof SkillImportError)) throw failed;
    // A signal that came in while a synchronous git call ran is delivered by the next event-loop turns.
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    if (aborter.signal.aborted) {
      out("PROBLEM the evaluation was interrupted");
      return 1;
    }
    try {
      if (failed !== undefined) throw failed;
      const skills = opts.skills ?? loadConfig().skills;
      const reg = discoverSkills(skills, { home: opts.home });
      const evaluation = evaluateSource({
        source,
        prep: fetched!.prep,
        evidence: fetched!.evidence,
        installed: reg.skills,
        exceptions,
        today,
        retrievedAt: now.toISOString().replace(/\.\d+Z$/, "Z"),
        tools: skills.tools,
        highRisk: skills.unresolved.high_risk,
        ...(project.length || repo !== undefined ? { project } : {}),
        results: [],
      });
      for (const line of evaluationLines(evaluation)) out(line);
      return evaluationFailed(evaluation) ? 1 : 0;
    } catch (e) {
      if (e instanceof GitTreeError) {
        out(`PROBLEM ${gitSentence(e.code, source.repositoryKey, commit)}`);
        return 1;
      }
      if (e instanceof SkillImportError) {
        if (e.code === "nothing-staged" && profile) {
          for (const line of emptyImportLines(profile, source, commit, e.rejected)) out(line);
          return 1;
        }
        if (e.code === "nothing-staged") for (const r of e.rejected) out(`REJECTED ${r.root}: ${r.reasons.join("; ")}`);
        out(`PROBLEM ${e.message}`);
        return 1;
      }
      throw e;
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
