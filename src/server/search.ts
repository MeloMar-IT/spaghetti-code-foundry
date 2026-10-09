import { githubNameOf, tryParseRepoUrl } from "../auth/repo-url.js";
import { listAllRepos, listRepos } from "../auth/repos.js";
import { DELETED_OWNER, ownerNames } from "../auth/run-owner.js";
import type { User } from "../auth/users.js";
import type { Board } from "../board.js";
import { liveRedactor } from "../credentials/redact.js";
import { ticketTitleOf, type RunBrief, type RunSummary } from "../engine/state.js";
import { listFlows } from "../flow/load.js";
import type { NextStep } from "../next-step.js";
import { listSessions } from "../refinement/store.js";
import { userFlowList } from "./api-flows.js";
import { checkedRun, runsListFor } from "./api-runs.js";
import { boardFor } from "./board.js";
import { HttpError, NAME_RE, send } from "./http.js";
import { nextFor, ownRecord, queuedJobNext } from "./next.js";
import { hidePaths, userRecord } from "./user-view.js";
import type { ApiContext, Route } from "./server.js";

export type SearchType = "run" | "issue" | "refinement" | "repo" | "flow";
export interface SearchHit { type: SearchType; id: string; title: string; href: string; status?: string; repo?: string; detail?: string; owner?: string; at?: string }
export interface SearchGroup { type: SearchType; label: string; hits: SearchHit[]; more: boolean }
export interface SearchAnswer { q: string; groups: SearchGroup[]; incomplete?: SearchType[] }

export const SEARCH_LIMIT = 8;
export const SEARCH_Q_MAX = 100;
export const SEARCH_RUN_READS = 40;
const TEXT_MAX = 200;
const BOARD_TTL_MS = 5_000;

const TYPES: { type: SearchType; label: string }[] = [
  { type: "run", label: "Runs" },
  { type: "issue", label: "Issues" },
  { type: "refinement", label: "Refinement sessions" },
  { type: "repo", label: "Repositories" },
  { type: "flow", label: "Flows" },
];

// ---- matching ------------------------------------------------------------------------------------

/** The words of a query: lower case, split on white space, each once. */
export function wordsOf(q: string): string[] {
  return [...new Set(q.toLowerCase().split(/\s+/).filter(Boolean))];
}

const isDigits = (s: string) => /^\d+$/.test(s);

/** 4 equal, 3 prefix, 2 start of a word, 1 contains, 0 no match. */
function textScore(w: string, text: string): number {
  const t = text.toLowerCase();
  if (t === w) return 4;
  if (t.startsWith(w)) return 3;
  let found = false;
  for (let at = t.indexOf(w); at >= 0; at = t.indexOf(w, at + 1)) {
    if (at > 0 && !/[\p{L}\p{N}]/u.test(t[at - 1]!)) return 2;
    found = true;
  }
  return found ? 1 : 0;
}

/** Numbers match whole or as a prefix only. */
const numberScore = (w: string, n: string): number => (n === w ? 4 : n.startsWith(w) ? 3 : 0);

/**
 * How well the fields match all words: 0 when one word matches nothing, else the sum of the best match of each word.
 * `#254` matches numbers only; a plain number matches numbers and text.
 */
export function scoreOf(words: string[], f: { text: unknown[]; numbers?: unknown[] }): number {
  const text = f.text.filter((t): t is string => typeof t === "string" && t !== "");
  const numbers = (f.numbers ?? []).flatMap((n) => (typeof n === "string" && n !== "") || typeof n === "number" ? [String(n)] : []);
  const uniq = [...new Set(words)];
  if (!uniq.length) return 0;
  let total = 0;
  for (const w of uniq) {
    let best = 0;
    if (w.startsWith("#")) {
      const d = w.slice(1);
      if (isDigits(d)) for (const n of numbers) best = Math.max(best, numberScore(d, n));
    } else {
      for (const t of text) best = Math.max(best, textScore(w, t));
      if (isDigits(w)) for (const n of numbers) best = Math.max(best, numberScore(w, n));
    }
    if (best === 0) return 0;
    total += best;
  }
  return total;
}

