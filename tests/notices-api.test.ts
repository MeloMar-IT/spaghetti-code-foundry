import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addRepo, removeRepo, setRepoSettings } from "../src/auth/repos.js";
import { addCredential } from "../src/credentials/store.js";
import { refOf, type RaisedNotice } from "../src/notices.js";
import { NoticeLog } from "../src/server/notices.js";
import { fakeKeychain, fakeToken, type FakeKeychain } from "./helpers/keychain.js";
import { startTestServer } from "./helpers/port.js";
import { signInAs, type TestSession } from "./helpers/session.js";

// The notices for programs over HTTP (#871): the long-poll, reset, redaction, access and saving. One server for the file.

type Started = Awaited<ReturnType<typeof startTestServer>>;
type Answer = { seq: number; reset?: boolean; notices: { seq: number; kind: string; at: string; title: string; text: string; key?: string; runId?: string; link?: string }[] };
let tmp: string;
let saved: string | undefined;
let server: Started;
let admin: TestSession;
let ann: TestSession;
let kc: FakeKeychain;
let n = 0;

const raise = (over: Partial<RaisedNotice> = {}): RaisedNotice => {
  n += 1;
  return { kind: "turn", title: "Foundry · your turn", text: `text ${n}`, key: `m-${n}`, runId: `run-${n}`, link: `http://localhost/#/runs/run-${n}`, ref: refOf(`t|${n}`), ...over };
};
const log = () => server.ctx.notices!;
const file = () => join(tmp, "home", "notices.json");
const get = async (who: TestSession, query = "") => {
  const r = await fetch(`${server.base}/api/notices${query}`, { headers: who.headers("GET") });
  return { status: r.status, body: (await r.json()) as Answer };
};
const seqOf = async () => (await get(admin)).body.seq;
const until = async (cond: () => boolean) => {
  while (!cond()) await new Promise((r) => setTimeout(r, 5));
};

beforeAll(async () => {
  kc = fakeKeychain();
  saved = process.env.FACTORY_HOME;
  tmp = mkdtempSync(join(tmpdir(), "notices-api-"));
  process.env.FACTORY_HOME = join(tmp, "home");
  mkdirSync(join(tmp, "repo"));
  server = await startTestServer({ repo: join(tmp, "repo"), runsDir: join(tmp, "runs"), claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, accountSweepMs: 3_600_000 });
  admin = await signInAs(server.base);
  ann = await signInAs(server.base, { name: "Ann", email: "ann@example.com", role: "user" });
});
afterAll(() => {
  server.close();
  kc.remove();
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(tmp, { recursive: true, force: true });
});

describe("GET /api/notices", () => {
  it("answers reset with a seq when since is missing or old, and nothing at the current seq", async () => {
    const first = await get(admin);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ seq: expect.any(Number), reset: true, notices: [] });
    expect((await get(admin, "?since=1")).body.reset).toBe(true);
    expect((await get(admin, `?since=${first.body.seq + 1000}`)).body.reset).toBe(true);
    expect((await get(admin, `?since=${first.body.seq}`)).body).toEqual({ seq: first.body.seq, notices: [] });
  });

  it("refuses a bad wait or since", async () => {
    for (const q of ["?wait=31", "?wait=-1", "?since=x"]) expect((await get(admin, q)).status, q).toBe(400);
  });

  it("answers a recorded notice with its fields, and saves the file as 0600 with no raw key", async () => {
    const since = await seqOf();
    expect(log().record([raise({ key: "m-abc", runId: "r-9", link: "https://f.example.com/#/runs/r-9", text: "hello" })])).toBe(true);
    const a = (await get(admin, `?since=${since}`)).body;
    expect(a.notices).toHaveLength(1);
    expect(a.notices[0]).toMatchObject({ seq: since + 1, kind: "turn", title: "Foundry · your turn", text: "hello", key: "m-abc", runId: "r-9", link: "https://f.example.com/#/runs/r-9" });
    expect(new Date(a.notices[0]!.at).toISOString()).toBe(a.notices[0]!.at);
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    expect(readFileSync(file(), "utf8")).toContain("hello");
  });

  it("holds a long-poll until a notice is recorded, and answers empty when the time is up", async () => {
    const since = await seqOf();
    const held = get(admin, `?since=${since}&wait=10`);
    await until(() => log().waiting() > 0);
    log().record([raise({ text: "woke" })]);
    expect((await held).body.notices.map((x) => x.text)).toEqual(["woke"]);
    expect(log().waiting()).toBe(0);
    const now = await seqOf();
    expect((await get(admin, `?since=${now}&wait=1`)).body).toEqual({ seq: now, notices: [] });
  });

  it("lets go of the waiter when the caller leaves", async () => {
    const ctl = new AbortController();
    const pending = fetch(`${server.base}/api/notices?since=${await seqOf()}&wait=30`, { headers: admin.headers("GET"), signal: ctl.signal }).catch(() => undefined);
    await until(() => log().waiting() > 0);
    ctl.abort();
    await pending;
    await until(() => log().waiting() === 0);
  });

  it("records the same ref once", async () => {
    const since = await seqOf();
    const one = raise();
    log().record([one]);
    log().record([one]);
    expect((await get(admin, `?since=${since}`)).body.notices).toHaveLength(1);
  });
});

