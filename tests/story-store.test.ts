import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as github from "../src/github.js";
import { STATUS_MARKER, withGhEnv } from "../src/github.js";
import { GitHubStore } from "../src/stories/github-store.js";
import { storeFor } from "../src/stories/store.js";
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
