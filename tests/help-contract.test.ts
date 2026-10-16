import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ACTIONS,
  ACTION_DROPPED,
  ACTION_RULES,
  ADMIN_ONLY_KEYS,
  LIST_MAX,
  claimsAction,
  CERTAINTY,
  CERTAINTY_WORDS,
  HANDOFFS,
  LIMIT_CODES,
  NAV_PAGES,
  PART_KINDS,
  PART_RULES,
  QUESTION_RULES,
  QUESTION_TYPES,
  READ_ONLY_BY_DEFAULT,
  ReplySchema,
  TEXT_MAX,
  actionAllowed,
  certaintyOf,
  checkReply,
  contractFor,
  displayText,
  forRole,
  hideNames,
  limitationFor,
  navPage,
  type Evidence,
} from "../src/help/contract.js";

const DOC: Evidence = { id: "D1", kind: "doc", title: "The run page", ref: "User guide, chapter 3" };
const STATE: Evidence = { id: "S1", kind: "state", title: "Run 2026-01-01 is waiting for approval", ref: "#/runs", observedAt: "2026-01-01T10:00:00.000Z" };
const good = { type: "product-help", summary: "A run is one start of a flow.", explanation: "It has steps.", certainty: "confirmed", evidence: ["D1"] };

describe("the Ask SCF contract", () => {
  it("names the four kinds of question, each with the evidence its answer needs", () => {
    expect([...QUESTION_TYPES]).toEqual(["product-help", "status", "troubleshooting", "guided-resolution"]);
    expect(QUESTION_RULES["product-help"].evidence).toBe("doc");
    for (const t of ["status", "troubleshooting", "guided-resolution"] as const) expect(QUESTION_RULES[t].evidence).toBe("state");
  });

  it("tells answers, recommendations, navigation, plans, drafts and actions apart: only an action changes something", () => {
    expect([...PART_KINDS]).toEqual(["answer", "recommendation", "navigation", "plan", "draft", "action"]);
    for (const k of PART_KINDS) {
      expect(PART_RULES[k].changesState, k).toBe(k === "action");
      expect(PART_RULES[k].needsConfirmation, k).toBe(k === "action");
      expect(PART_RULES[k].what.length).toBeGreaterThan(10);
    }
    expect(new Set(PART_KINDS.map((k) => PART_RULES[k].what)).size).toBe(PART_KINDS.length);
  });

  it("is read-only by default: two actions of the asker's own runs, each with a fixed effect that claims no result", () => {
    expect(READ_ONLY_BY_DEFAULT).toBe(true);
    expect(ACTIONS.map((a) => [a.id, a.impact, a.undoable, a.roles])).toEqual([
      ["resume-run", "reversible", true, ["admin", "user"]],
      ["cancel-run", "high", false, ["admin", "user"]],
    ]);
    for (const a of ACTIONS) {
      expect(a.effect.length).toBeGreaterThan(0);
      expect(a.effect.length).toBeLessThanOrEqual(TEXT_MAX.item);
      expect(claimsAction(a.effect)).toBe(false);
    }
    expect(actionAllowed("admin", "cancel-run")).toBe(true);
    expect(actionAllowed("user", "cancel-run")).toBe(true);
    expect(actionAllowed("user", "")).toBe(false);
    expect(ACTION_RULES).toHaveLength(5);
  });

  it("links only to pages the interface has, with the same roles", async () => {
    const ia = (await import("../ui/ia.js" as string)) as { PAGES: { path: string; roles: string[] }[] };
    for (const p of NAV_PAGES) {
      const page = ia.PAGES.find((x) => x.path === p.to);
      expect(page, p.to).toBeDefined();
      expect([...page!.roles].sort(), p.to).toEqual([...p.roles].sort());
      expect(p.to).not.toContain(":");
    }
    expect(navPage("user", "#/problems")).toBeUndefined();
    expect(navPage("admin", "#/problems")?.title).toBe("Problems");
    expect(navPage("user", "#/runs/123")).toBeUndefined();
    expect(navPage("admin", "https://example.com")).toBeUndefined();
  });
});

