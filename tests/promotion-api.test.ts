import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditPath } from "../src/auth/audit.js";
import { dataHome } from "../src/auth/store.js";
import { expectedResultKeys, homeInputs, type EvalInputs } from "../src/eval-inputs.js";
import { evalsDir, loadSuite, SAFETY_DIR } from "../src/evals.js";
import { promoteCommand } from "../src/promotion/cli.js";
import { currentSuiteInputs } from "../src/promotion/promote.js";
import { SAFETY_CATALOGUE } from "../src/promotion/required-suites.js";
import { FACTORY_HOME } from "../src/home.js";
import { startTestServer } from "./helpers/port.js";
import { signInAs, type TestSession } from "./helpers/session.js";

// GET and POST /api/promotions on a real server with a temporary data folder, reports written the way `scf eval safety` writes them.

const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
const STAMP = "2026-01-01T00-00-00-000Z";
const MARKER = "SECRET-REPORT-MARKER";
const flowYaml = (name: string, version = 1, publish = true) =>
  `name: ${name}\nsteps:\n  - id: one\n    type: shell\n    run: echo one\n${publish ? `publish:\n  enabled: true\n  version: ${version}\n` : ""}`;

let tmp: string;
let repo: string;
let server: Awaited<ReturnType<typeof startTestServer>>;
let admin: TestSession;
let user: TestSession;
const logged: string[] = [];

const globalFlows = join(FACTORY_HOME, "flows");
const put = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
const call = async (who: TestSession | undefined, method: string, path: string, body?: unknown) => {
  const r = await fetch(server.base + path, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(who ? who.headers(method) : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, text, json: () => JSON.parse(text) };
};
const get = (path: string) => call(admin, "GET", `/api/promotions${path}`);
const post = (body: unknown) => call(admin, "POST", "/api/promotions", body);
const auditLines = (action: string) =>
  (existsSync(auditPath()) ? readFileSync(auditPath(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, string>) : []).filter((l) => l.action === action);
const recordsFile = () => join(dataHome(), "promotions", "records.json");

/** A report as `runEval` writes it, for the components of the data folder now. */
function report(name: string, o: { stamp?: string; passed?: boolean } = {}) {
  const suitePath = join(SAFETY_DIR, name, "suite.yaml");
  const suite = loadSuite(suitePath);
  const inputs: EvalInputs = { version: 1, live: false, ...currentSuiteInputs(suitePath, suite), components: homeInputs(dataHome()) };
  const results = expectedResultKeys(suite, inputs).map((k) => {
    const [variant, c, attempt] = k.split("|");
    return { variant, case: c, attempt: Number(attempt), passed: o.passed ?? true };
  });
  put(join(evalsDir(), `${name}-${o.stamp ?? STAMP}.json`), JSON.stringify({ suite: name, startedAt: "x", finishedAt: "y", note: MARKER, inputs, results, summary: [] }));
}
const reportAll = () => SAFETY_CATALOGUE.forEach((n) => report(n));

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "promotion-api-"));
  repo = join(tmp, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  server = await startTestServer({ repo, runsDir: join(tmp, "runs"), claudeBin, watchers: false, accountSweepMs: 3_600_000, log: (m) => void logged.push(m) });
  admin = await signInAs(server.base);
  user = await signInAs(server.base, { name: "A User", email: "user@example.com", role: "user" });
});
afterAll(() => {
  server.close();
  rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  logged.length = 0;
});
afterEach(() => {
  for (const p of [globalFlows, evalsDir(), join(dataHome(), "promotions"), join(dataHome(), "auth.lock"), join(repo, ".claude-factory")]) rmSync(p, { recursive: true, force: true });
});

