import { createHash } from "node:crypto";
import { commentId, isFoundryComment, isOverruleReply, type Comment, type Issue } from "../github.js";
import { DECIDED_HEADING, stepIs } from "../next-step.js";
import { isStoppedCancel, type RunSummary } from "../engine/state.js";

/** /overrule: the owner changes a question the Foundry decided itself. Pure: reads comments and a run, builds reply texts. */

export const OVERRULE_ANSWER_MAX = 1000;
export const MERGE_STEPS: readonly string[] = ["push_develop", "push_main"];
export const MERGE_GUARD: readonly string[] = ["merge_develop", "merge_main", "push_develop", "push_main"];
/** The batch note tools/post-questions puts after the decided section; not part of a decision. */
export const EPIC_NOTE = "Each issue in this batch is decided on its own, so two issues may decide the same topic differently.";

export interface Overrule {
  /** overruleKey of the comment. */
  key: string;
  comment: Comment;
  /** The question number; absent for a malformed command. */
  q?: number;
  /** The answer; absent for a malformed command. */
  answer?: string;
  kind: "ok" | "unknown" | "malformed";
  /** The newest Foundry decided comment before the overrule. */
  decided: Comment;
}
export type OverruleAction = "none" | "wait" | "stop" | "followup" | "restart" | { replan: string };

const lines = (body: string): string[] => body.replace(/\r\n?/g, "\n").split("\n");
const lastLine = (body: string): string | undefined => body.split("\n").map((l) => l.trim()).filter(Boolean).at(-1);
const tidy = (t: string): string => t.trim().replace(/\n{3,}/g, "\n\n").slice(0, OVERRULE_ANSWER_MAX);

const COMMAND = /^[ \t]*\/overrule(?=[ \t]|$)(.*)$/i;
const TARGET = /^[ \t]+Q(\d+)[.:]?(?=[ \t]|$)(.*)$/i;

/** The first `/overrule Q<n> <answer>` line (and the lines after it), "malformed" when it is not written that way, undefined without a command. */
export function parseOverrule(body: string): { q: number; answer: string } | "malformed" | undefined {
  const all = lines(body).filter((l) => !l.trimStart().startsWith(">"));
  const at = all.findIndex((l) => COMMAND.test(l));
  if (at < 0) return undefined;
  const target = TARGET.exec(COMMAND.exec(all[at]!)![1]!);
  if (!target) return "malformed";
  const q = Number(target[1]);
  if (!Number.isSafeInteger(q) || q < 1) return "malformed";
  const rest = [target[2]!];
  for (const l of all.slice(at + 1)) {
    if (COMMAND.test(l)) break;
    rest.push(l);
  }
  const answer = tidy(rest.join("\n")).trimEnd();
  return answer ? { q, answer } : "malformed";
}

/**
 * The line index of the italic closing line of a posted comment (`_${tail}_` or `_closing_`), or -1.
 * It is the last content line before the markers, so an italic paragraph inside a decision is never one.
 */
function footerLine(all: string[], start: number): number {
  let i = all.length - 1;
  while (i > start && (!all[i]!.trim() || all[i]!.trim().startsWith("<!--") || all[i]!.trim() === EPIC_NOTE)) i--;
  return i > start && /^_[^_].*_$/.test(all[i]!.trim()) ? i : -1;
}

/** What a "Decided by the Foundry" comment decided, by question number. Questions above the heading are not read. */
export function decidedItems(body: string): Map<number, string> {
  const all = lines(body);
  const out = new Map<number, string>();
  const start = all.findIndex((l) => l.trim() === DECIDED_HEADING);
  if (start < 0) return out;
  let q: number | undefined;
  let value: string[] | undefined;
  const close = () => {
    if (q !== undefined && value) out.set(q, tidy(value.join("\n")));
    value = undefined;
  };
  const footer = footerLine(all, start);
  for (let i = start + 1; i < all.length; i++) {
    const raw = all[i]!;
    const l = raw.replace(/^\s*(?:>\s?)*/, "");
    const heading = /^\*\*Q(\d+)\./.exec(l);
    if (heading) {
      close();
      q = Number(heading[1]);
      if (out.has(q)) q = undefined;
      else out.set(q, "");
      continue;
    }
    if (q === undefined) continue;
    if (value) {
      const t = raw.trim();
      if (t.startsWith("<!--") || t === "---" || t === EPIC_NOTE || i === footer) {
        close();
        q = undefined;
      }
      else value.push(l);
      continue;
    }
    const d = /^\*\*Decision:?\*\*:?\s*/i.exec(l);
    if (d) value = [l.slice(d[0].length)];
  }
  close();
  return out;
}

