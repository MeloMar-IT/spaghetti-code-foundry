// The Metrics page (/metrics/): reads /metrics.json (the public totals of the receiver, #890) in the browser and shows them.
// Pure functions that return HTML strings, so Node can test them without a DOM. Every text from the data is escaped.
// Charts are inline SVG coloured only with the site's CSS variables, and each one has a table view.

export const PERIODS = [
  { id: "30d", label: "Last 30 days" },
  { id: "90d", label: "Last 90 days" },
  { id: "all", label: "All time" },
];

/** The ids of the numbers whose definition is in the `measures` of website/content/metrics.md. */
export const MEASURE_IDS = [
  "runsStarted", "runsEnded", "workItemsDelivered", "pullRequestsDelivered", "runDuration", "stepTime", "issuesSplit", "partsPerSplit",
  "stepRetries", "repeatedSteps", "stoppedWithQuestions", "questionsAnsweredAutomatically", "costTotal", "costByModel", "costByStep",
  "modelFallbacks", "sharing", "installsPerWeek", "bySource", "byFlow",
];
/** The outcome measures shown, with their definition from OUTCOME_DEFINITIONS (website/content/outcome-definitions.json). */
export const OUTCOME_IDS = [
  "issue_to_pr_time", "approval_latency", "first_pass_test_success", "merge_rate", "evidence_completeness", "rework", "resume_count",
  "policy_blocks", "cost_per_successful_run",
];

const DAY_MS = 86_400_000;
const FETCH_TIMEOUT_MS = 10_000;
const NO_NUMBERS = "No numbers are shared yet. They appear here once an install shares its metrics.";
const FAILED = "The numbers cannot be loaded right now. Please try again later.";

// ---------- small helpers ----------
export const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const isHist = (v) => isObj(v) && Array.isArray(v.counts) && typeof v.sum === "number";
const dayMs = (day) => Date.parse(`${day}T00:00:00.000Z`);
const dayText = (ms) => new Date(ms).toISOString().slice(0, 10);
const isDay = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(dayMs(s)) && dayText(dayMs(s)) === s;

/** The Monday (UTC) of the week of a day, as YYYY-MM-DD; the same as the receiver. */
export function weekOf(day) {
  const ms = dayMs(day);
  return dayText(ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY_MS);
}

export function countText(n) {
  return n === undefined ? "–" : Number.isInteger(n) ? n.toLocaleString("en-US") : (Math.round(n * 10) / 10).toLocaleString("en-US");
}
export function shareText(x) {
  return x === undefined ? "–" : `${Math.round(x * 1000) / 10}%`;
}
export function usdText(x) {
  return x === undefined ? "–" : `$${x < 10 ? x.toFixed(2) : Math.round(x).toLocaleString("en-US")}`;
}
export function durationText(ms) {
  if (ms === undefined) return "–";
  const one = (v, unit) => `${Math.round(v * 10) / 10} ${unit}`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return one(ms / 1000, "s");
  if (ms < 3_600_000) return one(ms / 60_000, "min");
  if (ms < DAY_MS) return one(ms / 3_600_000, "h");
  return one(ms / DAY_MS, "days");
}

// ---------- checking the data ----------
const validTotals = (t) => isObj(t) && num(t.installs) !== undefined && ["changes", "speed", "splits", "rework", "quality", "cost", "use"].every((s) => t[s] === undefined || isObj(t[s]));
const validHist = (h, n) => !isHist(h) || (h.counts.length === n && h.counts.every((c) => Number.isFinite(c) && c >= 0));
/** True when `v` is a metrics.json of version 1 with the fields the page reads. Optional numbers may be missing. */
export function isMetrics(v) {
  if (!isObj(v) || v.version !== 1 || !Number.isFinite(Date.parse(v.generatedAt))) return false;
  const e = v.edges;
  if (!isObj(e) || !Array.isArray(e.durationMs) || !Array.isArray(e.partsPerSplit)) return false;
  if (![...e.durationMs, ...e.partsPerSplit].every((n) => Number.isFinite(n))) return false;
  if (!Array.isArray(v.days) || !Array.isArray(v.weeks)) return false;
  if (!v.days.every((d) => isObj(d) && isDay(d.day) && validTotals(d)) || !v.weeks.every((w) => isObj(w) && isDay(w.week) && validTotals(w))) return false;
  const sp = (t) => t.speed ?? {};
  const okHists = (t) =>
    ["runDuration", "issueToPullRequest", "approvalLatency"].every((k) => validHist(sp(t)[k], e.durationMs.length + 1)) &&
    Object.values(sp(t).stepTime ?? {}).every((h) => validHist(h, e.durationMs.length + 1)) &&
    validHist(t.splits?.partsPerSplit, e.partsPerSplit.length + 1);
  if (![...v.days, ...v.weeks].every(okHists)) return false;
  const s = v.sharing;
  return s === undefined || (isObj(s) && isDay(s.since) && num(s.installs) !== undefined && num(s.accounts) !== undefined);
}

