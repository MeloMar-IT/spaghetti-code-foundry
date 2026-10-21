import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import type { MonitorConfig } from "../config.js";
import type { RunSummary, StepRecord } from "../engine/state.js";
import { parseEvidenceEventLine } from "../evidence/parse.js";
import { TERMINAL_RUN_STATUSES, type EvidenceEvent } from "../evidence/schema.js";
import { EVIDENCE_EVENTS_FILE, EVIDENCE_INCOMPLETE_FILE, EVIDENCE_MANIFEST_FILE } from "../evidence/version.js";
import { ownerRepo } from "./detectors.js";

// The input of the SLO detectors: plain data from the run.json and the evidence files of the runs, nothing else.
// It reads no telemetry. Files are read asynchronously, in pieces, up to a size limit, and never through a link.

/** A run is judged by evidence-finalization, and cached, only this long after it ended. */
export const SETTLE_MS = 2 * 60_000;
/** An evidence.jsonl above this size is not read; the run is measured from its run.json alone. */
export const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;
/** A line above this size is skipped. */
const MAX_LINE_BYTES = 1024 * 1024;
const CHUNK = 256 * 1024;
const YIELD_LINES = 200;
const MAX_CACHE = 1000;
const HOUR = 3_600_000;

/** One finished visit of a step. `at` is when it ended (ms). */
export interface StepVisit { flow: string; step: string; type: StepRecord["type"]; repo?: string; at: number; durationMs?: number; tokensOut?: number }
/** The refusals of one tool in one visit of a step (the larger of the run record and the evidence, never their sum). */
export interface ToolDenial { tool: string; repo?: string; count: number; at: number }
export interface MeasuredRun {
  runId: string;
  flow: string;
  repo?: string;
  visits: StepVisit[];
  toolDenials: ToolDenial[];
  /** The times (ms) of the policy decisions with policy.unavailable or policy.invalid. */
  policyFailures: number[];
}
/** The evidence files of a run that ended. */
export interface EvidenceState {
  runId: string;
  flow: string;
  repo?: string;
  finishedAt: string;
  stream: boolean;
  manifest: boolean;
  incomplete: boolean;
}
export interface SloInput { measures: MeasuredRun[]; evidence: EvidenceState[] }

/** The longest look-back of the SLO detectors, in hours. */
export function sloLookbackHours(c: MonitorConfig): number {
  return Math.max(c.policy_service_failure.within_hours, c.evidence_finalization.within_hours, c.step_latency_p95.within_hours, c.repeated_tool_denial.within_hours, c.abnormal_output.within_hours);
}

/** Tool name of one StepRecord.denied entry ("Bash: mkdir out" → "Bash"); undefined when empty. */
export function deniedTool(text: string): string | undefined {
  if (typeof text !== "string") return undefined;
  const name = text.split(":")[0]!.trim().slice(0, 100);
  return name || undefined;
}

type Tools = Map<string, { count: number; at: number }>;
/** What one visit of a step shows in the evidence: its refusals per tool. */
interface Segment { tools: Tools }
interface EventFacts { segments: Map<string, Segment[]>; policyFailures: number[] }

const keyOf = (s: { id: string; visit: number; parent?: string }) => `${s.parent ? `${s.parent}/` : ""}${s.id}#${s.visit}`;
const stamp = (t: string | undefined): number => {
  const n = Date.parse(t ?? "");
  return Number.isFinite(n) ? n : NaN;
};
const nap = () => new Promise<void>((r) => setImmediate(r));

/** Reads the facts of evidence.jsonl without keeping the events. Never throws; an unreadable or too large file gives none. */
async function readFacts(runDir: string, runId: string): Promise<EventFacts | undefined> {
  const facts: EventFacts = { segments: new Map(), policyFailures: [] };
  const status = await readEvidenceEvents(runDir, runId, (e) => {
    if (e.type === "step.started") {
      const k = keyOf(e.step);
      facts.segments.set(k, [...(facts.segments.get(k) ?? []), { tools: new Map() }]);
    } else if (e.type === "step.denied") {
      const tool = e.denial.kind === "tool" ? e.denial.tool.name : e.denial.kind === "policy" ? e.denial.tool?.name : undefined;
      if (!tool) return;
      const k = keyOf(e.step);
      const list = facts.segments.get(k) ?? [];
      if (!list.length) list.push({ tools: new Map() });
      facts.segments.set(k, list);
      const seg = list[list.length - 1]!;
      const t = seg.tools.get(tool) ?? { count: 0, at: 0 };
      t.count++;
      t.at = Math.max(t.at, stamp(e.time) || 0);
      seg.tools.set(tool, t);
    } else if (e.type === "policy.decided" && (e.decision.reasonCode === "policy.unavailable" || e.decision.reasonCode === "policy.invalid")) {
      const at = stamp(e.time);
      if (Number.isFinite(at)) facts.policyFailures.push(at);
    }
  });
  return status === "read" ? facts : undefined;
}

