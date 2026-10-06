import { describe, expect, it } from "vitest";
import { VAGUE_WORDS, checkText, draftRemarks, planSign, vagueWords } from "../src/refinement/draft-check.js";
import type { Draft } from "../src/refinement/draft.js";

const field = (text: string) => ({ text, from: "typed" as const });
const draft = (over: Partial<Draft> = {}): Draft => ({ id: "d", criteria: [], dependsOn: [], ...over });
const kinds = (text: string) => checkText("what", text).map((r) => r.kind);

describe("vague words", () => {
  it.each([...VAGUE_WORDS])("finds %s", (w) => {
    expect(vagueWords(`It should be ${w} for people.`)).toEqual([w]);
  });

  it("is case-insensitive and lists each word once", () => {
    expect(vagueWords("FAST, Fast and fast. Easy.")).toEqual(["fast", "easy"]);
  });

  it("finds etc and etc. at the end of a text", () => {
    expect(vagueWords("reports, exports, etc")).toEqual(["etc"]);
    expect(vagueWords("reports, exports, etc.")).toEqual(["etc"]);
  });

  it("does not find a word inside another word", () => {
    for (const t of ["breakfast", "easygoing", "fasten", "ketchup", "etcetera", "simpler lives", "user-friendlyness"]) expect(vagueWords(t), t).toEqual([]);
  });

  it("names the word and gives a plain sentence", () => {
    const [r] = checkText("why", "so that it is fast");
    expect(r).toMatchObject({ field: "why", kind: "vague", word: "fast" });
    expect(r!.text).toContain('"fast"');
    expect(r!.item).toBeUndefined();
  });
});

describe("plan signs", () => {
  it("finds a code block, not single backticks", () => {
    expect(planSign("Use:\n```\nnpm test\n```")).toBe("code block");
    expect(planSign("The `max_cost_usd` setting is shown")).toBeUndefined();
  });

  it("finds a path with a file extension, not routes, addresses or folders", () => {
    expect(planSign("Change src/a/b.ts for it")).toBe("src/a/b.ts");
    for (const t of ["POST /api/refinement/:id/review answers 202", "see https://x.org/a/index.html", "download report.csv", "the tools/refine-round-check tool", "yes/no", "and/or"]) {
      expect(planSign(t), t).toBeUndefined();
    }
  });

  it("does not flag a name in backticks", () => {
    expect(planSign("Change `src/a.ts` and call `saveDraft()` and `store.saveDraft(x)`")).toBeUndefined();
  });

  it("finds a call, not a plural in brackets or a word in brackets", () => {
    expect(planSign("It calls saveDraft() first")).toBe("saveDraft()");
    expect(planSign("Use store.saveDraft(x) here")).toBe("store.saveDraft(x)");
    expect(planSign("Use save_draft(x) here")).toBe("save_draft(x)");
    for (const t of ["Every user(s) can export", "The page (see below) loads", "an item (or two)"]) expect(planSign(t), t).toBeUndefined();
  });

  it("finds build steps with a build thing, not the steps of a user", () => {
    expect(planSign("First add a table, then call it")).toBe("First add a table, then");
    for (const t of ["The first page loads, then the list shows", "First create an account, then sign in", "First open the report, then press export"]) {
      expect(planSign(t), t).toBeUndefined();
    }
  });

  it("finds a path with any file extension", () => {
    expect(planSign("Put it in config/app.properties")).toBe("config/app.properties");
    expect(planSign("Edit lib/job.ex")).toBe("lib/job.ex");
    expect(planSign("see docs/readme and notes/")).toBeUndefined();
  });

  it("finds build steps across sentences and in a numbered list", () => {
    expect(planSign("First edit the schema. Then update the handler.")).toBe("First edit the schema. Then");
    expect(planSign("1. Add a table\n2. Create the endpoint")).toBe("Add a table");
    for (const t of ["First edit the report. Then sign in.", "1. Open the page\n2. Add a table", "1. Sign in\n2. Press export"]) {
      expect(planSign(t), t).toBeUndefined();
    }
  });

  it("says that a plan belongs in the build step", () => {
    const [r] = checkText("what", "Edit src/a.ts");
    expect(r).toMatchObject({ kind: "plan", word: "src/a.ts" });
    expect(r!.text).toContain("belongs in the build step");
  });

  it("gives one plan remark and one vague remark per word", () => {
    expect(kinds("Fast and easy: edit src/a.ts and src/b.ts")).toEqual(["vague", "vague", "plan"]);
  });
});

describe("a draft", () => {
  it("checks every field but the notes, with the item for a criterion", () => {
    const d = draft({
      title: field("A fast export"),
      who: field("an easy user"),
      what: field("to call saveDraft()"),
      why: field("it is quick"),
      criteria: [{ id: "c1", text: "It opens src/a.ts", from: "typed" }, { id: "c2", text: "It is simple", from: "typed" }],
      outOfScope: field("etc"),
      notes: field("First add a table, then call src/a.ts fast, easy, etc and saveDraft()"),
    });
    expect(draftRemarks(d).map((r) => [r.field, r.item, r.kind, r.word])).toEqual([
      ["title", undefined, "vague", "fast"],
      ["who", undefined, "vague", "easy"],
      ["what", undefined, "plan", "saveDraft()"],
      ["why", undefined, "vague", "quick"],
      ["criteria", "c1", "plan", "src/a.ts"],
      ["criteria", "c2", "vague", "simple"],
      ["outOfScope", undefined, "vague", "etc"],
    ]);
  });

  it("finds nothing in the notes, and nothing in an empty draft", () => {
    expect(draftRemarks(draft({ notes: field("fast, easy, etc, src/a.ts") }))).toEqual([]);
    expect(draftRemarks(draft())).toEqual([]);
  });
});

describe("cost", () => {
  it("finishes a worst-case text of 5,000 characters in under 200 ms", () => {
    for (const t of ["a/".repeat(2500), "first add ".repeat(500), "a.".repeat(2500), "(".repeat(5000), "x(".repeat(2500), "`".repeat(5000), "http://".repeat(700)]) {
      const at = performance.now();
      checkText("outOfScope", t);
      expect(performance.now() - at, t.slice(0, 10)).toBeLessThan(200);
    }
  });
});
