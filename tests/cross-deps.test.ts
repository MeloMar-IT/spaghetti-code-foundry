import { describe, expect, it, vi } from "vitest";
import type { RepoRecord } from "../src/auth/repos.js";
import { currentGhSession, type RestIssue } from "../src/github.js";
import { CrossDeps, NOT_ALLOWED, type CrossDepOptions }from "../src/queue/cross-deps.js";
import type { RepoGhIdentity } from "../src/queue/gh-identity.js";

const rec = (name: string, owner = "ann", method: RepoRecord["method"] = "github-token"): RepoRecord =>
  ({ id: `id-${name}`, owner, url: `https://github.com/${name}`, method, added: "2026-01-01T00:00:00Z" }) as RepoRecord;

const issue = (number: number, state = "open", state_reason: string | null = null, labels: string[] = []): RestIssue =>
  ({ number, state, state_reason, title: `T${number}`, html_url: "", created_at: "", labels: labels.map((name) => ({ name })) });

const story = (deps: string, number = 7) => ({ number, body: `### Depends on\n${deps}` });

function setup(o: { recs?: RepoRecord[]; issues?: Record<string, RestIssue[]>; admin?: boolean; self?: RepoGhIdentity; extra?: Partial<CrossDepOptions> } = {}) {
  const acts: string[] = [];
  const warns: string[] = [];
  const reads: string[] = [];
  const stamps: (string | undefined)[] = [];
  const recs = o.recs ?? [rec("acme/lib")];
  const issues = o.issues ?? { "acme/lib": [issue(3)] };
  const identity = (): RepoGhIdentity => ({ prepare: async () => ({ stamp: "lib" }), usesHostLogin: () => false, dispose: () => {} });
  const cross = new CrossDeps({
    selfRepo: "acme/app", owner: "ann", rule: () => ({ doneLabels: ["Factory_done"] }),
    identity, act: (m) => acts.push(m), warn: (m) => warns.push(m),
    isAdmin: () => o.admin ?? false, selfIdentity: () => o.self,
    find: (owner, name) => recs.find((r) => r.owner === owner && r.url.toLowerCase().endsWith(`/${name.toLowerCase()}`)),
    read: async (repo, n) => {
      reads.push(`${repo}#${n}`);
      stamps.push(currentGhSession()?.stamp);
      return issues[repo]?.find((i) => i.number === n);
    },
    ...o.extra,
  });
  return { cross, acts, warns, reads, stamps };
}

