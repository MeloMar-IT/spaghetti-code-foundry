import type { RunSummary } from "./engine/state.js";
import { TERMINAL_RUN_STATUSES, type EvidenceEvent } from "./evidence/schema.js";
import { measureRun } from "./monitor/measures.js";
import { evidenceFiles, MAX_EVIDENCE_BYTES, readEvidenceEvents, SETTLE_MS } from "./monitor/slo-input.js";

// What the outcome measures need to know about one run: a few small facts from its evidence, nothing else.
// `outcomeFactsOf` is pure. `OutcomeFactsCache` reads evidence.jsonl (read-only, bounded, never through a link).

export interface OutcomeFacts {
  runId: string;
  evidence: { stream: boolean; read: boolean; manifest: boolean; incomplete: boolean };
  /** Time of the first run.queued event. */
  queuedAt?: string;
  /** Some policy.decided at boundary "push". */
  pushed: boolean;
  /** The run succeeded and a push decision has an outcome other than "deny". */
  delivered: boolean;
  /** The test of the first step end that has a test of a suite that is not a baseline. */
  firstTest?: "passed" | "failed";
  /** step.denied events with denial kind "policy". */
  policyBlocks: number;
  /** policy.decided events with outcome deny in observe mode. */
  observeDenies: number;
  /** "agent:provider:model", unique and sorted. */
  models: string[];
  /** "id@version", unique and sorted. */
  policies: string[];
  approvals: { decided: number; totalMs: number; maxMs: number };
  resumes: number;
}

const stamp = (t: unknown): number => (typeof t === "string" ? Date.parse(t) : NaN);
const nap = () => new Promise<void>((r) => setImmediate(r));

/** A suite is a baseline when its own name (after the last "/") has the word "baseline" or "pretest" in it. */
function isBaseline(suite: string): boolean {
  const own = suite.slice(suite.lastIndexOf("/") + 1).toLowerCase();
  return own.split(/[_-]/).some((w) => w === "baseline" || w === "pretest");
}

function zeroFacts(runId: string, evidence: OutcomeFacts["evidence"]): OutcomeFacts {
  return { runId, evidence, pushed: false, delivered: false, policyBlocks: 0, observeDenies: 0, models: [], policies: [], approvals: { decided: 0, totalMs: 0, maxMs: 0 }, resumes: 0 };
}

/** The facts of one run from its run.json and its events. Pure; never throws (on an error it gives the zero facts). */
export function outcomeFactsOf(run: RunSummary, events: readonly EvidenceEvent[], evidence: OutcomeFacts["evidence"]): OutcomeFacts {
  const out = zeroFacts(String(run?.runId ?? ""), { ...evidence });
  try {
    const evs: readonly EvidenceEvent[] = Array.isArray(events) ? events.filter((e) => e && typeof e === "object") : [];
    const models = new Set<string>();
    const policies = new Set<string>();
    const addModel = (m: { agent: string; provider: string; model: string } | undefined) => {
      if (m) models.add(`${m.agent}:${m.provider}:${m.model}`);
    };
    let allowedPush = false;
    for (const e of evs) {
      if (e.type === "run.queued") {
        if (out.queuedAt === undefined && Number.isFinite(stamp(e.time))) out.queuedAt = e.time;
      } else if (e.type === "step.routed") {
        addModel(e.model);
      } else if (e.type === "step.completed" || e.type === "step.failed") {
        addModel(e.model);
        if (out.firstTest === undefined && e.test && !isBaseline(e.test.suite)) out.firstTest = e.test.outcome === "passed" ? "passed" : "failed";
      } else if (e.type === "step.denied") {
        if (e.denial.kind === "policy") out.policyBlocks++;
      } else if (e.type === "policy.decided") {
        const d = e.decision;
        policies.add(`${d.policy.id}@${d.policy.version}`);
        if (d.boundary === "push") {
          out.pushed = true;
          if (d.outcome !== "deny") allowedPush = true;
        }
        if (d.outcome === "deny" && d.mode === "observe") out.observeDenies++;
      }
    }
    out.delivered = run.status === "succeeded" && allowedPush;
    out.models = [...models].sort();
    out.policies = [...policies].sort();
    const m = measureRun(run, evs);
    if (m.approvals) out.approvals = { decided: m.approvals.decided, totalMs: m.approvals.totalMs, maxMs: m.approvals.maxMs };
    out.resumes = m.resumes ?? 0;
    return out;
  } catch {
    return zeroFacts(out.runId, { ...evidence });
  }
}

