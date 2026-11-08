import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { StoreError, withAuthLock } from "../src/auth/store.js";
import { createUser, deleteUser, getUser, hashPassword, type User } from "../src/auth/users.js";
import {
  GUIDE_STEPS, MAX_ANSWERS_BYTES, ProgressError, beginGuideProject, clearProgress, parseProgressRequest, progressPath, readProgress, recordCreatingLocked, recordGuideProject, saveProgress,
} from "../src/onboarding/progress-store.js";
import { deleteProgress, getProgress, putProgress } from "../src/server/api-onboarding.js";
import { HttpError } from "../src/server/http.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";

const PW = "test-password-12345";
let home: string;
let saved: string | undefined;
let kc: FakeKeychain;
let admin: User;
let ann: User;
let bob: User;

const thrown = (fn: () => unknown): any => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
};
const nest = (n: number): unknown => (n <= 0 ? 1 : { a: nest(n - 1) });

beforeAll(async () => void (await hashPassword(PW)));
beforeEach(async () => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "progress-"));
  process.env.FACTORY_HOME = home;
  kc = fakeKeychain();
  admin = await createUser({ name: "Root", email: "root@example.com", password: PW, role: "admin" });
  ann = await createUser({ name: "Ann", email: "ann@example.com", password: PW });
  bob = await createUser({ name: "Bob", email: "bob@example.com", password: PW });
});
afterEach(() => {
  kc.remove();
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

describe("progress store", () => {
  it("has no progress without a file and creates none", () => {
    expect(readProgress(ann.id)).toBeNull();
    expect(clearProgress(ann.id)).toBe(false);
    expect(existsSync(progressPath())).toBe(false);
  });

  it("round-trips, keeps accounts apart, replaces an entry and writes mode 0600", () => {
    const at = new Date("2026-01-02T03:04:05.000Z");
    saveProgress(ann.id, { step: "agents", answers: { agents: { have: "both" } } }, at);
    saveProgress(bob.id, { step: "computer", answers: {} }, at);
    expect(readProgress(ann.id)).toEqual({ step: "agents", answers: { agents: { have: "both" } }, at: at.toISOString() });
    expect(readProgress(bob.id)?.step).toBe("computer");
    expect(statSync(progressPath()).mode & 0o777).toBe(0o600);
    saveProgress(ann.id, { step: "welcome", answers: {} }, at);
    expect(readProgress(ann.id)).toEqual({ step: "welcome", answers: {}, at: at.toISOString() });
  });

  it("clears only one account, and writes nothing when there is no entry", () => {
    saveProgress(ann.id, { step: "computer", answers: {} });
    saveProgress(bob.id, { step: "agents", answers: {} });
    expect(clearProgress(ann.id)).toBe(true);
    expect(readProgress(ann.id)).toBeNull();
    expect(readProgress(bob.id)?.step).toBe("agents");
    const before = readFileSync(progressPath(), "utf8");
    expect(clearProgress(ann.id)).toBe(false);
    expect(readFileSync(progressPath(), "utf8")).toBe(before);
  });

  it("reads a stored step it does not know", () => {
    writeFileSync(progressPath(), JSON.stringify({ version: 1, users: { [ann.id]: { step: "pick-idea", answers: {}, at: new Date().toISOString() } } }));
    expect(readProgress(ann.id)?.step).toBe("pick-idea");
  });

  it("does not save for an account that does not exist (a late save after a delete)", () => {
    const e = thrown(() => saveProgress(randomUUID(), { step: "welcome", answers: {} }));
    expect(e).toBeInstanceOf(ProgressError);
    expect(e.code).toBe("gone");
    expect(existsSync(progressPath())).toBe(false);
  });

  it.each([
    ["not JSON", "{nope secret-value"],
    ["wrong format", JSON.stringify({ version: 2, users: {}, note: "secret-value" })],
    ["unknown top-level key", JSON.stringify({ version: 1, users: {}, extra: "secret-value" })],
  ])("a broken file (%s) stops read, save and clear with a StoreError that holds no file value", (_n, text) => {
    writeFileSync(progressPath(), text);
    for (const fn of [() => readProgress(ann.id), () => saveProgress(ann.id, { step: "welcome", answers: {} }), () => clearProgress(ann.id)]) {
      const e = thrown(fn);
      expect(e).toBeInstanceOf(StoreError);
      expect(["not-json", "wrong-format"]).toContain(e.kind);
      expect(e.message).not.toContain("secret-value");
    }
  });

  it("refuses a stored entry that breaks the limits", () => {
    const entry = (answers: unknown) => JSON.stringify({ version: 1, users: { [ann.id]: { step: "welcome", answers, at: new Date().toISOString() } } });
    writeFileSync(progressPath(), entry({ a: nest(20) }));
    expect(thrown(() => readProgress(ann.id))).toBeInstanceOf(StoreError);
    writeFileSync(progressPath(), entry({ Bad: 1 }));
    expect(thrown(() => readProgress(ann.id))).toBeInstanceOf(StoreError);
    writeFileSync(progressPath(), entry({ a: "x".repeat(MAX_ANSWERS_BYTES) }));
    expect(thrown(() => readProgress(ann.id))).toBeInstanceOf(StoreError);
  });
});

describe("parseProgressRequest", () => {
  const code = (body: unknown) => (thrown(() => parseProgressRequest(body)) as ProgressError | undefined)?.code;

  it("accepts every guide step and defaults answers to {}", () => {
    for (const step of GUIDE_STEPS) expect(parseProgressRequest({ step })).toEqual({ step, answers: {} });
  });

  it("answers bad for the wrong shapes", () => {
    for (const body of [null, "x", 1, [], { step: "welcome", extra: 1 }, {}, { step: "nope" }, { step: 1 }, { step: "welcome", answers: [] }, { step: "welcome", answers: null }, { step: "welcome", answers: "x" }]) {
      expect(code(body)).toBe("bad");
    }
  });

  it("answers bad for keys that are not allowed and too many keys", () => {
    for (const key of ["A", "__proto__", "1a", "a".repeat(41), "a_b"]) {
      expect(code({ step: "welcome", answers: JSON.parse(`{${JSON.stringify(key)}: 1}`) })).toBe("bad");
    }
    const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]));
    expect(code({ step: "welcome", answers: many(20) })).toBeUndefined();
    expect(code({ step: "welcome", answers: many(21) })).toBe("bad");
  });

  it("limits the depth, also for very deep values, without a stack error", () => {
    expect(code({ step: "welcome", answers: { a: nest(6) } })).toBeUndefined();
    expect(code({ step: "welcome", answers: { a: nest(8) } })).toBe("bad");
    expect(code({ step: "welcome", answers: JSON.parse(`{"a":${"[".repeat(8000)}${"]".repeat(8000)}}`) })).toBe("bad");
  });

  it("limits the size: exactly the maximum is fine, one byte more is too large", () => {
    const withBytes = (n: number) => {
      const overhead = Buffer.byteLength(JSON.stringify({ a: "" }));
      return { a: "x".repeat(n - overhead) };
    };
    expect(Buffer.byteLength(JSON.stringify(withBytes(MAX_ANSWERS_BYTES)))).toBe(MAX_ANSWERS_BYTES);
    expect(code({ step: "welcome", answers: withBytes(MAX_ANSWERS_BYTES) })).toBeUndefined();
    expect(code({ step: "welcome", answers: withBytes(MAX_ANSWERS_BYTES + 1) })).toBe("too-large");
  });

  it("names a field in the message, never a value", () => {
    const e = thrown(() => parseProgressRequest({ step: "welcome", answers: { Secret: "hunter2" } }));
    expect(e.message).not.toContain("hunter2");
  });
});

