import { describe, expect, it } from "vitest";
import { draftFromStory } from "../src/refinement/issue-import.js";
import { issueText } from "../src/refinement/publish.js";
import { dependencyRefs, quickChecks } from "../src/refinement/backlog.js";

const STORY = [
  "**Epic:** #73",
  "",
  "As an admin, I want to export a report, so that I can share it.",
  "",
  "### Acceptance criteria",
  "- [ ] It exports a file",
  "- [ ] The file has a header",
  "",
  "### Depends on",
  "- #5",
].join("\n");

const check = (body: string | null, known: number[] = [], titles: { number: number; title: string }[] = []) =>
  quickChecks({ number: 10, title: "Export a report", body }, new Set(known), { titles });

describe("formatted stories", () => {
  it("passes all four checks", () => {
    const c = check(STORY, [5]);
    expect(c).toMatchObject({ criteria: true, value: true, dependencies: true, questions: true, missing: [] });
  });
  it("fails the value check when a part is a placeholder", () => {
    expect(check(STORY.replace("an admin", "…"), [5]).value).toBe(false);
  });
  it("fails the criteria check when the section is empty", () => {
    expect(check(STORY.replace(/- \[ \] .*\n/g, ""), [5]).criteria).toBe(false);
  });
});

describe("unformatted texts: acceptance criteria", () => {
  it("takes a heading with a numbered list", () => {
    expect(check("Some text.\n\n## Acceptance Criteria\n1. It works\n2. It is fast").criteria).toBe(true);
  });
  it("takes a bold line with bullets", () => {
    expect(check("**Acceptance criteria**\n- one\n* two").criteria).toBe(true);
    expect(check("Acceptance criteria:\n+ one").criteria).toBe(true);
  });
  it("needs an item", () => {
    expect(check("## Acceptance criteria\n\nTo be written.\n\n## Notes\n- a").criteria).toBe(false);
    expect(check("- a\n- b").criteria).toBe(false);
  });
  it("ignores a heading inside a code fence", () => {
    expect(check("```\n## Acceptance criteria\n- a\n```").criteria).toBe(false);
  });
});

describe("unformatted texts: value sentence", () => {
  it("takes a sentence over two lines and with bold", () => {
    expect(check("**As** a user,\nI want to log in so that I see my data.").value).toBe(true);
    expect(check("As a user I want X, so that Y").value).toBe(true);
  });
  it("rejects plain prose", () => {
    expect(check("Please fix the thing. I want it to work.").value).toBe(false);
  });
  it("rejects a sentence of placeholders", () => {
    expect(check("As …, I want …, so that …").value).toBe(false);
    expect(check("As a user, I want …, so that I win.").value).toBe(false);
  });
  it("rejects a sentence that is only quoted inside other prose or a code fence", () => {
    expect(check('Write it like: "As a user, I want X, so that Y" and send it.').value).toBe(false);
    expect(check("```\nAs a user, I want X, so that Y\n```").value).toBe(false);
  });
});

describe("dependencies", () => {
  const dep = (text: string, known: number[] = [], titles: { number: number; title: string }[] = []) => check(`### Depends on\n${text}`, known, titles);
  it("is good when the issue exists", () => expect(dep("- #3", [3]).dependencies).toBe(true));
  it("lists a number that does not exist", () => expect(dep("- #3\n- #9", [3])).toMatchObject({ dependencies: false, missing: [9] }));
  it("is good with None or no section", () => {
    expect(dep("None").dependencies).toBe(true);
    expect(check("nothing here").dependencies).toBe(true);
  });
  it("ignores another repository's reference and a reference to itself", () => {
    expect(dep("- owner/repo#9").dependencies).toBe(true);
    expect(dep("- #10").dependencies).toBe(true);
  });
  it("finds a title-only entry through the titles", () => {
    const titles = [{ number: 4, title: "Login page" }];
    expect(dep("- Login page", [4], titles).dependencies).toBe(true);
    expect(dep("- Login page", [], titles)).toMatchObject({ dependencies: false, missing: [4] });
  });
  it("fails a title-only entry that matches no title", () => {
    const c = dep("- Something nobody wrote", [4], [{ number: 4, title: "Login page" }]);
    expect(c.dependencies).toBe(false);
    expect(c.unmatched).toEqual(["Something nobody wrote"]);
  });
  it("dependencyRefs separates numbers from unmatched entries", () => {
    expect(dependencyRefs({ number: 1, title: "t", body: "Depends on: #7, #8\n- Unknown thing" }, []).numbers).toEqual([7, 8]);
  });
});

describe("regressions", () => {
  it("accepts the Foundry's own 'None (can be built on its own).' and 'No dependencies'", () => {
    const d = draftFromStory({ title: "T", who: "an admin", what: "to export", why: "I can share", criteria: ["It exports"], dependsOn: [] });
    const t = issueText(d, { drafts: [d] }, { accepted: [], by: "Ann", date: "2026-10-07", numberOf: () => undefined });
    expect(t.body).toContain("None (can be built on its own)");
    expect(quickChecks({ number: 1, title: t.title, body: t.body }, new Set()).dependencies).toBe(true);
    expect(check("### Depends on\nNo dependencies.").dependencies).toBe(true);
    expect(check("### Depends on\nNo.").dependencies).toBe(true);
  });
  it("reads a sentence right under a heading, with no blank line", () => {
    expect(check("## User story\nAs a user, I want X, so that Y.").value).toBe(true);
    expect(check("Intro\n## Story\n**As a user, I want X, so that Y.**\n## Notes\nmore").value).toBe(true);
  });
});

describe("open questions", () => {
  it("is bad with text under an Open questions heading", () => {
    expect(check("### Open questions\nWhich format?").questions).toBe(false);
    expect(check("## Open question\n- Who pays?").questions).toBe(false);
  });
  it("is good with None. or an empty section", () => {
    expect(check("### Open questions\nNone.").questions).toBe(true);
    expect(check("### Open questions\n- none\n").questions).toBe(true);
    expect(check("### Open questions\n\n### Notes\nText").questions).toBe(true);
  });
  it("does not take a generic Questions heading", () => {
    expect(check("### Questions\nAnswered: yes").questions).toBe(true);
  });
  it("is bad with an unchecked task item that asks", () => {
    for (const m of ["-", "*", "+"]) expect(check(`${m} [ ] Which format?`).questions, m).toBe(false);
  });
  it("is good with a checked item or an unchecked statement", () => {
    expect(check("- [x] Which format?").questions).toBe(true);
    expect(check("- [ ] It exports a file").questions).toBe(true);
  });
  it("ignores questions inside a code fence", () => {
    expect(check("```\n### Open questions\nWhat?\n- [ ] Why?\n```").questions).toBe(true);
  });
});

describe("no text", () => {
  it("fails criteria and value, passes the others", () => {
    expect(check(null)).toMatchObject({ criteria: false, value: false, dependencies: true, questions: true });
  });
});
