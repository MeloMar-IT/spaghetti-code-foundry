import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRepo, setRepoWorkspace } from "../src/auth/repos.js";
import { beginGuideProject, guideIdea, readProgress, recordGuideProject, saveProgress, type Answers } from "../src/onboarding/progress-store.js";
import type { ServerOptions } from "../src/server/server.js";
import { parseStoryFile } from "../src/stories/story-file.js";
import { fakeGit, fakeGithub } from "./helpers/fake-github.js";
import { startTestServer } from "./helpers/port.js";
import { signInAs, type TestSession } from "./helpers/session.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
// Get started, steps 6 and 7 on the server: the guide's refinement session, and the whole way from the answers to a story set to `go`.
// Fake `claude`, no `gh`. Nothing waits for a fixed time: the scheduler's idle() is the event.

let base: string;
let gh: ReturnType<typeof fakeGithub>;
let tmp: string;
let started: Awaited<ReturnType<typeof startTestServer>> | undefined;
let admin: TestSession;
let ann: TestSession;
let model: any;
let n = 0;

beforeEach(async () => {
  model = await import("../ui/onboarding-guide-model.js" as string);
  gh = fakeGithub();
  fakeGit(gh, "https://github.com/acme/app");
  tmp = mkdtempSync(join(tmpdir(), "onboarding-e2e-"));
  process.env.FACTORY_HOME = join(tmp, "home");
  const opts: Omit<ServerOptions, "port"> = { repo: tmp, runsDir: join(tmp, "runs"), claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, refinementSweepMs: 3_600_000 };
  started = await startTestServer(opts);
  base = started.base;
  admin = await signInAs(base);
  ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
});
afterEach(async () => {
  if (!started?.ctx.scheduler.draining) await started?.ctx.scheduler.idle();
  started?.close();
  started = undefined;
  gh.restore();
  rmSync(tmp, { recursive: true, force: true });
});

async function call(who: TestSession, method: string, path: string, body?: unknown) {
  const send = () =>
    fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...who.headers(method) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const r = await send().catch(() => send());
  const text = await r.text();
  return { status: r.status, text, json: () => JSON.parse(text) };
}
const ghCalls = () => gh.ghLog().split("\n").filter((l) => l.startsWith("gh "));
const ANSWERS: Answers = { starter: "website", about: { who: "Café guests", what: "Show the menu and the opening hours." }, name: "Café Page", style: "Warm colours", where: "local" };

/** A guide project made without the starter: a folder, its record and the progress that names it, as the guide leaves them. */
function guideProject(who: TestSession, answers: Answers = ANSWERS) {
  const dir = join(tmp, `project-${n++}`);
  mkdirSync(dir);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "pipe" });
  saveProgress(who.user.id, { step: "step-5", answers });
  const rec = addRepo(who.user.id, { url: dir, method: "local" });
  const begun = beginGuideProject(who.user.id, () => false);
  if (!("token" in begun)) throw new Error("expected a token");
  recordGuideProject(who.user.id, begun.token, rec.id);
  return rec;
}
const sessions = async (who: TestSession) => ((await call(who, "GET", "/api/refinement")).json().sessions as any[]);
const live = async (who: TestSession) => (await sessions(who)).filter((s) => s.state !== "dropped");

describe("guideIdea", () => {
  it("builds the title and the idea from the answers", () => {
    const g = guideIdea(ANSWERS, "Website");
    expect(g.title).toBe("Café Page");
    expect(g.idea).toBe(['Make the first version of "Café Page", a new Website made from a starter.', "Who it is for: Café guests", "What it should do:", "Show the menu and the opening hours.", "Colours or style: Warm colours"].join("\n"));
  });

  it("leaves out what was not answered, and names an unnamed project", () => {
    const g = guideIdea({ about: { what: "A quiz" } });
    expect(g.title).toBe("My project");
    expect(g.idea).toBe(['Make the first version of "My project", a new project made from a starter.', "What it should do:", "A quiz"].join("\n"));
    expect(guideIdea({ name: "x".repeat(300) }).title).toHaveLength(120);
  });
});

