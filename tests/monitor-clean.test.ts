import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reposPath } from "../src/auth/repos.js";
import { usersPath } from "../src/auth/users.js";
import { ConfigSchema } from "../src/config.js";
import { BLOCKED, makeRedactor } from "../src/credentials/redact.js";
import { blockedWords, cleanLines, cleanTestNames, cleanText, collectNames, cutLine, safeWords, type Names } from "../src/monitor/clean.js";

// Built at run time so this file never holds a key-shaped string.
const TOKEN = "ghp_" + "a1B2c3D4e5".repeat(4);
const names: Names = {
  target: "melo/foundry",
  users: ["Jane Doe"],
  emails: ["jane@acme.example"],
  repos: ["acme/secret-app", "melo/foundry"],
  watchers: ["jane-issues"],
  complete: true,
};
const scan = async (t: string) => t;

describe("cleanText", () => {
  it("replaces other repositories and their issues, keeps the target", () => {
    expect(cleanText("failed in acme/secret-app", names)).toBe("failed in another repository");
    expect(cleanText("see https://github.com/acme/secret-app/issues/12", names)).toBe("see an issue");
    expect(cleanText("see acme/secret-app#12", names)).toBe("see an issue");
    expect(cleanText("see melo/foundry#12 and https://github.com/melo/foundry/issues/3", names)).toBe("see melo/foundry#12 and https://github.com/melo/foundry/issues/3");
    expect(cleanText("watching melo/foundry", names)).toBe("watching melo/foundry");
  });

  it("removes e-mail addresses, home folders, tokens, user names and watcher ids", () => {
    const out = cleanText(`mail jane@acme.example in /Users/jane/work/x with ${TOKEN} by @jane (Jane Doe) via jane-issues at https://evil.example/x?a=1`, names);
    for (const bad of ["jane@acme.example", "/Users/jane", "ghp_", "@jane", "Jane Doe", "jane-issues"]) expect(out).not.toContain(bad);
    expect(out).toContain("<url>");
    expect(cleanText("at /home/bob/app.js", names)).toBe("at <path>");
  });
});

describe("cutLine", () => {
  it("cuts a line to the part that says what went wrong", () => {
    expect(cutLine('2026-10-01T12:00:00Z [mon] ! step "build" failed: exit code 1\n  at foo')).toBe("exit code 1");
    expect(cutLine("Error: connection refused")).toBe("connection refused");
    expect(cutLine("x".repeat(300))).toHaveLength(160);
  });
});

describe("safeWords", () => {
  it("keeps words of the list and hides every other word", () => {
    expect(safeWords("exit code 1")).toBe("exit code 1");
    expect(safeWords("ENOENT: file not found")).toBe("ENOENT: file not found");
    expect(safeWords("HTTP 502 bad gateway")).toBe("HTTP 502 bad gateway");
    expect(safeWords("output did not match pass_if /ok/")).toBe("output did not match pass_if …");
    expect(safeWords("permission denied for hans")).toBe("permission denied for …");
    expect(safeWords("cannot push to zeta/hidden-app")).toBe("cannot push to …");
    expect(safeWords("branch factory/feature-x not found")).toBe("branch … not found");
  });

  it("gives nothing for a line of unknown words", () => {
    expect(safeWords("zeta qwerty plugh")).toBeUndefined();
  });
});

describe("cleanLines", () => {
  const ok = { redactor: () => makeRedactor([]), scan };

  it("cleans lines", async () => {
    const out = await cleanLines([`step "x" failed: cannot read /Users/jane/a.txt of acme/secret-app ${TOKEN}`], names, ok);
    expect(out).toBeDefined();
    const text = out!.join("\n");
    for (const bad of ["jane", "secret-app", "ghp_", "/Users"]) expect(text).not.toContain(bad);
    expect(text).toContain("cannot");
  });

  it("is not certain when the names are incomplete, the redactor is blocked, the scan fails, something is left or no line is left", async () => {
    expect(await cleanLines(["exit code 1"], { ...names, complete: false }, ok)).toBeUndefined();
    expect(await cleanLines(["exit code 1"], names, { ...ok, redactor: () => BLOCKED })).toBeUndefined();
    expect(await cleanLines(["exit code 1"], names, { ...ok, scan: () => Promise.reject(new Error("no")) })).toBeUndefined();
    // a scan that brings a mail back
    expect(await cleanLines(["exit code 1"], names, { ...ok, scan: async () => "exit code bob@x.example" })).toBeUndefined();
    // a scan that changes the number of lines
    expect(await cleanLines(["exit code 1"], names, { ...ok, scan: async () => "a\nb" })).toBeUndefined();
    expect(await cleanLines(["qwerty plugh"], names, ok)).toBeUndefined();
    expect(await cleanLines([], names, ok)).toBeUndefined();
    expect(await cleanLines(undefined, names, ok)).toBeUndefined();
    expect(await cleanLines(["exit code 1"], names, { ...ok, redactor: () => { throw new Error("x"); } })).toBeUndefined();
  });

  it("hides a short registered name, the basename and owner of another repository, and an invented placeholder", async () => {
    const n: Names = { ...names, users: ["An"], repos: ["acme/secret", "melo/foundry"], emails: [] };
    const out = await cleanLines(["An said cannot read repository secret of acme because <privatecustomer> failed with error"], n, ok);
    const text = out!.join(" ");
    for (const bad of [/\ban\b/i, /secret/, /acme/, /privatecustomer/]) expect(text).not.toMatch(bad);
    expect(text).toContain("cannot");
    expect(cleanText("An wrote this", n)).toBe("<user> wrote this");
    // the words of the target repository's own name are not blocked
    expect(blockedWords(n).has("foundry")).toBe(false);
    expect(blockedWords(n)).toEqual(expect.objectContaining({}));
    expect(blockedWords(n).has("secret")).toBe(true);
    expect(safeWords("<path> <email> <user> <url> <token> <x>")).toBe("<path> <email> <user> <url> <token> …");
  });

  it("hides stored secrets with the redactor", async () => {
    const out = await cleanLines(["cannot use sekrit-value-1234 here"], names, { redactor: () => makeRedactor(["sekrit-value-1234"]), scan });
    expect(out?.join(" ")).not.toContain("sekrit");
  });

  it("works with the real secret scan", async () => {
    const out = await cleanLines([`token ${TOKEN} denied`], names, { redactor: () => makeRedactor([]) });
    expect(out?.join(" ")).not.toContain("ghp_");
  });
});

