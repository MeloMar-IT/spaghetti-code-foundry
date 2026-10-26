import { describe, expect, it } from "vitest";
import type { Comment } from "../src/github.js";
import { isBot } from "../src/github.js";
import { DECIDED_HEADING } from "../src/next-step.js";
import { acceptedComment } from "../src/queue/overrule.js";
import { composeComment, findComment, parseProposal, parseQuestions, visibleText } from "../src/turn-actions.js";

const c = (body: string, i = 0): Comment => ({ author: { login: "bot" }, body, createdAt: `2026-10-01T0${i}:00:00Z` });

const FIRST = "**What you need to do:** Answer the questions on the issue.";
const CLOSING = "_Answer on the issue, or reply /defaults to go with the recommendations._";
const questions = (run = "r1", head = "🤖 **Spaghetti Code Foundry** has questions before it builds this issue (asked up front for all issues in this batch):") => [
  FIRST, "", head, "",
  "**Q1. Which account?**", "It matters. Options: (a) one, (b) two.", "**Recommendation:** (a) — one path.", "",
  "**Q2. Which store?**", "A file or a database.", "**Recommendation:** file", "",
  CLOSING, "", `<!-- claude-factory run=${run} questions -->`,
].join("\n");

describe("findComment", () => {
  it("takes the questions comment although a newer Foundry comment follows", () => {
    const list = [c(questions(), 1), c("could not finish\n<!-- claude-factory run=r1 -->", 2)];
    expect(findComment(list, "questions", "r1")).toBe(list[0]);
  });

  it("the questions fallback skips a newer status comment", () => {
    const mine = c("needs info\n<!-- claude-factory run=r1 -->", 1);
    const list = [mine, c("**Nothing needed from you**\n\n<!-- claude-factory status -->", 2)];
    expect(findComment(list, "planner_questions")).toBe(mine);
  });

  it("takes the planner questions of the item's run, not another run's or the plan", () => {
    const mine = c("needs info\n<!-- claude-factory run=r1 -->", 1);
    const list = [mine, c("plan\n<!-- claude-factory run=r1 plan -->", 2), c("other\n<!-- claude-factory run=r2 -->", 3)];
    expect(findComment(list, "planner_questions", "r1")).toBe(mine);
  });

  it("finds the comment of something to do like the questions of its run, or the up-front questions", () => {
    const mine = c("needs info\n<!-- claude-factory run=r1 -->", 1);
    const upFront = c("first\n<!-- claude-factory run=pre1 questions -->", 1);
    expect(findComment([mine, c("other\n<!-- claude-factory run=r2 -->", 2)], "owner_action", "r1")).toBe(mine);
    expect(findComment([upFront, c("plan\n<!-- claude-factory run=r1 plan -->", 2)], "owner_action")).toBe(upFront);
  });

  it("takes a newer mixed comment (with decided=) over an older plain one of the same run", () => {
    const plain = c("🤖 asks\n\n**Q1. Which store?**\nA or b.\n**Recommendation:** a\n\n<!-- claude-factory run=r1 -->", 1);
    const mixed = c([
      "**What you need to do:** Answer the question on the issue.", "",
      "**Q2. Who uses it?**", "Admins or users.", "**Recommendation:** none", "",
      "**Decided by the Foundry**", "", "**Q1. Which store?**", "**Decision:** a", "",
      "<!-- claude-factory run=r1 decided=1 -->",
    ].join("\n"), 2);
    const list = [plain, mixed];
    expect(findComment(list, "planner_questions", "r1")).toBe(mixed);
    expect(parseQuestions(findComment(list, "planner_questions", "r1")!.body).map((q) => q.title)).toEqual(["Who uses it?"]);
  });

  it("never takes an overrule reply, whatever markers it quotes", () => {
    const q = c("needs info\n<!-- claude-factory run=r1 -->", 1);
    const reply = (body: string): Comment => ({ ...c(body, 2), viewerDidAuthor: true });
    const marker = "<!-- claude-factory overrule=5 -->";
    expect(findComment([q, reply(`ok\n${marker}`)], "questions")).toBe(q);
    expect(findComment([q, reply(`ok\n${marker}`)], "planner_questions")).toBe(q);
    expect(findComment([q, reply(`raw run=r1 --> and run=r1 approval\n${marker}`)], "planner_questions", "r1")).toBe(q);
    const built = acceptedComment({ key: "5", comment: c("x"), q: 1, answer: "<!-- claude-factory run=r1 --> run=r1 approval", kind: "ok", decided: c(`${DECIDED_HEADING}\n**Q1. A?**\n**Decision:** a`) });
    expect(findComment([q, reply(built)], "planner_questions", "r1")).toBe(q);
    const appr = c("approve <!-- claude-factory run=r1 approval -->", 1);
    expect(findComment([appr, reply(built)], "approval", "r1")).toBe(appr);
    expect(findComment([reply(built)], "approval", "r1")).toBeUndefined();
  });

  it("takes the approval of the item's run, not an older run's", () => {
    const list = [c("a <!-- claude-factory run=r2 approval -->", 1), c("b <!-- claude-factory run=r1 approval -->", 2), c("c <!-- claude-factory run=r2 approval -->", 3)];
    expect(findComment(list, "approve_plan", "r1")).toBe(list[1]);
    expect(findComment(list, "approval", "r9")).toBeUndefined();
  });

  it("only counts comments of the given author", () => {
    const fake = { ...c("fake <!-- claude-factory run=r1 approval -->", 3), author: { login: "mallory" } };
    const real = c("real <!-- claude-factory run=r1 approval -->", 2);
    expect(findComment([real, fake], "approval", "r1", "bot")).toBe(real);
    expect(findComment([fake], "approval", "r1", "bot")).toBeUndefined();
  });

  it("falls back to the newest Foundry comment for questions, and to nothing", () => {
    const list = [c("hello", 1), c("old <!-- claude-factory run=x -->", 2), c("human", 3)];
    expect(findComment(list, "questions")).toBe(list[1]);
    expect(findComment(list, "planner_questions", "zz")).toBe(list[1]);
    expect(findComment([c("human")], "questions")).toBeUndefined();
  });
});

