import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditPath } from "../src/auth/audit.js";
import { createServiceAccount } from "../src/auth/service-accounts.js";
import { getUser } from "../src/auth/users.js";
import { startTestServer } from "./helpers/port.js";
import { signInAs, type TestSession } from "./helpers/session.js";

let home: string;
let saved: string | undefined;
let base: string;
let close: () => void;
let admin: TestSession;
let ann: TestSession;

beforeAll(async () => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "sharing-api-"));
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

const PATH = "/api/account/metrics-sharing";
const call = async (who: TestSession, method: string, path: string, body?: unknown, version?: string) => {
  const r = await fetch(base + path, {
    method,
    headers: who.headers(method, { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(version ? { "x-config-version": version } : {}) }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, any>, version: r.headers.get("x-config-version") ?? undefined };
};
const sharingLines = () =>
  (existsSync(auditPath()) ? readFileSync(auditPath(), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [])
    .filter((e) => e.action === "settings-change");
const setAllowed = async (allowed: boolean) => {
  const cfg = await call(admin, "GET", "/api/config");
  const r = await call(admin, "PUT", "/api/config", { ...cfg.json, metrics_sharing: { allowed } }, cfg.version);
  expect(r.status).toBe(200);
};

describe("/api/account/metrics-sharing", () => {
  it("answers unasked by default, for a user and an admin", async () => {
    expect((await call(ann, "GET", PATH)).json).toEqual({ allowed: true, answer: "unasked", changed: null });
    expect((await call(admin, "GET", PATH)).json).toEqual({ allowed: true, answer: "unasked", changed: null });
  });

  it("refuses any body but yes or no", async () => {
    for (const body of [{}, { answer: "unasked" }, { answer: true }, { answer: "YES" }]) expect((await call(ann, "PUT", PATH, body)).status).toBe(400);
    expect(getUser(ann.user.id)!.metricsSharing).toBeUndefined();
  });

  it("stores the own answer, writes one audit line per change and none for the same answer", async () => {
    const before = sharingLines().length;
    const yes = await call(ann, "PUT", PATH, { answer: "yes" });
    expect(yes).toMatchObject({ status: 200, json: { allowed: true, answer: "yes" } });
    expect(Date.parse(yes.json.changed)).not.toBeNaN();
    expect((await call(ann, "GET", PATH)).json).toEqual(yes.json);
    expect((await call(ann, "PUT", PATH, { answer: "yes" })).json).toEqual(yes.json);
    expect((await call(ann, "PUT", PATH, { answer: "no" })).json.answer).toBe("no");
    const lines = sharingLines().slice(before);
    expect(lines.map(({ by, target, detail }) => ({ by, target, detail }))).toEqual([
      { by: ann.user.id, target: "metrics-sharing", detail: "unasked -> yes" },
      { by: ann.user.id, target: "metrics-sharing", detail: "yes -> no" },
    ]);
  });

  it("an admin changes only its own answer and cannot reach another account's", async () => {
    const annBefore = getUser(ann.user.id)!.metricsSharing;
    expect((await call(admin, "PUT", PATH, { answer: "yes" })).json.answer).toBe("yes");
    expect(getUser(ann.user.id)!.metricsSharing).toEqual(annBefore);
    expect((await call(admin, "PUT", `${PATH}/${ann.user.id}`, { answer: "yes" })).status).toBe(404);
    expect((await call(admin, "POST", "/api/admin/view-as", { userId: ann.user.id })).status).toBe(200);
    try {
      expect((await call(admin, "GET", `${PATH}?as=${ann.user.id}`)).status).toBe(403);
      expect((await call(admin, "PUT", `${PATH}?as=${ann.user.id}`, { answer: "yes" })).status).toBe(403);
    } finally {
      await call(admin, "DELETE", "/api/admin/view-as");
    }
    expect(getUser(ann.user.id)!.metricsSharing).toEqual(annBefore);
  });

  it("follows the admin switch: off keeps the answers, refuses a change and is audited; on brings them back", async () => {
    const before = sharingLines().length;
    await setAllowed(false);
    const off = await call(ann, "GET", PATH);
    expect(off.json).toMatchObject({ allowed: false, answer: "no" });
    expect((await call(ann, "PUT", PATH, { answer: "yes" })).status).toBe(409);
    expect(getUser(ann.user.id)!.metricsSharing?.answer).toBe("no");
    await setAllowed(true);
    expect((await call(ann, "GET", PATH)).json).toEqual({ ...off.json, allowed: true });
    const lines = sharingLines().slice(before).filter((e) => e.target === "config.yaml").map((e) => e.detail);
    expect(lines).toEqual(["metrics_sharing.allowed: true -> false", "metrics_sharing.allowed: false -> true"]);
  });

  it("does not change config.yaml when the audit log cannot be written, for Save and Reset", async () => {
    const cfg = await call(admin, "GET", "/api/config");
    const path = join(home, "config.yaml");
    const text = existsSync(path) ? readFileSync(path, "utf8") : "";
    const log = auditPath();
    const kept = readFileSync(log);
    rmSync(log);
    mkdirSync(log); // a folder: the log cannot be opened
    try {
      const r = await call(admin, "PUT", "/api/config", { ...cfg.json, metrics_sharing: { allowed: false } }, cfg.version);
      expect(r.status).toBe(500);
      expect(existsSync(path) ? readFileSync(path, "utf8") : "").toBe(text);
      // Reset of a stored false: the change to the default must be audited too
      writeFileSync(path, `${text}\nmetrics_sharing:\n  allowed: false\n`);
      const stored = readFileSync(path, "utf8");
      const reset = await call(admin, "POST", "/api/settings/reset", { key: "metrics_sharing.allowed" });
      expect(reset.status).toBe(500);
      expect(readFileSync(path, "utf8")).toBe(stored);
    } finally {
      rmSync(log, { recursive: true, force: true });
      writeFileSync(log, kept);
    }
    const reset = await call(admin, "POST", "/api/settings/reset", { key: "metrics_sharing.allowed" });
    expect(reset).toMatchObject({ status: 200, json: { removed: true } });
    expect(sharingLines().at(-1)).toMatchObject({ by: admin.user.id, target: "config.yaml", detail: "metrics_sharing.allowed: false -> true" });
    expect((await call(ann, "GET", PATH)).json.allowed).toBe(true);
  });

  it("is never in the scope of a service account, and a service gets 403", async () => {
    expect(() => createServiceAccount({ name: "Bad", scope: ["GET account/metrics-sharing"] })).toThrow();
    expect(() => createServiceAccount({ name: "Bad", scope: ["GET account/metrics-sharing/preview"] })).toThrow();
    const { token } = createServiceAccount({ name: "Robot", scope: ["GET runs"] });
    const r = await fetch(base + PATH, { headers: { authorization: `Bearer ${token}` } });
    expect(r.status).toBe(403);
  });
});

describe("/api/account/metrics-sharing/preview (#888)", () => {
  const PREVIEW = "/api/account/metrics-sharing/preview";
  let n = 0;
  /** A finished run of `owner` today (UTC), in the server's runs folder. */
  const runOf = (owner: string) => {
    const runId = `share-run-${++n}`;
    const runDir = join(home, "runs", runId);
    const day = new Date().toISOString().slice(0, 10);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "run.json"), JSON.stringify({
      runId, flow: "issue-gitflow", flowDef: { steps: [] }, task: "secret task text", vars: {}, repo: "", status: "succeeded", runDir,
      startedAt: `${day}T00:00:00.100Z`, finishedAt: `${day}T00:00:00.200Z`, totalCostUsd: 0, history: [], state: { next: null, steps: {}, visits: {} }, owner,
    }));
  };
  const succeeded = (j: Record<string, any>) => j.next.report.changes.runsEnded.succeeded as number;

  it("a user sees only their own runs, an admin the runs of the accounts that said yes", async () => {
    const bob = await signInAs(base, { name: "Bob", email: "bob@example.com", role: "user" });
    const cid = await signInAs(base, { name: "Cid", email: "cid@example.com", role: "user" });
    expect((await call(ann, "PUT", PATH, { answer: "yes" })).status).toBe(200);
    expect((await call(bob, "PUT", PATH, { answer: "yes" })).status).toBe(200);
    expect((await call(cid, "PUT", PATH, { answer: "no" })).status).toBe(200);
    expect((await call(admin, "PUT", PATH, { answer: "no" })).status).toBe(200);
    runOf(ann.user.id);
    runOf(ann.user.id);
    runOf(bob.user.id);
    runOf(cid.user.id);
    runOf(admin.user.id);

    const a = await call(ann, "GET", PREVIEW);
    expect(a.status).toBe(200);
    expect(a.json).toMatchObject({ scope: "own", allowed: true, answer: "yes", last: null, lastUnreadable: false, next: { sofar: true } });
    expect(a.json.next.report.accountsSharing).toBe(1);
    expect(succeeded(a.json)).toBe(2);
    expect(succeeded((await call(bob, "GET", PREVIEW)).json)).toBe(1);
    expect(succeeded((await call(cid, "GET", PREVIEW)).json)).toBe(1);

    const all = await call(admin, "GET", PREVIEW);
    expect(all.json.scope).toBe("install");
    expect(all.json.next.report.accountsSharing).toBe(2);
    expect(succeeded(all.json)).toBe(3);
    expect(all.json.next.report.install).toBe("0".repeat(32));
    expect(JSON.stringify(all.json)).not.toContain("secret task text");
  });

  it("refuses an admin's preview of another account, and has no other method", async () => {
    expect((await call(admin, "POST", "/api/admin/view-as", { userId: ann.user.id })).status).toBe(200);
    try {
      expect((await call(admin, "GET", `${PREVIEW}?as=${ann.user.id}`)).status).toBe(403);
    } finally {
      await call(admin, "DELETE", "/api/admin/view-as");
    }
    expect((await call(ann, "POST", PREVIEW, {})).status).toBe(404);
  });
});