/** Best match first; equal scores by `at`, newest first (none last), then by id. The first 8; `more` when there are others. */
export function rank<T extends { hit: SearchHit; score: number }>(scored: T[]): { hits: SearchHit[]; more: boolean } {
  const sorted = [...scored].sort((a, b) => b.score - a.score || (b.hit.at ?? "").localeCompare(a.hit.at ?? "") || (a.hit.id < b.hit.id ? -1 : a.hit.id > b.hit.id ? 1 : 0));
  return { hits: sorted.slice(0, SEARCH_LIMIT).map((s) => s.hit), more: sorted.length > SEARCH_LIMIT };
}

// ---- the id form ---------------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_SHAPE: Record<SearchType, RegExp> = {
  run: /^[\w-]+$/,
  issue: /^[\w.-]+\/[\w.-]+#\d+$/,
  refinement: UUID_RE,
  repo: UUID_RE,
  flow: NAME_RE,
};

/** `id` parameters: 1 to 8 values of the form `<type>:<id>`, each once. Throws HttpError 400. */
export function parseIds(raw: string[]): { type: SearchType; id: string }[] {
  if (raw.length < 1 || raw.length > SEARCH_LIMIT) throw new HttpError(400, `give 1 to ${SEARCH_LIMIT} id values`);
  const seen = new Set<string>();
  const out: { type: SearchType; id: string }[] = [];
  for (const value of raw) {
    const at = value.indexOf(":");
    const type = value.slice(0, Math.max(at, 0)) as SearchType;
    const id = value.slice(at + 1);
    if (at < 0 || !TYPES.some((t) => t.type === type) || !ID_SHAPE[type].test(id)) throw new HttpError(400, "an id must look like <type>:<id>");
    if (seen.has(value)) continue;
    seen.add(value);
    out.push({ type, id });
  }
  return out;
}

// ---- the hits ------------------------------------------------------------------------------------

type Sel = { words: string[] } | { ids: string[] };
interface Cand { hit: SearchHit; score: number }
interface Out { hits: SearchHit[]; more: boolean }
interface Env {
  ctx: ApiContext;
  user: User;
  admin: boolean;
  /** Stored secrets taken out of a text, before it is matched or shown. */
  clean: (text: string) => string;
  ownerName: (owner: unknown) => string | undefined;
}

const cut = (text: string): string => [...text].slice(0, TEXT_MAX).join("");
const firstLine = (text: unknown): string => (typeof text === "string" ? text.split("\n", 1)[0]!.trim() : "");
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
/** `owner/name` only; not the placeholder of the forms. */
const safeRepo = (v: unknown): string | undefined => (typeof v === "string" && /^[\w.-]+\/[\w.-]+$/.test(v) && v !== "owner/repo" ? v : undefined);

/** A hit with the fixed fields only; optional fields are left out when empty. */
function hitOf(type: SearchType, h: { id: string; title: string; href: string; status?: unknown; repo?: unknown; detail?: unknown; owner?: unknown; at?: unknown }): SearchHit {
  const opt = { status: str(h.status), repo: str(h.repo), detail: str(h.detail), owner: str(h.owner), at: str(h.at) };
  return { type, id: h.id, title: h.title, href: h.href, ...Object.fromEntries(Object.entries(opt).filter(([, v]) => v !== undefined)) };
}

function cand(sel: Sel, hit: SearchHit, f: { text: unknown[]; numbers?: unknown[] }): Cand {
  return { hit, score: "words" in sel ? scoreOf(sel.words, f) : 1 };
}

