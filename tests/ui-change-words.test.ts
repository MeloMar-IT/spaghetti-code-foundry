import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { CHANGE_WORD, changesText, oldWordsIn, plainServerText, whoText } from "../ui/change-words.js";
import { TERMS, forbiddenIn } from "../ui/simple-words.js";
import { htmlTexts, jsStrings } from "./helpers/ui-text-scan.js";

const UI = join(process.cwd(), "ui");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(js|html)$/.test(n) ? [p] : [];
  });
}

describe("oldWordsIn", () => {
  it("finds the old words in a label", () => {
    expect(oldWordsIn("Find a story")).toEqual(["story"]);
    expect(oldWordsIn("Open issues of {}")).toEqual(["issues"]);
    expect(oldWordsIn("STORY")).toEqual(["STORY"]);
    expect(oldWordsIn("Bug stories are written to GitHub")).toEqual(["stories"]);
    expect(oldWordsIn("story-based")).toEqual(["story"]);
    expect(oldWordsIn("story/issue")).toEqual(["story", "issue"]);
    expect(oldWordsIn("")).toEqual([]);
    expect(oldWordsIn(undefined as unknown as string)).toEqual([]);
  });
  it("leaves GitHub names and technical tokens", () => {
    for (const t of ["Open GitHub issues of {}", "Issue #{} on GitHub", "Give the issue number.", "issue-gitflow", ".scf/stories/", "{}#{}",
      "issue/pr", "(default issue-gitflow)", "100 issues and pull requests", "issue_closed", "https://x/issues/1"]) expect(oldWordsIn(t), t).toEqual([]);
  });
});

describe("change words", () => {
  it("counts changes", () => {
    expect(changesText(0)).toBe("0 changes");
    expect(changesText(1)).toBe("1 change");
    expect(changesText(3)).toBe("3 changes");
  });
  it("shows the server's who value in the change words", () => {
    expect(whoText("Another story")).toBe("Another change");
    expect(whoText("You")).toBe("You");
    expect(whoText(undefined)).toBe("");
  });
  it("maps server-made sentences", () => {
    expect(plainServerText("Fix story #4")).toBe("Fix change #4");
    expect(plainServerText("waits for another story; stories")).toBe("waits for another change; changes");
    expect(plainServerText("Nothing — the story is parked")).toBe("Nothing — the change is parked");
    expect(plainServerText("Switch bug stories on again on the Watchers page")).toBe("Switch bug-fix changes on again on the Watchers page");
    expect(plainServerText("It waits: a bug story goes first")).toBe("It waits: a bug-fix change goes first");
    expect(plainServerText(null)).toBe("");
  });
  it("keeps values inside a sentence: branches, paths, files, urls and ids", () => {
    expect(plainServerText("Fix the tests on feature/story, or write a story that lists them"))
      .toBe("Fix the tests on feature/story, or write a change that lists them");
    expect(plainServerText("Saved in .scf/stories/4.md and monitor-guard.json")).toBe("Saved in .scf/stories/4.md and monitor-guard.json");
    expect(plainServerText("See https://github.com/o/a/stories/1 and story_id")).toBe("See https://github.com/o/a/stories/1 and story_id");
    expect(plainServerText("story-based work")).toBe("change-based work");
  });
  it("stays in step with the Simple word list", () => {
    expect(CHANGE_WORD.one).toBe(TERMS.story);
    expect(CHANGE_WORD.one).toBe(TERMS.issue);
    expect(forbiddenIn("Find a change")).toEqual([]);
  });
});

describe("jsStrings", () => {
  it("skips comments and reads escapes", () => {
    expect(jsStrings(`// "story"\n/* 'issue' */ const a = "x\\"y";`).map((f) => f.text)).toEqual(['x"y']);
  });
  it("reads templates and nested literals", () => {
    const t = jsStrings("const a = `${n === 1 ? \"story\" : \"stories\"} left`;").map((f) => f.text);
    expect(t).toEqual(["{} left", "story", "stories"]);
    expect(jsStrings("x = `a ${`b ${1}`} c`").map((f) => f.text)).toEqual(["a {} c", "b {}"]);
  });
  it("skips regex literals and keeps division", () => {
    expect(jsStrings(`if (/^the issue's limit /.test(s)) go("ok");`).map((f) => f.text)).toEqual(["ok"]);
    expect(jsStrings(`x = /[/]"/.test(s) ? "a" : "b";`).map((f) => f.text)).toEqual(["a", "b"]);
    expect(jsStrings(`x = a / b / "story";`).map((f) => f.text)).toEqual(["story"]);
  });
  it("counts lines", () => {
    expect(jsStrings(`a\n\nb("x")`)[0].line).toBe(3);
  });
});

