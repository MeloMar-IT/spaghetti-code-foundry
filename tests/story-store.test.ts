import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as github from "../src/github.js";
import { STATUS_MARKER, withGhEnv } from "../src/github.js";
import { GitHubStore } from "../src/stories/github-store.js";
import { storeFor, type GhCall } from "../src/stories/store.js";
import { fakeGithub, type FakeIssue } from "./helpers/fake-github.js";

// The store must send the same gh calls as the functions it wraps, and the exact arguments of the calls it makes itself.
// The fake gh logs every call (and the text sent on stdin for the calls that matter); we compare those logs.

const R = "o/r";
let fake: ReturnType<typeof fakeGithub>;
const store = storeFor(R);

beforeAll(() => {
  fake = fakeGithub();
  // The helper only puts the fake on PATH; an inherited FACTORY_GH_BIN would win over it.
  process.env.FACTORY_GH_BIN = resolve("tests/fixtures/fake-gh.sh");
});
afterAll(() => fake.restore());

const issue = (n: number): FakeIssue => ({
  number: n, state: "open", state_reason: null, title: `t${n}`, body: "b", labels: [{ name: "bug" }],
  html_url: `https://github.com/${R}/issues/${n}`, created_at: "2026-01-01T00:00:00Z", closed_at: null,
});

/** The part of the fake gh log that a call adds. */
async function logOf(fn: () => Promise<unknown>): Promise<string> {
  const before = fake.ghLog().length;
  await fn();
  return fake.ghLog().slice(before);
}

/** The lines `gh …` that a call logs. */
async function callsOf(fn: () => Promise<unknown>): Promise<string[]> {
  return (await logOf(fn)).split("\n").filter((l) => l.startsWith("gh "));
}

