import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STOPPED_CANCEL_REASON, type RunSummary } from "../src/engine/state.js";
import { isFoundryComment, isOverruleReply, isStatusComment, type Comment } from "../src/github.js";
import {
  EPIC_NOTE, OVERRULE_ANSWER_MAX, PLANNED_LINE, ackedNotPlanned, acceptedComment, codeMerged, decidedItems, findOverrules, followUpComment, followUpSearchArgs, hasPlanStep, mergeStarted,
  noteComment, overruleAction, overruleKey, overruleMarker, parseOverrule, plannedKeys, type Overrule,
} from "../src/queue/overrule.js";
// @ts-expect-error a plain ES module of the tools folder, without types
import { DECIDED_HEADING, decideQuestions } from "../tools/decide-questions.mjs";

const c = (body: string, i = 0, extra: Partial<Comment> = {}): Comment => ({
  author: { login: "someone" }, body, createdAt: `2026-10-01T00:00:${String(i).padStart(2, "0")}Z`, url: `https://x/y/issues/1#issuecomment-${100 + i}`, ...extra,
});
const bot = (body: string, i = 0): Comment => c(body, i, { author: { login: "bot" }, viewerDidAuthor: true });
const run = (over: Record<string, unknown>): RunSummary => ({ history: [], state: {}, flowDef: { steps: [] }, status: "stopped", ...over }) as unknown as RunSummary;
const entry = (id: string, output = "", ok = true) => ({ id, type: "shell", visit: 1, ok, output });
const decided = (n = 1, decision = "pg") => `intro\n\n${DECIDED_HEADING}\n\n> **Q${n}. Which db?**\n> text\n\n**Decision:** ${decision}\n\n<!-- claude-factory run=r1 decided=1 -->`;

describe("isFoundryComment / isOverruleReply", () => {
  const m = "<!-- claude-factory run=r1 -->";
  it("needs the marker and viewerDidAuthor", () => {
    expect(isFoundryComment({ body: m, viewerDidAuthor: true })).toBe(true);
    expect(isFoundryComment({ body: m })).toBe(false);
    expect(isFoundryComment({ body: "hi", viewerDidAuthor: true })).toBe(false);
  });
  it("reads the overrule marker on the last line only", () => {
    expect(isOverruleReply({ body: "x\n<!-- claude-factory overrule=5 -->", viewerDidAuthor: true })).toBe(true);
    expect(isOverruleReply({ body: "x\n<!-- claude-factory overrule=5 followup -->\n", viewerDidAuthor: true })).toBe(true);
    expect(isOverruleReply({ body: "x\n<!-- claude-factory overrule=5 -->", viewerDidAuthor: false })).toBe(false);
    expect(isOverruleReply({ body: `quote <!-- claude-factory overrule=5 -->\n${m}`, viewerDidAuthor: true })).toBe(false);
    expect(isOverruleReply({ body: "s\n<!-- claude-factory status -->", viewerDidAuthor: true })).toBe(false);
    expect(isStatusComment({ body: "x\n<!-- claude-factory overrule=5 -->" })).toBe(false);
  });
});

describe("parseOverrule", () => {
  it.each([
    ["/overrule Q2 use a file", 2, "use a file"], ["  /OVERRULE q2 x", 2, "x"], ["hi\n/overrule Q3 x", 3, "x"],
    ["ok\r\n/overrule Q3 x\r\n", 3, "x"], ["/overrule Q02 x", 2, "x"], ["/overrule Q2: x", 2, "x"],
  ])("accepts %j", (body, q, answer) => {
    expect(parseOverrule(body)).toEqual({ q, answer });
  });
  it("reads a multi-line answer, skips quotes, stops at a second command", () => {
    expect(parseOverrule("/overrule Q1 one\n> quoted\n\n\n\ntwo\n/overrule Q2 other")).toEqual({ q: 1, answer: "one\n\ntwo" });
  });
  it("cuts the answer at the limit", () => {
    const r = parseOverrule(`/overrule Q1 ${"a".repeat(2000)}`) as { answer: string };
    expect(r.answer.length).toBe(OVERRULE_ANSWER_MAX);
  });
  it.each(["please /overrule Q1 x", "> /overrule Q1 x", "/overrules Q1 x", "/overrule-x Q1 x", ""])("finds no command in %j", (b) => {
    expect(parseOverrule(b)).toBeUndefined();
  });
  it.each(["/overrule", "/overrule Q", "/overrule x y", "/overrule Q0 x", "/overrule Q1", "/overrule Q1   \n  ", "/overrule Q99999999999999999999 x"])("%j is malformed", (b) => {
    expect(parseOverrule(b)).toBe("malformed");
  });
});

