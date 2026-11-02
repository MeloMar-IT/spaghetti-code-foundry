import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setCap } from "../src/ops/caps.js";
import { CAP_ENDED, HOLD_MS } from "../src/ops/governor.js";
import { belowLine, capHistory, durationText, EARLIER, heldCap, logSince, reasonOf } from "../src/ops/governor-history.js";
import { readBack } from "../src/ops/read-back.js";
import { governorView } from "../src/server/api-governor.js";

const H = 3_600_000;
const NOW = Date.UTC(2026, 9, 20, 12, 0);
const SINCE = NOW - 24 * H;
const iso = (t: number) => new Date(t).toISOString();
const move = (t: number, from: number, to: number, why: string) => `${iso(t)} runs at once ${from} → ${to} (${why})`;
const ended = (t: number, from: number) => `${iso(t)} ${CAP_ENDED} from ${from} (limits taken away by hand)`;
const hist = (lines: string[], held?: { runs: number; until: number }, configured = 6) => capHistory(lines, { since: SINCE, now: NOW, configured, ...(held ? { held } : {}) });
const FITS = "the runs that fit next to other programs";

describe("capHistory", () => {
  it("takes the start value from the first line, so a cap set before the window counts", () => {
    const h = hist([move(SINCE + 3 * H, 4, 5, "calm: load 0.5 per core"), move(SINCE + 5 * H, 5, 6, "calm: load 0.5 per core")]);
    expect(h.start).toBe(4);
    expect(h.belowMs).toBe(5 * H);
    expect(h.lowest).toBe(4);
    expect(h.reasons).toEqual([{ why: EARLIER, ms: 5 * H }]);
  });

  it("counts a cap that still holds up to now and names the reason of the step down", () => {
    const h = hist([move(NOW - 2 * H, 6, 4, "2 runs fit")], { runs: 4, until: NOW });
    expect(h.belowMs).toBe(2 * H);
    expect(h.lowest).toBe(4);
    expect(h.reasons).toEqual([{ why: FITS, ms: 2 * H }]);
    expect(h.steps).toEqual([{ at: NOW - 2 * H, runs: 4, why: "2 runs fit" }]);
  });

  it("ignores a garbage line and a line without a readable time", () => {
    const h = hist(["garbage", "no time runs at once 6 → 1 (x)", "", move(NOW - H, 6, 5, "load 3.0 per core for 3 checks")], { runs: 5, until: NOW });
    expect(h.steps).toHaveLength(1);
    expect(h.lowest).toBe(5);
    expect(h.belowMs).toBe(H);
  });

  it("stops counting at a stale end", () => {
    const h = hist([move(NOW - 5 * H, 6, 4, "memory pressure critical")], { runs: 4, until: NOW - 3 * H });
    expect(h.belowMs).toBe(2 * H);
    expect(h.steps.at(-1)).toEqual({ at: NOW - 3 * H, runs: 6 });
  });

  it("does not count a cap past its last line when none is known to hold", () => {
    const h = hist([move(NOW - 5 * H, 6, 4, "memory pressure critical")]);
    expect(h.belowMs).toBe(0);
  });

  it("goes back to the configured number at a CAP_ENDED line, also as the first line of the window", () => {
    const h = hist([ended(SINCE + 2 * H, 3), move(SINCE + 6 * H, 6, 5, "1 run fits")], { runs: 5, until: NOW });
    expect(h.start).toBe(3);
    expect(h.belowMs).toBe(2 * H + 18 * H);
    expect(h.lowest).toBe(3);
    expect(h.reasons.map((r) => r.why)).toEqual([FITS, EARLIER]);
  });

  it("records a change nobody logged: the value before a line is its `from`", () => {
    const h = hist([move(NOW - 4 * H, 6, 4, "2 runs fit"), move(NOW - 2 * H, 6, 5, "2 runs fit")], { runs: 5, until: NOW });
    expect(h.belowMs).toBe(2 * H + 2 * H);
    expect(h.steps.map((s) => s.runs)).toEqual([4, 6, 5]);
  });

  it("keeps values between 0 and the configured number", () => {
    const h = hist([move(NOW - 2 * H, 9, 8, "x"), move(NOW - H, 8, 3, "load 3.0 per core for 3 checks")], { runs: 3, until: NOW });
    expect(h.start).toBe(6);
    expect(h.lowest).toBe(3);
    expect(h.belowMs).toBe(H);
  });

  it("skips a line after now and a line before the window", () => {
    const h = hist([move(SINCE - H, 6, 2, "x"), move(NOW + H, 6, 1, "x")]);
    expect(h).toMatchObject({ steps: [], belowMs: 0, start: 6 });
  });

  it("has no time below without lines and without a cap", () => {
    expect(hist([])).toEqual({ start: 6, steps: [], belowMs: 0, reasons: [] });
  });

  it("names a cap set before the window by the reason the state keeps", () => {
    const h = hist([], { runs: 4, until: NOW, why: "memory pressure critical" });
    expect(h.reasons).toEqual([{ why: "memory pressure", ms: 24 * H }]);
  });

  it("keeps the reason of the last step down through a step up in the window", () => {
    const h = hist([move(SINCE + 2 * H, 6, 4, "memory pressure critical"), move(SINCE + 4 * H, 4, 5, "calm: load 0.5 per core")], { runs: 5, until: NOW, why: "memory pressure critical" });
    // before the step down the cap is the configured number, so no time is below it; from the step down to the end, memory pressure
    expect(h.reasons).toEqual([{ why: "memory pressure", ms: 22 * H }]);
  });

  it("counts the whole window for a cap that holds and has no line", () => {
    const h = hist([], { runs: 4, until: NOW });
    expect(h.belowMs).toBe(24 * H);
    expect(h.reasons).toEqual([{ why: EARLIER, ms: 24 * H }]);
  });

  it("ignores a line about test workers only", () => {
    expect(hist([`${iso(NOW - H)} test workers → 4 (load 3.0 per core)`]).steps).toEqual([]);
  });

  it("reads a move that has a cause after it", () => {
    const h = hist([`${move(NOW - H, 6, 5, "load 2.8 per core for 3 checks")} — the Foundry uses 1.0 cores`], { runs: 5, until: NOW });
    expect(h.steps[0]).toMatchObject({ runs: 5, why: "load 2.8 per core for 3 checks" });
  });
});