describe("redaction", () => {
  it("hides a known secret in title, text and link, in the answer and in the file", async () => {
    const secret = fakeToken("Rd1");
    addCredential({ userId: admin.user.id, type: "token", name: "key", secret });
    const since = await seqOf();
    log().record([raise({ title: `t ${secret}`, text: `x ${secret} y`, link: `https://github.com/acme/app/releases/${secret}`, key: undefined })]);
    const a = (await get(admin, `?since=${since}`)).body.notices[0]!;
    expect(a.title).toBe("t [redacted]");
    expect(a.text).toBe("x [redacted] y");
    expect(a.link).toBe("https://github.com/acme/app/releases/[redacted]");
    const disk = readFileSync(file(), "utf8");
    expect(disk).not.toContain(secret);
    expect(disk).toContain("https://github.com/acme/app/releases/[redacted]");
  });

  it("hides a secret that was registered after the notice was saved", async () => {
    const secret = fakeToken("Late");
    const since = await seqOf();
    log().record([raise({ text: `late ${secret}` })]);
    addCredential({ userId: admin.user.id, type: "token", name: "late", secret });
    expect((await get(admin, `?since=${since}`)).body.notices[0]!.text).toBe("late [redacted]");
  });
});

describe("access", () => {
  const make = async (scope: string[], name: string) => {
    const r = await fetch(`${server.base}/api/service-accounts`, { method: "POST", headers: admin.headers("POST", { "content-type": "application/json" }), body: JSON.stringify({ name, scope }) });
    expect(r.status).toBe(201);
    const b = (await r.json()) as { token: string; account: { id: string } };
    return { token: b.token, id: b.account.id };
  };
  const call = (token: string, query = "") => fetch(`${server.base}/api/notices${query}`, { headers: { authorization: `Bearer ${token}` } });
  const admin_ = (method: string, path: string, body: unknown = {}) => fetch(`${server.base}${path}`, { method, headers: admin.headers(method, { "content-type": "application/json" }), body: JSON.stringify(body) });

  it("is for an admin; a user gets 403", async () => {
    expect((await get(ann)).status).toBe(403);
    expect((await get(admin)).status).toBe(200);
  });

  it("lets a service account in with GET notices or class:inbox, and not with another class", async () => {
    expect((await call((await make(["GET notices"], "R1")).token)).status).toBe(200);
    expect((await call((await make(["class:inbox"], "R2")).token)).status).toBe(200);
    expect((await call((await make(["class:summary"], "R3")).token)).status).toBe(403);
  });

  it("holds a request and checks it again: a revoked token, a removed scope or a closed repository gets no notice", async () => {
    const hold = async (token: string, act: () => Promise<unknown>) => {
      const since = await seqOf();
      const held = call(token, `?since=${since}&wait=10`);
      await until(() => log().waiting() > 0);
      await act();
      log().record([raise({ text: "must not leak" })]);
      const r = await held;
      expect([401, 403]).toContain(r.status);
      expect(await r.text()).not.toContain("must not leak");
    };
    const a = await make(["GET notices"], "H1");
    await hold(a.token, () => admin_("POST", `/api/service-accounts/${a.id}/revoke`));
    const b = await make(["GET notices"], "H2");
    await hold(b.token, () => admin_("PUT", `/api/service-accounts/${b.id}`, { scope: ["GET runs"] }));
    const c = await make(["GET notices"], "H3");
    const repo = addRepo(ann.user.id, { url: "acme/notice-closed", method: "none" });
    await hold(c.token, async () => void setRepoSettings(repo.id, { services: "none" }));
    // the repository stays closed: the service account is refused outright, the admin is not
    expect((await call(c.token)).status).toBe(403);
    expect((await get(admin)).status).toBe(200);
    removeRepo(ann.user.id, repo.id);
  });

  it("holds an admin's request and checks it again: a demoted admin gets 403", async () => {
    const boss = await signInAs(server.base, { name: "Boss", email: "boss@example.com", role: "admin" });
    const since = await seqOf();
    const held = fetch(`${server.base}/api/notices?since=${since}&wait=10`, { headers: boss.headers("GET") });
    await until(() => log().waiting() > 0);
    expect((await admin_("PUT", `/api/users/${boss.user.id}`, { role: "user" })).status).toBe(200);
    log().record([raise({ text: "must not leak" })]);
    const r = await held;
    expect([401, 403]).toContain(r.status);
    expect(await r.text()).not.toContain("must not leak");
  });
});

