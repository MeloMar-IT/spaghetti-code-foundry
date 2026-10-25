/**
 * "This story waits for #N": decide whether the request is valid and record it safely in the issue body.
 * Pure and synchronous. All GitHub access goes through an injected GhCall (argument arrays, body on stdin, no shell).
 */
import {
  cleanReason, dependencies, foundryDependsOn, mergeDependsOn, removeFromDependsOn, titleIndex, withoutFoundryPart,
  type TitleIndex,
} from "./deps.js";

/** Runs gh with these arguments (and the text on stdin) and returns its output. It throws when gh fails; the error's `stderr`, or its `message`, carries gh's text. */
export type GhCall = (args: string[], input?: string) => string;

export interface WaitIssue { number: number; title: string; state: string; body: string }
export interface WaitsForRequest { issues: number[]; reason: string; error?: string }
export interface Landed { issue: number; commit: string }
export interface WaitsForJudgement { wait: number[]; already: Landed[]; problems: string[] }
export interface WaitsForResult { outcome: "recorded" | "unchanged" | "problem"; wait: number[]; already: Landed[]; problems: string[] }
export interface Commit { sha: string; message: string }
export interface IssueLookup {
  /** The issues known so far (the list, plus issues viewed since): their titles feed dependencies(). */
  readonly all: readonly WaitIssue[];
  /** Known without a gh call? */
  has(n: number): boolean;
  /** The list entry or a remembered view, else one `issue view`. undefined: the issue does not exist. */
  get(n: number): WaitIssue | undefined;
  /** Always a new `issue view`; not remembered. */
  fresh(n: number): WaitIssue | undefined;
}

