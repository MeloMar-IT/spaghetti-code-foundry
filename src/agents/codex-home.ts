import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ownDir } from "../engine/os-sandbox.js";

export const CODEX_HOME_UNKNOWN = "the Codex folder of that session is not known (it ran before this version)";
export const CODEX_HOME_CHANGED = "it ran in another Codex folder (the sandbox, the isolation mode or CODEX_HOME changed)";

/** Which Codex folder a session used: "run" (the run's own folder) or "personal:<12 hex>" (a fingerprint of the path, never the path). */
export function codexHomeId(o: { run: boolean; codexHome?: string; home?: string }): string {
  if (o.run) return "run";
  const dir = resolve(o.codexHome || join(o.home ?? homedir(), ".codex"));
  return "personal:" + createHash("sha256").update(dir).digest("hex").slice(0, 12);
}

/** Why a step must not resume a session recorded with `recorded`; undefined when it may. */
export function codexResumeRefusal(recorded: unknown, now: string): string | undefined {
  if (typeof recorded !== "string" || recorded === "") return CODEX_HOME_UNKNOWN;
  return recorded === now ? undefined : CODEX_HOME_CHANGED;
}

export type CodexIsolation = "off" | "private" | "ignore-config" | "unsupported";

/** off: not isolated. private: a local model or a key, so the run's own Codex folder works. ignore-config: a Codex login, which lives in CODEX_HOME and must stay. */
export function codexIsolationMode(o: { isolate: boolean; local: boolean; hasKey: boolean }): "off" | "private" | "ignore-config" {
  if (!o.isolate) return "off";
  return o.local || o.hasKey ? "private" : "ignore-config";
}

export const CODEX_HOME_REFUSED = "Codex isolation: ";

/** Makes <runDir>/home and <runDir>/home/.codex (0700, a symlink at the path is replaced). */
export function privateCodexHome(runDir: string, make: (path: string) => void = ownDir): { CODEX_HOME: string } | { refused: string } {
  const home = join(runDir, "home");
  const dir = join(home, ".codex");
  try {
    make(home);
    make(dir);
  } catch {
    return { refused: CODEX_HOME_REFUSED + "the private Codex folder could not be made" };
  }
  return { CODEX_HOME: dir };
}

/** The log line of a mode; undefined for "off". */
export function codexIsolationLine(mode: CodexIsolation): string | undefined {
  switch (mode) {
    case "private": return "Codex: a private Codex folder for this run (no personal config, skills, AGENTS.md or command rules)";
    case "ignore-config": return "Codex: --ignore-user-config (personal config.toml and MCP servers are skipped; personal skills, AGENTS.md and command rules still apply)";
    case "unsupported": return "Codex: this CLI has no --ignore-user-config; the personal Codex setup is not isolated";
    default: return undefined;
  }
}
