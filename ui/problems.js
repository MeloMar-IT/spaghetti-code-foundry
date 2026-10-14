import { api, configVersion } from "./api.js";
import { h, mount, showError, tableBox, toast } from "./dom.js";
import { settingControl } from "./kit/forms.js";
import { confirmUnreadable, mutesTable, muteForm, PAGE, storyCell, untilText } from "./monitor.js";
import { emptyState, errorState, explainError, loadingState, staleNote } from "./states.js";

const when = (iso) => new Date(iso).toLocaleString();
const SEVERITY = { critical: "critical", major: "major", minor: "minor" };

/** The range of a number setting in words: "from 1 to 49", "at least 1", "at most 9", "more than 0"; "" for none. */
function rangeWords(d) {
  const parts = [];
  if (d.min !== undefined && d.max !== undefined) parts.push(`from ${d.min} to ${d.max}`);
  else if (d.min !== undefined) parts.push(`at least ${d.min}`);
  else if (d.max !== undefined) parts.push(`at most ${d.max}`);
  if (d.exclusiveMin !== undefined) parts.push(`more than ${d.exclusiveMin}`);
  return parts.join(" and ");
}

/** What is wrong with `value` for a number setting, as one sentence naming the field and the range; "" when it is fine (and for other kinds). */
export function settingProblem(d, value) {
  if (d.kind !== "number") return "";
  if (value === undefined && d.optional) return "";
  const range = rangeWords(d);
  const sp = range ? ` ${range}` : "";
  if (typeof value !== "number" || Number.isNaN(value)) return `"${d.label}" needs a number${sp}.`;
  if (d.integer && !Number.isInteger(value)) return `"${d.label}" must be a whole number${sp}.`;
  if (!Number.isFinite(value) || (d.min !== undefined && value < d.min) || (d.max !== undefined && value > d.max) || (d.exclusiveMin !== undefined && value <= d.exclusiveMin)) {
    return `"${d.label}" must be ${range || "a finite number"}.`;
  }
  return "";
}

const under = (m, prefix) => (m.settings ?? []).filter((s) => s.key.startsWith(prefix));
const pick = (m, key) => (m.settings ?? []).filter((s) => s.key === key);
const shownDefault = (s) => (s.default === undefined ? "not set" : String(s.default));
const REPO = /^[\w.-]+\/[\w.-]+$/;

/** Sets the dotted `key` in `obj`, creating the maps on the way; `undefined` removes it. */
function setAt(obj, key, value) {
  const parts = key.split(".");
  let cur = obj;
  for (const p of parts.slice(0, -1)) {
    if (cur[p] === null || typeof cur[p] !== "object") cur[p] = {};
    cur = cur[p];
  }
  const last = parts[parts.length - 1];
  if (value === undefined) delete cur[last];
  else cur[last] = value;
}

function readField(s, input) {
  const text = String(input.value ?? "").trim();
  if (!text) return undefined;
  return s.kind === "number" ? Number(text) : text;
}

function fieldProblem(s, v) {
  const p = settingProblem(s, v);
  if (p) return p;
  if (s.key === "monitor.report_to" && v !== undefined && !REPO.test(v)) return `"${s.label}" must be owner/repo.`;
  return "";
}

/** The fields of some settings with one Save and, for each, "Back to default". */
function settingsForm(list, m, reload, { saved = "Saved" } = {}) {
  if (!list.length) return null;
  const err = h("span", { class: "status bad", role: "alert" });
  const fields = list.map((s) => {
    const block = h("div", {}, settingControl(s, { value: s.value }));
    block.querySelector("input")?.setAttribute("aria-label", s.label);
    return { s, block, input: () => block.querySelector("input") };
  });
  const inputs = () => fields.map((f) => f.input());
  const show = (message, f) => showError(err, message, { fields: inputs(), field: f?.input() });
  const fail = (e) => show(e.message, fields.find((f) => e.message.includes(`"${f.s.key.split(".").pop()}"`)));
  const save = async () => {
    show("");
    const values = [];
    for (const f of fields) {
      const v = readField(f.s, f.input());
      const problem = fieldProblem(f.s, v);
      if (problem) return show(problem, f);
      values.push([f.s.key, v]);
    }
    try {
      const config = await api.config();
      for (const [k, v] of values) setAt(config, k, v);
      await api.saveConfig(config, configVersion(m));
      toast(saved);
      await reload();
    } catch (e) {
      fail(e);
    }
  };
  for (const f of fields) {
    const back = async () => {
      show("");
      try {
        await api.resetSetting(f.s.key, configVersion(m));
        toast(`${f.s.label} is back to its default`);
        await reload();
      } catch (e) {
        show(e.message, f);
      }
    };
    f.block.append(h("button", { class: "small", disabled: !f.s.stored, title: f.s.stored ? undefined : "Not set in config.yaml; the default is used", onClick: back }, `Back to default (${shownDefault(f.s)})`));
  }
  return h("div", {}, fields.map((f) => f.block), h("button", { class: "small", onClick: save }, "Save"), err);
}

