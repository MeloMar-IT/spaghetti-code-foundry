import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { PUBLISH_TOKEN, fingerprint } from "./publish-grants.js";
import { localRepoName } from "../auth/local-name.js";
import { githubNameOf, validGithubName } from "../auth/repo-url.js";
import type { RepoSettings } from "../auth/repo-settings.js";
import { type PublicRepo, type RepoRecord, addRepo, findOwnedRepo, getRepo, listAllRepos, readRepoSecret, removeRepo, repoAccess, setRepoSettings } from "../auth/repos.js";
import { getUser } from "../auth/users.js";
import type { Config } from "../config.js";
import { appTokenAccess } from "../engine/repo-access.js";
import { gh, ghLogin, withGhEnv } from "../github.js";
import { repoGhIdentity } from "../queue/gh-identity.js";
import { GO_LABEL, type Entry, scan } from "../stories/local-map.js";
import { type MoveResult, MoveError, moveRefusal, moveToGithub, planFrom, takeMoveLock } from "../stories/move-to-github.js";
import { STORIES_BRANCH } from "../stories/story-commit.js";
import { gitAuth } from "./connect.js";
import { scrubCredentials } from "./local-branch.js";
import { listRepoWatchers, moveRepoWatchers, watcherRepoProblem } from "./watchers.js";

// Moves a local project to GitHub: creates (or finds) the private repository with one of the owner's GitHub token sign-ins, pushes
// every branch and tag without forcing, moves the stories (the code of the story move), then moves the watchers and the settings to
// the GitHub record and removes the local record. Every step checks what is done already, so a move that stopped can run again.
// No secret is ever in a result or an error: the token reaches git through gitAuth's environment and gh through its session.

export const CONNECT_GITHUB_FIRST = "connect GitHub first: add a GitHub repository with a token under My repositories, then move again";

export type ProjectMoveCode = "bad-input" | "not-found" | "no-sign-in" | "push-failed" | "rewrites" | "github" | "stories-skipped" | "changed";
export class ProjectMoveError extends Error {
  constructor(readonly code: ProjectMoveCode, message: string) {
    super(message);
    this.name = "ProjectMoveError";
  }
}

export type MoveTarget = { create: { name: string; private: boolean } } | { repoId: string };
export interface MoveRequest {
  target: MoveTarget;
  includeClosed: boolean;
  dryRun: boolean;
  /** The token of the check; a real move needs it (the route takes it). */
  confirm?: string;
}

const bad = (message: string) => new ProjectMoveError("bad-input", message);
const BARE_NAME = /^[A-Za-z0-9._-]{1,100}$/;

const flag = (o: Record<string, unknown>, key: string): boolean => {
  if (o[key] === undefined) return false;
  if (typeof o[key] !== "boolean") throw bad(`${key} must be true or false`);
  return o[key];
};
const onlyKeys = (o: Record<string, unknown>, keys: string[], where: string): void => {
  const extra = Object.keys(o).find((k) => !keys.includes(k));
  if (extra !== undefined) throw bad(`unknown option${where}: ${extra.slice(0, 40)}`);
};
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Checks the body of the call; every problem is a `bad-input` with a sentence. */
export function parseMoveBody(body: unknown): MoveRequest {
  if (!isObject(body)) throw bad("the body must be an object");
  onlyKeys(body, ["target", "includeClosed", "dryRun", "confirm"], "");
  const t = body.target;
  if (!isObject(t)) throw bad("target is needed: { create: { name } } or { repoId }");
  onlyKeys(t, ["create", "repoId"], " in target");
  const hasCreate = t.create !== undefined;
  const hasPick = t.repoId !== undefined;
  if (hasCreate === hasPick) throw bad("target needs exactly one of create and repoId");
  let target: MoveTarget;
  if (hasPick) {
    if (typeof t.repoId !== "string" || !t.repoId || t.repoId.length > 100) throw bad("repoId must be the id of one of your repositories");
    target = { repoId: t.repoId };
  } else {
    const c = t.create;
    if (!isObject(c)) throw bad("create must be an object with a name");
    onlyKeys(c, ["name", "private"], " in create");
    const name = c.name;
    if (typeof name !== "string") throw bad("create.name must be a text");
    const parts = name.split("/");
    const fine = parts.length === 1
      ? BARE_NAME.test(name) && name !== "." && name !== ".."
      : parts.length === 2 && validGithubName(name) && BARE_NAME.test(parts[0]!) && BARE_NAME.test(parts[1]!) && parts[1] !== "." && parts[1] !== "..";
    if (!fine || /\.git$/i.test(name)) throw bad('create.name must be "name" or "owner/name" (letters, digits, "-", "_" and ".")');
    target = { create: { name, private: c.private === undefined ? true : flag(c, "private") } };
  }
  const dryRun = flag(body, "dryRun");
  let confirm: string | undefined;
  if (body.confirm !== undefined) {
    if (dryRun) throw bad("confirm is only for a real move, not for a dry run");
    if (typeof body.confirm !== "string" || !PUBLISH_TOKEN.test(body.confirm)) throw bad("confirm must be the token of the check");
    confirm = body.confirm;
  }
  return { target, includeClosed: flag(body, "includeClosed"), dryRun, ...(confirm !== undefined ? { confirm } : {}) };
}

