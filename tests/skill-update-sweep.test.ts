import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hideKeyVars, resetRedactCache } from "../src/credentials/redact.js";
import { mergeFindings, readFindings, saveFindings, type Finding } from "../src/monitor/findings.js";
import { CATALOGUE_KEY, SKILL_SOURCE_DETECTOR, applySourceChecks, clearSourceChecks, sourceFingerprint } from "../src/monitor/skill-source-findings.js";
import { checkUpdateFolder, skillUpdateSweeper, type SweepRun } from "../src/server/skill-update-sweep.js";

const T0 = new Date("2026-10-15T10:00:00Z");
const T1 = new Date("2026-10-16T10:00:00Z");
const idle = <T>(fn: () => T) => Promise.resolve(fn());
const checked = (k: string, v: string[]) => new Map([[k, v]]);
const other: Finding = { detector: "other", fingerprint: "other|x", severity: "minor", summary: "o", evidence: {}, about: "foundry", firstSeen: T0.toISOString(), lastSeen: T0.toISOString(), count: 1, gone: false };

describe("applySourceChecks", () => {
  it("opens a new finding", () => {
    const r = applySourceChecks([], checked("lib", ["bad"]), T0);
    expect(r.changed).toBe(true);
    expect(r.findings).toEqual([
      { detector: SKILL_SOURCE_DETECTOR, fingerprint: "skill-source-check|lib|bad", severity: "major", summary: "Skill source lib: bad", evidence: {}, about: "project", firstSeen: T0.toISOString(), lastSeen: T0.toISOString(), count: 1, gone: false, streak: 1, days: [expect.any(String)] },
    ]);
  });

  it("refreshes the same sentence without a duplicate", () => {
    const a = applySourceChecks([], checked("lib", ["bad"]), T0).findings;
    const b = applySourceChecks(a, checked("lib", ["bad"]), T1).findings;
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ firstSeen: T0.toISOString(), lastSeen: T1.toISOString(), count: 2, streak: 2 });
  });

  it("marks other sentences of the source gone and opens the new one", () => {
    const a = applySourceChecks([], checked("lib", ["one"]), T0).findings;
    const b = applySourceChecks(a, checked("lib", ["two"]), T1).findings;
    expect(b.map((f) => [f.fingerprint, f.gone])).toEqual([[sourceFingerprint("lib", "one"), true], [sourceFingerprint("lib", "two"), false]]);
  });

  it("an empty list marks the source gone and leaves others alone", () => {
    const a = applySourceChecks([other], new Map([["lib", ["x"]], ["ver", ["y"]]]), T0).findings;
    const b = applySourceChecks(a, checked("lib", []), T1);
    expect(b.changed).toBe(true);
    expect(b.findings.map((f) => f.gone)).toEqual([false, true, false]);
    expect(applySourceChecks(b.findings, checked("lib", []), T1).changed).toBe(false);
  });

  it("reopens a gone finding and keeps its report", () => {
    const report = { repo: "a/b", issue: 1, url: "https://x/1", at: T0.toISOString(), seen: 1 };
    const gone: Finding = { ...applySourceChecks([], checked("lib", ["x"]), T0).findings[0]!, gone: true, count: 4, report };
    const r = applySourceChecks([gone], checked("lib", ["x"]), T1).findings;
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ gone: false, count: 1, streak: 1, firstSeen: T1.toISOString(), report });
  });

  it("uses the catalogue summary for *", () => {
    expect(applySourceChecks([], checked(CATALOGUE_KEY, ["x"]), T0).findings[0]!.summary).toBe("Skill source checks: x");
  });

  it("removes control characters, cuts the summary and keeps 5 sentences", () => {
    const f = applySourceChecks([], checked("lib", ["a\u0007b\nc"]), T0).findings;
    expect(f[0]!.summary).toBe("Skill source lib: a b c");
    const long = applySourceChecks([], checked("lib", ["x".repeat(400)]), T0).findings;
    expect(long[0]!.summary).toHaveLength(300);
    const many = applySourceChecks([], checked("lib", ["1", "2", "3", "4", "5", "6", "7", "5"]), T0).findings;
    expect(many).toHaveLength(5);
  });

  it("keeps problems that differ only after character 300 apart", () => {
    const base = "y".repeat(310);
    const a = applySourceChecks([], checked("lib", [`${base}A`]), T0).findings;
    const b = applySourceChecks(a, checked("lib", [`${base}B`]), T1).findings;
    expect(b.map((f) => f.gone)).toEqual([true, false]);
    expect(b[1]!.count).toBe(1);
  });
});

