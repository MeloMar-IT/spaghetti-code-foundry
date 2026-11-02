// A red base branch: found once from the stopped runs, fixed by one story, and the other stories wait for a new commit.
// The state is kept by the server in <data>/red-base.json (see docs/DESIGN.md). Pure decisions first, then the check.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { githubKey } from "./auth/repo-url.js";
import { redactText } from "./credentials/redact.js";
import type { RunSummary } from "./engine/state.js";
import { isBaselineStop, safeSentence } from "./failure.js";
import { gh, type RestIssue } from "./github.js";
import type { NextData } from "./next-step.js";
import { validCommit } from "./release/build-claims.js";
import type { StoryStore } from "./stories/store.js";

export const NO_STORY_HOTFIX = "The trigger label is a hotfix label, so a fix story would skip the base branch. Fix the failing tests by hand, or list them in a story.";
export const NO_STORY_AUTONOMY = "The autonomy level of this flow does not let a story push, so no fix story is made. Fix the failing tests by hand, or raise the level.";
const PROBLEM_UNUSABLE = "A failing test name cannot be published safely, so no fix story is made. Fix the failing tests by hand, or list them in a story.";
const PROBLEM_SEARCH = "The Foundry could not check whether a fix story already exists, so it makes none. It tries again at the next check.";
const PROBLEM_CREATE = "The fix story could not be created. The Foundry tries again at the next check.";
const PROBLEM_FIX_GONE = "The fix story was closed and the tests still fail. Fix the failing tests by hand, or open a story that lists them.";
const PROBLEM_FIX_LABEL = "The fix story cannot start (its trigger label is missing, or it has an excluded label). Fix its labels, or fix the tests by hand.";

export interface BaseStop { runId: string; issue: number; branch: string; commit: string; clean: boolean; gate?: true; at: string; failing: string[]; assertions: { test: string; message: string }[] }
export interface BaseGreen { branch: string; commit: string; at: string }
export interface RedFix { issue: number; url?: string; tests: string[]; commit: string; label: string }
export interface RedState {
  branch: string; commit: string; failing: string[]; assertions: BaseStop["assertions"]; since: string; held: boolean;
  cleared?: string; moved?: true; prior?: { commit: string; failing: string[] }[]; fix?: RedFix; problem?: string;
  pending?: { marker: string; at: string; label: string };
}
export interface RedResult { state: RedState; held: boolean; made?: RestIssue }
export interface RedCheck {
  repo: string; branch: string; label: string; file: string;
  stops: BaseStop[];
  listed: Map<number, string[]>;
  greens: () => BaseGreen[];
  head: () => Promise<string>;
  commits: (from: string, to: string) => Promise<{ lines: string[]; total: number }>;
  store: Pick<StoryStore, "create" | "get" | "listAll">;
  noStory: () => string | undefined;
  alive: () => void; log: (msg: string) => void; now?: () => string;
  eligible: (labels: string[]) => boolean;
}

const MAX_PRIOR = 5;
const MAX_ENV = 64_000;
const MAX_STOP_FILE = 5 * 1024 * 1024;

// ---- the state file

export const redFile = (runsDir: string): string => join(dirname(runsDir), "red-base.json");

interface RedFile { version: 1; repos: Record<string, Record<string, RedState>> }
function readFile(file: string): RedFile {
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as RedFile;
    if (j && j.version === 1 && j.repos && typeof j.repos === "object") return j;
  } catch {
    // a missing or broken file is no state
  }
  return { version: 1, repos: {} };
}

/** The stored state of one repository and branch; never throws. */
export function readRed(file: string, repo: string, branch: string): RedState | undefined {
  const s = readFile(file).repos[githubKey(repo)]?.[branch];
  return s && typeof s === "object" && typeof s.commit === "string" && Array.isArray(s.failing) ? s : undefined;
}

/** Reads, changes and renames in one synchronous block, so two repositories cannot lose each other's update. */
export function writeRed(file: string, repo: string, branch: string, s: RedState): void {
  const f = readFile(file);
  const key = githubKey(repo);
  (f.repos[key] ??= {})[branch] = s;
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(f), { mode: 0o600 });
  renameSync(tmp, file);
}

// ---- reading runs

