import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { preview, sentenceCount, type Draft } from "../src/refinement/draft.js";
import { acceptedLines, acceptedView, checkReady, isReady, readinessView } from "../src/refinement/draft-ready.js";
import { DEFAULT_READY, type ReadyItem } from "../src/refinement/ready-list.js";
import {
  LOG_LIMIT,
  RefinementError,
  acceptAnywayOf,
  acceptProposal,
  acceptSuggestionOf,
  addDraft,
  answerQuestion,
  changeEntry,
  checkReadyOf,
  checkRefinements,
  correctReadyState,
  createSession,
  dropSession,
  endArchitectRun,
  getSession,
  moveToNotesOf,
  recordRound,
  refinementsPath,
  rejectSuggestionOf,
  removeAcceptedOf,
  removeDraft,
  removeEntry,
  saveDraft,
  setArchitectRun,
  setEpic,
} from "../src/refinement/store.js";

const ANN = "11111111-1111-4111-8111-111111111111";
const OK = { ownerOk: () => true, repoName: (_o: string, name: string) => name };
const ann = { id: ANN, admin: false };
const item = (id: string) => DEFAULT_READY.find((i) => i.id === id)!;
const LIST2: ReadyItem[] = [item("out-of-scope"), item("no-open-questions")];
let list: readonly ReadyItem[] = DEFAULT_READY;
let live: readonly ReadyItem[] | undefined = DEFAULT_READY;
const T = { repoOk: () => true, readyList: () => live };
let home: string;
let saved: string | undefined;
let runs = 0;

beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "refinement-ready-"));
  process.env.FACTORY_HOME = home;
  list = DEFAULT_READY;
  live = DEFAULT_READY;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof RefinementError ? e.code : e;
  }
  return undefined;
};
const file = () => readFileSync(refinementsPath(), "utf8");
const edit = (fn: (f: any) => void) => {
  const f = JSON.parse(file());
  fn(f);
  writeFileSync(refinementsPath(), JSON.stringify(f));
};
const unchanged = (fn: () => unknown, c?: string) => {
  const before = file();
  if (c) expect(code(fn)).toBe(c);
  else fn();
  expect(file()).toBe(before);
};
const draft = (id: string, did: string): Draft => getSession(id)!.drafts.find((d) => d.id === did)!;
const results = (id: string, did: string) => Object.fromEntries(draft(id, did).readiness!.items.map((i) => [i.id, i.result]));
const check = (id: string, did: string) => checkReadyOf(ann, id, did, T);
const accept = (id: string, did: string, item: string, reason = "Not needed here") => acceptAnywayOf(ann, id, did, item, { reason }, T);
const padLog = (n: number) =>
  edit((f) => {
    const s = f.sessions[0];
    s.log = [...s.log, ...Array.from({ length: Math.max(0, n - s.log.length) }, (_, i) => ({ at: new Date().toISOString(), by: ANN, what: "renamed", detail: `t${i}` }))];
  });

const FULL = { title: "Export", who: "an admin", what: "to export a report", why: "to share it", outOfScope: "Printing", criteria: [{ text: "It exports a file" }] };

function setup(fields: Record<string, unknown> = FULL) {
  const id = createSession(ANN, { repo: "acme/app", idea: "An idea" }, OK).id;
  const did = addDraft(ann, id, T).drafts[0]!.id;
  if (fields) saveDraft(ann, id, did, fields, T);
  return { id, did };
}
const q = (text = "Who uses it?") => ({
  view: "need",
  text,
  why: "It sets the value.",
  options: [
    { text: "Everyone", tradeoff: "Broad" },
    { text: "Admins", tradeoff: "Narrow" },
  ],
  recommended: 1,
});
const withRound = (id: string, questions = 1) => recordRound(id, `run-${++runs}`, { questions: Array.from({ length: questions }, (_, i) => q(`Question ${i + 1}?`)), proposals: [], done: "" });

