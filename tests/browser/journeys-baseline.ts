// The effort of the five audit tasks: the baseline (old UI, from the table in docs/ui-redesign/measurement.md)
// and what journeys.spec.ts measures in the redesigned UI. tests/ui-redesign-audit.test.ts keeps this file and the
// document in step.

export interface Counts { nav: number; clicks: number; fields: number }
export type TaskId = 1 | 2 | 3 | 4 | 5;

export const TASKS: Record<TaskId, string> = {
  1: "Start work",
  2: "Approve a waiting run",
  3: "Diagnose a failed run",
  4: "Add a repository",
  5: "Refine an idea into a story draft",
};

/** The gate: a task may not take more than this. */
export const BASELINE: Record<TaskId, Counts> = {
  1: { nav: 1, clicks: 2, fields: 1 },
  2: { nav: 1, clicks: 2, fields: 0 },
  3: { nav: 2, clicks: 3, fields: 0 },
  4: { nav: 2, clicks: 5, fields: 2 },
  5: { nav: 3, clicks: 5, fields: 2 },
};

/** What journeys.spec.ts measures (it asserts exact equality, so this stays true). */
export const REDESIGN: Record<TaskId, Counts> = {
  1: { nav: 2, clicks: 3, fields: 1 },
  2: { nav: 1, clicks: 2, fields: 0 },
  3: { nav: 2, clicks: 2, fields: 0 },
  4: { nav: 2, clicks: 4, fields: 2 },
  5: { nav: 3, clicks: 5, fields: 2 },
};

/** Tasks that are above the baseline and have a named follow-up: their case is `test.fixme` with this text. */
export const KNOWN_OVER: Partial<Record<TaskId, string>> = {
  1: 'Start work: 2 / 3 / 1 against a baseline of 1 / 2 / 1 — follow-up issue "UI quality 4c follow-up — Start work takes one more step and click than the baseline"',
};

/** The measures that are above the baseline, e.g. ["nav 2 > 1", "clicks 3 > 2"]; [] when none. */
export function over(counts: Counts, baseline: Counts): string[] {
  const out: string[] = [];
  for (const k of ["nav", "clicks", "fields"] as const) if (counts[k] > baseline[k]) out.push(`${k} ${counts[k]} > ${baseline[k]}`);
  return out;
}

/** "1 / 2 / 1" */
export const effortText = (c: Counts): string => `${c.nav} / ${c.clicks} / ${c.fields}`;