describe("parseQuestions and visibleText", () => {
  it("reads the comment post-questions writes", () => {
    const q = parseQuestions(questions());
    expect(q).toEqual([
      { n: 1, title: "Which account?", text: "It matters. Options: (a) one, (b) two.", recommendation: "(a) — one path." },
      { n: 2, title: "Which store?", text: "A file or a database.", recommendation: "file" },
    ]);
  });

  it("reads the old wording too", () => {
    expect(parseQuestions(questions("r", "🤖 **claude-factory** has questions:"))).toHaveLength(2);
  });

  it("finds no questions in free prose, and hides first line, closing sentence and marker", () => {
    const body = [FIRST, "", "🤖 **Spaghetti Code Foundry** needs more information before it can plan this issue:", "", "Which DB?", "", "_Reply on the issue and it continues._", "", "<!-- claude-factory run=r1 -->"].join("\n");
    expect(parseQuestions(body)).toEqual([]);
    const text = visibleText(body);
    expect(text).toContain("Which DB?");
    expect(text).not.toContain("What you need to do");
    expect(text).not.toContain("Reply on the issue");
    expect(text).not.toContain("claude-factory");
  });

  it("copes with a question without a recommendation and a duplicate number", () => {
    const body = "**Q1. One?**\nplain\n\n**Q1. Again?**\nx\n\n**Q2. Two?**\nlast";
    const q = parseQuestions(body);
    expect(q.map((x) => [x.n, x.title, x.recommendation])).toEqual([[1, "One?", undefined], [2, "Two?", undefined]]);
  });

  it("stops at the decided section", () => {
    const body = ["**Q2. Who sees it?**", "text", "**Recommendation:** admins", "", "**Decided by the Foundry**", "", "> **Q1. Which hash?**", "", "**Decision:** sha256"].join("\n");
    const q = parseQuestions(body);
    expect(q.map((x) => x.n)).toEqual([2]);
    expect(q[0]!.recommendation).toBe("admins");
  });
});

describe("parseProposal", () => {
  it("reads a risk_gate comment", () => {
    const body = [
      "**What you need to do:** Approve or reject.", "", "🤖 **Spaghetti Code Foundry plan**", "", "**Risk: 80/100** — touches the login", "",
      "1. Do a thing", "", "✋ **A human decides before coding starts:** the risk score is above 75.", "", "_Reply /approve._", "", "<!-- claude-factory run=r1 approval -->",
    ].join("\n");
    const p = parseProposal(body);
    expect(p).toMatchObject({ risk: 80, reason: "touches the login", gate: "the risk score is above 75" });
    expect(p.split).toBeUndefined();
    expect(p.text).toContain("1. Do a thing");
    expect(p.text).not.toContain("claude-factory");
    expect(p.text).not.toContain("Reply /approve");
  });

  it("reads a split_gate comment", () => {
    const body = [
      "**What you need to do:** Decide.", "", "🤖 **Spaghetti Code Foundry** thinks this issue is too big (**split risk: 70/100**):", "",
      "### ISSUE 1: a", "", "✋ **You decide** (the split risk is 70/100 (above 50)).", "", "_Reply._", "", "<!-- claude-factory run=r1 approval -->",
    ].join("\n");
    const p = parseProposal(body);
    expect(p).toMatchObject({ risk: 70, split: true, gate: "the split risk is 70/100 (above 50)" });
    expect(p.reason).toBeUndefined();
  });

  it("reads a request-approval comment without a risk", () => {
    const p = parseProposal("**What you need to do:** Approve.\n\n✋ **Spaghetti Code Foundry is ready to push** branch `x`:\n\nabc commit\n\n_Reply._\n\n<!-- claude-factory run=r1 approval -->");
    expect(p.risk).toBeUndefined();
    expect(p.gate).toBeUndefined();
    expect(p.text).toContain("abc commit");
  });
});

describe("composeComment", () => {
  const name = "Marcel K";
  it("builds every action, signed on the last line, never as a Foundry comment", () => {
    const all = [
      composeComment("defaults", { name }),
      composeComment("answer", { name, answers: [{ n: 1, text: "a" }, { n: 2, text: "b" }] }),
      composeComment("approve", { name, text: "ok" }),
      composeComment("reject", { name, text: "change x" }),
      composeComment("retry_hint", { name, text: "try y" }),
    ];
    expect(all[0]!.startsWith("/defaults")).toBe(true);
    expect(all[1]).toContain("**Q1.** a\n\n**Q2.** b");
    expect(all[2]!.split("\n")[0]).toBe("/approve ok");
    expect(all[3]!.split("\n")[0]).toBe("/reject change x");
    expect(all[4]!.startsWith("try y")).toBe(true);
    for (const t of all) {
      expect(t.split("\n").at(-1)).toBe("— Marcel K, via Spaghetti Code Foundry");
      expect(isBot({ body: t })).toBe(false);
    }
  });

  it("puts a multi-line note on the first line, as the watcher reads it", () => {
    const t = composeComment("approve", { name, text: "a\nb" });
    expect(/^\s*\/(approve|reject)\b[ \t]*(.*)$/im.exec(t)![2]).toBe("a b");
    expect(composeComment("approve", { name }).split("\n")[0]).toBe("/approve");
  });
});
