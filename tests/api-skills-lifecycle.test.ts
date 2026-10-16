import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearSkillRegistryCache } from "../src/skills/registry.js";
import { RunSkillLockSchema, writeRunSkillLock } from "../src/skills/run-lock.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { startTestServer } from "./helpers/port.js";
import { signInAs, type TestSession } from "./helpers/session.js";

// The admin routes under /api/skills/lifecycle, against a server with one installed skill and one run that locks it.

const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
const K = "kafka@1.0.0";

describe("skill lifecycle routes", () => {
  const savedHome = process.env.FACTORY_HOME;
  let kc: FakeKeychain;
  beforeAll(() => void (kc = fakeKeychain()));
  afterAll(() => {
    kc.remove();
    if (savedHome === undefined) delete process.env.FACTORY_HOME;
    else process.env.FACTORY_HOME = savedHome;
  });

  async function boot() {
    const tmp = mkdtempSync(join(tmpdir(), "api-lifecycle-"));
    const repo = join(tmp, "repo");
    mkdirSync(repo);
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: repo, stdio: "ignore" });
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "init");
    const home = join(tmp, "home");
    process.env.FACTORY_HOME = home;
    const dir = join(home, "skills", "kafka");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: kafka\ndescription: A test skill called kafka.\n---\n\nDo it.\n");
    writeFileSync(join(dir, "skill.yaml"), "id: kafka\nversion: 1.0.0\n");
    writeFileSync(join(home, "config.yaml"), "skills:\n  releases:\n    allow_unreleased: true\n");
    const runsDir = join(tmp, "runs");
    const runDir = join(runsDir, "run-a");
    mkdirSync(runDir, { recursive: true });
    writeRunSkillLock(runDir, RunSkillLockSchema.parse({
      version: 1, runId: "run-a", createdAt: "2026-01-01T00:00:00.000Z", planHash: `sha256:${"c".repeat(64)}`, estimatedTokens: 1,
      skills: [{ id: "kafka", version: "1.0.0", digest: `sha256:${"a".repeat(64)}`, source: "admin", role: "coder", selection: "requested", requiredBy: [], estimatedTokens: 1 }],
    }));
    const s = await startTestServer({ repo, runsDir, claudeBin, watchers: false, accountSweepMs: 3_600_000 });
    const admin = await signInAs(s.base);
    const call = async (who: TestSession, method: string, path: string, body?: unknown) => {
      const r = await fetch(s.base + path, {
        method,
        headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...who.headers(method) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      return { status: r.status, text, json: () => JSON.parse(text) };
    };
    return { s, admin, call, home, close: () => { s.close(); clearSkillRegistryCache(); rmSync(tmp, { recursive: true, force: true }); } };
  }

  it("sets a state as the admin, lists the locked runs, and shows it in the list", async () => {
    const t = await boot();
    try {
      const r = await t.call(t.admin, "POST", "/api/skills/lifecycle", { key: K, state: "quarantined", reason: "found a bug" });
      expect(r.status, r.text).toBe(200);
      const body = r.json();
      expect(body.transition).toMatchObject({ seq: 1, key: K, from: "active", to: "quarantined", by: t.admin.user.id });
      expect(body.lockedRuns).toEqual([{ runId: "run-a", effect: expect.stringContaining("allow-run") }]);
      const stored = readFileSync(join(t.home, "skill-lifecycle.jsonl"), "utf8").trim().split("\n");
      expect(stored).toHaveLength(1);
      expect(JSON.parse(stored[0]!).by).toBe(t.admin.user.id);

      const list = (await t.call(t.admin, "GET", "/api/skills/lifecycle")).json();
      expect(list.states).toEqual([expect.objectContaining({ key: K, state: "quarantined", allowedRuns: [] })]);
      expect(list.problem).toBeUndefined();
    } finally {
      t.close();
    }
  });

  it("answers a bad body with 400 and issues, an unknown key with 404, and a change from revoked with 409", async () => {
    const t = await boot();
    try {
      const bad = await t.call(t.admin, "POST", "/api/skills/lifecycle", { key: K, state: "retired", extra: 1 });
      expect(bad.status).toBe(400);
      expect(bad.json().issues.length).toBeGreaterThan(0);
      expect((await t.call(t.admin, "POST", "/api/skills/lifecycle", { key: K, state: "gone", reason: "x" })).status).toBe(400);
      expect((await t.call(t.admin, "POST", "/api/skills/lifecycle", { key: "nope@1.0.0", state: "retired", reason: "x" })).status).toBe(404);
      expect((await t.call(t.admin, "POST", "/api/skills/lifecycle", { key: K, state: "revoked", reason: "x" })).status).toBe(200);
      expect((await t.call(t.admin, "POST", "/api/skills/lifecycle", { key: K, state: "active", reason: "x" })).status).toBe(409);
      expect((await t.call(t.admin, "POST", "/api/skills/lifecycle/allow-run", { runId: "run-a", key: K, reason: "x" })).status).toBe(409);
    } finally {
      t.close();
    }
  });

  it("validates every field in the body before it looks at the registry, with issues", async () => {
    const t = await boot();
    try {
      const T = "/api/skills/lifecycle";
      const A = "/api/skills/lifecycle/allow-run";
      const bads: [string, unknown][] = [
        [T, { key: "nokey", state: "retired", reason: "x" }],
        [T, { key: "nope@1.0.0", state: "gone", reason: "x" }],
        [T, { key: "nope@1.0.0", state: "retired", reason: "" }],
        [T, { key: "nope@1.0.0", state: "retired", reason: " padded" }],
        [T, { key: "nope@1.0.0", state: "retired", reason: "x", replacement: "bad" }],
        [A, { runId: "bad id!", key: K, reason: "x" }],
        [A, { runId: "run-a", key: "nokey", reason: "x" }],
        [A, { runId: "run-a", key: K, reason: "tab\there" }],
      ];
      for (const [path, body] of bads) {
        const r = await t.call(t.admin, "POST", path, body);
        expect(r.status, JSON.stringify(body)).toBe(400);
        expect(r.json().issues.length, JSON.stringify(body)).toBeGreaterThan(0);
      }
    } finally {
      t.close();
    }
  });

  it("allows a run in the runs folder of the server, and then shows the allowance", async () => {
    const t = await boot();
    try {
      expect((await t.call(t.admin, "POST", "/api/skills/lifecycle", { key: K, state: "quarantined", reason: "found a bug" })).status).toBe(200);
      expect((await t.call(t.admin, "POST", "/api/skills/lifecycle/allow-run", { runId: "run-zz", key: K, reason: "ok" })).status).toBe(404);
      const r = await t.call(t.admin, "POST", "/api/skills/lifecycle/allow-run", { runId: "run-a", key: K, reason: "needed" });
      expect(r.status, r.text).toBe(200);
      expect(r.json()).toMatchObject({ added: true, allowance: { seq: 2, runId: "run-a", by: t.admin.user.id } });
      const list = (await t.call(t.admin, "GET", "/api/skills/lifecycle")).json();
      expect(list.states[0].allowedRuns).toEqual([expect.objectContaining({ runId: "run-a" })]);
    } finally {
      t.close();
    }
  });

  it("reports a record that cannot be read, and refuses a write", async () => {
    const t = await boot();
    try {
      writeFileSync(join(t.home, "skill-lifecycle.jsonl"), "oops\n");
      const list = (await t.call(t.admin, "GET", "/api/skills/lifecycle")).json();
      expect(list.problem).toContain("line 1");
      expect((await t.call(t.admin, "POST", "/api/skills/lifecycle", { key: K, state: "retired", reason: "x" })).status).toBe(409);
    } finally {
      t.close();
    }
  });

  it("answers a user with 403 on all three routes", async () => {
    const t = await boot();
    try {
      const user = await signInAs(t.s.base, { name: "Plain User", email: "user@example.com", role: "user" });
      expect((await t.call(user, "GET", "/api/skills/lifecycle")).status).toBe(403);
      expect((await t.call(user, "POST", "/api/skills/lifecycle", { key: K, state: "retired", reason: "x" })).status).toBe(403);
      expect((await t.call(user, "POST", "/api/skills/lifecycle/allow-run", { runId: "run-a", key: K, reason: "x" })).status).toBe(403);
    } finally {
      t.close();
    }
  });
});
