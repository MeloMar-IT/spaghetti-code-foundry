import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "../config.js";
import type { RunSummary } from "../engine/state.js";
import { FACTORY_HOME } from "../flow/load.js";
import type { GapSignal } from "./gap-signals.js";
import { discoverSkills, findSkill } from "./registry.js";
import { SKILL_ID_RE } from "./schema.js";

// Skill gap issues (#776): the marker, the duplicate and limit rules, the issue text, the ledger and the helpers for runs that
// stopped for a missing skill. GitHub's list is the source of truth for duplicates and limits; the ledger only links runs.
// The issue text holds validated tokens only: no file content, path, review text, issue text or secret.

export const REOPEN_DAYS = 30;
const DAY = 86_400_000;
export const GAP_LABEL_COLOR = "5319e7";
export const GAP_LABEL_TEXT = "A skill the Foundry found missing";
export const gapMarker = (topic: string): string => `<!-- scf skill-gap=${topic} -->`;
export const GAP_MARKER_RE = /<!-- scf skill-gap=([a-z0-9]+(?:-[a-z0-9]+)*) -->/;

/** The fields of a GitHub issue this module reads (a RestIssue fits). */
export interface GapRestIssue { number: number; state: string; body?: string | null; html_url: string; created_at: string; closed_at?: string | null; pull_request?: unknown }
/** The part of a story store this module uses (a StoryStore fits). */
export interface GapStore {
  listAll(o: { pages: number; timeoutMs?: number }): Promise<{ issues: GapRestIssue[]; cut: boolean }>;
  create(o: { title: string; body: string; labels: string[] }, timeoutMs?: number): Promise<{ number: number; html_url: string }>;
  createLabelIfMissing(name: string, color: string, description: string, timeoutMs?: number): Promise<void>;
}

export interface GapIssue { topic: string; number: number; url: string; open: boolean; createdAt: number; closedAt?: number }

/** The marked issues of a list (pull requests are ignored). `byTopic`: an open issue wins (the lowest number), else the newest closed one. `all`: every distinct marked issue. */
export function gapIssuesOf(issues: readonly GapRestIssue[]): { byTopic: Map<string, GapIssue>; all: GapIssue[] } {
  const all: GapIssue[] = [];
  const seen = new Set<number>();
  for (const i of issues) {
    if (i.pull_request || seen.has(i.number)) continue;
    const m = GAP_MARKER_RE.exec(i.body ?? "");
    if (!m || !SKILL_ID_RE.test(m[1]!)) continue;
    seen.add(i.number);
    const closedAt = i.closed_at ? Date.parse(i.closed_at) : NaN;
    all.push({
      topic: m[1]!, number: i.number, url: i.html_url, open: String(i.state).toLowerCase() !== "closed",
      createdAt: Date.parse(i.created_at) || 0, ...(Number.isNaN(closedAt) ? {} : { closedAt }),
    });
  }
  const byTopic = new Map<string, GapIssue>();
  for (const g of all) {
    const old = byTopic.get(g.topic);
    if (!old) byTopic.set(g.topic, g);
    else if (g.open && !old.open) byTopic.set(g.topic, g);
    else if (g.open && old.open) { if (g.number < old.number) byTopic.set(g.topic, g); }
    else if (!g.open && !old.open && (g.closedAt ?? 0) > (old.closedAt ?? 0)) byTopic.set(g.topic, g);
  }
  return { byTopic, all };
}

export const openGapCount = (all: readonly GapIssue[]): number => all.filter((g) => g.open).length;
export const newGapCount = (all: readonly GapIssue[], now: number): number => all.filter((g) => now - g.createdAt < DAY).length;

export type GapSkip = "open" | "closed-recently" | "max-open" | "max-per-day";
export interface GapPlan { open: GapSignal[]; skipped: { topic: string; reason: GapSkip }[] }

/** Which signals get a new issue. Never more than `maxOpen` open and `maxPerDay` new ones, counted over all marked issues. Pure. */
export function planGapIssues(signals: readonly GapSignal[], existing: { byTopic: Map<string, GapIssue>; all: readonly GapIssue[] }, o: { now: number; maxOpen: number; maxPerDay: number }): GapPlan {
  let open = openGapCount(existing.all);
  let fresh = newGapCount(existing.all, o.now);
  const plan: GapPlan = { open: [], skipped: [] };
  const seen = new Set<string>();
  for (const s of signals) {
    if (seen.has(s.topic)) continue;
    seen.add(s.topic);
    const old = existing.byTopic.get(s.topic);
    if (old?.open) { plan.skipped.push({ topic: s.topic, reason: "open" }); continue; }
    // a closed issue without a readable closing time counts as just closed (fail closed)
    if (old && (old.closedAt === undefined || o.now - old.closedAt < REOPEN_DAYS * DAY)) { plan.skipped.push({ topic: s.topic, reason: "closed-recently" }); continue; }
    if (open >= o.maxOpen) { plan.skipped.push({ topic: s.topic, reason: "max-open" }); continue; }
    if (fresh >= o.maxPerDay) { plan.skipped.push({ topic: s.topic, reason: "max-per-day" }); continue; }
    plan.open.push(s);
    open++;
    fresh++;
  }
  return plan;
}

