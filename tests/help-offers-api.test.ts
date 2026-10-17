import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditPath } from "../src/auth/audit.js";
import { addRepo } from "../src/auth/repos.js";
import { setStatus, updateUser } from "../src/auth/users.js";
import { OFFER_WORDS, OFFERS, type Offer } from "../src/help/actions.js";
import { ReplySchema } from "../src/help/contract.js";
import { addQuestion, archiveConversation, completeConversation, deleteConversation, finishTurn, getConversation } from "../src/help/store.js";
import { guardedHelpAsync } from "../src/server/api-help.js";
import { runOffer } from "../src/server/help-evidence.js";
import { RULES, findRule } from "../src/server/permissions.js";
import { startServer } from "../src/server/server.js";
import { dismissTurn, restoreTurn, turnFor } from "../src/server/your-turn.js";
import { onHome } from "../src/your-turn.js";
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
let admin2: TestSession;
let ann: TestSession;
let bob: TestSession;
let cy: TestSession;
let annRepo = "";
let bobRepo = "";
let cyRepo = "";

const writeRun = (id: string, owner: string, extra: Record<string, unknown> = {}) => {
  mkdirSync(join(runsDir, id), { recursive: true });
  writeFileSync(join(runsDir, id, "run.json"), JSON.stringify({ runId: id, flow: "deliver", task: "", vars: { github_repo: "acme/app" }, repo: tmp, source: "ui", status: "waiting", runDir: join(runsDir, id), owner, startedAt: "2026-01-01T00:00:00.000Z", history: [], state: { next: null, steps: {}, visits: {} }, ...extra }));
};
const asker = (who: TestSession, role: "admin" | "user" = "user") => ({ id: who.user.id, role });

/** Stores a finished reply with these offers in a new conversation of the owner. */
function keep(owner: TestSession, offers: Offer[]) {
  const turn = addQuestion(owner.user.id, { question: "Why does it wait?" });
  const reply = ReplySchema.parse({ type: "status", summary: "It waits.", explanation: "", certainty: "unverified", evidence: [], recommendations: [], links: [], drafts: [], actions: [], offers });
  finishTurn(turn.conversation.id, { message: turn.reply.id, tries: 1 }, reply);
  return { conversation: turn.conversation.id, message: turn.reply.id };
}
const offerOf = (type: Offer["type"], kind: Offer["subject"]["kind"], id: string): Offer => ({ type, title: OFFERS.find((o) => o.type === type)!.title, evidence: "state-x", subject: { kind, id } });
/** What the click gives: the result, or the status and the sentence of the refusal. */
async function click(who: TestSession, role: "admin" | "user", at: { conversation: string; message: string }, offer = 0, guard = {}) {
  try {
    return await guardedHelpAsync(started.ctx, () => runOffer(started.ctx, asker(who, role), at.conversation, { message: at.message, offer }, guard));
  } catch (e) {
    const s = e as { status?: number; message: string };
    return { status: s.status, message: s.message };
  }
}
const STALE = { status: 404, message: OFFER_WORDS.stale };
const DENIED = { status: 403, message: OFFER_WORDS.denied };

/** Runs `fn` with the rule of a call changed, and puts it back. */
async function withRule(change: () => () => void, fn: () => void | Promise<void>) {
  const undo = change();
  try {
    await fn();
  } finally {
    undo();
  }
}
const ruleNo = (method: string, seg: string[]) => () => {
  const rule = findRule(method, seg)!;
  const was = rule.user;
  rule.user = "no";
  return () => {
    rule.user = was;
  };
};

