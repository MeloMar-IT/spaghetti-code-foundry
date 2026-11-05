import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StoreError } from "../src/auth/store.js";
import {
  AUTO_UPDATES_FILE,
  GATE_MESSAGES,
  MAX_AUTO_UPDATE_FAILED,
  autoFailure,
  readAutoUpdates,
  recordAutoUpdate,
  type AutoUpdateEntry,
} from "../src/skills/auto-updates.js";
import { RELEASE_GATES } from "../src/skills/release-publish.js";

// skill-auto-updates.json: the last automatic update of each source (#799).

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "auto-updates-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const COMMIT = "a".repeat(40);
const entry = (over: Partial<AutoUpdateEntry> = {}): AutoUpdateEntry => ({ at: "2026-10-15T10:00:00Z", commit: COMMIT, result: "released", failed: [], ...over });
const file = () => join(home, AUTO_UPDATES_FILE);

describe("the messages", () => {
  it("has one fixed sentence for every gate", () => {
    expect(Object.keys(GATE_MESSAGES).sort()).toEqual([...RELEASE_GATES].sort());
    expect(autoFailure("some-skill", "scan")).toEqual({ skill: "some-skill", gate: "scan", message: GATE_MESSAGES.scan });
  });
});

describe("readAutoUpdates", () => {
  it("is none without a file, and ok after a write", () => {
    expect(readAutoUpdates({ home })).toEqual({ state: "none" });
    const e = entry({ release: { catalogue: "ver", version: "1.0.1", digest: `sha256:${"b".repeat(64)}` }, failed: [autoFailure("ver-b-123", "normalize")] });
    recordAutoUpdate("ver", e, { home });
    expect(readAutoUpdates({ home })).toEqual({ state: "ok", sources: { ver: e } });
  });

  it("is unreadable for a link, bad JSON, the wrong schema, or a message that is not the fixed text", () => {
    const target = join(home, "elsewhere.json");
    writeFileSync(target, "{}");
    symlinkSync(target, file());
    expect(readAutoUpdates({ home })).toMatchObject({ state: "unreadable", reason: "is a symbolic link" });
    rmSync(file());
    writeFileSync(file(), "nope");
    expect(readAutoUpdates({ home })).toMatchObject({ state: "unreadable", reason: "is not valid JSON" });
    writeFileSync(file(), JSON.stringify({ schema: 2, sources: {} }));
    expect(readAutoUpdates({ home })).toMatchObject({ state: "unreadable", reason: "has the wrong format" });
    const bad = entry({ failed: [{ skill: "ver-b-123", gate: "normalize", message: "text from upstream" }] });
    writeFileSync(file(), JSON.stringify({ schema: 1, sources: { ver: bad } }));
    expect(readAutoUpdates({ home })).toMatchObject({ state: "unreadable", reason: "has the wrong format" });
  });
});

describe("recordAutoUpdate", () => {
  it("writes a private file and replaces the entry of the same source, keeping the others", () => {
    recordAutoUpdate("ver", entry(), { home });
    recordAutoUpdate("other", entry({ result: "unchanged" }), { home });
    recordAutoUpdate("ver", entry({ result: "blocked" }), { home });
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    const read = readAutoUpdates({ home });
    expect(read.state === "ok" && Object.fromEntries(Object.entries(read.sources).map(([k, v]) => [k, v.result]))).toEqual({ ver: "blocked", other: "unchanged" });
  });

  it("drops the sources that are no longer listed", () => {
    recordAutoUpdate("gone", entry(), { home });
    recordAutoUpdate("ver", entry(), { home, keep: new Set(["ver"]) });
    const read = readAutoUpdates({ home });
    expect(read.state === "ok" && Object.keys(read.sources)).toEqual(["ver"]);
  });

  it("refuses a record over the limit and keeps the old bytes", () => {
    mkdirSync(home, { recursive: true });
    recordAutoUpdate("ver", entry(), { home });
    const before = readFileSync(file(), "utf8");
    const many = Array.from({ length: MAX_AUTO_UPDATE_FAILED + 1 }, (_, i) => autoFailure(`skill-${i}`, "scan"));
    expect(() => recordAutoUpdate("ver", entry({ failed: many }), { home })).toThrow(StoreError);
    expect(readFileSync(file(), "utf8")).toBe(before);
  });

  it("refuses a bad source id", () => {
    expect(() => recordAutoUpdate("Bad Id", entry(), { home })).toThrow();
  });
});