const isText = (x: unknown): x is string => typeof x === "string";
const isTime = (x: unknown): x is string => isText(x) && !Number.isNaN(Date.parse(x));

/** The stop file of a run that stopped at the baseline; undefined when there is none or it is not well formed. */
export function readBaseStop(run: RunSummary): BaseStop | undefined {
  if (run.status !== "failed" || !isBaselineStop(run.history)) return undefined;
  const issue = Number(run.vars?.issue);
  if (!Number.isInteger(issue) || issue <= 0) return undefined;
  try {
    const file = join(run.runDir, "baseline-stop.json");
    if (!existsSync(file) || statSync(file).size > MAX_STOP_FILE) return undefined;
    const j = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (j.version !== 1 || !isText(j.branch) || !validCommit(j.commit) || typeof j.clean !== "boolean" || !isTime(j.at)) return undefined;
    if (!Array.isArray(j.failing) || !j.failing.length || !j.failing.every(isText)) return undefined;
    const assertions = Array.isArray(j.assertions)
      ? (j.assertions as unknown[]).filter((a): a is { test: string; message: string } => !!a && isText((a as { test?: unknown }).test) && isText((a as { message?: unknown }).message)).slice(0, 10)
      : [];
    return { runId: run.runId, issue, branch: j.branch, commit: j.commit, clean: j.clean, ...(j.gate === true ? { gate: true as const } : {}), at: j.at, failing: j.failing as string[], assertions };
  } catch {
    return undefined;
  }
}

/** A green baseline of a clean tree: the last output line of the last good baseline_tests step. */
export function greenOf(run: RunSummary, branch: string): BaseGreen | undefined {
  const rec = [...(run.history ?? [])].reverse().find((r) => r.id.split("/").at(-1) === "baseline_tests" && r.ok);
  const last = (rec?.output ?? "").trimEnd().split("\n").at(-1) ?? "";
  const m = /^BASE_GREEN: (\S+) ([0-9a-f]{7,64}) (\S+)$/i.exec(last);
  if (!m || m[1] !== branch || !validCommit(m[2]) || !isTime(m[3])) return undefined;
  return { branch, commit: m[2], at: m[3] };
}

/** The issue text a run read (issue-body.md in its folder); "" when unreadable. */
export function runBody(run: RunSummary): string {
  try {
    return readFileSync(join(run.runDir, "issue-body.md"), "utf8");
  } catch {
    return "";
  }
}

export const labelNames = (issue: Pick<RestIssue, "labels">): string[] =>
  (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l.name ?? "")).filter(Boolean);

// ---- test names

/** The tests a story names under "Failing tests to fix" (the same rules as tools/baseline-tests). */
export function namedTests(body: string): string[] {
  const lines = String(body ?? "").replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex((l) => /^#{1,6}\s*failing tests to fix\s*:?\s*$/i.test(l.trim()));
  if (start < 0) return [];
  const names: string[] = [];
  for (const raw of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(raw)) break;
    let l = raw.trim();
    if (!l || l.startsWith("```") || l.startsWith("<!--")) continue;
    l = l.replace(/^(?:[-*+]|\d+[.)])\s+/, "").trim().replace(/^`+|`+$/g, "").trim();
    if (!l || l.length > 300 || names.includes(l)) continue;
    names.push(l);
    if (names.length >= 100) break;
  }
  return names;
}
export const covers = (entry: string, test: string): boolean => test === entry || test.startsWith(`${entry}.`);
export function namesAll(body: string, failing: string[]): boolean {
  const names = namedTests(body);
  return failing.length > 0 && failing.every((t) => names.some((n) => covers(n, t)));
}

const sameList = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
const inside = (list: string[], set: string[]) => list.every((t) => set.includes(t));

// ---- decisions

export function judgeStops(stops: BaseStop[], commit: string): Pick<BaseStop, "branch" | "commit" | "failing" | "assertions"> | undefined {
  const on = stops.filter((s) => s.commit === commit && !s.gate);
  const pick = (s: BaseStop) => ({ branch: s.branch, commit: s.commit, failing: s.failing, assertions: s.assertions });
  const clean = on.find((s) => s.clean);
  if (clean) return pick(clean);
  for (const a of on) if (on.some((b) => b.issue !== a.issue && sameList(a.failing, b.failing))) return pick(a);
  return undefined;
}

