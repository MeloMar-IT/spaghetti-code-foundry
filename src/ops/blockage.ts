import type { RunSummary } from "../engine/state.js";

/** Why a story cannot go on: it waits for files another run holds, or for a story it depends on. */
export interface Wait { story: string; on: string; why: "files" | "depends on" }

const storyOf = (r: RunSummary) => (r.vars?.issue ? `#${r.vars.issue}` : r.runId);

/** The newest run of every story. */
export function newestRuns(runs: RunSummary[]): RunSummary[] {
  const newest = new Map<string, RunSummary>();
  for (const r of runs) {
    const k = `${r.vars?.github_repo ?? ""}${storyOf(r)}`;
    if (!newest.has(k) || r.startedAt > newest.get(k)!.startedAt) newest.set(k, r);
  }
  return [...newest.values()];
}

/** Stories that stepped aside because another run holds their files. */
export function fileWaits(runs: RunSummary[]): Wait[] {
  const byId = new Map(runs.map((r) => [r.runId, r]));
  return newestRuns(runs).flatMap((r) => {
    const last = r.history?.at(-1);
    const holder = r.status === "stopped" && last?.id === "wait_for_area" ? /waiting for run (\S+)/.exec(last.output)?.[1] : undefined;
    const h = holder ? byId.get(holder) : undefined;
    return h ? [{ story: storyOf(r), on: storyOf(h), why: "files" as const }] : [];
  });
}

/** "… [scf] #356 waits for #355, #12 (depends on)" lines of the service log, the last one per story within `minutes`. */
export function dependencyWaits(log: string, now: Date, minutes = 20): Wait[] {
  const last = new Map<string, string[]>();
  for (const line of log.split("\n")) {
    const m = /^(\S+) \[[^\]]+\] (#\d+) waits for ((?:#\d+(?:, )?)+) \(depends on\)/.exec(line);
    if (m && now.getTime() - Date.parse(m[1]!) <= minutes * 60_000) last.set(m[2]!, m[3]!.split(", "));
  }
  return [...last.entries()].flatMap(([story, on]) => on.map((o) => ({ story, on: o, why: "depends on" as const })));
}

export interface Blocker { story: string; holdsUp: string[]; state: string }

/**
 * The stories at the root of the waiting: each holds up others (directly or through a chain) and
 * waits for nothing itself. The one that holds up the most comes first.
 */
export function blockers(waits: Wait[], runs: RunSummary[], now: Date): Blocker[] {
  const waitingOn = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();
  for (const w of waits) {
    (waitingOn.get(w.story) ?? waitingOn.set(w.story, new Set()).get(w.story)!).add(w.on);
    (dependents.get(w.on) ?? dependents.set(w.on, new Set()).get(w.on)!).add(w.story);
  }
  const all = (story: string, seen = new Set<string>()): Set<string> => {
    for (const d of dependents.get(story) ?? []) if (!seen.has(d)) all(d, seen.add(d));
    return seen;
  };
  const newest = new Map(newestRuns(runs).map((r) => [storyOf(r), r]));
  const stateOf = (story: string) => {
    const r = newest.get(story);
    if (!r) return "not started";
    if (r.status === "running") return `working on ${r.state?.next ?? "a step"}${r.stepStartedAt ? ` for ${Math.round((now.getTime() - Date.parse(r.stepStartedAt)) / 60_000)} minutes` : ""}`;
    if (r.status === "failed") return "failed — needs a look";
    if (r.status === "waiting") return "waits for an answer from you";
    return r.status === "succeeded" ? "finished — the others start at the next check" : "stopped";
  };
  return [...dependents.keys()]
    .filter((s) => !waitingOn.has(s))
    .map((s) => ({ story: s, holdsUp: [...all(s)].sort(), state: stateOf(s) }))
    .sort((a, b) => b.holdsUp.length - a.holdsUp.length);
}

export function blockageReport(list: Blocker[], waits: Wait[], working: number, limit: number, now: Date): string {
  const waiting = new Set(waits.map((w) => w.story)).size;
  const out = ["# What holds work up", "", `${now.toISOString().slice(0, 16).replace("T", " ")} UTC — ${working} of ${limit} runs are working; ${waiting} stor${waiting === 1 ? "y waits" : "ies wait"} for another.`, ""];
  if (working < limit && waiting) out.push(`**${limit - working} run slot${limit - working === 1 ? " is" : "s are"} empty while stories wait.** The first lines below say what would free them.`, "");
  if (!list.length) return [...out, "Nothing holds other work up.", ""].join("\n");
  out.push("| Story | Holds up | State |", "|---|---|---|");
  for (const b of list.slice(0, 10)) out.push(`| ${b.story} | ${b.holdsUp.length}: ${b.holdsUp.slice(0, 8).join(", ")}${b.holdsUp.length > 8 ? ", …" : ""} | ${b.state} |`);
  return [...out, ""].join("\n");
}