describe("requests that are not served", () => {
  it("gives every one a limitation and the safest next step, in plain sentences, for both roles", () => {
    for (const role of ["admin", "user"] as const) {
      for (const code of LIMIT_CODES) {
        const l = limitationFor(code, role);
        expect(l.code).toBe(code);
        expect(l.limitation, code).toMatch(/^[A-Z].*\.$/s);
        expect(l.nextStep, code).toMatch(/^[A-Z].*\.$/s);
        if (l.to !== undefined) expect(navPage(role, l.to), `${role} ${code}`).toBeDefined();
      }
    }
  });

  it("sends backlog refinement, the next step and monitor findings to their own place", () => {
    expect(Object.keys(HANDOFFS).sort()).toEqual(["monitor-finding", "next-step", "refinement"]);
    expect(limitationFor("refinement", "user")).toMatchObject({ to: "#/refinement", nextStep: expect.stringContaining("Refinement") });
    expect(limitationFor("next-step", "admin").to).toBe("#/home");
    expect(limitationFor("next-step", "user").to).toBe("#/runs");
    expect(limitationFor("monitor-finding", "admin").to).toBe("#/problems");
  });

  it("never points a user at a page or a fact of the administrators", () => {
    const finding = limitationFor("monitor-finding", "user");
    expect(finding.to).toBeUndefined();
    expect(finding.nextStep).toBe("Ask an administrator of this Foundry.");
    expect(limitationFor("admin-only", "user").to).toBeUndefined();
    for (const code of LIMIT_CODES) expect(JSON.stringify(limitationFor(code, "user"))).not.toMatch(/#\/(problems|settings|users|models|board)/);
  });

  it("answers a limit with the server's own words only, whatever else the model wrote", () => {
    const c = checkReply({ ...good, limit: "changes-state", summary: "Sure, I deleted the run.", actions: [{ id: "delete-run" }], links: [{ to: "#/settings" }], drafts: [{ text: "x" }] }, { role: "user", offered: [DOC] })!;
    expect(c.reply.summary).toBe(limitationFor("changes-state", "user").limitation);
    expect(c.reply.recommendations).toEqual([limitationFor("changes-state", "user").nextStep]);
    expect(c.reply).toMatchObject({ explanation: "", actions: [], drafts: [], links: [], evidence: [], limit: { code: "changes-state" } });
    expect(JSON.stringify(c.reply)).not.toContain("deleted");
    expect(checkReply({ limit: "refinement" }, { role: "user" })!.reply.links).toEqual([{ label: "Refinement", to: "#/refinement" }]);
    expect(displayText(c.reply)).toBe(`${c.reply.summary}\n\nWhat you can do:\n- ${c.reply.recommendations[0]}`);
  });

  it("treats an unknown limit code as no limit, and says so", () => {
    const c = checkReply({ ...good, limit: "do-anything" }, { role: "user", offered: [DOC] })!;
    expect(c.reply.limit).toBeUndefined();
    expect(c.dropped).toContain("limit: unknown code");
  });
});

describe("evidence and uncertainty", () => {
  it("lets a reply say it is sure only with evidence of the kind its question needs", () => {
    expect(certaintyOf("product-help", "confirmed", [DOC])).toBe("confirmed");
    expect(certaintyOf("product-help", "likely", [DOC])).toBe("likely");
    expect(certaintyOf("product-help", "confirmed", [])).toBe("unverified");
    expect(certaintyOf("status", "confirmed", [DOC])).toBe("unverified");
    expect(certaintyOf("status", "confirmed", [STATE])).toBe("confirmed");
    expect(certaintyOf("troubleshooting", "unverified", [STATE])).toBe("unverified");
  });

  it("has fixed words for every level", () => {
    expect([...CERTAINTY]).toEqual(["confirmed", "likely", "unverified"]);
    expect(CERTAINTY_WORDS.unverified).toContain("could not check");
  });

  it("keeps only evidence the server offered", () => {
    const c = checkReply({ ...good, evidence: ["D1", "D1", "X9", { id: "D1" }, 4] }, { role: "user", offered: [DOC, STATE] })!;
    expect(c.reply.evidence).toEqual([DOC]);
    expect(c.dropped.filter((d) => d.startsWith("evidence"))).toHaveLength(3);
    expect(c.reply.certainty).toBe("confirmed");
    const none = checkReply(good, { role: "user" })!;
    expect(none.reply.evidence).toEqual([]);
    expect(none.reply.certainty).toBe("unverified");
    expect(displayText(none.reply)).toContain(CERTAINTY_WORDS.unverified);
  });

  it("wants the time of observation on current state", () => {
    const check = (e: unknown) => ReplySchema.safeParse({ type: "status", summary: "s", explanation: "", certainty: "confirmed", evidence: [e], recommendations: [], links: [], drafts: [], actions: [] }).success;
    expect(check(STATE)).toBe(true);
    expect(check({ ...STATE, observedAt: undefined })).toBe(false);
    expect(check(DOC)).toBe(true);
    expect(displayText(checkReply({ type: "status", summary: "It waits.", certainty: "confirmed", evidence: ["S1"] }, { role: "user", offered: [STATE] })!.reply)).toContain("seen 2026-01-01T10:00:00.000Z");
  });
});

describe("a checked reply", () => {
  it("drops every action, a link to a page the role does not have, and a link that is not a page", () => {
    const raw = {
      ...good,
      recommendations: ["Open the run.", "", 7],
      links: [{ label: "Click here to win", to: "#/runs" }, { to: "#/settings" }, { to: "javascript:alert(1)" }, { to: "#/runs" }, "x"],
      drafts: [{ title: "Comment", text: "Please look at this." }, { text: "" }],
      actions: [{ id: "cancel-run", title: "Cancel", impact: "stops it" }, "rm -rf"],
    };
    const user = checkReply(raw, { role: "user", offered: [DOC] })!;
    expect(user.reply.links).toEqual([{ label: "Runs", to: "#/runs" }]);
    expect(user.reply.actions).toEqual([]);
    expect(user.reply.recommendations).toEqual(["Open the run."]);
    expect(user.reply.drafts).toEqual([{ title: "Comment", text: "Please look at this." }]);
    expect(user.dropped.filter((d) => d.startsWith("action"))).toHaveLength(2);
    expect(user.dropped).toContain(ACTION_DROPPED.unbound);
    expect(user.dropped.filter((d) => d.startsWith("link"))).toHaveLength(3);
    expect(ReplySchema.safeParse(user.reply).success).toBe(true);
    const admin = checkReply(raw, { role: "admin", offered: [DOC] })!;
    expect(admin.reply.links.map((l) => l.to)).toEqual(["#/runs", "#/settings"]);
    expect(admin.reply.actions).toEqual([]);
  });

  it("refuses what is not a reply", () => {
    for (const raw of [undefined, null, "text", 3, [], {}, { summary: "   " }, { summary: 5 }]) expect(checkReply(raw, { role: "user" }), JSON.stringify(raw)).toBeUndefined();
  });

  it("cuts long texts, removes control characters and passes every text through the cleaner", () => {
    const c = checkReply({ summary: `a\u0000b\u009b ${"x".repeat(900)}`, explanation: "the token is hunter2", type: "nonsense", certainty: "certain" }, { role: "user", clean: (t) => t.replace("hunter2", "***") })!;
    expect(c.reply.summary.startsWith("ab x")).toBe(true);
    expect(c.reply.summary.length).toBe(TEXT_MAX.summary);
    expect(c.reply.explanation).toBe("the token is ***");
    expect(c.reply.type).toBe("product-help");
    expect(c.reply.certainty).toBe("unverified");
  });

  it("writes the display text from the checked parts, with drafts marked as not sent", () => {
    const c = checkReply({ ...good, recommendations: ["Open the run."], links: [{ to: "#/runs" }], drafts: [{ title: "Comment", text: "Hello" }] }, { role: "user", offered: [DOC] })!;
    expect(displayText(c.reply)).toBe(
      [
        "A run is one start of a flow.", "", "It has steps.", "", "What you could do:", "- Open the run.", "", "Draft (not sent): Comment", "Hello", "",
        "Pages:", "- Runs (#/runs)", "", "Sources:", "- The run page (User guide, chapter 3)", "", CERTAINTY_WORDS.confirmed,
      ].join("\n"),
    );
  });
});

describe("what a normal user never sees", () => {
  const turn = { id: "m1", text: "hi", run: { model: "sonnet", provider: "anthropic", costUsd: 0.02, ms: 900 }, parts: [{ usage: { inputTokens: 5 }, text: "t" }], failure: { code: "provider", detail: "429 from api" } };

  it("leaves models, providers, costs, tokens and server detail out for a user, at any depth", () => {
    const seen = forRole("user", turn);
    expect(seen).toEqual({ id: "m1", text: "hi", run: { ms: 900 }, parts: [{ text: "t" }], failure: { code: "provider" } });
    const keys = (v: unknown): string[] => (v !== null && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [k, ...keys(x)]) : []);
    expect(keys(seen).filter((k) => ADMIN_ONLY_KEYS.includes(k))).toEqual([]);
    expect(forRole("admin", turn)).toBe(turn);
  });

  it("replaces the names of models and providers in a text", () => {
    expect(hideNames("I am claude-sonnet-4 from Anthropic, not Sonnet.", ["sonnet", "claude-sonnet-4", "anthropic", undefined, "x"])).toBe("I am the AI model from the AI model, not the AI model.");
    expect(hideNames("a.b costs", ["a.b"])).toBe("the AI model costs");
    expect(hideNames("axb", ["a.b"])).toBe("axb");
  });

  it("gives a user a contract without the pages and words of the administrators", () => {
    const user = contractFor("user");
    expect(user.readOnly).toBe(true);
    expect(user.pages.map((p) => p.to)).toEqual(["#/home", "#/runs", "#/start", "#/repos", "#/refinement", "#/refinement/backlog"]);
    expect(user.limits).toHaveLength(LIMIT_CODES.length);
    expect(user.actions).toEqual([
      { id: "resume-run", title: "Resume the run" },
      { id: "cancel-run", title: "Cancel the run" },
    ]);
    expect(contractFor("admin").pages.length).toBe(NAV_PAGES.length);
  });
});

