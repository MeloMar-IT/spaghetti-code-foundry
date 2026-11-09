import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRepo } from "../src/auth/repos.js";
import { REFINE_ROUND_FLOW } from "../src/flow/usage.js";
import { SUGGEST_MAX_COST_USD, askArchitect, askOfJob, kindOfRun, type ArchitectDeps } from "../src/refinement/architect.js";
import { SIMPLE_AVOID, simpleRules } from "../src/help/simple.js";
import { dropDraft, type Draft } from "../src/refinement/draft.js";
import { readyListOf } from "../src/refinement/ready-list.js";
import {
  END_BAD_FORM,
  END_NO_ROOM,
  END_ON_GITHUB,
  addDraft,
  checkReadyOf,
  checkRefinements,
  createSession,
  endArchitectRun,
  getSession,
  recordPublished,
  saveDraft,
  setArchitectRun,
} from "../src/refinement/store.js";
import { emptyTalk } from "../src/refinement/talk.js";
import { TALK_FIRST_LINE, TALK_MAX_BYTES, byteLength } from "../src/refinement/talk-text.js";
import { readPictures } from "../src/refinement/pictures.js";
import { UNDERSTOOD_PREFIX, applyUnderstood, replacedByUnderstand, understandText, understoodPictures, wordsOf } from "../src/refinement/understand-text.js";

const ANN = "11111111-1111-4111-8111-111111111111";
const OK = { ownerOk: () => true, repoName: (_o: string, name: string) => name };
const ann = { id: ANN, admin: false };
const T = { repoOk: () => true, readyList: () => readyListOf(undefined) };
let home: string;
let saved: string | undefined;
let runs = 0;

beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "refinement-understand-"));
  process.env.FACTORY_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const out = (over: Record<string, unknown> = {}) => ({
  title: "Export a report",
  who: "A team lead",
  what: "Download the report as a file.",
  why: "To share it with the team.",
  criteria: ["The export downloads a CSV file."],
  outOfScope: "",
  dependsOn: [] as number[],
  summary: `${UNDERSTOOD_PREFIX}a team lead wants to download the report.`,
  ...over,
});
const answer = (...drafts: Record<string, unknown>[]) => ({ drafts });
const session = () => createSession(ANN, { repo: "acme/app", idea: "Export a report as CSV" }, OK).id;
const withBrief = () => {
  const id = session();
  setArchitectRun(ann, id, "b0");
  endArchitectRun(id, "b0", { brief: { text: "The brief", at: "2026-01-01T00:00:00.000Z" } });
  return id;
};
function understand(id: string, output: unknown, kind: "understand" | "round" = "understand") {
  const runId = `u${++runs}`;
  setArchitectRun(ann, id, runId, { kind });
  return endArchitectRun(id, runId, { understood: output }, T)!;
}
const drafts = (id: string) => getSession(id)!.drafts;
const whats = (id: string) => getSession(id)!.log.map((l) => l.what);
const bare = (): { drafts: Draft[]; epic: undefined } => ({ drafts: [], epic: undefined });
const PUBLISHED = { issue: 12, url: "https://github.com/acme/app/issues/12" };

describe("wordsOf", () => {
  it.each([[undefined, ""], ["", ""], ["simple", "simple"]])("accepts %j", (input, want) => expect(wordsOf(input)).toBe(want));
  it.each([["plain"], [5], [null]])("refuses %j as bad-text", (input) => expect(() => wordsOf(input)).toThrow(expect.objectContaining({ code: "bad-text" })));
});

