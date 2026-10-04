import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { saveFindings, type Finding } from "../src/monitor/findings.js";
import { markerHash } from "../src/monitor/story.js";
import { fakeGithub } from "./helpers/fake-github.js";
import { signInAs, type TestSession } from "./helpers/session.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
let tmp: string;
let close: () => void;
let session: TestSession;
const home = () => join(tmp, "home");
const A = "restart-loop|a";
const T = "acme/app";

const call = (method: string, path: string, body?: unknown, headers = session?.headers(method)) =>
  fetch(base + path, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
const iso = (ms = 0) => new Date(Date.now() + ms).toISOString();
const finding = (fingerprint: string, over: Partial<Finding> = {}): Finding => ({
  detector: "restart-loop", fingerprint, severity: "critical", summary: `sentence of ${markerHash(fingerprint)}`, about: "foundry", evidence: {},
  firstSeen: iso(-3_600_000), lastSeen: iso(), count: 3, gone: false, ...over,
});
const story = (issue: number, over: Record<string, unknown> = {}) => ({ repo: T, issue, url: `https://github.com/${T}/issues/${issue}`, at: iso(), seen: 1, ...over });
const seed = (list: Finding[]) => saveFindings(list, join(home(), "monitor-findings.json"));
const stored = () => (JSON.parse(readFileSync(join(home(), "monitor-findings.json"), "utf8")) as { findings: Finding[] }).findings;
const get = async () => (await (await call("GET", "/api/monitor")).json()) as Record<string, any>;
const log = () => (existsSync(join(home(), "monitor-log.jsonl")) ? readFileSync(join(home(), "monitor-log.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>) : []);
const activity = async () => {
  const list = (await (await call("GET", "/api/watchers")).json()) as { id: string; status?: { lastActions: string[] } }[];
  return list.find((w) => w.id === "mon")?.status?.lastActions ?? [];
};
const setMonitor = async (patch: Record<string, unknown>) => {
  const cfg = (await (await call("GET", "/api/config")).json()) as { monitor: Record<string, unknown> };
  return call("PUT", "/api/config", { ...cfg, monitor: { ...cfg.monitor, ...patch } });
};
const withTarget = async (fn: () => Promise<void>) => {
  expect((await setMonitor({ report_to: T })).status).toBe(200);
  try {
    await fn();
  } finally {
    expect((await setMonitor({ report_to: undefined })).status).toBe(200);
  }
};

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "monitor-problems-"));
  process.env.FACTORY_HOME = home();
  const { startServer } = await import("../src/server/server.js");
  ({ close } = await startServer({ repo: tmp, runsDir: join(tmp, "runs"), port, claudeBin: resolve("tests/fixtures/fake-claude.mjs") }));
  session = await signInAs(base);
  const cfg = (await (await call("GET", "/api/config")).json()) as { watchers: unknown[] };
  expect((await call("PUT", "/api/config", { ...cfg, watchers: [{ id: "mon", source: "monitor", every: "1h" }] })).status).toBe(200);
  expect((await call("POST", "/api/watchers/mon/tick", {})).status).toBe(200);
});
afterAll(() => {
  close();
  rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  rmSync(join(home(), "monitor-guard.json"), { force: true });
  rmSync(join(home(), "monitor-log.jsonl"), { force: true });
  seed([]);
});