export function stoppedOnRed(s: RedState, stop: BaseStop | undefined): boolean {
  if (!stop || stop.branch !== s.branch) return false;
  if (stop.commit === s.commit) {
    if (s.cleared && !s.moved && stop.at > s.cleared) return false;
    return inside(stop.failing, s.failing);
  }
  const p = s.prior?.find((x) => x.commit === stop.commit);
  return !!p && inside(stop.failing, p.failing);
}

/** Stops that the stored state does not already cover; only these make a head read when nothing is held. */
export function newEvidence(cur: RedState | undefined, stops: BaseStop[]): BaseStop[] {
  if (cur?.cleared && cur.moved) return stops.filter((s) => !stoppedOnRed(cur, s));
  return stops;
}

export function advance(cur: RedState | undefined, o: { stops: BaseStop[]; head: string; greens: BaseGreen[]; now: string }): { state?: RedState; held: boolean } {
  const live = cur && !cur.cleared ? cur : undefined;
  const green = o.greens.filter((g) => g.commit === o.head && (!live || live.commit !== o.head || g.at > live.since)).sort((a, b) => (a.at < b.at ? 1 : -1))[0];
  if (live && green) return { state: { ...live, cleared: green.at, held: false, ...(live.commit !== o.head ? { moved: true as const } : {}) }, held: false };
  const stops = o.stops.filter((s) => {
    if (o.greens.some((g) => g.commit === s.commit && s.at <= g.at)) return false;
    if (cur?.cleared && !cur.moved && cur.commit === s.commit && s.at <= cur.cleared) return false;
    return true;
  });
  if (live && live.commit === o.head) return { state: live, held: true };
  const red = judgeStops(stops, o.head);
  if (red) {
    const prior = cur && cur.commit !== o.head ? [{ commit: cur.commit, failing: cur.failing }, ...(cur.prior ?? [])].slice(0, MAX_PRIOR) : cur?.prior;
    const fix = cur?.fix && red.failing.every((t) => cur.fix!.tests.some((n) => covers(n, t))) ? cur.fix : undefined;
    return { state: { branch: red.branch, commit: red.commit, failing: red.failing, assertions: red.assertions, since: o.now, held: true, ...(prior?.length ? { prior } : {}), ...(fix ? { fix } : {}) }, held: true };
  }
  if (live) return { state: { ...live, cleared: o.now, moved: true, held: false }, held: false };
  return { state: cur, held: false };
}

export function storyHeld(s: Pick<RedState, "failing" | "fix">, issue: { number: number; body?: string }, hotfix: boolean): boolean {
  if (hotfix || s.fix?.issue === issue.number) return false;
  return !namesAll(issue.body ?? "", s.failing);
}

// ---- words (every test name goes through redactText first)

const shown = (name: string) => safeSentence(redactText(name), 200);
export function redLine(s: Pick<RedState, "branch" | "failing">): string {
  const names = s.failing.slice(0, 3).map(shown);
  const rest = s.failing.length - names.length;
  return `${safeSentence(redactText(s.branch), 100)} has failing tests: ${names.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}`;
}

export function redBaseFacts(s: RedState): NonNullable<NextData["redBase"]> {
  return {
    branch: safeSentence(redactText(s.branch), 100), line: redLine(s),
    ...(s.fix ? { fix: { issue: s.fix.issue, ...(s.fix.url ? { url: s.fix.url } : {}) } } : {}),
    ...(s.problem ? { problem: s.problem } : {}),
  };
}

export function redComment(runId: string, s: RedState): string {
  return [
    `This story waits: the base branch is red. ${redLine(s)}.`,
    ...(s.fix ? [`A fix story is open: #${s.fix.issue}.`] : []),
    "It starts by itself when a new commit lands on the base branch.",
    `<!-- claude-factory run=${runId} -->`,
  ].join("\n\n");
}

