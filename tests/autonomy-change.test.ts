import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashPassword, type User } from "../src/auth/users.js";
import { AUTONOMY_LEVELS, type AutonomyLevel } from "../src/governance/autonomy.js";
import { accountableOwner, activeAdmins, approvalVerdict, checkReason } from "../src/governance/autonomy-change.js";
import { AutonomyError, readAutonomy, setLevel } from "../src/governance/autonomy-store.js";
import type { PromotionGate } from "../src/governance/gate.js";
import { approveAutonomy, demoteAutonomy, promoteAutonomy, type GateOf } from "../src/server/api-autonomy.js";
import { HttpError } from "../src/server/http.js";
import type { ApiContext } from "../src/server/server.js";

// Unit tests: a temporary data folder, users written by the test, a fake gate. No server, no git, no child process.

let hash: string;
let home: string;
let saved: string | undefined;
let configured: string | undefined;
let logs: string[];
let users: User[];
let A: User;
let B: User;
let C: User;

beforeAll(async () => {
  hash = await hashPassword("test-password-12345");
});

const mk = (name: string, role: User["role"], created: string, over: Partial<User> = {}): User => ({
  id: randomUUID(),
  name,
  email: `${name.toLowerCase()}@example.com`,
  role,
  status: "active",
  passwordHash: hash,
  created,
  lastSignIn: null,
  ...over,
});
const saveUsers = (list: User[]) => {
  users = list;
  writeFileSync(join(home, "users.json"), JSON.stringify({ version: 1, users: list }));
};
const ctx = () => ({ config: () => ({ governance: { owner: configured } }), diagLog: (m: string) => logs.push(m), opts: { repo: home } }) as unknown as ApiContext;

const PASS: PromotionGate = { passed: true, checks: [] };
const FAIL: PromotionGate = { passed: false, checks: [{ id: "evidence_completeness", label: "x", passed: false, value: 0, threshold: 1, detail: "d" }] };
const pass: GateOf = async () => PASS;
const fail: GateOf = async () => FAIL;
const never: GateOf = async () => {
  throw new Error("the gate must not run");
};
const deferred = () => {
  let release!: (g: PromotionGate) => void;
  const promise = new Promise<PromotionGate>((r) => (release = r));
  return { gate: (async () => promise) as GateOf, release };
};

const F = "f1";
const level = (): AutonomyLevel => readAutonomy().flows[F]?.level ?? "delivery-handoff";
const at = (l: AutonomyLevel) => setLevel("flows", F, l, A.id);
const body = (over: Record<string, unknown> = {}) => ({ kind: "flows", id: F, to: "plan-only", reason: "ready", ...over });
const audit = (): { action: string; result: string; by: string; target?: string; detail?: string }[] => {
  try {
    return readFileSync(join(home, "audit.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.action.startsWith("autonomy"));
  } catch {
    return [];
  }
};
const reject = async (p: Promise<unknown>): Promise<HttpError> => {
  try {
    await p;
  } catch (e) {
    return e as HttpError;
  }
  throw new Error("did not reject");
};
/** A request from `who` for the next level; returns its token. */
const ask = async (who: User, to = "plan-only") => ((await promoteAutonomy(ctx(), who, body({ to }), pass)).request.token);
const approve = (who: User, token: string, to = "plan-only", gate: GateOf = pass) => approveAutonomy(ctx(), who, { kind: "flows", id: F, to, token }, gate);

beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "autonomy-change-"));
  process.env.FACTORY_HOME = home;
  configured = undefined;
  logs = [];
  A = mk("Ann", "admin", "2026-01-01T00:00:00.000Z");
  B = mk("Bob", "admin", "2026-01-02T00:00:00.000Z");
  C = mk("Cy", "admin", "2026-01-03T00:00:00.000Z");
  saveUsers([A, B, C]);
  at("observe");
});
afterEach(() => {
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});
afterAll(() => undefined);