describe("the code checks with the default list", () => {
  it("an empty draft", () => {
    const { id, did } = setup(null as never);
    check(id, did);
    expect(results(id, did)).toEqual({ value: "not-met", standalone: "unsure", checkable: "not-met", small: "unsure", "no-open-questions": "met", "out-of-scope": "not-met", "no-plan": "unsure" });
    expect(draft(id, did).readiness!.items.map((i) => i.id)).toEqual(DEFAULT_READY.map((i) => i.id));
  });

  it("a full draft", () => {
    const { id, did } = setup();
    check(id, did);
    expect(results(id, did)).toMatchObject({ value: "unsure", checkable: "unsure", "out-of-scope": "met" });
  });

  it("value names the empty part", () => {
    const a = setup({ why: "to share it" });
    check(a.id, a.did);
    expect(draft(a.id, a.did).readiness!.items.find((i) => i.id === "value")).toMatchObject({ result: "not-met", reason: 'The "As …" part is empty.' });
    const b = setup({ who: "an admin" });
    check(b.id, b.did);
    expect(draft(b.id, b.did).readiness!.items.find((i) => i.id === "value")).toMatchObject({ result: "not-met", reason: 'The "so that …" part is empty.' });
  });

  it("no-open-questions counts open entries and waiting questions", () => {
    const { id, did } = setup();
    withRound(id, 2);
    check(id, did);
    const waiting = draft(id, did).readiness!.items.find((i) => i.id === "no-open-questions")!;
    expect(waiting.result).toBe("not-met");
    expect(waiting.reason).toBe("The map has 0 open questions and 2 questions wait for an answer.");
    const qid = getSession(id)!.talk!.rounds[0]!.questions[0]!.id;
    answerQuestion(ann, id, qid, { unknown: true }, T);
    check(id, did);
    expect(draft(id, did).readiness!.items.find((i) => i.id === "no-open-questions")!.reason).toBe("The map has 1 open question and 1 question waits for an answer.");
    answerQuestion(ann, id, getSession(id)!.talk!.rounds[0]!.questions[1]!.id, { option: 1 }, T);
    check(id, did);
    expect(draft(id, did).readiness!.items.find((i) => i.id === "no-open-questions")).toMatchObject({ result: "not-met", reason: "The map has 1 open question and 0 questions wait for an answer." });
  });

  it("no-plan quotes the sign it found", () => {
    const { id, did } = setup({ ...FULL, criteria: [{ text: "Edit src/a/b.ts" }] });
    check(id, did);
    expect(draft(id, did).readiness!.items.find((i) => i.id === "no-plan")).toMatchObject({ result: "not-met", reason: 'An acceptance criterion reads like an implementation plan ("src/a/b.ts").' });
  });

  it("no-plan names the field and stays one sentence", () => {
    const { id, did } = setup({ ...FULL, what: "First add a table. Then call it" });
    check(id, did);
    const r = draft(id, did).readiness!.items.find((i) => i.id === "no-plan")!;
    expect(r.result).toBe("not-met");
    expect(r.reason.startsWith('The "I want …" part reads like an implementation plan')).toBe(true);
    expect(sentenceCount(r.reason)).toBe(1);
  });

  it("standalone is not met for a gone draft and for the draft itself", () => {
    const U = (n: number) => `bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12, "0")}`;
    const mk = (target: string): Draft => ({ id: U(1), criteria: [], dependsOn: [{ id: U(9), draft: target, from: "typed" }] });
    const run = (d: Draft) => checkReady({ drafts: [d], epic: undefined }, undefined, d.id, DEFAULT_READY, "2026-01-01T00:00:00.000Z").drafts[0]!.readiness!.items.find((i) => i.id === "standalone")!;
    expect(run(mk(U(2)))).toMatchObject({ result: "not-met", reason: "Depends on names a draft that is gone." });
    expect(run(mk(U(1)))).toMatchObject({ result: "not-met", reason: "Depends on names the draft itself." });
    expect(run({ id: U(1), criteria: [], dependsOn: [{ id: U(9), issue: 5, from: "typed" }] }).result).toBe("unsure");
  });

  it("every reason is one short line that names its subject, and unsure ones say the architect judges", () => {
    for (const fields of [null, FULL, { ...FULL, criteria: [{ text: "Edit src/a/b.ts" }] }]) {
      const { id, did } = setup(fields as never);
      withRound(id);
      check(id, did);
      for (const i of draft(id, did).readiness!.items) {
        expect(i.by).toBe("code");
        expect([...i.reason].length).toBeLessThanOrEqual(300);
        expect(i.reason).not.toMatch(/[\n\r]/);
        expect(sentenceCount(i.reason)).toBe(1);
        if (i.result === "unsure") expect(i.reason).toContain("architect has to judge");
      }
    }
  });

  it("an item without a rule is unsure and its reason names the item, also for odd texts", () => {
    const odd = 'Done? Yes! "quoted". ' + "x".repeat(170);
    list = [{ id: "c-12345678", text: "legal agreed" }, { id: "c-87654321", text: odd.slice(0, 200) }];
    live = list;
    const { id, did } = setup();
    check(id, did);
    const [a, b] = draft(id, did).readiness!.items;
    expect(a).toMatchObject({ result: "unsure", reason: expect.stringContaining('"legal agreed"') });
    expect(b!.result).toBe("unsure");
    expect(b!.reason).toContain("architect has to judge");
    expect(b!.reason).toContain("Done");
    expect([...b!.reason].length).toBeLessThanOrEqual(300);
    expect(sentenceCount(b!.reason)).toBe(1);
  });
});

