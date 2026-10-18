import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { canonicalJson } from "../src/evidence/canonical.js";
import type { TelemetryEvent } from "../src/telemetry/envelope.js";
import { ownedByUs, sweepTelemetry, telemetryDir, telemetryFile, TelemetryWriter } from "../src/telemetry/local.js";
import { closeTelemetry, configureTelemetry, DROP_WORDS, emitTelemetry, flushTelemetry, resetTelemetry, telemetryEnabled, telemetryStats } from "../src/telemetry/telemetry.js";

const posix = process.platform !== "win32";
let home: string;
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "telemetry-"));
  process.env.FACTORY_HOME = home;
});
afterEach(() => {
  resetTelemetry();
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const NOW = new Date("2026-03-10T12:00:00.000Z");
const day = (offset: number) => new Date(NOW.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
const ev = (n = 1): TelemetryEvent => ({
  version: 1, id: `ev:r1:ev-${String(n).padStart(6, "0")}`, time: "2026-03-10T12:00:00.000Z", kind: "run", name: "run.queued", runId: "r1",
  evidence: { id: `ev-${String(n).padStart(6, "0")}`, seq: n },
});
const cfg = (telemetry: object = {}) => ConfigSchema.parse({ protected_branches: [], telemetry });
const today = () => telemetryFile(new Date().toISOString().slice(0, 10));
const mode = (p: string) => statSync(p).mode & 0o777;

describe("telemetry config", () => {
  it("defaults to local with 30 days, and checks its values", () => {
    expect(ConfigSchema.parse({}).telemetry).toEqual({ local: true, keep_days: 30 });
    for (const keep_days of [1, 365]) expect(() => cfg({ keep_days })).not.toThrow();
    for (const keep_days of [0, 366, 1.5]) expect(() => cfg({ keep_days })).toThrow();
    expect(() => cfg({ foo: 1 })).toThrow();
  });
});

describe("telemetry writer", () => {
  it("makes the folder 0700 and the file 0600", () => {
    new TelemetryWriter(() => 30).write("{}", NOW);
    expect(existsSync(telemetryFile(day(0)))).toBe(true);
    if (posix) {
      expect(mode(telemetryDir())).toBe(0o700);
      expect(mode(telemetryFile(day(0)))).toBe(0o600);
    }
  });

  it.runIf(posix)("tightens loose modes", () => {
    mkdirSync(telemetryDir(), { mode: 0o755 });
    chmodSync(telemetryDir(), 0o755);
    writeFileSync(telemetryFile(day(0)), "");
    chmodSync(telemetryFile(day(0)), 0o644);
    new TelemetryWriter(() => 30).write("{}", NOW);
    expect(mode(telemetryDir())).toBe(0o700);
    expect(mode(telemetryFile(day(0)))).toBe(0o600);
  });

  it.runIf(posix)("refuses a data folder others can write to", () => {
    chmodSync(home, 0o777);
    expect(() => new TelemetryWriter(() => 30).write("{}", NOW)).toThrow();
    expect(existsSync(telemetryDir())).toBe(false);
  });

  it.runIf(posix)("refuses a linked folder or file", () => {
    const target = mkdtempSync(join(tmpdir(), "telemetry-target-"));
    try {
      symlinkSync(target, telemetryDir());
      expect(() => new TelemetryWriter(() => 30).write("{}", NOW)).toThrow();
      expect(readdirSync(target)).toEqual([]);
      rmSync(telemetryDir());
      mkdirSync(telemetryDir(), { mode: 0o700 });
      const elsewhere = join(target, "elsewhere");
      writeFileSync(elsewhere, "keep\n");
      symlinkSync(elsewhere, telemetryFile(day(0)));
      expect(() => new TelemetryWriter(() => 30).write("{}", NOW)).toThrow();
      expect(readFileSync(elsewhere, "utf8")).toBe("keep\n");
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("keeps a torn last line apart from the next event", () => {
    mkdirSync(telemetryDir(), { mode: 0o700 });
    writeFileSync(telemetryFile(day(0)), '{"partial');
    new TelemetryWriter(() => 30).write('{"ok":1}', NOW);
    expect(readFileSync(telemetryFile(day(0)), "utf8")).toBe('{"partial\n{"ok":1}\n');
  });

  it("names the file after the UTC day, and opens a new one for a new day", () => {
    const w = new TelemetryWriter(() => 30);
    w.write("{}", new Date("2026-03-01T23:30:00-05:00"));
    w.write("{}", new Date("2026-03-03T00:00:00Z"));
    w.close();
    expect(readdirSync(telemetryDir()).sort()).toEqual(["events-2026-03-02.jsonl", "events-2026-03-03.jsonl"]);
  });

  it("checks the owner with an explicit uid", () => {
    expect(ownedByUs({ uid: 1 }, 2)).toBe(false);
    expect(ownedByUs({ uid: 2 }, 2)).toBe(true);
    expect(ownedByUs({ uid: 2 }, undefined)).toBe(true);
  });
});

describe("telemetry sweep", () => {
  const file = (d: string) => join(telemetryDir(), `events-${d}.jsonl`);
  it("removes only old plain event files", () => {
    mkdirSync(telemetryDir(), { mode: 0o700 });
    for (const o of [0, 29, 30, 31]) writeFileSync(file(day(o)), "{}\n");
    writeFileSync(join(telemetryDir(), "notes.txt"), "x");
    writeFileSync(join(telemetryDir(), "events-x.jsonl"), "x");
    mkdirSync(file(day(40)));
    writeFileSync(join(home, "target"), "t");
    if (posix) symlinkSync(join(home, "target"), file(day(50)));
    expect(sweepTelemetry(30, NOW)).toBe(2);
    const left = readdirSync(telemetryDir()).sort();
    expect(left).toEqual(expect.arrayContaining([`events-${day(0)}.jsonl`, `events-${day(29)}.jsonl`, "notes.txt", "events-x.jsonl", `events-${day(40)}.jsonl`]));
    expect(left).not.toContain(`events-${day(30)}.jsonl`);
    expect(left).not.toContain(`events-${day(31)}.jsonl`);
    if (posix) {
      expect(left).toContain(`events-${day(50)}.jsonl`);
      expect(existsSync(join(home, "target"))).toBe(true);
    }
  });

  it.runIf(posix)("removes nothing through a linked data folder", () => {
    const target = mkdtempSync(join(tmpdir(), "telemetry-target-"));
    const link = join(tmpdir(), `telemetry-link-${process.pid}-${Date.now()}`);
    try {
      mkdirSync(join(target, "telemetry"), { mode: 0o700 });
      writeFileSync(join(target, "telemetry", `events-${day(60)}.jsonl`), "{}\n");
      symlinkSync(target, link);
      process.env.FACTORY_HOME = link;
      expect(sweepTelemetry(30, NOW)).toBe(0);
      expect(readdirSync(join(target, "telemetry"))).toHaveLength(1);
    } finally {
      process.env.FACTORY_HOME = home;
      rmSync(link, { force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it.runIf(posix)("removes nothing through a linked folder", () => {
    const target = mkdtempSync(join(tmpdir(), "telemetry-target-"));
    try {
      writeFileSync(join(target, `events-${day(60)}.jsonl`), "{}\n");
      symlinkSync(target, telemetryDir());
      expect(sweepTelemetry(30, NOW)).toBe(0);
      expect(readdirSync(target)).toHaveLength(1);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe("telemetry hub", () => {
  it("writes nothing before it is configured", () => {
    emitTelemetry(ev());
    expect(telemetryEnabled()).toBe(false);
    expect(existsSync(telemetryDir())).toBe(false);
  });

  it("writes nothing and makes no folder with local: false", () => {
    configureTelemetry(cfg({ local: false }));
    emitTelemetry(ev());
    expect(telemetryEnabled()).toBe(false);
    expect(existsSync(telemetryDir())).toBe(false);
  });

  it("writes one canonical line per valid event and counts them", () => {
    configureTelemetry(cfg());
    emitTelemetry([ev(1), ev(2)]);
    flushTelemetry();
    expect(readFileSync(today(), "utf8")).toBe(`${canonicalJson(ev(1))}\n${canonicalJson(ev(2))}\n`);
    expect(telemetryStats()).toMatchObject({ enabled: true, written: 2 });
  });

  it("logs each drop reason once, in fixed words without values", () => {
    const said: string[] = [];
    configureTelemetry(cfg(), { log: (l) => said.push(l) });
    emitTelemetry([{ ...ev(), prompt: "secret words" } as unknown as TelemetryEvent, { ...ev(), output: "more" } as unknown as TelemetryEvent]);
    expect(said).toEqual([DROP_WORDS.invalid]);
    expect(telemetryStats().dropped.invalid).toBe(2);
    expect(said.join("")).not.toMatch(/secret words|more/);
  });

  it.runIf(posix)("counts a write drop and logs it once", () => {
    const target = mkdtempSync(join(tmpdir(), "telemetry-target-"));
    try {
      symlinkSync(target, telemetryDir());
      const said: string[] = [];
      configureTelemetry(cfg(), { log: (l) => said.push(l) });
      emitTelemetry([ev(1), ev(2)]);
      expect(said).toEqual([DROP_WORDS.write]);
      expect(telemetryStats().dropped.write).toBe(2);
      expect(readdirSync(target)).toEqual([]);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("replaces the log when one is given and keeps it when none is", () => {
    const a: string[] = [];
    const b: string[] = [];
    configureTelemetry(cfg(), { log: (l) => a.push(l) });
    configureTelemetry(cfg());
    emitTelemetry({ nope: 1 } as unknown as TelemetryEvent);
    expect(a).toHaveLength(1);
    configureTelemetry(cfg(), { log: (l) => b.push(l) });
    emitTelemetry({ nope: 2 } as unknown as TelemetryEvent);
    expect(a).toHaveLength(1);
    // the reason was already said once, so the new log hears nothing more of it
    expect(b).toEqual([]);
  });

  it("does not throw for garbage", () => {
    configureTelemetry(cfg());
    expect(() => emitTelemetry(undefined as unknown as TelemetryEvent)).not.toThrow();
    expect(() => emitTelemetry(42 as unknown as TelemetryEvent)).not.toThrow();
  });

  it("reopens the file after close, and flush without a file is fine", () => {
    configureTelemetry(cfg());
    expect(() => flushTelemetry()).not.toThrow();
    emitTelemetry(ev(1));
    closeTelemetry();
    emitTelemetry(ev(2));
    expect(readFileSync(today(), "utf8").split("\n").filter(Boolean)).toHaveLength(2);
  });
});
