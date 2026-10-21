import { mkdirSync, readdirSync } from "node:fs";
import { repoAccess } from "../auth/repos.js";
import { isPlainHttpsUrl, PullRequestIdentitySchema, RepositorySchema, type PullRequestIdentity, type StepIdentity } from "../evidence/identity.js";
import { validGithubName } from "../auth/repo-url.js";
import { makeRedactor } from "../credentials/redact.js";
import { combineDecisions } from "../policy/compose.js";
import type { Credential, ToolGrant } from "../tool-profile/schema.js";
import { TOOL_PROFILE_VERSION } from "../tool-profile/version.js";
import { checkToolCall, toolNameOf } from "../tool-profile/resolve.js";
import { GithubAppError, installationTokenInfo, type AppPermissions } from "../github-app.js";
import { runProcess } from "../steps/process.js";
import { APP_FAILED_RUN, APP_REFUSED_RUN, APP_TOKEN_EXPIRED, NO_COMMIT_IDENTITY, TOKEN_REFUSED_RUN, tokenRefused } from "./guards.js";
import { refuseByPolicy, stepEnv, type Engine, type Scope } from "./execute.js";
import { stepIsolated, stepIsolation, noMachineSignIn } from "./isolation.js";
import { repositoryFact } from "./policy-hooks.js";
import { appTokenAccess, ghConfigDir, removeGhConfigDir, repoNoCredentialEnv, repoTokenEnv } from "./repo-access.js";
import { LOCAL_OPERATIONS, REPO_OPERATIONS, RepoRequestSchema, repoToolOf, tailBytes, unsafeGitSettings, type RepoEvidenceOperation, type RepoOperation, type RepoRefusal, type RepoRequest } from "./repo-request.js";
import { shortEnv, shortEnvRun } from "./short-env.js";

export { REPO_OPERATIONS, RepoRequestSchema, type RepoRefusal, type RepoRequest };

/**
 * The repository broker: carries out one repository operation on the server. The target is always the run's own repository,
 * the credential is the narrowest one the grant allows, and every outcome is recorded as one `repo.operation` event.
 * No process goes through a shell. Nothing calls it yet.
 */

export type RepoGrant = Extract<ToolGrant, { kind: "git" | "github" }>;
export { type AppPermissions };

/** The permissions of an App token per operation. */
export const APP_PERMISSIONS: Record<"clone" | "fetch" | "push" | "pull-request", AppPermissions> = {
  clone: { contents: "read" },
  fetch: { contents: "read" },
  push: { contents: "write" },
  "pull-request": { pull_requests: "write" },
};

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  aborted?: boolean;
}
export type BrokerExec = (
  cmd: "git" | "gh",
  args: string[],
  o: { cwd: string; env: Record<string, string | undefined>; stdin?: string; cleanEnv: boolean; pinnedSecrets?: string[]; timeoutMs: number; signal?: AbortSignal; ownGroup: true },
) => Promise<ExecResult>;

