import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer } from "./helpers/port.js";
import { TEST_PASSWORD, signInAs, type TestSession } from "./helpers/session.js";

let home: string;
let saved: string | undefined;
let base: string;
let close: () => void;
let admin: TestSession;
let ann: TestSession;

beforeAll(async () => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "me-view-"));
  process.env.FACTORY_HOME = home;
  ({ base, close } = await startTestServer({
    repo: home, runsDir: join(home, "runs"), claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false,
  }));
  admin = await signInAs(base);
  ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
});
afterAll(() => {
  close();
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const call = async (who: TestSession, method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, {
    method,
    headers: who.headers(method, body === undefined ? {} : { "content-type": "application/json" }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
};

describe("/api/me/view", () => {
  it("answers the defaults and the views of the role", async () => {
    expect((await call(ann, "GET", "/api/me/view")).json).toEqual({ view: "advanced", views: ["simple", "advanced"] });
    expect((await call(admin, "GET", "/api/me/view")).json).toEqual({ view: "admin", views: ["simple", "advanced", "admin"] });
  });

  it("keeps the choice for the next sign-in, also after sign-out", async () => {
    const put = await call(ann, "PUT", "/api/me/view", { view: "simple" });
    expect(put).toMatchObject({ status: 200, json: { view: "simple" } });
    for (let i = 0; i < 2; i++) {
      const again = await signInAs(base, { email: "ann@example.com", create: false });
      expect(again.user).toMatchObject({ view: "simple", views: ["simple", "advanced"] });
      expect((await call(again, "GET", "/api/session")).json.user).toMatchObject({ view: "simple" });
      expect((await call(again, "GET", "/api/me/view")).json.view).toBe("simple");
      await call(again, "DELETE", "/api/session");
    }
    expect(TEST_PASSWORD.length).toBeGreaterThan(0);
  });

  it("refuses a view the role may not use, and a bad value", async () => {
    const who = await signInAs(base, { name: "Bob", email: "bob@example.com", role: "user" });
    expect((await call(who, "PUT", "/api/me/view", { view: "admin" })).status).toBe(403);
    expect((await call(who, "GET", "/api/me/view")).json.view).toBe("advanced");
    for (const body of [{}, { view: 3 }, { view: "expert" }]) {
      expect((await call(who, "PUT", "/api/me/view", body)).status).toBe(400);
      expect((await call(admin, "PUT", "/api/me/view", body)).status).toBe(400);
    }
  });

  it("does not change what an admin may do", async () => {
    expect((await call(admin, "PUT", "/api/me/view", { view: "simple" })).status).toBe(200);
    expect((await call(admin, "GET", "/api/users")).status).toBe(200);
    expect((await call(admin, "PUT", "/api/me/view", { view: "admin" })).status).toBe(200);
  });
});
