import type { RunSummary } from "../engine/state.js";
import { newestRuns } from "./blockage.js";

export interface DigestFacts {
  done: string[];
  split: string[];
  failed: string[];
  waiting: string[];
  working: number;
  /** Extra sections from the other helpers: a heading and a few lines each. */
  extra: { title: string; lines: string[] }[];
}

const titleOf = (r: RunSummary) => {
  const ticket = (r.state?.steps as Record<string, { output?: string }> | undefined)?.pull_ticket?.output ?? "";
  const m = /^# (#\d+: .+)$/m.exec(ticket);
  return (m ? m[1]! : r.vars?.issue ? `#${r.vars.issue}` : r.task?.split("\n")[0] ?? r.runId).slice(0, 110);
};

/** What happened to each story in the last `hours`, from its newest run. */
export function digestFacts(runs: RunSummary[], now: Date, hours = 24): Omit<DigestFacts, "extra"> {
  const since = now.getTime() - hours * 3_600_000;
  const f = { done: [] as string[], split: [] as string[], failed: [] as string[], waiting: [] as string[], working: 0 };
  for (const r of newestRuns(runs.filter((r) => r.vars?.issue))) {
    const ended = Date.parse(r.finishedAt ?? r.history?.at(-1)?.startedAt ?? r.startedAt);
    if (r.status === "running") f.working++;
    else if (r.status === "waiting") f.waiting.push(`${titleOf(r)} — ${r.waiting?.message?.split("\n")[0]?.slice(0, 120) ?? "waits for your answer"}`);
    else if (ended < since) continue;
    else if (r.status === "failed") f.failed.push(`${titleOf(r)} — ${(r.failureNote?.why ?? r.reason ?? "failed").slice(0, 200)}`);
    else if (r.status === "succeeded") (r.history?.at(-1)?.id === "create_split" ? f.split : f.done).push(titleOf(r));
  }
  return f;
}

export const digestLine = (f: Omit<DigestFacts, "extra">) =>
  `${f.done.length} done, ${f.failed.length} failed, ${f.waiting.length} wait${f.waiting.length === 1 ? "s" : ""} for you, ${f.working} in progress`;

export function digestReport(f: DigestFacts, now: Date, hours = 24): string {
  const out = [`# Foundry digest ${now.toISOString().slice(0, 10)}`, "", `The last ${hours} hours: ${digestLine(f)}${f.split.length ? `, ${f.split.length} split into smaller stories` : ""}.`, ""];
  const section = (title: string, lines: string[]) => lines.length && out.push(`## ${title}`, "", ...lines.map((l) => `- ${l}`), "");
  section("Waits for you", f.waiting);
  section("Failed", f.failed);
  section("Done", f.done);
  section("Split into smaller stories", f.split);
  for (const e of f.extra) if (e.lines.length) out.push(`## ${e.title}`, "", ...e.lines.map((l) => `- ${l}`), "");
  return out.join("\n");
}
