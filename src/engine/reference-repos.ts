import { chmodSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isLocalRepoName } from "../auth/local-name.js";
import { validGithubName } from "../auth/repo-url.js";
import { findLocalRepo, findOwnedRepo, repoAccess, type RepoAccess } from "../auth/repos.js";
import { referenceFolderName, referenceListProblem, type Config } from "../config.js";
import { CHECKOUT_TIMEOUT_MS, gitIn, shallowClone, type PreviewSource, type ShallowCloneOptions, type ShallowCloneResult } from "../preview/checkout.js";
import { RULE_SAFE_PATH } from "./context-index.js";
import type { RunPolicy } from "./policy-hooks.js";
import { appTokenAccess, type AppTokenResult } from "./repo-access.js";
import { REFERENCE_DIR, type ReferenceRecord, type RunReferences, type RunSummary } from "./state.js";

/**
 * Reference repositories (#878): read-only, shallow copies of other repositories of the run's owner, made at
 * `<run folder>/reference/<owner>-<name>` before the steps of a run start (also on resume) and removed when it ends.
 * A reference that cannot be used is noted and skipped; nothing here fails the run.
 */

export { REFERENCE_DIR };
export const MAX_REFERENCES = 10;
const MAX_RECORDS = 50;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const LOOKUP_TIMEOUT_MS = 10_000;
const CACHE_MS = 10 * 60_000;
/** The App token of a clone: the same as APP_PERMISSIONS.clone of the repository broker. */
const CLONE_PERMISSIONS = { contents: "read" } as const;

export const REF_NO_ACCESS = "the run's owner cannot use this repository";
export const REF_PRIVATE = "it is private (or its visibility is not known) and this repository is not known to be private; set reference_private_ok on the watcher to allow it";
export const REF_FETCH_FAILED = "it could not be fetched";
export const REF_POLICY = "a policy refused access to it";
export const REF_PATH = "the reference folder of this run cannot be used";
export const REF_NO_SANDBOX = "this run has no OS sandbox, so a shell step could make a copy writable again; references need a sandboxed run";

export type Visibility = "public" | "private" | "unknown";
type Credential = "none" | "machine" | "repository";

export interface ReferenceDeps {
  /** How the run's owner may read a repository. Default: repoAccess, unlisted repositories refused. */
  access?: (owner: string | undefined, repo: string) => RepoAccess;
  /** The credential a reference would use, for the policy question; read without a secret. */
  credential?: (owner: string | undefined, repo: string) => Credential;
  /** The visibility of a reference. Default: an anonymous GitHub lookup. */
  visibility?: (repo: string) => Promise<Visibility>;
  /** Whether the run's own repository is known to be private. Asked only when a reference is not public. */
  targetVisibility?: (summary: Pick<RunSummary, "vars" | "owner">, config: Pick<Config, "github_app" | "bot">) => Promise<"private" | "unknown">;
  appToken?: (access: Extract<RepoAccess, { kind: "app" }>, config: Pick<Config, "github_app">) => Promise<AppTokenResult>;
  clone?: (o: ShallowCloneOptions) => Promise<ShallowCloneResult>;
  /** The commit of a fresh copy, after its remote is removed. */
  head?: (dir: string, signal?: AbortSignal) => Promise<string | undefined>;
  now?: () => Date;
}

/** The reference list saved with a run, checked: 1–10 valid distinct names and an optional boolean. Anything else is undefined. */
export function checkedReferences(x: unknown): RunReferences | undefined {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return undefined;
  const { repos, privateOk } = x as { repos?: unknown; privateOk?: unknown };
  if (!Array.isArray(repos) || repos.length === 0 || repos.length > MAX_REFERENCES) return undefined;
  if (!repos.every((r): r is string => typeof r === "string")) return undefined;
  if (referenceListProblem(repos) !== undefined) return undefined;
  if (privateOk !== undefined && typeof privateOk !== "boolean") return undefined;
  return { repos: [...repos], ...(privateOk === true ? { privateOk: true as const } : {}) };
}

export const referencesDir = (runDir: string): string => join(runDir, REFERENCE_DIR);

// ---- visibility --------------------------------------------------------------------------------------

const cache = new Map<string, { v: Visibility; until: number }>();

/** Tests only. */
export function clearVisibilityCache(): void {
  cache.clear();
}

