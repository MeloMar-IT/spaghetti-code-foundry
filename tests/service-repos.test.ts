import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRepo, reposPath, setRepoSettings } from "../src/auth/repos.js";
import { createSession } from "../src/refinement/store.js";
import { HttpError } from "../src/server/http.js";
import { findRule } from "../src/server/permissions.js";
import { checkServiceRepos } from "../src/server/service-requests.js";

// `services: none` (#869): checkServiceRepos as a unit, with a stub scheduler and repositories in a temporary data folder.

const SVC = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000b2";
const OK = { ownerOk: () => true };

let home: string;
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "svc-repos-"));
  process.env.FACTORY_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

interface Stub { briefs?: { owner: string; githubRepo: string }[]; repos?: Record<string, string>; queued?: string[] }
const ctxOf = (s: Stub = {}) => ({
  diagLog: () => {},
  scheduler: { briefs: () => s.briefs ?? [], repoOf: (id: string) => s.repos?.[id], queuedRepos: () => s.queued ?? [] },
}) as never;
const svc = { id: SVC, role: "user", kind: "service", scope: [] } as never;
const person = { id: SVC, role: "user" } as never;

/** Runs the check for a call like `GET runs/x`, `POST skills/lifecycle`; returns the status (200 when it passes). */
function status(method: string, path: string, opts: { ctx?: never; user?: never; query?: string } = {}): number {
  const seg = path.split("/");
  const rule = findRule(method, seg);
  if (!rule) throw new Error(`no rule ${method} ${path}`);
  try {
    checkServiceRepos(opts.ctx ?? ctxOf(), opts.user ?? svc, rule, seg, new URLSearchParams(opts.query ?? ""));
    return 200;
  } catch (e) {
    return e instanceof HttpError ? e.status : 0;
  }
}

const close = (id: string) => setRepoSettings(id, { services: "none" });

describe("with no closed repository", () => {
  it("passes every rule", () => {
    addRepo(OTHER, "acme/open", OK);
    expect(status("GET", "board")).toBe(200);
    expect(status("GET", "help/conversations")).toBe(200);
    expect(status("POST", "skills/lifecycle")).toBe(200);
  });
});

