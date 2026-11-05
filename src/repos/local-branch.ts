import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { validBranchName } from "../auth/repo-settings.js";
import { engineHooksDir } from "../engine/guards.js";

// Writes to the owner's own folder of a local project: bringing a branch of the run's workspace into it, and the optional
// plain `git push` of that branch to the folder's remote. Synchronous, argument arrays only (no shell), time limits with SIGKILL.
// Nothing is ever forced: a branch moves by compare-and-swap after an ancestry check, or by `merge --ff-only` on the exact
// commit when it is checked out. Uncommitted, untracked and ignored work of the owner is never overwritten.

export type LocalUpdate =
  | { kind: "updated"; branch: string; sha: string; synced: boolean }
  | { kind: "moved"; detail: string }
  | { kind: "paused"; reason: string }
  | { kind: "refused"; reason: string };

export interface LocalUpdateOptions {
  workspace: string;
  ownerDir: string;
  branch: string;
  runId: string;
  protectedPatterns: readonly string[];
  git?: string;
  timeoutMs?: number;
  /** Lets a protected branch move. Only the final step of the daily release sets it, after grantedBranch() agreed. */
  allowProtected?: boolean;
}

export type RemotePush = { kind: "pushed"; remote: string } | { kind: "none" } | { kind: "failed"; remote: string; reason: string };

const ZERO = "0".repeat(40);
const OWNER_OPTIONS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];
const RUN_ID = /^[\w.-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
export const TAG_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export const PAUSED_REASON = (b: string): string =>
  `${b} is checked out in your folder and has changes that are not committed, or files that the update would replace. Commit, stash or move them, or switch to another branch; the Foundry goes on by itself.`;

/**
 * The branch the engine let this step move (FACTORY_PUSH_ALLOW = "<branch>:<hex token>"), or undefined. The token file must be in the
 * engine's own hooks folder (core.hooksPath of the step, absolute) and hold exactly that branch. Never throws.
 */
export function grantedBranch(env: NodeJS.ProcessEnv): string | undefined {
  try {
    const allow = env.FACTORY_PUSH_ALLOW ?? "";
    const at = allow.indexOf(":");
    if (at < 1) return undefined;
    const branch = allow.slice(0, at);
    const token = allow.slice(at + 1);
    if (!/^[0-9a-f]{16,64}$/.test(token) || !validBranchName(branch)) return undefined;
    const count = /^\d+$/.test(env.GIT_CONFIG_COUNT ?? "") ? Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10) : 0;
    let hooks: string | undefined;
    for (let i = 0; i < count; i++) if (env["GIT_CONFIG_KEY_" + i] === "core.hooksPath") hooks = env["GIT_CONFIG_VALUE_" + i];
    if (!hooks || !isAbsolute(hooks) || hooks !== engineHooksDir()) return undefined;
    return readFileSync(join(hooks, "allow", token), "utf8") === branch ? branch : undefined;
  } catch {
    return undefined;
  }
}

/** "*" matches any text, "?" one character; anchored. */
export function isProtectedBranch(branch: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => {
    if (!p) return false;
    const re = p.split("").map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[\\^$.|+()[\]{}]/g, "\\$&"))).join("");
    return new RegExp(`^${re}$`).test(branch);
  });
}

/** Removes the sign-in part of addresses in git's text; the last non-empty line, at most 300 characters. */
export function scrubCredentials(text: string): string {
  const clean = text.replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@]*@/g, "$1***@");
  const lines = clean.split("\n").map((l) => l.trim()).filter(Boolean);
  return (lines[lines.length - 1] ?? "").slice(0, 300);
}

interface Res { ok: boolean; out: string; err: string }

