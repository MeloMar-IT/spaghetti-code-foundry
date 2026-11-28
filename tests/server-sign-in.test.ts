import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetAiSignIn } from "../src/auth/ai-sign-in.js";
import { AI_TOKEN_VARS } from "../src/auth/ai-token.js";
import { startTestServer } from "./helpers/port.js";

// One server start: a job saved in the queue, and a (fake) Claude Code that is signed out and takes a moment to say so.

const KEYS = [...AI_TOKEN_VARS, "FACTORY_HOME", "FACTORY_NO_SIGN_IN_PROBE", "FAKE_CLAUDE_AUTH_FILE"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let tmp: string;

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetAiSignIn();
  rmSync(tmp, { recursive: true, force: true });
});

describe("a server that starts without an AI sign-in", () => {
  it("knows it before its queue starts a restored job: the job waits", async () => {
    tmp = mkdtempSync(join(tmpdir(), "factory-sign-in-server-"));
    for (const k of AI_TOKEN_VARS) delete process.env[k];
    delete process.env.FACTORY_NO_SIGN_IN_PROBE;
    process.env.FAKE_CLAUDE_AUTH_FILE = join(tmp, "signed-in"); // not there: signed out
    process.env.FACTORY_HOME = join(tmp, "home");
    mkdirSync(process.env.FACTORY_HOME);
    const flow = { name: "ai", workspace: "empty", vars: {}, defaults: {}, sandbox: {}, limits: {}, steps: [{ id: "a", type: "claude", prompt: "x" }] };
    writeFileSync(join(process.env.FACTORY_HOME, "queue.json"), JSON.stringify([
      { runId: "20261001-120000-aaaa", job: { kind: "run", flow, task: "t", repo: tmp, vars: {}, frozenVars: true }, source: "ui", enqueuedAt: new Date().toISOString() },
    ]));
    const { close, ctx } = await startTestServer({ repo: tmp, runsDir: join(tmp, "runs"), claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, log: () => {} });
    try {
      await Promise.resolve(); // the scheduler's first look at its queue
      expect(ctx.scheduler.queue().active).toEqual([]);
      expect(ctx.scheduler.queue().pending).toMatchObject([{ runId: "20261001-120000-aaaa", limit: "sign_in" }]);
    } finally {
      close();
    }
  });
});
