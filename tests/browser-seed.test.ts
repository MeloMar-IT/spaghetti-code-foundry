import { existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startSeeded, type Seeded } from "./browser/seed.js";
import { WIDTHS, usesDrawer } from "./browser/widths.js";
import { signInAs, type TestSession } from "./helpers/session.js";

const savedHome = process.env.FACTORY_HOME;
const savedPath = process.env.PATH;

const get = async (s: Seeded, who: TestSession, path: string) => {
  const r = await fetch(s.url + path, { headers: who.headers() });
  return { status: r.status, json: (await r.json()) as any };
};
const list = (j: any, key: string): any[] => (Array.isArray(j) ? j : j[key]);

describe("the seeded server", () => {
  let s: Seeded;
  let admin: TestSession;
  let user: TestSession;
  let home: string;
  beforeAll(async () => {
    s = await startSeeded();
    home = process.env.FACTORY_HOME!;
    admin = await signInAs(s.url, { create: false });
    user = await signInAs(s.url, { name: "Ann", email: "ann@example.com", role: "user", create: false });
  });
  afterAll(async () => {
    await s?.close();
  });

  it("has a run in every main status", async () => {
    const r = await get(s, admin, "/api/runs");
    const rows = list(r.json, "runs");
    for (const status of ["running", "waiting", "succeeded", "failed", "cancelled", "stopped"]) {
      const row = rows.find((x) => x.runId === s.runs[status]);
      expect(row, status).toBeTruthy();
      expect(row.status).toBe(status);
    }
  });

  it("shows the user only their own runs", async () => {
    const r = await get(s, user, "/api/runs");
    expect(list(r.json, "runs").map((x) => x.runId).sort()).toEqual([...s.userRuns].sort());
  });

  it("has an admin and a user account", () => {
    expect(admin.user.role).toBe("admin");
    expect(user.user.role).toBe("user");
  });

  it("has a repository, a refinement session and a watcher", async () => {
    const repos = list((await get(s, user, "/api/repos")).json, "repos");
    expect(repos).toHaveLength(1);
    expect(JSON.stringify(repos[0])).toContain("acme/app");
    const sessions = list((await get(s, user, "/api/refinement")).json, "sessions");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(s.sessionId);
    const watchers = list((await get(s, admin, "/api/watchers")).json, "watchers");
    expect(watchers.some((w) => w.id === "ui-w")).toBe(true);
  });

  it("touches nothing real", () => {
    expect(home.startsWith(tmpdir())).toBe(true);
    expect(home).not.toBe(savedHome);
  });
});

describe("closing the seeded server", () => {
  it("stops the server, removes its folder and puts the environment back", async () => {
    const before = process.env.FACTORY_HOME;
    const s = await startSeeded();
    const home = process.env.FACTORY_HOME!;
    expect(existsSync(home)).toBe(true);
    await s.close();
    await expect(fetch(s.url)).rejects.toThrow();
    expect(existsSync(home)).toBe(false);
    expect(process.env.FACTORY_HOME).toBe(before);
    expect(process.env.PATH).toBe(savedPath);
    await s.close(); // closing twice is fine
  });
});

describe("the harness wiring", () => {
  it("defines the four widths once", () => {
    expect([...WIDTHS]).toEqual([360, 768, 1024, 1440]);
    expect(usesDrawer(360)).toBe(true);
    expect(usesDrawer(768)).toBe(false);
  });

  it("keeps the browser tests out of npm test", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.scripts["test:ui"]).toMatch(/^playwright test/);
    expect(pkg.scripts.test).toBe("vitest run");
    expect(pkg.devDependencies["@playwright/test"]).toBeTruthy();
    expect(readdirSync("tests/browser").filter((f) => f.endsWith(".test.ts"))).toEqual([]);
  });

  it("restores FACTORY_HOME", () => {
    expect(process.env.FACTORY_HOME).toBe(savedHome);
  });
});
