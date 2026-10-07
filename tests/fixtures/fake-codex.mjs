#!/usr/bin/env node
// Stand-in for `codex exec --json`: reads the prompt from stdin, emits Codex JSONL events.
// Prompt directives: "WRITE <file> <text>" writes a file; "SAY <text>" sets the answer;
// "SHOWALLENV" answers "env: " and the sorted names (no values) of its environment.
// "LIMIT" fails with a rate limit. Args are echoed into the answer for assertions.
// "READ <path>" lists a folder or reads a file and answers "read ok <path> <count>" (never the content); an error is not caught.
// "CHILD READ <path>" and "CHILD WRITE <path> <text>" do the same in a child `node -e` process; a failing child fails this fake with its stderr.
// "CODEX_SIGNED_OUT" fails with a 401 answer.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const probeRead = (p) => (statSync(p).isDirectory() ? readdirSync(p).length : readFileSync(p).length);
const CHILD_READ = 'const fs=require("fs");const p=process.argv[1];console.log(fs.statSync(p).isDirectory()?fs.readdirSync(p).length:fs.readFileSync(p).length)';
const CHILD_WRITE = 'require("fs").writeFileSync(process.argv[1],process.argv[2])';
function child(code, ...a) {
  try {
    return execFileSync(process.execPath, ["-e", code, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    process.stderr.write(`child failed: ${e.stderr || e.message}\n`);
    process.exit(1);
  }
}

let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const args = process.argv.slice(2);
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const resumeAt = args.indexOf("resume");
const thread = resumeAt >= 0 ? args[args.indexOf("-") - 1] : `thread-${Math.random().toString(36).slice(2, 8)}`;

emit({ type: "thread.started", thread_id: thread });
emit({ type: "turn.started" });
// "at capacity" until the file named by CODEX_CAPACITY_ONCE exists (fails once, then works).
const once = /CODEX_CAPACITY_ONCE (\S+)/.exec(prompt)?.[1];
if (once && !existsSync(once)) {
  writeFileSync(once, "");
  emit({ type: "turn.failed", error: { message: "Selected model is at capacity. Please try a different model." } });
  process.exit(1);
}
if (prompt.includes("CODEX_LIMIT")) {
  emit({ type: "turn.failed", error: { message: "You've hit your usage limit (429 rate limit)" } });
  process.exit(1);
}
if (prompt.includes("CODEX_SIGNED_OUT")) {
  emit({ type: "turn.failed", error: { message: "unexpected status 401 Unauthorized" } });
  process.exit(1);
}
let answer = `codex ok args=${args.join(" ")}\nPROMPT<<${prompt}>>`;
let n = 0;
const shown = [];
for (const line of prompt.split("\n")) {
  const w = line.match(/^WRITE (\S+) (.*)$/);
  if (w) {
    writeFileSync(w[1], w[2]);
    emit({ type: "item.completed", item: { id: `item_${n++}`, type: "file_change", changes: [{ path: w[1], kind: "add" }], status: "completed" } });
  }
  const s = line.match(/^SAY (.*)$/);
  if (s) answer = s[1];
  const rd = line.match(/^READ (.*)$/);
  if (rd) shown.push(`read ok ${rd[1]} ${probeRead(rd[1])}`);
  const cr = line.match(/^CHILD READ (.*)$/);
  if (cr) shown.push(`read ok ${cr[1]} ${child(CHILD_READ, cr[1])}`);
  const cw = line.match(/^CHILD WRITE (\S+) (.*)$/);
  if (cw) child(CHILD_WRITE, cw[1], cw[2]);
  const sv = line.match(/^SHOWVARS (.*)$/);
  if (sv) shown.push(...sv[1].split(/\s+/).filter(Boolean).map((n) => `${n}=${process.env[n] ?? "(unset)"}`));
  if (line === "SHOWALLENV") shown.push(`env: ${Object.keys(process.env).sort().join(" ")}`);
  if (line === "SHOWGHDIR") {
    const d = process.env.GH_CONFIG_DIR;
    shown.push(`gh_dir=${!d ? "unset" : !existsSync(d) ? "missing" : readdirSync(d).length ? "files" : "empty"}`);
  }
  if (shown.length) answer = shown.join("\n");
}
emit({ type: "item.completed", item: { id: `item_${n++}`, type: "command_execution", command: "git status", aggregated_output: "clean\n", exit_code: 0, status: "completed" } });
if (prompt.includes("VERDICT: APPROVE")) answer = process.env.FAKE_CODEX_VERDICT ?? "Fine.\nVERDICT: APPROVE";
// Separate answers for checking a plan and for reviewing code, when a test needs them to differ.
if (prompt.includes("Review this implementation plan") && process.env.FAKE_CODEX_PLAN_VERDICT) answer = process.env.FAKE_CODEX_PLAN_VERDICT;
if (prompt.includes("Code review, round") && process.env.FAKE_CODEX_CODE_VERDICT) answer = process.env.FAKE_CODEX_CODE_VERDICT;
if (prompt.includes("VERDICT: APPROVE") && prompt.includes("RISK_SCORE:") && process.env.FAKE_CODEX_RISK) {
  answer = answer.replace(/(\n?VERDICT:)/, `\nRISK_SCORE: ${process.env.FAKE_CODEX_RISK}$1`);
}
emit({ type: "item.completed", item: { id: `item_${n++}`, type: "agent_message", text: answer } });
emit({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 50 } });