// ---------- adding up ----------
const RATIOS = { firstPassTests: "passed", mergeRate: "delivered", evidence: "complete" };
const SKIP = new Set(["installs", "accounts", "share", "median", "count"]);

function addInto(into, from) {
  for (const [k, v] of Object.entries(from)) {
    if (SKIP.has(k)) continue;
    if (typeof v === "number") into[k] = (into[k] ?? 0) + v;
    else if (isHist(v)) {
      const h = (into[k] ??= { counts: v.counts.map(() => 0), sum: 0 });
      v.counts.forEach((c, i) => (h.counts[i] = (h.counts[i] ?? 0) + c));
      h.sum += v.sum;
    } else if (isObj(v)) addInto((into[k] = isObj(into[k]) ? into[k] : {}), v);
  }
}
/**
 * The sum of a list of daily or weekly totals: numbers and histograms add up, shares are worked out again from the sums.
 * `installs` and `accounts` are not summed (the same install reports on many days); `median` is worked out when it is shown.
 */
export function sumTotals(list) {
  const out = {};
  for (const t of list) addInto(out, t);
  for (const [key, part] of Object.entries(RATIOS)) {
    const q = out.quality?.[key];
    if (q && q.counted > 0 && typeof q[part] === "number") q.share = Math.round((q[part] / q.counted) * 10_000) / 10_000;
  }
  return out;
}

/**
 * A quantile (0..1) of a histogram over fixed edges. A time histogram is interpolated inside its bucket; a discrete one
 * gives the lower edge. `open` is true when the value is in the last bucket, which has no upper edge. For q = 0.5 this
 * is the receiver's median.
 */
export function quantile(counts, edges, q, discrete) {
  const total = counts.reduce((a, n) => a + n, 0);
  if (!(total > 0)) return undefined;
  const target = total * q;
  let before = 0;
  for (let i = 0; i < counts.length; i++) {
    const n = counts[i];
    if (n > 0 && before + n >= target) {
      const lower = i === 0 ? 0 : edges[i - 1];
      if (i >= edges.length) return { value: lower, open: true };
      return { value: discrete ? lower : Math.round(lower + ((target - before) / n) * (edges[i] - lower)), open: false };
    }
    before += n;
  }
  return undefined;
}

/**
 * The numbers of a period. 30 days: the daily totals of the 30 days up to `generatedAt`, grouped by week for the charts.
 * 90 days: the weeks that start within the last 90 days (a week that starts earlier is left out, because daily detail
 * exists only for 35 days). All time: every week the receiver holds (it keeps reports for 400 days).
 */
