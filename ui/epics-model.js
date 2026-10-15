import { ageText } from "./work-model.js";

// The Epics page's data work: texts, order and the choice of repository. Pure: no DOM, no api; the time zone and "now" are
// parameters. The server decides the numbers, the forecast and its reason; nothing here computes them.

/** The segments of the bar, in order. The words are those of STATE_WORDS in src/epics/model.ts (a test pins them). */
export const SEGMENTS = [
  { id: "done", word: "Done" },
  { id: "working", word: "Working" },
  { id: "waiting", word: "Waiting" },
  { id: "your_turn", word: "Your turn" },
  { id: "failed", word: "Failed" },
];
export const RANGE_DASH = " – ";

const upperFirst = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");
const plural = (n, one, many) => (n === 1 ? one : many);
const time = (iso) => {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? undefined : t;
};

/** The parts of a day in a time zone: { weekday, day, month, year }, or null when the time is not valid. */
function parts(iso, timeZone) {
  const t = time(iso);
  if (t === undefined) return null;
  const f = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", ...(timeZone ? { timeZone } : {}) });
  const out = {};
  for (const p of f.formatToParts(new Date(t))) out[p.type] = p.value;
  return out;
}
const yearOf = (now, timeZone) => parts(now.toISOString(), timeZone)?.year;

/** "Mon 12 Oct"; with the year when it is not the year of `now` in that zone. "" when the time is not valid. */
export function dayText(iso, { timeZone, now = new Date() } = {}) {
  const p = parts(iso, timeZone);
  if (!p) return "";
  const base = `${p.weekday} ${p.day} ${p.month}`;
  return p.year === yearOf(now, timeZone) ? base : `${base} ${p.year}`;
}

/** "Mon 12 – Tue 13 Oct" (same month), "Fri 30 Oct – Mon 2 Nov", with years when either is not this year. "" when a time is not valid. */
export function rangeText(earliest, latest, { timeZone, now = new Date() } = {}) {
  const a = parts(earliest, timeZone);
  const b = parts(latest, timeZone);
  if (!a || !b) return "";
  if (a.day === b.day && a.month === b.month && a.year === b.year) return dayText(earliest, { timeZone, now });
  const thisYear = yearOf(now, timeZone);
  const withYear = a.year !== thisYear || b.year !== thisYear;
  if (a.month === b.month && a.year === b.year && !withYear) return `${a.weekday} ${a.day}${RANGE_DASH}${b.weekday} ${b.day} ${b.month}`;
  const one = (p) => `${p.weekday} ${p.day} ${p.month}${withYear ? ` ${p.year}` : ""}`;
  return `${one(a)}${RANGE_DASH}${one(b)}`;
}

/** How long an epic took: "less than an hour", "5 hours", "3 days", "3 weeks". "" for a missing or negative time. */
export function tookText(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
  const hour = 3_600_000;
  const day = 24 * hour;
  if (ms < hour) return "less than an hour";
  if (ms < 48 * hour) { const n = Math.round(ms / hour); return `${n} ${plural(n, "hour", "hours")}`; }
  if (ms < 14 * day) { const n = Math.round(ms / day); return `${n} ${plural(n, "day", "days")}`; }
  const n = Math.round(ms / (7 * day));
  return `${n} ${plural(n, "week", "weeks")}`;
}

/** The expected finish of a row: { kind: "range" | "too-early" | "finished" | "none", text, reason, likely?, note? }. */
export function finishView(row, opts = {}) {
  const f = row?.forecast;
  if (row?.finished || f?.kind === "finished") {
    return { kind: "finished", text: row.finishedAt ? `Finished ${dayText(row.finishedAt, opts)}` : "Finished", reason: row.tookMs != null && tookText(row.tookMs) ? `Took ${tookText(row.tookMs)}` : "" };
  }
  if (f?.kind === "too-early") {
    return { kind: "too-early", text: "Too early to say", reason: upperFirst(String(f.text ?? "").replace(/^Too early to say:\s*/i, "")) };
  }
  if (f?.kind === "range") {
    const text = rangeText(f.earliest, f.latest, opts);
    if (text) {
      const out = { kind: "range", text, reason: f.text ?? "", likely: dayText(f.expected, opts) };
      if (f.leavesOut?.length) out.note = `Leaves out: ${f.leavesOut.join(", ")}`;
      return out;
    }
  }
  return { kind: "none", text: "—", reason: "" };
}