export interface OutcomeFactsCacheOptions {
  /** Finished reads kept (the least recently used one goes first). Default 2000. */
  maxEntries?: number;
  /** An evidence.jsonl above this size is not read. Default MAX_EVIDENCE_BYTES. */
  maxBytes?: number;
  /** For tests: replaces the reader. */
  reader?: typeof readEvidenceEvents;
}

const MAX_ENTRIES = 2000;

/**
 * The facts of settled runs. evidence.jsonl is read at most once per run folder, run id and `updatedAt`; calls that
 * come while a read is running share it. The files that show up later (manifest, incomplete marker, the stream itself)
 * are checked again on every call. The cache keeps the small facts, never the events.
 */
export class OutcomeFactsCache {
  private done = new Map<string, { updatedAt: string; runId: string; facts: OutcomeFacts }>();
  /** Reads in progress, by run folder, run id and updatedAt. Not touched by the eviction of finished entries. */
  private inflight = new Map<string, Promise<OutcomeFacts>>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly reader: typeof readEvidenceEvents;

  constructor(opts: OutcomeFactsCacheOptions = {}) {
    this.maxEntries = Math.max(1, Math.floor(opts.maxEntries ?? MAX_ENTRIES));
    this.maxBytes = opts.maxBytes ?? MAX_EVIDENCE_BYTES;
    this.reader = opts.reader ?? readEvidenceEvents;
  }

  /** undefined: not an object, no runDir, not ended, not settled (now − finishedAt < SETTLE_MS) or no updatedAt. Never throws. */
  async get(run: RunSummary, updatedAt: string | undefined, now: Date): Promise<OutcomeFacts | undefined> {
    try {
      if (!run || typeof run !== "object" || typeof run.runDir !== "string" || !run.runDir || typeof run.runId !== "string") return undefined;
      if (!(TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status)) return undefined;
      const finished = stamp(run.finishedAt);
      if (!Number.isFinite(finished) || now.getTime() - finished < SETTLE_MS || typeof updatedAt !== "string") return undefined;
      const hit = this.done.get(run.runDir);
      let facts: OutcomeFacts;
      if (hit && hit.updatedAt === updatedAt && hit.runId === run.runId) {
        this.done.delete(run.runDir); // most recently used goes last
        this.done.set(run.runDir, hit);
        facts = hit.facts;
      } else {
        const key = `${run.runDir}\0${run.runId}\0${updatedAt}`;
        let pending = this.inflight.get(key);
        if (!pending) {
          pending = this.read(run, updatedAt, key);
          this.inflight.set(key, pending); // set before the first await of anyone else: concurrent calls share it
        }
        facts = await pending;
      }
      const fresh = await evidenceFiles(run.runDir);
      return { ...facts, evidence: { stream: fresh.stream, read: fresh.stream && facts.evidence.read, manifest: fresh.manifest, incomplete: fresh.incomplete } };
    } catch {
      return undefined;
    }
  }

  private read(run: RunSummary, updatedAt: string, key: string): Promise<OutcomeFacts> {
    const events: EvidenceEvent[] = [];
    return (async () => {
      try {
        const status = await this.reader(run.runDir, run.runId, (e) => void events.push(e), this.maxBytes);
        // events of a failed read are dropped: they would stand for the whole run
        const facts = outcomeFactsOf(run, status === "read" ? events : [], { stream: status !== "missing", read: status === "read", manifest: false, incomplete: false });
        this.done.delete(run.runDir);
        this.done.set(run.runDir, { updatedAt, runId: run.runId, facts });
        while (this.done.size > this.maxEntries) this.done.delete(this.done.keys().next().value as string);
        return facts;
      } finally {
        this.inflight.delete(key);
      }
    })();
  }

  /** Facts by runId, one run after the other, yielding every 10 reads. Never throws. */
  async collect(runs: readonly RunSummary[], updatedAt: ReadonlyMap<string, string>, now: Date): Promise<Map<string, OutcomeFacts>> {
    const out = new Map<string, OutcomeFacts>();
    try {
      let i = 0;
      for (const run of Array.isArray(runs) ? runs : []) {
        if (i++ > 0 && i % 10 === 0) await nap();
        const facts = await this.get(run, run && typeof run.runDir === "string" ? updatedAt.get(run.runDir) : undefined, now);
        if (facts) out.set(run.runId, facts);
      }
    } catch {
      // what was collected stays
    }
    return out;
  }
}
