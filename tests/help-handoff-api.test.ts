import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addRepo } from "../src/auth/repos.js";
import { ReplySchema, type Reply } from "../src/help/contract.js";
import { HANDOFF_WORDS, ideaText, type HandoffOffer } from "../src/help/handoff.js";
import { addQuestion, archiveConversation, deleteConversation, finishTurn, getConversation } from "../src/help/store.js";
import { saveFindings, type Finding } from "../src/monitor/findings.js";
import { markerHash } from "../src/monitor/story.js";
import { startServer } from "../src/server/server.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { freePort } from "./helpers/remote.js";
import { signInAs, type TestSession } from "./helpers/session.js";

let base: string;
let tmp: string;
let runsDir: string;
let saved: string | undefined;
let kc: FakeKeychain;
let started: Awaited<ReturnType<typeof startServer>>;
let admin: TestSession;
let ann: TestSession;
let bob: TestSession;
let gitlabRepo = "";
let sshRepo = "";
const FID = markerHash("restart-loop|x");
const finding: Finding = { detector: "restart-loop", fingerprint: "restart-loop|x", severity: "major", summary: "The server restarted.", about: "foundry", evidence: {}, firstSeen: "2026-01-01T00:00:00.000Z", lastSeen: "2026-01-01T00:00:00.000Z", count: 2, gone: false };