describe("progress routes", () => {
  const status = (fn: () => unknown) => (thrown(fn) as HttpError).status;

  it("get with nothing saved, put, get, delete (twice)", () => {
    expect(getProgress(ann.id)).toEqual({ step: null, answers: {} });
    const put = putProgress(ann.id, { step: "agents", answers: { agents: { have: "claude" } } });
    expect(put).toMatchObject({ step: "agents", answers: { agents: { have: "claude" } } });
    expect(getProgress(ann.id).step).toBe("agents");
    expect(getProgress(bob.id)).toEqual({ step: null, answers: {} });
    expect(deleteProgress(ann.id)).toEqual({ step: null, answers: {} });
    expect(deleteProgress(ann.id)).toEqual({ step: null, answers: {} });
    expect(getProgress(ann.id).step).toBeNull();
    expect(putProgress(admin.id, { step: "welcome" }).step).toBe("welcome");
  });

  it("maps bad bodies to 400, too-large answers to 413 and a deleted account to 404", () => {
    expect(status(() => putProgress(ann.id, {}))).toBe(400);
    expect(status(() => putProgress(ann.id, { step: "welcome", answers: { a: nest(30) } }))).toBe(400);
    expect(status(() => putProgress(ann.id, { step: "welcome", answers: { a: "x".repeat(MAX_ANSWERS_BYTES) } }))).toBe(413);
    expect(status(() => putProgress(randomUUID(), { step: "welcome" }))).toBe(404);
  });

  it("maps a broken file to 500 without the path or the contents", () => {
    writeFileSync(progressPath(), "secret-value {");
    for (const fn of [() => getProgress(ann.id), () => putProgress(ann.id, { step: "welcome" }), () => deleteProgress(ann.id)]) {
      const e = thrown(fn) as HttpError;
      expect(e.status).toBe(500);
      expect(e.message).toContain("not-json");
      expect(e.message).not.toContain("secret-value");
      expect(e.message).not.toContain(home);
    }
  });
});