/** Bug story limits, the repository and the circuit breaker. Nothing for an answer without `settings`. */
function monitorSettingsSection(m, reload) {
  if (!m.settings) return null;
  const stories = [...pick(m, "monitor.report_to"), ...under(m, "monitor.report_limits."), ...pick(m, "monitor.cooldown_minutes"), ...pick(m, "monitor.fix_wait_days")];
  const breaker = under(m, "monitor.breaker.");
  if (!stories.length && !breaker.length) return null;
  return h("section", {},
    h("h2", {}, "Monitor settings"),
    stories.length ? h("h3", {}, "Bug stories") : null,
    stories.length ? h("p", { class: "muted" }, "Bug stories with their evidence are written as issues to this repository; everyone who can read it sees them.") : null,
    settingsForm(stories, m, reload),
    breaker.length ? h("h3", {}, "Circuit breaker") : null,
    settingsForm(breaker, m, reload));
}

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
    if (m.state === "unreadable" && !(await confirmUnreadable())) return;
    await act(() => (wantOn ? api.monitorOn() : api.monitorOff()), () => (wantOn ? "The monitor is on" : "The monitor is off"), reload);
  };
  const isOn = !wantOn && m.running !== false;
  return h("div", {},
    h("div", { class: "row" },
      h("span", { class: isOn ? "status ok" : "status bad" }, monitorSentence(m)),
      h("span", { class: "spacer" }),
      h("button", { class: "small", onClick: click }, wantOn ? "Switch the monitor on" : "Switch the monitor off"),
      h("button", { class: "small", title: "Reload", "aria-label": "Reload", onClick: reload }, "↻")),
    h("p", { class: "muted flush mt-4" }, "While it is off the monitor still records problems, but makes no bug story and writes no comment."));
}

/** What the finding call returns, as nodes: the evidence, the bug stories and the runs. */
function findingDetail(d) {
  const story = (s) => {
    const link = typeof s.url === "string" && s.url.startsWith("https://")
      ? h("a", { href: s.url, target: "_blank", rel: "noopener noreferrer" }, `#${s.issue}`)
      : h("span", {}, `#${s.issue}`);
    return h("span", {}, link, s.current ? "" : " (earlier)", " ");
  };
  return [
    d.evidence?.length ? h("pre", { class: "mono" }, d.evidence.join("\n")) : h("p", { class: "muted" }, "No evidence was recorded."),
    h("div", {}, "Bug stories: ", d.stories?.length ? d.stories.map(story) : h("span", { class: "muted" }, "No bug story yet.")),
    h("div", {}, "Runs: ", d.runs?.length
      ? d.runs.map((r) => h("span", {}, h("a", { href: `#/runs/${r.id}` }, r.id), ` (${r.status}${r.startedAt ? `, ${when(r.startedAt)}` : ""}) `))
      : h("span", { class: "muted" }, "No run yet.")),
  ];
}

