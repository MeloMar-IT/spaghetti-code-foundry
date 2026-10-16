import { lstatSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { dataHome, openAppendLocked, withAuthLock } from "../auth/store.js";
import { credentialProblem } from "./credential-scan.js";
import { parseSkillKey } from "./lock.js";
import { readRegular } from "./package.js";

// The skill lifecycle record: an append-only file of JSON lines in the data folder. A transition sets the state of one
// skill version; an allowance lets one run go on with a quarantined version. A missing file means every version is active.
// The reader replays every line through the same rules as the writer and fails closed on anything else.

export const SKILL_LIFECYCLE_FILE = "skill-lifecycle.jsonl";
export const MAX_SKILL_LIFECYCLE_BYTES = 4 * 1024 * 1024;
export const LIFECYCLE_STATES = ["active", "deprecated", "quarantined", "retired", "revoked"] as const;
export type SkillLifecycleState = (typeof LIFECYCLE_STATES)[number];
/** Versions in these states are not selected for new runs. */
export const INELIGIBLE_STATES: ReadonlySet<SkillLifecycleState> = new Set<SkillLifecycleState>(["quarantined", "retired", "revoked"]);
export const RUN_ID_RE = /^[\w-]{1,128}$/;

export const skillLifecyclePath = (home = dataHome()) => join(home, SKILL_LIFECYCLE_FILE);

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** Why a reason text is not allowed, or undefined. The message never holds the text. */
export function lifecycleReasonProblem(reason: string): string | undefined {
  if (typeof reason !== "string" || reason.length < 1) return "the reason is empty";
  if (reason.length > 200) return "the reason is longer than 200 characters";
  if (reason !== reason.trim()) return "the reason has spaces around it";
  if (CONTROL.test(reason)) return "the reason has a control character";
  if (credentialProblem(reason) !== undefined) return "the reason looks like a credential";
  return undefined;
}

const KeySchema = z.string().refine((k) => parseSkillKey(k) !== undefined, "not a skill key");
const ReasonSchema = z.string().refine((r) => lifecycleReasonProblem(r) === undefined, "not a valid reason");
const BySchema = z.union([z.literal("cli"), z.uuid()]);
const StateSchema = z.enum(LIFECYCLE_STATES);

const TransitionSchema = z
  .object({
    type: z.literal("transition"),
    seq: z.number().int().min(1),
    key: KeySchema,
    from: StateSchema,
    to: StateSchema,
    at: z.iso.datetime(),
    by: BySchema,
    reason: ReasonSchema,
    replacement: KeySchema.optional(),
  })
  .strict();
const AllowRunSchema = z
  .object({
    type: z.literal("allow-run"),
    seq: z.number().int().min(1),
    key: KeySchema,
    runId: z.string().regex(RUN_ID_RE),
    at: z.iso.datetime(),
    by: BySchema,
    reason: ReasonSchema,
  })
  .strict();
export const LifecycleLineSchema = z.discriminatedUnion("type", [TransitionSchema, AllowRunSchema]);
export type TransitionLine = z.infer<typeof TransitionSchema>;
export type AllowRunLine = z.infer<typeof AllowRunSchema>;
export type SkillLifecycleLine = z.infer<typeof LifecycleLineSchema>;

export interface SkillRunAllowance {
  seq: number;
  runId: string;
  at: string;
  by: string;
  reason: string;
}
export interface SkillLifecycleStatus {
  state: SkillLifecycleState;
  seq: number;
  since: string;
  by: string;
  reason: string;
  replacement?: string;
  allowedRuns: SkillRunAllowance[];
}
/** A revocation from an approved release. `by` is `<catalogue>@<version>`. */
export interface SkillReleaseRevocation {
  by: string;
  on: string;
  reason: string;
}
export interface EffectiveLifecycle extends SkillLifecycleStatus {
  /** `<catalogue>@<version>` when a release revokes the key. */
  release?: string;
}
export type SkillLifecycleRead =
  | { ok: true; statuses: Map<string, SkillLifecycleStatus>; lines: SkillLifecycleLine[]; bytes: number; endsWithNewline: boolean }
  | { ok: false; reason: string };

/** Why `from → to` is not allowed, or undefined. Used by the writer and by the replay of the reader. */
export function lifecycleTransitionProblem(from: SkillLifecycleState, to: SkillLifecycleState): string | undefined {
  if (from === "revoked") return "a revoked version can never change state again";
  if (from === to) return `the version is already ${to}`;
  return undefined;
}

type Replay = { ok: true; statuses: Map<string, SkillLifecycleStatus>; lines: SkillLifecycleLine[] } | { ok: false; line: number };

function replay(texts: string[]): Replay {
  const statuses = new Map<string, SkillLifecycleStatus>();
  const lines: SkillLifecycleLine[] = [];
  let seq = 0;
  for (let i = 0; i < texts.length; i++) {
    const bad = { ok: false as const, line: i + 1 };
    let json: unknown;
    try {
      json = JSON.parse(texts[i]!);
    } catch {
      return bad;
    }
    const p = LifecycleLineSchema.safeParse(json);
    if (!p.success) return bad;
    const l = p.data;
    if (l.seq !== seq + 1) return bad;
    seq = l.seq;
    const cur = statuses.get(l.key);
    const state = cur?.state ?? "active";
    if (l.type === "transition") {
      if (l.from !== state || lifecycleTransitionProblem(l.from, l.to)) return bad;
      if (l.replacement !== undefined && (l.to === "active" || l.replacement === l.key)) return bad;
      statuses.set(l.key, { state: l.to, seq: l.seq, since: l.at, by: l.by, reason: l.reason, ...(l.replacement ? { replacement: l.replacement } : {}), allowedRuns: [] });
    } else {
      if (!cur || state !== "quarantined") return bad;
      cur.allowedRuns.push({ seq: l.seq, runId: l.runId, at: l.at, by: l.by, reason: l.reason });
    }
    lines.push(l);
  }
  return { ok: true, statuses, lines };
}

/** Reads the record. A missing file is empty. Anything wrong is `ok: false` with a reason that holds no path and no file content. */
export function readSkillLifecycle(home = dataHome(), maxBytes = MAX_SKILL_LIFECYCLE_BYTES): SkillLifecycleRead {
  const file = skillLifecyclePath(home);
  try {
    lstatSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, statuses: new Map(), lines: [], bytes: 0, endsWithNewline: true };
    return { ok: false, reason: `cannot be read (${(e as NodeJS.ErrnoException).code ?? "error"})` };
  }
  const bytes = readRegular(file, maxBytes);
  if (typeof bytes === "string") {
    return { ok: false, reason: bytes === "large" ? `is larger than ${maxBytes} bytes` : bytes === "link" ? "is a symbolic link" : "is not a readable regular file" };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "is not valid UTF-8" };
  }
  const parts = text.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  const r = replay(parts);
  if (!r.ok) return { ok: false, reason: `has a line that is not valid (line ${r.line})` };
  return { ok: true, statuses: r.statuses, lines: r.lines, bytes: bytes.length, endsWithNewline: bytes.length === 0 || bytes[bytes.length - 1] === 0x0a };
}

