import { describe, expect, it } from "vitest";
import { labelNames } from "../src/queue/watcher.js";
import type { WatcherConfig } from "../src/config.js";
import { DraftsSchema, preview } from "../src/refinement/draft.js";
import { buildingReason, pullsToRead, type PullKind } from "../src/refinement/issue-building.js";
import { cleanBody, draftFromStory, ideaOf, parseStory, type StoryFields } from "../src/refinement/issue-import.js";

const story = (o: Partial<StoryFields> = {}): StoryFields => ({
  title: "Export a report",
  who: "an admin",
  what: "to export a report as CSV",
  why: "I can share it",
  criteria: ["It exports a file", "The file has a header"],
  dependsOn: [],
  ...o,
});
const textOf = (s: StoryFields, epic?: number) => {
  const d = draftFromStory(s);
  return preview(d, { drafts: [d], ...(epic !== undefined ? { epic } : {}) });
};

describe("parseStory: round trip with preview()", () => {
  it("gives the same fields back", () => {
    const s = story({ outOfScope: "Printing", notes: "Use the existing exporter.", dependsOn: [12, 14] });
    const p = textOf(s, 73);
    const got = parseStory(p.title, p.body)!;
    expect(got).toEqual({ ...s, epic: 73 });
  });

  it("writes the same text again", () => {
    for (const why of ["I can share it", "it works.", "does it work?"]) {
      const p = textOf(story({ why }), 5);
      const got = parseStory(p.title, p.body)!;
      expect(textOf(got, got.epic)).toEqual(p);
    }
  });

  it("reads zero criteria, the none sentence and … parts", () => {
    const d = draftFromStory(story({ criteria: [] }));
    delete d.who;
    delete d.why;
    const p = preview(d, { drafts: [d] });
    const got = parseStory(p.title, p.body)!;
    expect(got.criteria).toEqual([]);
    expect(got.who).toBeUndefined();
    expect(got.why).toBeUndefined();
    expect(got.what).toBe("to export a report as CSV");
    expect(got.dependsOn).toEqual([]);
  });
});