describe("applyUnderstood", () => {
  it.each<[string, Record<string, unknown>[]]>([
    ["6 drafts", Array.from({ length: 6 }, () => out())],
    ["a link to itself", [out(), out({ dependsOn: [2] })]],
    ["a link to a later draft", [out({ dependsOn: [2] }), out()]],
    ["an unknown field", [out({ extra: 1 })]],
    ["a summary without the prefix", [out({ summary: "A team lead wants a file." })]],
    ["a summary of two sentences", [out({ summary: `${UNDERSTOOD_PREFIX}a lead wants a file. And more.` })]],
    ["a title with a line break", [out({ title: "Two\nlines" })]],
    ["11 criteria", [out({ criteria: Array.from({ length: 11 }, (_, i) => `Criterion ${i}`) })]],
    ["an empty who", [out({ who: "  " })]],
  ])("refuses %s and changes nothing", (_name, list) => {
    const st = bare();
    const copy = structuredClone(st);
    expect(() => applyUnderstood(st, { drafts: list })).toThrow(expect.objectContaining({ code: "bad-draft" }));
    expect(st).toEqual(copy);
  });

  it("wires the links in order and sets every source to accepted", () => {
    const c = applyUnderstood(bare(), answer(out(), out({ title: "Second", dependsOn: [1], outOfScope: "Printing" })));
    expect(c.drafts).toHaveLength(2);
    expect(c.drafts[1]!.dependsOn).toEqual([{ id: expect.any(String), draft: c.drafts[0]!.id, from: "accepted" }]);
    expect(c.drafts[0]!.title?.from).toBe("accepted");
    expect(c.drafts[0]!.outOfScope).toBeUndefined();
    expect(c.drafts[1]!.outOfScope).toMatchObject({ text: "Printing", from: "accepted" });
    expect(c.line).toEqual({ what: "architect-understood", detail: "2" });
  });
});

describe("replacedByUnderstand", () => {
  it("leaves out published, split, part, hand-written and held drafts", () => {
    const base = applyUnderstood(bare(), answer(out(), out({ title: "B" }), out({ title: "C" }), out({ title: "D" }), out({ title: "E" }))).drafts;
    const [a, b, c, d, e] = base as [Draft, Draft, Draft, Draft, Draft];
    const hand: Draft = { id: "99999999-9999-4999-8999-999999999999", criteria: [], dependsOn: [] };
    const published: Draft = { ...hand, id: "88888888-8888-4888-8888-888888888888", dependsOn: [{ id: "77777777-7777-4777-8777-777777777777", draft: b.id, from: "typed" }], published: { ...PUBLISHED, at: "2026-01-01T00:00:00.000Z" } };
    const suggested: Draft = { ...published, id: "66666666-6666-4666-8666-666666666666", dependsOn: [], suggestions: [{ id: "55555555-5555-4555-8555-555555555555", field: "dependsOn", draft: c.id }] };
    const split: Draft = { ...d, splitInto: [e.id] };
    const part: Draft = { ...e, part: { of: d.id } };
    expect([...replacedByUnderstand([a, b, c, hand, published, suggested])].sort()).toEqual([a.id]);
    expect([...replacedByUnderstand([split, part])]).toEqual([]);
    expect([...replacedByUnderstand([{ ...a, published: { ...PUBLISHED, at: "2026-01-01T00:00:00.000Z" } }])]).toEqual([]);
  });
});

describe("understandText", () => {
  const talkWith = (n: number, big = 0) => {
    const talk = emptyTalk();
    for (let i = 0; i < n; i++) {
      talk.rounds.push({ runId: `r${i}`, at: "2026-01-01T00:00:00.000Z", questions: [{ id: `q${i}`, view: "need", text: `Question ${i} ${"x".repeat(big)}`, why: "w", options: [{ text: "A", tradeoff: "a" }, { text: "B", tradeoff: "b" }], recommended: 1, answer: { option: 1 } }] } as never);
    }
    return talk;
  };

  it("starts with its first line and holds the idea, brief, map and answers", () => {
    const talk = talkWith(1);
    talk.map.rules.push({ id: "11111111-2222-4333-8444-555555555555", text: "Only admins export." } as never);
    const t = understandText({ idea: "The idea", brief: "The brief", talk, drafts: [] });
    expect(t.startsWith(TALK_FIRST_LINE.understand)).toBe(true);
    expect(t).toContain("The idea");
    expect(t).toContain("The brief");
    expect(t).toContain("- Only admins export.");
    expect(t).toContain("Question 0");
    expect(t).toContain("option 1: A");
  });

  it("lists the drafts that stay, not the replaceable ones", () => {
    const made = applyUnderstood(bare(), answer(out({ title: "Understood one" }))).drafts;
    const hand: Draft = { id: "99999999-9999-4999-8999-999999999999", title: { text: "By hand", from: "typed" }, criteria: [], dependsOn: [] };
    const pub: Draft = { ...made[0]!, id: "88888888-8888-4888-8888-888888888888", title: { text: "On GitHub", from: "typed" }, published: { ...PUBLISHED, at: "2026-01-01T00:00:00.000Z" } };
    const t = understandText({ idea: "i", talk: emptyTalk(), drafts: [made[0]!, hand, pub] });
    const stay = t.split("## The drafts that stay")[1]!;
    expect(stay).toContain("D2: By hand");
    expect(stay).toContain("D3: On GitHub");
    expect(stay).not.toContain("Understood one");
  });

  it("drops the old rounds first, then cuts the brief, and says so", () => {
    const talk = talkWith(6, 20_000);
    const t = understandText({ idea: "i", brief: "short", talk, drafts: [] });
    expect(byteLength(t)).toBeLessThanOrEqual(TALK_MAX_BYTES);
    expect(t).toContain("Question 5");
    expect(t).not.toContain("Question 0 ");
    expect(t).toContain("## Left out");
    expect(t).toContain("short");
    const cutBrief = understandText({ idea: "i", brief: "b".repeat(200_000), talk: talkWith(1), drafts: [] });
    expect(byteLength(cutBrief)).toBeLessThanOrEqual(TALK_MAX_BYTES);
    expect(cutBrief).toContain("The context brief was cut");
  });

  it("cuts entries of a map of the largest size with multibyte text", () => {
    const talk = emptyTalk();
    const entry = (i: number) => ({ id: `11111111-2222-4333-8444-${String(i).padStart(12, "0")}`, text: "é😀".repeat(250) }) as never;
    for (let i = 0; i < 100; i++) {
      talk.map.rules.push(entry(i));
      talk.map.examples.push(entry(i));
      talk.map.open.push(entry(i));
    }
    const t = understandText({ idea: "i", brief: "b", talk, drafts: [] });
    expect(byteLength(t)).toBeLessThanOrEqual(TALK_MAX_BYTES);
    expect(t).toContain("did not fit");
  });
});

