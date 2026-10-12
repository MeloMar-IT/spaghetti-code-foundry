import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** One test that failed, or passed only on a retry, in one run. `repo` is the GitHub name of the repository, "" when unknown. */
export interface Hit { run: string; issue: string; repo: string; test: string; kind: "failed" | "retried"; cause: string }

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** Known causes that are about the machine, not about the code under test. */
const CAUSES: [RegExp, string][] = [
  [/EADDRINUSE/, "a network port was already in use"],
  [/Test timed out in \d+ms|Hook timed out/, "a test ran into its time limit"],
  [/ENOSPC|no space left/i, "the disk was full"],
  [/EMFILE|too many open files/i, "too many open files"],
  [/ECONNRESET|ECONNREFUSED|socket hang up/, "a connection was refused or dropped"],
];

const TEST_FILE = String.raw`\S+\.(?:test|spec)\.\w+`;
const TOOK = String.raw`\d+(?:\.\d+)?\s*m?s`;
const VITEST_FAIL = new RegExp(String.raw`^\s*FAIL\s+(${TEST_FILE} > .+)$`);
const GRADLE_FAIL = /^(\S+ > \S.*) FAILED$/;
/** Vitest with `--reporter=verbose`: " ✓ file > suite > test 2ms (retry x1)", " × file > suite > test 0ms (retry x2)". */
const VITEST_TEST = new RegExp(String.raw`^\s*([✓×✗])\s+(${TEST_FILE} > .+?)\s+${TOOK}( \(retry x\d+\))?$`);
/** A test file in which every test passed: " ✓ tests/a.test.ts (4 tests) 12ms". */
const VITEST_FILE = new RegExp(String.raw`^\s*✓\s+(${TEST_FILE}) \(\d+ tests?(?: \| \d+ skipped)?\)`);

/**
 * The failing and retried tests in one test log. Understands Vitest (" FAIL  file > suite > test" with the error
 * under it; with `--reporter=verbose` also " ✓ file > suite > test 12ms (retry x1)" — the default reporter prints
 * nothing for a test that passed on a retry) and Gradle ("Class > test FAILED" with the exception under it).
 * A cause is given only to the test whose own error block shows it.
 */
export function parseTestLog(text: string, run: string, issue: string, repo = issue.includes("#") ? issue.slice(0, issue.lastIndexOf("#")) : ""): Hit[] {
  const hits = new Map<string, Hit>();
  const add = (test: string, kind: Hit["kind"]): Hit | undefined => {
    const t = test.trim().slice(0, 200);
    if (!t) return undefined;
    const had = hits.get(t);
    if (had && (kind === "retried" || had.kind === "failed")) return had;
    const hit: Hit = { run, issue, repo, test: t, kind, cause: had?.cause ?? "" };
    hits.set(t, hit);
    return hit;
  };
  // The tests whose error text the next lines are: Vitest prints one or more " FAIL " lines, then the error, then a rule.
  let block: Hit[] = [];
  let heading = false;
  let gradle = false;
  for (const line of strip(text).split("\n")) {
    const v = VITEST_FAIL.exec(line);
    const fail = v ?? GRADLE_FAIL.exec(line);
    if (fail) {
      const hit = add(fail[1]!, "failed");
      if (!heading) block = [];
      if (hit) block.push(hit);
      heading = true;
      gradle = !v;
      continue;
    }
    heading = false;
    if (/^\s*⎯/.test(line) || (gradle && !line.trim())) {
      block = [];
      continue;
    }
    if (block.length) {
      const cause = CAUSES.find(([re]) => re.test(line))?.[1];
      if (cause) for (const h of block) h.cause ||= cause;
    }
    const t = VITEST_TEST.exec(line);
    if (t && t[1] !== "✓") add(t[2]!, "failed");
    else if (t && t[3]) add(t[2]!, "retried");
  }
  return [...hits.values()];
}

/** What a log shows as passed: test names (verbose reporter) and test files in which everything passed. */
export function parsePassed(text: string): string[] {
  const out = new Set<string>();
  for (const line of strip(text).split("\n")) {
    const t = VITEST_TEST.exec(line);
    if (t && t[1] === "✓") out.add(t[2]!.trim().slice(0, 200));
    const f = VITEST_FILE.exec(line);
    if (f) out.add(f[1]!);
  }
  return [...out];
}

export interface Suspect {
  /** The GitHub name of the repository the test belongs to; "" when the runs name none. */
  repo: string;
  test: string;
  /** Different stories in which it failed, and in which it passed only on a retry. */
  failedIn: string[];
  retriedIn: string[];
  cause: string;
  /** It also passed in the same days: on a retry, on the second test run, or in a log that names it as passed. A test that never passes is broken, not unreliable. */
  passes: boolean;
}

/** A test is suspect when it failed or needed a retry in this many different stories: one story can break its own test, several cannot. */
export const MIN_STORIES = 3;

/** The file of a test: tests are filed per test file, because one cause usually breaks a whole file. */
const fileOf = (test: string) => test.split(" > ")[0]!;
/** Repository plus name: the same file name in two repositories is two things. */
export const keyOf = (repo: string, name: string) => (repo ? `${repo}:${name}` : name);
export const groupOf = (s: Pick<Suspect, "repo" | "test">) => keyOf(s.repo, fileOf(s.test));

