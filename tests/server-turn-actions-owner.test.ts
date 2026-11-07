import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addRepo } from "../src/auth/repos.js";
import { localRepoName } from "../src/auth/local-name.js";
import { ConfigSchema } from "../src/config.js";
import { nextStep, type NextStep } from "../src/next-step.js";
import { CLOSED_MESSAGE } from "../src/run-gate.js";
import { opaqueKey, readAct, turnAct, turnDetail, turnMine } from "../src/server/turn-actions.js";
import type { ApiContext } from "../src/server/server.js";
import { turnFor } from "../src/server/your-turn.js";
import { storeFor } from "../src/stories/store.js";
import { formatStoryFile, type FileStory } from "../src/stories/story-file.js";
import { fakeGithub } from "./helpers/fake-github.js";

// Answer, approve and retry on a local project, and the owner rule for people who are not admins. Unit level: no server.

const NOW = new Date("2026-10-01T12:00:00Z");
const SINCE = "2026-10-01T10:00:00Z";
const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const owner = { id: OWNER, name: "Marcel K" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

const questionsComment = "**What you need to do:** Answer.\n\n**Q1. Which?**\nOptions.\n**Recommendation:** (a)\n\n**Q2. Where?**\nHere or there.\n**Recommendation:** here\n\n_Answer or /defaults._\n\n<!-- claude-factory run=r0 questions -->";
const planComment = (run: string, risk: number) => `**What you need to do:** Decide.\n\n🤖 **Spaghetti Code Foundry plan**\n\n**Risk: ${risk}/100** — touches login\n\nthe plan\n\n✋ **A human decides before coding starts:** the risk score is above 75.\n\n_Reply._\n\n<!-- claude-factory run=${run} approval -->`;
const story = (n: number, over: Partial<FileStory> = {}): FileStory => ({
  number: n, title: `Story ${n}`, state: "open", kind: "story", labels: [], dependsOn: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", body: "Do it.", comments: [], ...over,
});
const fc = (body: string, author = "Foundry") => ({ author, createdAt: "2026-10-01T09:00:00Z", body });

let base: string;
let dir: string;
let name: string;
let repoId: string;
let gh: ReturnType<typeof fakeGithub>;
let kick: ReturnType<typeof vi.fn>;
let identityOf: ReturnType<typeof vi.fn>;

const hold = (next: NextStep) => ({ issue: next.issue, reason: next.text, next, since: SINCE });
const rec = (repo: string, kind: Parameters<typeof nextStep>[0], issue: number, runId?: string) =>
  nextStep(kind, { repo, issue, title: `T${issue}`, runId }, { watched: true, issueUrl: `https://example.invalid/${issue}`, failedLabel: "factory:failed", questions: 2 });

interface W { id: string; repo: string; repoId?: string; ownerId?: string; holds: ReturnType<typeof hold>[] }
function stub(ws: W[]) {
  const config = ConfigSchema.parse({ watchers: ws.map((w) => ({ id: w.id, github_repo: "acme/app", flow: "github-issue" })) });
  kick = vi.fn();
  return {
    opts: { log: vi.fn() },
    config: () => config,
    scheduler: { list: () => [], get: () => undefined, ownerOf: () => undefined, briefs: () => [], queue: () => ({ pending: [], active: [] }) },
    watchers: {
      statuses: () => [],
      identityOf,
      kickRepo: kick,
      tracked: () => ws.map((w, i) => ({
        watcher: { ...config.watchers[i], github_repo: w.repo, ...(w.repoId ? { repoId: w.repoId } : {}), ...(w.ownerId ? { ownerId: w.ownerId } : {}) },
        status: { id: w.id, lastActions: [], holds: w.holds },
        issues: w.holds.map((h) => ({ issue: h.issue, title: `T${h.issue}`, runId: h.next.runId })),
      })),
    },
  } as unknown as ApiContext;
}
const localHolds = () => [hold(rec(name, "questions", 5)), hold(rec(name, "approve_plan", 6, "r1")), hold(rec(name, "failed", 8)), hold(rec(name, "failed", 9))];
const localCtx = (ownerId = OWNER) => stub([{ id: "loc", repo: name, repoId, ownerId, holds: localHolds() }]);
const githubHolds = () => [hold(rec("acme/app", "questions", 5))];
const keyOf = (repo: string, issue: number, kind: string, run = "") => `${repo}#${issue}|${kind}|${run}`;
const status = async (p: Promise<unknown>) => p.then(() => 0, (e: { status?: number }) => e.status ?? -1);
const labels = async (n: number) => (await storeFor(name).stateAndLabels(n)).labels.map((l: string | { name: string }) => (typeof l === "string" ? l : l.name));
const bodies = async (n: number) => (await storeFor(name).comments(n)).map((c) => c.body);
const act = async (ctx: ApiContext, u: { id: string; name: string }, admin: boolean, body: Record<string, unknown>) => {
  let b = body;
  if (b.digest === undefined && b.action !== "retry" && b.action !== "retry_hint") b = { ...b, digest: (await turnDetail(ctx, u, admin, b.key as string, NOW)).digest };
  return turnAct(ctx, u, admin, readAct(b), NOW);
};

beforeEach(() => {
  gh = fakeGithub();
  identityOf = vi.fn(() => undefined);
  base = realpathSync(mkdtempSync(join(tmpdir(), "turn-owner-")));
  dir = join(base, "my-app");
  mkdirSync(join(dir, ".scf", "stories"), { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "T");
  const files: [string, FileStory][] = [
    ["5-q.md", story(5, { comments: [fc(questionsComment)] })],
    ["6-p.md", story(6, { comments: [fc(planComment("r1", 80))] })],
    ["8-f.md", story(8, { labels: ["factory:failed"] })],
    ["9-c.md", story(9, { labels: ["factory:failed"], state: "closed" })],
  ];
  for (const [f, s] of files) writeFileSync(join(dir, ".scf", "stories", f), formatStoryFile(s));
  writeFileSync(join(dir, ".scf", "stories", "next-number"), "10\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "stories");
  const r = addRepo(OWNER, { url: dir, method: "local" }, { ownerOk: () => true });
  repoId = r.id;
  name = localRepoName({ id: r.id, url: r.url });
});
afterEach(() => {
  gh.restore();
  rmSync(base, { recursive: true, force: true });
});

describe("a local project, as its owner", () => {
  const QK = () => keyOf(name, 5, "questions");

  it("shows the questions with no gh call and no sign-in", async () => {
    const d = await turnDetail(localCtx(), owner, false, QK(), NOW);
    expect(d).toMatchObject({ stamp: SINCE, acts: ["defaults", "answer"], questions: [{ n: 1 }, { n: 2 }] });
    expect(d.digest).toBeTruthy();
    expect(gh.ghLog()).toBe("");
    expect(identityOf).not.toHaveBeenCalled();
  });

  it("defaults and answer each add one comment on the story", async () => {
    const ctx = localCtx();
    await act(ctx, owner, false, { key: QK(), action: "defaults", stamp: SINCE });
    const b = await bodies(5);
    expect(b).toHaveLength(2);
    expect(b[1]).toContain("/defaults\n");
    expect(b[1]).toContain("— Marcel K, via Spaghetti Code Foundry");
    expect(kick).toHaveBeenCalledWith(name, expect.any(Number));
    expect(gh.ghLog()).toBe("");
    expect(identityOf).not.toHaveBeenCalled();
  });

  it("answer adds the numbered answers", async () => {
    await act(localCtx(), owner, false, { key: QK(), action: "answer", stamp: SINCE, answers: [{ n: 1, text: "a" }, { n: 2, text: "b" }] });
    expect((await bodies(5))[1]).toContain("**Q1.** a\n\n**Q2.** b");
    expect(gh.ghLog()).toBe("");
  });

  it("approve and reject post /approve and /reject without any write-access check", async () => {
    const pk = keyOf(name, 6, "approve_plan", "r1");
    await act(localCtx(), owner, false, { key: pk, action: "approve", stamp: SINCE, text: "notes" });
    expect((await bodies(6))[1]).toContain("/approve notes");
    await act(localCtx(), owner, false, { key: pk, action: "reject", stamp: SINCE, text: "use another way" }).catch(() => undefined);
    expect(gh.ghLog()).toBe("");
  });

  it("reject adds /reject", async () => {
    await act(localCtx(), owner, false, { key: keyOf(name, 6, "approve_plan", "r1"), action: "reject", stamp: SINCE, text: "use another way" });
    expect((await bodies(6))[1]).toContain("/reject use another way");
  });

  it("a later /approve by anyone blocks the in-app approve", async () => {
    await storeFor(name).comment(6, "/approve");
    expect(await status(act(localCtx(), owner, false, { key: keyOf(name, 6, "approve_plan", "r1"), action: "approve", stamp: SINCE, digest: (await turnDetail(localCtx(), owner, false, keyOf(name, 6, "approve_plan", "r1"), NOW)).digest }))).toBe(409);
  });

  it("ignores a Foundry-looking comment by another author", async () => {
    await storeFor(name).create({ title: "x", body: "y", labels: [] });
    const ctx = stub([{ id: "loc", repo: name, repoId, ownerId: OWNER, holds: [hold(rec(name, "questions", 10))] }]);
    // the story file of #10 has no comment of the Foundry's; a copied marker by "mallory" must not count
    writeFileSync(join(dir, ".scf", "stories", "10-x.md"), formatStoryFile(story(10, { comments: [fc(questionsComment, "mallory")] })));
    expect(await status(turnDetail(ctx, owner, false, keyOf(name, 10, "questions"), NOW))).toBe(409);
  });

  it("retry removes the failed label and posts nothing; the audit line names the account", async () => {
    await act(localCtx(), owner, false, { key: keyOf(name, 8, "failed"), action: "retry", stamp: SINCE });
    expect(await labels(8)).not.toContain("factory:failed");
    expect(await bodies(8)).toEqual([]);
    expect(gh.ghLog()).toBe("");
  });

  it("retry_hint posts the hint once and removes the label; a second request is refused", async () => {
    const ctx = localCtx();
    await act(ctx, owner, false, { key: keyOf(name, 8, "failed"), action: "retry_hint", stamp: SINCE, text: "try X" });
    expect(await bodies(8)).toHaveLength(1);
    expect(await labels(8)).not.toContain("factory:failed");
    expect(await status(act(ctx, owner, false, { key: keyOf(name, 8, "failed"), action: "retry_hint", stamp: SINCE, text: "try X" }))).toBe(409);
  });

  it("retry of a closed story answers 409 and changes nothing", async () => {
    for (const action of ["retry", "retry_hint"]) {
      const err = await act(localCtx(), owner, false, { key: keyOf(name, 9, "failed"), action, stamp: SINCE, text: "hint" }).catch((e: Error & { status?: number }) => e);
      expect(err).toMatchObject({ status: 409, message: CLOSED_MESSAGE });
    }
    expect(await labels(9)).toContain("factory:failed");
    expect(await bodies(9)).toEqual([]);
  });

  it("an answer whose commit fails is saved and recorded as done: the repeat is refused, nothing is posted twice", async () => {
    const lockDir = join(dir, ".git", "refs", "heads", "scf");
    mkdirSync(lockDir, { recursive: true });
    const lock = join(lockDir, "stories.lock");
    writeFileSync(lock, "");
    const ctx = localCtx();
    const answer = { key: QK(), action: "answer", stamp: SINCE, answers: [{ n: 1, text: "a" }, { n: 2, text: "b" }] };
    expect(await status(act(ctx, owner, false, answer))).toBe(502);
    expect(await bodies(5)).toHaveLength(2); // the answer is on the story
    expect(kick).toHaveBeenCalledWith(name, expect.any(Number)); // the watcher is kicked
    expect(turnMine(ctx, owner, false, NOW).items.some((i) => i.kind === "questions")).toBe(false); // it is continuing
    rmSync(lock);
    expect(await status(act(ctx, owner, false, answer))).toBe(409);
    expect(await bodies(5)).toHaveLength(2);
  });

  it("a commit that fails after the hint is saved: the repeat does not post the hint twice", async () => {
    const lockDir = join(dir, ".git", "refs", "heads", "scf");
    mkdirSync(lockDir, { recursive: true });
    const lock = join(lockDir, "stories.lock");
    writeFileSync(lock, "");
    const ctx = localCtx();
    const key = keyOf(name, 8, "failed");
    expect(await status(act(ctx, owner, false, { key, action: "retry_hint", stamp: SINCE, text: "try X" }))).toBe(502);
    expect(await bodies(8)).toHaveLength(1);
    rmSync(lock);
    await act(ctx, owner, false, { key, action: "retry_hint", stamp: SINCE, text: "try X" });
    expect(await bodies(8)).toHaveLength(1);
    expect(await labels(8)).not.toContain("factory:failed");
  });
});

describe("the owner rule", () => {
  const ghKey = keyOf("acme/app", 5, "questions");
  const withIdentity = (usesHostLogin: boolean) => {
    identityOf = vi.fn(() => ({ usesHostLogin: () => usesHostLogin, prepare: async () => undefined }));
  };
  const ghCtx = (w: Partial<W> = {}) => stub([{ id: "gh", repo: "acme/app", repoId: "rid", ownerId: OWNER, holds: githubHolds(), ...w }]);

  it("another user's item, a config.yaml watcher and an unknown key answer 404 for detail and act; the admin still gets through", async () => {
    const ctx = localCtx(OTHER);
    for (const key of [keyOf(name, 5, "questions"), opaqueKey(keyOf(name, 5, "questions")), "nope"]) {
      expect(await status(turnDetail(ctx, owner, false, key, NOW))).toBe(404);
      expect(await status(turnAct(ctx, owner, false, readAct({ key, action: "defaults", stamp: SINCE, digest: "x" }), NOW))).toBe(404);
    }
    expect(await bodies(5)).toHaveLength(1);
    expect((await turnDetail(ctx, owner, true, keyOf(name, 5, "questions"), NOW)).acts).toContain("answer");
    const cfgOnly = stub([{ id: "loc", repo: name, holds: localHolds() }]);
    expect(await status(turnDetail(cfgOnly, owner, false, keyOf(name, 5, "questions"), NOW))).toBe(404);
  });

  it("a GitHub watcher on the host login is refused, one with its own sign-in is allowed", async () => {
    withIdentity(true);
    expect(await status(turnDetail(ghCtx(), owner, false, ghKey, NOW))).toBe(404);
    withIdentity(false);
    process.env.FAKE_GH_COMMENTS = JSON.stringify({ comments: [{ author: { login: "foundry-owner" }, body: questionsComment, createdAt: "2026-10-01T00:00:00Z" }] });
    const ctx = ghCtx();
    await act(ctx, owner, false, { key: ghKey, action: "answer", stamp: SINCE, answers: [{ n: 1, text: "a" }] });
    expect(gh.ghLog()).toContain("gh issue comment");
    const diag = (ctx as unknown as { diagLog?: unknown }).diagLog;
    expect(diag).toBeUndefined();
  });

  it("an identity that throws or is missing counts as not allowed", async () => {
    identityOf = vi.fn(() => { throw new Error("boom"); });
    expect(await status(turnDetail(ghCtx(), owner, false, ghKey, NOW))).toBe(404);
    identityOf = vi.fn(() => undefined);
    expect(await status(turnDetail(ghCtx(), owner, false, ghKey, NOW))).toBe(404);
  });
});

describe("turnMine", () => {
  const both = () => {
    identityOf = vi.fn(() => ({ usesHostLogin: () => false, prepare: async () => undefined }));
    return stub([
      { id: "loc", repo: name, repoId, ownerId: OWNER, holds: localHolds() },
      { id: "gh", repo: "acme/app", repoId: "rid", ownerId: OTHER, holds: githubHolds() },
    ]);
  };

  it("lists only the person's items, with key, kind, acts and runId only; an admin gets all", () => {
    const ctx = both();
    const mine = turnMine(ctx, owner, false, NOW);
    expect(mine.items.length).toBe(turnFor(ctx, NOW).all.filter((i) => i.watcher === "loc" && i.acts.length).length);
    expect(mine.items.length).toBeGreaterThan(0);
    for (const i of mine.items) expect(Object.keys(i).every((k) => ["key", "kind", "runId", "acts"].includes(k))).toBe(true);
    const all = turnMine(ctx, owner, true, NOW);
    expect(all.items.length).toBe(mine.items.length + 1);
  });

  it("holds no repository name, and its opaque key works for the owner only", async () => {
    const ctx = both();
    const json = JSON.stringify(turnMine(ctx, owner, false, NOW)) + JSON.stringify(turnMine(ctx, owner, true, NOW));
    expect(json).not.toContain(name);
    expect(json).not.toContain("acme/app");
    expect(json).not.toContain("local:");
    const key = turnMine(ctx, owner, false, NOW).items.find((i) => i.kind === "questions")!.key;
    expect((await turnDetail(ctx, owner, false, key, NOW)).acts).toContain("answer");
    expect(await status(turnDetail(ctx, { id: OTHER }, false, key, NOW))).toBe(404);
    await act(ctx, owner, false, { key, action: "defaults", stamp: SINCE });
    expect(await bodies(5)).toHaveLength(2);
  });

  it("leaves out an item with no acts and an item acted on just now", async () => {
    const pr = { number: 4, url: "https://example.invalid/pull/4" };
    const rel = stub([{ id: "loc", repo: name, repoId, ownerId: OWNER, holds: [hold(nextStep("release", { repo: name, issue: undefined as unknown as number, title: "T" }, { watched: true, pr })), ...localHolds()] }]);
    expect(turnMine(rel, owner, false, NOW).items.some((i) => i.kind === "release")).toBe(false);
    const ctx = localCtx();
    const before = turnMine(ctx, owner, false, NOW).items.length;
    await act(ctx, owner, false, { key: keyOf(name, 5, "questions"), action: "defaults", stamp: SINCE });
    expect(turnMine(ctx, owner, false, NOW).items.length).toBe(before - 1);
  });
});
