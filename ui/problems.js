import { api } from "./api.js";
import { h, mount, toast } from "./dom.js";
import { mutesTable, muteForm, PAGE, storyCell, untilText } from "./monitor.js";

const when = (iso) => new Date(iso).toLocaleString();
const SEVERITY = { critical: "critical", major: "major", minor: "minor" };

/** The words for the keys of a detector's thresholds. */
const THRESHOLD_WORDS = {
  resumes: "resumes",
  within_minutes: "within minutes",
  within_hours: "within hours",
  checks: "checks in a row",
  percent: "percent",
  intervals: "intervals",
  runs: "runs",
  extra_minutes: "extra minutes",
  no_timeout_minutes: "minutes without a timeout",
  issues: "different issues",
  minutes: "minutes",
  hours: "hours",
  failures: "failures in a row",
  factor: "times the usual time",
  times: "times",
};
export const thresholdLabel = (key) => THRESHOLD_WORDS[key] ?? String(key).replaceAll("_", " ");

/** The one sentence at the top: whether the monitor runs, its bug stories, its last check, the stories of today and the circuit breaker. */
export function monitorSentence(m) {
  const stories = {
    on: m.reportTo === false ? "on, but no repository is set (monitor.report_to)" : "on",
    off: `off since ${m.since ? when(m.since) : "?"}`,
    quiet: `quiet until ${m.until ? when(m.until) : "?"} after the restart`,
    unreadable: "stopped (the state file monitor-guard.json cannot be read)",
    breaker: `stopped by the circuit breaker since ${m.since ? when(m.since) : "?"}`,
  }[m.state] ?? String(m.state);
  const last = m.lastCheck
    ? `it last checked at ${when(m.lastCheck)}${m.running === false ? " (since the server started)" : ""}`
    : "it has not checked since the server started";
  const n = m.madeToday ?? 0;
  const count = `it made ${n} bug ${n === 1 ? "story" : "stories"} today${m.perDay !== undefined ? ` (on its own at most ${m.perDay} a day)` : ""}`;
  const why = m.breaker?.open ? m.breaker.why : m.state === "breaker" ? m.why : undefined;
  const breaker = m.breaker?.open || m.state === "breaker" ? `the circuit breaker is open${why ? ` (${why})` : ""}` : "the circuit breaker is closed";
  return `The monitor is ${m.running === false ? "not running" : "running"}; bug stories are ${stories}; ${last}; ${count}; ${breaker}.`;
}

/** What a finding's state says, in plain words. */
export function stateText(f) {
  const n = f.story?.issue;
  switch (f.state) {
    case "seen": return "seen, no story yet";
    case "waiting": return `bug story #${n} is waiting`;
    case "building": return `bug story #${n} is being built`;
    case "fixed-watching": return "fixed, watching";
    case "came-back": return "came back";
    case "needs-you": return "needs you";
    case "muted": return f.mute ? `muted ${untilText(f.mute.until)}: ${f.mute.reason}` : "muted (the story was closed as not planned)";
    case "gone": return "gone";
    default: return String(f.state ?? "");
  }
}

/** The label of "Make a story now", and whether it works. */
export function storyButton(m) {
  if (m.running === false) return { label: "Make a story now (the monitor is not running)", enabled: false };
  if (m.state === "off" || m.state === "unreadable") return { label: "Make a story now (the monitor is off)", enabled: false };
  if (m.reportTo === false) return { label: "Make a story now (no repository is set)", enabled: false };
  return { label: "Make a story now", enabled: true };
}

let shown = PAGE;
const openIds = new Set();

const act = async (fn, ok, reload) => {
  try {
    const r = await fn();
    const text = ok?.(r);
    if (text) toast(text);
  } catch (e) {
    toast(e.message, "error");
  }
  await reload();
};

