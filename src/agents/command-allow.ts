import { accessSync, chmodSync, closeSync, constants, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, delimiter, join, resolve } from "node:path";
import type { Engine, Scope, StepResult } from "../engine/execute.js";
import { TOOLS_DIR } from "../engine/guards.js";
import { ALLOW_COMMAND_SETS, type AllowCommandSet, type ClaudeStep } from "../flow/schema.js";

// `allow_commands` on a claude step: named sets of commands the step may run on top of its tools.
//   images           magick, sips, cwebp, dwebp, pngquant and qlmanage -t, only the ones installed, only through tools/image-gate.mjs
//   project_scripts  the repository's own build and test scripts (the names in the root package.json)
// A step that still needs a refused command stops the run once (see refusedCommandStop).

export { ALLOW_COMMAND_SETS };
export type { AllowCommandSet };

export const IMAGE_TOOLS = ["magick", "sips", "cwebp", "dwebp", "pngquant", "qlmanage"] as const;
export type ImageTool = (typeof IMAGE_TOOLS)[number];
export const IMAGE_BIN_DIR = "image-bin";
export const IMAGE_LOG_DIR = "image-log";
export const IMAGE_GATE = join(TOOLS_DIR, "image-gate.mjs");

const MAX_SCRIPT_RULES = 40;
const SCRIPT_NAME = /^(build|test)([:._-][A-Za-z0-9:._-]{1,40})?$/;
const MARKER = /^[ \t]*REFUSED_COMMAND:[ \t]*(.*)$/m;

/** Is `dir` or a folder inside it in `skip`? */
function skipped(dir: string, skip: readonly string[]): boolean {
  return skip.some((s) => dir === s || dir.startsWith(s + "/"));
}

/** The executable file `name` on `path` (its real path), or undefined. Folders in `skip` are not looked at. */
export function findOnPath(name: string, path: string | undefined, skip: readonly string[] = []): string | undefined {
  for (const dir of (path ?? "").split(delimiter)) {
    if (!dir || skipped(resolve(dir), skip)) continue;
    const file = join(dir, name);
    try {
      if (!statSync(file).isFile()) continue;
      accessSync(file, constants.X_OK);
      return realpathSync(file);
    } catch {
      /* not here */
    }
  }
  return undefined;
}

/** The image tools found on `path`, with the real file of each. */
export function installedImageTools(path: string | undefined, skip: readonly string[] = []): { name: ImageTool; path: string }[] {
  const out: { name: ImageTool; path: string }[] = [];
  for (const name of IMAGE_TOOLS) {
    const p = findOnPath(name, path, skip);
    if (p) out.push({ name, path: p });
  }
  return out;
}

/** The permission rules of the image tools (qlmanage only with -t). */
export function imageToolRules(tools: readonly ImageTool[]): string[] {
  return tools.map((t) => (t === "qlmanage" ? "Bash(qlmanage -t *)" : `Bash(${t} *)`));
}

