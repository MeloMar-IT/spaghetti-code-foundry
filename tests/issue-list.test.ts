import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withGhEnv, type RestIssue } from "../src/github.js";
import { dependencies } from "../src/queue/deps.js";
import {
  dropIssueList, freshIssueList, isTrackingEpic, issueListsDir, storiesIn, readIssueList, recordContext, saveIssueList, storedIssueListRepos, toRecord, type IssueRecord,
} from "../src/queue/issue-list.js";
import { fakeGithub } from "./helpers/fake-github.js";

const rest = (number: number, over: Partial<RestIssue> = {}): RestIssue => ({
  number, state: "open", title: `Title ${number}`, body: "", html_url: `https://github.com/o/r/issues/${number}`,
  created_at: "2026-01-01T00:00:00Z", labels: [], ...over,
});
const recordOf = (issue: RestIssue, others: RestIssue[] = []) => toRecord(issue, recordContext([issue, ...others].map((i) => ({
  number: i.number, title: i.title, state: i.state, labels: i.labels.map((l) => ({ name: typeof l === "string" ? l : l.name ?? "" })),
}))));
const withBody = (body: string, number = 5, others: RestIssue[] = []) => recordOf(rest(number, { body }), others);

describe("toRecord", () => {
  it("reads the part-of lines", () => {
    expect(withBody("Part of #12").partOf).toBe(12);
    expect(withBody("Part 2 of 4 of #12").partOf).toBe(12);
  });
  it("reads epic and parent markers", () => {
    expect(withBody("**Epic:** #7").epic).toBe(7);
    expect(withBody("Parent: #7").parent).toBe(7);
    expect(withBody("**Parent:** #7").parent).toBe(7);
    expect(withBody("**Epic:** Updates").epic).toBeUndefined();
  });
  it("ignores markers in bullets and code fences, self references and huge numbers", () => {
    expect(withBody("- **Epic:** #7").epic).toBeUndefined();
    expect(withBody("- Parent: #7").parent).toBeUndefined();
    expect(withBody("```\n**Epic:** #7\nParent: #8\n```").epic).toBeUndefined();
    expect(withBody("~~~\nParent: #8\n~~~").parent).toBeUndefined();
    expect(withBody("**Epic:** #5").epic).toBeUndefined();
    expect(withBody("Part of #2147483648").partOf).toBeUndefined();
    expect(withBody("Parent: #5").parent).toBeUndefined();
  });
  it("a fence closes only with the same character and at least the same length", () => {
    expect(withBody("```\n~~~\nParent: #7\n```").parent).toBeUndefined();
    expect(withBody("~~~\n```\nParent: #7\n~~~").parent).toBeUndefined();
    expect(withBody("````\n```\nParent: #7\n````").parent).toBeUndefined();
    expect(withBody("```\nx\n```\nParent: #7").parent).toBe(7);
    expect(withBody("~~~~\nx\n~~~~~\nParent: #7").parent).toBe(7);
  });
  it("leaves out dependencies that are out of range, and the file stays readable", () => {
    const r = withBody("Depends on #0, #2147483648, #3");
    expect(r.dependsOn).toEqual([3]);
    const gh = fakeGithub();
    try {
      saveIssueList("o/r", [withBody("Depends on #0 #2147483648")], new Date(), false);
      expect(readIssueList("o/r")!.issues[0]!.dependsOn).toEqual([]);
    } finally {
      gh.restore();
    }
  });
  it("first marker wins and carriage returns do not matter", () => {
    expect(withBody("Parent: #3\r\nParent: #4").parent).toBe(3);
    expect(withBody("**Epic:** #7\r\n").epic).toBe(7);
  });
  it("reads epic labels", () => {
    const label = (name: string, others: RestIssue[] = [], number = 5) => recordOf(rest(number, { labels: [{ name }] }), others).epicLabel;
    expect(label("epic: 7")).toEqual({ name: "7", issue: 7 });
    expect(label("epic: #7")).toEqual({ name: "7", issue: 7 });
    expect(label("epic: 7", [], 7)).toEqual({ name: "7" });
    expect(label("Epic: Website", [rest(9, { title: "website" })])).toEqual({ name: "Website", issue: 9 });
    expect(label("Epic: Website", [rest(9, { title: "website" }), rest(8, { title: " Website " })])).toEqual({ name: "Website", issue: 8 });
    expect(label("epic: Nothing")).toEqual({ name: "Nothing" });
    expect(label("bug")).toBeUndefined();
  });
  it("takes string labels and named labels", () => {
    expect(recordOf(rest(5, { labels: ["a", { name: "b" }] })).labels).toEqual(["a", "b"]);
  });
  it("dependsOn is what dependencies() says", () => {
    const others = [rest(2, { title: "Install the update" }), rest(3, { title: "Other thing" })];
    const ctx = recordContext([rest(5), ...others].map((i) => ({ number: i.number, title: i.title, state: i.state })));
    for (const body of ["Depends on #3", "Depends on: Install the update"]) {
      expect(toRecord(rest(5, { body }), ctx).dependsOn).toEqual(dependencies(body, 5, ctx.all));
    }
    expect(withBody("Depends on #3", 5, others).dependsOn).toEqual([3]);
    expect(withBody("Depends on: Install the update", 5, others).dependsOn).toEqual([2]);
  });
  it("reads stories from a section or from task-list lines", () => {
    expect(withBody("intro #99\n### Stories\n- #12 first\n- [ ] #11 second\n- see #12 and #5\n### Other\n- #77").stories).toEqual([11, 12]);
    expect(withBody("**User stories**\n- #4\n").stories).toEqual([4]);
    expect(withBody("- [ ] #3 a\n- [x] #2 b\n- note #9\n- [ ] later #8").stories).toEqual([2, 3]);
    expect("stories" in withBody("nothing here")).toBe(false);
  });
  it("copies state_reason and closed_at, leaves null out", () => {
    const closed = recordOf(rest(5, { state: "closed", state_reason: "completed", closed_at: "2026-02-01T00:00:00Z" }));
    expect(closed).toMatchObject({ state: "closed", stateReason: "completed", closedAt: "2026-02-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z" });
    const open = recordOf(rest(5, { state_reason: null, closed_at: null }));
    expect("stateReason" in open).toBe(false);
    expect("closedAt" in open).toBe(false);
  });
});

