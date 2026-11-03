import { spawn } from "node:child_process";
import { resolveClaudeBinAsync } from "./steps/claude.js";
import { resolveCodexBin } from "./steps/codex.js";

// The setup check: is what the Foundry needs on this computer, in plain words. The API, `scf doctor` and the page all show this report.
// It only runs fixed programs with fixed arguments (--version, --help, auth status, login status). It never reads a secret.

export type SetupItemId = "git" | "claude" | "claude-sign-in" | "codex" | "codex-sign-in" | "node";
export type SetupState = "ok" | "missing" | "signed-out" | "unknown";
export type ExtraTool = "node";
export const EXTRA_TOOLS: readonly ExtraTool[] = ["node"];

export interface SetupItem {
  id: SetupItemId;
  name: string;
  needed: boolean;
  state: SetupState;
  explain: string;
  command?: string;
  link?: { label: string; url: string };
  version?: string;
}

export interface SetupReport {
  platform: "macos" | "linux" | "windows" | "other";
  items: SetupItem[];
  /** Every needed item is ok. */
  ready: boolean;
  /** Needed items that are missing or signed out. */
  problems: number;
  /** Needed items that could not be checked. */
  unchecked: number;
  checkedAt: string;
}

export interface ProbeResult {
  code: number | null;
  out: string;
  missing: boolean;
}
export type Probe = (cmd: string, args: string[]) => Promise<ProbeResult>;

const MAX_OUT = 64 * 1024;

/** The default probe: no shell, stdin closed, output capped, and a hard time limit (SIGTERM, then SIGKILL after a grace). */
export function createProbe(spawnFn: typeof spawn = spawn, o: { timeoutMs?: number; graceMs?: number } = {}): Probe {
  const timeoutMs = o.timeoutMs ?? 10_000;
  const graceMs = o.graceMs ?? 1000;
  return (cmd, args) =>
    new Promise<ProbeResult>((resolve) => {
      let out = "";
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;
      const child = spawnFn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
      const take = (d: Buffer | string) => {
        if (out.length < MAX_OUT) out = (out + d.toString()).slice(0, MAX_OUT);
      };
      const finish = (r: ProbeResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(limit);
        child.stdout?.off("data", take);
        child.stderr?.off("data", take);
        resolve(r);
      };
      const limit = setTimeout(() => {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), graceMs);
        killTimer.unref?.();
        finish({ code: null, out: out.trim(), missing: false });
      }, timeoutMs);
      child.stdout?.on("data", take);
      child.stderr?.on("data", take);
      child.on("error", (e: NodeJS.ErrnoException) => {
        clearTimeout(killTimer);
        finish({ code: null, out: "", missing: e.code === "ENOENT" });
      });
      child.on("close", (code) => {
        clearTimeout(killTimer);
        finish({ code, out: out.trim(), missing: false });
      });
    });
}

/** Whether this Claude Code lists `auth` in its help (an old one does not, and could take the words as a prompt). */
export function hasAuthCommand(help: ProbeResult): boolean {
  return help.code !== null && !help.missing && /^\s+auth\b/m.test(help.out);
}

export interface SetupCheckOptions {
  probe?: Probe;
  platform?: NodeJS.Platform;
  claudeBin?: string;
  codexBin?: string;
  needs?: ExtraTool[];
  now?: Date;
}

/** `need` values: one string, a list, or comma separated. Throws for a tool that is not on the list. */
export function parseNeeds(v: string | string[] | undefined): ExtraTool[] {
  const parts = (Array.isArray(v) ? v : v === undefined ? [] : [v]).flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
  const out: ExtraTool[] = [];
  for (const p of parts) {
    if (!(EXTRA_TOOLS as readonly string[]).includes(p)) throw new Error(`need must be one of: ${EXTRA_TOOLS.join(", ")}`);
    if (!out.includes(p as ExtraTool)) out.push(p as ExtraTool);
  }
  return out;
}

const platformOf = (p: NodeJS.Platform): SetupReport["platform"] => (p === "darwin" ? "macos" : p === "linux" ? "linux" : p === "win32" ? "windows" : "other");

/** A program name for a terminal: quoted with single quotes when it has characters a shell would read. */
const shellWord = (s: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);
const firstLine = (s: string) => s.split("\n")[0]?.trim() ?? "";

