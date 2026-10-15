import { dayText, finishView, issueList, rangeText } from "./epics-model.js";

/** "2 h 10 min", "45 min", "3 days". The same words as durationText in ui/dashboard.js, which the user display must not load. */
export function durationText(ms) {
  if (!(ms >= 60_000)) return "less than a minute";
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return min % 60 ? `${hours} h ${min % 60} min` : `${hours} h`;
  const days = Math.round(ms / 86_400_000);
  return `${days} ${days === 1 ? "day" : "days"}`;
}

// The epic page's data work: texts, chart points and history lines. Pure: no DOM, no api; the time zone and "now" are
// parameters. The server decides every number and the forecast (GET repos/:id/epics/:issue); nothing here computes them.

const plural = (n, one, many) => (n === 1 ? one : many);
const validTime = (iso) => typeof iso === "string" && !Number.isNaN(Date.parse(iso));

/** The address of an epic's page: "#/epics/12?repo=acme%2Fapp". "#/epics" without an id. */
export function epicHref(repo, id) {
  if (id == null || id === "") return "#/epics";
  return `#/epics/${encodeURIComponent(id)}${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`;
}

/** The smallest of 1, 2 or 5 times a power of ten that is at least `v` (and at least 1). */
export function niceMax(v) {
  const x = Math.max(1, Number.isFinite(v) ? v : 1);
  const p = 10 ** Math.floor(Math.log10(x));
  for (const m of [1, 2, 5, 10]) if (m * p >= x) return m * p;
  return 10 * p;
}

const r1 = (n) => Math.round(n * 10) / 10;
/** The server's days are UTC days: the label shows that day as it is, in no other zone. */
const chartDay = (day, now) => dayText(`${day}T12:00:00Z`, { timeZone: "UTC", now });

/** The two lines of the chart as points in a viewBox, with ticks and labels. null for an empty or invalid series. */
export function chartPoints(series, { width = 720, height = 180, left = 36, bottom = 22, top = 10, now = new Date() } = {}) {
  const list = (Array.isArray(series) ? series : []).filter((p) => p && typeof p.day === "string" && Number.isFinite(p.stories) && Number.isFinite(p.done));
  if (!list.length) return null;
  const max = niceMax(Math.max(...list.map((p) => p.stories)));
  const n = list.length;
  const x = (i) => r1(n === 1 ? left + (width - left) / 2 : left + (i * (width - left)) / (n - 1));
  const y = (v) => r1(top + (height - top - bottom) * (1 - v / max));
  const line = (key) => list.map((p, i) => ({ x: x(i), y: y(p[key]), day: p.day, value: p[key] }));
  const path = (pts) => pts.map((p, i) => `${i ? "L" : "M"} ${p.x},${p.y}`).join(" ");
  const stories = line("stories");
  const done = line("done");
  const ticks = [0, ...(max % 2 === 0 ? [max / 2] : []), max].map((value) => ({ value, y: y(value) }));
  const step = Math.ceil(n / 6);
  const labels = [];
  list.forEach((p, i) => {
    if (i % step !== 0 && i !== n - 1) return;
    if (i !== n - 1 && n - 1 - i < step / 2 && n > 1) return; // too close to the last label
    labels.push({ x: x(i), text: chartDay(p.day, now), anchor: i === 0 && n > 1 ? "start" : i === n - 1 && n > 1 ? "end" : "middle" });
  });
  return { width, height, left, top, bottom, max, ticks, stories, done, labels, paths: { stories: path(stories), done: path(done) } };
}

/** The table next to the chart: [{ day, stories, done }], oldest first. */
export function chartRows(series, { now = new Date() } = {}) {
  return (Array.isArray(series) ? series : []).filter((p) => p && typeof p.day === "string")
    .map((p) => ({ day: chartDay(p.day, now), stories: p.stories, done: p.done }));
}

/** "2026-10-13" for an instant in a time zone; undefined when the time is not valid. */
export function localDay(iso, timeZone) {
  if (!validTime(iso)) return undefined;
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", ...(timeZone ? { timeZone } : {}) }).format(new Date(Date.parse(iso)));
}
const dayNumber = (ymd) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
};

/** How the forecast moved: one line per saved forecast, newest first: [{ text, range, change, kind }]. */
export function historyLines(history, { timeZone, now = new Date() } = {}) {
  const today = localDay(now.toISOString(), timeZone);
  const list = (Array.isArray(history) ? history : []).filter((e) => e && validTime(e.at));
  const sorted = list.map((e, i) => ({ e, i })).sort((a, b) => Date.parse(a.e.at) - Date.parse(b.e.at) || a.i - b.i).map((x) => x.e);
  const out = [];
  let before; // the expected day of the next older range entry
  for (const e of sorted) {
    const ago = dayNumber(today) - dayNumber(localDay(e.at, timeZone));
    const when = ago <= 0 ? "Today" : ago === 1 ? "Yesterday" : `${ago} days ago`;
    const range = e.kind === "range" && validTime(e.expected);
    if (!range) {
      out.push({ text: `${when}: too early to say`, range: "", change: "", kind: "too-early" });
      continue;
    }
    const day = localDay(e.expected, timeZone);
    let change = "";
    if (before !== undefined && before !== day) {
      const diff = dayNumber(day) - dayNumber(before);
      const n = Math.abs(diff);
      change = `${n} ${plural(n, "day", "days")} ${diff > 0 ? "later" : "earlier"}`;
    }
    before = day;
    out.push({
      text: `${when}: ${dayText(e.expected, { timeZone, now })}`,
      range: validTime(e.earliest) && validTime(e.latest) ? rangeText(e.earliest, e.latest, { timeZone, now }) : "",
      change, kind: "range",
    });
  }
  return out.reverse();
}