export function periodOf(metrics, periodId) {
  const today = dayMs(metrics.generatedAt.slice(0, 10));
  let weeks;
  let list;
  if (periodId === "30d") {
    const from = dayText(today - 29 * DAY_MS);
    const days = metrics.days.filter((d) => d.day >= from && d.day <= dayText(today));
    const by = new Map();
    for (const d of days) by.set(weekOf(d.day), [...(by.get(weekOf(d.day)) ?? []), d]);
    weeks = [...by].sort(([a], [b]) => (a < b ? -1 : 1)).map(([week, ds]) => ({ week, totals: sumTotals(ds) }));
    list = days;
    return { totals: days.length ? sumTotals(days) : null, weeks, from: days[0]?.day, to: days[days.length - 1]?.day, installWeeks: [] };
  }
  const from = periodId === "90d" ? dayText(today - 89 * DAY_MS) : "";
  list = metrics.weeks.filter((w) => w.week >= from).sort((a, b) => (a.week < b.week ? -1 : 1));
  weeks = list.map((w) => ({ week: w.week, totals: sumTotals([w]) }));
  return { totals: list.length ? sumTotals(list) : null, weeks, from: list[0]?.week, to: list[list.length - 1]?.week, installWeeks: list.map((w) => ({ week: w.week, installs: w.installs })) };
}

// ---------- building blocks ----------
const stat = (label, value, definition, extra = "") =>
  `<div class="metric"><dt>${esc(label)}</dt><dd class="value">${value}</dd><dd class="def">${esc(definition ?? "")}${extra ? ` <span class="excl">${esc(extra)}</span>` : ""}</dd></div>`;

let chartCount = 0;
function figure(title, rows, svg) {
  const id = `chart-${++chartCount}`;
  const body = rows.map((r) => `<tr><th scope="row">${esc(r.label)}</th><td>${esc(r.text)}</td></tr>`).join("");
  return `<figure class="chart" id="${id}"><figcaption>${esc(title)}</figcaption>${svg}<details class="chart-table"><summary>Show as table</summary><table><caption class="sr-only">${esc(title)}</caption><thead><tr><th scope="col">Name</th><th scope="col">Value</th></tr></thead><tbody>${body}</tbody></table></details></figure>`;
}

/** Vertical bars, one per week. rows: [{ label, value, text }] */
function weekChart(title, rows) {
  rows = rows.filter((r) => num(r.value) !== undefined);
  if (!rows.length) return "";
  const W = 600, H = 180, top = 18, bottom = 28, max = Math.max(...rows.map((r) => r.value), 1);
  const slot = W / rows.length, bw = Math.min(40, slot * 0.7);
  const bars = rows
    .map((r, i) => {
      const h = Math.round(((H - top - bottom) * r.value) / max);
      const x = Math.round(i * slot + (slot - bw) / 2);
      return `<rect class="bar" x="${x}" y="${H - bottom - h}" width="${Math.round(bw)}" height="${h}"><title>${esc(`${r.label}: ${r.text}`)}</title></rect><text class="value-label" x="${Math.round(x + bw / 2)}" y="${H - bottom - h - 4}" text-anchor="middle">${esc(r.text)}</text>${rows.length <= 14 || i % 2 === 0 ? `<text class="label" x="${Math.round(x + bw / 2)}" y="${H - 8}" text-anchor="middle">${esc(r.label.slice(5))}</text>` : ""}`;
    })
    .join("");
  const svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${title}, per week (week starting)`)}"><line class="axis" x1="0" y1="${H - bottom}" x2="${W}" y2="${H - bottom}"/>${bars}</svg>`;
  return figure(`${title} (per week, week starting)`, rows, svg);
}

/** Horizontal bars, one per name. rows: [{ label, value, text }] */
function barList(title, rows) {
  rows = rows.filter((r) => num(r.value) !== undefined).sort((a, b) => b.value - a.value || (a.label < b.label ? -1 : 1));
  if (!rows.length) return "";
  const W = 600, rowH = 24, labelW = 170, max = Math.max(...rows.map((r) => r.value), 1);
  const bars = rows
    .map((r, i) => {
      const w = Math.max(1, Math.round(((W - labelW - 90) * r.value) / max));
      const y = i * rowH;
      return `<text class="label" x="${labelW - 6}" y="${y + 16}" text-anchor="end">${esc(r.label)}</text><rect class="bar" x="${labelW}" y="${y + 3}" width="${w}" height="${rowH - 8}"><title>${esc(`${r.label}: ${r.text}`)}</title></rect><text class="value-label" x="${labelW + w + 6}" y="${y + 16}">${esc(r.text)}</text>`;
    })
    .join("");
  return figure(title, rows, `<svg viewBox="0 0 ${W} ${rows.length * rowH}" role="img" aria-label="${esc(title)}">${bars}</svg>`);
}

