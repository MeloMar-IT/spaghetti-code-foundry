import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startServer } from "../src/server/server.js";
import { freePort, startTestServer } from "./helpers/port.js";
import { scanPorts, scanTestPorts } from "./helpers/port-scan.js";
import { signInAs } from "./helpers/session.js";

// Files that still pick their own port. A later part moves its files and deletes its lines; the list can only shrink.
// Part 2: refinement
const PART_2 = [
  "tests/refinement-api.test.ts",
  "tests/refinement-architect.test.ts",
  "tests/refinement-backlog-api.test.ts",
  "tests/refinement-draft-api.test.ts",
  "tests/refinement-impact-api.test.ts",
  "tests/refinement-import-api.test.ts",
  "tests/refinement-judge-api.test.ts",
  "tests/refinement-round.test.ts",
  "tests/refinement-source-label-api.test.ts",
  "tests/refinement-split-api.test.ts",
  "tests/refinement-talk-api.test.ts",
];
// Part 3: refinement publish
const PART_3 = [
  "tests/refinement-publish-api.test.ts",
  "tests/refinement-publish-changed-api.test.ts",
  "tests/refinement-publish-close-api.test.ts",
  "tests/refinement-publish-lock-api.test.ts",
  "tests/refinement-publish-post-api.test.ts",
  "tests/refinement-publish-replace-api.test.ts",
  "tests/refinement-publish-replace-plan-api.test.ts",
  "tests/refinement-publish-replace-retry-api.test.ts",
  "tests/refinement-publish-update-api.test.ts",
];
// Part 4: repositories, watchers, credentials
const PART_4 = [
  "tests/repo-key.test.ts",
  "tests/repo-watchers-run.test.ts",
];
// Part 5: accounts and sign-in
const PART_5 = [
  "tests/account-work.test.ts",
  "tests/audit-actions.test.ts",
  "tests/audit-api.test.ts",
  "tests/auth.test.ts",
  "tests/limits-api.test.ts",
  "tests/password-change.test.ts",
  "tests/password-link.test.ts",
  "tests/password-link-seams.test.ts",
  "tests/user-cli.test.ts",
  "tests/user-view.test.ts",
  "tests/users-api.test.ts",
];
// Part 6: server, runs and the rest
const PART_6 = [
  "tests/browser/seed.ts",
  "tests/home-process.test.ts",
  "tests/monitor-api.test.ts",
  "tests/net-server.test.ts",
  "tests/run-answer.test.ts",
  "tests/run-archive.test.ts",
  "tests/run-ownership.test.ts",
  "tests/search-api.test.ts",
  "tests/skill-cli.test.ts",
  "tests/ui-gallery-server.test.ts",
];
const ALLOWED = [...PART_2, ...PART_3, ...PART_4, ...PART_5, ...PART_6];

// Samples are built from pieces so no line of this file holds both the call and "port" or the sum.
const RND = ["Math", "random()"].join(".");
const pick = (base = "20000") => `${base} + Math.floor(${RND} * 20000)`;

describe("scanPorts", () => {
  it("flags a line that picks a port", () => {
    expect(scanPorts(`const port = ${pick()};`)).toEqual([`1: const port = ${pick()};`]);
  });

  it("reports the line number", () => {
    expect(scanPorts(`a\nb\n  const port = ${pick()};\nc`)).toEqual([`3: const port = ${pick()};`]);
  });

  it("flags a 4-5 digit base without the word port", () => {
    expect(scanPorts(`start(dir, runs, ${pick()});`)).toHaveLength(1);
    expect(scanPorts(`start(dir, runs, ${pick("4050")});`)).toHaveLength(1);
    expect(scanPorts(`start(dir, runs, ${pick("400")});`)).toEqual([]);
    expect(scanPorts(`start(dir, runs, ${pick("400000")});`)).toEqual([]);
  });

  it("flags the word port in any case", () => {
    expect(scanPorts(`const randomPort = () => ${RND};`)).toHaveLength(1);
    expect(scanPorts(`const PORT = ${RND};`)).toHaveLength(1);
  });

  it("does not flag the non-port uses", () => {
    expect(scanPorts("const id = `sess-${" + RND + ".toString(36).slice(2)}`;")).toEqual([]);
    expect(scanPorts("const t = `thread-${" + RND + ".toString(36).slice(2)}`;")).toEqual([]);
    expect(scanPorts(`const run = Math.floor(${RND} * 1e9).toString(16);`)).toEqual([]);
    expect(scanPorts("f.publish({ \"app.txt\": `v${" + RND + "}\\n` });")).toEqual([]);
  });

  it("needs the call and the word on one line", () => {
    expect(scanPorts("const port = 8080;")).toEqual([]);
    expect(scanPorts(`const x = ${RND};\nconst port = 1;`)).toEqual([]);
  });
});