describe("GET /api/monitor for the Problems page", () => {
  it("says what the monitor does", async () => {
    const m = await get();
    expect(m).toMatchObject({ running: true, perDay: 3, madeToday: 0, breaker: { open: false } });
    expect(typeof m.lastCheck).toBe("string");
  });

  it("madeToday follows the log", async () => {
    const line = JSON.stringify({ at: iso(), event: "story-made", fingerprint: "x" });
    writeFileSync(join(home(), "monitor-log.jsonl"), `${line}\n${line}\n`);
    expect((await get()).madeToday).toBe(2);
  });

  it("with an open breaker and the switch off, the state is off and the breaker is open with its reason", async () => {
    writeFileSync(join(home(), "monitor-guard.json"), JSON.stringify({ version: 1, off: { since: iso(), by: "cli" }, breaker: { open: { reason: "failed_fixes", count: 3, since: iso() } } }));
    const m = await get();
    expect(m.state).toBe("off");
    expect(m.breaker).toMatchObject({ open: true });
    expect(typeof m.breaker.why).toBe("string");
  });

  it("gives every finding its state, most urgent first", async () => {
    await withTarget(async () => {
      const past = iso(-1000);
      seed([
        finding("restart-loop|gone", { gone: true }),
        finding("restart-loop|minor", { severity: "minor" }),
        finding("restart-loop|seen"),
        finding("restart-loop|wait", { report: story(1) }),
        finding("restart-loop|fixed", { report: story(2, { closedAt: past }) }),
        finding("restart-loop|back", { report: story(3, { closedAt: past, clockAt: past, seenAfter: past }) }),
        finding("restart-loop|needs", { tries: 2, needsYou: past, report: story(4, { closedAt: past }) }),
        finding("restart-loop|np", { report: story(5, { muted: true }) }),
      ]);
      const m = await get();
      const state = (k: string) => m.findings.find((f: { id: string }) => f.id === markerHash(`restart-loop|${k}`)).state;
      expect(["gone", "minor", "seen", "wait", "fixed", "back", "needs", "np"].map(state)).toEqual(["gone", "seen", "seen", "waiting", "fixed-watching", "came-back", "needs-you", "muted"]);
      expect(m.findings.at(-1).id).toBe(markerHash("restart-loop|gone"));
      expect(m.findings.at(-2).severity).toBe("minor");
    });
  });

  it("says when the findings file cannot be read, and does not rename it", async () => {
    writeFileSync(join(home(), "monitor-findings.json"), "{ nope");
    const m = await get();
    expect(m).toMatchObject({ findingsUnreadable: true, findings: [] });
    expect(existsSync(join(home(), "monitor-findings.json.broken"))).toBe(false);
    expect(((await (await call("GET", "/api/health")).json()) as any).monitorFindings).toMatchObject({ unreadable: true });
  });

  it("lists the detectors with their thresholds and when they last found something", async () => {
    const seen = iso(-5000);
    seed([finding("restart-loop|x", { lastSeen: seen })]);
    const m = await get();
    const d = (n: string) => m.detectors.find((x: { name: string }) => x.name === n);
    expect(d("restart-loop")).toMatchObject({ key: "restart_loop", thresholds: { resumes: 5, within_minutes: 10 }, lastFound: seen });
    expect(d("self-update").thresholds).toBeUndefined();
    expect(d("detector-failed").thresholds).toBeUndefined();
    expect(d("slow-step").lastFound).toBeUndefined();
  });

  it("shows a threshold saved through the config, and refuses one out of range", async () => {
    expect((await setMonitor({ restart_loop: { resumes: 7, within_minutes: 10 } })).status).toBe(200);
    expect((await get()).detectors.find((x: { name: string }) => x.name === "restart-loop").thresholds).toEqual({ resumes: 7, within_minutes: 10 });
    expect((await setMonitor({ restart_loop: { resumes: 500, within_minutes: 10 } })).status).toBe(400);
    expect((await setMonitor({ restart_loop: { resumes: 5, within_minutes: 10 } })).status).toBe(200);
  });
});

describe("GET /api/monitor/findings/:id", () => {
  it("answers with the evidence, the stories and the runs, and never the fingerprint", async () => {
    seed([finding(A, { evidence: { flows: ["issue-gitflow"], lines: ["exit code 1"] }, earlier: [{ repo: T, issue: 3, url: `https://github.com/${T}/issues/3` }, { repo: T, issue: 4 }], report: story(4) })]);
    const res = await call("GET", `/api/monitor/findings/${markerHash(A)}`);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain(A);
    const d = JSON.parse(text);
    expect(d.evidence).toEqual(["Flows: issue-gitflow", "exit code 1"]);
    expect(d.stories).toEqual([{ issue: 3, url: `https://github.com/${T}/issues/3`, current: false }, { issue: 4, url: `https://github.com/${T}/issues/4`, current: true }]);
    expect(d.runs).toEqual([]);
  });

  it("answers 404 for an unknown or malformed id and for a broken file", async () => {
    seed([finding(A)]);
    expect((await call("GET", "/api/monitor/findings/0123456789abcdef")).status).toBe(404);
    expect((await call("GET", "/api/monitor/findings/nope")).status).toBe(404);
    writeFileSync(join(home(), "monitor-findings.json"), "{ nope");
    expect((await call("GET", `/api/monitor/findings/${markerHash(A)}`)).status).toBe(404);
    expect(existsSync(join(home(), "monitor-findings.json.broken"))).toBe(false);
  });
});