describe("parseStory: real issues", () => {
  const issue331 = [
    "**Epic:** Refinement — the Foundry helps people write good stories, as an architect (#73)",
    "",
    "Part 1 of 6 of #82 (Refinement 9), split by the Foundry.",
    "",
    "As a user, I want to start a refinement session from an open issue, so that an old issue gets care.",
    "",
    "### Acceptance criteria",
    "- [ ] It reads the issue",
    "- [x] It keeps the title",
    "* A star bullet",
    "",
    "### Notes for this codebase",
    "- NEW file",
    "",
    "### Depends on",
    "None (can be built on its own).",
  ].join("\n");

  it("keeps loose lines and unknown sections in the notes", () => {
    const got = parseStory("Refinement 9a", issue331)!;
    expect(got.epic).toBeUndefined();
    expect(got.who).toBe("a user");
    expect(got.criteria).toEqual(["It reads the issue", "It keeps the title", "A star bullet"]);
    expect(got.notes).toContain("**Epic:** Refinement");
    expect(got.notes).toContain("Part 1 of 6 of #82");
    expect(got.notes).toContain("### Notes for this codebase\n- NEW file");
    expect(got.dependsOn).toEqual([]);
  });

  it("drops Accepted anyway", () => {
    const p = textOf(story());
    const got = parseStory(p.title, `${p.body}\n\n### Accepted anyway\n- It has a thing: because`)!;
    expect(got.notes).toBeUndefined();
  });

  it("takes - #N lines and keeps the other lines of Depends on", () => {
    const body = `${textOf(story()).body.replace(/### Depends on[\s\S]*$/, "")}### Depends on\n- #12\n- Export (draft)\nowner/repo#3 first\n- #0\n- #12`;
    const got = parseStory("t", body)!;
    expect(got.dependsOn).toEqual([12]);
    expect(got.notes).toContain("### Depends on\n- Export (draft)\nowner/repo#3 first\n- #0");
  });

  it("keeps extra lines next to None", () => {
    const body = `${textOf(story()).body.replace(/None \(can be built on its own\)\./, "None (can be built on its own).\nbut only after the release")}`;
    expect(parseStory("t", body)!.notes).toContain("but only after the release");
  });

  it("has no story without the sentence or without the criteria", () => {
    expect(parseStory("t", "Just a bug\n\n### Acceptance criteria\n- [ ] x")).toBeUndefined();
    expect(parseStory("t", "As a user, I want a thing, so that it works.")).toBeUndefined();
    expect(parseStory("t", "")).toBeUndefined();
  });

  it("has no story when a delimiter is twice in the sentence", () => {
    expect(parseStory("t", "As a user, I want a, I want b, so that c.\n\n### Acceptance criteria")).toBeUndefined();
  });

  it("has no story when a field is over its limit", () => {
    const ok = (o: Partial<StoryFields>) => textOf(story(o));
    const one = (p: { title: string; body: string }) => parseStory(p.title, p.body);
    expect(one({ ...ok({}), title: "t".repeat(121) })).toBeUndefined();
    expect(one(ok({ criteria: ["c".repeat(501)] }))).toBeUndefined();
    expect(one(ok({ criteria: Array.from({ length: 51 }, (_, i) => `c${i}`) }))).toBeUndefined();
    expect(one(ok({ dependsOn: Array.from({ length: 21 }, (_, i) => i + 1) }))).toBeUndefined();
    expect(one(ok({ who: "w".repeat(501) }))).toBeUndefined();
    const body = `${ok({ notes: "n".repeat(4990) }).body}\n\n### Extra\n${"e".repeat(30)}`;
    expect(parseStory("t", body)).toBeUndefined();
  });

  it("does not take a heading inside a code fence as a section", () => {
    const body = `${textOf(story()).body.replace("### Depends on", "```\n### Out of scope\nnot a section\n```\n\n### Depends on")}`;
    const got = parseStory("t", body)!;
    expect(got.outOfScope).toBeUndefined();
    expect(got.notes).toContain("not a section");
  });

  it("closes a fence only with as many marks, so a shorter fence inside stays code", () => {
    const body = textOf(story()).body.replace("### Depends on", "````\n```\n### Out of scope\nstill code\n````\n\n### Depends on");
    const got = parseStory("t", body)!;
    expect(got.outOfScope).toBeUndefined();
    expect(got.notes).toContain("still code");
  });

  it("counts a title in characters, not UTF-16 units", () => {
    const p = textOf(story());
    expect(parseStory("😀".repeat(70), p.body)).toBeDefined();
    expect(parseStory("😀".repeat(121), p.body)).toBeUndefined();
  });

  it("takes an Epic line only in its exact form, and a safe number", () => {
    expect(parseStory("t", `**Epic:** #9007199254740993\n\n${textOf(story()).body}`)!.epic).toBeUndefined();
    expect(parseStory("t", `**Epic:** #7\n\n${textOf(story()).body}`)!.epic).toBe(7);
  });
});

describe("cleaning", () => {
  it("removes markers and the refined note", () => {
    const body = ["Text <!-- claude-factory run=1 --> more", "", "---", "Refined in Spaghetti Code Foundry by Ann on 2026-01-01.", "", "<!-- claude-factory refined=abc -->"].join("\n");
    expect(cleanBody(body)).toBe("Text  more");
    expect(cleanBody("a\n<!-- spaghetti-code-foundry status -->\nb")).toBe("a\n\nb");
    expect(cleanBody("a\n<!-- claude-factory never closed\nstill")).toBe("a");
    expect(cleanBody("a\n\nRefined in Spaghetti Code Foundry by Ann on 2026-01-01.")).toBe("a");
  });

  it("handles CRLF and control characters", () => {
    expect(cleanBody("a\r\nb\u0000c")).toBe("a\nbc");
  });

  it("ideaOf with an empty text is the title", () => {
    expect(ideaOf("Title", "")).toBe("Title");
    expect(ideaOf("Title", "Body")).toBe("Title\n\nBody");
    expect(ideaOf("Title", "<!-- claude-factory x -->")).toBe("Title");
  });

  it("draftFromStory marks every field as typed and fits the schema", () => {
    const d = draftFromStory(story({ outOfScope: "o", notes: "n", dependsOn: [3] }));
    expect(DraftsSchema.safeParse([d]).success).toBe(true);
    const froms = [d.title, d.who, d.what, d.why, d.outOfScope, d.notes, ...d.criteria, ...d.dependsOn].map((x) => x!.from);
    expect(new Set(froms)).toEqual(new Set(["typed"]));
  });
});

