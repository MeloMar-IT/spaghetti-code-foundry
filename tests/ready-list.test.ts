import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RepoError, addRepo, findOwnedRepo, getRepo, listAllRepos, listRepos, ownsRepo, removeRepo, reposPath, setRepoAuth, setRepoConnection, setRepoReady, setRepoSettings, transferRepo } from "../src/auth/repos.js";
import { DEFAULT_READY, READY_RULES, ReadyListSchema, checkReadyList, readyListOf } from "../src/refinement/ready-list.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";

const ANN = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const OK = { ownerOk: () => true };
const TOKEN = ["github", "pat", ""].join("_") + "Zx9".repeat(12);
let home: string;
let saved: string | undefined;
let kc: FakeKeychain;

beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "ready-list-"));
  process.env.FACTORY_HOME = home;
  kc = fakeKeychain();
});
afterEach(() => {
  kc.remove();
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const D = DEFAULT_READY.map((i) => ({ ...i }));
const check = (input: unknown, current = readyListOf(undefined)) => checkReadyList(input, current);
const fails = (input: unknown, sentence: string, current = readyListOf(undefined)) => {
  try {
    checkReadyList(input, current);
  } catch (e) {
    expect(e).toBeInstanceOf(RepoError);
    expect((e as RepoError).code).toBe("bad-ready");
    expect((e as RepoError).message).toBe(sentence);
    return;
  }
  throw new Error("did not throw");
};
const withItems = (...items: unknown[]) => ({ items });

describe("the default list", () => {
  it("has seven items in order, id equals rule, and fits the schema", () => {
    expect(DEFAULT_READY.map((i) => i.rule)).toEqual([...READY_RULES]);
    expect(DEFAULT_READY.map((i) => i.id)).toEqual([...READY_RULES]);
    expect(DEFAULT_READY.map((i) => i.text)).toEqual([
      "the value is clear (who and why)",
      "it stands on its own or its dependencies are named",
      "every acceptance criterion can be checked",
      "it is small enough to build in one go",
      "there are no open questions",
      "it says what is out of scope",
      "it contains no implementation plan",
    ]);
    expect(ReadyListSchema.safeParse(DEFAULT_READY).success).toBe(true);
  });

  it("readyListOf gives the default as a copy", () => {
    const l = readyListOf(undefined);
    expect(l).toEqual(DEFAULT_READY);
    l[0]!.text = "changed";
    l.pop();
    expect(DEFAULT_READY[0]!.text).toBe("the value is clear (who and why)");
    expect(DEFAULT_READY).toHaveLength(7);
    expect(readyListOf([{ id: "c-1", text: "x" }])).toEqual([{ id: "c-1", text: "x" }]);
  });
});

describe("checkReadyList: changes", () => {
  it("adds an item without an id: a c- id and no rule", () => {
    const l = check(withItems(...D.map(({ id, text }) => ({ id, text })), { text: "new one" }))!;
    expect(l).toHaveLength(8);
    expect(l[7]!.text).toBe("new one");
    expect(l[7]!.id).toMatch(/^c-[0-9a-f]{8}$/);
    expect(l[7]).not.toHaveProperty("rule");
  });

  it("removes a left-out item", () => {
    const l = check(withItems(...D.slice(1).map(({ id, text }) => ({ id, text }))))!;
    expect(l.map((i) => i.id)).toEqual(READY_RULES.slice(1));
  });

  it("rewords a default id (keeps its rule) and a custom id (keeps its id)", () => {
    const current = [{ id: "c-abc", text: "custom" }, ...D];
    const l = check(withItems({ id: "no-plan", text: "no plan please" }, { id: "c-abc", text: "custom 2" }), current)!;
    expect(l).toEqual([{ id: "no-plan", text: "no plan please", rule: "no-plan" }, { id: "c-abc", text: "custom 2" }]);
  });

  it("keeps the order as sent, trims, and ignores a sent rule", () => {
    const l = check(withItems({ id: "small", text: " small " }, { id: "value", text: "v", rule: "value" }, { text: " x ", rule: "no-plan" }))!;
    expect(l.map((i) => i.text)).toEqual(["small", "v", "x"]);
    expect(l.map((i) => i.rule)).toEqual(["small", "value", undefined]);
  });

  it("accepts the answer of the GET sent back", () => {
    const l = check(withItems(...D, { id: "c-1", text: "custom" }), [...D, { id: "c-1", text: "custom" }])!;
    expect(l).toHaveLength(8);
  });

  it("returns undefined for the default, for null, and not for a reworded default", () => {
    expect(check(withItems(...D))).toBeUndefined();
    expect(check({ items: null })).toBeUndefined();
    expect(check(withItems(...D.map((i, n) => (n === 0 ? { ...i, text: "other" } : i))))).toBeDefined();
    expect(check(withItems(...D.slice().reverse()))).toBeDefined();
  });

  it("brings a removed default item back by its id, keeping the custom items", () => {
    const current = [{ id: "c-1", text: "custom" }, ...D.filter((i) => i.id !== "no-plan")];
    const l = check(withItems({ id: "c-1", text: "custom" }, { id: "no-plan", text: "back" }), current)!;
    expect(l).toEqual([{ id: "c-1", text: "custom" }, { id: "no-plan", text: "back", rule: "no-plan" }]);
  });
});

describe("checkReadyList: limits", () => {
  it("refuses a bad body", () => {
    fails(null, 'the body must be an object with "items"');
    fails([], 'the body must be an object with "items"');
    fails({ items: null, more: 1 }, 'the body must be an object with "items"');
    fails({ items: "x" }, '"items" must be a list, or null for the default');
  });

  it("refuses 0 and 21 items", () => {
    fails(withItems(), "the list needs at least 1 item");
    fails(withItems(...Array.from({ length: 21 }, (_, i) => ({ text: `t${i}` }))), "the list may have at most 20 items");
    expect(check(withItems(...Array.from({ length: 20 }, (_, i) => ({ text: `t${i}` }))))).toHaveLength(20);
  });

  it("refuses a bad entry", () => {
    fails(withItems("x"), "every item must be an object with a text");
    fails(withItems({ text: "a", extra: 1 }), "an item may only have an id and a text");
    fails(withItems({ text: 5 }), "the text of an item must be text");
    fails(withItems({}), "the text of an item must be text");
    fails(withItems({ text: "" }), "an item may not be empty");
    fails(withItems({ text: "   " }), "an item may not be empty");
  });

  it("counts 200 characters as the limit, in code points", () => {
    expect(check(withItems({ text: "a".repeat(200) }))).toHaveLength(1);
    expect(check(withItems({ text: "😀".repeat(200) }))).toHaveLength(1);
    fails(withItems({ text: "a".repeat(201) }), "an item may be at most 200 characters");
    fails(withItems({ text: "😀".repeat(201) }), "an item may be at most 200 characters");
  });

  it("refuses control characters and line separators", () => {
    const s = "an item must be one line without control characters";
    for (const c of ["\n", "\t", "\u0085", " ", " ", "\u0000", "\u007f"]) {
      fails(withItems({ text: `a${c}b` }), s);
      fails(withItems({ text: `a${c}` }), s);
      fails(withItems({ text: `${c}a` }), s);
    }
  });

  it("refuses the same text twice, in another case", () => {
    fails(withItems({ text: "Same" }, { text: "same" }), "two items have the same text");
  });

  it("refuses an unknown, a repeated and a non-text id (null too)", () => {
    fails(withItems({ id: "nope", text: "a" }), 'unknown item id "nope"');
    fails(withItems({ id: "x\ny".padEnd(60, "z"), text: "a" }), `unknown item id "x?y${"z".repeat(37)}"`);
    fails(withItems({ id: "value", text: "a" }, { id: "value", text: "b" }), 'the item id "value" is given twice');
    fails(withItems({ id: 5, text: "a" }), "the id of an item must be text");
    fails(withItems({ id: null, text: "a" }), "the id of an item must be text");
  });
});

describe("ReadyListSchema", () => {
  it("refuses a rule on a custom id, a default id without a rule, a repeated id and an extra key", () => {
    const bad = (l: unknown) => expect(ReadyListSchema.safeParse(l).success).toBe(false);
    bad([{ id: "c-1", text: "a", rule: "value" }]);
    bad([{ id: "value", text: "a" }]);
    bad([{ id: "value", text: "a", rule: "small" }]);
    bad([{ id: "c-1", text: "a" }, { id: "c-1", text: "b" }]);
    bad([{ id: "c-1", text: "a", extra: 1 }]);
    bad([{ id: "c-1", text: "a" }, { id: "c-2", text: "A" }]);
    bad([]);
    bad([{ id: "c-1", text: " a" }]);
    expect(ReadyListSchema.safeParse([{ id: "c-1", text: "a" }]).success).toBe(true);
  });
});

describe("the store", () => {
  const add = (user: string, url: string, extra: object = {}) => addRepo(user, { url, ...extra }, OK);
  const raw = () => readFileSync(reposPath(), "utf8");
  const file = () => JSON.parse(raw()) as { version: number; repos: Record<string, unknown>[] };
  const LIST = withItems({ text: "custom" }, { id: "value", text: "why" });
  const STORED = [{ id: expect.stringMatching(/^c-/), text: "custom" },{ id: "value", text: "why", rule: "value" }];

  it("stores a changed list; only the admin reads have it", () => {
    const r = add(ANN, "acme/app");
    const out = setRepoReady(r.id, LIST);
    expect(out.changed).toBe(true);
    expect(out.repo.definitionOfReady).toEqual(STORED);
    expect(getRepo(r.id)!.definitionOfReady).toEqual(STORED);
    expect(listAllRepos()[0]!.definitionOfReady).toEqual(STORED);
    expect(listRepos(ANN)[0]).not.toHaveProperty("definitionOfReady");
    expect(add(ANN, "acme/two")).not.toHaveProperty("definitionOfReady");
  });

  it("the default removes the key; a repeat changes and writes nothing", async () => {
    const r = add(ANN, "acme/app");
    setRepoReady(r.id, LIST);
    const back = setRepoReady(r.id, { items: null });
    expect(back.changed).toBe(true);
    expect(file().repos[0]).not.toHaveProperty("definitionOfReady");
    const before = statSync(reposPath()).mtimeMs;
    await new Promise((res) => setTimeout(res, 20));
    expect(setRepoReady(r.id, withItems(...D)).changed).toBe(false);
    expect(statSync(reposPath()).mtimeMs).toBe(before);
  });

  it("an unknown id is not-found, also with a bad body", () => {
    for (const body of [LIST, "bad"]) {
      try {
        setRepoReady("00000000-0000-4000-8000-000000000000", body);
        throw new Error("did not throw");
      } catch (e) {
        expect((e as RepoError).code).toBe("not-found");
      }
    }
  });

  it("is kept by a change of authentication and by settings", () => {
    const r = add(ANN, "acme/app", { method: "github-token", token: TOKEN });
    setRepoReady(r.id, LIST);
    setRepoAuth(ANN, r.id, { token: TOKEN.replace(/Zx9/g, "Qq7") }, OK);
    expect(getRepo(r.id)!.definitionOfReady).toEqual(STORED);
    setRepoAuth(ANN, r.id, { method: "none" }, OK);
    expect(getRepo(r.id)!.definitionOfReady).toEqual(STORED);
    setRepoSettings(r.id, { mainBranch: "main" });
    expect(getRepo(r.id)!.definitionOfReady).toEqual(STORED);
    setRepoSettings(r.id, {});
    expect(getRepo(r.id)!.definitionOfReady).toEqual(STORED);
  });

  it("setRepoConnection saves after the list changed, and keeps the list", () => {
    const r = add(ANN, "acme/app");
    const rec = getRepo(r.id)!;
    setRepoReady(r.id, LIST);
    const result = { at: new Date().toISOString(), ok: true, checks: [{ check: "clone", ok: true, code: "ok", message: "The repository can be read." }] };
    expect(setRepoConnection(rec, result as never)).toBe("saved");
    expect(getRepo(r.id)!.definitionOfReady).toEqual(STORED);
  });

  it("is kept by a transfer and removed with the repository", () => {
    const r = add(ANN, "acme/app");
    setRepoReady(r.id, LIST);
    const t = transferRepo(r.id, "bob@example.com", { findOwner: () => ({ id: BOB, status: "active" }) });
    expect(t.repo.definitionOfReady).toEqual(STORED);
    expect(getRepo(r.id)!.definitionOfReady).toEqual(STORED);
    removeRepo(BOB, r.id);
    expect(listAllRepos()).toEqual([]);
  });

  it("loads a file without the field and adds no key; a version 1 file loads", () => {
    add(ANN, "acme/app");
    expect(file().repos[0]).not.toHaveProperty("definitionOfReady");
    setRepoSettings(listAllRepos()[0]!.id, {});
    expect(file().repos[0]).not.toHaveProperty("definitionOfReady");
    writeFileSync(reposPath(), JSON.stringify({ version: 1, repos: { [ANN]: ["acme/old"] } }));
    expect(listRepos(ANN)).toHaveLength(1);
  });

  it("refuses a hand-written file with a bad list", () => {
    const r = add(ANN, "acme/app");
    const f = file();
    f.repos[0]!.definitionOfReady = [{ id: "c-1", text: "a", rule: "value" }];
    writeFileSync(reposPath(), JSON.stringify(f));
    expect(() => getRepo(r.id)).toThrow();
  });

  it("findOwnedRepo finds by name, with .git and for ssh; ownsRepo is as before", () => {
    const a = add(ANN, "https://github.com/Acme/App.git");
    const s = add(ANN, "git@github.com:acme/ssh.git");
    add(ANN, "https://git.example.com/a/b");
    expect(findOwnedRepo(ANN, "acme/app")!.id).toBe(a.id);
    expect(findOwnedRepo(ANN, "Acme/App.git")!.id).toBe(a.id);
    expect(findOwnedRepo(ANN, "acme/ssh")!.id).toBe(s.id);
    expect(findOwnedRepo(BOB, "acme/app")).toBeUndefined();
    expect(findOwnedRepo(ANN, "a/b")).toBeUndefined();
    expect(ownsRepo(ANN, "acme/app")).toBe(true);
    expect(ownsRepo(BOB, "acme/app")).toBe(false);
    setRepoReady(a.id, LIST);
    expect(findOwnedRepo(ANN, "acme/app")!.definitionOfReady).toEqual(STORED);
  });
});
