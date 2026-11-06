import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { StoreError } from "../src/auth/store.js";
import { createUser, deleteUser, getUser, hashPassword, type User } from "../src/auth/users.js";
import {
  GUIDE_STEPS, MAX_ANSWERS_BYTES, ProgressError, clearProgress, parseProgressRequest, progressPath, readProgress, saveProgress,
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
