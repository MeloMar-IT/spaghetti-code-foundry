import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeIssue, listNewestIssues, listOpenIssues, updateIssue } from "../src/github.js";
import { fakeGithub, type FakeIssue } from "./helpers/fake-github.js";

let gh: ReturnType<typeof fakeGithub>;
beforeAll(() => {
  gh = fakeGithub();
});
afterAll(() => gh.restore());

const issue = (number: number, over: Partial<FakeIssue> = {}): FakeIssue => ({
  number, state: "open", state_reason: null, title: `T${number}`, body: "", labels: [], html_url: `https://github.com/o/r/issues/${number}`,
  created_at: "2026-01-01T00:00:00Z", closed_at: null, ...over,
});
const many = (n: number, over: (i: number) => Partial<FakeIssue> = () => ({})) => Array.from({ length: n }, (_, i) => issue(i + 1, over(i + 1)));
const listCalls = (since: number) => gh.ghLog().slice(since).split("\n").filter((l) => l.startsWith("gh api repos/o/r/issues?"));

describe("listOpenIssues", () => {
  it("reads 99 issues in one call", async () => {
    gh.setBugIssues(many(99).reverse());
    const at = gh.ghLog().length;
    const r = await listOpenIssues("o/r", { pages: 1 });
    expect(listCalls(at)).toHaveLength(1);
    expect(r.cut).toBe(false);
    expect(r.issues.map((i) => i.number)).toEqual(many(99).map((i) => i.number));
  });
  it("100 with pages 1 is not cut, but the sentinel is called", async () => {
    gh.setBugIssues(many(100));
    const at = gh.ghLog().length;
    const r = await listOpenIssues("o/r", { pages: 1 });
    const calls = listCalls(at);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("page=2");
    expect(r.cut).toBe(false);
    expect(r.issues).toHaveLength(100);
  });
  it("101 with pages 1 is cut", async () => {
    gh.setBugIssues(many(101));
    const r = await listOpenIssues("o/r", { pages: 1 });
    expect(r.cut).toBe(true);
    expect(r.issues).toHaveLength(100);
  });
  it("101 with pages 2 is complete", async () => {
    gh.setBugIssues(many(101));
    const at = gh.ghLog().length;
    const r = await listOpenIssues("o/r", { pages: 2 });
    expect(r.issues).toHaveLength(101);
    expect(listCalls(at)).toHaveLength(2);
    expect(r.cut).toBe(false);
  });
  it("leaves out pull requests but counts them as full", async () => {
    gh.setBugIssues(many(100, (n) => (n <= 3 ? { pull_request: {} } : {})));
    const at = gh.ghLog().length;
    const r = await listOpenIssues("o/r", { pages: 1 });
    expect(r.issues).toHaveLength(97);
    expect(listCalls(at)).toHaveLength(2);
  });
  it("leaves out closed issues", async () => {
    gh.setBugIssues([issue(1), issue(2, { state: "closed" }), issue(3)]);
    expect((await listOpenIssues("o/r", { pages: 1 })).issues.map((i) => i.number)).toEqual([1, 3]);
  });
  it("rejects a bad page count and a failing call", async () => {
    await expect(listOpenIssues("o/r", { pages: 0 })).rejects.toThrow(/pages/);
    process.env.FAKE_GH_FAIL_API = "list";
    try {
      await expect(listOpenIssues("o/r", { pages: 1 })).rejects.toThrow();
    } finally {
      delete process.env.FAKE_GH_FAIL_API;
    }
  });
  it("a list call without page= is unchanged: newest first, closed included", async () => {
    gh.setBugIssues([issue(1), issue(2, { state: "closed" }), issue(3)]);
    expect((await listNewestIssues("o/r")).map((i) => i.number)).toEqual([3, 2, 1]);
  });
});

describe("closeIssue", () => {
  it("closes through the API", async () => {
    gh.setBugIssues([issue(7)]);
    const r = await closeIssue("o/r", 7, "not_planned");
    expect(r.state).toBe("closed");
    expect(gh.closedIssues()).toEqual([{ issue: 7, state: "closed", state_reason: "not_planned" }]);
    expect(gh.bugIssues()[0]!.closed_at).toBeTruthy();
    expect(gh.updatedBodies()).toEqual([]);
    expect(gh.ghLog()).toContain("--- closed issue 7 (api):");
  });
  it("rejects an unknown issue", async () => {
    gh.setBugIssues([issue(7)]);
    await expect(closeIssue("o/r", 99, "completed")).rejects.toThrow();
  });
  it("rejects when GitHub does not report it closed with that reason", async () => {
    const bin = join(gh.tmp, "bin");
    mkdirSync(bin, { recursive: true });
    const answers = ['{"number":7,"state":"open","state_reason":null}', '{"number":7,"state":"closed","state_reason":"completed"}'];
    for (const [i, answer] of answers.entries()) {
      const script = join(bin, `gh-open-${i}`);
      writeFileSync(script, `#!/bin/sh\ncat >/dev/null\necho '${answer}'\n`);
      chmodSync(script, 0o755);
      process.env.FACTORY_GH_BIN = script;
      try {
        await expect(closeIssue("o/r", 7, "not_planned")).rejects.toThrow(/closed/);
      } finally {
        delete process.env.FACTORY_GH_BIN;
      }
    }
  });
});

describe("updateIssue", () => {
  it("sends no title when none is given", async () => {
    gh.setBugIssues([issue(5, { title: "Keep" })]);
    await updateIssue("o/r", 5, { body: "new" });
    const u = gh.updatedBodies().at(-1)!;
    expect(u).toEqual({ issue: 5, body: "new" });
    expect("title" in u).toBe(false);
    expect(gh.bugIssues()[0]!.title).toBe("Keep");
    await updateIssue("o/r", 5, { title: "T", body: "B" });
    expect(gh.updatedBodies().at(-1)).toEqual({ issue: 5, title: "T", body: "B" });
  });
  it("keeps titles and texts off the command line", async () => {
    gh.setBugIssues([issue(6)]);
    await updateIssue("o/r", 6, { title: "Secret title", body: "Secret body" });
    await closeIssue("o/r", 6, "completed");
    const lines = gh.ghLog().split("\n").filter((l) => l.startsWith("gh "));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l).not.toContain("Secret title");
      expect(l).not.toContain("Secret body");
    }
  });
});
