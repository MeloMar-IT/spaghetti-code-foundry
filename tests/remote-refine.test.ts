import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addRepo, listRepos, setRepoReady } from "../src/auth/repos.js";
import { findUserByEmail } from "../src/auth/users.js";
import { recordRound } from "../src/refinement/store.js";
import { areaHelp } from "../src/remote/cli.js";
import { REFINE } from "../src/remote/areas/refine.js";
import { parseCmd, specProblems, type Cmd } from "../src/remote/spec.js";
import { RULES } from "../src/server/permissions.js";
import { fakeGit, fakeGithub, type FakeIssue } from "./helpers/fake-github.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { TOKEN } from "./helpers/refinement-world.js";
import { remoteWorld, type RemoteWorld } from "./helpers/remote.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
const FULL = { title: "Export", who: "an admin", what: "to export a report", why: "to share it", outOfScope: "Printing" };
// a Definition of Ready that code can decide alone: a readiness check then starts no architect run
const READY_LIST = [{ id: "out-of-scope", text: "it says what is out of scope" }, { id: "no-open-questions", text: "there are no open questions" }];
const ROUND = {
  questions: [{ view: "need", text: "Who uses it?", why: "It sets the value.", options: [{ text: "Everyone", tradeoff: "Broad" }, { text: "Admins", tradeoff: "Narrow" }], recommended: 1 }],
  proposals: [{ list: "rule", text: "Only admins export." }, { list: "example", text: "An empty report exports a header." }],
  done: "",
};

let w: RemoteWorld;
let gh: ReturnType<typeof fakeGithub>;
let kc: FakeKeychain;
let ann: string;

