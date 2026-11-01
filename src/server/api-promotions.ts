import { readFileSync } from "node:fs";
import { DETAIL_MAX, writeAudit, auditAction } from "../auth/audit.js";
import { dataHome } from "../auth/store.js";
import { isShippedFlow } from "../engine/guards.js";
import { listFlows, parseFlow } from "../flow/load.js";
import { COMPONENT_KINDS, flowSha256, flowVersion, type ComponentKind } from "../promotion/components.js";
import { readHomeComponents, type FoundComponent } from "../promotion/home.js";
import { promoteWithReport, promotionDecision, REPORT_ID_RE, type BlockingItem, type PromotionDecision, type SuiteVerdict } from "../promotion/promote.js";
import { findRecord, readRecordBook, type RecordBook, type ReportRef } from "../promotion/records.js";
import { HttpError, readJson, send, str } from "./http.js";
import type { Route } from "./server.js";

/**
 * `GET /api/promotions` and `POST /api/promotions`: which components are promoted, what blocks the others, and promoting one.
 * Admin only (the table in permissions.ts). Answers hold ids, hashes and fixed texts, never report content or a path.
 */

const ID_RE = /^[\w.-]{1,200}$/;
const SCOPE_HINT = "This flow is in the repository: move it to the global flows, then run scf eval safety.";

export type PromotionState = "promoted" | "promotable" | "blocked";

export interface PromotionRow {
  ref: { kind: ComponentKind; id: string; version: string; sha256: string };
  state: PromotionState;
  record?: { reportId: string; reports: ReportRef[]; promotedAt: string; by: string };
  reports?: ReportRef[];
  blocking?: BlockingItem[];
}

/** A component the editor or the home folder holds, with the hint for a flow of the repository. */
interface Candidate {
  component: FoundComponent;
  scopeHint?: string;
}

/** The flows a run would find: repository, global, then built-in. An unchanged built-in flow is left out. */
function flowCandidates(repo: string): { found: Candidate[]; problems: { kind: ComponentKind; id: string; reason: string }[]; published: Set<string> } {
  const found: Candidate[] = [];
  const problems: { kind: ComponentKind; id: string; reason: string }[] = [];
  const published = new Set<string>();
  for (const f of listFlows(repo)) {
    if (f.error !== undefined) {
      problems.push({ kind: "flow", id: f.name, reason: "is not valid" });
      continue;
    }
    try {
      const flow = parseFlow(readFileSync(f.path, "utf8"), f.path);
      if (f.scope === "builtin" || isShippedFlow(flow)) continue;
      if (flow.publish?.enabled === true) published.add(f.name);
      found.push({ component: { kind: "flow", id: f.name, version: flowVersion(flow), sha256: flowSha256(flow) }, ...(f.scope === "repo" ? { scopeHint: SCOPE_HINT } : {}) });
    } catch {
      problems.push({ kind: "flow", id: f.name, reason: "is not valid" });
    }
  }
  return { found, problems, published };
}

type Located = Candidate | "problem" | undefined;

/**
 * The component of one kind and id: `problem` when a repository flow of that id does not parse. Such a flow still shadows a
 * global flow of its name, so it is never skipped in favour of the global copy. Undefined when nothing has that id.
 */
function locate(repo: string, kind: ComponentKind, id: string): Located {
  if (kind === "flow") {
    const flows = flowCandidates(repo);
    if (flows.problems.some((p) => p.id === id)) return "problem";
    return flows.found.find((c) => c.component.id === id);
  }
  const component = readHomeComponents(dataHome(), { kinds: [kind] }).found.find((f) => f.id === id);
  return component ? { component } : undefined;
}

function rowOf(d: PromotionDecision, book: RecordBook | undefined): PromotionRow {
  const ref = d.ref!;
  if (!d.ok) return { ref, state: "blocked", blocking: d.blocking };
  const entry = book ? findRecord(book, ref) : undefined;
  if (entry) return { ref, state: "promoted", record: { reportId: entry.reportId, reports: entry.reports, promotedAt: entry.promotedAt, by: entry.by } };
  return { ref, state: "promotable", reports: d.reports };
}

function kindOf(raw: unknown): ComponentKind {
  if (typeof raw !== "string" || !(COMPONENT_KINDS as readonly string[]).includes(raw)) throw new HttpError(400, `"kind" must be one of ${COMPONENT_KINDS.join(", ")}`);
  return raw as ComponentKind;
}
function idOf(raw: unknown): string {
  if (typeof raw !== "string" || !ID_RE.test(raw)) throw new HttpError(400, '"id" is not a component id');
  return raw;
}