describe("clearSourceChecks", () => {
  it("marks only open findings of this detector gone", () => {
    const a = applySourceChecks([other], checked("lib", ["x"]), T0).findings;
    const r = clearSourceChecks(a, T1);
    expect(r.changed).toBe(true);
    expect(r.findings.map((f) => f.gone)).toEqual([false, true]);
    expect(clearSourceChecks(r.findings, T1).changed).toBe(false);
  });
});

describe("checkUpdateFolder", () => {
  let dir: string;
  let home: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sweep-folder-"));
    home = join(dir, "home");
    mkdirSync(join(home, ".claude", "x"), { recursive: true });
    mkdirSync(join(home, ".codex", "y"), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("refuses unusable folders with fixed sentences", () => {
    expect(checkUpdateFolder("rel/path", { userHome: home })).toContain("not an absolute path");
    expect(checkUpdateFolder(join(dir, "nope"), { userHome: home })).toContain("does not exist");
    writeFileSync(join(dir, "file"), "x");
    expect(checkUpdateFolder(join(dir, "file"), { userHome: home })).toContain("does not exist");
    expect(checkUpdateFolder(join(home, ".claude", "x"), { userHome: home })).toContain(".claude or .codex");
    symlinkSync(join(home, ".codex", "y"), join(dir, "link"));
    expect(checkUpdateFolder(join(dir, "link"), { userHome: home })).toContain(".claude or .codex");
  });

  it("needs a git work tree", () => {
    const f = join(dir, "plain");
    mkdirSync(f);
    expect(checkUpdateFolder(f, { userHome: home })).toContain("not in a git work tree");
    expect(checkUpdateFolder(f, { userHome: home, env: { PATH: "/nonexistent" } })).toBeDefined();
    execFileSync("git", ["init", "--quiet", f]);
    expect(checkUpdateFolder(f, { userHome: home })).toBeUndefined();
  });
});

describe("the sweeper", () => {
  let dir: string;
  let file: string;
  let lines: string[];
  let now: Date;
  let cfg: { folder?: string; everyMs: number };
  let repo: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sweep-"));
    file = join(dir, "findings.json");
    repo = join(dir, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "--quiet", repo]);
    lines = [];
    now = new Date(T0);
    cfg = { folder: repo, everyMs: 1000 };
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.SWEEP_SECRET;
    resetRedactCache();
  });

  const make = (run: SweepRun, o: { findingsIdle?: <T>(fn: () => T) => Promise<T> } = {}) =>
    skillUpdateSweeper({ config: () => cfg, log: (l) => lines.push(l), findingsIdle: o.findingsIdle ?? idle, run, file, now: () => now, userHome: join(dir, "home") });
  const open = () => readFindings(file).findings.filter((f) => !f.gone);
  const all = () => readFindings(file).findings;
  const problem = (id: string, text: string): SweepRun => async ({ out, onChecked }) => {
    out(`${id}: PROBLEM ${text}`);
    onChecked(id, "PROBLEM");
    out("CHECKED 1 sources");
    return 1;
  };

  it("skips a tick while a run is in flight", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = make(async () => {
      calls++;
      await gate;
      return 0;
    });
    const first = s.tick();
    await s.tick();
    expect(calls).toBe(1);
    expect(s.running()).toBe(true);
    release();
    await first;
    expect(s.running()).toBe(false);
  });

  it("waits everyMs between starts", async () => {
    let calls = 0;
    const s = make(async () => ++calls * 0);
    await s.tick();
    now = new Date(now.getTime() + 500);
    await s.tick();
    expect(calls).toBe(1);
    now = new Date(now.getTime() + 600);
    await s.tick();
    expect(calls).toBe(2);
  });

  it("logs every output line", async () => {
    const s = make(async ({ out }) => {
      out("NOTE hello");
      out("CHECKED 0 sources");
      return 0;
    });
    await s.tick();
    expect(lines).toEqual(["skill-sources: NOTE hello", "skill-sources: CHECKED 0 sources"]);
  });

  it("opens a finding for PROBLEM and clears it when the source is OK", async () => {
    let ok = false;
    const s = make(async (a) => (ok ? (a.onChecked("lib", "OK"), 0) : problem("lib", "it broke")(a)));
    await s.tick();
    expect(open().map((f) => f.summary)).toEqual(["Skill source lib: it broke"]);
    ok = true;
    now = new Date(now.getTime() + 2000);
    await s.tick();
    expect(open()).toEqual([]);
    expect(all()).toHaveLength(1);
  });

  it("uses a fixed sentence for a PROBLEM outcome without a line", async () => {
    await make(async ({ onChecked }) => (onChecked("lib", "PROBLEM"), 1)).tick();
    expect(open()[0]!.summary).toBe("Skill source lib: the check ended with PROBLEM; see the server log");
  });

  it("opens a * finding for a bare PROBLEM and clears it with CHECKED", async () => {
    let bare = true;
    const s = make(async ({ out }) => {
      if (bare) out("PROBLEM origin is odd");
      else out("CHECKED 0 sources");
      return 0;
    });
    await s.tick();
    expect(open().map((f) => f.summary)).toEqual(["Skill source checks: origin is odd"]);
    bare = false;
    now = new Date(now.getTime() + 2000);
    await s.tick();
    expect(open()).toEqual([]);
  });

  it("does not call run for a bad folder and reports it under *", async () => {
    cfg.folder = join(dir, "missing");
    let calls = 0;
    await make(async () => ++calls).tick();
    expect(calls).toBe(0);
    expect(lines[0]).toMatch(/^skill-sources: PROBLEM the skill source folder does not exist/);
    expect(open()[0]!.fingerprint).toContain("|*|");
    expect(open()[0]!.summary).not.toContain(dir);
  });

  it("clears findings once when switched off", async () => {
    saveFindings(applySourceChecks([], checked("lib", ["x"]), T0).findings, file);
    cfg.folder = undefined;
    let writes = 0;
    const s = make(async () => 0, { findingsIdle: (fn) => (writes++, idle(fn)) });
    await s.tick();
    expect(open()).toEqual([]);
    await s.tick();
    expect(writes).toBe(1);
  });

  it("clears the old folder's findings first when the folder changes", async () => {
    const other2 = join(dir, "repo2");
    mkdirSync(other2);
    execFileSync("git", ["init", "--quiet", other2]);
    const seen: number[] = [];
    const s = make(async (a) => {
      seen.push(open().length);
      return problem("lib", "x")(a);
    });
    await s.tick();
    cfg.folder = other2;
    now = new Date(now.getTime() + 2000);
    await s.tick();
    expect(seen).toEqual([0, 0]);
  });

  it("retries a failed clean-up on a later tick (switched off)", async () => {
    saveFindings(applySourceChecks([], checked("lib", ["x"]), T0).findings, file);
    cfg.folder = undefined;
    let fail = true;
    const s = make(async () => 0, { findingsIdle: (fn) => (fail ? Promise.reject(new Error("busy")) : idle(fn)) });
    await s.tick();
    expect(open()).toHaveLength(1);
    expect(lines).toContain("skill-sources: the problems of the skill source checks could not be saved");
    fail = false;
    await s.tick();
    expect(open()).toEqual([]);
  });

  it("does not run in the new folder until the old findings are cleared", async () => {
    const other2 = join(dir, "repo2");
    mkdirSync(other2);
    execFileSync("git", ["init", "--quiet", other2]);
    let fail = false;
    let calls = 0;
    const s = make(async (a) => (calls++, problem("lib", "x")(a)), { findingsIdle: (fn) => (fail ? Promise.reject(new Error("busy")) : idle(fn)) });
    await s.tick();
    cfg.folder = other2;
    now = new Date(now.getTime() + 2000);
    fail = true;
    await s.tick();
    expect(calls).toBe(1);
    fail = false;
    await s.tick();
    expect(calls).toBe(2);
  });

  it("does nothing after stop, also when the findings lock is slow", async () => {
    saveFindings(applySourceChecks([], checked("lib", ["x"]), T0).findings, file);
    cfg.folder = undefined;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const s = make(async () => ++calls, { findingsIdle: async (fn) => (await gate, fn()) });
    const t = s.tick();
    s.stop();
    release();
    await t;
    expect(open()).toHaveLength(1);
    cfg.folder = repo;
    await s.tick();
    expect(calls).toBe(0);
  });

  it("stop aborts a check in flight and leaves the findings alone", async () => {
    let started!: () => void;
    const go = new Promise<void>((r) => (started = r));
    const s = make(async ({ out, onChecked, signal }) => {
      started();
      await new Promise<void>((r) => signal.addEventListener("abort", () => r()));
      out("lib: PROBLEM z");
      onChecked("lib", "PROBLEM");
      return 1;
    });
    const t = s.tick();
    await go;
    s.stop();
    await t;
    expect(readFindings(file).findings).toEqual([]);
  });

  it("survives a throwing run, config and findingsIdle", async () => {
    await make(async () => {
      throw new Error("boom");
    }).tick();
    expect(lines).toContain("skill-sources: PROBLEM the check failed unexpectedly; nothing was proposed");
    expect(open()[0]!.fingerprint).toContain("|*|");
    const bad = skillUpdateSweeper({ config: () => { throw new Error("c"); }, log: () => {}, findingsIdle: idle, file });
    await expect(bad.tick()).resolves.toBeUndefined();
    const bad2 = make(async () => 0, { findingsIdle: () => { throw new Error("i"); } });
    await expect(bad2.tick()).resolves.toBeUndefined();
  });

  it("never overwrites a broken findings file and logs it once", async () => {
    writeFileSync(file, "not json");
    const s = make(problem("lib", "x"));
    await s.tick();
    now = new Date(now.getTime() + 2000);
    await s.tick();
    expect(readFileSync(file, "utf8")).toBe("not json");
    expect(lines.filter((l) => l.includes("could not be read"))).toHaveLength(1);
  });

  it("retries the clean-up after a broken findings file is repaired", async () => {
    const good = applySourceChecks([], checked("lib", ["x"]), T0).findings;
    writeFileSync(file, "not json");
    cfg.folder = undefined;
    const s = make(async () => 0);
    await s.tick();
    await s.tick();
    expect(lines.filter((l) => l.includes("could not be read"))).toHaveLength(1);
    saveFindings(good, file);
    await s.tick();
    expect(open()).toEqual([]);
  });

  it("keeps its findings through the monitor's merge", async () => {
    const f = applySourceChecks([], checked("lib", ["x"]), T0).findings;
    const later = new Date(T0.getTime() + 3 * 86_400_000);
    const r = mergeFindings(f, [], later).findings;
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ gone: false, streak: 1, lastSeen: T0.toISOString() });
    // the sweeper still refreshes and clears it
    const again = applySourceChecks(r, checked("lib", ["x"]), later).findings;
    expect(again[0]).toMatchObject({ count: 2, streak: 2 });
    expect(applySourceChecks(again, checked("lib", []), later).findings[0]!.gone).toBe(true);
  });

  it("redacts secrets in findings and log lines", async () => {
    process.env.SWEEP_SECRET = "s3cr3t-value-12345";
    resetRedactCache();
    hideKeyVars(["SWEEP_SECRET"]);
    await make(problem("lib", "leaked s3cr3t-value-12345 here")).tick();
    expect(open()[0]!.summary).toContain("[redacted]");
    expect(JSON.stringify(all())).not.toContain("s3cr3t-value-12345");
    expect(lines.join("\n")).not.toContain("s3cr3t-value-12345");
  });
});
