import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRepo } from "../src/auth/repos.js";
import { createUser } from "../src/auth/users.js";
import { type Config, ConfigSchema } from "../src/config.js";
import { clearTokenCache } from "../src/github-app.js";
import { issueStatesDir, knownIssueState, markIssueCheckFailed, saveIssueStates } from "../src/issue-states.js";
import { CLOSED_MESSAGE, type GateRun, gateRun, issuesWatched, resumeGate, runIssue } from "../src/run-gate.js";
import { fakeGithub } from "./helpers/fake-github.js";
import { fakeGithubApp, type FakeGithubApp } from "./helpers/github-app.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { TEST_PASSWORD } from "./helpers/session.js";

const TOKEN = ["github", "pat", ""].join("_") + "Zx9".repeat(12);
const vars = (extra: Record<string, string> = {}) => ({ vars: { github_repo: "acme/app", issue: "7", ...extra } });
const open = async () => "open" as const;
const closed = async () => "closed" as const;
const boom = async (): Promise<"open"> => {
  throw new Error("down");
};
const CLOSED = { ok: false, reason: "issue_closed", message: CLOSED_MESSAGE };

let gh: ReturnType<typeof fakeGithub>;
beforeEach(() => {
  gh = fakeGithub();
});
afterEach(() => {
  delete process.env.FAKE_GH_ISSUES;
  delete process.env.FAKE_GH_EXPECT_TOKEN;
  gh.restore();
});

describe("runIssue", () => {
  it("reads the repository and the issue number", () => {
    expect(runIssue(vars())).toEqual({ repo: "acme/app", issue: 7 });
    expect(runIssue(vars({ issue: "004" }))).toEqual({ repo: "acme/app", issue: 4 });
    expect(runIssue(vars({ github_repo: "ACME/App" }))).toEqual({ repo: "ACME/App", issue: 7 });
  });

  it.each([
    [{ issue: "7" }],
    [{ github_repo: "owner/repo", issue: "7" }],
    [{ github_repo: "OWNER/Repo", issue: "7" }],
    [{ github_repo: "./repo", issue: "7" }],
    [{ github_repo: "acme/.", issue: "7" }],
    [{ github_repo: `${"a".repeat(40)}/app`, issue: "7" }],
    [{ github_repo: "acme/app" }],
    [{ github_repo: "acme/app", issue: "x" }],
    [{ github_repo: "acme/app", issue: "0" }],
    [{ github_repo: "acme/app", issue: "2147483648" }],
    [{ github_repo: "acme/app", pr: "5" }],
  ])("has no issue for %j", (v) => {
    expect(runIssue({ vars: v })).toBeUndefined();
  });
});