describe("decidedItems", () => {
  it("reads what decideQuestions writes", () => {
    const body = `**Q1. A?**\n**Kind:** technical\nx\n**Recommendation:** pg\n\nunless X\n\n**Q2. B?**\n**Kind:** technical\ny\n**Recommendation:** file`;
    const m = decidedItems(decideQuestions(body).body);
    expect(m.get(1)).toBe("pg\n\nunless X");
    expect(m.get(2)).toBe("file");
  });
  it("leaves the footers of a posted planner comment out of the last decision", () => {
    const d = decideQuestions(`**Q1. A?**\n**Kind:** technical\nx\n**Recommendation:** pg\n\nunless X`).body;
    const posted = ["first", "", "🤖 **Spaghetti Code Foundry** decided these:", "", d, "", "_Want a different answer? Say so._", "", "<!-- claude-factory run=r1 decided=1 -->"].join("\n");
    expect([...decidedItems(posted)]).toEqual([[1, "pg\n\nunless X"]]);
  });
  it("leaves the footers of a posted epic comment out of the last decision", () => {
    const d = decideQuestions(`**Q1. A?**\n**Kind:** technical\nx\n**Recommendation:** pg`).body;
    const posted = ["intro", "", d, "", EPIC_NOTE, "", "_closing_", "", "<!-- claude-factory run=r1 -->"].join("\n");
    expect(decidedItems(posted).get(1)).toBe("pg");
    expect(decidedItems(`${d}\n\n${EPIC_NOTE}`).get(1)).toBe("pg");
  });
  it("keeps italic paragraphs inside a decision", () => {
    const body = `${DECIDED_HEADING}\n\n> **Q1. Which db?**\n\n**Decision:** PostgreSQL\n\n_Only for durable records._\n\nKeep transient records in memory.\n\n<!-- claude-factory run=r1 -->`;
    expect(decidedItems(body).get(1)).toBe("PostgreSQL\n\n_Only for durable records._\n\nKeep transient records in memory.");
    const posted = `${DECIDED_HEADING}\n\n**Q1. Which db?**\n\n**Decision:** PostgreSQL\n\n_Only for durable records._\n\n_Want a different answer?_\n\n<!-- claude-factory run=r1 decided=1 -->`;
    expect(decidedItems(posted).get(1)).toBe("PostgreSQL\n\n_Only for durable records._");
  });
  it("keeps EPIC_NOTE equal to the text of tools/post-questions", () => {
    expect(readFileSync(new URL("../tools/post-questions", import.meta.url), "utf8")).toContain(`"${EPIC_NOTE}"`);
  });
  it("reads the quoted and the unquoted form", () => {
    const quoted = `${DECIDED_HEADING}\n\n> **Q3. C?**\n> t\n\n**Decision:** x\n\n> **Q4. D?**\n\n**Decision:** y`;
    expect([...decidedItems(quoted)]).toEqual([[3, "x"], [4, "y"]]);
    expect([...decidedItems(`${DECIDED_HEADING}\n\n**Q1. Which store?**\n**Decision:** a`)]).toEqual([[1, "a"]]);
  });
  it("ignores questions above the heading, and reads nothing without one", () => {
    expect([...decidedItems(`**Q2. Open?**\n**Decision:** no\n${DECIDED_HEADING}\n**Q1. A?**\n**Decision:** a`)]).toEqual([[1, "a"]]);
    expect(decidedItems("**Q1. A?**\n**Decision:** a").size).toBe(0);
  });
  it("gives a question without a decision an empty value", () => {
    expect(decidedItems(`${DECIDED_HEADING}\n**Q1. A?**\ntext`).get(1)).toBe("");
  });
  it("stops at a marker line and at ---", () => {
    expect(decidedItems(`${DECIDED_HEADING}\n**Q1. A?**\n**Decision:** a\n<!-- m -->\nmore`).get(1)).toBe("a");
    expect(decidedItems(`${DECIDED_HEADING}\n**Q1. A?**\n**Decision:** a\n---\nmore`).get(1)).toBe("a");
  });
});