describe("a check", () => {
  it("changes only `readiness`, a second check replaces it, and it asks no architect", () => {
    const { id, did } = setup();
    const before = JSON.parse(JSON.stringify(draft(id, did)));
    check(id, did);
    const { readiness, ...rest } = draft(id, did) as any;
    expect(rest).toEqual(before);
    expect(readiness.items).toHaveLength(7);
    expect(getSession(id)!.architect).toBeUndefined();
    edit((f) => (f.sessions[0].drafts[0].readiness.at = "2020-01-01T00:00:00.000Z"));
    check(id, did);
    expect(draft(id, did).readiness!.at).not.toBe("2020-01-01T00:00:00.000Z");
    expect(code(() => checkReadyOf(ann, id, "nope", T))).toBe("not-found");
  });

  it("logs the counts", () => {
    const { id, did } = setup();
    check(id, did);
    expect(getSession(id)!.log.at(-1)).toMatchObject({ what: "ready-checked", detail: "2 met, 0 not met, 5 unsure" });
  });
});

describe("becoming ready", () => {
  it("follows the drafts", () => {
    live = list = LIST2;
    const { id, did } = setup();
    expect(getSession(id)!.state).toBe("drafting");
    check(id, did);
    expect(isReady(draft(id, did), LIST2)).toBe(true);
    expect(getSession(id)!.state).toBe("ready");
    const second = addDraft(ann, id, T).drafts[1]!.id;
    expect(getSession(id)!.state).toBe("drafting");
    check(id, second);
    expect(results(id, second)["out-of-scope"]).toBe("not-met");
    expect(getSession(id)!.state).toBe("drafting");
    saveDraft(ann, id, second, { outOfScope: "Printing" }, T);
    check(id, second);
    expect(getSession(id)!.state).toBe("ready");
    removeDraft(ann, id, did, T);
    removeDraft(ann, id, second, T);
    expect(getSession(id)!.state).toBe("exploring");
  });

  it("an accepted-anyway item makes the draft ready", () => {
    live = list = LIST2;
    const { id, did } = setup({ title: "Export" });
    check(id, did);
    expect(isReady(draft(id, did), LIST2)).toBe(false);
    accept(id, did, "out-of-scope");
    expect(isReady(draft(id, did), LIST2)).toBe(true);
    expect(getSession(id)!.state).toBe("ready");
  });
});

describe("accepted anyway", () => {
  it("refuses bad reasons, the plan item, unknown items and drafts", () => {
    const { id, did } = setup();
    for (const body of [{ reason: "" }, { reason: "x".repeat(301) }, { reason: "two\nlines" }, {}, null]) unchanged(() => acceptAnywayOf(ann, id, did, "value", body, T), "bad-text");
    unchanged(() => accept(id, did, "no-plan"), "bad-state");
    unchanged(() => accept(id, did, "nope"), "not-found");
    unchanged(() => accept(id, "nope", "value"), "not-found");
    unchanged(() => removeAcceptedOf(ann, id, "nope", "value", T), "not-found");
    unchanged(() => removeAcceptedOf(ann, id, did, "nope", T), "not-found");
    expect(code(() => accept(id, did, "no-plan"))).toBe("bad-state");
  });

  it("takes 300 characters and trims", () => {
    const { id, did } = setup();
    accept(id, did, "value", `  ${"x".repeat(300)}  `);
    expect(draft(id, did).acceptedAnyway![0]!.reason).toHaveLength(300);
  });

  it("the same reason twice changes nothing; removing works and is quiet when there is no mark", () => {
    const { id, did } = setup();
    accept(id, did, "value");
    unchanged(() => accept(id, did, "value"));
    removeAcceptedOf(ann, id, did, "value", T);
    expect(draft(id, did).acceptedAnyway).toBeUndefined();
    unchanged(() => removeAcceptedOf(ann, id, did, "value", T));
    expect(getSession(id)!.log.slice(-2).map((l) => [l.what, l.detail])).toEqual([
      ["ready-accepted", item("value").text],
      ["ready-unaccepted", item("value").text],
    ]);
  });

  it("removing the mark makes the draft drafting again", () => {
    live = list = LIST2;
    const { id, did } = setup({ title: "Export" });
    check(id, did);
    accept(id, did, "out-of-scope");
    expect(getSession(id)!.state).toBe("ready");
    removeAcceptedOf(ann, id, did, "out-of-scope", T);
    expect(getSession(id)!.state).toBe("drafting");
  });

  it("a mark before any check is stored but the draft is not ready until the check", () => {
    live = list = LIST2;
    const { id, did } = setup({ title: "Export" });
    accept(id, did, "out-of-scope");
    expect(draft(id, did).acceptedAnyway).toHaveLength(1);
    expect(isReady(draft(id, did), LIST2)).toBe(false);
    check(id, did);
    expect(isReady(draft(id, did), LIST2)).toBe(true);
  });
});

