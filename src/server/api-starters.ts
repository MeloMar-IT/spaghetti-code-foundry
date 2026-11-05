import { auditAction } from "../auth/audit.js";
import { addRepo, getRepo, removeRepo, setRepoSettings } from "../auth/repos.js";
import type { User } from "../auth/users.js";
import { connectLevel, forgetLevel } from "../governance/autonomy-store.js";
import { type ListOptions, type Starter, StarterError, type StarterErrorCode, createProject, getStarter, listStarters } from "../starters/starters.js";
import { HttpError, readJson, send } from "./http.js";
import { guardedRepos, testRepo } from "./api-repos.js";
import type { ApiContext, Route } from "./server.js";

const STATUS: Record<StarterErrorCode, number> = { "bad-name": 400, "bad-folder": 400, "not-found": 404, broken: 409, exists: 409, failed: 500 };

/** What a client sees of a starter: never a folder. */
export const starterView = (s: Starter) => ({ id: s.id, title: s.title, description: s.description, needs: s.needs, source: s.source });

/** Test hooks; the routes pass none. */
export interface StartOptions {
  userHome?: string;
  git?: string;
  list?: ListOptions;
  test?: typeof testRepo;
  settings?: typeof setRepoSettings;
}

function listOptions(ctx: ApiContext, o: StartOptions): ListOptions {
  return { hidden: ctx.config().simple.hidden_starters, ...o.list };
}

/** Runs starter code: a StarterError becomes its status; the log gets the fixed detail, never a path. */
async function guardedStarters<T>(ctx: ApiContext, fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof StarterError) {
      if (e.detail) ctx.diagLog?.(e.detail);
      throw new HttpError(STATUS[e.code], e.message);
    }
    throw e;
  }
}

/** Removes what one failed request made in the stores: the record (if saved) and the autonomy entry of its id. */
function undo(ctx: ApiContext, user: User, id: string | undefined): void {
  if (!id) return;
  try {
    if (getRepo(id)) removeRepo(user.id, id);
  } catch {
    ctx.diagLog?.("starters: the repository record could not be removed");
  }
  try {
    forgetLevel("repos", id);
  } catch {
    ctx.diagLog?.("starters: the autonomy entry could not be removed");
  }
}

/** `POST /api/starters/<id>/project`: makes the folder and connects it. Only a connection that is ok gives the answer; anything else leaves nothing. */
export async function startProject(ctx: ApiContext, user: User, starterId: string, body: Record<string, unknown>, o: StartOptions = {}) {
  return guardedStarters(ctx, async () => {
    const starter = getStarter(starterId, listOptions(ctx, o));
    const made = await createProject({
      starter,
      name: body.name,
      parent: body.parent,
      simple: ctx.config().simple,
      userHome: o.userHome,
      git: o.git,
      connect: async (dir) => {
        let allocated: string | undefined;
        try {
          const repo = guardedRepos(ctx, () =>
            addRepo(user.id, { url: dir, method: "local" }, { beforeSave: (id) => { allocated = id; connectLevel(id); } }),
          );
          const saved = guardedRepos(ctx, () => (o.settings ?? setRepoSettings)(repo.id, { testCommand: starter.test }));
          const connection = await (o.test ?? testRepo)(ctx, user, repo.id);
          if (connection.ok !== true) throw new StarterError("failed", "the project could not be made; see the server log", "starters: the connection test failed");
          return { repo: { ...repo, settings: saved.repo.settings ?? {} }, connection };
        } catch (e) {
          undo(ctx, user, allocated);
          throw e;
        }
      },
    });
    const { repo } = made.result;
    auditAction(ctx.diagLog, user.id, "repo-add", repo.id, repo.url);
    return made.result;
  });
}

/** `GET /api/starters` and `POST /api/starters/<id>/project` (admins only; the permission rule says so). */
export const starterRoutes: Route = async (ctx, req, res, seg, method, user) => {
  if (seg[0] !== "starters") return false;
  if (seg.length === 1 && method === "GET") {
    const cat = listStarters(listOptions(ctx, {}));
    return send(res, 200, { starters: cat.starters.map(starterView), broken: cat.broken }), true;
  }
  if (seg.length === 3 && seg[2] === "project" && method === "POST") {
    const body = await readJson(req);
    return send(res, 201, await startProject(ctx, user, seg[1]!, body)), true;
  }
  return false;
};
