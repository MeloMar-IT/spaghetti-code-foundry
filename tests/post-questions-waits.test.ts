import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { foundryDependsOn } from "../src/queue/deps.js";
import { parse } from "yaml";

const TOOL = resolve("tools/post-questions");
const LIB = resolve("dist/queue/waits-for.js");
const FAKE_GH = resolve("tests/fixtures/fake-gh.sh");
let tmp: string;
let log: string;

beforeEach(() => {
  if (!existsSync(LIB)) throw new Error("dist/queue/waits-for.js is missing — run `npm run build` first");
  tmp = mkdtempSync(join(tmpdir(), "post-questions-"));
  log = join(tmp, "gh.log");
  writeFileSync(log, "");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const git = (...args: string[]) =>
  spawnSync("git", args, { cwd: tmp, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
const makeRepo = (...messages: string[]) => {
  git("init", "-q");
  for (const m of messages) git("commit", "-q", "--allow-empty", "-m", m);
};

const issueList = (bodies: Record<number, string> = {}) =>
  JSON.stringify([6, 7, 8, 9].map((number) => ({ number, title: `Issue ${number}`, state: "OPEN", body: bodies[number] ?? "Text\n\n### Depends on\n" })));

function run(input: string, issues: string, list = issueList()) {
  return spawnSync(process.execPath, [TOOL], {
    input, cwd: tmp, encoding: "utf8",
    env: {
      PATH: process.env.PATH, FACTORY_GH_BIN: FAKE_GH, FAKE_GH_LOG: log, FAKE_GH_ISSUES: list,
      FACTORY_VAR_GITHUB_REPO: "o/r", FACTORY_VAR_ISSUES: issues, FACTORY_VAR_NEEDS_INFO_LABEL: "Factory_needs_info", FACTORY_RUN_ID: "r1",
      GIT_CEILING_DIRECTORIES: dirname(tmp),
    },
  });
}
const bodies = (): Record<string, string> => {
  const f = `${log}.issue-bodies.json`;
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
};
const savedBody = (n: number) => bodies()[`o/r#${n}`];
const comments = (n: number) => [...readFileSync(log, "utf8").matchAll(/^--- comment on #(\d+):\n([\s\S]*?)\n--- end comment$/gm)].filter((m) => m[1] === String(n)).map((m) => m[2]!);

describe("tools/post-questions with WAITS_FOR", () => {
  it("records a valid request without a comment and asks about an invalid one", () => {
    makeRepo("start");
    const r = run("### #7\nWAITS_FOR: #6\nWAITS_FOR_REASON: needs the API\nNO_QUESTIONS\n### #8\nWAITS_FOR: #8\n", "7 8");
    expect(r.status).toBe(0);
    expect(foundryDependsOn(savedBody(7)!)).toEqual([6]);
    expect(savedBody(7)).toContain("needs the API");
    expect(r.stdout).toContain("#7: waits for #6");
    expect(comments(7)).toEqual([]);
    const l = readFileSync(log, "utf8");
    expect(l).not.toMatch(/issue edit 7 .*--add-label/);
    const c = comments(8);
    expect(c).toHaveLength(1);
    expect(c[0]).toContain("**Q1.** The Foundry wanted #8 to wait for #8");
    expect(c[0]).toContain("- #8 is this issue itself.");
    expect(c[0]).toContain("**Recommendation:** Plan it now without waiting");
    expect(c[0]).not.toContain("WAITS_FOR");
    expect(l).toContain("issue edit 8 --repo o/r --add-label Factory_needs_info");
    expect(r.stdout.trim().endsWith("QUESTIONS: 1")).toBe(true);
  });

  it("asks the second issue of an in-batch loop", () => {
    makeRepo("start");
    const r = run("### #6\nWAITS_FOR: #7\n### #7\nWAITS_FOR: #6\n", "6 7");
    expect(r.status).toBe(0);
    expect(foundryDependsOn(savedBody(6)!)).toEqual([7]);
    expect(savedBody(7)).toBeUndefined();
    expect(comments(7)[0]).toContain("would make a loop");
    expect(comments(7)[0]).toContain("#7 → #6 → #7");
    expect(readFileSync(log, "utf8")).toContain("issue edit 7 --repo o/r --add-label Factory_needs_info");
    expect(r.stdout.trim().endsWith("QUESTIONS: 1")).toBe(true);
  });

  it("numbers the question after existing ones and ignores issues outside the batch", () => {
    makeRepo("start");
    const r = run("### #7\n**Q1. Which format?**\n**Kind:** product\nctx\n**Recommendation:** A — simple\nWAITS_FOR: #99\n### #8\nWAITS_FOR: #6\n", "7");
    expect(r.status).toBe(0);
    const c = comments(7)[0]!;
    expect(c).toContain("**Q1. Which format?**");
    expect(c).toMatch(/\*\*Q2\.\*\*[\s\S]*#99 was not found in this repository\./);
    expect(c).not.toContain("WAITS_FOR");
    expect(savedBody(8)).toBeUndefined();
    expect(comments(8)).toEqual([]);
  });

  it("records a valid wait and keeps the other questions", () => {
    makeRepo("start");
    const r = run("### #7\n**Q1. Which format?**\n**Kind:** product\nctx\n**Recommendation:** A — simple\nWAITS_FOR: #6\n", "7");
    expect(r.status).toBe(0);
    expect(foundryDependsOn(savedBody(7)!)).toEqual([6]);
    const c = comments(7);
    expect(c).toHaveLength(1);
    expect(c[0]).toContain("**Q1. Which format?**");
    expect(c[0]).not.toContain("WAITS_FOR");
    expect(c[0]).not.toContain("The Foundry wanted");
    expect(readFileSync(log, "utf8")).toContain("--add-label Factory_needs_info");
  });

  it("does not load the library or list issues without WAITS_FOR", () => {
    const r = run("### #7\nNO_QUESTIONS\n", "7");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("#7: no questions\nQUESTIONS: 0\n");
    expect(readFileSync(log, "utf8")).toBe("");
  });

  it("asks when WAITS_FOR names no issue", () => {
    makeRepo("start");
    run("### #7\nWAITS_FOR: none\n", "7");
    expect(comments(7)[0]).toContain("WAITS_FOR names no issue number.");
  });

  it("a rerun of a recorded request is asked, not silently accepted; the dependency is kept", () => {
    makeRepo("start");
    run("### #7\nWAITS_FOR: #6\n", "7");
    const list = issueList({ 7: savedBody(7)! });
    const again = run("### #7\nWAITS_FOR: #6\n", "7", list);
    expect(again.stdout).toContain("could not record the wait");
    expect(comments(7)[0]).toContain("#6 is already waited for");
    expect(foundryDependsOn(savedBody(7)!)).toEqual([6]);
  });

  it("asks when an open issue's work already landed", () => {
    makeRepo("start", "Resolve #6: the API");
    const r = run("### #7\nWAITS_FOR: #6\n", "7");
    expect(r.status).toBe(0);
    expect(savedBody(7)).toBeUndefined();
    expect(comments(7)[0]).toMatch(/#6 is still open, but its work already landed/);
  });

  it("records nothing when the commits cannot be read", () => {
    // no git repository here (GIT_CEILING_DIRECTORIES), so the landed-work check is impossible
    const r = run("### #7\nWAITS_FOR: #6\n", "7");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("note: could not read the commits of HEAD");
    expect(savedBody(7)).toBeUndefined();
    expect(comments(7)[0]).toContain("could not be read, so it is unknown whether the work already landed");
  });

  it("the epic-questions prompt describes WAITS_FOR", () => {
    const flow = parse(readFileSync(resolve("flows/epic-questions.yaml"), "utf8"));
    const prompt = flow.steps.find((s: { id: string }) => s.id === "ask").prompt as string;
    expect(prompt).toContain("WAITS_FOR: #<n>");
    expect(prompt).toContain("WAITS_FOR_REASON:");
  });
});
