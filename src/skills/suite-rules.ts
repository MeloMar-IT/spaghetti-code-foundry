// The evaluation suites a Kafka or Confluent skill has to pass before it can be promoted: names, codes, limits and the text rules
// of the messaging-semantics check. Data only: no imports, no code that reads a file or the clock. The rules are tuned in
// tests/skill-suites.test.ts against skills/kafka (no false positives) and against lines that contradict it.

export const SUITES = ["messaging-semantics", "compatibility"] as const;
export type SuiteName = (typeof SUITES)[number];
export const MESSAGING_CODES = ["dead-letters", "duplicates", "exactly-once", "keys", "ordering", "retries"] as const;
export const COMPATIBILITY_CODES = ["incompatible", "no-declared-versions", "stale", "unchecked"] as const;
export const RECORD_CODES = ["not-recorded", "other-digest", "profile", "recorded-failed"] as const;
export type MessagingCode = (typeof MESSAGING_CODES)[number];
export type CompatibilityCode = (typeof COMPATIBILITY_CODES)[number];
export type SuiteCode = MessagingCode | CompatibilityCode | (typeof RECORD_CODES)[number];
/** A skill with an effective capability that starts like this needs both suites. */
export const SUITE_CAPABILITY_PREFIXES = ["kafka-", "confluent-"] as const;
/** A skill without capabilities from a source with one of these providers needs both suites. */
export const SUITE_PROVIDERS = ["confluent"] as const;
export const SUITE_LIMITS = { at: 10, records: 500, project: 8, noteChars: 200 } as const;

export interface SuiteRecord {
  source: string;
  skill: string;
  digest: string;
  suite: SuiteName;
  result: "passed" | "failed";
  /** Compatibility only: the project technologies the owner checked against, sorted by name. */
  project?: { name: string; version: string }[];
  owner: string;
  reviewed: string;
  note?: string;
}

// All case-insensitive. Windows are bounded (`.{0,N}`) because code such as `transactional.id` holds dots.
const EXTERNAL = String.raw`(?:database|db|http|e-?mail|another broker|external (?:system|service|effect)s?)`;
export const EXACTLY_ONCE = {
  claim: /\bexactly[-_ ]once/gi,
  enumeration: /\bat most once\b.{0,40}\bat least once\b.{0,40}\bexactly[- ]once\b/i,
  /** Text before a claim that denies it. */
  negation: /\b(?:not|never|no|cannot|can't|doesn't|don't)\b[^.]{0,40}$/i,
  inside: /\b(?:inside|within) kafka\b|\b(?:no effect|nothing) leaves kafka\b/i,
  client: [
    /\bidempoten/i,
    /\btransactional\.id\b/i,
    /\bread_committed\b/i,
    /\boffsets?\b.{0,60}\b(?:in|inside|within) the (?:same )?transaction\b|\bsendOffsetsToTransaction\b|\btransactional offsets?\b/i,
  ],
  streams: [/\bexactly_once_v2\b/i],
  external: new RegExp(`\\b${EXTERNAL}\\b`, "i"),
  /** The line says the effect stays outside the guarantee and has to be made safe by the reader. */
  outside: /\boutside\b|\bmust be idempotent\b|\bidempotent consumer\b|\bat least once\b/i,
  /** A verb that extends the guarantee to an external effect. */
  externalClaim: new RegExp(`(?<![.\\w])\\b(?:guarantee[sd]?|gives?|provides?|ensures?|covers?|extends?|includes?|reaches|into)\\b.{0,60}\\b${EXTERNAL}\\b`, "gi"),
  /** Text before such a verb that denies it. */
  externalNegation: /\b(?:not|never|no|cannot|doesn't|don't)\b[^.]{0,30}$/i,
} as const;

export const MESSAGING_CLAIMS: readonly { code: Exclude<MessagingCode, "exactly-once">; claim: RegExp; unless?: RegExp }[] = [
  {
    code: "ordering",
    claim: /\border\b.{0,30}\b(?:kept|guaranteed|preserved|holds?)\b.{0,30}\bacross\b.{0,20}\bpartitions\b|\bglobal(?:ly)? order/i,
    unless: /\b(?:not|never|no|only)\b/i,
  },
  {
    code: "keys",
    claim: /\b(?:increase|raise|change|add)\b.{0,40}\bpartition(?:s| count)\b.{0,40}\b(?:safe(?:ly)?|freely|at any time|without (?:risk|impact))\b/i,
    unless: /\b(?:not|never|breaks?|breaking)\b/i,
  },
  {
    code: "duplicates",
    claim: /\b(?:never|no|without)\b.{0,40}\bduplicates?\b|\bduplicates?\b.{0,20}\b(?:cannot|can't|never|will not|won't)\b/i,
    unless: /\bidempotent producer\b|\bown retries\b|\bmust be safe\b|\bdeduplicat/i,
  },
  {
    code: "retries",
    claim: /\bretr(?:y|ies)\b.{0,40}\b(?:forever|indefinitely|endlessly|until it succeeds|without (?:a )?limit)\b|\b(?:infinite|unbounded|endless) retr/i,
    unless: /\b(?:never|no|not|don't|do not)\b/i,
  },
  {
    code: "dead-letters",
    claim: /\b(?:skip|drop|discard|ignore)\b.{0,20}\b(?:poison|failed|failing|bad)\b.{0,10}\bmessages?\b/i,
    unless: /\bdead[- ]letter|\b(?:never|not|neither)\b/i,
  },
  {
    code: "dead-letters",
    claim: /\bdead[- ]letter\b.{0,60}\bwithout\b.{0,20}\bkey\b|\b(?:drop|strip|remove)\b.{0,20}\bkey\b.{0,60}\bdead[- ]letter/i,
    // A prohibition ("Never send it without the original key") is the right advice.
    unless: /\b(?:never|not|no|don't|do not|must not|neither)\b/i,
  },
];