function switchRow(m, reload) {
  const wantOn = m.state === "off" || m.state === "unreadable" || m.state === "breaker";
  const click = async () => {
    if (m.state === "unreadable" && !confirm("The state file cannot be read. Switching on keeps it as monitor-guard.json.broken and starts a fresh one. Go on?")) return;
    await act(() => (wantOn ? api.monitorOn() : api.monitorOff()), () => (wantOn ? "The monitor is on" : "The monitor is off"), reload);
  };
  const isOn = !wantOn && m.running !== false;
  return h("div", {},
    h("div", { class: "row" },
      h("span", { class: isOn ? "status ok" : "status bad" }, monitorSentence(m)),
      h("span", { class: "spacer" }),
      h("button", { class: "small", onClick: click }, wantOn ? "Switch the monitor on" : "Switch the monitor off"),
      h("button", { class: "small", title: "Reload", onClick: reload }, "↻")),
    h("p", { class: "muted flush mt-4" }, "While it is off the monitor still records problems, but makes no bug story and writes no comment."));
}

function detailRow(f, cache, cols) {
  const cell = h("td", { colspan: cols }, h("span", { class: "muted" }, "Loading…"));
  if (!cache.has(f.id)) cache.set(f.id, api.monitorFinding(f.id));
  cache.get(f.id).then((d) => {
    const story = (s) => {
      const link = typeof s.url === "string" && s.url.startsWith("https://")
        ? h("a", { href: s.url, target: "_blank", rel: "noopener noreferrer" }, `#${s.issue}`)
        : h("span", {}, `#${s.issue}`);
      return h("span", {}, link, s.current ? "" : " (earlier)", " ");
    };
    cell.replaceChildren(
      d.evidence?.length ? h("pre", { class: "mono" }, d.evidence.join("\n")) : h("p", { class: "muted" }, "No evidence was recorded."),
      h("div", {}, "Bug stories: ", d.stories?.length ? d.stories.map(story) : h("span", { class: "muted" }, "No bug story yet.")),
      h("div", {}, "Runs: ", d.runs?.length
        ? d.runs.map((r) => h("span", {}, h("a", { href: `#/runs/${r.id}` }, r.id), ` (${r.status}${r.startedAt ? `, ${when(r.startedAt)}` : ""}) `))
        : h("span", { class: "muted" }, "No run yet.")));
  }, (e) => cell.replaceChildren(h("span", { class: "status bad" }, e.message)));
  return h("tr", {}, cell);
}

function findingButtons(f, m, reload, redraw) {
  const buttons = [];
  const open = openIds.has(f.id);
  buttons.push(h("button", { class: "small", onClick: () => { if (open) openIds.delete(f.id); else openIds.add(f.id); redraw(); } }, open ? "Hide" : "Details"));
  if (f.state === "gone" || (f.state === "muted" && !f.mute)) return buttons;
  if (f.state === "muted") {
    const label = f.mute.kind === "detector" ? `End mute of detector ${f.detector}` : "End mute";
    buttons.push(h("button", { class: "small", onClick: () => act(() => api.unmuteMonitor(f.mute.id), () => "Mute ended", reload) }, label));
    return buttons;
  }
  if (f.state === "seen") {
    const b = storyButton(m);
    buttons.push(h("button", { class: "small", disabled: !b.enabled, onClick: () => act(() => api.monitorStory(f.id), (r) => (r.story?.made ? `Bug story #${r.story.issue} made` : `Bug story #${r.story?.issue} exists already`), reload) }, b.label));
  }
  if (f.state === "needs-you") {
    buttons.push(h("button", { class: "small", onClick: () => act(() => api.retryMonitor(f.id), () => "The monitor may try again", reload) }, "Try again"));
  }
  buttons.push(
    h("button", { class: "small", onClick: async () => { if (await muteForm({ finding: f.id }, m.detectors)) await reload(); } }, "Mute"),
    h("button", { class: "small", onClick: async () => { if (await muteForm({ finding: f.id }, m.detectors, { notProblem: true })) await reload(); } }, "This is not a problem"));
  return buttons;
}