export function overruleKey(c: Pick<Comment, "url" | "author" | "createdAt">): string {
  return commentId(c.url) ?? "h" + createHash("sha256").update(`${c.author?.login ?? ""}\n${c.createdAt ?? ""}`).digest("hex").slice(0, 12);
}

export const overruleMarker = (key: string, followup = false): string => `<!-- claude-factory overrule=${key}${followup ? " followup" : ""} -->`;

const hasDecidedHeading = (body: string): boolean => lines(body).some((l) => l.trim() === DECIDED_HEADING);

/** The /overrule commands of people that come after a Foundry decided comment and have no Foundry reply yet. */
export function findOverrules(comments: readonly Comment[]): Overrule[] {
  const found: Overrule[] = [];
  let decided: Comment | undefined;
  comments.forEach((c, i) => {
    if (isFoundryComment(c)) {
      if (!isOverruleReply(c) && hasDecidedHeading(c.body)) decided = c;
      return;
    }
    const parsed = parseOverrule(c.body);
    if (parsed === undefined || !decided) return;
    const key = overruleKey(c);
    const handled = [overruleMarker(key), overruleMarker(key, true)];
    if (comments.slice(i + 1).some((n) => isFoundryComment(n) && handled.includes(lastLine(n.body) ?? ""))) return;
    if (parsed === "malformed") found.push({ key, comment: c, kind: "malformed", decided });
    else found.push({ key, comment: c, q: parsed.q, answer: parsed.answer, kind: decidedItems(decided.body).has(parsed.q) ? "ok" : "unknown", decided });
  });
  return found;
}

/** Did a push really move code? A finished push step whose last output line is not MOVED. */
export function codeMerged(run: Pick<RunSummary, "history">): boolean {
  const history = Array.isArray(run.history) ? run.history : [];
  return history.some((x) => x.ok && stepIs(x.id, MERGE_STEPS) && lastLine(x.output ?? "") !== "MOVED");
}

/** Has a merge or push step run from `sinceIndex` on, or is one next? */
export function mergeStarted(run: Pick<RunSummary, "history" | "state">, sinceIndex: number): boolean {
  const history = Array.isArray(run.history) ? run.history : [];
  return history.slice(Math.max(0, sinceIndex || 0)).some((x) => stepIs(x.id, MERGE_GUARD)) || stepIs(run.state?.next, MERGE_GUARD);
}

/** What an accepted overrule does to the run of its issue. */
export function overruleAction(run: RunSummary, busy: "queued" | "active" | undefined, flowHasPlan: boolean): OverruleAction {
  if (!flowHasPlan) return "none";
  if (run.parkedAt || (run.status === "cancelled" && isStoppedCancel(run.reason))) return "none";
  if (busy === "queued") return "wait";
  if (busy === "active") return mergeStarted(run, 0) ? "wait" : "stop";
  if (codeMerged(run)) return "followup";
  const steps = run.flowDef?.steps ?? [];
  if (run.status === "succeeded") return steps.some((s) => stepIs(s.id, MERGE_GUARD)) ? "none" : "restart";
  const first = steps.find((s) => !s.jump_only);
  return first ? { replan: first.id } : "none";
}

const defuse = (t: string): string => t.replace(/<!--/g, "&lt;!--").replace(/-->/g, "--&gt;");
const quote = (t: string): string => t.split("\n").map((l) => (l.trim() ? `> ${l}` : ">")).join("\n");
const FOUNDRY = "🤖 **Spaghetti Code Foundry**";

export function acceptedComment(o: Overrule): string {
  const before = o.q === undefined ? "" : decidedItems(o.decided.body).get(o.q) ?? "";
  return [
    `${FOUNDRY}: ${ACCEPTED_TEXT} for Q${o.q}.`,
    ...(before ? ["The Foundry had decided:", quote(defuse(before))] : []),
    "Your answer replaces it:",
    quote(defuse(o.answer ?? "")),
    overruleMarker(o.key),
  ].join("\n\n");
}

