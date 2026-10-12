import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** One test that failed, or passed only on a retry, in one run. */
export interface Hit { run: string; issue: string; test: string; kind: "failed" | "retried"; cause: string }

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** Known causes that are about the machine, not about the code under test. */
const CAUSES: [RegExp, string][] = [
  [/EADDRINUSE/, "a network port was already in use"],
  [/Test timed out in \d+ms|Hook timed out/, "a test ran into its time limit"],
  [/ENOSPC|no space left/i, "the disk was full"],
  [/EMFILE|too many open files/i, "too many open files"],
  [/ECONNRESET|ECONNREFUSED|socket hang up/, "a connection was refused or dropped"],
];

/**
 * The failing and retried tests in one test log. Understands Vitest (" FAIL  file > suite > test",
 * "✓ test 12ms (retry x1)") and Gradle ("Class > test FAILED").
 */
export function parseTestLog(text: string, run: string, issue: string): Hit[] {
  const clean = strip(text);
  const cause = CAUSES.find(([re]) => re.test(clean))?.[1] ?? "";
  const hits = new Map<string, Hit>();
  const add = (test: string, kind: Hit["kind"]) => {
    const t = test.trim().slice(0, 200);
    if (t && !(kind === "retried" && hits.has(t))) hits.set(t, { run, issue, test: t, kind, cause: kind === "failed" ? cause : "" });
  };
  for (const line of clean.split("\n")) {
    const fail = /^\s*FAIL\s+(\S+\.(?:test|spec)\.\w+ > .+)$/.exec(line) ?? /^(\S+ > \S.*) FAILED$/.exec(line);
    if (fail) add(fail[1]!, "failed");
    const retried = /^\s*✓\s+(.+?)\s+\d+ms \(retry x\d+\)$/.exec(line);
    if (retried) add(retried[1]!, "retried");
  }
  return [...hits.values()];
}

export interface Suspect {
  test: string;
  /** Different stories in which it failed, and in which it passed only on a retry. */
  failedIn: string[];
  retriedIn: string[];
  cause: string;
}

/** A test is suspect when it failed or needed a retry in this many different stories: one story can break its own test, several cannot. */
export const MIN_STORIES = 3;

export function suspects(hits: Hit[]): Suspect[] {
  const by = new Map<string, Suspect>();
  for (const h of hits) {
    const s = by.get(h.test) ?? { test: h.test, failedIn: [], retriedIn: [], cause: "" };
    const list = h.kind === "failed" ? s.failedIn : s.retriedIn;
    if (!list.includes(h.issue)) list.push(h.issue);
    if (h.cause && !s.cause) s.cause = h.cause;
    by.set(h.test, s);
  }
  const stories = (s: Suspect) => new Set([...s.failedIn, ...s.retriedIn]).size;
  return [...by.values()].filter((s) => stories(s) >= MIN_STORIES).sort((a, b) => b.failedIn.length - a.failedIn.length || stories(b) - stories(a));
}

/** The test logs of the runs that changed in the last `days`, as hits. The story is the run's issue, or the run itself. */
export function collectHits(runsDir: string, now: Date, days = 7): { hits: Hit[]; logs: number } {
  const hits: Hit[] = [];
  let logs = 0;
  if (!existsSync(runsDir)) return { hits, logs };
  for (const run of readdirSync(runsDir)) {
    const log = join(runsDir, run, "tests.log");
    try {
      if (now.getTime() - statSync(log).mtimeMs > days * 86_400_000) continue;
      const summary = JSON.parse(readFileSync(join(runsDir, run, "run.json"), "utf8")) as { vars?: Record<string, string> };
      const issue = summary.vars?.issue ? `${summary.vars.github_repo ?? ""}#${summary.vars.issue}` : run;
      hits.push(...parseTestLog(readFileSync(log, "utf8"), run, issue));
      logs++;
    } catch {
      // no test log, or a run being written
    }
  }
  return { hits, logs };
}

export function flakyReport(list: Suspect[], logs: number, days: number, filed: Record<string, string> = {}): string {
  const out = ["# Unreliable tests", "", `From ${logs} test logs of the last ${days} days. A test is listed when it failed, or passed only on a retry, in at least ${MIN_STORIES} different stories.`, ""];
  if (!list.length) return [...out, "None found.", ""].join("\n");
  out.push("| Test | Failed in | Passed on a retry in | Likely cause | Story |", "|---|---|---|---|---|");
  for (const s of list) out.push(`| ${s.test.replace(/\|/g, "/")} | ${s.failedIn.length} | ${s.retriedIn.length} | ${s.cause || "–"} | ${filed[groupOf(s)] ?? "–"} |`);
  return [...out, ""].join("\n");
}

/** Tests are filed per test file: one cause usually breaks a whole file. */
export const groupOf = (s: Suspect) => s.test.split(" > ")[0]!;

export interface Story { key: string; title: string; body: string }

/** One bug story per test file, the worst files first, leaving out what was filed before. */
export function stories(list: Suspect[], filed: Record<string, string>, max = 2): Story[] {
  const groups = new Map<string, Suspect[]>();
  for (const s of list.filter((s) => s.failedIn.length >= MIN_STORIES)) groups.set(groupOf(s), [...(groups.get(groupOf(s)) ?? []), s]);
  return [...groups.entries()].filter(([key]) => !filed[key]).slice(0, max).map(([key, tests]) => {
    const cause = tests.find((t) => t.cause)?.cause;
    return {
      key,
      title: `Unreliable tests in ${key}`,
      body: [
        "## What goes wrong", "",
        `Tests in \`${key}\` failed in several unrelated stories in the last days, so the cause is in the test or in how test runs share the machine, not in those stories.`, "",
        ...(cause ? [`Likely cause, from the test logs: ${cause}.`, ""] : []),
        "| Test | Failed in stories | Passed only on a retry in |", "|---|---|---|",
        ...tests.map((t) => `| ${t.test.replace(/\|/g, "/")} | ${t.failedIn.length} | ${t.retriedIn.length} |`), "",
        "## Wanted", "",
        "- Find why these tests fail when the code under test is right, and remove that cause (a shared port, a fixed wait, a time limit that is too tight on a busy machine, state shared between tests).",
        "- Do not hide it with more retries or longer waits alone.", "",
        "## Acceptance criteria", "",
        "- [ ] The cause is named in the pull request.",
        "- [ ] The tests pass 20 times in a row while another full test run works on the same machine.",
        "- [ ] No behaviour of the product changes.", "",
        "Found by `scf flaky`.",
      ].join("\n"),
    };
  });
}