function run(git: string, cwd: string, args: string[], o: { owner?: boolean; ms: number }): Res {
  let env: NodeJS.ProcessEnv;
  if (o.owner) {
    env = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
    Object.assign(env, { LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" });
  } else env = { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" };
  const r = spawnSync(git, [...(o.owner ? OWNER_OPTIONS : []), ...args], {
    cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: o.ms, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024,
  });
  if (r.error) return { ok: false, out: "", err: (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? "git took too long" : r.error.message };
  if (r.signal) return { ok: false, out: "", err: "git took too long" };
  return { ok: r.status === 0, out: r.stdout ?? "", err: r.stderr ?? "" };
}

const firstLine = (t: string): string => (t.split("\n").map((l) => l.trim()).find(Boolean) ?? "git failed").slice(0, 200);

function real(p: string): string | undefined {
  try {
    return realpathSync(p.startsWith("file://") ? decodeURIComponent(p.slice(7)) : p);
  } catch {
    return undefined;
  }
}

/**
 * Parses `git worktree list --porcelain -z` into [path, branch ref] pairs. With -z the fields end in NUL and the records
 * are separated by an extra NUL, so a path with spaces, quotes or line breaks is read as it is.
 */
export function worktrees(text: string): { path: string; branch?: string }[] {
  const out: { path: string; branch?: string }[] = [];
  let path: string | undefined;
  let branch: string | undefined;
  for (const field of text.split("\0")) {
    if (field === "") {
      if (path !== undefined) out.push({ path, branch });
      path = undefined;
      branch = undefined;
    } else if (field.startsWith("worktree ")) path = field.slice(9);
    else if (field.startsWith("branch ")) branch = field.slice(7);
  }
  if (path !== undefined) out.push({ path, branch });
  return out;
}

/** Brings the workspace's `branch` into the owner's folder (see the header). Never throws. */
export function updateOwnerBranch(o: LocalUpdateOptions): LocalUpdate {
  const git = o.git ?? "git";
  const ms = o.timeoutMs ?? 60_000;
  const refuse = (reason: string): LocalUpdate => ({ kind: "refused", reason });
  const b = o.branch;
  if (!validBranchName(b)) return refuse("not a valid branch name");
  if (!RUN_ID.test(o.runId)) return refuse("the run id is not usable");
  if (!o.allowProtected && isProtectedBranch(b, o.protectedPatterns)) return refuse(`${b} is a protected branch`);
  const owner = real(o.ownerDir);
  if (!owner) return refuse("the folder of the local project is not reachable");
  const ws = (args: string[]) => run(git, o.workspace, args, { ms });
  const ow = (args: string[], dir = owner) => run(git, dir, args, { owner: true, ms });

  for (const args of [["remote", "get-url", "origin"], ["remote", "get-url", "--push", "origin"]]) {
    const r = ws(args);
    if (!r.ok || real(r.out.trim()) !== owner) return refuse("the origin of the workspace is not the folder of the local project");
  }
  const rewrite = ws(["config", "--get-regexp", "^url\\..*\\.(insteadof|pushinsteadof)$"]);
  if (rewrite.ok && rewrite.out.trim()) return refuse("the workspace rewrites addresses (url.*.insteadOf), so it is not sure where a push goes");

  const nw = ws(["rev-parse", "-q", "--verify", `refs/heads/${b}`]).out.trim();
  if (!SHA.test(nw)) return refuse(`the workspace has no branch ${b}`);
  const exp = ws(["rev-parse", "-q", "--verify", `refs/remotes/origin/${b}`]);
  const expected = exp.ok && SHA.test(exp.out.trim()) ? exp.out.trim() : ZERO;

  const temp = `refs/scf/incoming/${o.runId}`;
  try {
    ow(["update-ref", "-d", temp]);
    const push = ws(["push", "-q", owner, `+${nw}:${temp}`]);
    if (!push.ok) return refuse(`the push to your folder was refused: ${scrubCredentials(push.err)}`);

    const cur = ow(["rev-parse", "-q", "--verify", `refs/heads/${b}`]);
    const current = cur.ok && SHA.test(cur.out.trim()) ? cur.out.trim() : ZERO;
    // The final release: a resume finds main already at the new commit; that counts as done, so the tag can still be placed.
    if (o.allowProtected && current === nw) return { kind: "updated", branch: b, sha: nw, synced: true };
    if (current !== expected) return { kind: "moved", detail: `${b} in your folder moved since the clone` };
    if (expected !== ZERO && !ow(["merge-base", "--is-ancestor", expected, nw]).ok) return { kind: "moved", detail: `${b} in your folder is not an ancestor of the new commit` };

    // Fails closed: when the listing cannot be read, nothing is known about checked-out branches, so nothing is moved.
    const list = (): { path: string; branch?: string }[] | undefined => {
      const r = ow(["worktree", "list", "--porcelain", "-z"]);
      return r.ok ? worktrees(r.out) : undefined;
    };
    const first = list();
    if (!first) return refuse("the worktrees of your folder could not be listed");
    const checkedOut = first.find((w) => w.branch === `refs/heads/${b}`);
    if (checkedOut) {
      const wt = checkedOut.path;
      const dirty = ow(["status", "--porcelain", "--untracked-files=no", "--", ".", ":(exclude).scf/stories"], wt);
      if (!dirty.ok || dirty.out.trim()) return { kind: "paused", reason: PAUSED_REASON(b) };
      const added = ow(["diff", "--name-only", "-z", "--diff-filter=A", expected, nw]);
      if (!added.ok) return { kind: "paused", reason: PAUSED_REASON(b) };
      for (const p of added.out.split("\0").filter(Boolean)) {
        try {
          lstatSync(join(wt, p));
          return { kind: "paused", reason: PAUSED_REASON(b) };
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") return { kind: "paused", reason: PAUSED_REASON(b) };
        }
      }
      const head = ow(["symbolic-ref", "-q", "HEAD"], wt);
      if (!head.ok || head.out.trim() !== `refs/heads/${b}`) return { kind: "moved", detail: `${b} was switched away in your folder during the update` };
      const merge = ow(["merge", "--ff-only", "--no-overwrite-ignore", "-q", nw], wt);
      const after = ow(["rev-parse", "-q", "--verify", `refs/heads/${b}`]).out.trim();
      if (!merge.ok) {
        if (after !== expected) return { kind: "moved", detail: `${b} in your folder moved during the update` };
        return { kind: "paused", reason: PAUSED_REASON(b) };
      }
      if (after !== nw) return { kind: "moved", detail: `${b} in your folder moved during the update` };
      return { kind: "updated", branch: b, sha: nw, synced: true };
    }

    const set = ow(["update-ref", "-m", `scf: run ${o.runId} brings ${b} up to date`, `refs/heads/${b}`, nw, expected]);
    if (!set.ok) return { kind: "moved", detail: `${b} in your folder moved during the update` };
    const again = list();
    const taken = !again || again.some((w) => w.branch === `refs/heads/${b}`);
    if (!taken) return { kind: "updated", branch: b, sha: nw, synced: false };
    // The branch was checked out while the ref moved, so its work tree no longer matches the ref. Put the old value back,
    // compare-and-swap (a ref that moved again is left alone). A window of a few milliseconds remains: Git has no lock that
    // covers a checkout of a branch ref. The reflog keeps the old value either way.
    const undo = expected === ZERO
      ? ow(["update-ref", "-d", `refs/heads/${b}`, nw])
      : ow(["update-ref", "-m", `scf: run ${o.runId} undid the update of ${b}`, `refs/heads/${b}`, expected, nw]);
    const why = again ? `${b} was checked out in your folder during the update` : `${b} was moved, and your folder's worktrees could not be listed again`;
    return { kind: "moved", detail: undo.ok ? `${why}; the old value was put back` : `${why}; the old value could not be put back (see the reflog of ${b})` };
  } finally {
    ow(["update-ref", "-d", temp]);
  }
}

/** The remote "Also push" uses: `branch.<b>.remote` if it is listed, else "origin", else the only remote. */
export function ownerRemote(ownerDir: string, branch: string, git = "git"): string | undefined {
  const ms = 10_000;
  const list = run(git, ownerDir, ["remote"], { owner: true, ms });
  if (!list.ok) return undefined;
  const names = list.out.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!names.length) return undefined;
  const cfg = run(git, ownerDir, ["config", "--get", `branch.${branch}.remote`], { owner: true, ms });
  const conf = cfg.ok ? cfg.out.trim() : "";
  if (conf && names.includes(conf)) return conf;
  if (names.includes("origin")) return "origin";
  return names.length === 1 ? names[0] : undefined;
}

/**
 * Where "Also push" would send `branch`: the remote (chosen like ownerRemote), every push address git pushes to (`git push`
 * uses all of them, not only the first), and those addresses with any sign-in part replaced by `***` (the only form that may be
 * shown). Undefined when there is no remote or no address.
 */
export function ownerPushTarget(ownerDir: string, branch: string, git = "git"): { remote: string; urls: string[]; shown: string[] } | undefined {
  const remote = ownerRemote(ownerDir, branch, git);
  if (!remote) return undefined;
  const r = run(git, ownerDir, ["remote", "get-url", "--push", "--all", remote], { owner: true, ms: 10_000 });
  const urls = r.ok ? r.out.split("\n").map((l) => l.trim()).filter(Boolean) : [];
  if (!urls.length) return undefined;
  const shown = urls.map((url) => url.replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@]*@/g, "$1***@"));
  return { remote, urls, shown };
}

/** A plain `git push` of `branch` from the owner's folder. Inherits the step's environment (the Foundry's pre-push hook). */
export function pushOwnerBranch(o: { ownerDir: string; branch: string; tags?: string[]; git?: string; timeoutMs?: number }): RemotePush {
  const git = o.git ?? "git";
  if (!validBranchName(o.branch)) return { kind: "failed", remote: "", reason: "not a valid branch name" };
  const tags = o.tags ?? [];
  if (tags.some((t) => !TAG_NAME.test(t))) return { kind: "failed", remote: "", reason: "not a valid tag name" };
  const remote = ownerRemote(o.ownerDir, o.branch, git);
  if (!remote) return { kind: "none" };
  const specs = [`refs/heads/${o.branch}:refs/heads/${o.branch}`, ...tags.map((t) => `refs/tags/${t}:refs/tags/${t}`)];
  const r = run(git, o.ownerDir, ["push", "-q", remote, ...specs], { ms: o.timeoutMs ?? 120_000 });
  if (r.ok) return { kind: "pushed", remote };
  return { kind: "failed", remote, reason: scrubCredentials(r.err) || "git push failed" };
}

/**
 * Brings a tag of the workspace into the owner's folder with a plain, non-force push (create only). The same tag on the same
 * object counts as done; a tag of that name on another object is refused. Never throws.
 */
export function pushTagToOwner(o: { workspace: string; ownerDir: string; tag: string; git?: string; timeoutMs?: number }): { kind: "tagged" } | { kind: "refused"; reason: string } {
  const git = o.git ?? "git";
  const ms = o.timeoutMs ?? 60_000;
  const refuse = (reason: string) => ({ kind: "refused" as const, reason });
  if (!TAG_NAME.test(o.tag)) return refuse("not a valid tag name");
  const owner = real(o.ownerDir);
  if (!owner) return refuse("the folder of the local project is not reachable");
  const ws = (args: string[]) => run(git, o.workspace, args, { ms });
  for (const args of [["remote", "get-url", "origin"], ["remote", "get-url", "--push", "origin"]]) {
    const r = ws(args);
    if (!r.ok || real(r.out.trim()) !== owner) return refuse("the origin of the workspace is not the folder of the local project");
  }
  const ref = `refs/tags/${o.tag}`;
  const mine = ws(["rev-parse", "-q", "--verify", ref]).out.trim();
  if (!SHA.test(mine)) return refuse(`the workspace has no tag ${o.tag}`);
  const there = run(git, owner, ["rev-parse", "-q", "--verify", ref], { owner: true, ms });
  if (there.ok && there.out.trim() === mine) return { kind: "tagged" };
  if (there.ok) return refuse(`the tag ${o.tag} already exists in your folder on another object`);
  const push = ws(["push", "-q", owner, `${ref}:${ref}`]);
  if (!push.ok) return refuse(`the tag could not be placed: ${scrubCredentials(push.err)}`);
  return { kind: "tagged" };
}
