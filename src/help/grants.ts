import { createHash, randomBytes } from "node:crypto";
import type { About } from "./contract.js";

/** How long a confirmation token works, in ms. */
export const GRANT_TTL_MS = 300_000;
export const GRANTS_PER_OWNER = 5;
export const GRANTS_MAX = 1000;

/** What a token is bound to: the account, the conversation, the reply and the place of the action in it. */
export interface GrantBinding {
  owner: string;
  conversation: string;
  message: string;
  index: number;
}

export interface Grant extends GrantBinding {
  action: string;
  about: About;
  /** The state version of the run when the preview was made. */
  version: string;
  expiresAt: number;
}

export type TakeResult = { ok: true; grant: Grant } | { ok: false; reason: "unknown" | "expired" | "mismatch" };

export const sameBinding = (g: GrantBinding, b: GrantBinding): boolean => g.owner === b.owner && g.conversation === b.conversation && g.message === b.message && g.index === b.index;

const hashOf = (token: string): string => createHash("sha256").update(token).digest("hex");

/**
 * The confirmation tokens of previewed actions, in memory only. A grant is kept under the sha256 of its token; the
 * token itself is never stored. A token works once, for GRANT_TTL_MS, for the binding it was made for.
 */
export class ActionGrants {
  private grants = new Map<string, Grant>();
  private now: () => number;
  private ttlMs: number;
  private perOwner: number;
  private max: number;

  constructor(o: { now?: () => number; ttlMs?: number; perOwner?: number; max?: number } = {}) {
    this.now = o.now ?? Date.now;
    this.ttlMs = o.ttlMs ?? GRANT_TTL_MS;
    this.perOwner = o.perOwner ?? GRANTS_PER_OWNER;
    this.max = o.max ?? GRANTS_MAX;
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, g] of this.grants) if (g.expiresAt <= t) this.grants.delete(k);
  }

  /** A new token. It replaces the older grant for the same reply action, and the oldest grants go above the limits. */
  issue(g: Omit<Grant, "expiresAt">): { token: string; expiresAt: number } {
    this.sweep();
    for (const [k, old] of this.grants) if (sameBinding(old, g)) this.grants.delete(k);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + this.ttlMs;
    this.grants.set(hashOf(token), { ...g, about: { ...g.about }, expiresAt });
    const mine = [...this.grants].filter(([, x]) => x.owner === g.owner);
    for (const [k] of mine.slice(0, Math.max(0, mine.length - this.perOwner))) this.grants.delete(k);
    while (this.grants.size > this.max) this.grants.delete(this.grants.keys().next().value!);
    return { token, expiresAt };
  }

  /** A copy of the grant, or undefined (unknown or expired; an expired one is removed). Does not burn the token. */
  peek(token: string): Grant | undefined {
    const k = hashOf(token);
    const g = this.grants.get(k);
    if (!g) return undefined;
    if (g.expiresAt <= this.now()) {
      this.grants.delete(k);
      return undefined;
    }
    return { ...g, about: { ...g.about } };
  }

  /** Uses the token up. A token that does not fit the binding is burned too. */
  take(token: string, bind: GrantBinding): TakeResult {
    const k = hashOf(token);
    const g = this.grants.get(k);
    if (!g) return { ok: false, reason: "unknown" };
    this.grants.delete(k);
    if (g.expiresAt <= this.now()) return { ok: false, reason: "expired" };
    if (!sameBinding(g, bind)) return { ok: false, reason: "mismatch" };
    return { ok: true, grant: { ...g, about: { ...g.about } } };
  }

  /** Drops a token of this account and conversation; true when one was removed. */
  cancel(token: string, owner: string, conversation: string): boolean {
    const k = hashOf(token);
    const g = this.grants.get(k);
    if (!g || g.owner !== owner || g.conversation !== conversation) return false;
    this.grants.delete(k);
    return true;
  }

  get size(): number {
    return this.grants.size;
  }
}

const byKey = new WeakMap<object, ActionGrants>();
/** The grants of one server (keyed by its context). */
export function grantsOf(key: object): ActionGrants {
  let g = byKey.get(key);
  if (!g) {
    g = new ActionGrants();
    byKey.set(key, g);
  }
  return g;
}