/** `scf refine <words…>` as Ann, who owns acme/app. */
const refine = (words: string[], o: { as?: string; tty?: boolean; answers?: string[] } = {}) => w.scf(["refine", ...words], { cmds: REFINE, as: ann, ...o });
const json = async (words: string[]): Promise<any> => (await refine([...words, "--json"])).json();
const start = async (idea = "Export a report as CSV"): Promise<string> => (await json(["start", "acme/app", "--idea", idea])).id;
/** Waits until the architect's run of the session has ended: every 100 ms, for at most 30 s. */
async function idle(id: string): Promise<any> {
  for (let i = 0; i < 300; i++) {
    const s = await json(["show", id]);
    if (s.architect.state === "idle") return s;
    if (s.architect.state === "failed") throw new Error(`the architect failed: ${s.architect.reason}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("the architect did not finish");
}
const of = (action: string): Cmd => REFINE.find((c) => c.action === action)!;

beforeAll(async () => {
  // the fake gh and git first: their restore() puts the environment back as it was before the server
  gh = fakeGithub();
  fakeGit(gh, "https://github.com/acme/app");
  process.env.FAKE_GH_EXPECT_TOKEN = TOKEN;
  for (const k of ["FAKE_GH_SLEEP", "FAKE_BRIEF", "FAKE_ROUND", "FAKE_GH_ISSUES"]) delete process.env[k];
  kc = fakeKeychain();
  w = await remoteWorld({ refinementSweepMs: 3_600_000 });
  ann = await w.signIn("ann@example.com");
  const id = findUserByEmail("ann@example.com")!.id;
  addRepo(id, { url: "acme/app", method: "github-token", token: TOKEN });
  setRepoReady(listRepos(id)[0]!.id, { items: READY_LIST });
});
afterAll(() => {
  w.close();
  kc.remove();
  gh.restore();
});

describe("the refine commands", () => {
  it("are calls the server knows, and every refinement call has a command", () => {
    expect(specProblems(REFINE)).toEqual([]);
    const routes = RULES.filter((r) => r.path.startsWith("refinement"));
    expect(routes).toHaveLength(36);
    expect(routes.filter((r) => !REFINE.some((c) => c.method === r.method && c.path === r.path)).map((r) => `${r.method} ${r.path}`)).toEqual([]);
    expect(REFINE.every((c) => c.area === "refine")).toBe(true);
    expect(areaHelp(REFINE, "refine")).toContain("scf refine draft-suggest <id> <did> <field>");
  });

  it("puts arguments and flags where each call wants them", () => {
    const call = (action: string, words: string[]) => parseCmd(of(action), words).call;
    expect(call("start", ["acme/app", "--issue", "12"])).toEqual({ method: "POST", path: "refinement", body: { repo: "acme/app", issue: 12 } });
    expect(call("backlog", ["acme/app"])).toEqual({ method: "GET", path: "refinement/backlog", query: { repo: "acme/app" } });
    expect(call("source-unlabel", ["s1"])).toEqual({ method: "POST", path: "refinement/s1/source/remove-build-label", body: {} });
    expect(call("round", ["s1"])).toEqual({ method: "POST", path: "refinement/s1/round", body: {} });
    expect(call("ask", ["s1", "Is there an export already?"])).toEqual({ method: "POST", path: "refinement/s1/ask", body: { question: "Is there an export already?" } });
    expect(call("question-answer", ["s1", "q1", "--text", "Only admins"]).body).toEqual({ text: "Only admins" });
    expect(call("question-answer", ["s1", "q1", "--unknown"])).toEqual({ method: "POST", path: "refinement/s1/questions/q1/answer", body: { unknown: true } });
    expect(call("epic-clear", ["s1"])).toEqual({ method: "PUT", path: "refinement/s1/epic", body: { issue: null } });
    expect(call("draft-review", ["s1", "d1"])).toEqual({ method: "POST", path: "refinement/s1/drafts/d1/review", body: {} });
    expect(call("draft-impact", ["s1", "d1"])).toEqual({ method: "POST", path: "refinement/s1/drafts/d1/impact", body: {} });
    expect(call("draft-split", ["s1", "d1", "--own", "By role"])).toEqual({ method: "POST", path: "refinement/s1/drafts/d1/split", body: { own: "By role" } });
    const plan = { parts: [{ title: "A", criteria: [], dependsOn: [] }, { title: "B", criteria: [], dependsOn: [1] }], unplaced: [] };
    expect(call("draft-split-confirm", ["s1", "d1", "--way", "0", "--data", JSON.stringify(plan)])).toEqual({ method: "POST", path: "refinement/s1/drafts/d1/split/confirm", body: { way: 0, ...plan } });
    expect(call("criterion-move", ["s1", "d1", "c1", "d2"])).toEqual({ method: "POST", path: "refinement/s1/drafts/d1/criteria/c1/move", body: { to: "d2" } });
    expect(call("draft-merge", ["s1", "d1", "d2"])).toEqual({ method: "POST", path: "refinement/s1/drafts/d1/merge", body: { with: "d2" } });
    expect(call("draft-to-notes", ["s1", "d1", "--field", "criteria", "--item", "c1"])).toEqual({ method: "POST", path: "refinement/s1/drafts/d1/move-to-notes", body: { field: "criteria", item: "c1" } });
    expect(() => call("draft-to-notes", ["s1", "d1"])).toThrow("--field is needed");
    expect(call("review-label-remove", ["s1", "d1"])).toEqual({ method: "PUT", path: "refinement/s1/drafts/d1/review-label", body: { add: false } });
    expect(call("ready-unaccept", ["s1", "d1", "out-of-scope"])).toEqual({ method: "DELETE", path: "refinement/s1/drafts/d1/ready/out-of-scope/accept" });
    expect(call("suggestion-reject", ["s1", "d1", "x1", "--reason", "Too long"])).toEqual({ method: "POST", path: "refinement/s1/drafts/d1/suggestions/x1/reject", body: { reason: "Too long" } });
    const choice = { drafts: [{ draft: "d1", labels: ["bug"], startBuilding: true }] };
    expect(call("publish", ["s1", "--data", JSON.stringify(choice)])).toEqual({ method: "POST", path: "refinement/s1/publish", body: choice });
    // what is lost is said before these calls
    expect(REFINE.filter((c) => c.confirm).map((c) => c.action)).toEqual(["drop", "entry-remove", "draft-remove", "draft-merge", "publish"]);
  });

  it("starts a session, lists it, shows it and renames it", async () => {
    expect((await refine(["list"])).out).toBe("no refinement sessions\n\nrepositories for a new session: acme/app");
    const made = await refine(["start", "acme/app", "--idea", "Export a report as CSV", "--title", "Export"]);
    expect(made.code).toBe(0);
    expect(made.out).toMatch(/^id: +[0-9a-f-]{36}\ntitle: +Export\nrepo: +acme\/app\nstate: +exploring\nidea: +Export a report as CSV\n/);
    expect(made.out).toContain("architect: idle");
    expect(made.out).toContain("Story drafts\nno story drafts yet");
    const id = /^id: +(\S+)/.exec(made.out)![1]!;
    const list = (await refine(["list"])).out.split("\n");
    expect(list[0]).toMatch(/^ID +TITLE +REPO +STATE +UPDATED$/);
    expect(list[1]).toMatch(new RegExp(`^${id} +Export +acme/app +exploring +20`));
    // an admin sees the sessions of all accounts, with the owner
    const all = await w.scf(["refine", "list"], { cmds: REFINE });
    expect(all.out.split("\n")[0]).toMatch(/UPDATED +OWNER$/);
    expect(all.out).toContain("no GitHub repository yet");
    const renamed = await refine(["rename", id, "CSV export"]);
    expect(renamed.out).toMatch(/\ntitle: +CSV export\n/);
    expect((await json(["show", id])).title).toBe("CSV export");
    const bad = await refine(["start", "acme/app"]);
    expect([bad.code, bad.err.startsWith("error: ")]).toEqual([1, true]);
  });

  it("refuses what the account may not do with exit code 4, and hides the session of another account", async () => {
    const id = await start("A private idea");
    // the admin does not own acme/app: GitHub is read with the owner's sign-in only
    for (const words of [["backlog", "acme/app"], ["publish-plan", id]]) {
      const r = await w.scf(["refine", ...words], { cmds: REFINE });
      expect([r.code, r.err.startsWith("error: ")]).toEqual([4, true]);
    }
    const bob = await w.signIn("bob@example.com");
    expect(await refine(["show", id], { as: bob })).toMatchObject({ code: 1, err: "error: no such refinement session" });
  });

  it("asks before it drops a session, and restores it", async () => {
    const id = await start("An idea to drop");
    await expect(refine(["drop", id])).rejects.toThrow("it is removed for good after 30 days. Add --yes to do it without a question.");
    expect(await refine(["drop", id], { tty: true, answers: ["no"] })).toMatchObject({ code: 1, out: "nothing was changed" });
    expect((await json(["show", id])).state).toBe("exploring");
    const dropped = await refine(["drop", id, "--yes"]);
    expect(dropped.out).toMatch(/\nstate: +dropped\n/);
    expect(dropped.out).toMatch(/\nremoved on: +20/);
    expect((await refine(["restore", id])).out).toMatch(/\nstate: +exploring\n/);
  });

  it("shows the architect's questions and proposals, and takes the answers", async () => {
    const id = await start("An idea to talk about");
    recordRound(id, "run-1", ROUND);
    const s = await json(["show", id]);
    const q = s.talk.rounds[0].questions[0].id as string;
    const [p1, p2] = s.talk.proposals.map((p: any) => p.id as string);
    const shown = (await refine(["show", id])).out;
    expect(shown).toContain(`Questions waiting for an answer\n${q}  Who uses it?\n  1. Everyone (Broad) — recommended\n  2. Admins (Narrow)`);
    expect(shown).toMatch(new RegExp(`Proposals waiting\nID +LIST +TEXT\n${p1} +rule +Only admins export\\.\n${p2} +example +An empty report exports a header\\.`));

    const answered = await refine(["question-answer", id, q, "--option", "2"]);
    expect(answered.out).not.toContain("Questions waiting");
    expect((await json(["show", id])).talk.rounds[0].questions[0].answer).toMatchObject({ option: 2 });
    expect((await refine(["proposal-accept", id, p1!])).out).toMatch(new RegExp(`Rules, examples and open questions\nID +LIST +TEXT\n${p1} +rule +Only admins export\\.`));
    expect((await refine(["proposal-reject", id, p2!])).out).not.toContain("Proposals waiting");
    expect((await refine(["entry-set", id, p1!, "Admins export."])).out).toContain("rule  Admins export.");
    await expect(refine(["entry-remove", id, p1!])).rejects.toThrow("This removes the rule, example or open question from the session. Add --yes");
    expect((await refine(["entry-remove", id, p1!, "--yes"])).out).not.toContain("Rules, examples");
    expect((await json(["show", id])).talk.map.rules).toEqual([]);
  });

  it("writes a story draft, checks it, shows the plan and publishes it to the fake GitHub", async () => {
    const id = await start("Export a report");
    expect((await refine(["epic-set", id, "--issue", "7"])).out).toMatch(/\nepic: +#7\n/);
    const added = await refine(["draft-add", id]);
    expect(added.out.split("\n")[0]).toMatch(/^ID +TITLE +STATE +CRITERIA +SUGGESTIONS +ISSUE$/);
    expect(added.out).toContain("(no title)  drafting  0");
    const did = (await json(["draft-list", id])).drafts[0].id as string;

    // one-line fields as flags, the list of criteria from a file
    const file = join(w.tmp, "criteria.json");
    writeFileSync(file, JSON.stringify({ criteria: [{ text: "It exports a file" }] }));
    const set = await refine(["draft-set", id, did, "--title", FULL.title, "--who", FULL.who, "--what", FULL.what, "--why", FULL.why, "--out-of-scope", FULL.outOfScope, "--data", `@${file}`]);
    expect(set.code).toBe(0);
    expect(set.out).toContain("Export\n\n**Epic:** #7\n\nAs an admin, I want to export a report, so that to share it.\n\n### Acceptance criteria\n- [ ] It exports a file\n\n### Out of scope\nPrinting");
    expect(set.out).toMatch(/Acceptance criteria\nID +TEXT\n[0-9a-f-]{36} +It exports a file/);

    expect((await refine(["review-label-add", id, did])).out).toMatch(/\nreview label: +added when published\n/);
    expect((await refine(["review-label-remove", id, did])).out).not.toContain("review label");

    // not checked yet: the plan says why it would not be published
    const early = (await refine(["publish-plan", id])).out;
    expect(early.split("\n")[0]).toMatch(/^N +DRAFT +TITLE +STATE +ISSUE +LABELS +AFTER +REASON$/);
    expect(early).toMatch(new RegExp(`\n1 +${did} +Export +not-ready .*readiness check`));
    expect(early).toContain("A publish creates 0 and changes 0 issue(s) in acme/app.");

    const checked = await refine(["draft-ready-check", id, did]);
    expect(checked.out).toMatch(/^id: +\S+\nstate: +ready\n/);
    expect(checked.out).toMatch(/Definition of Ready\nID +RESULT +BY +REASON\nout-of-scope +met +code /);
    expect((await refine(["draft-list", id])).out).toMatch(new RegExp(`\n${did} +Export +ready +1$`));
    const shown = await refine(["draft-show", id, did]);
    expect(shown.out).toBe(checked.out);
    expect((await refine(["draft-show", id, "nope"])).out).toBe(`no story draft nope in this session: scf refine draft-list ${id}`);

    const plan = (await refine(["publish-plan", id])).out;
    expect(plan).toMatch(new RegExp(`\n1 +${did} +Export +ready\n`));
    expect(plan).toContain("A publish creates 1 and changes 0 issue(s) in acme/app.\nthis repository has no enabled watcher for issues, so no label starts a build");

    await expect(refine(["publish", id])).rejects.toThrow("This creates or changes issues on GitHub for every ready story draft of the session. Add --yes");
    expect(gh.createdBodies()).toEqual([]);
    const published = await refine(["publish", id, "--yes"]);
    expect(published.code).toBe(0);
    expect(published.out).toMatch(new RegExp(`^WHAT +ISSUE +DRAFT +URL\ncreated +#(\\d+) +${did} +https://github\\.com/acme/app/issues/\\d+\n\nsession: published$`));
    expect(gh.createdBodies().map((b) => b.title)).toEqual(["Export"]);
    expect(gh.createdBodies()[0]!.body).toContain("- [ ] It exports a file");
    expect((await refine(["draft-list", id])).out).toMatch(new RegExp(`\n${did} +Export +ready +1 +#\\d+$`));
    expect((await refine(["publish-plan", id])).out).toMatch(/Export +on-github +#\d+/);
  });

  it("accepts an item of the Definition of Ready anyway, and removes and merges drafts after a question", async () => {
    const id = await start("Two small stories");
    const ids: string[] = [];
    for (const title of ["First", "Second", "Third"]) {
      await refine(["draft-add", id]);
      const did = (await json(["draft-list", id])).drafts.at(-1).id as string;
      await refine(["draft-set", id, did, "--title", title, "--who", "an admin", "--what", `to see ${title}`, "--why", "to know it"]);
      ids.push(did);
    }
    const [a, b, c] = ids as [string, string, string];
    // no "out of scope" text: the item is not met until it is accepted anyway
    expect((await refine(["draft-ready-check", id, a])).out).toMatch(/\nout-of-scope +not-met +code /);
    const accepted = await refine(["ready-accept", id, a, "out-of-scope", "--reason", "Nothing is left out"]);
    expect(accepted.out).toMatch(/Accepted anyway\nID +REASON\nout-of-scope +Nothing is left out/);
    expect((await refine(["ready-unaccept", id, a, "out-of-scope"])).out).not.toContain("Accepted anyway");

    await expect(refine(["draft-remove", id, c])).rejects.toThrow("This removes the story draft and its texts. Add --yes");
    const removed = await refine(["draft-remove", id, c, "--yes"]);
    expect(removed.out.split("\n")).toHaveLength(3);
    expect(removed.out).not.toContain("Third");
    const merged = await refine(["draft-merge", id, a, b, "--yes"]);
    expect(merged.out.split("\n")).toHaveLength(2);
    expect(merged.out).toContain(a);
  });

  it("lists the open issues of a repository with their checks", async () => {
    const issue = (n: number, title: string, body: string): FakeIssue =>
      ({ number: n, state: "open", state_reason: null, title, body, labels: [], html_url: `https://github.com/acme/app/issues/${n}`, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-02-03T04:05:06Z", closed_at: null }) as FakeIssue;
    const before = gh.bugIssues();
    gh.setBugIssues([...before, issue(901, "A rough wish", "Please fix the thing.")]);
    try {
      const r = await refine(["backlog", "acme/app"]);
      expect(r.code).toBe(0);
      expect(r.out.split("\n")[0]).toMatch(/^ISSUE +TITLE +CRITERIA +VALUE +DEPENDS +QUESTIONS +SESSION$/);
      expect(r.out).toMatch(/\n#901 +A rough wish +no +no +/);
      expect((await json(["backlog", "acme/app"])).repo).toBe("acme/app");
    } finally {
      gh.setBugIssues(before);
    }
  });

  it("lets the architect read the repository and suggest a title, and takes the suggestion into the draft", async () => {
    const id = await start("Export a report as CSV, with the architect");
    const asked = await refine(["brief", id]);
    expect(asked.code).toBe(0);
    expect(asked.out).toMatch(/\narchitect: +(queued|running|idle)/);
    expect((await idle(id)).brief).toBeDefined();
    expect((await refine(["show", id])).out).toMatch(/\nbrief: +read \(see --json\)\n/);

    await refine(["draft-add", id]);
    const did = (await json(["draft-list", id])).drafts[0].id as string;
    expect((await refine(["draft-suggest", id, did, "title"])).code).toBe(0);
    const s = await idle(id);
    const sid = s.drafts[0].suggestions[0].id as string;
    expect((await refine(["draft-list", id])).out).toMatch(new RegExp(`\n${did} +\\(no title\\) +drafting +0 +1$`));
    expect((await refine(["draft-show", id, did])).out).toMatch(new RegExp(`Suggestions waiting\nID +FIELD +TEXT\n${sid} +title +A suggested title`));
    const taken = await refine(["suggestion-accept", id, did, sid]);
    expect(taken.out).not.toContain("Suggestions waiting");
    expect(taken.out).toContain("\n\nA suggested title\n\nAs …");
    // a run is refused with the server's sentence while a field has nothing to work from
    const none = await refine(["draft-suggest", id, did, "criteria"]);
    expect(none).toMatchObject({ code: 1, err: "error: there is no rule and no example in the map yet; ask for a round of questions and accept some entries first" });
  }, 90_000);
});
