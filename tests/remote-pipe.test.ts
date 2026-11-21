import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI = resolve("dist/cli.js");
const DEADLINE_MS = 8000;

let home: string;
let server: Server;
let children: ChildProcess[];
let answer: { status: number; body: string };

beforeEach(async () => {
  if (!existsSync(CLI)) throw new Error(`${CLI} is missing — run \`npm run build\` first`);
  home = mkdtempSync(join(tmpdir(), "scf-pipe-"));
  children = [];
  server = createServer((_req, res) => {
    res.writeHead(answer.status, { "content-type": "application/json" });
    res.end(answer.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  writeFileSync(join(home, "cli-session.json"), JSON.stringify({ server: `http://127.0.0.1:${port}`, cookie: "c=1", token: "t", email: "a@example.com" }));
});

afterEach(async () => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(home, { recursive: true, force: true });
});

function scf(args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((done, fail) => {
    const c = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, SCF_HOME: home, FACTORY_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(c);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => { c.kill("SIGKILL"); fail(new Error("the command did not end in time")); }, DEADLINE_MS);
    c.stdout.on("data", (b: Buffer) => out.push(b));
    c.stderr.on("data", (b: Buffer) => err.push(b));
    c.on("error", (e) => { clearTimeout(timer); fail(e); });
    c.on("close", (code) => {
      clearTimeout(timer);
      done({ code, out: Buffer.concat(out).toString("utf8"), err: Buffer.concat(err).toString("utf8") });
    });
  });
}

describe("remote CLI output to a pipe", () => {
  it("writes a large --json answer whole", async () => {
    const runs = Array.from({ length: 4000 }, (_, i) => ({ id: `run-${i}`, status: "succeeded", task: "x".repeat(400) }));
    answer = { status: 200, body: JSON.stringify(runs) };
    const r = await scf(["runs", "list", "--json"]);
    expect(r.code).toBe(0);
    expect(r.out.length).toBeGreaterThan(1_000_000);
    const parsed = JSON.parse(r.out);
    expect(parsed).toHaveLength(4000);
    expect(parsed[3999].id).toBe("run-3999");
  }, 15000);

  it("writes a large error body whole and keeps the exit code", async () => {
    answer = { status: 500, body: JSON.stringify({ error: "boom", detail: "y".repeat(1_500_000) }) };
    const r = await scf(["api", "GET", "runs", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.err).detail).toHaveLength(1_500_000);
    expect(r.out).toBe("");
  }, 15000);
});