describe("the preview", () => {
  it("has the section only for needed marks", () => {
    live = list = LIST2;
    const { id, did } = setup({ title: "Export", who: "an admin", what: "x", why: "y" });
    const s = () => getSession(id)!;
    expect(preview(draft(id, did), s(), acceptedLines(draft(id, did), LIST2)).body).not.toContain("Accepted anyway");
    accept(id, did, "out-of-scope");
    const body = preview(draft(id, did), s(), acceptedLines(draft(id, did), LIST2)).body;
    expect(body.endsWith(`### Accepted anyway\n- ${item("out-of-scope").text}: Not needed here`)).toBe(true);
    check(id, did);
    expect(acceptedLines(draft(id, did), LIST2)).toHaveLength(1);
    saveDraft(ann, id, did, { outOfScope: "Printing" }, T);
    check(id, did);
    expect(acceptedLines(draft(id, did), LIST2)).toEqual([]);
    expect(acceptedView(draft(id, did), LIST2)).toEqual([{ id: "out-of-scope", text: item("out-of-scope").text, reason: "Not needed here", notNeeded: true }]);
    expect(preview(draft(id, did), s(), acceptedLines(draft(id, did), LIST2)).body).not.toContain("Accepted anyway");
    saveDraft(ann, id, did, { outOfScope: null }, T);
    expect(acceptedLines(draft(id, did), LIST2)).toHaveLength(1);
  });
});

