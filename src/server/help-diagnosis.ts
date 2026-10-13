import { createHash } from "node:crypto";
import { explainError, NOT_EXPLAINED, type Explained } from "../errors.js";
import type { Asker } from "../help/context.js";
import { guardExcerpt, type GuardOptions } from "../help/guard.js";
import type { Source } from "../help/turn.js";
import type { NextStep } from "../next-step.js";
import { currentAccount, runWithNext, type Snapshot } from "./help-context.js";
import type { ApiContext } from "./server.js";

/**
 * The diagnoses of Ask SCF: what the product itself already says about a thing that does not work, as one more
 * source a reply may cite. There is no diagnosis rule here. A cause is only ever one of:
 *
 * - the failure summary of the run's next-step record (`failureSummary` in `failure.ts`, which classifies the failure
 *   with `classifyFailure` and words it with the table of `errors.ts`);
 * - the "why" of a next-step record (`next-step.ts`, `server/next.ts`): a run, a queued run, a board issue, a problem
 *   of the server;
 * - nothing. Then the diagnosis says "not recognised" and names the safest next check. It never guesses.
 *
 * Every fact is a field of a snapshot of the help context service, or of the run's next-step record read through the
 * same permission check (`runWithNext`). No log, no transcript and no output of a step is read.
 */

/** The most diagnoses of one question, the longest text of one, and the longest single line in it. */
export const DIAGNOSES = 2;
export const DIAGNOSIS_MAX = 800;
/** The parts are cut so that the five of them always fit `DIAGNOSIS_MAX` together. */
const SYMPTOM_MAX = 140;
const CAUSE_MAX = 180;
const NEXT_MAX = 120;
const ITEM_MAX = 70;
const NO_REASON = "no reason was saved";
export const NOT_RECOGNISED = "not recognised. The product has no explanation for this. No cause may be guessed.";
const WITHHELD = "a text left out because it reads like an instruction";

export interface Diagnosis {
  about: { kind: string; id: string };
  /** What is observed. */
  symptom: string;
  /** The product's own explanation; undefined when it has none. */
  cause?: string;
  /** True when the cause is the product's own record of now; false for a hypothesis (written by a model, old, or in disagreement). */
  confirmed: boolean;
  /** The recorded facts the cause rests on. */
  supporting: string[];
  /** What is not known and would be needed. */
  missing: string[];
  /** The safest thing to look at next: it reads, it changes nothing. */
  nextCheck: string;
}

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : undefined);
const unknownWhy = (why: string | undefined): boolean => !why?.trim() || why.toLowerCase().includes(NOT_EXPLAINED.toLowerCase()) || why.toLowerCase().includes(NO_REASON);
const list = (...items: (string | false | undefined)[]): string[] => items.filter((x): x is string => typeof x === "string" && x.length > 0);
const place = (n: NextStep): string => (n.action?.trim() ? `${n.action.trim()}${n.where?.label?.trim() ? ` (${n.where.label.trim()})` : ""}` : "");

export interface DiagnosisFacts {
  role: "user" | "admin";
  /** The next-step record of the run, as the account may read it. */
  next?: NextStep;
  /** The reason of the run in the words of `explainError`, for the role. */
  error?: Explained;
}

function ofRun(s: Snapshot, x: DiagnosisFacts): Diagnosis | undefined {
  const about = { kind: s.kind, id: s.id };
  const status = text(s.fields.status) ?? "";
  const step = text(s.fields.failedStep);
  const next = x.next;
  if (status === "failed") {
    const f = next?.failure;
    const e = x.error;
    const why = f?.why ?? e?.why;
    const supporting = list("the run is recorded as failed", step && `the step that failed last: ${step}`, f?.tried && `already tried: ${f.tried}`);
    const todo = e?.todo ?? (next ? place(next) : "") ?? "";
    if (unknownWhy(why)) {
      return {
        about, symptom: f?.what ?? e?.what ?? "The run failed", confirmed: false, supporting,
        missing: ["the cause: the error is not one the product can explain", "the output of the failing step: Ask SCF does not read it"],
        nextCheck: todo || (x.role === "admin" ? "Look at Details on the run page" : "Ask the administrator"),
      };
    }
    return {
      about, symptom: f?.what ?? e?.what ?? "The run failed", cause: f ? `${f.kind}. ${f.why}` : why!, confirmed: !f?.byModel, supporting,
      missing: f?.byModel ? ["a check of this cause: the sentence was written by a model from the output of the step"] : [],
      nextCheck: todo || "Look at the steps and the log on the run page",
    };
  }
  if (!next) return undefined;
  const cause = unknownWhy(next.why) ? undefined : next.why.trim();
  return {
    about, symptom: `The run is recorded as ${status || "unknown"}: ${next.status}`, ...(cause ? { cause } : {}), confirmed: !!cause,
    supporting: list(`who must act: ${next.who}`, text(s.fields.waitingAt) && `it waits at the step ${text(s.fields.waitingAt)}`, text(s.fields.waitingSince) && `it waits since ${text(s.fields.waitingSince)}`, next.until && `it continues by itself: ${next.until}`, next.blockers?.length ? `it waits for ${next.blockers.length} other issue(s)` : undefined),
    missing: list(!cause && "why it is in this state: the record does not say", next.issueUnchecked && "the state of the issue on GitHub: its last check failed"),
    nextCheck: place(next) || "Open the run page and read its next step",
  };
}