/** The rules for the build and test scripts named in the root package.json of `workdir`. Never more than 40. */
export function projectScriptRules(workdir: string): string[] {
  let scripts: Record<string, unknown> = {};
  try {
    const file = join(workdir, "package.json");
    if (statSync(file).size > 1_000_000) return [];
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { scripts?: unknown };
    if (parsed && typeof parsed.scripts === "object" && parsed.scripts !== null) scripts = parsed.scripts as Record<string, unknown>;
  } catch {
    return [];
  }
  const names = Object.keys(scripts).filter((n) => SCRIPT_NAME.test(n));
  const runners = ["npm", ...(existsSync(join(workdir, "pnpm-lock.yaml")) ? ["pnpm"] : []), ...(existsSync(join(workdir, "yarn.lock")) ? ["yarn"] : [])];
  const rules: string[] = [];
  for (const r of runners) {
    for (const n of names) rules.push(`Bash(${r} run ${n})`, `Bash(${r} run ${n} *)`);
    if (names.includes("test")) rules.push(`Bash(${r} test)`, `Bash(${r} test *)`);
  }
  return [...new Set(rules)].slice(0, MAX_SCRIPT_RULES);
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Writes one wrapper per tool into `dir` (made before), then makes the folder read-only. The paths are fixed in the files. */
export function writeImageBin(dir: string, o: { root: string; log: string; tools: readonly { name: ImageTool; path: string }[]; node?: string; gate?: string }): void {
  for (const t of o.tools) {
    const file = join(dir, t.name);
    // The tool's name is passed on its own: the real file may be a symlink to a binary with another name.
    writeFileSync(file, `#!/bin/sh\nexec ${quote(o.node ?? process.execPath)} ${quote(o.gate ?? IMAGE_GATE)} ${quote(o.root)} ${quote(o.log)} ${quote(t.name)} ${quote(t.path)} "$@"\n`);
    chmodSync(file, 0o555);
  }
  chmodSync(dir, 0o555);
}

export interface StepCommands {
  /** Extra permission rules of the step. */
  rules: string[];
  /** The wrapper folder (first on the PATH). */
  binDir?: string;
  /** The folder of the refusal log: outside the checkout, writable for the session. */
  logDir?: string;
  refusalLog?: string;
  /** One line for the run log. */
  log?: string;
  /** Removes both folders; call it after the process has exited. */
  cleanup(): void;
}

const none = (log?: string): StepCommands => ({ rules: [], ...(log ? { log } : {}), cleanup() {} });

function removeDir(dir: string): void {
  try {
    chmodSync(dir, 0o755);
  } catch {
    /* gone */
  }
  rmSync(dir, { recursive: true, force: true });
}

/** The rules and wrappers of one attempt of a step with `allow_commands`. */
export function stepCommands(
  step: Pick<ClaudeStep, "allow_commands" | "id">,
  o: { runDir: string; workdir: string; path?: string; declaredProfile: boolean; attempt: number },
): StepCommands {
  const sets = step.allow_commands;
  if (!sets?.length) return none();
  if (o.declaredProfile) return none(`    · allow_commands: no extra commands — the run has a declared tool profile`);
  const rules: string[] = [];
  let binDir: string | undefined;
  let logDir: string | undefined;
  let refusalLog: string | undefined;
  let line: string | undefined;
  if (sets.includes("images")) {
    const tools = installedImageTools(o.path, [join(o.runDir, IMAGE_BIN_DIR)]);
    if (tools.length) {
      const stamp = `${step.id.replace(/[^A-Za-z0-9_-]/g, "_")}-${o.attempt}-`;
      mkdirSync(join(o.runDir, IMAGE_BIN_DIR), { recursive: true });
      mkdirSync(join(o.runDir, IMAGE_LOG_DIR), { recursive: true });
      binDir = mkdtempSync(join(o.runDir, IMAGE_BIN_DIR, stamp));
      logDir = mkdtempSync(join(o.runDir, IMAGE_LOG_DIR, stamp));
      refusalLog = join(logDir, "refused.log");
      writeFileSync(refusalLog, "");
      writeImageBin(binDir, { root: realpathSync(o.workdir), log: refusalLog, tools });
      rules.push(...imageToolRules(tools.map((t) => t.name)));
      line = `    · image tools: ${tools.map((t) => t.name).join(", ")}`;
    } else {
      line = "    · image tools: none installed";
    }
  }
  if (sets.includes("project_scripts")) rules.push(...projectScriptRules(o.workdir));
  return {
    rules,
    binDir,
    logDir,
    refusalLog,
    log: line,
    cleanup() {
      if (binDir) removeDir(binDir);
      if (logDir) removeDir(logDir);
    },
  };
}

/** A line cleaned for a reason or a log: one line, no control characters, at most `max` characters. */
function clean(s: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** The most the refusal log is read for (the agent can write it, so it is never read whole). */
const MAX_REFUSAL_LOG_BYTES = 8192;

/**
 * The refusals the image gate wrote (at most 5, cleaned), as `Bash: <command>` like the permission denials.
 * The agent can write this file, so it is opened without following a symlink, must be a regular file, and only its start is read.
 */
export function readGateRefusals(logPath: string | undefined): string[] {
  if (!logPath) return [];
  let fd: number | undefined;
  try {
    fd = openSync(logPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile()) return [];
    const buf = Buffer.alloc(Math.min(st.size, MAX_REFUSAL_LOG_BYTES));
    const n = readSync(fd, buf, 0, buf.length, 0);
    const parts = buf.subarray(0, n).toString("utf8").split("\n");
    // a file longer than the read ends in a cut line: that one is left out
    if (st.size > n) parts.pop();
    const lines = parts.map((l) => clean(l, 80)).filter(Boolean);
    return [...new Set(lines)].slice(0, 5).map((l) => `Bash: ${l}`);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The program of a `Bash: <command>` denial (leading VAR=x words skipped), or undefined for another tool. */
export function deniedProgram(denial: string): string | undefined {
  const m = /^Bash: (.*)$/.exec(denial);
  if (!m) return undefined;
  const word = m[1]!.trim().split(/\s+/).find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  return word ? basename(word) : undefined;
}

/** The command a step needs and was refused, or undefined. */
export function refusedCommand(o: { output: string; denied?: string[]; earlierDenied?: string[] }): string | undefined {
  const marker = MARKER.exec(o.output)?.[1]?.replace(/`/g, "");
  const named = marker === undefined ? "" : clean(marker, 120);
  if (named && !/^<the command>$/i.test(named)) return named;
  const denied = o.denied ?? [];
  const image = denied.find((d) => (IMAGE_TOOLS as readonly string[]).includes(deniedProgram(d) ?? ""));
  if (image) return clean(image.replace(/^Bash: /, ""), 120);
  const earlier = new Set((o.earlierDenied ?? []).map(deniedProgram).filter(Boolean));
  const again = denied.find((d) => earlier.has(deniedProgram(d)));
  return again ? clean(again.replace(/^Bash: /, ""), 120) : undefined;
}

export function refusedCommandReason(stepId: string, command: string): string {
  return `step "${stepId}" needs a command that is not allowed: ${clean(command, 120)}. Install the tool or allow the command in the flow, then resume the run.`;
}

/**
 * A step with `allow_commands` that still needed a refused command does not count as done, even when it answered "ok".
 * Returns the result unchanged, or a failed result with `refusedCommand` set (the loop stops the run there).
 */
export function refusedCommandStop(step: ClaudeStep, scope: Pick<Scope, "prefix">, engine: Pick<Engine, "summary" | "log" | "signal">, res: StepResult): StepResult {
  if (!step.allow_commands?.length || res.limited || res.held || engine.signal?.aborted) return res;
  if (/timed out/i.test(res.error ?? "")) return res;
  const id = scope.prefix + step.id;
  const earlier = [...(engine.summary.history ?? [])].reverse().find((h) => h.id === id);
  const command = refusedCommand({ output: res.output, denied: res.denied, earlierDenied: earlier?.denied });
  if (!command) return res;
  const reason = refusedCommandReason(step.id, command);
  engine.log(`    ! ${reason}`);
  return { ...res, ok: false, error: reason, refusedCommand: command };
}
