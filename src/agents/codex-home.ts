import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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