describe("with a closed repository", () => {
  let closedId: string;
  let openId: string;
  beforeEach(() => {
    closedId = addRepo(OTHER, "acme/closed", OK).id;
    openId = addRepo(OTHER, "acme/open", OK).id;
    close(closedId);
  });

  it("never checks a person", () => {
    expect(status("GET", "board", { user: person })).toBe(200);
    expect(status("GET", `repos/${closedId}/ready`, { user: person })).toBe(200);
  });

  it("refuses a repository named by id, by name, by query or through a run", () => {
    expect(status("GET", `repos/${closedId}/ready`)).toBe(403);
    expect(status("GET", `admin/repos/${closedId}/watchers`)).toBe(403);
    expect(status("DELETE", "repos/acme/closed")).toBe(403);
    expect(status("GET", "runs", { query: "repo=acme/closed" })).toBe(403);
    expect(status("GET", "runs/r1/events", { ctx: ctxOf({ repos: { r1: "acme/closed" } }) })).toBe(403);
    expect(status("GET", "runs/r1/diff", { ctx: ctxOf({ repos: { r1: "Acme/Closed.git" } }) })).toBe(403);
  });

  it("refuses a run whose repository is stored as an HTTPS or SSH address", () => {
    for (const address of ["https://github.com/acme/closed", "https://github.com/Acme/Closed.git", "git@github.com:acme/closed.git", "ssh://git@github.com/acme/closed"]) {
      expect(status("GET", "runs/r1/events", { ctx: ctxOf({ repos: { r1: address } }) }), address).toBe(403);
      expect(status("GET", "runs/r1/diff", { ctx: ctxOf({ repos: { r1: address } }) }), address).toBe(403);
    }
    expect(status("GET", "runs", { query: "repo=https://github.com/acme/closed.git" })).toBe(403);
    expect(status("GET", "queue", { ctx: ctxOf({ queued: ["git@github.com:acme/closed.git"] }) })).toBe(403);
    expect(status("GET", "runs/r1/events", { ctx: ctxOf({ repos: { r1: "https://github.com/acme/open" } }) })).toBe(200);
  });

  it("passes an open repository by the same paths", () => {
    expect(status("GET", `repos/${openId}/ready`)).toBe(200);
    expect(status("GET", `admin/repos/${openId}/watchers`)).toBe(200);
    expect(status("DELETE", "repos/acme/open")).toBe(200);
    expect(status("GET", "runs", { query: "repo=acme/open" })).toBe(200);
    expect(status("GET", "runs/r1/events", { ctx: ctxOf({ repos: { r1: "acme/open" } }) })).toBe(200);
    expect(status("GET", "runs/unknown/events")).toBe(200);
  });

  it("refuses an admin-only rule about no named object, unless it holds no repository data", () => {
    expect(status("GET", "board")).toBe(403);
    expect(status("GET", "admin/repos")).toBe(403);
    expect(status("POST", "skills/lifecycle")).toBe(403);
    expect(status("GET", "governor")).toBe(200);
    expect(status("GET", "skills/lifecycle")).toBe(200);
  });

  it("refuses Ask Foundry, but not its admin usage page", () => {
    expect(status("GET", "help/conversations")).toBe(403);
    expect(status("GET", "help/conversations/c1")).toBe(403);
    expect(status("GET", "help/export")).toBe(403);
    expect(status("POST", "help/context")).toBe(403);
    expect(status("GET", "help/usage")).toBe(200);
  });

  it("lets a user-open list rule pass when the account has nothing on a closed repository", () => {
    expect(status("GET", "runs")).toBe(200);
    expect(status("GET", "queue")).toBe(200);
    expect(status("GET", "refinement")).toBe(200);
    expect(status("GET", "me/view")).toBe(200);
  });

  it("refuses a list rule when the account owns a closed record, or has a run on one", () => {
    expect(status("GET", "runs", { ctx: ctxOf({ briefs: [{ owner: SVC, githubRepo: "acme/closed" }] }) })).toBe(403);
    expect(status("GET", "runs", { ctx: ctxOf({ briefs: [{ owner: OTHER, githubRepo: "acme/closed" }] }) })).toBe(200);
    expect(status("GET", "runs", { ctx: ctxOf({ briefs: [{ owner: SVC, githubRepo: "acme/open" }] }) })).toBe(200);
  });

  it("refuses a list rule for a queued job or a session on a repository that was moved away and closed", () => {
    expect(status("GET", "queue", { ctx: ctxOf({ queued: ["acme/closed"] }) })).toBe(403);
    createSession(SVC, { repo: "acme/closed", idea: "an idea" }, { ...OK, repoName: (_u, n) => n });
    expect(status("GET", "refinement")).toBe(403);
    expect(status("GET", "changes")).toBe(403);
    expect(status("GET", "me/view")).toBe(200);
  });

  it("refuses a session by id when its repository is closed", () => {
    const s = createSession(OTHER, { repo: "acme/closed", idea: "an idea" }, OK);
    const o = createSession(OTHER, { repo: "acme/open", idea: "an idea" }, OK);
    expect(status("GET", `refinement/${s.id}`)).toBe(403);
    expect(status("GET", `refinement/${o.id}`)).toBe(200);
  });

  it("clears when the setting is cleared", () => {
    expect(status("GET", "board")).toBe(403);
    setRepoSettings(closedId, { services: "all" });
    expect(status("GET", "board")).toBe(200);
  });
});

describe("a repository file that cannot be read", () => {
  it("fails closed with 500 once a repository file exists", () => {
    addRepo(OTHER, "acme/open", OK);
    writeFileSync(reposPath(), "{ not json");
    expect(status("GET", "board")).toBe(500);
  });
});
