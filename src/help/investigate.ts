import type { Target } from "../agents/targets.js";
import type { Config } from "../config.js";
import type { ClaudeRunResult } from "../steps/claude.js";
import type { Investigation, StopReason } from "./contract.js";
import { GuardError, guardExcerpt, type GuardOptions } from "./guard.js";
import { NOTE_MAX, REFUSED_WORDS, parseToolCall, type ToolName, type ToolRunner } from "./tools.js";
import type { FailureCode } from "./store.js";
// types only: turn.ts imports this module, so everything it needs of turn.ts at run time comes in through `LoopDeps`
import type { Asker, Prepared, Source } from "./turn.js";

/**
 * The loop of an answer that looks things up: model call, look-up, model call, until the model answers. Every call is
 * the same call without tools as a turn that looks nothing up; between two calls the server may carry out one read-only
 * look-up from its fixed list. The loop is bound by the limits of one question (`help.investigate`) and, before every
 * call, by the daily budgets. A stop or a pause ends it: no further call, no further look-up, nothing accepted.
 */

/** Whether a turn is a loop: the setting is on and the server has look-ups to offer. */
export const investigating = (config: Config, tools: ToolRunner | undefined): tools is ToolRunner => config.help.investigate.enabled && tools !== undefined;

/** A call that may still ask for a look-up gets at least this much of the time of the question. */
export const MIN_CALL_MS = 5000;

export interface ToolLogEntry {
  round: number;
  tool: ToolName | "refused";
  /** A short note, guarded and cut. The text of what was found is among the excerpts, not here. */
  result: string;
  /** The ids of the sources this look-up added that a reply may cite. */
  sources: string[];
}

/** What the prompt of one call of the loop says about look-ups: `list` (how many are left) or `stop` (answer now). */
export interface PromptTools {
  list?: number;
  stop?: StopReason;
  log: readonly ToolLogEntry[];
}

export interface CallCaps {
  maxBudgetUsd: number | undefined;
  timeoutMs: number;
}

export type LoopEnd =
  | { kind: "reply"; raw: unknown; ready: Prepared; investigation: Investigation }
  | { kind: "fail"; code: FailureCode }
  | { kind: "stopped" };

export interface LoopDeps {
  config: Config;
  target: Target;
  asker: Asker;
  /** The sources of the turn before any look-up. */
  base: readonly Source[];
  guard: GuardOptions;
  floorUsd: number;
  prepare: (sources: readonly Source[]) => Prepared;
  prompt: (ready: Prepared, tools: PromptTools) => string;
  /** One model call without tools. It never throws for a failed call, and counts the usage. */
  call: (prompt: string, caps: CallCaps) => Promise<ClaudeRunResult>;
  /** The most the next call may cost by the limit per call and the daily budgets, worked out now; undefined when no cost limit applies. */
  cap: () => number | undefined;
  tools: ToolRunner;
  jsonOf: (output: string) => unknown;
  classify: (r: ClaudeRunResult) => FailureCode;
  now: () => number;
  stopped: () => boolean;
  paused: () => boolean;
  log: (msg: string) => void;
}

const HELD_BACK = "The note of this look-up was held back.";
const CUT = " Some text was cut to fit the read limits.";
const DROPPED = " Some sources were left out: they cannot be cited.";

/** The note of a look-up as it goes into the log: guarded, with what the read limits did to it, and cut. Throws `GuardError`. */
export function logNote(note: string, guard: GuardOptions, cut: boolean, dropped: boolean): string {
  const g = guardExcerpt(note, guard);
  const tail = `${cut ? CUT : ""}${dropped ? DROPPED : ""}`;
  return `${(g.withheld ? HELD_BACK : g.text).slice(0, NOTE_MAX - tail.length)}${tail}`;
}

