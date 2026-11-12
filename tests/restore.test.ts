import { describe, expect, it } from "vitest";
import { RESTORE_NOT_UNDONE, RESTORE_OTHERS, restoreIssue, restoreMarker, takenBack } from "../src/restore.js";
import type { SafeChange, SafePoint } from "../src/safe-points.js";

const sha = (c: string) => c.repeat(40);
const point = (c: string, at: string, changes: SafeChange[], over: Partial<SafePoint> = {}): SafePoint =>
  ({ commit: sha(c), short: sha(c).slice(0, 7), branch: "develop", at, release: false, changes, by: { kind: "you" }, ...over });
// newest first, as the route answers
const four = [
  point("4", "2026-11-04T10:00:00.000Z", [{ issue: 4, title: "Four" }]),
  point("3", "2026-11-03T10:00:00.000Z", [{ issue: 3, title: "Three" }]),
  point("2", "2026-11-02T10:00:00.000Z", [{ issue: 2, title: "Two" }]),
  point("1", "2026-11-01T10:00:00.000Z", [{ issue: 1, title: "One" }]),
];

describe("takenBack", () => {
  it("lists only the changes of the newer points", () => {
    expect(takenBack(four, sha("2"))).toEqual({ changes: [{ issue: 4, title: "Four" }, { issue: 3, title: "Three" }], more: 0 });
  });
  it("is empty for the newest point and undefined for an unknown commit", () => {
    expect(takenBack(four, sha("4"))).toEqual({ changes: [], more: 0 });
    expect(takenBack(four, sha("9"))).toBeUndefined();
  });
  it("lists a change once, also when two newer points hold it", () => {
    const pts = [point("3", "2026-11-03T00:00:00.000Z", [{ issue: 7, title: "Seven" }]), point("2", "2026-11-02T00:00:00.000Z", [{ issue: 7, title: "Seven again" }]), point("1", "2026-11-01T00:00:00.000Z", [])];
    expect(takenBack(pts, sha("1"))?.changes).toEqual([{ issue: 7, title: "Seven" }]);
  });
  it("leaves out a change that is also in the chosen point or an older one (release checks list old merges)", () => {
    const pts = [point("3", "2026-11-03T00:00:00.000Z", [{ issue: 1, title: "One" }, { issue: 3, title: "Three" }]), point("2", "2026-11-02T00:00:00.000Z", [{ issue: 1, title: "One" }])];
    expect(takenBack(pts, sha("2"))?.changes).toEqual([{ issue: 3, title: "Three" }]);
  });
  it("lists a change without a number by its title, and adds nothing for a baseline point", () => {
    const pts = [point("3", "2026-11-03T00:00:00.000Z", []), point("2", "2026-11-02T00:00:00.000Z", [{ title: "Loose" }]), point("1", "2026-11-01T00:00:00.000Z", [])];
    expect(takenBack(pts, sha("1"))?.changes).toEqual([{ title: "Loose" }]);
  });
  it("caps the list and counts the rest as a lower bound", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ issue: i + 10, title: `C${i}` }));
    const pts = [point("2", "2026-11-02T00:00:00.000Z", many.slice(0, 20), { moreChanges: 3 }), point("3", "2026-11-03T00:00:00.000Z", many.slice(20)), point("1", "2026-11-01T00:00:00.000Z", [])];
    const t = takenBack([pts[1]!, pts[0]!, pts[2]!], sha("1"))!;
    expect(t.changes).toHaveLength(20);
    // 5 distinct changes overflow the list; the 3 hidden by point 2 may or may not be among them, so the larger is used
    expect(t.more).toBe(5);
  });
  it("does not add up the counts of overlapping points", () => {
    const pts = [
      point("3", "2026-11-03T00:00:00.000Z", [], { moreChanges: 3 }),
      point("2", "2026-11-02T00:00:00.000Z", [], { moreChanges: 3 }),
      point("1", "2026-11-01T00:00:00.000Z", []),
    ];
    expect(takenBack(pts, sha("1"))?.more).toBe(3);
  });
  it("keeps the larger of the hidden count and the overflow when both overlap", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ issue: i + 10, title: `C${i}` }));
    const pts = [
      point("3", "2026-11-03T00:00:00.000Z", many, { moreChanges: 3 }),
      point("2", "2026-11-02T00:00:00.000Z", many.slice(0, 5), { moreChanges: 3 }),
      point("1", "2026-11-01T00:00:00.000Z", []),
    ];
    const t = takenBack(pts, sha("1"))!;
    expect(t.changes).toHaveLength(20);
    expect(t.more).toBe(5);
  });
});

describe("restoreIssue", () => {
  const p = four[2]!;
  it("names the branch and the full commit, the changes, the fixed sentences, the way and the marker", () => {
    const { title, body } = restoreIssue(p, { changes: [{ issue: 4, title: "Four" }], more: 2 });
    expect(title).toBe("Restore the version 2222222 from 2026-11-02");
    for (const s of [sha("2"), "`develop`", "#4 `Four`", "and at least 2 more", RESTORE_OTHERS, RESTORE_NOT_UNDONE, "git revert", "force-push", restoreMarker(sha("2"))]) expect(body).toContain(s);
    expect(body).not.toContain("### Failing tests to fix");
  });
  it("puts titles in code spans without backticks or line breaks", () => {
    const { body } = restoreIssue(p, { changes: [{ title: "a`b\n@x" }], more: 0 });
    expect(body).toContain("- `a b @x`");
    expect(body).not.toMatch(/^@x/m);
  });
  it("names the failing tests only when it is given them", () => {
    const { body } = restoreIssue(p, { changes: [], more: 0 }, ["suite > test one", "other"]);
    expect(body).toContain("### Failing tests to fix\n- `suite > test one`\n- `other`");
    expect(body).toContain("no change of the Foundry is known");
  });
});