/** The state that counts for a key: a release revocation wins over every local state. Undefined means active. */
export function effectiveLifecycle(
  reg: { lifecycle?: ReadonlyMap<string, SkillLifecycleStatus>; revoked?: ReadonlyMap<string, SkillReleaseRevocation> },
  key: string,
): EffectiveLifecycle | undefined {
  const local = reg.lifecycle?.get(key);
  const rel = reg.revoked?.get(key);
  if (rel) {
    return { state: "revoked", seq: local?.seq ?? 0, since: rel.on, by: rel.by, reason: rel.reason, ...(local?.replacement ? { replacement: local.replacement } : {}), allowedRuns: [], release: rel.by };
  }
  return local && local.state !== "active" ? local : undefined;
}

export type LifecycleWrite<T> =
  | { status: "ok"; line: T; added: boolean }
  | { status: "bad-input" | "bad-transition" | "not-quarantined" | "unreadable" | "full"; reason: string };

export const LIFECYCLE_FULL_REASON = "the skill lifecycle record is full (4 MiB); no more changes can be recorded. Do not remove or shorten skill-lifecycle.jsonl: without it every skill version counts as active again.";

interface WriteBase {
  key: string;
  reason: string;
  by: string;
  now?: Date;
  waitMs?: number;
  maxBytes?: number;
}

