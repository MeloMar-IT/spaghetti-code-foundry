import { agentStatuses, providerStatuses, testSpec } from "../agents/health.js";
import { auditActions } from "../auth/audit.js";
import { changeDetail, configChanges } from "../auth/audit-changes.js";
import { configView, storedConfigProblem, withStoredWebhook } from "./config-view.js";
import { hasAdmin } from "../auth/users.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CONFIG_PATH, ConfigSchema, STALE_CONFIG, configVersion, editConfigText, parseConfigText, readConfigText, type Config } from "../config.js";
import { spentToday } from "../engine/state.js";
import { cleanRuns } from "../clean.js";
import { listEvalReports } from "../evals.js";
import { clickThrough } from "../notify.js";
import { DELETED_OWNER, ownerNames } from "../auth/run-owner.js";
import { effectiveLimits } from "../auth/limits.js";
import { computeStats, todayCostByOwner } from "../stats.js";
import { userUsage } from "./usage-view.js";
import { HttpError, readJson, send } from "./http.js";
import { hostAllowed, listenCovers, listenProblem } from "./net.js";
import { configIdProblem, fileWatcherProblem } from "../repos/watchers.js";
import { watcherRows } from "./api-repos.js";
import { FACTORY_HOME } from "../flow/load.js";
import { describeSettings, startupSettings } from "../settings/describe.js";
import { resolveClaudeBinAsync } from "../steps/claude.js";
import { resolveCodexBin } from "../steps/codex.js";
import type { Route } from "./server.js";

/** The settings in this text of the file; undefined when it cannot be read (the running ones are used then). */
function fileSnapshot(text: string): Config | undefined {
  try {
    return parseConfigText(text);
  } catch {
    return undefined;
  }
}