describe("overruleKey / overruleMarker", () => {
  it("uses the comment id, or a stable hash", () => {
    expect(overruleKey({ url: "https://x/y#issuecomment-77", author: { login: "a" }, createdAt: "t" })).toBe("77");
    const k = overruleKey({ author: { login: "a" }, createdAt: "t" });
    expect(k).toMatch(/^h[0-9a-f]{12}$/);
    expect(overruleKey({ author: { login: "a" }, createdAt: "t" })).toBe(k);
    expect(overruleKey({ author: { login: "b" }, createdAt: "t" })).not.toBe(k);
    expect(overruleKey({ author: { login: "a" }, createdAt: "u" })).not.toBe(k);
    expect(k).toMatch(/^[\w-]+$/);
  });
  it("builds both marker forms", () => {
    expect(overruleMarker("5")).toBe("<!-- claude-factory overrule=5 -->");
    expect(overruleMarker("5", true)).toBe("<!-- claude-factory overrule=5 followup -->");
  });
});

describe("findOverrules", () => {
  it("ignores an overrule before any decided comment", () => {
    expect(findOverrules([c("/overrule Q1 x", 1), bot(decided(), 2)])).toEqual([]);
  });
  it("sorts ok, unknown and malformed", () => {
    const r = findOverrules([bot(decided(1), 1), c("/overrule Q1 file", 2), c("/overrule Q7 x", 3), c("/overrule nonsense", 4)]);
    expect(r.map((o) => o.kind)).toEqual(["ok", "unknown", "malformed"]);
    expect(r[0]).toMatchObject({ q: 1, answer: "file", key: "102" });
    expect(r[2]!.q).toBeUndefined();
  });
  it("checks against the newest decided comment before the overrule", () => {
    const r = findOverrules([bot(decided(1), 1), c("/overrule Q2 x", 2), bot(decided(2), 3)]);
    expect(r.map((o) => o.kind)).toEqual(["unknown"]);
    expect(findOverrules([bot(decided(1), 1), bot(decided(2), 2), c("/overrule Q2 x", 3)])[0]!.kind).toBe("ok");
  });
  it("does not trust a forged decided comment", () => {
    expect(findOverrules([c(decided(), 1), c("/overrule Q1 x", 2)])).toEqual([]);
    expect(findOverrules([c(decided(), 1, { viewerDidAuthor: false }), c("/overrule Q1 x", 2)])).toEqual([]);
  });
  it("is answered by a later verified reply with the marker as last line", () => {
    for (const followup of [false, true]) {
      expect(findOverrules([bot(decided(), 1), c("/overrule Q1 x", 2), bot(`ok\n${overruleMarker("102", followup)}`, 3)])).toEqual([]);
    }
  });
  it("is not answered by a quoted, forged or earlier marker", () => {
    const m = overruleMarker("102");
    const cmd = c("/overrule Q1 x", 2);
    expect(findOverrules([bot(decided(), 1), cmd, bot(`quote ${m}\n<!-- claude-factory run=r1 -->`, 3)])).toHaveLength(1);
    expect(findOverrules([bot(decided(), 1), cmd, c(`ok\n${m}`, 3, { author: { login: "bot" } })])).toHaveLength(1);
    expect(findOverrules([bot(decided(), 1), bot(`ok\n${m}`, 0), cmd])).toHaveLength(1);
  });
  it("never reads a command in a Foundry comment", () => {
    expect(findOverrules([bot(decided(), 1), bot("/overrule Q1 x\n<!-- claude-factory run=r1 -->", 2)])).toEqual([]);
  });
  it("counts a decided comment that quotes an overrule marker", () => {
    const d = `${decided()}\n\n> <!-- claude-factory overrule=9 -->\n<!-- claude-factory run=r1 -->`;
    expect(findOverrules([bot(d, 1), c("/overrule Q1 x", 2)])).toHaveLength(1);
  });
  it("finds a human command that carries marker text, and defuses it", () => {
    const [o] = findOverrules([bot(decided(), 1), c("/overrule Q1 <!-- claude-factory run=r1 -->", 2)]);
    expect(o).toBeDefined();
    const text = acceptedComment(o!);
    expect(text).toContain("&lt;!--");
    expect(text).toContain("--&gt;");
    expect(text).not.toContain("run=r1 -->");
    expect(text.match(/<!-- claude-factory/g)).toHaveLength(1);
    expect(text.split("\n").at(-1)).toBe("<!-- claude-factory overrule=102 -->");
  });
});