describe("POST /api/refinement with guide: true", { timeout: 30_000 }, () => {
  it("answers 409 without a project of the guide, and makes nothing", async () => {
    const r = await call(admin, "POST", "/api/refinement", { guide: true });
    expect(r.status).toBe(409);
    expect(await sessions(admin)).toEqual([]);
    expect((await call(ann, "POST", "/api/refinement", { guide: true })).status).toBe(409);
    expect(await sessions(ann)).toEqual([]);
  });

  it("makes one session, keeps its id in the guide and answers 200 with the same session after that", async () => {
    const rec = guideProject(admin);
    const first = await call(admin, "POST", "/api/refinement", { guide: true });
    expect(first.status, first.text).toBe(201);
    const s = first.json();
    expect(s.title).toBe("Café Page");
    expect(s.idea).toContain("Who it is for: Café guests");
    expect(s.idea).toContain("Show the menu and the opening hours.");
    expect(s.idea).toContain("Colours or style: Warm colours");
    expect(s.repo).toMatch(/^local:/);
    expect(readProgress(admin.user.id)!.answers.session).toBe(s.id);
    const second = await call(admin, "POST", "/api/refinement", { guide: true });
    expect(second.status).toBe(200);
    expect(second.json().id).toBe(s.id);
    expect(await live(admin)).toHaveLength(1);
    expect(rec.id).toBeTruthy();
    expect(ghCalls()).toEqual([]);
  });

  it("two calls at the same time make one session", async () => {
    guideProject(admin);
    const [x, y] = await Promise.all([call(admin, "POST", "/api/refinement", { guide: true }), call(admin, "POST", "/api/refinement", { guide: true })]);
    expect([x.status, y.status].sort()).toEqual([200, 201]);
    expect(x.json().id).toBe(y.json().id);
    expect(await live(admin)).toHaveLength(1);
  });

  it("is not changed by a PUT of the progress, and a dropped session is replaced", async () => {
    guideProject(admin);
    const id = (await call(admin, "POST", "/api/refinement", { guide: true })).json().id as string;
    const other = "11111111-1111-4111-8111-111111111111";
    const put = await call(admin, "PUT", "/api/onboarding/progress", { step: "step-6", answers: { ...readProgress(admin.user.id)!.answers, session: other } });
    expect(put.status).toBe(200);
    expect(readProgress(admin.user.id)!.answers.session).toBe(id);
    const noSession = { ...readProgress(admin.user.id)!.answers };
    delete noSession.session;
    expect((await call(admin, "PUT", "/api/onboarding/progress", { step: "step-6", answers: noSession })).status).toBe(200);
    expect(readProgress(admin.user.id)!.answers.session).toBe(id);
    expect((await call(admin, "POST", `/api/refinement/${id}/drop`)).status).toBe(200);
    const again = await call(admin, "POST", "/api/refinement", { guide: true });
    expect(again.status).toBe(201);
    expect(again.json().id).not.toBe(id);
    expect(readProgress(admin.user.id)!.answers.session).toBe(again.json().id);
  });

  it("refuses a body that says more than guide: true", async () => {
    guideProject(admin);
    for (const body of [{ guide: false }, { guide: "yes" }, { guide: true, repo: "acme/app" }, { guide: true, idea: "x" }, { guide: true, title: "x" }, { guide: true, issue: 1 }]) {
      expect((await call(admin, "POST", "/api/refinement", body)).status).toBe(400);
    }
    expect(await sessions(admin)).toEqual([]);
  });

  it("refuses a project outside the caller's workspaces, for a new session and for a reopened one", async () => {
    const rec = guideProject(ann);
    const first = await call(ann, "POST", "/api/refinement", { guide: true });
    expect(first.status).toBe(201);
    setRepoWorkspace(rec.id, { workspace: "team-a" }, () => true);
    const reopened = await call(ann, "POST", "/api/refinement", { guide: true });
    expect(reopened.status).toBe(409);
    expect(reopened.text).not.toContain(first.json().id);
    // a new session is refused too, and none is made
    const before = readdirSync(join(tmp, "home")).length;
    const rec2 = guideProject(ann);
    setRepoWorkspace(rec2.id, { workspace: "team-a" }, () => true);
    expect((await call(ann, "POST", "/api/refinement", { guide: true })).status).toBe(409);
    expect(readProgress(ann.user.id)!.answers.session).toBeUndefined();
    expect(readdirSync(join(tmp, "home")).length).toBe(before);
  });

  it("drops the new session when its id cannot be recorded, and a retry makes exactly one", async () => {
    guideProject(admin);
    // answers that fit now but not with one more id: the record step fails after the session was made
    const room = (extra: number): Answers => ({ ...ANSWERS, filler: "x".repeat(extra) });
    const sizeOf = (a: Answers) => Buffer.byteLength(JSON.stringify({ ...a, repoId: readProgress(admin.user.id)!.answers.repoId }));
    let extra = 100;
    extra += 16_384 - 20 - sizeOf(room(extra));
    saveProgress(admin.user.id, { step: "step-6", answers: room(extra) });
    const failed = await call(admin, "POST", "/api/refinement", { guide: true });
    expect(failed.status).toBe(413);
    expect(readProgress(admin.user.id)!.answers.session).toBeUndefined();
    const all = await sessions(admin);
    expect(all).toHaveLength(1);
    expect(all[0].state).toBe("dropped");
    saveProgress(admin.user.id, { step: "step-6", answers: ANSWERS });
    const ok = await call(admin, "POST", "/api/refinement", { guide: true });
    expect(ok.status).toBe(201);
    expect(await live(admin)).toHaveLength(1);
    expect(readProgress(admin.user.id)!.answers.session).toBe(ok.json().id);
  });

  it("answers 409 and leaves no session when the guide was started again", async () => {
    guideProject(admin);
    expect((await call(admin, "DELETE", "/api/onboarding/progress")).status).toBe(200);
    expect((await call(admin, "POST", "/api/refinement", { guide: true })).status).toBe(409);
    expect(await sessions(admin)).toEqual([]);
  });
});

