import type { RunSummary } from "../engine/state.js";

/** Whole-line answers that park a NOT_CODE stop (lower case; straight apostrophe). */
export const PARK_PHRASES: readonly string[] = [
  "keep it open", "keep it open but out of the build queue", "keep it open, but out of the build queue",
  "do not build", "do not build it", "don't build", "don't build it", "dont build", "park it",
];

const PARK_CMD = /^[ \t]*\/park\b/im;

/** `/park` at the start of a line (any stop), or a whole line that is one of PARK_PHRASES (NOT_CODE stops only). */
export function wantsPark(body: string, notCode: boolean): boolean {
  if (PARK_CMD.test(body)) return true;
  if (!notCode) return false;
  for (const line of body.split(/\r?\n/)) {
    if (line.trimStart().startsWith(">")) continue;
    const t = line.trim().toLowerCase().replace(/’/g, "'").replace(/[.!]+$/, "");
    if (t && PARK_PHRASES.includes(t)) return true;
  }
  return false;
}

/** The run stopped, and the last `PLAN_STATUS:` line of its newest `plan` / `revise_plan` history entry is NOT_CODE. */
export function notCodeStop(run: Pick<RunSummary, "status" | "history">): boolean {
  if (run.status !== "stopped" || !Array.isArray(run.history)) return false;
  const entry = [...run.history].reverse().find((h) => ["plan", "revise_plan"].includes(String(h.id).split("/").at(-1) ?? ""));
  if (!entry || typeof entry.output !== "string") return false;
  const all = [...entry.output.matchAll(/^PLAN_STATUS: *([A-Z_]*)/gm)];
  return all.at(-1)?.[1] === "NOT_CODE";
}

/** The comment posted when an issue is parked; its last line is the marker. */
export function parkedComment(label: string, runId?: string): string {
  return [
    "🤖 **Spaghetti Code Foundry** parked this issue: it stays open, but the Foundry does not build it or ask about it.",
    "",
    `To have it built after all, add the \`${label}\` label again.`,
    "",
    runId ? `<!-- claude-factory run=${runId} parked -->` : "<!-- claude-factory parked -->",
  ].join("\n");
}