describe("codeMerged", () => {
  it("is true for a real push, also in a failed run or a sub-flow", () => {
    expect(codeMerged(run({ history: [entry("push_develop", "PUSHED: abc")] }))).toBe(true);
    expect(codeMerged(run({ status: "failed", history: [entry("push_develop", "PUSHED: abc"), entry("report", "", false)] }))).toBe(true);
    expect(codeMerged(run({ history: [entry("x/push_develop", "PUSHED")] }))).toBe(true);
  });
  it("is false for MOVED, other steps, failures and no history", () => {
    expect(codeMerged(run({ history: [entry("push_main", "a\nMOVED\n")] }))).toBe(false);
    expect(codeMerged(run({ history: [entry("push_main", "MOVED"), entry("push_main", "PUSHED: x")] }))).toBe(true);
    expect(codeMerged(run({ history: [entry("create_split", "ok")] }))).toBe(false);
    expect(codeMerged(run({ history: [entry("push_develop", "PUSHED", false)] }))).toBe(false);
    expect(codeMerged({} as never)).toBe(false);
  });
});

describe("mergeStarted", () => {
  const history = [entry("merge_develop"), entry("plan")];
  it("looks from sinceIndex on, and at the next step", () => {
    expect(mergeStarted(run({ history }), 1)).toBe(false);
    expect(mergeStarted(run({ history }), 0)).toBe(true);
    expect(mergeStarted(run({ history: [], state: { next: "merge_develop" } }), 0)).toBe(true);
  });
});

describe("overruleAction", () => {
  const flowDef = (...steps: [string, boolean?][]) => ({ steps: steps.map(([id, jump_only]) => ({ id, ...(jump_only ? { jump_only } : {}) })) });
  it("does nothing without a plan, when parked, or after a stopped cancel", () => {
    expect(overruleAction(run({}), undefined, false)).toBe("none");
    expect(overruleAction(run({ parkedAt: "t", flowDef: flowDef(["plan"]) }), undefined, true)).toBe("none");
    expect(overruleAction(run({ status: "cancelled", reason: STOPPED_CANCEL_REASON, flowDef: flowDef(["plan"]) }), undefined, true)).toBe("none");
  });
  it("waits, stops, or follows up", () => {
    expect(overruleAction(run({}), "queued", true)).toBe("wait");
    expect(overruleAction(run({ history: [entry("merge_develop")] }), "active", true)).toBe("wait");
    expect(overruleAction(run({ history: [entry("plan")] }), "active", true)).toBe("stop");
    expect(overruleAction(run({ history: [entry("push_develop", "PUSHED: a")], status: "failed" }), undefined, true)).toBe("followup");
  });
  it("restarts a plan-only run and leaves a succeeded split alone", () => {
    expect(overruleAction(run({ status: "succeeded", flowDef: flowDef(["plan"], ["report"]) }), undefined, true)).toBe("restart");
    expect(overruleAction(run({ status: "succeeded", flowDef: flowDef(["plan"], ["merge_develop"]), history: [entry("create_split")] }), undefined, true)).toBe("none");
  });
  it("re-plans from the first step that is not jump-only", () => {
    expect(overruleAction(run({ status: "failed", flowDef: flowDef(["loop", true], ["pull_ticket"], ["plan"]) }), undefined, true)).toEqual({ replan: "pull_ticket" });
    expect(overruleAction(run({ status: "failed", flowDef: flowDef() }), undefined, true)).toBe("none");
  });
});