describe("the kind of a run", () => {
  it("is understand for the task and for the variable", () => {
    const task = understandText({ idea: "i", talk: emptyTalk(), drafts: [] });
    expect(askOfJob(REFINE_ROUND_FLOW, undefined, task)).toEqual({ kind: "understand" });
    expect(askOfJob(REFINE_ROUND_FLOW, "understand")).toEqual({ kind: "understand" });
    expect(kindOfRun({ flow: REFINE_ROUND_FLOW, vars: { ask: "understand" } })).toBe("understand");
  });
});

describe("endArchitectRun with understood drafts", () => {
  it("stores one draft, moves the state and logs it", () => {
    const id = withBrief();
    const s = understand(id, answer(out()));
    expect(s.drafts).toHaveLength(1);
    const d = s.drafts[0]!;
    expect(d.title).toEqual({ text: "Export a report", from: "accepted" });
    expect(d.criteria[0]!.from).toBe("accepted");
    expect(d.understood!.summary.startsWith(UNDERSTOOD_PREFIX)).toBe(true);
    expect(s.state).toBe("drafting");
    expect(s.epic).toBeUndefined();
    expect(s.architect).toBeUndefined();
    expect(whats(id).slice(-2)).toEqual(["understand-asked", "architect-understood"]);
    expect(s.log.at(-1)!.detail).toBe("1");
    expect(() => checkRefinements()).not.toThrow();
  });

  it("stores three drafts with their links", () => {
    const id = withBrief();
    const s = understand(id, answer(out(), out({ title: "Two", dependsOn: [1] }), out({ title: "Three", dependsOn: [1, 2] })));
    const [a, b, c] = s.drafts as [Draft, Draft, Draft];
    expect(b.dependsOn.map((x) => x.draft)).toEqual([a.id]);
    expect(c.dependsOn.map((x) => x.draft)).toEqual([a.id, b.id]);
    expect(s.epic).toBeUndefined();
  });

  it("fails on a bad answer and changes nothing", () => {
    const id = withBrief();
    const before = drafts(id);
    const s = understand(id, answer(out({ summary: "no prefix" })));
    expect(s.architect?.failed).toBe(END_BAD_FORM);
    expect(s.drafts).toEqual(before);
  });

  it("replaces its earlier drafts, keeps the rest and the new ones come last", () => {
    const id = withBrief();
    const first = understand(id, answer(out({ title: "One" }), out({ title: "Two" })));
    const [u1, u2] = first.drafts as [Draft, Draft];
    const hand = addDraft(ann, id, T).drafts.at(-1)!.id;
    saveDraft(ann, id, hand, { title: "By hand", dependsOn: [{ draft: u1.id }] }, T);
    recordPublished(ann, id, u2.id, PUBLISHED, T);
    const s = understand(id, answer(out({ title: "New" })));
    const ids = s.drafts.map((d) => d.id);
    expect(ids).not.toContain(u1.id);
    expect(ids.slice(0, 2)).toEqual([u2.id, hand]);
    expect(s.drafts.at(-1)!.title?.text).toBe("New");
    expect(s.drafts.find((d) => d.id === hand)!.dependsOn).toEqual([]);
    expect(s.drafts.find((d) => d.id === u2.id)!.published).toBeDefined();
    expect(() => checkRefinements()).not.toThrow();
  });

  it("clears the readiness of a kept draft that lost a link", () => {
    const id = withBrief();
    const u1 = understand(id, answer(out())).drafts[0]!;
    const hand = addDraft(ann, id, T).drafts.at(-1)!.id;
    saveDraft(ann, id, hand, { title: "By hand", who: "a lead", what: "a thing", why: "a reason", criteria: [{ text: "It works" }], dependsOn: [{ draft: u1.id }] }, T);
    expect(checkReadyOf(ann, id, hand, T).drafts.find((d) => d.id === hand)!.readiness).toBeDefined();
    const s = understand(id, answer(out({ title: "New" })));
    expect(s.drafts.find((d) => d.id === hand)!.readiness).toBeUndefined();
    expect(s.state).toBe("drafting");
  });

  it("keeps a published draft and the understood draft its suggestion points to", () => {
    const id = withBrief();
    const [u1] = understand(id, answer(out())).drafts as [Draft];
    const pub = addDraft(ann, id, T).drafts.at(-1)!.id;
    saveDraft(ann, id, pub, { title: "On GitHub" }, T);
    recordPublished(ann, id, pub, PUBLISHED, T);
    // A pending suggestion of the published draft points at the understood draft.
    const file = join(home, "refinements.json");
    const f = JSON.parse(readFileSync(file, "utf8"));
    f.sessions[0].drafts.find((d: Draft) => d.id === pub).suggestions = [{ id: "55555555-5555-4555-8555-555555555555", field: "dependsOn", draft: u1.id }];
    writeFileSync(file, JSON.stringify(f));
    const before = drafts(id).find((d) => d.id === pub);
    const s = understand(id, answer(out({ title: "New" })));
    expect(s.drafts.map((d) => d.id)).toContain(u1.id);
    expect(s.drafts.find((d) => d.id === pub)).toEqual(before);
  });

  it("keeps a split original that has understood", () => {
    const split = { ...applyUnderstood(bare(), answer(out())).drafts[0]!, splitInto: ["99999999-9999-4999-8999-999999999999"] };
    expect([...replacedByUnderstand([split])]).toEqual([]);
    expect(() => dropDraft({ drafts: [split], epic: undefined }, split.id)).not.toThrow();
  });

  it("fails with no room when 19 drafts stay and 2 come", () => {
    const id = withBrief();
    for (let i = 0; i < 19; i++) addDraft(ann, id, T);
    const before = drafts(id);
    const s = understand(id, answer(out(), out({ title: "Two" })));
    expect(s.architect?.failed).toBe(END_NO_ROOM);
    expect(s.drafts).toEqual(before);
  });

  it("fails for a run of another kind", () => {
    const id = withBrief();
    const s = understand(id, answer(out()), "round");
    expect(s.architect?.failed).toBe(END_BAD_FORM);
    expect(s.drafts).toEqual([]);
  });

  it("fails for a published session and leaves the drafts", () => {
    const id = withBrief();
    const [u1] = understand(id, answer(out())).drafts as [Draft];
    recordPublished(ann, id, u1.id, PUBLISHED, T);
    expect(getSession(id)!.state).toBe("published");
    const before = drafts(id);
    const s = understand(id, answer(out({ title: "New" })));
    expect(s.architect?.failed).toBe(END_ON_GITHUB);
    expect(s.drafts).toEqual(before);
  });
});