async function lookup(repo: string, token: string | undefined, fetchImpl: typeof fetch): Promise<{ private?: unknown } | undefined> {
  const res = await fetchImpl(`https://api.github.com/repos/${repo}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "claude-factory", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  });
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => {});
    return undefined;
  }
  const body = (await res.json()) as unknown;
  return typeof body === "object" && body !== null ? (body as { private?: unknown }) : undefined;
}

/** Anonymous: public only on a 200 with `private: false`; a 404 or any other answer is unknown. Cached for 10 minutes. Never throws. */
export async function githubVisibility(repo: string, fetchImpl: typeof fetch = fetch, now: () => number = Date.now): Promise<Visibility> {
  if (!validGithubName(repo)) return "unknown";
  const key = repo.toLowerCase();
  const hit = cache.get(key);
  if (hit && hit.until > now()) return hit.v;
  let v: Visibility = "unknown";
  try {
    const body = await lookup(repo, undefined, fetchImpl);
    if (body?.private === false) v = "public";
  } catch {
    v = "unknown";
  }
  cache.set(key, { v, until: now() + CACHE_MS });
  return v;
}

export interface TargetDeps {
  access?: (owner: string | undefined, repo: string) => RepoAccess;
  appToken?: (access: Extract<RepoAccess, { kind: "app" }>, config: Pick<Config, "github_app">) => Promise<AppTokenResult>;
  findLocal?: (name: string) => { settings?: { pushRemote?: boolean } } | undefined;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

/**
 * Whether the run's repository is private, on affirmative and current evidence only: a local project without a push remote,
 * or a GitHub repository whose lookup with its own sign-in says `private: true`. Not cached. Anything else is unknown. Never throws.
 */
export async function targetVisibility(summary: Pick<RunSummary, "vars" | "owner">, config: Pick<Config, "github_app" | "bot">, deps: TargetDeps = {}): Promise<"private" | "unknown"> {
  const repo = summary.vars?.github_repo ?? "";
  try {
    if (isLocalRepoName(repo)) {
      const rec = (deps.findLocal ?? findLocalRepo)(repo);
      return rec && rec.settings?.pushRemote !== true ? "private" : "unknown";
    }
    if (!validGithubName(repo)) return "unknown";
    const a = (deps.access ?? ((o, n) => repoAccess(o, n, { unlisted: "admin-server" })))(summary.owner, repo);
    let token: string | undefined;
    if (a.kind === "token") token = a.token;
    else if (a.kind === "app") {
      const t = await (deps.appToken ?? ((x, c) => appTokenAccess(x, c, 20_000, CLONE_PERMISSIONS)))(a, config);
      token = t.ok ? t.token : undefined;
    } else if (a.kind === "server") {
      const name = config.bot?.gh_token_env;
      token = name ? (deps.env ?? process.env)[name] : undefined;
    }
    if (!token) return "unknown";
    const body = await lookup(repo, token, deps.fetch ?? fetch);
    return body?.private === true ? "private" : "unknown";
  } catch {
    return "unknown";
  }
}

// ---- the copies ----------------------------------------------------------------------------------------

/** Sets files to 0444 and folders to 0555, deepest first, `dir` last. Throws on a link or anything that is not a file or folder. */
function lockTree(dir: string): void {
  const files: string[] = [];
  const folders: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isDirectory()) {
        walk(p);
        folders.push(p);
      } else if (st.isFile()) files.push(p);
      else throw new Error("not a file or folder");
    }
  };
  walk(dir);
  folders.push(dir);
  for (const f of files) chmodSync(f, 0o444);
  for (const f of folders) chmodSync(f, 0o555);
}

/** Sets folders back to 0700, top-down, never following a link. Never throws. */
function unlockTree(dir: string): void {
  try {
    if (!lstatSync(dir).isDirectory()) return;
    chmodSync(dir, 0o700);
    for (const n of readdirSync(dir)) unlockTree(join(dir, n));
  } catch {
    // not ours, or gone
  }
}

/** Removes `<run folder>/reference` with every copy in it. True when nothing is left there. Never throws. */
export function removeReferences(runDir: string): boolean {
  const dir = referencesDir(runDir);
  try {
    lstatSync(dir);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT";
  }
  try {
    unlockTree(dir);
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // checked below
  }
  try {
    lstatSync(dir);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/** The commit of a fresh copy, after its remote is removed (a copy has no address to push to). Undefined when either fails. */
async function defaultHead(dir: string, signal?: AbortSignal): Promise<string | undefined> {
  const r = await gitIn(dir, ["rev-parse", "HEAD"], { signal });
  if (r.code !== 0) return undefined;
  const unlinked = await gitIn(dir, ["remote", "remove", "origin"], { signal });
  return unlinked.code === 0 ? r.stdout.trim() : undefined;
}

function defaultCredential(owner: string | undefined, repo: string): Credential {
  if (!owner) return "none";
  try {
    const rec = findOwnedRepo(owner, repo);
    return !rec ? "none" : rec.method === "none" ? "machine" : "repository";
  } catch {
    return "none";
  }
}

type Source = { source: PreviewSource } | { refused: string };

async function sourceOf(a: RepoAccess, repo: string, config: Pick<Config, "github_app">, deps: ReferenceDeps): Promise<Source> {
  if (a.kind === "refused") return { refused: `${REF_NO_ACCESS} (${a.reason})` };
  if (a.kind === "token") return { source: { kind: "remote", url: a.url, auth: { method: "https-token", username: a.username, secret: a.token } } };
  if (a.kind === "key") return { source: { kind: "remote", url: a.url, auth: { method: "ssh-deploy-key", secret: a.key } } };
  if (a.kind === "server") return { source: { kind: "remote", url: `https://github.com/${repo}.git`, auth: { method: "none" } } };
  const t = await (deps.appToken ?? ((x, c) => appTokenAccess(x, c, 20_000, CLONE_PERMISSIONS)))(a, config);
  return t.ok ? { source: { kind: "remote", url: a.url, auth: { method: "github-token", secret: t.token } } } : { refused: t.reason };
}

export interface PrepareContext {
  log: (line: string) => void;
  policy?: Pick<RunPolicy, "at">;
  signal?: AbortSignal;
  /** True when the run's steps run in the OS sandbox. Without it no copy is made: file modes alone do not stop a shell step's chmod. */
  sandboxed: boolean;
}

/**
 * Makes the copies of `summary.referenceRepos` and adds one record per reference to `summary.references` (all with the
 * same `at`). Leftovers of an earlier start are removed first. Does nothing for a run without references. Never throws.
 */
export async function prepareReferences(summary: RunSummary, config: Pick<Config, "github_app" | "bot">, ctx: PrepareContext, deps: ReferenceDeps = {}): Promise<void> {
  const refs = checkedReferences(summary.referenceRepos);
  if (!refs) return;
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const records: ReferenceRecord[] = [];
  const say = (line: string) => {
    try {
      ctx.log(line);
    } catch {
      // a log that fails must not stop the run
    }
  };
  const skip = (repo: string, reason: string) => {
    records.push({ repo, at, ok: false, reason });
    say(`! reference ${repo}: skipped — ${reason}`);
  };
  const base = referencesDir(summary.runDir);
  if (!ctx.sandboxed) {
    removeReferences(summary.runDir);
    for (const repo of refs.repos) skip(repo, REF_NO_SANDBOX);
    summary.references = [...(Array.isArray(summary.references) ? summary.references : []), ...records].slice(-MAX_RECORDS);
    return;
  }
  let usable = RULE_SAFE_PATH.test(summary.runDir) && removeReferences(summary.runDir);
  if (usable) {
    try {
      mkdirSync(base, { mode: 0o700 });
    } catch {
      usable = false;
    }
  }
  let target: "private" | "unknown" | undefined;
  for (const repo of refs.repos) {
    try {
      if (!usable) {
        skip(repo, REF_PATH);
        continue;
      }
      const credential = (deps.credential ?? defaultCredential)(summary.owner, repo);
      const answer = ctx.policy?.at("repository.access", { repository: repo.toLowerCase(), credential });
      if (answer?.denied) {
        skip(repo, `${REF_POLICY} (${answer.denied.reason})`);
        continue;
      }
      const a = (deps.access ?? ((o, n) => repoAccess(o, n, { unlisted: "refuse" })))(summary.owner, repo);
      if (a.kind === "refused") {
        skip(repo, `${REF_NO_ACCESS} (${a.reason})`);
        continue;
      }
      if (!refs.privateOk) {
        const vis = await (deps.visibility ?? ((r) => githubVisibility(r)))(repo);
        if (vis !== "public") {
          target ??= await (deps.targetVisibility ?? ((s, c) => targetVisibility(s, c)))(summary, config);
          if (target !== "private") {
            skip(repo, REF_PRIVATE);
            continue;
          }
        }
      }
      const src = await sourceOf(a, repo, config, deps);
      if ("refused" in src) {
        skip(repo, src.refused);
        continue;
      }
      const folder = referenceFolderName(repo);
      const dir = join(base, folder);
      const cloned = await (deps.clone ?? shallowClone)({ source: src.source, dir, signal: ctx.signal, timeoutMs: CHECKOUT_TIMEOUT_MS, gitConfig: [["core.symlinks", "false"]] });
      if (!cloned.ok) {
        removeCopy(dir);
        skip(repo, REF_FETCH_FAILED);
        continue;
      }
      const commit = await (deps.head ?? defaultHead)(dir, ctx.signal);
      if (!commit || !COMMIT.test(commit)) {
        removeCopy(dir);
        skip(repo, REF_FETCH_FAILED);
        continue;
      }
      try {
        lockTree(dir);
      } catch {
        removeCopy(dir);
        skip(repo, REF_FETCH_FAILED);
        continue;
      }
      records.push({ repo, at, ok: true, commit, folder: `${REFERENCE_DIR}/${folder}` });
      say(`· reference ${repo}: commit ${commit.slice(0, 12)} (read only, ${REFERENCE_DIR}/${folder} in the run folder)`);
    } catch {
      skip(repo, REF_FETCH_FAILED);
    }
  }
  if (usable) {
    try {
      chmodSync(base, 0o555);
    } catch {
      // the copies inside are locked already
    }
  }
  summary.references = [...(Array.isArray(summary.references) ? summary.references : []), ...records].slice(-MAX_RECORDS);
}

function removeCopy(dir: string): void {
  unlockTree(dir);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // removed with the whole folder at the end of the run
  }
}