export async function investigate(d: LoopDeps): Promise<LoopEnd> {
  const limits = d.config.help.investigate;
  const perCallMs = d.config.help.timeout_seconds * 1000;
  const startedAt = d.now();
  let rounds = 0;
  let spent = 0;
  let forced: StopReason | undefined;
  /** What the look-ups found, newest first, one per id. */
  let found: Source[] = [];
  const log: ToolLogEntry[] = [];
  /** A stop or a pause ends the loop: asked right after every call and look-up, and right before every call. */
  const gate = (): LoopEnd | undefined => (d.stopped() ? { kind: "stopped" } : d.paused() ? { kind: "fail", code: "setup" } : undefined);

  try {
    let ready = d.prepare(d.base);
    for (;;) {
      const shared = d.cap();
      // a used-up daily budget ends the question: not even the last call is made
      if (shared !== undefined && shared < d.floorUsd) return { kind: "fail", code: "limit" };
      const timeLeft = limits.max_seconds * 1000 - (d.now() - startedAt);
      const moneyLeft = shared === undefined ? undefined : limits.max_cost_usd - spent;
      const final: StopReason | undefined = forced ?? (rounds >= limits.max_rounds ? "rounds" : timeLeft < MIN_CALL_MS ? "time" : moneyLeft !== undefined && moneyLeft < d.floorUsd ? "cost" : undefined);
      const caps: CallCaps = final
        ? { maxBudgetUsd: shared, timeoutMs: perCallMs }
        : { maxBudgetUsd: shared === undefined ? undefined : Math.min(shared, moneyLeft!), timeoutMs: Math.min(perCallMs, timeLeft) };
      const prompt = d.prompt(ready, final ? { stop: final, log } : { list: limits.max_rounds - rounds, log });

      const before = gate();
      if (before) return before;
      const r = await d.call(prompt, caps);
      // counted at once: a call that fails, and the last one, are part of what the question took
      if (!d.target.free && Number.isFinite(r.costUsd) && r.costUsd! > 0) spent += r.costUsd!;
      const after = gate();
      if (after) return after;
      if (r.error === "cancelled") return { kind: "stopped" };
      if (!r.ok) {
        const code = d.classify(r);
        // only when the limit of the question was the tighter one is there still a last call to make
        if (!final && code === "timeout" && timeLeft < perCallMs) forced = "time";
        else if (!final && code === "limit" && moneyLeft !== undefined && moneyLeft < shared!) forced = "cost";
        else return { kind: "fail", code };
        continue;
      }

      const raw = d.jsonOf(r.output);
      const asked = parseToolCall(raw, d.guard);
      if (asked.kind === "reply") {
        const investigation: Investigation = { rounds, seconds: Math.max(0, Math.round((d.now() - startedAt) / 1000)), costUsd: spent, ...(final ? { stoppedBy: final } : {}) };
        return { kind: "reply", raw, ready, investigation };
      }
      if (final) return { kind: "fail", code: "bad-answer" };
      rounds++;
      if (asked.kind === "refused") {
        log.push({ round: rounds, tool: "refused", result: REFUSED_WORDS[asked.code], sources: [] });
        continue;
      }
      const result = await d.tools(d.asker, asked.call);
      const looked = gate();
      if (looked) return looked;
      // a newer source replaces an older one with the same id, also when the newer one is then held back
      const fresh = new Set(result.sources.map((s) => s.id));
      found = [...result.sources, ...found.filter((s) => !fresh.has(s.id))];
      ready = d.prepare([...found, ...d.base.filter((s) => !found.some((f) => f.id === s.id))]);
      const offered = result.sources.filter((s) => ready.offered.some((o) => o.id === s.id));
      const cut = offered.some((s) => {
        if (!s.excerpt) return false;
        const kept = ready.excerpts.find((e) => e.id === s.id)?.text.length ?? 0;
        return kept < guardExcerpt(s.excerpt, d.guard).text.length;
      });
      log.push({ round: rounds, tool: asked.call.tool, result: logNote(result.note, d.guard, cut, offered.length < result.sources.length), sources: offered.map((s) => s.id) });
    }
  } catch (e) {
    // a check that cannot be done, or anything else that breaks: nothing more is sent and nothing is looked up
    d.log(`help: an investigation was ended (${e instanceof GuardError ? e.message : "it could not go on"})`);
    return d.stopped() ? { kind: "stopped" } : { kind: "fail", code: "setup" };
  }
}
