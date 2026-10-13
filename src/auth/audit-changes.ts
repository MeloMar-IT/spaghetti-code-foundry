import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { DETAIL_MAX } from "./audit.js";

/** Settings whose value never goes into the audit log: `agent_env` matches any path segment, the others the whole path. */
export const MASKED_KEYS = ["notify.slack_webhook", "notify.command", "agent_env"] as const;
/** Options of a watcher (whole path inside the watcher) that say only "changed": an account e-mail and free task text. */
export const MASKED_WATCHER_OPTIONS = ["owner", "task"] as const;
/** A value in a detail is cut to this many characters (plus `…`). */
export const VALUE_MAX = 80;

/** One changed setting. `path` is ready to show (no control characters). `old`/`new` are rendered and cut; both are absent when the key is masked. */
export interface SettingChange {
  path: string;
  old?: string;
  new?: string;
}

type Obj = Readonly<Record<string, unknown>>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** True when the names, as stored, are a masked key. */
function masked(path: string[], watcher: boolean): boolean {
  const joined = path.join(".");
  if (path.includes("agent_env")) return true;
  if ((MASKED_KEYS as readonly string[]).includes(joined)) return true;
  return watcher && (MASKED_WATCHER_OPTIONS as readonly string[]).includes(joined);
}

const CONTROL_ALL = /[\u0000-\u001f\u007f-\u009f]/g;
const CONTROL_HIGH = /[\u007f-\u009f]/g;

/** The path as shown, complete: control characters in each name become `?`. */
function shown(path: string[]): string {
  return path.map((s) => s.replace(CONTROL_ALL, "?")).join(".");
}

function render(v: unknown): string {
  if (v === undefined) return "(not set)";
  const s = (JSON.stringify(v) ?? String(v)).replace(CONTROL_HIGH, "?");
  return s.length > VALUE_MAX ? `${s.slice(0, VALUE_MAX)}…` : s;
}

function diff(before: unknown, after: unknown, watcher: boolean, path: string[], head: string[], out: SettingChange[]): void {
  if (isObj(before) || isObj(after)) {
    const b = isObj(before) ? before : {};
    const a = isObj(after) ? after : {};
    for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) diff(b[k], a[k], watcher, [...path, k], head, out);
    return;
  }
  if (isDeepStrictEqual(before, after)) return;
  const p = shown([...head, ...path]);
  out.push(masked(path, watcher) ? { path: p } : { path: p, old: render(before), new: render(after) });
}

const bySortedPath = (a: SettingChange, b: SettingChange) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** Changed options of one watcher (paths such as `every`, `vars.test_cmd`), sorted. */
export function watcherChanges(before: Obj, after: Obj): SettingChange[] {
  const out: SettingChange[] = [];
  diff(before, after, true, [], [], out);
  return out.sort(bySortedPath);
}

const watcherList = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);

/** Changed leaves of two parsed configs, sorted by path; `watchers` by id as `watchers.<id>.<option>`, or `watchers.<id>#<n>.<option>` when an id is used twice. */
export function configChanges(before: Obj, after: Obj): SettingChange[] {
  const { watchers: bw, ...b } = before;
  const { watchers: aw, ...a } = after;
  const out: SettingChange[] = [];
  diff(b, a, false, [], [], out);
  const olds = watcherList(bw);
  const news = watcherList(aw);
  const ids = [...new Set([...olds, ...news].map((w) => String(w.id)))].sort();
  for (const id of ids) {
    const o = olds.filter((w) => String(w.id) === id);
    const n = news.filter((w) => String(w.id) === id);
    const label = (nth: number) => (o.length > 1 || n.length > 1 ? `${id}#${nth}` : id);
    const freeNew = [...n];
    const restOld: { w: Obj; nth: number }[] = [];
    o.forEach((w, i) => {
      const at = freeNew.findIndex((x) => isDeepStrictEqual(x, w));
      if (at >= 0) freeNew.splice(at, 1);
      else restOld.push({ w, nth: i + 1 });
    });
    const pairs: { b: Obj; a: Obj; nth: number }[] = [];
    restOld.forEach((r, i) => pairs.push({ b: r.w, a: freeNew[i] ?? {}, nth: r.nth }));
    freeNew.slice(restOld.length).forEach((w, j) => pairs.push({ b: {}, a: w, nth: o.length + j + 1 }));
    for (const p of pairs) diff(p.b, p.a, true, [], ["watchers", label(p.nth)], out);
  }
  return out.sort(bySortedPath);
}

/** `<prefix><path>: <old> -> <new>`, or `<prefix><path>: changed`; at most DETAIL_MAX characters, never ending in a space. */
export function changeDetail(c: SettingChange, prefix = ""): string {
  const what = c.old === undefined || c.new === undefined ? ": changed" : `: ${c.old} -> ${c.new}`;
  let who = `${prefix}${c.path}`;
  // Only a name too long for the limit is shortened: its two ends stay, with a hash of the whole name between, so
  // two long names never look alike and the change itself is never cut.
  const room = DETAIL_MAX - what.length;
  if (who.length > room) {
    const hash = createHash("sha256").update(who).digest("hex").slice(0, 12);
    const keep = Math.floor((room - hash.length - 2) / 2);
    who = `${who.slice(0, keep)}~${hash}~${who.slice(who.length - keep)}`;
  }
  return `${who}${what}`.slice(0, DETAIL_MAX).trimEnd();
}
