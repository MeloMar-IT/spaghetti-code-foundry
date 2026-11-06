import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunBrief } from "../src/engine/state.js";
import { HttpError } from "../src/server/http.js";
import { briefInScope, callerWorkspaces, checkScope, inWorkspaces, runInScope, scopedRepos, sessionInScope, userWorkspaces } from "../src/server/workspace-scope.js";
import { disposeWorkspaces, supplyWorkspaces } from "../src/workspaces/list.js";

// The session and its repository record are read from these, so a test can place them (#817).
const fake = vi.hoisted(() => ({ session: undefined as unknown, repo: undefined as unknown }));
vi.mock("../src/refinement/store.js", async (orig) => ({ ...(await orig<object>()), getSession: () => fake.session }));
vi.mock("../src/auth/repos.js", async (orig) => ({ ...(await orig<object>()), findOwnedProject: () => fake.repo, findOwnedRepo: () => fake.repo, getRepo: () => fake.repo }));

const ANN = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const CAT = "33333333-3333-4333-8333-333333333333";
const ann = { id: ANN, role: "user" as const };
const admin = { id: "99999999-9999-4999-8999-999999999999", role: "admin" as const };

let home: string;
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "wscope-"));
  process.env.FACTORY_HOME = home;
});
afterEach(() => {
  disposeWorkspaces("test");
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const supply = (list: unknown) => supplyWorkspaces({ owner: "test", plugin: "test", store: { list: () => list }, report: () => {} });
const TEAMS = [
  { id: "team-a", name: "A", members: [ANN] },
  { id: "team-b", name: "B", members: [BOB] },
];

describe("callerWorkspaces", () => {
  it("is undefined for an admin", () => {
    supply(TEAMS);
    expect(callerWorkspaces(admin)).toBeUndefined();
  });
  it("is exactly the workspaces that list the account", () => {
    supply(TEAMS);
    expect([...callerWorkspaces(ann)!]).toEqual(["team-a"]);
    expect([...callerWorkspaces({ id: BOB, role: "user" })!]).toEqual(["team-b"]);
  });
  it("is {default} for an account in no workspace, and no default for a team member", () => {
    supply(TEAMS);
    expect([...userWorkspaces(CAT)]).toEqual(["default"]);
    expect(userWorkspaces(ANN).has("default")).toBe(false);
  });
  it("is {default} when there is no list or the list is bad", () => {
    expect([...userWorkspaces(ANN)]).toEqual(["default"]);
    supply("not a list");
    expect([...userWorkspaces(ANN)]).toEqual(["default"]);
  });
});

describe("inWorkspaces", () => {
  it("lets everything through without a set", () => {
    expect(inWorkspaces(undefined, "team-x")).toBe(true);
    expect(inWorkspaces(undefined, undefined)).toBe(true);
  });
  it("reads an invalid or missing value as default", () => {
    expect(inWorkspaces(new Set(["default"]), undefined)).toBe(true);
    expect(inWorkspaces(new Set(["default"]), "Bad Id")).toBe(true);
    expect(inWorkspaces(new Set(["team-a"]), undefined)).toBe(false);
    expect(inWorkspaces(new Set(["team-a"]), "team-a")).toBe(true);
    expect(inWorkspaces(new Set(["team-a"]), "team-b")).toBe(false);
  });
});

describe("briefs, repositories and sessions", () => {
  const brief = (owner: string, workspace?: string) => ({ runId: "r", flow: "f", status: "succeeded", startedAt: "", runDir: "", dirName: "r", updatedAt: "", owner, ...(workspace ? { workspace } : {}) }) as RunBrief;
  it("keeps a user's own briefs in their workspaces, and everything for an admin", () => {
    supply(TEAMS);
    const ws = callerWorkspaces(ann);
    expect(briefInScope(ann, ws, brief(ANN, "team-a"))).toBe(true);
    expect(briefInScope(ann, ws, brief(ANN, "team-b"))).toBe(false);
    expect(briefInScope(ann, ws, brief(ANN))).toBe(false);
    expect(briefInScope(ann, ws, brief(BOB, "team-a"))).toBe(false);
    expect(briefInScope(admin, undefined, brief(BOB, "team-b"))).toBe(true);
  });
  it("filters repository records by workspace", () => {
    supply(TEAMS);
    const list = [{ id: "1", workspace: "team-a" }, { id: "2", workspace: "team-b" }, { id: "3" }];
    expect(scopedRepos(ann, list).map((r) => r.id)).toEqual(["1"]);
    expect(scopedRepos(admin, list)).toHaveLength(3);
  });
  it("runInScope needs the owner and the workspace, and passes an admin", () => {
    supply(TEAMS);
    const owners: Record<string, string> = { mine: ANN, mineB: ANN, theirs: BOB };
    const spaces: Record<string, string> = { mine: "team-a", mineB: "team-b", theirs: "team-a" };
    const ctx = { scheduler: { ownerOf: (id: string) => owners[id], workspaceOf: (id: string) => spaces[id] ?? "default" } } as unknown as Parameters<typeof runInScope>[0];
    expect(runInScope(ctx, ann, "mine")).toBe(true);
    expect(runInScope(ctx, ann, "mineB")).toBe(false);
    expect(runInScope(ctx, ann, "theirs")).toBe(false);
    expect(runInScope(ctx, ann, "unknown")).toBe(false);
    expect(runInScope(ctx, admin, "mineB")).toBe(true);
  });
  it("does not open a session whose architect run is in another workspace than the repository's (repository moved)", () => {
    supply(TEAMS);
    fake.session = { id: "s1", owner: ANN, repo: "acme/moved", architect: { runId: "run-b" } };
    fake.repo = { workspace: "team-a" };
    const ctx = { scheduler: { workspaceOf: (id: string) => (id === "run-b" ? "team-b" : "team-a") } } as unknown as Parameters<typeof checkScope>[0];
    let thrown: unknown;
    try {
      checkScope(ctx, ann as never, "session", ["refinement", "s1", "drop"]);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).status).toBe(404);
    fake.session = { id: "s1", owner: ANN, repo: "acme/moved", architect: { runId: "run-a" } };
    expect(() => checkScope(ctx, ann as never, "session", ["refinement", "s1", "drop"])).not.toThrow();
    fake.session = undefined;
    fake.repo = undefined;
  });
  it("sees a session whose repository record is gone", () => {
    supply(TEAMS);
    expect(sessionInScope(ann, { owner: ANN, repo: "acme/gone" })).toBe(true);
    expect(sessionInScope(admin, { owner: ANN, repo: "acme/gone" })).toBe(true);
  });
});
