import { actorText, targetText, timeText } from "./audit.js";
import { api } from "./api.js";
import { tile } from "./dashboard.js";
import { h, mount, timeAgo, toast } from "./dom.js";
import { askCancelRun, renderHealth } from "./health.js";
import { ownerLabel } from "./runs.js";
import { loadingState } from "./states.js";

export const QUEUE_SHOWN = 5;
export const AUDIT_SHOWN = 8;

const firstLine = (s) => String(s ?? "").split("\n")[0];
const usd = (n) => "$" + (n ?? 0).toFixed(2);

/** GET /api/watchers rows: how many are enabled, which have a problem, when the oldest good check was. */
export function watcherSummary(watchers) {
  const rows = watchers ?? [];
  const enabled = rows.filter((w) => w.enabled);
  const problems = rows
    .filter((w) => w.problem || w.status?.lastError)
    .map((w) => ({ id: w.id, text: String(w.problem ?? firstLine(w.status.lastError)).slice(0, 200) }));
  const oks = enabled.map((w) => w.status?.lastOk).filter(Boolean).sort();
  return { total: rows.length, enabled: enabled.length, problems, oldestOk: oks[0] ?? null, neverOk: enabled.filter((w) => !w.status?.lastOk).length };
}

/** GET /api/queue: counts and the first waiting runs. `p.task` is never read. */
export function queueSummary(queue) {
  const pending = queue?.pending ?? [];
  const active = queue?.active ?? [];
  const first = pending.slice(0, QUEUE_SHOWN).map((p) => ({
    runId: p.runId,
    what: (p.flow ?? p.kind ?? "") + (p.githubRepo && p.issue ? ` · ${p.githubRepo}#${p.issue}` : ""),
    next: p.next?.text ?? "",
    owner: p.ownerName ?? "",
  }));
  return { running: active.length, waiting: pending.length, concurrency: queue?.concurrency, first, more: Math.max(0, pending.length - QUEUE_SHOWN) };
}

/** GET /api/info and GET /api/stats; each part is null when its source is missing. */
export function limitSummary(info, stats) {
  return {
    spend: info ? { spentToday: info.spentToday ?? 0, dailyBudget: info.dailyBudget, enforced: info.costLimits !== false } : null,
    atLimit: stats ? (stats.byUser ?? []).filter((u) => u.atLimit?.length).map((u) => ({ name: u.name, fields: u.atLimit })) : null,
  };
}

/** GET /api/providers: agents first, then providers. */
export function providerSummary(providers) {
  const rows = [
    ...(providers?.agents ?? []).map((a) => ({ kind: "agent", name: a.agent, ready: !!(a.installed && a.loggedIn !== false), detail: a.detail })),
    ...(providers?.providers ?? []).map((p) => ({ kind: "provider", name: p.name, ready: p.ok === true, detail: p.detail })),
  ];
  return { rows, ready: rows.filter((r) => r.ready).length, total: rows.length };
}

// Each load gets a number; an answer that is not the newest load, or that arrives after the person left the page, is dropped.
let generation = 0;
const onPage = () => {
  if (typeof location === "undefined") return true;
  try {
    return decodeURIComponent(location.hash.split("?")[0].split("/")[1] ?? "") === "operations";
  } catch {
    return false;
  }
};

const ok = (p) => p.status === "fulfilled";
const notAvailable = (p) => h("p", { class: "status bad", role: "alert" }, "Not available. " + firstLine(p.reason?.message));
const card = (title, cls, body, links) => h("div", { class: cls }, h("h3", {}, title), body, links);
const link = (href, page) => h("a", { href }, "Open " + page);
const spendText = (s) => (s.enforced === false
  ? `Spent today ${usd(s.spentToday)} (estimate at API prices). No limits are enforced.`
  : s.dailyBudget ? `Spent today ${usd(s.spentToday)} of ${usd(s.dailyBudget)} daily budget.` : `Spent today ${usd(s.spentToday)}. No daily budget set.`);
const spendSub = (s) => (s.enforced === false ? "estimate at API prices · no limits enforced" : s.dailyBudget ? `of ${usd(s.dailyBudget)} daily budget` : "no daily budget set");
const table = (caption, heads, rows) => h("table", { class: "table compact" },
  h("caption", { class: "sr-only" }, caption),
  h("thead", {}, h("tr", {}, heads.map((t) => h("th", { scope: "col" }, t)))),
  h("tbody", {}, rows));

