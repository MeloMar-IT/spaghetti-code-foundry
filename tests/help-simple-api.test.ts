import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { addRepo } from "../src/auth/repos.js";
import { helpProjects, helpTurnsOf } from "../src/server/api-help.js";
import { startServer } from "../src/server/server.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { installFakeDom } from "./helpers/fake-dom.js";
import { freePort } from "./helpers/remote.js";
import { signInAs, type TestSession } from "./helpers/session.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
// Ask Foundry in the Simple view, through the server with the fake claude: the view of the account decides.
let base: string;
let tmp: string;
let saved: Record<string, string | undefined>;
let kc: FakeKeychain;
let started: Awaited<ReturnType<typeof startServer>>;
let admin: TestSession;
let ann: TestSession;
let restoreDom: () => void;
let ui: any;
let words: any;
const ids = { annRepo: "", bobRepo: "" };
const OK = { ownerOk: () => true, repoName: (_o: string, n: string) => n };

beforeAll(async () => {
  saved = { home: process.env.FACTORY_HOME, help: process.env.FAKE_HELP };
  delete process.env.FAKE_HELP;
  tmp = mkdtempSync(join(tmpdir(), "help-simple-api-"));
  process.env.FACTORY_HOME = join(tmp, "home");
  mkdirSync(process.env.FACTORY_HOME, { recursive: true });
  writeFileSync(join(process.env.FACTORY_HOME, "config.yaml"), "default_model: sonnet\nhelp:\n  enabled: true\n  turns_per_user_per_day: 30\n");
  kc = fakeKeychain();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  started = await startServer({ repo: tmp, runsDir: join(tmp, "runs"), port, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, log: () => {} });
  admin = await signInAs(base);
  ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
  const bob = await signInAs(base, { name: "Bob", email: "bob@example.com", role: "user" });
  ids.annRepo = addRepo(ann.user.id, "acme/app", OK).id;
  ids.bobRepo = addRepo(bob.user.id, "bobco/hidden-thing", OK).id;
  restoreDom = installFakeDom();
  ui = await import("../ui/ask-model.js" as string);
  words = await import("../ui/simple-words.js" as string);
});
afterEach(() => {
  delete process.env.FAKE_HELP;
});
afterAll(() => {
  restoreDom?.();
  started?.close();
  kc.remove();
  for (const [k, env] of [["home", "FACTORY_HOME"], ["help", "FAKE_HELP"]] as const) {
    if (saved[k] === undefined) delete process.env[env];
    else process.env[env] = saved[k];
  }
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function call(who: TestSession, method: string, path: string, body?: unknown) {
  const r = await fetch(base + path, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...who.headers(method) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, text, json: () => JSON.parse(text) };
}
const view = async (who: TestSession, v: string) => expect((await call(who, "PUT", "/api/me/view", { view: v })).status).toBe(200);
async function asked(who: TestSession, question: string) {
  const r = await call(who, "POST", "/api/help/conversations", { question });
  expect(r.status, r.text).toBe(202);
  await helpTurnsOf(started.ctx).idle();
  return (await call(who, "GET", `/api/help/conversations/${r.json().id}`)).json().messages.at(-1);
}
const canned = () => ({
  type: "product-help",
  summary: "Your run failed on the repository.",
  explanation: "The issue was merged. Check the logs.",
  certainty: "unverified",
  links: [{ to: "#/home" }, { to: "#/help" }, { to: `#/repos/${ids.annRepo}` }, { to: `#/repos/${ids.bobRepo}` }, { to: "#/runs" }, { to: "#/settings" }],
  drafts: [{ title: "d", text: "a draft" }],
});
const tos = (m: any) => m.reply.links.map((l: any) => l.to);

describe("Ask Foundry for an account in the Simple view", () => {
  it("reads the projects of the account only", () => {
    expect(helpProjects(ann.user.id)).toEqual([{ id: ids.annRepo, name: "app" }]);
    expect(helpProjects("00000000-0000-4000-8000-000000000000")).toEqual([]);
  });

  it("keeps only Simple links, no drafts, and lays the stored answer out in plain words", async () => {
    await view(ann, "simple");
    process.env.FAKE_HELP = JSON.stringify(canned());
    const m = await asked(ann, "What happened?");
    expect(tos(m)).toEqual(["#/home", "#/help", `#/repos/${ids.annRepo}`]);
    expect(m.reply.links[2].label).toBe("app");
    expect(m.reply.drafts).toEqual([]);
    const layout = ui.replyLayout(m.reply, "user", [], { simple: true });
    expect(layout.summary).toBe("Your work got stuck on the project.");
    expect(layout.explanation).toBe("The change was done.");
    expect(layout.cards.filter((c: any) => c.link).map((c: any) => c.link.href)).toEqual(["#/home", "#/help", `#/repos/${ids.annRepo}`]);
    const texts = [layout.summary, layout.explanation, ...layout.cards.map((c: any) => `${c.title} ${c.text} ${c.note} ${c.link?.title ?? ""}`)];
    for (const t of texts) expect(words.forbiddenIn(t), t).toEqual([]);
  });

  it("also for an administrator: another account's project is not linked", async () => {
    await view(admin, "simple");
    process.env.FAKE_HELP = JSON.stringify(canned());
    const m = await asked(admin, "What happened?");
    expect(tos(m)).toEqual(["#/home", "#/help"]);
  });

  it("changes nothing for the Advanced view", async () => {
    await view(ann, "advanced");
    process.env.FAKE_HELP = JSON.stringify(canned());
    const m = await asked(ann, "What happened again?");
    expect(tos(m)).toContain("#/runs");
    expect(tos(m)).not.toContain("#/settings");
    expect(m.reply.drafts).toHaveLength(1);
  });
});
