import { DETAIL_MAX, auditAction } from "../auth/audit.js";
import { describeSettings } from "../settings/describe.js";
import { RESTART_CODE } from "../supervise.js";
import { HttpError, send } from "./http.js";
import type { RestartState } from "./next.js";
import type { ApiContext, Route } from "./server.js";

export interface SettingsRestartOptions {
  /** True when no run is active (and nothing else keeps the server busy). */
  idle: () => boolean;
  drain: () => void;
  undrain: () => void;
  /** Another restart (new version, data folder) waits: it applies the settings too. */
  other: () => boolean;
  beforeExit: () => void;
  log: (m: string) => void;
  supervised?: () => boolean;
  exit?: (code: number) => void;
  everyMs?: number;
}

/** The restart an admin asked for after a settings change: waits until no run is active, then exits for the supervisor. */
export class SettingsRestart {
  private since?: string;
  private timer?: NodeJS.Timeout;

  constructor(private o: SettingsRestartOptions) {}

  /** True when the server runs under the supervisor, which starts it again on exit code 75. */
  available(): boolean {
    return (this.o.supervised ?? (() => process.env.FACTORY_SUPERVISED === "1"))();
  }

  waiting(): { since: string } | undefined {
    return this.since === undefined ? undefined : { since: this.since };
  }

  /** "started" or "waiting": the restart waits now; "unsupervised" and "other": nothing changed. */
  request(): "started" | "waiting" | "unsupervised" | "other" {
    if (!this.available()) return "unsupervised";
    if (this.o.other()) return "other";
    if (this.since !== undefined) return "waiting";
    this.since = new Date().toISOString();
    this.o.drain();
    this.o.log("settings: restart asked for — no new runs start; restarting when the active runs are done");
    // the first check is one tick away, so the answer to the request is sent before any exit
    this.timer = setInterval(() => this.tick(), this.o.everyMs ?? 5_000);
    this.timer.unref();
    return "started";
  }

  /** False when no restart of its own waits (or another restart took over). */
  cancel(): boolean {
    if (this.since === undefined || this.o.other()) return false;
    this.clear();
    this.o.undrain();
    this.o.log("settings: restart cancelled — runs and watchers start again");
    return true;
  }

  /** Clears the timer (before the exit, in tests). */
  stop(): void {
    this.clear();
  }

  private clear() {
    clearInterval(this.timer);
    this.timer = undefined;
    this.since = undefined;
  }

  private tick() {
    if (this.o.other()) {
      this.clear();
      this.o.log("settings: another restart waits and applies the changed settings too");
      return;
    }
    if (!this.o.idle()) return;
    clearInterval(this.timer);
    this.timer = undefined;
    this.o.log("settings: restarting for a changed setting");
    this.o.beforeExit();
    (this.o.exit ?? process.exit)(RESTART_CODE);
  }
}

export function settingsRestartFor(ctx: ApiContext, o: Pick<SettingsRestartOptions, "idle" | "beforeExit" | "log" | "supervised" | "exit" | "everyMs">): SettingsRestart {
  return new SettingsRestart({
    ...o,
    drain: () => {
      ctx.restart = { why: "settings", since: new Date().toISOString() };
      ctx.scheduler.drain();
      ctx.watchers.drain();
    },
    undrain: () => {
      if (ctx.restart?.why !== "settings") return;
      ctx.restart = undefined;
      ctx.scheduler.resume();
      if (ctx.opts.watchers !== false) ctx.watchers.sync();
    },
    other: () => !!ctx.restart && ctx.restart.why !== "settings",
  });
}

export interface RestartNeed { key: string; label: string; running: string; saved: string }

const show = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v) ?? "");

function valueAt(obj: unknown, key: string): unknown {
  let cur: any = obj;
  for (const part of key.split(".")) cur = cur?.[part];
  return cur;
}

/** The saved settings that apply only after a restart and differ from the running value. */
export function restartNeeded(ctx: ApiContext): RestartNeed[] {
  const out: RestartNeed[] = [];
  const saved = ctx.fileConfig();
  if (saved.server.listen !== ctx.listen) out.push({ key: "server.listen", label: "Listen on", running: ctx.listen, saved: saved.server.listen });
  if (ctx.started) {
    for (const s of describeSettings()) {
      if (s.effect !== "restart" || s.key === "server.listen") continue; // listen is compared with the running address above
      const running = valueAt(ctx.started, s.key);
      const now = valueAt(saved, s.key);
      if (JSON.stringify(running) !== JSON.stringify(now)) out.push({ key: s.key, label: s.label, running: show(running), saved: show(now) });
    }
  }
  return out;
}

export interface RestartView {
  needed: RestartNeed[];
  canRestart: boolean;
  manual?: string;
  waiting?: { why: RestartState["why"]; since: string; activeRuns: number; cancellable: boolean };
}

export function restartView(ctx: ApiContext): RestartView {
  const canRestart = !!ctx.settingsRestart?.available();
  const view: RestartView = { needed: restartNeeded(ctx), canRestart };
  if (!canRestart) view.manual = "This server cannot restart itself (it runs without the supervisor, FACTORY_NO_SUPERVISE=1). Stop it and start it again with scf ui to use the new values.";
  if (ctx.restart) view.waiting = { why: ctx.restart.why, since: ctx.restart.since, activeRuns: ctx.scheduler.queue().active.length, cancellable: ctx.restart.why === "settings" };
  return view;
}

const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();

export const restartRoutes: Route = async (ctx, _req, res, seg, method, user) => {
  if (seg[0] !== "restart" || seg[1]) return false;
  if (method === "GET") return send(res, 200, restartView(ctx)), true;
  const sr = ctx.settingsRestart;
  const otherWaits = !!ctx.restart && ctx.restart.why !== "settings";
  if (method === "POST") {
    if (!sr?.available()) throw new HttpError(409, "This server cannot restart itself: stop it and start it again");
    if (otherWaits) throw new HttpError(409, "The server already waits to restart on a new version or a moved data folder; that restart applies the settings too");
    const needed = restartNeeded(ctx);
    if (needed.length === 0 && !sr.waiting()) throw new HttpError(409, "No saved setting needs a restart");
    const r = sr.request();
    if (r === "unsupervised") throw new HttpError(409, "This server cannot restart itself: stop it and start it again");
    if (r === "other") throw new HttpError(409, "The server already waits to restart on a new version or a moved data folder; that restart applies the settings too");
    if (r === "started") {
      const detail = clean(needed.map((n) => `${n.key}: ${n.running} -> ${n.saved}`).join("; ")).slice(0, DETAIL_MAX);
      auditAction(ctx.diagLog, user.id, "restart-request", "server", detail || undefined);
    }
    return send(res, 200, restartView(ctx)), true;
  }
  if (method === "DELETE") {
    if (!sr?.cancel()) {
      throw new HttpError(409, otherWaits ? "The restart for a new version or a moved data folder cannot be cancelled here" : "Nothing waits to restart");
    }
    auditAction(ctx.diagLog, user.id, "restart-cancel", "server");
    return send(res, 200, restartView(ctx)), true;
  }
  return false;
};