describe("GET /api/promotions", () => {
  it("is for admins: 200 for an admin, 403 for a user, 401 without a session", async () => {
    expect((await get("")).status).toBe(200);
    expect((await call(user, "GET", "/api/promotions")).status).toBe(403);
    expect((await call(undefined, "GET", "/api/promotions")).status).toBe(401);
  });

  it("answers 400 for a bad kind, a bad id and an id without a kind", async () => {
    for (const q of ["?kind=nope", "?kind=flow&id=a%20b", "?kind=flow&id=../x", "?id=x"]) expect((await get(q)).status, q).toBe(400);
  });

  it("lists published flows only, and an unpublished one when asked for by id", async () => {
    put(join(globalFlows, "pub.yaml"), flowYaml("pub"));
    put(join(globalFlows, "draft.yaml"), flowYaml("draft", 1, false));
    const all = (await get("?kind=flow")).json();
    expect(all.components.map((c: { ref: { id: string } }) => c.ref.id)).toEqual(["pub"]);
    const one = (await get("?kind=flow&id=draft")).json();
    expect(one.components.map((c: { ref: { id: string } }) => c.ref.id)).toEqual(["draft"]);
    expect((await get("?kind=flow&id=walk")).json().components).toEqual([]); // an unchanged built-in flow is left out
  });

  it("goes blocked, promotable, promoted and blocked again", async () => {
    put(join(globalFlows, "pub.yaml"), flowYaml("pub"));
    let row = (await get("?kind=flow&id=pub")).json().components[0];
    expect(row.state).toBe("blocked");
    expect(row.ref).toMatchObject({ kind: "flow", id: "pub", version: "1", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(row.blocking.map((b: { suite: string }) => b.suite)).toEqual([...SAFETY_CATALOGUE]);
    expect(row.blocking[0]).toEqual({ code: "suite-missing", suite: "approval-bypass", remediation: "scf eval safety" });

    reportAll();
    row = (await get("?kind=flow&id=pub")).json().components[0];
    expect(row.state).toBe("promotable");
    expect(row.reports).toHaveLength(9);

    const done = await post({ kind: "flow", id: "pub", reportId: `timeout-${STAMP}` });
    expect(done.status).toBe(200);
    expect(done.json().component).toMatchObject({ state: "promoted", record: { reportId: `timeout-${STAMP}`, by: admin.user.id } });
    row = (await get("?kind=flow&id=pub")).json().components[0];
    expect(row.state).toBe("promoted");
    expect(row.record.reports).toHaveLength(9);

    // the live check wins over a record: a newer failing report blocks again
    report("timeout", { stamp: "2026-02-01T00-00-00-000Z", passed: false });
    row = (await get("?kind=flow&id=pub")).json().components[0];
    expect(row.state).toBe("blocked");
    expect(row.blocking).toEqual([{ code: "suite-failed", suite: "timeout", remediation: "scf eval safety" }]);
  });

  it("keeps two published versions with the same hash apart", async () => {
    put(join(globalFlows, "pub.yaml"), flowYaml("pub", 1));
    reportAll();
    expect((await post({ kind: "flow", id: "pub", reportId: `timeout-${STAMP}` })).status).toBe(200);
    put(join(globalFlows, "pub.yaml"), flowYaml("pub", 2)); // a new version number, the same hash
    const row = (await get("?kind=flow&id=pub")).json().components[0];
    expect(row.ref.version).toBe("2");
    expect(row.state).toBe("promotable");
  });

  it("gives the scope hint for a flow of the repository on a stale or missing block only", async () => {
    put(join(repo, ".claude-factory", "flows", "rf.yaml"), flowYaml("rf"));
    let row = (await get("?kind=flow&id=rf")).json().components[0];
    expect(row.blocking.every((b: { remediation: string }) => b.remediation.includes("move it to the global flows"))).toBe(true);
    reportAll();
    report("timeout", { stamp: "2026-02-01T00-00-00-000Z", passed: false });
    row = (await get("?kind=flow&id=rf")).json().components[0];
    const by = (s: string) => row.blocking.find((b: { suite: string }) => b.suite === s);
    expect(by("timeout")).toEqual({ code: "suite-failed", suite: "timeout", remediation: "scf eval safety" });
    expect(by("output-caps")).toMatchObject({ code: "report-stale", remediation: expect.stringContaining("move it to the global flows") });
    // a global flow gets no hint
    put(join(globalFlows, "pub.yaml"), flowYaml("pub"));
    row = (await get("?kind=flow&id=pub")).json().components[0];
    expect(JSON.stringify(row)).not.toContain("global flows");
  });

  it("holds no report content, and names a flow that is not valid as a problem", async () => {
    put(join(globalFlows, "pub.yaml"), flowYaml("pub"));
    put(join(globalFlows, "bad.yaml"), "name: [oops\n");
    reportAll();
    const res = await get("");
    expect(res.text).not.toContain(MARKER);
    expect(res.text).not.toContain('"results"');
    expect(res.text).not.toContain('"inputs"');
    expect(res.json().problems).toContainEqual({ kind: "flow", id: "bad", reason: "is not valid" });
  });

  it("names a record file that cannot be read, and shows no promoted row", async () => {
    put(join(globalFlows, "pub.yaml"), flowYaml("pub"));
    reportAll();
    put(recordsFile(), "{ nope");
    const body = (await get("?kind=flow&id=pub")).json();
    expect(body.recordProblem).toContain("promotions/records.json is not valid");
    expect(body.components[0].state).toBe("promotable");
    const post503 = await post({ kind: "flow", id: "pub", reportId: `timeout-${STAMP}` });
    expect(post503.status).toBe(503);
    expect(readFileSync(recordsFile(), "utf8")).toBe("{ nope");
  });
});

describe("POST /api/promotions", () => {
  it("is for admins and needs the CSRF token", async () => {
    put(join(globalFlows, "pub.yaml"), flowYaml("pub"));
    reportAll();
    const body = { kind: "flow", id: "pub", reportId: `timeout-${STAMP}` };
    expect((await call(user, "POST", "/api/promotions", body)).status).toBe(403);
    const noCsrf = await fetch(`${server.base}/api/promotions`, { method: "POST", headers: { "content-type": "application/json", cookie: admin.cookie }, body: JSON.stringify(body) });
    expect(noCsrf.status).toBe(403);
    expect(existsSync(recordsFile())).toBe(false);
  });

  it("answers 400 for a bad kind, id or report id", async () => {
    for (const b of [{}, { kind: "flow", id: "pub" }, { kind: "x", id: "pub", reportId: `timeout-${STAMP}` }, { kind: "flow", id: "a/b", reportId: `timeout-${STAMP}` }, { kind: "flow", id: "pub", reportId: "../../etc" }]) {
      expect((await post(b)).status, JSON.stringify(b)).toBe(400);
    }
  });

  it("writes the record and an audit line", async () => {
    put(join(globalFlows, "pub.yaml"), flowYaml("pub"));
    reportAll();
    const before = auditLines("component-promote").length;
    expect((await post({ kind: "flow", id: "pub", reportId: `output-caps-${STAMP}` })).status).toBe(200);
    const saved = JSON.parse(readFileSync(recordsFile(), "utf8")).records;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ id: "pub", reportId: `output-caps-${STAMP}`, by: admin.user.id });
    const lines = auditLines("component-promote");
    expect(lines).toHaveLength(before + 1);
    expect(lines.at(-1)).toMatchObject({ result: "ok", by: admin.user.id, target: "flow/pub", detail: expect.stringMatching(new RegExp(`^v1 sha256:[0-9a-f]{64} report:output-caps-${STAMP}$`)) });
  });

  it("refuses with 409 and the blocking list, logs the CLI's line, audits a failure and writes nothing", async () => {
    put(join(globalFlows, "pub.yaml"), flowYaml("pub"));
    reportAll();
    report("timeout", { stamp: "2026-02-01T00-00-00-000Z", passed: false });
    const before = auditLines("component-promote").length;
    const res = await post({ kind: "flow", id: "pub", reportId: `output-caps-${STAMP}` });
    expect(res.status).toBe(409);
    expect(res.json().blocking).toEqual([{ code: "suite-failed", suite: "timeout", remediation: "scf eval safety" }]);
    expect(existsSync(recordsFile())).toBe(false);

    const cli: string[] = [];
    promoteCommand(["flow", "pub"], {}, (l) => void cli.push(l));
    expect(cli.filter((l) => l.startsWith("BLOCKED"))).toEqual(["BLOCKED flow pub: timeout (suite-failed) — scf eval safety"]);
    expect(logged.filter((l) => l.startsWith("BLOCKED"))).toEqual(cli.filter((l) => l.startsWith("BLOCKED")));

    const lines = auditLines("component-promote");
    expect(lines).toHaveLength(before + 1);
    expect(lines.at(-1)).toMatchObject({ result: "failed", target: "flow/pub", detail: "timeout: suite-failed" });
  });

  it("refuses a report id that is not the newest passing one of a suite", async () => {
    put(join(globalFlows, "pub.yaml"), flowYaml("pub"));
    reportAll();
    const res = await post({ kind: "flow", id: "pub", reportId: `timeout-2027-01-01T00-00-00-000Z` });
    expect(res.status).toBe(409);
    expect(res.json().blocking).toEqual([{ code: "report-unknown", remediation: "scf promote flow pub" }]);
    expect(existsSync(recordsFile())).toBe(false);
  });

  it("refuses a repository flow that does not parse, even when a valid global flow of its name has passing reports", async () => {
    put(join(globalFlows, "shadow.yaml"), flowYaml("shadow"));
    reportAll();
    put(join(repo, ".claude-factory", "flows", "shadow.yaml"), "name: [oops\n");
    const before = auditLines("component-promote").length;
    const res = await post({ kind: "flow", id: "shadow", reportId: `timeout-${STAMP}` });
    expect(res.status).toBe(409);
    expect(res.json().blocking).toEqual([{ code: "problem", remediation: "scf components flow" }]);
    expect(existsSync(recordsFile())).toBe(false);
    expect(logged).toContain("BLOCKED flow shadow: (problem) — scf components flow");
    expect(auditLines("component-promote")).toHaveLength(before + 1);
    expect(auditLines("component-promote").at(-1)).toMatchObject({ result: "failed", target: "flow/shadow", detail: "problem" });
  });

  it("answers 503 at once and writes no record while another process holds the lock", async () => {
    put(join(globalFlows, "pub.yaml"), flowYaml("pub"));
    reportAll();
    const lock = join(dataHome(), "auth.lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "pid"), String(process.ppid)); // a live process that is not this one
    const started = Date.now();
    const res = await post({ kind: "flow", id: "pub", reportId: `timeout-${STAMP}` });
    expect(res.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(1500);
    rmSync(lock, { recursive: true, force: true });
    expect(existsSync(recordsFile())).toBe(false);
  });
});
