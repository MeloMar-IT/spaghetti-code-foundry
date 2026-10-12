import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { UpdateStep } from "./self-update-state.js";

const ANSI =/\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const FAIL = /^\s*FAIL\s+(\S+\.(?:test|spec)\.\w+ > .+)$/;
const CROSS = /^\s*[×✗]\s+(.+?)(?:\s+\d+\s?ms)?(?:\s+\(retry x\d+\))?\s*$/;

/** The names of the failing tests in the output of a vitest run: " FAIL  file > name" and "×" lines. At most 20; [] when none. */
export function failingTests(output: string): string[] {
  const lines = output.replace(ANSI, "").split("\n");
  const fails = new Set<string>();
  for (const l of lines) {
    const m = FAIL.exec(l);
    if (m?.[1]) fails.add(m[1].trim());
  }
  const all = new Set(fails);
  for (const l of lines) {
    const name = CROSS.exec(l)?.[1]?.trim();
    if (!name) continue;
    // vitest prints the same test in both forms
    if ([...fails].some((f) => f === name || f.endsWith(` > ${name}`))) continue;
    all.add(name);
  }
  return [...all].slice(0, 20);
}

/** Removes the first line that is exactly `mark` from a stream that comes in pieces. Holds back only a tail that could still be the start of the mark. */
export function markFinder(mark: string): { push(piece: string): string; found(): boolean; rest(): string } {
  const needle = `${mark}\n`;
  let held = "";
  let done = false;
  let lineStart = true;
  return {
    push(piece) {
      if (done) return piece;
      const atStart = held ? true : lineStart;
      const s = held + piece;
      held = "";
      let from = 0;
      for (;;) {
        const i = s.indexOf(needle, from);
        if (i < 0) break;
        if (i === 0 ? atStart : s[i - 1] === "\n") {
          done = true;
          return s.slice(0, i) + s.slice(i + needle.length);
        }
        from = i + 1;
      }
      const last = s.lastIndexOf("\n");
      const tail = s.slice(last + 1);
      let out = s;
      if ((last >= 0 || atStart) && tail.length > 0 && tail.length < needle.length && needle.startsWith(tail)) {
        held = tail;
        out = s.slice(0, last + 1);
      }
      if (out) lineStart = out.endsWith("\n");
      return out;
    },
    found: () => done,
    rest() {
      const h = held;
      held = "";
      return h;
    },
  };
}

/** The key of a test record: as the flows compute it, `printf '%s\n%s\n' tree cmd | shasum | cut -c1-40`. */
export function testedKey(tree: string, cmd: string): string {
  return createHash("sha1").update(`${tree}\n${cmd}\n`).digest("hex");
}

const RECORD = /^run ([A-Za-z0-9_-]{1,64}), (\d{4}-\d\d-\d\dT\d\d:\d\dZ), tree ([0-9a-f]{40})\n?$/;

/** "run <id>, <time>" when the release check recorded a pass of `cmd` on `tree` in `dir`; else undefined. Never throws. */
export function passedBefore(dir: string, tree: string, cmd: string): string | undefined {
  try {
    if (!/^[0-9a-f]{40}$/.test(tree) || cmd === "") return undefined;
    const p = join(dir, testedKey(tree, cmd));
    const st = lstatSync(p); // a symlink or a folder is not a record
    if (!st.isFile() || st.size > 200) return undefined;
    const m = RECORD.exec(readFileSync(p, "utf8"));
    if (!m || m[3] !== tree) return undefined;
    return `run ${m[1]}, ${m[2]}`;
  } catch {
    return undefined;
  }
}

/** What tools/detect-commands of the running version prints for `test` in `cwd`; undefined when nothing, more than one line, an error or a timeout. Never throws. */
export function detectTestCmd(cwd: string, tool = fileURLToPath(new URL("../tools/detect-commands", import.meta.url))): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile("sh", [tool, "test"], { cwd, timeout: 10_000, maxBuffer: 10_000, env: { PATH: process.env.PATH ?? "" } }, (err, stdout) => {
        if (err) return resolve(undefined);
        const out = String(stdout).replace(/\n$/, "");
        resolve(out === "" || /[\r\n]/.test(out) ? undefined : out);
      });
    } catch {
      resolve(undefined);
    }
  });
}

/** True when the code in `cwd` may pin its test command: .claude-factory/config.yaml mentions `test_cmd`, or cannot be read. Never throws. */
export function pinsTests(cwd: string): boolean {
  try {
    return readFileSync(join(cwd, ".claude-factory", "config.yaml"), "utf8").includes("test_cmd");
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    return !(code === "ENOENT" || code === "ENOTDIR"); // nothing there: nothing pinned
  }
}

const SAFE_PART = /^[A-Za-z0-9_.\/:=@%+-]+$/;

/** True only when `cmd` is the step's own command, alone or after "npm ci && ". */
export function sameTests(step: UpdateStep | undefined, cmd: string | undefined): boolean {
  if (!step || !cmd) return false;
  const parts = [step.cmd, ...step.args];
  if (!parts.every((p) => SAFE_PART.test(p))) return false;
  const base = parts.join(" ");
  return cmd === base || cmd === `npm ci && ${base}`;
}

/** The same step, run through tools/test-slot; it prints a start mark right before the command starts. */
export function slotStep(
  step: UpdateStep,
  o: { tool: string; slotsDir: string; slots?: number; waitSec?: number; pollMs?: number },
): UpdateStep {
  const mark = `scf-tests-start-${randomBytes(8).toString("hex")}`; // letters, digits and "-" only: safe inside the shell text
  const waitSec = o.waitSec ?? 900;
  return {
    ...step,
    cmd: "node",
    args: [o.tool, o.slotsDir, "sh", "-c", `echo ${mark}; exec "$@"`, "sh", step.cmd, ...step.args],
    env: {
      ...step.env,
      FACTORY_VAR_TEST_SLOTS: String(o.slots ?? 2),
      FACTORY_TEST_SLOT_WAIT_SEC: String(waitSec),
      FACTORY_TEST_SLOT_POLL_MS: String(o.pollMs ?? 2000),
    },
    waitMs: waitSec * 1000,
    startMark: mark,
    slotsDir: o.slotsDir,
  };
}
