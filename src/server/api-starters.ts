import { auditAction } from "../auth/audit.js";
import { addRepo, getRepo, removeRepo, setRepoSettings } from "../auth/repos.js";
import { StoreError } from "../auth/store.js";
import type { User } from "../auth/users.js";
import { ProgressError, beginGuideProject, guideGeneration, readProgress, recordCreatingLocked, recordGuideProject } from "../onboarding/progress-store.js";
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
  /** Called at the start of the connect step (before the record is saved). */
  beforeConnect?: () => void;
  /** Called after the connection test, before the guide records the project. */
  afterTest?: () => void;
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

/** A guide-progress problem as a fixed answer: never a path or a value. */
function guideHttp(ctx: ApiContext, e: unknown): unknown {
  if (e instanceof ProgressError) {
    if (e.code === "stale") return new HttpError(409, "the guide was started again meanwhile; nothing was made");
    if (e.code === "too-large") return new HttpError(413, "your answers in the guide are too large; start the guide again");
    if (e.code === "bad") return new HttpError(400, "your answers in the guide cannot take the project; start the guide again");
    return new HttpError(404, "no such account");
  }
  if (e instanceof StoreError) {
    ctx.diagLog?.(`starters: onboarding-progress.json ${e.kind}`);
    return new HttpError(500, `your place in the guide could not be read or saved (${e.kind}); try again`);
  }
  return e;
}

// Guide requests of one account run one at a time: a second tab or a double press waits, then finds the project made.
const guideChain = new Map<string, Promise<unknown>>();
function oneAtATime<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (guideChain.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  guideChain.set(key, tail);
  void tail.then(() => { if (guideChain.get(key) === tail) guideChain.delete(key); });
  return run;
}

/**
 * `POST /api/starters/<id>/project`: makes the folder and connects it. Only a connection that is ok gives the answer; anything else leaves nothing.
 * With `guide: true` the project is made once per account: the guide answers hold a token while it is made and the project's id once it is done.
 */
export async function startProject(ctx: ApiContext, user: User, starterId: string, body: Record<string, unknown>, o: StartOptions = {}) {
  if (body.guide !== undefined && typeof body.guide !== "boolean") throw new HttpError(400, "guide must be true or false");
  if (body.guide !== true) return makeProject(ctx, user, starterId, body, o);
  // the generation is read when the request arrives: a reset while it waits in the queue makes it answer 409
  const generation = guideGeneration(user.id);
  return oneAtATime(user.id, async () => {
    if (guideGeneration(user.id) !== generation) throw new HttpError(409, "the guide was started again meanwhile; nothing was made");
    let begun: ReturnType<typeof beginGuideProject>;
    try {
      recoverGuideCreation(ctx, user);
      begun = beginGuideProject(user.id, (id) => !!getRepo(id));
    } catch (e) {
      throw guideHttp(ctx, e);
    }
    if ("existing" in begun) return { repo: { id: begun.existing }, existing: true as const };
    const token = begun.token;
    return makeProject(ctx, user, starterId, body, o, {
      start: (id) => {
        try {
          recordCreatingLocked(user.id, token, id);
        } catch (e) {
          throw guideHttp(ctx, e);
        }
      },
      finish: (id) => {
        try {
          recordGuideProject(user.id, token, id);
        } catch (e) {
          throw guideHttp(ctx, e);
        }
      },
    });
  });
}

/**
 * A restart during a guide project leaves its repository record (and nothing else in the progress) behind, with its id in
 * `creating`. Before the next make that record is undone, so no project exists that the guide does not know of. The folder stays.
 */
function recoverGuideCreation(ctx: ApiContext, user: User): void {
  const pending = readProgress(user.id)?.answers.creating;
  if (typeof pending === "string") undo(ctx, user, pending);
}

/** The guide's hooks of one make: `start` runs while the record is written (before it is saved), `finish` once the project is complete. */
interface GuideMarks {
  start: (id: string) => void;
  finish: (id: string) => void;
}

async function makeProject(ctx: ApiContext, user: User, starterId: string, body: Record<string, unknown>, o: StartOptions, guide?: GuideMarks) {
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
          o.beforeConnect?.();
          const repo = guardedRepos(ctx, () =>
            addRepo(user.id, { url: dir, method: "local" }, {
              beforeSave: (id) => {
                guide?.start(id); // first: a refused mark writes nothing
                allocated = id;
                connectLevel(id);
              },
            }),
          );
          const saved = guardedRepos(ctx, () => (o.settings ?? setRepoSettings)(repo.id, { testCommand: starter.test }));
          const connection = await (o.test ?? testRepo)(ctx, user, repo.id);
          if (connection.ok !== true) throw new StarterError("failed", "the project could not be made; see the server log", "starters: the connection test failed");
          o.afterTest?.();
          // last: the guide learns of the project only when it is complete; a reset meanwhile throws here and everything is undone
          guide?.finish(repo.id);
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
    const out = await startProject(ctx, user, seg[1]!, body);
    return send(res, "existing" in out ? 200 : 201, out), true;
  }
  return false;
};