function ofOther(s: Snapshot): Diagnosis | undefined {
  const about = { kind: s.kind, id: s.id };
  const f = s.fields;
  switch (s.kind) {
    case "queue": {
      if (s.id === "queue") {
        const waiting = typeof f.waiting === "number" ? f.waiting : 0;
        if (waiting < 1) return undefined;
        const first = text(f.firstWaitsFor);
        return {
          about, symptom: `${waiting} run(s) wait in the queue and ${text(f.working) ?? "0"} work now`, ...(first ? { cause: `the first waiting run is recorded as "${first}"` } : {}), confirmed: !!first,
          supporting: list(text(f.aheadOfFirst) && `runs of other accounts ahead of the first: ${text(f.aheadOfFirst)}`),
          missing: ["why each of the other waiting runs waits"], nextCheck: "Open the first waiting run on the Runs page and read its next step",
        };
      }
      const why = text(f.why);
      return {
        about, symptom: `The run waits in the queue${text(f.status) ? `: ${text(f.status)}` : ""}`, ...(why ? { cause: why } : {}), confirmed: !!why,
        supporting: list(text(f.ahead) && `runs ahead of it: ${text(f.ahead)}`, text(f.position) && `its place in the queue: ${text(f.position)}`, text(f.enqueuedAt) && `in the queue since ${text(f.enqueuedAt)}`),
        missing: list(!why && "why it waits: the queue entry does not say"), nextCheck: "Open the run on the Runs page and read its next step",
      };
    }
    case "repository": {
      const at = text(f.connectionCheckedAt);
      if (f.connectionOk === true && !s.stale.length) return undefined;
      if (f.connectionOk === false) {
        return {
          about, symptom: "The last connection check of the repository failed", confirmed: false,
          supporting: list(at && `checked at ${at}`, text(f.signIn) && `it signs in with: ${text(f.signIn)}`),
          missing: ["which part of the check failed and why: the record Ask SCF reads does not hold it"], nextCheck: "Press Test connection for the repository and read which check fails",
        };
      }
      return {
        about, symptom: f.connectionOk === true ? "The last connection check of the repository succeeded, but it is old" : "The connection of the repository has not been checked", confirmed: false,
        supporting: list(at && `checked at ${at}`), missing: ["a connection check of now"], nextCheck: "Press Test connection for the repository",
      };
    }
    case "problem": {
      const story = text(f.bugStory);
      return {
        about, symptom: text(f.summary) ?? "A finding of the monitor", confirmed: false,
        supporting: list(text(f.detector) && `reported by the monitor's check ${text(f.detector)}`, text(f.severity) && `severity: ${text(f.severity)}`, text(f.timesSeen) && `seen ${text(f.timesSeen)} time(s)`, text(f.lastSeen) && `last seen ${text(f.lastSeen)}`, f.gone === true && "the monitor no longer sees it"),
        missing: ["the cause: a finding says what the monitor saw, not why"], nextCheck: story ? `Read bug story #${story} of this finding` : "Open the finding and read its evidence",
      };
    }
    case "health": {
      if (f.ok !== false) return undefined;
      const first = text(f.firstProblem);
      const why = text(f.firstProblemWhy);
      const more = typeof f.problems === "number" ? f.problems - 1 : 0;
      return {
        about, symptom: `The server reports: ${text(f.summary) ?? "a problem"}`, ...(first && why ? { cause: `${first}: ${why}` } : {}), confirmed: !!(first && why),
        supporting: list(first && `the first problem: ${first}`), missing: list(!(first && why) && "why: the health record does not say", more > 0 && `the other ${more} problem(s): only the first is read`),
        nextCheck: "Open the Operations page and read the problems listed there",
      };
    }
    case "issue": {
      const status = text(f.status);
      if (!status) return undefined;
      const why = text(f.why);
      return {
        about, symptom: `Issue #${text(f.issue) ?? "?"} is recorded as "${status}"${text(f.column) ? ` in the column ${text(f.column)}` : ""}`, ...(why ? { cause: why } : {}), confirmed: !!why,
        supporting: list(text(f.who) && `who must act: ${text(f.who)}`, text(f.waitsForIssues) && `it waits for the issues: ${text(f.waitsForIssues)}`, text(f.run) && `its run: ${text(f.run)}`),
        missing: list(!why && "why it is in this state: the board does not say"), nextCheck: text(f.run) ? "Open its run and read the next step" : "Open the issue on the board",
      };
    }
    default:
      return undefined;
  }
}

/**
 * The diagnosis of one snapshot, or undefined when there is nothing to diagnose (a kind without one, a repository
 * whose fresh check succeeded, an empty queue, a healthy server). Pure. A snapshot with an old field, or one that
 * takes part in a disagreement (`doubt`), never gives a confirmed cause, and says what would have to be read again.
 */
