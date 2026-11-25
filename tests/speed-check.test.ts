import { describe, expect, it } from "vitest";
import { median, speedProblems, type SpeedSample } from "./helpers/speed.js";

const O = { limitMs: 200, maxParses: 1 };
const cpu = (...v: number[]): SpeedSample[] => v.map((cpuMs) => ({ cpuMs, wallMs: cpuMs, parses: 1 }));

describe("median", () => {
  it("takes the middle value, or the mean of the two middle ones", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNaN();
  });
});

describe("speedProblems", () => {
  it("passes steady calls", () => expect(speedProblems("x", cpu(100, 100, 100, 100, 100), O)).toEqual([]));
  it("passes one slow call under the cap", () => expect(speedProblems("x", cpu(100, 100, 350, 100, 100), O)).toEqual([]));
  it("fails one call over the cap", () => {
    const p = speedProblems("x", cpu(100, 100, 450, 100, 100), O);
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("call 3");
    expect(p[0]).toContain("400 ms");
  });
  it("fails a call of exactly the cap", () => expect(speedProblems("x", cpu(100, 100, 400, 100, 100), O)).toHaveLength(1));
  it("fails a median over the limit", () => {
    const p = speedProblems("x", cpu(210, 205, 220, 190, 230), O);
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("median 210");
  });
  it("does not judge wall time", () => expect(speedProblems("x", [{ cpuMs: 50, wallMs: 900, parses: 1 }], O)).toEqual([]));
  it("fails two parses in one call", () => {
    const p = speedProblems("x", [{ cpuMs: 10, wallMs: 10, parses: 2 }], O);
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("parsed 2 run files");
  });
  it("fails an empty list", () => expect(speedProblems("x", [], O)).toEqual(["x: no calls"]));
});