export function redBaseEnv(runsDir: string, vars: Record<string, string | undefined>): Record<string, string> {
  try {
    const repo = vars.github_repo;
    const branch = vars.develop_branch;
    if (!repo || !branch) return {};
    const s = readRed(redFile(runsDir), repo, branch);
    if (!s || !s.held || s.cleared) return {};
    const make = (failing: string[]) => JSON.stringify({ branch: s.branch, commit: s.commit, fix: s.fix?.issue, failing });
    let failing = s.failing;
    while (failing.length && make(failing).length > MAX_ENV) failing = failing.slice(0, Math.floor(failing.length / 2));
    return { FACTORY_RED_BASE: make(failing) };
  } catch {
    return {};
  }
}

// ---- the fix story

const text = (t: string) => safeSentence(redactText(t), 500);
export const markerOf = (repo: string, branch: string, commit: string): string =>
  `<!-- claude-factory red-base=${createHash("sha256").update(`${githubKey(repo)}|${branch}|${commit}`).digest("hex").slice(0, 24)} -->`;

export function fixStory(o: { repo: string; state: RedState; commits?: { lines: string[]; total: number }; lastGreen?: string }): { title: string; body: string; marker: string } | { unusable: string } {
  const { state: s } = o;
  const bad = s.failing.find((t) => redactText(t) !== t || t.includes("<!--") || /depends\s+on|blocked\s+by/i.test(t) || /[\r\n]/.test(t));
  if (bad !== undefined) return { unusable: PROBLEM_UNUSABLE };
  const marker = markerOf(o.repo, s.branch, s.commit);
  const commitSection = o.lastGreen === undefined && !o.commits
    ? "No earlier green baseline is known."
    : !o.commits
      ? "The commits could not be read."
      : ["```text", ...o.commits.lines.map((l) => `- ${text(l)}`), ...(o.commits.total > o.commits.lines.length ? [`… and ${o.commits.total - o.commits.lines.length} more`] : []), "```"].join("\n");
  const asserts = s.assertions.length
    ? ["```text", ...s.assertions.map((a) => `- ${text(a.test)}: ${text(a.message)}`), "```"].join("\n")
    : "No assertion messages were recorded.";
  const body = [
    `The tests on \`${safeSentence(redactText(s.branch), 100)}\` fail, and the Foundry found this by itself. Other stories wait until it is fixed. Make the failing tests pass without deleting or weakening them.`,
    "", "## Failing tests to fix", "", ...s.failing.map((t) => `- \`${t}\``),
    "", "## Base commit", "", `\`${s.commit}\``,
    "", "## Commits since the last green baseline", "", commitSection,
    "", "## Failing assertions", "", asserts,
    "", marker,
  ].join("\n");
  if (!namesAll(body, s.failing)) return { unusable: PROBLEM_UNUSABLE };
  return { title: `Fix the failing tests on ${safeSentence(redactText(s.branch), 100)} (${s.commit.slice(0, 7)})`, body, marker };
}

export async function readCommits(repo: string, from: string, to: string, timeoutMs: number): Promise<{ lines: string[]; total: number }> {
  if (!validCommit(from) || !validCommit(to)) throw new Error("not a commit id");
  const j = JSON.parse(await gh(["api", `repos/${repo}/compare/${from}...${to}`], undefined, timeoutMs)) as { commits?: { commit?: { message?: string } }[]; total_commits?: number };
  const lines = (j.commits ?? []).slice(0, 30).map((c) => (c.commit?.message ?? "").split("\n")[0] ?? "");
  return { lines, total: typeof j.total_commits === "number" ? j.total_commits : lines.length };
}

// ---- the check

function limit<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timer = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error("timed out")), ms); });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
}