describe("accountableOwner", () => {
  const list = () => [mk("A", "admin", "2026-01-01T00:00:00.000Z"), mk("B", "admin", "2026-01-02T00:00:00.000Z"), mk("U", "user", "2025-01-01T00:00:00.000Z")];
  it("is the first active admin when none is set, and the configured one when it is an active admin", () => {
    const [a, b] = list();
    expect(accountableOwner(undefined, list())).toMatchObject({ source: "first-admin" });
    expect(accountableOwner(undefined, [b!, a!])).toEqual({ id: a!.id, source: "first-admin" });
    expect(accountableOwner(b!.id, [a!, b!])).toEqual({ id: b!.id, source: "config" });
  });
  it("falls back to the first active admin, with a problem, for a blocked, non-admin, unknown or password-less owner", () => {
    const [a, b, u] = list();
    const blocked = { ...b!, status: "blocked" as const };
    const { passwordHash: _h, ...noPassword } = b!;
    for (const [id, users] of [[b!.id, [a!, blocked]], [u!.id, [a!, b!, u!]], [randomUUID(), [a!, b!]], [b!.id, [a!, noPassword as User]]] as const) {
      expect(accountableOwner(id, users)).toEqual({ id: a!.id, source: "first-admin", problem: "the configured owner is not an active admin" });
    }
  });
  it("skips a blocked first admin, so the owner can always sign in, and is undefined with no active admin", () => {
    const [a, b] = list();
    expect(accountableOwner(undefined, [{ ...a!, status: "blocked" }, b!])?.id).toBe(b!.id);
    expect(accountableOwner(undefined, [{ ...a!, status: "blocked" }])).toBeUndefined();
    expect(activeAdmins([a!, b!]).map((x) => x.id)).toEqual([a!.id, b!.id]);
  });
});

describe("approvalVerdict", () => {
  const [o, x, r] = ["owner", "other", "req"];
  const v = (approver: string, requester: string, to: AutonomyLevel, admins: number) => approvalVerdict({ approver, requester, owner: o!, to, admins });
  it("follows the table", () => {
    expect(v(o!, r!, "guarded-write", 2)).toEqual({ ok: true, selfApproved: false, instead: false });
    expect(v(o!, o!, "plan-only", 3)).toEqual({ ok: true, selfApproved: true, instead: false });
    expect(v(o!, o!, "guarded-write", 1)).toEqual({ ok: true, selfApproved: true, instead: false });
    expect(v(o!, o!, "guarded-write", 2)).toEqual({ ok: false, code: "same-person" });
    expect(v(o!, o!, "delivery-handoff", 2)).toEqual({ ok: false, code: "same-person" });
    expect(v(x!, o!, "guarded-write", 2)).toEqual({ ok: true, selfApproved: false, instead: true });
    expect(v(x!, r!, "plan-only", 2)).toEqual({ ok: false, code: "not-owner" });
    expect(v(r!, r!, "plan-only", 2)).toEqual({ ok: false, code: "not-owner" });
  });
});

describe("checkReason", () => {
  it("accepts a plain reason, trimmed", () => expect(checkReason("  ready  ")).toBe("ready"));
  it("refuses a bad reason without quoting it", () => {
    const secret = ["github", "pat", ""].join("_") + "Zx9".repeat(20);
    for (const bad of [undefined, 5, "", "   ", "x".repeat(201), "a\nb", "a\u0085b", `token ${secret}`]) {
      let msg = "";
      try {
        checkReason(bad);
      } catch (e) {
        expect(e).toBeInstanceOf(AutonomyError);
        msg = (e as Error).message;
      }
      expect(msg, String(bad)).not.toBe("");
      expect(msg).not.toContain(secret);
      expect(msg).not.toContain("xxxx");
    }
  });
});

