import { storyKey } from "../monitor/breaker.js";
import { evidenceLines, readFindings, saveFindings, type Finding, type StoryRef } from "../monitor/findings.js";
import { fixState, tryAgain, waitsForPerson } from "../monitor/fix.js";
import { buildingStories, byUrgency, findingState, madeToday } from "../monitor/state.js";
import { breakerNow, breakerWhy, currentState, describeEntry, loadGuard, MAX_MUTE_HOURS, switchStories, validReason, writeLog, type Mute, type StoriesState } from "../monitor/guard.js";
import { activeMutes, addMute, endMute, muteFor, MuteError } from "../monitor/mutes.js";
import { markerHash } from "../monitor/story.js";
import { detectorInfo } from "../monitor/work-detectors.js";
import { HttpError, readJson, send, str } from "./http.js";
import type { ApiContext, Route } from "./server.js";

/**
 * The state as the card and the Problems page show it. `reportTo` is false when no repository is set for the stories.
 * `madeToday` counts the monitor's log, so it can be above `perDay`.
 */
function view(ctx: ApiContext) {
  const monitor = ctx.config().monitor;
  const state: StoriesState = currentState({ startedAt: ctx.watchers.startedAt, cooldownMinutes: monitor.cooldown_minutes });
  const open = breakerNow();
  const lastCheck = ctx.watchers.monitorLastCheck();
  return {
    ...state,
    ...(state.state === "breaker" ? { why: breakerWhy(state) } : {}),
    reportTo: !!monitor.report_to,
    running: ctx.watchers.monitorRunning(),
    ...(lastCheck ? { lastCheck } : {}),
    perDay: monitor.report_limits.per_day,
    madeToday: madeToday(new Date()),
    breaker: open ? { open: true, why: breakerWhy(open) } : { open: false },
  };
}

/** The public shape of a mute: a finding is named by its hash, never by its fingerprint. */
function muteView(m: Mute, byFingerprint: Map<string, Finding>) {
  const f = m.fingerprint !== undefined ? byFingerprint.get(m.fingerprint) : undefined;
  return {
    id: m.id,
    kind: m.kind,
    detector: m.detector,
    ...(m.fingerprint !== undefined ? { finding: markerHash(m.fingerprint) } : {}),
    ...(f ? { summary: f.summary } : {}),
    reason: m.reason,
    since: m.since,
    ...(m.until ? { until: m.until } : {}),
    by: m.by,
  };
}

/** Did the fix work? Only for a story in the repository the monitor writes to. */
const fixOf = (r: StoryRef, target?: string) => (target && r.repo.toLowerCase() === target.toLowerCase() ? fixState(r) : undefined);

/** The findings of the monitor (every stored one), the mutes in force and the detector names. */
function lists(ctx: ApiContext) {
  const config = ctx.config().monitor;
  const target = config.report_to;
  const read = readFindings();
  const findings = read.findings.sort(byUrgency);
  const byFingerprint = new Map(findings.map((f) => [f.fingerprint, f]));
  const mutes = activeMutes(loadGuard(), new Date());
  const building = buildingStories(ctx.scheduler);
  return {
    // The file cannot be read: the empty list is not "no findings".
    ...(read.broken ? { findingsUnreadable: true } : {}),
    findings: findings.map((f) => {
      const m = muteFor(mutes, f);
      const r = f.report;
      return {
        id: markerHash(f.fingerprint),
        detector: f.detector,
        summary: f.summary,
        severity: f.severity,
        firstSeen: f.firstSeen,
        lastSeen: f.lastSeen,
        count: f.count,
        gone: f.gone,
        state: findingState(f, { target, muted: !!m, building: !!r && building.has(storyKey(r.repo, r.issue)) }),
        ...(r ? { story: { issue: r.issue, url: r.url, state: r.muted ? "not_planned" : r.closedAt ? "closed" : "open", ...(fixOf(r, target) ? { fix: fixOf(r, target) } : {}) } } : {}),
        ...(f.due && !r ? { owed: true } : {}),
        ...(waitsForPerson(f, target) ? { needsYou: true } : {}),
        ...(m ? { mute: { id: m.id, kind: m.kind, reason: m.reason, ...(m.until ? { until: m.until } : {}) } } : {}),
      };
    }),
    mutes: mutes.map((m) => muteView(m, byFingerprint)),
    detectors: detectorInfo().map((d) => {
      const key = d.name.replace(/-/g, "_");
      const set = (config as Record<string, unknown>)[key];
      const thresholds = d.name !== "detector-failed" && set && typeof set === "object" ? (set as Record<string, number>) : undefined;
      const last = findings.filter((f) => f.detector === d.name).map((f) => Date.parse(f.lastSeen)).filter((t) => !Number.isNaN(t));
      return { ...d, key, ...(thresholds ? { thresholds: { ...thresholds } } : {}), ...(last.length ? { lastFound: new Date(Math.max(...last)).toISOString() } : {}) };
    }),
  };
}