describe("guide answers", () => {
  const ok = (answers: any) => parseProgressRequest({ step: "step-4", answers });
  const bad = (answers: any) => {
    const e = thrown(() => ok(answers)) as ProgressError;
    expect(e).toBeInstanceOf(ProgressError);
    expect(e.code).toBe("bad");
    return e.message;
  };

  it("accepts a full valid set", () => {
    expect(() => ok({ starter: "website", about: { who: "me", what: "a\nb\tc" }, name: "!!!", style: "blue", where: "local", repoId: randomUUID(), making: randomUUID(), agents: { have: "both" } })).not.toThrow();
  });

  it("allows each limit exactly and refuses one more, without the value in the message", () => {
    const cases: [string, (n: number) => any, number][] = [
      ["who", (n) => ({ about: { who: "x".repeat(n) } }), 200],
      ["what", (n) => ({ about: { what: "y".repeat(n) } }), 2000],
      ["style", (n) => ({ style: "z".repeat(n) }), 200],
      ["name", (n) => ({ name: "q".repeat(n) }), 100],
    ];
    for (const [field, make, max] of cases) {
      expect(() => ok(make(max))).not.toThrow();
      const m = bad(make(max + 1));
      expect(m).toContain(field);
      expect(m).not.toMatch(/[xyzq]{5}/);
    }
  });

  it("refuses control characters (new lines only in what)", () => {
    expect(bad({ about: { what: "a\u0007" } })).toContain("what");
    expect(bad({ about: { who: "a\nb" } })).toContain("who");
    expect(bad({ name: "a\u0001" })).toContain("name");
    expect(bad({ style: "a\tb" })).toContain("style");
  });

  it("refuses other shapes with a message that names the field only", () => {
    expect(bad({ where: "ftp" })).toContain("where");
    expect(bad({ repoId: "x" })).toContain("repoId");
    expect(bad({ making: "x" })).toContain("making");
    expect(bad({ starter: "Bad_ID" })).toContain("starter");
    expect(bad({ about: { extra: "secret-text" } })).not.toContain("secret-text");
    expect(bad({ about: "x" })).toContain("about");
  });

  it("a PUT keeps the repoId and making that are stored, and ignores the ones it sends", () => {
    const id = randomUUID();
    const token = randomUUID();
    saveProgress(ann.id, { step: "step-5", answers: { name: "a" } });
    expect(saveProgress(ann.id, { step: "step-5", answers: { repoId: id, making: token } }).answers).toEqual({});
    const m = beginGuideProject(ann.id, () => false) as { token: string };
    recordGuideProject(ann.id, m.token, id);
    const after = saveProgress(ann.id, { step: "step-5", answers: { name: "b", repoId: randomUUID() } });
    expect(after.answers).toEqual({ name: "b", repoId: id });
    // after Start again a stale PUT cannot bring the old id back
    clearProgress(ann.id);
    expect(saveProgress(ann.id, { step: "step-5", answers: { repoId: id } }).answers).toEqual({});
  });
});

