import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commentFirst, commentText, nextStepEnv, reportFirst } from "../src/next-step.js";
// @ts-expect-error a plain ES module of the tools folder, without types
import { DECIDED_HEADING, commitPending, decideQuestions, decideRound, postPlan, readRecord } from "../tools/decide-questions.mjs";

const q = (n: number, title: string, kind: string, rec: string) => `**Q${n}. ${title}**\nSome text.\n**Kind:** ${kind}\n**Recommendation:** ${rec}\n`;
const ALL = q(1, "Which db?", "technical", "Use pg.") + "\n" + q(2, "Which lib?", "technical", "Use zod.");
const ALL2 = q(1, "Which queue?", "technical", "Use none.") + "\n" + q(2, "Which logger?", "technical", "Use pino.");
const MIXED = q(1, "Which db?", "technical", "Use pg.") + "\n" + q(2, "Who is the user?", "product", "none");
const MIXED2 = q(1, "Which db?", "technical", "Use pg.") + "\n" + q(2, "Who are the users now?", "product", "none");
const PRODUCT = q(1, "Who is the user?", "product", "none");

const base = (over: Record<string, string> = {}): Record<string, string> => ({
  ...(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>),
  FACTORY_VAR_ISSUE: "7", FACTORY_VAR_GITHUB_REPO: "owner/repo", FACTORY_RUN_ID: "r-1", FACTORY_DECIDE_TECHNICAL: "1", ...over,
});

/** A gh in memory: comments are kept, the issue view lists them as ours. */
function memGh(opts: { failComment?: boolean; badView?: boolean; after?: () => void } = {}) {
  const posted: string[] = [];
  const calls: string[][] = [];
  const gh = (args: string[], input?: string): string => {
    calls.push(args);
    if (args[1] === "comment") {
      if (opts.failComment) throw new Error("boom");
      posted.push(input ?? "");
      opts.after?.();
      return "";
    }
    return opts.badView ? "not json" : JSON.stringify({ comments: posted.map((body) => ({ body, viewerDidAuthor: true })), labels: [] });
  };
  return { gh, posted, calls };
}

