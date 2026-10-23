import { describe, expect, it } from "vitest";
import { isBot, isStatusComment } from "../src/github.js";
import { notCodeStop, parkedComment, PARK_PHRASES, wantsPark } from "../src/queue/park.js";

describe("wantsPark", () => {
  it.each(["/park", "  /park please", "thanks\n/park", "/PARK", "ok\r\n/park\r\n"])("%j parks, whatever the stop", (body) => {
    expect(wantsPark(body, true)).toBe(true);
    expect(wantsPark(body, false)).toBe(true);
  });
  it.each(["keep it open", "Keep it open.", "Keep it open but out of the build queue", "do not build", "Don't build!", "don’t build", "park it", "thanks\n  Do not build  \nbye"])(
    "%j parks a NOT_CODE stop only", (body) => {
      expect(wantsPark(body, true)).toBe(true);
      expect(wantsPark(body, false)).toBe(false);
    });
  it.each(["please /park", "/parking", "> /park", "don't park this", "keep it open please", "I would not keep it open", "plan it anyway", "plan it anyway, do not build yet", "> do not build", ""])(
    "%j does not park", (body) => {
      expect(wantsPark(body, true)).toBe(false);
      expect(wantsPark(body, false)).toBe(false);
    });
  it("lists only lower case phrases", () => {
    for (const p of PARK_PHRASES) expect(p).toBe(p.toLowerCase());
  });
});

describe("notCodeStop", () => {
  const entry = (id: string, output: string) => ({ id, type: "claude", visit: 1, ok: true, output });
  const run = (history: ReturnType<typeof entry>[], status = "stopped") => ({ status, history }) as never;
  it("is false without a plan entry", () => {
    expect(notCodeStop(run([]))).toBe(false);
    expect(notCodeStop(run([entry("other", "PLAN_STATUS: NOT_CODE")]))).toBe(false);
  });
  it("is true when the plan ends NOT_CODE", () => {
    expect(notCodeStop(run([entry("plan", "why\nPLAN_STATUS: NOT_CODE")]))).toBe(true);
  });
  it("reads the newest plan or revise_plan entry", () => {
    expect(notCodeStop(run([entry("plan", "PLAN_STATUS: NOT_CODE"), entry("revise_plan", "PLAN_STATUS: READY")]))).toBe(false);
    expect(notCodeStop(run([entry("plan", "PLAN_STATUS: READY"), entry("plan", "PLAN_STATUS: NOT_CODE")]))).toBe(true);
  });
  it("reads the last PLAN_STATUS line", () => {
    expect(notCodeStop(run([entry("plan", "PLAN_STATUS: NOT_CODE\nmore\nPLAN_STATUS: NEEDS_INFO")]))).toBe(false);
    expect(notCodeStop(run([entry("plan", "PLAN_STATUS: NEEDS_INFO\nmore\nPLAN_STATUS: NOT_CODE")]))).toBe(true);
  });
  it("needs a stopped run", () => {
    expect(notCodeStop(run([entry("plan", "PLAN_STATUS: NOT_CODE")], "failed"))).toBe(false);
  });
  it("accepts a sub-flow id and CRLF output", () => {
    expect(notCodeStop(run([entry("sub/plan", "PLAN_STATUS: NOT_CODE")]))).toBe(true);
    expect(notCodeStop(run([entry("plan", "why\r\nPLAN_STATUS: NOT_CODE\r\n")]))).toBe(true);
  });
});

describe("parkedComment", () => {
  it("ends with the marker", () => {
    expect(parkedComment("claude-factory", "r1").split("\n").at(-1)).toBe("<!-- claude-factory run=r1 parked -->");
    expect(parkedComment("claude-factory").split("\n").at(-1)).toBe("<!-- claude-factory parked -->");
  });
  it("names the label and counts as ours, not as a status comment", () => {
    const body = parkedComment("Factory_go", "r1");
    expect(body).toContain("`Factory_go`");
    const c = { author: { login: "bot" }, body, createdAt: "2026-01-01T00:00:00Z" };
    expect(isBot(c)).toBe(true);
    expect(isStatusComment(c)).toBe(false);
  });
});
