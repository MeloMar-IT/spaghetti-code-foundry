import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, existsSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addRepo, getRepo, listAllRepos, removeRepo } from "../src/auth/repos.js";
import { withAuthLock } from "../src/auth/store.js";
import { createUser, findUserByEmail, type User } from "../src/auth/users.js";
import { readAutonomy } from "../src/governance/autonomy-store.js";
import { beginGuideProject, clearProgress, progressPath, readProgress, recordCreatingLocked, saveProgress } from "../src/onboarding/progress-store.js";
import { startProject } from "../src/server/api-starters.js";
import { HttpError } from "../src/server/http.js";
import type { ApiContext } from "../src/server/server.js";
import { TEST_PASSWORD } from "./helpers/session.js";

// `guide: true`: the project of the Get started guide is made once per account. Few cases use real git (temporary folders).

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "starter-guide-")));
const logs: string[] = [];
const ctx = { config: () => ({ simple: { hidden_starters: [] } }), diagLog: (m: string) => logs.push(m), opts: {} } as unknown as ApiContext;
let admin: User;
let n = 0;
const fresh = (): string => {
  const d = join(tmp, `p${n++}`);
  mkdirSync(d);
  return d;
};
const failure = async (p: Promise<unknown>): Promise<HttpError> => {
  try {
    await p;
  } catch (e) {
    return e as HttpError;
  }
  throw new Error("expected a failure");
};
const stores = () => ({ repos: listAllRepos().length, autonomy: Object.keys(readAutonomy().repos).length });

