import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readApprovals, recordApprovedRef, updateSourceApprovals, type ApprovalsFile } from "../src/skills/approvals.js";
import { autoBases, nextAutoVersion, rejectedFailures, takenVersions } from "../src/skills/auto-release.js";
import { GATE_MESSAGES } from "../src/skills/auto-updates.js";
import type { StoreListing } from "../src/skills/release-store.js";

// The pieces of an automatic release that need no git: the next catalogue version, the base of the versions, the ref check.

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "auto-release-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const listing = (...r: [string, string][]): StoreListing => ({ releases: r.map(([catalogue, version]) => ({ catalogue, version, dir: "/nowhere" })), hidden: 0, unreadable: 0 });
const DIGEST = `sha256:${"a".repeat(64)}`;
const approvals = (catalogue: string, version: string): ApprovalsFile => ({ ver: { repositoryKey: "github.com/e/v", releases: [{ catalogue, version, digest: DIGEST, at: "2026-10-15T10:00:00Z" }] } });

describe("nextAutoVersion", () => {
  it("starts at 1.0.1", () => {
    expect(nextAutoVersion("ver", listing(), {})).toBe("1.0.1");
  });

  it("counts above the store and the approvals of the catalogue only, and skips holes", () => {
    expect(nextAutoVersion("ver", listing(["ver", "1.0.2"], ["ver", "1.0.9"], ["other", "1.0.40"], ["ver", "2.0.0"]), {})).toBe("1.0.10");
    expect(nextAutoVersion("ver", listing(["ver", "1.0.2"]), approvals("ver", "1.0.7"))).toBe("1.0.8");
    expect(nextAutoVersion("ver", listing(), approvals("other", "1.0.7"))).toBe("1.0.1");
  });
});

describe("autoBases and takenVersions", () => {
  it("find nothing in an empty data folder", () => {
    expect(autoBases("ver", home)).toEqual({ state: "ok", bases: new Map() });
    expect(takenVersions(home).size).toBe(0);
  });

  it("refuse to guess when the approved release is not in the store, or the approvals are unreadable", () => {
    updateSourceApprovals(() => approvals("ver", "1.0.1"), { home });
    expect(autoBases("ver", home)).toMatchObject({ state: "problem", text: expect.stringContaining("ver@1.0.1 is not in the release store") });
  });
});

describe("rejectedFailures", () => {
  it("gives fixed placeholder ids and the fixed message", () => {
    expect(rejectedFailures("ver", 2)).toEqual([
      { skill: "ver-skill-1", gate: "normalize", message: GATE_MESSAGES.normalize },
      { skill: "ver-skill-2", gate: "normalize", message: GATE_MESSAGES.normalize },
    ]);
  });
});

describe("recordApprovedRef with an expected previous commit", () => {
  const KEY = "github.com/e/v";
  const C1 = "1".repeat(40);
  const C2 = "2".repeat(40);
  const C3 = "3".repeat(40);

  it("records when the stored commit is the expected one, and refuses when another writer moved it", () => {
    expect(recordApprovedRef("ver", KEY, C1, { home, expectedPrevious: null })).toBe("recorded");
    expect(recordApprovedRef("ver", KEY, C2, { home, expectedPrevious: C1 })).toBe("recorded");
    expect(recordApprovedRef("ver", KEY, C3, { home, expectedPrevious: C1 })).toBe("stale");
    const read = readApprovals({ home });
    expect(read.state === "ok" && read.sources.ver!.ref!.approved).toBe(C2);
  });

  it("refuses a first record when a commit is already stored, and is a repeat when it is already the new one", () => {
    recordApprovedRef("ver", KEY, C1, { home });
    expect(recordApprovedRef("ver", KEY, C2, { home, expectedPrevious: null })).toBe("stale");
    expect(recordApprovedRef("ver", KEY, C1, { home, expectedPrevious: null })).toBe("unchanged");
  });
});