describe("belowLine, durationText, reasonOf", () => {
  it("says nothing without time below", () => {
    expect(belowLine(hist([]), 6)).toBeUndefined();
  });
  it("names the time, the lowest cap and two reasons", () => {
    const h = hist([move(NOW - 3 * H, 6, 4, "2 runs fit"), move(NOW - H, 4, 3, "memory pressure critical")], { runs: 3, until: NOW });
    expect(belowLine(h, 6)).toBe(`the runs at once were below 6 for 3 h in the last day (lowest 3): ${FITS} 2 h, memory pressure 1 h`);
  });
  it("writes durations in plain words", () => {
    expect([0, 59_000, 5 * 60_000, 2 * H, 2 * H + 10 * 60_000].map(durationText)).toEqual(["less than a minute", "less than a minute", "5 min", "2 h", "2 h 10 min"]);
  });
  it("groups the reasons", () => {
    expect(reasonOf("memory pressure critical")).toBe("memory pressure");
    expect(reasonOf("1 run fits")).toBe(FITS);
    expect(reasonOf("3 runs fit, throttled: CPU speed limit 80%")).toBe(FITS);
    expect(reasonOf("throttled: CPU speed limit 80%")).toBe("throttled");
    expect(reasonOf("swapping: swap grew by 90 MB")).toBe("swapping");
    expect(reasonOf("load 3.0 per core for 3 checks, CPU 90% busy")).toBe("high load");
    expect(reasonOf("the settings changed")).toBe("the settings changed");
  });
});

describe("files", () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "scf-hist-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("logSince keeps file order and stops at the first older line, in a file larger than one read", () => {
    const dir = tmp();
    const old = `${move(SINCE - H, 6, 5, "old")}\n`.repeat(3000);
    const mine = Array.from({ length: 1500 }, (_, i) => move(SINCE + H + i * 1000, 6, 5, "new")).join("\n");
    writeFileSync(join(dir, "changes.log"), `${old}garbage\n${mine}\n`);
    const lines = logSince(dir, SINCE);
    expect(lines).toHaveLength(1500);
    expect(lines[0]).toContain(iso(SINCE + H));
    expect(lines.at(-1)).toContain(iso(SINCE + H + 1499 * 1000));
  });

  it("logSince gives [] for a missing file", () => {
    expect(logSince(tmp(), SINCE)).toEqual([]);
  });

  it("readBack decodes an arrow that is cut by a chunk boundary", () => {
    const dir = tmp();
    const text = `${move(NOW - 2 * H, 6, 5, "a")}\n${move(NOW - H, 5, 4, "b")}\n`;
    writeFileSync(join(dir, "changes.log"), text);
    const arrow = Buffer.from(text).indexOf(Buffer.from("→"));
    for (const size of [Buffer.byteLength(text) - arrow - 1, Buffer.byteLength(text) - arrow - 2, 7, 1]) {
      const seen: string[] = [];
      readBack(join(dir, "changes.log"), (l) => (seen.push(l), true), size);
      expect(seen.filter(Boolean).reverse().join("\n") + "\n", `chunk ${size}`).toBe(text);
    }
  });

  it("heldCap: fresh, stale, none, malformed", () => {
    const dir = tmp();
    const now = new Date(NOW);
    expect(heldCap(dir, now)).toBeUndefined();
    writeFileSync(join(dir, "state.json"), JSON.stringify({ runs: 4, at: iso(NOW - 60_000) }));
    expect(heldCap(dir, now)).toEqual({ runs: 4, until: NOW });
    writeFileSync(join(dir, "state.json"), JSON.stringify({ runs: 4, at: iso(NOW - H) }));
    expect(heldCap(dir, now)).toEqual({ runs: 4, until: NOW - H + HOLD_MS });
    for (const runs of ["4", 1.5, -1, null]) {
      writeFileSync(join(dir, "state.json"), JSON.stringify({ runs, at: iso(NOW) }));
      expect(heldCap(dir, now)).toBeUndefined();
    }
    writeFileSync(join(dir, "state.json"), "{");
    expect(heldCap(dir, now)).toBeUndefined();
  });
});