function inputProblem(i: WriteBase): string | undefined {
  if (!parseSkillKey(i.key)) return "not a skill key (expected id@version)";
  if (!BySchema.safeParse(i.by).success) return "the actor is not valid";
  return lifecycleReasonProblem(i.reason);
}

function append(line: SkillLifecycleLine, cur: Extract<SkillLifecycleRead, { ok: true }>, maxBytes: number): { status: "full" } | { status: "ok" } {
  const text = JSON.stringify(line);
  const size = cur.bytes + (cur.bytes > 0 && !cur.endsWithNewline ? 1 : 0) + Buffer.byteLength(text) + 1;
  if (size > maxBytes) return { status: "full" };
  const f = openAppendLocked(skillLifecyclePath());
  try {
    f.append(text);
  } finally {
    f.close();
  }
  return { status: "ok" };
}

/** Sets the state of one version. Checked under the data-folder lock; a `StoreError` (`locked`) propagates. */
export function recordLifecycleTransition(i: WriteBase & { to: SkillLifecycleState; replacement?: string }): LifecycleWrite<TransitionLine> {
  const bad = (reason: string) => ({ status: "bad-input" as const, reason });
  const problem = inputProblem(i);
  if (problem) return bad(problem);
  if (!LIFECYCLE_STATES.includes(i.to)) return bad("not a lifecycle state");
  if (i.replacement !== undefined) {
    if (!parseSkillKey(i.replacement)) return bad("the replacement is not a skill key (expected id@version)");
    if (i.replacement === i.key) return bad("the replacement must be another version");
    if (i.to === "active") return bad("a replacement only goes with a state other than active");
  }
  const maxBytes = i.maxBytes ?? MAX_SKILL_LIFECYCLE_BYTES;
  return withAuthLock((): LifecycleWrite<TransitionLine> => {
    const cur = readSkillLifecycle();
    if (!cur.ok) return { status: "unreadable", reason: `the skill lifecycle record ${cur.reason}` };
    const from = cur.statuses.get(i.key)?.state ?? "active";
    const why = lifecycleTransitionProblem(from, i.to);
    if (why) return { status: "bad-transition", reason: why };
    const line: TransitionLine = {
      type: "transition",
      seq: (cur.lines.at(-1)?.seq ?? 0) + 1,
      key: i.key,
      from,
      to: i.to,
      at: (i.now ?? new Date()).toISOString(),
      by: i.by,
      reason: i.reason,
      ...(i.replacement ? { replacement: i.replacement } : {}),
    };
    if (append(line, cur, maxBytes).status === "full") return { status: "full", reason: LIFECYCLE_FULL_REASON };
    return { status: "ok", line, added: true };
  }, i.waitMs);
}

/** Lets one run go on with a quarantined version. The same allowance twice is a no-op (`added: false`). */
export function recordRunAllowance(i: WriteBase & { runId: string }): LifecycleWrite<AllowRunLine> {
  const problem = inputProblem(i);
  if (problem) return { status: "bad-input", reason: problem };
  if (!RUN_ID_RE.test(i.runId)) return { status: "bad-input", reason: "not a run id" };
  const maxBytes = i.maxBytes ?? MAX_SKILL_LIFECYCLE_BYTES;
  return withAuthLock((): LifecycleWrite<AllowRunLine> => {
    const cur = readSkillLifecycle();
    if (!cur.ok) return { status: "unreadable", reason: `the skill lifecycle record ${cur.reason}` };
    const st = cur.statuses.get(i.key);
    if (!st || st.state !== "quarantined") return { status: "not-quarantined", reason: `${i.key} is not quarantined` };
    const have = st.allowedRuns.find((a) => a.runId === i.runId);
    if (have) {
      const old = cur.lines.find((l): l is AllowRunLine => l.type === "allow-run" && l.seq === have.seq)!;
      return { status: "ok", line: old, added: false };
    }
    const line: AllowRunLine = {
      type: "allow-run",
      seq: (cur.lines.at(-1)?.seq ?? 0) + 1,
      key: i.key,
      runId: i.runId,
      at: (i.now ?? new Date()).toISOString(),
      by: i.by,
      reason: i.reason,
    };
    if (append(line, cur, maxBytes).status === "full") return { status: "full", reason: LIFECYCLE_FULL_REASON };
    return { status: "ok", line, added: true };
  }, i.waitMs);
}