beforeAll(async () => {
  saved = process.env.FACTORY_HOME;
  tmp = mkdtempSync(join(tmpdir(), "help-offers-"));
  runsDir = join(tmp, "runs");
  process.env.FACTORY_HOME = join(tmp, "home");
  mkdirSync(process.env.FACTORY_HOME, { recursive: true });
  writeFileSync(join(process.env.FACTORY_HOME, "config.yaml"), "default_model: sonnet\nhelp:\n  enabled: true\n");
  kc = fakeKeychain();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  started = await startServer({ repo: tmp, runsDir, port, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, log: () => {} });
  admin = await signInAs(base);
  admin2 = await signInAs(base, { name: "Second", email: "admin2@example.com", role: "admin" });
  ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
  bob = await signInAs(base, { name: "Bob", email: "bob@example.com", role: "user" });
  cy = await signInAs(base, { name: "Cy", email: "cy@example.com", role: "user" });
  writeRun("run-ann-1", ann.user.id);
  writeRun("run-bob-1", bob.user.id);
  writeRun("run-cy-1", cy.user.id);
  annRepo = addRepo(ann.user.id, "annco/thing", { ownerOk: () => true }).id;
  bobRepo = addRepo(bob.user.id, "bobco/hidden-thing", { ownerOk: () => true }).id;
  cyRepo = addRepo(cy.user.id, "cyco/thing", { ownerOk: () => true }).id;
});
afterAll(() => {
  started?.close();
  kc.remove();
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("open-run", () => {
  it("opens the run of the account", async () => {
    expect(await click(ann, "user", keep(ann, [offerOf("open-run", "run", "run-ann-1")]))).toEqual({ type: "open-run", to: "#/runs/run-ann-1" });
    expect(await click(admin, "admin", keep(admin, [offerOf("open-run", "run", "run-bob-1")]))).toEqual({ type: "open-run", to: "#/runs/run-bob-1" });
  });

  it("is denied for an account that is blocked now", async () => {
    const at = keep(cy, [offerOf("open-run", "run", "run-cy-1")]);
    await setStatus(cy.user.id, "blocked");
    try {
      expect(await click(cy, "user", at)).toEqual(DENIED);
    } finally {
      await setStatus(cy.user.id, "active");
    }
    expect(await click(cy, "user", at)).toMatchObject({ type: "open-run" });
  });

  it("is denied when the rule of the call refuses now", async () => {
    const at = keep(ann, [offerOf("open-run", "run", "run-ann-1")]);
    await withRule(ruleNo("GET", ["runs", "run-ann-1"]), async () => {
      expect(await click(ann, "user", at)).toEqual(DENIED);
    });
    expect(await click(ann, "user", at)).toMatchObject({ type: "open-run" });
  });

  it("is stale when the run is gone, when the id is now protected, and for the run of another account", async () => {
    expect(await click(ann, "user", keep(ann, [offerOf("open-run", "run", "run-gone")]))).toEqual(STALE);
    const at = keep(ann, [offerOf("open-run", "run", "run-ann-1")]);
    expect(await click(ann, "user", at, 0, { patterns: ["run-ann-\\d"] })).toEqual(STALE);
    expect(await click(ann, "user", keep(ann, [offerOf("open-run", "run", "run-bob-1")]))).toEqual(STALE);
  });
});

describe("open-repository", () => {
  it("opens the repository of the account", async () => {
    expect(await click(ann, "user", keep(ann, [offerOf("open-repository", "repository", annRepo)]))).toEqual({ type: "open-repository", to: `#/repos/${annRepo}` });
  });

  it("is denied for an account that is blocked now", async () => {
    const at = keep(cy, [offerOf("open-repository", "repository", cyRepo)]);
    await setStatus(cy.user.id, "blocked");
    try {
      expect(await click(cy, "user", at)).toEqual(DENIED);
    } finally {
      await setStatus(cy.user.id, "active");
    }
  });

  it("is denied when the rule of the call refuses now", async () => {
    const at = keep(ann, [offerOf("open-repository", "repository", annRepo)]);
    await withRule(ruleNo("GET", ["repos"]), async () => {
      expect(await click(ann, "user", at)).toEqual(DENIED);
    });
  });

  it("is stale for an unknown repository and for the repository of another account", async () => {
    expect(await click(ann, "user", keep(ann, [offerOf("open-repository", "repository", "99999999-9999-4999-8999-999999999999")]))).toEqual(STALE);
    expect(await click(ann, "user", keep(ann, [offerOf("open-repository", "repository", bobRepo)]))).toEqual(STALE);
  });
});

describe("open-turn-item", () => {
  const key = () => turnFor(started.ctx).all.find((i) => i.next.runId === "run-ann-1")?.key;

  it("has the run on Home", () => {
    expect(onHome(turnFor(started.ctx), { runId: "run-ann-1" })).toBe(true);
  });

  it("opens Home for a run that is there", async () => {
    expect(await click(admin, "admin", keep(admin, [offerOf("open-turn-item", "run", "run-ann-1")]))).toEqual({ type: "open-turn-item", to: "#/home" });
  });

  it("is denied for an administrator who is a user now", async () => {
    const at = keep(admin2, [offerOf("open-turn-item", "run", "run-ann-1")]);
    await updateUser(admin2.user.id, { role: "user" });
    try {
      expect(await click(admin2, "admin", at)).toEqual(DENIED);
    } finally {
      await updateUser(admin2.user.id, { role: "admin" });
    }
  });

  it("is denied when the rule of the call is gone", async () => {
    const at = keep(admin, [offerOf("open-turn-item", "run", "run-ann-1")]);
    const i = RULES.findIndex((r) => r.method === "GET" && r.path === "your-turn");
    const [rule] = RULES.splice(i, 1);
    try {
      expect(await click(admin, "admin", at)).toEqual(DENIED);
    } finally {
      RULES.splice(i, 0, rule!);
    }
  });

  it("is stale for a dismissed item, an unknown run and an issue that is not on the board", async () => {
    const at = keep(admin, [offerOf("open-turn-item", "run", "run-ann-1"), offerOf("open-turn-item", "run", "run-gone"), offerOf("open-turn-item", "issue", "acme/app#99")]);
    const k = key()!;
    dismissTurn(started.ctx, k);
    try {
      expect(await click(admin, "admin", at, 0)).toEqual(STALE);
    } finally {
      restoreTurn(k);
    }
    expect(await click(admin, "admin", at, 0)).toMatchObject({ type: "open-turn-item" });
    expect(await click(admin, "admin", at, 1)).toEqual(STALE);
    expect(await click(admin, "admin", at, 2)).toEqual(STALE);
  });

  it("is not for a user: the type is not hers", async () => {
    expect(await click(ann, "user", keep(ann, [offerOf("open-turn-item", "run", "run-ann-1")]))).toEqual(DENIED);
  });
});

describe("the route", () => {
  async function call(who: TestSession | undefined, path: string, body?: string, type = "application/json") {
    const r = await fetch(base + path, { method: "POST", headers: { "content-type": type, ...(who ? who.headers("POST") : {}) }, ...(body !== undefined ? { body } : {}) });
    const text = await r.text();
    return { status: r.status, text, json: () => JSON.parse(text) as Record<string, unknown> };
  }
  const url = (id: string) => `/api/help/conversations/${id}/actions`;
  const send = (who: TestSession, at: { conversation: string; message: string }, offer = 0) => call(who, url(at.conversation), JSON.stringify({ message: at.message, offer }));
  const lines = () => readFileSync(auditPath(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { action: string; by: string; result?: string; target?: string; detail?: string });
  const mine = () => keep(ann, [offerOf("open-run", "run", "run-ann-1"), offerOf("open-run", "run", "run-gone"), offerOf("open-run", "run", "run-bob-1")]);

  it("answers {type, to} and writes the audit line; refusals are audited with their reason", async () => {
    const at = mine();
    const ok = await send(ann, at, 0);
    expect([ok.status, ok.json()]).toEqual([200, { type: "open-run", to: "#/runs/run-ann-1" }]);
    expect((await send(ann, at, 1)).json().error).toBe(OFFER_WORDS.stale);
    expect(lines().filter((l) => l.action === "help-action").map((l) => [l.result, l.detail, l.target])).toEqual([
      ["ok", "open-run", `conversation ${at.conversation}`],
      ["failed", "refused: stale", `conversation ${at.conversation}`],
    ]);
    await withRule(ruleNo("GET", ["runs", "run-ann-1"]), async () => {
      const r = await send(ann, at, 0);
      expect([r.status, r.json().error]).toEqual([403, OFFER_WORDS.denied]);
    });
    expect(lines().filter((l) => l.action === "help-action").at(-1)).toMatchObject({ result: "failed", detail: "refused: denied" });
  });

  it("is off with 503, and 403 for an account outside the audience", async () => {
    const at = mine();
    const help = started.ctx.config().help;
    help.enabled = false;
    try {
      expect((await send(ann, at)).status).toBe(503);
    } finally {
      help.enabled = true;
    }
    help.audience = "admins";
    try {
      const r = await send(ann, at);
      expect(r.status).toBe(403);
    } finally {
      delete help.audience;
    }
  });

  it("checks the conversation before the body: another account's, an unknown and a deleted one", async () => {
    const at = mine();
    const gone = keep(ann, []);
    deleteConversation(ann.user.id, gone.conversation);
    const unknown = "99999999-9999-4999-8999-999999999999";
    const bodies: [string | undefined, string][] = [["{not json", "application/json"], ["null", "application/json"], ["[]", "application/json"], ['"x"', "application/json"], ["hello", "text/plain"], [undefined, "application/json"]];
    for (const [body, type] of bodies) {
      expect((await call(bob, url(at.conversation), body, type)).status, `bob ${body}`).toBe(404);
      expect((await call(ann, url(unknown), body, type)).status, `unknown ${body}`).toBe(404);
      expect((await call(ann, url(gone.conversation), body, type)).status, `deleted ${body}`).toBe(410);
    }
    expect((await call(bob, url(at.conversation), JSON.stringify({ question: "Another question?" }))).status).toBe(404);
  });

  it("refuses a wrong body of its own conversation with 400", async () => {
    const at = mine();
    for (const body of [{ message: "x" }, { message: at.message, offer: 0, extra: 1 }, { message: at.message, offer: 3 }, {}]) {
      const r = await call(ann, url(at.conversation), JSON.stringify(body));
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect((await call(ann, url(at.conversation), "[]")).status).toBe(400);
    expect((await call(ann, url(at.conversation), "hello", "text/plain")).status).toBe(415);
  });

  it("works in archived, completed and pending conversations and stores nothing", async () => {
    const states = {
      archived: () => {
        const at = mine();
        archiveConversation(ann.user.id, at.conversation);
        return at;
      },
      completed: () => {
        const at = mine();
        completeConversation(ann.user.id, at.conversation);
        return at;
      },
      pending: () => {
        const at = mine();
        addQuestion(ann.user.id, { conversation: at.conversation, question: "And now?" });
        return at;
      },
    };
    for (const [name, make] of Object.entries(states)) {
      const at = make();
      const before = JSON.stringify(getConversation(ann.user.id, at.conversation));
      const r = await send(ann, at, 0);
      expect([name, r.status, r.json()]).toEqual([name, 200, { type: "open-run", to: "#/runs/run-ann-1" }]);
      expect(JSON.stringify(getConversation(ann.user.id, at.conversation)), name).toBe(before);
    }
  });

  it("audits the early refusals too: outside the audience, another account's and a deleted conversation", async () => {
    const at = mine();
    const gone = keep(ann, []);
    deleteConversation(ann.user.id, gone.conversation);
    const failed = () => lines().filter((l) => l.action === "help-action" && l.result === "failed").map((l) => [l.target, l.detail]);
    const before = failed().length;
    expect((await call(bob, url(at.conversation), "{not json")).status).toBe(404);
    expect((await call(ann, url(gone.conversation), "{not json")).status).toBe(410);
    const help = started.ctx.config().help;
    help.audience = "admins";
    try {
      expect((await send(ann, at)).status).toBe(403);
    } finally {
      delete help.audience;
    }
    expect(failed().slice(before)).toEqual([
      [`conversation ${at.conversation}`, "refused: stale"],
      [`conversation ${gone.conversation}`, "refused: stale"],
      [`conversation ${at.conversation}`, "refused: denied"],
    ]);
    // a wrong body is not a refusal of the offer
    expect((await call(ann, url(at.conversation), "[]")).status).toBe(400);
    expect(failed().length).toBe(before + 3);
  });

  it("is not available in a preview", async () => {
    const at = mine();
    const r = await call(admin, `${url(at.conversation)}?as=${ann.user.id}`, JSON.stringify({ message: at.message, offer: 0 }));
    expect(r.status).toBe(403);
  });
});