async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("openChangeWith", () => {
  const o = { head: "f", base: "main", title: "T", body: "B" };
  const run = async (args: string[], stdin: string) => ({ args, stdin });

  it("gives the runner the gh arguments and the body on stdin", async () => {
    expect(await store.openChangeWith(o, run)).toEqual({ args: ["pr", "create", "--repo=o/r", "--head=f", "--base=main", "--title=T", "--body-file", "-"], stdin: "B" });
  });

  it("adds --draft only for draft: true", async () => {
    expect((await store.openChangeWith({ ...o, draft: true }, run)).args.at(-1)).toBe("--draft");
    expect((await store.openChangeWith({ ...o, draft: false }, run)).args).not.toContain("--draft");
  });

  it("keeps a value that starts with - or has spaces in one element", async () => {
    const r = await store.openChangeWith({ ...o, title: "-x", head: "a b\"c" }, run);
    expect(r.args).toContain("--title=-x");
    expect(r.args).toContain("--head=a b\"c");
  });

  it("passes an empty body on, returns the runner's object and its rejection, and does not run gh", async () => {
    const res = { x: 1 };
    const log = await logOf(async () => {
      expect(await store.openChangeWith({ ...o, body: "" }, async (_a, s) => (expect(s).toBe(""), res))).toBe(res);
      await expect(store.openChangeWith(o, () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    });
    expect(log).toBe("");
  });
});

describe("storeFor", () => {
  it("gives one GitHubStore per repository", () => {
    expect(storeFor("o/r")).toBe(storeFor("o/r"));
    expect(storeFor("o/r")).toBeInstanceOf(GitHubStore);
    expect(storeFor("o/r").repo).toBe("o/r");
    expect(storeFor("o/other")).not.toBe(storeFor("o/r"));
  });

  it("keeps the status marker", () => {
    expect(STATUS_MARKER).toBe("<!-- claude-factory status -->");
  });
});

describe("methods that wrap a function of github.ts send the same calls", () => {
  const statusComments = JSON.stringify({ comments: [{ body: `old\n${STATUS_MARKER}`, url: `https://github.com/${R}/issues/7#issuecomment-5`, viewerDidAuthor: true, author: { login: "me" } }] });
  const body = "line one\n$(x) `y` \"z\"";
  const rows: [string, () => Promise<unknown>, () => Promise<unknown>, Record<string, string>?][] = [
    ["listByLabel", () => github.listIssuesByLabel(R, "bug", 5000), () => store.listByLabel("bug", 5000)],
    ["listOpenByLabelPages", () => github.listOpenIssuesByLabelPages(R, "bug", { fromPage: 1, pages: 2 }), () => store.listOpenByLabelPages("bug", { fromPage: 1, pages: 2 })],
    ["listOpen", () => github.listOpenIssues(R, { pages: 2, timeoutMs: 5000 }), () => store.listOpen({ pages: 2, timeoutMs: 5000 })],
    ["listAll", () => github.listAllIssues(R, { pages: 2 }), () => store.listAll({ pages: 2 })],
    ["listNewest", () => github.listNewestIssues(R), () => store.listNewest()],
    ["listNewestCut", () => github.listNewestIssuesCut(R), () => store.listNewestCut()],
    ["get", () => github.restIssue(R, 7), () => store.get(7)],
    ["create", () => github.createIssue(R, { title: "T", body, labels: ["a"] }), () => store.create({ title: "T", body, labels: ["a"] })],
    ["edit", () => github.updateIssue(R, 7, { title: "T2", body }), () => store.edit(7, { title: "T2", body })],
    ["edit without title", () => github.updateIssue(R, 7, { body }), () => store.edit(7, { body })],
    ["setLabels", () => github.setLabels(R, 7, "b", ["a", "b"]), () => store.setLabels(7, "b", ["a", "b"])],
    ["ensureLabel", () => github.ensureLabel(R, "n", "ffffff", "d"), () => store.ensureLabel("n", "ffffff", "d")],
    ["createLabelIfMissing", () => github.createLabelIfMissing(R, "m", "ffffff", "d"), () => store.createLabelIfMissing("m", "ffffff", "d")],
    ["labels", () => github.repoLabels(R), () => store.labels()],
    ["comments", () => github.issueComments(R, 7), () => store.comments(7)],
    ["comment", () => github.commentOnIssue(R, 7, body), () => store.comment(7, body)],
    ["upsertStatusComment", () => github.upsertStatusComment(R, 7, "new", { create: true }), () => store.upsertStatusComment(7, "new", { create: true }), { FAKE_GH_COMMENTS: statusComments }],
    ["close", () => github.closeIssue(R, 7, "not_planned"), () => store.close(7, "not_planned")],
    ["changeState", () => github.pullState(R, 3), () => store.changeState(3)],
    ["changeComments", () => github.prComments(R, 3), () => store.changeComments(3)],
    ["commentOnChange", () => github.commentOnPullRequest(R, 3, body), () => store.commentOnChange(3, body)],
  ];

  it.each(rows)("%s", async (_name, direct, viaStore, env = {}) => {
    fake.setBugIssues([issue(7)]);
    fake.setPulls([{ number: 3, state: "closed", merged: true }]);
    await withEnv(env, async () => {
      const a = await logOf(direct);
      fake.setBugIssues([issue(7)]);
      const b = await logOf(viaStore);
      expect(a).not.toBe("");
      expect(b).toBe(a);
    });
  });

  it("sends the same GraphQL request for states and state, and reads the answer for the right repository", async () => {
    const file = join(fake.tmp, "graphql.log");
    writeFileSync(file, "");
    const by = JSON.stringify({ "o/r": [{ number: 3, state: "CLOSED" }], "p/q": [{ number: 3, state: "OPEN" }, { number: 1, state: "CLOSED" }] });
    await withEnv({ FAKE_GH_GRAPHQL_LOG: file, FAKE_GH_ISSUES_BY_REPO: by }, async () => {
      for (const repo of ["o/r", "p/q"]) {
        writeFileSync(file, "");
        let before = 0;
        const want = await github.issueStates(repo, [3, 1, 3], 5000, () => before++);
        const wantRequest = readFileSync(file, "utf8");
        writeFileSync(file, "");
        let beforeStore = 0;
        const got = await storeFor(repo).states([3, 1, 3], { timeoutMs: 5000, before: () => beforeStore++ });
        expect(readFileSync(file, "utf8")).toBe(wantRequest);
        expect(JSON.parse(wantRequest).variables).toEqual({ owner: repo.split("/")[0], name: repo.split("/")[1] });
        expect([...got]).toEqual([...want]);
        expect(beforeStore).toBe(before);
        writeFileSync(file, "");
        expect(await storeFor(repo).state(3)).toBe(await github.issueState(repo, 3));
      }
      expect(await storeFor("o/r").state(3)).toBe("closed");
      expect(await storeFor("p/q").state(3)).toBe("open");
    });
  });
});

describe("methods that call gh themselves send exactly these arguments", () => {
  it("listOpenWithLabel", async () => {
    const calls = await callsOf(() => store.listOpenWithLabel("ready", { limit: 100 }));
    expect(calls).toEqual([`gh issue list --repo ${R} --label ready --state open --limit 100 --json number,title,labels,body,createdAt,updatedAt`]);
  });

  it("reopen after close", async () => {
    fake.setBugIssues([issue(7)]);
    await store.close(7, "completed");
    const calls = await callsOf(async () => expect((await store.reopen(7)).state).toBe("open"));
    expect(calls).toEqual([`gh api repos/${R}/issues/7 -X PATCH --input -`]);
    expect(fake.closedIssues().at(-1)).toEqual({ issue: 7, state: "open" });
  });

  it("openChange and findChange", async () => {
    const calls = await callsOf(async () => {
      expect(await store.openChange({ head: "feat", title: "T", body: "B" })).toBe("https://github.com/owner/repo/pull/99");
    });
    expect(calls).toEqual([`gh pr create --repo ${R} --head feat --title T --body-file -`]);
    expect(await callsOf(() => store.openChange({ head: "f2", base: "main", title: "T", body: "B", draft: true }))).toEqual([
      `gh pr create --repo ${R} --base main --head f2 --title T --body-file - --draft`,
    ]);
    expect(await callsOf(async () => expect(await store.findChange("feat")).toEqual({ number: 99, url: "https://github.com/owner/repo/pull/99", headRefName: "feat", state: "OPEN" }))).toEqual([
      `gh pr list --repo ${R} --head feat --state open --json number,url,headRefName,state --limit 20`,
    ]);
    expect(await store.findChange("nobody")).toBeUndefined();
  });

  it("updateChange sends the text on stdin", async () => {
    expect(await callsOf(() => store.updateChange(99, { title: "T2", body: "B2" }))).toEqual([`gh pr edit 99 --repo ${R} --title T2 --body-file -`]);
    expect(await logOf(() => store.updateChange("https://github.com/o/r/pull/5", { body: "B3 $(x)" }))).toContain("--body-file -\nB3 $(x)");
    expect(await callsOf(() => store.updateChange("12", { body: "B" }))).toEqual([`gh pr edit 12 --repo ${R} --body-file -`]);
  });

  it("mergeChange and closeChange", async () => {
    expect(await callsOf(() => store.mergeChange(4))).toEqual([`gh pr merge 4 --repo ${R} --squash --delete-branch`]);
    expect(await callsOf(() => store.closeChange("https://github.com/o/r/pull/5"))).toEqual([`gh pr close https://github.com/o/r/pull/5 --repo ${R}`]);
    expect(readFileSync(`${fake.tmp}/gh.log.prclosed`, "utf8").trim()).toBe("https://github.com/o/r/pull/5");
  });

  it("mergedChanges", async () => {
    await withEnv({ FAKE_GH_MERGED_PRS: JSON.stringify([{ number: 2, title: "x" }]) }, async () => {
      expect(await callsOf(async () => expect(await store.mergedChanges(50)).toEqual([{ number: 2, title: "x" }]))).toEqual([
        `gh pr list --repo ${R} --state merged --limit 50 --json number,title,url,mergedAt,baseRefName,body`,
      ]);
    });
  });

  it("checks reads the check runs and skips an entry with no name", async () => {
    const runs = { check_runs: [{ name: "build", status: "completed", conclusion: "success" }, { status: "queued" }, { name: "lint", status: "queued", conclusion: null }] };
    await withEnv({ FAKE_GH_CHECK_RUNS: JSON.stringify(runs) }, async () => {
      expect(await callsOf(async () => {
        expect(await store.checks("abc1234")).toEqual([
          { name: "build", status: "completed", conclusion: "success" },
          { name: "lint", status: "queued", conclusion: null },
        ]);
      })).toEqual([`gh api repos/${R}/commits/abc1234/check-runs?per_page=100`]);
    });
    await withEnv({ FAKE_GH_CHECK_RUNS: "{}" }, async () => {
      await expect(store.checks("abc1234")).rejects.toThrow("no check runs list");
    });
  });

  it("listOpenWithAnyLabel strips quotes from a label", async () => {
    await withEnv({ FAKE_GH_PRIORITY_ISSUES: JSON.stringify([{ number: 4 }]) }, async () => {
      expect(await callsOf(async () => expect(await store.listOpenWithAnyLabel("ready", ['p"1', "p2"], { limit: 1000 })).toEqual([{ number: 4 }]))).toEqual([
        `gh issue list --repo ${R} --label ready --state open --limit 1000 --search label:"p1","p2" sort:created-asc --json number,title,labels,body,createdAt,updatedAt`,
      ]);
    });
  });

  it("listClosedWithAnyLabel", async () => {
    await withEnv({ FAKE_GH_CLOSED_ISSUES: JSON.stringify([{ number: 5 }]) }, async () => {
      expect(await callsOf(async () => expect(await store.listClosedWithAnyLabel(["a", "b"], { limit: 30 })).toEqual([{ number: 5 }]))).toEqual([
        `gh issue list --repo ${R} --state closed --limit 30 --search label:"a","b" sort:updated-desc --json number,title,labels,state`,
      ]);
    });
  });

  it("listWithBodies", async () => {
    expect(await callsOf(() => store.listWithBodies(500))).toEqual([
      `gh issue list --repo ${R} --state all --limit 500 --json number,title,labels,state,body`,
    ]);
  });

  it("isClosed", async () => {
    for (const [state, closed] of [["closed", true], ["CLOSED", true], ["OPEN", false]] as const) {
      await withEnv({ FAKE_GH_ISSUE_STATE: state }, async () => {
        expect(await callsOf(async () => expect(await store.isClosed(7)).toBe(closed))).toEqual([`gh issue view 7 --repo ${R} --json state --jq .state`]);
      });
    }
  });

  it("isClosed rejects when gh fails", async () => {
    await withEnv({ FAKE_GH_FAIL: "issue view" }, async () => {
      await expect(store.isClosed(7)).rejects.toThrow();
    });
  });

  it("stateAndLabels", async () => {
    await withEnv({ FAKE_GH_FRESH: JSON.stringify([{ number: 8, state: "OPEN", labels: [{ name: "x" }] }]) }, async () => {
      expect(await callsOf(async () => expect(await store.stateAndLabels(8)).toEqual({ state: "OPEN", labels: [{ name: "x" }] }))).toEqual([
        `gh issue view 8 --repo ${R} --json state,labels`,
      ]);
    });
  });

  it("searchOverrules", async () => {
    await withEnv({ FAKE_GH_OVERRULE_SEARCH: JSON.stringify([{ number: 3, updatedAt: "t" }]) }, async () => {
      expect(await callsOf(async () => expect(await store.searchOverrules({ since: "2026-01-02", limit: 30 })).toEqual([{ number: 3, updatedAt: "t" }]))).toEqual([
        `gh issue list --repo ${R} --state all --search overrule in:comments updated:>=2026-01-02 --limit 30 --json number,updatedAt`,
      ]);
    });
    await withEnv({ FAKE_GH_OVERRULE_SEARCH: "{}" }, async () => {
      expect(await store.searchOverrules({ since: "2026-01-02", limit: 30 })).toEqual([]);
    });
  });

  it("openChanges", async () => {
    await withEnv({ FAKE_GH_PRS: JSON.stringify([{ number: 9, headRefName: "factory/9", state: "OPEN" }]) }, async () => {
      expect(await callsOf(async () => expect(await store.openChanges(50)).toEqual([{ number: 9, headRefName: "factory/9", state: "OPEN" }]))).toEqual([
        `gh pr list --repo ${R} --state open --limit 50 --json number,headRefName,state,url,title,createdAt`,
      ]);
    });
  });

  it("changeActivity", async () => {
    const view = { comments: [], reviews: [], commits: [{ committedDate: "t" }] };
    await withEnv({ FAKE_GH_PR_VIEW: JSON.stringify(view) }, async () => {
      expect(await callsOf(async () => expect(await store.changeActivity(6)).toEqual(view))).toEqual([`gh pr view 6 --repo ${R} --json comments,reviews,commits`]);
    });
  });

  it("reviewComments", async () => {
    await withEnv({ FAKE_GH_API: JSON.stringify([{ body: "rename", created_at: "t" }]) }, async () => {
      expect(await callsOf(async () => expect(await store.reviewComments(7)).toEqual([{ body: "rename", created_at: "t" }]))).toEqual([`gh api repos/${R}/pulls/7/comments`]);
    });
  });
});

describe("step methods send the arguments of the old flow steps and return gh's text unchanged", () => {
  const OLD_FOUNDRY = String.raw`[.comments[] | select(.viewerDidAuthor == true and ((.body // "") | contains("<!-- claude-factory") or contains("<!-- spaghetti-code-foundry"))) | (.url // "") | select(test("#issuecomment-[0-9]+$")) | capture("#issuecomment-(?<id>[0-9]+)$").id | tonumber]`;

  it("stepIssue", async () => {
    await withEnv({ FAKE_GH_ISSUE_JSON: '{"number":7}' }, async () => {
      expect(await callsOf(async () => expect(await store.stepIssue(7)).toBe('{"number":7}\n'))).toEqual([`gh issue view 7 --repo ${R} --json body,number,title,updatedAt`]);
    });
  });
  it("stepBody", async () => {
    expect(await callsOf(async () => expect(await store.stepBody(7)).toBe("Please add feature.txt\n"))).toEqual([`gh issue view 7 --repo ${R} --json body --jq .body`]);
  });
  it("stepText", async () => {
    const log = await logOf(async () => expect(await store.stepText(7)).toContain("# #7: Add a feature"));
    expect(log).toContain(`gh issue view 7 --repo ${R} --json number,title,body,url,labels,comments --jq \n  "# #\\(.number): \\(.title)`);
    expect(log).toContain(String.raw`(if .viewerDidAuthor == true and ((.body // "") | contains("<!-- claude-factory") or contains("<!-- spaghetti-code-foundry")) then " (Foundry)" else "" end)`);
  });
  it("stepComments", async () => {
    await withEnv({ FAKE_GH_ISSUE_COMMENTS_JSONL: '{"id":1}\n' }, async () => {
      expect(await callsOf(async () => expect(await store.stepComments(7)).toBe('{"id":1}\n'))).toEqual([
        `gh api --paginate repos/${R}/issues/7/comments?per_page=100 --jq .[] | {id, html_url, created_at, updated_at, body}`,
      ]);
    });
  });
  it("stepFoundryComments", async () => {
    await withEnv({ FAKE_GH_FOUNDRY_COMMENTS_JSON: "[2]" }, async () => {
      expect(await callsOf(async () => expect(await store.stepFoundryComments(7)).toBe("[2]"))).toEqual([`gh issue view 7 --repo ${R} --json comments --jq ${OLD_FOUNDRY}`]);
    });
  });
  it("stepComment sends the text on stdin and returns the link", async () => {
    const log = await logOf(async () => expect(await store.stepComment(7, "a $(x)\nb")).toMatch(/^https:\/\/\S+#issuecomment-\d+\n$/));
    expect(log.split("\n").filter((l) => l.startsWith("gh "))).toEqual([`gh issue comment 7 --repo ${R} --body-file -`]);
    expect(log).toContain("--- comment on #7:\na $(x)\nb");
  });
  it("stepCreate runs gh issue create with the text on stdin", async () => {
    const log = await logOf(async () => expect(await store.stepCreate({ title: "T $(x)", body: "B", labels: ["a", "b"] })).toMatch(/^https:\/\/\S+\/issues\/\d+\n$/));
    expect(log).toContain(`--- created issue: issue create --repo ${R} --title T $(x) --body-file - --label a --label b\nB`);
  });

  // The calls that print through gh(): gh may fail in the fake; the arguments are what counts.
  const sent = (fn: () => Promise<unknown>) => callsOf(() => fn().catch(() => undefined));
  // The fake logs with echo, which turns a backslash-n into a line break.
  const logged = (s: string) => s.replace(/\\n/g, "\n");
  const OLD_PLAIN =String.raw`
    "# #\(.number): \(.title)\nLabels: \([.labels[].name] | join(", "))\n\n\(.body)\n"
    + ([.comments[] | "\n--- comment by \(.author.login):\n\(.body)"] | join("\n"))`;
  const OLD_QUERY = String.raw`query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){author{login} lastEditedBy{login}}}}`;
  const OLD_AUTHORS = String.raw`.data.repository.issue | [(.author.login // ""), (.lastEditedBy.login // "")] | join(" ")`;
  const OLD_PR_TEXT = String.raw`"# PR #\(.number // "") \(.title)\n\(.body)\n"`;
  const OLD_LINES = String.raw`.[] | select(.body | (contains("claude-factory") or contains("spaghetti-code-foundry")) | not) | "--- \(.user.login) on \(.path):\(.line // .original_line):\n\(.body)\n"`;
  const OLD_REVIEWS = String.raw`
  (.reviews[] | select(.body != "") | "--- review by \(.author.login) (\(.state)):\n\(.body)\n"),
  (.comments[] | select(.body | (contains("claude-factory") or contains("spaghetti-code-foundry")) | not) | "--- \(.author.login):\n\(.body)\n")`;

  it("the issue steps send the old arguments", async () => {
    expect(await sent(() => store.stepTitle(7))).toEqual([`gh issue view 7 --repo ${R} --json title -q .title`]);
    expect(await sent(() => store.stepLabels(7))).toEqual([`gh issue view 7 --repo ${R} --json labels --jq .labels[].name`]);
    expect(await sent(() => store.stepCommentsAndLabels(7))).toEqual([`gh issue view 7 --repo ${R} --json comments,labels`]);
    const plain = await logOf(() => store.stepPlainText(7).catch(() => undefined));
    expect(plain).toContain(`gh issue view 7 --repo ${R} --json number,title,body,labels,comments --jq ${logged(OLD_PLAIN)}`);
    expect(plain).not.toContain("(Foundry)");
    expect(await logOf(() => store.stepAuthors(7).catch(() => undefined))).toContain(`gh api graphql -F n=7 -f o=o -f r=r -f query=${OLD_QUERY} --jq ${OLD_AUTHORS}`);
    expect(await sent(() => store.stepClose(7, "completed"))).toEqual([`gh issue close 7 --repo ${R} --reason completed`]);
    expect(await sent(() => store.stepClose(7, "not planned"))).toEqual([`gh issue close 7 --repo ${R} --reason not planned`]);
  });

  it("the pull request steps send the old arguments", async () => {
    expect(await sent(() => store.stepFindChange("b"))).toEqual([`gh pr view b --repo ${R} --json url -q .url`]);
    expect(await sent(() => store.stepFindChange(""))).toEqual([`gh pr view  --repo ${R} --json url -q .url`]);
    expect(await sent(() => store.stepReviewDecision("b"))).toEqual([`gh pr view b --repo ${R} --json reviewDecision -q .reviewDecision`]);
    expect(await sent(() => store.stepListChanges({ head: "dev", base: "main" }))).toEqual([`gh pr list --repo ${R} --head dev --base main --state open --json number,headRefName,state`]);
    expect(await sent(() => store.stepSetReady(5, true))).toEqual([`gh pr ready 5 --repo ${R}`]);
    expect(await sent(() => store.stepSetReady(5, false))).toEqual([`gh pr ready 5 --repo ${R} --undo`]);
    const comment = await logOf(() => store.stepCommentOnChange(5, "a $(x)\nb").catch(() => undefined));
    expect(comment).toContain(`gh pr comment 5 --repo ${R} --body-file -`);
    expect(await logOf(() => store.stepChangeText(5).catch(() => undefined))).toContain(`gh pr view 5 --repo ${R} --json number,title,body -q ${logged(OLD_PR_TEXT)}`);
    const lines = await logOf(() => store.stepReviewComments(5).catch(() => undefined));
    expect(lines).toContain(`gh api repos/${R}/pulls/5/comments --jq ${logged(OLD_LINES)}`);
    const reviews = await logOf(() => store.stepReviews(5).catch(() => undefined));
    expect(reviews).toContain(`gh pr view 5 --repo ${R} --json reviews,comments --jq ${logged(OLD_REVIEWS)}`);
    // The new marker is left out of both lists, once each.
    for (const log of [lines, reviews]) expect(log.split('contains("spaghetti-code-foundry")')).toHaveLength(2);
  });

  it.each<[string, () => Promise<unknown>]>([
    ["stepClose(0)", () => store.stepClose(0, "completed")],
    ["stepClose reason", () => store.stepClose(7, "x" as "completed")],
    ["stepTitle(1.5)", () => store.stepTitle(1.5)],
    ["stepMerge option", () => store.stepMerge("--admin")],
    ["stepFindChange option", () => store.stepFindChange("-x")],
    ["stepReviewDecision space", () => store.stepReviewDecision("a b")],
    ["stepChecks space", () => store.stepChecks("a b")],
    ["stepListChanges option", () => store.stepListChanges({ head: "-x", base: "main" })],
    ["stepOpenChange option", () => store.stepOpenChange({ head: "--x", title: "T", body: "b" })],
    ["stepCommentOnChange option", () => store.stepCommentOnChange("--x", "b")],
    ["stepSetReady 0", () => store.stepSetReady(0, true)],
    ["stepCheckout option", () => store.stepCheckout("--x")],
    ["stepChangeText(0)", () => store.stepChangeText(0)],
    ["stepReviews(-1)", () => store.stepReviews(-1)],
    ["stepReviewComments(1.5)", () => store.stepReviewComments(1.5)],
    ["stepOpenStories 0", () => store.stepOpenStories({ limit: 0, comments: false })],
    ["stepOpenStories 5000", () => store.stepOpenStories({ limit: 5000, comments: true })],
  ])("%s is refused before gh runs", async (_name, call) => {
    expect(await logOf(async () => void (await call().then(() => expect.unreachable(), (e) => expect(e).toBeInstanceOf(Error))))).toBe("");
  });

  it.each([0, -1, 1.5])("each refuses %s before gh runs", async (n) => {
    const calls = [() => store.stepIssue(n), () => store.stepBody(n), () => store.stepText(n), () => store.stepComments(n), () => store.stepFoundryComments(n), () => store.stepComment(n, "x")];
    for (const call of calls) {
      expect(await logOf(async () => void (await call().then(() => expect.unreachable(), (e) => expect(e).toBeInstanceOf(Error))))).toBe("");
    }
  });
});

describe("input that could become a gh option is refused before gh runs", () => {
  it.each<[string, () => Promise<unknown>]>([
    ["reopen(0)", () => store.reopen(0)],
    ["reopen(1.5)", () => store.reopen(1.5)],
    ["reviewComments(-1)", () => store.reviewComments(-1)],
    ["updateChange option", () => store.updateChange("--admin", { body: "b" })],
    ["mergeChange shell", () => store.mergeChange("1; x")],
    ["mergeChange other host path", () => store.mergeChange("https://x/y/z/issues/3")],
    ["closeChange 0", () => store.closeChange(0)],
    ["checks path", () => store.checks("../x")],
    ["findChange empty", () => store.findChange("")],
    ["listOpenWithLabel 0", () => store.listOpenWithLabel("x", { limit: 0 })],
    ["mergedChanges big", () => store.mergedChanges(5000)],
    ["isClosed(0)", () => store.isClosed(0)],
    ["stateAndLabels(-1)", () => store.stateAndLabels(-1)],
    ["changeActivity(1.5)", () => store.changeActivity(1.5)],
    ["openChanges(0)", () => store.openChanges(0)],
    ["listWithBodies(5000)", () => store.listWithBodies(5000)],
    ["listClosedWithAnyLabel 0", () => store.listClosedWithAnyLabel(["a"], { limit: 0 })],
    ["listOpenWithAnyLabel 0", () => store.listOpenWithAnyLabel("x", ["a"], { limit: 0 })],
    ["searchOverrules option", () => store.searchOverrules({ since: "--x", limit: 30 })],
    ["searchOverrules limit", () => store.searchOverrules({ since: "2026-01-01", limit: 0 })],
  ])("%s", async (_name, call) => {
    expect(await logOf(async () => void (await call().then(() => expect.unreachable(), (e) => expect(e).toBeInstanceOf(Error))))).toBe("");
  });
});

describe("failures", () => {
  it("openChange rejects when gh fails", async () => {
    await withEnv({ FAKE_GH_FAIL: "pr create" }, async () => {
      await expect(store.openChange({ head: "h", title: "t", body: "b" })).rejects.toThrow();
    });
  });

  it("reopen rejects when the update fails", async () => {
    fake.setBugIssues([issue(7)]);
    await withEnv({ FAKE_GH_FAIL_API: "update" }, async () => {
      await expect(store.reopen(7)).rejects.toThrow();
    });
  });
});

describe("session and timeout", () => {
  it("a call runs in the session of the caller, also for a store made outside it", async () => {
    const auth = fake.authLog();
    const s = storeFor("o/session");
    await withGhEnv({ env: { GH_TOKEN: "tok-a" }, stamp: "a" }, () => s.comments(1));
    await s.comments(1);
    const rows = auth.rows();
    expect(rows[0]!.token).toBe("tok-a");
    expect(rows[1]!.token).not.toBe("tok-a");
    delete process.env.FAKE_GH_AUTH_LOG;
  });

  it("timeoutMs reaches gh", async () => {
    const release = fake.hold("repos");
    try {
      await expect(store.labels(200)).rejects.toThrow();
    } finally {
      release();
    }
    const release2 = fake.hold("pr close");
    try {
      await expect(store.closeChange(1, 200)).rejects.toThrow();
    } finally {
      release2();
      rmSync(join(fake.tmp, "hold"), { force: true });
      delete process.env.FAKE_GH_HOLD;
      delete process.env.FAKE_GH_HOLD_ON;
    }
  });
});

describe("status comment", () => {
  it("creates one with the marker, then edits it", async () => {
    await withEnv({ FAKE_GH_COMMENTS_FROM_LOG: "1" }, async () => {
      const s = storeFor("o/status");
      const first = await s.upsertStatusComment(31, `hello\n${STATUS_MARKER}`, { create: true });
      expect(first.created).toBe(true);
      expect(fake.statusComments().some((c) => c.issue === 31 && c.body.endsWith(STATUS_MARKER))).toBe(true);
      const editsBefore = fake.statusEdits().length;
      const second = await s.upsertStatusComment(31, `changed\n${STATUS_MARKER}`, { create: true });
      expect(second.created).toBeUndefined();
      expect(second.changed).toBe(true);
      expect(fake.statusEdits()).toHaveLength(editsBefore + 1);
      expect(fake.statusComments().filter((c) => c.issue === 31)).toHaveLength(1);
    });
  });
});

describe("sync(): the synchronous part runs the caller's GhCall", () => {
  type Call = { args: string[]; input?: string };
  /** A recording GhCall that answers with `answer` (a string) or throws it (an Error). */
  function recorder(answer: string | Error) {
    const calls: Call[] = [];
    const run: GhCall = (args, input) => {
      calls.push({ args, input });
      if (answer instanceof Error) throw answer;
      return answer;
    };
    return { calls, stories: store.sync(run) };
  }
  const gone = (stderr: string) => Object.assign(new Error("gh failed"), { stderr });

  it("get sends these arguments and upper-cases the state", () => {
    const { calls, stories } = recorder(JSON.stringify({ number: 3, title: "t", state: "closed", body: "b" }));
    expect(stories.get(3)).toEqual({ number: 3, title: "t", state: "CLOSED", body: "b" });
    expect(calls).toEqual([{ args: ["issue", "view", "3", "--repo", R, "--json", "number,title,state,body"], input: undefined }]);
  });

  it.each(["GraphQL: Could not resolve to an Issue with the number of 9.", "HTTP 404: Not Found"])("get gives undefined for %s", (text) => {
    expect(recorder(gone(text)).stories.get(9)).toBeUndefined();
  });

  it("get throws on another gh error, on text that is not JSON and on the wrong number", () => {
    expect(() => recorder(gone("rate limit")).stories.get(3)).toThrow("gh failed");
    expect(() => recorder("not json").stories.get(3)).toThrow("Unexpected answer from gh for #3.");
    expect(() => recorder(JSON.stringify({ number: 4, title: "t" })).stories.get(3)).toThrow("Unexpected answer from gh for #3.");
  });

  it("list sends these arguments, drops malformed entries and upper-cases the state", () => {
    const { calls, stories } = recorder(JSON.stringify([{ number: 1, title: "a", state: "open", body: "x" }, { number: "2", title: "b" }, null, { number: 3, title: "c" }]));
    expect(stories.list(500)).toEqual([{ number: 1, title: "a", state: "OPEN", body: "x" }, { number: 3, title: "c", state: "OPEN", body: "" }]);
    expect(calls[0]!.args).toEqual(["issue", "list", "--repo", R, "--state", "all", "--limit", "500", "--json", "number,title,state,body"]);
  });

  it("list throws when the answer is not a list", () => {
    expect(() => recorder("{}").stories.list(500)).toThrow("Unexpected answer from gh for the issue list.");
  });

  it("setBody sends the body on stdin, not in the arguments", () => {
    const { calls, stories } = recorder("");
    stories.setBody(5, "text $(x)\nmore");
    expect(calls).toEqual([{ args: ["issue", "edit", "5", "--repo", R, "--body-file", "-"], input: "text $(x)\nmore" }]);
  });

  it("refuses a bad number or limit before gh runs", () => {
    const { calls, stories } = recorder("[]");
    expect(() => stories.get(0)).toThrow();
    expect(() => stories.setBody(-1, "b")).toThrow();
    expect(() => stories.list(0)).toThrow();
    expect(() => stories.list(5000)).toThrow();
    expect(calls).toEqual([]);
  });

  it("the text methods send these arguments and return gh's text unchanged", () => {
    const { calls, stories } = recorder(" out\n");
    expect(stories.view(4, "comments,labels")).toBe(" out\n");
    expect(stories.openList(300, "number,title")).toBe(" out\n");
    expect(stories.viewer()).toBe(" out\n");
    expect(stories.listChanges({ state: "open", limit: 20, head: "feat/x", fields: "url,state" })).toBe(" out\n");
    expect(stories.listChanges({ state: "all", limit: 300, fields: "number" })).toBe(" out\n");
    expect(stories.viewChange("https://github.com/a/b/pull/7", "title,body")).toBe(" out\n");
    expect(calls.map((c) => c.args)).toEqual([
      ["issue", "view", "4", "--repo", R, "--json", "comments,labels"],
      ["issue", "list", "--repo", R, "--state", "open", "--limit", "300", "--json", "number,title"],
      ["api", "user", "--jq", ".login"],
      ["pr", "list", "--repo", R, "--head", "feat/x", "--state", "open", "--limit", "20", "--json", "url,state"],
      ["pr", "list", "--repo", R, "--state", "all", "--limit", "300", "--json", "number"],
      ["pr", "view", "https://github.com/a/b/pull/7", "--repo", R, "--json", "title,body"],
    ]);
  });

  it("bodies go on stdin, never in the arguments", () => {
    const { calls, stories } = recorder("https://github.com/a/b/issues/9\n");
    expect(stories.create({ title: "T", body: "b $(x)", labels: ["bug", "x"] })).toBe("https://github.com/a/b/issues/9\n");
    stories.comment(3, "c");
    stories.openChange({ head: "h", base: "main", title: "T", body: "pb", draft: true });
    stories.updateChange(8, { title: "T2", body: "nb" });
    stories.updateChange(8, { body: "only" });
    expect(calls).toEqual([
      { args: ["issue", "create", "--repo", R, "--title", "T", "--body-file", "-", "--label", "bug", "--label", "x"], input: "b $(x)" },
      { args: ["issue", "comment", "3", "--repo", R, "--body-file", "-"], input: "c" },
      { args: ["pr", "create", "--repo", R, "--base", "main", "--head", "h", "--title", "T", "--body-file", "-", "--draft"], input: "pb" },
      { args: ["pr", "edit", "8", "--repo", R, "--title", "T2", "--body-file", "-"], input: "nb" },
      { args: ["pr", "edit", "8", "--repo", R, "--body-file", "-"], input: "only" },
    ]);
  });

  it("setLabels puts the removals first and allows only an add or only removals", () => {
    const { calls, stories } = recorder("");
    stories.setLabels(723, "new", ["a", "b"]);
    stories.setLabels(723, undefined, ["a", "b"]);
    stories.setLabels(723, "new", []);
    expect(calls.map((c) => c.args)).toEqual([
      ["issue", "edit", "723", "--repo", R, "--remove-label", "a", "--remove-label", "b", "--add-label", "new"],
      ["issue", "edit", "723", "--repo", R, "--remove-label", "a", "--remove-label", "b"],
      ["issue", "edit", "723", "--repo", R, "--add-label", "new"],
    ]);
  });

  it("close and requestReview send these arguments", () => {
    const { calls, stories } = recorder("");
    stories.close(5, "not planned");
    stories.close(5, "completed");
    stories.requestReview(9, "octocat");
    expect(calls.map((c) => c.args)).toEqual([
      ["issue", "close", "5", "--repo", R, "--reason", "not planned"],
      ["issue", "close", "5", "--repo", R, "--reason", "completed"],
      ["pr", "edit", "9", "--repo", R, "--add-reviewer", "octocat"],
    ]);
  });

  it("view and openList pass a gh error through", () => {
    const { stories } = recorder(gone("rate limit"));
    expect(() => stories.view(3, "title")).toThrow("gh failed");
    expect(() => stories.openList(10, "title")).toThrow("gh failed");
  });

  it("refuses input that could become an option before gh runs", () => {
    const { calls, stories } = recorder("");
    expect(() => stories.view(0, "title")).toThrow();
    expect(() => stories.openList(1001, "title")).toThrow();
    expect(() => stories.view(1, "--x")).toThrow();
    expect(() => stories.view(1, "a b")).toThrow();
    expect(() => stories.listChanges({ state: "open", limit: 5, head: "-x", fields: "url" })).toThrow();
    expect(() => stories.viewChange("https://github.com/a/b/issues/7", "url")).toThrow();
    expect(() => stories.viewChange("-1", "url")).toThrow();
    expect(() => stories.requestReview(1, "-x")).toThrow();
    expect(() => stories.requestReview(1, "a b")).toThrow();
    expect(() => stories.openChange({ head: "-h", title: "T", body: "b" })).toThrow();
    expect(() => stories.close(1, "other" as never)).toThrow();
    expect(calls).toEqual([]);
  });
});

describe("probeAccess", () => {
  it("sends both paths with the host and lets one failure stand beside the other", async () => {
    const seen: { args: string[]; stdin: string }[] = [];
    const out = await store.probeAccess(async (args, stdin) => {
      seen.push({ args, stdin });
      if (args[1]!.includes("/pulls")) throw new Error("no pulls");
      return "ok";
    });
    expect(seen).toEqual([
      { args: ["api", `repos/${R}/issues?per_page=1`, "--hostname", "github.com"], stdin: "" },
      { args: ["api", `repos/${R}/pulls?per_page=1&state=all`, "--hostname", "github.com"], stdin: "" },
    ]);
    expect(out.stories).toEqual({ status: "fulfilled", value: "ok" });
    expect(out.changes.status).toBe("rejected");
  });
});
