import { api } from "./api.js";
import { h, modal, mount, timeAgo, toast } from "./dom.js";
import { monitorLists } from "./monitor.js";
import { ownerText, sortRepos } from "./admin-repos.js";
import { watcherSemanticOf } from "./icons.js";
import { nextList, statusMark, watcherNext } from "./next.js";
import { monitorDialog, repoWatcherDialog } from "./watcher-form.js";

const f = (label, el, hint) => h("label", { class: "field" }, h("span", {}, label), el, hint ? h("small", {}, hint) : null);
const input = (value, attrs = {}) => h("input", { value: value ?? "", ...attrs });
const check = (checked, label) => {
  const el = h("input", { type: "checkbox", class: "fit", checked: !!checked });
  return { el, row: h("label", { class: "row tight" }, el, h("span", {}, label)) };
};
const num = (el) => (el.value.trim() === "" ? undefined : Number(el.value));

/** The notes of a watcher's status (what waits or is wrong with the monitor's bug stories) as a list, or null when there are none. */
export const watcherNotes = (st) => (st?.notes?.length ? h("ul", { class: "holds" }, st.notes.map((n) => h("li", {}, n))) : null);

/** A time as the card shows it: the clock time on the same local day, else with the short month and the day. */
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

/** The line and the switch button for the monitor's card; null without a state. */
export function storiesRow(m, reload) {
  if (!m) return null;
  const isOn = m.state === "on" || m.state === "quiet";
  const wantOn = m.state === "off" || m.state === "unreadable" || m.state === "breaker";
  const click = async () => {
    if (m.state === "unreadable" && !confirm("The state file cannot be read. Switching on keeps it as monitor-guard.json.broken and starts a fresh one. Go on?")) return;
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

/** The `notify` setting from the raw values of the Settings controls (strings for text, booleans for checkboxes). */
export function notifyFrom(v) {
  const t = (x) => String(x ?? "").trim();
  return {
    macos: !!v.macos,
    slack_webhook: t(v.slack) || undefined,
    command: t(v.command) || undefined,
    on: v.on,
    successes: !!v.successes,
    throttle_minutes: t(v.throttle) === "" ? 5 : Number(v.throttle),
    quiet_hours: t(v.quietFrom) && t(v.quietTo) ? { from: t(v.quietFrom), to: t(v.quietTo) } : undefined,
    daily_summary_at: t(v.summaryAt) || undefined,
  };
}

/** The `server` setting from the raw values of the Network controls. */
export function serverFrom(v) {
  return {
    listen: String(v.listen ?? "").trim() || "127.0.0.1",
    allowed_hosts: String(v.hosts ?? "").split(/[\s,]+/).filter(Boolean),
    allow_insecure_http: !!v.insecure,
  };
}

async function saveConfig(mutate, okMsg) {
  const config = await api.config();
  mutate(config);
  await api.saveConfig(config);
  toast(okMsg);
}

// ── watchers ──

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

export async function renderWatchers(main) {
  const [watchers, flows, repos] = await Promise.all([api.watchers(), api.flows(), api.allRepos()]);
  const reload = () => renderWatchers(main);
  const mon = watchers.some((w) => w.source === "monitor") ? await api.monitor().catch(() => undefined) : undefined;
  const { groups, gone, monitor, file } = watcherGroups(watchers, repos);
  // a failed call shows the server's sentence as it is; the page is drawn again either way
  const act = async (fn) => {
    try {
      await fn();
    } catch (e) {
      toast(e.message, "error");
    }
    reload();
  };

  const saveMonitor = (existing) => (entry) =>
    saveConfig((c) => {
      if (!existing && c.watchers.some((x) => x.id === entry.id)) throw new Error(`a watcher "${entry.id}" already exists`);
      const next = monitorEntry(entry);
      c.watchers = existing ? c.watchers.map((x) => (x.id === existing.id ? next : x)) : [...c.watchers, next];
    }, `Watcher ${entry.id} saved`);
  const checkNow = (w) => h("button", { class: "small", onClick: () => act(async () => { toast("Checking…"); await api.tickWatcher(w.id); }) }, "Check now");

  const buttons = (w, kind) => {
    if (kind === "file") return [w.enabled ? checkNow(w) : null];
    if (kind === "monitor") {
      return [w.enabled ? checkNow(w) : null,
        h("button", { class: "small", onClick: async () => (await monitorDialog(w, saveMonitor(w))) && reload() }, "Edit"),
        h("button", { class: "small danger", onClick: () => {
          if (!confirm(`Delete watcher ${w.id}?`)) return;
          act(() => saveConfig((c) => (c.watchers = c.watchers.filter((x) => x.id !== w.id)), "Deleted"));
        } }, "Delete")];
    }
    const del = h("button", { class: "small danger", onClick: () => {
      if (!confirm(`Delete watcher ${w.id}?`)) return;
      act(async () => { await api.removeRepoWatcher(w.repoId, w.id); toast("Deleted"); });
    } }, "Delete");
    // a watcher whose repository is gone can only be deleted: the API refuses to change it
    if (kind === "gone") return [del];
    return [w.enabled && !w.problem ? checkNow(w) : null,
      h("button", { class: "small", onClick: async () => (await repoWatcherDialog({ repos, flows, existing: w })) && reload() }, "Edit"),
      h("button", { class: "small", onClick: () => act(() => api.saveRepoWatcher(w.repoId, w.id, { enabled: !w.enabled })) }, w.enabled ? "Disable" : "Enable"),
      del];
  };

  const card = (w, kind) => {
    const st = w.status;
    return h("div", { class: "card" },
      h("div", { class: "row" },
        h("b", { class: "mono" }, w.id),
        watcherStateMark(w),
        kind === "file" && w.github_repo ? h("span", { class: "mono" }, w.github_repo) : null,
        h("span", { class: "muted" }, describeWatcher(w)),
        h("span", { class: "spacer" }),
        buttons(w, kind)),
      w.problem ? h("p", { class: "status bad mt-4 mb-4" }, w.problem) : null,
      kind === "file" ? h("div", { class: "muted text-sm" }, "still in config.yaml: it moves to its repository when the server starts; the server log says why if it stays") : null,
      h("div", { class: "muted text-sm" },
        w.source === "monitor" ? `every ${w.every}` : w.source === "schedule" ? (w.at ? `checks every ${w.every}` : `max 1 run per ${w.every}`) : `every ${w.every} · max ${w.max_per_tick} per check`,
        w.exclude_labels?.length ? ` · skips ${w.exclude_labels.join(", ")}` : "",
        w.pause_while_pr_open ? ` · pauses while a ${w.pause_while_pr_open}* PR is open` : "",
        w.enabled ? lastOkText(st) : "",
        st?.nextTick ? ` · next ${new Date(st.nextTick).toLocaleTimeString()}` : ""),
      w.enabled && !w.problem && watcherNext(w).length ? h("div", {}, h("div", { class: "muted text-sm mt-6" }, "What happens next:"), nextList(watcherNext(w))) : null,
      w.source === "monitor" ? storiesRow(mon, reload) : null,
      w.source === "monitor" ? monitorLists(mon, reload) : null,
      watcherNotes(st),
      st?.lastError ? h("details", {}, h("summary", {}, "Error details"), h("pre", { class: "mono" }, st.lastError)) : null,
      st?.lastActions?.length ? h("details", {}, h("summary", {}, `Recent activity (${st.lastActions.length})`), h("pre", { class: "mono" }, st.lastActions.join("\n"))) : null);
  };
  const section = (title, list, kind, sub) => (list.length ? h("div", {}, h("h3", {}, title), sub ?? null, h("div", { class: "watcher-list" }, list.map((w) => card(w, kind)))) : null);
  const add = () => h("button", { class: "primary", onClick: async () => (await repoWatcherDialog({ repos, flows, existing: null })) && reload() }, "+ Add watcher");

  mount(main,
    h("div", { class: "toolbar" }, h("h1", {}, "Watchers"),
      h("span", { class: "muted" }, "Poll GitHub and start runs automatically while this server runs"),
      h("span", { class: "spacer" }),
      h("button", { onClick: reload }, "↻"),
      monitor.length ? null : h("button", { onClick: async () => (await monitorDialog(null, saveMonitor(null))) && reload() }, "+ Add the monitor"),
      add()),
    watchers.length ? [
      ...groups.map(({ repo, watchers: list }) => section(repo.url, list, "repo",
        h("p", { class: "muted flush mb-6" }, "Owner: ", ownerText(repo), repo.account?.status === "blocked" ? [" ", h("span", { class: "pill" }, "blocked")] : null))),
      section("Repository not connected any more", gone, "gone"),
      section("The Foundry itself", monitor, "monitor"),
      section("From config.yaml", file, "file"),
    ] : h("div", { class: "empty" },
      h("p", {}, "No watchers yet. A watcher checks a GitHub repo on a schedule and runs a flow: for labelled issues, review comments, red CI on the default branch, or a recurring chore."),
      add()),
    h("p", { class: "muted mt-16" },
      "Watchers run inside this server. To keep them running after you close the terminal or restart your Mac: ",
      h("code", {}, "scf service install")));
}

// ── disk ──

function diskSection(section) {
  const days = input("7", { type: "number", min: 0, class: "w-90" });
  const purge = check(false, "Also delete run logs");
  const paused = check(false, "Include stopped / waiting runs (they can't be resumed afterwards)");
  const out = h("div");
  const go = async (dryRun) => {
    if (!dryRun && !confirm("Remove these workspaces now? Branches in your repos are kept.")) return;
    try {
      const r = await api.clean({ olderThanDays: Number(days.value), purge: purge.el.checked, includePaused: paused.el.checked, dryRun });
      mount(out, h("p", { class: dryRun ? "muted flush" : "status ok flush" },
        `${dryRun ? "Would remove" : "Removed"} ${r.workspaces.length} workspace(s)${r.runs.length ? ` and ${r.runs.length} run(s)` : ""} · ${r.freedMb} MB`,
        r.kept.length ? ` · keeping ${r.kept.length} paused/running` : ""));
    } catch (e) {
      toast(e.message, "error");
    }
  };
  return section("Disk",
    h("p", { class: "muted flush" }, "Each run keeps its workspace (worktree or clone) so you can inspect or resume it. Clean up old ones here or with ", h("code", {}, "scf clean"), "."),
    h("div", { class: "row" }, h("span", {}, "Runs finished more than"), days, h("span", {}, "days ago")),
    purge.row, paused.row,
    h("div", { class: "row" }, h("button", { onClick: () => go(true) }, "Preview"), h("button", { class: "danger", onClick: () => go(false) }, "Clean up"), out));
}

// ── settings ──

export async function renderSettings(main) {
  const [c, info] = await Promise.all([api.config(), api.info()]);
  const budget = input(c.daily_budget_usd ?? "", { type: "number", step: "0.5", placeholder: "no limit" });
  const limits = check(c.cost_limits !== false, "Enforce cost limits (run, step and daily budgets)");
  const conc = input(String(c.concurrency), { type: "number", min: 1 });
  const protectedB = input(c.protected_branches.join(", "), { class: "mono" });
  const macos = check(c.notify.macos, "macOS notifications");
  const slack = input(c.notify.slack_webhook ?? "", { class: "mono", placeholder: "https://hooks.slack.com/services/…" });
  const cmd = input(c.notify.command ?? "", { class: "mono", placeholder: 'e.g. say "$FACTORY_STATUS"' });
  const successes = check(c.notify.successes, "Also notify when a run succeeds");
  const throttle = input(c.notify.throttle_minutes ?? 5, { type: "number", min: 1 });
  const quietFrom = input(c.notify.quiet_hours?.from ?? "", { type: "time" });
  const quietTo = input(c.notify.quiet_hours?.to ?? "", { type: "time" });
  const summaryAt = input(c.notify.daily_summary_at ?? "", { type: "time" });
  const on = ["succeeded", "failed", "stopped", "waiting", "cancelled"].map((s) => [s, check(c.notify.on.includes(s), s)]);
  const botName = input(c.bot.name ?? "", { placeholder: "claude-factory[bot]" });
  const botEmail = input(c.bot.email ?? "", { class: "mono" });
  const botToken = input(c.bot.gh_token_env ?? "", { class: "mono", placeholder: "FACTORY_GH_TOKEN" });
  const appId = input(c.github_app?.app_id ?? "", { class: "mono" });
  const appSlug = input(c.github_app?.slug ?? "", { class: "mono" });
  const instId = input(c.github_app?.installation_id ?? "", { class: "mono" });
  const keyPath = input(c.github_app?.private_key_path ?? "", { class: "mono", placeholder: "/path/to/app.private-key.pem" });
  const sbxClaude = check(c.sandbox.claude, "Sandbox agents' shell commands by default");
  const sbxOff = check(c.sandbox.user_runs === "off", "Allow user runs without the OS sandbox");
  const secrets = check(c.secret_scan !== false, "Block pushes that add secrets (API keys, tokens, private keys, .env files)");
  const hotfix = check(c.hotfix_to_main === true, "Hotfixes: build bug stories on a hotfix branch and merge them into main without a person (only the unchanged built-in issue-gitflow)");
  const sbxImage = input(c.sandbox.docker_image ?? "", { class: "mono", placeholder: "e.g. node:22" });
  const selfUpdate = check(c.self_update?.enabled === true, "Self-update: when main of the Foundry's own repository has new commits, build and test them and restart on the new version without a person");
  const selfRepo = input(c.self_update?.repo ?? "", { class: "mono", placeholder: "owner/name" });
  const net = c.server ?? { listen: "127.0.0.1", allowed_hosts: [], allow_insecure_http: false };
  const listenSel = h("select", {}, ["127.0.0.1", "::1", "0.0.0.0", "::"].map((a) => h("option", { value: a }, a)));
  listenSel.value = net.listen;
  const hostsIn = input(net.allowed_hosts.join(", "), { class: "mono", placeholder: "mymac.local" });
  const insecure = check(net.allow_insecure_http, "Allow plain HTTP from other computers");
  const auditDays = input(String(c.audit?.retention_days ?? 180), { type: "number", min: 1, max: 3650, step: 1 });
  const redesign = check(c.ui?.redesign === true, "Show the redesigned pages (still being built)");
  const err = h("div");

  const save = async () => {
    const next = {
      ...c,
      ui: { ...c.ui, redesign: redesign.el.checked },
      audit: { ...c.audit, retention_days: auditDays.value.trim() === "" ? 180 : Number(auditDays.value) },
      server: serverFrom({ listen: listenSel.value, hosts: hostsIn.value, insecure: insecure.el.checked }),
      daily_budget_usd: num(budget),
      cost_limits: limits.el.checked,
      concurrency: Number(conc.value) || 1,
      protected_branches: protectedB.value.split(",").map((s) => s.trim()).filter(Boolean),
      secret_scan: secrets.el.checked,
      hotfix_to_main: hotfix.el.checked,
      self_update: { enabled: selfUpdate.el.checked, repo: selfRepo.value.trim() || undefined },
      notify: notifyFrom({
        macos: macos.el.checked, slack: slack.value, command: cmd.value, on: on.filter(([, x]) => x.el.checked).map(([s]) => s),
        successes: successes.el.checked, throttle: throttle.value, quietFrom: quietFrom.value, quietTo: quietTo.value, summaryAt: summaryAt.value,
      }),
      bot: { name: botName.value.trim() || undefined, email: botEmail.value.trim() || undefined, gh_token_env: botToken.value.trim() || undefined },
      github_app: appId.value.trim()
        ? { app_id: appId.value.trim(), private_key_path: keyPath.value.trim(), slug: appSlug.value.trim() || undefined, installation_id: instId.value.trim() || undefined }
        : undefined,
      sandbox: { ...c.sandbox, claude: sbxClaude.el.checked || undefined, docker_image: sbxImage.value.trim() || undefined, user_runs: sbxOff.el.checked ? "off" : "required" },
    };
    try {
      await api.saveConfig(next);
      mount(err);
      toast("Settings saved");
    } catch (e) {
      mount(err, h("div", { class: "errors" }, e.message));
    }
  };

  const section = (title, ...children) => h("div", { class: "card mb-14" }, h("h3", {}, title), ...children);
  mount(main,
    h("div", { class: "toolbar" }, h("h1", {}, "Settings"), h("span", { class: "muted mono" }, info.configPath), h("span", { class: "spacer" }), h("button", { class: "primary", onClick: save }, "Save")),
    err,
    section("Budget & capacity",
      limits.row,
      h("p", { class: "muted text-sm mt-4 mb-10" }, "Off: costs are still recorded and shown (Dashboard, runs), but no run is ever stopped because of money — for fixed-price subscriptions. Claude's and Codex's own usage limits still pause runs."),
      h("div", { class: "grid" },
        f("Daily budget ($)", budget, `Spent today: $${info.spentToday.toFixed(2)}. When reached, runs pause (stopped) and resume the next day.`),
        f("Runs at the same time", conc))),
    section("Redesign",
      redesign.row,
      h("p", { class: "muted" }, "Off by default. Applies after you reload the page.")),
    section("Network",
      h("p", { class: "muted flush" }, "Who can reach this page. For other computers, use HTTPS through a proxy on this Mac (see the user guide)."),
      info.listening && info.listening !== net.listen ? h("p", { class: "status bad flush" }, `Now listening on ${info.listening} — restart the server to use ${net.listen}`) : null,
      h("div", { class: "grid" },
        f("Listen on", listenSel, "127.0.0.1: this Mac only. 0.0.0.0 and :: reach all networks (needs an admin account). Needs a restart."),
        f("Allowed host names", hostsIn, "Names people type, comma-separated, e.g. mymac.local.")),
      insecure.row,
      h("p", { class: "muted text-sm flush mt-4" }, "Warning: with plain HTTP, passwords and session cookies cross the network unencrypted. Use it only on a network you trust.")),
    section("Safety",
      f("Protected branches", protectedB, "Pushes to these are refused during runs (glob patterns, comma-separated). Also enable branch protection on GitHub."),
      secrets.row,
      hotfix.row,
      selfUpdate.row,
      f("Repository the Foundry may update from", selfRepo, "owner/name. Updates come only when the checkout's origin is this repository. Needs one stop and start of the Foundry after upgrading."),
      sbxClaude.row,
      sbxOff.row,
      h("p", { class: "muted text-sm mt-4 mb-10" }, "Off by default. Without the sandbox, a shell step of a user's run can read this Mac account's files."),
      f("Docker image for sandboxed shell steps", sbxImage, "Steps marked “Run in Docker” (like tests) run in this image with only the workspace mounted."),
      f("Keep the audit log for … days", auditDays, "1 to 3650. Older lines are removed when the server starts and once a day.")),
    section("Notifications",
      macos.row,
      h("p", { class: "muted text-sm mt-4 mb-10" },
        "Tells you only when something waits for you. ",
        info.clickThrough === true ? "A click opens the item." : info.clickThrough === false ? "Install terminal-notifier (brew install terminal-notifier) and restart to open the item with a click." : ""),
      successes.row,
      h("div", { class: "grid" },
        f("At most one notification every … minutes", throttle),
        f("Quiet hours from", quietFrom, "Leave both empty for no quiet hours."),
        f("Quiet hours to", quietTo),
        f("Daily summary at", summaryAt, "Empty: no summary.")),
      h("div", { class: "grid" }, f("Slack webhook", slack), f("Command", cmd, "Runs with $FACTORY_STATUS, $FACTORY_RUN_ID, $FACTORY_MESSAGE.")),
      h("div", { class: "row" }, h("span", { class: "muted" }, "Run the command when a run is:"), on.map(([, x]) => x.row))),
    section("Bot identity",
      h("p", { class: "muted flush" }, "By default commits and comments are made as you (your git config and gh login)."),
      h("div", { class: "grid" }, f("Commit author name", botName), f("Commit author email", botEmail), f("Env var with the bot's GitHub token", botToken, "Used as GH_TOKEN for gh and git pushes."))),
    diskSection(section),
    section("GitHub App",
      h("div", { class: "grid" },
        f("App ID", appId),
        f("App name (slug)", appSlug, "The last part of https://github.com/apps/<name>. Needed for the method “GitHub App” on My repositories."),
        f("Private key file", keyPath, "The .pem file of the app, readable only by the server's account."),
        f("Installation ID (optional)", instId, "Only for the bot identity: runs then commit and comment as the app."))));
}
