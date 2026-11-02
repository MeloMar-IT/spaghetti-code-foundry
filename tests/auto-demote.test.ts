import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRepo } from "../src/auth/repos.js";
import { WatcherSchema } from "../src/config.js";
import { AUTO_DEMOTE_DETECTORS, autoDemoteReason, componentsOf, demotesOn, markAutoDemotions, runAutoDemotions } from "../src/governance/auto-demote.js";
import { autonomyFile, levelIn, readAutonomy, setLevel } from "../src/governance/autonomy-store.js";
import type { AutonomyLevel } from "../src/governance/autonomy.js";
import type { Detector } from "../src/monitor/detectors.js";
import { loadFindings, saveFindings, type Finding, type FindingInput } from "../src/monitor/findings.js";
import { Monitor } from "../src/monitor/monitor.js";
import { ALL_DETECTORS } from "../src/monitor/work-detectors.js";
import { ConfigSchema } from "../src/config.js";

// Unit tests: a temporary data folder, hand-built findings, a fake scheduler. No server, no git, no child process.

const HOUR = 3_600_000;
const T0 = new Date("2026-10-01T12:00:00Z").getTime();

const finding = (over: Partial<Finding> = {}): Finding => ({
  detector: "restart-loop", fingerprint: "fp|1", severity: "critical", summary: "s", evidence: { flows: ["f1"] }, about: "foundry",
  firstSeen: new Date(T0).toISOString(), lastSeen: new Date(T0).toISOString(), count: 1, gone: false, ...over,
});

