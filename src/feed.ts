import { DEFAULT_WORKSPACE } from "./workspaces/index.js";
import { validWorkspaceId } from "./workspaces/list.js";

/**
 * The change feed (#868). The server compares snapshots of what exists and records one change per added, changed or removed
 * object: a kind and an id, never any detail. A caller reads the changes after its last `seq`.
 */
export type FeedKind = "turn" | "run" | "repo" | "change";
export const FEED_KINDS: readonly FeedKind[] = ["turn", "run", "repo", "change"];

/** Every change younger than this is kept. */
export const FEED_KEEP_MS = 24 * 3_600_000;
/** The newest changes of any age that are kept. */
export const FEED_KEEP_COUNT = 10_000;
/** The file never holds more than this, even when that cuts into the last 24 hours. */
export const FEED_MAX = 20_000;
export const FEED_WAIT_MAX_S = 30;

/** Who may see an object: its owner, its workspace and, for a change request, the workspace of its architect run. */
export interface FeedSide {
  o?: string;
  w?: string;
  a?: string;
}

/** One object in the snapshot. `f` is an internal fingerprint and is never sent. */
export interface FeedEntry extends FeedSide {
  f: string;
}

/** `see` holds the sides before and after the change, so a reader who could see either learns of a deletion or a move. */
export interface FeedRecord {
  s: number;
  k: FeedKind;
  i: string;
  /** ms since the epoch */
  at: number;
  see: FeedSide[];
}

export interface FeedState {
  version: 1;
  seq: number;
  /** Cursors below this get `reset`: records up to here were dropped. */
  floor: number;
  snapshot: Record<string, FeedEntry>;
  changes: FeedRecord[];
}

export const emptyFeed = (now: number): FeedState => ({ version: 1, seq: now, floor: now, snapshot: {}, changes: [] });

const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const sideOf = (v: unknown): FeedSide | undefined => {
  if (!isObj(v)) return undefined;
  for (const k of ["o", "w", "a"]) if (v[k] !== undefined && !isStr(v[k])) return undefined;
  const out: FeedSide = {};
  if (isStr(v.o)) out.o = v.o;
  if (isStr(v.w)) out.w = v.w;
  if (isStr(v.a)) out.a = v.a;
  return out;
};

/** Reads the file's text. `undefined`: broken (start a fresh feed). `"newer"`: written by a newer version (leave it alone). */
export function parseFeed(raw: string): FeedState | "newer" | undefined {
  let d: unknown;
  try {
    d = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isObj(d)) return undefined;
  if (isNum(d.version) && d.version > 1) return "newer";
  if (d.version !== 1 || !isNum(d.seq) || !isNum(d.floor) || !isObj(d.snapshot) || !Array.isArray(d.changes)) return undefined;
  const snapshot: Record<string, FeedEntry> = {};
  for (const [key, e] of Object.entries(d.snapshot)) {
    const side = sideOf(e);
    if (!side || !isObj(e) || !isStr(e.f)) return undefined;
    snapshot[key] = { f: e.f, ...side };
  }
  const changes: FeedRecord[] = [];
  for (const c of d.changes) {
    if (!isObj(c) || !isNum(c.s) || !isNum(c.at) || !isStr(c.i) || !FEED_KINDS.includes(c.k as FeedKind) || !Array.isArray(c.see)) return undefined;
    const see = c.see.map(sideOf);
    if (see.some((x) => x === undefined)) return undefined;
    changes.push({ s: c.s, k: c.k as FeedKind, i: c.i, at: c.at, see: see as FeedSide[] });
  }
  return { version: 1, seq: d.seq, floor: d.floor, snapshot, changes };
}

const sideOfEntry = (e: FeedEntry | undefined): FeedSide[] => (e ? [{ o: e.o, w: e.w, a: e.a }] : []);
const keyOf = (k: FeedKind, i: string) => `${k}:${i}`;

/**
 * Records what differs between the saved snapshot and `next` for the kinds in `read`; the other kinds keep their old entries.
 * With `silent` the snapshot is taken without any record (a new feed). Returns how many records were made.
 */
export function diffFeed(state: FeedState, read: ReadonlySet<FeedKind>, next: ReadonlyMap<string, FeedEntry>, now: number, silent = false): number {
  let n = 0;
  const add = (key: string, before: FeedEntry | undefined, after: FeedEntry | undefined) => {
    if (silent) return;
    const at = key.indexOf(":");
    state.seq += 1;
    state.changes.push({ s: state.seq, k: key.slice(0, at) as FeedKind, i: key.slice(at + 1), at: now, see: [...sideOfEntry(before), ...sideOfEntry(after)] });
    n += 1;
  };
  for (const [key, old] of Object.entries(state.snapshot)) {
    if (!read.has(key.slice(0, key.indexOf(":")) as FeedKind) || next.has(key)) continue;
    add(key, old, undefined);
    delete state.snapshot[key];
  }
  for (const [key, e] of next) {
    const old = state.snapshot[key];
    if (old && old.f === e.f) {
      state.snapshot[key] = e; // the same fingerprint means the same sides, but keep the stored copy current
      continue;
    }
    add(key, old, e);
    state.snapshot[key] = e;
  }
  return n;
}