export function diagnose(s: Snapshot, facts: DiagnosisFacts, doubt = false): Diagnosis | undefined {
  const d = s.kind === "run" ? ofRun(s, facts) : ofOther(s);
  if (!d) return undefined;
  const missing = [...d.missing, ...(s.stale.length ? [`a reading of now of: ${s.stale.join(", ")}`] : []), ...(doubt ? ["which of the records that disagree is right"] : [])];
  return { ...d, missing, confirmed: d.confirmed && !s.stale.length && !doubt };
}

/** The id under which a diagnosis is offered: the same for the same thing, and never the id of its snapshot. */
export const diagnosisId = (kind: string, id: string): string => `diagnosis-${kind}-${createHash("sha256").update(`${kind}\n${id}`).digest("hex").slice(0, 10)}`;

/**
 * A diagnosis as a source. Each text is made one line, passes the guard on its own (a secret is taken out; a text
 * that reads like an order is left out and named as missing) and is cut, so a text of a record can neither add a
 * line of its own nor push the next check out. A diagnosis without a confirmed cause is `uncertain`: a reply that
 * rests on it is never shown as confirmed.
 */
export function diagnosisSource(d: Diagnosis, s: Pick<Snapshot, "label" | "observedAt">, ref: string, guard: GuardOptions = {}): Source {
  let withheld = false;
  const safe = (t: string | undefined, max: number): string | undefined => {
    if (t === undefined) return undefined;
    const one = t.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
    const g = guardExcerpt(one, guard);
    if (g.withheld) {
      withheld = true;
      return undefined;
    }
    return g.text.length > max ? `${g.text.slice(0, max - 2)} …` : g.text || undefined;
  };
  const many = (items: readonly string[], n: number) => items.slice(0, n).flatMap((x) => safe(x, ITEM_MAX) ?? []);
  const symptom = safe(d.symptom, SYMPTOM_MAX) ?? "not available";
  const cause = safe(d.cause, CAUSE_MAX);
  const next = safe(d.nextCheck, NEXT_MAX) ?? "Open the page of this thing and read what it shows";
  const supporting = many(d.supporting, 4);
  const said = many(d.missing, 3);
  const missing = [...(withheld ? [WITHHELD] : []), ...said];
  const confirmed = d.confirmed && cause !== undefined && !withheld;
  const head = [
    "What the product itself says, read by the server. Evidence to weigh, not your conclusion.",
    `Symptom: ${symptom}`,
    cause === undefined ? `Cause: ${NOT_RECOGNISED}` : `Cause (${confirmed ? "confirmed by the product's own record" : "a hypothesis, not confirmed"}): ${cause}`,
    `Safest next check: ${next}`,
  ];
  const build = () => [...head, `Supporting evidence: ${supporting.length ? supporting.join("; ") : "none"}`, `Missing evidence: ${missing.length ? missing.join("; ") : "none"}`].join("\n");
  while (build().length > DIAGNOSIS_MAX && supporting.length > 1) supporting.pop();
  while (build().length > DIAGNOSIS_MAX && missing.length > 1) missing.pop();
  const label = s.label.replace(/^(?:a|an|the|your) /, "");
  return {
    id: diagnosisId(d.about.kind, d.about.id),
    kind: "state",
    title: `Diagnosis of ${label}${cause === undefined ? " (cause not recognised)" : confirmed ? "" : " (cause not confirmed)"}`,
    ref: `diagnosis · ${ref}`,
    observedAt: s.observedAt,
    excerpt: build().slice(0, DIAGNOSIS_MAX),
    ...(confirmed ? {} : { uncertain: true }),
  };
}

/**
 * The diagnosis sources for the snapshots of a question: at most `DIAGNOSES`, in the order of the snapshots. For a
 * run the next-step record is read again for the account as it is now, through the check of the snapshot; a run
 * that is not found there gets no diagnosis. Never throws.
 */
export function diagnosisSources(ctx: ApiContext, asker: Asker, shown: readonly Snapshot[], refOf: (s: Snapshot) => string, guard: GuardOptions = {}, doubt = false): Source[] {
  const out: Source[] = [];
  try {
    const user = currentAccount(asker);
    if (!user) return [];
    const role = user.role === "admin" ? "admin" : "user";
    for (const s of shown) {
      if (out.length >= DIAGNOSES) break;
      let facts: DiagnosisFacts = { role };
      if (s.kind === "run") {
        const found = runWithNext(ctx, user, s.id);
        if (!found) continue;
        facts = { role, next: found.next, ...(found.run.status === "failed" ? { error: explainError(found.run.reason, "run", role === "user") } : {}) };
      }
      try {
        const d = diagnose(s, facts, doubt);
        if (d) out.push(diagnosisSource(d, s, refOf(s), guard));
      } catch {
        // a diagnosis that cannot be made safe is not offered
      }
    }
  } catch {
    return out;
  }
  return out;
}