// ---- askArchitect ----------------------------------------------------------------------------------

function stub(runs: Record<string, unknown> = {}) {
  const submitted: any[] = [];
  const metas: any[] = [];
  const scheduler = {
    submit: (job: any, meta?: any) => (submitted.push(job), metas.push(meta), job.kind === "run" ? `new-${submitted.length}` : job.runId),
    cancel: () => false,
    get: (id: string) => runs[id] as never,
    isActive: () => false,
    isQueued: () => false,
    briefs: () => [],
    queue: () => ({ pending: [], active: [] }),
  };
  const deps: ArchitectDeps = { scheduler: scheduler as never, repo: home, log: () => undefined };
  return { deps, submitted };
}

describe("askArchitect for understand", () => {
  beforeEach(() => void addRepo(ANN, "acme/app", { ownerOk: () => true }));
  const ask = (s: ReturnType<typeof stub>, id: string, over: Record<string, unknown> = {}) => askArchitect(s.deps, ann, id, { kind: "understand", ...over });

  it("submits ask=understand with the lower cost cap and the words", () => {
    const id = withBrief();
    const s = stub();
    expect(ask(s, id)).toEqual({ runId: "new-1", resumed: false });
    const job = s.submitted[0];
    expect(job.vars).toMatchObject({ ask: "understand", words: "" });
    expect(job.flow.limits.max_cost_usd).toBe(SUGGEST_MAX_COST_USD);
    expect(job.task.startsWith(TALK_FIRST_LINE.understand)).toBe(true);
    expect(getSession(id)!.architect).toMatchObject({ kind: "understand" });
    expect(whats(id).at(-1)).toBe("understand-asked");
    const s2 = stub();
    const id2 = withBrief();
    ask(s2, id2, { words: "simple" });
    expect(s2.submitted[0].vars.words).toBe("simple");
  });

  it("gives round the words too", () => {
    const s = stub();
    askArchitect(s.deps, ann, withBrief(), { kind: "round" });
    expect(s.submitted[0].vars.words).toBe("");
    const s2 = stub();
    askArchitect(s2.deps, ann, withBrief(), { kind: "round", words: "simple" });
    expect(s2.submitted[0].vars.words).toBe("simple");
    expect(() => askArchitect(s2.deps, ann, withBrief(), { kind: "round", words: "x" })).toThrow(expect.objectContaining({ code: "bad-text" }));
  });

  it("refuses without a brief, with an unanswered question, with a bad word, and from an issue", () => {
    const s = stub();
    expect(() => ask(s, session())).toThrow(/look at the code first/);
    expect(() => ask(s, withBrief(), { words: "x" })).toThrow(expect.objectContaining({ code: "bad-text" }));
    const id = withBrief();
    setArchitectRun(ann, id, "r0", { kind: "round" });
    endArchitectRun(id, "r0", { round: { questions: [{ view: "need", text: "Q?", why: "w", options: [{ text: "A", tradeoff: "a" }, { text: "B", tradeoff: "b" }], recommended: 1 }], proposals: [], done: "" } as never });
    expect(() => ask(s, id)).toThrow(/answer every question of the last round first/);
    expect(s.submitted).toEqual([]);
  });

  it("refuses a published session and 20 hand-written drafts", () => {
    const s = stub();
    const id = withBrief();
    const [u1] = understand(id, answer(out())).drafts as [Draft];
    recordPublished(ann, id, u1.id, PUBLISHED, T);
    expect(() => ask(s, id)).toThrow(expect.objectContaining({ code: "bad-state" }));
    const full = withBrief();
    for (let i = 0; i < 20; i++) addDraft(ann, full, T);
    expect(() => ask(s, full)).toThrow(expect.objectContaining({ code: "limit" }));
    expect(s.submitted).toEqual([]);
  });

  it("does not resume a paused run once the session is published", () => {
    const id = withBrief();
    const runDir = join(home, "runs", "p1");
    mkdirSync(runDir, { recursive: true });
    const [u1] = understand(id, answer(out())).drafts as [Draft];
    setArchitectRun(ann, id, "p1", { kind: "understand" });
    recordPublished(ann, id, u1.id, PUBLISHED, T);
    const before = drafts(id);
    const s = stub({ p1: { runId: "p1", status: "stopped", workdir: home, runDir, flow: REFINE_ROUND_FLOW } });
    expect(() => ask(s, id)).toThrow(expect.objectContaining({ code: "bad-state" }));
    expect(s.submitted).toEqual([]);
    expect(getSession(id)!.architect?.failed).toBe(END_ON_GITHUB);
    expect(drafts(id)).toEqual(before);
  });
});

