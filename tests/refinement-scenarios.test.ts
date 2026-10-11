import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setRepoReady } from "../src/auth/repos.js";
import { openWorld, type World } from "./helpers/refinement-world.js";
import type { FakeIssue } from "./helpers/fake-github.js";

// Whole refinement sessions through the real server, with the fake claude, gh and git.
/* eslint-disable @typescript-eslint/no-explicit-any */

let w: World;
let refs: string;
beforeEach(async () => {
  w = await openWorld("refinement-scenarios");
  refs = w.gh.remoteGit("for-each-ref");
});
afterEach(async () => {
  await w.close();
});

const url = (id: string, rest: string) => `/api/refinement/${id}/${rest}`;
const post = (path: string, body?: unknown) => w.call(w.ann, "POST", path, body);
const put = (path: string, body: unknown) => w.call(w.ann, "PUT", path, body);
const LIST2 = [{ id: "out-of-scope", text: "it says what is out of scope" }, { id: "no-open-questions", text: "there are no open questions" }];
const FULL = { title: "Export a report", who: "an admin", what: "to export a report", why: "to share it", outOfScope: "Printing", criteria: [{ text: "It exports a file" }] };

const newSession = async (idea: string) => (await post("/api/refinement", { repo: "acme/app", idea })).json().id as string;
const addDraft = async (id: string, fields: Record<string, unknown> = FULL) => {
  const did = (await post(url(id, "drafts"))).json().drafts.at(-1).id as string;
  expect((await put(url(id, `drafts/${did}`), fields)).status).toBe(200);
  return did;
};
const ask = async (id: string, what: string) => {
  expect((await post(url(id, what))).status).toBe(202);
  return w.idle(id);
};
const draftOf = async (id: string, did: string) => (await w.get(id)).drafts.find((d: any) => d.id === did);
const item = (d: any, name: string) => d.readiness.items.find((i: any) => i.id === name);
/** The architect only reads: nothing reached GitHub and the remote has the same refs. */
const nothingWritten = () => {
  expect(w.gh.createdBodies()).toEqual([]);
  expect(w.gh.updatedBodies()).toEqual([]);
  expect(w.gh.closedIssues()).toEqual([]);
  expect(w.gh.comments()).toEqual([]);
  expect(w.gh.remoteGit("for-each-ref")).toBe(refs);
};

