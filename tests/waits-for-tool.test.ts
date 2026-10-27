import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { foundryDependsOn, mergeDependsOn } from "../src/queue/deps.js";

const TOOL = resolve("tools/waits-for");
const LIB = resolve("dist/queue/waits-for.js");
const FAKE_GH = resolve("tests/fixtures/fake-gh.sh");
const BODY = "Text\n\n### Depends on\n";
let tmp: string;
let log: string;

beforeEach(() => {
  if (!existsSync(LIB)) throw new Error("dist/queue/waits-for.js is missing — run `npm run build` first");
  tmp = mkdtempSync(join(tmpdir(), "waits-for-"));
  log = join(tmp, "gh.log");
  writeFileSync(log, "");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const git = (...args: string[]) =>
  spawnSync("git", args, { cwd: tmp, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
const makeRepo = (...messages: string[]) => {
  git("init", "-q", "-b", "main");
  for (const m of messages) git("commit", "-q", "--allow-empty", "-m", m);
};

const issueList = (over: Record<number, { state?: string; body?: string }> = {}) =>
  JSON.stringify([6, 7, 8, 9].map((number) => ({ number, title: `Issue ${number}`, state: over[number]?.state ?? "OPEN", body: over[number]?.body ?? BODY })));

function run(input: string, o: { list?: string; env?: Record<string, string>; args?: string[]; cwd?: string } = {}) {
  return spawnSync(process.execPath, [TOOL, ...(o.args ?? [])], {
    input, cwd: o.cwd ?? tmp, encoding: "utf8",
    env: {
      PATH: process.env.PATH, FACTORY_GH_BIN: FAKE_GH, FAKE_GH_LOG: log, FAKE_GH_ISSUES: o.list ?? issueList(),
      FACTORY_VAR_GITHUB_REPO: "o/r", FACTORY_VAR_ISSUE: "7", GIT_CEILING_DIRECTORIES: dirname(tmp),
      ...o.env,
    },
  });
}
const bodies = (): Record<string, string> => {
  const f = `${log}.issue-bodies.json`;
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
};
const savedBody = (n: number) => bodies()[`o/r#${n}`];
const lines = (s: string) => s.trim().split("\n");

describe("tools/waits-for", () => {
  it("records a valid wait without a comment and parks", () => {
    makeRepo("start");
    const r = run("Plan.\nWAITS_FOR: #6\nWAITS_FOR_REASON: needs the API\nPLAN_STATUS: WAITS_FOR\n");
    expect(r.status).toBe(0);
    const l = lines(r.stdout);
    expect(l[0]).toBe("WAITS_FOR: #6");
    expect(l.at(-1)).toBe("PARKED");
    expect(foundryDependsOn(savedBody(7)!)).toEqual([6]);
    expect(readFileSync(log, "utf8")).not.toContain("--- comment");
  });

  it("asks when the issue already waits for it", () => {
    makeRepo("start");
    run("WAITS_FOR: #6\n");
    const r = run("WAITS_FOR: #6\n", { list: issueList({ 7: { body: savedBody(7)! } }) });
    expect(r.status).toBe(0);
    expect(lines(r.stdout).at(-1)).toBe("QUESTION");
    expect(r.stdout).toContain("already waited for");
  });

  it("says unchanged when the wait is recorded already", () => {
    makeRepo("start");
    writeFileSync(`${log}.issue-bodies.json`, JSON.stringify({ "o/r#7": mergeDependsOn(BODY, [6], "x") }));
    const r = run("WAITS_FOR: #6\n");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Already recorded");
    expect(lines(r.stdout).at(-1)).toBe("PARKED");
    expect(readFileSync(log, "utf8")).not.toContain("issue edit 7");
  });

  it("asks about a wait for the issue itself", () => {
    makeRepo("start");
    const r = run("WAITS_FOR: #7\n");
    expect(r.status).toBe(0);
    expect(r.stdout.startsWith("The Foundry wanted #7 to wait for #7")).toBe(true);
    expect(r.stdout).toContain("#7 is this issue itself");
    expect(lines(r.stdout).at(-1)).toBe("QUESTION");
  });

  it("checks closed issues against the commits", () => {
    makeRepo("start");
    const closed = issueList({ 6: { state: "CLOSED" } });
    expect(run("WAITS_FOR: #6\n", { list: closed }).stdout).toContain("is closed, but no commit for it landed");
    git("commit", "-q", "--allow-empty", "-m", "Resolve #6");
    expect(run("WAITS_FOR: #6\n", { list: closed }).stdout).toContain("Nothing left to wait for");
  });

  it("looks at the commits of HEAD only", () => {
    makeRepo("start");
    git("checkout", "-q", "-b", "develop");
    git("commit", "-q", "--allow-empty", "-m", "Resolve #6");
    git("checkout", "-q", "main");
    const r = run("WAITS_FOR: #6\n");
    expect(lines(r.stdout).at(-1)).toBe("PARKED");
    git("checkout", "-q", "develop");
    expect(run("WAITS_FOR: #6\n", { list: issueList() }).stdout).toContain("is still open, but its work already landed");
  });

  it("asks about an unknown issue", () => {
    makeRepo("start");
    const r = run("WAITS_FOR: #99\n");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("was not found");
    expect(lines(r.stdout).at(-1)).toBe("QUESTION");
  });

  it("asks without calling gh when the line is missing or empty", () => {
    makeRepo("start");
    const a = run("Just a plan.\n");
    expect(a.stdout).toContain("The Foundry wanted #7 to wait for another story");
    expect(a.stdout).toContain("The plan has no WAITS_FOR: line.");
    const b = run("WAITS_FOR: none\n");
    expect(b.stdout).toContain("names no issue number");
    expect(readFileSync(log, "utf8")).toBe("");
  });

  it("fails on a gh failure and asks nothing", () => {
    makeRepo("start");
    const r = run("WAITS_FOR: #6\n", { env: { FAKE_GH_FAIL: "issue list", FAKE_GH_FAIL_TEXT: "HTTP 404: Not Found" } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("waits-for: gh failed: HTTP 404: Not Found");
    expect(r.stdout).not.toContain("QUESTION");
  });

  it("fails when the edit fails, and saves nothing", () => {
    makeRepo("start");
    const r = run("WAITS_FOR: #6\n", { env: { FAKE_GH_FAIL: "issue edit" } });
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain("QUESTION");
    expect(savedBody(7)).toBeUndefined();
  });

  it("fails outside a git repository, before any gh call", () => {
    const r = run("WAITS_FOR: #6\n", { cwd: dirname(tmp) });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("could not read the commits");
    expect(r.stdout).not.toContain("QUESTION");
    expect(readFileSync(log, "utf8")).toBe("");
  });

  it("fails on bad input", () => {
    makeRepo("start");
    for (const x of [{ env: { FACTORY_VAR_ISSUE: "abc" } }, { env: { FACTORY_VAR_GITHUB_REPO: "nope" } }, { args: ["x"] }]) {
      const r = run("WAITS_FOR: #6\n", x);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("waits-for:");
    }
  });
});
