import { BLOCKED, liveRedactor, type Redactor } from "../credentials/redact.js";
import { PATTERN_LIMIT, PATTERN_MAX } from "./patterns.js";

export { PATTERN_LIMIT, PATTERN_MAX, usablePattern } from "./patterns.js";

/**
 * The guard of Ask SCF: what stands between a text and the two places a text can go, the store (`help.json`) and
 * the model. It takes secrets out (`scrub`), and it holds back copied text that reads like an order to the model
 * (`guardExcerpt`). Both fail closed: when a check cannot be done, a `GuardError` is thrown and the caller neither
 * stores nor sends anything. Pure functions; the only thing read is the set of stored credentials.
 */

/** What kind of secret was taken out. A report names the kind, never the value. */
export const SECRET_CATEGORIES = ["stored-credential", "private-key", "authorization-header", "cookie", "url-credential", "token", "environment-secret", "configured-pattern"] as const;
export type SecretCategory = (typeof SECRET_CATEGORIES)[number];

/** The words that stand where a secret was. */
export const REMOVED_WORDS: Record<SecretCategory, string> = {
  "stored-credential": "[removed: a credential stored in the Foundry]",
  "private-key": "[removed: a private key]",
  "authorization-header": "[removed: an authorization header]",
  cookie: "[removed: a cookie]",
  "url-credential": "[removed: a sign-in in an address]",
  token: "[removed: a token]",
  "environment-secret": "[removed: a secret value]",
  "configured-pattern": "[removed: a text this Foundry keeps private]",
};

/** A check could not be done. The message is in fixed words and safe to log; it never holds the text. */
export class GuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardError";
  }
}

/** The longest text the guard looks at. A longer one is refused, not cut: the cut could split a secret. */
export const GUARD_MAX = 200_000;
export interface GuardOptions {
  /** `help.sensitive_patterns`: regular expressions for texts this install keeps private. */
  patterns?: readonly string[];
  /** The redactor of the stored credentials; tests replace it. */
  stored?: () => Redactor;
}

export interface Scrubbed {
  text: string;
  /** The kinds of secret that were taken out, each once, in the order of `SECRET_CATEGORIES`. */
  removed: SecretCategory[];
}

interface Shape {
  category: Exclude<SecretCategory, "stored-credential" | "configured-pattern">;
  re: RegExp;
  /** The part of the match that stays (a header name, the name of a variable). Default: nothing. */
  keep?: number;
  /** The part after the value that stays. */
  tail?: number;
}

/** After the sign between a name and its value: never match a value that is already one of the guard's own marks. */
const NOT_MARK = String.raw`(?!\s*["']?\[removed: )`;

/**
 * The shapes of secrets, by kind. Order matters: whole blocks and headers first, single tokens after them, and the
 * loose "name = value" rule last. A match that is too wide costs a word of an answer; one that is too narrow leaks.
 */
