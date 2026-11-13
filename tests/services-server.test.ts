import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lookupServiceToken } from "../src/auth/service-accounts.js";
import { signInAs } from "./helpers/session.js";

// startServer with a managed service (#867): it starts once the server listens, shows on Health, and stops on close.

const FIXTURE = resolve("tests/fixtures/services/fake-service.mjs");
let tmp: string;
let home: string;
let startTestServer: typeof import("./helpers/port.js").startTestServer;

beforeAll(async () => {
  chmodSync(FIXTURE, 0o755);
  tmp = mkdtempSync(join(tmpdir(), "factory-svc-srv-"));
  home = join(tmp, "home");
  mkdirSync(home, { recursive: true });
  process.env.FACTORY_HOME = home; // read at import time, so import afterwards
  ({ startTestServer } = await import("./helpers/port.js"));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const until = async (cond: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("services at server start", () => {
  it("starts after the server listens, shows on Health, and is stopped on close", async () => {
    const outFile = join(tmp, "out.jsonl");
    writeFileSync(join(home, "config.yaml"), `services:\n  - name: echo-bot\n    command: ${FIXTURE}\n    args: ["--out", ${JSON.stringify(outFile)}]\n    scope: ["GET health"]\n`);
    const s = await startTestServer({ repo: tmp, runsDir: join(tmp, "runs"), watchers: false, claudeBin: resolve("tests/fixtures/fake-claude.mjs") });
    let closed = false;
    try {
      await until(() => existsSync(outFile) && readFileSync(outFile, "utf8").includes("\n"));
      const started = JSON.parse(readFileSync(outFile, "utf8").split("\n")[0]!) as { token: string; url: string };
      expect(started.url).toBe(s.url); // the server's address was known: it listens
      expect(lookupServiceToken(started.token)?.state).toBe("live");
      const admin = await signInAs(s.base);
      const r = await fetch(`${s.base}/api/health`, { headers: admin.headers("GET") });
      const body = (await r.json()) as { services?: { name: string; state: string; restarts: number }[] };
      expect(body.services).toMatchObject([{ name: "echo-bot", state: "running", restarts: 0 }]);
      expect(JSON.stringify(body)).not.toContain(started.token);
      s.close();
      closed = true;
      await until(() => readFileSync(outFile, "utf8").includes("term") && lookupServiceToken(started.token)?.state !== "live");
    } finally {
      if (!closed) s.close();
    }
  });

  it("is set in config.yaml only: not in GET config, refused in PUT config, kept by a save without it", async () => {
    const outFile = join(tmp, "out2.jsonl");
    writeFileSync(join(home, "config.yaml"), `services:\n  - name: echo-bot\n    command: ${FIXTURE}\n    args: ["--out", ${JSON.stringify(outFile)}]\n    env: { API_KEY: SECRET-ENV }\n    scope: ["GET health"]\n`);
    const s = await startTestServer({ repo: tmp, runsDir: join(tmp, "runs"), watchers: false, claudeBin: resolve("tests/fixtures/fake-claude.mjs") });
    try {
      const admin = await signInAs(s.base);
      const call = (method: string, body?: unknown) =>
        fetch(`${s.base}/api/config`, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...admin.headers(method) }, body: body ? JSON.stringify(body) : undefined });
      const text = await (await call("GET")).text();
      expect(text).not.toContain("SECRET-ENV");
      const settings = JSON.parse(text) as Record<string, unknown>;
      expect(settings).not.toHaveProperty("services");
      const refused = await call("PUT", { ...settings, services: [] });
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: string }).error).toContain("set in config.yaml only");
      expect((await call("PUT", { ...settings, concurrency: 2 })).status).toBe(200);
      const file = readFileSync(join(home, "config.yaml"), "utf8");
      expect(file).toContain("echo-bot");
      expect(file).toContain("SECRET-ENV");
    } finally {
      s.close();
    }
  });

  it("has no services key, no folder and no account without services", async () => {
    rmSync(join(home, "services"), { recursive: true, force: true });
    rmSync(join(home, "services-accounts.json"), { force: true });
    writeFileSync(join(home, "config.yaml"), "");
    const s = await startTestServer({ repo: tmp, runsDir: join(tmp, "runs"), watchers: false, claudeBin: resolve("tests/fixtures/fake-claude.mjs") });
    try {
      const admin = await signInAs(s.base);
      const body = (await (await fetch(`${s.base}/api/health`, { headers: admin.headers("GET") })).json()) as Record<string, unknown>;
      expect(body).not.toHaveProperty("services");
    } finally {
      s.close();
    }
  });
});
