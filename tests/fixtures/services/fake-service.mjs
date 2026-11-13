#!/usr/bin/env node
// A fake managed service (#867). Stays up until SIGTERM, then appends "term" to the --out file and exits 0.
//   --out <file>            append one JSON line: { argv, token, url, pid }
//   --print-token           write the token to stdout
//   --print-env <NAME>      write the value of that variable to stdout
//   --exit <code>           exit with that code (after --after <ms>, default at once)
//   --ignore-term           ignore SIGTERM
//   --chatter <bytes>       write that many characters to stdout, in lines
//   --fork-child            start a long-lived child in the same process group (its pid goes to <out>.child)
//   --term-chatter <bytes>  write that many characters to stdout when SIGTERM comes
//   --split-token           write the token in two halves with a pause between them
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const val = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const out = val("out");
const token = process.env.SCF_SERVICE_TOKEN ?? "";

if (out) appendFileSync(out, JSON.stringify({ argv: process.argv.slice(2), token, url: process.env.SCF_URL, pid: process.pid }) + "\n");
if (flag("print-token")) process.stdout.write(`token=${token}\n`);
if (val("print-env")) process.stdout.write(`env=${process.env[val("print-env")]}\n`);
if (flag("split-token")) {
  process.stdout.write(`half=${token.slice(0, 20)}`);
  setTimeout(() => process.stdout.write(`${token.slice(20)}\n`), 30);
}
if (val("chatter")) {
  const n = Number(val("chatter"));
  for (let i = 0; i < n; i += 50) process.stdout.write(`${"é".repeat(24)}-line-${i}\n`);
}
if (flag("split-streams")) {
  // the configured env value API_KEY, first part on stdout, the rest on stderr after a pause (no newline between)
  const secret = process.env.API_KEY ?? "";
  process.stdout.write(secret.slice(0, 8));
  setTimeout(() => process.stderr.write(`${secret.slice(8)}\n`), 30);
}
if (flag("fork-child")) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  if (out) writeFileSync(`${out}.child`, String(child.pid));
}
if (val("exit") !== undefined) {
  setTimeout(() => process.exit(Number(val("exit"))), Number(val("after") ?? 0));
} else {
  setInterval(() => {}, 1000);
}
process.on("SIGTERM", () => {
  if (flag("ignore-term")) return;
  if (out) appendFileSync(out, "term\n");
  if (val("term-chatter")) process.stdout.write(`${"x".repeat(Number(val("term-chatter")))}\n`);
  process.exit(0);
});
