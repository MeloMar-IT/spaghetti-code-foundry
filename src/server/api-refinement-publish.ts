import { buildLabelOf } from "../refinement/build-limits.js";
import { readyListOf } from "../refinement/ready-list.js";
import { planOf } from "../refinement/publish.js";
import { getSession } from "../refinement/store.js";
import { isBot, repoLabels } from "../github.js";
import { HttpError, send } from "./http.js";
import { guardedAsync, limitsOf } from "./api-refinement.js";
import { sessionUser } from "./api-auth.js";
import { asOwnedRepo } from "./repo-sign-in.js";
import type { Route } from "./server.js";

const GH_TIMEOUT_MS = 15_000;

/** What went wrong with a call to GitHub, in one line: its own words (the first line of stderr), or that it did not answer. */
function whatHappened(e: unknown): string {
  const x = e as { killed?: boolean; stderr?: unknown; message?: unknown };
  if (x?.killed === true) return "GitHub did not answer in time";
  const first = (t: unknown) => (typeof t === "string" ? t.split("\n").map((l) => l.trim()).find(Boolean) : undefined);
  return first(x?.stderr) ?? first(x?.message) ?? "unknown error";
}

/** The publish plan of a refinement session. It only reads: nothing in the session or on GitHub changes. */
export const refinementPublishRoutes: Route = async (ctx, req, res, seg, method, effective) => {
  if (seg[0] !== "refinement" || seg.length !== 3 || seg[2] !== "publish" || method !== "GET") return false;
  const body = await guardedAsync(ctx, async () => {
    // The signed-in account, not the one an admin views as: the plan is read with the owner's sign-in, so a view of the owner must not open it.
    const user = sessionUser(ctx, req);
    const s = getSession(seg[1]!);
    if (!s || (s.owner !== user.id && user.role !== "admin")) throw new HttpError(404, "no such refinement session");
    if (s.owner !== user.id) throw new HttpError(403, "only the owner can read the publish plan: it is read with the owner's GitHub sign-in");
    if (s.state === "dropped") throw new HttpError(409, "a dropped session cannot be published; restore it first");
    const by = (user.name ?? "").replace(/\s+/g, " ").trim() || "a Foundry user";
    if (isBot({ body: by })) throw new HttpError(400, "the account name holds a Foundry marker");

    const labels = await asOwnedRepo(ctx, s.owner, s.repo, async (rec) => {
      let names: string[];
      try {
        names = await repoLabels(s.repo, ctx.opts.ghTimeoutMs ?? GH_TIMEOUT_MS);
      } catch (e) {
        throw new HttpError(502, `could not read the labels on GitHub: ${whatHappened(e)} — check the repository's sign-in under My repositories and try again`);
      }
      return { names, list: readyListOf(rec.definitionOfReady) };
    });

    const buildLabel = buildLabelOf(s.repo, ctx.config().watchers, s.owner);
    const reviewLabel = limitsOf(ctx, s).reviewLabel;
    const onGithub = new Map(s.drafts.flatMap((d) => (d.published !== undefined ? [[d.id, d.published] as const] : [])));
    const { items, willCreate } = planOf(s, {
      list: labels.list,
      onGithub,
      by,
      date: new Date().toISOString().slice(0, 10),
      ...(buildLabel ? { buildLabel } : {}),
      ...(reviewLabel ? { reviewLabel } : {}),
    });
    return {
      repo: s.repo,
      items,
      willCreate,
      repoLabels: labels.names,
      ...(buildLabel ? { buildLabel } : { noBuildLabel: "this repository has no enabled watcher for issues, so no label starts a build" }),
      ...(reviewLabel ? { reviewLabel } : {}),
    };
  });
  return send(res, 200, body), true;
};