// ---- the prompt -------------------------------------------------------------------------------------------

const isDirectory = (p: string): boolean => {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The block at the top of an agent step's prompt: the references of the newest preparation that are there (path and
 * commit) and the ones that are not. `dirs` are given to the agent as read-only folders. Undefined without records.
 */
export function referencePrompt(summary: Pick<RunSummary, "runDir" | "references">, deps: { isDir?: (p: string) => boolean; real?: (p: string) => string } = {}): { text: string; dirs: string[] } | undefined {
  const all = Array.isArray(summary.references) ? summary.references : [];
  const last = all.at(-1);
  if (!last) return undefined;
  const batch = all.filter((r) => r.at === last.at && typeof r.repo === "string" && validGithubName(r.repo));
  if (!batch.length) return undefined;
  const isDir = deps.isDir ?? isDirectory;
  const there: string[] = [];
  const missing: string[] = [];
  const dirs: string[] = [];
  for (const r of batch) {
    const folder = referenceFolderName(r.repo);
    const path = join(summary.runDir, REFERENCE_DIR, folder);
    if (!r.ok || r.folder !== `${REFERENCE_DIR}/${folder}` || !r.commit || !COMMIT.test(r.commit) || !RULE_SAFE_PATH.test(path) || !isDir(path)) {
      missing.push(r.repo);
      continue;
    }
    there.push(`- ${r.repo}: ${path} (commit ${r.commit.slice(0, 12)})`);
    dirs.push(path);
    try {
      const real = (deps.real ?? realpathSync)(path);
      if (real !== path && RULE_SAFE_PATH.test(real)) dirs.push(real);
    } catch {
      // listed by its own path
    }
  }
  const lines = ["## Reference repositories (read only)", ""];
  if (there.length) {
    lines.push("These folders hold read-only copies of other repositories of this owner, at the newest commit of their default branch:", ...there, "");
  }
  if (missing.length) lines.push(`Not available in this run: ${missing.join(", ")}.`, "");
  if (there.length) {
    lines.push(
      "Read them with Read, Glob and Grep to look up routes, file formats and names. Never change, commit or push anything in them; they are not part of your work and not part of the pull request.",
      "A fact you can find in a reference repository is not a question for the owner: look it up there, and do not ask it as an owner_action question.",
    );
  }
  return { text: lines.join("\n").trimEnd(), dirs };
}