describe("promote", () => {
  it("refuses two levels up, the top level and a second request, and changes nothing", async () => {
    const before = readFileSync(join(home, "autonomy.json"), "utf8");
    expect((await reject(promoteAutonomy(ctx(), A, body({ to: "guarded-write" }), pass))).status).toBe(409);
    expect((await reject(promoteAutonomy(ctx(), A, body({ to: "observe" }), pass))).status).toBe(409);
    expect(readFileSync(join(home, "autonomy.json"), "utf8")).toBe(before);
    await ask(A);
    expect((await reject(promoteAutonomy(ctx(), A, body(), pass))).message).toMatch(/waiting already/);
    at("delivery-handoff");
    expect((await reject(promoteAutonomy(ctx(), A, body({ to: "delivery-handoff" }), pass))).message).toMatch(/top level/);
  });

  it("answers 409 with the gate, stores nothing and writes a failed line when the gate fails", async () => {
    const e = await reject(promoteAutonomy(ctx(), A, body(), fail));
    expect(e.status).toBe(409);
    expect(e.extra?.gate).toEqual(FAIL);
    expect(readAutonomy().requests).toBeUndefined();
    expect(audit()).toEqual([expect.objectContaining({ action: "autonomy-promote-request", result: "failed", by: A.id, target: `flows:${F}`, detail: "observe→plan-only refused: evidence_completeness" })]);
  });

  it("stores a request with a token and writes the audit line", async () => {
    const r = await promoteAutonomy(ctx(), A, body({ reason: "  looks good " }), pass);
    expect(r.request).toMatchObject({ from: "observe", to: "plan-only", reason: "looks good", by: A.id, state: "pending" });
    expect(readAutonomy().requests!.flows[F]).toEqual(r.request);
    expect(r.owner).toMatchObject({ id: A.id });
    expect(audit()).toEqual([expect.objectContaining({ action: "autonomy-promote-request", result: "ok", detail: "observe→plan-only reason: looks good" })]);
  });

  it("replaces an expired request with a new token", async () => {
    const t1 = await ask(B);
    at("plan-only");
    expect((await reject(approve(A, t1))).status).toBe(409); // expires
    at("observe");
    const t2 = await ask(B);
    expect(t2).not.toBe(t1);
    expect(readAutonomy().requests!.flows[F]!.state).toBe("pending");
  });

  it("refuses a bad reason with 400, an unknown flow with 404 and a bad kind with 400", async () => {
    for (const reason of [undefined, "", "x".repeat(201), "a\nb"]) expect((await reject(promoteAutonomy(ctx(), A, body({ reason }), pass))).status).toBe(400);
    expect((await reject(promoteAutonomy(ctx(), A, body({ id: "nope" }), pass))).status).toBe(404);
    expect((await reject(promoteAutonomy(ctx(), A, body({ kind: "x" }), pass))).status).toBe(400);
    expect((await reject(promoteAutonomy(ctx(), A, body({ to: "root" }), pass))).status).toBe(400);
    expect(readAutonomy().requests).toBeUndefined();
  });

  it("refuses a request whose admin is blocked while the gate runs, and stores nothing", async () => {
    const d = deferred();
    const p = reject(promoteAutonomy(ctx(), B, body(), d.gate));
    saveUsers([A, { ...B, status: "blocked" }, C]);
    d.release(PASS);
    expect((await p).status).toBe(403);
    expect(readAutonomy().requests).toBeUndefined();
    expect(audit().at(-1)).toMatchObject({ action: "autonomy-promote-request", result: "failed", by: B.id, detail: "refused: not-admin" });
  });

  it("refuses a request whose admin is demoted to user while the gate runs, and stores nothing", async () => {
    const d = deferred();
    const p = reject(promoteAutonomy(ctx(), B, body(), d.gate));
    saveUsers([A, { ...B, role: "user" }, C]);
    d.release(PASS);
    expect((await p).status).toBe(403);
    expect(readAutonomy().requests).toBeUndefined();
  });

  it("lets only one of two requests at the lock win", async () => {
    const [a, b] = await Promise.allSettled([promoteAutonomy(ctx(), A, body(), pass), promoteAutonomy(ctx(), B, body(), pass)]);
    expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
    expect(audit().filter((e) => e.result === "ok")).toHaveLength(1);
  });
});

