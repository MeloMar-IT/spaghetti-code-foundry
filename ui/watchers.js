import { api } from "./api.js";
import { confirmDialog, h, mount, timeAgo, toast } from "./dom.js";
import { confirmUnreadable, monitorLists } from "./monitor.js";
import { emptyState, errorState, explainError, loadingState, staleNote } from "./states.js";
import { ownerText, sortRepos } from "./admin-repos.js";
import { watcherSemanticOf } from "./icons.js";
import { nextList, statusMark, watcherNext } from "./next.js";
import { monitorDialog, repoWatcherDialog } from "./watcher-form.js";

/** The notes of a watcher's status (what waits or is wrong with the monitor's bug stories) as a list, or null when there are none. */
export const watcherNotes = (st) => (st?.notes?.length ? h("ul", { class: "holds" }, st.notes.map((n) => h("li", {}, n))) : null);

/** A time as the page shows it: the clock time on the same local day, else with the short month and the day. */
function storyTime(iso, now) {
  const d = new Date(iso);
  const clock = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === now.toDateString() ? clock : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${clock}`;
}

/** The one line that says whether the monitor makes bug stories. */
export function storiesLine(m, now = new Date()) {
  let line;
  if (m.state === "off") line = `Bug stories: off since ${storyTime(m.since, now)}`;
  else if (m.state === "quiet") line = `Bug stories: quiet until ${storyTime(m.until, now)} after the restart`;
  else if (m.state === "breaker") line = `Bug stories: stopped by the circuit breaker since ${storyTime(m.since, now)}${m.why ? ` (${m.why})` : ""}`;
  else if (m.state === "unreadable") line = "Bug stories: stopped. The state file monitor-guard.json cannot be read.";
  else line = `Bug stories: on${m.reportTo === false ? " (no repository is set: monitor.report_to)" : ""}`;
  if (m.reset) line += ` The state file could not be read at ${storyTime(m.reset, now)}; it was kept as monitor-guard.json.broken and started fresh.`;
  return line;
}

/** The line and the switch button for the monitor's page; null without a state. */
export function storiesRow(m, reload) {
  if (!m) return null;
  const isOn = m.state === "on" || m.state === "quiet";
  const wantOn = m.state === "off" || m.state === "unreadable" || m.state === "breaker";
  const click = async () => {
    if (m.state === "unreadable" && !(await confirmUnreadable())) return;
    try {
      await (wantOn ? api.monitorOn() : api.monitorOff());
      toast(wantOn ? "Bug stories are on" : "Bug stories are off");
    } catch (e) {
      toast(e.message, "error");
    }
    await reload();
  };
  return h("div", { class: "row" },
    h("span", { class: isOn ? "status ok" : "status bad" }, storiesLine(m)),
    h("span", { class: "spacer" }),
    h("button", { class: "small", onClick: click }, wantOn ? "Switch bug stories on" : "Switch bug stories off"));
}

async function saveConfig(mutate, okMsg) {
  const config = await api.config();
  mutate(config);
  await api.saveConfig(config);
  toast(okMsg);
}

/** The watcher's own state with its "?". */
export const watcherStateMark = (w) => (w.state ? statusMark(w.state, `state-${w.state.name}`, false, watcherSemanticOf(w.state.name)) : null);

const DEFAULT_FLOWS = { issues: "issue-gitflow", schedule: "release-daily" };
/** A monitor has no repository, flow, labels or owner: only these fields are saved (a changed source drops the rest). */
export const monitorEntry = ({ id, every, enabled }) => ({ id, source: "monitor", every, enabled });

export const describeWatcher = (w) => {
  const flow = w.flow === "default" ? DEFAULT_FLOWS[w.source] ?? "(no flow)" : w.flow;
  return {
    monitor: "checks the Foundry itself for problems",
    issues: `issues labelled “${w.label}” → ${flow}`,
    "pr-feedback": `PR review comments → ${flow}`,
    "ci-failures": `CI failures on ${w.branch ?? "the default branch"} → ${flow}`,
    schedule: `${w.at ? `daily at ${w.at}${w.timezone ? ` ${w.timezone}` : ""}` : `every ${w.every}`}: ${(w.task ?? "").slice(0, 60)}${(w.task ?? "").length > 60 ? "…" : ""} → ${flow}`,
  }[w.source];
};

/** " · last successful check 5m ago", or a short text when there is none yet. */
export const lastOkText = (st) => (!st ? "" : st.lastOk ? ` · last successful check ${timeAgo(st.lastOk)}` : " · no successful check yet");

/** The page's sections: { groups: [{ repo, watchers }], gone: [...], monitor: [...], file: [...] }. */
export function watcherGroups(watchers, repos) {
  const known = new Set(repos.map((r) => r.id));
  const stored = watchers.filter((w) => w.source !== "monitor" && w.repoId);
  return {
    groups: sortRepos(repos).map((repo) => ({ repo, watchers: stored.filter((w) => w.repoId === repo.id) })).filter((g) => g.watchers.length),
    gone: stored.filter((w) => !known.has(w.repoId)),
    monitor: watchers.filter((w) => w.source === "monitor"),
    file: watchers.filter((w) => w.source !== "monitor" && !w.repoId),
  };
}

/** "repo" | "gone" | "monitor" | "file", by the same rules as watcherGroups. */
export const watcherKind = (w, repos) => (w.source === "monitor" ? "monitor" : !w.repoId ? "file" : repos.some((r) => r.id === w.repoId) ? "repo" : "gone");

/** The settings line: "every 5m · max 1 per check · skips … · last successful check … · next …". */
export const watcherSettings = (w) => {
  const st = w.status;
  return [
    w.source === "monitor" ? `every ${w.every}` : w.source === "schedule" ? (w.at ? `checks every ${w.every}` : `max 1 run per ${w.every}`) : `every ${w.every} · max ${w.max_per_tick} per check`,
    w.exclude_labels?.length ? ` · skips ${w.exclude_labels.join(", ")}` : "",
    w.pause_while_pr_open ? ` · pauses while a ${w.pause_while_pr_open}* PR is open` : "",
    w.enabled ? lastOkText(st) : "",
    st?.nextTick ? ` · next ${new Date(st.nextTick).toLocaleTimeString()}` : "",
  ].join("");
};

const FILE_NOTE = "still in config.yaml: it moves to its repository when the server starts; the server log says why if it stays";

// The newest reload wins: an older answer that arrives later is dropped.
let reloads = 0;

async function loadWatchers() {
  const [watchers, flows, repos] = await Promise.all([api.watchers(), api.flows(), api.allRepos()]);
  return { watchers, flows, repos };
}

export async function renderWatchers(main, { data } = {}) {
  if (!data) {
    mount(main, h("div", { class: "toolbar" }, h("h1", {}, "Watchers")), loadingState("Loading watchers…", { rows: 4, shape: "cards" }));
    data = await loadWatchers(); // a failure goes to the router, which draws the error with Retry
  }
  const { watchers, flows, repos } = data;
  const at = Date.now();
  const note = h("div");
  const reload = async () => {
    const my = ++reloads;
    let fresh;
    try {
      fresh = await loadWatchers();
    } catch {
      if (my === reloads) mount(note, staleNote(at, { failed: true, onRetry: reload }));
      return;
    }
    if (my === reloads) await renderWatchers(main, { data: fresh });
  };
  const { groups, gone, monitor, file } = watcherGroups(watchers, repos);
  const saveMonitor = (entry) =>
    saveConfig((c) => {
      if (c.watchers.some((x) => x.id === entry.id)) throw new Error(`a watcher "${entry.id}" already exists`);
      c.watchers = [...c.watchers, monitorEntry(entry)];
    }, `Watcher ${entry.id} saved`);

  const row = (w, kind) => {
    const st = w.status;
    return h("tr", {},
      h("td", {}, h("a", { class: "mono", href: "#/watchers/" + encodeURIComponent(w.id) }, w.id)),
      h("td", {}, watcherStateMark(w)),
      h("td", {},
        kind === "file" && w.github_repo ? [h("span", { class: "mono" }, w.github_repo), " "] : null,
        describeWatcher(w),
        w.problem ? h("div", { class: "status bad" }, w.problem) : null),
      h("td", {}, !w.enabled ? "" : st?.lastOk ? timeAgo(st.lastOk) : "none yet"));
  };
  const section = (title, list, kind, sub) => (list.length
    ? h("div", {}, h("h3", {}, title), sub ?? null,
      h("table", { class: "table compact", "aria-label": title },
        h("thead", {}, h("tr", {}, ["Watcher", "State", "What it does", "Last successful check"].map((c) => h("th", { scope: "col" }, c)))),
        h("tbody", {}, list.map((w) => row(w, kind)))))
    : null);
  const addWatcher = async () => (await repoWatcherDialog({ repos, flows, existing: null })) && reload();

  mount(main,
    h("div", { class: "toolbar" }, h("h1", {}, "Watchers"),
      h("span", { class: "muted" }, "Poll GitHub and start runs automatically while this server runs"),
      h("span", { class: "spacer" }),
      h("button", { onClick: reload, "aria-label": "Reload" }, "↻"),
      monitor.length ? null : h("button", { onClick: async () => (await monitorDialog(null, saveMonitor)) && reload() }, "+ Add the monitor"),
      h("button", { class: "primary", onClick: addWatcher }, "+ Add watcher")),
    note,
    watchers.length ? [
      ...groups.map(({ repo, watchers: list }) => section(repo.url, list, "repo",
        h("p", { class: "muted flush mb-6" }, "Owner: ", ownerText(repo), repo.account?.status === "blocked" ? [" ", h("span", { class: "pill" }, "blocked")] : null))),
      section("Repository not connected any more", gone, "gone"),
      section("The Foundry itself", monitor, "monitor"),
      section("From config.yaml", file, "file", h("p", { class: "muted flush mb-6" }, FILE_NOTE)),
    ] : emptyState("No watchers yet. A watcher checks a GitHub repo on a schedule and runs a flow: for labelled issues, review comments, red CI on the default branch, or a recurring chore.",
      { label: "+ Add watcher", onClick: addWatcher }),
    h("p", { class: "muted mt-16" },
      "Watchers run inside this server. To keep them running after you close the terminal or restart your Mac: ",
      h("code", {}, "scf service install")));
}

let detailReloads = 0;

/** One watcher: its full state, its routine actions, and Delete apart in a Danger group. */
export async function renderWatcherDetail(main, id, { data } = {}) {
  const back = { href: "#/watchers", label: "Back to Watchers" };
  if (!data) {
    mount(main, h("h1", {}, "Watcher"), loadingState("Loading the watcher…", { rows: 4, shape: "detail" }));
    data = await loadWatchers(); // a failure goes to the router, which draws the error with Retry
  }
  const { watchers, flows, repos } = data;
  const w = watchers.find((x) => x.id === id);
  if (!w) {
    mount(main, h("h1", {}, "Watcher"), errorState(explainError({ status: 404 }, { what: `There is no watcher "${id}".` }), { back }));
    return;
  }
  let mon = data.mon;
  let monError = data.monError;
  if (w.source === "monitor" && !mon && !monError) {
    try {
      mon = await api.monitor();
    } catch (e) {
      monError = e;
    }
  }
  const kind = watcherKind(w, repos);
  const st = w.status;
  const at = Date.now();
  const note = h("div");
  const reload = async () => {
    const my = ++detailReloads;
    let fresh;
    try {
      fresh = await loadWatchers();
      if (fresh.watchers.some((x) => x.id === id && x.source === "monitor")) {
        try {
          fresh.mon = await api.monitor();
        } catch (e) {
          fresh.monError = e;
        }
      }
    } catch {
      if (my === detailReloads) mount(note, staleNote(at, { failed: true, onRetry: reload }));
      return;
    }
    if (my === detailReloads) await renderWatcherDetail(main, id, { data: fresh });
  };
  // a failed call shows the server's sentence as it is; the page is drawn again either way
  const act = async (fn) => {
    try {
      await fn();
    } catch (e) {
      toast(e.message, "error");
    }
    await reload();
  };
  const saveMonitor = (entry) =>
    saveConfig((c) => {
      c.watchers = c.watchers.map((x) => (x.id === w.id ? monitorEntry(entry) : x));
    }, `Watcher ${entry.id} saved`);
  const checkNow = () => {
    const busy = h("span", { class: "muted", role: "status" });
    const btn = h("button", { class: "small", onClick: async () => {
      btn.disabled = true;
      mount(busy, h("span", { class: "spinner" }), " Checking…");
      await act(() => api.tickWatcher(w.id));
      btn.disabled = false;
      mount(busy);
    } }, "Check now");
    return [busy, btn];
  };
  const sure = () => confirmDialog({ title: `Delete watcher ${w.id}?`, text: "The watcher stops checking. You can add it again later.", confirm: "Delete watcher" });
  const remove = (fn) => async () => {
    if (!(await sure())) return;
    try {
      await fn();
      toast("Deleted");
    } catch (e) {
      toast(e.message, "error");
      await reload();
      return;
    }
    globalThis.location.hash = "#/watchers";
  };
  const edit = (open) => h("button", { class: "small", onClick: async () => (await open()) && reload() }, "Edit");

  let actions = [];
  let del = null;
  if (kind === "file") actions = [w.enabled ? checkNow() : null];
  else if (kind === "monitor") {
    actions = [w.enabled ? checkNow() : null, edit(() => monitorDialog(w, saveMonitor))];
    del = remove(() => saveConfig((c) => (c.watchers = c.watchers.filter((x) => x.id !== w.id)), "Deleted"));
  } else {
    // a watcher whose repository is gone can only be deleted: the API refuses to change it
    if (kind === "repo") {
      actions = [w.enabled && !w.problem ? checkNow() : null,
        edit(() => repoWatcherDialog({ repos, flows, existing: w })),
        h("button", { class: "small", onClick: () => act(() => api.saveRepoWatcher(w.repoId, w.id, { enabled: !w.enabled })) }, w.enabled ? "Disable" : "Enable")];
    }
    del = remove(() => api.removeRepoWatcher(w.repoId, w.id));
  }
  const hasActions = actions.some(Boolean);

  mount(main,
    h("div", { class: "toolbar" },
      h("h1", { class: "mono" }, w.id),
      watcherStateMark(w),
      kind === "file" && w.github_repo ? h("span", { class: "mono" }, w.github_repo) : null,
      h("span", { class: "muted" }, describeWatcher(w)),
      h("span", { class: "spacer" }),
      h("button", { onClick: reload, "aria-label": "Reload" }, "↻")),
    note,
    w.problem ? h("p", { class: "status bad mt-4 mb-4" }, w.problem) : null,
    kind === "file" ? h("div", { class: "muted text-sm" }, FILE_NOTE) : null,
    kind === "gone" ? h("div", { class: "muted text-sm" }, "Its repository is not connected any more.") : null,
    h("div", { class: "muted text-sm" }, watcherSettings(w)),
    w.enabled && !w.problem && watcherNext(w).length ? h("div", {}, h("div", { class: "muted text-sm mt-6" }, "What happens next:"), nextList(watcherNext(w))) : null,
    w.source !== "monitor" ? null : monError
      ? errorState(explainError(monError, { what: "Could not load the monitor's state.", safe: "The watcher is shown and keeps checking." }), { onRetry: reload })
      : [storiesRow(mon, reload), monitorLists(mon, reload)],
    watcherNotes(st),
    st?.lastError ? h("details", {}, h("summary", {}, "Error details"), h("pre", { class: "mono" }, st.lastError)) : null,
    st?.lastActions?.length ? h("details", {}, h("summary", {}, `Recent activity (${st.lastActions.length})`), h("pre", { class: "mono" }, st.lastActions.join("\n"))) : null,
    hasActions ? h("section", { class: "action-group" }, h("h2", {}, "Actions"), h("div", { class: "row" }, actions)) : null,
    del ? h("section", { class: "action-group danger-group" },
      h("h2", {}, "Danger"),
      h("p", { class: "muted text-sm" }, "The watcher stops checking. You can add it again later."),
      h("button", { class: "small danger", onClick: del }, "Delete")) : null);
}
