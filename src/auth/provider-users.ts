import { appendAuditLocked } from "./audit.js";
import { addSessionLocked, readSessions } from "./sessions.js";
import { withAuthLock } from "./store.js";
import { readUsersFile, writeUsersFileLocked, type User } from "./users.js";

/**
 * Mirror accounts of the identity provider (#833). The provider is the source of truth for who someone is, their role and
 * their workspace; users.json keeps one `source: "provider"` record per account so the ~30 places that look an account up by
 * id keep working. A record never has a password. Recheck never creates a record.
 */

/** UserSchema needs a unique, valid e-mail: a provider record gets a name that can never be real. */
export const providerEmail = (id: string): string => `${id}@identity-provider.invalid`;

export interface ProviderIdentity {
  id: string;
  name: string;
  role: "admin" | "user";
  workspace: string;
}

export type ProviderStart = { kind: "ok"; user: User; token: string; auditFailed?: true } | { kind: "blocked" } | { kind: "taken" };

/**
 * Under one lock: creates or updates the record, sets `lastSignIn`, starts the session (`replaces` is the id of the session the
 * request came with) and adds the sign-in audit line (best effort). A local account with the id or the e-mail is never taken over.
 */
export function startProviderSession(identity: ProviderIdentity, replaces?: string, now = new Date()): ProviderStart {
  return withAuthLock((): ProviderStart => {
    const file = readUsersFile();
    const i = file.users.findIndex((u) => u.id === identity.id);
    const cur = file.users[i];
    if (cur && cur.source !== "provider") return { kind: "taken" };
    if (cur && cur.status !== "active") return { kind: "blocked" };
    const email = providerEmail(identity.id);
    if (!cur && file.users.some((u) => u.email === email)) return { kind: "taken" };
    const lastSignIn = now.toISOString();
    const user: User = cur
      ? { ...cur, name: identity.name, role: identity.role, workspace: identity.workspace, lastSignIn }
      : { id: identity.id, name: identity.name, email, role: identity.role, status: "active", source: "provider", workspace: identity.workspace, created: lastSignIn, lastSignIn };
    writeUsersFileLocked({ ...file, users: cur ? file.users.map((u, j) => (j === i ? user : u)) : [...file.users, user] });
    const token = addSessionLocked(user.id, replaces, now.getTime());
    try {
      appendAuditLocked(user.id, { action: "sign-in", result: "ok", target: "identity-provider" });
      return { kind: "ok", user, token };
    } catch {
      return { kind: "ok", user, token, auditFailed: true }; // best-effort: the session stands
    }
  });
}

export type ProviderRefresh = { kind: "ok"; user: User } | { kind: "refused" };

const same = (u: User, id: ProviderIdentity) => u.name === id.name && u.role === id.role && u.workspace === id.workspace;

/**
 * A recheck after the provider answered again. The session and the account are read now, after the answer: a revoked or expired
 * session, or a missing, blocked or local account is refused. Nothing is created, and nothing is written when nothing changed
 * (that path takes no lock).
 */
export function refreshProviderSession(sessionKey: string, identity: ProviderIdentity, now = Date.now()): ProviderRefresh {
  const live = () => readSessions().some((s) => s.id === sessionKey && s.userId === identity.id && Date.parse(s.expires) > now);
  const fast = readUsersFile().users.find((u) => u.id === identity.id);
  if (fast && fast.source === "provider" && fast.status === "active" && same(fast, identity)) return live() ? { kind: "ok", user: fast } : { kind: "refused" };
  return withAuthLock((): ProviderRefresh => {
    if (!live()) return { kind: "refused" };
    const file = readUsersFile();
    const i = file.users.findIndex((u) => u.id === identity.id);
    const cur = file.users[i];
    if (!cur || cur.source !== "provider" || cur.status !== "active") return { kind: "refused" };
    if (same(cur, identity)) return { kind: "ok", user: cur };
    const user: User = { ...cur, name: identity.name, role: identity.role, workspace: identity.workspace };
    writeUsersFileLocked({ ...file, users: file.users.map((u, j) => (j === i ? user : u)) });
    return { kind: "ok", user };
  });
}