describe("CrossDeps", () => {
  it("an open issue of the owner's other repository holds the story; the read runs in that repository's session", async () => {
    const t = setup();
    const s = story("- acme/lib#3");
    t.cross.startCheck([s]);
    expect(await t.cross.blockers(s, false)).toEqual([{ repo: "acme/lib", issue: 3 }]);
    expect(t.stamps).toEqual(["lib"]);
    expect(t.acts).toEqual([]);
    expect(t.warns).toEqual([]);
  });

  it("closed as completed releases; closed as not planned holds with notPlanned", async () => {
    const t = setup({ issues: { "acme/lib": [issue(3, "closed", "completed"), issue(4, "closed", "not_planned", ["Factory_done"])] } });
    const s = story("- acme/lib#3\n- acme/lib#4");
    t.cross.startCheck([s]);
    expect(await t.cross.blockers(s, false)).toEqual([{ repo: "acme/lib", issue: 4, notPlanned: true }]);
  });

  it("a repository of another account, or none in the Foundry, does not hold, with one line", async () => {
    const t = setup({ recs: [rec("other/repo", "bob")] });
    const s = story("- other/repo#3\n- nobody/here#1");
    t.cross.startCheck([s]);
    expect(await t.cross.blockers(s, false)).toEqual([]);
    expect(t.acts).toEqual(["#7: nobody/here#1 is not a repository of the Foundry; not waited for", "#7: other/repo#3 is not a repository of the Foundry; not waited for"]);
    expect(t.reads).toEqual([]);
  });

  it("without an owner nothing counts; the watcher's own repository is skipped", async () => {
    const t = setup({ extra: { owner: undefined } });
    const s = story("- acme/lib#3\n- acme/app#5");
    t.cross.startCheck([s]);
    expect(await t.cross.blockers(s, false)).toEqual([]);
    expect(t.acts).toEqual(["#7: acme/lib#3 is not a repository of the Foundry; not waited for"]);
  });

  it("a non-admin's repository without a sign-in of its own (method none) holds and is never read", async () => {
    const t = setup({ recs: [rec("acme/lib", "ann", "none")] });
    const s = story("- acme/lib#3");
    t.cross.startCheck([s]);
    expect(await t.cross.blockers(s, false)).toEqual([{ repo: "acme/lib", issue: 3, noSignIn: true }]);
    expect(t.warns).toEqual([`#7: acme/lib#3 could not be read: ${NOT_ALLOWED}`]);
    expect(t.reads).toEqual([]);
  });

  it("logs a refusal once across checks, and again after it went away and came back", async () => {
    const t = setup({ recs: [rec("acme/lib", "ann", "none")] });
    const s = story("- acme/lib#3");
    for (let i = 0; i < 3; i++) {
      t.cross.startCheck([s]);
      await t.cross.blockers(s, false);
    }
    expect(t.warns).toHaveLength(1);
    t.cross.startCheck([{ number: 7, body: "" }]);
    await t.cross.blockers({ number: 7, body: "" }, false);
    t.cross.startCheck([s]); // the check without the line is over: it counts as gone
    await t.cross.blockers(s, false);
    expect(t.warns).toHaveLength(2);
  });

  it("keeps the refusal while a story is only found late in the check (not in startCheck's bodies)", async () => {
    const t = setup({ recs: [rec("acme/lib", "ann", "none")] });
    const s = story("- acme/lib#3");
    for (let i = 0; i < 3; i++) {
      t.cross.startCheck([]);
      await t.cross.blockers(s, false);
    }
    expect(t.warns).toHaveLength(1);
  });

  it("reads the issue once the repository has a sign-in, and forgets the refusal", async () => {
    const recs = [rec("acme/lib", "ann", "none")];
    const t = setup({ recs });
    const s = story("- acme/lib#3");
    t.cross.startCheck([s]);
    expect(await t.cross.blockers(s, false)).toEqual([{ repo: "acme/lib", issue: 3, noSignIn: true }]);
    recs[0] = rec("acme/lib", "ann", "github-token");
    t.cross.startCheck([s]);
    expect(await t.cross.blockers(s, false)).toEqual([{ repo: "acme/lib", issue: 3 }]);
    expect(t.reads).toEqual(["acme/lib#3"]);
    recs[0] = rec("acme/lib", "ann", "none");
    t.cross.startCheck([s]);
    await t.cross.blockers(s, false);
    expect(t.warns).toHaveLength(2);
  });

  it("a failed read, a 404, no identity or a failing lookup holds and is logged", async () => {
    const s = story("- acme/lib#3");

    const failing = setup({ extra: { read: async () => { throw new Error("HTTP 401: Bad credentials"); } } });
    failing.cross.startCheck([s]);
    expect(await failing.cross.blockers(s, false)).toEqual([{ repo: "acme/lib", issue: 3 }]);
    expect(failing.warns).toEqual(["#7: acme/lib#3 could not be read: HTTP 401: Bad credentials"]);

    const gone = setup({ issues: {} });
    gone.cross.startCheck([s]);
    expect(await gone.cross.blockers(s, false)).toEqual([{ repo: "acme/lib", issue: 3 }]);
    expect(gone.warns[0]).toMatch(/^#7: acme\/lib#3 could not be read: /);

    const noId = setup({ extra: { identity: () => undefined } });
    noId.cross.startCheck([s]);
    expect(await noId.cross.blockers(s, false)).toHaveLength(1);
    expect(noId.warns).toHaveLength(1);

    const badStore = setup({ extra: { find: () => { throw new Error("store unreadable"); } } });
    badStore.cross.startCheck([s]);
    expect(await badStore.cross.blockers(s, false)).toHaveLength(1);
    expect(badStore.warns).toEqual(["#7: acme/lib#3 could not be read: store unreadable"]);

    const signIn = setup({ extra: { identity: () => ({ prepare: async () => { throw new Error("no token"); }, usesHostLogin: () => false, dispose() {} }) } });
    signIn.cross.startCheck([s]);
    expect(await signIn.cross.blockers(s, false)).toHaveLength(1);
    expect(signIn.warns).toEqual(["#7: acme/lib#3 could not be read: no token"]);
    expect(signIn.reads).toEqual([]);
  });

  it("an issue is read once per check; markedOnly reads only the marked part", async () => {
    const t = setup();
    const s = story("- acme/lib#3");
    const same = { number: 8, body: "### Depends on\n- acme/lib#3" };
    t.cross.startCheck([s, same]);
    await t.cross.blockers(s, false);
    await t.cross.blockers(same, false);
    expect(t.reads).toEqual(["acme/lib#3"]);
    t.cross.startCheck([s]);
    await t.cross.blockers(s, false);
    expect(t.reads).toEqual(["acme/lib#3", "acme/lib#3"]); // open: read again in the next check
    expect(await t.cross.blockers(story("- acme/lib#3"), true)).toEqual([]); // only the marked part: none here
  });

  it("a reopened issue holds again: a done result is not kept from an earlier check", async () => {
    const list = [issue(3, "closed", "completed")];
    const t = setup({ issues: { "acme/lib": list } });
    const s = story("- acme/lib#3");
    t.cross.startCheck([s]);
    expect(await t.cross.blockers(s, false)).toEqual([]);
    list[0] = issue(3); // reopened
    t.cross.startCheck([s]);
    expect(await t.cross.blockers(s, false)).toEqual([{ repo: "acme/lib", issue: 3 }]);
    expect(t.reads).toEqual(["acme/lib#3", "acme/lib#3"]);
  });

  it("over the cap the reference holds with one line per check; the reads rotate, so each reference gets its turn", async () => {
    const done = [1, 2, 3].map((n) => issue(n, "closed", "completed"));
    const t = setup({ issues: { "acme/lib": done }, extra: { cap: 2 } });
    const s = story("- acme/lib#1\n- acme/lib#2\n- acme/lib#3");
    t.cross.startCheck([s]);
    expect(await t.cross.blockers(s, false)).toEqual([{ repo: "acme/lib", issue: 3 }]);
    expect(t.reads).toEqual(["acme/lib#1", "acme/lib#2"]);
    const capLines = () => t.warns.filter((w) => w.startsWith("issues of other repositories: at most 2"));
    expect(capLines()).toHaveLength(1);

    t.cross.startCheck([s]);
    expect(await t.cross.blockers(s, false)).toEqual([{ repo: "acme/lib", issue: 2 }]);
    expect(t.reads).toEqual(["acme/lib#1", "acme/lib#2", "acme/lib#1", "acme/lib#3"]);
    expect(capLines()).toHaveLength(2); // one per check
  });

  it("a story with a reference over the cap is not starved: the reference read longest ago gets the next slot", async () => {
    const t = setup({
      issues: { "acme/lib": [issue(1), issue(2), issue(9, "closed", "completed")] },
      extra: { cap: 2 },
    });
    const a = story("- acme/lib#1\n- acme/lib#2", 7);
    const b = story("- acme/lib#9", 8);
    t.cross.startCheck([a, b]);
    expect(await t.cross.blockers(a, false)).toEqual([{ repo: "acme/lib", issue: 1 }, { repo: "acme/lib", issue: 2 }]);
    expect(await t.cross.blockers(b, false)).toEqual([{ repo: "acme/lib", issue: 9 }]); // no slot yet
    expect(t.reads).toEqual(["acme/lib#1", "acme/lib#2"]);

    t.cross.startCheck([a, b]);
    expect(await t.cross.blockers(b, false)).toEqual([]); // its slot comes first in the next check
    expect(t.reads).toEqual(["acme/lib#1", "acme/lib#2", "acme/lib#9"]);
  });

  it("a stopped check does not start the read after the sign-in, and its error is passed on without a read failure", async () => {
    const s = story("- acme/lib#3");
    let stop = false;
    const alive = () => { if (stop) throw new Error("this watcher was stopped"); };
    const id: RepoGhIdentity = { prepare: async () => { stop = true; return { stamp: "lib" }; }, usesHostLogin: () => false, dispose() {} };
    const u = setup({ extra: { identity: () => id } });
    u.cross.startCheck([s]);
    await expect(u.cross.blockers(s, false, alive)).rejects.toThrow("this watcher was stopped");
    expect(u.reads).toEqual([]);
    expect(u.warns).toEqual([]);

    // stopped while the read runs: the same
    const read = vi.fn(async () => { stop = true; throw new Error("aborted"); });
    stop = false;
    const v = setup({ extra: { read } });
    v.cross.startCheck([s]);
    await expect(v.cross.blockers(s, false, alive)).rejects.toThrow("this watcher was stopped");
    expect(read).toHaveBeenCalledOnce();
    expect(v.warns).toEqual([]);
  });
});

describe("CrossDeps: the allowed ways to read an issue (#976)", () => {
  const s = story("- acme/lib#3");
  /** An identity that records in `order` when it is prepared. */
  const signIn = (stamp: string, order: string[] = [], fail?: string): RepoGhIdentity => ({
    prepare: async () => {
      order.push(stamp);
      if (fail) throw new Error(fail);
      return { stamp };
    },
    usesHostLogin: () => false,
    dispose: () => {},
  });
  /** Each session gets its own answer: an issue, undefined (404) or an error. */
  const answers = (by: Record<string, RestIssue | Error | undefined>) => {
    const asked: string[] = [];
    const read = async () => {
      const stamp = currentGhSession()!.stamp;
      asked.push(stamp);
      const a = by[stamp];
      if (a instanceof Error) throw a;
      return a;
    };
    return { asked, read };
  };
  const done = issue(3, "closed", "completed");
  const forbidden = new Error("HTTP 403: Resource not accessible by integration");
  type Case = { method?: RepoRecord["method"]; admin?: boolean; own?: RepoGhIdentity; self?: RepoGhIdentity; read: () => Promise<RestIssue | undefined>; selfRepo?: string };
  const make = (c: Case) => {
    const own = c.own ?? signIn("lib");
    return setup({
      recs: [rec("acme/lib", "ann", c.method)], admin: c.admin, self: c.self,
      extra: { identity: () => own, read: c.read, ...(c.selfRepo ? { selfRepo: c.selfRepo } : {}) },
    });
  };
  const check = async (t: ReturnType<typeof setup>) => {
    t.cross.startCheck([s]);
    return t.cross.blockers(s, false);
  };

  it("reads an admin's none repository with the server's own access: open holds, completed releases", async () => {
    const by: Record<string, RestIssue> = { host: issue(3) };
    const a = answers(by);
    const t = make({ method: "none", admin: true, own: signIn("host"), read: a.read });
    expect(await check(t)).toEqual([{ repo: "acme/lib", issue: 3 }]);
    by.host = done;
    expect(await check(t)).toEqual([]);
    expect(a.asked).toEqual(["host", "host"]);
    expect(t.warns).toEqual([]);
  });

  it.each(["other/app", "acme/app"])("refuses a non-admin's none repository before any sign-in (story repository %s)", async (selfRepo) => {
    const order: string[] = [];
    const a = answers({ host: done, self: done });
    const t = make({ method: "none", selfRepo, own: signIn("host", order), self: signIn("self", order), read: a.read });
    expect(await check(t)).toEqual([{ repo: "acme/lib", issue: 3, noSignIn: true }]);
    expect(t.warns).toEqual([`#7: acme/lib#3 could not be read: ${NOT_ALLOWED}`]);
    expect(order).toEqual([]);
    expect(a.asked).toEqual([]);
  });

  it("same GitHub owner (without case): after a 403 the story repository's sign-in reads the issue", async () => {
    const order: string[] = [];
    const a = answers({ lib: forbidden, self: done });
    const t = make({ selfRepo: "ACME/app", own: signIn("lib", order), self: signIn("self", order), read: a.read });
    expect(await check(t)).toEqual([]);
    expect(a.asked).toEqual(["lib", "self"]);
    expect(order).toEqual(["lib", "self"]);
    expect(t.warns).toEqual([]);
  });

  it("uses the story repository's sign-in when the other sign-in cannot be prepared", async () => {
    const a = answers({ self: done });
    const t = make({ own: signIn("lib", [], "no token"), self: signIn("self"), read: a.read });
    expect(await check(t)).toEqual([]);
    expect(a.asked).toEqual(["self"]);
  });

  it.each([
    ["open", issue(3), {}],
    ["not planned", issue(3, "closed", "not_planned"), { notPlanned: true }],
  ])("a first readable answer (%s) is final", async (_name, first, extra) => {
    const order: string[] = [];
    const a = answers({ lib: first, self: done });
    const t = make({ own: signIn("lib", order), self: signIn("self", order), read: a.read });
    expect(await check(t)).toEqual([{ repo: "acme/lib", issue: 3, ...extra }]);
    expect(a.asked).toEqual(["lib"]);
    expect(order).toEqual(["lib"]);
  });

  it("a 404 on the first way and an open answer on the second holds without noSignIn", async () => {
    const a = answers({ host: undefined, self: issue(3) });
    const t = make({ method: "none", admin: true, own: signIn("host"), self: signIn("self"), read: a.read });
    expect(await check(t)).toEqual([{ repo: "acme/lib", issue: 3 }]);
    expect(a.asked).toEqual(["host", "self"]);
    expect(t.warns).toEqual([]);
  });

  it("403 and 404 on every way never release; the line names each way and its reason", async () => {
    const a = answers({ lib: forbidden, self: undefined });
    const t = make({ self: signIn("self"), read: a.read });
    expect(await check(t)).toEqual([{ repo: "acme/lib", issue: 3 }]);
    expect(t.warns).toEqual([
      "#7: acme/lib#3 could not be read: no sign-in could read it; tried: its own sign-in: HTTP 403: Resource not accessible by integration; the sign-in of acme/app: GitHub does not know it",
    ]);
  });

  it("an admin's none repository that no way can read has noSignIn, logged once across checks", async () => {
    const a = answers({ host: undefined, self: forbidden });
    const t = make({ method: "none", admin: true, own: signIn("host"), self: signIn("self"), read: a.read });
    for (let i = 0; i < 3; i++) expect(await check(t)).toEqual([{ repo: "acme/lib", issue: 3, noSignIn: true }]);
    expect(t.warns).toEqual([
      "#7: acme/lib#3 could not be read: the repository has no sign-in of its own that works; tried: the server's own access: GitHub does not know it; the sign-in of acme/app: HTTP 403: Resource not accessible by integration",
    ]);
  });

  it("a passing error on a none repository holds without noSignIn", async () => {
    const a = answers({ host: new Error("timed out") });
    const t = make({ method: "none", admin: true, own: signIn("host"), read: a.read });
    expect(await check(t)).toEqual([{ repo: "acme/lib", issue: 3 }]);
    expect(t.warns).toEqual(["#7: acme/lib#3 could not be read: the repository has no sign-in of its own that works; tried: the server's own access: timed out"]);
  });

  it("another GitHub owner: the story repository's sign-in is not used, and the failure text is the read's own", async () => {
    const order: string[] = [];
    const a = answers({ lib: new Error("HTTP 401: Bad credentials"), self: done });
    const t = make({ selfRepo: "other/app", own: signIn("lib", order), self: signIn("self", order), read: a.read });
    expect(await check(t)).toEqual([{ repo: "acme/lib", issue: 3 }]);
    expect(order).toEqual(["lib"]);
    expect(t.warns).toEqual(["#7: acme/lib#3 could not be read: HTTP 401: Bad credentials"]);
  });

  it("does not read twice with the same session", async () => {
    const a = answers({ host: undefined });
    const t = make({ method: "none", admin: true, own: signIn("host"), self: signIn("host"), read: a.read });
    expect(await check(t)).toHaveLength(1);
    expect(a.asked).toEqual(["host"]);
  });

  it("another account's repository is not read, also under the same GitHub owner", async () => {
    const order: string[] = [];
    const t = setup({ recs: [rec("acme/lib", "bob")], self: signIn("self", order) });
    expect(await check(t)).toEqual([]);
    expect(t.reads).toEqual([]);
    expect(order).toEqual([]);
  });

  it("a check stopped during the first read tries no second way", async () => {
    let stop = false;
    const order: string[] = [];
    const read = vi.fn(async (): Promise<RestIssue | undefined> => { stop = true; throw forbidden; });
    const t = make({ self: signIn("self", order), read });
    t.cross.startCheck([s]);
    await expect(t.cross.blockers(s, false, () => { if (stop) throw new Error("this watcher was stopped"); })).rejects.toThrow("this watcher was stopped");
    expect(read).toHaveBeenCalledOnce();
    expect(order).toEqual([]);
    expect(t.warns).toEqual([]);
  });
});