describe("scanTestPorts", () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const put = (rel: string, text: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  const bad = `const port = ${pick()};\n`;

  it("walks subfolders and the three extensions, and reports with line and the way out", () => {
    root = mkdtempSync(join(tmpdir(), "scan-ports-"));
    put("tests/a.test.ts", `x\n${bad}`);
    put("tests/sub/b.mjs", bad);
    put("tests/sub/deep/c.js", bad);
    put("tests/notes.md", bad);
    const found = scanTestPorts(root);
    expect(found.map((f) => f.where)).toEqual(["tests/a.test.ts", "tests/sub/b.mjs", "tests/sub/deep/c.js"]);
    expect(found[0]!.problems[0]).toContain("2: const port");
    expect(found[0]!.problems[0]).toContain("use startTestServer() or freePort() from tests/helpers/port.ts");
  });

  it("accepts an allowlisted file with a hit, and flags one without", () => {
    root = mkdtempSync(join(tmpdir(), "scan-ports-"));
    put("tests/a.test.ts", bad);
    put("tests/b.test.ts", "const x = 1;\n");
    expect(scanTestPorts(root, ["tests/a.test.ts"])).toEqual([]);
    const found = scanTestPorts(root, ["tests/a.test.ts", "tests/b.test.ts", "tests/gone.test.ts"]);
    expect(found.map((f) => f.where)).toEqual(["tests/b.test.ts", "tests/gone.test.ts"]);
    expect(found[0]!.problems[0]).toContain("remove it from the allowlist");
    expect(found[1]!.problems[0]).toContain("remove it from the allowlist");
  });
});

describe("the guard", () => {
  it("finds no test file that picks its own port, apart from the allowlist", () => {
    const found = scanTestPorts(".", ALLOWED);
    expect(found.map((f) => `${f.where}: ${f.problems.join("; ")}`).join("\n")).toBe("");
  });

  it("keeps the allowlist clean", () => {
    expect(new Set(ALLOWED).size).toBe(ALLOWED.length);
    for (const moved of ["tests/helpers/refinement-world.ts", "tests/refinement-suggest-api.test.ts", "tests/refinement-review-api.test.ts"]) {
      expect(ALLOWED).not.toContain(moved);
    }
  });
});

describe("freePort", () => {
  it("gives a port number", async () => {
    const p = await freePort();
    expect(Number.isInteger(p)).toBe(true);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThanOrEqual(65535);
  });
});

describe("startServer with a port from the system", () => {
  let tmp: string;
  let savedHome: string | undefined;
  const open: { close: () => void }[] = [];
  beforeAll(() => {
    savedHome = process.env.FACTORY_HOME;
    tmp = mkdtempSync(join(tmpdir(), "test-ports-"));
    process.env.FACTORY_HOME = join(tmp, "home");
  });
  afterAll(() => {
    if (savedHome === undefined) delete process.env.FACTORY_HOME;
    else process.env.FACTORY_HOME = savedHome;
    rmSync(tmp, { recursive: true, force: true });
  });
  afterEach(() => {
    for (const s of open.splice(0)) s.close();
  });
  const opts = () => ({ repo: tmp, runsDir: join(tmp, "runs"), watchers: false });

  it("gives back the real port, in url, base and the options", async () => {
    const s = await startTestServer(opts());
    open.push(s);
    expect(s.port).toBeGreaterThan(0);
    expect(s.url).toBe(`http://localhost:${s.port}`);
    expect(s.base).toBe(`http://127.0.0.1:${s.port}`);
    expect(s.ctx.opts.port).toBe(s.port);
  });

  it("names the session cookie after the real port", async () => {
    const s = await startTestServer(opts());
    open.push(s);
    const admin = await signInAs(s.base);
    expect(admin.cookie.startsWith(`scf_session_${s.port}=`)).toBe(true);
    const r = await fetch(`${s.base}/api/session`, { headers: admin.headers() });
    expect(r.status).toBe(200);
  });

  it("accepts the host of the real port", async () => {
    const s = await startTestServer(opts());
    open.push(s);
    expect((await fetch(`${s.base}/`)).status).toBe(200);
  });

  it("starts two servers at once on two ports", async () => {
    const [a, b] = await Promise.all([startTestServer(opts()), startTestServer(opts())]);
    open.push(a, b);
    expect(a.port).not.toBe(b.port);
    expect((await fetch(`${a.base}/`)).status).toBe(200);
    expect((await fetch(`${b.base}/`)).status).toBe(200);
  });

  it("keeps a port other than 0", async () => {
    // freePort is not a reservation: only a new port from the system is taken after EADDRINUSE; other errors go up
    for (let attempt = 0; ; attempt++) {
      const p = await freePort();
      try {
        const s = await startServer({ ...opts(), port: p });
        open.push(s);
        expect(s.port).toBe(p);
        expect(s.url.endsWith(`:${p}`)).toBe(true);
        return;
      } catch (e) {
        if (attempt >= 4 || (e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
      }
    }
  });
});
