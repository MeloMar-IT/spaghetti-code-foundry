import { existsSync } from "node:fs";
import { githubNameOf } from "../auth/repo-url.js";
import { repoSecretName } from "../auth/repo-connection.js";
import { TOKEN_MISSING, TOKEN_UNREADABLE, getRepo, readRepoSecret, type RepoRecord } from "../auth/repos.js";
import { getUser } from "../auth/users.js";
import type { Config } from "../config.js";
import { listCredentials } from "../credentials/store.js";
import { APP_NOT_SET_UP_RUN } from "../engine/guards.js";
import { ghConfigDir, ghTokenEnv, appTokenAccess, removeGhConfigDir } from "../engine/repo-access.js";
import { repoApp } from "../github-app.js";
import type { GhSession } from "../github.js";
import { watcherRepoProblem } from "../repos/watchers.js";

/** Every failure of a repository's sign-in starts like this, so a watcher's status shows what it is. */
export const SIGN_IN_PREFIX = "the GitHub sign-in of this repository does not work: ";
export const NOT_CONNECTED = "this repository is not connected any more; delete the watcher";
export const OWNER_BLOCKED = "the owner of this repository is blocked";
export const DATA_UNREADABLE = "the Foundry's own data files could not be read; ask an admin";
export const NOT_PREPARED = "the sign-in of this repository could not be prepared; the next check tries again";

/** A token is read from the credential store again after this long, even when nothing changed (a Keychain key that went away is noticed). */
export const REREAD_MS = 60 * 60_000;
/** An app token is renewed when it ends in less than this. */
export const RENEW_MS = 15 * 60_000;

/** What a watcher of a repository needs to talk to GitHub as that repository. */
export interface RepoGhIdentity {
  /** The session for the next check; rejects with a plain sentence (starting with `SIGN_IN_PREFIX`) when there is none. Makes no GitHub call except an app's token request. */
  prepare(): Promise<GhSession>;
  /** Does this repository use the server's own `gh` login (method "none")? Read from the record, no secret. */
  usesHostLogin(): boolean;
  /** Removes the settings folder of `gh`. */
  dispose(): void;
}

export interface RepoGhOptions {
  config: () => Config;
  log?: (msg: string) => void;
  /** The time in ms (tests move it). */
  now?: () => number;
}

class SignInError extends Error {
  constructor(sentence: string) {
    super(`${SIGN_IN_PREFIX}${sentence}`);
    this.name = "SignInError";
  }
}

const HOST: GhSession = Object.freeze({ stamp: "host" });

/** The identity of one stored repository; its sessions are made from the record as it is now. */
export function repoGhIdentity(repoId: string, o: RepoGhOptions): RepoGhIdentity {
  const now = o.now ?? Date.now;
  let dir: string | undefined;
  /** The token session, with what it was made from. */
  let tokenHit: { credentialId: string; fingerprint: string; readAt: number; session: GhSession } | undefined;
  let appHit: { expires: number; session: GhSession; key: string } | undefined;
  let appPending: { key: string; promise: Promise<GhSession> } | undefined;

  const settingsDir = (): string => {
    if (!dir || !existsSync(dir)) dir = ghConfigDir();
    return dir;
  };

  const record = (): RepoRecord | undefined => {
    try {
      return getRepo(repoId);
    } catch {
      throw new SignInError(DATA_UNREADABLE);
    }
  };

  async function app(rec: RepoRecord, github: string): Promise<GhSession> {
    const installationId = rec.installationId ?? "";
    const cfg = repoApp(o.config());
    if (!cfg) {
      // the app was removed from the settings: nothing cached may be used
      appHit = undefined;
      appPending = undefined;
      throw new SignInError(APP_NOT_SET_UP_RUN);
    }
    const key = `${cfg.app_id}|${cfg.private_key_path}|${installationId}|${github}`;
    if (appHit && appHit.key !== key) appHit = undefined;
    if (appPending && appPending.key !== key) appPending = undefined;
    if (appHit && appHit.expires - now() > RENEW_MS) return appHit.session;
    if (appPending) return appPending.promise;
    const made = (async (): Promise<{ session: GhSession; expires: number }> => {
      const r = await appTokenAccess({ kind: "app", installationId, url: rec.url, github }, o.config());
      if (!r.ok) throw new SignInError(r.reason);
      const session: GhSession = Object.freeze({ env: Object.freeze(ghTokenEnv(r.token, settingsDir())), app: true, stamp: `app:${cfg.app_id}:${installationId}` });
      return { session, expires: now() + (r.expires - Date.now()) };
    })();
    const promise = made.then((m) => m.session);
    promise.catch(() => {}); // callers that wait for it see the rejection; this one is only the cache entry
    appPending = { key, promise };
    try {
      const m = await made;
      // the settings may have changed while the token was requested: then it is not kept
      if (appPending?.promise === promise) appHit = { expires: m.expires, session: m.session, key };
      return m.session;
    } finally {
      if (appPending?.promise === promise) appPending = undefined;
    }
  }

  function token(rec: RepoRecord): GhSession {
    const c = rec.credentialId
      ? listCredentials(rec.owner).find((x) => x.id === rec.credentialId && x.name === repoSecretName(rec) && x.type === "token")
      : undefined;
    if (!c) {
      tokenHit = undefined;
      throw new SignInError(TOKEN_MISSING);
    }
    if (tokenHit && tokenHit.credentialId === c.id && tokenHit.fingerprint === c.fingerprint && now() - tokenHit.readAt < REREAD_MS) return tokenHit.session;
    tokenHit = undefined;
    let secret: string;
    try {
      secret = readRepoSecret(rec);
    } catch (e) {
      throw new SignInError((e as { code?: string }).code === "no-credential" ? TOKEN_MISSING : TOKEN_UNREADABLE);
    }
    const session: GhSession = Object.freeze({ env: Object.freeze(ghTokenEnv(secret, settingsDir())), stamp: `token:${c.id}:${c.fingerprint}` });
    tokenHit = { credentialId: c.id, fingerprint: c.fingerprint, readAt: now(), session };
    return session;
  }

  return {
    async prepare() {
      try {
        const rec = record();
        if (!rec) throw new SignInError(NOT_CONNECTED);
        let owner;
        try {
          owner = getUser(rec.owner);
        } catch {
          throw new SignInError(DATA_UNREADABLE);
        }
        const problem = watcherRepoProblem(rec, owner);
        if (problem) throw new SignInError(problem);
        if (owner!.status !== "active") throw new SignInError(OWNER_BLOCKED);
        const github = githubNameOf(rec.url)!;
        if (rec.method === "none") return HOST;
        if (rec.method === "github-app") return await app(rec, github);
        if (rec.method === "github-token") return token(rec);
        throw new SignInError(NOT_PREPARED);
      } catch (e) {
        if (e instanceof SignInError) throw e;
        throw new SignInError(NOT_PREPARED);
      }
    },
    usesHostLogin() {
      try {
        return getRepo(repoId)?.method === "none";
      } catch {
        return false;
      }
    },
    dispose() {
      tokenHit = undefined;
      appHit = undefined;
      if (dir) removeGhConfigDir(dir);
      dir = undefined;
    },
  };
}