/** "3 of 10 done; Working 2, Waiting 4": only non-zero states besides done. */
export function progressText(counts, total) {
  if (!total) return "No stories yet";
  const rest = SEGMENTS.filter((s) => s.id !== "done" && counts?.[s.id] > 0).map((s) => `${s.word} ${counts[s.id]}`);
  const head = `${counts?.done ?? 0} of ${total} done`;
  return rest.length ? `${head}; ${rest.join(", ")}` : head;
}

/** The bar's parts: non-zero segments with `x` and `width` in 0..100, one after another. [] without stories. */
export function barSegments(counts, total) {
  if (!total) return [];
  const out = [];
  let x = 0;
  for (const s of SEGMENTS) {
    const count = counts?.[s.id] ?? 0;
    if (count <= 0) continue;
    const width = (count / total) * 100;
    out.push({ id: s.id, word: s.word, count, x, width });
    x += width;
  }
  return out;
}

/** "Stories: 21 at the start, 95 now (16 were split)". The server's text wins; else the same format from the numbers. */
export function growthSentence(row) {
  if (row?.growthText) return `Stories: ${row.growthText}`;
  const g = row?.growth;
  if (!g || typeof g.atStart !== "number" || typeof g.now !== "number") return "";
  const base = `${g.atStart} at the start, ${g.now} now`;
  const split = g.split > 0 ? ` (${g.split} ${g.split === 1 ? "was" : "were"} split)` : "";
  return `Stories: ${base}${split}`;
}

/** "#12", "#12 and #14", "#1, #2 and #3"; more than five: "#1, #2, #3, #4, #5 and 3 more". */
export function issueList(issues) {
  const list = (issues ?? []).map((n) => `#${n}`);
  if (list.length <= 1) return list.join("");
  if (list.length > 5) return `${list.slice(0, 5).join(", ")} and ${list.length - 5} more`;
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/** What blocks a row: [{ kind, text, help }]. The server's list is `row.holdUps`. */
export function blockTexts(ups) {
  return (ups ?? []).map((u) => {
    const n = u.waiting?.length ?? 0;
    const more = n ? `; ${n} more ${plural(n, "story waits for it", "stories wait for them")}` : "";
    return { kind: u.kind, text: `${upperFirst(u.status ?? "")}: ${issueList(u.issues)}${more}`, help: u.help ?? "" };
  });
}

/** The rows in order: open epics by expected finish, then the too early ones, then finished ones (newest first). Stable; the input stays. */
export function sortRows(rows) {
  const rank = (r) => (r.finished || r.forecast?.kind === "finished" ? 2 : r.forecast?.kind === "range" && time(r.forecast.expected) !== undefined ? 0 : 1);
  const key = (r) => (rank(r) === 0 ? time(r.forecast.expected) : rank(r) === 2 ? -(time(r.finishedAt) ?? 0) : 0);
  return rows.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || key(a.r) - key(b.r) || a.i - b.i).map((x) => x.r);
}

/** "Issues read just now" / "Issues read 12 min ago"; "" without fresh data. A cut read says the counts can be too low. */
export function freshText(data) {
  if (data?.state !== "fresh") return "";
  const age = data.ageMs < 60_000 ? "just now" : `${ageText(data.readAt, new Date(Date.parse(data.readAt) + data.ageMs)) || "a while"} ago`;
  const base = `Issues read ${age}`;
  return data.cut ? `${base}. Not every issue was read, so the counts can be too low` : base;
}

const REPO_OK = /^[\w.-]+\/[\w.-]+$/;

/** The repositories to choose from: [{ name, id }], without doubles (case ignored), by name. An admin's own record wins. */
export function repoChoices(rows, { admin = false, meId } = {}) {
  const by = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (typeof r?.github !== "string" || !REPO_OK.test(r.github) || r.id == null) continue;
    const k = r.github.toLowerCase();
    const mine = admin && meId != null && r.owner === meId;
    if (!by.has(k) || (mine && !by.get(k).mine)) by.set(k, { name: r.github, id: r.id, mine });
  }
  return [...by.values()].map(({ name, id }) => ({ name, id })).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

/** { choice } | { gone: true } (the wanted one is not there) | { none: true } (nothing wanted, several to choose from or no choices). */
export function pickRepo(choices, wanted) {
  if (wanted) {
    const c = choices.find((x) => x.name.toLowerCase() === String(wanted).toLowerCase());
    return c ? { choice: c } : { gone: true };
  }
  return choices.length === 1 ? { choice: choices[0] } : { none: true };
}
