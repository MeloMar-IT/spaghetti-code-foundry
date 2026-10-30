import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const TOOL = resolve("tools/story");
const STORE = resolve("dist/stories/store.js");
const FAKE_GH = resolve("tests/fixtures/fake-gh.sh");
let tmp: string;
let log: string;

beforeEach(() => {
  if (!existsSync(STORE)) throw new Error("dist/stories/store.js is missing — run `npm run build` first");
  tmp = mkdtempSync(join(tmpdir(), "story-tool-"));
  log = join(tmp, "gh.log");
  writeFileSync(log, "");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function run(args: string[], o: { input?: string; env?: Record<string, string | undefined>; tool?: string } = {}) {
  return spawnSync(process.execPath, [o.tool ?? TOOL, ...args], {
    input: o.input ?? "", cwd: tmp, encoding: "utf8",
    env: { PATH: process.env.PATH, FACTORY_GH_BIN: FAKE_GH, FAKE_GH_LOG: log, FACTORY_VAR_GITHUB_REPO: "o/r", FACTORY_VAR_ISSUE: "7", ...o.env } as NodeJS.ProcessEnv,
  });
}
const ghLog = () => readFileSync(log, "utf8");
const ISSUE = JSON.stringify({ number: 7, title: "T", body: "B", updatedAt: "2026-01-01T00:00:00Z" });

describe("tools/story reads", () => {
  it("view prints the issue JSON unchanged", () => {
    const r = run(["view"], { env: { FAKE_GH_ISSUE_JSON: ISSUE } });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${ISSUE}\n`);
    expect(ghLog()).toContain("gh issue view 7 --repo o/r --json body,number,title,updatedAt");
  });

  it("comments prints the lines unchanged, and an empty answer is empty", () => {
    const lines = '{"id":1,"body":"a"}\n{"id":2,"body":"b"}\n';
    expect(run(["comments"], { env: { FAKE_GH_ISSUE_COMMENTS_JSONL: lines } }).stdout).toBe(lines);
    const empty = run(["comments"], { env: { FAKE_GH_ISSUE_COMMENTS_JSONL: "" } });
    expect(empty.status).toBe(0);
    expect(empty.stdout).toBe("");
  });

  it("foundry-comments prints the ids", () => {
    const r = run(["foundry-comments"], { env: { FAKE_GH_FOUNDRY_COMMENTS_JSON: "[2]" } });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("[2]");
  });

  it("body and text print what gh prints", () => {
    const body = run(["body"], { env: { FAKE_GH_ISSUE_BODIES: JSON.stringify({ 7: "Do it" }) } });
    expect(body.stdout).toBe("Do it\n");
    const text = run(["text"]);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain("# #7: Add a feature\nhttps://github.com/owner/repo/issues/7\n");
    expect(ghLog()).toContain("--json number,title,body,url,labels,comments --jq");
  });

  it("a 404 gives exit 1, no stdout and gh's text", () => {
    const r = run(["view"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Not Found");
  });
});

describe("tools/story comment", () => {
  it("passes the text unchanged on stdin and prints the link", () => {
    const text = "a $(x) `y` \"q\" 'r'\nline two\n";
    const r = run(["comment"], { input: text });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("https://github.com/owner/repo/issues/7#issuecomment-1\n");
    expect(ghLog()).toContain("gh issue comment 7 --repo o/r --body-file -\n--- comment on #7:\n" + text);
  });

  it("shows gh's text when the call fails", () => {
    const r = run(["comment"], { input: "x", env: { FAKE_GH_FAIL: "issue comment", FAKE_GH_FAIL_TEXT: "gh exploded" } });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("gh exploded");
  });
});

describe("tools/story create", () => {
  it("creates with the text on stdin, labels as given, and prints the address", () => {
    const r = run(["create", "--title", "--odd $(x) title", "--label", "a", "--label", "b"], { input: "Body $(y)\nmore", env: { FACTORY_VAR_ISSUE: undefined } });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("https://github.com/owner/repo/issues/101\n");
    expect(ghLog()).toContain("--- created issue: issue create --repo o/r --title --odd $(x) title --body-file - --label a --label b\nBody $(y)\nmore");
  });

  it("works without a label", () => {
    expect(run(["create", "--title", "T"], { input: "x" }).status).toBe(0);
    expect(ghLog()).not.toContain("--label");
  });

  it("fails when gh cannot set a label", () => {
    const r = run(["create", "--title", "T", "--label", "nope"], { input: "x", env: { FAKE_GH_FAIL: "issue create", FAKE_GH_FAIL_TEXT: "could not add label" } });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("could not add label");
  });
});

describe("tools/story refuses bad input before gh runs", () => {
  it.each([
    [[], {}],
    [["constructor"], {}],
    [["nope"], {}],
    [["view", "extra"], {}],
    [["comment", "--body", "x"], {}],
    [["view"], { FACTORY_VAR_GITHUB_REPO: "" }],
    [["view"], { FACTORY_VAR_GITHUB_REPO: "o" }],
    [["view"], { FACTORY_VAR_GITHUB_REPO: "--repo" }],
    [["view"], { FACTORY_VAR_ISSUE: "" }],
    [["view"], { FACTORY_VAR_ISSUE: "0" }],
    [["view"], { FACTORY_VAR_ISSUE: "1;x" }],
    [["view"], { FACTORY_VAR_ISSUE: "--help" }],
    [["create"], {}],
    [["create", "--title"], {}],
    [["create", "--title", ""], {}],
    [["create", "--title", "T", "--unknown", "x"], {}],
    [["create", "--title", "T", "stray"], {}],
  ] as [string[], Record<string, string>][])("%j %j", (args, env) => {
    const r = run(args, { input: "x", env });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^story: /);
    expect(r.stdout).toBe("");
    expect(ghLog()).toBe("");
  });
});

describe("tools/story environment", () => {
  it("an empty FACTORY_GH_BIN means gh on the PATH", () => {
    const bin = join(tmp, "bin");
    mkdirSync(bin);
    copyFileSync(FAKE_GH, join(bin, "gh"));
    spawnSync("chmod", ["+x", join(bin, "gh")]);
    const r = run(["view"], { env: { FACTORY_GH_BIN: "", PATH: `${bin}:${process.env.PATH}`, FAKE_GH_ISSUE_JSON: ISSUE } });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${ISSUE}\n`);
  });

  it("says so when the compiled store is missing", () => {
    const lone = join(tmp, "lone");
    mkdirSync(lone);
    copyFileSync(TOOL, join(lone, "story"));
    const r = run(["view"], { tool: join(lone, "story") });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("story: could not load the story store");
    expect(ghLog()).toBe("");
  });
});