/** The Overview page of Administration: what needs attention, on one page. Returns a cleanup. */
export async function renderOperations(main) {
  const mine = ++generation;
  const live = () => mine === generation && onPage();
  const head = () => h("div", { class: "toolbar" }, h("h1", {}, "Overview"), h("span", { class: "muted" }, "What needs attention"));

  const onCancel = async (runId) => {
    if (!(await askCancelRun())) return;
    await api.cancelRun(runId).catch((e) => toast(e.message, "error"));
    if (live()) await load();
  };

  const draw = ([health, stats, info, queue, watchers, providers, audit]) => {
    const f = ok(health) ? health.value?.monitorFindings : undefined;
    const findingsText = f?.unreadable ? "The findings file cannot be read." : f ? `${f.open} open of ${f.total} stored` : "No findings stored.";
    const q = ok(queue) ? queueSummary(queue.value) : null;
    const w = ok(watchers) ? watcherSummary(watchers.value) : null;
    const lim = limitSummary(ok(info) ? info.value : null, ok(stats) ? stats.value : null);
    const na = "Not available";

    const tiles = h("div", { class: "tiles" },
      tile("Problems", ok(health) ? String(f?.open ?? 0) : "—", ok(health) ? (f?.unreadable ? "the findings file cannot be read" : f ? `${f.total} stored` : "none stored") : na),
      tile("Queue", q ? `${q.running} running` : "—", q ? `${q.waiting} waiting` : na),
      tile("Watchers", w ? `${w.enabled} enabled` : "—", w ? `${w.problems.length} with a problem` : na),
      tile("Spent today", lim.spend ? usd(lim.spend.spentToday) : "—", lim.spend ? spendSub(lim.spend) : na));

    let healthBody;
    if (ok(health)) {
      healthBody = h("div");
      renderHealth(healthBody, health.value, { onCancel });
    } else healthBody = notAvailable(health);

    const pv = ok(providers) ? providerSummary(providers.value) : null;
    const providersBody = pv ? [
      h("p", {}, `${pv.ready} of ${pv.total} ready`),
      pv.rows.length ? table("Providers and their state", ["Name", "Status", "Detail"], pv.rows.map((r) => h("tr", {},
        h("td", {}, r.name),
        h("td", {}, h("span", { class: r.ready ? "pill ok" : "pill fail" }, r.ready ? "ready" : "not ready")),
        h("td", { class: "muted" }, r.detail ?? "")))) : null,
    ] : notAvailable(providers);

    const queueBody = q ? [
      h("p", {}, `${q.running} running of ${q.concurrency ?? "?"} at the same time · ${q.waiting} waiting`),
      q.first.length ? h("ul", {}, q.first.map((p) => h("li", {},
        p.runId ? h("span", { class: "mono" }, p.runId) : null, p.runId ? " " : null, p.what,
        p.next ? h("span", { class: "muted" }, " · " + p.next) : null,
        p.owner ? h("span", { class: "muted" }, " · " + ownerLabel(p.owner)) : null)))
        : h("p", { class: "muted" }, "Nothing is waiting."),
      q.more > 0 ? h("p", { class: "muted" }, `and ${q.more} more`) : null,
    ] : notAvailable(queue);

    const watchersBody = w ? [
      h("p", {}, `${w.enabled} of ${w.total} enabled`),
      w.problems.length ? h("ul", {}, w.problems.map((p) => h("li", {}, h("span", { class: "mono" }, p.id), " " + p.text))) : null,
      w.oldestOk !== null ? h("p", { class: "muted" }, "Oldest successful check: " + timeAgo(w.oldestOk)) : null,
      w.neverOk > 0 ? h("p", { class: "muted" }, `${w.neverOk} enabled without a successful check yet`) : null,
    ] : notAvailable(watchers);

    const limitsBody = [
      lim.spend ? h("p", {}, spendText(lim.spend)) : notAvailable(info),
      lim.atLimit
        ? lim.atLimit.length
          ? h("ul", {}, lim.atLimit.map((u) => h("li", {}, ownerLabel(u.name) + " ", h("span", { class: "pill locked" }, "at limit"))))
          : h("p", { class: "muted" }, "No account is at a limit.")
        : notAvailable(stats),
    ];

    const entries = ok(audit) ? (audit.value?.entries ?? []) : null;
    const auditBody = entries
      ? entries.length
        ? table("The latest audit entries", ["Time", "Who", "Action", "Target"], entries.slice(0, AUDIT_SHOWN).map((e) => h("tr", {},
          h("td", { class: "muted", title: e.time }, timeText(e.time)),
          h("td", {}, actorText(e.actor)),
          h("td", { class: "mono" }, e.action),
          h("td", {}, targetText(e.target) || "—"))))
        : h("p", { class: "muted" }, "No entries.")
      : notAvailable(audit);

    mount(main, head(), tiles, h("div", { class: "dash-grid" },
      card("Health", "card span-all", healthBody, null),
      card("Problems", "card", ok(health) ? h("p", {}, findingsText) : notAvailable(health), link("#/problems", "Problems")),
      card("Providers", "card", providersBody, link("#/models", "Models")),
      card("Queue", "card", queueBody, link("#/runs", "Runs")),
      card("Watchers", "card", watchersBody, link("#/watchers", "Watchers")),
      card("Limits", "card", limitsBody, h("p", {}, link("#/settings", "Settings"), " · ", link("#/users", "Users"))),
      card("Recent audit", "card span-all", auditBody, link("#/audit", "Audit"))));
  };

  const load = async () => {
    const results = await Promise.allSettled([api.health(), api.stats(), api.info(), api.queue(), api.watchers(), api.providers(), api.audit()]);
    if (!live()) return;
    draw(results);
  };

  mount(main, head(), loadingState("Loading the overview", { rows: 6, shape: "cards" }));
  await load();
  return () => {
    if (generation === mine) generation++;
  };
}
