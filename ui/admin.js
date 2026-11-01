import { api, configVersion } from "./api.js";
import { confirmDialog, fieldFor, h, markInvalid, mount, toast } from "./dom.js";
import { describedSections, generatedSection, hintFor, hinted, startupSection } from "./admin-sections.js";
import { skillsSection } from "./settings-skills.js";
import { check, field as f, input, lockReadOnly } from "./fields.js";
import { poller } from "./live.js";
import { promotionPanel } from "./promotions.js";
import { componentsPanel } from "./admin-components.js";
import { loadingState } from "./states.js";
import { settingsPage } from "./templates.js";

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
  const [c, info, s, restart] = await Promise.all([api.config(), api.info(), api.settings(), api.restartState().catch(() => undefined)]);
  const described = Array.isArray(s?.settings) ? s.settings : [];
  const startup = Array.isArray(s?.startup) ? s.startup : [];
  const hint = (key, extra) => hintFor(described, key, extra);
  const section = (title, ...children) => h("div", { class: "card mb-14" }, h("h3", {}, title), ...children);
  const skills = skillsSection(described, c.skills, { disabled: readOnly });
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
  const extra = describedSections(c, described, { section, readOnly });
  const askScf = generatedSection("Ask SCF", "help.", c, described, { section, readOnly });
  const deliveryCard = generatedSection("Delivery", "delivery.", c, described, { section, readOnly });
  const policyCard = generatedSection("Policy", "policy.", c, described, { section, readOnly });
  const promotionCard = generatedSection("Promotion", "promotion.", c, described, { section, readOnly });
  const governorCard = generatedSection("Load governor", "governor.", c, described, { section, readOnly });
  const retryCard = generatedSection("Retries", "auto_retry.", c, described, { section, readOnly });
  // the hand-built controls and the current controls of the described cards (those are drawn again when their message changes)
  const fieldsNow = () => ({ ...fields, ...extra.inputs(), ...askScf.inputs(), ...deliveryCard.inputs(), ...policyCard.inputs(), ...promotionCard.inputs(), ...governorCard.inputs(), ...retryCard.inputs() });
  const QUOTED = new Set(["name", "email", "repo", "command", "pass"]);
  const SETTINGS_PAIRS = Object.keys(fieldsNow()).map((k) => [new RegExp(QUOTED.has(k) ? `"${k}"` : `\\b${k}\\b`), k]);

  const save = async () => {
    const bad = extra.check() ?? askScf.check() ?? deliveryCard.check() ?? policyCard.check() ?? promotionCard.check() ?? governorCard.check() ?? retryCard.check();
    if (bad) {
      mount(err);
      saveNote.setAttribute("class", "status bad");
      mount(saveNote, "Not saved.");
      bad.focus();
      return;
    }
    const risks = skills.risks();
    if (risks.length && !(await confirmDialog({ title: "Lower the safety of skills?", text: risks.map((r) => r.text).join(" "), confirm: "Save anyway" }))) {
      saveNote.setAttribute("class", "status bad");
      mount(saveNote, "Not saved.");
      return;
    }
    const v = extra.values();
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
      help: askScf.values(),
      delivery: deliveryCard.values(),
      policy: policyCard.values(),
      promotion: promotionCard.values(),
      governor: governorCard.values(),
      auto_retry: retryCard.values(),
      isolate_agents: v.isolate_agents,
      failure_summary: v.failure_summary,
      step_env: v.step_env,
      sandbox: { ...c.sandbox, user_read: v.user_read, claude: sbxClaude.el.checked || undefined, docker_image: sbxImage.value.trim() || undefined, user_runs: sbxOff.el.checked ? "off" : "required" },
    };
    saveBtn.disabled = true;
    saveNote.setAttribute("class", "status");
    mount(saveNote, "Saving…");
    skills.busy(true);
    try {
      const saved = await api.saveConfig(next, version);
      skills.busy(false);
      skills.showIssues([]);
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
      markInvalid(Object.values(fieldsNow()));
      extra.restore(); // a list changed while the request ran can still be wrong
      askScf.restore();
      deliveryCard.restore();
      policyCard.restore();
      promotionCard.restore();
      governorCard.restore();
      retryCard.restore();
      saveNote.setAttribute("class", "status ok");
      mount(saveNote, `Saved at ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
      toast("Settings saved");
    } catch (e) {
      skills.busy(false);
      const issues = Array.isArray(e.data?.issues) ? e.data.issues : [];
      const unplaced = skills.showIssues(issues);
      const placed = issues.length - unplaced.length;
      const onlyCard = placed > 0 && unplaced.length === 0 && issues.length < 50;
      mount(err, h("div", { class: "errors", role: "alert" }, onlyCard ? "Not saved: see the messages in the Skills card." : e.message));
      const now = fieldsNow();
      // With structured issues, only the ones left in the banner name a hand-built control.
      // A path names its control directly (its last part is the key); the sentence is the fallback.
      const named = placed > 0 ? unplaced.map((i) => (typeof i?.path === "string" ? (Object.hasOwn(now, i.path) ? i.path : i.path.split(".").pop()) : undefined)).find((k) => k && Object.hasOwn(now, k)) : undefined;
      const text = placed > 0 ? unplaced.map((i) => `${i?.path ?? ""} ${i?.message ?? ""}`).join(" ") : e.message;
      markInvalid(Object.values(now), e.status === 409 || onlyCard ? undefined : now[named ?? fieldFor(text, SETTINGS_PAIRS)]);
      extra.restore();
      askScf.restore();
      deliveryCard.restore();
      policyCard.restore();
      promotionCard.restore();
      governorCard.restore();
      retryCard.restore();
      saveNote.setAttribute("class", "status bad");
      mount(saveNote, "Not saved.");
    } finally {
      saveBtn.disabled = false;
    }
  };

  mount(main, settingsPage({
    title: "Settings",
    actions: [h("span", { class: "muted mono" }, info.configPath), ...(readOnly ? [] : [h("span", { class: "spacer" }), saveNote, saveBtn])],
    notices: [err, restartSlot],
    sections: [
    section("Budget & capacity",
      hinted(limits.row, limits.el, hint("cost_limits", "Claude's and Codex's own usage limits still pause runs.")),
      h("div", { class: "grid" },
        f("Daily budget ($)", budget, hint("daily_budget_usd", `Spent today: $${info.spentToday.toFixed(2)}.`)),
        f("Runs at the same time", conc, hint("concurrency")))),
    ...(governorCard.card ? [governorCard.card] : []),
    section("Redesign",
      hinted(redesign.row, redesign.el, hint("ui.redesign", "Off by default. Applies after you reload the page."))),
    section("Network",
      h("p", { class: "muted flush" }, "Who can reach this page. For other computers, use HTTPS through a proxy on this Mac (see the user guide)."),
      h("div", { class: "grid" },
        f("Listen on", listenSel, hint("server.listen", "0.0.0.0 and :: need an admin account.")),
        f("Allowed host names", hostsIn, hint("server.allowed_hosts", "Comma-separated, for example mymac.local."))),
      hinted(insecure.row, insecure.el, hint("server.allow_insecure_http")),
      h("p", { class: "muted text-sm flush mt-4" }, "Warning: with plain HTTP, passwords and session cookies cross the network unencrypted. Use it only on a network you trust.")),
    section("Safety",
      f("Protected branches", protectedB, hint("protected_branches", "Comma-separated. Also turn on branch protection on GitHub.")),
      hinted(secrets.row, secrets.el, hint("secret_scan")),
      hinted(hotfix.row, hotfix.el, hint("hotfix_to_main")),
      hinted(selfUpdate.row, selfUpdate.el, hint("self_update.enabled")),
      f("Repository the Foundry may update from", selfRepo, hint("self_update.repo", "Needs one stop and start of the Foundry after upgrading.")),
      hinted(sbxClaude.row, sbxClaude.el, hint("sandbox.claude")),
      hinted(sbxOff.row, sbxOff.el, hint("sandbox.user_runs", "Without the sandbox, a shell step of a user's run can read this Mac account's files.")),
      f("Docker image for sandboxed shell steps", sbxImage, hint("sandbox.docker_image", "Steps marked “Run in Docker” run in this image with only the workspace mounted.")),
      f("Keep the audit log for … days", auditDays, hint("audit.retention_days"))),
    skills.el,
    ...extra.cards,
    ...(askScf.card ? [askScf.card] : []),
    ...(deliveryCard.card ? [deliveryCard.card] : []),
    section("Notifications",
      hinted(macos.row, macos.el, hint("notify.macos")),
      h("p", { class: "muted text-sm mt-4 mb-10" },
        "Tells you only when something waits for you. ",
        info.clickThrough === true ? "A click opens the item." : info.clickThrough === false ? "Install terminal-notifier (brew install terminal-notifier) and restart to open the item with a click." : ""),
      hinted(successes.row, successes.el, hint("notify.successes")),
      h("div", { class: "grid" },
        f("At most one notification every … minutes", throttle, hint("notify.throttle_minutes")),
        f("Quiet hours from", quietFrom, hint("notify.quiet_hours.from", "Leave both empty for no quiet hours.")),
        f("Quiet hours to", quietTo, hint("notify.quiet_hours.to")),
        f("Daily summary at", summaryAt, hint("notify.daily_summary_at", "Empty: no summary."))),
      h("div", { class: "grid" },
        h("div", {},
          h("label", { class: "field" }, h("span", {}, "Slack webhook: ", slackState), slack, h("small", {}, hint("notify.slack_webhook", "Enter a new address to replace it; leave empty to keep it."))),
          slackRemove.row),
        f("Command", cmd, hint("notify.command"))),
      h("div", { class: "row" }, h("span", { class: "muted" }, "Run the command when a run is:"), on.map(([, x]) => x.row)),
      h("small", { class: "muted" }, hint("notify.on"))),
    section("Bot identity",
      h("p", { class: "muted flush" }, "By default commits and comments are made as you (your git config and gh login)."),
      h("div", { class: "grid" }, f("Commit author name", botName, hint("bot.name")), f("Commit author email", botEmail, hint("bot.email")), f("Env var with the bot's GitHub token", botToken, hint("bot.gh_token_env")))),
    section("GitHub App",
      h("div", { class: "grid" },
        f("App ID", appId, hint("github_app.app_id")),
        f("App name (slug)", appSlug, hint("github_app.slug", "Needed for the method “GitHub App” on My repositories.")),
        f("Private key file", keyPath, hint("github_app.private_key_path")),
        f("Installation ID (optional)", instId, hint("github_app.installation_id"))),
      h("p", { class: "muted flush" }, h("a", { href: "#/all-repos?method=github-app" }, "Repositories that use the app"))),
    ...(policyCard.card ? [policyCard.card] : []),
    ...(promotionCard.card ? [promotionCard.card] : []),
    promotionPanel({ readOnly }),
    ...(retryCard.card ? [retryCard.card] : []),
    componentsPanel(),
    ...(startup.length ? [startupSection(startup, section)] : []),
    ],
  }));
  if (readOnly) lockReadOnly(main);
  return () => poll?.stop();
}