const SHAPES: readonly Shape[] = [
  { category: "private-key", re: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|$)/g },
  { category: "authorization-header", re: new RegExp(String.raw`\b((?:proxy-)?authorization["']?\s*[:=]${NOT_MARK}\s*["']?)(?:(?:bearer|basic|token|digest|negotiate)\s+)?[^\s"',;]+`, "gi"), keep: 1 },
  { category: "authorization-header", re: /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi },
  { category: "cookie", re: new RegExp(String.raw`\b((?:set-)?cookie["']?\s*[:=]${NOT_MARK}\s*["']?)[^\r\n"']+`, "gi"), keep: 1 },
  { category: "url-credential", re: /\b([a-z][a-z0-9+.-]{1,20}:\/\/)[^\s/:@"'[\]]{1,200}:[^\s/@"']{1,500}(@)/gi, keep: 1, tail: 2 },
  { category: "token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { category: "token", re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { category: "token", re: /\bglpat-[A-Za-z0-9_-]{16,}/g },
  { category: "token", re: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { category: "token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { category: "token", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { category: "token", re: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { category: "token", re: /\bnpm_[A-Za-z0-9]{30,}/g },
  { category: "token", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  {
    category: "environment-secret",
    re: new RegExp(String.raw`\b([A-Za-z0-9_.-]{0,60}(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_.-]{0,60}["']?\s*[:=]${NOT_MARK}\s*["']?)[^\s"',;]{6,}`, "gi"),
    keep: 1,
  },
];

function configured(patterns: readonly string[]): RegExp[] {
  if (patterns.length > PATTERN_LIMIT) throw new GuardError("help.sensitive_patterns has too many patterns");
  return patterns.map((p) => {
    if (typeof p !== "string" || !p || p.length > PATTERN_MAX) throw new GuardError("a pattern of help.sensitive_patterns is not usable");
    try {
      return new RegExp(p, "gi");
    } catch {
      throw new GuardError("a pattern of help.sensitive_patterns is not a regular expression");
    }
  });
}

/**
 * The text without secrets, and the kinds that were taken out. Stored credentials go first (by value), then the
 * known shapes, then the patterns of this install. Throws `GuardError` when it cannot be sure: the credential store
 * cannot be read, a configured pattern is broken, or the text is too long to check.
 */
export function scrub(text: string, o: GuardOptions = {}): Scrubbed {
  if (typeof text !== "string") throw new GuardError("only text can be checked for secrets");
  if (text.length > GUARD_MAX) throw new GuardError("a text is too long to be checked for secrets");
  const found = new Set<SecretCategory>();
  let out = text;
  try {
    const extra = configured(o.patterns ?? []);
    const stored = (o.stored ?? liveRedactor)();
    if (stored === BLOCKED) throw new GuardError("the stored credentials cannot be read, so no text can be checked for secrets");
    if (!stored.empty) {
      let next = "";
      let at = 0;
      for (const m of stored.find(out)) {
        next += out.slice(at, m.start) + REMOVED_WORDS["stored-credential"];
        at = m.end;
        found.add("stored-credential");
      }
      out = next + out.slice(at);
      if (stored.find(out).length) throw new GuardError("a stored credential could not be taken out of a text");
    }
    for (const s of SHAPES) {
      out = out.replace(s.re, (...m: unknown[]) => {
        found.add(s.category);
        const part = (i: number | undefined) => (i !== undefined && typeof m[i] === "string" ? (m[i] as string) : "");
        return `${part(s.keep)}${REMOVED_WORDS[s.category]}${part(s.tail)}`;
      });
    }
    for (const re of extra) {
      out = out.replace(re, (m) => {
        if (!m) return m;
        found.add("configured-pattern");
        return REMOVED_WORDS["configured-pattern"];
      });
    }
  } catch (e) {
    if (e instanceof GuardError) throw e;
    throw new GuardError("a text could not be checked for secrets");
  }
  return { text: out, removed: SECRET_CATEGORIES.filter((c) => found.has(c)) };
}

/** Collects what several `scrub` calls took out. */
export class Removals {
  private readonly seen = new Set<SecretCategory>();
  constructor(private readonly options: GuardOptions = {}) {}
  /** The text without secrets; what was removed is remembered. Throws `GuardError` like `scrub`. */
  clean = (text: string): string => {
    const r = scrub(text, this.options);
    for (const c of r.removed) this.seen.add(c);
    return r.text;
  };
  /** Remembers a kind that was taken out elsewhere. */
  note(c: SecretCategory): void {
    this.seen.add(c);
  }
  get removed(): SecretCategory[] {
    return SECRET_CATEGORIES.filter((c) => this.seen.has(c));
  }
}

// ---- text that reads like an order -----------------------------------------------------------------------

/**
 * Signs that a copied text talks to the model instead of to a person: an order to drop the rules, a made-up
 * "system" or "assistant" turn, the markers of a chat template, or a request for the hidden prompt.
 */
const ORDERS: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,60}\b(?:instructions?|rules|prompts?|guidelines|policy|policies)\b/i,
  /(?:^|\n|\\n)\s*(?:#{1,6}\s*)?\[?(?:system|assistant|developer)(?: message| prompt)?\]?\s*:/i,
  /<\/?\s*(?:system|assistant|instructions?|im_start|im_end)\b[^>]{0,40}>/i,
  /<\|[a-z_]{2,30}\|>/i,
  /\[\/?INST\]/,
  /\byou are now\b/i,
  /\bnew (?:instructions?|rules|system prompt)\b/i,
  /\b(?:reveal|print|show|repeat|output|leak)\b[^.\n]{0,40}\b(?:system prompt|hidden (?:prompt|context|instructions?)|your (?:prompt|instructions|rules))\b/i,
  /\bdo not (?:tell|inform|warn) the (?:user|person)\b/i,
  /\b(?:call|use|run|invoke) the [a-z_ -]{1,30}\b(?:tool|function|command)\b/i,
];

/** Whether a copied text reads like an order to the model. Throws `GuardError` for a text it cannot check. */
export function looksLikeOrders(text: string): boolean {
  if (typeof text !== "string") throw new GuardError("only text can be checked for orders");
  if (text.length > GUARD_MAX) throw new GuardError("a text is too long to be checked for orders");
  try {
    return ORDERS.some((re) => re.test(text));
  } catch {
    throw new GuardError("a text could not be checked for orders");
  }
}

export interface GuardedExcerpt extends Scrubbed {
  /** The text reads like an order to the model, or could not be checked: it is not handed over at all. */
  withheld: boolean;
}

/**
 * A copied text (from a document, a record, a log, a page) made ready for the model: secrets out, and held back
 * when it reads like an order. A failure of the secret check throws (nothing may go out); a failure of the check for
 * orders holds the text back.
 */
export function guardExcerpt(text: string, o: GuardOptions = {}): GuardedExcerpt {
  const s = scrub(text, o);
  let withheld = true;
  try {
    withheld = looksLikeOrders(text) || looksLikeOrders(s.text);
  } catch {
    withheld = true;
  }
  return withheld ? { text: "", removed: s.removed, withheld } : { ...s, withheld };
}
