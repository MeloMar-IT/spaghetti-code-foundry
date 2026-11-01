import { pidAlive, type RunSummary } from "../engine/state.js";
import { retriesOf, retryOutcome } from "../engine/auto-retry.js";
import { newestRuns, storyOf } from "./blockage.js";

export interface DigestFacts {
  done: string[];
  split: string[];
  failed: string[];
  waiting: string[];
  working: number;
  /** Runs that still say "running" although their process is gone (the server or the machine stopped under them). */
  interrupted: string[];
  /** Extra sections from the other helpers: a heading and a few lines each. */
  extra: { title: string; lines: string[] }[];
  /** Automatic retries after a time limit, by story. Only present when there is something to report. */
  retries?: RetryFacts;
}

export interface RetryFacts { stories: number; retries: number; finished: number; split: number; failed: number; open: number }

const titleOf = (r: RunSummary) => {
  const ticket = (r.state?.steps as Record<string, { output?: string }> | undefined)?.pull_ticket?.output ?? "";
  const m = /^# (#\d+: .+)$/m.exec(ticket);
  return (m ? m[1]! : r.vars?.issue ? `#${r.vars.issue}` : r.task?.split("\n")[0] ?? r.runId).slice(0, 110);
};

const endedAt = (r: RunSummary) => Date.parse(r.finishedAt ?? r.history?.at(-1)?.startedAt ?? r.startedAt);

/**
 * Automatic retries by story. The newest run gives the outcome. Its own retries count, and the retries of older runs of the
 * story count only when those runs ended in the window (as the digest of that time reported them).
 */
function retryFacts(runs: RunSummary[], since: number): RetryFacts | undefined {
  const retried = runs.filter((r) => retriesOf(r));
  const t: RetryFacts = { stories: 0, retries: 0, finished: 0, split: 0, failed: 0, open: 0 };
  for (const r of newestRuns(runs)) {
    const outcome = retryOutcome(r);
    if (outcome !== "open" && endedAt(r) < since) continue;
    const story = storyOf(r);
    const mine = retriesOf(r);
    const older = retried.filter((o) => o.runId !== r.runId && storyOf(o) === story && endedAt(o) >= since);
    const retries = (mine?.started ?? 0) + older.reduce((n, o) => n + retriesOf(o)!.started, 0);
    if (!retries && !mine?.waiting) continue;
    t.stories++;
    t.retries += retries;
    t[outcome === "cancelled" ? "failed" : outcome]++;
  }
  return t.stories ? t : undefined;
}

/** What happened to each story in the last `hours`, from its newest run. */
export function digestFacts(runs: RunSummary[], now: Date, hours = 24, alive: (pid: unknown) => boolean = pidAlive): Omit<DigestFacts, "extra"> {
  const since = now.getTime() - hours * 3_600_000;
  const f = { done: [] as string[], split: [] as string[], failed: [] as string[], waiting: [] as string[], working: 0, interrupted: [] as string[] };
  const stories = runs.filter((r) => r.vars?.issue);
  for (const r of newestRuns(stories)) {
    const ended = endedAt(r);
    if (r.status === "running" && !alive(r.pid)) f.interrupted.push(`${titleOf(r)} — its process is gone; resume it`);
    else if (r.status === "running") f.working++;
    else if (r.status === "waiting") f.waiting.push(`${titleOf(r)} — ${r.waiting?.message?.split("\n")[0]?.slice(0, 120) ?? "waits for your answer"}`);
    else if (ended < since) continue;
    else if (r.status === "failed") f.failed.push(`${titleOf(r)} — ${(r.failureNote?.why ?? r.reason ?? "failed").slice(0, 200)}`);
    else if (r.status === "succeeded") (r.history?.at(-1)?.id === "create_split" ? f.split : f.done).push(titleOf(r));
  }
  const retries = retryFacts(stories, since);
  return retries ? { ...f, retries } : f;
}

export const digestLine = (f: Omit<DigestFacts, "extra">) =>
  `${f.done.length} done, ${f.failed.length} failed, ${f.waiting.length} wait${f.waiting.length === 1 ? "s" : ""} for you, ${f.working} in progress${f.interrupted.length ? `, ${f.interrupted.length} interrupted` : ""}`;

/** The day as people on this machine see it: the digest of the morning is the one of that day, in any time zone. */
export const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const retryLine = (r: RetryFacts) =>
  `${plural(r.stories, "story", "stories")}, ${plural(r.retries, "retry", "retries")}: ${r.finished} finished, ${r.split} split, ${r.failed} failed, ${r.open} still open`;

export function digestReport(f: DigestFacts, now: Date, hours = 24): string {
  const out = [`# Foundry digest ${localDay(now)}`, "", `The last ${hours} hours: ${digestLine(f)}${f.split.length ? `, ${f.split.length} split into smaller stories` : ""}.`, ""];
  const section = (title: string, lines: string[]) => lines.length && out.push(`## ${title}`, "", ...lines.map((l) => `- ${l}`), "");
  section("Waits for you", f.waiting);
  section("Interrupted", f.interrupted);
  section("Failed", f.failed);
  section("Done", f.done);
  section("Split into smaller stories", f.split);
  if (f.retries) section("Automatic retries after a time limit", [retryLine(f.retries)]);
  for (const e of f.extra) if (e.lines.length) out.push(`## ${e.title}`, "", ...e.lines.map((l) => `- ${l}`), "");
  return out.join("\n");
}
