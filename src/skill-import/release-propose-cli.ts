import { homedir } from "node:os";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { dataHome } from "../auth/store.js";
import { ConfigSchema, loadConfig, type Config, type SkillsConfig } from "../config.js";
import { appendApprovedEntry, checkApprovedEdit, normalRepository, releaseBranch, releasePullRequest, type DeploymentEntry } from "../skills/release-deployment.js";
import { artifactFolder, loadReleaseDir, parseReleaseTarget, type LoadedRelease } from "../skills/release-cli.js";
import { catalogueChangeLines, catalogueChanges, type CatalogueChanges } from "../skills/release-changes.js";
import { approvalSignatureState, decodeBase64Exact } from "../skills/release-signature.js";
import { listStoredReleases } from "../skills/release-store.js";
import { artifactPathProblem, compareSkillVersions, SKILL_ID_RE } from "../skills/schema.js";
import { catalogueSentence, Interrupted, NOTHING, tickFor, withSignal } from "./update-common.js";
import { CatalogueError, commitFile, createPullRequest, defaultBranch, deleteOwnBranch, fetchBase, openPullRequest, originRepo, pushNewBranch, readBlob, showPrefix, type CatalogueContext } from "./catalogue-git.js";

// `scf skills release propose <catalogue>@<version>`: in a clone of the deployment repository, appends one approved entry to the
// configured config file, pushes the branch skill-catalogue/<catalogue>-<version> and opens a pull request with the catalogue
// change report. The local config, the data folder and the release store are never written. Prints checked fields and fixed
// sentences only; the text of git, gh and the config files never reaches the output.

export const PROPOSE_USAGE = "usage: scf skills release propose <catalogue>@<version> [--artifact <absolute folder>] [--key <key-id> --signature <base64>]";
const INTERRUPTED = `PROBLEM the proposal was interrupted; ${NOTHING}`;
const CANNOT = "the deployment file has a form this command cannot edit byte for byte";

export interface ReleaseProposeOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  userHome?: string;
  skills?: SkillsConfig;
}

const syntax = (why: string) => new Error(`${why}\n${PROPOSE_USAGE}`);
type Outcome = "OK" | "OPEN" | "UNCHANGED" | "PROBLEM";

/** `scf skills release propose`. `positionals` are the operands after "propose"; the syntax is checked before anything is read. */
export async function releaseProposeCommand(
  args: { positionals: string[]; values: Record<string, unknown> },
  out: (line: string) => void,
  opts: ReleaseProposeOptions = {},
): Promise<number> {
  const { key, signature, artifact, ...rest } = args.values;
  for (const [k, v] of Object.entries(rest)) if (v !== undefined) throw syntax(`scf skills release propose: unexpected option --${k}`);
  if (args.positionals.length !== 1) throw syntax("scf skills release propose: expects one <catalogue>@<version>");
  const target = parseReleaseTarget(args.positionals[0]!);
  if (!target) throw syntax("scf skills release propose: the operand must be <catalogue>@<version>");
  if ((key === undefined) !== (signature === undefined)) throw syntax("scf skills release propose: --key and --signature are given together");
  if (key !== undefined && (typeof key !== "string" || !SKILL_ID_RE.test(key))) throw syntax("scf skills release propose: --key must be a key id from skills.releases.keys");
  if (signature !== undefined && (typeof signature !== "string" || !decodeBase64Exact(signature, 64))) throw syntax("scf skills release propose: --signature must be base64 of 64 bytes");
  if (artifact !== undefined && (typeof artifact !== "string" || artifact === "" || artifactPathProblem(artifact))) throw syntax("scf skills release propose: --artifact must be an absolute folder path");

  const given = { key: key as string | undefined, signature: signature as string | undefined, artifact: artifact as string | undefined };
  return withSignal(async (signal) => {
    try {
      return (await run(target, given, out, opts, signal)) === "PROBLEM" ? 1 : 0;
    } catch (e) {
      if (e instanceof Interrupted) {
        out(INTERRUPTED);
        return 1;
      }
      if (e instanceof CatalogueError) {
        out(`PROBLEM ${proposeSentence(e.code)}`);
        return 1;
      }
      throw e;
    }
  });
}

function proposeSentence(code: CatalogueError["code"], gh: "list" | "create" = "list"): string {
  if (code === "not-a-repository") return "this folder is not in a git work tree; run the command in a clone of the deployment repository";
  if (code === "read-failed") return `the deployment file could not be read from origin; ${NOTHING}`;
  return catalogueSentence(code, gh);
}