describe("approve", () => {
  it("lets the owner approve another admin's request: the level changes, the request goes, the line is written", async () => {
    const token = await ask(B);
    const r = await approve(A, token);
    expect(r).toMatchObject({ kind: "flows", id: F, from: "observe", to: "plan-only", level: "plan-only", requester: B.id, approver: A.id, selfApproved: false });
    const store = readAutonomy();
    expect(store.flows[F]).toMatchObject({ level: "plan-only", by: A.id, reason: "ready" });
    expect(store.requests).toBeUndefined();
    expect(audit().at(-1)).toMatchObject({ action: "autonomy-promote", result: "ok", by: A.id, detail: `observe→plan-only requester:${B.id} reason: ready` });
    expect((await reject(approve(A, token))).status).toBe(409); // repeat
  });

  it("answers 409 for a wrong token or level and changes nothing", async () => {
    const token = await ask(B);
    expect((await reject(approve(A, randomUUID()))).message).toMatch(/changed/);
    expect((await reject(approve(A, token, "guarded-write"))).status).toBe(409);
    expect((await reject(approve(A, "x"))).status).toBe(409);
    expect(level()).toBe("observe");
    expect(readAutonomy().requests!.flows[F]!.state).toBe("pending");
  });

  it("refuses an admin who is not the owner with 403 and a failed line, and the request stays", async () => {
    const token = await ask(B);
    const e = await reject(approve(C, token, "plan-only", never));
    expect(e.status).toBe(403);
    expect(readAutonomy().requests!.flows[F]!.state).toBe("pending");
    expect(audit().at(-1)).toMatchObject({ result: "failed", by: C.id, detail: "observe→plan-only refused: not-owner" });
  });

  it("needs a second admin for a move to guarded-write when the owner asked", async () => {
    at("plan-only");
    const token = await ask(A, "guarded-write");
    const e = await reject(approve(A, token, "guarded-write", never));
    expect(e.status).toBe(403);
    expect(audit().at(-1)).toMatchObject({ result: "failed", detail: "plan-only→guarded-write refused: same-person" });
    const r = await approve(B, token, "guarded-write");
    expect(r).toMatchObject({ level: "guarded-write", approver: B.id, requester: A.id, selfApproved: false });
    expect(audit().at(-1)?.detail).toContain("second-admin");
  });

  it("lets the owner approve their own move to plan-only, marked self-approved", async () => {
    const token = await ask(A);
    expect((await approve(A, token)).selfApproved).toBe(true);
    expect(audit().at(-1)?.detail).toContain("self-approved");
  });

  it("allows self-approval with one active admin, for a sensitive level too", async () => {
    saveUsers([A, { ...B, status: "blocked" }, { ...C, role: "user" }]);
    at("plan-only");
    const token = await ask(A, "guarded-write");
    const r = await approve(A, token, "guarded-write");
    expect(r.selfApproved).toBe(true);
    expect(audit().at(-1)?.detail).toBe(`plan-only→guarded-write requester:${A.id} self-approved reason: ready`);
  });

  it("marks owner-fallback when the configured owner is gone", async () => {
    configured = randomUUID();
    const token = await ask(B);
    await approve(A, token);
    expect(audit().at(-1)?.detail).toContain("owner-fallback");
    expect(logs.some((l) => l.includes("configured owner"))).toBe(true);
  });

  it("uses the configured owner", async () => {
    configured = B.id;
    const token = await ask(A);
    expect((await reject(approve(A, token, "plan-only", never))).status).toBe(403);
    expect((await approve(B, token)).approver).toBe(B.id);
  });

  it("expires a request when the gate fails at approval, and then answers 409", async () => {
    const token = await ask(B);
    const e = await reject(approve(A, token, "plan-only", fail));
    expect(e.status).toBe(409);
    expect(e.extra?.gate).toEqual(FAIL);
    expect(readAutonomy().requests!.flows[F]!.state).toBe("expired");
    expect(level()).toBe("observe");
    expect(audit().at(-1)).toMatchObject({ result: "failed", detail: "observe→plan-only expired: gate-failed" });
    expect((await reject(approve(A, token))).status).toBe(409);
  });

  it("expires a request when the level changed, but not for a person who may not approve", async () => {
    const token = await ask(B);
    at("plan-only");
    expect((await reject(approve(C, token, "plan-only", never))).status).toBe(403);
    expect(readAutonomy().requests!.flows[F]!.state).toBe("pending");
    const e = await reject(approve(A, token, "plan-only", never));
    expect(e.status).toBe(409);
    expect(readAutonomy().requests!.flows[F]!.state).toBe("expired");
    expect(audit().at(-1)?.detail).toBe("observe→plan-only expired: level-changed");
    expect(level()).toBe("plan-only");
  });

  it("does not approve a replaced request with the old token while the gate runs", async () => {
    const t1 = await ask(B);
    const d = deferred();
    const p = reject(approve(A, t1, "plan-only", d.gate));
    // while the gate runs: the level moves up, the request expires, the level goes down and a new request is made
    at("plan-only");
    expect((await reject(approve(A, t1, "plan-only", never))).status).toBe(409);
    await demoteAutonomy(ctx(), A, body({ to: "observe" }));
    const t2 = await ask(B);
    d.release(PASS);
    expect((await p).message).toMatch(/changed/);
    expect(readAutonomy().requests!.flows[F]).toMatchObject({ token: t2, state: "pending" });
    expect(level()).toBe("observe");
  });

  it("refuses an approver who is blocked or no longer an admin while the gate runs", async () => {
    const t1 = await ask(B);
    const d = deferred();
    const p = reject(approve(A, t1, "plan-only", d.gate));
    saveUsers([{ ...A, role: "user" }, B, C]);
    d.release(PASS);
    expect((await p).status).toBe(403);
    expect(level()).toBe("observe");
    expect(audit().at(-1)).toMatchObject({ result: "failed", detail: "observe→plan-only refused: not-admin" });
  });

  it("refuses a blocked second admin under the owner-requester exception", async () => {
    at("plan-only");
    const t1 = await ask(A, "guarded-write");
    const d = deferred();
    const p = reject(approve(B, t1, "guarded-write", d.gate));
    saveUsers([A, { ...B, status: "blocked" }, C]);
    d.release(PASS);
    expect((await p).status).toBe(403);
    expect(level()).toBe("plan-only");
  });
});