/** The buttons of a finding's page: { story, mute }. Which show depends on its state. */
function findingActions(f, m, reload) {
  const story = [];
  const mute = [];
  if (f.state === "gone" || (f.state === "muted" && !f.mute)) return { story, mute };
  if (f.state === "muted") {
    const label = f.mute.kind === "detector" ? `End mute of detector ${f.detector}` : "End mute";
    mute.push(h("button", { class: "small", onClick: () => act(() => api.unmuteMonitor(f.mute.id), () => "Mute ended", reload) }, label));
    return { story, mute };
  }
  if (f.state === "seen") {
    const b = storyButton(m);
    story.push(h("button", { class: "small", disabled: !b.enabled, onClick: () => act(() => api.monitorStory(f.id), (r) => (r.story?.made ? `Bug story #${r.story.issue} made` : `Bug story #${r.story?.issue} exists already`), reload) }, b.label));
  }
  if (f.state === "needs-you") {
    story.push(h("button", { class: "small", onClick: () => act(() => api.retryMonitor(f.id), () => "The monitor may try again", reload) }, "Try again"));
  }
  mute.push(
    h("button", { class: "small", onClick: async () => { if (await muteForm({ finding: f.id }, m.detectors)) await reload(); } }, "Mute"),
    h("button", { class: "small", onClick: async () => { if (await muteForm({ finding: f.id }, m.detectors, { notProblem: true })) await reload(); } }, "This is not a problem"));
  return { story, mute };
}

function findingsTable(m, redraw) {
  const rows = m.findings.slice(0, shown);
  const body = rows.map((f) => h("tr", {},
    h("td", {}, SEVERITY[f.severity] ?? f.severity),
    h("td", {}, h("a", { href: "#/problems/" + encodeURIComponent(f.id) }, f.summary), h("div", { class: "muted text-xs" }, f.detector)),
    h("td", {}, when(f.firstSeen)),
    h("td", {}, `seen in ${f.count} ${f.count === 1 ? "check" : "checks"}`),
    h("td", {}, stateText(f)),
    h("td", {}, storyCell(f.story, f.needsYou))));
  const left = m.findings.length - rows.length;
  return h("div", {},
    tableBox(h("table", { class: "table compact", "aria-label": "Findings" },
      h("thead", {}, h("tr", {}, ["Severity", "What", "Since", "How often", "State", "Story"].map((c) => h("th", { scope: "col" }, c)))),
      h("tbody", {}, body))),
    left > 0 ? h("button", { class: "small", onClick: () => { shown += PAGE; redraw(); } }, `Show ${Math.min(PAGE, left)} more`) : null);
}

function detectorsTable(m, reload) {
  const rows = (m.detectors ?? []).map((d) => {
    const mute = (m.mutes ?? []).find((x) => x.kind === "detector" && x.detector === d.name);
    const list = under(m, `monitor.${d.key}.`);
    return h("tr", {},
      h("td", {}, d.name),
      h("td", {}, d.description),
      h("td", {}, list.length ? settingsForm(list, m, reload, { saved: "Threshold saved" }) : h("span", { class: "muted" }, "none")),
      h("td", {}, d.lastFound ? when(d.lastFound) : "nothing in the last 30 days"),
      h("td", {}, mute ? `muted ${untilText(mute.until)}: ${mute.reason}` : ""),
      h("td", {}, mute
        ? h("button", { class: "small", onClick: () => act(() => api.unmuteMonitor(mute.id), () => "Mute ended", reload) }, "End mute")
        : h("button", { class: "small", onClick: async () => { if (await muteForm({ detector: d.name }, m.detectors)) await reload(); } }, "Mute")));
  });
  return tableBox(h("table", { class: "table compact", "aria-label": "Detectors" },
    h("thead", {}, h("tr", {}, ["Detector", "What it looks for", "Threshold", "Last found", "Muted", h("span", { class: "sr-only" }, "Actions")].map((c) => h("th", { scope: "col" }, c)))),
    h("tbody", {}, rows)));
}

// The newest reload wins: an older answer that arrives later is dropped.
let reloads = 0;