describe("saving notices.json", () => {
  it("answers false for a failed save, tries again alone, and flushes on stop", async () => {
    const real = server.ctx.notices!;
    const f = file();
    rmSync(f, { force: true });
    mkdirSync(f); // a directory in the file's place: the write fails
    const l = new NoticeLog({ retryMs: 20 });
    server.ctx.notices = l;
    try {
      expect(l.record([raise({ text: "kept in memory" })])).toBe(false);
      rmSync(f, { recursive: true });
      await until(() => existsSync(f)); // the retry timer writes it
      expect(readFileSync(f, "utf8")).toContain("kept in memory");

      rmSync(f, { force: true });
      mkdirSync(f);
      expect(l.record([raise({ text: "flushed" })])).toBe(false);
      rmSync(f, { recursive: true });
      l.stop();
      expect(readFileSync(f, "utf8")).toContain("flushed");
    } finally {
      server.ctx.notices = real;
    }
  });

  it("prunes on a read too, so an idle server stops answering a notice older than 7 days", () => {
    const real = server.ctx.notices!;
    let t = Date.now();
    const l = new NoticeLog({ now: () => t });
    l.start();
    const before = l.answer(undefined).seq;
    l.record([raise({ text: "idle" })]);
    expect(l.answer(before).notices).toHaveLength(1);
    t += 8 * 86_400_000; // no new notice is recorded
    expect(l.answer(before)).toMatchObject({ reset: true, notices: [] });
    expect(readFileSync(file(), "utf8")).not.toContain("idle");
    l.stop();
    server.ctx.notices = real;
  });

  it("answers reset when a notice was pruned after the cursor, and refuses a wait after stop", async () => {
    const real = server.ctx.notices!;
    let t = Date.now();
    const l = new NoticeLog({ now: () => t });
    l.start();
    server.ctx.notices = l;
    try {
      l.record([raise({ text: "old" })]);
      const since = l.answer(0).seq - 1;
      expect(l.answer(since).reset).toBeUndefined();
      t += 8 * 86_400_000;
      l.record([raise({ text: "new" })]);
      expect((await get(admin, `?since=${since}`)).body).toMatchObject({ reset: true, notices: [] });
      const ctl = new AbortController();
      l.stop();
      const t0 = Date.now();
      await l.wait(10_000, ctl.signal);
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(l.waiting()).toBe(0);
    } finally {
      server.ctx.notices = real;
    }
  });
});
