import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readIssueFiles } from "../src/context/issue-files.js";
import { render } from "../src/engine/template.js";

const FLOWS = ["issue-gitflow", "issue-plan", "issue-code-daily"];
const L1 = 'node "$FACTORY_TOOLS/story" view > "{{run.dir}}/issue.json" 2>/dev/null || rm -f "{{run.dir}}/issue.json"';
const L2 = 'node "$FACTORY_TOOLS/story" comments > "{{run.dir}}/issue-comments.jsonl" 2>/dev/null || rm -f "{{run.dir}}/issue-comments.jsonl"';
const L3 = 'node "$FACTORY_TOOLS/story" foundry-comments > "{{run.dir}}/issue-foundry-comments.json" 2>/dev/null || rm -f "{{run.dir}}/issue-foundry-comments.json"';

function pullTicketScript(flow: string): string {
  const doc = parse(readFileSync(resolve("flows", `${flow}.yaml`), "utf8")) as { steps: { id: string; run?: string }[] };
  const step = doc.steps.find((s) => s.id === "pull_ticket");
  if (!step?.run) throw new Error(`no pull_ticket in ${flow}`);
  return step.run;
}

const ISSUE = { body: "Please add", number: 12, title: "Add a feature", updatedAt: "2026-10-01T10:00:00Z" };
const comment = (id: number) =>
  JSON.stringify({ id, html_url: `https://github.com/owner/repo/issues/12#issuecomment-${id}`, created_at: "2026-10-01T11:00:00Z", updated_at: "2026-10-02T10:00:00Z", body: "hi" });

let dir: string;
let bin: string;
let runDir: string;
let log: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pull-ticket-files-"));
  bin = join(dir, "bin");
  runDir = join(dir, "run");
  log = join(dir, "gh.log");
  mkdirSync(bin);
  mkdirSync(runDir);
  symlinkSync(resolve("tests/fixtures/fake-gh.sh"), join(bin, "gh"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function runScript(extra: Record<string, string> = {}) {
  const rendered = render(pullTicketScript("issue-gitflow"), { run: { dir: runDir } });
  return spawnSync("sh", ["-c", rendered], {
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, FACTORY_TOOLS: resolve("tools"), FAKE_GH_LOG: log, FACTORY_VAR_ISSUE: "12", FACTORY_VAR_GITHUB_REPO: "owner/repo", ...extra },
  });
}

describe("pull_ticket saves the issue files", () => {
  it.each(FLOWS)("%s: the two lines come right after case, before any other gh line", (flow) => {
    const lines = pullTicketScript(flow).split("\n").map((l) => l.trim());
    const i = lines.findIndex((l) => l.startsWith('case "$FACTORY_VAR_ISSUE"'));
    expect(i).toBeGreaterThanOrEqual(0);
    expect(lines[i + 1]).toBe(L1);
    expect(lines[i + 2]).toBe(L2);
    expect(lines[i + 3]).toBe(L3);
    expect(lines.filter((l) => l === L3)).toHaveLength(1);
    const text = lines.findIndex((l) => l === 'node "$FACTORY_TOOLS/story" text');
    expect(text).toBeGreaterThan(i + 3);
    expect(lines.slice(text + 1).some((l) => l.includes("gh "))).toBe(false);
    expect(lines.some((l) => /\bgh\s/.test(l))).toBe(false);
    expect(lines.filter((l) => l === L1)).toHaveLength(1);
    expect(lines.filter((l) => l === L2)).toHaveLength(1);
    const body = lines.findIndex((l) => l.includes("issue-body.md") && l.includes('story" body'));
    if (flow === "issue-code-daily") expect(body).toBeGreaterThan(i + 2);
  });

  it("saves both files when gh answers, and readIssueFiles reads them", () => {
    const none = runScript();
    const r = runScript({ FAKE_GH_ISSUE_JSON: JSON.stringify(ISSUE), FAKE_GH_ISSUE_COMMENTS_JSONL: `${comment(1)}\n${comment(2)}\n` });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(none.stdout);
    const read = readIssueFiles(runDir, 12, "2026-10-26T00:00:00Z");
    expect(read).toHaveProperty("ok");
    if (!("ok" in read)) return;
    expect(read.ok.leftComments).toBe(0);
    expect(read.ok.issue.text).toBe("Add a feature\n\nPlease add");
    expect(read.ok.issue.version).toBe("2026-10-01T10:00:00Z");
    expect(read.ok.issue.comments).toHaveLength(2);
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("gh issue view 12 --repo owner/repo --json body,number,title,updatedAt");
    expect(calls).toContain("gh api --paginate repos/owner/repo/issues/12/comments?per_page=100");
  });

  it("saves the Foundry comment ids, and readIssueFiles marks them", () => {
    const none = runScript();
    const vars = { FAKE_GH_ISSUE_JSON: JSON.stringify(ISSUE), FAKE_GH_ISSUE_COMMENTS_JSONL: `${comment(1)}\n${comment(2)}\n` };
    const r = runScript({ ...vars, FAKE_GH_FOUNDRY_COMMENTS_JSON: "[2]" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(none.stdout);
    expect(readFileSync(join(runDir, "issue-foundry-comments.json"), "utf8")).toBe("[2]");
    const read = readIssueFiles(runDir, 12, "2026-10-26T00:00:00Z");
    if (!("ok" in read)) throw new Error("not read");
    expect(read.ok.issue.comments![0]).not.toHaveProperty("foundry");
    expect(read.ok.issue.comments![1]).toHaveProperty("foundry", true);
  });

  it("a failed call removes an old Foundry list", () => {
    writeFileSync(join(runDir, "issue-foundry-comments.json"), "[1]");
    expect(runScript().status).toBe(0);
    expect(existsSync(join(runDir, "issue-foundry-comments.json"))).toBe(false);
  });

  it("without the variables: exit 0, same stdout, no files", () => {
    const r = runScript();
    expect(r.status).toBe(0);
    expect(r.stdout.startsWith("# #12: Add a feature")).toBe(true);
    expect(r.stderr).not.toContain("404");
    expect(existsSync(join(runDir, "issue.json"))).toBe(false);
    expect(existsSync(join(runDir, "issue-comments.jsonl"))).toBe(false);
    expect(existsSync(join(runDir, "issue-foundry-comments.json"))).toBe(false);
    expect(readIssueFiles(runDir, 12, "2026-10-26T00:00:00Z")).toEqual({ failed: "issue-unreadable" });
  });

  it("an empty comments answer gives a 0-byte file", () => {
    const r = runScript({ FAKE_GH_ISSUE_JSON: JSON.stringify(ISSUE), FAKE_GH_ISSUE_COMMENTS_JSONL: "" });
    expect(r.status).toBe(0);
    expect(statSync(join(runDir, "issue-comments.jsonl")).size).toBe(0);
    const read = readIssueFiles(runDir, 12, "2026-10-26T00:00:00Z");
    expect(read).toHaveProperty("ok");
    if ("ok" in read) expect(read.ok.issue.comments).toHaveLength(0);
  });

  it("a failed fetch removes an old file", () => {
    writeFileSync(join(runDir, "issue.json"), "{}");
    writeFileSync(join(runDir, "issue-comments.jsonl"), "{}\n");
    expect(runScript().status).toBe(0);
    expect(existsSync(join(runDir, "issue.json"))).toBe(false);
    expect(existsSync(join(runDir, "issue-comments.jsonl"))).toBe(false);
  });
});
