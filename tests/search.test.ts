import { describe, expect, it } from "vitest";
import { HttpError } from "../src/server/http.js";
import { parseIds, rank, scoreOf, searchFor, wordsOf, type SearchHit } from "../src/server/search.js";

describe("wordsOf", () => {
  it("lower-cases, splits on white space and drops repeats", () => {
    expect(wordsOf("  Fix\tLOGIN\nfix  page ")).toEqual(["fix", "login", "page"]);
  });
  it("gives no words for a blank text", () => {
    expect(wordsOf("   \n")).toEqual([]);
    expect(wordsOf("")).toEqual([]);
  });
});

describe("scoreOf", () => {
  const s = (w: string, text: string) => scoreOf(wordsOf(w), { text: [text] });
  it("ranks equal above prefix above word start above contains", () => {
    const scores = [s("login", "login"), s("login", "login page"), s("login", "fix login"), s("login", "relogin")];
    expect(scores.every((x) => x > 0)).toBe(true);
    expect(scores[0]).toBeGreaterThan(scores[1]!);
    expect(scores[1]).toBeGreaterThan(scores[2]!);
    expect(scores[2]).toBeGreaterThan(scores[3]!);
  });
  it("matches #254 with numbers only", () => {
    expect(scoreOf(["#254"], { text: ["254 things"] })).toBe(0);
    expect(scoreOf(["#254"], { text: [], numbers: ["254"] })).toBeGreaterThan(0);
    expect(scoreOf(["#25"], { text: [], numbers: [254] })).toBeGreaterThan(0);
    expect(scoreOf(["#25"], { text: [], numbers: ["1254"] })).toBe(0);
  });
  it("matches 254 and 25 with numbers and text", () => {
    expect(scoreOf(["254"], { text: [], numbers: ["254"] })).toBeGreaterThan(0);
    expect(scoreOf(["25"], { text: [], numbers: ["254"] })).toBeGreaterThan(0);
    expect(scoreOf(["254"], { text: ["254 things"] })).toBeGreaterThan(0);
  });
  it("counts a repeated word once", () => {
    expect(scoreOf(["fix", "fix"], { text: ["fix"] })).toBe(scoreOf(["fix"], { text: ["fix"] }));
  });
  it("is 0 when one word matches nothing", () => {
    expect(scoreOf(wordsOf("a b c d e f nothing"), { text: ["a b c d e f"] })).toBe(0);
  });
  it("skips fields that are not text", () => {
    expect(scoreOf(["fix"], { text: [undefined, 5, null, "fix"] })).toBeGreaterThan(0);
    expect(scoreOf(["fix"], { text: [undefined, 5] })).toBe(0);
    expect(scoreOf([], { text: ["fix"] })).toBe(0);
  });
});

describe("rank", () => {
  const c = (id: string, score: number, at?: string) => ({ score, hit: { type: "run", id, title: id, href: "#", ...(at ? { at } : {}) } as SearchHit });
  it("sorts by score, then newest, then a missing time last, then id", () => {
    const r = rank([c("b", 1, "2026-01-01"), c("a", 1, "2026-01-01"), c("n", 1), c("new", 1, "2026-02-01"), c("top", 5, "2020-01-01")]);
    expect(r.hits.map((h) => h.id)).toEqual(["top", "new", "a", "b", "n"]);
  });
  it("keeps 8 and says when there are more", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => c(`r${i}`, 1));
    expect(rank(many(9))).toMatchObject({ more: true });
    expect(rank(many(9)).hits).toHaveLength(8);
    expect(rank(many(8))).toMatchObject({ more: false });
  });
});

describe("parseIds", () => {
  const code = (raw: string[]) => {
    try {
      parseIds(raw);
    } catch (e) {
      return (e as HttpError).status;
    }
    return 0;
  };
  it("refuses bad ids with 400", () => {
    expect(code(Array.from({ length: 9 }, (_, i) => `run:r${i}`))).toBe(400);
    expect(code([])).toBe(400);
    for (const bad of ["x:1", "run:", "run:a/b", "repo:not-a-uuid", "issue:acme/app", "run", "flow:a b"]) expect(code([bad]), bad).toBe(400);
  });
  it("accepts good ids, drops repeats and keeps the order", () => {
    expect(parseIds(["issue:acme/app#254", "flow:walk", "run:r-1", "flow:walk"])).toEqual([
      { type: "issue", id: "acme/app#254" },
      { type: "flow", id: "walk" },
      { type: "run", id: "r-1" },
    ]);
  });
});

describe("searchFor", () => {
  it("reads nothing for a blank query", () => {
    const ctx = new Proxy({}, { get: () => { throw new Error("read"); } }) as never;
    const user = new Proxy({}, { get: () => { throw new Error("read"); } }) as never;
    expect(searchFor(ctx, user, { q: "  " })).toEqual({ q: "", groups: [] });
  });
});
