import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { GUARD_MAX, REMOVED_WORDS, looksLikeOrders, scrub, type GuardOptions } from "./guard.js";

/**
 * Bounded reading of a log for Ask Foundry, and making its text safe. A read never takes more than its cap, and only
 * from a file that lies inside its folder. The order of the text work is always the same: raw lines → `readableLine` →
 * `maskKeyBlocks` over the whole window → `redactRange` (whole blocks of lines) → only then numbering and `cutLine`.
 */

/** The most bytes a tail reads from the end, and the most a search or a test log reads. */
export const TAIL_BYTES = 128 * 1024;
export const SEARCH_BYTES = 4 * 1024 * 1024;
/** Next to a place where a read cuts the file, lines are only context for the guard: a secret may be cut in half there. */
export const EDGE_BYTES = 4 * 1024;
/** The lines around a place that are checked together with it. */
export const GUARD_PAD = 20;
/** The longest shown line. */
export const LINE_MAX = 240;
/** The lines shown around a search match. */
export const AROUND = 2;
/** The most places a search shows (the last ones), and the most lines of one place. */
export const KEEP_GROUPS = 3;
export const GROUP_LINES_MAX = 15;
/** The words that stand for a line that reads like an order. */
export const HELD_LINE = "(held back: it reads like an order)";
const CHUNK = 64 * 1024;

export interface WindowOk {
  kind: "ok";
  /** The raw lines that were read whole; a cut line at an edge of the read is left out. */
  lines: string[];
  /** The size of the file as read. */
  size: number;
  bytesRead: number;
  atStart: boolean;
  atEnd: boolean;
  /** The lines that may be shown or matched: `from` up to (not including) `to`. The others are context for the guard. */
  usable: { from: number; to: number };
}
export type LogWindow = WindowOk | { kind: "missing" } | { kind: "outside" };

export interface ReadOptions {
  from: "start" | "end";
  capBytes: number;
  /** Only for tests: they replace the file at an exact moment. */
  hooks?: { beforeOpen?: () => void; afterOpen?: () => void };
}

