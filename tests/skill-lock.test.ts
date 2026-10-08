import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StoreError } from "../src/auth/store.js";
import { FACTORY_HOME } from "../src/flow/load.js";
import { homePaths, migrateDataHome, setFactoryHome } from "../src/home.js";
import { acquireLock, lockPath, releaseLock } from "../src/home-migrate.js";
import { addSkillPins, parseSkillKey, readSkillLock, removeSkillPin, SkillLockError, skillLockPath } from "../src/skills/lock.js";

const D1 = "sha256:" + "1".repeat(64);
const D2 = "sha256:" + "2".repeat(64);
const D3 = "sha256:" + "3".repeat(64);
const T1 = new Date("2026-01-01T00:00:00.000Z");
const T2 = new Date("2026-02-01T00:00:00.000Z");

let home: string;
let saved: { HOME?: string; FACTORY_HOME?: string; SCF_HOME?: string; binding: string };
beforeEach(() => {
  saved = { HOME: process.env.HOME, FACTORY_HOME: process.env.FACTORY_HOME, SCF_HOME: process.env.SCF_HOME, binding: FACTORY_HOME };
  home = realpathSync(mkdtempSync(join(tmpdir(), "skilllock-")));
  process.env.FACTORY_HOME = home;
});
afterEach(() => {
  for (const [k, v] of [["HOME", saved.HOME], ["FACTORY_HOME", saved.FACTORY_HOME], ["SCF_HOME", saved.SCF_HOME]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  setFactoryHome(saved.binding);
  rmSync(home, { recursive: true, force: true });
});

const file = () => skillLockPath(home);
const bytes = () => readFileSync(file());
const roundTrip = () => expect(readSkillLock(home).ok).toBe(true);
const pins = () => {
  const r = readSkillLock(home);
  if (!r.ok) throw new Error(r.reason);
  return r.pins;
};

describe("parseSkillKey", () => {
  it("accepts id@version", () => {
    expect(parseSkillKey("x@1.0.0")).toEqual({ id: "x", version: "1.0.0" });
    expect(parseSkillKey("x@1.0.0-rc.1")).toEqual({ id: "x", version: "1.0.0-rc.1" });
  });
  it("refuses anything else", () => {
    for (const k of ["x", "x@", "@1.0.0", "X@1.0.0", "x@1.0", "x@1.0.0@2.0.0", ""]) expect(parseSkillKey(k), k).toBeUndefined();
  });
});

describe("skill lock file", () => {
  it("reads a missing file as an empty lock", () => {
    expect(readSkillLock(home)).toEqual({ ok: true, pins: {} });
  });

  it("creates the file with mode 0600 and sorted keys, and merges", () => {
    addSkillPins([{ key: "b@1.0.0", digest: D1 }], { now: T1 });
    addSkillPins([{ key: "a@1.0.0", digest: D2 }], { now: T2 });
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    expect(Object.keys(JSON.parse(bytes().toString()).pins)).toEqual(["a@1.0.0", "b@1.0.0"]);
    expect(pins()["b@1.0.0"]).toEqual({ digest: D1, pinnedAt: T1.toISOString() });
    roundTrip();
  });

  it("reports the outcome of every key", () => {
    addSkillPins([{ key: "a@1.0.0", digest: D1 }, { key: "b@1.0.0", digest: D1 }], { now: T1 });
    const input = [{ key: "a@1.0.0", digest: D1 }, { key: "b@1.0.0", digest: D2 }, { key: "c@1.0.0", digest: D3 }];
    expect(addSkillPins(input, { now: T2 })).toEqual({ added: ["c@1.0.0"], unchanged: ["a@1.0.0"], kept: ["b@1.0.0"], replaced: [] });
    expect(pins()["b@1.0.0"]!.digest).toBe(D1);
    roundTrip();
    expect(addSkillPins(input.slice(0, 2), { replace: true, now: T2 })).toEqual({ added: [], unchanged: ["a@1.0.0"], kept: [], replaced: ["b@1.0.0"] });
    expect(pins()["a@1.0.0"]).toEqual({ digest: D1, pinnedAt: T1.toISOString() });
    expect(pins()["b@1.0.0"]).toEqual({ digest: D2, pinnedAt: T2.toISOString() });
    roundTrip();
  });

  it("does not rewrite an unchanged pin", () => {
    addSkillPins([{ key: "a@1.0.0", digest: D1 }], { now: T1 });
    const before = bytes();
    expect(addSkillPins([{ key: "a@1.0.0", digest: D1 }], { replace: true, now: T2 }).unchanged).toEqual(["a@1.0.0"]);
    expect(bytes()).toEqual(before);
  });

  it("returns an empty outcome for an empty list and creates no file", () => {
    expect(addSkillPins([])).toEqual({ added: [], unchanged: [], kept: [], replaced: [] });
    expect(existsSync(file())).toBe(false);
  });

  it("removes a pin once", () => {
    addSkillPins([{ key: "a@1.0.0", digest: D1 }, { key: "b@1.0.0", digest: D2 }]);
    expect(removeSkillPin("a@1.0.0")).toBe(true);
    expect(removeSkillPin("a@1.0.0")).toBe(false);
    expect(Object.keys(pins())).toEqual(["b@1.0.0"]);
    roundTrip();
  });
});

describe("bad input", () => {
  const bad: [string, () => unknown][] = [
    ["bad key", () => addSkillPins([{ key: "nope", digest: D1 }])],
    ["bad digest", () => addSkillPins([{ key: "a@1.0.0", digest: "sha256:zz" }])],
    ["same key twice", () => addSkillPins([{ key: "a@1.0.0", digest: D1 }, { key: "a@1.0.0", digest: D1 }])],
    ["remove garbage", () => removeSkillPin("garbage")],
  ];
  for (const [name, fn] of bad) {
    it(`${name}: bad-input before the read and the lock`, () => {
      expect(fn, name).toThrow(SkillLockError);
      expect(fn).toThrow(expect.objectContaining({ code: "bad-input" }));
      expect(existsSync(file())).toBe(false);
      writeFileSync(file(), "{not json");
      expect(fn).toThrow(expect.objectContaining({ code: "bad-input" }));
      expect(acquireLock(join(home, "auth.lock"))).toBe(true);
      try {
        expect(fn).toThrow(expect.objectContaining({ code: "bad-input" }));
      } finally {
        releaseLock(join(home, "auth.lock"));
      }
    });
  }
  it("leaves a good lock as it was", () => {
    addSkillPins([{ key: "a@1.0.0", digest: D1 }]);
    const before = bytes();
    for (const [, fn] of bad) expect(fn).toThrow(SkillLockError);
    expect(bytes()).toEqual(before);
  });
});

describe("unreadable locks", () => {
  const good = JSON.stringify({ version: 1, pins: { "a@1.0.0": { digest: D1, pinnedAt: "x" } } });
  const cases: [string, (f: string) => void][] = [
    ["invalid JSON", (f) => writeFileSync(f, "{")],
    ["wrong version", (f) => writeFileSync(f, JSON.stringify({ version: 2, pins: {} }))],
    ["bad digest", (f) => writeFileSync(f, good.replace(D1, "sha256:abc"))],
    ["unknown property", (f) => writeFileSync(f, JSON.stringify({ version: 1, pins: {}, extra: 1 }))],
    ["bad key", (f) => writeFileSync(f, good.replace("a@1.0.0", "nope"))],
    ["symlinked file", (f) => (writeFileSync(f + ".real", good), symlinkSync(f + ".real", f))],
    ["dangling symlink", (f) => symlinkSync(join(home, "nowhere"), f)],
    ["folder", (f) => mkdirSync(f)],
  ];
  for (const [name, make] of cases) {
    it(name, () => {
      make(file());
      const r = readSkillLock(home);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).not.toContain(home);
      const before = lstatSync(file()).isFile() ? bytes() : undefined;
      expect(() => addSkillPins([{ key: "b@1.0.0", digest: D2 }])).toThrow(expect.objectContaining({ code: "unreadable" }));
      expect(() => removeSkillPin("a@1.0.0")).toThrow(expect.objectContaining({ code: "unreadable" }));
      if (before) expect(bytes()).toEqual(before);
      expect(existsSync(file() + ".tmp")).toBe(false);
    });
  }
});

describe("hostile content", () => {
  it("never repeats a key from the file in the reason", () => {
    for (const key of ["/Users/alice/private", "a@1.0.0\nPROBLEM injected", "../../etc/passwd"]) {
      writeFileSync(file(), JSON.stringify({ version: 1, pins: { [key]: { digest: D1, pinnedAt: "x" } } }));
      const r = readSkillLock(home);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).not.toMatch(/alice|injected|passwd|\n/);
      }
    }
    writeFileSync(file(), JSON.stringify({ version: 1, pins: {}, "/Users/bob": 1 }));
    const r = readSkillLock(home);
    expect(!r.ok && r.reason).not.toContain("bob");
  });
});