/** Keeps every change younger than 24 h and the newest 10,000, within the hard cap. Returns true when something was dropped. */
export function pruneFeed(state: FeedState, now: number): boolean {
  const n = state.changes.length;
  let keep = state.changes.filter((c, i) => n - i <= FEED_KEEP_COUNT || c.at >= now - FEED_KEEP_MS);
  if (keep.length > FEED_MAX) keep = keep.slice(keep.length - FEED_MAX);
  if (keep.length === n) return false;
  const kept = new Set(keep.map((c) => c.s));
  for (const c of state.changes) if (!kept.has(c.s)) state.floor = Math.max(state.floor, c.s);
  state.changes = keep;
  return true;
}

/** The caller as the feed sees them. `kinds` limits a service account to the kinds whose read route is in its scope. */
export interface FeedReader {
  id: string;
  admin: boolean;
  /** undefined for an admin (no check) */
  workspaces: ReadonlySet<string> | undefined;
  kinds?: ReadonlySet<FeedKind>;
}

const inWs = (ws: ReadonlySet<string> | undefined, v: unknown): boolean => ws === undefined || ws.has(validWorkspaceId(v) ? v : DEFAULT_WORKSPACE);

/** May the caller see an object of this kind with this side? An admin sees all but another account's change request. */
export function sideVisible(k: FeedKind, side: FeedSide, who: FeedReader): boolean {
  if (who.kinds && !who.kinds.has(k)) return false;
  if (k === "change") {
    if (side.o !== who.id) return false;
    // a repository that is gone leaves no workspace: like the session routes, the request stays visible
    return who.admin || ((side.w === undefined || inWs(who.workspaces, side.w)) && (side.a === undefined || inWs(who.workspaces, side.a)));
  }
  if (who.admin) return true;
  return side.o === who.id && inWs(who.workspaces, side.w);
}

export const visible = (r: Pick<FeedRecord, "k" | "see">, who: FeedReader): boolean => r.see.some((s) => sideVisible(r.k, s, who));

export interface FeedAnswer {
  seq: number;
  reset?: true;
  changes: { kind: FeedKind; id: string; at: string }[];
}

/**
 * What changed after `since`, for this caller. A missing `since`, one below the floor or above `seq` is `reset`.
 * `current` is the snapshot: an object that still exists is shown only when it is readable now.
 */
export function feedAnswer(state: FeedState, since: number | undefined, who: FeedReader, current: Readonly<Record<string, FeedEntry>> = state.snapshot): FeedAnswer {
  if (since === undefined || since < state.floor || since > state.seq) return { seq: state.seq, reset: true, changes: [] };
  const newest = new Map<string, FeedRecord>();
  for (const r of state.changes) {
    if (r.s <= since || !visible(r, who)) continue;
    // A turn item's id is opaque and carries no detail: its record is shown by the sides it was recorded with, so an owner
    // learns that an item left their list (acted on, or moved) even though the item still exists.
    const now = current[keyOf(r.k, r.i)];
    if (now && r.k !== "turn" && !sideVisible(r.k, now, who)) continue;
    newest.set(keyOf(r.k, r.i), r); // records are in order of `s`: the last one wins
  }
  const changes = [...newest.values()].sort((a, b) => a.s - b.s).map((r) => ({ kind: r.k, id: r.i, at: new Date(r.at).toISOString() }));
  return { seq: state.seq, changes };
}

export class FeedQueryError extends Error {}

/** `since` and `wait` of a request. A bad value throws FeedQueryError; no `wait` is 0. */
export function parseFeedQuery(q: URLSearchParams): { since?: number; wait: number } {
  const num = (name: string, max: number): number | undefined => {
    const v = q.get(name);
    if (v === null) return undefined;
    if (!/^\d{1,16}$/.test(v) || Number(v) > max) throw new FeedQueryError(`"${name}" must be a whole number from 0 to ${max}`);
    return Number(v);
  };
  const since = num("since", Number.MAX_SAFE_INTEGER);
  return { ...(since === undefined ? {} : { since }), wait: num("wait", FEED_WAIT_MAX_S) ?? 0 };
}
