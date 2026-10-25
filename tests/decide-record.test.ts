import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error a plain ES module of the tools folder, without types
import { LIMITS, abandonPending, checkRound, commitPending, decideRound, normaliseTitle, readRecord, roundId } from "../tools/decide-questions.mjs";

describe("the run record", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "decide-rec-")); });
  afterEach(() => { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }); });

  const qs = (n = 1, over: Record<string, unknown> = {}) => Array.from({ length: n }, (_, i) => ({ n: i + 1, title: `Which db ${i + 1}?`, text: `text ${i + 1}`, decision: "pg", ...over }));
  const rd = (over: Record<string, unknown> = {}) => ({ issue: 7, source: "planner", outcome: "went_on", questions: qs(2), ...over });
  const pendingPath = () => join(dir, "decided-pending.json");
  const recordPath = () => join(dir, "decided.json");
  const pendingAt = () => JSON.parse(readFileSync(pendingPath(), "utf8")).round.at;

  it("writes only the pending file, and the record on commit", () => {
    const id = decideRound(dir, rd());
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(existsSync(recordPath())).toBe(false);
    expect(commitPending(dir, id)).toBe(true);
    expect(existsSync(pendingPath())).toBe(false);
    const rec = readRecord(dir);
    expect(rec.rounds).toHaveLength(1);
    expect(rec.rounds[0]).toMatchObject({ id, issue: 7, source: "planner", outcome: "went_on" });
  });

  it("commits once: a second call, another ID and no pending file append nothing", () => {
    expect(commitPending(dir, "0000000000000000")).toBe(false);
    const id = decideRound(dir, rd());
    expect(commitPending(dir, "0000000000000000")).toBe(false);
    expect(existsSync(pendingPath())).toBe(true);
    expect(readRecord(dir).rounds).toHaveLength(0);
    expect(commitPending(dir, id)).toBe(true);
    expect(commitPending(dir, id)).toBe(false);
    expect(readRecord(dir).rounds).toHaveLength(1);
  });

  it("gives the same ID for the same input and another for a changed one", () => {
    const base = roundId(7, "planner", "went_on", qs(2));
    expect(roundId(7, "planner", "went_on", qs(2))).toBe(base);
    expect(roundId(8, "planner", "went_on", qs(2))).not.toBe(base);
    expect(roundId(7, "epic", "went_on", qs(2))).not.toBe(base);
    expect(roundId(7, "planner", "asked", qs(2))).not.toBe(base);
    expect(roundId(7, "planner", "went_on", qs(2, { decision: "sqlite" }))).not.toBe(base);
  });

  it("keeps the ID and `at` when the same round is decided again; another round replaces the pending file", () => {
    const id = decideRound(dir, rd(), new Date("2026-01-01T00:00:00Z"));
    expect(decideRound(dir, rd(), new Date("2026-02-01T00:00:00Z"))).toBe(id);
    expect(pendingAt()).toBe("2026-01-01T00:00:00.000Z");
    const other = decideRound(dir, rd({ issue: 8 }), new Date("2026-03-01T00:00:00Z"));
    expect(other).not.toBe(id);
    expect(pendingAt()).toBe("2026-03-01T00:00:00.000Z");
    expect(commitPending(dir, id)).toBe(false);
  });

  it("after a commit, deciding the same round again keeps `at` and a commit appends nothing", () => {
    const id = decideRound(dir, rd(), new Date("2026-01-01T00:00:00Z"));
    commitPending(dir, id);
    expect(decideRound(dir, rd(), new Date("2026-05-01T00:00:00Z"))).toBe(id);
    expect(pendingAt()).toBe("2026-01-01T00:00:00.000Z");
    expect(commitPending(dir, id)).toBe(false);
    expect(readRecord(dir).rounds).toHaveLength(1);
    expect(existsSync(pendingPath())).toBe(false);
  });

  it("never writes through a link planted at the old temporary name", () => {
    const target = join(dir, "target.txt");
    writeFileSync(target, "keep");
    symlinkSync(target, join(dir, `decided-pending.json.${process.pid}.tmp`));
    symlinkSync(target, join(dir, `decided.json.${process.pid}.tmp`));
    const id = decideRound(dir, rd());
    expect(commitPending(dir, id)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("keep");
  });

  it("abandons a pending file", () => {
    decideRound(dir, rd());
    expect(abandonPending(dir)).toBe(true);
    expect(existsSync(pendingPath())).toBe(false);
    expect(abandonPending(dir)).toBe(false);
  });

  it("stores a gave_up round without questions, with an ID of its own", () => {
    const id = decideRound(dir, rd({ outcome: "gave_up" }));
    expect(id).not.toBe(roundId(7, "planner", "went_on", qs(2)));
    commitPending(dir, id);
    expect(readRecord(dir).rounds[0].questions).toEqual([]);
  });

  it("accepts an asked round without decisions", () => {
    const id = decideRound(dir, rd({ outcome: "asked", questions: [] }));
    expect(commitPending(dir, id)).toBe(true);
    expect(readRecord(dir).rounds[0].questions).toEqual([]);
  });

  const over: [string, Record<string, unknown>][] = [
    ["21 questions", { questions: qs(21) }],
    ["a title of 301 characters", { questions: qs(1, { title: "x".repeat(301) }) }],
    ["a tab in a title", { questions: qs(1, { title: "a\tb" }) }],
    ["a text of 4001 characters", { questions: qs(1, { text: "x".repeat(4001) }) }],
    ["a decision of 1001 characters", { questions: qs(1, { decision: "x".repeat(1001) }) }],
    ["a string issue", { issue: "7" }],
    ["issue 0", { issue: 0 }],
    ["an unknown source", { source: "me" }],
    ["an unknown outcome", { outcome: "done" }],
    ["went_on without questions", { questions: [] }],
  ];
  it.each(over)("throws for %s and writes nothing", (_n, o) => {
    expect(() => decideRound(dir, rd(o))).toThrow(/decided:/);
    expect(existsSync(pendingPath())).toBe(false);
  });

  it("accepts every limit exactly", () => {
    const full = Array.from({ length: LIMITS.decided }, (_, i) => ({ n: i, title: "t".repeat(LIMITS.title), text: "x".repeat(LIMITS.text), decision: "d".repeat(LIMITS.decision) }));
    const id = decideRound(dir, rd({ questions: full }));
    expect(commitPending(dir, id)).toBe(true);
    expect(readRecord(dir).rounds[0].questions).toEqual(full);
  });

  const filled = (n: number) => ({
    version: 1,
    rounds: Array.from({ length: n }, (_, i) => ({ id: String(i).padStart(16, "0"), issue: 1, at: "2026-01-01T00:00:00.000Z", source: "planner", outcome: "asked", questions: [] })),
  });

  it("accepts 500 rounds, and refuses a 501st before anything is written", () => {
    writeFileSync(recordPath(), JSON.stringify(filled(LIMITS.rounds - 1)));
    const id = decideRound(dir, rd());
    expect(commitPending(dir, id)).toBe(true);
    expect(readRecord(dir).rounds).toHaveLength(LIMITS.rounds);
    const before = readFileSync(recordPath(), "utf8");
    expect(() => decideRound(dir, rd({ issue: 9 }))).toThrow(/500 rounds/);
    expect(existsSync(pendingPath())).toBe(false);
    expect(readFileSync(recordPath(), "utf8")).toBe(before);
  });

  it("lets a committed round be retried when the record is full", () => {
    writeFileSync(recordPath(), JSON.stringify(filled(LIMITS.rounds - 1)));
    const id = decideRound(dir, rd());
    commitPending(dir, id);
    expect(decideRound(dir, rd())).toBe(id);
    expect(commitPending(dir, id)).toBe(false);
    expect(readRecord(dir).rounds).toHaveLength(LIMITS.rounds);
  });

  it("refuses a round that would pass the byte limit, and lets a committed one be retried", () => {
    const big = (issue: number) => rd({ issue, questions: Array.from({ length: LIMITS.decided }, (_, i) => ({ n: i, title: "t", text: "x".repeat(LIMITS.text), decision: "d".repeat(LIMITS.decision) })) });
    let threw = false;
    let last: [number, string] | undefined;
    for (let issue = 1; issue < 40 && !threw; issue++) {
      try {
        const id = decideRound(dir, big(issue));
        commitPending(dir, id);
        last = [issue, id];
      } catch (e) {
        threw = true;
        expect(String(e)).toMatch(/bytes/);
      }
    }
    expect(threw).toBe(true);
    expect(Buffer.byteLength(readFileSync(recordPath(), "utf8"))).toBeLessThanOrEqual(LIMITS.bytes);
    expect(decideRound(dir, big(last![0]))).toBe(last![1]);
    expect(commitPending(dir, last![1])).toBe(false);
  });

  it("throws on a corrupt record", () => {
    const id = decideRound(dir, rd());
    writeFileSync(recordPath(), "{nope");
    expect(() => commitPending(dir, id)).toThrow(/not valid/);
    expect(() => decideRound(dir, rd())).toThrow(/not valid/);
  });

  it("throws when the record cannot be written", () => {
    const id = decideRound(dir, rd());
    mkdirSync(recordPath());
    expect(() => commitPending(dir, id)).toThrow();
  });

  describe("checkRound", () => {
    const r = (outcome: string, extra: Record<string, unknown> = {}) => ({ issue: 7, source: "planner", outcome, questions: outcome === "gave_up" ? [] : [{ title: `old ${outcome} ${Object.keys(extra).length} ${String(extra.source)}` }], ...extra });
    const rec = (...rounds: unknown[]) => ({ version: 1, rounds });
    const all = { decided: [{ title: "New thing" }], left: 0 };
    const some = { decided: [{ title: "New thing" }], left: 1 };

    it("gives up on the third planner round in a row that decides everything", () => {
      expect(checkRound(rec(r("went_on"), r("went_on")), 7, "planner", all)).toBe("gave_up");
      expect(checkRound(rec(r("went_on"), r("went_on")), 7, "planner", some)).toBe("asked");
      expect(checkRound(rec(r("went_on")), 7, "planner", all)).toBe("went_on");
    });
    it("starts the streak again after an asked or gave_up round", () => {
      expect(checkRound(rec(r("went_on"), r("went_on"), r("asked"), r("went_on")), 7, "planner", all)).toBe("went_on");
      expect(checkRound(rec(r("went_on"), r("went_on"), r("gave_up"), r("went_on")), 7, "planner", all)).toBe("went_on");
    });
    it("counts the issues apart", () => {
      expect(checkRound(rec(r("went_on"), r("went_on")), 8, "planner", all)).toBe("went_on");
    });
    it("skips an epic round that went on, but an epic asked or gave_up round resets", () => {
      expect(checkRound(rec(r("went_on"), r("went_on", { source: "epic" }), r("went_on")), 7, "planner", all)).toBe("gave_up");
      expect(checkRound(rec(r("went_on"), r("went_on"), r("asked", { source: "epic" })), 7, "planner", all)).toBe("went_on");
      expect(checkRound(rec(r("went_on"), r("went_on"), r("gave_up", { source: "epic" })), 7, "planner", all)).toBe("went_on");
    });
    it("does not apply the streak to an epic round", () => {
      expect(checkRound(rec(r("went_on"), r("went_on")), 7, "epic", all)).toBe("went_on");
    });
    it("gives up on a repeated title, in any case or punctuation, from any round", () => {
      const old = (source: string, outcome: string) => ({ issue: 7, source, outcome, questions: [{ title: "Which DB?" }] });
      const again = { decided: [{ title: "which db" }], left: 1 };
      expect(checkRound(rec(old("planner", "asked")), 7, "planner", again)).toBe("gave_up");
      expect(checkRound(rec(old("epic", "went_on")), 7, "epic", again)).toBe("gave_up");
      expect(checkRound(rec(old("planner", "asked")), 8, "planner", again)).toBe("asked");
    });
    it("does not match an empty title, and works without a record", () => {
      const blank = { issue: 7, source: "planner", outcome: "asked", questions: [{ title: "" }] };
      expect(checkRound(rec(blank), 7, "planner", { decided: [{ title: "?" }], left: 0 })).toBe("went_on");
      expect(checkRound(undefined, 7, "planner", all)).toBe("went_on");
      expect(checkRound(undefined, 7, "planner", some)).toBe("asked");
      expect(checkRound(undefined, 7, "planner", { decided: [], left: 2 })).toBe("asked");
    });
    it("normalises titles", () => {
      expect(normaliseTitle("  Which  DB?! ")).toBe("which db");
    });
  });
});