const section = (id, title, intro, stats, charts) =>
  `<section class="metrics-section" aria-labelledby="m-${id}"><h2 id="m-${id}">${esc(title)}</h2><p class="section-note">${esc(intro)}</p><dl class="metric-grid">${stats.join("")}</dl>${charts.join("")}</section>`;

// ---------- the page ----------
export function renderState(kind) {
  return `<p class="metrics-state">${kind === "none" ? NO_NUMBERS : FAILED}</p>`;
}

function periodNote(metrics, period, p) {
  const label = PERIODS.find((x) => x.id === period).label.toLowerCase();
  const generated = metrics.generatedAt.slice(0, 16).replace("T", " ");
  const range =
    period === "30d" ? `days ${p.from} to ${p.to}` : period === "90d" ? `weeks starting ${p.from} to ${p.to} (only whole weeks that start within 90 days)` : `weeks starting ${p.from} to ${p.to} (all the receiver keeps, up to 400 days)`;
  return `Showing ${label}: ${range}. Worked out ${generated} UTC.`;
}

/** The whole page content for one period, as HTML. */
export function renderMetrics(metrics, definitions, periodId = "30d") {
  if (!isMetrics(metrics)) return renderState("failed");
  if (!metrics.days.length && !metrics.weeks.length) return renderState("none");
  chartCount = 0;
  const period = PERIODS.some((x) => x.id === periodId) ? periodId : "30d";
  const sw = `<div class="metrics-switch" role="group" aria-label="Period">${PERIODS.map((x) => `<button type="button" data-period="${x.id}" aria-pressed="${x.id === period}">${esc(x.label)}</button>`).join("")}</div>`;
  const p = periodOf(metrics, period);
  if (!p.totals) return `${sw}<p class="metrics-state">There are no numbers for the period “${esc(PERIODS.find((x) => x.id === period).label)}” yet.</p>`;

  const t = p.totals;
  const { edges } = metrics;
  const outcome = (id) => (definitions.outcomes ?? []).find((o) => o.id === id);
  const odef = (id) => outcome(id)?.definition ?? "";
  const oexcl = (id) => outcome(id)?.exclusions ?? "";
  const mdef = (id) => definitions.measures?.[id]?.definition ?? "";
  const mlabel = (id, fallback) => definitions.measures?.[id]?.label ?? fallback;
  const olabel = (id) => outcome(id)?.label ?? id;
  const weekRows = (get, fmt = countText) => p.weeks.map((w) => ({ label: w.week, value: get(w.totals), text: fmt(get(w.totals)) }));
  const histOf = (h, e, discrete) => {
    if (!isHist(h)) return {};
    const total = h.counts.reduce((a, n) => a + n, 0);
    return { med: quantile(h.counts, e, 0.5, discrete), p90: quantile(h.counts, e, 0.9, discrete), mean: total > 0 ? h.sum / total : undefined };
  };
  const q = (x, fmt) => (x ? `${x.open ? "at least " : ""}${fmt(x.value)}` : "–");
  const timeStat = (label, def, h, extra, withMean) => {
    const s = histOf(h, edges.durationMs, false);
    const mean = withMean && s.mean !== undefined ? ` · mean ${durationText(s.mean)}` : "";
    return stat(label, `${esc(q(s.med, durationText))}<small> median · ${esc(q(s.p90, durationText))} 90th percentile${esc(mean)}</small>`, def, extra);
  };
  const c = t.changes ?? {}, sp = t.speed ?? {}, spl = t.splits ?? {}, rw = t.rework ?? {}, ql = t.quality ?? {}, co = t.cost ?? {}, us = t.use ?? {};
  const ended = c.runsEnded ?? {};
  const ratio = (k, id) => stat(olabel(id), esc(shareText(ql[k]?.share)) + (ql[k]?.counted !== undefined ? `<small> of ${countText(ql[k].counted)}</small>` : ""), odef(id), oexcl(id));
  const outcomeCount = (v, id) => stat(olabel(id), esc(countText(v)), odef(id), oexcl(id));
  const perCost = num(co.costUsd) !== undefined && num(ended.succeeded) > 0 ? co.costUsd / ended.succeeded : undefined;
  const names = (obj, valueOf, fmt = countText) => Object.entries(obj ?? {}).map(([label, v]) => ({ label, value: valueOf(v), text: fmt(valueOf(v)) }));
  const stepMedians = Object.entries(sp.stepTime ?? {}).flatMap(([label, h]) => {
    const m = isHist(h) ? quantile(h.counts, edges.durationMs, 0.5, false) : undefined;
    const p90 = isHist(h) ? quantile(h.counts, edges.durationMs, 0.9, false) : undefined;
    return m ? [{ label, value: m.value, text: `${q(m, durationText)} (90th percentile ${q(p90, durationText)})` }] : [];
  });
  const tokens = (v) => `${countText((v.tokensIn ?? 0) + (v.tokensOut ?? 0))} tokens${num(v.costUsd) !== undefined ? `, ${usdText(v.costUsd)}` : ""}`;
  // Bars are dollars only. A name without a cost gets no bar; it is listed in a sentence instead, so no chart mixes units.
  const cost = (obj, title) => {
    const known = Object.entries(obj ?? {}).filter(([, v]) => num(v?.costUsd) !== undefined);
    const unknown = Object.keys(obj ?? {}).filter((k) => num(obj[k]?.costUsd) === undefined);
    const rows = known.map(([label, v]) => ({ label, value: v.costUsd, text: `${usdText(v.costUsd)} (${tokens(v)})` }));
    const chart = barList(title, rows);
    const note = unknown.length ? `<p class="section-note">No cost is known for ${esc(unknown.join(", "))}; only the tokens are counted.</p>` : "";
    return chart + note;
  };
  const instWeeks = p.installWeeks.map((w) => ({ label: w.week, value: w.installs, text: countText(w.installs) }));
  const sh = metrics.sharing;
  const sections = [
    section("changes", "Changes", "What the Foundry delivered.", [
      stat(mlabel("runsStarted", "Runs started"), esc(countText(c.runsStarted)), mdef("runsStarted")),
      stat(mlabel("runsEnded", "Runs ended"), `${esc(countText(ended.succeeded))}<small> succeeded · ${esc(countText(ended.failed))} failed · ${esc(countText(ended.cancelled))} cancelled</small>`, mdef("runsEnded")),
      stat(mlabel("workItemsDelivered", "Work items delivered"), esc(countText(c.workItemsDelivered)), mdef("workItemsDelivered")),
      stat(mlabel("pullRequestsDelivered", "Pull requests delivered"), esc(countText(c.pullRequestsDelivered)), mdef("pullRequestsDelivered")),
    ], [
      weekChart("Runs started", weekRows((x) => num(x.changes?.runsStarted))),
      weekChart("Work items delivered", weekRows((x) => num(x.changes?.workItemsDelivered))),
      weekChart("Pull requests delivered", weekRows((x) => num(x.changes?.pullRequestsDelivered))),
    ]),
    section("speed", "Speed", "How long things take. Times are from histograms, so they are close, not exact.", [
      timeStat(mlabel("runDuration", "Run time"), mdef("runDuration"), sp.runDuration),
      timeStat(olabel("issue_to_pr_time"), odef("issue_to_pr_time"), sp.issueToPullRequest, oexcl("issue_to_pr_time")),
      timeStat(olabel("approval_latency"), odef("approval_latency"), sp.approvalLatency, oexcl("approval_latency"), true),
    ], [barList(`${mlabel("stepTime", "Time per built-in step")}: ${mdef("stepTime")}`, stepMedians)]),
    section("splits", "Splits", "How often a story was too big and was split.", [
      stat(mlabel("issuesSplit", "Stories split"), esc(countText(spl.issuesSplit)), mdef("issuesSplit")),
      (() => {
        const s = histOf(spl.partsPerSplit, edges.partsPerSplit, true);
        return stat(mlabel("partsPerSplit", "Parts per split"), esc(q(s.med, countText)) + `<small> median · ${esc(q(s.p90, countText))} 90th percentile</small>`, mdef("partsPerSplit"));
      })(),
    ], []),
    section("rework", "Rework", "How often work comes back or is repeated.", [
      outcomeCount(rw.reworkedAfterDelivery, "rework"),
      outcomeCount(rw.resumes, "resume_count"),
      stat(mlabel("stepRetries", "Step retries"), esc(countText(rw.stepRetries)), mdef("stepRetries")),
    ], [barList(`${mlabel("repeatedSteps", "Repeated steps")}: ${mdef("repeatedSteps")}`, names(rw.repeatedSteps, (v) => num(v)))]),
    section("quality", "Quality", "Whether the work is right and safe.", [
      ratio("firstPassTests", "first_pass_test_success"),
      ratio("mergeRate", "merge_rate"),
      ratio("evidence", "evidence_completeness"),
      outcomeCount(ql.policyBlocks, "policy_blocks"),
      stat(mlabel("stoppedWithQuestions", "Questions for a person"), esc(countText(ql.stoppedWithQuestions)), mdef("stoppedWithQuestions")),
      stat(mlabel("questionsAnsweredAutomatically", "Questions answered automatically"), esc(countText(ql.questionsAnsweredAutomatically)), mdef("questionsAnsweredAutomatically")),
    ], []),
    section("cost", "Cost and models", "Estimated cost from the token counts and a price table.", [
      stat(mlabel("costTotal", "Estimated cost"), esc(usdText(num(co.costUsd))), mdef("costTotal")),
      stat(olabel("cost_per_successful_run"), esc(usdText(perCost)), odef("cost_per_successful_run"), oexcl("cost_per_successful_run")),
      stat(mlabel("modelFallbacks", "Model fallbacks"), esc(countText(co.modelFallbacks)), mdef("modelFallbacks")),
    ], [
      cost(co.byModel, `${mlabel("costByModel", "Cost per model")}: ${mdef("costByModel")}`),
      cost(co.byStep, `${mlabel("costByStep", "Cost per built-in step")}: ${mdef("costByStep")}`),
    ]),
    section("use", "Use", "Who uses the Foundry and how.", [
      stat(mlabel("sharing", "Installs and accounts that share"), sh ? `${esc(countText(sh.installs))}<small> installs · ${esc(countText(sh.accounts))} accounts, since ${esc(sh.since)}</small>` : "–", mdef("sharing")),
    ], [
      weekChart(`${mlabel("installsPerWeek", "Installs per week")}: ${mdef("installsPerWeek")}`, instWeeks),
      barList(`${mlabel("bySource", "Runs per watcher source")}: ${mdef("bySource")}`, names(us.bySource, (v) => num(v))),
      barList(`${mlabel("byFlow", "Runs per built-in flow")}: ${mdef("byFlow")}`, names(us.byFlow, (v) => num(v))),
    ]),
  ];
  return `${sw}<p class="period-note">${esc(periodNote(metrics, period, p))}</p>${sections.join("")}`;
}

/** Loads /metrics.json and shows it in `root`. A 503 and every other failure give the "cannot be loaded" sentence. */
export async function start(root, definitions, fetchFn = fetch, timeoutMs = FETCH_TIMEOUT_MS) {
  let metrics = null;
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = setTimeout(() => ctl?.abort(), timeoutMs);
  try {
    const res = await fetchFn("/metrics.json", { credentials: "omit", cache: "no-cache", signal: ctl?.signal });
    if (res.ok) metrics = await res.json();
  } catch {
    metrics = null;
  } finally {
    clearTimeout(timer);
  }
  let period = "30d";
  const draw = () => {
    root.innerHTML = renderMetrics(metrics, definitions, period);
  };
  root.addEventListener("click", (ev) => {
    const b = ev.target?.closest?.("[data-period]");
    if (b && PERIODS.some((x) => x.id === b.dataset.period)) {
      period = b.dataset.period;
      draw();
    }
  });
  draw();
}

if (typeof document !== "undefined") {
  const root = document.getElementById("metrics-app");
  const defs = document.getElementById("metric-definitions");
  if (root && defs) void start(root, JSON.parse(defs.textContent));
}