const SAMPLE_TASKS: Record<GapSignal["kind"], (t: string) => string[]> = {
  unknown: (t) => [`Add a feature to a project that needs ${t}.`, `Fix a bug in code that uses ${t}.`, `Review a change that touches ${t}.`],
  technology: (t) => [`Add a small feature to a ${t} project and its tests.`, `Fix a failing test in a ${t} project.`, `Review a pull request in a ${t} project.`],
  review: (t) => [`Write code in the area of ${t} that a reviewer accepts at once.`, `Fix a review finding about ${t}.`, `Review a change for problems about ${t}.`],
  failure: (t) => [`Make the tests pass in the area of ${t} in one repair step.`, `Find the cause of a repeated failure about ${t}.`, `Prevent a failure about ${t} before it reaches the tests.`],
};
const WHAT: Record<GapSignal["kind"], (s: GapSignal) => string> = {
  unknown: (s) => `Write a skill with the id \`${s.topic}\`. Runs asked for it, and the catalogue has no skill with that id.`,
  technology: (s) => `Write a skill for \`${s.evidence.technology?.name ?? s.topic}\`. Runs worked on it, and no skill in the catalogue covers it.`,
  review: (s) => `Write a skill about \`${s.topic}\`. Reviewers raised the same kind of finding in several runs.`,
  failure: (s) => `Write a skill about \`${s.topic}\`. Runs failed or needed several repair steps for the same kind of work.`,
};

/** The title and body of the issue for a signal. Validated tokens only; the marker is last. */
export function gapIssueText(s: GapSignal): { title: string; body: string } {
  const ev = ["### Evidence", "", `- Runs: ${s.evidence.runs.map((r) => `\`${r}\``).join(", ")}`];
  if (s.evidence.findingKinds.length) ev.push(`- Finding kinds: ${s.evidence.findingKinds.map((k) => `\`${k}\``).join(", ")}`);
  const t = s.evidence.technology;
  if (t) ev.push(`- Technology: \`${t.name}\`${t.version ? ` (version \`${t.version}\`)` : ""}`);
  ev.push(`- Repository: \`${s.repo}\``);
  const body = [
    "### What to teach", "", WHAT[s.kind](s), "",
    ...ev, "",
    "### Sample tasks", "", ...SAMPLE_TASKS[s.kind](s.topic).map((x, i) => `${i + 1}. ${x}`), "",
    "Opened by the Foundry. It lists run ids, kinds and technology names only.", "",
    gapMarker(s.topic),
  ].join("\n");
  return { title: `Skill gap: ${s.topic}`, body };
}

// ---- the ledger

export interface GapLedgerEntry { issue: number; url: string; state: "open" | "closed"; closedAt?: string }
export interface GapLedger { version: 1; repository: string; at: string; topics: Record<string, GapLedgerEntry> }
export const gapLedgerFile = (): string => join(process.env.FACTORY_HOME ?? FACTORY_HOME, "skill-gaps.json");
const URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d{1,10}$/;
const MAX_LEDGER = 200;

const emptyLedger = (repository: string): GapLedger => ({ version: 1, repository, at: "", topics: {} });

/** The ledger of `repository` (any case). A missing or broken file, or a ledger of another repository, reads as empty. Never throws. */
export function readGapLedger(file: string = gapLedgerFile(), repository = ""): GapLedger {
  const want = repository.trim().toLowerCase();
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as GapLedger;
    if (!j || j.version !== 1 || typeof j.repository !== "string" || !j.topics || typeof j.topics !== "object") return emptyLedger(want);
    if (want !== "" && j.repository.toLowerCase() !== want) return emptyLedger(want);
    const topics: Record<string, GapLedgerEntry> = {};
    for (const [k, v] of Object.entries(j.topics)) {
      if (!SKILL_ID_RE.test(k) || !v || !Number.isInteger(v.issue) || typeof v.url !== "string" || !URL_RE.test(v.url)) continue;
      topics[k] = { issue: v.issue, url: v.url, state: v.state === "closed" ? "closed" : "open", ...(typeof v.closedAt === "string" ? { closedAt: v.closedAt } : {}) };
    }
    return { version: 1, repository: j.repository.toLowerCase(), at: typeof j.at === "string" ? j.at : "", topics };
  } catch {
    return emptyLedger(want);
  }
}

