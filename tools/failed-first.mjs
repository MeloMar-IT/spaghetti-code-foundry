#!/usr/bin/env node
// After a fix, the test step first runs only the test files that failed last time.
//
//   failed-first.mjs record <marker-file> <run-dir> <exit-code>
//       After a test run. Exit code 0: removes <run-dir>/failed-tests.txt and exits 0. Else it names the failing tests
//       from the JUnit reports written after the marker (read in the working folder) and from <run-dir>/tests.log.
//       When any is named it writes the list and exits 0; when none is, the list stays as it is and it exits 1.
//   failed-first.mjs command <run-dir> <test-cmd>
//       Prints the test command that runs only the listed targets, or nothing (no list, a runner it does not know,
//       a command it cannot read safely, no usable target, or more than 50). Reads ./package.json. Exit 0.
//   Bad usage exits 2.
//
// One line of the list is "<target><TAB><test name>". The target is a test file, a Java class or a Go package. The test
// name can be empty (a test file that could not be loaded). Targets come from test output: each one is checked against a
// strict pattern for its runner and single-quoted before it is part of a command.
//
// A command that selects tests by path (`pytest tests/`, `vitest run src`) has those paths replaced by the failing
// targets: appending would still run everything under them. A flag whose meaning is not known, followed by a word,
// could take that word as its value or not, so such a command gets no focused run.
import { readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { reportFiles } from "./failing-tests.mjs";

const LIST = "failed-tests.txt";
const MAX_TARGETS = 50;
const MAX_LINES = 500;

const unxml = (s) => s.replace(/&(lt|gt|quot|apos|amp);/g, (_, e) => ({ lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" })[e]);
const attr = (s, name) => {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(s);
  return m ? unxml(m[1] ?? m[2] ?? "") : undefined;
};

function dedupe(list) {
  const seen = new Set();
  return list.filter((x) => {
    const key = `${x.target}\t${x.test}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
}

const JS_FILE = String.raw`[\w./@+-]+\.(?:[cm]?[jt]sx?|vue|svelte)`;
/** vitest `FAIL  file > suite > test` and `FAIL  file [ file ]`; jest `FAIL file (1.2 s)`. A project name may come first. */
const JS_FAIL = new RegExp(String.raw`^\s*FAIL\s+(?:\|[^|]*\|\s+)?(${JS_FILE})(?:\s+>\s+(.+?)|\s+\[[^\]]*\]|\s+\([\d.]+\s*m?s\))?\s*$`);

/** The failing targets a test log names: vitest, jest, pytest, go, gradle and maven lines. */
export function targetsFromLog(text) {
  const out = [];
  let goTests = [];
  for (const line of String(text).replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").split(/\r?\n/)) {
    let m;
    if ((m = /^FAIL\t(\S+)\t[\d.]+s\b/.exec(line))) {
      for (const test of goTests) out.push({ target: m[1], test });
      goTests = [];
    } else if (/^ok\s+\S+/.test(line)) goTests = [];
    else if ((m = /^\s*--- FAIL:\s+(\S+)/.exec(line))) goTests.push(m[1]);
    else if ((m = JS_FAIL.exec(line))) out.push({ target: m[1], test: m[2] ?? "" });
    else if ((m = /^FAILED\s+([^\s:]+\.py)::(.+?)(?:\s+-\s+.*)?$/.exec(line))) out.push({ target: m[1], test: m[2] });
    else if ((m = /^((?:[\w$]+\.)*[A-Z][\w$]*)\s>\s(.+?)\sFAILED$/.exec(line))) out.push({ target: m[1], test: m[2] });
    else if ((m = /^\[ERROR\]\s+((?:[\w$]+\.)*[A-Z][\w$]*)\.([\w$]+)(?=[\s:([]|$)/.exec(line)) && m[2] !== "java") out.push({ target: m[1], test: m[2] });
  }
  return dedupe(out);
}

/** The failing targets of the JUnit reports newer than the marker: the `file` attribute, else the class name. */
export function targetsFromReports(marker, root = ".") {
  let since = 0;
  try {
    if (marker) since = statSync(marker).mtimeMs;
  } catch {
    since = 0;
  }
  const out = [];
  for (const f of reportFiles(root, since)) {
    let xml;
    try {
      xml = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const m of xml.matchAll(/<testcase\b((?:[^>"']|"[^"]*"|'[^']*')*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
      const name = attr(m[1], "name");
      if (name === undefined || !/<(failure|error)\b/.test(m[2] ?? "")) continue;
      let target = attr(m[1], "file");
      if (target && isAbsolute(target)) {
        const rel = relative(resolve(root), target);
        if (rel && !rel.startsWith("..")) target = rel;
      }
      target = (target || attr(m[1], "classname") || "").replace(/^\.\//, "");
      if (target) out.push({ target, test: name });
    }
  }
  return dedupe(out);
}

export function readList(runDir) {
  let text;
  try {
    text = readFileSync(join(runDir, LIST), "utf8");
  } catch {
    return [];
  }
  return text.split("\n").filter(Boolean).map((line) => {
    const [target, ...rest] = line.split("\t");
    return { target, test: rest.join(" ") };
  });
}

export function writeList(runDir, list) {
  const clean = (s) => String(s).replace(/[\t\r\n]+/g, " ");
  const lines = list.filter((x) => !/[\t\r\n]/.test(x.target)).slice(0, MAX_LINES).map((x) => `${x.target}\t${clean(x.test)}\n`);
  const tmp = join(runDir, `${LIST}.tmp`);
  writeFileSync(tmp, lines.join(""));
  renameSync(tmp, join(runDir, LIST));
}

/**
 * Notes the result of a test run. 0: the run passed (the list is gone) or its failing tests are listed. 1: it failed
 * and names no test (the list is unchanged). Reports and log are both read: the class name of a report is not always
 * something the runner can be given (pytest), and the log may name the file.
 */
export function record(marker, runDir, code, root = ".") {
  if (Number(code) === 0) {
    rmSync(join(runDir, LIST), { force: true });
    return 0;
  }
  let log = "";
  try {
    log = readFileSync(join(runDir, "tests.log"), "utf8");
  } catch {
    log = "";
  }
  // The log first: its targets are the ones the runner itself printed, so they stay when the list is cut.
  const list = dedupe([...targetsFromLog(log), ...targetsFromReports(marker, root)]);
  if (!list.length) return 1;
  writeList(runDir, list);
  return 0;
}

// ── the focused command ──

const SAFE_COMMAND = /^[A-Za-z0-9_./=:,@+ -]+$/;
const words = (s) => s.trim().split(/ +/).filter(Boolean);
const set = (s) => new Set(words(s));

/** The flags of a runner that are known: `plain` take no value, `value` take the next word, `refuse` rule out a focused run. */
const JS_FLAGS = {
  plain: set("--run --ci --coverage --silent --verbose --passWithNoTests --runInBand -i --forceExit --detectOpenHandles --globals --colors --color --runTestsByPath"),
  value: set("-c --config -r --root --dir --project --reporter --outputFile --environment --pool --testTimeout --hookTimeout --maxWorkers --minWorkers -w --rootDir --testEnvironment -t --testNamePattern"),
  refuse: set("--watch --watchAll --testPathPattern --testPathPatterns --findRelatedTests --reporters --selectProjects --roots --testMatch --coverageReporters --collectCoverageFrom"),
};
const PY_FLAGS = {
  plain: set("-q -qq -v -vv -x -s -l --quiet --verbose --exitfirst -ra -rA -rf -rfE --strict-markers --strict-config --disable-warnings --cache-clear --showlocals"),
  value: set("-k -m -p -c -n -o -W --rootdir --tb --maxfail --junitxml --junit-xml --durations --timeout --dist --cov-report --cov-config --ignore --ignore-glob --deselect --confcutdir --import-mode --color"),
  refuse: set("--pyargs"),
};
/** Go test flags: `plain` take no value, `value` take the next word (a path such as ./coverage.out is a value, not a package). */
const GO_PLAIN = set("-v -race -short -failfast -json -cover -a -n -x -c -msan -asan -trimpath -work");
const GO_VALUE = set("-run -skip -count -timeout -parallel -p -cpu -bench -benchtime -benchmem -shuffle -coverprofile -covermode -coverpkg -o -exec");

/**
 * Go test arguments: flags with their values are kept; the packages (`./…`, `.`) are dropped, since the failing packages
 * replace them. Null for a flag that is not known (it may take a value), `-args`, or a package that is not written as ./….
 */
function parseGoArgs(args) {
  const kept = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-args" || a === "--args") return null;
    if (!a.startsWith("-")) {
      if (a === "." || a.startsWith("./")) continue;
      return null;
    }
    if (a.includes("=") || GO_PLAIN.has(a)) {
      kept.push(a);
      continue;
    }
    if (!GO_VALUE.has(a) || args[i + 1] === undefined) return null;
    kept.push(a, args[i + 1]);
    i++;
  }
  return { kept };
}

const GRADLE_FLAGS = {
  plain: set("-q --quiet -i --info -s --stacktrace --daemon --no-daemon --continue --offline --rerun-tasks --parallel --no-parallel --build-cache --no-build-cache --configuration-cache"),
  value: set("-p --project-dir -x --exclude-task --console --max-workers -I --init-script"),
  refuse: set("--tests"),
};
const MAVEN_FLAGS = {
  plain: set("-q --quiet -B --batch-mode -e --errors -o --offline -U --update-snapshots -ntp --no-transfer-progress -am --also-make -X --debug"),
  value: set("-f --file -pl --projects -P --activate-profiles -s --settings -T --threads -gs --global-settings"),
  refuse: set(""),
};

/**
 * Splits arguments into the flags (with their values) and the other words. Null when a flag rules the run out, or when
 * it cannot be known whether a word is the value of a flag or a path. A flag at the end that may take a value would take
 * the first appended target, so that is refused too.
 */
function parseArgs(args, flags) {
  const kept = [];
  const others = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("-")) {
      others.push(a);
      continue;
    }
    const name = a.split("=")[0];
    if (flags.refuse.has(name)) return null;
    if (a.includes("=") || flags.plain.has(a)) {
      kept.push(a);
      continue;
    }
    const next = args[i + 1];
    if (flags.value.has(a)) {
      if (next === undefined || next.startsWith("-")) return null;
      kept.push(a, next);
      i++;
    } else if (next?.startsWith("-") || a.startsWith("-D") || a.startsWith("-P") || a.startsWith("--no-")) kept.push(a);
    else return null;
  }
  return { kept, others };
}

/** A direct vitest or jest call: what comes before its arguments, the arguments kept, and the paths it names. */
function jsCall(tokens) {
  let i = 0;
  if (tokens[0] === "npx") {
    i = 1;
    while (["--no-install", "--no", "--yes", "-y"].includes(tokens[i])) i++;
  } else if (tokens[0] === "pnpm" && tokens[1] === "exec") i = 2;
  const runner = /^(?:(?:\.\/)?node_modules\/\.bin\/)?(vitest|jest)$/.exec(tokens[i] ?? "")?.[1];
  if (!runner) return null;
  const head = tokens.slice(0, i + 1);
  let args = tokens.slice(i + 1);
  if (runner === "vitest") {
    if (["watch", "dev", "bench", "list", "related", "init", "typecheck"].includes(args[0])) return null;
    if (args[0] === "run") {
      head.push("run");
      args = args.slice(1);
    }
  }
  const parsed = parseArgs(args, JS_FLAGS);
  return parsed && { head, ...parsed };
}

const PACKAGE_SCRIPT = { "npm test": "npm test --", "npm run test": "npm run test --", "pnpm test": "pnpm test", "pnpm run test": "pnpm run test", "yarn test": "yarn test", "yarn run test": "yarn run test", "bun run test": "bun run test" };

/** How the last part of a test command runs chosen targets: the kind of target, and the command for them. Null: unknown. */
function runnerOf(part, packageJson) {
  const tokens = words(part);
  const script = PACKAGE_SCRIPT[tokens.join(" ")];
  if (script) {
    // `bun test` is not here: it is bun's own test runner, not the script.
    const test = packageJson?.scripts?.test;
    if (typeof test !== "string" || !SAFE_COMMAND.test(test)) return null;
    const call = jsCall(words(test));
    // A path inside the script cannot be replaced, and the files appended to it would run next to everything under it.
    if (!call || call.others.length) return null;
    return { kind: "file", build: (t) => `${script} ${t}` };
  }
  const js = jsCall(tokens);
  if (js) return { kind: "file", build: (t) => [...js.head, ...js.kept, t].join(" ") };

  const py = /^(?:pytest|py\.test|python[\d.]* -m pytest)(?= |$)/.exec(tokens.join(" "))?.[0];
  if (py) {
    const parsed = parseArgs(tokens.slice(words(py).length), PY_FLAGS);
    return parsed && { kind: "python", build: (t) => [py, ...parsed.kept, t].join(" ") };
  }
  if (tokens[0] === "go" && tokens[1] === "test") {
    const parsed = parseGoArgs(tokens.slice(2));
    if (!parsed) return null;
    return { kind: "go", build: (t) => ["go", "test", ...parsed.kept, t].join(" ") };
  }
  if (/^(?:\.\/gradlew|gradle)$/.test(tokens[0] ?? "")) {
    const parsed = parseArgs(tokens.slice(1), GRADLE_FLAGS);
    // --tests belongs to the one test task before it.
    if (!parsed || parsed.others.length !== 1 || !/^(?::?[\w-]+:)*:?test$/.test(parsed.others[0])) return null;
    const task = parsed.others[0];
    return { kind: "java", build: (t) => [tokens[0], ...parsed.kept, task, t].join(" "), join: (list) => list.map((c) => `--tests '${c}'`).join(" ") };
  }
  if (/^(?:\.\/mvnw|mvn)$/.test(tokens[0] ?? "")) {
    if (tokens.some((a) => a.startsWith("-Dtest="))) return null;
    const parsed = parseArgs(tokens.slice(1), MAVEN_FLAGS);
    if (!parsed || !parsed.others.includes("test") || parsed.others.some((g) => g !== "test" && g !== "clean")) return null;
    return { kind: "java", build: (t) => `${tokens.join(" ")} ${t}`, join: (list) => `-Dtest='${list.join(",")}' -Dsurefire.failIfNoSpecifiedTests=false` };
  }
  return null;
}

const plainPath = (t) => /^[\w./@+-]+$/.test(t) && !t.startsWith("-") && !isAbsolute(t) && !t.split("/").includes("..");
const VALID = {
  file: (t, exists) => plainPath(t) && exists(t),
  python: (t, exists) => t.endsWith(".py") && plainPath(t) && exists(t),
  go: (t) => /^[\w./-]+$/.test(t) && plainPath(t),
  java: (t) => /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(t),
};

/** The test command that runs only the failing targets; "" when there is no safe one. */
export function focusedCommand(cmd, targets, { packageJson = null, exists = () => false } = {}) {
  // What comes before the last " && " (an install) stays as it is.
  const at = cmd.lastIndexOf(" && ");
  const prefix = at < 0 ? "" : cmd.slice(0, at + 4);
  const part = at < 0 ? cmd : cmd.slice(at + 4);
  if (!SAFE_COMMAND.test(part)) return "";
  const runner = runnerOf(part, packageJson);
  if (!runner) return "";
  const usable = [...new Set(targets.map((x) => x.target))].filter((t) => VALID[runner.kind](t, exists));
  if (!usable.length || usable.length > MAX_TARGETS) return "";
  return prefix + runner.build(runner.join ? runner.join(usable) : usable.map((t) => `'${t}'`).join(" "));
}

function readPackageJson() {
  try {
    return JSON.parse(readFileSync("package.json", "utf8"));
  } catch {
    return null;
  }
}

const isFile = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "record" && args.length === 3 && /^\d+$/.test(args[2])) {
    process.exitCode = record(args[0], args[1], Number(args[2]));
  } else if (mode === "command" && args.length === 2) {
    const out = focusedCommand(args[1], readList(args[0]), { packageJson: readPackageJson(), exists: isFile });
    if (out) process.stdout.write(`${out}\n`);
  } else {
    process.stderr.write("usage: failed-first.mjs record <marker-file> <run-dir> <exit-code> | command <run-dir> <test-cmd>\n");
    process.exitCode = 2;
  }
}

let isMain = false;
try {
  isMain = realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch {
  isMain = false;
}
if (isMain) main();
