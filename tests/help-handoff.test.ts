import { describe, expect, it } from "vitest";
import { ADMIN_ONLY_KEYS, ReplySchema, type Reply } from "../src/help/contract.js";
import { COPIED, HANDOFF_TEXT_MAX, HANDOFF_TITLE_MAX, HandoffCallSchema, HandoffRecordSchema, copiedOf, handoffOffers, ideaText, routeOfRef, sameFill, titleOf, type HandoffInput } from "../src/help/handoff.js";
import { IDEA_MAX, TITLE_MAX } from "../src/refinement/store.js";

const CONV = "11111111-1111-4111-8111-111111111111";
const MSG = "22222222-2222-4222-8222-222222222222";

const reply = (extra: Record<string, unknown> = {}): Reply =>
  ReplySchema.parse({ type: "product-help", summary: "A run is one start of a flow.", explanation: "", certainty: "unverified", evidence: [], recommendations: ["Open the run."], links: [], drafts: [], actions: [], ...extra });
const limit = (code: string) => ({ code, limitation: "x", nextStep: "y" });
const input = (over: Partial<HandoffInput> = {}): HandoffInput => ({ role: "user", conversation: CONV, question: "What is a run?", reply: reply(), found: {}, evidence: [], ...over });
const keys = (over?: Partial<HandoffInput>) => handoffOffers(input(over)).map((o) => o.key);

function allKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, out));
  else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      allKeys(x, out);
    }
  return out;
}

describe("offers for a user", () => {
  it("never include Problems or Your turn", () => {
    expect(keys({ found: { problem: "abcdef0123456789" }, reply: reply({ limit: limit("monitor-finding") }) })).toEqual(["refinement"]);
    expect(keys({ reply: reply({ type: "status", limit: limit("next-step") }) })).toEqual(["refinement"]);
  });
});

describe("offers for an admin", () => {
  it("gives Problems with an id, and without one for the monitor-finding limit", () => {
    const withId = handoffOffers(input({ role: "admin", found: { problem: "abcdef0123456789" } }));
    expect(withId.find((o) => o.key === "problems")?.page).toBe("#/problems/abcdef0123456789");
    expect(handoffOffers(input({ role: "admin", reply: reply({ limit: limit("monitor-finding") }) })).find((o) => o.key === "problems")?.page).toBe("#/problems");
    expect(keys({ role: "admin" })).not.toContain("problems");
  });

  it("gives Your turn for a status reply and for the next-step limit", () => {
    expect(handoffOffers(input({ role: "admin", reply: reply({ type: "status" }) })).find((o) => o.key === "your-turn")?.page).toBe("#/home");
    expect(keys({ role: "admin", reply: reply({ limit: limit("next-step") }) })).toContain("your-turn");
    expect(keys({ role: "admin" })).not.toContain("your-turn");
  });
});

describe("order, pages and fills", () => {
  it("is run, problems, your-turn, refinement, drafts; ids are encoded", () => {
    const r = reply({ type: "status", drafts: [{ title: "One", text: "t1" }, { title: "Two", text: "t2" }] });
    const offers = handoffOffers(input({ role: "admin", reply: r, found: { run: "a/b c", problem: "abcdef0123456789" } }));
    expect(offers.map((o) => o.key)).toEqual(["run", "problems", "your-turn", "refinement", "issue-draft-0", "issue-draft-1"]);
    expect(offers[0]!.page).toBe("#/runs/a%2Fb%20c");
    expect(offers[0]!.fill).toBeUndefined();
    expect(offers.slice(3).every((o) => o.page === "#/refinement")).toBe(true);
  });

  it("gives every reply a refinement offer whose text is the idea text and holds no conversation id", () => {
    const o = handoffOffers(input({ evidence: ["- Run x · #/runs/x"], repo: "acme/app" })).find((x) => x.key === "refinement")!;
    expect(o.fill).toEqual({ title: "What is a run?", text: ideaText("What is a run?", reply(), ["- Run x · #/runs/x"]), repo: "acme/app", fromHelp: CONV });
    expect(o.fill!.text).not.toContain(CONV);
    expect(o.fill!.text).toContain("Sources:\n- Run x · #/runs/x");
  });

  it("leaves the summary out of the idea of a limit reply", () => {
    const text = ideaText("Q?", reply({ limit: limit("not-scf") }), []);
    expect(text).not.toContain("A run is one start of a flow.");
    expect(text).toContain("- Open the run.");
  });

  it("gives each draft its title and text, and a repo only when one is set", () => {
    const r = reply({ drafts: [{ title: "Comment", text: "Do the thing" }] });
    const plain = handoffOffers(input({ reply: r })).find((o) => o.key === "issue-draft-0")!;
    expect(plain.fill).toEqual({ title: "Comment", text: "Do the thing", fromHelp: CONV });
    expect("repo" in plain.fill!).toBe(false);
    expect(handoffOffers(input({ reply: r, repo: "acme/app" })).find((o) => o.key === "issue-draft-0")!.fill!.repo).toBe("acme/app");
  });

  it("keeps no admin-only key at any depth", () => {
    const offers = handoffOffers(input({ role: "admin", reply: reply({ type: "status", drafts: [{ title: "One", text: "t" }] }), found: { run: "r", problem: "abcdef0123456789" }, repo: "a/b" }));
    const record = { message: MSG, where: "run", page: "#/runs/r", copied: [], at: "2026-03-01T10:00:00.000Z" };
    for (const k of [...allKeys(offers), ...allKeys(record)]) expect(ADMIN_ONLY_KEYS).not.toContain(k);
  });
});

