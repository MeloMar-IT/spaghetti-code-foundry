import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addRepo, removeRepo } from "../src/auth/repos.js";
import { startTestServer } from "./helpers/port.js";
import { signInAs, type TestSession } from "./helpers/session.js";

// The change feed over HTTP (#868): kinds, the long-poll, reset, who sees what, and a restart on the same data folder.

type Started = Awaited<ReturnType<typeof startTestServer>>;
let tmp: string;
let saved: string | undefined;
let server: Started;
let admin: TestSession;
let ann: TestSession;
let bob: TestSession;

const opts = () => ({ repo: join(tmp, "repo"), runsDir: join(tmp, "runs"), claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, feedTickMs: 40, accountSweepMs: 3_600_000 });
const feed = async (who: TestSession, query = "") => {
  const r = await fetch(`${server.base}/api/feed${query}`, { headers: who.headers("GET") });
  return { status: r.status, body: (await r.json()) as { seq: number; reset?: boolean; changes: { kind: string; id: string; at: string }[] } };
};
const seqOf = async (who: TestSession) => (await feed(who)).body.seq;

beforeAll(async () => {
  saved = process.env.FACTORY_HOME;
  tmp = mkdtempSync(join(tmpdir(), "feed-api-"));
  process.env.FACTORY_HOME = join(tmp, "home");
  mkdirSync(join(tmp, "repo"));
  server = await startTestServer(opts());
  admin = await signInAs(server.base);
  ann = await signInAs(server.base, { name: "Ann", email: "ann@example.com", role: "user" });
  bob = await signInAs(server.base, { name: "Bob", email: "bob@example.com", role: "user" });
});
afterAll(() => {
  server.close();
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(tmp, { recursive: true, force: true });
});

describe("GET /api/feed", () => {
  it("answers reset with a seq when since is missing or too old, and nothing new afterwards", async () => {
    const first = await feed(ann);
    expect(first.status).toBe(200);
    expect(first.body.reset).toBe(true);
    expect(first.body.changes).toEqual([]);
    expect(await feed(ann, "?since=1")).toMatchObject({ body: { reset: true } });
    expect((await feed(ann, `?since=${first.body.seq + 1000}`)).body.reset).toBe(true);
    expect((await feed(ann, `?since=${first.body.seq}`)).body).toEqual({ seq: first.body.seq, changes: [] });
  });

  it("refuses a bad wait or since", async () => {
    for (const q of ["?wait=31", "?wait=-1", "?wait=1.5", "?since=x"]) expect((await feed(ann, q)).status, q).toBe(400);
  });

  it("lists a new repository for its owner and the admin, not for another user, with the kind and id only", async () => {
    const since = await seqOf(ann);
    const repo = addRepo(ann.user.id, { url: "acme/feed-app", method: "none" });
    const mine = await feed(ann, `?since=${since}&wait=10`);
    expect(mine.body.changes).toHaveLength(1);
    expect(Object.keys(mine.body.changes[0]!).sort()).toEqual(["at", "id", "kind"]);
    expect(mine.body.changes[0]).toMatchObject({ kind: "repo", id: repo.id });
    expect((await feed(admin, `?since=${since}`)).body.changes.map((c) => c.id)).toContain(repo.id);
    expect((await feed(bob, `?since=${since}`)).body.changes).toEqual([]);
    // a removed repository is a change too
    const after = (await feed(ann)).body.seq;
    removeRepo(ann.user.id, repo.id);
    expect((await feed(ann, `?since=${after}&wait=10`)).body.changes).toMatchObject([{ kind: "repo", id: repo.id }]);
  });

  it("holds a long-poll until its time is up when nothing visible changes, and lets go of the waiter when the caller leaves", async () => {
    const since = await seqOf(bob);
    const held = feed(bob, `?since=${since}&wait=1`);
    addRepo(ann.user.id, { url: "acme/hidden-from-bob", method: "none" }); // a change Bob may not see
    expect((await held).body).toEqual({ seq: expect.any(Number), changes: [] });
    const ctl = new AbortController();
    const pending = fetch(`${server.base}/api/feed?since=${await seqOf(bob)}&wait=30`, { headers: bob.headers("GET"), signal: ctl.signal }).catch(() => undefined);
    while (server.ctx.feed!.waiting() === 0) await new Promise((r) => setTimeout(r, 10));
    ctl.abort();
    await pending;
    while (server.ctx.feed!.waiting() !== 0) await new Promise((r) => setTimeout(r, 10));
  });
});

describe("a service account", () => {
  const make = async (scope: string[]) => {
    const r = await fetch(`${server.base}/api/service-accounts`, { method: "POST", headers: admin.headers("POST", { "content-type": "application/json" }), body: JSON.stringify({ name: `Robot ${scope.length}`, scope }) });
    expect(r.status).toBe(201);
    return ((await r.json()) as { token: string }).token;
  };
  const call = (token: string, query: string) => fetch(`${server.base}/api/feed${query}`, { headers: { authorization: `Bearer ${token}` } });

  it("gets 403 without GET feed in its scope", async () => {
    expect((await call(await make(["GET runs"]), "")).status).toBe(403);
  });

  it("sees only the kinds whose read route is in its scope", async () => {
    const token = await make(["GET feed", "GET runs/:id"]);
    const since = ((await (await call(token, "")).json()) as { seq: number }).seq;
    addRepo(ann.user.id, { url: "acme/scoped", method: "none" });
    await feed(admin); // let the recorder look
    const r = await call(token, `?since=${since}&wait=1`);
    expect(((await r.json()) as { changes: unknown[] }).changes).toEqual([]);
  });
});

describe("saving feed.json", () => {
  it("tries again after a failed write, with no further change needed", async () => {
    const file = join(tmp, "home", "feed.json");
    rmSync(file, { force: true });
    mkdirSync(file); // a directory in the file's place: the write fails
    const repo = addRepo(ann.user.id, { url: "acme/retry-save", method: "none" });
    server.ctx.feed!.tick(); // recorded, but the save fails
    rmSync(file, { recursive: true });
    server.ctx.feed!.tick(); // nothing new: the retry alone writes it
    const saved = JSON.parse(readFileSync(file, "utf8")) as { changes: { i: string }[] };
    expect(saved.changes.map((c) => c.i)).toContain(repo.id);
  });
});

describe("a restart on the same data folder", () => {
  it("continues the sequence, tells what changed while the server was down, and answers reset when the file is lost", async () => {
    await feed(admin);
    const file = join(tmp, "home", "feed.json");
    await new Promise((r) => setTimeout(r, 120)); // one more tick wrote the file
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const before = (await feed(admin)).body.seq;
    server.close();
    const repo = addRepo(ann.user.id, { url: "acme/while-down", method: "none" });
    server = await startTestServer(opts());
    admin = await signInAs(server.base); // sessions do not survive a restart
    const again = await feed(admin, `?since=${before}`);
    expect(again.body.reset).toBeUndefined();
    expect(again.body.seq).toBeGreaterThanOrEqual(before);
    expect(again.body.changes.map((c) => c.id)).toContain(repo.id);
    // the file holds kinds and ids only
    expect(readFileSync(file, "utf8")).not.toContain("while-down");
    server.close();
    rmSync(file);
    server = await startTestServer(opts());
    admin = await signInAs(server.base);
    expect((await feed(admin, `?since=${before}`)).body.reset).toBe(true);
  });
});
