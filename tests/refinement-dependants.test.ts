import { describe, expect, it } from "vitest";
import { dependantComment, dependsOnText, findDependants, originalComment, rangeHash, replaceMarker, rewriteDependsOn } from "../src/refinement/dependants.js";

describe("Windows line ends", () => {
  const body = "Intro #12\r\n### Depends on\r\n#12\r\n- #13 and #12\r\n\r\n### Notes\r\n#12";
  it("rewriteDependsOn keeps every line end", () => {
    const r = rewriteDependsOn(body, 12, [31, 32])!;
    expect(r.before).toBe("#12\r\n- #13 and #12");
    expect(r.after).toBe("#31, #32\r\n- #13 and #31, #32");
    expect(r.body).toBe("Intro #12\r\n### Depends on\r\n" + r.after + "\r\n\r\n### Notes\r\n#12");
  });
  it("rangeHash is over the exact text", () => {
    const h = rangeHash(body)!;
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(rangeHash(body.replace("Intro", "Other").replace("Notes\r\n#12", "Notes\r\nx"))).toBe(h);
    expect(rangeHash(body.replace(/\r\n/g, "\n"))).not.toBe(h);
  });
  it("findDependants gives the CRLF before and after", () => {
    const open = [{ number: 5, title: "Five", body: "### Depends on\r\n#12\r\n- #6\r\n" }];
    expect(findDependants(open, { number: 12, title: "Twelve" }, [31, 32])).toEqual([
      { issue: 5, title: "Five", byHand: false, before: "#12\r\n- #6", after: "#31, #32\r\n- #6" },
    ]);
  });
});

describe("rewriteDependsOn", () => {
  it("replaces references inside the range only", () => {
    const body = "Intro #12\n### Depends on\n#12, #123, owner/repo#12 and #12\n### Notes\n#12";
    const r = rewriteDependsOn(body, 12, [31, 32])!;
    expect(r.after).toBe("#31, #32, #123, owner/repo#12 and #31, #32");
    expect(r.before).toBe("#12, #123, owner/repo#12 and #12");
    const start = body.indexOf("#12, #123");
    expect(r.body.slice(0, start)).toBe(body.slice(0, start));
    expect(r.body).toBe(body.slice(0, start) + r.after + "\n### Notes\n#12");
  });
  it("gives undefined when there is nothing to do", () => {
    expect(rewriteDependsOn("no header #12", 12, [31])).toBeUndefined();
    expect(rewriteDependsOn("### Depends on\n#123\n", 12, [31])).toBeUndefined();
    expect(rewriteDependsOn("#12\n### Depends on\nNone\n", 12, [31])).toBeUndefined();
    expect(rewriteDependsOn("### Depends on\n#12\n", 12, [])).toBeUndefined();
  });
  it("does not cut a reference that runs past the end of a capped range", () => {
    const body = `### Depends on\n${"x".repeat(996)} #12${"3"}`;
    expect(body.indexOf("#123")).toBe(body.length - 4);
    expect(rewriteDependsOn(body, 12, [31, 32])).toBeUndefined();
    const ok = `### Depends on\n${"x".repeat(990)} #12 y`;
    expect(rewriteDependsOn(ok, 12, [31])!.after.endsWith(" #31 y")).toBe(true);
  });
  it("writes a number as #n and a string as it is", () => {
    expect(rewriteDependsOn("### Depends on\n#12\n", 12, ["new issue 2", 31])!.after).toBe("new issue 2, #31");
  });
  it("handles a single part", () => {
    expect(rewriteDependsOn("Depends on: #12", 12, [31])!.after).toBe("#31");
  });
});

describe("rangeHash", () => {
  const body = "before\n### Depends on\n#12\n### Notes\nafter";
  it("hashes the range only", () => {
    const h = rangeHash(body)!;
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(rangeHash("changed\n### Depends on\n#12\n### Notes\nother")).toBe(h);
    expect(rangeHash(body.replace("#12", "#13"))).not.toBe(h);
    expect(rangeHash("nothing")).toBeUndefined();
  });
});

describe("findDependants", () => {
  const original = { number: 12, title: "Story 12 — Audit and monitor updates" };
  const open = [
    { number: 9, title: "Nine" },
    { number: 8, title: "Eight", state: "closed", body: "Depends on: #12" },
    { number: 31, title: "Part", body: "Depends on: #12" },
    { number: 12, title: original.title, body: "Depends on: #12" },
    { number: 6, title: "Six", body: "Depends on: #123" },
    { number: 5, title: "Five", body: "### Depends on\n#12\n" },
    { number: 4, title: "Four", body: "### Depends on\nStory 12 — Audit" },
  ];
  it("finds, skips and orders", () => {
    expect(findDependants(open, original, [31, 32])).toEqual([
      { issue: 4, title: "Four", byHand: true },
      { issue: 5, title: "Five", byHand: false, before: "#12", after: "#31, #32" },
    ]);
    expect(findDependants([...open].reverse(), original, [31, 32]).map((d) => d.issue)).toEqual([4, 5]);
  });
  it("keeps upper-case OPEN", () => {
    expect(findDependants([{ number: 5, title: "Five", state: "OPEN", body: "Depends on: #12" }], original, [31]).map((d) => d.issue)).toEqual([5]);
  });
  it("writes `shown` while `exclude` only skips parts on GitHub", () => {
    expect(findDependants(open, original, [31], ["new issue 1", 31])).toEqual([
      { issue: 4, title: "Four", byHand: true },
      { issue: 5, title: "Five", byHand: false, before: "#12", after: "new issue 1, #31" },
    ]);
    expect(findDependants(open, original, [], ["new issue 1", "new issue 2"]).find((d) => d.issue === 5)!.after).toBe("new issue 1, new issue 2");
  });
  it("uses the title given for the original, not the one in the list", () => {
    const list = [
      { number: 12, title: "Old name", body: "" },
      { number: 4, title: "Four", body: "### Depends on\nNew name\n" },
    ];
    expect(findDependants(list, { number: 12, title: "New name" }, [31])).toEqual([{ issue: 4, title: "Four", byHand: true }]);
    expect(findDependants(list, { number: 12, title: "Old name" }, [31])).toEqual([]);
  });
  it("works when the original is not in the list", () => {
    expect(findDependants(open.filter((i) => i.number !== 12), original, [31, 32]).map((d) => d.issue)).toEqual([4, 5]);
  });
});

