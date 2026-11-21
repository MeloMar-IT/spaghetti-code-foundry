import { nextShareDay } from "./pusher.js";
import { NO_INSTALL, type ShareReport } from "./report.js";
import { buildShareReport, type ShareDeps } from "./sources.js";
import type { SentRecord, ShareState } from "./state.js";

// What is shared (#888): the report the next push would send and the last report that was sent, for one caller.
// A user gets a report of their own runs only and never the body of the last report (it holds every sharing account's
// numbers); an admin gets the install's report and the last report. The install id is always zeros: it is the key to this
// install's data at the receiver. Pure apart from what `deps` reads.

export interface PreviewDeps {
  share: ShareDeps;
  /** The accounts that share (an admin's report). */
  accounts(): string[];
  state(): { state?: ShareState; broken: boolean };
  sent(): { sent?: SentRecord; broken: boolean };
  now(): Date;
}

export type SharingAnswerText = "unasked" | "yes" | "no";

export interface LastSent {
  at: string;
  day: string;
  result: "accepted" | "refused" | "unreachable";
  status?: number;
  /** False when a send is known but its copy is not available (sent before this version, or the copy could not be saved). */
  reportKept: boolean;
  /** Only for an admin, and only when the copy is kept. */
  report?: ShareReport;
}

export interface SharePreview {
  scope: "own" | "install";
  allowed: boolean;
  answer: SharingAnswerText;
  next: { day: string; sofar: boolean; report: ShareReport };
  last: LastSent | null;
  lastUnreadable: boolean;
  stateUnreadable: boolean;
}

export interface PreviewCaller {
  id: string;
  admin: boolean;
  allowed: boolean;
  answer: SharingAnswerText;
}

/** The report with the install id replaced by zeros. */
export const masked = (r: ShareReport): ShareReport => ({ ...r, install: NO_INSTALL });

/** The last send the push state knows, when there is no copy: its last answer to a send, else the newest accepted day. */
function lastFromState(state: ShareState | undefined): LastSent | null {
  const l = state?.last;
  if (l && l.request === "send" && l.day && l.result !== "error") {
    return { at: l.at, day: l.day, result: l.result, ...(l.status !== undefined ? { status: l.status } : {}), reportKept: false };
  }
  let best: LastSent | null = null;
  for (const [day, e] of Object.entries(state?.days ?? {})) {
    if (e.accepted && (!best || e.accepted > best.at)) best = { at: e.accepted, day, result: "accepted", reportKept: false };
  }
  return best;
}

/** The day the next push would send, both reports and the last answer. Throws only when the report cannot be built. */
export async function sharePreview(who: PreviewCaller, deps: PreviewDeps): Promise<SharePreview> {
  const loaded = deps.state();
  const now = deps.now();
  const { day, sofar } = nextShareDay(loaded.broken ? undefined : loaded.state, now);
  const accounts = who.admin ? deps.accounts() : [who.id];
  const report = masked(await buildShareReport(day, accounts, { ...deps.share, install: undefined }));
  const sent = deps.sent();
  let last: LastSent | null;
  if (sent.sent) {
    const s = sent.sent;
    last = {
      at: s.at, day: s.day, result: s.result, ...(s.status !== undefined ? { status: s.status } : {}), reportKept: true,
      ...(who.admin ? { report: masked(s.report) } : {}),
    };
  } else {
    last = lastFromState(loaded.state);
  }
  return {
    scope: who.admin ? "install" : "own",
    allowed: who.allowed,
    answer: who.answer,
    next: { day, sofar, report },
    last,
    lastUnreadable: sent.broken,
    stateUnreadable: loaded.broken,
  };
}