// ---- the sentences about pictures (#836) -----------------------------------------------------------

describe("understoodPictures", () => {
  it("is undefined without pictures, and passes the right count", () => {
    expect(understoodPictures({ drafts: [] }, 0)).toBeUndefined();
    expect(understoodPictures({ pictures: ["A form.", "A chart."] }, 2)).toEqual(["A form.", "A chart."]);
    expect(understoodPictures({ pictures: [] }, 0)).toEqual([]);
  });
  it("refuses an answer without descriptions when the request has pictures", () => {
    expect(() => understoodPictures({ drafts: [] }, 2)).toThrow(expect.objectContaining({ code: "bad-draft" }));
  });
  it.each<[string, unknown, number]>([
    ["a wrong count", ["A form."], 2],
    ["pictures when none were added", ["A form."], 0],
    ["two sentences", ["It is one. It is two."], 1],
    ["a line break", ["A form.\nMore."], 1],
    ["301 characters", [`${"a".repeat(300)}.`], 1],
    ["an image", ["![x](http://e/x.png)"], 1],
    ["a link", ["See [here](b)."], 1],
    ["a tag", ["It is <img src=x>."], 1],
    ["an address", ["See https://e.example/x."], 1],
    ["not a list", "A form.", 1],
  ])("throws bad-draft for %s", (_n, pictures, count) => {
    expect(() => understoodPictures({ pictures }, count)).toThrow(expect.objectContaining({ code: "bad-draft" }));
  });
  it("lets applyUnderstood accept an answer that has pictures", () => {
    expect(() => applyUnderstood(bare(), { drafts: [out()], pictures: ["A form."] })).not.toThrow();
  });
});

