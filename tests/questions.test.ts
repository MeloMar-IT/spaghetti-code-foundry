import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error a plain ES module of the tools folder, without types
import { LIMITS as MJS_LIMITS, commitPending, decideRound } from "../tools/decide-questions.mjs";
import { DECIDED_FILE, LIMITS, readDecidedQuestions } from "../src/engine/questions.js";
import { userRun } from "../src/server/user-view.js";

vi.mock("../src/credentials/redact.js", () => ({ redactText: (s: string) => s.replaceAll("SECRET", "[redacted]") }));

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "decided-")); });
afterEach(() => { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }); });

const q = (n: number, over: Record<string, unknown> = {}) => ({ n, title: `Which db ${n}?`, text: `**Q${n}.** text`, decision: "pg", ...over });
const round = (over: Record<string, unknown> = {}) => ({ id: "0123456789abcdef", issue: 7, at: "2026-10-25T10:00:00.000Z", source: "planner", outcome: "went_on", questions: [q(1)], ...over });
const put = (rec: unknown) => writeFileSync(join(dir, DECIDED_FILE), typeof rec === "string" ? rec : JSON.stringify(rec));
const read = () => { const log: string[] = []; return { value: readDecidedQuestions(dir, (l) => log.push(l)), log }; };

describe("readDecidedQuestions", () => {
  it("mirrors the limits of the tool library", () => {
    expect(LIMITS).toEqual(MJS_LIMITS);
  });

  it("returns undefined without a log line when there is no file", () => {
    expect(read()).toEqual({ value: undefined, log: [] });
  });

  it("reads a valid file, rebuilt from the known fields", () => {
    put({ version: 1, extra: 1, rounds: [{ ...round(), more: "x", questions: [{ ...q(1), kind: "technical" }] }] });
    const { value, log } = read();
    expect(log).toEqual([]);
    expect(value).toEqual([round()]);
  });

  it("redacts the values", () => {
    put({ version: 1, rounds: [round({ questions: [q(1, { title: "a SECRET", text: "SECRET", decision: "SECRET!" })] })] });
    expect(read().value![0]!.questions[0]).toMatchObject({ title: "a [redacted]", text: "[redacted]", decision: "[redacted]!" });
  });

  const bad: [string, unknown][] = [
    ["bad JSON", "{nope"],
    ["an empty file", ""],
    ["version 2", { version: 2, rounds: [] }],
    ["501 rounds", { version: 1, rounds: Array.from({ length: 501 }, () => round()) }],
    ["a control character in a title", { version: 1, rounds: [round({ questions: [q(1, { title: "a\u0007b" })] })] }],
    ["a title that is too long", { version: 1, rounds: [round({ questions: [q(1, { title: "x".repeat(301) })] })] }],
    ["a text that is too long", { version: 1, rounds: [round({ questions: [q(1, { text: "x".repeat(4001) })] })] }],
    ["a decision that is too long", { version: 1, rounds: [round({ questions: [q(1, { decision: "x".repeat(1001) })] })] }],
    ["21 questions", { version: 1, rounds: [round({ questions: Array.from({ length: 21 }, (_, i) => q(i)) })] }],
    ["a string issue", { version: 1, rounds: [round({ issue: "12" })] }],
    ["a bad id", { version: 1, rounds: [round({ id: "xyz" })] }],
    ["a bad time", { version: 1, rounds: [round({ at: "never" })] }],
    ["a gave_up round with questions", { version: 1, rounds: [round({ outcome: "gave_up" })] }],
    ["a went_on round without questions", { version: 1, rounds: [round({ questions: [] })] }],
    ["a negative question number", { version: 1, rounds: [round({ questions: [q(-1)] })] }],
  ];
  it.each(bad)("ignores %s with one log line", (_name, rec) => {
    put(rec);
    const { value, log } = read();
    expect(value).toBeUndefined();
    expect(log).toHaveLength(1);
    expect(log[0]).toContain("decided.json ignored");
  });

  it("ignores a file longer than the byte limit, also when the start is valid JSON", () => {
    put(JSON.stringify({ version: 1, rounds: [] }) + " ".repeat(LIMITS.bytes) + "x");
    const { value, log } = read();
    expect(value).toBeUndefined();
    expect(log).toHaveLength(1);
    expect(log[0]).toContain("decided.json ignored");
  });

  it("does not follow a link", () => {
    mkdirSync(join(dir, "o"));
    writeFileSync(join(dir, "o", "x.json"), JSON.stringify({ version: 1, rounds: [round()] }));
    symlinkSync(join(dir, "o", "x.json"), join(dir, DECIDED_FILE));
    expect(read().value).toBeUndefined();
  });

  it("reads what the writer committed, at every limit with 20 questions", () => {
    const questions = Array.from({ length: LIMITS.decided }, (_, i) => ({
      n: i + 1, title: "t".repeat(LIMITS.title - 3) + String(i).padStart(3, "0"), text: "x".repeat(LIMITS.text), decision: "d".repeat(LIMITS.decision),
    }));
    const id = decideRound(dir, { issue: 7, source: "planner", outcome: "went_on", questions });
    expect(commitPending(dir, id)).toBe(true);
    const { value, log } = read();
    expect(log).toEqual([]);
    expect(value).toHaveLength(1);
    expect(value![0]!.questions).toEqual(questions);
    expect(value![0]!.id).toBe(id);
  });
});

describe("userRun", () => {
  it("does not show the decided questions", () => {
    const s = { runId: "r1", flow: "f", task: "", status: "succeeded", startedAt: "2026-10-18T00:00:00Z", vars: {}, history: [], state: { next: null }, decidedQuestions: [round()] };
    expect(userRun(s as never)).not.toHaveProperty("decidedQuestions");
  });
});