/** The owner's `github-token` record to sign in with: one whose GitHub owner is `owner` comes first, else the first one added. */
export function pickSignIn(ownerId: string, owner?: string): RepoRecord | undefined {
  const mine = listAllRepos().filter((r) => r.owner === ownerId && r.method === "github-token" && githubNameOf(r.url) !== undefined);
  const match = owner === undefined ? undefined : mine.find((r) => githubNameOf(r.url)!.split("/")[0] === owner.toLowerCase());
  return match ?? mine[0];
}

// ---- git ---------------------------------------------------------------------------------------------------------------

const GIT_OPTIONS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];
const SHORT_MS = 30_000;
const PUSH_MS = 10 * 60_000;
const GH_MS = 60_000;
const CHUNK = 200;

interface Ran { code: number | null; stdout: string; stderr: string }

function runGit(git: string, cwd: string, args: string[], env: NodeJS.ProcessEnv, timeout: number): Promise<Ran> {
  return new Promise((resolve) => {
    execFile(git, args, { cwd, env, timeout, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
      const e = err as NodeJS.ErrnoException & { killed?: boolean; stdout?: unknown; stderr?: unknown };
      const timedOut = e.killed === true;
      resolve({ code: typeof e.code === "number" ? e.code : null, stdout: String(stdout ?? ""), stderr: timedOut ? "git took too long" : String(stderr || e.message) });
    });
  });
}