/** The Problems page: what the monitor found, what happens to it, and the detectors. For admins. */
export async function renderProblems(main, { data } = {}) {
  let m = data;
  if (!m) {
    mount(main, h("h1", {}, "Problems"), loadingState("Loading problems…", { rows: 5, shape: "table" }));
    try {
      m = await api.monitor();
    } catch (e) {
      mount(main, h("h1", {}, "Problems"), errorState(explainError(e, { what: "The problems could not be loaded." }), { onRetry: () => renderProblems(main) }));
      return;
    }
  }
  const at = Date.now();
  const note = h("div");
  const reload = async () => {
    const my = ++reloads;
    let fresh;
    try {
      fresh = await api.monitor();
    } catch {
      if (my === reloads) mount(note, staleNote(at, { failed: true, onRetry: reload }));
      return;
    }
    if (my === reloads) await renderProblems(main, { data: fresh });
  };
  shown = PAGE;
  const list = h("div", {});
  const redraw = () => list.replaceChildren(
    m.findingsUnreadable ? h("p", { class: "status bad" }, "The findings file of the monitor cannot be read, so the list is not shown. The next check keeps it as monitor-findings.json.broken and starts a new one.") : null,
    m.findings?.length ? findingsTable(m, redraw) : m.findingsUnreadable ? null : emptyState("No findings."));
  redraw();
  mount(main,
    h("h1", {}, "Problems"),
    note,
    switchRow(m, reload),
    list,
    h("details", {}, h("summary", {}, `Mutes (${(m.mutes ?? []).length})`), (m.mutes ?? []).length ? mutesTable(m, reload) : h("p", { class: "muted" }, "No mutes.")),
    monitorSettingsSection(m, reload),
    h("h2", {}, "Detectors"),
    detectorsTable(m, reload));
}

let detailReloads = 0;

/** One finding: its facts, evidence, bug stories and runs, and its buttons in two groups. For admins. */
export async function renderProblemDetail(main, id, { data } = {}) {
  const back = { href: "#/problems", label: "Back to Problems" };
  let d;
  let m;
  if (data) ({ d, m } = data);
  else {
    mount(main, h("h1", {}, "Problem"), loadingState("Loading the problem…", { rows: 3, shape: "detail" }));
    const [one, list] = await Promise.allSettled([api.monitorFinding(id), api.monitor()]);
    if (one.status === "rejected") {
      const e = one.reason;
      mount(main, h("h1", {}, "Problem"),
        errorState(explainError(e, { what: "The problem could not be loaded." }), { back, onRetry: e?.status === 404 ? undefined : () => renderProblemDetail(main, id) }));
      return;
    }
    if (list.status === "rejected") {
      mount(main, h("h1", {}, "Problem"),
        errorState(explainError(list.reason, { what: "The problems could not be loaded." }), { back, onRetry: () => renderProblemDetail(main, id) }));
      return;
    }
    d = one.value;
    m = list.value;
  }
  const at = Date.now();
  const note = h("div");
  const reload = async () => {
    const my = ++detailReloads;
    let fresh;
    try {
      const [one, list] = await Promise.all([api.monitorFinding(id), api.monitor()]);
      fresh = { d: one, m: list };
    } catch {
      if (my === detailReloads) mount(note, staleNote(at, { failed: true, onRetry: reload }));
      return;
    }
    if (my === detailReloads) await renderProblemDetail(main, id, { data: fresh });
  };
  // the two calls read the findings independently: the finding can be gone from the list by now
  const f = (m.findings ?? []).find((x) => x.id === id);
  const { story, mute } = f ? findingActions(f, m, reload) : { story: [], mute: [] };
  mount(main,
    h("h1", {}, f?.summary ?? "Problem"),
    f
      ? h("div", { class: "muted text-sm" },
        [SEVERITY[f.severity] ?? f.severity, f.detector, `since ${when(f.firstSeen)}`, `seen in ${f.count} ${f.count === 1 ? "check" : "checks"}`, stateText(f)].join(" · "), " · ", storyCell(f.story, f.needsYou))
      : h("p", { class: "status bad" }, "This problem is not in the list of the monitor any more. What was found is shown below.", " ", h("a", { href: back.href }, back.label)),
    note,
    findingDetail(d),
    story.length ? h("section", { class: "action-group" }, h("h2", {}, "Bug story"), h("div", { class: "row" }, story)) : null,
    mute.length ? h("section", { class: "action-group" }, h("h2", {}, "Mute"), h("div", { class: "row" }, mute)) : null);
}