export interface BrokerContext {
  engine: Engine;
  scope: Scope;
  step: StepIdentity;
  logFile: string;
  exec?: BrokerExec;
}
export interface BrokerResult {
  outcome: "done" | "failed" | "refused";
  refusal?: RepoRefusal;
  output: string;
  pullRequest?: PullRequestIdentity;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_CAP_BYTES = 20_000;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

const REFUSAL_TEXT: Record<RepoRefusal, string> = {
  "invalid-request": "the request is not valid",
  "no-target": "the run has no single repository to work on",
  "not-in-profile": "the tool profile does not allow this operation on this repository",
  "approval-required": "the tool profile requires an approval for this operation",
  "deploy-key": "a deploy key cannot be used for this operation",
  "no-credential": "no sign-in of this repository may be used for this operation",
  "unsafe-git-settings": "the workspace has git settings that are not allowed",
  policy: "a policy refused this operation",
  "not-empty": "the workspace is not empty",
};

type Cred =
  | { level: "none" }
  | { level: Credential; source: "token"; token: string; username: string; url: string }
  | { level: Credential; source: "app"; access: Parameters<typeof appTokenAccess>[0] }
  | { level: "machine"; source: "bot-app" }
  | { level: "machine"; source: "bot-env"; token: string };

interface Target {
  owner: string;
  name: string;
  /** Lower case, as the profile and the policy see it. */
  fact: string;
}

/** The run's repository: one concrete "owner/name". A placeholder, a pattern or a missing value is no target. */
function resolveTarget(vars: Record<string, string>): Target | undefined {
  const fact = repositoryFact(vars);
  const raw = vars.github_repo?.trim();
  if (!fact || !raw || raw.includes("*") || !validGithubName(raw)) return undefined;
  const [owner, name, ...rest] = raw.split("/");
  return owner && name && rest.length === 0 && RepositorySchema.safeParse(fact).success ? { owner, name, fact } : undefined;
}

/** What the operation records: filled in as the checks go on. */
interface State {
  credential: Credential;
  repository?: string;
  policy?: "allow" | "warn" | "require_approval" | "deny";
  token?: string;
}

const branchOf = (r: RepoRequest): string | undefined => (r.op === "push" ? r.branch : r.op === "branch" ? r.name : r.op === "fetch" ? r.branch : r.op === "pull-request" ? r.head : undefined);

const defaultExec = (logFile: string): BrokerExec => (cmd, args, o) =>
  runProcess(cmd, args, { cwd: o.cwd, env: o.env, stdin: o.stdin, timeoutMs: o.timeoutMs, signal: o.signal, logFile, cleanEnv: o.cleanEnv, pinnedSecrets: o.pinnedSecrets, ownGroup: true });

/** Carries out one request of a run and records it. Never throws. `grant` is the git or github grant of the tool profile. */
export async function brokerRequest(ctx: BrokerContext, request: unknown, grant: RepoGrant | undefined): Promise<BrokerResult> {
  const { engine } = ctx;
  const parsed = RepoRequestSchema.safeParse(request);
  const st: State = { credential: "none" };
  let result: BrokerResult;
  let op: RepoEvidenceOperation | undefined;
  let branch: string | undefined;
  let ghDir: string | undefined;
  if (!parsed.success) {
    const given = (request as { op?: unknown } | null)?.op;
    // an operation that is not a known one is recorded as "unknown": nothing of the request itself is kept
    op = (REPO_OPERATIONS as readonly unknown[]).includes(given) ? (given as RepoOperation) : "unknown";
    result = { outcome: "refused", refusal: "invalid-request", output: REFUSAL_TEXT["invalid-request"] };
    if (op === "unknown") engine.log("    ! repository broker: a request with no known operation was refused");
  } else {
    op = parsed.data.op;
    branch = branchOf(parsed.data);
    try {
      result = await attempt(ctx, parsed.data, grant, st, () => (ghDir ??= ghConfigDir()));
    } catch (e) {
      const text = `the operation could not run: ${e instanceof Error ? e.message : "error"}`;
      result = { outcome: "failed", output: tailBytes(clean(text, st.token), grant?.outputCapBytes ?? DEFAULT_CAP_BYTES) };
    } finally {
      if (ghDir) {
        try {
          removeGhConfigDir(ghDir);
        } catch {
          // the folder is empty or in the temporary folder; nothing more to do
        }
      }
    }
  }
  if (op) {
    try {
      engine.evidence?.repoOperation({
        step: ctx.step,
        operation: op,
        ...(st.repository ? { repository: st.repository } : {}),
        ...(branch ? { branch } : {}),
        credential: st.credential,
        ...(st.policy ? { policy: st.policy } : {}),
        outcome: result.outcome,
        ...(result.outcome === "refused" ? { refusal: result.refusal } : {}),
        ...(result.pullRequest ? { pullRequest: result.pullRequest } : {}),
      });
    } catch {
      // the recorder never throws; a problem here must not change the result
    }
  }
  return result;
}

const clean = (text: string, token: string | undefined): string => {
  const plain = text.replace(ANSI, "");
  return token ? makeRedactor([token]).redact(plain) : plain;
};

async function attempt(ctx: BrokerContext, req: RepoRequest, grant: RepoGrant | undefined, st: State, gh: () => string): Promise<BrokerResult> {
  const { engine, scope, step } = ctx;
  const cap = grant?.outputCapBytes ?? DEFAULT_CAP_BYTES;
  const timeoutMs = grant?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const exec = ctx.exec ?? defaultExec(ctx.logFile);
  const vars = scope.ctx.vars;
  const owner = engine.summary.owner;
  const refuse = (refusal: RepoRefusal, text = REFUSAL_TEXT[refusal]): BrokerResult => ({ outcome: "refused", refusal, output: tailBytes(text, cap) });
  /** `prefix` is kept whole and first; the text after it is cut from the front. */
  const reply = (outcome: "done" | "failed", text: string, prefix = "", pullRequest?: PullRequestIdentity): BrokerResult => {
    const head = prefix ? `${prefix}\n` : "";
    const room = cap - Buffer.byteLength(head);
    const output = room <= 0 ? tailBytes(head, cap) : head + tailBytes(clean(text, st.token), room);
    return { outcome, output, ...(pullRequest ? { pullRequest } : {}) };
  };

  // 2. the target
  const target = resolveTarget(vars);
  if (!target) return refuse("no-target");
  st.repository = target.fact;

  // 3. the profile
  const tool = repoToolOf(req.op);
  const call = { kind: tool.kind, operation: tool.operation, target: target.fact };
  const name = toolNameOf(tool.kind, tool.operation);
  let decision: ReturnType<typeof checkToolCall>;
  try {
    decision = grant ? checkToolCall({ version: TOOL_PROFILE_VERSION, profile: { id: "repo-broker", version: "1" }, grants: [grant] }, call) : { outcome: "deny", reasonCode: "tool.not-allowed", refusal: "kind-not-granted" };
  } catch {
    decision = { outcome: "deny", reasonCode: "tool.not-allowed", refusal: "kind-not-granted" };
  }
  if (decision.outcome !== "allow" || !grant) {
    engine.evidence?.stepDenied(step, { kind: "tool", tool: { name } });
    return refuse(decision.outcome === "require_approval" ? "approval-required" : "not-in-profile");
  }

  // 4. the credential
  const local = LOCAL_OPERATIONS.includes(req.op);
  const picked = pickCredential(engine, target, local ? "none" : grant.credential);
  if ("refusal" in picked) return refuse(picked.refusal);
  const cred = picked;
  st.credential = cred.level;

  // 5. the workspace
  const cwd = engine.summary.workdir;
  if (!cwd) return reply("failed", "the run has no workspace");
  const short = shortEnvRun(owner);
  const plain = (o: Record<string, string | undefined>) => (short ? shortEnv(o, engine.config) : o);
  const run = (cmd: "git" | "gh", args: string[], env: Record<string, string | undefined>, stdin?: string) =>
    exec(cmd, args, { cwd, env, ...(stdin !== undefined ? { stdin } : {}), cleanEnv: short, ...(st.token ? { pinnedSecrets: [st.token] } : {}), timeoutMs, signal: engine.signal, ownGroup: true });
  if (req.op === "clone") {
    mkdirSync(cwd, { recursive: true });
    if (readdirSync(cwd).length > 0) return refuse("not-empty");
  } else {
    const listing = await run("git", ["config", "--list", "--null", "--no-includes"], plain({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0", GIT_CONFIG_PARAMETERS: "", GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined, GIT_INDEX_FILE: undefined, LC_ALL: "C" }));
    if (listing.exitCode !== 0 || listing.timedOut || listing.aborted || unsafeGitSettings(listing.stdout).length > 0) return refuse("unsafe-git-settings");
  }

  // 6. the commit identity
  const isolated = cred.level === "repository" || stepIsolated(owner, vars.github_repo);
  let who: { name: string; email: string } | undefined;
  if (req.op !== "clone" && req.op !== "fetch" && req.op !== "status") {
    const iso = stepIsolation(engine, vars, cred.level === "repository");
    // only a commit needs a name; for the others policy sees `commitIdentity: false` for a push
    if (iso && "refused" in iso && req.op === "commit") return reply("failed", NO_COMMIT_IDENTITY);
    const bot = engine.config.bot;
    who = iso ? ("who" in iso ? iso.who : undefined) : bot.name && bot.email ? { name: bot.name, email: bot.email } : undefined;
  }

  // 7. policy
  const facts = { repository: target.fact, step: step.id, tool: name, credential: cred.level, isolated };
  const answers = [engine.policy?.at("repository.access", facts, step)];
  if (answers[0] && !answers[0].denied && req.op === "push") answers.push(engine.policy?.at("push", { ...facts, branch: req.branch, commitIdentity: Boolean(who) }, step));
  const asked = answers.filter((a): a is NonNullable<typeof a> => Boolean(a));
  const denied = asked.find((a) => a.denied)?.denied;
  if (asked.length) st.policy = combineDecisions(asked.flatMap((a) => a.decisions))?.decision.outcome ?? (denied ? "deny" : undefined);
  if (denied) {
    refuseByPolicy(engine, step, denied);
    return refuse("policy", denied.reason);
  }

  // 8. the token and the process
  let username = "x-access-token";
  let expires: number | undefined;
  if (cred.level !== "none") {
    const t = await issueToken(engine, cred, target.name, req.op);
    if ("fail" in t) return reply("failed", t.fail);
    st.token = t.token;
    username = t.username ?? username;
    expires = t.expires;
  }
  const access = accessOf(cred, st.token, username, target);
  const env = brokerEnv(ctx, gh(), local ? undefined : access, who);
  const exact = plain(env);
  const net = (cmd: "git" | "gh", args: string[], stdin?: string) => run(cmd, args, exact, stdin);
  const finish = (r: ExecResult, extra?: { text?: string; pr?: PullRequestIdentity }): BrokerResult => {
    const text = `${r.stdout}${r.stderr}`;
    if (r.timedOut) return reply("failed", text, "timed out");
    if (r.aborted) return reply("failed", text, "cancelled");
    if (r.exitCode !== 0) {
      if (st.token && tokenRefused(r.stderr)) {
        const app = cred.level !== "none" && "source" in cred && (cred.source === "app" || cred.source === "bot-app");
        return reply("failed", text, app ? (expires !== undefined && expires <= Date.now() ? APP_TOKEN_EXPIRED : APP_REFUSED_RUN) : TOKEN_REFUSED_RUN);
      }
      return reply("failed", text);
    }
    return reply("done", extra?.text ?? text, "", extra?.pr);
  };

  const u = access.url;
  switch (req.op) {
    case "clone":
      return finish(await net("git", ["clone", "-q", "--", u, "."]));
    case "fetch": {
      const b = req.branch ?? "*";
      return finish(await net("git", ["fetch", "--no-tags", "--no-recurse-submodules", "--", u, `+refs/heads/${b}:refs/remotes/origin/${b}`]));
    }
    case "push":
      return finish(await net("git", ["push", "--recurse-submodules=no", "--", u, `HEAD:refs/heads/${req.branch}`]));
    case "pull-request": {
      const args = ["pr", "create", `--repo=${target.fact}`, `--head=${req.head}`, `--base=${req.base}`, `--title=${req.title}`, "--body-file", "-", ...(req.draft ? ["--draft"] : [])];
      const r = await net("gh", args, req.body ?? "");
      return finish(r, { pr: r.exitCode === 0 ? pullRequestOf(r.stdout, target.fact) : undefined });
    }
    case "branch":
      return finish(await net("git", ["checkout", "-q", "-B", req.name, ...(req.from ? [`origin/${req.from}`] : [])]));
    case "status":
      return finish(await net("git", ["status", "--porcelain=v1", "--branch"]));
    case "commit": {
      const added = await net("git", ["add", "-A"]);
      if (added.exitCode !== 0 || added.timedOut || added.aborted) return finish(added);
      const staged = await net("git", ["diff", "--cached", "--quiet"]);
      if (staged.exitCode === 0 && !staged.timedOut && !staged.aborted) return reply("done", "nothing to commit");
      if (staged.exitCode !== 1 || staged.timedOut || staged.aborted) return finish(staged.exitCode === 0 ? { ...staged, exitCode: 1 } : staged);
      return finish(await net("git", ["commit", "-q", "--no-gpg-sign", "-m", req.message]));
    }
  }
}

/** The narrowest sign-in the grant allows, without making a token yet. */
function pickCredential(engine: Engine, t: Target, ceiling: Credential): Cred | { refusal: RepoRefusal } {
  if (ceiling === "none") return { level: "none" };
  const { owner: runOwner } = engine.summary;
  const access = repoAccess(runOwner, t.fact, { unlisted: "admin-server" });
  if (access.kind === "key") return { refusal: "deploy-key" };
  if (access.kind === "token") return { level: "repository", source: "token", token: access.token, username: access.username, url: access.url };
  if (access.kind === "app") return { level: "repository", source: "app", access };
  const { github_app: app, bot } = engine.config;
  if (ceiling !== "machine" || stepIsolated(runOwner, `${t.owner}/${t.name}`)) return { refusal: "no-credential" };
  if (app?.installation_id) return { level: "machine", source: "bot-app" };
  const token = bot.gh_token_env ? process.env[bot.gh_token_env] : undefined;
  return token ? { level: "machine", source: "bot-env", token } : { refusal: "no-credential" };
}

async function issueToken(engine: Engine, cred: Exclude<Cred, { level: "none" }>, repo: string, op: RepoOperation): Promise<{ token: string; username?: string; expires?: number } | { fail: string }> {
  if (cred.source === "token") return { token: cred.token, username: cred.username };
  if (cred.source === "bot-env") return { token: cred.token };
  const permissions = op in APP_PERMISSIONS ? APP_PERMISSIONS[op as keyof typeof APP_PERMISSIONS] : undefined;
  if (!repo) return { fail: APP_FAILED_RUN };
  if (cred.source === "app") {
    const t = await appTokenAccess(cred.access, engine.config, 20_000, permissions);
    return t.ok ? { token: t.token, expires: t.expires } : { fail: t.reason };
  }
  const app = engine.config.github_app!;
  try {
    const t = await installationTokenInfo(app, app.installation_id!, { repository: repo, fresh: true, permissions, timeoutMs: 20_000 });
    return { token: t.token, expires: t.expires };
  } catch (e) {
    return { fail: e instanceof GithubAppError ? e.message : APP_FAILED_RUN };
  }
}

type Access = { kind: "token"; token: string; url: string; username: string } | { kind: "none"; url: string };
function accessOf(cred: Cred, token: string | undefined, username: string, t: Target): Access {
  const fallback = `https://github.com/${t.owner}/${t.name}.git`;
  const stored = "access" in cred ? cred.access.url : "url" in cred ? cred.url : undefined;
  const url = stored && isPlainHttpsUrl(stored) ? stored : fallback;
  return token ? { kind: "token", token, url, username } : { kind: "none", url };
}

/** Adds one `GIT_CONFIG_KEY_n`/`VALUE_n` entry after the existing ones. */
function addConfig(env: Record<string, string | undefined>, key: string, value: string): void {
  const n = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10) || 0;
  env[`GIT_CONFIG_KEY_${n}`] = key;
  env[`GIT_CONFIG_VALUE_${n}`] = value;
  env.GIT_CONFIG_COUNT = String(n + 1);
}

/** The env of a process: the engine's own git settings first, no machine sign-in, https only, the commit name, then the credential. */
function brokerEnv(ctx: BrokerContext, ghDir: string, access: Access | undefined, who: { name: string; email: string } | undefined): Record<string, string | undefined> {
  const { engine, scope } = ctx;
  const env: Record<string, string | undefined> = { ...stepEnv(scope, engine), FACTORY_PUSH_LOG: undefined };
  const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10) || 0;
  let hooks = false;
  for (let i = 0; i < count; i++) if (env[`GIT_CONFIG_KEY_${i}`] === "core.hooksPath") hooks = true;
  // a repository's own pre-push hook must not run while a token is in the environment
  if (!hooks) addConfig(env, "core.hooksPath", "/dev/null");
  Object.assign(env, noMachineSignIn(engine.config, ghDir), { GIT_ALLOW_PROTOCOL: "https", GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined, GIT_INDEX_FILE: undefined, GIT_SSL_NO_VERIFY: undefined });
  addConfig(env, "user.useConfigOnly", "true");
  if (who) Object.assign(env, { GIT_AUTHOR_NAME: who.name, GIT_COMMITTER_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_EMAIL: who.email });
  if (access) Object.assign(env, access.kind === "token" ? repoTokenEnv(access, env as Record<string, string>, ghDir) : repoNoCredentialEnv(env as Record<string, string>, ghDir));
  return env;
}

/** The pull request a `gh pr create` printed: its page, on the last line. */
function pullRequestOf(stdout: string, repository: string): PullRequestIdentity | undefined {
  const line = stdout.trim().split("\n").pop()?.trim() ?? "";
  const m = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/([1-9]\d{0,9})$/.exec(line);
  const pr = m ? PullRequestIdentitySchema.safeParse({ repository, number: Number(m[1]), url: line }) : undefined;
  return pr?.success ? pr.data : undefined;
}