describe("builders", () => {
  const d = bot(`${DECIDED_HEADING}\n\n> **Q1. A?**\n\n**Decision:** pg\n\nunless X\n\n> **Q3. B?**\n\n**Decision:** y`, 1);
  const o = (over: Partial<Overrule> = {}): Overrule => ({ key: "7", comment: c("x", 2), q: 1, answer: "file\n\nplease", kind: "ok", decided: d, ...over });
  it("accepts with the old decision and the answer quoted", () => {
    const t = acceptedComment(o());
    expect(t).toContain("**Overrule accepted** for Q1.");
    expect(t).toContain("The Foundry had decided:\n\n> pg\n>\n> unless X");
    expect(t).toContain("Your answer replaces it:\n\n> file\n>\n> please");
    expect(t.endsWith("<!-- claude-factory overrule=7 -->")).toBe(true);
  });
  it("defuses user text", () => {
    const t = acceptedComment(o({ answer: "a <!-- b --> c" }));
    expect(t).toContain("a &lt;!-- b --&gt; c");
    expect(t.match(/<!--/g)).toHaveLength(1);
  });
  it("explains a malformed and an unknown overrule without echoing text", () => {
    const bad = noteComment(o({ kind: "malformed", q: undefined, answer: undefined }));
    const unknown = noteComment(o({ kind: "unknown", q: 9, answer: "secret" }));
    expect(bad).toContain("/overrule Q<n> <answer>");
    expect(unknown).toContain("has no Q9");
    expect(unknown).toContain("Questions it decided: Q1, Q3.");
    expect(unknown).not.toContain("secret");
    for (const t of [bad, unknown]) expect(t.endsWith("<!-- claude-factory overrule=7 -->")).toBe(true);
  });
  it("drafts a follow-up issue", () => {
    const t = followUpComment({ number: 12 }, o());
    expect(t).toContain("**Title:** Follow-up to #12: apply the overrule of Q1");
    expect(t).toContain("### Acceptance criteria");
    expect(t).toContain("The Foundry does not create this issue");
    expect(t.endsWith("<!-- claude-factory overrule=7 followup -->")).toBe(true);
  });
});

describe("hasPlanStep", () => {
  it("is true with a plan step only", () => {
    expect(hasPlanStep({ flowDef: { name: "f", steps: [{ id: "pull_ticket" }, { id: "plan" }] } } as never)).toBe(true);
    expect(hasPlanStep({ flowDef: { name: "f", steps: [{ id: "pull_ticket" }] } } as never)).toBe(false);
    expect(hasPlanStep({ flowDef: { name: "f", steps: [] } } as never)).toBe(false);
    expect(hasPlanStep({} as never)).toBe(false);
  });
});

describe("ackedNotPlanned", () => {
  const ack = (key: string, i: number, extra: Partial<Comment> = {}): Comment => ({ ...bot(`🤖 **Spaghetti Code Foundry**: **Overrule accepted** for Q1.\n\n${overruleMarker(key)}`, i), ...extra });
  const thread = (extra: Partial<Comment> = {}): Comment[] => [bot(decided(), 0), c("/overrule Q1 sqlite", 1), ack(overruleKey(c("", 1)), 2, extra)];
  it("gives back an accepted overrule that no run planned again", () => {
    const [o] = ackedNotPlanned(thread(), new Set());
    expect(o).toMatchObject({ key: "101", q: 1, answer: "sqlite", kind: "ok" });
  });
  it("gives nothing for a planned key, a forged ack, or when the overrule comment is gone", () => {
    expect(ackedNotPlanned(thread(), plannedKeys([PLANNED_LINE("101")]))).toEqual([]);
    expect(ackedNotPlanned(thread({ viewerDidAuthor: false }), new Set())).toEqual([]);
    expect(ackedNotPlanned(thread().filter((x) => x.url !== c("", 1).url), new Set())).toEqual([]);
  });
  it("does not take a rejection note for an ack, even when the command was edited to a valid question", () => {
    // The Foundry rejected `/overrule Q7 x` with a note (same marker as an ack); the user then edited it to Q1.
    const note = bot(`${"🤖 **Spaghetti Code Foundry**: this overrule was not used"}\n\n${overruleMarker("101")}`, 2);
    const edited = [bot(decided(), 0), c("/overrule Q1 sqlite", 1), note];
    expect(ackedNotPlanned(edited, new Set())).toEqual([]);
  });
  it("reads the planned lines of a run log", () => {
    expect([...plannedKeys(["x", PLANNED_LINE("5"), "overrule 6 planned again "])]).toEqual(["5", "6"]);
  });
});

describe("followUpSearchArgs", () => {
  it("searches issues in any state with an overrule in a comment, updated in the last 14 days, at most 30", () => {
    expect(followUpSearchArgs("acme/app", Date.parse("2026-10-27T12:00:00Z"))).toEqual([
      "issue", "list", "--repo", "acme/app", "--state", "all", "--search", "overrule in:comments updated:>=2026-10-13",
      "--limit", "30", "--json", "number,updatedAt",
    ]);
  });
});