export const promotionRoutes: Route = async (ctx, req, res, seg, method, user) => {
  if (seg[0] !== "promotions" || seg.length !== 1) return false;
  const repo = ctx.opts.repo;

  if (method === "GET") {
    const q = new URL(req.url ?? "/", "http://x").searchParams;
    const kind = q.has("kind") ? kindOf(q.get("kind")) : undefined;
    const id = q.has("id") ? idOf(q.get("id")) : undefined;
    if (id !== undefined && kind === undefined) throw new HttpError(400, '"id" needs "kind"');

    const kinds = kind ? [kind] : COMPONENT_KINDS;
    const candidates: Candidate[] = [];
    const problems: { kind: ComponentKind; id: string; reason: string }[] = [];
    if (kinds.includes("flow")) {
      const flows = flowCandidates(repo);
      // Without an id only the published flows are listed; a flow asked for by id is always answered.
      candidates.push(...flows.found.filter((c) => (id === undefined ? flows.published.has(c.component.id) : c.component.id === id)));
      problems.push(...flows.problems.filter((p) => id === undefined || p.id === id));
    }
    const others = kinds.filter((k) => k !== "flow");
    if (others.length) {
      const home = readHomeComponents(dataHome(), { kinds: others });
      candidates.push(...home.found.filter((f) => !f.builtin && (id === undefined || f.id === id)).map((component) => ({ component })));
      problems.push(...home.problems.filter((p) => id === undefined || p.id === id));
    }

    const book = readRecordBook();
    const verdicts = new Map<string, SuiteVerdict>();
    const components = candidates
      .map((c) => rowOf(promotionDecision(c.component.kind, c.component.id, { live: false, component: c.component, verdicts, ...(c.scopeHint ? { scopeHint: c.scopeHint } : {}) }), book.ok ? book.book : undefined))
      .sort((a, b) => (a.ref.kind + "/" + a.ref.id < b.ref.kind + "/" + b.ref.id ? -1 : 1));
    return send(res, 200, { components, problems, ...(book.ok ? {} : { recordProblem: book.reason }) }), true;
  }

  if (method === "POST") {
    const body = await readJson(req);
    const kind = kindOf(body.kind);
    const id = idOf(body.id);
    const reportId = str(body, "reportId");
    if (!REPORT_ID_RE.test(reportId)) throw new HttpError(400, '"reportId" is not a report id');

    const target = `${kind}/${id}`;
    /** Logs the BLOCKED lines, writes a failed audit line (best effort) and returns the 409 to throw. */
    const refuse = (blocking: BlockingItem[], lines: string[]): HttpError => {
      for (const line of lines) if (line.startsWith("BLOCKED ")) ctx.opts.log?.(line);
      try {
        const codes = blocking.map((b) => (b.suite ? `${b.suite}: ${b.code}` : b.code)).join(", ");
        writeAudit(user.id, { action: "component-promote", result: "failed", target, ...(codes ? { detail: codes.slice(0, DETAIL_MAX) } : {}) }, 0);
      } catch {
        ctx.diagLog?.("audit: audit.jsonl not-written (component-promote)");
      }
      return new HttpError(409, "not promoted", undefined, { blocking });
    };

    const found = locate(repo, kind, id);
    // a repository flow that does not parse blocks the promotion: the global copy of its name must not be promoted instead
    if (found === "problem") throw refuse([{ code: "problem", remediation: `scf components ${kind}` }], [`BLOCKED ${kind} ${id}: (problem) — scf components ${kind}`]);
    const r = promoteWithReport(kind, id, reportId, {
      live: false,
      by: user.id,
      waitMs: 0,
      ...(found ? { component: found.component } : {}),
      ...(found?.scopeHint ? { scopeHint: found.scopeHint } : {}),
    });
    if (!r.ok) {
      if (r.reason !== undefined) throw new HttpError(503, r.reason);
      throw refuse(r.decision.blocking, r.decision.lines);
    }
    const e = r.entry;
    auditAction(ctx.diagLog, user.id, "component-promote", target, `v${e.version} sha256:${e.sha256} report:${e.reportId}`);
    const book: RecordBook = { version: 1, records: [e] };
    return send(res, 200, { component: rowOf(r.decision, book) }), true;
  }

  return false;
};
