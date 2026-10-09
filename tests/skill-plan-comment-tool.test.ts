import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePlanCommentFacts, planBodyHashOf } from "../src/skills/plan-record-rules.js";

const run = (input: string, ...args: string[]) => spawnSync(process.execPath, [resolve("tools/plan-comment"), ...args], { input, encoding: "utf8" });
const MARK = "<!-- claude-factory run=r-1 plan -->";
const plan = (id: number, over: Record<string, unknown> = {}) => ({ body: `The secret plan ${id}\n${MARK}`, url: `https://github.com/a/x/issues/5#issuecomment-${id}`, viewerDidAuthor: true, ...over });
const human = (over: Record<string, unknown> = {}) => ({ body: "looks good", url: "https://github.com/a/x/issues/5#issuecomment-900", viewerDidAuthor: false, ...over });
const list = (comments: unknown[]) => {
  const r = run(JSON.stringify({ comments }));
  expect(r.status).toBe(0);
  return parsePlanCommentFacts(r.stdout)!.comments;
};

describe("tools/plan-comment hash", () => {
  it("hashes the normalised body", () => {
    const a = run("a\r\nb  \n\n", "hash");
    expect(a.status).toBe(0);
    expect(a.stdout.trim()).toBe(run("a\nb", "hash").stdout.trim());
    expect(a.stdout.trim()).toBe(planBodyHashOf("a\nb"));
  });
  it("refuses an empty body and an unknown argument", () => {
    expect(run(" \n", "hash").status).toBe(1);
    expect(run("", "hash").stdout).toContain("empty");
    expect(run("x", "other").status).toBe(1);
  });
});

describe("tools/plan-comment", () => {
  it("finds a plan comment with CRLF and trailing white space; its hash matches `hash`", () => {
    const body = `Plan\r\n${MARK}  \r\n\r\n`;
    const [c] = list([plan(11, { body })]);
    expect(c).toEqual({ id: "11", sha256: run(body, "hash").stdout.trim(), mine: true, later: 0 });
  });
  it("does not list a comment that only quotes the marker, or has no usable link", () => {
    expect(list([plan(1, { body: `> ${MARK}\nmore` }), plan(2, { body: `${MARK}\nmore` }), plan(3, { url: undefined }), plan(4, { url: "https://x/y" }), plan(5, { body: 7 })])).toEqual([]);
  });
  it("counts later comments that are not ours", () => {
    expect(list([plan(1), human()])[0]!.later).toBe(1);
    expect(list([plan(1), human({ body: "x\n<!-- claude-factory status -->" })])[0]!.later).toBe(1);
    expect(list([plan(1), { body: "x\n<!-- claude-factory status -->", viewerDidAuthor: true }])[0]!.later).toBe(0);
    expect(list([plan(1), plan(2, { viewerDidAuthor: true })])[0]!.later).toBe(0);
  });
  it("does not count any Foundry comment of ours, whatever its marker", () => {
    for (const m of ["run=r-2 approval", "run=r-2 questions", "run=r-2 daily", "run=r-2 release", "status", "monitor=0123456789abcdef"]) {
      expect(list([plan(1), { body: `x\n<!-- claude-factory ${m} -->`, viewerDidAuthor: true }])[0]!.later, m).toBe(0);
      expect(list([plan(1), { body: `x\n<!-- claude-factory ${m} -->`, viewerDidAuthor: false }])[0]!.later, m).toBe(1);
    }
  });
  it("counts a marked comment without viewerDidAuthor, and it is not mine", () => {
    const withoutFlag = plan(2);
    delete (withoutFlag as Record<string, unknown>).viewerDidAuthor;
    const out = list([plan(1), withoutFlag]);
    expect(out.map((c) => [c.id, c.mine, c.later])).toEqual([["1", true, 1], ["2", false, 0]]);
  });
  it("lists the newest 30, oldest first", () => {
    const out = list(Array.from({ length: 35 }, (_, i) => plan(i + 1)));
    expect(out).toHaveLength(30);
    expect(out[0]!.id).toBe("6");
    expect(out.at(-1)!.id).toBe("35");
  });
  it("fails on input it cannot read", () => {
    for (const input of ["{oops", "[]", '{"comments":1}', ""]) {
      const r = run(input);
      expect(r.status).toBe(1);
      expect(r.stdout.trim()).toBe("plan check: the comments could not be read");
    }
  });
  it("prints one line and no comment text", () => {
    const r = run(JSON.stringify({ comments: [plan(1), human({ body: "private words" })] }));
    expect(r.stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(r.stdout).not.toMatch(/secret|private|words|looks/);
  });
});