const inside = (root: string, file: string): boolean => {
  const rel = relative(root, file);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

const gone = (e: unknown) => ["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException).code ?? "");

/**
 * At most `capBytes` from the start or the end of a file inside `root`. The path is checked as written, and again for
 * the file that was really opened, so neither a link nor a swap between the check and the open leads outside.
 */
export async function readWindow(file: string, root: string, o: ReadOptions): Promise<LogWindow> {
  const path = resolve(file);
  if (!inside(resolve(root), path)) return { kind: "outside" };
  o.hooks?.beforeOpen?.();
  let handle: FileHandle | undefined;
  try {
    // never wait for the writer of a FIFO
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    o.hooks?.afterOpen?.();
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) return { kind: "missing" };
    const [realRoot, real] = await Promise.all([realpath(root), realpath(path)]);
    if (!inside(realRoot, real)) return { kind: "outside" };
    const there = await lstat(real, { bigint: true });
    if (there.dev !== opened.dev || there.ino !== opened.ino) return { kind: "outside" };
    const size = Number(opened.size);
    const want = Math.min(size, o.capBytes);
    const start = o.from === "end" ? size - want : 0;
    const buffer = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const { bytesRead } = await handle.read(buffer, got, Math.min(CHUNK, want - got), start + got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    return linesOf(buffer.subarray(0, got), size, start === 0, start + got >= size);
  } catch (e) {
    if (gone(e)) return { kind: "missing" };
    throw e;
  } finally {
    await handle?.close();
  }
}

/** The whole lines of a window, and which of them lie away from a cut edge. Empty lines count; a last line break adds none. */
function linesOf(bytes: Buffer, size: number, atStart: boolean, atEnd: boolean): WindowOk {
  const lines: string[] = [];
  let from = -1;
  let to = 0;
  let at = 0;
  if (!atStart) {
    const nl = bytes.indexOf(10);
    at = nl < 0 ? bytes.length : nl + 1;
  }
  while (at < bytes.length) {
    const nl = bytes.indexOf(10, at);
    if (nl < 0 && !atEnd) break;
    const end = nl < 0 ? bytes.length : nl;
    const index = lines.push(bytes.toString("utf8", at, end > at && bytes[end - 1] === 13 ? end - 1 : end)) - 1;
    if ((atStart || at >= EDGE_BYTES) && (atEnd || at < bytes.length - EDGE_BYTES)) {
      if (from < 0) from = index;
      to = index + 1;
    }
    at = end + 1;
  }
  return { kind: "ok", lines, size, bytesRead: bytes.length, atStart, atEnd, usable: from < 0 ? { from: 0, to: 0 } : { from, to } };
}

/** The number of a line: counted from 1 at the start of the file, else back from the end (the last line is 1). */
export const lineNumber = (w: Pick<WindowOk, "lines" | "atStart">, index: number): number => (w.atStart ? index + 1 : w.lines.length - index);

const text = (v: unknown): string => (typeof v === "string" ? v : "");
const rec = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const plain = (v: unknown): string => (typeof v === "string" ? v : (JSON.stringify(v) ?? ""));
const resultText = (v: unknown): string => (typeof v === "string" ? v : arr(v).map((c) => text(rec(c).text)).filter(Boolean).join("\n"));
const fields = (v: unknown): string => Object.entries(rec(v)).map(([k, x]) => `${k}: ${plain(x)}`).join("\n");

/** The readable words of one event of a Claude stream-json or Codex JSONL log; "" for any other line. */
function eventText(ev: Record<string, unknown>): string {
  if (ev.type === "assistant" || ev.type === "user") {
    return arr(rec(ev.message).content).map(rec).map((c) => {
      if (c.type === "text") return text(c.text);
      if (c.type === "tool_use") return `tool ${text(c.name)}: ${fields(c.input)}`;
      if (c.type === "tool_result") return `tool result${c.is_error ? " (error)" : ""}: ${resultText(c.content)}`;
      return "";
    }).filter(Boolean).join("\n");
  }
  if (ev.type === "result") return text(ev.result) ? `result: ${text(ev.result)}` : "";
  if (ev.type === "item.completed") {
    const item = rec(ev.item);
    if (item.type === "agent_message") return text(item.text);
    if (item.type === "command_execution") return `command: ${plain(item.command)}\n${text(item.aggregated_output)}`;
    if (item.type === "error") return `error: ${text(item.message)}`;
    return "";
  }
  if (ev.type === "turn.failed" || ev.type === "error") {
    const message = text(rec(ev.error).message) || text(ev.message);
    return message ? `error: ${message}` : "";
  }
  return "";
}

const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g;

/** One raw line as a person reads it: an agent event as short text, no colour codes or control characters. Line breaks stay. */
export function readableLine(raw: string): string {
  let out = raw;
  if (raw.startsWith("{")) {
    try {
      out = eventText(rec(JSON.parse(raw))) || raw;
    } catch {
      out = raw;
    }
  }
  return out.replace(ANSI, "").replace(/\r\n|[\r\p{Zl}\p{Zp}]/gu, "\n").replace(/\t/g, " ").replace(/(?!\n)\p{Cc}/gu, "");
}

const KEY_MARK = /-----(BEGIN|END) [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const onlyBase64 = (line: string) => {
  const parts = line.split("\n").map((p) => p.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((p) => BASE64.test(p));
};

/**
 * Takes private keys out of a whole window, before anything matches or groups its lines. A key without its end is
 * masked to the end of the window; an end without a start masks everything before it. `cutStart`: the window begins
 * in the middle of the file, so a first run of base64 lines may be the rest of a key.
 */
export function maskKeyBlocks(lines: readonly string[], o: { cutStart?: boolean } = {}): string[] {
  const mark = REMOVED_WORDS["private-key"];
  const out: string[] = [];
  let open = false;
  for (const line of lines) {
    let done = open ? mark : "";
    let at = 0;
    for (const m of line.matchAll(KEY_MARK)) {
      if (m[1] === "BEGIN") {
        if (open) continue;
        done += line.slice(at, m.index) + mark;
        open = true;
      } else {
        if (!open) {
          out.fill(mark);
          done = mark;
        }
        open = false;
      }
      at = m.index + m[0].length;
    }
    out.push(open ? done : done + line.slice(at));
  }
  if (o.cutStart) {
    for (let i = 0; i < lines.length && onlyBase64(lines[i]!); i++) out[i] = mark;
  }
  return out;
}

export interface Place {
  /** The first and the last line of the place (both included), and its first match. */
  from: number;
  to: number;
  hit: number;
}

/** The places of the matches from `from` up to `to` (not included): close matches are one place; the last `max` places are kept. */
export function findPlaces(lines: readonly string[], isHit: (line: string) => boolean, o: { around: number; max: number; from?: number; to?: number }): { places: Place[]; total: number } {
  const from = o.from ?? 0;
  const to = o.to ?? lines.length;
  const places: Place[] = [];
  let current: Place | undefined;
  let total = 0;
  for (let i = from; i < to; i++) {
    if (!isHit(lines[i]!)) continue;
    total++;
    let first = Math.max(from, i - o.around);
    const last = Math.min(to - 1, i + o.around);
    if (current && first <= current.to + 1) {
      if (last - current.from + 1 <= GROUP_LINES_MAX) {
        current.to = Math.max(current.to, last);
        continue;
      }
      if (i <= current.to) continue;
      first = current.to + 1;
    }
    current = { from: first, to: last, hit: i };
    places.push(current);
    if (places.length > o.max) places.shift();
  }
  return { places, total };
}

/** The characters of context kept on each side of a place when it is checked, on top of the `pad` lines. */
export const CONTEXT_CHARS = 16_000;

/**
 * The lines from `from` up to `to` (not included), safe to show, one text for each. They are checked as one block: at
 * least `pad` lines and at least `CONTEXT_CHARS` characters on each side (as far as the block stays within `GUARD_MAX`),
 * so a configured pattern or a key that spans many lines is still found; then a line that reads like an order is held
 * back. Undefined when the place itself is too long to be checked: nothing of it may be shown. Throws `GuardError` like `scrub`.
 */
export function redactRange(lines: readonly string[], from: number, to: number, guard: GuardOptions, pad = GUARD_PAD): string[] | undefined {
  let first = from;
  for (let chars = 0; first > 0 && (first > from - pad || chars < CONTEXT_CHARS); ) {
    first--;
    chars += lines[first]!.length + 1;
  }
  let end = to;
  for (let chars = 0; end < lines.length && (end < to + pad || chars < CONTEXT_CHARS); ) {
    chars += lines[end]!.length + 1;
    end++;
  }
  const block = lines.slice(first, end);
  const joined = block.join("\n");
  if (joined.length > GUARD_MAX) return undefined;
  const pieces = scrub(joined, { ...guard, keepLines: true }).text.split("\n");
  // each line knows how many pieces are its own: a readable line may hold line breaks
  const counts = block.map((l) => l.split("\n").length);
  if (pieces.length !== counts.reduce((a, b) => a + b, 0)) return undefined;
  const out: string[] = [];
  let at = 0;
  counts.forEach((n, i) => {
    const index = first + i;
    if (index >= from && index < to) {
      const safe = pieces.slice(at, at + n).join("\n");
      out.push(looksLikeOrders(lines[index]!) || looksLikeOrders(safe) ? HELD_LINE : safe);
    }
    at += n;
  });
  return out;
}

/** A line of at most `max` characters; with `at`, the part around that position. Only for text that is already safe. */
export function cutLine(line: string, max: number, at?: number): string {
  if (line.length <= max) return line;
  if (at === undefined) return `${line.slice(0, max - 1)}…`;
  const room = max - 2;
  const start = Math.max(0, Math.min(Math.floor(at - room / 2), line.length - room));
  return `${start > 0 ? "…" : ""}${line.slice(start, start + room)}${start + room < line.length ? "…" : ""}`;
}