describe("endArchitectRun with picture sentences", () => {
  const withPictures = (n = 2) => {
    const s = createSession(ANN, { repo: "acme/app", idea: "Add a thing", changeRequest: true, pictures: readPictures(Array.from({ length: n }, () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]).toString("base64"))) }, OK);
    setArchitectRun(ann, s.id, "b0");
    endArchitectRun(s.id, "b0", { brief: { text: "The brief", at: "2026-01-01T00:00:00.000Z" } });
    return s.id;
  };
  it("stores a sentence on each picture, and a later run replaces them", () => {
    const id = withPictures();
    understand(id, { drafts: [out()], pictures: ["A form.", "A chart."] });
    expect(getSession(id)!.pictures!.map((p) => p.about)).toEqual(["A form.", "A chart."]);
    understand(id, { drafts: [out()], pictures: ["A new form.", "A new chart."] });
    expect(getSession(id)!.pictures!.map((p) => p.about)).toEqual(["A new form.", "A new chart."]);
    expect(() => checkRefinements()).not.toThrow();
  });
  it("ends with the wrong form for a wrong count and keeps the old drafts", () => {
    const id = withPictures();
    understand(id, { drafts: [out()], pictures: ["A form.", "A chart."] });
    const before = drafts(id);
    const s = understand(id, { drafts: [out({ title: "Other" })], pictures: ["Only one."] });
    expect(s.architect?.failed).toBe(END_BAD_FORM);
    expect(drafts(id)).toEqual(before);
    expect(getSession(id)!.pictures!.map((p) => p.about)).toEqual(["A form.", "A chart."]);
  });
  it("refuses an answer without descriptions for a request with pictures, and keeps the old drafts", () => {
    const id = withPictures(1);
    understand(id, { drafts: [out()], pictures: ["A form."] });
    const before = drafts(id);
    const s = understand(id, answer(out({ title: "Other" })));
    expect(s.architect?.failed).toBe(END_BAD_FORM);
    expect(drafts(id)).toEqual(before);
    expect(getSession(id)!.pictures![0]!.about).toBe("A form.");
  });
});

// ---- the check tool --------------------------------------------------------------------------------