function finish(cands: Cand[], sel: Sel, more = false): Out {
  if ("ids" in sel) {
    const byId = new Map(cands.map((c) => [c.hit.id, c.hit]));
    return { hits: sel.ids.flatMap((id) => byId.get(id) ?? []), more: false };
  }
  const r = rank(cands.filter((c) => c.score > 0));
  return { hits: r.hits, more: r.more || more };
}

const queuedOwner = (ctx: ApiContext, runId: string): string | undefined => ctx.scheduler.ownerOf(runId);

/** Runs of the account (all for an admin) and queued jobs that have no run folder yet; one group. */
function runGroup(env: Env, sel: Sel): Out {
  const { ctx, user, admin, clean } = env;
  const owner = admin ? undefined : user.id;
  const all = ctx.scheduler.briefs();
  const briefs = all.filter((b) => admin || b.owner === user.id);
  const shown = (s: Pick<RunSummary, "workdir" | "runDir" | "repo">, text: string) => cut(admin ? clean(text) : hidePaths(clean(text), s));
  const mine = (rid: string) => ctx.scheduler.ownerOf(rid) === user.id;

  // Records, built once for a request: one per archive state, with the list of that state only when a hit has succeeded.
  const nexts = new Map<boolean, (r: RunSummary) => NextStep>();
  const view = (n: NextStep) => (admin ? n : userRecord(ownRecord(n, mine)));
  const statusOf = (s: RunSummary, archived: boolean, needList: boolean): string | undefined => {
    let f = nexts.get(archived);
    if (!f) nexts.set(archived, (f = nextFor(ctx, needList ? runsListFor(ctx, owner, archived) : undefined, !admin)));
    return view(f(s)).status;
  };

  const verified: { s: RunSummary; b: RunBrief; hit: SearchHit; text: unknown[]; numbers: unknown[] }[] = [];
  const build = (b: RunBrief): void => {
    const s = checkedRun(ctx.scheduler, b.dirName, owner);
    if (!s) return;
    const task = firstLine(s.task);
    const title = (task && shown(s, task)) || shown(s, ticketTitleOf(s.state?.steps?.pull_ticket?.output)) || `Run ${s.runId}`;
    const issue = typeof s.vars?.issue === "string" && /^\d+$/.test(s.vars.issue) ? s.vars.issue : undefined;
    const repo = safeRepo(s.vars?.github_repo);
    const detail = [str(s.flow) && shown(s, s.flow), issue ? `#${issue}` : undefined].filter(Boolean).join(" · ");
    const ownerName = admin ? env.ownerName(s.owner) : undefined;
    const hit = hitOf("run", { id: s.runId, title, href: `#/runs/${s.runId}`, repo, detail, owner: ownerName, at: s.startedAt });
    verified.push({ s, b, hit, text: [title, repo, detail, s.runId], numbers: [issue] });
  };

  let capped = false;
  if ("ids" in sel) {
    for (const id of sel.ids) {
      const b = briefs.find((x) => x.dirName === id);
      if (b) build(b);
    }
  } else {
    const pre = briefs
      .map((b) => ({ b, score: scoreOf(sel.words, { text: [clean(b.taskLine ?? ""), clean(b.issueTitle ?? ""), b.githubRepo, b.flow, b.runId, b.dirName], numbers: [b.issue] }) }))
      .filter((c) => c.score > 0); // newest first, as the briefs come; only verified hits are ranked
    let reads = 0;
    for (const c of pre) {
      if (verified.length > SEARCH_LIMIT) break;
      if (reads >= SEARCH_RUN_READS) {
        capped = true;
        break;
      }
      reads++;
      build(c.b);
      // The final score is on what is shown.
      const last = verified.at(-1);
      if (last && last.b === c.b && scoreOf(sel.words, last) === 0) verified.pop();
    }
  }
  const needList = (archived: boolean) => verified.some((v) => !!v.b.archived === archived && v.s.status === "succeeded");
  const cands: Cand[] = verified.map((v) => {
    const status = statusOf(v.s, !!v.b.archived, needList(!!v.b.archived));
    return cand(sel, status ? { ...v.hit, status } : v.hit, v);
  });

  // Queued jobs: no run folder yet. The owner is looked up for the jobs that could match only.
  const dirs = new Set(all.map((b) => b.dirName));
  const jobNext = queuedJobNextOnce(ctx, admin);
  for (const p of ctx.scheduler.queue().pending) {
    if (p.kind !== "run" || dirs.has(p.runId) || ("ids" in sel && !sel.ids.includes(p.runId))) continue;
    const who = queuedOwner(ctx, p.runId);
    if (!admin && who !== user.id) continue;
    const task = firstLine(p.task);
    const hide = { repo: p.repo, workdir: ctx.opts.repo };
    const shownJob = (text: string) => cut(admin ? clean(text) : hidePaths(clean(text), hide));
    const record = view(jobNext()(p));
    const title = (task && shownJob(task)) || shownJob(firstLine(record.title)) || `Run ${p.runId}`;
    const repo = safeRepo(p.githubRepo);
    const issue = typeof p.issue === "string" && /^\d+$/.test(p.issue) ? p.issue : undefined;
    const detail = str(p.flow) && cut(clean(p.flow!));
    const status = record.status;
    const hit = hitOf("run", { id: p.runId, title, href: "#/runs", status, repo, detail, owner: admin ? env.ownerName(who) : undefined, at: p.enqueuedAt });
    cands.push(cand(sel, hit, { text: [title, repo, detail, p.runId], numbers: [issue] }));
  }
  const kept = cands.filter((c) => c.score > 0).length;
  return finish(cands, sel, verified.length > SEARCH_LIMIT || (capped && kept >= SEARCH_LIMIT));
}