describe("buildingReason", () => {
  const names = labelNames({} as WatcherConfig);
  const own = labelNames({ status_labels: { working: "Bot_busy", done: "Bot_done", needs_info: "Bot_info", waiting: "Bot_wait" } } as WatcherConfig);
  const base = { labels: [] as string[], runs: [] as { status: any; pr?: string }[], labelNames: names };

  it("is undefined for an issue the Foundry has not touched", () => {
    expect(buildingReason(base)).toBeUndefined();
  });

  it("blocks for running, waiting and queued", () => {
    expect(buildingReason({ ...base, runs: [{ status: "running" }] })).toMatch(/building it now/);
    expect(buildingReason({ ...base, runs: [{ status: "waiting" }] })).toMatch(/waiting/);
    expect(buildingReason({ ...base, queued: true })).toMatch(/queue/);
  });

  it("blocks for each status label, in default names, own names and other case", () => {
    for (const key of ["working", "waiting", "needsInfo", "done"] as const) {
      expect(buildingReason({ ...base, labels: [names[key]] }), key).toBeTruthy();
      expect(buildingReason({ ...base, labels: [own[key]], labelNames: [names, own] }), key).toBeTruthy();
      expect(buildingReason({ ...base, labels: [names[key].toUpperCase()] }), key).toBeTruthy();
      expect(buildingReason({ ...base, labels: [own[key]] }), key).toBeUndefined();
    }
  });

  it("lets a failed run alone and the failed label alone through", () => {
    expect(buildingReason({ ...base, runs: [{ status: "failed" }] })).toBeUndefined();
    expect(buildingReason({ ...base, labels: [names.failed] })).toBeUndefined();
    expect(buildingReason({ ...base, labels: ["bug", "Factory_go"], runs: [{ status: "stopped" }, { status: "cancelled" }] })).toBeUndefined();
  });

  it("blocks for a run with a pull request unless it is closed and not merged", () => {
    const pulls = (k?: PullKind) => (k ? new Map<string, PullKind>([["17", k]]) : new Map<string, PullKind>());
    for (const status of ["succeeded", "failed"] as const) {
      const runs = [{ status, pr: "17" }];
      expect(buildingReason({ ...base, runs, pulls: pulls("open") })).toMatch(/#17/);
      expect(buildingReason({ ...base, runs, pulls: pulls("merged") })).toMatch(/#17/);
      expect(buildingReason({ ...base, runs, pulls: pulls("unknown") })).toMatch(/#17/);
      expect(buildingReason({ ...base, runs, pulls: pulls("gone") })).toMatch(/#17/);
      expect(buildingReason({ ...base, runs, pulls: pulls() })).toMatch(/#17/);
      expect(buildingReason({ ...base, runs, pulls: pulls("closed") })).toBeUndefined();
    }
    expect(buildingReason({ ...base, runs: [{ status: "failed", pr: "x1" }], pulls: new Map([["x1", "closed"]]) })).toMatch(/x1/);
  });

  it("puts a live run before a label", () => {
    expect(buildingReason({ ...base, labels: [names.done], runs: [{ status: "running" }] })).toMatch(/building it now/);
  });

  it("lists each pull request once, newest run first, and skips odd numbers", () => {
    expect(
      pullsToRead([
        { status: "failed", pr: "3", startedAt: "2026-01-01T00:00:00Z" },
        { status: "failed", pr: "5", startedAt: "2026-02-01T00:00:00Z" },
        { status: "failed", pr: "3", startedAt: "2026-03-01T00:00:00Z" },
        { status: "failed", pr: "abc" },
        { status: "failed" },
      ]),
    ).toEqual(["3", "5"]);
  });
});