describe("size", () => {
  it("accepts exactly maxBytes and refuses one byte less", () => {
    addSkillPins([{ key: "a@1.0.0", digest: D1 }], { now: T1 });
    const size = bytes().length;
    removeSkillPin("a@1.0.0");
    addSkillPins([{ key: "a@1.0.0", digest: D1 }], { now: T1, maxBytes: size });
    expect(bytes().length).toBe(size);
    removeSkillPin("a@1.0.0");
    const before = bytes();
    expect(() => addSkillPins([{ key: "a@1.0.0", digest: D1 }], { now: T1, maxBytes: size - 1 })).toThrow(expect.objectContaining({ code: "too-large" }));
    expect(bytes()).toEqual(before);
    expect(existsSync(file() + ".tmp")).toBe(false);
  });
  it("reads a file one byte over the limit as unreadable", () => {
    addSkillPins([{ key: "a@1.0.0", digest: D1 }]);
    const size = bytes().length;
    expect(readSkillLock(home, size).ok).toBe(true);
    expect(readSkillLock(home, size - 1).ok).toBe(false);
  });
});

describe("write problems", () => {
  it("fails on contention without touching the file", () => {
    addSkillPins([{ key: "a@1.0.0", digest: D1 }]);
    const before = bytes();
    expect(acquireLock(join(home, "auth.lock"))).toBe(true);
    try {
      expect(() => addSkillPins([{ key: "b@1.0.0", digest: D2 }], { waitMs: 100 })).toThrow(expect.objectContaining({ kind: "locked" }));
    } finally {
      releaseLock(join(home, "auth.lock"));
    }
    expect(bytes()).toEqual(before);
    expect(existsSync(file() + ".tmp")).toBe(false);
  });

  it("fails with cannot-write when the temp path is a non-empty folder", () => {
    addSkillPins([{ key: "a@1.0.0", digest: D1 }]);
    const before = bytes();
    mkdirSync(file() + ".tmp");
    writeFileSync(join(file() + ".tmp", "x"), "x");
    let err: unknown;
    try {
      addSkillPins([{ key: "b@1.0.0", digest: D2 }]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StoreError);
    expect(err).toMatchObject({ kind: "cannot-write" });
    expect(bytes()).toEqual(before);
    expect(existsSync(join(home, "auth.lock"))).toBe(false);
  });

  it("does not follow a symlinked temp file", () => {
    const outside = join(home, "..", `outside-${process.pid}.txt`);
    writeFileSync(outside, "keep");
    try {
      symlinkSync(outside, file() + ".tmp");
      addSkillPins([{ key: "a@1.0.0", digest: D1 }]);
      expect(readFileSync(outside, "utf8")).toBe("keep");
      expect(lstatSync(file()).isFile()).toBe(true);
      roundTrip();
    } finally {
      rmSync(outside, { force: true });
    }
  });
});

describe("the data-folder move", () => {
  let oldHome: string;
  let newHome: string;
  beforeEach(() => {
    process.env.HOME = home;
    delete process.env.FACTORY_HOME;
    delete process.env.SCF_HOME;
    ({ oldHome, newHome } = homePaths());
    mkdirSync(oldHome, { recursive: true });
    writeFileSync(join(oldHome, "config.yaml"), "concurrency: 2\n");
    setFactoryHome(oldHome);
  });

  it("refuses to pin after the move, and releases both locks", () => {
    mkdirSync(newHome);
    expect(() => addSkillPins([{ key: "a@1.0.0", digest: D1 }])).toThrow(StoreError);
    expect(() => addSkillPins([{ key: "a@1.0.0", digest: D1 }])).toThrow("moved to");
    expect(existsSync(join(oldHome, "skills.lock.json"))).toBe(false);
    expect(existsSync(join(oldHome, "auth.lock"))).toBe(false);
    expect(existsSync(lockPath(newHome))).toBe(false);
  });

  it("keeps the lock in a normal move", () => {
    addSkillPins([{ key: "a@1.0.0", digest: D1 }, { key: "b@1.0.0", digest: D2 }], { now: T1 });
    const before = readFileSync(join(oldHome, "skills.lock.json"));
    const r = migrateDataHome({ from: oldHome, to: newHome, env: {}, freeBytes: () => 1e15, sizeBytes: () => 1000, log: () => {} });
    expect(r.status).toBe("migrated");
    expect(readFileSync(join(newHome, "skills.lock.json"))).toEqual(before);
    expect(statSync(join(newHome, "skills.lock.json")).mode & 0o777).toBe(0o600);
    const read = readSkillLock(newHome);
    expect(read.ok && Object.values(read.pins).map((p) => p.digest)).toEqual([D1, D2]);
  });
});
