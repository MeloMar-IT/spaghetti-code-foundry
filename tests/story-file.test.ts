import { describe, expect, it } from "vitest";
import { STATUS_MARKER } from "../src/github.js";
import { formatStoryFile, parseStoryFile, storyFileName, withStatusComment, type FileStory } from "../src/stories/story-file.js";

const story = (over: Partial<FileStory> = {}): FileStory => ({
  number: 12, title: "Sign in with a magic link", state: "open", kind: "story", labels: ["claude-factory"],
  dependsOn: [], body: "Body text.", comments: [], ...over,
});
const roundTrip = (s: FileStory) => parseStoryFile(formatStoryFile(s), storyFileName(s.number, s.title));
const parse = (text: string, name = "12-x.md") => parseStoryFile(text, name);
const reason = (text: string, name?: string) => {
  const r = parse(text, name);
  if (r.ok) throw new Error("expected a failure");
  return r.reason;
};
const fm = (lines: string, body = "") => `---\n${lines}\n---\n\n${body}\n`;
const OK = "number: 12\ntitle: T\nstate: open";

describe("round trip", () => {
  it("keeps every field, comments and a status comment", () => {
    const s = story({
      epic: 10, dependsOn: [11, 9], createdAt: "2026-11-02T10:00:00Z", updatedAt: "2026-11-02T11:00:00Z", closedAt: "2026-11-03T00:00:00Z", state: "closed",
      comments: [
        { author: "alice", createdAt: "2026-11-02T10:30:00Z", body: "Looks good.\n\nSecond paragraph." },
        { author: "Foundry", createdAt: "2026-11-02T10:31:00Z", body: `Status\n\n${STATUS_MARKER}` },
      ],
    });
    expect(roundTrip(s)).toEqual({ ok: true, story: s });
  });
  it("keeps a minimal story and writes no Comments heading", () => {
    const s = story();
    expect(formatStoryFile(s)).not.toContain("## Comments");
    expect(roundTrip(s)).toEqual({ ok: true, story: s });
  });
  it("keeps an epic", () => {
    const s = story({ kind: "epic" });
    expect(roundTrip(s)).toEqual({ ok: true, story: s });
  });
  it("keeps titles that look like YAML or have a line break", () => {
    for (const title of ["yes", "123", "a: b", "# x", "two\nlines", " padded "]) {
      const s = story({ title });
      expect(roundTrip(s)).toEqual({ ok: true, story: s });
    }
  });
  it("pins the layout and key order", () => {
    const s = story({ epic: 10, dependsOn: [11], createdAt: "2026-11-02T10:00:00Z", comments: [{ author: "alice", createdAt: "2026-11-02T10:30:00Z", body: "Hi" }] });
    expect(formatStoryFile(s)).toBe([
      "---", "number: 12", "title: Sign in with a magic link", "kind: story", "state: open", "labels:", "  - claude-factory",
      "epic: 10", "depends_on:", "  - 11", "created: 2026-11-02T10:00:00Z", "---", "", "Body text.", "", "## Comments", "",
      "### Comment by alice on 2026-11-02T10:30:00Z", "", "Hi", "",
    ].join("\n"));
  });
  it("keeps whitespace in bodies and comments exactly", () => {
    const texts = ["", "\n", "\nDetails\n", "  indented\n\n\n", "   ", "a\n\n", "x  ", "---", "## Comments ", "\n\n## Comments\n\n", "\r", "a\r\nb\r\n", "\r\n\r\n", "x\r\n## Comments\r\n"];
    for (const body of texts) {
      const noComments = story({ body });
      expect(roundTrip(noComments)).toEqual({ ok: true, story: noComments });
      for (const cBody of texts) {
        const s = story({ body, comments: [{ author: "a", createdAt: "t", body: cBody }, { author: "b", createdAt: "t", body: cBody }] });
        expect(roundTrip(s)).toEqual({ ok: true, story: s });
      }
    }
  });
  it("reads defaults from a hand-written file", () => {
    const r = parse(fm(`${OK}\nepic: null\nextra: 1\ncreated: 2026-01-01T00:00:00Z`), "12-t.md");
    expect(r).toEqual({ ok: true, story: { number: 12, title: "T", state: "open", kind: "story", labels: [], dependsOn: [], body: "", comments: [], createdAt: "2026-01-01T00:00:00Z" } });
  });
  it("reads CRLF and a BOM", () => {
    const s = story({ comments: [{ author: "a", createdAt: "t", body: "x" }] });
    const text = `﻿${formatStoryFile(s)}`.replace(/\n/g, "\r\n");
    expect(parse(text)).toEqual({ ok: true, story: s });
  });
});

