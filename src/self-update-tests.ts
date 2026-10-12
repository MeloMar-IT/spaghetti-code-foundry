import { randomBytes } from "node:crypto";
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