describe("the plan of a reply", () => {
  const DIAG: Evidence = { id: "diagnosis-run-0123456789", kind: "state", title: "Diagnosis: the step failed", ref: "#/runs", observedAt: "2026-01-01T10:00:00.000Z" };
  const step = (over: Record<string, unknown> = {}) => ({ kind: "reversible", title: "Save a copy of the log", evidence: ["S1"], expected: "You have a copy.", failure: "The copy is empty.", fallback: "Leave it as it is.", ...over });
  const high = (over: Record<string, unknown> = {}) => step({ kind: "high-impact", title: "Start the step again", evidence: [DIAG.id], ...over });
  const base = { type: "guided-resolution", summary: "Steps.", certainty: "confirmed", evidence: ["S1", DIAG.id] };
  const check = (plan: unknown[], over: Record<string, unknown> = {}, input: Record<string, unknown> = {}) => checkReply({ ...base, plan, ...over }, { role: "user", offered: [STATE, DIAG], ...input })!;

  it("is stored only when it has steps: no plan key otherwise", () => {
    expect("plan" in check([]).reply).toBe(false);
    expect("plan" in checkReply(good, { role: "user", offered: [DOC] })!.reply).toBe(false);
    expect("plan" in check(["x", 3, null]).reply).toBe(false);
    expect(check([step()]).reply.plan).toHaveLength(1);
    expect(ReplySchema.safeParse(check([step(), high()]).reply).success).toBe(true);
  });

  it("a limit reply never has a plan", () => {
    expect("plan" in checkReply({ ...good, limit: "changes-state", plan: [step()] }, { role: "user", offered: [DOC] })!.reply).toBe(false);
  });

  it("a high-impact step stays only on a confirmed, certain diagnosis; an uncertain source turns it into a check", () => {
    const kept = check([high()]);
    expect(kept.reply.plan![0]).toMatchObject({ kind: "high-impact" });
    const doubted = check([high()], {}, { uncertain: [DIAG.id] });
    expect(doubted.reply.certainty).toBe("likely");
    expect(doubted.reply.plan![0]).toMatchObject({ kind: "check", wouldBe: "high-impact", proposal: "Start the step again" });
  });

  it("the text of the plan: kinds, would-be warning and what to expect, without a claim of success", () => {
    const text = displayText(check([step(), high({ evidence: [] })]).reply);
    expect(text).toContain("Plan (nothing is done until you do it):");
    expect(text).toContain("1. [Reversible change] Save a copy of the log");
    expect(text).toContain("Would be a high-impact change, do not do it yet: Start the step again");
    expect(text).toContain("What you should see: You have a copy.");
    expect(text).toContain("If it fails: The copy is empty.");
    expect(text).toContain("Then: Leave it as it is.");
    expect(text).not.toMatch(/succeeded|done\b(?! until)/i);
  });

  it("the contract lists the six kinds of step", () => {
    expect(contractFor("user").steps.map((s) => s.id)).toEqual(["explanation", "navigation", "check", "input", "reversible", "high-impact"]);
  });

  it("a user keeps the instructions, expected, failure, fallback and proposal of every step", () => {
    const reply = check([step({ instructions: "Paste it into a note." }), high({ evidence: [] })]).reply;
    const seen = forRole("user", reply).plan!;
    expect(seen[0]).toMatchObject({ instructions: "Paste it into a note.", expected: "You have a copy.", failure: "The copy is empty.", fallback: "Leave it as it is." });
    expect(seen[1]).toMatchObject({ proposal: "Start the step again", expected: expect.any(String), fallback: expect.any(String) });
  });
});

