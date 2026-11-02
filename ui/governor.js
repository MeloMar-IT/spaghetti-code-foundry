import { h, svg, tableBox, timeAgo } from "./dom.js";

export const CAP_LABELS = { load: "Load governor", busy: "Busy mode (switched on)", "busy-apps": "Busy mode (a program runs)", limits: "Usage limits" };

const cores = (n) => `${Number(n).toFixed(1)} cores`;
const minutes = (ms) => {
  if (!(ms >= 60_000)) return "less than a minute";
  const min = Math.round(ms / 60_000);
  return min < 60 ? `${min} min` : min % 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min / 60} h`;
};
const clock = (iso) => String(iso).slice(11, 16);

/** A plain model of the texts of the card (no DOM): what the card says for a GET /api/governor answer. */
export function governorSummary(view) {
  const v = view ?? {};
  const out = {
    now: `${v.limit} of ${v.configured}`,
    caps: (v.caps ?? []).map((c) => ({ who: CAP_LABELS[c.who] ?? c.who, runs: c.runs, why: c.why })),
    notes: [],
    state: null,
    below: null,
  };
  if (v.status === "none") out.state = "The governor has no result. Install it with `scf governor install`.";
  else if (v.status === "old") out.state = `The last check was ${timeAgo(v.at)}. Measurements are not shown. Limits are shown as they are stored; each ends at its own time.`;
  if (v.cap) out.notes.push(`Load governor: ${v.cap.runs} at once${v.cap.why ? ` (${v.cap.why})` : ""}`);
  if (v.tests) out.notes.push("Test runs: 1 at once");
  if (v.workers) out.notes.push(`Test workers: at most ${v.workers} per test run`);
  if (v.paused) out.notes.push(`Test runs beyond the first are paused since ${clock(v.paused)}`);
  const hs = v.history;
  if (hs?.belowMs > 0) out.below = `Below ${v.configured} for ${minutes(hs.belowMs)} in the last 24 hours (lowest ${hs.lowest}): ${hs.reasons.slice(0, 3).map((r) => `${r.why} ${minutes(r.ms)}`).join(", ")}`;
  return out;
}

/** The step chart of the runs at once over the window of `history`. */
export function capChart(history, configured) {
  const W = 720, H = 140, L = 44, B = 22, T = 10, R = 8;
  const t0 = Date.parse(history.since);
  const t1 = Date.parse(history.now);
  const span = Math.max(1, t1 - t0);
  const x = (t) => L + ((Math.min(t1, Math.max(t0, t)) - t0) / span) * (W - L - R);
  const max = Math.max(1, configured);
  const y = (v) => T + (H - T - B) * (1 - Math.min(max, Math.max(0, v)) / max);
  let d = `M${L},${y(history.start)}`;
  for (const s of history.steps) d += ` H${x(Date.parse(s.at)).toFixed(1)} V${y(s.runs)}`;
  d += ` H${W - R}`;
  const grid = [0, max].map((v) => [
    svg("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), class: "grid-line" }),
    svg("text", { x: L - 6, y: y(v) + 4, "text-anchor": "end", class: "axis" }, String(v)),
  ]);
  const labels = [[0, "start", "24 h ago"], [0.5, "middle", "12 h ago"], [1, "end", "now"]].map(([f, anchor, text]) =>
    svg("text", { x: L + f * (W - L - R), y: H - 6, "text-anchor": anchor, class: "axis" }, text));
  return h("div", { class: "chart" },
    svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `Runs at once over the last 24 hours, between 0 and ${configured}` },
      grid, svg("path", { d, class: "cap-line" }), labels));
}

/** Every step of the chart as a table row: time, runs at once and why. */
export function capList(history, configured) {
  const rows = [{ at: history.since, runs: history.start, why: "at the start of the 24 hours" }, ...history.steps];
  return h("details", {}, h("summary", {}, "Show as list"),
    tableBox(h("table", { class: "table compact" },
      h("caption", { class: "sr-only" }, `Runs at once over the last 24 hours (configured: ${configured})`),
      h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Time"), h("th", { scope: "col" }, "Runs at once"), h("th", { scope: "col" }, "Why"))),
      h("tbody", {}, rows.map((s) => h("tr", {}, h("td", { class: "mono" }, String(s.at).slice(0, 16).replace("T", " ")), h("td", {}, String(s.runs)), h("td", { class: "muted" }, s.why ?? "")))))));
}

const table = (caption, heads, rows) => tableBox(h("table", { class: "table compact" },
  h("caption", { class: "sr-only" }, caption),
  h("thead", {}, h("tr", {}, heads.map((t) => h("th", { scope: "col" }, t)))),
  h("tbody", {}, rows)));

/** The content of the Load governor card. No buttons; every name is a text node. */
export function governorBody(view) {
  const s = governorSummary(view);
  const parts = [h("p", {}, `Runs at once now: ${s.now}`)];
  if (s.state) parts.push(h("p", { class: "muted" }, s.state));
  if (s.caps.length) parts.push(h("ul", {}, s.caps.map((c) => h("li", {}, `${c.who}: ${c.runs} at once`, c.why ? h("span", { class: "muted" }, ` · ${c.why}`) : null))));
  else parts.push(h("p", { class: "muted" }, "No cap is set: runs are as configured."));
  if (s.notes.length) parts.push(h("ul", {}, s.notes.map((n) => h("li", {}, n))));
  const v = view;
  if (v.status === "ok") {
    if (v.capacity) parts.push(h("p", {}, `Free capacity: ${cores(v.capacity.free)} of ${v.capacity.cores} (${v.capacity.reserve} kept for other programs)`, v.capacity.fit !== undefined ? ` · ${v.capacity.fit} run${v.capacity.fit === 1 ? "" : "s"} fit` : ""));
    else parts.push(h("p", { class: "muted" }, "Free capacity: not measured."));
    if (v.other) {
      parts.push(h("p", {}, `Other programs: ${cores(v.other.cores)}`));
      if (v.other.top.length) parts.push(table("The programs that use the most", ["Program", "Cores"], v.other.top.map((p) => h("tr", {}, h("td", {}, p.program), h("td", { class: "mono" }, p.cores.toFixed(1))))));
    } else parts.push(h("p", { class: "muted" }, "Other programs: not measured."));
    if (v.foundry) parts.push(h("p", {}, `The Foundry: ${cores(v.foundry.cores)} (tests ${v.foundry.tests.toFixed(1)}, server ${v.foundry.server.toFixed(1)})`));
  }
  const hs = v.history;
  if (hs) {
    if (s.below) parts.push(h("p", {}, s.below));
    if (!hs.steps.length && hs.start >= v.configured) parts.push(h("p", { class: "muted" }, "No changes in the last 24 hours."));
    else parts.push(capChart(hs, v.configured), capList(hs, v.configured));
  }
  return h("div", {}, parts);
}