const STORY_NOW: Record<string, [number, string]> = {
  off: [409, "the monitor is off: bug stories are switched off"],
  unreadable: [409, "the monitor is off: the state file monitor-guard.json cannot be read"],
  not_running: [409, "the monitor is not running"],
  exists: [409, "this finding has a bug story already"],
  muted: [409, "this finding is muted"],
  two_tries: [409, "two bug stories did not fix this finding: it needs a person (use Try again)"],
  gone: [409, "this finding is gone"],
  no_target: [409, "no repository is set for bug stories (monitor.report_to)"],
  unknown: [400, "unknown finding"],
  github: [502, "GitHub did not answer or refused the call"],
  failed: [502, "the check of the monitor failed"],
};

const MUTE_STATUS: Record<MuteError["code"], number> = { invalid: 400, not_found: 404, exists: 409, full: 409, locked: 409, unreadable: 409 };
const UNREADABLE = "the state file monitor-guard.json cannot be read; switch bug stories on to start a fresh one";

function muteFailure(e: unknown): never {
  if (!(e instanceof MuteError)) throw e;
  throw new HttpError(MUTE_STATUS[e.code], e.code === "unreadable" ? UNREADABLE : e.message);
}

/** The off switch of the monitor's bug stories, and the mutes (admin only; the rules are in permissions.ts). */
export const monitorRoutes: Route = async (ctx, req, res, seg, method, user) => {
  if (seg[0] !== "monitor" || seg.length > 3) return false;
  if (seg.length === 1) {
    if (method !== "GET") throw new HttpError(405, "method not allowed");
    return send(res, 200, { ...view(ctx), ...lists(ctx) }), true;
  }
  if (seg[1] === "mutes") {
    if (seg.length === 2 && method === "POST") {
      const body = await readJson(req);
      const has = (k: string) => typeof body[k] === "string" && body[k] !== "";
      if (has("detector") === has("finding")) throw new HttpError(400, 'give either "detector" or "finding"');
      const raw = str(body, "reason");
      const reason = raw.trim();
      // Control characters are refused before trimming, so a trailing newline is not silently dropped.
      if (/[\u0000-\u001f\u007f-\u009f]/.test(raw) || !validReason(reason)) throw new HttpError(400, '"reason" must be 1 to 200 characters without control characters');
      const hours = body.hours;
      if (hours !== undefined && hours !== null && !(typeof hours === "number" && Number.isFinite(hours) && hours > 0 && hours <= MAX_MUTE_HOURS)) {
        throw new HttpError(400, `"hours" must be a number above 0 and at most ${MAX_MUTE_HOURS}`);
      }
      const stored = readFindings().findings;
      let detector: string;
      let fingerprint: string | undefined;
      if (has("detector")) {
        detector = body.detector as string;
        if (!detectorInfo().some((d) => d.name === detector)) throw new HttpError(400, "unknown detector");
      } else {
        const hash = body.finding as string;
        const f = /^[0-9a-f]{16}$/.test(hash) ? stored.find((x) => markerHash(x.fingerprint) === hash) : undefined;
        if (!f) throw new HttpError(400, "unknown finding");
        detector = f.detector;
        fingerprint = f.fingerprint;
      }
      let mute: Mute;
      try {
        mute = addMute({ detector, ...(fingerprint !== undefined ? { fingerprint } : {}), reason, ...(typeof hours === "number" ? { hours } : {}), by: user.id }, { onLogError: (m) => ctx.diagLog?.(m) });
      } catch (e) {
        return muteFailure(e);
      }
      ctx.watchers.monitorAct(describeEntry({ event: "mute-made", detector: mute.detector, ...(mute.fingerprint ? { fingerprint: mute.fingerprint } : {}), text: mute.reason, ...(mute.until ? { until: mute.until } : {}) }));
      return send(res, 201, { ...view(ctx), ...lists(ctx), mute: muteView(mute, new Map(stored.map((f) => [f.fingerprint, f]))) }), true;
    }
    if (seg.length === 3 && method === "DELETE") {
      let mute: Mute;
      try {
        mute = endMute(seg[2]!, user.id, { onLogError: (m) => ctx.diagLog?.(m) });
      } catch (e) {
        return muteFailure(e);
      }
      ctx.watchers.monitorAct(describeEntry({ event: "mute-ended", detector: mute.detector }));
      return send(res, 200, { ...view(ctx), ...lists(ctx) }), true;
    }
    return false;
  }
  if (seg[1] === "retry" && seg.length === 2 && method === "POST") {
    const body = await readJson(req);
    const hash = typeof body.finding === "string" ? body.finding : "";
    const target = ctx.config().monitor.report_to;
    // Waits for a check in flight (also of a replaced monitor); then reads, changes and saves with no await in between.
    const found = await ctx.watchers.monitorIdle(() => {
      const { findings, broken } = readFindings();
      const f = !broken && /^[0-9a-f]{16}$/.test(hash) ? findings.find((x) => markerHash(x.fingerprint) === hash) : undefined;
      if (!f) return { status: 400, message: "unknown finding" } as const;
      if (!waitsForPerson(f, target)) return { status: 409, message: "this finding does not wait for a person" } as const;
      saveFindings(findings.map((x) => (x === f ? tryAgain(x) : x)));
      writeLog({ event: "try-again", by: user.id, detector: f.detector, fingerprint: f.fingerprint, ...(target ? { repo: target } : {}) }, { onError: (m) => ctx.diagLog?.(m) });
      return { status: 200, detector: f.detector } as const;
    });
    if (found.status !== 200) throw new HttpError(found.status, found.message);
    ctx.watchers.monitorAct(describeEntry({ event: "try-again", detector: found.detector }));
    return send(res, 200, { ...view(ctx), ...lists(ctx) }), true;
  }
  if (seg[1] === "findings" && seg.length === 3 && method === "GET") {
    const { findings, broken } = readFindings();
    const f = !broken && /^[0-9a-f]{16}$/.test(seg[2]!) ? findings.find((x) => markerHash(x.fingerprint) === seg[2]) : undefined;
    if (!f) throw new HttpError(404, "unknown finding");
    const stories = new Map<string, { issue: number; url?: string; current: boolean }>();
    for (const e of f.earlier ?? []) stories.set(storyKey(e.repo, e.issue), { issue: e.issue, ...(e.url ? { url: e.url } : {}), current: false });
    if (f.report) stories.set(storyKey(f.report.repo, f.report.issue), { issue: f.report.issue, url: f.report.url, current: true });
    const mine = (repo?: string, issue?: string) => !!repo && /^\d+$/.test(issue ?? "") && stories.has(storyKey(repo, issue!));
    const runs: { id: string; status: string; startedAt?: string }[] = ctx.scheduler.briefs()
      .filter((b) => mine(b.githubRepo, b.issue))
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      .map((b) => ({ id: b.dirName, status: b.status, startedAt: b.startedAt }));
    // Jobs that wait in the queue and have no run folder yet.
    for (const p of ctx.scheduler.queue().pending) {
      if (p.kind === "run" && p.runId && mine(p.githubRepo, p.issue) && !runs.some((r) => r.id === p.runId)) runs.push({ id: p.runId, status: "queued" });
    }
    return send(res, 200, { id: seg[2], evidence: evidenceLines(f.evidence), stories: [...stories.values()], runs }), true;
  }
  if (seg[1] === "story" && seg.length === 2 && method === "POST") {
    const body = await readJson(req);
    const hash = typeof body.finding === "string" ? body.finding : "";
    if (!/^[0-9a-f]{16}$/.test(hash)) throw new HttpError(400, '"finding" must be the id of a finding');
    const { findings, broken } = readFindings();
    if (broken) throw new HttpError(400, "the findings file cannot be read");
    if (!findings.some((x) => markerHash(x.fingerprint) === hash)) throw new HttpError(400, "unknown finding");
    const r = await ctx.watchers.storyNow(hash, user.id);
    if (!r.ok) {
      const [status, message] = STORY_NOW[r.code] ?? [500, "the story could not be made"];
      throw new HttpError(status, message);
    }
    return send(res, 200, { ...view(ctx), ...lists(ctx), story: { made: r.made, issue: r.issue, url: r.url } }), true;
  }
  if (seg.length !== 2 || (seg[1] !== "off" && seg[1] !== "on") || method !== "POST") return false;
  const sub = seg[1];
  let r;
  try {
    r = switchStories(sub, user.id, { onLogError: (m) => ctx.diagLog?.(m) });
  } catch (e) {
    throw new HttpError(409, (e as Error).message);
  }
  if (r.changed) ctx.watchers.monitorAct(describeEntry({ event: sub }));
  if ("closed" in r && r.closed) ctx.watchers.monitorAct(describeEntry({ event: "breaker-closed" }));
  return send(res, 200, { ...view(ctx), changed: r.changed, ...("closed" in r && r.closed ? { closed: true } : {}), ...("reset" in r && r.reset ? { reset: r.reset } : {}) }), true;
};
