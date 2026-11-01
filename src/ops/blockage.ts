import { pidAlive, type RunSummary } from "../engine/state.js";

/** Why a story cannot go on: it waits for files another run holds, or for a story it depends on. */
export interface Wait { story: string; on: string; why: "files" | "depends on" }

/** A story is named with its repository ("acme/app#12"): the same number in two repositories is two stories. */
const storyOf = (r: RunSummary) => (r.vars?.issue ? `${r.vars.github_repo ?? ""}#${r.vars.issue}` : r.runId);

/** The newest run of every story. */
export function newestRuns(runs: RunSummary[]): RunSummary[] {
  const newest = new Map<string, RunSummary>();
  for (const r of runs) {
    const k = storyOf(r);
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

/** Which repository a watcher works for, from the runs it started (their source is "watcher <id> …"). */
export function watcherRepos(runs: RunSummary[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of runs) {
    const id = /^watcher (\S+) /.exec(r.source ?? "")?.[1];
    if (id && r.vars?.github_repo) out[id] = r.vars.github_repo;
  }
  return out;
}

/**
 * "… [watcher] #356 waits for #355, #12 (depends on)" lines of the service log. The watcher writes such a line
 * once and not again while it is among its last actions, so a long wait has an old line: lines up to `hours` old
 * count, the last one per story. A later line that shows the story started ("#356 … → run <id>", "→ resuming
 * run") or ended ("#356 → succeeded|failed|stopped|cancelled") ends its wait. `repos`: watcher id → repository;
 * a watcher that is not in it keeps its stories apart under its own id.
 */
export function dependencyWaits(log: string, now: Date, repos: Record<string, string> = {}, hours = 6): Wait[] {
  const last = new Map<string, string[]>();
  for (const line of log.split("\n")) {
    const m = /^(\S+) \[([^\]]+)\] #(\d+)\b(.*)$/.exec(line);
    if (!m) continue;
    const name = (n: string) => `${repos[m[2]!] ?? `[${m[2]}]`}#${n}`;
    const rest = m[4]!;
    const waits = /^ waits for ((?:#\d+(?:, )?)+) \(depends on\)/.exec(rest);
    if (waits) {
      const age = now.getTime() - Date.parse(m[1]!);
      if (age <= hours * 3_600_000) last.set(name(m[3]!), waits[1]!.split(", ").map((o) => name(o.slice(1))));
    } else if (/ → (?:resuming )?run \S+/.test(rest) || /^(?: \(closed\))? → (?:succeeded|failed|stopped|cancelled)\b/.test(rest)) last.delete(name(m[3]!));
  }
  return [...last.entries()].flatMap(([story, on]) => on.map((o) => ({ story, on: o, why: "depends on" as const })));
}

/** Stories that wait for each other in a circle; each circle once, starting at its first story by name. */
export function cycles(waits: Wait[]): string[][] {
  const next = new Map<string, Set<string>>();
  for (const w of waits) (next.get(w.story) ?? next.set(w.story, new Set()).get(w.story)!).add(w.on);
  const found = new Map<string, string[]>();
  const walk = (start: string, at: string, path: string[]) => {
    for (const n of next.get(at) ?? []) {
      if (n === start) found.set([...path].sort().join(" "), path);
      // only through stories after `start`: every circle is found once, from its first story
      else if (n > start && !path.includes(n) && path.length < 50) walk(start, n, [...path, n]);
    }
  };
  for (const s of [...next.keys()].sort()) walk(s, s, [s]);
  return [...found.values()];
}

export interface Blocker { story: string; holdsUp: string[]; state: string; cycle?: true }

/**
 * The stories at the root of the waiting: each holds up others (directly or through a chain) and
 * waits for nothing itself. The one that holds up the most comes first. Stories that wait for each
 * other in a circle have no such root: each circle is listed as one entry, before the others, because
 * it never ends by itself.
 */
export function blockers(waits: Wait[], runs: RunSummary[], now: Date, alive: (pid: unknown) => boolean = pidAlive): Blocker[] {
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
    // "running" with no process behind it: the server or the machine stopped under it
    if (r.status === "running" && !alive(r.pid)) return "interrupted — resume it";
    if (r.status === "running") return `working on ${r.state?.next ?? "a step"}${r.stepStartedAt ? ` for ${Math.round((now.getTime() - Date.parse(r.stepStartedAt)) / 60_000)} minutes` : ""}`;
    if (r.status === "failed") return "failed — needs a look";
    if (r.status === "waiting") return "waits for an answer from you";
    return r.status === "succeeded" ? "finished — the others start at the next check" : "stopped";
  };
  const circles: Blocker[] = cycles(waits).map((c) => {
    const others = new Set<string>();
    for (const s of c) for (const d of all(s)) if (!c.includes(d)) others.add(d);
    return { story: [...c, c[0]!].join(" → "), holdsUp: [...others].sort(), state: "wait for each other — take one of the dependencies away", cycle: true as const };
  });
  const roots = [...dependents.keys()]
    .filter((s) => !waitingOn.has(s))
    .map((s) => ({ story: s, holdsUp: [...all(s)].sort(), state: stateOf(s) }))
    .sort((a, b) => b.holdsUp.length - a.holdsUp.length);
  return [...circles, ...roots];
}

export function blockageReport(list: Blocker[], waits: Wait[], working: number, limit: number, now: Date): string {
  const waiting = new Set(waits.map((w) => w.story)).size;
  const out = ["# What holds work up", "", `${now.toISOString().slice(0, 16).replace("T", " ")} UTC — ${limit < 1 ? `${working} run${working === 1 ? " is" : "s are"} working and no new run may start` : `${working} of ${limit} runs are working`}; ${waiting} stor${waiting === 1 ? "y waits" : "ies wait"} for another.`, ""];
  if (working < limit && waiting) out.push(`**${limit - working} run slot${limit - working === 1 ? " is" : "s are"} empty while stories wait.** The first lines below say what would free them.`, "");
  if (!list.length) return [...out, "Nothing holds other work up.", ""].join("\n");
  out.push("| Story | Holds up | State |", "|---|---|---|");
  for (const b of list.slice(0, 10)) out.push(`| ${b.story} | ${b.cycle && !b.holdsUp.length ? "each other" : `${b.holdsUp.length}: ${b.holdsUp.slice(0, 8).join(", ")}${b.holdsUp.length > 8 ? ", …" : ""}`} | ${b.state} |`);
  return [...out, ""].join("\n");
}
