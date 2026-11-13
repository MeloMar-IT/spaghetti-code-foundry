import { randomBytes, randomUUID } from "node:crypto";
import { prepareAuditLocked, type AuditEvent } from "./audit.js";
import { sessionId } from "./sessions.js";
import { withAuthLock } from "./store.js";
import { SERVICE_EMAIL_DOMAIN, UserError, checkName, publicUser, readUsersFile, writeUsersFileLocked, type PublicUser, type User } from "./users.js";

/**
 * Service accounts (#866): accounts for programs. They live in users.json (`kind: "service"`), so everything that is keyed
 * by an account id works for them. A service has no password and no session. It signs in with a bearer token; only the
 * SHA-256 of the token is stored (as for sessions). The token ends 30 days after its last request.
 */
export const SERVICE_TOKEN_PREFIX = "scf_svc_";
/** A token that was not used for this long is dead. */
export const SERVICE_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
export const SCOPE_MAX = 200;
const TOKEN_RE = /^scf_svc_[A-Za-z0-9_-]{43}$/;
const SCOPE_KEY_RE = /^(GET|POST|PUT|DELETE) [A-Za-z0-9:/_-]{1,200}$/;

export type TokenState = "live" | "expired" | "revoked";
export type ServiceAccount = User & { kind: "service"; scope: string[] };

export const isService = (u: User): u is ServiceAccount => u.kind === "service" && u.scope !== undefined;

/** When the token ends: 30 days after the later of its creation and its last request. */
export function tokenExpires(u: ServiceAccount): number | undefined {
  if (!u.token) return undefined;
  return Math.max(Date.parse(u.token.created), u.token.used ? Date.parse(u.token.used) : 0) + SERVICE_IDLE_MS;
}

/** `live` until 30 days after the last request (that moment itself still counts), then `expired`; `revoked` after a revoke. */
export function tokenState(u: ServiceAccount, now = Date.now()): TokenState {
  if (!u.token || u.token.revoked !== undefined) return "revoked";
  return now > tokenExpires(u)! ? "expired" : "live";
}