/** Runs in one chain per repository and branch (see inOrder). Makes no GitHub call without new evidence or a live state. */
export async function checkRed(o: RedCheck): Promise<RedResult | undefined> {
  const now = o.now ?? (() => new Date().toISOString());
  o.alive();
  let cur = readRed(o.file, o.repo, o.branch);
  const live = !!cur && !cur.cleared;
  if (!live && !newEvidence(cur, o.stops).length) return cur ? { state: cur, held: false } : undefined;
  let head: string;
  try {
    head = await o.head();
  } catch (e) {
    o.alive();
    o.log(`! red base: cannot read the head of ${o.branch}: ${safeSentence(redactText(String((e as Error).message)), 200)}`);
    return cur ? { state: cur, held: cur.held && !cur.cleared } : undefined;
  }
  o.alive();
  const adv = advance(cur, { stops: o.stops, head, greens: o.greens(), now: now() });
  let state = adv.state;
  if (!state) return undefined;
  const save = (s: RedState) => { o.alive(); writeRed(o.file, o.repo, o.branch, s); state = s; };
  if (JSON.stringify(state) !== JSON.stringify(cur)) {
    save(state);
    o.log(adv.held ? `! red base: ${redLine(state)}` : `base branch ${o.branch} moved on, held stories start again`);
  }
  cur = state;
  let held = adv.held;
  let made: RestIssue | undefined;
  if (!held) {
    if (state.problem || state.pending) save({ ...state, problem: undefined, pending: undefined } as RedState);
    return { state, held: false };
  }
  const fix = state.fix;
  // Only the owner of the fix story decides its problem; another watcher keeps what is stored.
  let problem: string | undefined = fix && fix.label !== o.label ? state.problem : undefined;
  if (fix && fix.label === o.label) {
    let labels = o.listed.get(fix.issue);
    let open = !!labels;
    if (!labels) {
      let got: RestIssue | undefined;
      try {
        got = await limit(o.store.get(fix.issue, 20_000), 25_000);
      } catch {
        o.alive();
        got = undefined;
        return { state, held };
      }
      o.alive();
      open = got?.state === "open";
      labels = got ? labelNames(got) : [];
    }
    if (!open) {
      if (fix.commit === state.commit) problem = PROBLEM_FIX_GONE;
      else save({ ...state, fix: undefined });
    } else if (!o.eligible(labels)) problem = PROBLEM_FIX_LABEL;
  }
  if (!state.fix) {
    const no = o.noStory();
    if (no) problem = no;
    else {
      const r = await makeFix(o, state, save, now);
      problem = r.problem;
      made = r.made;
      state = r.state ?? state;
    }
  }
  if ((state.problem ?? undefined) !== problem) save({ ...state, ...(problem ? { problem } : { problem: undefined }) } as RedState);
  return { state, held, ...(made ? { made } : {}) };
}

async function makeFix(o: RedCheck, state: RedState, save: (s: RedState) => void, now: () => string): Promise<{ problem?: string; made?: RestIssue; state?: RedState }> {
  const greens = o.greens().filter((g) => g.commit !== state.commit && g.branch === state.branch).sort((a, b) => (a.at < b.at ? 1 : -1));
  let commits: { lines: string[]; total: number } | undefined;
  if (greens[0]) {
    try {
      commits = await limit(o.commits(greens[0].commit, state.commit), 25_000);
    } catch {
      commits = undefined;
    }
    o.alive();
  }
  const built = fixStory({ repo: o.repo, state, commits, lastGreen: greens[0]?.commit });
  if ("unusable" in built) return { problem: built.unusable };
  let issues: RestIssue[];
  let cut: boolean;
  try {
    ({ issues, cut } = await limit(o.store.listAll({ pages: 10, timeoutMs: 20_000 }), 25_000));
  } catch {
    o.alive();
    return { problem: PROBLEM_SEARCH };
  }
  o.alive();
  const found = issues.find((i) => !i.pull_request && (i.body ?? "").includes(built.marker));
  if (found) {
    const next: RedState = { ...state, fix: { issue: found.number, url: found.html_url, tests: state.failing, commit: state.commit, label: state.pending?.label ?? o.label }, pending: undefined };
    save(next);
    return { state: next };
  }
  const reached = !!state.pending && issues.some((i) => Date.parse(i.created_at) < Date.parse(state.pending!.at) - 3_600_000);
  if (state.pending && cut && !reached) return { problem: PROBLEM_SEARCH };
  const pend: RedState = { ...state, pending: { marker: built.marker, at: now(), label: o.label } };
  save(pend);
  let made: RestIssue;
  try {
    made = await limit(o.store.create({ title: built.title, body: built.body, labels: [o.label] }, 30_000), 35_000);
  } catch {
    o.alive();
    return { problem: PROBLEM_CREATE, state: pend };
  }
  o.alive();
  const next: RedState = { ...pend, fix: { issue: made.number, url: made.html_url, tests: state.failing, commit: state.commit, label: o.label }, pending: undefined };
  save(next);
  o.log(`created the fix story #${made.number} for the red base branch`);
  return { made, state: next };
}