/** A plain environment for the calls that carry no credential. */
function plainEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
  return Object.assign(env, { LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" });
}

/** The refs to push: every branch and tag of the folder, as full names (`scf/stories` is a branch). Empty for a folder without commits. */
export async function listLocalRefs(dir: string, git = "git"): Promise<string[]> {
  const r = await runGit(git, dir, [...GIT_OPTIONS, "for-each-ref", "--format=%(refname)", "refs/heads", "refs/tags"], plainEnv(), SHORT_MS);
  if (r.code !== 0) throw new ProjectMoveError("push-failed", `the branches of your folder could not be listed: ${scrubCredentials(r.stderr) || "git failed"}`);
  return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** The branches and tags of the folder with the object each points to. Sorted by name. */
export async function listLocalRefIds(dir: string, git = "git"): Promise<{ ref: string; id: string }[]> {
  const r = await runGit(git, dir, [...GIT_OPTIONS, "for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/tags"], plainEnv(), SHORT_MS);
  if (r.code !== 0) throw new ProjectMoveError("push-failed", `the branches of your folder could not be listed: ${scrubCredentials(r.stderr) || "git failed"}`);
  return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean).flatMap((l) => {
    const at = l.indexOf(" ");
    return at > 0 ? [{ ref: l.slice(at + 1), id: l.slice(0, at) }] : [];
  }).sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
}

/**
 * What a move publishes and where, as a fingerprint: the GitHub name, every ref with its object id, and the number and a hash of
 * the content of each story that would be created. A check and the move that follows must give the same value.
 */
export function moveWhat(github: string, refs: readonly { ref: string; id: string }[], plan: readonly { number: number; status: string }[], entries: readonly Entry[]): string {
  const stories = plan.filter((p) => p.status === "create").map((p) => {
    const e = entries.find((x) => x.n === p.number);
    return { n: p.number, h: fingerprint(e && e.ok ? e.story : null) };
  });
  return fingerprint({ github: github.toLowerCase(), refs: refs.map((r) => `${r.ref}@${r.id}`), stories });
}

export const PUBLISH_CHANGED = "Nothing was published: the branches, tags or stories changed since the check; run the check again and look at it";

/** The lines of `git push --porcelain`: flag, destination ref and the rest of the line. */
export function parsePorcelain(stdout: string): { flag: string; ref: string; summary: string }[] {
  const out: { flag: string; ref: string; summary: string }[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^([ +\-*=!])\t([^\t]*)\t(.*)$/.exec(line);
    if (!m) continue;
    const to = m[2]!.includes(":") ? m[2]!.slice(m[2]!.indexOf(":") + 1) : m[2]!;
    out.push({ flag: m[1]!, ref: to, summary: m[3]!.trim() });
  }
  return out;
}

/** The folder's own config must not rewrite addresses: a rewrite could send the token and the history to another place. */
async function refuseRewrites(dir: string, git: string): Promise<void> {
  const r = await runGit(git, dir, [...GIT_OPTIONS, "config", "--local", "--includes", "--get-regexp", "^url\\..*\\.(insteadof|pushinsteadof)$"], plainEnv(), SHORT_MS);
  if (r.code === 0 && r.stdout.trim()) {
    throw new ProjectMoveError("rewrites", "your folder rewrites addresses (url.*.insteadOf), so it is not sure where a push goes; remove those lines from the folder's git config, then move again");
  }
}

// ---- the move ----------------------------------------------------------------------------------------------------------

export interface RefPush { ref: string; status: "push" | "pushed" | "up-to-date" }
export interface ProjectMoveOptions extends MoveRequest {
  localId: string;
  owner: string;
  config: () => Config;
  /** Runs under the lock of the record store, before the new record is saved (the starting autonomy level). */
  beforeSave?: (id: string) => void;
  /** Called as soon as the GitHub record is added, so the audit line exists even when a later step fails. */
  onAdded?: (repo: PublicRepo) => void;
  /** The `what` of the check that was confirmed. Checked before anything is created or pushed; a difference is a `changed` error. */
  expectWhat?: string;
  git?: string;
}
export interface ProjectMoveResult {
  dryRun: boolean;
  github: string;
  repoId?: string;
  repository: "create" | "created" | "exists" | "picked";
  refs: RefPush[];
  stories: MoveResult;
  /** Internal: the fingerprint of what the move publishes (see moveWhat). The route keeps it and never sends it. */
  what?: string;
  switched?: { watchers: string[]; settings: "merged" | "kept" | "none"; kept: string[]; removed: string };
}

/** A record the move can use as its target: a GitHub repository of the owner that can have a watcher and call the GitHub API. */
function usable(rec: RepoRecord | undefined, owner: string): boolean {
  if (!rec || rec.owner !== owner || rec.method === "local" || rec.method === "none" || githubNameOf(rec.url) === undefined) return false;
  return watcherRepoProblem(rec, getUser(owner) ?? undefined) === undefined;
}
const NOT_USABLE = "repoId must be one of your GitHub repositories that signs in with a GitHub token or the GitHub App";

const NOT_FOUND_RE = /could not resolve to a repository|\b404\b|not found/i;
const EXISTS_RE = /already exists/i;
const failText = (e: unknown): string => {
  const o = e as { stderr?: unknown; message?: unknown } | undefined;
  return scrubCredentials(`${typeof o?.stderr === "string" ? o.stderr : ""}\n${typeof o?.message === "string" ? o.message : ""}`) || "failed";
};

async function repoExists(github: string): Promise<boolean> {
  try {
    await gh(["repo", "view", github, "--json", "name"], undefined, GH_MS);
    return true;
  } catch (e) {
    const o = e as { stderr?: unknown } | undefined;
    if (NOT_FOUND_RE.test(typeof o?.stderr === "string" ? o.stderr : "")) return false;
    throw new ProjectMoveError("github", `GitHub could not be asked about ${github}: ${failText(e)}`);
  }
}

/** The build label: the first issues watcher of the target, else of the local record, else `go`. */
function buildLabelOf(targetId: string | undefined, localId: string): string {
  const first = (id: string) => listRepoWatchers().filter((w) => w.repoId === id && w.source === "issues").sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0]?.label;
  return (targetId ? first(targetId) : undefined) ?? first(localId) ?? GO_LABEL;
}

/** The token git signs in with for the record: its own token, or a new installation token of the GitHub App. */
async function pushSecret(owner: string, rec: RepoRecord, github: string, config: () => Config): Promise<string> {
  const a = repoAccess(owner, github);
  if (a.kind === "token") return a.token;
  if (a.kind === "app") {
    const t = await appTokenAccess(a, config());
    if (!t.ok) throw new ProjectMoveError("no-sign-in", t.reason);
    return t.token;
  }
  throw new ProjectMoveError("no-sign-in", a.kind === "refused" ? a.reason : CONNECT_GITHUB_FIRST);
}