export const adminRoutes: Route = async (ctx, req, res, seg, method, user) => {
  const { opts, scheduler, watchers } = ctx;

  if (seg[0] === "info" && method === "GET") {
    const config = ctx.config();
    return send(res, 200, {
      repo: opts.repo,
      runsDir: opts.runsDir,
      configPath: CONFIG_PATH(),
      spentToday: spentToday(opts.runsDir),
      dailyBudget: config.cost_limits ? config.daily_budget_usd : undefined,
      costLimits: config.cost_limits,
      redesign: config.ui.redesign,
      listening: ctx.listen,
      clickThrough: process.platform === "darwin" ? clickThrough() : undefined,
    }), true;
  }

  if (seg[0] === "settings" && !seg[1] && method === "GET") {
    return send(res, 200, {
      settings: describeSettings(),
      startup: startupSettings({
        home: process.env.FACTORY_HOME ?? FACTORY_HOME,
        port: opts.port,
        repo: opts.repo,
        claudeBin: opts.claudeBin ?? (await resolveClaudeBinAsync()),
        codexBin: resolveCodexBin(),
        ghBin: process.env.FACTORY_GH_BIN ?? "gh",
      }),
    }), true;
  }

  if (seg[0] === "config") {
    if (method === "GET") {
      const text = readConfigText();
      res.setHeader("x-config-version", configVersion(text));
      return send(res, 200, configView(fileSnapshot(text) ?? ctx.fileConfig())), true;
    }
    if (method === "PUT") {
      const body = await readJson(req);
      // From here to the write there is no await, so two saves cannot interleave.
      const text = readConfigText();
      const sent = req.headers["x-config-version"];
      if (typeof sent === "string" && sent !== configVersion(text)) throw new HttpError(409, STALE_CONFIG);
      let saved;
      let out: { text: string } | undefined;
      let before: Config;
      try {
        before = parseConfigText(text);
      } catch (e) {
        throw new HttpError(400, `invalid config: ${storedConfigProblem(e)}`);
      }
      const merged = withStoredWebhook(body, before.notify.slack_webhook);
      try {
        // Do not let a change shut out the browser that sends it (or the proxy it comes through).
        const parsed = ConfigSchema.parse(merged);
        const next = parsed.server;
        if (!hostAllowed(req.headers.host, next.allowed_hosts, opts.port)) {
          throw new Error(`allowed_hosts must keep "${req.headers.host}", the name you are using now`);
        }
        if (!listenCovers(next.listen, req.socket.localAddress)) {
          throw new Error(`listen "${next.listen}" would not answer on ${req.socket.localAddress}, where you are connected`);
        }
        const problem = listenProblem(next.listen, hasAdmin);
        if (problem) throw new Error(problem);
        const inFile = before.watchers;
        // ids are unique on the whole install: only new duplicates and new collisions with the store are refused
        const stored = [...ctx.config().watchers.filter((w) => w.repoId !== undefined), ...ctx.blockedWatchers()];
        const bad = fileWatcherProblem(parsed.watchers, inFile) ?? configIdProblem(parsed.watchers, inFile, stored);
        if (bad) throw new Error(bad);
        const edited = editConfigText(text, merged);
        out = edited;
        saved = edited.config;
        if (edited.text !== text) {
          mkdirSync(dirname(CONFIG_PATH()), { recursive: true });
          writeFileSync(CONFIG_PATH(), edited.text);
        }
      } catch (e) {
        throw new HttpError(400, `invalid config: ${(e as Error).message}`);
      }
      auditActions(ctx.diagLog, user.id, "settings-change", "config.yaml", configChanges(before, saved).map((c) => changeDetail(c)));
      ctx.reloadConfig();
      watchers.sync();
      res.setHeader("x-config-version", configVersion(out.text));
      return send(res, 200, configView(saved)), true;
    }
  }

  if (seg[0] === "watchers") {
    if (!seg[1] && method === "GET") {
      const text = readConfigText();
      res.setHeader("x-config-version", configVersion(text));
      const file = fileSnapshot(text)?.watchers.find((w) => w.source === "monitor");
      const rows = watcherRows(ctx).map((w) => (file && w.source === "monitor" && w.id === file.id ? { ...w, file: { id: file.id, every: file.every, enabled: file.enabled } } : w));
      return send(res, 200, rows), true;
    }
    if (seg[1] && seg[2] === "tick" && method === "POST") return send(res, 200, await watchers.runNow(seg[1])), true;
  }

  if (seg[0] === "clean" && method === "POST") {
    const body = await readJson(req);
    const days = Number(body.olderThanDays ?? 7);
    if (!(days >= 0)) throw new HttpError(400, "olderThanDays must be >= 0");
    const evidenceDays = body.evidenceOlderThanDays;
    if (evidenceDays !== undefined && !(typeof evidenceDays === "number" && evidenceDays >= 0)) throw new HttpError(400, "evidenceOlderThanDays must be a number >= 0");
    return send(res, 200, cleanRuns({
      runsDir: opts.runsDir,
      olderThanDays: days,
      evidenceOlderThanDays: evidenceDays,
      purge: body.purge === true,
      includePaused: body.includePaused === true,
      dryRun: body.dryRun !== false,
      isActive: (id) => scheduler.isActive(id) || scheduler.isQueued(id),
    })), true;
  }

  if (seg[0] === "providers" && method === "GET") {
    const [agents, providers] = await Promise.all([agentStatuses(), providerStatuses(ctx.config())]);
    return send(res, 200, { agents, providers }), true;
  }

  if (seg[0] === "providers" && seg[1] === "test" && method === "POST") {
    const body = await readJson(req);
    if (typeof body.spec !== "string" || !body.spec.trim() || body.spec.length > 200) throw new HttpError(400, "spec required");
    try {
      return send(res, 200, await testSpec(body.spec, ctx.config(), { claudeBin: opts.claudeBin })), true;
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  }

  if (seg[0] === "evals" && method === "GET") return send(res, 200, listEvalReports()), true;

  if (seg[0] === "stats" && method === "GET") {
    const now = new Date(); // one clock for every "today" number
    const runs = scheduler.list(2000);
    const stats = computeStats(runs, 30, now);
    const active = new Map<string, number>();
    for (const a of scheduler.queue().active) {
      const o = scheduler.ownerOf(a.runId) ?? "";
      active.set(o, (active.get(o) ?? 0) + 1);
    }
    const byUser = userUsage(stats.byUser, {
      names: ownerNames(),
      active,
      runsToday: scheduler.startedTodayByOwner(now),
      costToday: todayCostByOwner(runs, now),
      limitsOf: (id) => effectiveLimits(id, ctx.diagLog),
      deletedName: DELETED_OWNER,
    });
    return send(res, 200, { ...stats, byUser }), true;
  }
  return false;
};
