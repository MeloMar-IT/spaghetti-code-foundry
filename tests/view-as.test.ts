import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuditEntrySchema } from "../src/auth/audit.js";
import { startServer } from "../src/server/server.js";
import { VIEW_AS_MS, ViewStore, viewsOf } from "../src/server/view-as.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { signInAs, type TestSession } from "./helpers/session.js";

const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
let tmp: string;
let runsDir: string;
let close: () => void;
let ctx: Awaited<ReturnType<typeof startServer>>["ctx"];
let kc: FakeKeychain;
let saved: string | undefined;
let now = 1_000_000;
let admin: TestSession;
let ann: TestSession;
let bob: TestSession;
let annRun: string;
let bobRun: string;

const WALK = `name: walk
workspace: empty
publish:
  enabled: true
steps:
  - {id: say, type: shell, run: "echo hi"}
  - {id: gate, type: approval, message: "Go?"}
`;

beforeAll(async () => {
  saved = process.env.FACTORY_HOME;
  tmp = mkdtempSync(join(tmpdir(), "viewas-"));
  process.env.FACTORY_HOME = join(tmp, "home");
  kc = fakeKeychain();
  const repo = join(tmp, "repo");
  runsDir = join(tmp, "runs");
  mkdirSync(repo);
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: repo, stdio: "ignore" });
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "init");
  ({ close, ctx } = await startServer({
    repo,
    runsDir,
    port,
    claudeBin: resolve("tests/fixtures/fake-claude.mjs"),
    watchers: false,
    viewAsClock: () => now,
    sessionRecheckMs: 100,
  }));
  admin = await signInAs(base);
  ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
  bob = await signInAs(base, { name: "Bob", email: "bob@example.com", role: "user" });
  expect((await call(ann, "POST", "/api/repos", { name: "acme/app" })).status).toBe(201);
  expect((await call(admin, "PUT", "/api/flows/walk", { yaml: WALK, scope: "repo" })).status).toBe(200);
  annRun = await waitingRun(ann);
  bobRun = await waitingRun(bob);
});
afterAll(() => {
  close();
  kc.remove();
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(tmp, { recursive: true, force: true });
});

async function call(who: TestSession | undefined, method: string, path: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(who ? who.headers(method) : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, text, json: () => JSON.parse(text), error: () => (JSON.parse(text) as { error?: string }).error };
}

async function waitingRun(who: TestSession): Promise<string> {
  const r = await call(who, "POST", "/api/runs", { flow: "walk", task: "walk" });
  expect(r.status).toBe(201);
  const { runId } = r.json() as { runId: string };
  expect((await ctx.scheduler.wait(runId))?.status).toBe("waiting");
  return runId;
}

/** Reads a run stream until its first `update` event; returns the content type and that event's data. */
async function firstUpdate(who: TestSession, path: string): Promise<{ type: string; data: string }> {
  const ctl = new AbortController();
  const r = await fetch(base + path, { headers: who.headers(), signal: ctl.signal });
  const type = r.headers.get("content-type") ?? "";
  const reader = r.body!.getReader();
  const dec = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const m = /event: update\ndata: (.*)\n/.exec(text);
      if (m) return { type, data: m[1]! };
      const { done, value } = await reader.read();
      if (done) return { type, data: text };
      text += dec.decode(value);
    }
  } finally {
    ctl.abort();
  }
}

/** Opens a stream; `ended` settles when the server cut the connection. */
function openStream(who: TestSession, path: string) {
  const ctl = new AbortController();
  let over = false;
  const ended = fetch(base + path, { headers: who.headers(), signal: ctl.signal }).then(
    async (r) => {
      const reader = r.body!.getReader();
      try {
        for (;;) if ((await reader.read()).done) break;
      } catch {
        // cut
      }
      over = true;
    },
    () => void (over = true),
  );
  return { ended: () => over, done: ended, abort: () => ctl.abort() };
}
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  return cond();
};

const start = (who: TestSession, id: string) => call(who, "POST", "/api/admin/view-as", { userId: id });
const auditLines = () => readFileSync(join(process.env.FACTORY_HOME!, "audit.jsonl"), "utf8").split("\n").filter(Boolean);
const viewLines = () => auditLines().filter((l) => JSON.parse(l).action === "view-as");