describe("falling back to drafting", () => {
  const ABOVE = { title: "Export", who: "an admin", what: "to export", why: "to share", outOfScope: "Printing", criteria: [{ text: "It exports" }], notes: "n" };
  /** A session with one checked draft (marked, so that the mark can be seen to stay), in the ready state. */
  function ready(extra: Record<string, unknown> = {}) {
    live = list = LIST2;
    const s = setup({ ...ABOVE, ...extra });
    check(s.id, s.did);
    accept(s.id, s.did, "no-open-questions");
    expect(getSession(s.id)!.state).toBe("ready");
    return s;
  }
  const fellBack = (id: string, did: string) => {
    expect(draft(id, did).readiness).toBeUndefined();
    expect(draft(id, did).acceptedAnyway).toHaveLength(1);
    expect(getSession(id)!.state).toBe("drafting");
  };
  const stays = (id: string, did: string) => {
    expect(draft(id, did).readiness).toBeDefined();
    expect(getSession(id)!.state).toBe("ready");
  };

  it.each([
    ["title", { title: "Other" }],
    ["who", { who: "a user" }],
    ["what", { what: "to print" }],
    ["why", { why: "to know" }],
    ["out of scope", { outOfScope: "Mail" }],
    ["notes", { notes: "other notes" }],
    ["a criterion", { criteria: [{ text: "It exports twice" }] }],
    ["a new criterion", { criteria: [{ text: "It exports" }, { text: "More" }] }],
    ["depends on", { dependsOn: [{ issue: 5 }] }],
  ])("a save of %s", (_n, input) => {
    const { id, did } = ready();
    const c = JSON.parse(JSON.stringify(draft(id, did).criteria));
    saveDraft(ann, id, did, "criteria" in input ? { criteria: [...(input as any).criteria.slice(0, 1).map((x: any, i: number) => (i === 0 && x.text === "It exports" ? { id: c[0].id, ...x } : x)), ...(input as any).criteria.slice(1)] } : input, T);
    fellBack(id, did);
  });

  it("a save with the same text changes nothing", () => {
    const { id, did } = ready();
    unchanged(() => saveDraft(ann, id, did, { title: "Export" }, T));
    stays(id, did);
  });

  it("an accepted suggestion", () => {
    const { id, did } = ready();
    const runId = `s-${++runs}`;
    setArchitectRun(ann, id, runId, { kind: "suggest", draft: did, field: "what" });
    endArchitectRun(id, runId, { suggested: { field: "what", suggestions: [{ text: "to export it twice" }] } });
    stays(id, did);
    acceptSuggestionOf(ann, id, did, draft(id, did).suggestions![0]!.id, {}, T);
    fellBack(id, did);
  });

  it("a rejected suggestion does not clear", () => {
    const { id, did } = ready();
    const runId = `s-${++runs}`;
    setArchitectRun(ann, id, runId, { kind: "suggest", draft: did, field: "what" });
    endArchitectRun(id, runId, { suggested: { field: "what", suggestions: [{ text: "to export it twice" }] } });
    rejectSuggestionOf(ann, id, did, draft(id, did).suggestions![0]!.id, {}, T);
    stays(id, did);
  });

  it("move to notes", () => {
    const { id, did } = ready({ criteria: [{ text: "Edit src/a/b.ts" }] });
    check(id, did);
    expect(getSession(id)!.state).toBe("ready");
    moveToNotesOf(ann, id, did, { field: "criteria", item: draft(id, did).criteria[0]!.id }, T);
    fellBack(id, did);
  });

  it("removing a draft that it depended on", () => {
    live = list = LIST2;
    const { id, did } = setup(ABOVE);
    const other = addDraft(ann, id, T).drafts[1]!.id;
    saveDraft(ann, id, did, { dependsOn: [{ draft: other }] }, T);
    saveDraft(ann, id, other, ABOVE, T);
    check(id, did);
    check(id, other);
    accept(id, did, "no-open-questions");
    expect(getSession(id)!.state).toBe("ready");
    removeDraft(ann, id, other, T);
    fellBack(id, did);
  });

  it("an Epic change clears every draft", () => {
    const { id, did } = ready();
    setEpic(ann, id, { issue: 7 }, T);
    fellBack(id, did);
  });

  it("a change of the open questions clears every draft", () => {
    for (const how of ["unknown", "remove", "change", "round"]) {
      const { id, did } = ready();
      if (how === "round") withRound(id);
      else {
        withRound(id);
        const qid = getSession(id)!.talk!.rounds[0]!.questions[0]!.id;
        // answering with a text leaves the map as it is but changes the number of waiting questions
        if (how === "unknown") answerQuestion(ann, id, qid, { unknown: true }, T);
        else {
          answerQuestion(ann, id, qid, { unknown: true }, T);
          const e = getSession(id)!.talk!.map.open[0]!;
          if (how === "remove") removeEntry(ann, id, e.id, T);
          else changeEntry(ann, id, e.id, "Other question", T);
        }
      }
      fellBack(id, did);
    }
  });

  it("a waiting question answered by an option clears, though the map's open list does not change", () => {
    const { id, did } = ready();
    withRound(id);
    check(id, did);
    accept(id, did, "no-open-questions", "later");
    expect(getSession(id)!.state).toBe("ready");
    answerQuestion(ann, id, getSession(id)!.talk!.rounds[0]!.questions[0]!.id, { option: 2 }, T);
    expect(getSession(id)!.talk!.map.open).toEqual([]);
    fellBack(id, did);
  });

  it("a new architect round with a question clears a ready session", () => {
    const { id, did } = ready();
    withRound(id, 1);
    fellBack(id, did);
  });

  it("an accepted rule and a removed rule tied to a criterion do not clear", () => {
    const { id, did } = ready();
    recordRound(id, "run-r", { questions: [], proposals: [{ list: "rule", text: "Only admins export." }], done: "Done" });
    const pid = getSession(id)!.talk!.proposals[0]!.id;
    stays(id, did);
    acceptProposal(ann, id, pid, T);
    stays(id, did);
    const rule = getSession(id)!.talk!.map.rules[0]!.id;
    removeEntry(ann, id, rule, T);
    stays(id, did);
  });
});