describe("the whole way: answers to a story set to go", { timeout: 60_000 }, () => {
  const storyDir = (projectDir: string) => join(projectDir, ".scf", "stories");

  it("goes from step 1 to a first story in state go on a local project, with no gh call", async () => {
    // steps 1 to 5 as the guide saves them, with a Back
    const steps = ["welcome", "computer", "agents", "step-3", "step-4", "step-3", "step-4", "step-5"];
    let answers: Answers = {};
    for (const [i, step] of steps.entries()) {
      if (step === "step-4" && i === 4) answers = { starter: "website" };
      if (step === "step-5") answers = { ...ANSWERS };
      const put = await call(admin, "PUT", "/api/onboarding/progress", { step, answers });
      expect(put.status, put.text).toBe(200);
    }
    const parent = join(tmp, "projects");
    mkdirSync(parent);
    const made = await call(admin, "POST", "/api/starters/website/project", { name: "Café Page", parent, guide: true });
    expect(made.status, made.text).toBe(201);
    const repoId = made.json().repo.id as string;
    const projectDir = made.json().repo.url as string;

    const sess = await call(admin, "POST", "/api/refinement", { guide: true });
    expect(sess.status, sess.text).toBe(201);
    const id = sess.json().id as string;
    const view = async () => (await call(admin, "GET", `/api/refinement/${id}`)).json();

    expect((await call(admin, "POST", `/api/refinement/${id}/architect`, {})).status).toBe(202);
    await started!.ctx.scheduler.idle();
    let s = await view();
    expect(model.planPhase(s)).toBe("need-plan");
    expect((await call(admin, "POST", `/api/refinement/${id}/understand`, { words: "simple" })).status).toBe(202);
    await started!.ctx.scheduler.idle();
    s = await view();
    expect(model.planPhase(s)).toBe("plan");
    expect(model.planItems(s)[0].title).toBe("Export a report");

    // the build loop of step 6, over the routes it uses
    let done = false;
    for (let i = 0; i < model.MAX_BUILD_ACTIONS && !done; i++) {
      s = await view();
      const act = model.nextBuildAction(s);
      if (act.type === "wait") await started!.ctx.scheduler.idle();
      else if (act.type === "check") expect((await call(admin, "POST", `/api/refinement/${id}/drafts/${act.draft}/ready-check`, {})).status).toBeLessThan(300);
      else if (act.type === "accept") expect((await call(admin, "POST", `/api/refinement/${id}/drafts/${act.draft}/ready/${act.item}/accept`, { reason: model.ACCEPT_REASON })).status).toBe(200);
      else if (act.type === "publish") {
        const pub = await call(admin, "POST", `/api/refinement/${id}/publish`, { drafts: act.drafts.map((draft: string) => ({ draft, startBuilding: true })) });
        expect(pub.status, pub.text).toBe(200);
        expect(pub.json().created.length).toBe(act.drafts.length);
      } else if (act.type === "done") done = true;
      else throw new Error(`the build stopped: ${JSON.stringify(act)}`);
      await started!.ctx.scheduler.idle();
    }
    expect(done).toBe(true);

    const files = readdirSync(storyDir(projectDir)).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const parsed = parseStoryFile(readFileSync(join(storyDir(projectDir), f), "utf8"), f) as any;
      expect((parsed.story ?? parsed).state).toBe("go");
    }
    // publishing again makes nothing new
    const again = await call(admin, "POST", `/api/refinement/${id}/publish`, { drafts: [] });
    expect(again.status).toBe(200);
    expect(again.json().created).toEqual([]);
    expect(readdirSync(storyDir(projectDir)).filter((f) => f.endsWith(".md"))).toHaveLength(files.length);

    // the watcher of the project: added once, found the second time
    const add = await call(admin, "POST", `/api/admin/repos/${repoId}/watchers`, { id: model.guideWatcherId(repoId), source: "issues" });
    expect(add.status, add.text).toBe(201);
    const rows = (await call(admin, "GET", `/api/admin/repos/${repoId}/watchers`)).json();
    expect(model.issuesWatcherOf(rows)?.id).toBe(model.guideWatcherId(repoId));
    expect(ghCalls()).toEqual([]);
  });
});