beforeAll(async () => {
  admin = findUserByEmail("admin@example.com") ?? (await createUser({ name: "Admin", email: "admin@example.com", password: TEST_PASSWORD, role: "admin" }));
});
beforeEach(() => {
  clearProgress(admin.id);
  logs.length = 0;
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("guide: true", () => {
  it("makes one project per account: a repeat answers existing with the same id, whatever the name", async () => {
    const parent = fresh();
    const first = await startProject(ctx, admin, "website", { name: "One", parent, guide: true });
    const before = stores();
    const again = (await startProject(ctx, admin, "website", { name: "Two", parent, guide: true })) as { repo: { id: string }; existing?: boolean };
    expect(again.existing).toBe(true);
    expect(again.repo.id).toBe(first.repo.id);
    expect(stores()).toEqual(before);
    expect(existsSync(join(parent, "two"))).toBe(false);
    const saved = readProgress(admin.id)!.answers;
    expect(saved.repoId).toBe(first.repo.id);
    expect(saved).not.toHaveProperty("making");
    // the repository is gone: the next call makes a new project
    removeRepo(admin.id, first.repo.id);
    const third = await startProject(ctx, admin, "website", { name: "Three", parent, guide: true });
    expect(third.repo.id).not.toBe(first.repo.id);
    expect(readProgress(admin.id)!.answers.repoId).toBe(third.repo.id);
  });

  it("two calls at the same time make one project", async () => {
    const parent = fresh();
    const [x, y] = await Promise.all([
      startProject(ctx, admin, "website", { name: "Twin", parent, guide: true }),
      startProject(ctx, admin, "website", { name: "Twin", parent, guide: true }),
    ]);
    expect(x.repo.id).toBe(y.repo.id);
    expect(listAllRepos().filter((r) => r.url === join(parent, "twin"))).toHaveLength(1);
  });

  it("Start again while the project is being made: 409, and nothing is left", async () => {
    const parent = fresh();
    const before = stores();
    const e = await failure(startProject(ctx, admin, "website", { name: "Reset", parent, guide: true }, { afterTest: () => void clearProgress(admin.id) }));
    expect(e.status).toBe(409);
    expect(stores()).toEqual(before);
    expect(existsSync(join(parent, "reset"))).toBe(false);
    expect(readProgress(admin.id)).toBeNull();
  });

  it("a progress file that cannot be used: a fixed 500 without a path, and nothing is left", async () => {
    const parent = fresh();
    const before = stores();
    const e = await failure(startProject(ctx, admin, "website", { name: "Broken", parent, guide: true }, { beforeConnect: () => writeFileSync(progressPath(), "{") }));
    expect(e.status).toBe(500);
    expect(e.message).not.toContain("/");
    expect(e.message).not.toContain("onboarding-progress");
    expect(stores()).toEqual(before);
    expect(existsSync(join(parent, "broken"))).toBe(false);
    expect(logs.some((l) => l.includes(tmp))).toBe(false);
    rmSync(progressPath(), { force: true });
  });
});

describe("guide: true, interruptions and resets", () => {
  it("a restart after the record was written undoes that record on the next make", async () => {
    const parent = fresh();
    const dir = join(parent, "interrupted");
    mkdirSync(dir);
    execFileSync("git", ["init", "-q", dir]);
    const begun = beginGuideProject(admin.id, () => false) as { token: string };
    // the process stops right after the record is saved: no connection test, no repoId
    const record = addRepo(admin.id, { url: dir, method: "local" }, { beforeSave: (id) => recordCreatingLocked(admin.id, begun.token, id) });
    expect(readProgress(admin.id)!.answers.creating).toBe(record.id);
    expect(getRepo(record.id)).toBeDefined();
    const out = await startProject(ctx, admin, "website", { name: "Retry", parent, guide: true });
    expect(out.existing).toBeUndefined();
    expect(getRepo(record.id)).toBeUndefined();
    expect(readAutonomy().repos[record.id]).toBeUndefined();
    expect(readProgress(admin.id)!.answers).toEqual({ repoId: out.repo.id });
    expect(listAllRepos().filter((r) => r.id === record.id)).toHaveLength(0);
  });

  it("a restart before the record was saved leaves nothing to undo and the next make works", async () => {
    const parent = fresh();
    const begun = beginGuideProject(admin.id, () => false) as { token: string };
    withAuthLock(() => recordCreatingLocked(admin.id, begun.token, randomUUID()));
    const out = await startProject(ctx, admin, "website", { name: "Early Stop", parent, guide: true });
    expect(out.existing).toBeUndefined();
    expect(readProgress(admin.id)!.answers).toEqual({ repoId: out.repo.id });
  });

  it("a request queued before Start again makes nothing, even when the reset came from the first request", async () => {
    const parent = fresh();
    const before = stores();
    const first = startProject(ctx, admin, "website", { name: "Queued A", parent, guide: true }, { afterTest: () => void clearProgress(admin.id) });
    const second = startProject(ctx, admin, "website", { name: "Queued B", parent, guide: true });
    const [a, b] = await Promise.allSettled([first, second]);
    expect(a.status === "rejected" && (a.reason as HttpError).status).toBe(409);
    expect(b.status === "rejected" && (b.reason as HttpError).status).toBe(409);
    expect(stores()).toEqual(before);
    expect(existsSync(join(parent, "queued-a"))).toBe(false);
    expect(existsSync(join(parent, "queued-b"))).toBe(false);
    expect(readProgress(admin.id)).toBeNull();
  });

  it("a request that arrives after the reset is served as usual", async () => {
    const parent = fresh();
    clearProgress(admin.id);
    const out = await startProject(ctx, admin, "website", { name: "After Reset", parent, guide: true });
    expect(out.repo.id).toBeDefined();
    expect(readProgress(admin.id)!.answers.repoId).toBe(out.repo.id);
  });
});

describe("guide: true, without a project made", () => {
  it("refuses a guide that is not true or false", async () => {
    expect((await failure(startProject(ctx, admin, "website", { name: "x", guide: "yes" }))).status).toBe(400);
  });

  it("answers a fixed 500 for a garbled progress file before any folder is made", async () => {
    const parent = fresh();
    writeFileSync(progressPath(), "secret {");
    const e = await failure(startProject(ctx, admin, "website", { name: "Early", parent, guide: true }));
    expect(e.status).toBe(500);
    expect(e.message).not.toContain("secret");
    expect(e.message).not.toContain(tmp);
    expect(existsSync(join(parent, "early"))).toBe(false);
    rmSync(progressPath(), { force: true });
  });

  it("answers 400 for a full entry before any folder is made", async () => {
    const parent = fresh();
    const answers: Record<string, string> = {};
    for (let i = 0; i < 20; i++) answers[`k${i}`] = "x";
    saveProgress(admin.id, { step: "step-5", answers });
    const e = await failure(startProject(ctx, admin, "website", { name: "Full", parent, guide: true }));
    expect(e.status).toBe(400);
    expect(existsSync(join(parent, "full"))).toBe(false);
    expect(Object.keys(readProgress(admin.id)!.answers)).toHaveLength(20);
  });
});