describe("resumeGate", () => {
  it("passes an open issue and refuses a closed one with the exact sentence", async () => {
    expect(await resumeGate(vars(), { read: open })).toEqual({ ok: true });
    expect(await resumeGate(vars(), { read: closed })).toEqual(CLOSED);
    expect(CLOSED_MESSAGE).toBe("The issue is closed — nothing to retry. Reopen the issue if the work is still wanted.");
  });

  it("makes no call for a run without an issue", async () => {
    let calls = 0;
    const read = async () => (calls++, "closed" as const);
    expect(await resumeGate({ vars: { github_repo: "acme/app" } }, { read })).toEqual({ ok: true });
    expect(calls).toBe(0);
  });

  it("falls back to the stored state when GitHub cannot be read", async () => {
    saveIssueStates("acme/app", new Map([[7, "closed"]]));
    expect(await resumeGate(vars(), { read: boom })).toEqual(CLOSED);
    saveIssueStates("acme/app", new Map([[7, "open"]]));
    expect(await resumeGate(vars(), { read: boom })).toEqual({ ok: true, unchecked: true });
  });

  it("is unchecked after a failed check alone, and with no entry", async () => {
    expect(await resumeGate(vars(), { read: boom })).toEqual({ ok: true, unchecked: true });
    markIssueCheckFailed("acme/app");
    expect(knownIssueState("acme/app", 7)).toBe("unknown");
    expect(await resumeGate(vars(), { read: boom })).toEqual({ ok: true, unchecked: true });
  });

  it("writes the live result only with store, also when there is no entry yet", async () => {
    saveIssueStates("acme/app", new Map([[7, "closed"]]));
    await resumeGate(vars(), { read: open });
    expect(knownIssueState("acme/app", 7)).toBe("closed");
    await resumeGate(vars(), { read: open, store: true });
    expect(knownIssueState("acme/app", 7)).toBe("open");
    await resumeGate(vars(), { read: closed, store: true });
    expect(knownIssueState("acme/app", 7)).toBe("closed");
    gh.restore();
    gh = fakeGithub();
    expect(knownIssueState("acme/app", 7)).toBeUndefined();
    await resumeGate(vars(), { read: closed, store: true });
    expect(knownIssueState("acme/app", 7)).toBe("closed");
  });

  it("asks GitHub for the repository without .git and in lower case", async () => {
    const asked: string[] = [];
    const read = async (repo: string) => (asked.push(repo), "closed" as const);
    expect(await resumeGate(vars({ github_repo: "Acme/App.git" }), { read })).toEqual(CLOSED);
    expect(asked).toEqual(["acme/app"]);
  });

  it("a failing store write never changes the answer", async () => {
    mkdirSync(join(issueStatesDir(), ".."), { recursive: true });
    const dir = issueStatesDir();
    // a file where the folder should be: the write fails
    const { writeFileSync, rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(dir, "x");
    expect(await resumeGate(vars(), { read: closed, store: true })).toEqual(CLOSED);
    expect(await resumeGate(vars(), { read: open, store: true })).toEqual({ ok: true });
    rmSync(dir, { force: true });
  });
});

const watchers = (over: object = {}) => ConfigSchema.parse({ watchers: [{ id: "a", github_repo: "acme/app", flow: "github-issue", ...over }] }).watchers;

describe("issuesWatched", () => {
  it("counts only an enabled issues watcher of the same repository, in any case", () => {
    expect(issuesWatched(watchers(), "acme/app")).toBe(true);
    expect(issuesWatched(watchers(), "ACME/App")).toBe(true);
    expect(issuesWatched(watchers({ github_repo: "Acme/App.git" }), "acme/app")).toBe(true);
    expect(issuesWatched(watchers({ enabled: false }), "acme/app")).toBe(false);
    expect(issuesWatched(watchers({ source: "pr-feedback" }), "acme/app")).toBe(false);
    expect(issuesWatched(watchers(), "acme/other")).toBe(false);
  });
});

describe("gateRun", { timeout: 60_000 }, () => {
  let kc: FakeKeychain;
  let fake: FakeGithubApp | undefined;
  let user: { id: string };
  const config = (over: object = {}): Config => ConfigSchema.parse({ protected_branches: [], ...over });
  const graphql = () => (gh.ghLog().match(/api graphql/g) ?? []).length;
  const run = (extra: Partial<GateRun> = {}): GateRun => ({ ...vars(), flow: "github-issue", source: "ui", owner: undefined, ...extra });
  const setIssue = (state: string) => (process.env.FAKE_GH_ISSUES = JSON.stringify([{ number: 7, state }]));
  // gh settings folders are made in os.tmpdir(); a private one keeps tests of other files running in parallel out of the listing
  const scfDirs = () => readdirSync(process.env.TMPDIR!).filter((n) => n.startsWith("scf-gh-"));

  beforeEach(async () => {
    process.env.FACTORY_HOME = join(gh.tmp, "home");
    mkdirSync(process.env.FACTORY_HOME, { recursive: true });
    kc = fakeKeychain();
    user = await createUser({ name: "User", email: "user@example.com", password: TEST_PASSWORD, role: "user" });
  });
  afterEach(() => {
    fake?.restore();
    fake = undefined;
    clearTokenCache();
    kc.remove();
  });

  it("uses the server's gh for a run without an owner, also a refinement run", async () => {
    expect(await gateRun(run(), config())).toEqual({ ok: true });
    expect(graphql()).toBe(1);
    setIssue("CLOSED");
    expect(await gateRun(run(), config())).toEqual(CLOSED);
    expect(await gateRun(run({ source: "refinement" }), config())).toEqual(CLOSED);
  });

  it("finds a closed issue of a repository written with .git, by the repository's own state", async () => {
    process.env.FAKE_GH_ISSUES_BY_REPO = JSON.stringify({ "acme/app": [{ number: 7, state: "CLOSED" }] });
    try {
      expect(await gateRun(run({ vars: { github_repo: "acme/app.git", issue: "7" } }), config())).toEqual(CLOSED);
    } finally {
      delete process.env.FAKE_GH_ISSUES_BY_REPO;
    }
  });

  it("makes no call for a run without an issue", async () => {
    expect(await gateRun({ vars: { github_repo: "acme/app" }, flow: "f", source: "ui", owner: user.id }, config())).toEqual({ ok: true });
    expect(graphql()).toBe(0);
  });

  it("uses the stored token of the owner", async () => {
    await addRepo(user.id, { url: "acme/app", method: "github-token", token: TOKEN });
    process.env.FAKE_GH_EXPECT_TOKEN = TOKEN;
    expect(await gateRun(run({ owner: user.id }), config())).toEqual({ ok: true });
    setIssue("CLOSED");
    expect(await gateRun(run({ owner: user.id }), config())).toEqual(CLOSED);
  });

  it("is unchecked when the token is not accepted, and a stored closed still refuses", async () => {
    await addRepo(user.id, { url: "acme/app", method: "github-token", token: TOKEN });
    process.env.FAKE_GH_EXPECT_TOKEN = "other";
    expect(await gateRun(run({ owner: user.id }), config())).toEqual({ ok: true, unchecked: true });
    saveIssueStates("acme/app", new Map([[7, "closed"]]));
    expect(await gateRun(run({ owner: user.id }), config())).toEqual(CLOSED);
  });

  it("never uses the server's gh for a repository the owner did not give", async () => {
    expect(await gateRun(run({ owner: user.id }), config())).toEqual({ ok: true, unchecked: true });
    expect(graphql()).toBe(0);
    saveIssueStates("acme/app", new Map([[7, "closed"]]));
    expect(await gateRun(run({ owner: user.id }), config())).toEqual(CLOSED);
    expect(graphql()).toBe(0);
  });

  it("leaves no gh settings folder behind, also when the check fails", async () => {
    await addRepo(user.id, { url: "acme/app", method: "github-token", token: TOKEN });
    process.env.TMPDIR = mkdtempSync(join(tmpdir(), "gate-tmp-"));
    process.env.FAKE_GH_EXPECT_TOKEN = TOKEN;
    await gateRun(run({ owner: user.id }), config());
    process.env.FAKE_GH_EXPECT_TOKEN = "other";
    await gateRun(run({ owner: user.id }), config());
    expect(scfDirs()).toEqual([]);
  });

  it("uses a new token of the GitHub App, and is unchecked without the app set up", async () => {
    fake = fakeGithubApp();
    fake.installs.set("acme/app", 77);
    clearTokenCache();
    await addRepo(user.id, { url: "acme/app", method: "github-app" }, { installationId: "77" });
    const cfg = config({ github_app: fake.config() });
    process.env.FAKE_GH_EXPECT_TOKEN = "";
    expect(await gateRun(run({ owner: user.id }), cfg)).toEqual({ ok: true, unchecked: true });
    delete process.env.FAKE_GH_EXPECT_TOKEN;
    expect(await gateRun(run({ owner: user.id }), cfg)).toEqual({ ok: true });
    expect(fake.tokens).toHaveLength(2);
    expect(await gateRun(run({ owner: user.id }), config())).toEqual({ ok: true, unchecked: true });
  });

  it("writes the live result for an enabled issues watcher, without a seeded file", async () => {
    setIssue("CLOSED");
    const w = config({ watchers: [{ id: "a", github_repo: "acme/app", flow: "github-issue" }] });
    expect(await gateRun(run(), w)).toEqual(CLOSED);
    expect(knownIssueState("acme/app", 7)).toBe("closed");
    setIssue("OPEN");
    expect(await gateRun(run({ vars: { github_repo: "ACME/App", issue: "7" } }), w)).toEqual({ ok: true });
    expect(knownIssueState("acme/app", 7)).toBe("open");
  });

  it.each([
    [{ enabled: false }],
    [{ source: "pr-feedback" }],
    [{ github_repo: "acme/other" }],
  ])("writes nothing for the watcher %j", async (over) => {
    setIssue("CLOSED");
    await gateRun(run(), config({ watchers: [{ id: "a", github_repo: "acme/app", flow: "github-issue", ...over }] }));
    expect(existsSync(issueStatesDir()) ? readdirSync(issueStatesDir()) : []).toEqual([]);
  });
});
