import { DAY_TEXT, dayWindow } from "./build.js";
import { buildShareReport, defaultShareDeps, sharingAccounts, type ShareDeps } from "./sources.js";

export const METRICS_USAGE = `usage: scf metrics preview [--day YYYY-MM-DD]   Print the shared metrics report of one UTC day (default yesterday); nothing is sent`;
export const PREVIEW_NOTE = "preview only: nothing was sent";

/** Yesterday (UTC) as YYYY-MM-DD. */
export const yesterday = (now: Date): string => new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);

export interface MetricsOptions {
  day?: string;
  runsDir: string;
  now?: Date;
  /** For tests: replace what is read. */
  deps?: ShareDeps;
  accounts?: () => string[];
}

/** `scf metrics preview [--day YYYY-MM-DD]`. Prints the report as JSON through `out` and a note through `note`. Read-only. */
export async function metricsCommand(positionals: string[], opts: MetricsOptions, out: (line: string) => void, note: (line: string) => void): Promise<number> {
  const [sub, ...rest] = positionals;
  if (sub !== "preview" || rest.length) throw new Error(METRICS_USAGE);
  const day = opts.day ?? yesterday(opts.now ?? new Date());
  try {
    dayWindow(day);
  } catch {
    throw new Error(`${DAY_TEXT}\n${METRICS_USAGE}`);
  }
  const report = await buildShareReport(day, (opts.accounts ?? sharingAccounts)(), opts.deps ?? defaultShareDeps(opts.runsDir));
  out(JSON.stringify(report, null, 2));
  note(PREVIEW_NOTE);
  return 0;
}