/** ok = it ran; missing = not found or it failed; unknown = it did not answer in time. */
function presence(r: ProbeResult): "ok" | "missing" | "unknown" {
  if (r.missing) return "missing";
  if (r.code === null) return "unknown";
  return r.code === 0 ? "ok" : "missing";
}

export async function setupCheck(o: SetupCheckOptions = {}): Promise<SetupReport> {
  const probe = o.probe ?? createProbe();
  const platform = platformOf(o.platform ?? process.platform);
  const claudeBin =
    o.claudeBin ??
    (await resolveClaudeBinAsync(async () => {
      const r = await probe("claude", ["--version"]);
      return r.code === 0 ? r.out : "";
    }));
  const codexBin = o.codexBin ?? resolveCodexBin();
  const needs = o.needs ?? [];
  const bare = (bin: string, name: string) => (bin === name ? name : shellWord(bin));
  const items: SetupItem[] = [];

  const [git, claude, codex, node] = await Promise.all([
    probe("git", ["--version"]),
    probe(claudeBin, ["--version"]),
    probe(codexBin, ["--version"]),
    needs.includes("node") ? probe("node", ["--version"]) : Promise.resolve(null),
  ]);

  // Git
  {
    const st = presence(git);
    const item: SetupItem = { id: "git", name: "Git", needed: true, state: st, explain: "", version: st === "ok" ? firstLine(git.out) : undefined };
    if (st === "missing") {
      item.explain = "Git is not on this computer. The Foundry uses it to keep every change to your project.";
      if (platform === "macos") {
        item.command = "xcode-select --install";
        item.explain += " A window opens: choose Install.";
      } else if (platform === "linux") item.command = "sudo apt install git";
      item.link = { label: "Download Git", url: "https://git-scm.com/downloads" };
    } else if (st === "unknown") item.explain = "The Foundry could not check whether Git is on this computer.";
    items.push(item);
  }

  // Claude Code and its sign-in
  const claudeState = presence(claude);
  {
    const item: SetupItem = { id: "claude", name: "Claude Code", needed: true, state: claudeState, explain: "", version: claudeState === "ok" ? firstLine(claude.out) : undefined };
    if (claudeState === "missing") {
      item.explain = "Claude Code is not on this computer. It is the AI helper that does the work. Then sign in: type claude in a terminal, then /login.";
      if (platform !== "windows") item.command = "npm install -g @anthropic-ai/claude-code";
      item.link = { label: "How to install Claude Code", url: "https://docs.claude.com/en/docs/claude-code/setup" };
    } else if (claudeState === "unknown") item.explain = "The Foundry could not check whether Claude Code is on this computer.";
    items.push(item);
  }
  if (claudeState === "ok") {
    const command = bare(claudeBin, "claude");
    const item: SetupItem = { id: "claude-sign-in", name: "Claude Code sign-in", needed: true, state: "unknown", explain: "" };
    const help = await probe(claudeBin, ["--help"]);
    // `auth status` only when this Claude Code lists `auth`: an old one could take the words as a prompt.
    if (hasAuthCommand(help)) {
      const s = await probe(claudeBin, ["auth", "status"]);
      if (/"loggedIn"\s*:\s*false/i.test(s.out) || /not (logged|signed) in/i.test(s.out)) item.state = "signed-out";
      else if (s.code === 0) item.state = "ok";
      else if (s.code !== null && /\/login|log in|sign in/i.test(s.out)) item.state = "signed-out";
    }
    if (item.state === "signed-out") {
      item.explain = "Claude Code is not signed in. Type this in a terminal, then type /login and sign in with your Claude account in the window that opens. The Foundry never asks for your password.";
      item.command = command;
    } else if (item.state === "unknown") {
      item.explain = "The Foundry could not check whether Claude Code is signed in. If a run says it is signed out: type this in a terminal, then /login. Then check again, or update Claude Code.";
      item.command = command;
    }
    items.push(item);
  }

  // Codex (only needed for OpenAI models)
  const codexState = presence(codex);
  {
    const item: SetupItem = { id: "codex", name: "Codex", needed: false, state: codexState, explain: "", version: codexState === "ok" ? firstLine(codex.out) : undefined };
    if (codexState === "missing") {
      item.explain = "Codex is not on this computer. You only need it for OpenAI models. Then sign in: codex login.";
      item.command = "npm install -g @openai/codex";
      item.link = { label: "How to install Codex", url: "https://developers.openai.com/codex/cli" };
    } else if (codexState === "unknown") item.explain = "The Foundry could not check whether Codex is on this computer.";
    items.push(item);
  }
  if (codexState === "ok") {
    const l = await probe(codexBin, ["login", "status"]);
    const item: SetupItem = { id: "codex-sign-in", name: "Codex sign-in", needed: false, state: "ok", explain: "" };
    if (l.code === null) item.state = "unknown";
    else if (l.code !== 0 || /not logged in/i.test(l.out)) item.state = "signed-out";
    if (item.state === "signed-out") {
      item.explain = "Codex is not signed in. Type this in a terminal and sign in with your ChatGPT account in the window that opens.";
      item.command = `${bare(codexBin, "codex")} login`;
    } else if (item.state === "unknown") item.explain = "The Foundry could not check whether Codex is signed in.";
    items.push(item);
  }

  // Extra tools that were asked for
  if (node) {
    const st = presence(node);
    const item: SetupItem = { id: "node", name: "Node.js", needed: true, state: st, explain: "", version: st === "ok" ? firstLine(node.out) : undefined };
    if (st === "missing") {
      item.explain = "Node.js is not on this computer. This starter needs it to build and test the website.";
      item.link = { label: "Download Node.js", url: "https://nodejs.org/en/download" };
    } else if (st === "unknown") item.explain = "The Foundry could not check whether Node.js is on this computer.";
    items.push(item);
  }

  const needed = items.filter((i) => i.needed);
  return {
    platform,
    items,
    ready: needed.every((i) => i.state === "ok"),
    problems: needed.filter((i) => i.state === "missing" || i.state === "signed-out").length,
    unchecked: needed.filter((i) => i.state === "unknown").length,
    checkedAt: (o.now ?? new Date()).toISOString(),
  };
}