const MAX_ISSUES = 10;
const MAX_VIEWS = 50;
const MAX_NODES = 500;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REF = /(?<![\w/#$`\\])#(\d{1,9})(?![\w#$`(\\{])/g;

/** The request in a text: the last WAITS_FOR: line wins. undefined without such a line. */
export function parseWaitsFor(text: string): WaitsForRequest | undefined {
  const lines = (text ?? "").split(/\r?\n/);
  const last = (re: RegExp) => { for (let i = lines.length - 1; i >= 0; i--) { const m = re.exec(lines[i]!); if (m) return m[1]!; } return undefined; };
  const line = last(/^\s*WAITS_FOR:(.*)$/);
  if (line === undefined) return undefined;
  const found = new Set<number>();
  for (const m of line.matchAll(REF)) { const n = Number(m[1]); if (n > 0) found.add(n); }
  const issues = [...found].sort((a, b) => a - b);
  const reason = (last(/^\s*WAITS_FOR_REASON:(.*)$/) ?? "").trim().slice(0, 500);
  if (!issues.length) return { issues, reason, error: "WAITS_FOR names no issue number." };
  if (issues.length > MAX_ISSUES) return { issues, reason, error: `WAITS_FOR names more than ${MAX_ISSUES} issues.` };
  return { issues, reason };
}

/** The sha of the first commit whose message says Resolve, Merge, Fix(es) or Close(s) "#N". A bare #N or owner/repo#N does not count. */
export function landedCommit(issue: number, commits: readonly Commit[]): string | undefined {
  const re = new RegExp(String.raw`\b(?:resolve[sd]?|merge[sd]?|fix(?:e[sd])?|close[sd]?)\b[ \t]*:?[ \t]+#${issue}(?![\w])`, "i");
  return commits.find((c) => re.test(c.message))?.sha;
}

const errText = (e: unknown): string => {
  const o = e as { stderr?: unknown; message?: unknown } | undefined;
  const s = typeof o?.stderr === "string" && o.stderr.trim() ? o.stderr : typeof o?.message === "string" ? o.message : String(e);
  return s.trim().split(/\r?\n/)[0]!.slice(0, 200);
};
const isNotFound = (e: unknown) => {
  const o = e as { stderr?: unknown; message?: unknown } | undefined;
  return /Could not resolve to an Issue|Not Found|HTTP 404/i.test(`${typeof o?.stderr === "string" ? o.stderr : ""}\n${typeof o?.message === "string" ? o.message : ""}`);
};

function toIssue(x: unknown): WaitIssue | undefined {
  const o = x as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || !Number.isInteger(o.number) || (o.number as number) <= 0 || typeof o.title !== "string") return undefined;
  return { number: o.number as number, title: o.title, state: typeof o.state === "string" ? o.state.toUpperCase() : "OPEN", body: typeof o.body === "string" ? o.body : "" };
}

/** One `issue view`. undefined only for a confirmed not-found; a malformed answer or another gh error throws. */
function viewIssue(gh: GhCall, repo: string, n: number): WaitIssue | undefined {
  let out: string;
  try { out = gh(["issue", "view", String(n), "--repo", repo, "--json", "number,title,state,body"]); }
  catch (e) { if (isNotFound(e)) return undefined; throw e; }
  let issue: WaitIssue | undefined;
  try { issue = toIssue(JSON.parse(out)); } catch { issue = undefined; }
  if (!issue || issue.number !== n) throw new Error(`Unexpected answer from gh for #${n}.`);
  return issue;
}

function makeLookup(gh: GhCall, repo: string, listed: readonly WaitIssue[], viewOnly: boolean): IssueLookup {
  const byNumber = new Map(listed.map((i) => [i.number, i] as const));
  const viewed = new Map<number, WaitIssue | undefined>();
  let cache: WaitIssue[] | undefined;
  return {
    get all() {
      if (!cache) {
        const m = new Map(byNumber);
        for (const [n, i] of viewed) if (i) m.set(n, i);
        cache = [...m.values()];
      }
      return cache;
    },
    has: (n) => viewed.has(n) || (!viewOnly && byNumber.has(n)),
    get(n) {
      if (viewed.has(n)) return viewed.get(n);
      if (!viewOnly && byNumber.has(n)) return byNumber.get(n);
      const i = viewIssue(gh, repo, n);
      viewed.set(n, i);
      cache = undefined;
      return i;
    },
    fresh: (n) => viewIssue(gh, repo, n),
  };
}

/** One `issue list` call now; issues missing from it are viewed on demand (and remembered). */
export function issueLookup(gh: GhCall, repo: string): IssueLookup {
  if (!REPO.test(repo)) throw new Error(`Not a repository name: ${repo}`);
  const out = gh(["issue", "list", "--repo", repo, "--state", "all", "--limit", "500", "--json", "number,title,state,body"]);
  const parsed: unknown = JSON.parse(out);
  if (!Array.isArray(parsed)) throw new Error("Unexpected answer from gh for the issue list.");
  return makeLookup(gh, repo, parsed.map(toIssue).filter((i): i is WaitIssue => !!i), false);
}

/** Does the wanted issue reach `self` through dependencies()? Closed issues block nothing and are not followed. Hitting a limit is `incomplete`, never a pass. */
export function findCycle(
  self: WaitIssue, from: readonly number[], lookup: IssueLookup, limits = { views: MAX_VIEWS, nodes: MAX_NODES },
): { cycle?: number[]; incomplete?: "views" | "nodes" } {
  const parent = new Map<number, number>();
  const queue: number[] = [];
  for (const w of from) if (!parent.has(w)) { parent.set(w, 0); queue.push(w); }
  const chain = (n: number) => { const c: number[] = []; for (let x = n; x; x = parent.get(x)!) c.unshift(x); return c; };
  let views = 0;
  let seen: readonly WaitIssue[] | undefined;
  let all: WaitIssue[] = [];
  let titles: TitleIndex = [];
  for (let i = 0; i < queue.length; i++) {
    const n = queue[i]!;
    if (n === self.number) return { cycle: [self.number, self.number] };
    if (!lookup.has(n) && ++views > limits.views) return { incomplete: "views" };
    const issue = lookup.get(n);
    if (!issue || issue.state.toUpperCase() !== "OPEN") continue;
    if (lookup.all !== seen) {
      seen = lookup.all;
      all = [...seen.filter((x) => x.number !== self.number), self];
      titles = titleIndex(all);
    }
    for (const d of dependencies(issue.body, n, all, titles)) {
      if (d === self.number) return { cycle: [self.number, ...chain(n), self.number] };
      if (parent.has(d)) continue;
      if (parent.size >= limits.nodes) return { incomplete: "nodes" };
      parent.set(d, n);
      queue.push(d);
    }
  }
  return {};
}

const hash = (ns: readonly number[]) => ns.map((n) => "#" + n).join(", ");
const loopText = (path: readonly number[]) => `Waiting for #${path[1]} would make a loop: ${path.map((n) => "#" + n).join(" → ")}.`;
const limitText = (w: "views" | "nodes") =>
  `Could not finish the cycle check: it needed more than ${w === "views" ? `${MAX_VIEWS} extra issue views` : `${MAX_NODES} issues`}.`;

/** Is "self waits for these" valid? Lists what to wait for, what already landed, and every problem. */
export function judgeWaitsFor(self: WaitIssue, request: WaitsForRequest, lookup: IssueLookup, commits: readonly Commit[]): WaitsForJudgement {
  const out: WaitsForJudgement = { wait: [], already: [], problems: [] };
  if (request.error) { out.problems.push(request.error); return out; }
  const own = foundryDependsOn(self.body);
  for (const n of [...request.issues].sort((a, b) => a - b)) {
    if (n === self.number) { out.problems.push(`#${n} is this issue itself.`); continue; }
    if (own.includes(n)) { out.problems.push(`#${n} is already waited for: this issue waited for it before.`); continue; }
    let issue: WaitIssue | undefined;
    try { issue = lookup.get(n); } catch (e) { out.problems.push(`#${n} could not be read: ${errText(e)}`); continue; }
    if (!issue) { out.problems.push(`#${n} was not found in this repository.`); continue; }
    const sha = landedCommit(n, commits);
    if (issue.state.toUpperCase() !== "OPEN") {
      if (sha) out.already.push({ issue: n, commit: sha });
      else out.problems.push(`#${n} is closed, but no commit for it landed.`);
    } else if (sha) out.problems.push(`#${n} is still open, but its work already landed (commit ${sha.slice(0, 7)}).`);
    else out.wait.push(n);
  }
  if (out.problems.length) return out;
  if (!out.wait.length) {
    out.problems.push(`Nothing left to wait for: ${out.already.map((a) => `#${a.issue} (commit ${a.commit.slice(0, 7)})`).join(", ")} already landed.`);
    return out;
  }
  try {
    const r = findCycle(self, out.wait, lookup);
    if (r.cycle) out.problems.push(loopText(r.cycle));
    else if (r.incomplete) out.problems.push(limitText(r.incomplete));
  } catch (e) {
    out.problems.push(`Could not finish the cycle check: ${errText(e)}`);
  }
  return out;
}

const person = (b: string) => withoutFoundryPart(b).trimEnd();

/** Set by writeSafely before every edit, so a failure later still knows that a write may have happened. */
interface WriteState { wrote: boolean }

/**
 * Reads the body fresh, writes `change(body)` once (body on stdin), reads again and checks it. On a mismatch the change is
 * made again on what was read, once. ok: `done(body)` holds; wrote: whether an edit was made.
 */
function writeSafely(
  gh: GhCall, repo: string, n: number, change: (body: string) => string, done: (body: string) => boolean, state: WriteState,
): { ok: boolean; body: string } {
  const first = viewIssue(gh, repo, n);
  if (!first) throw new Error(`#${n} was not found.`);
  // Already in place before any write: no edit, and the person's text is not compared.
  if (done(first.body)) return { ok: true, body: first.body };
  let cur = first.body;
  for (let attempt = 0; attempt < 2; attempt++) {
    const next = change(cur);
    state.wrote = true;
    gh(["issue", "edit", String(n), "--repo", repo, "--body-file", "-"], next);
    const after = viewIssue(gh, repo, n);
    if (!after) throw new Error(`#${n} was not found.`);
    if (done(after.body) && person(after.body) === person(next)) return { ok: true, body: after.body };
    cur = after.body;
  }
  return { ok: false, body: cur };
}

/** Takes numbers this call added back out, the safe way. Returns the problem text when that is not verified. */
function undoAdded(gh: GhCall, repo: string, self: number, gone: readonly number[]): string | undefined {
  if (!gone.length) return undefined;
  try {
    const u = writeSafely(gh, repo, self, (b) => removeFromDependsOn(b, gone),
      (b) => { const have = foundryDependsOn(b); return gone.every((n) => !have.includes(n)); }, { wrote: false });
    if (u.ok) return undefined;
  } catch {
    // reported below
  }
  return `Could not take ${hash(gone)} out of the issue again; please check its Depends on section.`;
}

/** Judges the request, then records it in the issue's Foundry part, checks it, and undoes it if it made a cycle. */
export function recordWaitsFor(gh: GhCall, repo: string, self: number, request: WaitsForRequest, commits: readonly Commit[]): WaitsForResult {
  const res = (outcome: WaitsForResult["outcome"], j: { wait: number[]; already: Landed[] }, problems: string[]): WaitsForResult =>
    ({ outcome, wait: j.wait, already: j.already, problems });
  let judged: WaitsForJudgement = { wait: [], already: [], problems: [] };
  const state: WriteState = { wrote: false };
  const added = new Set<number>();
  try {
    const lookup = issueLookup(gh, repo);
    const me = lookup.get(self);
    if (!me) return res("problem", judged, [`#${self} was not found.`]);
    judged = judgeWaitsFor(me, request, lookup, commits);
    if (judged.problems.length) return res("problem", judged, judged.problems);
    const wait = judged.wait;
    // Numbers this call adds, relative to the fresh body before our first write. Retries add nothing.
    const gone = () => [...added].sort((a, b) => a - b);
    const w = writeSafely(gh, repo, self, (b) => {
      if (!state.wrote) { const have = foundryDependsOn(b); for (const n of wait) if (!have.includes(n)) added.add(n); }
      return mergeDependsOn(b, wait, request.reason);
    }, (b) => { const have = foundryDependsOn(b); return wait.every((n) => have.includes(n)); }, state);
    if (!w.ok) {
      const problems = ["The issue changed while it was being updated."];
      const undo = undoAdded(gh, repo, self, gone());
      if (undo) problems.push(undo);
      return res("problem", judged, problems);
    }
    if (!state.wrote) return res("unchanged", judged, []);

    let problem: string;
    try {
      const r = findCycle({ ...me, body: w.body }, wait, makeLookup(gh, repo, lookup.all, true));
      if (!r.cycle && !r.incomplete) return res("recorded", judged, []);
      problem = r.cycle ? loopText(r.cycle) : limitText(r.incomplete!);
    } catch (e) {
      problem = `Could not finish the cycle check: ${errText(e)}`;
    }
    const problems = [problem];
    const undo = undoAdded(gh, repo, self, gone());
    if (undo) problems.push(undo);
    return res("problem", judged, problems);
  } catch (e) {
    // A failure after an edit (for example a failed read-back) still undoes what this call wrote.
    const problems = [`Could not read or update the issue on GitHub: ${errText(e)}`];
    if (state.wrote) {
      const undo = undoAdded(gh, repo, self, [...added].sort((a, b) => a - b));
      if (undo) problems.push(undo);
    }
    return res("problem", judged, problems);
  }
}

/** Plain text for the person: why the Foundry could not make #self wait. */
export function waitsForQuestion(self: number, request: WaitsForRequest, problems: readonly string[]): string {
  const reason = cleanReason(request.reason);
  return [
    `The Foundry wanted #${self} to wait for ${hash(request.issues)}, but this is not possible:`,
    ...problems.map((p) => `- ${p}`),
    ...(reason ? [`Reason given: ${reason}`] : []),
    `What should happen? Answer here, or name the issue to wait for in the "Depends on" section.`,
  ].join("\n");
}
