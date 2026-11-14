import { createHash } from "node:crypto";

/**
 * Notices for programs (#871). The notifier records one notice per Your-turn item, per success and per daily summary,
 * with the text the Mac shows. A program reads the notices after its last `seq` (the same long-poll as the change feed).
 */
export type NoticeKind = "turn" | "done" | "summary";
export const NOTICE_KINDS: readonly NoticeKind[] = ["turn", "done", "summary"];

/** Every notice younger than this is kept; there is no count limit. */
export const NOTICE_KEEP_MS = 7 * 86_400_000;

/** What the notifier hands over. `ref` is an internal hash used to never store one thing twice; it is never sent. */
export interface RaisedNotice {
  kind: NoticeKind;
  title: string;
  text: string;
  /** The opaque item key (as `GET feed` and `GET your-turn/mine` show it). */
  key?: string;
  runId?: string;
  link?: string;
  ref: string;
}

export interface NoticeRecord extends RaisedNotice {
  s: number;
  /** ms since the epoch */
  at: number;
}

export interface NoticeState {
  version: 1;
  seq: number;
  /** Cursors below this get `reset`: notices up to here were dropped. */
  floor: number;
  notices: NoticeRecord[];
}

export const emptyNotices = (now: number): NoticeState => ({ version: 1, seq: now, floor: now, notices: [] });

/** A sha256 hex of the parts: stored instead of any raw key or URL. */
export const refOf = (parts: string): string => createHash("sha256").update(parts).digest("hex");

const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Reads the file's text. `undefined`: broken (start fresh). `"newer"`: written by a newer version (leave it alone). */
export function parseNotices(raw: string): NoticeState | "newer" | undefined {
  let d: unknown;
  try {
    d = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isObj(d)) return undefined;
  if (isNum(d.version) && d.version > 1) return "newer";
  if (d.version !== 1 || !isNum(d.seq) || !isNum(d.floor) || !Array.isArray(d.notices)) return undefined;
  const notices: NoticeRecord[] = [];
  for (const n of d.notices) {
    if (!isObj(n) || !isNum(n.s) || !isNum(n.at) || !isStr(n.title) || !isStr(n.text) || !isStr(n.ref)) return undefined;
    if (!NOTICE_KINDS.includes(n.kind as NoticeKind)) return undefined;
    for (const k of ["key", "runId", "link"]) if (n[k] !== undefined && !isStr(n[k])) return undefined;
    notices.push({
      s: n.s, at: n.at, kind: n.kind as NoticeKind, title: n.title, text: n.text, ref: n.ref,
      ...(isStr(n.key) ? { key: n.key } : {}),
      ...(isStr(n.runId) ? { runId: n.runId } : {}),
      ...(isStr(n.link) ? { link: n.link } : {}),
    });
  }
  return { version: 1, seq: d.seq, floor: d.floor, notices };
}

/** Adds the notices whose `ref` is not kept yet; title, text and link are redacted first. Returns how many were added. */
export function appendNotices(state: NoticeState, raised: readonly RaisedNotice[], now: number, redact: (s: string) => string): number {
  const have = new Set(state.notices.map((n) => n.ref));
  let added = 0;
  for (const r of raised) {
    if (have.has(r.ref)) continue;
    have.add(r.ref);
    state.seq = state.seq + 1;
    state.notices.push({
      s: state.seq, at: now, kind: r.kind, title: redact(r.title), text: redact(r.text), ref: r.ref,
      ...(r.key !== undefined ? { key: r.key } : {}),
      ...(r.runId !== undefined ? { runId: r.runId } : {}),
      ...(r.link !== undefined ? { link: redact(r.link) } : {}),
    });
    added += 1;
  }
  return added;
}

/** Drops notices older than 7 days and raises the floor. Returns true when something was dropped. */
export function pruneNotices(state: NoticeState, now: number): boolean {
  const keep = state.notices.filter((n) => n.at >= now - NOTICE_KEEP_MS);
  if (keep.length === state.notices.length) return false;
  const kept = new Set(keep.map((n) => n.s));
  for (const n of state.notices) if (!kept.has(n.s)) state.floor = Math.max(state.floor, n.s);
  state.notices = keep;
  return true;
}

export interface NoticeOut {
  seq: number;
  kind: NoticeKind;
  at: string;
  title: string;
  text: string;
  key?: string;
  runId?: string;
  link?: string;
}

export interface NoticesAnswer {
  seq: number;
  reset?: true;
  notices: NoticeOut[];
}

/** The notices after `since`. A missing `since`, one below the floor or above `seq` is `reset` with no notices. Never holds `ref`. */
export function noticesAnswer(state: NoticeState, since: number | undefined): NoticesAnswer {
  if (since === undefined || since < state.floor || since > state.seq) return { seq: state.seq, reset: true, notices: [] };
  const notices = state.notices
    .filter((n) => n.s > since)
    .map((n): NoticeOut => ({
      seq: n.s, kind: n.kind, at: new Date(n.at).toISOString(), title: n.title, text: n.text,
      ...(n.key !== undefined ? { key: n.key } : {}),
      ...(n.runId !== undefined ? { runId: n.runId } : {}),
      ...(n.link !== undefined ? { link: n.link } : {}),
    }));
  return { seq: state.seq, notices };
}