const running = new Map<string, Promise<SetupReport>>();

/** While a check runs, a second caller with the same needs gets the same answer; a finished answer is never reused. */
export function sharedSetupCheck(o: SetupCheckOptions = {}): Promise<SetupReport> {
  const key = JSON.stringify([[...(o.needs ?? [])].sort(), o.claudeBin ?? "", o.codexBin ?? ""]);
  const have = running.get(key);
  if (have) return have;
  const p = setupCheck(o).finally(() => running.delete(key));
  running.set(key, p);
  return p;
}

export function summaryLine(r: SetupReport): string {
  if (r.ready) return "Everything is ready.";
  const parts: string[] = [];
  if (r.problems) parts.push(`${r.problems} ${r.problems === 1 ? "thing" : "things"} to fix.`);
  if (r.unchecked) parts.push(`${r.unchecked} ${r.unchecked === 1 ? "thing" : "things"} could not be checked. Run \`scf doctor --simple\` again.`);
  return parts.join(" ");
}

export function setupText(r: SetupReport, o: { simple: boolean }): string {
  const lines: string[] = [];
  for (const i of r.items) {
    const mark = i.state === "ok" ? "✔" : i.state === "unknown" ? "?" : "✘";
    const tag = !i.needed && i.state !== "ok" ? " (optional)" : "";
    lines.push(`${mark} ${i.name}${tag}${i.state === "ok" && !o.simple && i.version ? ` (${i.version})` : ""}`);
    if (i.state === "ok") continue;
    lines.push(`    ${i.explain}`);
    if (i.command) lines.push(`    Run: ${i.command}`);
    if (i.link) lines.push(`    Or open: ${i.link.url}`);
  }
  lines.push("", summaryLine(r));
  return lines.join("\n");
}

export async function doctorCommand(
  o: { simple?: boolean; json?: boolean; need?: string[] },
  io: { out: (s: string) => void; err: (s: string) => void },
  check: (needs: ExtraTool[]) => Promise<SetupReport> = (needs) => setupCheck({ needs }),
): Promise<number> {
  let needs: ExtraTool[];
  try {
    needs = parseNeeds(o.need);
  } catch (e) {
    io.err((e as Error).message);
    return 1;
  }
  const report = await check(needs);
  io.out(o.json ? JSON.stringify(report, null, 2) : setupText(report, { simple: !!o.simple }));
  return report.ready ? 0 : 1;
}