/** The record builder of queued jobs, made on first use. */
function queuedJobNextOnce(ctx: ApiContext, admin: boolean): () => ReturnType<typeof queuedJobNext> {
  let f: ReturnType<typeof queuedJobNext> | undefined;
  return () => (f ??= queuedJobNext(ctx, !admin, false));
}

const boards = new WeakMap<ApiContext, { at: number; board: Board }>();

function boardCached(ctx: ApiContext): Board {
  const have = boards.get(ctx);
  if (have && Date.now() - have.at < BOARD_TTL_MS) return have.board;
  const board = boardFor(ctx);
  boards.set(ctx, { at: Date.now(), board });
  return board;
}

export function forgetBoard(ctx: ApiContext): void {
  boards.delete(ctx);
}

/** The board's cards (admin only). */
function issueGroup(env: Env, sel: Sel): Out {
  const cands: Cand[] = [];
  for (const r of boardCached(env.ctx).repos) {
    for (const col of r.columns) {
      for (const card of col.cards) {
        const title = env.clean(card.title || "") || `#${card.issue}`;
        const href = card.runId ? `#/runs/${card.runId}` : `#/board/${encodeURIComponent(r.repo)}`;
        const hit = hitOf("issue", { id: `${r.repo}#${card.issue}`, title, href, status: card.next?.status, repo: safeRepo(r.repo), owner: card.ownerName, at: card.since });
        cands.push(cand(sel, hit, { text: [title, r.repo], numbers: [card.issue] }));
      }
    }
  }
  return finish(cands, sel);
}

function sessionGroup(env: Env, sel: Sel): Out {
  const cands = listSessions(env.admin ? undefined : env.user.id).map((s) => {
    const title = env.clean(s.title);
    const hit = hitOf("refinement", { id: s.id, title, href: `#/refinement/${s.id}`, status: s.state, repo: s.repo, owner: env.admin ? env.ownerName(s.owner) : undefined, at: s.updated });
    return cand(sel, hit, { text: [title, s.repo, s.id] });
  });
  return finish(cands, sel);
}

