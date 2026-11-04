import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import {
  blockersClearable, buildGapLedger, gapIssueText, gapIssuesOf, gapLinkSentence, gapLinksFor, gapMarker, isSkillGapStop, newGapCount, openGapCount,
  openGapIssues, planGapIssues, readGapLedger, skillGapReady, unknownTopicIds, writeGapLedger, GAP_MARKER_RE,
} from "../src/skills/gap-issues.js";
import type { GapSignal } from "../src/skills/gap-signals.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
const NOW = Date.parse("2026-11-04T12:00:00Z");
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const tmp = mkdtempSync(join(tmpdir(), "gap-issues-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const sig = (topic: string, o: Partial<GapSignal> = {}): GapSignal => ({
  topic, kind: "technology", repo: "acme/app", at: NOW,
  evidence: { runs: ["r1", "r2"], findingKinds: [], technology: { name: topic, version: "20.1.0" } }, ...o,
});
let n = 100;
const issue = (topic: string, o: { state?: string; ageDays?: number; closedDaysAgo?: number; number?: number; body?: string; pr?: boolean } = {}): any => ({
  number: o.number ?? ++n, state: o.state ?? "open", title: "t", html_url: `https://github.com/lib/skills/issues/${o.number ?? n}`,
  created_at: iso(NOW - (o.ageDays ?? 40) * DAY), labels: [],
  closed_at: o.closedDaysAgo === undefined ? null : iso(NOW - o.closedDaysAgo * DAY),
  body: o.body ?? `text\n${gapMarker(topic)}`, ...(o.pr ? { pull_request: {} } : {}),
});
const O = { now: NOW, maxOpen: 5, maxPerDay: 3 };
const plan = (signals: GapSignal[], issues: any[], o = O) => planGapIssues(signals, gapIssuesOf(issues), o);

describe("marker and index", () => {
  it("round trips and ignores pull requests", () => {
    expect(GAP_MARKER_RE.exec(gapMarker("nodejs-testing"))?.[1]).toBe("nodejs-testing");
    expect(gapIssuesOf([issue("x", { pr: true })]).all).toEqual([]);
  });
  it("an open issue wins over a closed one, the lowest open number first", () => {
    const g = gapIssuesOf([issue("a", { state: "closed", closedDaysAgo: 2, number: 1 }), issue("a", { number: 7 }), issue("a", { number: 5 })]);
    expect(g.byTopic.get("a")).toMatchObject({ number: 5, open: true });
    expect(g.all).toHaveLength(3);
  });
});

describe("planGapIssues", () => {
  it("skips a topic with an open issue", () => {
    expect(plan([sig("a")], [issue("a")])).toMatchObject({ open: [], skipped: [{ topic: "a", reason: "open" }] });
  });
  it("skips a recently closed topic and opens one closed over 30 days ago", () => {
    expect(plan([sig("a")], [issue("a", { state: "closed", closedDaysAgo: 10 })]).skipped[0]!.reason).toBe("closed-recently");
    expect(plan([sig("a")], [issue("a", { state: "closed", closedDaysAgo: 31 })]).open.map((s) => s.topic)).toEqual(["a"]);
  });
  it("max_open and max_per_day are never exceeded", () => {
    const five = Array.from({ length: 5 }, (_, i) => issue(`t${i}`));
    expect(plan([sig("new")], five).skipped[0]!.reason).toBe("max-open");
    expect(plan([sig("new")], [], { ...O, maxPerDay: 0 }).open).toEqual([]);
    const many = ["a", "b", "c", "d", "e"].map((t) => sig(t));
    expect(plan(many, []).open).toHaveLength(3);
    expect(plan(many, [], { ...O, maxOpen: 2 }).open).toHaveLength(2);
  });
  it("counts duplicate markers and a reopened older issue", () => {
    const dup = [issue("a", { number: 1 }), issue("a", { number: 2 }), issue("b", { number: 3 })];
    expect(openGapCount(gapIssuesOf(dup).all)).toBe(3);
    expect(plan([sig("c")], dup, { ...O, maxOpen: 3 }).skipped[0]!.reason).toBe("max-open");
    const recent = [issue("a", { ageDays: 0.1 }), issue("b", { ageDays: 0.2 }), issue("old", { ageDays: 90 })];
    expect(newGapCount(gapIssuesOf(recent).all, NOW)).toBe(2);
    expect(plan([sig("c"), sig("d")], recent).open).toHaveLength(1);
  });
});

describe("issue text", () => {
  it("has the sections, only the evidence repository and the marker last", () => {
    const { title, body } = gapIssueText(sig("nodejs"));
    expect(title).toBe("Skill gap: nodejs");
    for (const h of ["### What to teach", "### Evidence", "### Sample tasks"]) expect(body).toContain(h);
    expect(body).toContain("`r1`");
    expect(body).toContain("version `20.1.0`");
    expect(body).toContain("`acme/app`");
    expect(body.trimEnd().endsWith(gapMarker("nodejs"))).toBe(true);
    expect(body.replace(/`acme\/app`/g, "")).not.toMatch(/\/[\w.-]+\/|[A-Za-z]:\\/);
  });
});

