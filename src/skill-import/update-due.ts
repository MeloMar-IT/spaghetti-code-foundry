import { resolve } from "node:path";
import { StoreError } from "../auth/store.js";
import { SOURCES_FILE, sourcesFromBytes, type SkillLibrarySource } from "../skills/sources.js";
import { UPDATE_CHECK_OUTCOMES, UPDATE_CHECKS_FILE, isDue, readUpdateChecks, recordUpdateCheck, type UpdateCheckOutcome } from "../skills/update-schedule.js";
import { CatalogueError, defaultBranch, fetchBase, originRepo, readBlob, showPrefix, type CatalogueContext } from "./catalogue-git.js";
import type { SkillUpdateOptions, updateSource } from "./update-cli.js";
import { Interrupted, NOTHING, catalogueSentence, tickFor } from "./update-common.js";

// `scf skills update --due [--all]`: checks every enabled source whose cadence is due, one after the other, with the same code
// as `scf skills update <id>`. The list of sources is read from origin/<base>, never from the working copy. One failing source
// does not stop the others. The time and outcome of each finished check are kept in the data folder.

/**
 * Prints the lines of every due source and a summary. Exit code: 1 when a source gave PROBLEM or the run was interrupted.
 * `onChecked` is called after each source's check (before the abort check), for the server's sweeper.
 */
export async function updateDue(
  o: { all: boolean; onChecked?: (id: string, outcome: UpdateCheckOutcome) => void },
  out: (line: string) => void,
  opts: SkillUpdateOptions,
  signal: AbortSignal,
  check: typeof updateSource,
): Promise<number> {
  const problem = (text: string): number => {
    out(`PROBLEM ${text}`);
    return 1;
  };
  const today = (opts.now ?? new Date()).toISOString().slice(0, 10);
  const ctx: CatalogueContext = { cwd: resolve(opts.cwd ?? process.cwd()), env: opts.env ?? process.env };
  const tick = tickFor(signal);

  let manifest: SkillLibrarySource[];
  try {
    const prefix = showPrefix(ctx);
    await tick();
    if (originRepo(ctx) === undefined) return problem("the address of origin is not a GitHub repository address; the pull request needs it");
    await tick();
    const base = defaultBranch(ctx);
    const baseCommit = fetchBase(ctx, base);
    await tick();
    const blob = readBlob(ctx, baseCommit, prefix + SOURCES_FILE);
    await tick();
    if (blob === undefined) return problem(`${SOURCES_FILE} is not on origin/${base}; ${NOTHING}`);
    const read = sourcesFromBytes(blob.content, today);
    if (read.state === "invalid") {
      for (const p of read.problems) out(`PROBLEM ${p.where}: ${p.message}`);
      return 1;
    }
    manifest = read.state === "ok" ? read.manifest.sources : [];
  } catch (e) {
    if (e instanceof CatalogueError) return problem(catalogueSentence(e.code));
    if (e instanceof Interrupted) return problem(`the update was interrupted; ${NOTHING}`);
    throw e;
  }

  const record = readUpdateChecks({ home: opts.home });
  if (record.state === "none") out(`NOTE ${UPDATE_CHECKS_FILE} is not in the data folder yet; every source counts as never checked`);
  else if (record.state === "unreadable") out(`NOTE ${UPDATE_CHECKS_FILE} in the data folder ${record.reason}; every source counts as never checked`);
  const checks = record.state === "ok" ? record.checks : {};

  const enabled = manifest.filter((s) => s.status === "enabled");
  const selected: SkillLibrarySource[] = [];
  let manual = 0;
  let notDue = 0;
  for (const s of enabled) {
    if (o.all) selected.push(s);
    else if (s.update.cadence === "manual") manual++;
    else if (isDue(s.update.cadence, checks[s.id], opts.now ?? new Date())) selected.push(s);
    else notDue++;
  }

  const counts = Object.fromEntries(UPDATE_CHECK_OUTCOMES.map((k) => [k, 0])) as Record<UpdateCheckOutcome, number>;
  const keep = new Set(manifest.map((s) => s.id));
  let checked = 0;
  let writeNote = false;
  let interrupted = false;
  for (const s of selected) {
    const at = opts.now ?? new Date();
    const line = (text: string) => out(`${s.id}: ${text}`);
    let outcome: UpdateCheckOutcome;
    try {
      outcome = await check(s.id, {}, line, opts, signal, { sources: manifest });
    } catch {
      line(`PROBLEM the check failed unexpectedly; ${NOTHING}`);
      outcome = "PROBLEM";
    }
    checked++;
    counts[outcome]++;
    o.onChecked?.(s.id, outcome);
    if (signal.aborted) {
      interrupted = true;
      break;
    }
    try {
      recordUpdateCheck(s.id, outcome, at, { home: opts.home, keep });
    } catch (e) {
      if (!(e instanceof StoreError)) throw e;
      if (!writeNote) out(`NOTE ${UPDATE_CHECKS_FILE} could not be written to the data folder; the next run may check the same sources again`);
      writeNote = true;
    }
  }

  const parts = UPDATE_CHECK_OUTCOMES.map((k) => `${counts[k]} ${k}`).join(", ");
  out(
    `CHECKED ${checked} sources: ${parts}` +
      (notDue > 0 ? `; ${notDue} not due` : "") +
      (manual > 0 ? `; ${manual} manual` : "") +
      (interrupted ? `; interrupted, ${selected.length - checked} not checked` : ""),
  );
  return counts.PROBLEM > 0 || interrupted ? 1 : 0;
}