describe("replaceMarker", () => {
  it("is a hash line", () => {
    const m = replaceMarker("session-abc", 12);
    expect(m).toMatch(/^<!-- claude-factory replaced=[0-9a-f]{64} -->$/);
    expect(m).not.toContain("session-abc");
    expect(replaceMarker("session-abc", 12)).toBe(m);
    expect(replaceMarker("session-abc", 13)).not.toBe(m);
    expect(replaceMarker("other", 12)).not.toBe(m);
  });
});

describe("comments", () => {
  const marker = replaceMarker("s", 5);
  const base = { original: 12, parts: [31, 32], by: "alice", marker };
  it("dependantComment names parts and ends with the marker", () => {
    for (const kind of ["rewritten", "byHand", "check"] as const) {
      const c = dependantComment({ ...base, kind, before: "#12", after: "#31, #32" });
      expect(c.split("\n").at(-1)).toBe(marker);
      expect(c).toContain("#31, #32");
      expect(c).toContain("#12");
      expect(c).toContain("alice");
    }
  });
  it("rewritten shows Before and After in a growing fence", () => {
    const c = dependantComment({ ...base, kind: "rewritten", before: "a ``` b", after: "x" });
    expect(c).toContain("**Before**");
    expect(c).toContain("**After**");
    expect(c).toContain("````text");
    expect(dependantComment({ ...base, kind: "rewritten", before: "a `````", after: "x" })).toContain("``````text");
  });
  it("byHand and check have no fence and differ", () => {
    const h = dependantComment({ ...base, kind: "byHand" });
    const k = dependantComment({ ...base, kind: "check" });
    expect(h).not.toContain("```");
    expect(k).not.toContain("```");
    expect(h).toContain("by its title");
    expect(k).toContain("changed in the meantime");
  });
  it("originalComment", () => {
    const c = originalComment({ ending: "closes", parts: [31, 32], by: "alice", marker });
    expect(c).toContain("will be closed");
    expect(c).not.toContain("was closed");
    const s = originalComment({ ending: "staysOpen", parts: [31, 32], by: "alice", marker });
    expect(s).toContain("stays open");
    expect(s).not.toContain("closed");
    for (const t of [c, s]) {
      expect(t.split("\n").at(-1)).toBe(marker);
      expect(t).toContain("#31, #32");
      expect(t).toContain("alice");
    }
  });
  it("originalComment: the three endings", () => {
    const o = { parts: [31, 32], by: "alice", marker };
    const open = originalComment({ ...o, ending: "staysOpen" });
    expect(open).toContain("close it by hand");
    expect(open).not.toContain("closed");
    const already = originalComment({ ...o, ending: "closedAlready" });
    expect(already).toContain("closed already");
    expect(originalComment({ ...o, ending: "closes" })).toContain("will be closed as not planned");
  });
  it("originalComment: the 1,000 issue warning, the labels, the list left behind", () => {
    const o = { ending: "staysOpen" as const, parts: [31], by: "alice", marker };
    expect(originalComment(o)).not.toContain("1,000");
    expect(originalComment({ ...o, cut: true })).toContain("1,000");
    expect(originalComment({ ...o, labels: ["Factory_go"] })).toContain("The label `Factory_go` was taken off");
    expect(originalComment({ ...o, labels: ["A", "B"] })).toContain("The labels `A`, `B` were taken off");
    const list = originalComment({ ...o, leftBehind: ["It prints", "Line one\nline two"] });
    expect(list).toContain("- It prints");
    expect(list).toContain("- Line one line two");
    expect(list.split("\n").at(-1)).toBe(marker);
  });
  it("originalComment: one fixed sentence replaces a list that is too long", () => {
    const o = { ending: "staysOpen" as const, parts: [31], by: "alice", marker };
    const long = originalComment({ ...o, leftBehind: ["a criterion", "another criterion"], max: 100 });
    expect(long).not.toContain("- a criterion");
    expect(long).toContain("Some acceptance criteria were left on this issue");
    expect(long.split("\n").at(-1)).toBe(marker);
  });
  it("dependsOnText is the text rewriteDependsOn works on", () => {
    const body = "Intro\n### Depends on\n#12\n\n### Notes";
    expect(dependsOnText(body)).toBe(rewriteDependsOn(body, 12, [31])!.before);
    expect(dependsOnText("no section")).toBeUndefined();
  });
});