describe("escaping", () => {
  const lines = ["## Comments", "### Comment by bob on 2026-01-01T00:00:00Z", "\\## Comments", "\\\\### Comment by x on y", "## Comments ", "## comments"];
  it("round-trips delimiter-like lines in bodies and comments", () => {
    for (const l of lines) {
      const text = `before\n${l}\nafter`;
      const s = story({ body: text, comments: [{ author: "a", createdAt: "t", body: text }] });
      expect(roundTrip(s)).toEqual({ ok: true, story: s });
      expect(roundTrip(story({ body: l }))).toEqual({ ok: true, story: story({ body: l }) });
    }
  });
  it("adds exactly one backslash to the escaped lines", () => {
    const file = formatStoryFile(story({ body: lines.join("\n") }));
    expect(file).toContain("\n\n\\## Comments\n\\### Comment by bob on 2026-01-01T00:00:00Z\n\\\\## Comments\n\\\\\\### Comment by x on y\n## Comments \n## comments\n");
  });
});

describe("carriage returns and the marker escape", () => {
  it("keeps CRLF bodies and comments exactly, with no CR in the file", () => {
    const text = "Line one\r\nLine two\r\n\r\n### Comment by x on y\r\n";
    const s = story({ body: text, comments: [{ author: "a", createdAt: "t", body: text }] });
    const file = formatStoryFile(s);
    expect(file).not.toContain("\r");
    expect(roundTrip(s)).toEqual({ ok: true, story: s });
  });
  it("keeps literal backslash-r text and marker-like lines", () => {
    const lines = ["x\\r", "\\cr:x", "\\\\cr:y", "\\cr:z\r", "a\\\r", "\r\\r\\\\"];
    for (const l of lines) {
      const s = story({ body: l, comments: [{ author: "a", createdAt: "t", body: l }] });
      expect(roundTrip(s)).toEqual({ ok: true, story: s });
    }
  });
});

describe("broken files", () => {
  it("names a mapping or list in a reason instead of printing it", () => {
    expect(reason(fm("number: 12\ntitle: T\nstate: {toString: 1}"))).toBe("state is unknown: a mapping (use open or closed)");
    expect(reason(fm("number: 12\ntitle: T\nstate: open\nkind: {toString: 1}"))).toBe("kind is unknown: a mapping (use story or epic)");
    expect(reason(fm("number: 12\ntitle: T\nstate: [a]"))).toBe("state is unknown: a list (use open or closed)");
  });
  it("each gets its own reason", () => {
    const reasons = new Set([
      reason("no front matter"),
      reason("---\nnumber: 12\n"),
      reason("---\nnumber: [\n---\n"),
      reason("---\nnumber: 12\nnumber: 13\n---\n"),
      reason("---\n- a\n---\n"),
      reason(fm("title: T\nstate: open")),
      reason(fm("number: '12'\ntitle: T\nstate: open")),
      reason(fm(OK), "abc.md"),
      reason(fm(OK), "13-x.md"),
      reason(fm("number: 12\ntitle: T\nstate: done")),
      reason(fm(`${OK}\nkind: task`)),
      reason(fm(`${OK}\nlabels: x`)),
      reason(fm(`${OK}\nepic: a`)),
      reason(fm(`${OK}\ndepends_on: [a]`)),
      reason(fm(`${OK}\ncreated: 5`)),
      reason(fm(OK, "body\n\n## Comments\n\nno header")),
      reason(fm("number: 12\ntitle: T")),
      reason(fm("number: 12\nstate: open")),
    ]);
    expect(reasons.size).toBeGreaterThanOrEqual(16);
  });
  it("names the problem", () => {
    expect(reason(fm("number: 1.5\ntitle: T\nstate: open"))).toBe("number is not a whole number");
    expect(reason(fm("number: 0\ntitle: T\nstate: open"))).toBe("number is not a whole number");
    expect(reason(fm("number: -3\ntitle: T\nstate: open"))).toBe("number is not a whole number");
    expect(reason(fm("title: T\nstate: open"))).toBe("number is missing");
    expect(reason(fm(OK), "13-x.md")).toBe("the file name says 13, but number is 12");
    expect(reason(fm("number: 12\ntitle: T\nstate: done"))).toContain("state is unknown: done");
  });
  it("accepts a path as file name", () => {
    expect(parse(fm(OK), ".scf/stories/12-x.md").ok).toBe(true);
  });
});