const writeRun = (id: string, owner: string, repo = "annco/thing") => {
  mkdirSync(join(runsDir, id), { recursive: true });
  writeFileSync(join(runsDir, id, "run.json"), JSON.stringify({ runId: id, flow: "deliver", task: "", vars: { github_repo: repo }, repo: tmp, source: "ui", status: "waiting", runDir: join(runsDir, id), owner, startedAt: "2026-01-01T00:00:00.000Z", history: [], state: { next: null, steps: {}, visits: {} }, ...{} }));
};
async function call(who: TestSession, method: string, path: string, body?: unknown) {
  const r = await fetch(base + path, { method, headers: who.headers(method, body === undefined ? {} : { "content-type": "application/json" }), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await r.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: r.status, text, json: (): any => JSON.parse(text) };
}
/** The administrator starts "View as user" for this account: only then does `?as=` get past the view checks. */
const viewAs = async (who: TestSession) => {
  const r = await call(admin, "POST", "/api/admin/view-as", { userId: who.user.id });
  expect(r.status).toBe(200);
};
const stateRef =(id: string, title: string, ref: string) => ({ id, kind: "state" as const, title, ref, observedAt: "2026-01-01T00:00:00.000Z" });
const makeReply = (extra: Record<string, unknown> = {}): Reply =>
  ReplySchema.parse({ type: "status", summary: "It waits.", explanation: "", certainty: "unverified", evidence: [], recommendations: [], links: [], drafts: [], actions: [], ...extra });

/** Stores a finished reply for `who`: the question, its page context and the reply. */
function keep(who: TestSession, over: { question?: string; context?: Record<string, unknown>; reply?: Reply } = {}) {
  const turn = addQuestion(who.user.id, { question: over.question ?? "Why does my run wait?", ...(over.context ? { context: over.context } : {}) });
  const reply = over.reply ?? makeReply();
  finishTurn(turn.conversation.id, { message: turn.reply.id, tries: 1 }, reply);
  return { conversation: turn.conversation.id, message: turn.reply.id, question: turn.question.text, reply };
}
const offersOf = async (who: TestSession, at: { conversation: string; message: string }) => {
  const r = await call(who, "GET", `/api/help/conversations/${at.conversation}/handoffs?message=${at.message}`);
  return { status: r.status, offers: (r.status === 200 ? r.json().offers : []) as HandoffOffer[], r };
};
const take = (who: TestSession, at: { conversation: string; message: string }, offer: HandoffOffer, over: Record<string, unknown> = {}) =>
  call(who, "POST", `/api/help/conversations/${at.conversation}/handoffs`, { message: at.message, offer: offer.key, page: offer.page, ...(offer.fill ? { fill: offer.fill } : {}), ...over });
const recorded = (who: TestSession, conversation: string) => getConversation(who.user.id, conversation).handoffs ?? [];

beforeAll(async () => {
  saved = process.env.FACTORY_HOME;
  tmp = mkdtempSync(join(tmpdir(), "help-handoff-"));
  runsDir = join(tmp, "runs");
  process.env.FACTORY_HOME = join(tmp, "home");
  mkdirSync(process.env.FACTORY_HOME, { recursive: true });
  writeFileSync(join(process.env.FACTORY_HOME, "config.yaml"), "default_model: sonnet\nhelp:\n  enabled: true\n");
  kc = fakeKeychain();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  started = await startServer({ repo: tmp, runsDir, port, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, log: () => {} });
  admin = await signInAs(base);
  ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
  bob = await signInAs(base, { name: "Bob", email: "bob@example.com", role: "user" });
  addRepo(ann.user.id, "annco/thing", { ownerOk: () => true });
  sshRepo = addRepo(ann.user.id, { url: "git@github.com:annco/sshthing.git", method: "ssh-deploy-key" }, { ownerOk: () => true }).id;
  gitlabRepo = addRepo(ann.user.id, { url: "ssh://git@gitlab.com/annco/lab.git", method: "ssh-deploy-key" }, { ownerOk: () => true }).id;
  writeRun("run-ann-1", ann.user.id);
  writeRun("run-ann-2", ann.user.id);
  writeRun("run-ann-ssh", ann.user.id, "annco/sshthing");
  writeRun("run-ann-lost", ann.user.id, "gone/repo");
  writeRun("run-bob-1", bob.user.id, "bobco/hidden");
});
afterAll(() => {
  started?.close();
  kc.remove();
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const runCtx = (id: string) => ({ page: `#/runs/${id}`, kind: "run", id });

describe("GET handoffs", () => {
  it("offers the refinement session with a fill that matches the idea text", async () => {
    const at = keep(ann);
    const { status, offers } = await offersOf(ann, at);
    expect(status).toBe(200);
    expect(offers.map((o) => o.key)).toEqual(["refinement"]);
    const o = offers[0]!;
    expect(o.page).toBe("#/refinement");
    expect(o.fill).toEqual({ title: "Why does my run wait?", text: ideaText(at.question, at.reply, []), fromHelp: at.conversation });
    expect(recorded(ann, at.conversation)).toEqual([]);
  });

  it("answers 404 for another account's conversation and an unknown message, 410 for a deleted one, 409 for an archived one", async () => {
    const at = keep(ann);
    expect((await offersOf(bob, at)).status).toBe(404);
    expect((await offersOf(ann, { ...at, message: "00000000-0000-4000-8000-000000000000" })).status).toBe(404);
    expect((await offersOf(ann, { ...at, message: "nope" })).status).toBe(404);
    const archived = keep(ann);
    archiveConversation(ann.user.id, archived.conversation);
    expect((await offersOf(ann, archived)).status).toBe(409);
    const gone = keep(ann);
    deleteConversation(ann.user.id, gone.conversation);
    expect((await offersOf(ann, gone)).status).toBe(410);
  });

  it("gives a run offer for the account's own run only, and a user never gets Problems or Your turn", async () => {
    saveFindings([finding]);
    const own = keep(ann, { context: { ...runCtx("run-ann-1"), entities: [{ kind: "problem", id: FID }] } });
    expect((await offersOf(ann, own)).offers.map((o) => o.key)).toEqual(["run", "refinement"]);
    expect((await offersOf(ann, own)).offers[0]!.page).toBe("#/runs/run-ann-1");
    const theirs = keep(ann, { context: runCtx("run-bob-1") });
    expect((await offersOf(ann, theirs)).offers.map((o) => o.key)).toEqual(["refinement"]);
    const limited = keep(ann, { reply: makeReply({ limit: { code: "monitor-finding", limitation: "x", nextStep: "y" } }) });
    expect((await offersOf(ann, limited)).offers.map((o) => o.key)).toEqual(["refinement"]);
  });

  it("gives an admin Problems and Your turn", async () => {
    saveFindings([finding]);
    const at = keep(admin, { context: { page: `#/problems/${FID}` } });
    const keys = (await offersOf(admin, at)).offers;
    expect(keys.map((o) => o.key)).toEqual(["problems", "your-turn", "refinement"]);
    expect(keys[0]!.page).toBe(`#/problems/${FID}`);
  });

  it("copies the sources that the account can open now, and drops the others", async () => {
    const reply = makeReply({
      evidence: [
        stateRef("state-a", "A run of the flow deliver", "run run-ann-1 · #/runs/run-ann-1"),
        stateRef("state-b", "Diagnosis of the run", "diagnosis · run run-ann-1 · #/runs/run-ann-1"),
        stateRef("state-c", "A run of another account", "run run-bob-1 · #/runs/run-bob-1"),
        stateRef("state-d", "The comparison", "compared by the server"),
      ],
    });
    const at = keep(ann, { context: runCtx("run-ann-1"), reply });
    const o = (await offersOf(ann, at)).offers.find((x) => x.key === "refinement")!;
    expect(o.fill!.text).toContain("- A run of the flow deliver · #/runs/run-ann-1");
    expect(o.fill!.text).toContain("- Diagnosis of the run · #/runs/run-ann-1");
    expect(o.fill!.text).not.toContain("run-bob-1");
    expect(o.fill!.text).not.toContain("compared by the server");
  });

  it("names the repository only when it is a GitHub repository the account owns now", async () => {
    const https = (await offersOf(ann, keep(ann, { context: runCtx("run-ann-1") }))).offers.find((o) => o.key === "refinement")!;
    expect(https.fill!.repo).toBe("annco/thing");
    const ssh = (await offersOf(ann, keep(ann, { context: runCtx("run-ann-ssh") }))).offers.find((o) => o.key === "refinement")!;
    expect(ssh.fill!.repo).toBe("annco/sshthing");
    const viaRepo = (await offersOf(ann, keep(ann, { context: { page: `#/repos/${sshRepo}`, kind: "repository", id: sshRepo } }))).offers.find((o) => o.key === "refinement")!;
    expect(viaRepo.fill!.repo).toBe("annco/sshthing");
    const other = (await offersOf(ann, keep(ann, { context: { page: `#/repos/${gitlabRepo}`, kind: "repository", id: gitlabRepo } }))).offers.find((o) => o.key === "refinement")!;
    expect(other.fill).toBeDefined();
    expect("repo" in other.fill!).toBe(false);
    const lost = (await offersOf(ann, keep(ann, { context: runCtx("run-ann-lost") }))).offers.find((o) => o.key === "refinement")!;
    expect("repo" in lost.fill!).toBe(false);
  });

  it("gives a title the session can keep, also for a long first line", async () => {
    const at = keep(ann, { question: "x".repeat(300), context: runCtx("run-ann-1") });
    const fill = (await offersOf(ann, at)).offers.find((o) => o.key === "refinement")!.fill!;
    expect(fill.title).toHaveLength(120);
    const made = await call(ann, "POST", "/api/refinement", { repo: fill.repo, idea: fill.text, title: fill.title, fromHelp: fill.fromHelp });
    expect(made.status).toBe(201);
    expect(made.json().title).toBe(fill.title);
  });
});

describe("POST handoffs", () => {
  it("records the hand-off when the previewed page and fill are the same, and writes nothing in the target", async () => {
    const at = keep(ann, { context: runCtx("run-ann-1") });
    const before = (await call(ann, "GET", "/api/refinement")).json().sessions.length;
    const offer = (await offersOf(ann, at)).offers.find((o) => o.key === "refinement")!;
    const r = await take(ann, at, offer);
    expect(r.status).toBe(200);
    expect(r.json().offer).toEqual(offer);
    const read = (await call(ann, "GET", `/api/help/conversations/${at.conversation}`)).json();
    expect(read.handoffs).toEqual([{ message: at.message, where: "refinement", page: "#/refinement", copied: ["title", "text", "repository", "link"], at: expect.any(String) }]);
    expect(r.json().conversation.handoffs).toHaveLength(1);
    expect((await call(ann, "GET", "/api/refinement")).json().sessions).toHaveLength(before);
    // a navigation records nothing that was copied
    const nav = (await offersOf(ann, at)).offers.find((o) => o.key === "run")!;
    expect((await take(ann, at, nav)).status).toBe(200);
    expect(recorded(ann, at.conversation).map((h) => h.copied)).toEqual([["title", "text", "repository", "link"], []]);
  });

  it("answers 409 and records nothing for a changed fill, a changed page, an unknown key; 400 for a bad body", async () => {
    const at = keep(ann, { context: runCtx("run-ann-1") });
    const offer = (await offersOf(ann, at)).offers.find((o) => o.key === "refinement")!;
    const changed = await take(ann, at, offer, { fill: { ...offer.fill, text: `${offer.fill!.text} more` } });
    expect(changed.status).toBe(409);
    expect(changed.json().error).toBe(HANDOFF_WORDS.changed);
    expect((await take(ann, at, offer, { page: "#/runs" })).status).toBe(409);
    expect((await take(ann, at, offer, { fill: undefined })).status).toBe(409);
    expect((await take(ann, at, offer, { offer: "issue-draft-9" })).status).toBe(409);
    expect((await take(ann, at, offer, { page: undefined })).status).toBe(400);
    expect(recorded(ann, at.conversation)).toEqual([]);
  });

  it("answers 404 for another account, and 409 for an archived conversation", async () => {
    const at = keep(ann);
    const offer = (await offersOf(ann, at)).offers[0]!;
    expect((await take(bob, at, offer)).status).toBe(404);
    archiveConversation(ann.user.id, at.conversation);
    expect((await take(ann, at, offer)).status).toBe(409);
  });

  it("answers 409 when the run named in the evidence is gone between preview and confirm", async () => {
    writeRun("run-tmp-1", ann.user.id);
    const reply = makeReply({ evidence: [stateRef("state-a", "A run of the flow deliver", "run run-tmp-1 · #/runs/run-tmp-1")] });
    const at = keep(ann, { reply });
    const offer = (await offersOf(ann, at)).offers.find((o) => o.key === "refinement")!;
    expect(offer.fill!.text).toContain("run-tmp-1");
    rmSync(join(runsDir, "run-tmp-1"), { recursive: true, force: true });
    expect((await take(ann, at, offer)).status).toBe(409);
    expect(recorded(ann, at.conversation)).toEqual([]);
  });

  it("answers 409 when the run offer would move to another run", async () => {
    writeRun("run-tmp-2", ann.user.id);
    const at = keep(ann, { context: { page: "#/runs", entities: [{ kind: "run", id: "run-tmp-2" }, { kind: "run", id: "run-ann-2" }] } });
    const offer = (await offersOf(ann, at)).offers.find((o) => o.key === "run")!;
    expect(offer.page).toBe("#/runs/run-tmp-2");
    rmSync(join(runsDir, "run-tmp-2"), { recursive: true, force: true });
    expect((await offersOf(ann, at)).offers.find((o) => o.key === "run")!.page).toBe("#/runs/run-ann-2");
    expect((await take(ann, at, offer)).status).toBe(409);
    expect(recorded(ann, at.conversation)).toEqual([]);
  });

  it("answers 409 when Problems would fall back from the finding to the list", async () => {
    saveFindings([finding]);
    const at = keep(admin, { context: { page: `#/problems/${FID}` }, reply: makeReply({ limit: { code: "monitor-finding", limitation: "x", nextStep: "y" } }) });
    const offer = (await offersOf(admin, at)).offers.find((o) => o.key === "problems")!;
    expect(offer.page).toBe(`#/problems/${FID}`);
    saveFindings([]);
    try {
      expect((await offersOf(admin, at)).offers.find((o) => o.key === "problems")!.page).toBe("#/problems");
      expect((await take(admin, at, offer)).status).toBe(409);
      expect(recorded(admin, at.conversation)).toEqual([]);
    } finally {
      saveFindings([finding]);
    }
  });

  it("is refused in View as user", async () => {
    const at = keep(ann);
    const offer = (await offersOf(ann, at)).offers[0]!;
    await viewAs(ann);
    expect((await call(admin, "GET", `/api/runs?as=${ann.user.id}`)).status).toBe(200);
    expect((await call(admin, "GET", `/api/help/conversations/${at.conversation}/handoffs?message=${at.message}&as=${ann.user.id}`)).status).toBe(403);
    expect((await call(admin, "POST", `/api/help/conversations/${at.conversation}/handoffs?as=${ann.user.id}`, { message: at.message, offer: offer.key, page: offer.page })).status).toBe(403);
  });
});

describe("fromHelp on a refinement session", () => {
  const idea = { repo: "annco/thing", idea: "Make the thing better." };

  it("is shown to the owner only, and never in a list or in View as user", async () => {
    const conv = keep(ann).conversation;
    const made = await call(ann, "POST", "/api/refinement", { ...idea, fromHelp: conv });
    expect(made.status).toBe(201);
    expect(made.json().fromHelp).toBe(conv);
    const id = made.json().id as string;
    expect((await call(ann, "GET", `/api/refinement/${id}`)).json().fromHelp).toBe(conv);
    const asAdmin = await call(admin, "GET", `/api/refinement/${id}`);
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.json().fromHelp).toBeUndefined();
    expect(asAdmin.text).not.toContain(conv);
    await viewAs(ann);
    const preview = await call(admin, "GET", `/api/refinement/${id}?as=${ann.user.id}`);
    expect(preview.status).toBe(200);
    expect(preview.text).not.toContain(conv);
    expect((await call(ann, "GET", "/api/refinement")).text).not.toContain(conv);
    expect(made.json().idea).not.toContain(conv);
  });

  it("leaves it out for another account's or a deleted conversation, and refuses a bad value", async () => {
    const theirs = keep(bob).conversation;
    const a = await call(ann, "POST", "/api/refinement", { ...idea, fromHelp: theirs });
    expect(a.status).toBe(201);
    expect(a.json().fromHelp).toBeUndefined();
    const gone = keep(ann).conversation;
    deleteConversation(ann.user.id, gone);
    const b = await call(ann, "POST", "/api/refinement", { ...idea, fromHelp: gone });
    expect(b.status).toBe(201);
    expect(b.json().fromHelp).toBeUndefined();
    expect((await call(ann, "POST", "/api/refinement", { ...idea, fromHelp: 5 })).status).toBe(400);
    expect((await call(ann, "POST", "/api/refinement", { ...idea, fromHelp: "not-a-uuid" })).status).toBe(400);
    const unknown = await call(ann, "POST", "/api/refinement", { ...idea, fromHelp: "00000000-0000-4000-8000-000000000000" });
    expect(unknown.status).toBe(201);
    expect(unknown.json().fromHelp).toBeUndefined();
  });
});