describe("the documentation of the contract", () => {
  const guide = readFileSync("docs/USER_GUIDE.md", "utf8");
  const design = readFileSync("docs/DESIGN.md", "utf8");

  it("is in the user guide: the kinds of question, the parts of a reply, the levels and every limitation", () => {
    expect(guide).toContain("## 14. Ask SCF");
    for (const t of QUESTION_TYPES) expect(guide, t).toContain(QUESTION_RULES[t].what);
    for (const k of PART_KINDS) expect(guide, k).toContain(PART_RULES[k].what);
    for (const c of CERTAINTY) expect(guide, c).toContain(CERTAINTY_WORDS[c]);
    for (const rule of ACTION_RULES) expect(guide).toContain(rule);
    for (const code of LIMIT_CODES) expect(guide, code).toContain(limitationFor(code, "user").limitation);
  });

  it("is in the design document, with the place of the code", () => {
    expect(design).toContain("### Ask SCF: the contract");
    expect(design).toContain("src/help/contract.ts");
    for (const fn of ["checkReply", "limitationFor", "certaintyOf", "forRole"]) expect(design, fn).toContain(fn);
  });
});

describe("binding an action", () => {
  const targets = { S1: { kind: "run", id: "run-1" } } as const;
  const base = { type: "status", summary: "Your run failed.", explanation: "", certainty: "confirmed", evidence: ["S1"] };
  const act = (over: Record<string, unknown> = {}) => ({ id: "resume-run", title: "x", impact: "The run would go on.", source: "S1", ...over });
  const check = (actions: unknown[], over: Record<string, unknown> = {}, role: "admin" | "user" = "user") =>
    checkReply({ ...base, actions }, { role, offered: [STATE, DOC], targets, ...over })!;

  it("keeps a bound action with the server's own title, effect and run", () => {
    const c = check([act({ title: "Click me", about: { kind: "run", id: "other" } })]);
    expect(c.reply.actions).toEqual([{ id: "resume-run", title: "Resume the run", impact: ACTIONS[0]!.effect, source: "S1", about: { kind: "run", id: "run-1" } }]);
    expect(c.dropped).toEqual([]);
    expect(ReplySchema.safeParse(c.reply).success).toBe(true);
    expect(displayText(c.reply)).toContain(`- Resume the run: ${ACTIONS[0]!.effect}`);
    const cancel = check([act({ id: "cancel-run" })], {}, "admin");
    expect(cancel.reply.actions[0]).toMatchObject({ id: "cancel-run", impact: ACTIONS[1]!.effect, about: { id: "run-1" } });
  });

  it.each([
    ["an id that is not on the list", act({ id: "delete-run" }), "action: not on the server's list"],
    ["no source", act({ source: undefined }), ACTION_DROPPED.unbound],
    ["a source that is offered but not cited", act({ source: "D1" }), ACTION_DROPPED.unbound],
    ["a source that is not offered", act({ source: "S9" }), ACTION_DROPPED.unbound],
    ["__proto__ as source", act({ source: "__proto__" }), ACTION_DROPPED.unbound],
    ["constructor as source", act({ source: "constructor" }), ACTION_DROPPED.unbound],
    ["a result claimed", act({ impact: "The run was resumed." }), ACTION_DROPPED.claimed],
    ["a cancel claimed", act({ impact: "The run was cancelled." }), ACTION_DROPPED.claimed],
    ["a done claim", act({ impact: "Done: the run was resumed." }), ACTION_DROPPED.claimed],
    ["has been restarted", act({ impact: "It has been restarted" }), ACTION_DROPPED.claimed],
  ])("drops %s", (_n, a, word) => {
    const c = check([a]);
    expect(c.reply.actions).toEqual([]);
    expect(c.dropped).toEqual([word]);
  });

  it("drops a source of kind doc, an uncertain source, and every action when the switch is off or the target is missing", () => {
    const doc = checkReply({ ...base, evidence: ["D1"], actions: [act({ source: "D1" })] }, { role: "user", offered: [STATE, DOC], targets: { D1: { kind: "run", id: "run-1" } } })!;
    expect(doc.dropped).toEqual([ACTION_DROPPED.unbound]);
    expect(check([act()], { uncertain: ["S1"] }).dropped).toEqual([ACTION_DROPPED.uncertain]);
    expect(check([act()], { targets: undefined }).dropped).toEqual([ACTION_DROPPED.unbound]);
    expect(check([act()], { targets: {} }).dropped).toEqual([ACTION_DROPPED.unbound]);
  });

  it("finds a claim after the length limit and inside a fake marker, and does not repeat the text", () => {
    for (const impact of [`The run would go on. ${"x".repeat(600)} The run was resumed.`, "[removed: The run was resumed.]"]) {
      const c = check([act({ impact })]);
      expect(c.reply.actions).toEqual([]);
      expect(c.dropped).toEqual([ACTION_DROPPED.claimed]);
    }
  });

  it("keeps a repeated action once, two actions on one run, and no more than the list allows", () => {
    expect(check([act(), act()]).reply.actions).toHaveLength(1);
    expect(check([act(), act({ id: "cancel-run" })]).reply.actions).toHaveLength(2);
    const ids = ["S1", "S2", "S3", "S4"];
    const t = Object.fromEntries(ids.map((k, i) => [k, { kind: "run", id: `run-${i}` }]));
    const offered = ids.map((id) => ({ ...STATE, id }));
    const c = checkReply({ ...base, evidence: ids, actions: ids.map((s) => act({ source: s })) }, { role: "user", offered, targets: t as never })!;
    expect(c.reply.actions).toHaveLength(LIST_MAX.actions);
  });

  it("lets a plan step name an action only when the server kept a bound proposal of it", () => {
    const DIAG: Evidence = { id: "diagnosis-run-0123456789", kind: "state", title: "Diagnosis: the step failed", ref: "#/runs", observedAt: "2026-01-01T10:00:00.000Z" };
    const step = { kind: "reversible", title: "Save a copy of the log", evidence: ["S1"], expected: "You have a copy.", failure: "The copy is empty.", fallback: "Leave it as it is.", action: "resume-run" };
    const raw = { ...base, evidence: ["S1", DIAG.id], plan: [step] };
    const named = (c: ReturnType<typeof checkReply>) => (c!.reply.plan ?? []).map((p) => p.action);
    // switch off (no targets), or a source the server did not tie to a run (another account's run)
    expect(named(checkReply(raw, { role: "user", offered: [STATE, DIAG] }))).not.toContain("resume-run");
    expect(named(checkReply({ ...raw, actions: [act()] }, { role: "user", offered: [STATE, DIAG], targets: {} }))).not.toContain("resume-run");
    // bound: the step may name it
    expect(named(checkReply({ ...raw, actions: [act()] }, { role: "user", offered: [STATE, DIAG], targets }))).toContain("resume-run");
    // bound for resume only: cancel is not allowed in a step
    expect(named(checkReply({ ...raw, plan: [{ ...step, action: "cancel-run" }], actions: [act()] }, { role: "user", offered: [STATE, DIAG], targets }))).not.toContain("cancel-run");
  });

  it("requires source and a strict run in the schema", () => {
    const ok = check([act()]).reply;
    const a = ok.actions[0]!;
    const good = (action: Record<string, unknown>) => ReplySchema.safeParse({ ...ok, actions: [action] }).success;
    expect(good(a)).toBe(true);
    const { source: _s, ...noSource } = a;
    const { about: _a, ...noAbout } = a;
    expect(good(noSource)).toBe(false);
    expect(good(noAbout)).toBe(false);
    expect(good({ ...a, about: { kind: "repo", id: "r" } })).toBe(false);
    expect(good({ ...a, about: { kind: "run", id: "r", extra: 1 } })).toBe(false);
    expect(good({ ...a, about: { kind: "run", id: "a/b" } })).toBe(false);
  });
});