export type EvidenceReadStatus = "read" | "missing" | "refused";

/**
 * Reads evidence.jsonl in pieces and hands each event of `runId` to `take` (an error in `take` skips that line).
 * Never throws, never follows a link, never reads past the size checked on the open file.
 * "missing": no file. "refused": a link, a file that is not plain, a file over the limit, or an I/O error.
 */
export async function readEvidenceEvents(runDir: string, runId: string, take: (e: EvidenceEvent) => void, maxBytes = MAX_EVIDENCE_BYTES): Promise<EvidenceReadStatus> {
  let fh;
  try {
    fh = await open(join(runDir, EVIDENCE_EVENTS_FILE), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const st = await fh.stat();
    if (!st.isFile() || st.size > maxBytes) return "refused";
    const buf = Buffer.alloc(Math.min(CHUNK, Math.max(1, st.size)));
    let pos = 0;
    let rest = "";
    let skipping = false;
    let lines = 0;
    const line = (text: string) => {
      if (!text.trim()) return;
      try {
        const e = parseEvidenceEventLine(text);
        if (e.runId === runId) take(e);
      } catch {
        // a line that cannot be read is skipped
      }
    };
    while (pos < st.size) {
      // never read past the size that was checked: a file that grows later is cut there
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, st.size - pos), pos);
      if (bytesRead === 0) break;
      pos += bytesRead;
      const parts = (rest + buf.toString("utf8", 0, bytesRead)).split("\n");
      rest = parts.pop() ?? "";
      for (const p of parts) {
        if (skipping) skipping = false;
        else if (p.length <= MAX_LINE_BYTES) line(p);
        if (++lines % YIELD_LINES === 0) await nap();
      }
      if (rest.length > MAX_LINE_BYTES) {
        rest = "";
        skipping = true;
      }
      await nap();
    }
    if (rest && !skipping && rest.length <= MAX_LINE_BYTES) line(rest);
    return "read";
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : "refused";
  } finally {
    await fh?.close().catch(() => {});
  }
}

/** Refusals per tool of one visit, from the run record and from the evidence: per tool the larger count. */
function reconcile(record: Tools, events: Tools | undefined, fallbackAt: number): ToolDenial[] {
  const out: ToolDenial[] = [];
  for (const tool of new Set([...record.keys(), ...(events?.keys() ?? [])])) {
    const r = record.get(tool)?.count ?? 0;
    const e = events?.get(tool);
    if (!r && !e) continue;
    const count = Math.max(r, e?.count ?? 0);
    out.push({ tool, count, at: e?.at || fallbackAt });
  }
  return out;
}

