import { spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, sep } from "node:path";
import type { Config } from "../config.js";
import { CONTEXT_ATTEMPT_FILE, CONTEXT_BUNDLE_FILE, CONTEXT_SOURCES_DIR } from "../context/version.js";
import { EVIDENCE_DIFF_FILE, EVIDENCE_EVENTS_FILE, EVIDENCE_INCOMPLETE_FILE, EVIDENCE_MANIFEST_FILE } from "../evidence/version.js";
import { FACTORY_HOME } from "../flow/load.js";
import { checkOutbound, evaluationLimits, READ_DENY_REFUSED } from "./eval-limits.js";
import { TOOLS_DIR as TOOLS } from "./guards.js";
import { heldWorkspace, userAccount } from "./isolation.js";
import { workspaceDir, workspaceFolderIn } from "./state.js";

/**
 * Holds a step (shell or agent) of a user's run in a generated `sandbox-exec` profile (macOS): it cannot read other runs, the data folder,
 * the Mac account's home or the Keychain, and it can write only in its own run folder. The profile allows everything first
 * and then denies; the last matching rule wins, so the order of the lines below is what the profile means.
 */

export const SANDBOX_REFUSED = "This computer cannot hold a user's run in a sandbox, so the run was not started. An admin can allow user runs without it in Settings.";
export const SANDBOX_FOLDER_FAILED = "SANDBOX_FOLDER_FAILED";

/** The folder in the data folder with the delivery signing keys: no sandboxed step may read it. */
export const DELIVERY_KEYS_DIR = "delivery-keys";
/** The folder in a run folder with the delivery contract: the server alone writes it. */
export const RUN_DELIVERY_DIR = "delivery";

const SANDBOX_EXEC ="/usr/bin/sandbox-exec";
const WRITABLE_DEVICES = ["/dev/null", "/dev/tty", "/dev/dtracehelper"];

let cached: boolean | undefined;

/** Forget the trial (tests); with a value, the next `sandboxAvailable()` answers it. */
export function resetSandboxCache(value?: boolean): void {
  cached = value;
}

/** macOS, `sandbox-exec` is there, and a trial profile runs. Asked once per process (a sandbox inside a sandbox fails the trial). */
export function sandboxAvailable(): boolean {
  if (cached !== undefined) return cached;
  let ok = false;
  if (process.platform === "darwin" && existsSync(SANDBOX_EXEC)) {
    try {
      ok = spawnSync(SANDBOX_EXEC, ["-p", "(version 1)(allow default)", "/usr/bin/true"], { stdio: "ignore", timeout: 10_000 }).status === 0;
    } catch {
      ok = false;
    }
  }
  return (cached = ok);
}

/** Does a user's run need the sandbox? `off` when the owner is an admin (or unknown), or an admin allowed runs without it. */
export function sandboxedRun(owner: string | undefined, config: Pick<Config, "sandbox">, available: () => boolean = sandboxAvailable): "on" | "off" | { refused: string } {
  if (userAccount(owner) === undefined) return "off";
  if (config.sandbox.user_runs === "off" || process.env.SCF_USER_SANDBOX === "off" || process.env.FACTORY_USER_SANDBOX === "off") return "off";
  return available() ? "on" : { refused: SANDBOX_REFUSED };
}

/** Why a team's run stops before any step when the sandbox cannot be used (#785). */
export const TEAM_SANDBOX_REFUSED = "This computer cannot hold a team's run in a sandbox, so the run was not started. Runs in a workspace always need the sandbox.";

/**
 * Does this run need the sandbox? A team's run (any workspace but `default`) always does, whatever `sandbox.user_runs`
 * and SCF_USER_SANDBOX say, also for an admin; `default` runs follow `sandboxedRun` exactly.
 */
export function runSandbox(run: { owner?: string; workspace?: string }, config: Pick<Config, "sandbox">, available: () => boolean = sandboxAvailable): "on" | "off" | { refused: string } {
  if (heldWorkspace(run.workspace)) return available() ? "on" : { refused: TEAM_SANDBOX_REFUSED };
  return sandboxedRun(run.owner, config, available);
}