describe("beginGuideProject and recordGuideProject", () => {
  it("starts at step 5 with a token when there is no entry", () => {
    const b = beginGuideProject(ann.id, () => false) as { token: string };
    const p = readProgress(ann.id)!;
    expect(p.step).toBe("step-5");
    expect(p.answers).toEqual({ making: b.token });
  });

  it("returns the id of a repository that exists and writes nothing", () => {
    const id = randomUUID();
    const b = beginGuideProject(ann.id, () => false) as { token: string };
    recordGuideProject(ann.id, b.token, id);
    const before = readFileSync(progressPath(), "utf8");
    expect(beginGuideProject(ann.id, (x) => x === id)).toEqual({ existing: id });
    expect(readFileSync(progressPath(), "utf8")).toBe(before);
    // the repository is gone: the id is dropped and there is a new token
    const again = beginGuideProject(ann.id, () => false) as { token: string };
    expect(readProgress(ann.id)!.answers).toEqual({ making: again.token });
  });

  it("records only for the token that is stored, and never after Start again", () => {
    const id = randomUUID();
    const b = beginGuideProject(ann.id, () => false) as { token: string };
    expect((thrown(() => recordGuideProject(ann.id, randomUUID(), id)) as ProgressError).code).toBe("stale");
    recordGuideProject(ann.id, b.token, id);
    expect(readProgress(ann.id)!.answers).toEqual({ repoId: id });
    const c = beginGuideProject(ann.id, () => false) as { token: string };
    clearProgress(ann.id);
    const before = existsSync(progressPath()) ? readFileSync(progressPath(), "utf8") : "";
    expect((thrown(() => recordGuideProject(ann.id, c.token, id)) as ProgressError).code).toBe("stale");
    expect(existsSync(progressPath()) ? readFileSync(progressPath(), "utf8") : "").toBe(before);
  });

  it("records the creating id only inside the lock and only with the current token; the server keeps it", () => {
    const id = randomUUID();
    const b = beginGuideProject(ann.id, () => false) as { token: string };
    expect(() => recordCreatingLocked(ann.id, b.token, id)).toThrow("inside withAuthLock");
    expect((thrown(() => withAuthLock(() => recordCreatingLocked(ann.id, randomUUID(), id))) as ProgressError).code).toBe("stale");
    withAuthLock(() => recordCreatingLocked(ann.id, b.token, id));
    expect(readProgress(ann.id)!.answers).toEqual({ making: b.token, creating: id });
    // a PUT can neither set nor remove it
    expect(saveProgress(ann.id, { step: "step-5", answers: { creating: randomUUID() } }).answers).toEqual({ making: b.token, creating: id });
    saveProgress(ann.id, { step: "step-5", answers: {} });
    expect(readProgress(ann.id)!.answers).toEqual({ making: b.token, creating: id });
    // the made project clears it
    recordGuideProject(ann.id, b.token, randomUUID());
    expect(readProgress(ann.id)!.answers).not.toHaveProperty("creating");
  });

  it("refuses a full entry before anything is written, and keeps other accounts readable", () => {
    const answers: Record<string, string> = {};
    for (let i = 0; i < 20; i++) answers[`k${i}`] = "x";
    saveProgress(ann.id, { step: "step-5", answers });
    saveProgress(bob.id, { step: "agents", answers: {} });
    const before = readFileSync(progressPath(), "utf8");
    expect((thrown(() => beginGuideProject(ann.id, () => false)) as ProgressError).code).toBe("bad");
    expect(readFileSync(progressPath(), "utf8")).toBe(before);
    expect(readProgress(bob.id)?.step).toBe("agents");
  });

  it("is gone for an account that does not exist, and a retry after a restart finds the project", () => {
    expect((thrown(() => beginGuideProject(randomUUID(), () => false)) as ProgressError).code).toBe("gone");
    const id = randomUUID();
    const b = beginGuideProject(ann.id, () => false) as { token: string };
    recordGuideProject(ann.id, b.token, id);
    // nothing is kept in memory: a new begin reads the file
    expect(beginGuideProject(ann.id, (x) => x === id)).toEqual({ existing: id });
  });
});

describe("deleteUser", () => {
  it("removes the progress of that account and leaves the others", async () => {
    saveProgress(ann.id, { step: "computer", answers: {} });
    saveProgress(bob.id, { step: "agents", answers: {} });
    deleteUser(ann.id);
    expect(readProgress(ann.id)).toBeNull();
    expect(readProgress(bob.id)?.step).toBe("agents");
  });

  it("is stopped by a broken progress file, and the account stays", () => {
    writeFileSync(progressPath(), "not json");
    expect(thrown(() => deleteUser(ann.id))).toBeInstanceOf(StoreError);
    expect(getUser(ann.id)).toBeTruthy();
  });
});