/** The critical path in words: { summary, path, now }. `stories` (the epic's whole list) tells an empty epic from one with no chain left. */
export function criticalPathView(chains, stories) {
  const list = Array.isArray(stories) ? stories : [];
  const byIssue = new Map(list.map((s) => [s.issue, s]));
  const nodes = chains?.nodes ?? [];
  if (!list.length && !nodes.length) return { summary: "No stories yet.", path: "", now: "" };
  if (!nodes.length) return { summary: "No chain to show: the stories of this epic were split or dropped.", path: "", now: "" };
  const cp = chains.criticalPath;
  if (!cp || !cp.remaining) {
    const all = list.length > 0 && list.every((s) => s.state === "done");
    return { summary: all ? "Nothing left on any chain: every story is done." : "Nothing left on any chain: the stories that can be built are done.", path: "", now: "" };
  }
  const nodeOf = new Map(nodes.map((n) => [n.issue, n]));
  const path = (cp.stories ?? []).map((n) => `#${n}${nodeOf.get(n)?.done ? " (done)" : ""}`).join(" → ");
  let now = "";
  if (cp.at != null) {
    const s = byIssue.get(cp.at);
    const title = s?.title ?? nodeOf.get(cp.at)?.title ?? "";
    now = `Now at #${cp.at}${title ? ` ${title}` : ""}: ${s?.words ?? nodeOf.get(cp.at)?.state ?? ""}${s?.status ? ` — ${s.status}` : ""}`;
  }
  return { summary: `The longest chain still to do has ${cp.remaining} ${plural(cp.remaining, "story", "stories")} left.`, path, now };
}

/** The list of stories in the order given: [{ issue, title, href, words, status, help, notes }]. */
export function storyItems(stories, chains, repo) {
  const nodeOf = new Map((chains?.nodes ?? []).map((n) => [n.issue, n]));
  return (Array.isArray(stories) ? stories : []).map((s) => {
    const node = nodeOf.get(s.issue);
    const notes = [];
    if (s.partOf != null) notes.push(`part of #${s.partOf}`);
    if (node?.dependsOn?.length) notes.push(`after ${issueList(node.dependsOn)}`);
    for (const n of node?.outside ?? []) notes.push(`also waits for #${n} (outside this epic)`);
    return { issue: s.issue, title: s.title, href: repo ? `https://github.com/${repo}/issues/${s.issue}` : "", words: s.words ?? s.state ?? "", status: s.status ?? "", help: s.help ?? "", notes };
  });
}

/** Sentences about cycles and about stories outside the epic. */
export function chainNotes(chains) {
  const out = [];
  for (const c of chains?.cycles ?? []) out.push(`${issueList(c)} depend on each other, so none of them can start first`);
  const outside = chains?.outside ?? [];
  if (outside.length) out.push(`Stories outside this epic that stories here wait for: ${outside.map((o) => `#${o.issue}${o.title ? ` ${o.title}` : ""}`).join(", ")}`);
  return out;
}

const windowLabel = (i) => (i === 0 ? "Last 24 hours" : `${i}–${i + 1} days ago`);

/** The pace and the median story time in words: { perDay, median, rows }. */
export function paceView(pace, medianStoryMs) {
  const days = pace?.days ?? [];
  const total = days.reduce((a, d) => a + (d.done || 0), 0);
  const perDay = !pace?.perDay || !total
    ? `No story was finished in the last ${days.length || 14} days.`
    : `About ${Math.round(pace.perDay * 10) / 10} ${plural(Math.round(pace.perDay * 10) / 10, "story", "stories")} a day over the last ${days.length} days (all epics of this repository).`;
  const median = typeof medianStoryMs === "number" && medianStoryMs > 0
    ? `A story takes about ${durationText(medianStoryMs)} from the start of its run to done (the median of the finished runs).`
    : "Not enough finished stories yet to say how long one takes.";
  const rows = [...days].reverse().map((d, i) => ({ label: windowLabel(i), done: d.done }));
  return { perDay, median, rows };
}

/** `finishView` plus what the forecast leaves out ("Leaves out: …"); "" when finished or when it leaves nothing out. */
export function forecastView(epic, opts = {}) {
  const v = finishView(epic, opts);
  const out = epic?.forecast?.leavesOut ?? [];
  return { ...v, leavesOut: v.kind !== "finished" && out.length ? `Leaves out: ${out.join(", ")}` : "" };
}