/** A shell step is wrapped when its run is sandboxed and no Docker image holds it. */
export const wrapsStep = (mode: "on" | "off" | { refused: string }, dockerImage: string | undefined): boolean => mode === "on" && !dockerImage;

export interface SandboxPaths {
  /** The Mac account's home folder. */
  home: string;
  /** The server's data folder. */
  data: string;
  /** The folder with all run folders. */
  runs: string;
  /** More folders with runs or workspace folders, denied like `runs` (#824). */
  runsRoots?: string[];
  runDir: string;
  tools: string;
  /** The compiled code the tools load (`dist/`, read-only) and the files that tell node how to read it (`package.json`). */
  compiled?: { dir: string; files: string[] };
  hooks: string;
  learnings: string;
  lockDir: string;
  /** The system temp folder: other steps' `gh` folders and key files lie there. */
  temp?: string;
  /** The `gh` folder of this step. */
  ghDir?: string;
  /** Programs (node, git, claude, codex): their folder is readable when it lies under the home. */
  programs?: string[];
  /** Paths from `sandbox.user_read`. */
  userRead?: string[];
  /** The one agent program of an agent step: it and its install folder are readable, whatever the home rules say. */
  agentProgram?: string;
  /** Writes only in `<runDir>/home` and `<runDir>/tmp` (a read-only Codex step): the workspace stays as it is. */
  workspaceReadOnly?: boolean;
  /** The request folder of a step with repo_ops: also writable when the workspace is read-only. */
  requestsDir?: string;
  /** The folder of the push log: also writable when the workspace is read-only, so a refused push can always be recorded. */
  pushLogDir?: string;
  /** Folders no step may read, from the evaluation limit. */
  denyRead?: string[];
  /** When set, the only outbound TCP: `*:<port>` or `localhost:<port>`. */
  outbound?: string[];
  /** A team's step (#785): all outbound IP is denied except the proxy port and the ports of a local model endpoint, on localhost. An evaluation limit narrows it. */
  network?: { proxyPort?: number; localPorts: number[] };
  /** Folders the step may read and write (the workspace cache); read-only for a read-only workspace. */
  shared?: string[];
  /** Folders the server writes and the step only reads (the Java stand-in). */
  readOnly?: string[];
  /** The test slots: the machine's `slot-N` folders, the workspace's own folder (`workspace` is its id) and the governor's files; `link` is `<workspace folder>/test-slots`. */
  slots?: { root: string; workspace: string; link?: string };
}

type Real = (p: string) => string;