describe("htmlTexts", () => {
  it("reads text and labels, not scripts, comments or links", () => {
    const t = htmlTexts(`<!-- issue --><script>"issue"</script><a href="/issues" aria-label="Find">Hi  there</a>`).map((f) => f.text);
    expect(t).toEqual(["Find", "Hi there"]);
  });
});

// Strings that are ids, saved values or server values and are never shown as they are.
const API = "an API path, never shown";
const ID = "an id or saved value that is compared in code, never shown";
const CLS = "a CSS class or element id, never shown";
const ALLOWED: { file: string; text: string; why: string }[] = [
  { file: "ui/api.js", text: "/api/runs/{}/issue-limit", why: API },
  { file: "ui/ask-handoff.js", text: "issue-draft", why: ID },
  { file: "ui/board.js", text: "card-{}-issue", why: CLS },
  { file: "ui/change-words.js", text: "Another story", why: "the value the server sends; whoText shows it as Another change" },
  { file: "ui/work-model.js", text: "Another story", why: "the value the server sends; whoText shows it as Another change" },
  { file: "ui/dashboard.js", text: "issues", why: "the watcher kind, saved by the server" },
  { file: "ui/watcher-form.js", text: "issues", why: "the watcher kind, saved by the server" },
  { file: "ui/watcher-options.js", text: "issues", why: "the watcher kind, saved by the server" },
  { file: "ui/onboarding-guide-model.js", text: "issues", why: "the watcher kind, saved by the server" },
  { file: "ui/onboarding-plan.js", text: "issues", why: "the watcher kind, saved by the server" },
  { file: "ui/epic-page-model.js", text: "stories", why: ID },
  { file: "ui/epic-page.js", text: "dot-stories", why: CLS },
  { file: "ui/epic-page.js", text: "line-stories", why: CLS },
  { file: "ui/epic-page.js", text: "seg-stories", why: CLS },
  { file: "ui/epic-page.js", text: "stories", why: ID },
  { file: "ui/epic-page.js", text: "epic-stories", why: CLS },
  { file: "ui/work.js", text: "stories", why: ID },
  { file: "ui/gallery/registry.js", text: "issue", why: ID },
  { file: "ui/kit/product.js", text: "Issue", why: "the kind read out before the GitHub #number" },
  { file: "ui/next.js", text: "issue", why: ID },
  { file: "ui/next.js", text: "muted issue-unchecked", why: CLS },
  { file: "ui/refinement-draft.js", text: "depends-issue", why: CLS },
  { file: "ui/refinement-new.js", text: "issue", why: "the start-point id" },
  { file: "ui/refinement-publish.js", text: "issue", why: "an object key check" },
  { file: "ui/refinement.js", text: "issue", why: ID },
  { file: "ui/run-skills.js", text: "issue", why: ID },
  { file: "ui/run-skills.js", text: "skill-issue-{}", why: CLS },
  { file: "ui/since.js", text: "{}-issue", why: ID },
  { file: "ui/turn.js", text: "turn-issue-{}", why: ID },
  { file: "ui/turn.js", text: "turn-story-{}-{}", why: ID },
  { file: "ui/turn.js", text: "turn-done-issue-{}", why: ID },
  { file: "ui/user/start-entry.js", text: "issue", why: "the start-point id" },
  { file: "ui/user/start.js", text: "issue", why: "the start-point id" },
  { file: "ui/work-model.js", text: "issue", why: "the saved order key" },
  { file: "ui/work-panel.js", text: "work-panel-issue", why: CLS },
];

describe("the UI says change", () => {
  const hits: { file: string; line: number; text: string; words: string[] }[] = [];
  const used = new Set<number>();
  for (const f of files(UI)) {
    const src = readFileSync(f, "utf8");
    const found = f.endsWith(".html") ? htmlTexts(src) : jsStrings(src);
    for (const s of found) {
      const words = oldWordsIn(s.text);
      if (!words.length) continue;
      const rel = relative(process.cwd(), f).replaceAll("\\", "/");
      const idx = ALLOWED.findIndex((a) => a.file === rel && a.text === s.text.trim());
      if (idx >= 0) { used.add(idx); continue; }
      hits.push({ file: rel, line: s.line, text: s.text, words });
    }
  }
  it("has no old word in a shown label", () => {
    expect(hits.map((h) => `${h.file}:${h.line} "${h.text}" → ${h.words.join(", ")}`)).toEqual([]);
  });
  it("has no stale allow-list entry, and each has a reason", () => {
    ALLOWED.forEach((a, i) => { expect(a.why.length, a.text).toBeGreaterThan(5); expect(used.has(i), `${a.file} "${a.text}"`).toBe(true); });
  });
  it("never allows the word story in a sentence", () => {
    for (const a of ALLOWED) if (/\s/.test(a.text) && /stor(y|ies)/i.test(a.text)) expect(a.text, "compat value").toBe("Another story");
  });
});