describe("a changed list", () => {
  it("a reworded or new item counts as not checked, and accepting it does not make the draft ready", () => {
    live = list = LIST2;
    const { id, did } = setup();
    check(id, did);
    expect(getSession(id)!.state).toBe("ready");
    const reworded: ReadyItem[] = [{ id: "out-of-scope", text: "it says clearly what is out of scope", rule: "out-of-scope" }, item("no-open-questions")];
    live = reworded;
    const d = draft(id, did);
    expect(readinessView(d, reworded)).toMatchObject({ stale: true, items: [expect.objectContaining({ id: "no-open-questions" })] });
    expect(isReady(d, reworded)).toBe(false);
    // accepting the new text does not use the old check
    accept(id, did, "out-of-scope");
    expect(isReady(draft(id, did), reworded)).toBe(false);
    check(id, did);
    expect(isReady(draft(id, did), reworded)).toBe(true);
    const added: ReadyItem[] = [...reworded, { id: "c-12345678", text: "legal agreed" }];
    live = added;
    expect(isReady(draft(id, did), added)).toBe(false);
    accept(id, did, "c-12345678", "ok");
    expect(isReady(draft(id, did), added)).toBe(false);
    check(id, did);
    expect(isReady(draft(id, did), added)).toBe(true);
  });

  it("a mark for the old wording does not count, and a mark for a gone item is not shown", () => {
    live = list = LIST2;
    const { id, did } = setup({ title: "Export" });
    check(id, did);
    accept(id, did, "out-of-scope");
    const reworded: ReadyItem[] = [{ id: "out-of-scope", text: "it says clearly what is out of scope", rule: "out-of-scope" }, item("no-open-questions")];
    expect(acceptedView(draft(id, did), reworded)).toEqual([]);
    expect(acceptedLines(draft(id, did), reworded)).toEqual([]);
    expect(acceptedLines(draft(id, did), [item("no-open-questions")])).toEqual([]);
    // a later accept prunes the stale marks
    live = [...reworded];
    accept(id, did, "no-open-questions", "later");
    expect(draft(id, did).acceptedAnyway!.map((a) => a.id)).toEqual(["no-open-questions"]);
  });

  it("a removed item leaves the draft ready", () => {
    live = list = LIST2;
    const { id, did } = setup();
    check(id, did);
    expect(isReady(draft(id, did), [item("out-of-scope")])).toBe(true);
    expect(readinessView(draft(id, did), [item("out-of-scope")])!.items).toHaveLength(1);
    expect(readinessView(draft(id, did), [item("out-of-scope")])!.stale).toBeUndefined();
  });

  it("correctReadyState fixes the stored state without a log line or a new `updated`", () => {
    live = list = LIST2;
    const { id, did } = setup();
    check(id, did);
    const log = getSession(id)!.log.length;
    const updated = getSession(id)!.updated;
    expect(correctReadyState(id, T)).toBeUndefined();
    live = [...LIST2, { id: "c-12345678", text: "legal agreed" }];
    expect(correctReadyState(id, T)!.state).toBe("drafting");
    expect(getSession(id)!.state).toBe("drafting");
    expect(getSession(id)!.log).toHaveLength(log);
    expect(getSession(id)!.updated).toBe(updated);
    unchanged(() => correctReadyState(id, T));
    live = LIST2;
    expect(correctReadyState(id, T)!.state).toBe("ready");
    live = undefined;
    edit((f) => (f.sessions[0].state = "drafting"));
    expect(correctReadyState(id, T)).toBeUndefined();
    live = LIST2;
    dropSession(ann, id);
    expect(correctReadyState(id, T)).toBeUndefined();
    expect(correctReadyState("nope", T)).toBeUndefined();
  });
});

describe("the log", () => {
  it("has no room: check, accept and remove all stop and write nothing", () => {
    const { id, did } = setup();
    accept(id, did, "value");
    padLog(LOG_LIMIT - 1);
    unchanged(() => check(id, did), "limit");
    unchanged(() => accept(id, did, "checkable"), "limit");
    unchanged(() => removeAcceptedOf(ann, id, did, "value", T), "limit");
  });
});

describe("an old file", () => {
  it("loads unchanged, and a bad result is refused", () => {
    const { id, did } = setup();
    checkRefinements();
    const bytes = file();
    getSession(id);
    expect(file()).toBe(bytes);
    expect(draft(id, did).readiness).toBeUndefined();
    check(id, did);
    edit((f) => (f.sessions[0].drafts[0].readiness.items[0].result = "maybe"));
    expect(() => checkRefinements()).toThrow();
  });
});