function measure(run: RunSummary, facts: EventFacts | undefined): MeasuredRun {
  const repo = ownerRepo(run);
  const out: MeasuredRun = { runId: String(run.runId), flow: String(run.flow), ...(repo ? { repo } : {}), visits: [], toolDenials: [], policyFailures: facts?.policyFailures ?? [] };
  const used = new Map<string, number>();
  const history: unknown[] = Array.isArray(run.history) ? run.history : [];
  const runEnd = stamp(run.finishedAt) || stamp(run.startedAt);
  for (const raw of history) {
    if (!raw || typeof raw !== "object") continue;
    const rec = raw as Partial<StepRecord>;
    if (typeof rec.id !== "string") continue;
    const visit = typeof rec.visit === "number" && rec.visit >= 1 ? Math.round(rec.visit) : 1;
    const dur = typeof rec.durationMs === "number" && Number.isFinite(rec.durationMs) && rec.durationMs >= 0 ? Math.round(rec.durationMs) : undefined;
    const started = stamp(rec.startedAt);
    const end = Number.isFinite(started) ? started + (dur ?? 0) : NaN;
    const tokensOut = typeof rec.tokens?.output === "number" && Number.isFinite(rec.tokens.output) && rec.tokens.output >= 0 ? Math.round(rec.tokens.output) : undefined;
    if (Number.isFinite(end)) out.visits.push({ flow: out.flow, step: rec.id, type: rec.type as StepRecord["type"], ...(repo ? { repo } : {}), at: end, ...(dur !== undefined ? { durationMs: dur } : {}), ...(tokensOut !== undefined ? { tokensOut } : {}) });
    // the same visit can be run again (a resume): the n-th record is the n-th start in the evidence
    // A record's id of a nested step already starts with its parent ("build/test"); evidence names it id "test", parent "build".
    const parent = typeof rec.parent === "string" && rec.parent ? rec.parent : undefined;
    const key = keyOf({ id: parent && rec.id.startsWith(`${parent}/`) ? rec.id.slice(parent.length + 1) : rec.id, visit, parent });
    const n = used.get(key) ?? 0;
    used.set(key, n + 1);
    const fromRecord: Tools = new Map();
    for (const d of Array.isArray(rec.denied) ? rec.denied : []) {
      const tool = deniedTool(d);
      if (tool) fromRecord.set(tool, { count: (fromRecord.get(tool)?.count ?? 0) + 1, at: 0 });
    }
    const at = Number.isFinite(end) ? end : runEnd;
    out.toolDenials.push(...reconcile(fromRecord, facts?.segments.get(key)?.[n]?.tools, at).map((d) => ({ ...d, ...(repo ? { repo } : {}) })));
  }
  // visits that only the evidence knows (the record was lost or cut)
  for (const [key, segs] of facts?.segments ?? []) {
    segs.forEach((seg, i) => {
      if (i < (used.get(key) ?? 0)) return;
      out.toolDenials.push(...reconcile(new Map(), seg.tools, runEnd).map((d) => ({ ...d, ...(repo ? { repo } : {}) })));
    });
  }
  return out;
}

async function present(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ENOENT"; // a file that cannot be looked at counts as there
  }
}

export interface EvidenceFiles { stream: boolean; manifest: boolean; incomplete: boolean }

/** Whether each evidence file is there (lstat; a file that cannot be looked at counts as there). Never throws. */
export async function evidenceFiles(runDir: string): Promise<EvidenceFiles> {
  const [stream, manifest, incomplete] = await Promise.all([present(join(runDir, EVIDENCE_EVENTS_FILE)), present(join(runDir, EVIDENCE_MANIFEST_FILE)), present(join(runDir, EVIDENCE_INCOMPLETE_FILE))]);
  return { stream, manifest, incomplete };
}

/** Builds the input once per check. Measures are cached per run folder and `updatedAt`; the file checks are made again every time. */
export class SloInputCache {
  private cache = new Map<string, { updatedAt: string; runId: string; measured: MeasuredRun }>();

  /** Never throws: a run whose files cannot be read is left out. */
  async build(runs: readonly RunSummary[], updatedAt: ReadonlyMap<string, string>, now: Date, config: MonitorConfig): Promise<SloInput> {
    const t = now.getTime();
    const from = t - sloLookbackHours(config) * HOUR;
    const out: SloInput = { measures: [], evidence: [] };
    const seen = new Set<string>();
    let reads = 0;
    for (const run of runs) {
      try {
        if (!run || typeof run.runDir !== "string") continue;
        const ended = (TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status);
        const finished = stamp(run.finishedAt);
        // runs that ended before the longest window have nothing to say
        if (ended && (!Number.isFinite(finished) || finished < from)) continue;
        const stamped = updatedAt.get(run.runDir);
        const settled = ended && t - finished >= SETTLE_MS && stamped !== undefined;
        const hit = this.cache.get(run.runDir);
        let measured: MeasuredRun;
        if (settled && hit && hit.updatedAt === stamped && hit.runId === run.runId) {
          measured = hit.measured;
        } else {
          if (reads++ > 0 && reads % 10 === 0) await nap();
          measured = measure(run, await readFacts(run.runDir, run.runId));
          if (settled && stamped !== undefined && (this.cache.has(run.runDir) || this.cache.size < MAX_CACHE)) this.cache.set(run.runDir, { updatedAt: stamped, runId: run.runId, measured });
        }
        if (settled || this.cache.has(run.runDir)) seen.add(run.runDir);
        out.measures.push(measured);
        if (ended) {
          out.evidence.push({ runId: run.runId, flow: run.flow, ...(measured.repo ? { repo: measured.repo } : {}), finishedAt: run.finishedAt!, ...(await evidenceFiles(run.runDir)) });
        }
      } catch {
        // a run that cannot be read is left out
      }
    }
    for (const k of [...this.cache.keys()]) if (!seen.has(k)) this.cache.delete(k);
    return out;
  }
}
