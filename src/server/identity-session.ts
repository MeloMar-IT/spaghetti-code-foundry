import type { IncomingMessage } from "node:http";
import { REASON_TAKEN, reportIdentityProblem, resolveIdentity, type IdentityRequest, type Resolution } from "../auth/identity.js";
import { refreshProviderSession, startProviderSession, type ProviderIdentity } from "../auth/provider-users.js";
import { revokeSession, sessionId } from "../auth/sessions.js";
import type { User } from "../auth/users.js";
import { DEFAULT_WORKSPACE, knownWorkspace } from "../workspaces/index.js";

/**
 * The session flow of the identity provider (#833): asks the provider about a request, then signs in or rechecks a session.
 * Everything that reads the stores happens after the provider has answered, so a change made while it was thinking wins.
 */

/** The request as the provider sees it: the session cookie is removed, other cookies stay. */
export function identityRequest(req: IncomingMessage, cookieName: string): IdentityRequest {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const v = Array.isArray(value) ? value.join(", ") : value;
    if (name === "cookie") {
      const kept = v
        .split(";")
        .map((p) => p.trim())
        .filter((p) => p !== "" && p.slice(0, Math.max(p.indexOf("="), 0)).trim() !== cookieName);
      if (kept.length) headers.cookie = kept.join("; ");
      continue;
    }
    headers[name] = v;
  }
  return { method: req.method ?? "GET", url: req.url ?? "/", headers, remoteAddress: req.socket?.remoteAddress ?? "" };
}

/** An unknown (but well-formed) workspace becomes "default". */
function toIdentity(r: Extract<Resolution, { kind: "user" }>): ProviderIdentity {
  const ws = r.workspace ?? DEFAULT_WORKSPACE;
  return { id: r.id, name: r.name, role: r.role, workspace: knownWorkspace(ws) ? ws : DEFAULT_WORKSPACE };
}

export type SessionCheck = { kind: "ok"; user: User } | { kind: "revoked" } | { kind: "refused" } | { kind: "error" };

/**
 * Asks the provider again for a live provider session. A null answer or another id revokes the session. A provider error does
 * not (the caller answers 503). A recheck never creates an account or a session.
 */
export async function recheckProviderSession(req: IncomingMessage, cookieName: string, cur: { token: string; user: User }): Promise<SessionCheck> {
  const r = await resolveIdentity(identityRequest(req, cookieName));
  if (r.kind === "error") return { kind: "error" };
  const key = sessionId(cur.token);
  if (r.kind === "none" || r.id !== cur.user.id) {
    revokeSession(key);
    return { kind: "revoked" };
  }
  const refreshed = refreshProviderSession(key, toIdentity(r));
  return refreshed.kind === "ok" ? { kind: "ok", user: refreshed.user } : { kind: "refused" };
}

export type ProviderSignIn = { kind: "ok"; user: User; token: string; auditFailed?: true } | { kind: "none" } | { kind: "error" } | { kind: "blocked"; id: string };

/** Signs in whoever the provider names (creates or updates their record). `replaces` is the id of the session the request came with. */
export async function providerSignIn(req: IncomingMessage, cookieName: string, replaces?: string): Promise<ProviderSignIn> {
  const r = await resolveIdentity(identityRequest(req, cookieName));
  if (r.kind !== "user") return { kind: r.kind };
  const started = startProviderSession(toIdentity(r), replaces);
  if (started.kind === "taken") {
    reportIdentityProblem(REASON_TAKEN);
    return { kind: "error" };
  }
  if (started.kind === "blocked") return { kind: "blocked", id: r.id };
  return started;
}