/** "owner/name" for a GitHub address, else the last two parts of the parsed address. Never the address itself. */
function repoTitle(url: string): string {
  return githubNameOf(url) ?? tryParseRepoUrl(url)?.key.split("/").slice(-2).join("/") ?? "repository";
}

function repoGroup(env: Env, sel: Sel): Out {
  const cands = (env.admin ? listAllRepos() : listRepos(env.user.id)).map((r) => {
    const title = env.clean(repoTitle(r.url));
    const hit = hitOf("repo", { id: r.id, title, href: r.owner === env.user.id ? "#/repos" : "#/all-repos", owner: env.admin ? env.ownerName(r.owner) : undefined, at: r.added });
    return cand(sel, hit, { text: [title] });
  });
  return finish(cands, sel);
}

function flowGroup(env: Env, sel: Sel): Out {
  const { ctx, admin } = env;
  const cands = admin
    ? listFlows(ctx.opts.repo).filter((f) => NAME_RE.test(f.name)).map((f) => {
      const detail = f.description ? env.clean(f.description) : undefined;
      return cand(sel, hitOf("flow", { id: f.name, title: f.name, href: `#/flows/${f.name}`, detail }), { text: [f.name, detail] });
    })
    : userFlowList(ctx.opts.repo).map((f) => {
      const title = cut(env.clean(f.title));
      const detail = f.description ? cut(env.clean(f.description)) : undefined;
      return cand(sel, hitOf("flow", { id: f.name, title, href: "#/start", detail }), { text: [title, f.name, detail] });
    });
  return finish(cands, sel);
}

const SOURCES: Record<SearchType, (env: Env, sel: Sel) => Out> = { run: runGroup, issue: issueGroup, refinement: sessionGroup, repo: repoGroup, flow: flowGroup };

/** Searches the things the user may see. `ids` picks by exact id and ignores the text. */
export function searchFor(ctx: ApiContext, user: User, query: { q: string } | { ids: { type: SearchType; id: string }[] }): SearchAnswer {
  const words = "q" in query ? wordsOf(query.q) : [];
  const q = "q" in query ? query.q.trim() : "";
  if ("q" in query && !words.length) return { q, groups: [] };
  const admin = user.role === "admin";
  let names: Map<string, string> | undefined;
  const red = liveRedactor();
  const env: Env = {
    ctx, user, admin,
    clean: (t) => red.redact(t),
    ownerName: (o) => (typeof o === "string" ? (names ??= ownerNames()).get(o) ?? DELETED_OWNER : undefined),
  };
  const groups: SearchGroup[] = [];
  const incomplete: SearchType[] = [];
  for (const { type, label } of TYPES) {
    let sel: Sel;
    if ("q" in query) sel = { words };
    else {
      const ids = query.ids.filter((i) => i.type === type).map((i) => i.id);
      if (!ids.length) continue;
      sel = { ids };
    }
    if (type === "issue" && !admin) continue;
    try {
      const out = SOURCES[type](env, sel);
      if (out.hits.length) groups.push({ type, label, hits: out.hits, more: out.more });
    } catch {
      incomplete.push(type);
      ctx.diagLog?.(`search: ${type} source failed`);
    }
  }
  return { q, groups, ...(incomplete.length ? { incomplete } : {}) };
}

export const searchRoutes: Route = async (ctx, req, res, seg, method, user) => {
  if (seg[0] !== "search" || seg[1] || method !== "GET") return false;
  const params = new URL(req.url ?? "/", "http://x").searchParams;
  const ids = params.getAll("id");
  if (ids.length) return send(res, 200, searchFor(ctx, user, { ids: parseIds(ids) })), true;
  const q = params.get("q") ?? "";
  if ([...q].length > SEARCH_Q_MAX) throw new HttpError(400, `q can have at most ${SEARCH_Q_MAX} characters`);
  return send(res, 200, searchFor(ctx, user, { q })), true;
};
