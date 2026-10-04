import { describe, expect, it } from "vitest";
import { evidenceLines, mergeFindings, type Finding, type StoryRef } from "../src/monitor/findings.js";
import { checkFixes, tryAgain, triesOf, waitsForPerson } from "../src/monitor/fix.js";
import { describeEntry, logLine } from "../src/monitor/guard.js";

const T = "2026-10-01T10:00:00.000Z";
const story = (o: Partial<StoryRef> = {}): StoryRef => ({ repo: "acme/app", issue: 7, url: "https://github.com/acme/app/issues/7", at: T, seen: 1, ...o });
const finding = (o: Partial<Finding> = {}): Finding => ({
  detector: "d", fingerprint: "fp", severity: "major", summary: "It breaks.", evidence: {}, about: "foundry",
  firstSeen: T, lastSeen: T, count: 2, gone: false, ...o,
});

describe("triesOf", () => {
  it("counts a story from before the count as one", () => {
    expect(triesOf({})).toBe(0);
    expect(triesOf({ report: story() })).toBe(1);
    expect(triesOf({ report: story({ fixedAt: T }) })).toBe(0);
    expect(triesOf({ tries: 0, report: story() })).toBe(0);
    expect(triesOf({ tries: 2, report: story() })).toBe(2);
  });
});

describe("waitsForPerson", () => {
  const closed = story({ closedAt: T });
  it("is true for a closed story, a story closed as not planned and no story in the target", () => {
    expect(waitsForPerson(finding({ needsYou: T, report: closed }), "acme/app")).toBe(true);
    expect(waitsForPerson(finding({ needsYou: T, report: story({ muted: true }) }), "acme/app")).toBe(true);
    expect(waitsForPerson(finding({ needsYou: T }), "acme/app")).toBe(true);
    expect(waitsForPerson(finding({ needsYou: T, report: closed }), "ACME/app")).toBe(true);
  });
  it("is false without the mark, when gone, without a target, and for an open or fixed story", () => {
    expect(waitsForPerson(finding({ report: closed }), "acme/app")).toBe(false);
    expect(waitsForPerson(finding({ needsYou: T, gone: true }), "acme/app")).toBe(false);
    expect(waitsForPerson(finding({ needsYou: T }), undefined)).toBe(false);
    expect(waitsForPerson(finding({ needsYou: T, report: story() }), "acme/app")).toBe(false);
    expect(waitsForPerson(finding({ needsYou: T, report: story({ closedAt: T, fixedAt: T }) }), "acme/app")).toBe(false);
  });
});

describe("tryAgain", () => {
  it("starts the count anew and keeps the rest", () => {
    const f = finding({ tries: 2, needsYou: T, report: story({ closedAt: T }) });
    const r = tryAgain(f);
    expect(r.tries).toBe(0);
    expect(r.needsYou).toBeUndefined();
    expect(r.report).toBe(f.report);
    expect(r.summary).toBe(f.summary);
  });
});

describe("fixed starts a new count", () => {
  it("sets the tries back to 0", () => {
    const clock = "2026-10-01T11:00:00.000Z";
    const f = finding({ tries: 2, needsYou: T, lastSeen: T, report: story({ closedAt: T, clockAt: clock, workedMs: 23 * 3_600_000 }) });
    const now = new Date("2026-10-02T12:00:00.000Z");
    const r = checkFixes([f], { target: "acme/app", now, waitDays: 7, worked: 2 * 3_600_000 });
    expect(r.events.map((e) => e.event)).toEqual(["fixed"]);
    expect(r.findings[0]!.tries).toBe(0);
    expect(r.findings[0]!.needsYou).toBeUndefined();
    expect(r.findings[0]!.report!.fixedAt).toBeDefined();
  });
});

describe("mergeFindings and the two fields", () => {
  const input = { detector: "d", fingerprint: "fp", severity: "major" as const, summary: "It breaks.", evidence: {}, about: "foundry" as const };
  it("carries tries (also 0) and needsYou for a finding that is seen again and for one that was gone", () => {
    for (const gone of [false, true]) {
      const stored = finding({ tries: 0, needsYou: T, gone });
      const out = mergeFindings([stored], [input], new Date("2026-10-02T10:00:00.000Z")).findings[0]!;
      expect(out.tries).toBe(0);
      expect(out.needsYou).toBe(T);
    }
  });
  it("keeps a gone finding that needs a person for good", () => {
    const old = new Date("2026-08-01T10:00:00.000Z").toISOString();
    const now = new Date("2026-10-02T10:00:00.000Z");
    const kept = mergeFindings([finding({ gone: true, lastSeen: old, needsYou: T }), finding({ fingerprint: "other", gone: true, lastSeen: old })], [], now);
    expect(kept.findings.map((f) => f.fingerprint)).toEqual(["fp"]);
  });
  it("does not count it in the 500", () => {
    const many = Array.from({ length: 501 }, (_, i) => finding({ fingerprint: `p${i}`, lastSeen: T }));
    const out = mergeFindings([...many, finding({ gone: true, needsYou: T })], [], new Date("2026-10-01T11:00:00.000Z"));
    expect(out.findings.some((f) => f.fingerprint === "fp")).toBe(true);
    expect(out.dropped).toBe(1);
  });
});

describe("evidenceLines", () => {
  it("gives labelled lines in order, with one Counts line", () => {
    expect(evidenceLines({ flows: ["x"], counts: { a: 1, b: 2 }, times: [T], lines: ["one"] })).toEqual(["Flows: x", "Counts: a 1, b 2", `Times: ${T}`, "one"]);
  });
  it("keeps to its limits", () => {
    const n = (k: number) => Array.from({ length: k }, (_, i) => `v${i}`);
    const counts = Object.fromEntries(n(20).map((k) => [k, 1]));
    const lines = evidenceLines({ flows: n(8), counts, times: n(9), steps: n(9), lines: n(9), watchers: n(9) });
    expect(lines.length).toBeLessThanOrEqual(11);
    expect(lines.find((l) => l.startsWith("Counts"))!.split(",").length).toBe(6);
  });
  it("cuts long lines, drops bad counts and survives bad input", () => {
    expect(evidenceLines({ lines: ["x".repeat(500)] })[0]!.length).toBe(200);
    expect(evidenceLines({ counts: { "a b": 1, "": 1, ["k".repeat(60)]: 1, c: "3" as unknown as number, d: null as unknown as number, e: Infinity } })).toEqual([]);
    expect(evidenceLines({ counts: "x" as never })).toEqual([]);
    expect(evidenceLines({ counts: [1, 2] as never })).toEqual([]);
    expect(evidenceLines({ lines: [1, null] as never })).toEqual([]);
    expect(evidenceLines({ lines: ["a\nb\u0007c"] })).toEqual(["a b c"]);
    expect(evidenceLines(undefined)).toEqual([]);
  });
});

describe("the log", () => {
  it("describes try-again and the two_tries skip, and keeps by", () => {
    expect(describeEntry({ event: "try-again", detector: "d" })).toContain("try again");
    expect(describeEntry({ event: "story-skipped", reason: "two_tries", detector: "d", issue: 7 })).toContain("two bug stories did not fix it");
    expect(JSON.parse(logLine({ event: "try-again", by: "cli" }, new Date(T)))).toMatchObject({ event: "try-again", by: "cli" });
  });
});