describe("tools/refine-round-check for understand", () => {
  const check = (obj: unknown, pictures?: string) => {
    const r = spawnSync("node", ["tools/refine-round-check"], { env: { ...process.env, FACTORY_VAR_ASK: "understand", ...(pictures !== undefined ? { FACTORY_VAR_PICTURES: pictures } : {}), FACTORY_OUT_ROUND: typeof obj === "string" ? obj : JSON.stringify(obj) }, encoding: "utf8" });
    return { code: r.status, text: r.stdout.trim() };
  };

  it("checks the picture sentences against the number of pictures", () => {
    const ok = check({ drafts: [out()], pictures: ["A form.", "A chart."] }, "2");
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.text).pictures).toEqual(["A form.", "A chart."]);
    expect(Object.keys(JSON.parse(ok.text))).toEqual(["drafts", "pictures"]);
    const none = check({ drafts: [out()], pictures: [] }, "");
    expect(none.code).toBe(0);
    expect(Object.keys(JSON.parse(none.text))).toEqual(["drafts"]);
    expect(check(answer(out()), "0").code).toBe(0);
  });

  it.each<[string, unknown, string]>([
    ["one sentence for two pictures", { drafts: [out()], pictures: ["SECRET_TEXT one."] }, "2"],
    ["a missing list", answer(out()), "2"],
    ["two sentences in one entry", { drafts: [out()], pictures: ["SECRET_TEXT one. SECRET_TEXT two.", "B."] }, "2"],
    ["301 characters", { drafts: [out()], pictures: [`${"S".repeat(300)}.`, "B."] }, "2"],
    ["a line break", { drafts: [out()], pictures: ["SECRET_TEXT\nmore.", "B."] }, "2"],
    ["a Markdown image", { drafts: [out()], pictures: ["![SECRET_TEXT](x.png)", "B."] }, "2"],
    ["a Markdown link", { drafts: [out()], pictures: ["See [SECRET_TEXT](x).", "B."] }, "2"],
    ["an HTML tag", { drafts: [out()], pictures: ["A <b>SECRET_TEXT</b> form.", "B."] }, "2"],
    ["an address", { drafts: [out()], pictures: ["See http://SECRET_TEXT.example.", "B."] }, "2"],
    ["a sentence that is not text", { drafts: [out()], pictures: [5, "B."] }, "2"],
    ["sentences when no picture was added", { drafts: [out()], pictures: ["SECRET_TEXT."] }, ""],
    ["a count of 9", { drafts: [out()], pictures: ["SECRET_TEXT."] }, "9"],
  ])("fails for %s with a sentence that holds no answer text", (_name, obj, n) => {
    const r = check(obj, n);
    expect(r.code).toBe(1);
    expect(r.text).not.toMatch(/SECRET/);
    expect(r.text.split("\n")).toHaveLength(1);
  });

  it("passes one good draft and three linked drafts", () => {
    const one = check(answer(out()));
    expect(one.code).toBe(0);
    expect(JSON.parse(one.text).drafts[0]).toEqual(out());
    const three = check(answer(out(), out({ dependsOn: [1] }), out({ dependsOn: [1, 2] })));
    expect(three.code).toBe(0);
    expect(JSON.parse(three.text).drafts).toHaveLength(3);
  });

  it.each<[string, unknown]>([
    ["6 drafts", answer(...Array.from({ length: 6 }, () => out()))],
    ["no drafts", answer()],
    ["a link to a later draft", answer(out({ dependsOn: [2] }), out())],
    ["a link to itself", answer(out(), out({ dependsOn: [2] }))],
    ["an unknown field", answer(out({ SECRET_EXTRA: "x" }))],
    ["an extra key", { drafts: [out()], echo: "SECRET_EXTRA" }],
    ["a summary without the prefix", answer(out({ summary: "SECRET_TEXT wants a file." }))],
    ["a summary of two sentences", answer(out({ summary: `${UNDERSTOOD_PREFIX}SECRET_TEXT is one. SECRET_TEXT is two.` }))],
    ["a title with a line break", answer(out({ title: "SECRET_TEXT\nmore" }))],
    ["11 criteria", answer(out({ criteria: Array.from({ length: 11 }, () => "SECRET_TEXT") }))],
    ["a title of 121 characters", answer(out({ title: "S".repeat(121) }))],
    ["no criteria", answer(out({ criteria: [] }))],
  ])("fails for %s with a sentence that holds no answer text", (_name, obj) => {
    const r = check(obj);
    expect(r.code).toBe(1);
    expect(r.text).not.toMatch(/SECRET|Export a report|team lead/);
    expect(r.text.length).toBeGreaterThan(5);
    expect(r.text.split("\n")).toHaveLength(1);
  });
});

describe("the flow prompt", () => {
  it("holds the three plain-words lines", () => {
    const yaml = readFileSync("flows/refine-round.yaml", "utf8");
    for (const line of simpleRules([]).slice(0, 3)) expect(yaml).toContain(line);
    expect(SIMPLE_AVOID.length).toBeGreaterThan(0);
  });
});