describe("offers in a reply", () => {
  const RUN_SRC: Evidence = { id: "state-run-1", kind: "state", title: "A run", ref: "run r1 · #/runs/r1", observedAt: "2026-01-01T10:00:00.000Z" };
  const REPO_SRC: Evidence = { id: "state-repo-1", kind: "state", title: "A repository", ref: "repository x · #/repos/x", observedAt: "2026-01-01T10:00:00.000Z" };
  const subjects = { "state-run-1": { kind: "run" as const, id: "r1" }, "state-repo-1": { kind: "repository" as const, id: "x" } };
  const base = { type: "status", summary: "It waits.", explanation: "", certainty: "confirmed", evidence: ["state-run-1"] };
  const run = (offers: unknown[], role: "admin" | "user" = "user", over: object = {}) => checkReply({ ...base, offers }, { role, offered: [RUN_SRC, REPO_SRC, DOC], subjects, ...over })!;

  it("keeps the server's title and subject, and nothing else the model wrote", () => {
    const c = run([{ type: "open-run", evidence: "state-run-1", title: "Free money", to: "https://evil.example", url: "https://evil.example", path: "/x", params: { a: 1 } }]);
    expect(c.reply.offers).toEqual([{ type: "open-run", title: "Open this run", evidence: "state-run-1", subject: { kind: "run", id: "r1" } }]);
    expect(JSON.stringify(c.reply)).not.toContain("evil");
    expect(ReplySchema.safeParse(c.reply).success).toBe(true);
  });

  it("drops what is not on the server's list, with a reason", () => {
    const reasons = (o: unknown, role: "admin" | "user" = "user", over: object = {}) => run([o], role, over).dropped.filter((d) => d.startsWith("offer"));
    expect(reasons({ type: "open-anything", evidence: "state-run-1" })).toEqual(["offer: not on the server's list"]);
    expect(reasons({ type: "open-turn-item", evidence: "state-run-1" })).toEqual(["offer: not on the server's list"]);
    expect(reasons({ type: "open-run", evidence: "state-nope" })).toEqual(["offer: no state source of the server"]);
    expect(reasons({ type: "open-run", evidence: "D1" })).toEqual(["offer: no state source of the server"]);
    expect(reasons({ type: "open-run", evidence: "state-run-1" }, "user", { subjects: {} })).toEqual(["offer: no state source of the server"]);
    expect(reasons({ type: "open-repository", evidence: "state-run-1" })).toEqual(["offer: does not fit its source"]);
    expect(run([{ type: "open-run", evidence: "state-run-1" }, { type: "open-run" }, "x", null]).reply.offers).toHaveLength(1);
    expect(run([{ type: "open-turn-item", evidence: "state-run-1" }], "admin").reply.offers?.[0]?.type).toBe("open-turn-item");
  });

  it("keeps a check offer that fits its source and drops one that does not", () => {
    const kept = run([{ type: "refresh-evidence", evidence: "state-run-1" }, { type: "test-repository", evidence: "state-repo-1" }]).reply.offers;
    expect(kept?.map((o) => [o.type, o.title, o.subject.kind])).toEqual([["refresh-evidence", "Read it again", "run"], ["test-repository", "Test the connection", "repository"]]);
    expect(run([{ type: "test-repository", evidence: "state-run-1" }]).dropped).toContain("offer: does not fit its source");
  });

  it("keeps at most three, without duplicates; no offers means no key", () => {
    const dup = run([{ type: "open-run", evidence: "state-run-1" }, { type: "open-run", evidence: "state-run-1" }, { type: "open-repository", evidence: "state-repo-1" }], "admin");
    expect(dup.reply.offers).toHaveLength(2);
    const four = run([{ type: "open-run", evidence: "state-run-1" }, { type: "open-turn-item", evidence: "state-run-1" }, { type: "open-repository", evidence: "state-repo-1" }, { type: "open-turn-item", evidence: "state-run-1" }], "admin");
    expect(four.reply.offers).toHaveLength(3);
    expect(Object.hasOwn(run([]).reply, "offers")).toBe(false);
    expect(Object.hasOwn(checkReply({ ...base, offers: "x" }, { role: "user", offered: [RUN_SRC] })!.reply, "offers")).toBe(false);
  });

  it("a limit reply has no offers, an older reply parses, and the text lists the titles", () => {
    expect(checkReply({ limit: "secret", offers: [{ type: "open-run", evidence: "state-run-1" }] }, { role: "user", offered: [RUN_SRC], subjects })!.reply.offers).toBeUndefined();
    const reply = run([{ type: "open-run", evidence: "state-run-1" }]).reply;
    const { offers: _o, ...older } = reply;
    expect(ReplySchema.safeParse(older).success).toBe(true);
    expect(ReplySchema.safeParse({ ...reply, offers: [{ ...reply.offers![0], to: "#/home" }] }).success).toBe(false);
    expect(displayText(reply)).toContain("You can open:\n- Open this run");
  });
});
