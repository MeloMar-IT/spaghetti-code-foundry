import { createHash, randomBytes } from "node:crypto";

// The confirmation tokens of "Yes, publish" (#796): nothing of a local project leaves the machine until its owner has seen the
// check (a dry run) and confirmed it. Like src/help/grants.ts: in memory only, kept under the sha256 of the token, usable once,
// with a time limit and a limit per owner. A token that does not fit is burned.

/** How long a confirmation works, in ms. */
export const PUBLISH_TTL_MS = 600_000;
export const PUBLISH_PER_OWNER = 5;
export const PUBLISH_MAX = 1000;
export const PUBLISH_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export type PublishKind = "move" | "push-remote" | "restore";

/** What a token is bound to: the account, the project, what it publishes and the request that was checked. */
export interface PublishBinding {
  owner: string;
  repoId: string;
  kind: PublishKind;
  /** The canonical text of the request (target, includeClosed; or the proposed branch settings). */
  request: string;
}

export interface PublishGrant extends PublishBinding {
  /** A sha256 of what will be published and where. */
  what: string;
  expiresAt: number;
}

export type PublishReason = "needed" | "used" | "mismatch";
export type PublishTake = { ok: true; grant: PublishGrant } | { ok: false; reason: PublishReason };

/** A sha256 (hex) of a value, for the fingerprint of what is published. Stable for the same JSON. */
export const fingerprint = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const hashOf = (token: string): string => createHash("sha256").update(token).digest("hex");
const sameBinding = (a: PublishBinding, b: PublishBinding): boolean => a.owner === b.owner && a.repoId === b.repoId && a.kind === b.kind && a.request === b.request;

export class PublishGrants {
  private grants = new Map<string, PublishGrant>();
  private now: () => number;
  private ttlMs: number;
  private perOwner: number;
  private max: number;

  constructor(o: { now?: () => number; ttlMs?: number; perOwner?: number; max?: number } = {}) {
    this.now = o.now ?? (() => Date.now());
    this.ttlMs = o.ttlMs ?? PUBLISH_TTL_MS;
    this.perOwner = o.perOwner ?? PUBLISH_PER_OWNER;
    this.max = o.max ?? PUBLISH_MAX;
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, g] of this.grants) if (g.expiresAt <= t) this.grants.delete(k);
  }

  /** A new token. It replaces the older one of the same account, project and kind; the oldest go above the limits. */
  issue(b: PublishBinding, what: string): { token: string; expiresAt: number } {
    this.sweep();
    for (const [k, old] of this.grants) if (old.owner === b.owner && old.repoId === b.repoId && old.kind === b.kind) this.grants.delete(k);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + this.ttlMs;
    this.grants.set(hashOf(token), { ...b, what, expiresAt });
    const mine = [...this.grants].filter(([, x]) => x.owner === b.owner);
    for (const [k] of mine.slice(0, Math.max(0, mine.length - this.perOwner))) this.grants.delete(k);
    while (this.grants.size > this.max) this.grants.delete(this.grants.keys().next().value!);
    return { token, expiresAt };
  }

  /** Uses the token up, whatever the outcome. It must fit the binding exactly. */
  take(token: unknown, bind: PublishBinding): PublishTake {
    if (typeof token !== "string" || !PUBLISH_TOKEN.test(token)) return { ok: false, reason: "needed" };
    const k = hashOf(token);
    const g = this.grants.get(k);
    if (!g) return { ok: false, reason: "used" };
    this.grants.delete(k);
    if (g.expiresAt <= this.now()) return { ok: false, reason: "used" };
    if (!sameBinding(g, bind)) return { ok: false, reason: "mismatch" };
    return { ok: true, grant: { ...g } };
  }

  get size(): number {
    return this.grants.size;
  }
}

const byKey = new WeakMap<object, PublishGrants>();
/** The publish grants of one server (keyed by its context). */
export function publishGrantsOf(key: object): PublishGrants {
  let g = byKey.get(key);
  if (!g) {
    g = new PublishGrants();
    byKey.set(key, g);
  }
  return g;
}

/** The sentences of a refusal. Each says that nothing was published. */
export const PUBLISH_WORDS = {
  needed: "Nothing was published: run the check first and confirm it with Yes, publish",
  used: "Nothing was published: the confirmation is used up or has expired; run the check again",
  mismatch: "Nothing was published: the confirmation was made for another request; run the check again",
  changed: "Nothing was published: the project changed since the check; run the check again and look at it",
  blocked: "Nothing was published: some stories cannot go along, so there is nothing to confirm; fix them and run the check again",
  noRemote: "Nothing was published: the folder has no git remote to push to",
} as const;

export const refusalText = (reason: PublishReason): string => PUBLISH_WORDS[reason];
