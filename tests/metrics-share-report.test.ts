import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { shareReportFrom } from "../src/metrics-share/build.js";
import {
  CUSTOM, DEFAULT_MODEL, DURATION_EDGES_MS, KNOWN_MODELS, NO_INSTALL, SHARE_SOURCES, SHIPPED_FLOWS, SHIPPED_STEPS, ShareReportSchema, bucketOf, flowKeyOf, modelKeyOf, stepKeyOf,
} from "../src/metrics-share/report.js";
import { WATCHER_SOURCES } from "../src/telemetry/envelope.js";
import { DEFAULT_PRICES } from "../src/usage/events.js";

const empty = () => shareReportFrom({ day: "2026-11-19", accountIds: [], foundryVersion: "0.4.0", briefs: [], runs: [], watcherSources: new Map() });
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const H = () => ({ counts: new Array(DURATION_EDGES_MS.length + 1).fill(0), sum: 0 });

describe("ShareReportSchema", () => {
  it("takes an empty report with version 1 and the placeholder install id", () => {
    const r = empty();
    expect(r.version).toBe(1);
    expect(r.install).toBe(NO_INSTALL);
    expect(ShareReportSchema.safeParse(r).success).toBe(true);
    expect(ShareReportSchema.safeParse({ ...clone(r), version: 2 }).success).toBe(false);
    expect(ShareReportSchema.safeParse({ ...clone(r), version: undefined }).success).toBe(false);
  });

  it("refuses an unknown field at every level", () => {
    const paths: string[][] = [
      [], ["changes"], ["changes", "runsEnded"], ["speed"], ["speed", "runDuration"], ["splits"], ["rework"], ["quality"], ["cost"], ["use"],
    ];
    for (const p of paths) {
      const r = clone(empty()) as Record<string, unknown>;
      let o = r;
      for (const k of p) o = o[k] as Record<string, unknown>;
      o.note = "free text";
      expect(ShareReportSchema.safeParse(r).success, p.join(".") || "top").toBe(false);
    }
    const withTokens = clone(empty());
    withTokens.cost.byStep = { implement: { tokensIn: 1, tokensOut: 1, note: "x" } as never };
    expect(ShareReportSchema.safeParse(withTokens).success).toBe(false);
  });

  it("refuses a UUID, a branch, a repository, an e-mail and an empty string as a name, without a builder", () => {
    const bad = ["3f1c3c8e-8a5e-4c43-9f43-0a0e2f6b9b51", "feature/893-shared-metrics", "o/r", "someone@example.com", ""];
    const slots: ((r: ReturnType<typeof empty>, k: string) => void)[] = [
      (r, k) => void (r.speed.stepTime = { [k]: H() }),
      (r, k) => void (r.rework.repeatedSteps = { [k]: 1 }),
      (r, k) => void (r.cost.byModel = { [k]: { tokensIn: 1, tokensOut: 1 } }),
      (r, k) => void (r.cost.byStep = { [k]: { tokensIn: 1, tokensOut: 1 } }),
      (r, k) => void (r.use.bySource = { [k]: 1 }),
      (r, k) => void (r.use.byFlow = { [k]: 1 }),
    ];
    for (const slot of slots) {
      for (const k of bad) {
        const r = clone(empty());
        slot(r, k);
        expect(ShareReportSchema.safeParse(r).success, `${k}`).toBe(false);
      }
      const ok = clone(empty());
      slot(ok, slot === slots[4] ? "manual" : CUSTOM);
      expect(ShareReportSchema.safeParse(ok).success).toBe(true);
    }
  });

  it("refuses a histogram with other buckets and an install id that is not 32 hex", () => {
    const r = clone(empty());
    r.speed.runDuration.counts.push(0);
    expect(ShareReportSchema.safeParse(r).success).toBe(false);
    expect(ShareReportSchema.safeParse({ ...clone(empty()), install: "host-name" }).success).toBe(false);
  });
});

describe("the fixed lists", () => {
  it("SHIPPED_FLOWS and SHIPPED_STEPS are the names and step ids of flows/*.yaml", () => {
    const dir = join(import.meta.dirname, "..", "flows");
    const flows: string[] = [];
    const steps = new Set<string>();
    const walk = (list: unknown) => {
      for (const s of Array.isArray(list) ? list : []) {
        if (s && typeof s.id === "string") steps.add(s.id);
        if (s && Array.isArray(s.steps)) walk(s.steps);
      }
    };
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".yaml"))) {
      const y = parse(readFileSync(join(dir, f), "utf8")) as { name: string; steps: unknown };
      flows.push(y.name);
      walk(y.steps);
    }
    expect([...SHIPPED_FLOWS].sort()).toEqual(flows.sort());
    expect([...SHIPPED_STEPS].sort()).toEqual([...steps].sort());
  });

  it("KNOWN_MODELS has every model of the price table; SHARE_SOURCES every watcher source", () => {
    for (const m of Object.keys(DEFAULT_PRICES)) expect(KNOWN_MODELS as readonly string[]).toContain(m);
    for (const s of WATCHER_SOURCES) expect(SHARE_SOURCES as readonly string[]).toContain(s);
  });
});

describe("helpers", () => {
  it("bucketOf puts a value in [edge i-1, edge i)", () => {
    expect(bucketOf(0, DURATION_EDGES_MS)).toBe(0);
    expect(bucketOf(9_999, DURATION_EDGES_MS)).toBe(0);
    expect(bucketOf(10_000, DURATION_EDGES_MS)).toBe(1);
    expect(bucketOf(60_000, DURATION_EDGES_MS)).toBe(2);
    expect(bucketOf(30 * 86_400_000, DURATION_EDGES_MS)).toBe(DURATION_EDGES_MS.length);
  });

  it("keeps shipped flow and step names and known models; anything else is custom", () => {
    expect(flowKeyOf("issue-gitflow")).toBe("issue-gitflow");
    expect(flowKeyOf("my-secret-flow")).toBe(CUSTOM);
    expect(flowKeyOf(undefined)).toBe(CUSTOM);
    expect(stepKeyOf("implement", "issue-gitflow")).toBe("implement");
    expect(stepKeyOf("my_step", "issue-gitflow")).toBe(CUSTOM);
    expect(stepKeyOf("implement", "my-secret-flow")).toBe(CUSTOM);
    expect(modelKeyOf("claude:anthropic:opus")).toBe("opus");
    expect(modelKeyOf("codex:openai:gpt-5")).toBe("gpt-5");
    expect(modelKeyOf("claude:anthropic")).toBe(DEFAULT_MODEL);
    expect(modelKeyOf("claude:my-proxy:private-model-x")).toBe(CUSTOM);
    expect(modelKeyOf(undefined)).toBeUndefined();
  });
});