describe("post-plan", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "post-plan-"));
    for (const [k, v] of Object.entries(nextStepEnv())) vi.stubEnv(k, v);
  });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

  const run = (text: string, g = memGh(), over: Record<string, string> = {}) => ({ ...postPlan(dir, text, base(over), g.gh), g });
  const last = (g: { posted: string[] }) => g.posted.at(-1)!.split("\n").filter(Boolean).at(-1)!;

  describe("child process", () => {
    const go = (args: string[], input: string, env: Record<string, string>) =>
      spawnSync(process.execPath, [resolve("tools/decide-questions.mjs"), ...args], { input, encoding: "utf8", env });
    const env = (over: Record<string, string> = {}) => base({
      ...nextStepEnv(), FACTORY_GH_BIN: resolve("tests/fixtures/fake-gh.sh"), FAKE_GH_LOG: join(dir, "gh.log"), FAKE_GH_COMMENTS_FROM_LOG: "1", ...over,
    });
    const comments = () => [...readFileSync(join(dir, "gh.log"), "utf8").matchAll(/--- comment on #7:\n([\s\S]*?)\n--- end comment/g)].map((m) => m[1]!);

    it("rejects missing and extra arguments", () => {
      for (const args of [[], ["post-plan", "a", "b"]]) {
        const r = go(args, "x", env());
        expect(r.status).toBe(2);
        expect(r.stderr).toContain("usage:");
      }
      expect(existsSync(join(dir, "gh.log"))).toBe(false);
    });

    it("posts the plain comment when the setting is off", () => {
      writeFileSync(join(dir, "decided-pending.json"), "{}");
      const r = go(["post-plan", dir], ALL, env({ FACTORY_DECIDE_TECHNICAL: "0" }));
      expect(r.status).toBe(0);
      expect(r.stdout).toBe(ALL);
      expect(existsSync(join(dir, "decided-pending.json"))).toBe(false);
      expect(existsSync(join(dir, "decided.json"))).toBe(false);
      const want = [commentFirst("planner_questions"), "", "🤖 **Spaghetti Code Foundry** needs more information before it can plan this issue:", "", ALL.replace(/\n+$/, ""), "", `_${commentText("planner_questions")}_`, "", "<!-- claude-factory run=r-1 -->"].join("\n");
      expect(comments().map((c) => c.trim())).toEqual([want.trim()]);
    });

    it("decides everything, and a second run posts nothing new", () => {
      const first = go(["post-plan", dir], ALL, env());
      expect(first.status).toBe(3);
      expect(first.stdout).toBe(decideQuestions(ALL).body + "\n");
      const [c] = comments();
      expect(c!.startsWith(reportFirst("decided"))).toBe(true);
      expect(c).toContain("decided these technical questions itself and plans the issue again:");
      expect(c).toContain("_Want a different answer?");
      expect(go(["post-plan", dir], ALL, env()).status).toBe(3);
      expect(comments()).toHaveLength(1);
      expect(readRecord(dir).rounds).toHaveLength(1);
    });
  });

  it("checks the environment", () => {
    const file = join(dir, "file");
    writeFileSync(file, "x");
    const cases: [string, Record<string, string>][] = [
      [dir, { FACTORY_VAR_ISSUE: "0" }], [dir, { FACTORY_VAR_ISSUE: "7a" }], [dir, { FACTORY_VAR_GITHUB_REPO: "owner" }],
      [dir, { FACTORY_RUN_ID: "a b" }], [join(dir, "missing"), {}], [file, {}],
    ];
    for (const [d, over] of cases) {
      const g = memGh();
      const r = postPlan(d, ALL, base(over), g.gh);
      expect(r.code, JSON.stringify(over)).toBe(2);
      expect(r.out).toMatch(/^post-plan: /);
      expect(g.calls).toEqual([]);
    }
  });

  describe("the plain comment", () => {
    const plain = (first: string, next: string, text: string) =>
      `${first}\n\n🤖 **Spaghetti Code Foundry** needs more information before it can plan this issue:\n\n${text}\n\n_${next}_\n\n<!-- claude-factory run=r-1 -->\n`;

    it("keeps the bytes of send_back with empty or missing formatting values", () => {
      vi.stubEnv("FACTORY_FIRST_PLANNER_QUESTIONS", "");
      const g = memGh();
      const env = base({ FACTORY_DECIDE_TECHNICAL: "0" });
      delete env.FACTORY_NEXT_PLANNER_QUESTIONS;
      const r = postPlan(dir, PRODUCT, env, g.gh);
      expect(r).toMatchObject({ code: 0, out: PRODUCT });
      expect(g.posted).toEqual([plain("", "", PRODUCT.replace(/\n+$/, ""))]);
      expect(g.posted[0]!.startsWith("\n\n🤖")).toBe(true);
    });

    it("drops all trailing newlines of the body, and returns the raw text", () => {
      for (const tail of ["", "\n", "\n\n\n"]) {
        const g = memGh();
        const text = "Why?" + tail;
        const r = run(text, g, { FACTORY_DECIDE_TECHNICAL: "0", FACTORY_NEXT_PLANNER_QUESTIONS: "go" });
        expect(r.out).toBe(text);
        expect(g.posted[0]).toBe(plain(nextStepEnv().FACTORY_FIRST_PLANNER_QUESTIONS!, "go", "Why?"));
      }
    });

    it("is used when nothing is decided, and the record is not touched", () => {
      const g = memGh();
      const r = run(PRODUCT, g);
      expect(r).toMatchObject({ code: 0, out: PRODUCT });
      expect(g.calls).toHaveLength(1);
      expect(g.posted[0]!.endsWith("<!-- claude-factory run=r-1 -->\n")).toBe(true);
      expect(existsSync(join(dir, "decided.json"))).toBe(false);
    });
  });

  it("asks the product question and shows what was decided (mixed)", () => {
    const g = memGh();
    const r = run(MIXED, g);
    expect(r.code).toBe(0);
    expect(r.out).toBe(decideQuestions(MIXED).body + "\n");
    const c = g.posted[0]!;
    expect(c.split("\n")[0]).toBe(commentFirst("planner_questions"));
    expect(c.indexOf("Who is the user?")).toBeLessThan(c.indexOf(DECIDED_HEADING));
    expect(last(g)).toMatch(/decided=[0-9a-f]{16} -->$/);
    const rec = readRecord(dir);
    expect(rec.rounds).toHaveLength(1);
    expect(rec.rounds[0]).toMatchObject({ outcome: "asked", issue: 7 });
    expect(run(MIXED, g)).toMatchObject({ code: 0 });
    expect(g.posted).toHaveLength(1);
  });

  it("posts a changed asked question again: the guard gives up and every question is asked", () => {
    const g = memGh();
    expect(run(MIXED, g).code).toBe(0);
    const r = run(MIXED2, g);
    expect(r.code).toBe(4);
    expect(g.posted).toHaveLength(2);
    expect(g.posted[1]).toContain("Who are the users now?");
    expect(g.posted[1]).not.toContain(DECIDED_HEADING);
    expect(last(g)).toMatch(/decided=/);
    expect(readRecord(dir).rounds.at(-1)).toMatchObject({ outcome: "gave_up", questions: [] });
  });

  it("posts a changed asked question after a crash before the commit", () => {
    const opts: { after?: () => void } = { after: () => { throw new Error("crash"); } };
    const g = memGh(opts);
    expect(run(MIXED, g).code).toBe(1); // posted, then the process died: the round is pending
    opts.after = undefined;
    expect(run(MIXED2, g).code).toBe(0);
    expect(g.posted).toHaveLength(2);
    expect(g.posted[1]).toContain("Who are the users now?");
    expect(readRecord(dir).rounds).toHaveLength(1);
  });

  it("does not post twice after a crash between posting and the commit", () => {
    const opts: { after?: () => void } = { after: () => { throw new Error("crash"); } };
    const g = memGh(opts);
    expect(run(ALL, g).code).toBe(1);
    opts.after = undefined;
    expect(run(ALL, g).code).toBe(3);
    expect(g.posted).toHaveLength(1);
    expect(readRecord(dir).rounds).toHaveLength(1);
  });

  it("a retry is found when the posted comment was edited but keeps its marker", () => {
    const g = memGh();
    expect(run(ALL, g).code).toBe(3);
    g.posted[0] = g.posted[0]!.replace("Spaghetti Code Foundry", "edited by a person");
    expect(run(ALL, g).code).toBe(3);
    expect(g.posted).toHaveLength(1);
  });

  it("a retry is found when the formatting values changed", () => {
    const g = memGh();
    expect(run(ALL, g).code).toBe(3);
    vi.stubEnv("FACTORY_FIRST_DECIDED", "changed first line");
    expect(run(ALL, g).code).toBe(3);
    expect(g.posted).toHaveLength(1);
    const other = mkdtempSync(join(tmpdir(), "post-plan-mixed-"));
    const m = memGh();
    try {
      expect(postPlan(other, MIXED, base({ FACTORY_NEXT_PLANNER_QUESTIONS: "first next" }), m.gh).code).toBe(0);
      expect(postPlan(other, MIXED, base({ FACTORY_NEXT_PLANNER_QUESTIONS: "changed next" }), m.gh).code).toBe(0);
      expect(m.posted).toHaveLength(1);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  describe("give up", () => {
    const seed = () => {
      for (const t of [ALL2.replace(/Which queue\?/, "Which cache?").replace(/Which logger\?/, "Which mailer?"), ALL2]) {
        const id = decideRound(dir, { issue: 7, source: "planner", outcome: "went_on", questions: decideQuestions(t).decided });
        commitPending(dir, id);
      }
    };

    it("posts the plain comment with the marker, records gave_up, and a retry posts nothing", () => {
      seed();
      const g = memGh();
      const r = run(ALL, g);
      expect(r.code).toBe(4);
      expect(r.out.startsWith("post-plan: the Foundry gave up")).toBe(true);
      expect(g.posted).toHaveLength(1);
      expect(g.posted[0]).toContain("needs more information before it can plan this issue:");
      expect(g.posted[0]).toContain("**Q1. Which db?**");
      expect(last(g)).toMatch(/^<!-- claude-factory run=r-1 decided=[0-9a-f]{16} -->$/);
      expect(readRecord(dir).rounds.at(-1)).toMatchObject({ outcome: "gave_up", questions: [], issue: 7 });
      expect(run(ALL, g).code).toBe(4);
      expect(g.posted).toHaveLength(1);
      expect(readRecord(dir).rounds).toHaveLength(3);
    });

    it("A, then B, then A again gives up", () => {
      const g = memGh();
      expect(run(ALL, g).code).toBe(3);
      expect(run(ALL2, g).code).toBe(3);
      expect(run(ALL, g).code).toBe(4);
      expect(g.posted).toHaveLength(3);
    });
  });

  describe("failures", () => {
    it("a failed post is an error and records nothing", () => {
      const r = run(ALL, memGh({ failComment: true }));
      expect(r.code).toBe(1);
      expect(r.out).toContain("boom");
      expect(existsSync(join(dir, "decided.json"))).toBe(false);
    });

    it("a failed commit is an error", () => {
      const g = memGh({ after: () => writeFileSync(join(dir, "decided.json"), "{") });
      expect(run(ALL, g).code).toBe(1);
    });

    it("a broken comment list posts nothing and writes nothing", () => {
      const g = memGh({ badView: true });
      expect(run(ALL, g).code).toBe(1);
      expect(g.posted).toEqual([]);
      expect(existsSync(join(dir, "decided-pending.json"))).toBe(false);
    });

    it("a corrupt record is an error before any post", () => {
      writeFileSync(join(dir, "decided.json"), "{");
      const g = memGh();
      expect(run(ALL, g).code).toBe(1);
      expect(g.calls).toEqual([]);
    });

    it("a timed-out post is an error, the pending round stays, and the retry does not post twice", () => {
      const g = memGh({ after: () => { throw new Error("spawnSync gh ETIMEDOUT"); } });
      const r = run(ALL, g);
      expect(r.code).toBe(1);
      expect(r.out).toContain("ETIMEDOUT");
      expect(existsSync(join(dir, "decided-pending.json"))).toBe(true);
      expect(existsSync(join(dir, "decided.json"))).toBe(false);
      const again = memGh();
      again.posted.push(...g.posted);
      expect(run(ALL, again).code).toBe(3);
      expect(again.posted).toHaveLength(1);
      expect(readRecord(dir).rounds).toHaveLength(1);
    });

    it("the default gh stops a call that takes too long", () => {
      mkdirSync(join(dir, "r"));
      const r = postPlan(join(dir, "r"), ALL, base({
        FACTORY_GH_BIN: resolve("tests/fixtures/fake-gh.sh"), FAKE_GH_LOG: join(dir, "gh.log"), FAKE_GH_SLEEP: "5", FACTORY_GH_TIMEOUT_MS: "300",
      }));
      expect(r.code).toBe(1);
      expect(r.out).toContain("ETIMEDOUT");
    });
  });
});
