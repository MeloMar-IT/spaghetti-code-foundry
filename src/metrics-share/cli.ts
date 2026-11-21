import { loadConfig } from "../config.js";
import { DAY_TEXT, dayWindow } from "./build.js";
import type { PushResult, PushTarget } from "./push.js";
import { MAX_AGE_DAYS, ageDays, dayOf, pushOne, reconcile, type SharingConfig } from "./pusher.js";
import type { ShareReport } from "./report.js";
import { buildShareReport, defaultShareDeps, sharingAccounts, type ShareDeps } from "./sources.js";
import {
  answerText, loadShareState, saveSentReport, saveShareState, shareLockFile, shareSentFile, shareStateFile, withShareLock, type LastAnswer,
} from "./state.js";

export const METRICS_USAGE = `usage: scf metrics preview [--day YYYY-MM-DD]   Print the shared metrics report of one UTC day (default yesterday); nothing is sent
       scf metrics send [--day YYYY-MM-DD]      Send the report of one ended UTC day (default yesterday) to the receiver now`;
export const PREVIEW_NOTE = "preview only: nothing was sent";
export const SEND_NOT_SHARING = "nothing was sent: no account shares its metrics, or an admin does not allow sharing";
export const SEND_NOT_ENDED = "nothing was sent: the day has not ended yet (UTC)";
export const SEND_TOO_OLD = `nothing was sent: the day is more than ${MAX_AGE_DAYS} days old`;
export const SEND_DONE_ALREADY = "nothing was sent: the receiver already accepted this day";
export const SEND_BUSY = "nothing was sent: the server is sending right now; try again in a minute";
export const SEND_BROKEN = "nothing was sent: metrics-share.json in the data folder cannot be read";
export const SEND_NOT_SAVED = "nothing was sent: metrics-share.json in the data folder could not be saved";
export const SEND_UNSAVED_AFTER = "the receiver answered, but metrics-share.json could not be saved: the day is not recorded here";

/** Yesterday (UTC) as YYYY-MM-DD. */
export const yesterday = (now: Date): string => new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);

export interface MetricsOptions {
  day?: string;
  runsDir: string;
  now?: Date;
  /** For tests: replace what is read. */
  deps?: ShareDeps;
  accounts?: () => string[];
  /** For tests: the metrics_sharing settings instead of config.yaml. */
  config?: SharingConfig;
  /** The settings as they are now; read again right before a send. For tests: replace the config.yaml read. */
  reload?: () => SharingConfig;
  stateFile?: string;
  lockFile?: string;
  /** The copy of the last sent report (#888); default metrics-share-last.json in the data folder. */
  sentFile?: string;
  /** For tests: replace the request. */
  send?: (t: PushTarget, report: ShareReport, signal?: AbortSignal) => Promise<PushResult>;
}

/** The line about the last answer of the receiver. */
export const lastAnswerLine = (a: LastAnswer): string =>
  `last answer of the receiver: ${a.at} ${a.request}${a.day ? ` ${a.day}` : ""} ${answerText(a)}`;

/**
 * `scf metrics preview [--day YYYY-MM-DD]` prints the report as JSON through `out` and notes through `note`; read-only.
 * `scf metrics send [--day YYYY-MM-DD]` sends one ended day now; 1 when nothing was accepted.
 */
export async function metricsCommand(positionals: string[], opts: MetricsOptions, out: (line: string) => void, note: (line: string) => void): Promise<number> {
  const [sub, ...rest] = positionals;
  if ((sub !== "preview" && sub !== "send") || rest.length) throw new Error(METRICS_USAGE);
  const now = opts.now ?? new Date();
  const day = opts.day ?? yesterday(now);
  try {
    dayWindow(day);
  } catch {
    throw new Error(`${DAY_TEXT}\n${METRICS_USAGE}`);
  }
  const stateFile = opts.stateFile ?? shareStateFile();
  if (sub === "send") return send(day, now, stateFile, opts, out, note);
  const stored = loadShareState(stateFile).state;
  const deps = opts.deps ?? defaultShareDeps(opts.runsDir);
  const report = await buildShareReport(day, (opts.accounts ?? sharingAccounts)(), { ...deps, ...(deps.install || !stored ? {} : { install: stored.install }) });
  out(JSON.stringify(report, null, 2));
  note(PREVIEW_NOTE);
  if (stored?.last) note(lastAnswerLine(stored.last));
  return 0;
}

async function send(day: string, now: Date, stateFile: string, opts: MetricsOptions, out: (line: string) => void, note: (line: string) => void): Promise<number> {
  const today = dayOf(now);
  if (day >= today) return refuse(note, SEND_NOT_ENDED);
  if (ageDays(day, today) > MAX_AGE_DAYS) return refuse(note, SEND_TOO_OLD);
  const reload = opts.reload ?? (() => loadConfig().metrics_sharing);
  const cfg = opts.config ?? reload();
  // No accounts while sharing is not allowed; the custom accounts list of the tests is read only when it is.
  const accountsOf = (allowed: boolean): string[] => (allowed ? (opts.accounts ? opts.accounts() : sharingAccounts(true)) : []);
  const r = await withLock(opts, cfg, async () => {
    const accounts = accountsOf(cfg.allowed);
    if (!accounts.length) return refuse(note, SEND_NOT_SHARING);
    const loaded = loadShareState(stateFile);
    if (loaded.broken) return refuse(note, SEND_BROKEN);
    const rec = reconcile(loaded.state, true, cfg.endpoint, now);
    if (rec.deferred) return refuse(note, SEND_BUSY);
    const state = rec.state!;
    if (rec.changed && !saveShareState(state, stateFile)) return refuse(note, SEND_NOT_SAVED);
    if (state.days[day]?.accepted) return refuse(note, SEND_DONE_ALREADY);
    const deps = opts.deps ?? defaultShareDeps(opts.runsDir);
    const one = await pushOne(day, state, {
      target: { endpoint: cfg.endpoint, timeoutMs: cfg.timeout_ms, version: deps.foundryVersion() },
      build: (d, install) => buildShareReport(d, accounts, { ...deps, install }),
      // The settings and the accounts are read again right before the send: a change during the build stops it.
      stillActive: () => {
        try {
          const current = reload();
          if (!current.allowed || current.endpoint !== cfg.endpoint) return false;
          const yes = new Set(accountsOf(true));
          return accounts.every((a) => yes.has(a));
        } catch {
          return false;
        }
      },
      save: (s) => saveShareState(s, stateFile),
      keepSent: (rec) => saveSentReport(rec, opts.sentFile ?? shareSentFile()),
      now: () => opts.now ?? new Date(),
      ...(opts.send ? { send: opts.send } : {}),
    });
    if (one.kind === "skipped") return refuse(note, one.why === "accepted" ? SEND_DONE_ALREADY : one.why === "not-saved" ? SEND_NOT_SAVED : SEND_NOT_SHARING);
    if (!one.saved) return refuse(note, `${answerText(one.result)}; ${SEND_UNSAVED_AFTER}`);
    if (one.kind === "accepted") {
      out(`accepted (${one.result.status})`);
      return 0;
    }
    out(`not accepted: ${answerText(one.result)}`);
    return 1;
  });
  return r === "busy" ? refuse(note, SEND_BUSY) : r;
}

const refuse = (note: (line: string) => void, text: string): number => {
  note(text);
  return 1;
};

const withLock = (opts: MetricsOptions, cfg: SharingConfig, fn: () => Promise<number>): Promise<number | "busy"> =>
  withShareLock(fn, { file: opts.lockFile ?? shareLockFile(), staleMs: cfg.timeout_ms + 60_000 });