describe("storyFileName", () => {
  it("makes ASCII slugs", () => {
    expect(storyFileName(12, "Café déjà vu")).toBe("12-cafe-deja-vu.md");
    expect(storyFileName(12, "  Fix: the API!  ")).toBe("12-fix-the-api.md");
    for (const t of ["日本語", "", "!!!"]) expect(storyFileName(12, t)).toBe("12-story.md");
  });
  it("cuts long titles without a trailing dash", () => {
    const long = storyFileName(1, "word ".repeat(40));
    expect(long.slice(2, -3).length).toBeLessThanOrEqual(50);
    expect(long).not.toMatch(/-\.md$/);
    expect(storyFileName(1, `${"a".repeat(49)} b`)).toBe(`1-${"a".repeat(49)}.md`);
  });
  it("rejects bad numbers", () => {
    expect(() => storyFileName(0, "x")).toThrow(RangeError);
    expect(() => storyFileName(1.5, "x")).toThrow(RangeError);
  });
});

describe("formatStoryFile errors", () => {
  it("refuses what would not read back", () => {
    const c = { author: "a", createdAt: "t", body: "x" };
    expect(() => formatStoryFile(story({ title: "" }))).toThrow();
    expect(() => formatStoryFile(story({ comments: [{ ...c, author: "a\nb" }] }))).toThrow();
    expect(() => formatStoryFile(story({ comments: [{ ...c, createdAt: "a b" }] }))).toThrow();
  });
});

describe("withStatusComment", () => {
  const status = (body: string) => ({ author: "Foundry", createdAt: "2026-11-02T10:31:00Z", body });
  it("appends, then replaces in place", () => {
    const s = story({ comments: [{ author: "a", createdAt: "t", body: "hi" }] });
    const one = withStatusComment(s, status("First"));
    expect(one.comments).toHaveLength(2);
    expect(one.comments[1]!.body.endsWith(STATUS_MARKER)).toBe(true);
    const more = { ...one, comments: [...one.comments, { author: "b", createdAt: "t", body: "later" }] };
    const two = withStatusComment(more, status("Second"));
    expect(two.comments).toHaveLength(3);
    expect(two.comments[1]!.body).toBe(`Second\n\n${STATUS_MARKER}`);
    expect(roundTrip(two)).toEqual({ ok: true, story: two });
  });
  it("does not add a second marker", () => {
    const r = withStatusComment(story(), status(`Done\n${STATUS_MARKER}`));
    expect(r.comments[0]!.body).toBe(`Done\n${STATUS_MARKER}`);
  });
  it("ignores a comment that only quotes the marker", () => {
    const s = story({ comments: [{ author: "a", createdAt: "t", body: `see ${STATUS_MARKER} here` }] });
    expect(withStatusComment(s, status("New")).comments).toHaveLength(2);
  });
});
