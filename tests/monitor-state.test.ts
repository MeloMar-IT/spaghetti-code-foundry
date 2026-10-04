import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Finding, StoryRef } from "../src/monitor/findings.js";
import { buildingStories, byUrgency, findingState, madeToday, withStory } from "../src/monitor/state.js";

const T = "acme/app";
const at = (d: number) => new Date(2026, 9, d, 12, 0, 0).toISOString();
const story = (over: Partial<StoryRef> = {}): StoryRef => ({ repo: T, issue: 7, url: "https://github.com/acme/app/issues/7", at: at(1), seen: 1, ...over });
const f = (over: Partial<Finding> = {}): Finding => ({
  detector: "d", fingerprint: "d|a", severity: "major", summary: "s", about: "foundry", evidence: {}, firstSeen: at(1), lastSeen: at(1), count: 1, gone: false, ...over,
});
const state = (x: Finding, o: Parameters<typeof findingState>[1] = { target: T }) => findingState(x, o);

describe("findingState", () => {
  it("gone wins over a mute, needsYou and an open story", () => {
    expect(state(f({ gone: true, needsYou: at(1), report: story() }), { target: T, muted: true })).toBe("gone");
  });
  it("an admin mute gives muted, also with an open story", () => {
    expect(state(f({ report: story() }), { target: T, muted: true })).toBe("muted");
  });
  it("needs-you for a closed story and for a not-planned story with needsYou", () => {
    expect(state(f({ needsYou: at(2), report: story({ closedAt: at(2) }) }))).toBe("needs-you");
    expect(state(f({ needsYou: at(2), report: story({ muted: true }) }))).toBe("needs-you");
  });
  it("without report_to a finding with needsYou is seen", () => {
    expect(state(f({ needsYou: at(2) }), {})).toBe("seen");
  });
  it("seen for no story, a story elsewhere and no target", () => {
    expect(state(f())).toBe("seen");
    expect(state(f({ report: story({ repo: "other/repo" }) }))).toBe("seen");
    expect(state(f({ report: story() }), {})).toBe("seen");
  });
  it("an open story is waiting, or building", () => {
    expect(state(f({ report: story() }))).toBe("waiting");
    expect(state(f({ report: story() }), { target: T, building: true })).toBe("building");
  });
  it("a story closed as not planned is muted", () => {
    expect(state(f({ report: story({ muted: true }) }))).toBe("muted");
  });
  it("a closed story is fixed-watching, or came-back after new proof", () => {
    expect(state(f({ report: story({ closedAt: at(2) }) }))).toBe("fixed-watching");
    expect(state(f({ report: story({ closedAt: at(2), clockAt: at(3) }) }))).toBe("fixed-watching");
    expect(state(f({ report: story({ closedAt: at(2), fixedAt: at(4) }) }))).toBe("fixed-watching");
    expect(state(f({ report: story({ closedAt: at(2), clockAt: at(3), seenAfter: at(4) }) }))).toBe("came-back");
  });
  it("compares the repository without case", () => {
    expect(state(f({ report: story({ repo: "ACME/App" }) }))).toBe("waiting");
  });
});

describe("buildingStories", () => {
  it("keeps active runs with a repository and a numeric issue", () => {
    const runs: Record<string, { vars?: Record<string, string> } | undefined> = {
      a: { vars: { github_repo: "Acme/App", issue: "7" } },
      b: { vars: { github_repo: "acme/app" } },
      c: { vars: { github_repo: "acme/app", issue: "x" } },
    };
    const set = buildingStories({
      queue: () => ({ active: [{ runId: "a" }, { runId: "b" }, { runId: "c" }, { runId: "d" }] }),
      get: (id) => {
        if (id === "d") throw new Error("broken");
        return runs[id];
      },
    });
    expect([...set]).toEqual(["acme/app#7"]);
  });
});

describe("byUrgency", () => {
  it("puts gone last, then severity, then the newest", () => {
    const list = [f({ fingerprint: "1", gone: true, severity: "critical" }), f({ fingerprint: "2", severity: "minor", lastSeen: at(9) }), f({ fingerprint: "3", severity: "critical", lastSeen: at(2) }), f({ fingerprint: "4", severity: "critical", lastSeen: at(5) })];
    expect(list.sort(byUrgency).map((x) => x.fingerprint)).toEqual(["4", "3", "2", "1"]);
  });
});

describe("madeToday", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "made-today-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const line = (day: number, event = "story-made", fp = "x") => JSON.stringify({ at: at(day), event, fingerprint: fp });

  it("counts the story-made lines of today in both files, each line once", () => {
    writeFileSync(join(dir, "a.jsonl"), [line(5), line(5), line(4), line(5, "story-skipped"), "not json"].join("\n"));
    writeFileSync(join(dir, "b.jsonl"), [line(5, "story-made", "y"), line(6)].join("\n"));
    expect(madeToday(new Date(2026, 9, 5, 15, 0, 0), [join(dir, "a.jsonl"), join(dir, "b.jsonl")])).toBe(3);
  });
  it("is 0 for missing files", () => {
    expect(madeToday(new Date(), [join(dir, "none.jsonl")])).toBe(0);
  });
});

describe("withStory", () => {
  const changed = f({ report: story(), tries: 1 });
  it("keeps the other fields of the newest record and clears what the story settles", () => {
    const newest = [f({ count: 9, lastSeen: at(8), due: at(2), skipped: ["day_limit"], needsYou: at(3) }), f({ fingerprint: "d|b", count: 4 })];
    const out = withStory(newest, changed);
    expect(out[0]).toMatchObject({ count: 9, lastSeen: at(8), tries: 1, report: story() });
    expect(out[0]).not.toHaveProperty("due");
    expect(out[0]).not.toHaveProperty("skipped");
    expect(out[0]).not.toHaveProperty("needsYou");
    expect(out[1]).toEqual(newest[1]);
  });
  it("appends a record that is missing", () => {
    const out = withStory([f({ fingerprint: "d|b" })], changed);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ fingerprint: "d|a", tries: 1 });
  });
});