describe("governorView", () => {
  const dirs: string[] = [];
  const setup = () => {
    const home = mkdtempSync(join(tmpdir(), "scf-view-"));
    dirs.push(home);
    const dir = join(home, "governor");
    mkdirSync(dir, { recursive: true });
    return { dir, capsFile: join(dir, "caps.json"), configured: 6, reserve: 2, now: new Date(NOW) };
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const latest = (dir: string, body: object) => writeFileSync(join(dir, "latest.json"), JSON.stringify(body));
  const usage = { windowSec: 60, foundry: { cores: 1.5, tests: 1, server: 0.2, runs: [], repos: [] }, other: { cores: 3, top: Array.from({ length: 7 }, (_, i) => ({ program: `p${i}`, cores: 7 - i })) }, perRun: {} };

  it("is none without latest.json, but still reads the history", () => {
    const o = setup();
    writeFileSync(join(o.dir, "changes.log"), `${move(NOW - H, 6, 5, "2 runs fit")}\n`);
    writeFileSync(join(o.dir, "state.json"), JSON.stringify({ runs: 5, runsWhy: "2 runs fit", at: iso(NOW - 1000), calm: 0 }));
    const v = governorView(o);
    expect(v.status).toBe("none");
    expect(v.capacity).toBeUndefined();
    expect(v.cap).toEqual({ runs: 5, why: "2 runs fit" });
    expect(v.history.belowMs).toBe(H);
  });

  it("gives a cap that started before the window its reason from the state, and the partial recovery keeps it", () => {
    const o = setup();
    writeFileSync(join(o.dir, "state.json"), JSON.stringify({ runs: 5, runsWhy: "memory pressure critical", at: iso(NOW - 1000), calm: 0 }));
    const v = governorView(o);
    expect(v.cap).toEqual({ runs: 5, why: "memory pressure critical" });
    expect(v.history.reasons).toEqual([{ why: "memory pressure", ms: 24 * H }]);
  });

  it("is old after the hold time: no measurements, but a cap that still holds is listed", () => {
    const o = setup();
    latest(o.dir, { at: iso(NOW - 2 * HOLD_MS), cores: 8, free: 3, usage });
    setCap("load", { runs: 4, until: iso(NOW + 60_000), why: "machine load" }, o.capsFile);
    const v = governorView(o);
    expect(v.status).toBe("old");
    expect(v).not.toHaveProperty("capacity");
    expect(v).not.toHaveProperty("foundry");
    expect(v).not.toHaveProperty("other");
    expect(v.caps).toEqual([{ who: "load", runs: 4, why: "machine load", until: iso(NOW + 60_000) }]);
    expect(v.limit).toBe(4);
  });

  it("is ok with capacity, five programs, the Foundry's split and the lowest cap", () => {
    const o = setup();
    latest(o.dir, { at: iso(NOW - 1000), cores: 8, free: 3, fit: 2, usage });
    setCap("busy", { runs: 2, until: iso(NOW + H), why: "busy" }, o.capsFile);
    setCap("load", { runs: 4, until: iso(NOW + 60_000), why: "machine load" }, o.capsFile);
    setCap("limits", { runs: 1, until: iso(NOW - 60_000), why: "ended" }, o.capsFile);
    const v = governorView(o);
    expect(v.status).toBe("ok");
    expect(v.capacity).toEqual({ cores: 8, free: 3, reserve: 2, fit: 2 });
    expect(v.other!.top).toHaveLength(5);
    expect(v.foundry).toEqual({ cores: 1.5, tests: 1, server: 0.2 });
    expect(v.limit).toBe(2);
    expect(v.caps.map((c) => c.who)).toEqual(["busy", "load"]);
  });

  it("shows free cores without a learned run size (no fit)", () => {
    const o = setup();
    latest(o.dir, { at: iso(NOW - 1000), cores: 8, free: 4 });
    expect(governorView(o).capacity).toEqual({ cores: 8, free: 4, reserve: 2 });
  });

  it("does not throw for a latest.json of the wrong shape", () => {
    const o = setup();
    for (const body of [{ at: iso(NOW), usage: { foundry: 1, other: { cores: "x", top: 3 } }, cores: "x", free: -1 }, [], "x", { at: iso(NOW), usage: { foundry: { cores: 1, tests: 0, server: 0 }, other: { cores: 1, top: [null, { program: 3, cores: 1 }, { program: "a", cores: 1 }] } } }]) {
      latest(o.dir, body);
      const v = governorView(o);
      expect(v.capacity).toBeUndefined();
    }
    expect(governorView(o).other!.top).toEqual([{ program: "a", cores: 1 }]);
  });
});