describe("openGapIssues", () => {
  const store = (issues: any[], cut = false) => {
    const calls = { labels: [] as string[], created: [] as any[] };
    return {
      calls,
      listAll: async () => ({ issues, cut }),
      createLabelIfMissing: async (name: string) => void calls.labels.push(name),
      create: async (o: any) => { calls.created.push(o); return { number: 900 + calls.created.length, html_url: `https://github.com/lib/skills/issues/${900 + calls.created.length}` } as any; },
    };
  };
  const base = { label: "Factory_go", maxOpen: 5, maxPerDay: 3, now: NOW };
  it("creates the label and the issues with it", async () => {
    const s = store([]);
    const r = await openGapIssues({ ...base, store: s as any, signals: [sig("a"), sig("b")] });
    expect(s.calls.labels).toEqual(["Factory_go"]);
    expect(s.calls.created.map((c) => c.labels)).toEqual([["Factory_go"], ["Factory_go"]]);
    expect(r.made.map((m) => m.topic)).toEqual(["a", "b"]);
    expect(r.byTopic.get("a")).toMatchObject({ open: true, number: 901 });
  });
  it("creates nothing when the list is cut", async () => {
    const s = store([], true);
    const r = await openGapIssues({ ...base, store: s as any, signals: [sig("a")] });
    expect(r.cut).toBe(true);
    expect(s.calls.created).toEqual([]);
    expect(s.calls.labels).toEqual([]);
  });
  it("stops at a failing create", async () => {
    const s = { ...store([]), create: async () => { throw new Error("no"); } };
    const r = await openGapIssues({ ...base, store: s as any, signals: [sig("a"), sig("b")] });
    expect(r).toMatchObject({ failed: true, made: [] });
  });
});

describe("ledger", () => {
  it("reads a broken or missing file as empty", () => {
    const f = join(tmp, "broken.json");
    writeFileSync(f, "{not json");
    expect(readGapLedger(f, "lib/skills").topics).toEqual({});
    expect(readGapLedger(join(tmp, "none.json"), "lib/skills").topics).toEqual({});
  });
  it("writes atomically and ignores an entry for another repository", () => {
    const f = join(tmp, "ok.json");
    const byTopic = gapIssuesOf([issue("a", { number: 4 })]).byTopic;
    writeGapLedger(buildGapLedger("Lib/Skills", byTopic, NOW), f);
    expect(readdirSync(tmp).filter((x) => x.endsWith(".tmp"))).toEqual([]);
    expect(readGapLedger(f, "lib/skills").topics.a).toMatchObject({ issue: 4, state: "open" });
    expect(readGapLedger(f, "other/repo").topics).toEqual({});
    expect(JSON.parse(readFileSync(f, "utf8")).repository).toBe("lib/skills");
  });
  it("links only ids it has, in a fixed sentence", () => {
    const l = gapLinksFor(["a", "zzz"], buildGapLedger("lib/skills", gapIssuesOf([issue("a", { number: 4 })]).byTopic, NOW));
    expect(l).toHaveLength(1);
    expect(gapLinkSentence(l)).toBe("Skill gap issue: https://github.com/lib/skills/issues/4");
  });
});

describe("stopped runs", () => {
  const stop = (unresolved: any[], o: any = {}): any => ({ status: "stopped", skillPlan: { action: "stop", unresolved }, ...o });
  const unknown = (id: string, mandatory = false) => ({ id, code: "unknown", mandatory });
  const link = [{ topic: "a", issue: 1, url: "https://github.com/lib/skills/issues/1" }];
  it("lists unknown ids and tells clearable blockers", () => {
    expect(unknownTopicIds(stop([unknown("a"), { id: "b", code: "unpinned" }]))).toEqual(["a"]);
    expect(blockersClearable(stop([unknown("a")]))).toBe(true);
    expect(blockersClearable(stop([unknown("a"), { id: "b", code: "unpinned" }]))).toBe(false);
    expect(blockersClearable(stop([unknown("a", true), { id: "b", code: "blocked" }]))).toBe(true);
    expect(blockersClearable(stop([unknown("a"), { id: "b", code: "blocked" }]))).toBe(false);
    expect(blockersClearable(stop([]))).toBe(false);
  });
  it("is a skill gap stop only with a link", () => {
    expect(isSkillGapStop(stop([unknown("a")], { skillGap: link }))).toBe(true);
    expect(isSkillGapStop(stop([unknown("a")]))).toBe(false);
    expect(isSkillGapStop(stop([unknown("a")], { skillGap: link, status: "failed" }))).toBe(false);
  });
  it("is ready once every unknown id is found, and false on an error", () => {
    const skills = ConfigSchema.parse({}).skills;
    const run = stop([unknown("a"), unknown("b", true), { id: "c", code: "blocked" }]);
    const found = (ids: string[]) => ((): any => ({ skills: ids.map((id) => ({ id, active: true })), byKey: new Map(), problems: [] }));
    expect(skillGapReady(run, skills, found(["a"]) as any)).toBe(false);
    expect(skillGapReady(run, skills, found(["a", "b"]) as any)).toBe(true);
    expect(skillGapReady(run, skills, (() => { throw new Error("x"); }) as any)).toBe(false);
  });
});
