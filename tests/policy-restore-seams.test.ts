// Wraps some built-ins so a test can fail one call. Everything else is real.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Fail = { fn: string; match: RegExp; code: string };
const probe = vi.hoisted(() => ({ fails: [] as Fail[] }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  // fails the first call of `name` whose argument at `pathAt` matches an armed fault, once
  const wrap = <F extends (...a: never[]) => unknown>(name: string, fn: F, pathAt: number): F =>
    ((...args: unknown[]) => {
      const f = probe.fails.find((x) => x.fn === name && x.match.test(String(args[pathAt])));
      if (f) {
        probe.fails.splice(probe.fails.indexOf(f), 1);
        throw Object.assign(new Error(f.code), { code: f.code });
      }
      return (fn as (...a: unknown[]) => unknown)(...args);
    }) as F;
  const patched = {
    ...actual,
    openSync: wrap("openSync", actual.openSync, 0),
    copyFileSync: wrap("copyFileSync", actual.copyFileSync, 0),
    renameSync: wrap("renameSync", actual.renameSync, 1),
    rmSync: wrap("rmSync", actual.rmSync, 0),
  };
  return { ...patched, default: patched };
});

const { parsePolicyPack } = await import("../src/policy/parse.js");
const { auditPath } = await import("../src/auth/audit.js");
const { restorePolicy, saveLastKnownGood } = await import("../src/engine/policy-store.js");
const { coverPack, writePack } = await import("./fixtures/policy-pack.js");

let home: string;
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "policy-seams-"));
  process.env.FACTORY_HOME = home;
  probe.fails = [];
  writePack(home, "org", coverPack("org"));
  saveLastKnownGood(home, "org", coverPack("org"), () => {});
  writeFileSync(join(home, "policies", "org.json"), "{ nope");
});
afterEach(() => {
  probe.fails = [];
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const audit = () => (existsSync(auditPath()) ? readFileSync(auditPath(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : []);
const left = () => readdirSync(join(home, "policies")).filter((n) => n.endsWith(".tmp") || n.includes(".replaced-"));
const NOT_REPLACED = { ok: false, reason: "policies/org.json could not be replaced; nothing was restored" };
const RENAME: Fail = { fn: "renameSync", match: /policies\/org\.json$/, code: "EIO" };

function nothingChanged() {
  expect(readFileSync(join(home, "policies", "org.json"), "utf8")).toBe("{ nope");
  expect(left()).toEqual([]);
  expect(audit().filter((l) => l.result === "ok")).toEqual([]);
  expect(audit().filter((l) => l.result === "failed")).toHaveLength(1);
}

describe("restorePolicy under faults", () => {
  it("the temp write fails", () => {
    probe.fails = [{ fn: "openSync", match: /\.org\.json\.[0-9a-f]+\.tmp$/, code: "EIO" }];
    expect(restorePolicy("org")).toEqual(NOT_REPLACED);
    nothingChanged();
  });

  it("the backup fails", () => {
    probe.fails = [{ fn: "copyFileSync", match: /org\.json$/, code: "EIO" }];
    expect(restorePolicy("org")).toEqual(NOT_REPLACED);
    nothingChanged();
  });

  it("the rename fails and the backup of this call is removed", () => {
    probe.fails = [RENAME];
    expect(restorePolicy("org")).toEqual(NOT_REPLACED);
    nothingChanged();
  });

  it("a failing cleanup does not throw, and the lock is free afterwards", () => {
    probe.fails = [RENAME, { fn: "rmSync", match: /\.tmp$/, code: "EACCES" }];
    expect(restorePolicy("org")).toEqual(NOT_REPLACED);
    expect(readdirSync(join(home, "policies")).some((n) => n.includes(".replaced-"))).toBe(false);
    expect(audit().filter((l) => l.result === "failed")).toHaveLength(1);
    expect(restorePolicy("org", { force: true })).toMatchObject({ ok: true });
  });

  it("a failing lock release after the restore still reports the restore", () => {
    probe.fails = [{ fn: "rmSync", match: /auth\.lock$/, code: "EIO" }];
    const r = restorePolicy("org");
    expect(r).toMatchObject({ ok: true, kept: expect.stringMatching(/^org\.json\.replaced-/) });
    expect(readFileSync(join(home, "policies", "org.json"), "utf8")).toBe(JSON.stringify(parsePolicyPack(coverPack("org"))));
    expect(audit().filter((l) => l.result === "ok")).toHaveLength(1);
  });
});
