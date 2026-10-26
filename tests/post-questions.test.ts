import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { countQuestions, nextStepEnv } from "../src/next-step.js";
import { parseQuestions } from "../src/turn-actions.js";
// @ts-expect-error plain JavaScript library
import { commitPending, decideQuestions, decideRound, roundId } from "../tools/decide-questions.mjs";

const TOOL = resolve("tools/post-questions");
const FAKE_GH = resolve("tests/fixtures/fake-gh.sh");
const env = nextStepEnv();
const TECH = "**Q1. Which hash?**\n**Kind:** technical\nPick one.\n**Recommendation:** sha256 — the default";
const PRODUCT = "**Q2. Who sees it?**\n**Kind:** product\nWho?\n**Recommendation:** admins — safer";
const MARKER_Q = "<!-- claude-factory run=r1 questions -->";

let dir: string;
let runDir: string;
let log: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "post-questions-"));
  runDir = join(dir, "run");
  mkdirSync(runDir);
  log = join(dir, "gh.log");
  writeFileSync(`${log}.issues.json`, JSON.stringify([{ number: 75, labels: [] }, { number: 76, labels: [] }]));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(sections: Record<string, string>, extra: Record<string, string> = {}, args: string[] = [runDir]) {
  const input = Object.entries(sections).map(([n, b]) => `### #${n}\n${b}\n`).join("\n");
  return spawnSync(process.execPath, [TOOL, ...args], {
    input, encoding: "utf8",
    env: {
      PATH: process.env.PATH, ...env,
      FACTORY_VAR_GITHUB_REPO: "owner/repo", FACTORY_VAR_ISSUES: "75 76", FACTORY_RUN_ID: "r1", FACTORY_VAR_NEEDS_INFO_LABEL: "needs",
      FACTORY_DECIDE_TECHNICAL: "1", FACTORY_GH_BIN: FAKE_GH, FAKE_GH_LOG: log, FAKE_GH_COMMENTS_FROM_LOG: "1", ...extra,
    },
  });
}
const logText = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
const comments = (issue: number) => [...logText().matchAll(/^--- comment on #(\d+):\n([\s\S]*?)\n--- end comment$/gm)].filter((m) => m[1] === String(issue)).map((m) => m[2]!);
const rounds = () => (existsSync(join(runDir, "decided.json")) ? JSON.parse(readFileSync(join(runDir, "decided.json"), "utf8")).rounds : []) as { id: string; issue: number; source: string; outcome: string; at: string; questions: unknown[] }[];

describe("post-questions", () => {
  it("all technical: a decided comment, no label, a committed round", () => {
    const r = run({ 75: TECH, 76: "NO_QUESTIONS" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("QUESTIONS: 0");
    const [c] = comments(75);
    expect(comments(75)).toHaveLength(1);
    const lines = c!.split("\n");
    expect(lines[0]).toBe(env.FACTORY_FIRST_DECIDED);
    expect(c).toContain("**Decided by the Foundry**");
    expect(c).toContain("**Decision:** sha256 — the default");
    expect(c).toContain("Each issue in this batch is decided on its own");
    expect(c).not.toContain("questions -->");
    expect(rounds()).toHaveLength(1);
    expect(rounds()[0]).toMatchObject({ issue: 75, source: "epic", outcome: "went_on" });
    expect(lines.at(-1)).toBe(`<!-- claude-factory run=r1 decided=${rounds()[0]!.id} -->`);
    expect(existsSync(join(runDir, "decided-pending.json"))).toBe(false);
    expect(logText()).not.toContain("--add-label");
  });

  it("mixed: one comment with both parts, the label, an asked round", () => {
    const r = run({ 75: `${TECH}\n\n${PRODUCT}` });
    expect(r.status).toBe(0);
    expect(comments(75)).toHaveLength(1);
    const c = comments(75)[0]!;
    const lines = c.split("\n");
    expect(lines[0]).toBe(env.FACTORY_FIRST_QUESTIONS);
    expect(c.indexOf("**Q2.")).toBeLessThan(c.indexOf("**Decided by the Foundry**"));
    expect(c).toContain(`_${env.FACTORY_NEXT_QUESTIONS}_`);
    expect(lines.at(-1)).toBe(MARKER_Q);
    expect(lines.at(-2)).toBe(`<!-- claude-factory run=r1 decided=${rounds()[0]!.id} -->`);
    expect(rounds()[0]!.outcome).toBe("asked");
    expect(readFileSync(`${log}.issues.json`, "utf8")).toContain("needs");
    expect(countQuestions(c)).toBe(1);
    const q = parseQuestions(c);
    expect(q).toHaveLength(1);
    expect(q[0]!.recommendation).not.toContain("Decided");
  });

  it("setting off or no run folder: exactly today's comment, no reading, no files", () => {
    const body = `${TECH}\n\n${PRODUCT}`;
    const today = [env.FACTORY_FIRST_QUESTIONS, "", "🤖 **Spaghetti Code Foundry** has questions before it builds this issue (asked up front for all issues in this batch):", "", body, "", `_${env.FACTORY_NEXT_QUESTIONS}_`, "", MARKER_Q].join("\n");
    expect(run({ 75: body }, { FACTORY_DECIDE_TECHNICAL: "0" }).status).toBe(0);
    expect(comments(75)).toEqual([today]);
    expect(logText()).not.toContain("issue view");
    expect(existsSync(join(runDir, "decided.json"))).toBe(false);
    expect(existsSync(join(runDir, "decided-pending.json"))).toBe(false);
    rmSync(log);
    expect(run({ 75: body }, {}, []).status).toBe(0);
    expect(comments(75)).toEqual([today]);
    expect(logText()).not.toContain("issue view");
  });

  it("gh fails: the round is not committed and the exit status is not 0", () => {
    const r = run({ 75: TECH }, { FAKE_GH_FAIL: "issue comment" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("post-questions: #75");
    expect(rounds()).toHaveLength(0);
    expect(comments(75)).toHaveLength(0);
    const v = run({ 75: TECH }, { FAKE_GH_FAIL: "issue view" });
    expect(v.status).not.toBe(0);
    expect(comments(75)).toHaveLength(0);
    expect(rounds()).toHaveLength(0);
  });

  it("a partly posted batch that is retried posts nothing twice", () => {
    const sections = { 75: TECH, 76: `${TECH}\n\n${PRODUCT}` };
    const first = run(sections, { FAKE_GH_FAIL_ON: "issue comment 76 " });
    expect(first.status).not.toBe(0);
    expect(comments(75)).toHaveLength(1);
    expect(rounds()).toHaveLength(1);
    const at = rounds()[0]!.at;
    expect(run(sections).status).toBe(0);
    expect(comments(75)).toHaveLength(1);
    expect(comments(76)).toHaveLength(1);
    expect(rounds()).toHaveLength(2);
    expect(new Set(rounds().map((x) => x.id)).size).toBe(2);
    expect(rounds().find((x) => x.issue === 75)!.at).toBe(at);
  });

  it("a crash after the post: the retry adds the missing label once and commits once", () => {
    const sections = { 76: `${TECH}\n\n${PRODUCT}` };
    expect(run(sections, { FAKE_GH_FAIL_ON: "issue edit 76 " }).status).not.toBe(0);
    expect(comments(76)).toHaveLength(1);
    expect(rounds()).toHaveLength(0);
    expect(readFileSync(`${log}.issues.json`, "utf8")).not.toContain("needs");
    expect(run(sections).status).toBe(0);
    expect(comments(76)).toHaveLength(1);
    expect(readFileSync(`${log}.issues.json`, "utf8")).toContain("needs");
    expect(rounds()).toHaveLength(1);
    const size = logText().length;
    const calls = (logText().match(/issue edit/g) ?? []).length;
    expect(run(sections).status).toBe(0);
    expect(comments(76)).toHaveLength(1);
    expect(rounds()).toHaveLength(1);
    expect(logText().length).toBeGreaterThanOrEqual(size);
    expect((logText().match(/issue edit/g) ?? []).length).toBe(calls);
  });

  describe("a marker written by someone else", () => {
    const marker = () => {
      const d = decideQuestions(TECH);
      const qs = d.decided.map(({ n, title, text, decision }: Record<string, unknown>) => ({ n, title, text, decision }));
      return `<!-- claude-factory run=r1 decided=${roundId(75, "epic", "went_on", qs)} -->`;
    };
    const seen = (c: Record<string, unknown>) => ({ FAKE_GH_COMMENTS_BY_ISSUE: JSON.stringify({ "owner/repo#75": { comments: [{ body: `x\n${marker()}`, ...c }] } }) });

    it("does not count when viewerDidAuthor is false", () => {
      expect(run({ 75: TECH }, seen({ viewerDidAuthor: false, author: { login: "mallory" } })).status).toBe(0);
      expect(comments(75)).toHaveLength(1);
      expect(rounds()).toHaveLength(1);
    });

    it("does not count when the login differs", () => {
      expect(run({ 75: TECH }, seen({ author: { login: "mallory" } })).status).toBe(0);
      expect(comments(75)).toHaveLength(1);
    });

    it("counts when the login is ours", () => {
      expect(run({ 75: TECH }, seen({ author: { login: "foundry-owner" } })).status).toBe(0);
      expect(comments(75)).toHaveLength(0);
      expect(rounds()).toHaveLength(1);
    });

    it("fails safely when gh cannot tell who wrote it", () => {
      const r = run({ 75: TECH }, { ...seen({ author: { login: "foundry-owner" } }), FAKE_GH_NO_USER: "1" });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("update gh");
      expect(comments(75)).toHaveLength(0);
      expect(rounds()).toHaveLength(0);
    });
  });

  it("the guard gives up: today's comment, the label and a gave_up round, once", () => {
    const prior = { issue: 75, source: "planner", outcome: "went_on", questions: [{ n: 1, title: "Which hash?", text: "x", decision: "y" }] };
    const id = decideRound(runDir, prior);
    commitPending(runDir, id);
    expect(run({ 75: TECH }).status).toBe(0);
    const c = comments(75)[0]!;
    expect(c).toContain("**Q1. Which hash?**");
    expect(c).not.toContain("**Decided by the Foundry**");
    expect(c).toContain("decided=");
    expect(c.split("\n").at(-1)).toBe(MARKER_Q);
    expect(rounds().map((x) => x.outcome)).toEqual(["went_on", "gave_up"]);
    expect(rounds()[1]!.questions).toEqual([]);
    const before = logText();
    expect(run({ 75: TECH }).status).toBe(0);
    expect(comments(75)).toHaveLength(1);
    expect((logText().match(/issue edit/g) ?? []).length).toBe((before.match(/issue edit/g) ?? []).length);
    expect(rounds()).toHaveLength(2);
  });

  it("an ambiguous section is asked as it is, and a retry does not post twice", () => {
    const body = `${TECH}\n\n${TECH}`;
    expect(run({ 75: body }).status).toBe(0);
    expect(comments(75)).toHaveLength(1);
    expect(comments(75)[0]).toContain("**Q1. Which hash?**");
    expect(rounds()).toHaveLength(0);
    expect(run({ 75: body }).status).toBe(0);
    expect(comments(75)).toHaveLength(1);
  });

  it("rejects bad input", () => {
    expect(run({ 75: TECH }, {}, [runDir, "extra"])).toMatchObject({ status: 1 });
    const missing = run({ 75: TECH }, {}, [join(dir, "nope")]);
    expect(missing.status).toBe(1);
    expect(logText()).toBe("");
    writeFileSync(join(runDir, "decided.json"), "{ not json");
    const bad = run({ 75: TECH });
    expect(bad.status).toBe(1);
    expect(comments(75)).toHaveLength(0);
  });
});