describe("the issue list file", () => {
  let gh: ReturnType<typeof fakeGithub>;
  beforeEach(() => { gh = fakeGithub(); });
  afterEach(() => gh.restore());

  const records = (): IssueRecord[] => [recordOf(rest(1, { labels: ["epic: 2"] })), recordOf(rest(2, { state: "closed", state_reason: "completed", closed_at: "2026-02-01T00:00:00Z" }))];

  it("never holds an issue body or a secret", () => {
    const TOKEN = "ghp_" + "a1B2c3D4e5".repeat(4);
    const r = recordOf(rest(5, { body: `${TOKEN}\n**Epic:** #7` }));
    expect(r.epic).toBe(7);
    saveIssueList("o/r", [r], new Date(), false);
    const text = readFileSync(join(issueListsDir(), "o%2Fr.json"), "utf8");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("body");
  });
  it("saves and reads the same records, readAt and cut, and leaves no temporary file", () => {
    const at = new Date("2026-03-01T10:00:00Z");
    saveIssueList("o/r", records(), at, true);
    expect(readIssueList("o/r")).toEqual({ repo: "o/r", readAt: at.toISOString(), cut: true, issues: records() });
    expect(readdirSync(issueListsDir()).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
  it("gives undefined for a missing file, broken JSON, a wrong shape and another repository", () => {
    expect(readIssueList("o/r")).toBeUndefined();
    mkdirSync(issueListsDir(), { recursive: true });
    const file = join(issueListsDir(), "o%2Fr.json");
    writeFileSync(file, "{ nope");
    expect(readIssueList("o/r")).toBeUndefined();
    const good = { repo: "o/r", readAt: "2026-03-01T10:00:00Z", cut: false, issues: JSON.parse(JSON.stringify(records())) };
    for (const bad of [
      { ...good, cut: "no" }, { ...good, readAt: "never" }, { ...good, issues: [{ ...good.issues[0], state: "weird" }] },
      { ...good, issues: [{ ...good.issues[0], number: 0 }] }, { ...good, issues: [{ ...good.issues[0], dependsOn: ["1"] }] },
      { ...good, issues: [{ ...good.issues[0], epicLabel: { name: 7 } }] }, [], null,
    ]) {
      writeFileSync(file, JSON.stringify(bad));
      expect(readIssueList("o/r")).toBeUndefined();
    }
    writeFileSync(file, JSON.stringify(good));
    expect(readIssueList("o/r")).toBeDefined();
    writeFileSync(file, JSON.stringify({ ...good, repo: "o/other" }));
    expect(readIssueList("o/r")).toBeUndefined();
  });
  it("drops a file and lists the stored repositories", () => {
    expect(storedIssueListRepos()).toEqual([]);
    saveIssueList("o/r", records(), new Date(), false);
    saveIssueList("o/s", records(), new Date(), false);
    expect(storedIssueListRepos().sort()).toEqual(["o/r", "o/s"]);
    dropIssueList("o/r");
    expect(readIssueList("o/r")).toBeUndefined();
    expect(storedIssueListRepos()).toEqual(["o/s"]);
  });
});

describe("freshIssueList", () => {
  let gh: ReturnType<typeof fakeGithub>;
  beforeEach(() => { gh = fakeGithub(); });
  afterEach(() => {
    delete process.env.FAKE_GH_ISSUES;
    gh.restore();
  });

  const gi = (n: number, over: Record<string, unknown> = {}) => ({ number: n, title: `Title ${n}`, body: "", labels: [], state: "OPEN", createdAt: "2026-01-01T00:00:00Z", ...over });
  const setList = (list: unknown[]) => { process.env.FAKE_GH_ISSUES = JSON.stringify(list); };
  const many = (n: number, over: Record<number, Record<string, unknown>> = {}) => Array.from({ length: n }, (_, i) => gi(i + 1, over[i + 1]));
  const firstPages = () => gh.ghLog().split("\n").filter((l) => l.includes("state=all") && l.endsWith("page=1")).length;
  const logHas = (text: string, count = 1) => gh.ghLog().split("\n").filter((l) => l.includes(text)).length >= count;
  const until = async (cond: () => boolean) => { for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setTimeout(r, 20)); expect(cond()).toBe(true); };
  const as = (stamp: string, fn: () => Promise<unknown>) => withGhEnv({ stamp }, fn) as ReturnType<typeof freshIssueList>;
  const titleIn = (repo = "o/r") => readIssueList(repo)?.issues[0]?.title;

  it("two calls at once make one read; a later since reads again; an earlier since reuses it", async () => {
    setList(many(3));
    const [a, b] = await Promise.all([freshIssueList("o/r", { since: 0 }), freshIssueList("o/r", { since: 0 })]);
    expect(firstPages()).toBe(1);
    expect(a).toMatchObject({ ok: true, saved: true, cut: false });
    expect(b).toMatchObject({ ok: true, saved: true });
    expect(readIssueList("o/r")!.issues.map((i) => i.number)).toEqual([3, 2, 1]);
    await freshIssueList("o/r", { since: 0 });
    expect(firstPages()).toBe(1);
    await freshIssueList("o/r", { since: Date.now() + 1 });
    expect(firstPages()).toBe(2);
  });

  it("keeps sign-ins apart", async () => {
    setList(many(2));
    const r = await Promise.all([as("a", () => freshIssueList("o/r", { since: 0 })), as("a", () => freshIssueList("o/r", { since: 0 })), as("b", () => freshIssueList("o/r", { since: 0 }))]);
    expect(r.every((x) => x.ok)).toBe(true);
    expect(firstPages()).toBe(2);
  });
  it("the host login and a stored one with no sign-in share a read", async () => {
    setList(many(2));
    await Promise.all([freshIssueList("o/r", { since: 0 }), as("host", () => freshIssueList("o/r", { since: 0 }))]);
    expect(firstPages()).toBe(1);
  });
  it("a failing read of one sign-in gives ok false to that sign-in only", async () => {
    setList(many(2));
    process.env.FAKE_GH_FAIL_API = "list";
    const release = gh.hold("state=all");
    const a = as("a", () => freshIssueList("o/r", { since: 0 }));
    await until(() => logHas("state=all"));
    // the held call of "a" started with FAIL_API set; "b" starts without it
    delete process.env.FAKE_GH_HOLD;
    delete process.env.FAKE_GH_FAIL_API;
    const b = await as("b", () => freshIssueList("o/r", { since: 0 }));
    release();
    expect((await a).ok).toBe(false);
    expect(b).toMatchObject({ ok: true, saved: true });
  });

  it("a newer read is not overwritten by an older one that ends later", async () => {
    setList([gi(1, { title: "v1" })]);
    const release = gh.hold("state=all");
    const a = freshIssueList("o/r", { since: 0 });
    await until(() => logHas("state=all"));
    delete process.env.FAKE_GH_HOLD;
    setList([gi(1, { title: "v2" })]);
    const b = await freshIssueList("o/r", { since: Date.now() + 1 });
    expect(b).toMatchObject({ ok: true, saved: true });
    expect(titleIn()).toBe("v2");
    const readAt = readIssueList("o/r")!.readAt;
    release();
    const old = await a;
    expect(old).toMatchObject({ ok: true, saved: false });
    expect((old as { saveError?: string }).saveError).toBeUndefined();
    expect(titleIn()).toBe("v2");
    expect(readIssueList("o/r")!.readAt).toBe(readAt);
  });
  it("an older read still writes when the newer one failed", async () => {
    setList([gi(1, { title: "v1" })]);
    const release = gh.hold("state=all");
    const a = freshIssueList("o/r", { since: 0 });
    await until(() => logHas("state=all"));
    delete process.env.FAKE_GH_HOLD;
    process.env.FAKE_GH_FAIL_API = "list";
    try {
      expect((await freshIssueList("o/r", { since: Date.now() + 1 })).ok).toBe(false);
    } finally {
      delete process.env.FAKE_GH_FAIL_API;
    }
    release();
    expect(await a).toMatchObject({ ok: true, saved: true });
    expect(titleIn()).toBe("v1");
  });

  it("a failing call is ok false; the old file stays and the next call reads again", async () => {
    setList(many(2));
    await freshIssueList("o/r", { since: 0 });
    const before = readIssueList("o/r")!;
    process.env.FAKE_GH_FAIL_API = "list";
    try {
      const r = await freshIssueList("o/r", { since: Date.now() + 1 });
      expect(r).toMatchObject({ ok: false });
      expect((r as { error: string }).error).toContain("gh api");
    } finally {
      delete process.env.FAKE_GH_FAIL_API;
    }
    expect(readIssueList("o/r")).toEqual(before);
    const reads = firstPages();
    expect((await freshIssueList("o/r", { since: 0 })).ok).toBe(true);
    expect(firstPages()).toBe(reads + 1);
  });
  it("a malformed issue on page 2 fails the read and keeps the old file", async () => {
    setList(many(2));
    await freshIssueList("o/r", { since: 0 });
    const before = readIssueList("o/r")!;
    setList(many(101, { 1: { state: "weird" } }));
    const r = await freshIssueList("o/r", { since: Date.now() + 1 });
    expect(r).toMatchObject({ ok: false });
    expect(logHas("state=all") && logHas("page=2")).toBe(true);
    expect(readIssueList("o/r")).toEqual(before);
  });
  it("a failed write is ok with saveError and leaves no temporary file", async () => {
    setList(many(2));
    writeFileSync(issueListsDir(), "not a folder");
    try {
      const r = await freshIssueList("o/r", { since: 0 });
      expect(r).toMatchObject({ ok: true, saved: false });
      expect((r as { saveError?: string }).saveError).toBeTruthy();
      expect((r as { issues: unknown[] }).issues).toHaveLength(2);
    } finally {
      rmSync(issueListsDir(), { force: true });
    }
    expect(existsSync(issueListsDir())).toBe(false);
  });

  it("does not write when nobody wants it any more", async () => {
    setList(many(2));
    let want = true;
    const release = gh.hold("state=all");
    const p = freshIssueList("o/r", { since: 0, wanted: () => want });
    await until(() => logHas("state=all"));
    want = false;
    release();
    expect(await p).toMatchObject({ ok: true, saved: false });
    expect(readIssueList("o/r")).toBeUndefined();
  });
  it("does not write after dropIssueList, and the next call reads again", async () => {
    setList(many(2));
    const release = gh.hold("state=all");
    const p = freshIssueList("o/r", { since: 0 });
    await until(() => logHas("state=all"));
    dropIssueList("o/r");
    release();
    expect(await p).toMatchObject({ ok: true, saved: false });
    expect(readIssueList("o/r")).toBeUndefined();
    const reads = firstPages();
    await freshIssueList("o/r", { since: 0 });
    expect(firstPages()).toBe(reads + 1);
    expect(readIssueList("o/r")).toBeDefined();
  });
  it("writes when one of two callers still wants it", async () => {
    setList(many(2));
    const release = gh.hold("state=all");
    const a = freshIssueList("o/r", { since: 0, wanted: () => false });
    const b = freshIssueList("o/r", { since: 0, wanted: () => true });
    await until(() => logHas("state=all"));
    release();
    await Promise.all([a, b]);
    expect(readIssueList("o/r")).toBeDefined();
  });
});

describe("storiesIn and isTrackingEpic", () => {
  const epic = (body?: string | null, labels: string[] = [], number = 5) => isTrackingEpic({ number, body, labels: labels.map((name) => ({ name })) });
  it("storiesIn lists the stories of the section, or the task list", () => {
    expect(storiesIn("### Stories\n- #12\n- [ ] #11\n### Other\n- #77", 5)).toEqual([11, 12]);
    expect(storiesIn("- [ ] #3 a\n- [x] #2 b", 5)).toEqual([2, 3]);
    expect(storiesIn("## Stories\n- #5", 5)).toEqual([]);
  });
  it("storiesIn follows the rule of toRecord", () => {
    for (const body of ["## Stories\n- #12\n- #5", "- [ ] #3\n- [ ] #9999999999", "nothing", "```\n## Stories\n- #4\n```"]) {
      expect(storiesIn(body, 5)).toEqual(withBody(body).stories ?? []);
    }
  });
  it("is an epic with the epic label or a stories list", () => {
    expect(epic("", ["epic"])).toBe(true);
    expect(isTrackingEpic({ number: 5, labels: ["Epic"] })).toBe(true);
    expect(isTrackingEpic({ number: 5, labels: [" EPIC "] })).toBe(true);
    expect(epic("## Stories\n- #12")).toBe(true);
    expect(epic("**User stories**\n- #4")).toBe(true);
    expect(epic("**Epic:** #7", ["epic"])).toBe(true);
  });
  it("is not an epic otherwise", () => {
    expect(epic("- [ ] #12 docs follow-up")).toBe(false);
    expect(epic("## Stories\n- #5")).toBe(false);
    expect(epic("", ["epic: Foo"])).toBe(false);
    expect(epic("", ["epic: 7"])).toBe(false);
    expect(epic("## Stories")).toBe(false);
    expect(epic("```\n## Stories\n- #12\n```")).toBe(false);
    expect(epic("**Epic:** #7\n## Stories\n- #12")).toBe(false);
    expect(epic("Parent: #7\n## Stories\n- #12")).toBe(false);
    expect(epic(undefined)).toBe(false);
  });
});