describe("refinement sessions, whole", { timeout: 60_000 }, () => {
  it("1. a small clear idea becomes one ready story that is published", async () => {
    const id = await newSession("Export a report as CSV");
    const briefed = await ask(id, "architect");
    expect(briefed.brief).toBeTruthy();
    const did = await addDraft(id);
    expect((await post(url(id, `drafts/${did}/ready-check`))).status).toBe(202);
    const done = await w.idle(id);
    expect(done.state).toBe("ready");
    const d = await draftOf(id, did);
    expect(d.state).toBe("ready");
    expect(new Set(d.readiness.items.map((i: any) => i.by))).toEqual(new Set(["code", "architect"]));
    expect(d.readiness.items.every((i: any) => i.result === "met")).toBe(true);

    expect((await w.call(w.ann, "GET", url(id, "publish"))).json().willCreate).toEqual([did]);
    nothingWritten();
    const r = await post(url(id, "publish"), {});
    expect(r.status).toBe(200);
    expect(r.json().created).toHaveLength(1);
    const made = w.gh.createdBodies();
    expect(made).toHaveLength(1);
    expect(made[0]!.title).toBe("Export a report");
    expect(made[0]!.body).toContain("### Acceptance criteria\n- [ ] It exports a file");
    const s = await w.get(id);
    expect(s.state).toBe("published");
    expect(s.drafts[0].published.issue).toBeGreaterThan(0);
    expect(s.log.at(-1).what).toBe("draft-published");
    await post(url(id, "publish"), {});
    expect(w.gh.createdBodies()).toHaveLength(1);
  });

  it("2. a vague idea gets questions, open questions block readiness, answers make it ready", async () => {
    setRepoReady(w.annRepo().id, { items: LIST2 });
    process.env.FAKE_ROUND = JSON.stringify({
      questions: [
        { view: "need", text: "Who uses it?", why: "Value.", options: [{ text: "Everyone", tradeoff: "Broad" }, { text: "Admins", tradeoff: "Narrow" }], recommended: 1 },
        { view: "build", text: "What does it touch?", why: "Risk.", options: [{ text: "The API", tradeoff: "Wide" }, { text: "The UI", tradeoff: "Small" }], recommended: 2 },
        { view: "test", text: "Which edge case?", why: "Tests.", options: [{ text: "Empty", tradeoff: "Cheap" }, { text: "Huge", tradeoff: "Slow" }], recommended: 1 },
      ],
      proposals: [{ list: "open", text: "Who may see the reports?" }],
      done: "",
    });
    const id = await newSession("Make reports better");
    await ask(id, "architect");
    const round = await ask(id, "round");
    expect(round.talk.rounds).toHaveLength(1);
    expect(round.talk.rounds[0].questions).toHaveLength(3);
    expect(round.talk.proposals).toHaveLength(1);

    const did = await addDraft(id);
    expect((await post(url(id, `drafts/${did}/ready-check`))).status).toBe(200);
    // The proposal becomes an open question once the person accepts it.
    expect((await post(url(id, `proposals/${round.talk.proposals[0].id}/accept`), {})).status).toBe(200);
    expect((await post(url(id, `drafts/${did}/ready-check`))).status).toBe(200);
    let d = await draftOf(id, did);
    expect(item(d, "no-open-questions")).toMatchObject({ result: "not-met", by: "code" });
    expect(item(d, "no-open-questions").reason).toMatch(/1/);
    expect(d.state).toBe("drafting");
    const planItem = (await w.call(w.ann, "GET", url(id, "publish"))).json().items.find((i: any) => i.draft === did);
    expect(planItem.state).toBe("not-ready");
    await post(url(id, "publish"), {});
    expect(w.gh.createdBodies()).toEqual([]);

    const [q1, q2, q3] = round.talk.rounds[0].questions;
    expect((await post(url(id, `questions/${q1.id}/answer`), { option: 2 })).status).toBe(200);
    expect((await post(url(id, `questions/${q2.id}/answer`), { option: 1 })).status).toBe(200);
    expect((await post(url(id, `questions/${q3.id}/answer`), { unknown: true })).status).toBe(200);
    const answered = await w.get(id);
    expect(answered.talk.map.open.length).toBeGreaterThan(1); // "I don't know yet" leaves a question open
    await post(url(id, `drafts/${did}/ready-check`));
    expect(item(await draftOf(id, did), "no-open-questions").result).toBe("not-met");

    for (const o of answered.talk.map.open) expect((await w.call(w.ann, "DELETE", url(id, `map/${o.id}`))).status).toBe(200);
    await post(url(id, `drafts/${did}/ready-check`));
    d = await draftOf(id, did);
    expect(d.readiness.items.every((i: any) => i.result === "met")).toBe(true);
    expect(d.state).toBe("ready");
    expect((await w.get(id)).state).toBe("ready");
    nothingWritten();
    expect((await post(url(id, "publish"), {})).json().created).toHaveLength(1);
  });

  it("3. a big idea is split into three stories with dependencies, published in order", async () => {
    setRepoReady(w.annRepo().id, { items: LIST2 });
    const id = await newSession("A full reporting area");
    await ask(id, "architect");
    const three = [{ text: "It exports a file" }, { text: "It has a header" }, { text: "It is sent by mail" }];
    const did = await addDraft(id, { ...FULL, title: "Reporting", criteria: three });
    const before = await draftOf(id, did);
    expect((await post(url(id, `drafts/${did}/split`))).status).toBe(202);
    const asked = await w.idle(id);
    const original = asked.drafts.find((d: any) => d.id === did);
    expect(original.split.ways).toHaveLength(2);
    const { split: _s, ...rest } = original;
    expect(rest).toEqual(before); // the architect only proposes

    const c = before.criteria.map((k: any) => k.id);
    const confirmed = await post(url(id, `drafts/${did}/split/confirm`), {
      parts: [
        { title: "Export a file", criteria: [c[0]], dependsOn: [] },
        { title: "Add a header", criteria: [c[1]], dependsOn: [1] },
        { title: "Send it by mail", criteria: [c[2]], dependsOn: [2] },
      ],
      unplaced: [],
    });
    expect(confirmed.status).toBe(201);
    const all = confirmed.json().drafts;
    expect(all).toHaveLength(4);
    expect(all.find((d: any) => d.id === did).state).toBe("split");
    const parts = all.filter((d: any) => d.part).map((d: any) => d.id) as string[];
    expect(parts).toHaveLength(3);
    for (const p of parts) {
      expect((await put(url(id, `drafts/${p}`), { who: FULL.who, what: FULL.what, why: FULL.why, outOfScope: FULL.outOfScope })).status).toBe(200);
      expect((await post(url(id, `drafts/${p}/ready-check`))).status).toBe(200);
    }
    const plan = (await w.call(w.ann, "GET", url(id, "publish"))).json();
    expect(plan.willCreate).toEqual(parts);
    expect(plan.willCreate).not.toContain(did);
    nothingWritten();

    expect((await post(url(id, "publish"), {})).status).toBe(200);
    const made = w.gh.createdBodies();
    expect(made.map((m) => m.title)).toEqual(["Export a file", "Add a header", "Send it by mail"]);
    const numbers = (await w.get(id)).drafts.filter((d: any) => d.published).map((d: any) => d.published.issue) as number[];
    expect(made[1]!.body).toContain(`- #${numbers[0]}`);
    expect(made[2]!.body).toContain(`- #${numbers[1]}`);
    for (const m of made) {
      expect(m.body).not.toContain("new issue");
      expect(m.body).not.toContain("(draft)");
    }
    const s = await w.get(id);
    expect(s.state).toBe("published");
    expect(s.drafts.find((d: any) => d.id === did).published).toBeUndefined();
  });

  it("4. an existing issue is refined and updated, not created again", async () => {
    setRepoReady(w.annRepo().id, { items: LIST2 });
    const body = ["As an admin, I want to export a report, so that I can share it.", "", "### Acceptance criteria", "- [ ] It exports a file", "", "### Notes for the builder", "Use the exporter."].join("\n");
    w.gh.setLabels(["bug"]);
    w.gh.setBugIssues([{
      number: 7, state: "open", state_reason: null, title: "Old title", body, labels: [], html_url: "https://github.com/acme/app/issues/7",
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-02-03T04:05:06Z", closed_at: null,
    } as FakeIssue]);
    const made = await post("/api/refinement", { repo: "acme/app", issue: 7 });
    expect(made.status).toBe(201);
    const s0 = made.json();
    expect(s0.drafts).toHaveLength(1);
    expect(s0.source.issue).toBe(7);
    expect(s0.drafts[0].criteria.every((k: any) => k.from === "typed")).toBe(true);
    nothingWritten();

    const did = s0.drafts[0].id as string;
    expect((await put(url(s0.id, `drafts/${did}`), { title: "Export a report", criteria: [{ text: "It exports a CSV file" }], outOfScope: "Printing" })).status).toBe(200);
    expect((await post(url(s0.id, `drafts/${did}/ready-check`))).status).toBe(200);
    const plan = (await w.call(w.ann, "GET", url(s0.id, "publish"))).json();
    expect(plan.willUpdate).toEqual([did]);
    expect(plan.willCreate).toEqual([]);
    nothingWritten();

    expect((await post(url(s0.id, "publish"), {})).status).toBe(200);
    expect(w.gh.updatedBodies()).toHaveLength(1);
    expect(w.gh.updatedBodies()[0]).toMatchObject({ issue: 7 });
    expect(w.gh.updatedBodies()[0]!.body).toContain("- [ ] It exports a CSV file");
    expect(w.gh.createdBodies()).toEqual([]);
    expect(w.gh.comments().filter((c) => c.issue === 7)).toHaveLength(1);
    await post(url(s0.id, "publish"), {});
    expect(w.gh.updatedBodies()).toHaveLength(1);
    expect(w.gh.comments().filter((c) => c.issue === 7)).toHaveLength(1);
  });
});