/** Real path of `p`; the part that does not exist yet is kept as named. */
function deepReal(p: string, real: Real): string {
  try {
    return real(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : join(deepReal(parent, real), basename(p));
  }
}

/** Real path of the folder that holds `p`, then the name as given: a link a step makes at `p` itself is never followed. */
function namedReal(p: string, real: Real): string {
  return join(deepReal(dirname(p), real), basename(p));
}

/** A path as a Seatbelt regex literal: every special character is escaped; a line break, a NUL or a quote is refused. */
export function regexQuote(p: string): string {
  if (/[\n\r\0"]/.test(p)) throw new Error("a path with a line break or a quote cannot be used in a sandbox profile");
  return p.replace(/[\\.^$|()[\]{}*+?]/g, "\\$&");
}

/** A path in profile text. A newline would end the string early, so it is refused. */
function quote(p: string): string {
  if (/[\n\r\0]/.test(p)) throw new Error("a path with a line break cannot be used in a sandbox profile");
  return `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const within = (p: string, root: string): boolean => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * The folder an agent program needs next to itself: the `.app` bundle, or the `node_modules/<package>` folder
 * (also `@scope/package`). A plain binary has none.
 */
export function installDir(realBin: string): string | undefined {
  const parts = realBin.split(sep);
  const app = parts.findIndex((x) => x.endsWith(".app") && x.length > 4);
  if (app > 0) return parts.slice(0, app + 1).join(sep) || sep;
  const nm = parts.lastIndexOf("node_modules");
  if (nm >= 0) {
    const len = parts[nm + 1]?.startsWith("@") ? 2 : 1;
    if (parts.length > nm + 1 + len) return parts.slice(0, nm + 1 + len).join(sep);
  }
  return undefined;
}

/** The profile text for one step. Pure: `real` is `realpathSync` unless a test gives another. */
export function sandboxProfile(paths: SandboxPaths, real: Real = realpathSync): string {
  const home = deepReal(paths.home, real);
  const data = deepReal(paths.data, real);
  const runs = deepReal(paths.runs, real);
  const runDir = namedReal(paths.runDir, real);
  const runTmp = join(runDir, "tmp");
  const tools = deepReal(paths.tools, real);
  const hooks = deepReal(paths.hooks, real);
  const learnings = namedReal(paths.learnings, real);
  const lockDir = namedReal(paths.lockDir, real);
  const temp = paths.temp ? deepReal(paths.temp, real) : undefined;
  const ghDir = paths.ghDir ? deepReal(paths.ghDir, real) : undefined;

  // the agents' own folders hold their login and settings: no program rule may open them
  const secretDirs = [join(home, ".claude"), join(home, ".codex")];
  const opensSecrets = (d: string) => secretDirs.some((x) => within(x, d));
  const programDirs = (paths.programs ?? [])
    .filter((p) => isAbsolute(p))
    .map((p) => dirname(deepReal(p, real)))
    .filter((d) => d !== home && within(d, home) && !opensSecrets(d));
  const agent = paths.agentProgram && isAbsolute(paths.agentProgram) ? paths.agentProgram : undefined;
  const agentReal = agent ? deepReal(agent, real) : undefined;
  const agentInstall = agentReal ? installDir(agentReal) : undefined;
  const extra = (paths.userRead ?? []).filter((p) => isAbsolute(p)).map((p) => deepReal(p, real));
  const readFirst = [...new Set([...extra, ...programDirs, ...(agentInstall && !opensSecrets(agentInstall) ? [agentInstall] : [])])];

  const outbound = paths.outbound?.map(checkOutbound);
  const denyRead = (paths.denyRead ?? []).map((p) => {
    if (!isAbsolute(p)) throw new Error(READ_DENY_REFUSED);
    return deepReal(p, real);
  });
  const denied = [...new Set([home, data, runs, ...(paths.runsRoots ?? []).map((p) => deepReal(p, real)), ...(temp ? [temp] : []), ...denyRead])];
  const compiledDir = paths.compiled ? deepReal(paths.compiled.dir, real) : undefined;
  const compiledFiles = (paths.compiled?.files ?? []).map((f) => deepReal(f, real));
  const shared = (paths.shared ?? []).map((p) => deepReal(p, real));
  const readOnly = (paths.readOnly ?? []).map((p) => deepReal(p, real));
  const slotRoot = paths.slots ? deepReal(paths.slots.root, real) : undefined;
  const slotOwn = paths.slots && slotRoot ? join(slotRoot, "workspaces", paths.slots.workspace) : undefined;
  const slotFiles = slotRoot ? ["cap", "workers", "pause"].map((f) => join(slotRoot, f)) : [];
  const slotLink = paths.slots?.link ? namedReal(paths.slots.link, real) : undefined;
  const subpathReads = [runDir, tools, hooks, lockDir, ...(ghDir ? [ghDir] : []), ...(compiledDir ? [compiledDir] : []), ...shared, ...readOnly];
  const literalReads = [learnings, join(data, "known_hosts"), ...compiledFiles, ...new Set([agent ? namedReal(agent, real) : undefined, agentReal].filter((p): p is string => Boolean(p)))];

  // A process needs the metadata of each folder above an allowed path that lies under a denied folder.
  const parents = new Set<string>();
  for (const p of [...readFirst, ...subpathReads, ...literalReads, ...(slotOwn ? [slotOwn, ...slotFiles] : []), ...(slotLink ? [slotLink] : [])]) {
    for (let d = dirname(p); d !== dirname(d); d = dirname(d)) {
      if (denied.some((r) => within(d, r))) parents.add(d);
    }
  }

  const out: string[] = ["(version 1)", "(allow default)"];
  // reads
  // all broad denies first, then every exception (also user_read and program folders inside the data, runs or temp folder)
  for (const p of denied) out.push(`(deny file-read* (subpath ${quote(p)}))`);
  for (const p of readFirst) out.push(`(allow file-read* (subpath ${quote(p)}))`);
  for (const p of subpathReads) out.push(`(allow file-read* (subpath ${quote(p)}))`);
  for (const p of literalReads) out.push(`(allow file-read* (literal ${quote(p)}))`);
  for (const p of parents) out.push(`(allow file-read-metadata (literal ${quote(p)}))`);
  if (slotRoot) out.push(`(allow file-read-metadata (literal ${quote(slotRoot)}))`);
  // the delivery signing keys: after every allow, so no user_read or program folder opens them; a key added during the step is covered too
  const keys = join(data, DELIVERY_KEYS_DIR);
  out.push(`(deny file-read* (subpath ${quote(keys)}))`);
  try {
    const r = real(keys);
    if (r !== keys) out.push(`(deny file-read* (subpath ${quote(r)}))`);
  } catch {
    /* not made yet */
  }
  // writes
  out.push("(deny file-write*)");
  const writable = paths.workspaceReadOnly ? [join(runDir, "home"), runTmp, ...(paths.requestsDir ? [paths.requestsDir] : []), ...(paths.pushLogDir ? [namedReal(paths.pushLogDir, real)] : [])] : [runDir, runTmp, lockDir, ...(ghDir ? [ghDir] : [])];
  for (const p of [...writable, ...(paths.workspaceReadOnly ? [] : shared)]) out.push(`(allow file-write* (subpath ${quote(p)}))`);
  // the test slots (#785): after the write deny, so they also hold for a read-only workspace
  if (slotRoot && slotOwn) {
    out.push(`(allow file-read* file-write* (subpath ${quote(slotOwn)}))`);
    out.push(`(allow file-read* file-write* (regex #"^${regexQuote(slotRoot)}/slot-[0-9]+(/.*)?$"))`);
    out.push(`(allow file-read* ${slotFiles.map((f) => `(literal ${quote(f)})`).join(" ")})`);
    if (slotLink) out.push(`(allow file-read* (literal ${quote(slotLink)}))`);
  }
  // only the learnings file: its folder is made by the server before the step and cannot be moved or removed by the step
  if (!paths.workspaceReadOnly) out.push(`(allow file-write* (literal ${quote(learnings)}))`);
  for (const p of WRITABLE_DEVICES) out.push(`(allow file-write* (literal ${quote(p)}))`);
  // what the server alone writes
  out.push(`(deny file-write* (literal ${quote(join(runDir, "run.json"))}) (literal ${quote(join(runDir, "live.log"))}) (subpath ${quote(join(runDir, "logs"))}))`);
  out.push(`(deny file-write* (literal ${quote(join(runDir, "skill-lock.json"))}))`);
  out.push(`(deny file-write* (literal ${quote(join(runDir, EVIDENCE_EVENTS_FILE))}) (literal ${quote(join(runDir, EVIDENCE_MANIFEST_FILE))}) (literal ${quote(join(runDir, EVIDENCE_DIFF_FILE))}) (literal ${quote(join(runDir, EVIDENCE_INCOMPLETE_FILE))}))`);
  out.push(`(deny file-write* (literal ${quote(join(runDir, CONTEXT_BUNDLE_FILE))}) (literal ${quote(join(runDir, CONTEXT_ATTEMPT_FILE))}) (subpath ${quote(join(runDir, CONTEXT_SOURCES_DIR))}))`);
  out.push(`(deny file-write* (subpath ${quote(join(runDir, RUN_DELIVERY_DIR))}))`);
  out.push(`(deny file-write* (subpath ${quote(join(runDir, "step-pids"))}))`);
  out.push(`(deny file-write* (subpath ${quote(join(lockDir, ".running"))}))`);
  // the run folder and the lock folder themselves cannot be moved or removed
  out.push(`(deny file-write* (literal ${quote(runDir)}) (literal ${quote(lockDir)}))`);
  // a link or a clone would give a second name to a file the step may not read or write
  out.push("(deny file-link)", "(deny file-clone)");
  // ways out of the file rules
  out.push('(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd"))');
  out.push("(deny network-outbound (remote unix-socket))");
  out.push('(allow network-outbound (literal "/private/var/run/mDNSResponder"))');
  // an evaluation limit: TCP only to the listed ports (Seatbelt takes only `*` or `localhost` as the host)
  if (paths.network) {
    const allowed = [paths.network.proxyPort, ...paths.network.localPorts].filter((x): x is number => Boolean(x)).map((x) => `localhost:${x}`);
    out.push('(deny network-outbound (remote ip "*:*"))');
    for (const e of allowed.filter((x) => !outbound || outbound.includes(x))) out.push(`(allow network-outbound (remote tcp ${quote(e)}))`);
  } else if (outbound) {
    out.push('(deny network-outbound (remote ip "*:*"))');
    for (const e of outbound) out.push(`(allow network-outbound (remote tcp ${quote(e)}))`);
  }
  out.push("(deny lsopen)", "(deny appleevent-send)", "(deny job-creation)");
  return out.join("\n");
}

/** Where `name` is on the PATH (for the profile: its folder may be readable). */
function onPath(name: string, path = process.env.PATH ?? ""): string | undefined {
  for (const d of path.split(delimiter)) {
    if (!d || !isAbsolute(d)) continue;
    const f = join(d, name);
    if (existsSync(f)) return f;
  }
  return undefined;
}

/** The profile paths of one step of a run (see the notes in `sandboxProfile`). */
export function stepSandboxPaths(o: { runDir: string; learnings: string; ghDir?: string; claudeBin?: string; codexBin?: string; userRead?: string[]; agentBin?: string; workspaceReadOnly?: boolean; requestsDir?: string; pushLogDir?: string; runsDir?: string; lockDir?: string; network?: SandboxPaths["network"]; shared?: string[]; readOnly?: string[]; slots?: SandboxPaths["slots"] }): SandboxPaths {
  const data = process.env.FACTORY_HOME ?? FACTORY_HOME;
  const programs = [process.execPath, onPath("git"), o.claudeBin ? (isAbsolute(o.claudeBin) ? o.claudeBin : onPath(o.claudeBin)) : onPath("claude"), o.codexBin ? (isAbsolute(o.codexBin) ? o.codexBin : onPath(o.codexBin)) : onPath("codex")];
  const limit = evaluationLimits();
  return {
    home: homedir(),
    data,
    runs: dirname(o.runDir),
    runsRoots: [join(data, "runs"), join(data, "workspaces"), ...(o.runsDir ? [o.runsDir, join(dirname(o.runsDir), "workspaces")] : [])],
    runDir: o.runDir,
    tools: TOOLS,
    compiled: { dir: join(TOOLS, "../dist"), files: [join(TOOLS, "../package.json")] },
    hooks: join(data, "hooks"),
    learnings: o.learnings,
    lockDir: o.lockDir ?? (process.env.SCF_LOCK_DIR || process.env.FACTORY_LOCK_DIR || join(data, "locks")),
    temp: tmpdir(),
    ghDir: o.ghDir,
    programs: programs.filter((p): p is string => Boolean(p)),
    userRead: o.userRead,
    ...(o.agentBin ? { agentProgram: isAbsolute(o.agentBin) ? o.agentBin : onPath(o.agentBin) } : {}),
    ...(o.workspaceReadOnly ? { workspaceReadOnly: true } : {}),
    ...(o.requestsDir ? { requestsDir: o.requestsDir } : {}),
    ...(o.pushLogDir ? { pushLogDir: o.pushLogDir } : {}),
    ...(o.network ? { network: o.network } : {}),
    ...(o.shared ? { shared: o.shared } : {}),
    ...(o.readOnly ? { readOnly: o.readOnly } : {}),
    ...(o.slots ? { slots: o.slots } : {}),
    ...(limit ? { denyRead: [...limit.denyRead], outbound: [...limit.outbound] } : {}),
  };
}

/**
 * A folder of the step's own, made on an open handle so that a link left there by an earlier step is never followed:
 * a link or a file is replaced, and the mode becomes 0700.
 */
export function ownDir(path: string): void {
  try {
    let st = lstatSync(path, { throwIfNoEntry: false });
    if (st && !st.isDirectory()) {
      rmSync(path, { force: true });
      st = undefined;
    }
    if (!st) mkdirSync(path, { mode: 0o700 });
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    try {
      fchmodSync(fd, 0o700);
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    throw new Error(`${SANDBOX_FOLDER_FAILED}: could not make ${path} (${(e as NodeJS.ErrnoException).code ?? "error"})`);
  }
}

/** The text of a plain file; "" for a link, a pipe, a folder or a missing file (a step may have put one there). */
export function readPlainFile(path: string, maxBytes = 1_000_000): string {
  let fd: number | undefined;
  try {
    // one open that never follows a link or waits for a pipe; what was opened is what is checked and read
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile()) return "";
    const buf = Buffer.alloc(Math.min(st.size, maxBytes));
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The cache folder of a workspace and the variables that point package tools at it (#785). The folder is made on an open handle, so a planted link is replaced. */
export function workspaceCacheEnv(ws: string, env: Record<string, string | undefined> = {}): { dir: string; env: Record<string, string> } {
  const home = workspaceFolderIn(process.env.FACTORY_HOME ?? FACTORY_HOME, ws);
  mkdirSync(home, { recursive: true });
  const dir = join(home, "cache");
  ownDir(dir);
  const maven = `-Dmaven.repo.local=${join(dir, "m2")}`;
  return {
    dir,
    env: {
      npm_config_cache: join(dir, "npm"),
      YARN_CACHE_FOLDER: join(dir, "yarn"),
      GRADLE_USER_HOME: join(dir, "gradle"),
      MAVEN_OPTS: env.MAVEN_OPTS ? `${env.MAVEN_OPTS} ${maven}` : maven,
      PIP_CACHE_DIR: join(dir, "pip"),
      GOMODCACHE: join(dir, "go-mod"),
      GOCACHE: join(dir, "go-build"),
    },
  };
}

/** The folder with the Java stand-in of a team's run: the server makes it, the step only reads it (#785). */
export function workspaceJavaDir(ws: string): string {
  const home = workspaceFolderIn(process.env.FACTORY_HOME ?? FACTORY_HOME, ws);
  mkdirSync(home, { recursive: true });
  const dir = join(home, "agent-java");
  ownDir(dir);
  return dir;
}

/**
 * The test slots a team's step may use. The data folder is `dirname(runsDir)`, like `ensureWorkspaceTestSlots`; the
 * workspace's own slot folder is made here. `link` is the `test-slots` link in the workspace folder that flows and the gate follow.
 */
export function workspaceSlotsDir(runsDir: string | undefined, ws: string): { root: string; workspace: string; link: string } {
  const data = runsDir ? dirname(runsDir) : (process.env.FACTORY_HOME ?? FACTORY_HOME);
  const rd = runsDir ?? join(data, "runs");
  mkdirSync(join(data, "test-slots", "workspaces", ws), { recursive: true });
  return { root: realpathSync(join(data, "test-slots")), workspace: ws, link: join(workspaceDir(rd, ws), "test-slots") };
}

/** HOME and the temp folders of a sandboxed step: folders of its own in the run folder. */
export function sandboxHomeEnv(runDir: string): Record<string, string> {
  const home = join(runDir, "home");
  const tmp = join(runDir, "tmp");
  ownDir(home);
  ownDir(tmp);
  return { HOME: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
}