/** Writes with a temporary file and a rename. */
export function writeGapLedger(ledger: GapLedger, file: string = gapLedgerFile()): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(ledger, null, 2));
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** The ledger of the marked issues, with the newest MAX_LEDGER topics. */
export function buildGapLedger(repository: string, byTopic: ReadonlyMap<string, GapIssue>, now: number): GapLedger {
  const topics: Record<string, GapLedgerEntry> = {};
  const list = [...byTopic.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_LEDGER);
  for (const g of list) {
    if (!URL_RE.test(g.url)) continue;
    topics[g.topic] = { issue: g.number, url: g.url, state: g.open ? "open" : "closed", ...(g.closedAt ? { closedAt: new Date(g.closedAt).toISOString() } : {}) };
  }
  return { version: 1, repository: repository.toLowerCase(), at: new Date(now).toISOString(), topics };
}

// ---- runs that stopped for a missing skill

type Unresolved = NonNullable<RunSummary["skillPlan"]>["unresolved"];
const stopped = (run: RunSummary): Unresolved | undefined => (run.skillPlan?.action === "stop" && Array.isArray(run.skillPlan.unresolved) ? run.skillPlan.unresolved : undefined);

/** The ids of the unknown skills a run stopped for. */
export function unknownTopicIds(run: RunSummary): string[] {
  return [...new Set((stopped(run) ?? []).filter((u) => u.code === "unknown").map((u) => u.id))];
}

/** Would the stop clear once the unknown skills exist? Every stopping item is unknown, or blocked because a mandatory skill is unknown. */
export function blockersClearable(run: RunSummary): boolean {
  const items = stopped(run);
  if (!items?.length) return false;
  const unknownMandatory = items.some((u) => u.code === "unknown" && u.mandatory);
  return items.some((u) => u.code === "unknown") && items.every((u) => u.code === "unknown" || (u.code === "blocked" && unknownMandatory));
}

/** The ledger entries of the given ids. */
export function gapLinksFor(ids: readonly string[], ledger: GapLedger): { topic: string; issue: number; url: string }[] {
  return ids.flatMap((id) => (Object.hasOwn(ledger.topics, id) ? [{ topic: id, issue: ledger.topics[id]!.issue, url: ledger.topics[id]!.url }] : []));
}

export const GAP_SENTENCE = "Skill gap issue: ";
export const gapLinkSentence = (links: readonly { url: string }[]): string => (links.length ? `${GAP_SENTENCE}${links.map((l) => l.url).join(", ")}` : "");

/** A stopped run that waits for a skill with an open or closed gap issue. */
export function isSkillGapStop(run: RunSummary): boolean {
  return run.status === "stopped" && Array.isArray(run.skillGap) && run.skillGap.length > 0 && blockersClearable(run);
}

/** Is every unknown skill of the run in the registry now? Never throws; false on an error. */
export function skillGapReady(run: RunSummary, skills: Config["skills"], discover: typeof discoverSkills = discoverSkills): boolean {
  try {
    const ids = unknownTopicIds(run);
    if (!ids.length) return false;
    const reg = discover(skills, { repo: run.workdir ?? run.repo });
    return ids.every((id) => findSkill(reg, id) !== undefined);
  } catch {
    return false;
  }
}

// ---- opening the issues

export interface OpenGapResult {
  made: { topic: string; number: number; url: string }[];
  skipped: GapPlan["skipped"];
  /** The issue list was cut: nothing was opened. */
  cut: boolean;
  /** A create failed; the rest was not tried. */
  failed: boolean;
  byTopic: Map<string, GapIssue>;
}

/** Lists first; a cut list opens nothing. Creates the label if missing, then the issues. A failing list throws. */
export async function openGapIssues(o: {
  store: GapStore;
  signals: readonly GapSignal[];
  label: string;
  maxOpen: number;
  maxPerDay: number;
  now: number;
}): Promise<OpenGapResult> {
  const { issues, cut } = await o.store.listAll({ pages: 3, timeoutMs: 20_000 });
  const existing = gapIssuesOf(issues);
  const out: OpenGapResult = { made: [], skipped: [], cut, failed: false, byTopic: existing.byTopic };
  if (cut) return out;
  const plan = planGapIssues(o.signals, existing, { now: o.now, maxOpen: o.maxOpen, maxPerDay: o.maxPerDay });
  out.skipped = plan.skipped;
  if (!plan.open.length) return out;
  try {
    await o.store.createLabelIfMissing(o.label, GAP_LABEL_COLOR, GAP_LABEL_TEXT, 20_000);
  } catch {
    out.failed = true;
    return out;
  }
  for (const s of plan.open) {
    try {
      const t = gapIssueText(s);
      const made = await o.store.create({ title: t.title, body: t.body, labels: [o.label] }, 30_000);
      out.made.push({ topic: s.topic, number: made.number, url: made.html_url });
      out.byTopic.set(s.topic, { topic: s.topic, number: made.number, url: made.html_url, open: true, createdAt: o.now });
    } catch {
      out.failed = true;
      break;
    }
  }
  return out;
}