describe("POST /api/monitor/story", () => {
  let gh: ReturnType<typeof fakeGithub>;
  beforeEach(() => {
    gh = fakeGithub();
  });
  afterEach(() => gh.restore());
  const press = (fp = A, headers = session.headers("POST")) => call("POST", "/api/monitor/story", { finding: markerHash(fp) }, headers);

  it("makes the story, logs who asked, and the finding is waiting", async () => {
    await withTarget(async () => {
      seed([finding(A)]);
      const res = await press();
      const text = await res.text();
      expect(res.status).toBe(200);
      expect(text).not.toContain(A);
      expect(JSON.parse(text).story).toMatchObject({ made: true });
      expect(gh.createdBodies()).toHaveLength(1);
      const m = await get();
      expect(m.findings[0].state).toBe("waiting");
      expect(m.madeToday).toBe(1);
      expect(log().filter((l) => l.event === "story-made")).toMatchObject([{ by: session.user.id }]);
      expect((await activity()).some((l) => l.includes("an admin asked for it"))).toBe(true);
    });
  });

  it("is refused with 409 when the monitor is off, and for exists, muted, two tries, gone and no repository", async () => {
    await withTarget(async () => {
      seed([finding(A)]);
      expect((await call("POST", "/api/monitor/off", {})).status).toBe(200);
      const off = await press();
      expect(off.status).toBe(409);
      expect(((await off.json()) as { error: string }).error).toContain("the monitor is off");
      expect(gh.createdBodies()).toEqual([]);
      expect((await call("POST", "/api/monitor/on", {})).status).toBe(200);
      for (const over of [{ report: story(1) }, { tries: 2 }, { gone: true }]) {
        seed([finding(A, over)]);
        expect((await press()).status).toBe(409);
      }
      seed([finding(A)]);
      expect((await call("POST", "/api/monitor/mutes", { finding: markerHash(A), reason: "noise" })).status).toBe(201);
      expect((await press()).status).toBe(409);
      expect(gh.createdBodies()).toEqual([]);
    });
    seed([finding(A)]);
    expect((await press()).status).toBe(409); // no repository
  });

  it("is allowed while the circuit breaker is open", async () => {
    await withTarget(async () => {
      seed([finding(A)]);
      writeFileSync(join(home(), "monitor-guard.json"), JSON.stringify({ version: 1, breaker: { open: { reason: "failed_fixes", count: 3, since: iso() } } }));
      expect((await press()).status).toBe(200);
    });
  });

  it("answers 400 for bad input, an unknown finding and a broken file, and 403 without the CSRF token", async () => {
    await withTarget(async () => {
      seed([finding(A)]);
      for (const body of [{}, { finding: "x" }, { finding: "0123456789abcdef" }]) expect((await call("POST", "/api/monitor/story", body)).status).toBe(400);
      expect((await press(A, { cookie: session.cookie })).status).toBe(403);
      writeFileSync(join(home(), "monitor-findings.json"), "{ nope");
      expect((await press()).status).toBe(400);
      expect(existsSync(join(home(), "monitor-findings.json.broken"))).toBe(false);
    });
  });

  it("answers 502 when GitHub fails", async () => {
    await withTarget(async () => {
      seed([finding(A)]);
      process.env.FAKE_GH_FAIL_API = "create";
      expect((await press()).status).toBe(502);
      expect(stored()[0]!.report).toBeUndefined();
    });
  });

  it("still answers 200 when the watcher is disabled during the request", async () => {
    await withTarget(async () => {
      seed([finding(A)]);
      const cfg = (await (await call("GET", "/api/config")).json()) as { watchers: unknown[] };
      const release = gh.hold("-X POST");
      const pending = press();
      await new Promise((r) => setTimeout(r, 1500));
      expect((await call("PUT", "/api/config", { ...cfg, watchers: [{ id: "mon", source: "monitor", every: "1h", enabled: false }] })).status).toBe(200);
      release();
      expect((await pending).status).toBe(200);
      expect(stored()[0]!.report).toBeDefined();
      const m = await get();
      expect(m.running).toBe(false);
      expect(typeof m.lastCheck).toBe("string");
      const again = await press();
      expect(again.status).toBe(409);
      expect(((await again.json()) as { error: string }).error).toContain("the monitor is not running");
      expect((await call("PUT", "/api/config", cfg)).status).toBe(200);
    });
  }, 20_000);
});

describe("for a user", () => {
  it("is refused everywhere and shows no repository name", async () => {
    seed([finding(A, { summary: "other-owner/secret-repo is broken" })]);
    const ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
    const calls: [string, string, unknown?][] = [
      ["GET", "/api/monitor"], ["GET", `/api/monitor/findings/${markerHash(A)}`], ["POST", "/api/monitor/story", { finding: markerHash(A) }], ["POST", "/api/monitor/off", {}],
      ["POST", "/api/monitor/on", {}], ["POST", "/api/monitor/mutes", {}], ["POST", "/api/monitor/retry", {}], ["GET", "/api/health"],
    ];
    for (const [method, path, body] of calls) {
      const res = await fetch(base + path, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...ann.headers(method) }, body: body !== undefined ? JSON.stringify(body) : undefined });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await res.text()).not.toContain("secret-repo");
    }
  });
});