/** Pushes the refs to the record's address, each as its own `ref:ref` (never forced). A refused ref stops the move. */
async function pushRefs(o: ProjectMoveOptions, dir: string, rec: RepoRecord, github: string, refs: { ref: string; id: string }[]): Promise<RefPush[]> {
  if (!refs.length) return [];
  const secret = await pushSecret(o.owner, rec, github, o.config);
  const temp = mkdtempSync(join(tmpdir(), "scf-move-"));
  const git = o.git ?? "git";
  const redact = (t: string) => t.split(secret).join("***");
  try {
    const auth = gitAuth(temp, { method: "github-token", secret });
    const done = new Map<string, RefPush["status"]>();
    for (let i = 0; i < refs.length; i += CHUNK) {
      const part = refs.slice(i, i + CHUNK);
      const r = await runGit(git, dir, [...auth.args, ...GIT_OPTIONS, "push", "--porcelain", "--no-verify", rec.url, ...part.map((x) => `${x.id}:${x.ref}`)], auth.env, PUSH_MS);
      const lines = parsePorcelain(r.stdout);
      const refused = lines.find((l) => l.flag === "!");
      if (refused) {
        throw new ProjectMoveError("push-failed", `the push was refused for ${refused.ref}: ${redact(refused.summary).slice(0, 200)}; nothing was forced. Bring the GitHub repository and your folder together, then move again`);
      }
      if (r.code !== 0) throw new ProjectMoveError("push-failed", `the push to ${github} failed: ${redact(scrubCredentials(r.stderr)) || "git failed"}`);
      for (const l of lines) done.set(l.ref, l.flag === "=" ? "up-to-date" : "pushed");
    }
    return refs.map(({ ref }) => ({ ref, status: done.get(ref) ?? "pushed" }));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/** The local settings (without `pushRemote`) added to the target's: the target's value wins where both have a key. */
function mergeSettings(local: RepoSettings | undefined, target: RepoSettings | undefined): { merged: RepoSettings; status: "merged" | "kept" | "none"; kept: string[] } {
  const { pushRemote: _p, ...mine } = (local ?? {}) as RepoSettings;
  const theirs = (target ?? {}) as Record<string, unknown>;
  const keys = Object.keys(mine);
  if (!keys.length) return { merged: { ...theirs } as RepoSettings, status: "none", kept: [] };
  const kept = keys.filter((k) => k in theirs && !isDeepStrictEqual(theirs[k], (mine as Record<string, unknown>)[k]));
  const merged = { ...mine, ...theirs } as RepoSettings;
  return { merged, status: isDeepStrictEqual(merged, theirs) ? "kept" : "merged", kept };
}

/** Moves the project; see the header. A dry run changes nothing (it only asks GitHub whether the repository exists). */
export async function moveProjectToGithub(o: ProjectMoveOptions): Promise<ProjectMoveResult> {
  const first = getRepo(o.localId);
  if (!first || first.owner !== o.owner || first.method !== "local") throw new ProjectMoveError("not-found", "no such local project");
  const dir = first.url;
  const git = o.git ?? "git";
  const release = takeMoveLock(dir, "project");
  let identity: ReturnType<typeof repoGhIdentity> | undefined;
  try {
    const local = getRepo(o.localId);
    if (!local || local.owner !== o.owner || local.method !== "local") throw new ProjectMoveError("not-found", "no such local project");
    const localName = localRepoName({ id: local.id, url: local.url });
    await refuseRewrites(dir, git);
    const refIds = await listLocalRefIds(dir, git);
    const refs = refIds.map((x) => x.ref);

    // -- the target: a record of the owner, or a repository to create --
    let rec: RepoRecord | undefined;
    let github: string;
    let how: "created" | "exists" | "picked" = "exists";
    let session: Awaited<ReturnType<ReturnType<typeof repoGhIdentity>["prepare"]>> | undefined;
    let src: RepoRecord | undefined;
    if ("repoId" in o.target) {
      rec = getRepo(o.target.repoId);
      if (!rec || !usable(rec, o.owner)) throw bad(NOT_USABLE);
      github = githubNameOf(rec.url)!;
      how = "picked";
    } else {
      const { name } = o.target.create;
      const ownerPart = name.includes("/") ? name.split("/")[0]! : undefined;
      github = name;
      rec = ownerPart ? findOwnedRepo(o.owner, name) : undefined;
      if (!rec) {
        src = pickSignIn(o.owner, ownerPart);
        if (!src) throw new ProjectMoveError("no-sign-in", CONNECT_GITHUB_FIRST);
        identity = repoGhIdentity(src.id, { config: o.config });
        try {
          session = await identity.prepare();
        } catch (e) {
          throw new ProjectMoveError("no-sign-in", `${CONNECT_GITHUB_FIRST} (${(e as Error).message})`);
        }
        if (!ownerPart) {
          const login = await withGhEnv(session, () => ghLogin(GH_MS)).catch((e: unknown) => {
            throw new ProjectMoveError("github", `GitHub could not be asked for your user name: ${failText(e)}`);
          });
          github = `${login}/${name}`;
        }
        rec = findOwnedRepo(o.owner, github);
      }
      if (rec && !usable(rec, o.owner)) throw bad(`you have ${githubNameOf(rec.url)} already, but it cannot be used here: ${NOT_USABLE}`);
      if (rec) github = githubNameOf(rec.url)!;
    }
    // before anything is created: a project that was moved to another repository stays there
    const refusal = moveRefusal(scan(dir), github);
    if (refusal) throw new MoveError(refusal);

    // what the check approved must still be what goes: names, object ids and the stories to create
    const entries = scan(dir);
    const what = moveWhat(github, refIds, planFrom(entries, o.includeClosed), entries);
    if (o.expectWhat !== undefined && o.expectWhat !== what) throw new ProjectMoveError("changed", PUBLISH_CHANGED);

    if (!rec) {
      const visibility = "create" in o.target && !o.target.create.private ? "--public" : "--private";
      const exists = await withGhEnv(session, () => repoExists(github));
      if (o.dryRun) {
        return {
          dryRun: true, github, repository: exists ? "exists" : "create", refs: refs.map((ref) => ({ ref, status: "push" })),
          stories: { target: github, dryRun: true, plan: planFrom(entries, o.includeClosed), created: [], done: [] }, what,
        };
      }
      how = "exists";
      if (!exists) {
        try {
          await withGhEnv(session, () => gh(["repo", "create", github, visibility], undefined, GH_MS));
          how = "created";
        } catch (e) {
          if (!EXISTS_RE.test(failText(e))) throw new ProjectMoveError("github", `GitHub did not create ${github}: ${failText(e)}`);
        }
      }
      const added = addRepo(o.owner, { url: `https://github.com/${github}`, method: "github-token", token: readRepoSecret(src!) }, { beforeSave: o.beforeSave });
      o.onAdded?.(added);
      rec = getRepo(added.id);
      if (!rec) throw new ProjectMoveError("not-found", "the new repository record is gone");
    }

    const label = buildLabelOf(rec.id, local.id);
    const base = { local: localName, target: github, owner: o.owner, config: o.config, includeClosed: o.includeClosed, buildLabel: label };
    if (o.dryRun) {
      const stories = await moveToGithub({ ...base, dryRun: true });
      return { dryRun: true, github, repoId: rec.id, repository: how === "picked" ? "picked" : "exists", refs: refs.map((ref) => ({ ref, status: "push" })), stories, what };
    }

    // -- push, stories, push the story commits --
    const pushed = await pushRefs(o, dir, rec, github, refIds);
    const stories = await moveToGithub(base);
    // A story that was skipped (unreadable, or its comments too large for one GitHub comment) never reaches GitHub: the switch
    // would take its watchers and the local record away from it. Stop here; the local record and the watchers stay.
    const left = stories.plan.filter((p) => (p.status === "unreadable" || p.status === "too-large") && !stories.done.includes(p.number));
    if (left.length) {
      throw new ProjectMoveError("stories-skipped", `the stories ${left.map((p) => `#${p.number}`).join(", ")} were not moved (${left.map((p) => p.status === "unreadable" ? "the file cannot be read" : "its comments are too large for one GitHub comment").join("; ")}). Fix or remove them, then move again; nothing was switched`);
    }
    const storiesRef = `refs/heads/${STORIES_BRANCH}`;
    // the story commits are made by the move itself (not part of the check), so this one is pushed by its new id
    const storiesId = (await listLocalRefIds(dir, git)).find((x) => x.ref === storiesRef);
    if (storiesId) {
      const again = await pushRefs(o, dir, rec, github, [storiesId]);
      const mine = pushed.find((p) => p.ref === storiesRef);
      if (mine && again[0]?.status === "pushed") mine.status = "pushed";
      else if (!mine) pushed.push(...again);
    }

    // -- the switch: watchers, settings, the local record --
    const nowLocal = getRepo(local.id);
    const moved = moveRepoWatchers(local.id, rec.id, label);
    const nowTarget = getRepo(rec.id);
    const m = mergeSettings(nowLocal?.settings, nowTarget?.settings);
    if (m.status === "merged") setRepoSettings(rec.id, m.merged);
    removeRepo(o.owner, local.id);
    return {
      dryRun: false, github, repoId: rec.id, repository: how, refs: pushed, stories,
      switched: { watchers: moved.map((w) => w.id), settings: m.status, kept: m.kept, removed: local.id },
    };
  } finally {
    identity?.dispose();
    release();
  }
}