/** `passed`: keys (`keyOf`) of the tests and test files a log of the same days shows as passed. Hits without a story are left out. */
export function suspects(hits: Hit[], passed: ReadonlySet<string> = new Set()): Suspect[] {
  const by = new Map<string, Suspect>();
  for (const h of hits) {
    if (!h.issue) continue;
    const key = keyOf(h.repo, h.test);
    const s = by.get(key) ?? { repo: h.repo, test: h.test, failedIn: [], retriedIn: [], cause: "", passes: false };
    const list = h.kind === "failed" ? s.failedIn : s.retriedIn;
    if (!list.includes(h.issue)) list.push(h.issue);
    if (h.cause && !s.cause) s.cause = h.cause;
    by.set(key, s);
  }
  const stories = (s: Suspect) => new Set([...s.failedIn, ...s.retriedIn]).size;
  return [...by.values()]
    .filter((s) => stories(s) >= MIN_STORIES)
    .map((s) => ({ ...s, passes: s.retriedIn.length > 0 || passed.has(keyOf(s.repo, s.test)) || passed.has(groupOf(s)) }))
    .sort((a, b) => b.failedIn.length - a.failedIn.length || stories(b) - stories(a));
}

/**
 * The test logs of the runs that changed in the last `days`, as hits. Only a run for an issue counts as a story.
 * `tests.first.log` is the log of a test run that failed and passed when it was run once more (the flows keep it):
 * what failed in it, and does not fail in the newest log, passed on the second run and counts as retried.
 */
export function collectHits(runsDir: string, now: Date, days = 7): { hits: Hit[]; logs: number; passed: Set<string> } {
  const hits: Hit[] = [];
  const passed = new Set<string>();
  let logs = 0;
  if (!existsSync(runsDir)) return { hits, logs, passed };
  const fresh = (file: string): string | undefined => {
    try {
      return now.getTime() - statSync(file).mtimeMs > days * 86_400_000 ? undefined : readFileSync(file, "utf8");
    } catch {
      return undefined; // no such log
    }
  };
  for (const run of readdirSync(runsDir).sort()) {
    try {
      const last = fresh(join(runsDir, run, "tests.log"));
      const first = fresh(join(runsDir, run, "tests.first.log"));
      if (last === undefined && first === undefined) continue;
      const summary = JSON.parse(readFileSync(join(runsDir, run, "run.json"), "utf8")) as { vars?: Record<string, string> };
      const repo = summary.vars?.github_repo ?? "";
      const issue = summary.vars?.issue ? `${repo}#${summary.vars.issue}` : "";
      const found = last === undefined ? [] : parseTestLog(last, run, issue, repo);
      const failing = new Set(found.filter((h) => h.kind === "failed").map((h) => h.test));
      const known = new Set(found.map((h) => h.test));
      for (const h of first === undefined ? [] : parseTestLog(first, run, issue, repo)) {
        if (failing.has(h.test)) continue; // it fails still: not a pass on the second run
        passed.add(keyOf(repo, h.test));
        if (!known.has(h.test)) found.push({ ...h, kind: "retried" });
      }
      for (const h of found) if (h.kind === "retried") passed.add(keyOf(repo, h.test));
      for (const text of [last, first]) for (const name of text === undefined ? [] : parsePassed(text)) passed.add(keyOf(repo, name));
      hits.push(...found);
      logs += (last === undefined ? 0 : 1) + (first === undefined ? 0 : 1);
    } catch {
      // a run being written
    }
  }
  return { hits, logs, passed };
}

/** The address of the story filed for a group; `filed` of before repositories were told apart has the bare file name. */
export const filedFor = (s: Pick<Suspect, "repo" | "test">, filed: Record<string, string>) => filed[groupOf(s)] ?? filed[fileOf(s.test)];

export function flakyReport(list: Suspect[], logs: number, days: number, filed: Record<string, string> = {}): string {
  const out = ["# Unreliable tests", "", `From ${logs} test logs of the last ${days} days. A test is listed when it failed, or passed only on a retry, in at least ${MIN_STORIES} different stories.`, ""];
  if (!list.length) return [...out, "None found.", ""].join("\n");
  out.push("| Repository | Test | Failed in | Passed on a retry in | Also passes | Likely cause | Story |", "|---|---|---|---|---|---|---|");
  for (const s of list) out.push(`| ${s.repo || "–"} | ${s.test.replace(/\|/g, "/")} | ${s.failedIn.length} | ${s.retriedIn.length} | ${s.passes ? "yes" : "not seen"} | ${s.cause || "–"} | ${filedFor(s, filed) ?? "–"} |`);
  return [...out, "", "A story is made only for a test file of a known repository in which at least one listed test was also seen to pass: a test that never passes is broken, not unreliable.", ""].join("\n");
}

export interface Story { key: string; repo: string; title: string; body: string }

/**
 * One bug story per test file of a repository, the worst files first. Left out: what was filed before, files of an
 * unknown repository, and files of which no listed test was seen to pass. The caller decides how many it files.
 */
export function stories(list: Suspect[], filed: Record<string, string>): Story[] {
  const groups = new Map<string, Suspect[]>();
  for (const s of list) groups.set(groupOf(s), [...(groups.get(groupOf(s)) ?? []), s]);
  return [...groups.entries()].filter(([, tests]) => tests[0]!.repo && !filedFor(tests[0]!, filed) && tests.some((t) => t.passes)).map(([key, tests]) => {
    const cause = tests.find((t) => t.cause)?.cause;
    const file = fileOf(tests[0]!.test);
    return {
      key,
      repo: tests[0]!.repo,
      title: `Unreliable tests in ${file}`,
      body: [
        "## What goes wrong", "",
        `Tests in \`${file}\` failed, or passed only when they were run again, in several unrelated stories in the last days, so the cause is in the test or in how test runs share the machine, not in those stories.`, "",
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