describe("demote", () => {
  it("lowers a level at once for any admin, with no gate, and writes the line", async () => {
    at("guarded-write");
    const r = await demoteAutonomy(ctx(), C, body({ to: "observe", reason: "incident" }));
    expect(r).toMatchObject({ from: "guarded-write", to: "observe", level: "observe" });
    expect(level()).toBe("observe");
    expect(audit().at(-1)).toMatchObject({ action: "autonomy-demote", result: "ok", by: C.id, target: `flows:${F}`, detail: "guarded-write→observe reason: incident" });
  });

  it("refuses the same or a higher level, and a bad reason", async () => {
    for (const to of ["observe", "plan-only"] as const) expect((await reject(demoteAutonomy(ctx(), A, body({ to })))).status).toBe(409);
    at("plan-only");
    expect((await reject(demoteAutonomy(ctx(), A, body({ to: "observe", reason: "" })))).status).toBe(400);
  });

  it("goes up again only through the same steps", async () => {
    at("guarded-write");
    await demoteAutonomy(ctx(), B, body({ to: "plan-only" }));
    const token = await ask(B, "guarded-write");
    expect(level()).toBe("plan-only");
    expect((await approve(A, token, "guarded-write")).level).toBe("guarded-write");
  });

  it("refuses a demotion by an admin who was blocked after the request was authenticated (the body read is in between)", async () => {
    at("guarded-write");
    // the handler gets the account as it was when the request was signed in; it is blocked before the change is committed
    saveUsers([A, { ...B, status: "blocked" }, C]);
    const e = await reject(demoteAutonomy(ctx(), B, body({ to: "observe" })));
    expect(e.status).toBe(403);
    expect(level()).toBe("guarded-write");
    expect(audit().at(-1)).toMatchObject({ action: "autonomy-demote", result: "failed", by: B.id, detail: "refused: not-admin" });
  });

  it("refuses a demotion by an admin who was demoted to user after the request was authenticated", async () => {
    at("guarded-write");
    saveUsers([A, { ...B, role: "user" }, C]);
    expect((await reject(demoteAutonomy(ctx(), B, body({ to: "observe" })))).status).toBe(403);
    expect(level()).toBe("guarded-write");
  });

  it("can demote from the top level one step", async () => {
    at("delivery-handoff");
    const r = await demoteAutonomy(ctx(), A, body({ to: "guarded-write" }));
    expect(AUTONOMY_LEVELS.indexOf(r.level)).toBe(2);
  });
});

describe("audit", () => {
  it("stops a change when the audit log cannot be opened, and the answer holds no path", async () => {
    at("guarded-write");
    mkdirSync(join(home, "audit.jsonl"));
    const before = readFileSync(join(home, "autonomy.json"), "utf8");
    const e = await reject(demoteAutonomy(ctx(), A, body({ to: "observe" })));
    expect(e.status).toBe(500);
    expect(e.message).not.toContain(home);
    expect(readFileSync(join(home, "autonomy.json"), "utf8")).toBe(before);
    expect(logs.join("\n")).not.toContain(home);
  });
});
