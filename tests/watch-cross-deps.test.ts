import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addRepo } from "../src/auth/repos.js";
import { createUser } from "../src/auth/users.js";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
import type { GhSession } from "../src/github.js";
import { repoGhIdentity, type RepoGhIdentity } from "../src/queue/gh-identity.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { Watcher } from "../src/queue/watcher.js";
import { needsUser } from "../src/your-turn.js";
import { claudeBin, fakeGithub, oldFlowFor } from "./helpers/fake-github.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { TEST_PASSWORD } from "./helpers/session.js";

const T = "claude-factory";
const ASKS = "factory:needs-info";
const TOKEN = ["github", "pat", ""].join("_") + "Lb4".repeat(12);
const question = { author: { login: "bot" }, body: "**Q1.** Which database? <!-- claude-factory run=r2 -->", createdAt: "2026-01-01T00:00:00Z" };
const answer = { author: { login: "marcel" }, body: "Use Postgres", createdAt: "2026-01-01T01:00:00Z" };
const ENV = ["FAKE_GH_COMMENTS", "FAKE_GH_ISSUES", "FAKE_GH_REPO_ISSUES", "FAKE_GH_TOKEN_BY_REPO", "FAKE_GH_PERMISSION", "FAKE_GH_LABEL_FILTER", "FAKE_GH_HOLD", "FAKE_GH_HOLD_ON"];

