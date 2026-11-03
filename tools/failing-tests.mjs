#!/usr/bin/env node
// Names the failing tests of the last test run, with one message each, for the agent that fixes them.
//
//   failing-tests.mjs summary <marker-file> <run-dir> [--unfinished]
//       Prints the summary. The names come from the JUnit XML reports newer than the marker (read in the
//       working folder), else from <run-dir>/tests.log. With --unfinished (the test step ran out of time) it
//       says so and prints the end of the log. When no test can be named it prints the last 60 lines.
//
// Every line it prints starts with "| ": a line of a test log can look like a routing marker of the flow
// (RETEST, DEVELOP_BEHIND: …), and the engine matches routes against whole lines. Exit 0; exit 2 on bad usage.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

const MAX_LISTED = 20;
const MESSAGE_CHARS = 300;

// Only for what is printed.
function tidy(text) {
  // A newline inside a name or message (JUnit allows one) would start a line of its own, unprefixed.
  let o = String(text).replace(/\r\n|\r|\n/g, " ").replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").replace(/[\u0000-\u0008\u000b-\u001f\u007f`]/g, "");
  for (const h of [process.cwd(), homedir()].filter((x) => x && x.length > 1)) o = o.split(h).join("(folder)");
  o = o.trim();
  return o.length > MESSAGE_CHARS ? `${o.slice(0, MESSAGE_CHARS)}…` : o;
}

const unxml = (s) => s.replace(/&(lt|gt|quot|apos|amp);/g, (_, e) => ({ lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" })[e]);
const attr = (s, name) => {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(s);
  return m ? unxml(m[1] ?? m[2] ?? "") : undefined;
};

function reportFiles(root, since) {
  const files = [];
  (function walk(dir, depth) {
    if (depth > 8) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git" || e.name === ".gradle") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/^TEST-.*\.xml$|^junit.*\.xml$/.test(e.name) && statSync(p).mtimeMs >= since) files.push(p);
    }
  })(root, 0);
  return files;
}

/** The failing cases of the JUnit reports newer than the marker. */
export function fromReports(marker, root = ".") {
  let since = 0;
  try {
    if (marker) since = statSync(marker).mtimeMs;
  } catch {
    since = 0;
  }
  const files = reportFiles(root, since);
  const failing = [];
  for (const f of files) {
    let xml;
    try {
      xml = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const m of xml.matchAll(/<testcase\b((?:[^>"']|"[^"]*"|'[^']*')*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
      const name = attr(m[1], "name");
      const inner = m[2] ?? "";
      if (name === undefined || !/<(failure|error)\b/.test(inner)) continue;
      const cls = attr(m[1], "classname");
      const tag = /<(?:failure|error)\b((?:[^>"']|"[^"]*"|'[^']*')*)>?([^<]*)/.exec(inner);
      const msg = attr(tag?.[1] ?? "", "message") ?? unxml((tag?.[2] ?? "").trim().split("\n")[0] ?? "");
      failing.push({ test: tidy(`${cls ? `${cls}.` : ""}${name}`), message: tidy(msg) });
    }
  }
  return { files: files.length, failing: dedupe(failing) };
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((x) => (seen.has(x.test) ? false : (seen.add(x.test), true)));
}

const ERROR_LINE = /(Error|Exception)\b.*:|^\s*(expected|Expected|assert)\b/;

/** The failing tests a test log names: vitest, jest, pytest, go, gradle and maven lines. */
export function fromLog(text) {
  const lines = String(text).replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").split("\n");
  const out = [];
  const nextText = (i) => {
    for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) if (lines[j].trim()) return lines[j].trim();
    return "";
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if ((m = /^\s*FAIL\s+(.+?)\s*$/.exec(l))) {
      const name = m[1].replace(/\s*\[[^\]]*\]\s*$/, "");
      let message = "";
      for (let j = i + 1; j < Math.min(lines.length, i + 9); j++) if (ERROR_LINE.test(lines[j])) { message = lines[j].trim(); break; }
      out.push({ test: tidy(name), message: tidy(message) });
    } else if ((m = /^\s*●\s+(.+›.+)$/.exec(l))) out.push({ test: tidy(m[1]), message: tidy(nextText(i)) });
    else if ((m = /^FAILED\s+(\S+)(?:\s+-\s+(.+))?$/.exec(l))) out.push({ test: tidy(m[1]), message: tidy(m[2] ?? "") });
    else if ((m = /^\s*--- FAIL:\s+(\S+)/.exec(l))) out.push({ test: tidy(m[1]), message: tidy(nextText(i)) });
    else if ((m = /^(\S.*?)\s>\s(.+?)\sFAILED$/.exec(l))) out.push({ test: tidy(`${m[1]} > ${m[2]}`), message: tidy(nextText(i)) });
    else if ((m = /^\[ERROR\]\s+([\w$.]+\.[\w$]+)(?::\d+)?\s+(.+)$/.exec(l))) out.push({ test: tidy(m[1]), message: tidy(m[2]) });
  }
  return dedupe(out);
}

/**
 * Is this failure a busy machine rather than the code? Only when the tests did not finish (the step ran out of
 * time or was stopped). Failures that differ between the two full runs are NOT taken as load: tests that are
 * skipped, a run that stops at the first failure, or a log that is only partly understood look the same, and a
 * timing-sensitive test can fail in both full runs and still pass alone. Without a run of the failing tests on
 * their own that passed, the answer is "fix" (unknown counts as a real failure).
 */
export function verdict(o) {
  if (o && o.unfinished) return { retest: true, why: "the tests did not finish (the step ran out of time or was stopped)" };
  return { retest: false, why: "" };
}

function readLog(runDir) {
  try {
    return readFileSync(join(runDir, "tests.log"), "utf8");
  } catch {
    return "";
  }
}

const tail = (text, n) => text.replace(/\n+$/, "").split("\n").slice(-n);

export function summary(marker, runDir, unfinished) {
  const log = readLog(runDir);
  const out = [];
  if (unfinished) {
    out.push("The tests did not finish (the step ran out of time or was stopped). The end of the test log:");
    out.push(...tail(log, 30));
    return out;
  }
  const rep = fromReports(marker);
  const fromLogged = rep.failing.length ? [] : fromLog(log);
  const list = rep.failing.length ? rep.failing : fromLogged;
  if (!list.length) {
    out.push("No failing test could be named from the JUnit reports or the test log. The last 60 lines of the test log:");
    out.push(...tail(log, 60));
    return out;
  }
  out.push(`The failing tests (${rep.failing.length ? "from the JUnit reports" : "from the test log"}), ${list.length} in all:`);
  for (const t of list.slice(0, MAX_LISTED)) out.push(`  - ${t.test}${t.message ? `: ${t.message}` : ""}`);
  if (list.length > MAX_LISTED) out.push(`  … and ${list.length - MAX_LISTED} more`);
  return out;
}

function main() {
  const [cmd, marker, runDir, ...flags] = process.argv.slice(2);
  if (cmd !== "summary" || !marker || !runDir || flags.some((f) => f !== "--unfinished")) {
    process.stderr.write("usage: failing-tests.mjs summary <marker-file> <run-dir> [--unfinished]\n");
    process.exit(2);
  }
  const lines = summary(marker, runDir, flags.includes("--unfinished"));
  // Every physical line gets the prefix, so no line of the output can be a route marker by itself.
  process.stdout.write(lines.flatMap((l) => l.split(/\r\n|\r|\n/)).map((l) => `| ${l}\n`).join(""));
  process.exit(0);
}

let isMain = false;
try {
  isMain = realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch {
  isMain = false;
}
if (isMain) main();