describe("auto demotion", () => {
  let home: string;
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.FACTORY_HOME;
    home = mkdtempSync(join(tmpdir(), "auto-demote-"));
    process.env.FACTORY_HOME = home;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.FACTORY_HOME;
    else process.env.FACTORY_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  });

  const audit = () => {
    try {
      return readFileSync(join(home, "audit.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, string>);
    } catch {
      return [];
    }
  };
  const flowLevel = (name: string): AutonomyLevel => levelIn(readAutonomy(), "flows", name);

  describe("rules", () => {
    it("lowers on a critical finding of any detector and on a major one of the two named detectors only", () => {
      expect(demotesOn({ severity: "critical", detector: "anything" })).toBe(true);
      for (const d of AUTO_DEMOTE_DETECTORS) expect(demotesOn({ severity: "major", detector: d })).toBe(true);
      expect(demotesOn({ severity: "major", detector: "restart-loop" })).toBe(false);
      expect(demotesOn({ severity: "minor", detector: AUTO_DEMOTE_DETECTORS[0]! })).toBe(false);
    });

    it("names only detectors that exist", () => {
      const names = new Set(ALL_DETECTORS.map((d) => d.name));
      for (const d of AUTO_DEMOTE_DETECTORS) expect(names.has(d)).toBe(true);
    });

    it("names components once each, repositories without regard to case", () => {
      expect(componentsOf({ repo: "Acme/App", evidence: { repos: ["acme/app", "acme/other"], flows: ["f", "f", "g"] } })).toEqual(["repos:acme/app", "repos:acme/other", "flows:f", "flows:g"]);
      expect(componentsOf({ evidence: {} })).toEqual([]);
    });

    it("writes a plain reason, cuts a long one, and falls back for a credential", () => {
      expect(autoDemoteReason({ detector: "d", fingerprint: "a|b" })).toBe("auto: d a|b");
      expect(autoDemoteReason({ detector: "d", fingerprint: "x".repeat(500) })).toHaveLength(200);
      expect(autoDemoteReason({ detector: "d", fingerprint: "a\nb" })).toBe("auto: d a b");
      const token = ["github", "pat", ""].join("_") + "Zx9".repeat(20);
      expect(autoDemoteReason({ detector: "d", fingerprint: token })).toBe("auto: d");
    });

    it("marks only new findings that lower a level and name something", () => {
      const a = finding();
      const b = finding({ fingerprint: "fp|2", severity: "major" });
      const c = finding({ fingerprint: "fp|3", evidence: {} });
      markAutoDemotions([a, b, c], new Date(T0));
      expect(a.autoDemote).toEqual({ at: new Date(T0).toISOString(), left: ["flows:f1"] });
      expect(b.autoDemote).toBeUndefined();
      expect(c.autoDemote).toBeUndefined();
    });
  });

  describe("runAutoDemotions", () => {
    const marked = (fingerprint: string, left: string[]) => finding({ fingerprint, autoDemote: { at: new Date(T0).toISOString(), left } });

    it("lowers one level, audits it, and leaves a component at observe alone", () => {
      const a = marked("fp|1", ["flows:f1", "flows:f2"]);
      setLevel("flows", "f2", "observe", "system:connect");
      const r = runAutoDemotions([a], () => {});
      expect(r.demoted.map((d) => `${d.name} ${d.from}→${d.to}`)).toEqual(["f1 delivery-handoff→guarded-write"]);
      expect(a.autoDemote!.left).toEqual([]);
      expect(readAutonomy().flows.f1).toMatchObject({ level: "guarded-write", by: "system:monitor" });
      const lines = audit();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ action: "autonomy-demote", by: "monitor", result: "ok", target: "flows:f1", detail: "delivery-handoff→guarded-write reason: auto: restart-loop fp|1" });
    });

    it("lowers a repository by its GitHub name and drops an unknown name silently", () => {
      const id = addRepo(randomUUID(), "https://github.com/Acme/App.git", { ownerOk: () => true }).id;
      setLevel("repos", id, "plan-only", "system:connect");
      const a = marked("fp|1", ["repos:acme/app", "repos:acme/unknown"]);
      const r = runAutoDemotions([a], () => {});
      expect(r.problems).toEqual([]);
      expect(r.demoted).toHaveLength(1);
      expect(levelIn(readAutonomy(), "repos", id)).toBe("observe");
      expect(audit()[0]).toMatchObject({ target: `repos:${id}`, by: "monitor" });
    });

    it("lowers once per finding, also for two findings with the same long prefix", () => {
      const prefix = "p".repeat(300);
      const list = [marked(`${prefix}1`, ["flows:f1"]), marked(`${prefix}2`, ["flows:f1"])];
      const r = runAutoDemotions(list, () => {});
      expect(r.demoted).toHaveLength(2);
      expect(flowLevel("f1")).toBe("plan-only");
      expect(runAutoDemotions(list, () => {}).demoted).toEqual([]);
    });

    it("skips gone findings and findings without a marker", () => {
      const r = runAutoDemotions([{ ...marked("fp|1", ["flows:f1"]), gone: true }, finding({ fingerprint: "fp|2" })], () => {});
      expect(r.demoted).toEqual([]);
      expect(audit()).toEqual([]);
    });

    it("never repeats a demotion when a save fails, and does the lost key at the next run", () => {
      const a = marked("fp|1", ["flows:f1"]);
      const b = marked("fp|2", ["flows:f1"]);
      let saves = 0;
      const save = () => {
        if (++saves === 2) throw new Error("disk full");
      };
      const r = runAutoDemotions([a, b], save);
      expect(r.demoted).toHaveLength(1);
      expect(r.problems).toHaveLength(1);
      expect(a.autoDemote!.left).toEqual([]);
      expect(b.autoDemote!.left).toEqual(["flows:f1"]);
      expect(flowLevel("f1")).toBe("guarded-write");
      // a promotion in between does not make A repeat
      setLevel("flows", "f1", "delivery-handoff", "system:connect");
      const again = runAutoDemotions([a, b], () => {});
      expect(again.demoted).toHaveLength(1);
      expect(flowLevel("f1")).toBe("guarded-write");
      expect(runAutoDemotions([a, b], () => {}).demoted).toEqual([]);
    });

    it("a failure on the second record retries only that record; the first is not demoted again", () => {
      const r1 = randomUUID();
      const r2 = randomUUID();
      const a = marked("fp|1", [`repos:${r1}`, `repos:${r2}`]);
      let claims = 0;
      let good = "";
      // the second claim is saved, then autonomy.json becomes unreadable: the second record's demotion fails
      const save = () => {
        if (++claims === 2) {
          good = readFileSync(autonomyFile(), "utf8");
          writeFileSync(autonomyFile(), "{");
        }
      };
      const r = runAutoDemotions([a], save);
      expect(r.demoted.map((d) => d.ref.id)).toEqual([r1]);
      expect(r.problems).toHaveLength(1);
      expect(r.problems.join()).not.toContain(home);
      expect(a.autoDemote!.left).toEqual([`repos:${r2}`]);
      writeFileSync(autonomyFile(), good);
      const again = runAutoDemotions([a], () => {});
      expect(again.demoted.map((d) => d.ref.id)).toEqual([r2]);
      expect(a.autoDemote!.left).toEqual([]);
      expect(levelIn(readAutonomy(), "repos", r1)).toBe("guarded-write");
      expect(levelIn(readAutonomy(), "repos", r2)).toBe("guarded-write");
      expect(audit().filter((l) => l.target === `repos:${r1}`)).toHaveLength(1);
    });

    it("puts a key back when autonomy.json cannot be read, without a path in the message", () => {
      writeFileSync(autonomyFile(), "{");
      const a = marked("fp|1", ["flows:f1"]);
      const r = runAutoDemotions([a], () => {});
      expect(r.demoted).toEqual([]);
      expect(a.autoDemote!.left).toEqual(["flows:f1"]);
      expect(r.problems).toEqual(["auto-demote: f1 not lowered (not-json); tried again at the next check"]);
      expect(r.problems.join()).not.toContain(home);
    });
  });

  describe("in the monitor", () => {
    let now: number;
    let found: FindingInput[];
    let on: boolean;
    let lines: string[];
    let file: string;
    let live: string;
    const detector: Detector = { name: "fake", description: "d", run: () => found };
    const input = (over: Partial<FindingInput> = {}): FindingInput => ({ detector: "restart-loop", fingerprint: "fp|1", severity: "critical", summary: "s", evidence: { flows: ["f1"] }, about: "foundry", ...over });
    const mon = (active: string[] = []) => {
      const run = { runId: "r1", flow: "f1", runDir: live, vars: {} };
      const scheduler = { briefs: () => [], get: (id: string) => (active.includes(id) ? run : undefined), queue: () => ({ active: active.map((runId) => ({ runId })), pending: [] }) } as never;
      const config = ConfigSchema.parse({});
      return new Monitor(WatcherSchema.parse({ id: "mon", source: "monitor", every: "5m" }), {
        scheduler, watchers: () => [], thresholds: () => config.monitor, log: (m) => lines.push(m), file, detectors: [detector], now: () => new Date(now), autoDemote: () => on,
      });
    };
    const tick = async (m: Monitor, at: number) => {
      now = at;
      await m.tick();
      expect(m.status.lastError).toBeUndefined();
    };

    beforeEach(() => {
      now = T0;
      found = [input()];
      on = true;
      lines = [];
      file = join(home, "monitor-findings.json");
      live = join(home, "run-r1");
      mkdirSync(live, { recursive: true });
    });

    it("lowers a flow once, then again only after the finding went away and came back", async () => {
      const m = mon();
      await tick(m, T0);
      expect(flowLevel("f1")).toBe("guarded-write");
      expect(lines.some((l) => l.includes("auto-demote: f1 delivery-handoff→guarded-write (restart-loop)"))).toBe(true);
      await tick(m, T0 + HOUR);
      expect(flowLevel("f1")).toBe("guarded-write");
      found = [];
      await tick(m, T0 + 26 * HOUR);
      expect(loadFindings(file).findings[0]!.gone).toBe(true);
      found = [input()];
      await tick(m, T0 + 27 * HOUR);
      expect(flowLevel("f1")).toBe("plan-only");
      expect(audit().map((l) => l.action)).toEqual(["autonomy-demote", "autonomy-demote"]);
    });

    it("lowers on a major of a named detector only", async () => {
      found = [input({ severity: "major", fingerprint: "a" }), input({ detector: "policy-service-failure", severity: "major", fingerprint: "b", evidence: { flows: ["f2"] } })];
      await tick(mon(), T0);
      expect(flowLevel("f1")).toBe("delivery-handoff");
      expect(flowLevel("f2")).toBe("guarded-write");
    });

    it("lowers nothing when the setting is off, and does not mark the finding", async () => {
      on = false;
      const m = mon();
      await tick(m, T0);
      expect(audit()).toEqual([]);
      expect(loadFindings(file).findings[0]!.autoDemote).toBeUndefined();
      on = true;
      await tick(m, T0 + HOUR);
      expect(audit()).toEqual([]);
    });

    it("does not lower for a finding that was open before, or when the findings file is broken", async () => {
      saveFindings([finding({ lastSeen: new Date(T0 - HOUR).toISOString() })], file);
      const m = mon();
      await tick(m, T0);
      expect(audit()).toEqual([]);
      writeFileSync(file, "{");
      await tick(m, T0 + HOUR);
      await tick(m, T0 + 2 * HOUR);
      expect(audit()).toEqual([]);
      expect(flowLevel("f1")).toBe("delivery-handoff");
    });

    it("keeps going when the level cannot be written, and tries again at the next check, logging once", async () => {
      writeFileSync(autonomyFile(), "{");
      const m = mon();
      await tick(m, T0);
      await tick(m, T0 + HOUR);
      expect(lines.filter((l) => l.includes("auto-demote: f1 not lowered"))).toHaveLength(1);
      expect(lines.join("\n")).not.toContain(home);
      rmSync(autonomyFile());
      await tick(m, T0 + 2 * HOUR);
      expect(flowLevel("f1")).toBe("guarded-write");
      await tick(m, T0 + 3 * HOUR);
      expect(flowLevel("f1")).toBe("guarded-write");
      expect(audit()).toHaveLength(1);
    });

    it("does not run a pending demotion while the setting is off, and does not run it after switching back on", async () => {
      writeFileSync(autonomyFile(), "{");
      const m = mon();
      await tick(m, T0); // the demotion fails and stays pending
      expect(loadFindings(file).findings[0]!.autoDemote!.left).toEqual(["flows:f1"]);
      rmSync(autonomyFile());
      on = false;
      await tick(m, T0 + HOUR);
      expect(flowLevel("f1")).toBe("delivery-handoff");
      expect(loadFindings(file).findings[0]!.autoDemote!.left).toEqual([]);
      on = true;
      await tick(m, T0 + 2 * HOUR);
      expect(flowLevel("f1")).toBe("delivery-handoff");
      expect(audit()).toEqual([]);
    });

    it("writes a line to the live log of an active run of the flow", async () => {
      await tick(mon(["r1"]), T0);
      expect(readFileSync(join(live, "live.log"), "utf8")).toContain("autonomy: f1 was lowered to guarded-write by the monitor (restart-loop); this run keeps its level");
    });

    it("does nothing without the dependency", async () => {
      const config = ConfigSchema.parse({});
      const m = new Monitor(WatcherSchema.parse({ id: "mon", source: "monitor", every: "5m" }), {
        scheduler: { briefs: () => [], get: () => undefined, queue: () => ({ active: [], pending: [] }) } as never,
        watchers: () => [], thresholds: () => config.monitor, log: () => {}, file, detectors: [detector], now: () => new Date(T0),
      });
      await tick(m, T0);
      expect(audit()).toEqual([]);
    });
  });
});