describe("ViewStore", () => {
  it("starts, gets, ends, expires and prunes", () => {
    let t = 0;
    const s = new ViewStore(() => t);
    s.start("a", "u1");
    s.start("b", "u2");
    expect(s.get("a")?.userId).toBe("u1");
    s.start("a", "u3"); // replaces
    expect(s.get("a")?.userId).toBe("u3");
    expect(s.end("b")).toBe(true);
    expect(s.end("b")).toBe(false);
    t = VIEW_AS_MS;
    expect(s.get("a")).toBeUndefined();
    s.start("c", "u4");
    expect(s.size).toBe(1);
  });
});

describe("view as user", () => {
  it("rejects bad starts", async () => {
    expect((await start(admin, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await start(admin, "nope")).status).toBe(400);
    expect((await start(admin, admin.user.id)).status).toBe(400);
    const second = await signInAs(base, { name: "Two", email: "two@example.com", role: "admin" });
    expect((await start(admin, second.user.id)).status).toBe(400);
    const a = await start(ann, bob.user.id);
    expect(a.status).toBe(403);
    expect(a.error()).toBe("not allowed for your role");
    const r = await fetch(`${base}/api/admin/view-as`, { method: "POST", headers: { cookie: admin.cookie, "content-type": "application/json" }, body: JSON.stringify({ userId: ann.user.id }) });
    expect(r.status).toBe(403);
    expect(viewsOf(ctx).size).toBe(0);
  });

  it("refuses as= without a view, from a user, and with writes", async () => {
    const q = `?as=${ann.user.id}`;
    expect((await call(admin, "GET", `/api/runs${q}`)).status).toBe(403);
    expect((await call(admin, "GET", "/api/runs?as=")).status).toBe(403);
    expect((await call(ann, "GET", `/api/runs?as=${bob.user.id}`)).status).toBe(403);
    expect((await call(ann, "GET", `/api/runs${q}`)).status).toBe(403);
    const w = await call(admin, "POST", `/api/runs${q}`, { flow: "walk", task: "x" });
    expect(w.status).toBe(403);
    expect(w.error()).toBe("the preview is read-only");
    expect((await call(admin, "DELETE", `/api/session${q}`)).status).toBe(403);
    expect((await call(admin, "GET", "/api/session")).status).toBe(200);
  });

  it("answers as the user, read-only, with one audit line", async () => {
    const before = auditLines().length;
    const r = await start(admin, ann.user.id);
    expect(r.status).toBe(200);
    expect(r.json()).toEqual({ id: ann.user.id, name: "Ann" });
    expect(auditLines()).toHaveLength(before + 1);
    const entry = AuditEntrySchema.parse(JSON.parse(viewLines().at(-1)!));
    expect(entry).toMatchObject({ by: admin.user.id, action: "view-as", result: "ok", userId: ann.user.id });
    expect(auditLines().join("\n")).not.toContain(admin.token);

    const q = `as=${ann.user.id}`;
    for (const path of ["flows", "queue", "runs", `runs/${annRun}`, `runs/${annRun}/diff`, "repos", "repos/methods", "credentials", "refinement"]) {
      const viewed = await call(admin, "GET", `/api/${path}?${q}`);
      const own = await call(ann, "GET", `/api/${path}`);
      expect(viewed.status, path).toBe(own.status);
      expect(viewed.json(), path).toEqual(own.json());
    }
    // the refinement session of Ann, and the run stream
    const made = await call(ann, "POST", "/api/refinement", { repo: "acme/app", idea: "An idea" });
    expect(made.status).toBe(201);
    const rpath = `/api/refinement/${made.json().id}`;
    const rv = await call(admin, "GET", `${rpath}?${q}`);
    expect(rv.status).toBe(200);
    expect(rv.json()).toEqual((await call(ann, "GET", rpath)).json());
    expect((await call(admin, "GET", `/api/refinement?${q}`)).json()).toEqual((await call(ann, "GET", "/api/refinement")).json());
    const evViewed = await firstUpdate(admin, `/api/runs/${annRun}/events?${q}`);
    const evOwn = await firstUpdate(ann, `/api/runs/${annRun}/events`);
    expect(evViewed.type).toContain("text/event-stream");
    expect(evViewed.data).toBe(evOwn.data);
    expect((await call(admin, "GET", `/api/runs/${bobRun}/events?${q}`)).status).toBe(404);
    expect((await call(admin, "GET", `/api/runs?owner=${bob.user.id}&${q}`)).json()).toEqual((await call(ann, "GET", "/api/runs")).json());
    // an admin's own repository does not show in the view
    expect((await call(admin, "POST", "/api/repos", { name: "mine/admin-repo", method: "none" })).status).toBe(201);
    expect((await call(admin, "GET", `/api/repos?${q}`)).text).not.toContain("admin-repo");
    expect((await call(admin, "GET", `/api/repos/methods?${q}`)).text).not.toContain('"none"');
    // limits
    for (const path of [`runs/${bobRun}`, `runs/${bobRun}/diff`]) {
      const x = await call(admin, "GET", `/api/${path}?${q}`);
      expect(x.status, path).toBe(404);
    }
    for (const path of ["users", "config", `runs/${annRun}/transcript/0`]) {
      const x = await call(admin, "GET", `/api/${path}?${q}`);
      expect(x.status, path).toBe(403);
      expect(x.error()).toBe("not allowed for your role");
    }
    // read-only
    const cancel = await call(admin, "POST", `/api/runs/${annRun}/cancel?${q}`);
    expect(cancel.status).toBe(403);
    expect(cancel.error()).toBe("the preview is read-only");
    expect((await call(admin, "POST", `/api/admin/view-as?${q}`, { userId: bob.user.id })).status).toBe(403);
    expect(viewsOf(ctx).size).toBe(1);
    expect(auditLines()).toHaveLength(before + 2); // the view and the admin's repo; no line per GET
    // other users, other sessions and /api/session
    expect((await call(admin, "GET", `/api/runs?as=${bob.user.id}`)).status).toBe(403);
    const again = await signInAs(base, {});
    expect((await call(again, "GET", `/api/runs?${q}`)).status).toBe(403);
    expect((await call(admin, "GET", `/api/session?${q}`)).json()).toEqual((await call(admin, "GET", "/api/session")).json());
    expect((await call(undefined, "GET", `/api/session?${q}`)).json().user).toBeNull();
    // /api/ready is not exempt
    expect((await call(undefined, "GET", `/api/ready?${q}`)).status).toBe(401);
    expect((await call(ann, "GET", `/api/ready?${q}`)).status).toBe(403);
    expect((await call(admin, "GET", `/api/ready?${q}`)).status).toBe(404);
    // an unchanged call
    expect((await call(admin, "GET", "/api/runs")).json().length).toBeGreaterThanOrEqual(2);
  });

  it("keeps working for a blocked user, and stops on promotion or expiry", async () => {
    const q = `?as=${ann.user.id}`;
    expect((await call(admin, "POST", `/api/users/${ann.user.id}/block`, {})).status).toBe(200);
    expect((await call(admin, "GET", `/api/runs${q}`)).status).toBe(200);
    now += VIEW_AS_MS;
    expect((await call(admin, "GET", `/api/runs${q}`)).status).toBe(403);
    expect((await start(admin, ann.user.id)).status).toBe(200);
    expect((await call(admin, "DELETE", "/api/admin/view-as")).status).toBe(200);
    expect((await call(admin, "GET", `/api/runs${q}`)).status).toBe(403);
    expect((await start(admin, ann.user.id)).status).toBe(200);
    expect((await call(admin, "PUT", `/api/users/${ann.user.id}`, { role: "admin" })).status).toBe(200);
    expect((await call(admin, "GET", `/api/runs${q}`)).status).toBe(403);
    expect(viewsOf(ctx).size).toBe(0);
  });

  it("closes an open preview stream when the view expires, is ended, or the session ends", async () => {
    const path = `/api/runs/${bobRun}/events?as=${bob.user.id}`;
    // stays open while nothing changes
    expect((await start(admin, bob.user.id)).status).toBe(200);
    const s1 = openStream(admin, path);
    expect(await until(s1.ended, 600)).toBe(false);
    // expiry
    now += VIEW_AS_MS;
    expect(await until(s1.ended)).toBe(true);
    // DELETE
    expect((await start(admin, bob.user.id)).status).toBe(200);
    const s2 = openStream(admin, path);
    expect(await until(s2.ended, 600)).toBe(false);
    expect((await call(admin, "DELETE", "/api/admin/view-as")).status).toBe(200);
    expect(await until(s2.ended)).toBe(true);
    // the session ends
    expect((await start(admin, bob.user.id)).status).toBe(200);
    const s3 = openStream(admin, path);
    expect(await until(s3.ended, 600)).toBe(false);
    expect((await call(admin, "DELETE", "/api/session")).status).toBe(200);
    expect(await until(s3.ended)).toBe(true);
    s1.abort();
    s2.abort();
    s3.abort();
  });
});