describe("a story that depends on an issue of another repository (#880)", () => {
  let gh: ReturnType<typeof fakeGithub>;
  let kc: FakeKeychain;
  let scheduler: Scheduler;
  let submit: ReturnType<typeof vi.spyOn>;
  let logged: string[];
  let ann: { id: string };
  let libId: string;
  const config = ConfigSchema.parse({ protected_branches: ["main"], concurrency: 2 });

  // The accounts and their repositories are made once (making an account is slow); the tests only read them.
  beforeAll(async () => {
    kc = fakeKeychain();
    ann = await createUser({ name: "Ann", email: "ann@example.com", password: TEST_PASSWORD, role: "admin" });
    const bob = await createUser({ name: "Bob", email: "bob@example.com", password: TEST_PASSWORD, role: "user" });
    addRepo(ann.id, { url: "acme/app", method: "none" });
    addRepo(ann.id, { url: "acme/app2", method: "none" });
    libId = addRepo(ann.id, { url: "acme/lib", method: "github-token", token: TOKEN }).id;
    addRepo(bob.id, { url: "other/repo", method: "github-token", token: TOKEN });
  });
  afterAll(() => kc.remove());

  beforeEach(() => {
    gh = fakeGithub();
    process.env.FAKE_GH_PERMISSION = "write";
    process.env.FAKE_GH_LABEL_FILTER = "1";
    logged = [];
    made.length = 0;
    scheduler = new Scheduler({ runsDir: join(gh.tmp, "runs"), config: () => config, claudeBin });
    submit = vi.spyOn(scheduler, "submit").mockReturnValue("queued-1");
    vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const k of ENV) delete process.env[k];
    gh.restore();
  });

  const made: RepoGhIdentity[] = [];
  const watcher = (over: Record<string, unknown> = {}, repoGh?: (id: string) => RepoGhIdentity) =>
    new Watcher(WatcherSchema.parse({ id: "w", github_repo: "acme/app", owner: "ann@example.com", vars: {}, flow: oldFlowFor({}), status_comment: false, ...over }), {
      scheduler, runsDir: join(gh.tmp, "runs"), repo: gh.tmp, log: (m) => { logged.push(m); },
      repoGh: repoGh ?? ((id) => { const i = repoGhIdentity(id, { config: () => config }); made.push(i); return i; }),
    });
  /** Story #4; with needs-info its question is answered, so only the dependency holds it. */
  const story = (deps: string, labels = [T, ASKS]) => {
    if (labels.includes(ASKS)) process.env.FAKE_GH_COMMENTS = JSON.stringify({ comments: [question, answer] });
    else delete process.env.FAKE_GH_COMMENTS;
    process.env.FAKE_GH_ISSUES = JSON.stringify([{ number: 4, title: "four", state: "OPEN", labels: labels.map((name) => ({ name })), body: `### Depends on\n${deps}\n` }]);
  };
  const lib = (...list: { number: number; state?: string; state_reason?: string | null; labels?: string[] }[]) => {
    process.env.FAKE_GH_REPO_ISSUES = JSON.stringify({
      "acme/lib": list.map((i) => ({ number: i.number, state: i.state ?? "open", state_reason: i.state_reason ?? null, title: `lib ${i.number}`, html_url: "", created_at: "", labels: (i.labels ?? []).map((name) => ({ name })) })),
    });
  };
  /** A call for acme/lib works only with its own token (each fake gh call then costs one more process: only where it is checked). */
  const onlyLibToken = () => { process.env.FAKE_GH_TOKEN_BY_REPO = JSON.stringify({ "acme/lib": TOKEN }); };
  const hold = (w: Watcher) => w.status.holds?.find((h) => h.issue === 4);
  const acts = (w: Watcher) => w.status.lastActions.join("\n");

  it("holds the story while the issue is open, removes needs-info, and starts it once the issue is closed as completed", async () => {
    onlyLibToken();
    story("- acme/lib#3");
    lib({ number: 3 });
    const w = watcher();
    await w.tick();
    expect(w.status.lastError).toBeUndefined();
    const h = hold(w)!;
    expect(h.next.kind).toBe("dependency");
    expect(h.next.blockers).toEqual([{ issue: 3, repo: "acme/lib" }]);
    expect(h.next.who).not.toBe("You");
    expect(needsUser(h.next)).toBe(false);
    expect(h.reason).toContain("#4 waits for acme/lib#3, which is to be done");
    expect(submit).not.toHaveBeenCalled();
    expect(acts(w)).toContain(`#4 label ${ASKS} removed`);
    expect(gh.ghLog()).toContain("api repos/acme/lib/issues/3");

    story("- acme/lib#3", [T]);
    lib({ number: 3, state: "closed", state_reason: "completed" });
    await w.tick();
    expect(hold(w)).toBeUndefined();
    expect(submit).toHaveBeenCalledOnce();
    w.stop();
  });

  it("starts the story when the other issue has a done label", async () => {
    story("- acme/lib#3", [T]);
    lib({ number: 3, labels: ["factory:done"] });
    const w = watcher({ dependency_done_labels: ["factory:done"] });
    await w.tick();
    expect(submit).toHaveBeenCalledOnce();
    w.stop();
  });

  it("puts the story in Your turn when the other issue was closed as not planned, also with a done label", async () => {
    story("- acme/lib#3");
    lib({ number: 3, state: "closed", state_reason: "not_planned", labels: ["factory:done"] });
    const w = watcher({ dependency_done_labels: ["factory:done"] });
    await w.tick();
    const h = hold(w)!;
    expect(h.next.kind).toBe("dependency");
    expect(h.next.who).toBe("You");
    expect(h.next.why).toBe("acme/lib#3 was closed as not planned");
    expect(needsUser(h.next)).toBe(true);
    expect(submit).not.toHaveBeenCalled();
    expect(acts(w)).toContain("#4: acme/lib#3 was closed as not planned");
    expect(acts(w)).not.toContain(`label ${ASKS} removed`);
    w.stop();
  });

  it("does not wait for a repository that is not the owner's in the Foundry, and says so once", async () => {
    story("- other/repo#3\n- nobody/here#1", [T]);
    const w = watcher();
    await w.tick();
    expect(submit).toHaveBeenCalledOnce();
    expect(acts(w)).toContain("#4: other/repo#3 is not a repository of the Foundry; not waited for");
    submit.mockClear();
    await w.tick(); // the run is not seen (submit is mocked), so the story is looked at again
    expect(acts(w).split("\n").filter((a) => a.endsWith("#4: other/repo#3 is not a repository of the Foundry; not waited for"))).toHaveLength(1);
    expect(gh.ghLog()).not.toContain("api repos/other/repo");
    w.stop();
  });

  it("holds a story whose other repository has no sign-in of its own, and never uses the host login for it", async () => {
    story("- acme/app2#3", [T]);
    const w = watcher();
    await w.tick();
    expect(hold(w)?.next.kind).toBe("dependency");
    expect(submit).not.toHaveBeenCalled();
    expect(logged).toContain("[w] ! #4: acme/app2#3 could not be read: the repository has no sign-in of its own");
    expect(gh.ghLog()).not.toContain("api repos/acme/app2");
    w.stop();
  });

  it("reads with the other repository's own token: a wrong one holds the story and is logged", async () => {
    onlyLibToken();
    story("- acme/lib#3", [T]);
    lib({ number: 3, state: "closed", state_reason: "completed" });
    const wrong: RepoGhIdentity = { prepare: async (): Promise<GhSession> => ({ env: { GH_TOKEN: "nope" }, stamp: "wrong" }), usesHostLogin: () => false, dispose() {} };
    const w = watcher({}, () => wrong);
    await w.tick();
    expect(hold(w)?.next.kind).toBe("dependency");
    expect(submit).not.toHaveBeenCalled();
    expect(logged.some((l) => l.startsWith("[w] ! #4: acme/lib#3 could not be read: ") && l.includes("401"))).toBe(true);
    expect(logged.join("\n")).not.toContain(TOKEN);
    w.stop();
  });

  it("holds and releases a #N dependency as before", async () => {
    process.env.FAKE_GH_ISSUES = JSON.stringify([
      { number: 4, title: "four", state: "OPEN", labels: [{ name: T }], body: "### Depends on\n#9\n" },
      { number: 9, title: "nine", state: "OPEN", labels: [{ name: "other" }] },
    ]);
    const w = watcher({ wait_for_dependencies: true, exclude_labels: ["other"] });
    await w.tick();
    expect(hold(w)?.next.blockers).toEqual([{ issue: 9 }]);
    expect(acts(w)).toContain("#4 waits for #9 (depends on)");
    expect(gh.ghLog()).not.toContain("api repos/acme/app/issues/9");
    w.stop();
  });

  it("removes the other sign-ins at stop: at once when idle, after the check when one runs, and logs no read failure", async () => {
    story("- acme/lib#3", [T]);
    lib({ number: 3 });
    const disposed: string[] = [];
    let release!: () => void;
    let started!: () => void;
    const begun = new Promise<void>((r) => { started = r; });
    const slow: RepoGhIdentity = {
      prepare: () => { started(); return new Promise<GhSession>((r) => { release = () => r({ env: { GH_TOKEN: TOKEN }, stamp: "lib" }); }); },
      usesHostLogin: () => false,
      dispose: () => { disposed.push("lib"); },
    };
    const w = watcher({}, (id) => { expect(id).toBe(libId); return slow; });
    const tick = w.tick();
    await begun;
    w.stop();
    expect(disposed).toEqual([]); // the check still runs
    release();
    await tick;
    expect(disposed).toEqual(["lib"]);
    expect(submit).not.toHaveBeenCalled();
    expect(gh.ghLog()).not.toContain("api repos/acme/lib/issues/3");
    expect(logged.some((l) => l.includes("could not be read"))).toBe(false);

    // idle: at once
    const v = watcher();
    await v.tick();
    expect(made).toHaveLength(1);
    const spy = vi.spyOn(made[0]!, "dispose");
    v.stop();
    expect(spy).toHaveBeenCalledOnce();
  });
});
