import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Config } from "./config.js";

/**
 * The GitHub App: installation tokens and the installation of a repository.
 * Every error has a fixed sentence: never the key file path, a token, or GitHub's own text.
 */

export type AppErrorCode = "key" | "unreachable" | "answer" | "status";

/** The sentences start with "GitHub App token", which `failure.ts` matches. */
export class GithubAppError extends Error {
  constructor(
    public code: AppErrorCode,
    public status?: number,
  ) {
    super(
      code === "key"
        ? "GitHub App token request failed: the private key file cannot be read; check github_app.private_key_path"
        : code === "unreachable"
          ? "GitHub App token request failed: GitHub could not be reached"
          : code === "answer"
            ? "GitHub App token request failed: the answer was not a token"
            : `GitHub App token request failed: ${status}`,
    );
    this.name = "GithubAppError";
  }
}

export interface AppCredentials {
  app_id: string;
  private_key_path: string;
}

/** The app as the repository method needs it: set up with a name. */
export interface RepoApp extends AppCredentials {
  slug: string;
}

/** The app for the method "GitHub App", or undefined when it is not set up (no app, no app id or no name). */
export function repoApp(config: Pick<Config, "github_app">): RepoApp | undefined {
  const a = config.github_app;
  if (!a || !a.app_id.trim() || !a.private_key_path.trim() || !a.slug) return undefined;
  return { app_id: a.app_id, private_key_path: a.private_key_path, slug: a.slug };
}

export const installUrl = (slug: string) => `https://github.com/apps/${slug}/installations/new`;

const API = "https://api.github.com";
const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** A JWT of the app, valid for ten minutes. */
export function appJwt(appId: string, privateKeyPem: string, now = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const sig = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKeyPem);
  return `${header}.${payload}.${b64url(sig)}`;
}

function jwtFor(app: AppCredentials): string {
  try {
    return appJwt(app.app_id, readFileSync(app.private_key_path, "utf8"));
  } catch {
    throw new GithubAppError("key");
  }
}

const headers = (jwt: string) => ({ authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "user-agent": "claude-factory" });

async function call(url: string, init: RequestInit, timeoutMs?: number): Promise<Response> {
  try {
    return await fetch(url, timeoutMs ? { ...init, signal: AbortSignal.timeout(timeoutMs) } : init);
  } catch {
    throw new GithubAppError("unreachable");
  }
}

const cache = new Map<string, { token: string; expires: number }>();

export interface TokenOpts {
  /** Limit the token to this repository (its name, without the owner). */
  repository?: string;
  /** Ask GitHub even when a token is cached. */
  fresh?: boolean;
  timeoutMs?: number;
}

/** A short-lived token of an installation, cached per app, installation and repository until 5 minutes before it ends. */
export async function installationToken(app: AppCredentials, installationId: string, opts: TokenOpts = {}): Promise<string> {
  const key = `${app.app_id}/${installationId}/${opts.repository ?? ""}`;
  const hit = cache.get(key);
  if (!opts.fresh && hit && hit.expires - Date.now() > 5 * 60_000) return hit.token;
  const jwt = jwtFor(app);
  const res = await call(
    `${API}/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    opts.repository
      ? { method: "POST", headers: { ...headers(jwt), "content-type": "application/json" }, body: JSON.stringify({ repositories: [opts.repository] }) }
      : { method: "POST", headers: headers(jwt) },
    opts.timeoutMs,
  );
  if (!res.ok) throw new GithubAppError("status", res.status);
  let body: { token?: unknown; expires_at?: unknown } | undefined;
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new GithubAppError("answer");
  }
  const expires = typeof body?.expires_at === "string" ? new Date(body.expires_at).getTime() : NaN;
  if (typeof body?.token !== "string" || !body.token || !Number.isFinite(expires) || expires <= Date.now()) throw new GithubAppError("answer");
  cache.set(key, { token: body.token, expires });
  return body.token;
}

/** Forgets the cached tokens (tests). */
export const clearTokenCache = () => cache.clear();

export type InstallProblem = "not-installed" | "app-broken" | "rate-limit" | "unreachable" | "failed";
export type InstallResult = { ok: true; installationId: string; token?: string } | { ok: false; problem: InstallProblem };

/**
 * Finds the installation of the app on a GitHub repository ("owner/name"), and with `token` a token limited to that
 * repository. Never throws and never returns text of GitHub or the key path.
 */
export async function repoInstallation(app: AppCredentials, github: string, opts: { token?: boolean; timeoutMs?: number } = {}): Promise<InstallResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;
  try {
    const jwt = jwtFor(app);
    const res = await call(`${API}/repos/${github.split("/").map(encodeURIComponent).join("/")}/installation`, { method: "GET", headers: headers(jwt) }, timeoutMs);
    if (res.status === 404) return { ok: false, problem: "not-installed" };
    if (res.status === 401) return { ok: false, problem: "app-broken" };
    if (res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")) return { ok: false, problem: "rate-limit" };
    if (!res.ok) return { ok: false, problem: "failed" };
    let id: unknown;
    try {
      id = ((await res.json()) as { id?: unknown })?.id;
    } catch {
      return { ok: false, problem: "failed" };
    }
    if ((typeof id !== "number" && typeof id !== "string") || !Number.isSafeInteger(Number(id)) || Number(id) <= 0) return { ok: false, problem: "failed" };
    const installationId = String(id);
    if (!opts.token) return { ok: true, installationId };
    // a new token for every test: it is short-lived and limited to this repository
    // `timeoutMs` is the budget of the lookup and the token call together
    const token = await installationToken(app, installationId, { repository: github.split("/")[1], timeoutMs: Math.max(1, deadline - Date.now()), fresh: true });
    return { ok: true, installationId, token };
  } catch (e) {
    if (!(e instanceof GithubAppError)) return { ok: false, problem: "failed" };
    if (e.code === "key") return { ok: false, problem: "app-broken" };
    if (e.code === "unreachable") return { ok: false, problem: "unreachable" };
    if (e.code === "answer") return { ok: false, problem: "failed" };
    if (e.status === 401) return { ok: false, problem: "app-broken" };
    if (e.status === 404) return { ok: false, problem: "not-installed" };
    if (e.status === 429) return { ok: false, problem: "rate-limit" };
    return { ok: false, problem: "failed" };
  }
}