describe("routeOfRef", () => {
  it("takes the route out of a ref", () => {
    expect(routeOfRef("run x · #/runs/x")).toBe("#/runs/x");
    expect(routeOfRef("diagnosis · run x · #/runs/x")).toBe("#/runs/x");
    expect(routeOfRef("#/runs")).toBe("#/runs");
  });
  it("gives nothing for anything else", () => {
    for (const bad of ["compared by the server", "https://evil/#/runs", "run x · #/runs/x?y=1", "run x · #/runs/x y", ""]) expect(routeOfRef(bad), bad).toBeUndefined();
  });
});

describe("titleOf and ideaText", () => {
  it("cuts and cleans the first line", () => {
    expect(titleOf("x".repeat(300))).toHaveLength(HANDOFF_TITLE_MAX);
    expect(titleOf("\n a\tb\u0001c \nsecond")).toBe("a b c");
    expect(titleOf("  \n ")).toBe("Ask SCF answer");
  });

  it("drops sources from the end to fit, and cuts a long question", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `- ${"s".repeat(1500)}${i} · #/runs/r${i}`);
    const text = ideaText("q", reply(), lines);
    expect(text.length).toBeLessThanOrEqual(HANDOFF_TEXT_MAX);
    expect(text).toContain("r0");
    expect(text).not.toContain("r9");
    const cut = ideaText("q".repeat(4000), reply(), []);
    expect(cut).toContain(`${"q".repeat(2000)} …`);
    expect(cut).not.toContain("q".repeat(2001));
    expect(ideaText("q", reply(), [])).not.toContain("Sources:");
  });

  it("keeps the same limits as refinement sessions", () => {
    expect(HANDOFF_TEXT_MAX).toBe(IDEA_MAX);
    expect(HANDOFF_TITLE_MAX).toBe(TITLE_MAX);
  });
});

describe("copiedOf and sameFill", () => {
  it("lists what an offer copies", () => {
    const [nav] = handoffOffers(input({ found: { run: "r" } }));
    expect(copiedOf(nav!)).toEqual([]);
    const withRepo = handoffOffers(input({ repo: "a/b" })).find((o) => o.key === "refinement")!;
    expect(copiedOf(withRepo)).toEqual(["title", "text", "repository", "link"]);
    expect(copiedOf(handoffOffers(input()).find((o) => o.key === "refinement")!)).toEqual(["title", "text", "link"]);
    for (const c of copiedOf(withRepo)) expect(COPIED).toContain(c);
  });

  it("compares fills field by field, ignoring key order", () => {
    const a = { title: "t", text: "x", fromHelp: CONV };
    expect(sameFill(a, { fromHelp: CONV, text: "x", title: "t" })).toBe(true);
    expect(sameFill(a, { ...a, text: "y" })).toBe(false);
    expect(sameFill(a, undefined)).toBe(false);
    expect(sameFill(undefined, undefined)).toBe(true);
  });
});

describe("schemas", () => {
  const rec = { message: MSG, where: "run", page: "#/runs/r", copied: [], at: "2026-03-01T10:00:00.000Z" };
  it("refuse an extra field and a page with a query", () => {
    expect(HandoffRecordSchema.safeParse(rec).success).toBe(true);
    expect(HandoffRecordSchema.safeParse({ ...rec, extra: 1 }).success).toBe(false);
    expect(HandoffRecordSchema.safeParse({ ...rec, page: "#/runs?x=1" }).success).toBe(false);
  });
  it("refuse a numeric offer, a missing page and a long title", () => {
    const call = { message: MSG, offer: "run", page: "#/runs/r" };
    expect(HandoffCallSchema.safeParse(call).success).toBe(true);
    expect(HandoffCallSchema.safeParse({ ...call, offer: 1 }).success).toBe(false);
    expect(HandoffCallSchema.safeParse({ message: MSG, offer: "run" }).success).toBe(false);
    expect(HandoffCallSchema.safeParse({ ...call, fill: { title: "t".repeat(121), text: "x", fromHelp: CONV } }).success).toBe(false);
    expect(HandoffCallSchema.safeParse({ ...call, fill: { title: "t".repeat(120), text: "x", fromHelp: CONV } }).success).toBe(true);
  });
});