export function noteComment(o: Overrule): string {
  const text = o.kind === "malformed"
    ? `${FOUNDRY}: this overrule was not used. Write it as \`/overrule Q<n> <answer>\`: the number of a question the Foundry decided, then your answer.`
    : [
      `${FOUNDRY}: this overrule was not used: the Foundry's last decided comment has no Q${o.q}.`,
      `Questions it decided: ${[...decidedItems(o.decided.body).keys()].sort((a, b) => a - b).map((n) => `Q${n}`).join(", ")}.`,
    ].join("\n\n");
  return `${text}\n\n${overruleMarker(o.key)}`;
}

export function followUpComment(issue: Pick<Issue, "number">, o: Overrule): string {
  const n = issue.number;
  const body = [
    `The Foundry decided Q${o.q} of #${n} itself; the owner overruled it after the code was merged.`,
    "**Overruled with:**",
    defuse(o.answer ?? ""),
    "### Acceptance criteria",
    `- [ ] The code follows the new answer to Q${o.q}.`,
  ].join("\n\n");
  return [
    `${FOUNDRY}: the code of #${n} is already merged, so this overrule does not change it. A draft for a follow-up issue:`,
    `**Title:** Follow-up to #${n}: apply the overrule of Q${o.q}`,
    quote(body),
    "_The Foundry does not create this issue: create it yourself if you want the change._",
    overruleMarker(o.key, true),
  ].join("\n\n");
}

/** How long after its last update a merged story stays watched for /overrule (#704, Q1: 14 days). */
export const FOLLOWUP_WINDOW_DAYS = 14;
/** At most this many issues per after-merge sweep. */
export const FOLLOWUP_SEARCH_LIMIT = 30;
/** The gh arguments of the after-merge sweep: issues in any state with an /overrule in a comment, updated in the window. */
export function followUpSearchArgs(repo: string, nowMs: number): string[] {
  const since = new Date(nowMs - FOLLOWUP_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  return ["issue", "list", "--repo", repo, "--state", "all", "--search", `overrule in:comments updated:>=${since}`,
    "--limit", String(FOLLOWUP_SEARCH_LIMIT), "--json", "number,updatedAt"];
}

/** Does the flow of this run plan (has a `plan` step)? Only then an overrule can change anything. */
export function hasPlanStep(run: Pick<RunSummary, "flowDef">): boolean {
  return (run.flowDef?.steps ?? []).some((s) => stepIs(s.id, ["plan"]));
}

/** The line a watcher writes into the live log of the run that plans again for an accepted overrule. */
export const PLANNED_LINE = (key: string): string => `overrule ${key} planned again`;

/** The keys named by PLANNED_LINE lines. */
export function plannedKeys(logLines: readonly string[]): Set<string> {
  const keys = new Set<string>();
  for (const l of logLines) {
    const m = /^overrule (\S+) planned again$/.exec(l.trim());
    if (m) keys.add(m[1]!);
  }
  return keys;
}

const ACK_KEY = /^<!-- claude-factory overrule=([\w-]+) -->$/;
const ACCEPTED_TEXT = "**Overrule accepted**";

/** The overrules the Foundry accepted (a verified ack is on the issue) whose run was not planned again yet, rebuilt from the comments. */
export function ackedNotPlanned(comments: readonly Comment[], planned: ReadonlySet<string>): Overrule[] {
  const out: Overrule[] = [];
  const seen = new Set<string>();
  for (const ack of comments) {
    if (!isFoundryComment(ack) || !isOverruleReply(ack)) continue;
    // A rejection note carries the same marker: only the acceptance text makes it an ack (a follow-up reply has another marker).
    if (!ack.body.includes(ACCEPTED_TEXT)) continue;
    const key = ACK_KEY.exec(lastLine(ack.body) ?? "")?.[1];
    if (!key || planned.has(key) || seen.has(key)) continue;
    const at = comments.findIndex((c) => !isFoundryComment(c) && overruleKey(c) === key);
    if (at < 0) continue;
    const original = comments[at]!;
    const parsed = parseOverrule(original.body);
    if (parsed === undefined || parsed === "malformed") continue;
    let decided: Comment | undefined;
    for (const c of comments.slice(0, at)) if (isFoundryComment(c) && !isOverruleReply(c) && hasDecidedHeading(c.body)) decided = c;
    if (!decided || !decidedItems(decided.body).has(parsed.q)) continue;
    seen.add(key);
    out.push({ key, comment: original, q: parsed.q, answer: parsed.answer, kind: "ok", decided });
  }
  return out;
}
