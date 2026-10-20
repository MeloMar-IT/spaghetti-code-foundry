import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunSummary } from "../src/engine/state.js";
import type { EvidenceEvent } from "../src/evidence/schema.js";
import { EVIDENCE_EVENTS_FILE, EVIDENCE_INCOMPLETE_FILE, EVIDENCE_MANIFEST_FILE } from "../src/evidence/version.js";
import { readEvidenceEvents, SETTLE_MS } from "../src/monitor/slo-input.js";
import { OutcomeFactsCache, outcomeFactsOf, type OutcomeFacts } from "../src/outcome-facts.js";
import { computeOutcomes } from "../src/outcomes.js";

const T0 = Date.parse("2026-03-10T12:00:00.000Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const NOW = new Date(T0 + 100_000 + SETTLE_MS + 60_000);
const EV = { stream: true, read: true, manifest: false, incomplete: false };

let n = 0;
const ev = (type: string, sec: number, rest: object = {}, runId = "r1"): EvidenceEvent => ({ version: 3, id: `ev-${++n}`, seq: n, runId, time: at(sec), type, ...rest }) as unknown as EvidenceEvent;
const step = (id: string, type = "claude", visit = 1) => ({ id, visit, type });
const model = { agent: "claude", provider: "anthropic", model: "opus" };
const decide = (boundary: string, outcome: string, mode = "enforce", id = "p") => ev("policy.decided", 1, { decision: { policy: { id, version: "1" }, boundary, mode, outcome, reasonCode: "policy.no-rule-matched", version: 1, packSha256: "a".repeat(64), inputSha256: "b".repeat(64), evaluatedAt: at(1) }, step: step("a") });
const test = (suite: string, outcome: string, type = "step.completed") => ev(type, 2, { step: step("t"), durationMs: 1, artifacts: [], test: { suite, outcome } });
const run = (o: Partial<RunSummary> = {}): RunSummary =>
  ({ runId: "r1", flow: "f", flowDef: { steps: [{ id: "approve", type: "approval" }] }, task: "", vars: {}, repo: "", status: "succeeded", runDir: "/x", startedAt: at(0), finishedAt: at(100), totalCostUsd: 0, history: [], state: { next: null, steps: {}, visits: {} }, ...o }) as unknown as RunSummary;

beforeEach(() => {
  n = 0;
});

describe("outcomeFactsOf", () => {
  it("delivered needs a succeeded run and a push decision that is not a deny", () => {
    const f = (status: string, ...events: EvidenceEvent[]) => outcomeFactsOf(run({ status: status as RunSummary["status"] }), events, EV);
    const a = f("succeeded", decide("push", "allow"));
    expect([a.pushed, a.delivered]).toEqual([true, true]);
    const b = f("succeeded", decide("push", "deny"));
    expect([b.pushed, b.delivered]).toEqual([true, false]);
    const c = f("failed", decide("push", "allow"));
    expect([c.pushed, c.delivered]).toEqual([true, false]);
    const d = f("succeeded", decide("push", "deny"), decide("push", "allow"));
    expect([d.pushed, d.delivered]).toEqual([true, true]);
    const e = f("succeeded", decide("step.before", "allow"));
    expect([e.pushed, e.delivered]).toEqual([false, false]);
  });

  it("takes the first test that is not a baseline", () => {
    expect(outcomeFactsOf(run(), [test("baseline_tests", "passed"), test("run_tests", "failed", "step.failed"), test("later", "passed")], EV).firstTest).toBe("failed");
    expect(outcomeFactsOf(run(), [test("baseline_tests", "failed")], EV).firstTest).toBeUndefined();
    expect(outcomeFactsOf(run(), [test("build/pretest_tests", "failed"), test("unit", "passed")], EV).firstTest).toBe("passed");
  });

  it("counts policy denials and the denials of observed packs", () => {
    const denied = ev("step.denied", 3, { step: step("a"), denial: { kind: "policy", policy: { id: "p", version: "1" }, reasonCode: "x.y" } });
    const tool = ev("step.denied", 3, { step: step("a"), denial: { kind: "tool", tool: { name: "Bash" } } });
    const f = outcomeFactsOf(run(), [denied, tool, decide("step.before", "deny", "observe"), decide("step.before", "deny", "enforce")], EV);
    expect(f.policyBlocks).toBe(1);
    expect(f.observeDenies).toBe(1);
  });

  it("lists models and policies once, sorted", () => {
    const f = outcomeFactsOf(run(), [ev("step.routed", 1, { step: step("a"), model }), ev("step.completed", 2, { step: step("a"), model: { ...model, model: "haiku" }, durationMs: 1, artifacts: [] }), ev("step.routed", 3, { step: step("b"), model }), decide("push", "allow", "enforce", "q"), decide("push", "allow", "enforce", "p")], EV);
    expect(f.models).toEqual(["claude:anthropic:haiku", "claude:anthropic:opus"]);
    expect(f.policies).toEqual(["p@1", "q@1"]);
  });

  it("takes approvals and resumes from the events, and resumes from run.json without events", () => {
    const events = [ev("run.stopped", 10, { at: "approve" }), ev("run.resumed", 20, { from: "approve", by: {} }), ev("step.approved", 40, { step: step("approve", "approval"), by: {} })];
    const f = outcomeFactsOf(run({ resumes: 5 }), events, EV);
    expect(f.approvals).toEqual({ decided: 1, totalMs: 30_000, maxMs: 30_000 });
    expect(f.resumes).toBe(1);
    expect(outcomeFactsOf(run({ resumes: 5 }), [], EV).resumes).toBe(5);
    expect(outcomeFactsOf(run(), [ev("run.queued", 0)], EV).queuedAt).toBe(at(0));
  });

  it("does not throw on odd input", () => {
    expect(() => outcomeFactsOf(null as never, null as never, EV)).not.toThrow();
    expect(() => outcomeFactsOf(run(), [null, 3, { type: "policy.decided" }] as never, EV)).not.toThrow();
    expect(outcomeFactsOf(run(), "x" as never, EV).delivered).toBe(false);
  });
});

describe("files", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "outcome-facts-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const lines = (...events: EvidenceEvent[]) => `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
  const file = (d: string) => join(d, EVIDENCE_EVENTS_FILE);
  const folder = (name: string, content?: string): string => {
    const d = join(dir, name);
    mkdirSync(d, { recursive: true });
    if (content !== undefined) writeFileSync(file(d), content);
    return d;
  };

  describe("readEvidenceEvents", () => {
    const read = async (d: string, max?: number, runId = "r1") => {
      const got: EvidenceEvent[] = [];
      const status = await readEvidenceEvents(d, runId, (e) => void got.push(e), max);
      return { status, got };
    };

    it("tells a missing file, an empty file and a refused file apart", async () => {
      expect((await read(folder("none"))).status).toBe("missing");
      expect(await read(folder("empty", ""))).toEqual({ status: "read", got: [] });
      const link = folder("link");
      writeFileSync(join(dir, "real.jsonl"), lines(ev("run.queued", 0)));
      symlinkSync(join(dir, "real.jsonl"), file(link));
      expect((await read(link)).status).toBe("refused");
      const asDir = folder("asdir");
      mkdirSync(file(asDir));
      expect((await read(asDir)).status).toBe("refused");
      expect((await read(folder("big", lines(ev("run.queued", 0))), 10)).status).toBe("refused");
    });

    it("skips lines of another run and broken lines", async () => {
      const d = folder("mixed", `${lines(ev("run.queued", 0), ev("run.queued", 1, {}, "other"))}not json\n${JSON.stringify(ev("run.stopped", 2))}`);
      const r = await read(d);
      expect(r.status).toBe("read");
      expect(r.got.map((e) => e.type)).toEqual(["run.queued", "run.stopped"]);
    });

    const padded = (d: string) => {
      const pad = `${JSON.stringify(ev("run.stopped", 1, { at: "x".repeat(900) }))}\n`;
      writeFileSync(file(d), lines(ev("run.queued", 0)) + pad.repeat(400) + lines(ev("run.completed", 9)));
    };

    it("never reads past the size it checked, when the file grows", async () => {
      const d = folder("grow");
      padded(d);
      const got: string[] = [];
      let grown = false;
      const status = await readEvidenceEvents(d, "r1", (e) => {
        got.push(e.type);
        if (!grown) {
          grown = true;
          appendFileSync(file(d), lines(ev("run.failed", 10)));
        }
      });
      expect(status).toBe("read");
      expect(got[0]).toBe("run.queued");
      expect(got.at(-1)).toBe("run.completed");
      expect(got).not.toContain("run.failed");
    });

    it("reads the file it opened, when the path is replaced", async () => {
      const d = folder("swap");
      padded(d);
      const got: string[] = [];
      let swapped = false;
      await readEvidenceEvents(d, "r1", (e) => {
        got.push(e.type);
        if (!swapped) {
          swapped = true;
          writeFileSync(join(d, "new.jsonl"), lines(ev("run.failed", 10)));
          renameSync(join(d, "new.jsonl"), file(d));
        }
      });
      expect(got.at(-1)).toBe("run.completed");
      expect(got).not.toContain("run.failed");
    });
  });

  describe("OutcomeFactsCache", () => {
    const ended = (d: string, o: Partial<RunSummary> = {}) => run({ runDir: d, runId: "r1", ...o });
    const counting = () => {
      const c = { reads: 0 };
      const reader: typeof readEvidenceEvents = (d, id, take, max) => {
        c.reads++;
        return readEvidenceEvents(d, id, take, max);
      };
      return { c, reader };
    };
    const delivered = () => lines(ev("run.queued", 0), decide("push", "allow"));

    it("reads once per updatedAt, even when the file changes, and again for a new updatedAt", async () => {
      const d = folder("a", delivered());
      const { c, reader } = counting();
      const cache = new OutcomeFactsCache({ reader });
      const r = ended(d);
      const first = await cache.get(r, "u1", NOW);
      expect(first).toMatchObject({ delivered: true, evidence: { stream: true, read: true } });
      writeFileSync(file(d), lines(ev("run.queued", 0)));
      expect((await cache.get(r, "u1", NOW))?.delivered).toBe(true);
      expect(c.reads).toBe(1);
      expect((await cache.get(r, "u2", NOW))?.delivered).toBe(false);
      expect(c.reads).toBe(2);
    });

    it("shares one read between concurrent calls", async () => {
      const d = folder("b", delivered());
      const { c, reader } = counting();
      const cache = new OutcomeFactsCache({ reader });
      const [x, y] = await Promise.all([cache.get(ended(d), "u1", NOW), cache.get(ended(d), "u1", NOW)]);
      expect(c.reads).toBe(1);
      expect(x).toEqual(y);
    });

    it("keeps a read in progress when finished entries are evicted", async () => {
      const dirs = ["c1", "c2", "c3"].map((x) => folder(x, delivered()));
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let reads = 0;
      const reader: typeof readEvidenceEvents = async (d, id, take, max) => {
        reads++;
        if (d === dirs[0]) await gate;
        return readEvidenceEvents(d, id, take, max);
      };
      const cache = new OutcomeFactsCache({ reader, maxEntries: 2 });
      const a1 = cache.get(ended(dirs[0]!), "u", NOW);
      await cache.get(ended(dirs[1]!, { runId: "r1" }), "u", NOW);
      await cache.get(ended(dirs[2]!), "u", NOW);
      const a2 = cache.get(ended(dirs[0]!), "u", NOW);
      release();
      await Promise.all([a1, a2]);
      expect(reads).toBe(3);
    });

    it("reads nothing before the run has settled, has ended or has an updatedAt", async () => {
      const d = folder("d", delivered());
      const { c, reader } = counting();
      const cache = new OutcomeFactsCache({ reader });
      expect(await cache.get(ended(d), "u", new Date(T0 + 100_000 + SETTLE_MS - 1))).toBeUndefined();
      expect(await cache.get(ended(d), undefined, NOW)).toBeUndefined();
      expect(await cache.get(ended(d, { status: "running", finishedAt: undefined }), "u", NOW)).toBeUndefined();
      expect(await cache.get(null as never, "u", NOW)).toBeUndefined();
      expect(c.reads).toBe(0);
    });

    it("looks at the manifest and the incomplete marker on every call", async () => {
      const d = folder("e", delivered());
      const { c, reader } = counting();
      const cache = new OutcomeFactsCache({ reader });
      expect((await cache.get(ended(d), "u", NOW))?.evidence).toEqual({ stream: true, read: true, manifest: false, incomplete: false });
      writeFileSync(join(d, EVIDENCE_MANIFEST_FILE), "{}");
      expect((await cache.get(ended(d), "u", NOW))?.evidence.manifest).toBe(true);
      writeFileSync(join(d, EVIDENCE_INCOMPLETE_FILE), "");
      expect((await cache.get(ended(d), "u", NOW))?.evidence.incomplete).toBe(true);
      expect(c.reads).toBe(1);
    });

    it("tells a failed read from an empty stream", async () => {
      const asDir = folder("f1");
      mkdirSync(file(asDir));
      const cache = new OutcomeFactsCache();
      expect(await cache.get(ended(asDir), "u", NOW)).toMatchObject({ delivered: false, evidence: { stream: true, read: false } });
      expect((await cache.get(ended(folder("f2", "")), "u", NOW))?.evidence).toMatchObject({ stream: true, read: true });
      expect((await cache.get(ended(folder("f3")), "u", NOW))?.evidence).toMatchObject({ stream: false, read: false });
    });

    it("does not follow a link", async () => {
      writeFileSync(join(dir, "real.jsonl"), delivered());
      const d = folder("g");
      symlinkSync(join(dir, "real.jsonl"), file(d));
      expect(await new OutcomeFactsCache().get(ended(d), "u", NOW)).toMatchObject({ delivered: false, evidence: { stream: true, read: false } });
    });

    it("does not read a file over the size limit", async () => {
      const d = folder("h", delivered());
      expect((await new OutcomeFactsCache({ maxBytes: 10 }).get(ended(d), "u", NOW))?.evidence.read).toBe(false);
    });

    it("drops the events of a failed read and keeps the resumes of run.json", async () => {
      const d = folder("i", delivered());
      const reader: typeof readEvidenceEvents = async (_d, _id, take) => {
        take(ev("run.queued", 0));
        return "refused";
      };
      const facts = await new OutcomeFactsCache({ reader }).get(ended(d, { resumes: 2 }), "u", NOW);
      expect(facts).toMatchObject({ resumes: 2, evidence: { stream: true, read: false } });
      expect(facts?.queuedAt).toBeUndefined();
      const out = computeOutcomes([ended(d, { resumes: 2 })], new Map([["r1", facts as OutcomeFacts]]), { from: new Date(T0), to: new Date(T0 + 3_600_000), previousFrom: new Date(T0 - 3_600_000) });
      expect(out.measures.find((m) => m.id === "resume_count")?.value).toBe(2);
    });

    it("evicts the least recently used entry", async () => {
      const dirs = ["j1", "j2", "j3"].map((x) => folder(x, delivered()));
      const { c, reader } = counting();
      const cache = new OutcomeFactsCache({ reader, maxEntries: 2 });
      for (const d of dirs) await cache.get(ended(d), "u", NOW);
      expect(c.reads).toBe(3);
      await cache.get(ended(dirs[2]!), "u", NOW);
      expect(c.reads).toBe(3);
      await cache.get(ended(dirs[0]!), "u", NOW);
      expect(c.reads).toBe(4);
    });

    it("collects facts by run id", async () => {
      const d1 = folder("k1", delivered());
      const d2 = folder("k2", delivered());
      const runs = [ended(d1, { runId: "a" }), ended(d2, { runId: "b", status: "running", finishedAt: undefined }), null as never];
      const got = await new OutcomeFactsCache().collect(runs, new Map([[d1, "u"], [d2, "u"]]), NOW);
      expect([...got.keys()]).toEqual(["a"]);
    });
  });
});