function findingsTable(m, reload, redraw, cache) {
  const rows = m.findings.slice(0, shown);
  const body = rows.flatMap((f) => {
    const row = h("tr", {},
      h("td", {}, SEVERITY[f.severity] ?? f.severity),
      h("td", {}, f.summary, h("div", { class: "muted text-xs" }, f.detector)),
      h("td", {}, when(f.firstSeen)),
      h("td", {}, `seen in ${f.count} ${f.count === 1 ? "check" : "checks"}`),
      h("td", {}, stateText(f)),
      h("td", {}, storyCell(f.story, f.needsYou)),
      h("td", {}, findingButtons(f, m, reload, redraw)));
    return openIds.has(f.id) ? [row, detailRow(f, cache, 7)] : [row];
  });
  const left = m.findings.length - rows.length;
  return h("div", {},
    h("table", { class: "table compact" },
      h("thead", {}, h("tr", {}, ["Severity", "What", "Since", "How often", "State", "Story", ""].map((c) => h("th", {}, c)))),
      h("tbody", {}, body)),
    left > 0 ? h("button", { class: "small", onClick: () => { shown += PAGE; redraw(); } }, `Show ${Math.min(PAGE, left)} more`) : null);
}

function detectorsTable(m, reload) {
  const rows = (m.detectors ?? []).map((d) => {
    const mute = (m.mutes ?? []).find((x) => x.kind === "detector" && x.detector === d.name);
    const err = h("span", { class: "status bad" });
    const inputs = Object.entries(d.thresholds ?? {}).map(([k, v]) => ({ key: k, el: h("input", { type: "number", step: "any", value: String(v), class: "w-80", "aria-label": `${d.name} ${thresholdLabel(k)}` }), label: thresholdLabel(k) }));
    const save = async () => {
      err.textContent = "";
      const values = {};
      for (const i of inputs) {
        const text = String(i.el.value ?? "").trim();
        const n = Number(text);
        if (!text || !Number.isFinite(n)) {
          err.textContent = "Give a number.";
          return;
        }
        values[i.key] = n;
      }
      try {
        const config = await api.config();
        config.monitor = { ...config.monitor, [d.key]: { ...config.monitor?.[d.key], ...values } };
        await api.saveConfig(config);
        toast("Threshold saved");
        await reload();
      } catch (e) {
        err.textContent = e.message;
      }
    };
    return h("tr", {},
      h("td", {}, d.name),
      h("td", {}, d.description),
      h("td", {}, inputs.length ? h("div", {}, inputs.map((i) => h("label", { class: "field" }, h("span", {}, i.label), i.el)), h("button", { class: "small", onClick: save }, "Save"), err) : h("span", { class: "muted" }, "none")),
      h("td", {}, d.lastFound ? when(d.lastFound) : "nothing in the last 30 days"),
      h("td", {}, mute ? `muted ${untilText(mute.until)}: ${mute.reason}` : ""),
      h("td", {}, mute
        ? h("button", { class: "small", onClick: () => act(() => api.unmuteMonitor(mute.id), () => "Mute ended", reload) }, "End mute")
        : h("button", { class: "small", onClick: async () => { if (await muteForm({ detector: d.name }, m.detectors)) await reload(); } }, "Mute")));
  });
  return h("table", { class: "table compact" },
    h("thead", {}, h("tr", {}, ["Detector", "What it looks for", "Threshold", "Last found", "Muted", ""].map((c) => h("th", {}, c)))),
    h("tbody", {}, rows));
}

/** The Problems page: what the monitor found, what happens to it, and the detectors. For admins. */
export async function renderProblems(main) {
  const reload = () => renderProblems(main);
  let m;
  try {
    m = await api.monitor();
  } catch (e) {
    mount(main, h("h1", {}, "Problems"), h("p", { class: "status bad" }, e.message));
    return;
  }
  shown = PAGE;
  const cache = new Map();
  const list = h("div", {});
  const redraw = () => list.replaceChildren(
    m.findingsUnreadable ? h("p", { class: "status bad" }, "The findings file of the monitor cannot be read, so the list is not shown. The next check keeps it as monitor-findings.json.broken and starts a new one.") : null,
    m.findings?.length ? findingsTable(m, reload, redraw, cache) : m.findingsUnreadable ? null : h("p", { class: "muted" }, "No findings."));
  redraw();
  mount(main,
    h("h1", {}, "Problems"),
    switchRow(m, reload),
    list,
    h("details", {}, h("summary", {}, `Mutes (${(m.mutes ?? []).length})`), (m.mutes ?? []).length ? mutesTable(m, reload) : h("p", { class: "muted" }, "No mutes.")),
    h("h2", {}, "Detectors"),
    detectorsTable(m, reload));
}
