import { describe, expect, it } from "vitest";
import {
  appendNotices, emptyNotices, NOTICE_KEEP_MS, noticesAnswer, parseNotices, pruneNotices, refOf,
  type NoticeState, type RaisedNotice,
} from "../src/notices.js";

// The notices for programs without a server: append, prune, the answer and the file format (#871).

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const same = (s: string) => s;
const raised = (n: number, over: Partial<RaisedNotice> = {}): RaisedNotice => ({
  kind: "turn", title: "Foundry · your turn", text: `text ${n}`, key: `m-${n}`, runId: `r${n}`, link: `https://x.example/#/runs/r${n}`, ref: refOf(`turn|k${n}|s`), ...over,
});

describe("appendNotices", () => {
  it("gives rising sequence numbers and skips a ref that is kept", () => {
    const st = emptyNotices(1000);
    expect(appendNotices(st, [raised(1), raised(2)], NOW, same)).toBe(2);
    expect(appendNotices(st, [raised(2), raised(3)], NOW, same)).toBe(1);
    expect(appendNotices(st, [raised(3), raised(3, { text: "again" })], NOW, same)).toBe(0);
    expect(st.notices.map((n) => n.s)).toEqual([1001, 1002, 1003]);
    expect(st.seq).toBe(1003);
  });

  it("redacts title, text and link, and nothing else", () => {
    const st = emptyNotices(1000);
    const redact = (s: string) => s.replaceAll("SECRET", "[redacted]");
    appendNotices(st, [raised(1, { title: "t SECRET", text: "x SECRET y", link: "https://h/SECRET/z", key: "m-keep" })], NOW, redact);
    expect(st.notices[0]).toMatchObject({ title: "t [redacted]", text: "x [redacted] y", link: "https://h/[redacted]/z", key: "m-keep" });
  });

  it("keeps no raw key or url as the ref", () => {
    const url = "https://github.com/acme/app/pull/7";
    const ref = refOf(`turn|release|${url}|stamp`);
    expect(ref).toMatch(/^[0-9a-f]{64}$/);
    expect(ref).not.toContain("acme");
  });
});

describe("pruneNotices", () => {
  it("drops what is older than 7 days and raises the floor; younger stays", () => {
    const st = emptyNotices(1000);
    appendNotices(st, [raised(1)], NOW - 8 * DAY, same);
    appendNotices(st, [raised(2)], NOW - 6 * DAY, same);
    expect(pruneNotices(st, NOW)).toBe(true);
    expect(st.notices.map((n) => n.s)).toEqual([1002]);
    expect(st.floor).toBe(1001);
    expect(pruneNotices(st, NOW)).toBe(false);
  });

  it("has no count limit: more than 5,000 fresh notices all stay", () => {
    const st = emptyNotices(1000);
    appendNotices(st, Array.from({ length: 5001 }, (_, i) => raised(i)), NOW - DAY, same);
    expect(pruneNotices(st, NOW)).toBe(false);
    expect(st.notices).toHaveLength(5001);
    expect(NOTICE_KEEP_MS).toBe(7 * DAY);
  });
});

describe("noticesAnswer", () => {
  const st = (): NoticeState => {
    const s = emptyNotices(1000);
    appendNotices(s, [raised(1), raised(2, { link: undefined, key: undefined, runId: undefined })], NOW, same);
    return s;
  };

  it("is reset for a missing, low or high since, with a current seq and no notices", () => {
    const s = st();
    for (const since of [undefined, 5, 1999]) expect(noticesAnswer(s, since)).toEqual({ seq: 1002, reset: true, notices: [] });
  });

  it("is empty at the current seq", () => {
    expect(noticesAnswer(st(), 1002)).toEqual({ seq: 1002, notices: [] });
  });

  it("holds only the newer notices in order, with the fields that apply and never the ref", () => {
    const a = noticesAnswer(st(), 1000);
    expect(a.notices).toHaveLength(2);
    expect(a.notices[0]).toEqual({
      seq: 1001, kind: "turn", at: new Date(NOW).toISOString(), title: "Foundry · your turn", text: "text 1", key: "m-1", runId: "r1", link: "https://x.example/#/runs/r1",
    });
    expect(Object.keys(a.notices[1]!).sort()).toEqual(["at", "kind", "seq", "text", "title"]);
    expect(noticesAnswer(st(), 1001).notices.map((n) => n.seq)).toEqual([1002]);
    expect(JSON.stringify(a)).not.toContain("ref");
  });
});

describe("parseNotices", () => {
  it("round-trips", () => {
    const s = emptyNotices(1000);
    appendNotices(s, [raised(1), raised(2, { kind: "summary", key: undefined })], NOW, same);
    expect(parseNotices(JSON.stringify(s))).toEqual(s);
  });

  it("reads a broken file or a bad field as undefined and a newer version as newer", () => {
    expect(parseNotices("{nope")).toBeUndefined();
    expect(parseNotices("[]")).toBeUndefined();
    const s = emptyNotices(1000);
    appendNotices(s, [raised(1)], NOW, same);
    for (const bad of [{ kind: "x" }, { title: 3 }, { at: "now" }, { link: 4 }, { ref: undefined }]) {
      const copy = JSON.parse(JSON.stringify(s)) as { notices: Record<string, unknown>[] };
      Object.assign(copy.notices[0]!, bad);
      expect(parseNotices(JSON.stringify(copy)), JSON.stringify(bad)).toBeUndefined();
    }
    expect(parseNotices(JSON.stringify({ ...s, version: 2 }))).toBe("newer");
  });
});
