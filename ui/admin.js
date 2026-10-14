import { api, configVersion } from "./api.js";
import { confirmDialog, fieldFor, h, markInvalid, mount, toast } from "./dom.js";
import { skillsSection } from "./settings-skills.js";
import { check, input, lockReadOnly } from "./fields.js";
import { poller } from "./live.js";
import { loadingState } from "./states.js";
import { settingsPage } from "./templates.js";

const f = (label, el, hint) => h("label", { class: "field" }, h("span", {}, label), el, hint ? h("small", {}, hint) : null);
const num = (el) => (el.value.trim() === "" ? undefined : Number(el.value));

export { lastOkText, watcherNotes, storiesLine, storiesRow, watcherStateMark, describeWatcher, watcherGroups, monitorEntry } from "./watchers.js";

/** The `notify` setting from the raw values of the Settings controls (strings for text, booleans for checkboxes). */
export function notifyFrom(v) {
  const t = (x) => String(x ?? "").trim();
  return {
    macos: !!v.macos,
    // empty: the server keeps the stored webhook; null removes it
    slack_webhook: t(v.slack) || (v.removeSlack ? null : undefined),
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

// ── settings ──

const WAIT_WHY = {
  settings: "The server waits to restart for a changed setting.",
  new_version: "The server waits to restart on a new version.",
  data_folder: "The server waits to restart onto a moved data folder.",
};

/**
 * The box about a restart: what needs one, and the button or the wait. Null when `view` is not a restart view
 * (an old server) or there is nothing to say.
 */
export function restartBox(view, { onRequest, onCancel, readOnly = false } = {}) {
  if (!view || !Array.isArray(view.needed)) return null;
  const w = view.waiting;
  if (w) {
    const left = w.activeRuns > 0
      ? `${w.activeRuns} active run${w.activeRuns === 1 ? "" : "s"} left — no new runs start and the watchers are stopped until then.`
      : "It restarts in a moment.";
    return h("div", { class: "card mb-14" },
      h("p", { class: "status flush", role: "status" }, `${WAIT_WHY[w.why] ?? WAIT_WHY.new_version} ${left}`),
      w.cancellable && !readOnly ? h("button", { onClick: () => onCancel?.() }, "Cancel the restart") : null);
  }
  if (view.needed.length === 0) return null;
  const list = view.needed.map((n) => `${n.label} ${n.running} → ${n.saved}`).join("; ");
  return h("div", { class: "card mb-14" },
    h("p", { class: "status bad flush", role: "status" }, `A restart is needed: ${list}.`),
    view.canRestart
      ? (readOnly ? null : h("button", { class: "primary", onClick: () => onRequest?.() }, "Restart when no story is running"))
      : h("p", { class: "muted flush" }, view.manual ?? "Stop the server and start it again to use the new values."));
}

export async function renderSettings(main, { readOnly = false } = {}) {
  mount(main, settingsPage({ title: "Settings", sections: loadingState("Loading settings…", { rows: 6, shape: "detail" }) }));
  const [c, info, restart, described] = await Promise.all([api.config(), api.info(), api.restartState().catch(() => undefined), api.settings().catch(() => undefined)]);
  const skills = skillsSection(described?.settings, c.skills, { disabled: readOnly });
  let version = configVersion(c);
  const budget = input(c.daily_budget_usd ?? "", { type: "number", step: "0.5", placeholder: "no limit" });
  const limits = check(c.cost_limits !== false, "Enforce cost limits (run, step and daily budgets)");
  const conc = input(String(c.concurrency), { type: "number", min: 1 });
  const protectedB = input(c.protected_branches.join(", "), { class: "mono" });
  const macos = check(c.notify.macos, "macOS notifications");
  let hookSet = c.notify.slack_webhook_set === true;
  const slack = input("", { class: "mono", placeholder: "https://hooks.slack.com/services/…", autocomplete: "off" });
  const slackState = h("span", {}, hookSet ? "set" : "not set");
  const slackRemove = check(false, "Remove the Slack webhook");
  slackRemove.el.disabled = !hookSet;
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
  const restartSlot = h("div");
  let poll;
  const drawRestart = (view) => mount(restartSlot, restartBox(view, { onRequest: () => restartAction(api.requestRestart), onCancel: () => restartAction(api.cancelRestart), readOnly }));
  const restartAction = async (call) => {
    try {
      const view = await call();
      mount(err);
      if (poll) poll.show(view);
      else drawRestart(view);
    } catch (e) {
      mount(err, h("div", { class: "errors", role: "alert" }, e.message));
    }
  };
  drawRestart(restart);
  // Only a server that has the restart route gets the poller: the box follows the runs, another admin and the restart itself.
  if (restart && Array.isArray(restart.needed)) poll = poller({ load: () => api.restartState().catch(() => null), draw: drawRestart, every: 5000 });
  const saveNote = h("span", { class: "status", role: "status" });
  const saveBtn = h("button", { class: "primary", onClick: () => save() }, "Save");
  // the controls a server sentence can name, by the key of the setting
  const fields = {
    allowed_hosts: hostsIn, listen: listenSel, daily_budget_usd: budget, concurrency: conc, protected_branches: protectedB, retention_days: auditDays,
    slack_webhook: slack, command: cmd, throttle_minutes: throttle, quiet_hours: quietFrom, daily_summary_at: summaryAt, gh_token_env: botToken,
    app_id: appId, slug: appSlug, installation_id: instId, private_key_path: keyPath, docker_image: sbxImage, repo: selfRepo, name: botName, email: botEmail,
  };
  const SETTINGS_PAIRS = Object.keys(fields).map((k) => [new RegExp(k === "name" || k === "email" || k === "repo" || k === "command" ? `"${k}"` : `\\b${k}\\b`), k]);

  const save = async () => {
    const risks = skills.risks();
    if (risks.length && !(await confirmDialog({ title: "Lower the safety of skills?", text: risks.map((r) => r.text).join(" "), confirm: "Save anyway" }))) {
      saveNote.setAttribute("class", "status bad");
      mount(saveNote, "Not saved.");
      return;
    }
    const next = {
      ...c,
      skills: skills.value(),
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
        macos: macos.el.checked, slack: slack.value, removeSlack: slackRemove.el.checked, command: cmd.value, on: on.filter(([, x]) => x.el.checked).map(([s]) => s),
        successes: successes.el.checked, throttle: throttle.value, quietFrom: quietFrom.value, quietTo: quietTo.value, summaryAt: summaryAt.value,
      }),
      bot: { name: botName.value.trim() || undefined, email: botEmail.value.trim() || undefined, gh_token_env: botToken.value.trim() || undefined },
      github_app: appId.value.trim()
        ? { app_id: appId.value.trim(), private_key_path: keyPath.value.trim(), slug: appSlug.value.trim() || undefined, installation_id: instId.value.trim() || undefined }
        : undefined,
      sandbox: { ...c.sandbox, claude: sbxClaude.el.checked || undefined, docker_image: sbxImage.value.trim() || undefined, user_runs: sbxOff.el.checked ? "off" : "required" },
    };
    saveBtn.disabled = true;
    saveNote.setAttribute("class", "status");
    mount(saveNote, "Saving…");
    try {
      const saved = await api.saveConfig(next, version);
      version = configVersion(saved) ?? version;
      skills.saved(next.skills);
      hookSet = saved?.notify?.slack_webhook_set === true;
      mount(slackState, hookSet ? "set" : "not set");
      slack.value = "";
      slackRemove.el.checked = false;
      slackRemove.el.disabled = !hookSet;
      mount(err);
      if (poll) poll.refresh();
      else api.restartState().then(drawRestart).catch(() => {});
      markInvalid(Object.values(fields));
      saveNote.setAttribute("class", "status ok");
      mount(saveNote, `Saved at ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
      toast("Settings saved");
    } catch (e) {
      mount(err, h("div", { class: "errors", role: "alert" }, e.message));
      markInvalid(Object.values(fields), e.status === 409 ? undefined : fields[fieldFor(e.message, SETTINGS_PAIRS)]);
      saveNote.setAttribute("class", "status bad");
      mount(saveNote, "Not saved.");
    } finally {
      saveBtn.disabled = false;
    }
  };

  const section = (title, ...children) => h("div", { class: "card mb-14" }, h("h3", {}, title), ...children);
  mount(main, settingsPage({
    title: "Settings",
    actions: [h("span", { class: "muted mono" }, info.configPath), ...(readOnly ? [] : [h("span", { class: "spacer" }), saveNote, saveBtn])],
    notices: [err, restartSlot],
    sections: [
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
    skills.el,
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
      h("div", { class: "grid" },
        h("div", {},
          h("label", { class: "field" }, h("span", {}, "Slack webhook: ", slackState), slack, h("small", {}, "Never shown. Enter a new address to replace it; leave empty to keep it.")),
          slackRemove.row),
        f("Command", cmd, "Runs with $FACTORY_STATUS, $FACTORY_RUN_ID, $FACTORY_MESSAGE.")),
      h("div", { class: "row" }, h("span", { class: "muted" }, "Run the command when a run is:"), on.map(([, x]) => x.row))),
    section("Bot identity",
      h("p", { class: "muted flush" }, "By default commits and comments are made as you (your git config and gh login)."),
      h("div", { class: "grid" }, f("Commit author name", botName), f("Commit author email", botEmail), f("Env var with the bot's GitHub token", botToken, "Used as GH_TOKEN for gh and git pushes."))),
    section("GitHub App",
      h("div", { class: "grid" },
        f("App ID", appId),
        f("App name (slug)", appSlug, "The last part of https://github.com/apps/<name>. Needed for the method “GitHub App” on My repositories."),
        f("Private key file", keyPath, "The .pem file of the app, readable only by the server's account."),
        f("Installation ID (optional)", instId, "Only for the bot identity: runs then commit and comment as the app.")),
      h("p", { class: "muted flush" }, h("a", { href: "#/all-repos?method=github-app" }, "Repositories that use the app"))),
    ],
  }));
  if (readOnly) lockReadOnly(main);
  return () => poll?.stop();
}