const newToken = () => `${SERVICE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;

/** The scope as stored: strings of the shape `METHOD path`, unique, at most 200. Which keys exist is the server's check (permissions.ts). */
export function checkScopeShape(scope: unknown): string[] {
  if (!Array.isArray(scope) || scope.length > SCOPE_MAX) throw new UserError("bad-role", `the scope must be a list of at most ${SCOPE_MAX} routes`);
  const seen = new Set<string>();
  for (const k of scope) {
    if (typeof k !== "string" || !SCOPE_KEY_RE.test(k)) throw new UserError("bad-role", "every scope entry must be a route such as `GET runs`");
    if (seen.has(k)) throw new UserError("bad-role", `"${k}" is in the scope twice`);
    seen.add(k);
  }
  return [...scope];
}

export function listServiceAccounts(): ServiceAccount[] {
  return readUsersFile().users.filter(isService);
}

export const getServiceAccount = (id: string): ServiceAccount | undefined => listServiceAccounts().find((u) => u.id === id);

/** What a mutation hands back: the record without its token hash. */
export type ServiceView = PublicUser & { kind: "service"; scope: string[] };

function audited<T>(by: string | undefined, event: AuditEvent | undefined, mutate: () => T): T {
  if (by === undefined || !event) return mutate();
  const log = prepareAuditLocked(by, event);
  try {
    const r = mutate();
    log.write();
    return r;
  } finally {
    log.close();
  }
}

export interface ServiceResult {
  account: ServiceAccount;
  /** The token, shown once. Only its SHA-256 is stored. Missing when nothing new was made. */
  token?: string;
}

/** Makes a service account and its first token. Names are unique among service accounts (`name-taken`). */
export function createServiceAccount(input: { name: string; scope: unknown }, opts: { by?: string } = {}): ServiceResult {
  const name = checkName(input.name);
  const scope = checkScopeShape(input.scope);
  const token = newToken();
  const id = randomUUID();
  const now = new Date().toISOString();
  const account: ServiceAccount = {
    id,
    name,
    email: `${id}@${SERVICE_EMAIL_DOMAIN}`,
    role: "user",
    status: "active",
    created: now,
    lastSignIn: null,
    kind: "service",
    scope,
    token: { id: sessionId(token), created: now },
  };
  return withAuthLock(() => {
    const file = readUsersFile();
    if (file.users.some((u) => u.kind === "service" && u.name === name)) throw new UserError("name-taken", "a service account with that name exists already");
    audited(opts.by, { action: "create", userId: id }, () => writeUsersFileLocked({ ...file, users: [...file.users, account] }));
    return { account, token };
  });
}

/** Runs `apply` on one service account under the lock and writes the result. */
function changeService(id: string, apply: (u: ServiceAccount, all: User[]) => { next: ServiceAccount; event?: AuditEvent } | undefined, by?: string): ServiceAccount {
  return withAuthLock(() => {
    const file = readUsersFile();
    const current = file.users.find((u) => u.id === id);
    if (!current || !isService(current)) throw new UserError("not-found", "no such service account");
    const r = apply(current, file.users);
    if (!r) return current;
    return audited(by, r.event, () => {
      writeUsersFileLocked({ ...file, users: file.users.map((u) => (u.id === id ? r.next : u)) });
      return r.next;
    });
  });
}

/** Changes the name and the scope (both optional). Nothing is written when nothing changes. */
export function updateServiceAccount(id: string, changes: { name?: string; scope?: unknown }, opts: { by?: string } = {}): ServiceAccount {
  const name = changes.name === undefined ? undefined : checkName(changes.name);
  const scope = changes.scope === undefined ? undefined : checkScopeShape(changes.scope);
  return changeService(
    id,
    (u, all) => {
      if (name !== undefined && all.some((o) => o.id !== id && o.kind === "service" && o.name === name)) throw new UserError("name-taken", "a service account with that name exists already");
      const next: ServiceAccount = { ...u, name: name ?? u.name, scope: scope ?? u.scope };
      if (next.name === u.name && next.scope.length === u.scope.length && next.scope.every((k, i) => k === u.scope[i])) return undefined;
      return { next, event: { action: "edit", userId: id } };
    },
    opts.by,
  );
}

/** Gives the account a new token at once; the old one is dead. A dead (expired or revoked) token comes back to life with the new one. */
export function rotateServiceToken(id: string, opts: { by?: string } = {}): ServiceResult {
  const token = newToken();
  const account = changeService(
    id,
    (u) => ({ next: { ...u, token: { id: sessionId(token), created: new Date().toISOString() } }, event: { action: "service-token-rotate", result: "ok", userId: id } }),
    opts.by,
  );
  return { account, token };
}

/** Ends the token at once. Rotate gives a new one. */
export function revokeServiceToken(id: string, opts: { by?: string } = {}): ServiceAccount {
  return changeService(
    id,
    (u) => {
      if (!u.token || u.token.revoked !== undefined) return undefined;
      return { next: { ...u, token: { ...u.token, revoked: new Date().toISOString() } }, event: { action: "service-token-revoke", result: "ok", userId: id } };
    },
    opts.by,
  );
}

export interface FoundToken {
  account: ServiceAccount;
  state: TokenState;
}

/** The account a well-formed token belongs to, in any state (also an old, revoked or expired one); undefined for any other string. For audit lines and refusals. */
export function lookupServiceToken(token: string, now = Date.now()): FoundToken | undefined {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return undefined;
  const id = sessionId(token);
  const account = readUsersFile().users.find((u): u is ServiceAccount => isService(u) && u.token?.id === id);
  return account ? { account, state: tokenState(account, now) } : undefined;
}

/** The account for a token only when the account is active and the token is live; else undefined. */
export function findServiceByToken(token: string, now = Date.now()): ServiceAccount | undefined {
  const found = lookupServiceToken(token, now);
  return found && found.state === "live" && found.account.status === "active" ? found.account : undefined;
}

export interface ServiceUse {
  result: "ok" | "failed";
  /** "METHOD rule-path" */
  target: string;
  detail?: string;
}

/**
 * Writes the `service-request` audit line of one request (`by` is the account id, or `anonymous` when no account is known) and,
 * with `touch`, the time of the request in `token.used` (exact, so the 30 days run from the real last request). Both happen
 * under one lock that is not waited for. Throws a StoreError when the line or the file cannot be written. A token that is not
 * live under the lock is not touched, and an `ok` line for it is written as `failed`: the result says whether the request may go on.
 */
export function recordServiceUse(id: string | undefined, use: ServiceUse, opts: { touch?: boolean; now?: number } = {}): boolean {
  const now = opts.now ?? Date.now();
  return withAuthLock(() => {
    const file = readUsersFile();
    const account = id === undefined ? undefined : file.users.find((u) => u.id === id);
    const live = !!account && isService(account) && account.status === "active" && tokenState(account, now) === "live";
    const ok = use.result === "ok" && (id === undefined ? false : live);
    const detail = use.detail ?? (use.result === "ok" && !ok ? "the token ended" : undefined);
    const log = prepareAuditLocked(id ?? "anonymous", {
      action: "service-request",
      result: ok ? "ok" : "failed",
      target: use.target,
      ...(detail !== undefined ? { detail } : {}),
    });
    try {
      if (opts.touch && live && account && isService(account)) {
        const next: ServiceAccount = { ...account, token: { ...account.token!, used: new Date(now).toISOString() } };
        writeUsersFileLocked({ ...file, users: file.users.map((u) => (u.id === next.id ? next : u)) });
      }
      log.write();
    } finally {
      log.close();
    }
    return ok;
  }, 0);
}

export const serviceView = (u: ServiceAccount): ServiceView => publicUser(u) as ServiceView;
