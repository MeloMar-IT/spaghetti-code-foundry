import { sharingAnswer } from "../auth/users.js";
import { sharePreview, type PreviewDeps, type SharePreview } from "../metrics-share/preview.js";
import { dayOf } from "../metrics-share/pusher.js";
import { defaultShareDeps, sharingAccounts } from "../metrics-share/sources.js";
import { loadSentReport, loadShareState } from "../metrics-share/state.js";
import { SHARING_NOT_IN_PREVIEW } from "./api-auth.js";
import { HttpError, send } from "./http.js";
import type { Route } from "./server.js";
import { asParam } from "./view-as.js";

// GET /api/account/metrics-sharing/preview (#888): what the next push would send and what was sent last, for the What is
// shared dialog. A user sees a report of their own runs, an admin the install's. An admin's preview of another account
// (`?as=`) is refused, as for the sharing answer.

/** Builds that run now, by scope, account and day: two opens at the same time share one build. */
const inFlight = new Map<string, Promise<SharePreview>>();

export const metricsShareRoutes: Route = async (ctx, req, res, seg, method, user) => {
  if (seg.length !== 3 || seg[0] !== "account" || seg[1] !== "metrics-sharing" || seg[2] !== "preview" || method !== "GET") return false;
  if (asParam(req) !== undefined) throw new HttpError(403, SHARING_NOT_IN_PREVIEW);
  const allowed = ctx.config().metrics_sharing.allowed;
  const admin = user.role === "admin";
  const answer = sharingAnswer(user);
  const key = `${admin ? "install" : "own"}|${user.id}|${dayOf(new Date())}|${allowed}|${answer}`;
  let p = inFlight.get(key);
  if (!p) {
    const deps: PreviewDeps = {
      share: defaultShareDeps(ctx.opts.runsDir),
      accounts: () => sharingAccounts(allowed),
      state: () => loadShareState(),
      sent: () => loadSentReport(),
      now: () => new Date(),
    };
    p = sharePreview({ id: user.id, admin, allowed, answer }, deps).finally(() => inFlight.delete(key));
    inFlight.set(key, p);
  }
  send(res, 200, await p);
  return true;
};
