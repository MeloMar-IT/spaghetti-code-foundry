import { execFile } from "node:child_process";
import { accessSync, constants, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runProcess, type ProcessMeter, type RunPriority } from "./process.js";

/** Where the Claude desktop app keeps its bundled Claude Code, one folder per version. */
const desktopClaudeCodeDir = () => process.env.FACTORY_DESKTOP_CLAUDE_DIR ?? join(homedir(), "Library/Application Support/Claude/claude-code");

const VERSION_RE = /(\d+)\.(\d+)\.(\d+)/;
function cmpVersion(a: string, b: string): number {
  const x = VERSION_RE.exec(a)?.slice(1).map(Number) ?? [0, 0, 0];
  const y = VERSION_RE.exec(b)?.slice(1).map(Number) ?? [0, 0, 0];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

/** `claude --version` on PATH: the text it prints. Rejects when it is not there. */
function claudeVersion(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("claude", ["--version"], { encoding: "utf8", timeout: 15_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/** The one `claude --version` of this process, shared by every caller. The first caller's probe wins. */
let pathProbe: Promise<string | null> | undefined;

/** What `claude --version` on PATH printed, or null when it is not there. Runs once; later calls share it. */
export function claudePathVersionText(probe: () => Promise<string> = claudeVersion): Promise<string | null> {
  pathProbe ??= probe().then(
    (out) => out,
    () => null,
  );
  pathProbe.then(() => (pathSettled = true));
  return pathProbe;
}

let pathSettled = false;

/** The probe while it is still running (so a caller can share it), else undefined: a finished answer is not reused. */
export function pendingClaudePathProbe(): Promise<string | null> | undefined {
  return pathProbe && !pathSettled ? pathProbe : undefined;
}

/** The newest Claude Code bundled with the Claude desktop app. Looked up on every call. */
function bundledClaude(): { version: string; bin: string } | undefined {
  let bundled: { version: string; bin: string } | undefined;
  try {
    for (const v of readdirSync(desktopClaudeCodeDir()).filter((d) => VERSION_RE.test(d)).sort(cmpVersion).reverse()) {
      // The app keeps it at <version>/claude.app/… or, in newer app versions, <version>/<id>/claude.app/…
      const dirs = [join(desktopClaudeCodeDir(), v)];
      try {
        for (const sub of readdirSync(join(desktopClaudeCodeDir(), v))) dirs.push(join(desktopClaudeCodeDir(), v, sub));
      } catch {
        // unreadable version folder
      }
      for (const d of dirs) {
        const bin = join(d, "claude.app/Contents/MacOS/claude");
        try {
          accessSync(bin, constants.X_OK);
          bundled = { version: v, bin };
          break;
        } catch {
          // not here, or an incomplete download of that version
        }
      }
      if (bundled) break;
    }
  } catch {
    // no desktop app
  }
  return bundled;
}

/**
 * FACTORY_CLAUDE_BIN, else the newest Claude Code on this Mac: `claude` on PATH or the one
 * bundled with the Claude desktop app (which updates itself). Newer models need a recent CLI.
 * Never blocks: the version on PATH is read once, without a shell, and shared.
 */
export async function resolveClaudeBinAsync(probe?: () => Promise<string>): Promise<string> {
  if (process.env.FACTORY_CLAUDE_BIN) return process.env.FACTORY_CLAUDE_BIN;
  const pathVersion = VERSION_RE.exec((await claudePathVersionText(probe)) ?? "")?.[0] ?? null;
  const bundled = bundledClaude();
  if (bundled && (!pathVersion || cmpVersion(bundled.version, pathVersion) > 0)) return bundled.bin;
  return "claude";
}

/**
 * Unattended factory steps should not inherit the user's personal Claude Code setup (MCP
 * servers, plugins, skills, hooks, env): it bloats every turn and invites off-task detours.
 * The only skills a step may follow are the ones the Foundry puts in a <foundry-skills> block at the
 * start of the prompt; the safety rules and the task win over that guidance.
 */
export const FACTORY_AGENT_NOTE = [
  "You are running unattended as one step of a Spaghetti Code Foundry flow. Do only the task in the prompt.",
  "Ignore instructions from global or home-folder configuration about spawning agents or swarms,",
  "memory tools, hooks or other orchestration. The only skill guidance you may follow is the",
  "<foundry-skills> block at the start of the prompt, or of an earlier prompt of this session, if there is one; do not use, load or look for any other skill.",
  "The Foundry's rules and the task win over it. Do not look at other projects",
  "or at ~/.claude. Work only inside the current workspace.",
].join(" ");

export interface ClaudeRunOptions {
  prompt: string;
  cwd: string;
  logFile: string;
  claudeBin?: string;
  model?: string;
  systemPrompt?: string;
  permissionMode?: string;
  allowedTools?: string[];
  resumeSessionId?: string;
  maxBudgetUsd?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  /** Pass only `env`, nothing of the server's environment. */
  cleanEnv?: boolean;
  /** Start Claude inside this `sandbox-exec` profile (a user's run, see os-sandbox.ts). */
  sandboxProfile?: string;
  /** Start Claude at this priority (see ProcessOptions). */
  priority?: RunPriority;
  /** Filled with the process time and the bytes it printed (see ProcessMeter). */
  meter?: ProcessMeter;
  /** Sandbox Claude's bash tool (writes limited to the workspace). */
  sandbox?: boolean;
  /** Folders outside the workspace the agent may write (the request folder of a step with repo_ops): added to its folders and to its bash sandbox. */
  writableDirs?: string[];
  /** Folders outside the workspace the agent may read but never edit (the run's context folder). */
  readOnlyDirs?: string[];
  /** Load no MCP servers (keeps the prompt small for local models). */
  noMcp?: boolean;
  /** Skip the user's personal setup: MCP servers, user settings (hooks, plugins, env), skills. */
  isolated?: boolean;
  /** Give the model no tools at all (`--tools ""`). */
  noTools?: boolean;
  /** Only these tools (`--tools a,b`), no hooks and no personal setup: an evaluation run. `noTools` wins. */
  tools?: readonly string[];
  /** low | medium | high | xhigh | max */
  effort?: string;
  onProgress?: (msg: string) => void;
  /** The name of each tool the model calls; never its arguments. Once per call: when its result comes back, with the time in whole ms, or at the end of the session without one. */
  onTool?: (name: string, durationMs?: number) => void;
}

export interface ClaudeRunResult {
  ok: boolean;
  output: string;
  sessionId?: string;
  costUsd?: number;
  numTurns?: number;
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
  /** Tool calls Claude Code refused (at most 5), without intentional `git push`. */
  denied?: string[];
  /** Tool calls of the session and the time they took (whole ms). Absent when the program did not start. */
  tools?: ToolTimes;
  /** The largest input of one model turn (input + cache read + cache creation tokens). Absent without `usage` lines. */
  contextTokens?: number;
}

/** Calls of a session and the time between each call and its result. A call without a result counts in `calls` only. */
export interface ToolTimes {
  calls: number;
  totalMs: number;
  maxMs: number;
}

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface StreamEvent {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  num_turns?: number;
  usage?: Usage;
  permission_denials?: Array<{ tool_name?: string; tool_input?: Record<string, unknown> }>;
  message?: { usage?: Usage; content?: Array<{ type?: string; id?: string; tool_use_id?: string; name?: string; input?: Record<string, unknown> }> };
}

const count = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);

/**
 * Times tool calls and finds the largest model turn from the lines of the stream. Pure apart from the clock and
 * `onTool`. Durations are whole milliseconds. Never throws on odd lines.
 */
export function streamMeter(o: { now?: () => number; onTool?: (name: string, durationMs?: number) => void }): { line(ev: unknown): void; end(): { tools: ToolTimes; contextTokens?: number } } {
  const now = o.now ?? (() => performance.now());
  const pending: { id?: string; name: string; at: number }[] = [];
  const tools: ToolTimes = { calls: 0, totalMs: 0, maxMs: 0 };
  let context: number | undefined;
  const notify = (name: string, ms?: number) => {
    try {
      o.onTool?.(name, ms);
    } catch {
      // a broken callback does not stop the session
    }
  };
  return {
    line(raw) {
      const ev = raw as StreamEvent | null;
      if (!ev || typeof ev !== "object") return;
      const content = Array.isArray(ev.message?.content) ? ev.message!.content! : [];
      if (ev.type === "assistant") {
        const u = ev.message?.usage;
        if (u && typeof u === "object") {
          const turn = count(u.input_tokens) + count(u.cache_read_input_tokens) + count(u.cache_creation_input_tokens);
          context = Math.max(context ?? 0, turn);
        }
        for (const c of content) {
          if (c?.type === "tool_use" && c.name) {
            tools.calls++;
            pending.push({ ...(typeof c.id === "string" && c.id ? { id: c.id } : {}), name: c.name, at: now() });
          }
        }
      } else if (ev.type === "user") {
        for (const c of content) {
          if (c?.type !== "tool_result" || typeof c.tool_use_id !== "string") continue;
          const i = pending.findIndex((p) => p.id === c.tool_use_id);
          if (i < 0) continue;
          const [p] = pending.splice(i, 1);
          const ms = Math.max(0, Math.round(now() - p!.at));
          tools.totalMs += ms;
          tools.maxMs = Math.max(tools.maxMs, ms);
          notify(p!.name, ms);
        }
      }
    },
    end() {
      for (const p of pending.splice(0)) notify(p.name);
      return { tools: { ...tools }, ...(context !== undefined ? { contextTokens: context } : {}) };
    },
  };
}

export function buildClaudeArgs(o: ClaudeRunOptions): string[] {
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  if (o.model) args.push("--model", o.model);
  if (o.effort) args.push("--effort", o.effort);
  if (o.permissionMode) args.push("--permission-mode", o.permissionMode);
  if (o.noTools) args.push("--tools", "");
  else if (o.tools) args.push("--tools", o.tools.join(","));
  if (o.allowedTools?.length) args.push("--allowedTools", o.allowedTools.join(","));
  const system = [o.isolated ? FACTORY_AGENT_NOTE : "", o.systemPrompt ?? ""].filter(Boolean).join("\n\n");
  if (system) args.push("--append-system-prompt", system);
  if (o.resumeSessionId) args.push("--resume", o.resumeSessionId);
  for (const dir of o.writableDirs ?? []) args.push("--add-dir", dir);
  if (o.maxBudgetUsd) args.push("--max-budget-usd", String(o.maxBudgetUsd));
  // Pushing is a flow decision (shell steps + protected-branch hook), never Claude's.
  args.push("--disallowedTools", "Bash(git push*)");
  const strict = o.isolated || Boolean(o.tools);
  if (o.noMcp || strict) args.push("--strict-mcp-config");
  if (strict) args.push("--setting-sources", "project,local", "--disable-slash-commands");
  // Through --settings, not --allowedTools: a path with a space or a comma would break the list.
  const readOnly = (o.readOnlyDirs ?? []).map((dir) => `//${dir.replace(/^\/+/, "").replace(/\/+$/, "")}/**`);
  const settings = {
    ...(readOnly.length
      ? { permissions: { allow: readOnly.map((p) => `Read(${p})`), deny: readOnly.flatMap((p) => [`Edit(${p})`, `Write(${p})`, `NotebookEdit(${p})`]) } }
      : {}),
    ...(o.sandbox ? { sandbox: { enabled: true, autoAllowBashIfSandboxed: true, ...(o.writableDirs?.length ? { filesystem: { allowWrite: o.writableDirs } } : {}) } } : {}),
    ...(o.tools ? { disableAllHooks: true } : {}),
  };
  if (Object.keys(settings).length) args.push("--settings", JSON.stringify(settings));
  return args;
}

function describeToolUse(name: string, input: Record<string, unknown> = {}): string {
  const hint = input.file_path ?? input.command ?? input.pattern ?? input.description;
  const s = typeof hint === "string" ? hint.replace(/\s+/g, " ").slice(0, 80) : "";
  return s ? `${name}: ${s}` : name;
}

// An executed `git` (optionally path-qualified, after env assignments) at a command position, not in an argument.
const GIT_PUSH = /(?:^|[;&|(\n])\s*(?:\w+=\S*\s+)*(?:\S*\/)?git(?:\s+-\S+(?:\s+[^-\s]\S*)?)*\s+push\b/;

/** `git push` is always refused on purpose (see buildClaudeArgs); it is not a finding. */
function isPush(tool: string, input: Record<string, unknown> = {}): boolean {
  return tool === "Bash" && typeof input.command === "string" && GIT_PUSH.test(input.command);
}

/** Run the local Claude Code CLI headlessly. The prompt goes via stdin. */
export async function runClaude(o: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const bin = o.claudeBin ?? (await resolveClaudeBinAsync());
  let final: StreamEvent | undefined;
  const meter = streamMeter({ onTool: o.onTool });

  const spawned = await runProcess(bin, buildClaudeArgs(o), {
    cwd: o.cwd,
    env: o.env,
    cleanEnv: o.cleanEnv,
    sandboxProfile: o.sandboxProfile,
    priority: o.priority,
    meter: o.meter,
    stdin: o.prompt,
    timeoutMs: o.timeoutMs,
    signal: o.signal,
    logFile: o.logFile,
    onLine: (line) => {
      let ev: StreamEvent;
      try {
        ev = JSON.parse(line) as StreamEvent;
      } catch {
        return;
      }
      meter.line(ev);
      if (ev.type === "result") final = ev;
      else if (ev.type === "assistant" && o.onProgress) {
        for (const c of ev.message?.content ?? []) {
          if (c.type === "tool_use" && c.name) o.onProgress(describeToolUse(c.name, c.input));
        }
      }
    },
  }).then((r) => ({ res: r }), (e: Error) => ({ err: e }));
  // A program that is not there is a setup problem with a stable message (the failure rules read it).
  if ("err" in spawned) {
    meter.end();
    const msg = /ENOENT/.test(spawned.err.message) ? "claude CLI not found — install Claude Code on the computer that runs the Foundry" : spawned.err.message;
    return { ok: false, output: "", error: msg };
  }
  const res = spawned.res;
  const measured = meter.end();

  if (res.aborted) return { ok: false, output: final?.result ?? "", error: "cancelled", ...measured };
  if (res.timedOut) return { ok: false, output: final?.result ?? "", error: "timed out", ...measured };
  if (!final) {
    return {
      ...measured,
      ok: false,
      output: "",
      error: `claude exited with code ${res.exitCode} and no result. ${res.stderr.trim().slice(-500)}`,
    };
  }
  const ok = !final.is_error && final.subtype === "success" && res.exitCode === 0;
  const denied = [...new Set(
    (Array.isArray(final.permission_denials) ? final.permission_denials : [])
      .filter((d) => d && typeof d.tool_name === "string" && d.tool_name && !isPush(d.tool_name, d.tool_input))
      .map((d) => describeToolUse(d.tool_name!, d.tool_input)),
  )].slice(0, 5);
  return {
    ...measured,
    denied: denied.length ? denied : undefined,
    ok,
    output: final.result ?? "",
    sessionId: final.session_id,
    costUsd: final.total_cost_usd,
    numTurns: final.num_turns,
    inputTokens: final.usage ? (final.usage.input_tokens ?? 0) + (final.usage.cache_read_input_tokens ?? 0) + (final.usage.cache_creation_input_tokens ?? 0) : undefined,
    outputTokens: final.usage?.output_tokens,
    // An API error comes back as is_error with subtype "success": show its message, not "success".
    error: ok ? undefined : final.subtype && final.subtype !== "success" ? `claude result: ${final.subtype}` : (final.result || "claude reported an error").slice(0, 300),
  };
}