/** The newest approved release of the catalogue that can be shown as the old side: from the store, else from the local artifact. */
function loadBaseline(cfg: SkillsConfig, home: string, prev: { catalogue: string; version: string; digest: string }, o: { env: NodeJS.ProcessEnv; userHome: string }): LoadedRelease | undefined {
  const t = { catalogue: prev.catalogue, version: prev.version };
  const listing = listStoredReleases(home);
  const stored = listing.releases.find((r) => r.catalogue === t.catalogue && r.version === t.version);
  if (stored) {
    const r = loadReleaseDir(stored.dir, t);
    if (typeof r !== "string" && r.digest === prev.digest) return r;
  }
  const local = cfg.releases.approved.find((a) => a.catalogue === t.catalogue && a.version === t.version && a.digest === prev.digest && a.artifact !== undefined);
  if (!local?.artifact) return undefined;
  const folder = artifactFolder(local.artifact, { home, env: o.env, userHome: o.userHome });
  if (!("real" in folder)) return undefined;
  const r = loadReleaseDir(folder.real, t);
  return typeof r !== "string" && r.digest === prev.digest ? r : undefined;
}

async function run(
  target: { catalogue: string; version: string },
  given: { key?: string; signature?: string; artifact?: string },
  out: (line: string) => void,
  opts: ReleaseProposeOptions,
  signal: AbortSignal,
): Promise<Outcome> {
  const problem = (text: string): "PROBLEM" => {
    out(`PROBLEM ${text}`);
    return "PROBLEM";
  };
  const tick = tickFor(signal);
  const { catalogue, version } = target;
  const name = `${catalogue}@${version}`;
  const env = opts.env ?? process.env;
  const home = opts.home ?? dataHome();
  const userHome = opts.userHome ?? homedir();

  // 1. the local config
  let cfg: SkillsConfig;
  try {
    cfg = opts.skills ?? loadConfig().skills;
  } catch {
    return problem(`the local config cannot be read or is not a valid config; ${NOTHING}`);
  }
  const deployment = cfg.releases.deployment;
  if (!deployment) return problem(`skills.releases.deployment is not set; name the deployment repository and file in the config; ${NOTHING}`);
  const file = deployment.file;

  // 2. the release, offline
  let next: LoadedRelease;
  if (given.artifact !== undefined) {
    const folder = artifactFolder(given.artifact, { home, env, userHome });
    if ("missing" in folder) return problem(`the artifact folder does not exist; ${NOTHING}`);
    if ("problem" in folder) return problem(`${folder.problem}; ${NOTHING}`);
    const r = loadReleaseDir(folder.real, target);
    if (typeof r === "string") return problem(r);
    next = r;
  } else {
    const listing = listStoredReleases(home);
    if (listing.refused || listing.unreadable) return problem(`the release store cannot be read; ${NOTHING}`);
    const found = listing.releases.find((r) => r.catalogue === catalogue && r.version === version);
    if (!found) return problem(`${name} is not in the release store; give --artifact <folder> for a release you did not publish; ${NOTHING}`);
    const r = loadReleaseDir(found.dir, target);
    if (typeof r === "string") return problem(r);
    next = r;
  }
  const entry: DeploymentEntry = { catalogue, version, digest: next.digest, ...(given.key !== undefined ? { key: given.key, signature: given.signature } : {}) };

  // 3. git and origin
  const ctx: CatalogueContext = { cwd: resolve(opts.cwd ?? process.cwd()), env };
  showPrefix(ctx);
  await tick();
  const repo = originRepo(ctx);
  await tick();
  if (repo === undefined) return problem("the address of origin is not a GitHub repository address; the pull request needs it");
  if (normalRepository(repo) !== normalRepository(deployment.repository)) {
    return problem(`origin is ${repo}, not the deployment repository ${deployment.repository}; run the command in a clone of it; ${NOTHING}`);
  }

  // 4. the file on origin
  const base = defaultBranch(ctx);
  await tick();
  const baseCommit = fetchBase(ctx, base);
  await tick();
  const blob = readBlob(ctx, baseCommit, file);
  await tick();
  if (!blob) return problem(`${file} is not on origin/${base}; ${NOTHING}`);
  const before = blob.content.toString("utf8");
  if (!Buffer.from(before, "utf8").equals(blob.content)) return problem(`${CANNOT}; ${NOTHING}`);
  let parsed: Config;
  try {
    const res = ConfigSchema.safeParse(parseYaml(before) ?? {});
    if (!res.success) {
      const i = res.error.issues[0]!;
      return problem(`${file} on origin/${base} is not a valid config: ${i.path.join(".")}: ${i.message}; ${NOTHING}`);
    }
    parsed = res.data as Config;
  } catch {
    return problem(`${file} on origin/${base} is not a valid config; ${NOTHING}`);
  }
  const approved = parsed.skills.releases.approved;

  // 5. the same version already in the file
  const same = approved.find((a) => a.catalogue === catalogue && a.version === version);
  if (same) {
    if (same.digest !== entry.digest) return problem(`${file} already approves ${name} with another digest; ${NOTHING}`);
    out(`UNCHANGED ${name} ${entry.digest} is already in ${file}; nothing to propose`);
    return "UNCHANGED";
  }

  // 6. an open pull request
  const branch = releaseBranch(catalogue, version);
  const already = openPullRequest(ctx, repo, branch);
  await tick();
  if (already !== undefined) {
    out(`OPEN ${already} for ${name}; no second pull request was opened`);
    return "OPEN";
  }

  // 7. only a newer version
  let previous: (typeof approved)[number] | undefined;
  for (const a of approved) if (a.catalogue === catalogue && (!previous || compareSkillVersions(a.version, previous.version) > 0)) previous = a;
  if (previous && compareSkillVersions(version, previous.version) <= 0) {
    return problem(`${name} is not newer than the approved ${catalogue}@${previous.version}; ${NOTHING}`);
  }

  // 8. signature
  const fileKeys = parsed.skills.releases.keys;
  if (given.key === undefined) {
    if (fileKeys.length || cfg.releases.keys.length) {
      return problem(`skills.releases.keys is set, so the entry needs --key <key-id> --signature <base64> from "scf skills release sign"; ${NOTHING}`);
    }
  } else {
    const state = approvalSignatureState(entry, fileKeys);
    if (state.state === "unsigned") return problem(`the key ${given.key} is not in skills.releases.keys of ${file}; ${NOTHING}`);
    if (state.state === "bad") return problem(`the signature does not verify for ${name} ${entry.digest}; ${NOTHING}`);
  }

  // 9. the edit
  const edited = appendApprovedEntry(before, entry);
  if ("problem" in edited) return problem(`${edited.problem}; ${NOTHING}`);
  const checked = checkApprovedEdit(before, edited.text, entry);
  if ("problem" in checked) return problem(`${checked.problem}; ${NOTHING}`);

  // 10. the change report (required)
  const cannot = `the change report against ${catalogue}@${previous?.version} cannot be built: it is not in the release store and no artifact in the local config for it verifies; ${NOTHING}`;
  let changes: CatalogueChanges;
  try {
    if (!previous) changes = catalogueChanges(undefined, next.manifest, { old: [], next: next.packages }, { highRisk: cfg.unresolved.high_risk });
    else {
      const old = loadBaseline(cfg, home, { catalogue, version: previous.version, digest: previous.digest }, { env, userHome });
      if (!old) return problem(cannot);
      changes = catalogueChanges(old.manifest, next.manifest, { old: old.packages, next: next.packages }, { highRisk: cfg.unresolved.high_risk });
    }
  } catch (e) {
    if (!(e instanceof RangeError || e instanceof TypeError)) throw e;
    return problem(previous ? cannot : `the change report cannot be built; ${NOTHING}`);
  }
  await tick();
  const n = catalogueChangeLines(changes).length;
  out(`CHANGES ${catalogue}@${changes.from?.version ?? "none"} -> ${version}: ${n} change${n === 1 ? "" : "s"}`);

  // 11. commit, push, pull request
  const pr = releasePullRequest({ file, entry, signedBy: given.key, previous: previous && { version: previous.version, digest: previous.digest }, changes });
  const proposal = commitFile(ctx, baseCommit, file, Buffer.from(edited.text, "utf8"), blob.mode, pr.title);
  await tick();

  // From here on a branch may exist on origin; it is deleted only while it still holds this commit.
  const cleanup = (): boolean => deleteOwnBranch(ctx, branch, proposal);
  const leftover = (text: string) => problem(`${text}; the branch ${branch} may still be on origin: delete it by hand`);
  try {
    pushNewBranch(ctx, branch, proposal);
  } catch (e) {
    if (!(e instanceof CatalogueError)) throw e;
    const cleaned = cleanup();
    let competing: string | undefined;
    try {
      competing = openPullRequest(ctx, repo, branch);
    } catch {
      // not known; the push failure is reported
    }
    if (competing !== undefined) {
      out(`OPEN ${competing} for ${name}; no second pull request was opened`);
      return "OPEN";
    }
    const sentence = proposeSentence(e.code);
    return cleaned ? problem(sentence) : leftover(sentence);
  }
  try {
    await tick();
  } catch (e) {
    if (!(e instanceof Interrupted)) throw e;
    out(cleanup() ? INTERRUPTED : `PROBLEM the proposal was interrupted; the branch ${branch} may still be on origin: delete it by hand`);
    return "PROBLEM";
  }

  let url: string | undefined;
  let failure: CatalogueError | undefined;
  try {
    url = createPullRequest(ctx, { repo, base, head: branch, title: pr.title, body: pr.body });
  } catch (e) {
    if (!(e instanceof CatalogueError)) throw e;
    failure = e;
  }
  if (url === undefined) {
    // gh may have made the pull request before it failed: look before the branch is removed
    try {
      url = openPullRequest(ctx, repo, branch);
    } catch {
      // not known
    }
  }
  if (url === undefined) {
    const cleaned = cleanup();
    const sentence = proposeSentence(failure?.code ?? "gh-failed", "create");
    return cleaned ? problem(sentence) : leftover(sentence);
  }
  let interrupted = false;
  try {
    await tick();
  } catch (e) {
    if (!(e instanceof Interrupted)) throw e;
    interrupted = true;
  }
  out(`OK opened ${url} for ${name}; an installation uses it only after its config names it${interrupted ? " (interrupted after the pull request was opened)" : ""}`);
  return "OK";
}
