import { dataHome } from "../auth/store.js";
import { COMPONENT_KINDS, isCounted, lookupVersions, type ComponentKind, type LineMark, type SeenHash } from "./components.js";
import { readHomeComponents, type ComponentProblem, type FoundComponent } from "./home.js";
import {
  emptyGovernanceBook,
  governanceOrphans,
  governanceProfile,
  governanceRecord,
  governanceStatus,
  readGovernanceBook,
  type GovernanceLifecycle,
  type GovernanceRecord,
  type GovernanceRisk,
  type GovernanceStatus,
} from "./governance.js";
import { readVersionBook, recordVersions } from "./versions.js";

export interface GovernedRow {
  component: FoundComponent;
  mark?: LineMark;
  record: GovernanceRecord | undefined;
  status: GovernanceStatus;
  /** True for a counted component whose version book could not be read: it has no version, and `scf components` leaves it out. */
  versionFailed?: boolean;
}

export interface GovernedList {
  rows: GovernedRow[];
  problems: ComponentProblem[];
  /** Why the governance file cannot be used; the rows then have no record. */
  bookProblem?: string;
}

/**
 * The components of the data folder with their version, governance record and status. `scf components` and
 * `GET /api/admin/components` both read it. It writes only when `record` is true (new hashes get a version).
 */
export function listGoverned(o: { kinds?: readonly ComponentKind[]; record?: boolean; waitMs?: number; builtinFlowsDir?: string; now?: Date } = {}): GovernedList {
  const { found, problems } = readHomeComponents(dataHome(), { ...(o.kinds ? { kinds: o.kinds } : {}), ...(o.builtinFlowsDir ? { builtinFlowsDir: o.builtinFlowsDir } : {}) });
  const counted = found.filter((f): f is FoundComponent & { kind: SeenHash["kind"] } => isCounted(f.kind));
  const seen: SeenHash[] = counted.map((f) => ({ kind: f.kind, id: f.id, sha256: f.sha256 }));

  let versions: (number | undefined)[] = [];
  let failure: string | undefined;
  if (seen.length > 0) {
    if (o.record) {
      const r = recordVersions(seen, o.waitMs === undefined ? {} : { waitMs: o.waitMs });
      if (r.ok) versions = r.versions;
      else failure = r.reason;
    } else {
      const r = readVersionBook();
      if (r.ok) versions = lookupVersions(r.book, seen);
      else failure = r.reason;
    }
  }

  const gov = readGovernanceBook(dataHome());
  const book = gov.ok ? gov.book : emptyGovernanceBook();
  const now = o.now ?? new Date();
  const row = (component: FoundComponent, mark?: LineMark, versionFailed?: boolean): GovernedRow => {
    const record = governanceRecord(book, component.kind, component.id);
    return { component, ...(mark ? { mark } : {}), record, status: governanceStatus(component, record, now), ...(versionFailed ? { versionFailed } : {}) };
  };

  const all: ComponentProblem[] = [...problems, ...governanceOrphans(book, found, problems, o.kinds ?? COMPONENT_KINDS)];
  const rows: GovernedRow[] = [];
  for (const f of found) {
    if (!isCounted(f.kind)) {
      rows.push(row(f, f.builtin ? "builtin" : undefined));
      continue;
    }
    if (failure !== undefined) {
      all.push({ kind: f.kind, id: f.id, reason: failure });
      rows.push(row(f, undefined, true));
      continue;
    }
    const v = versions[counted.indexOf(f as (typeof counted)[number])];
    const c = { ...f, ...(v === undefined ? {} : { version: String(v) }) };
    rows.push(row(c, v === undefined ? "unrecorded" : undefined));
  }
  return { rows, problems: all, ...(gov.ok ? {} : { bookProblem: gov.reason }) };
}

export interface ComponentRow {
  kind: ComponentKind;
  id: string;
  builtin: boolean;
  version: string | null;
  owner: string | null;
  risk: GovernanceRisk;
  lifecycle: GovernanceLifecycle;
  approvedVersion: string | null;
  lastReview: string | null;
  evalSuite: string | null;
  status: GovernanceStatus;
}

export interface ComponentsView {
  components: ComponentRow[];
  problems: { kind: ComponentKind; id: string; reason: string }[];
  governanceProblem?: string;
}

/** The answer of `GET /api/admin/components`: built field by field, so no hash or path can get in. Missing values are null. */
export function componentsView(list: GovernedList): ComponentsView {
  const components = list.rows.map((r): ComponentRow => {
    const p = governanceProfile(r.record);
    return {
      kind: r.component.kind,
      id: r.component.id,
      builtin: r.component.builtin === true,
      version: r.component.version ?? null,
      owner: p.owner ?? null,
      risk: p.risk,
      lifecycle: p.lifecycle,
      approvedVersion: p.approved_version ?? null,
      lastReview: p.last_review ?? null,
      evalSuite: p.eval_suite ?? null,
      status: r.status,
    };
  });
  return {
    components,
    problems: list.problems.map((p) => ({ kind: p.kind, id: p.id, reason: p.reason })),
    ...(list.bookProblem !== undefined ? { governanceProblem: list.bookProblem } : {}),
  };
}