describe("cleanTestNames", () => {
  const ok = { redactor: () => makeRedactor([]), scan };
  const NPM = "npm_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";

  it("keeps a plain test name and removes or drops private data", async () => {
    const out = await cleanTestNames(
      [
        "tests/a.test.ts > adds numbers",
        "tests/b.test.ts > mails jane@acme.example",
        "reads /Users/jane/x.json",
        "asks @someone",
        "Jane Doe fails",
        "uses acme/secret-app",
        "C:\\private-project\\customer-data.json",
        "\\\\server\\share\\a.txt",
        "reads /etc/passwd",
        `token ${TOKEN}`,
        "hash " + "ab".repeat(16),
        "visit https://evil.example/x",
        "with jane-issues",
        "back `tick` name",
      ],
      names,
      ok,
    );
    const text = out!.join("\n");
    expect(out).toContain("tests/a.test.ts > adds numbers");
    for (const bad of ["jane", "Jane", "acme.example", "/Users", "someone", "secret-app", "private-project", "customer-data", "C:", "server", "/etc", "ghp_", "ab".repeat(16), "evil.example", "`"]) expect(text).not.toContain(bad);
    expect(out).toContain("back 'tick' name");
  });

  it("drops a stored secret and a name that is too long, instead of cutting it", async () => {
    const r = makeRedactor(["hunter2hunter2"]);
    const long = "x".repeat(190) + " " + NPM;
    expect(long.length).toBeGreaterThan(200);
    const out = await cleanTestNames(["uses hunter2hunter2", long, "fine name"], names, { redactor: () => r, scan });
    expect(out).toEqual(["uses [redacted]", "fine name"]);
    expect(await cleanTestNames([NPM, "ok"], names, ok)).toEqual(["ok"]);
  });

  it("takes the first line only and at most 20 names", async () => {
    expect(await cleanTestNames(["first line\nsecond line"], names, ok)).toEqual(["first line"]);
    const out = await cleanTestNames(Array.from({ length: 25 }, (_, i) => `test number ${i}`), names, ok);
    expect(out).toHaveLength(20);
  });

  it("is not certain when the names are incomplete, the redactor is blocked, the scan fails or misleads, or nothing is left", async () => {
    expect(await cleanTestNames(["a"], { ...names, complete: false }, ok)).toBeUndefined();
    expect(await cleanTestNames(undefined, names, ok)).toBeUndefined();
    expect(await cleanTestNames(["a"], names, { ...ok, redactor: () => BLOCKED })).toBeUndefined();
    expect(await cleanTestNames(["a"], names, { ...ok, scan: () => Promise.reject(new Error("no")) })).toBeUndefined();
    expect(await cleanTestNames(["a"], names, { ...ok, scan: async () => "a\nb" })).toBeUndefined();
    expect(await cleanTestNames(["a"], names, { ...ok, scan: async () => "bob@x.example" })).toBeUndefined();
    expect(await cleanTestNames(["C:\\x\\y"], names, ok)).toBeUndefined();
    expect(await cleanTestNames([], names, ok)).toBeUndefined();
  });
});

describe("collectNames", () => {
  let dirs: string[] = [];
  beforeEach(() => {
    dirs = [];
  });
  afterEach(() => {
    for (const f of [usersPath(), reposPath()]) rmSync(f, { force: true });
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const config = ConfigSchema.parse({ watchers: [{ id: "w1", source: "issues", github_repo: "own/repo" }] });

  it("reads users, repositories and watcher ids", () => {
    mkdirSync(dirname(usersPath()), { recursive: true });
    writeFileSync(usersPath(), JSON.stringify({ version: 1, users: [{ id: crypto.randomUUID(), name: "Jane Doe", email: "jane@acme.example", role: "admin", status: "active", created: new Date().toISOString(), lastSignIn: null }] }));
    writeFileSync(reposPath(), JSON.stringify({ version: 1, repos: { [crypto.randomUUID()]: ["zeta/hidden-app"] } }));
    const n = collectNames("own/repo", config);
    expect(n.complete).toBe(true);
    expect(n.users).toContain("Jane Doe");
    expect(n.emails).toContain("jane@acme.example");
    expect(n.repos).toEqual(expect.arrayContaining(["zeta/hidden-app", "own/repo"]));
    expect(n.watchers).toContain("w1");
  });

  it("is not complete when users.json cannot be read", () => {
    mkdirSync(dirname(usersPath()), { recursive: true });
    writeFileSync(usersPath(), "{ not json");
    expect(collectNames("own/repo", config).complete).toBe(false);
    const d = mkdtempSync(join(tmpdir(), "x-"));
    dirs.push(d);
  });
});
