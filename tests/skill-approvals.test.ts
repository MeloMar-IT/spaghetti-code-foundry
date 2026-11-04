import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StoreError } from "../src/auth/store.js";
import {
  APPROVALS_FILE,
  MAX_APPROVALS_BYTES,
  applyApprovedRefs,
  approvalsPath,
  approvalsSettings,
  approvedReleases,
  mergeApprovedReleases,
  readApprovals,
  recordApprovedRef,
  updateSourceApprovals,
  withApprovedRefs,
  type ApprovalsFile,
} from "../src/skills/approvals.js";
import type { ApprovedRelease } from "../src/skills/release.js";
import { parseSources, readSources, type SourcesManifest } from "../src/skills/sources.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const COMMIT2 = "fedcba9876543210fedcba9876543210fedcba98";
const D1 = `sha256:${"a".repeat(64)}`;
const D2 = `sha256:${"b".repeat(64)}`;
const SIG = Buffer.alloc(64, 1).toString("base64");
const KEY = "github.com/acme/skills";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "approvals-"));
  approvalsSettings.waitMs = 2000;
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const rel = (version: string, digest = D1, extra: object = {}) => ({ catalogue: "acme", version, digest, at: "2026-01-01T00:00:00Z", ...extra });
const file = (over: Partial<ApprovalsFile[string]> = {}): ApprovalsFile => ({ s1: { repositoryKey: KEY, releases: [], ...over } });
const put = (text: string) => writeFileSync(approvalsPath(home), text);

function sources(auto: boolean, extra: Record<string, unknown> = {}): SourcesManifest {
  const r = parseSources({
    schema: 1,
    sources: [
      {
        id: "s1",
        repository: "https://github.com/acme/skills",
        status: "enabled",
        ref: { track: "main", approved: COMMIT },
        paths: ["skills"],
        adapter: "agent-skills",
        trust: "first-party",
        licence: { allow: ["MIT"] },
        update: { cadence: "weekly", ...(auto ? { auto: true } : {}) },
        owner: "@octocat",
        ...extra,
      },
    ],
  });
  return r.manifest!;
}

describe("the store file", () => {
  it("round-trips with mode 0600", () => {
    expect(readApprovals({ home }).state).toBe("none");
    expect(updateSourceApprovals(() => file({ releases: [rel("1.0.0", D1, { key: "k1", signature: SIG })] }), { home })).toBe("written");
    expect(statSync(approvalsPath(home)).mode & 0o777).toBe(0o600);
    const r = readApprovals({ home });
    expect(r.state === "ok" && r.sources.s1!.releases[0]!.version).toBe("1.0.0");
    expect(updateSourceApprovals(() => undefined, { home })).toBe("unchanged");
  });

  it.each([
    ["bad json", "{"],
    ["wrong schema", JSON.stringify({ schema: 2, sources: {} })],
    ["an unknown key", JSON.stringify({ schema: 1, sources: {}, extra: 1 })],
    ["a bad digest", JSON.stringify({ schema: 1, sources: { s1: { repositoryKey: KEY, releases: [rel("1.0.0", "sha256:zz")] } } })],
    ["key without signature", JSON.stringify({ schema: 1, sources: { s1: { repositoryKey: KEY, releases: [rel("1.0.0", D1, { key: "k1" })] } } })],
    ["too large", " ".repeat(MAX_APPROVALS_BYTES + 1)],
  ])("is unreadable: %s", (_n, text) => {
    put(text);
    expect(readApprovals({ home }).state).toBe("unreadable");
  });

  it("is unreadable as a symlink or a folder", () => {
    writeFileSync(join(home, "other.json"), "{}");
    symlinkSync(join(home, "other.json"), approvalsPath(home));
    expect(readApprovals({ home }).state).toBe("unreadable");
    rmSync(approvalsPath(home));
    mkdirSync(approvalsPath(home));
    expect(readApprovals({ home }).state).toBe("unreadable");
  });

  it("is never replaced when unreadable", () => {
    put("{");
    expect(() => updateSourceApprovals(() => file(), { home })).toThrow(StoreError);
    expect(readFileSync(approvalsPath(home), "utf8")).toBe("{");
  });

  it("refuses an update that would be too large and keeps the old bytes", () => {
    updateSourceApprovals(() => file(), { home });
    const before = readFileSync(approvalsPath(home), "utf8");
    const big: ApprovalsFile = {};
    for (let i = 0; i < 200; i++) {
      big[`s${i}`] = { repositoryKey: KEY, releases: Array.from({ length: 100 }, (_, j) => ({ ...rel(`1.0.${j}`), key: "k1", signature: SIG }) as never) };
    }
    let err: unknown;
    try {
      updateSourceApprovals(() => big, { home });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StoreError);
    expect((err as StoreError).kind).toBe("too-large");
    expect(readFileSync(approvalsPath(home), "utf8")).toBe(before);
    expect(readApprovals({ home }).state).toBe("ok");
  });

  it("refuses a 201st source with too-large and keeps the old bytes", () => {
    updateSourceApprovals(() => Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`x${i}`, { repositoryKey: KEY, releases: [] }])), { home });
    const before = readFileSync(approvalsPath(home), "utf8");
    let err: unknown;
    try {
      updateSourceApprovals((cur) => ({ ...cur, extra: { repositoryKey: KEY, releases: [] } }), { home });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StoreError);
    expect((err as StoreError).kind).toBe("too-large");
    expect(readFileSync(approvalsPath(home), "utf8")).toBe(before);
  });

  it("fails with locked when the lock is held, and works with claimed", () => {
    mkdirSync(join(home, "skill-approvals.lock"));
    writeFileSync(join(home, "skill-approvals.lock", "pid"), String(process.pid));
    approvalsSettings.waitMs = 0;
    let err: unknown;
    try {
      updateSourceApprovals(() => file(), { home });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StoreError);
    expect((err as StoreError).kind).toBe("locked");
    rmSync(join(home, "skill-approvals.lock"), { recursive: true });
    expect(updateSourceApprovals(() => file(), { home, claimed: true })).toBe("written");
  });

  it("records an approved ref, and replaces the entry of another repository", () => {
    expect(recordApprovedRef("s1", KEY, COMMIT, { home })).toBe("recorded");
    expect(recordApprovedRef("s1", KEY, COMMIT, { home })).toBe("unchanged");
    updateSourceApprovals((cur) => ((cur.s1!.releases.push(rel("1.0.0") as never), cur)), { home });
    expect(recordApprovedRef("s1", KEY, COMMIT2, { home })).toBe("recorded");
    let r = readApprovals({ home });
    expect(r.state === "ok" && r.sources.s1!.releases).toHaveLength(1);
    expect(recordApprovedRef("s1", "github.com/other/repo", COMMIT, { home })).toBe("recorded");
    r = readApprovals({ home });
    expect(r.state === "ok" && r.sources.s1).toMatchObject({ repositoryKey: "github.com/other/repo", releases: [] });
    expect(() => recordApprovedRef("s1", KEY, "main", { home })).toThrow();
    expect(() => recordApprovedRef("Bad Id", KEY, COMMIT, { home })).toThrow();
  });
});

describe("mergeApprovedReleases", () => {
  const cfg = (version: string, digest: string, extra: object = {}): ApprovedRelease => ({ catalogue: "acme", version, digest, ...extra });
  it("de-duplicates the same digest and the config entry wins", () => {
    const m = mergeApprovedReleases([cfg("1.0.0", D1, { key: "k1", signature: SIG })], file({ releases: [rel("1.0.0", D1), rel("1.1.0", D1)] }));
    expect(m.conflicts.size).toBe(0);
    expect(m.approved).toEqual([cfg("1.0.0", D1, { key: "k1", signature: SIG }), cfg("1.1.0", D1)]);
  });
  it("drops both entries of a different digest and lists the conflict", () => {
    const m = mergeApprovedReleases([cfg("1.0.0", D1)], file({ releases: [rel("1.0.0", D2), rel("1.1.0", D1)] }));
    expect([...m.conflicts]).toEqual(["acme@1.0.0"]);
    expect(m.approved.map((a) => a.version)).toEqual(["1.1.0"]);
  });
  it("conflicts between two stored sources, and de-duplicates the same digest", () => {
    const two: ApprovalsFile = { a: { repositoryKey: KEY, releases: [rel("1.0.0", D1), rel("2.0.0", D1)] }, b: { repositoryKey: KEY, releases: [rel("1.0.0", D2), rel("2.0.0", D1)] } };
    const m = mergeApprovedReleases([], two);
    expect([...m.conflicts]).toEqual(["acme@1.0.0"]);
    expect(m.approved.map((a) => a.version)).toEqual(["2.0.0"]);
  });
  it("approvedReleases keeps the config and names a problem when the file is unreadable or conflicts", () => {
    const c = [cfg("1.0.0", D1)];
    expect(approvedReleases({ approved: c }, { home }).problems).toEqual([]);
    put("{");
    const bad = approvedReleases({ approved: c }, { home });
    expect(bad.approved).toEqual(c);
    expect(bad.problems).toHaveLength(1);
    expect(bad.problems[0]!.kind).toBe("unreadable");
    rmSync(approvalsPath(home));
    updateSourceApprovals(() => file({ releases: [rel("1.0.0", D2)] }), { home });
    const conf = approvedReleases({ approved: c }, { home });
    expect(conf.approved).toEqual([]);
    expect(conf.problems.map((p) => p.kind)).toEqual(["conflict"]);
  });
});

describe("the ref overlay", () => {
  const stored = (over: Partial<ApprovalsFile[string]> = {}) => file({ ref: { approved: COMMIT2, at: "2026-01-01T00:00:00Z" }, ...over });
  it("applies to an enabled auto source of the same repository", () => {
    const r = applyApprovedRefs(sources(true), stored());
    expect(r.manifest.sources[0]!.ref).toEqual({ track: "main", approved: COMMIT2 });
    expect([...r.fromStore]).toEqual(["s1"]);
  });
  it.each([
    ["a non-auto source", () => sources(false), stored()],
    ["a disabled source", () => sources(true, { status: "disabled", reason: "off" }), stored()],
    ["another repository", () => sources(true), stored({ repositoryKey: "github.com/other/repo" })],
    ["a missing ref", () => sources(true), file()],
  ])("does not apply to %s", (_n, m, s) => {
    const r = applyApprovedRefs(m(), s);
    expect(r.manifest.sources[0]!.ref.approved).toBe(COMMIT);
    expect(r.fromStore.size).toBe(0);
  });

  const yaml = (auto: boolean) =>
    `schema: 1\nsources:\n  - id: s1\n    repository: https://github.com/acme/skills\n    status: enabled\n    ref: {track: main, approved: ${COMMIT}}\n    paths: [skills]\n    adapter: agent-skills\n    trust: first-party\n    licence: {allow: [MIT]}\n    update: {cadence: weekly${auto ? ", auto: true" : ""}}\n    owner: '@octocat'\n`;
  it("readSources overlays by default and not with approvals: false", () => {
    const path = join(home, "skill-sources.yaml");
    writeFileSync(path, yaml(true));
    recordApprovedRef("s1", KEY, COMMIT2, { home });
    const on = readSources(path, undefined, undefined, { home });
    expect(on.state === "ok" && on.manifest.sources[0]!.ref.approved).toBe(COMMIT2);
    const off = readSources(path, undefined, undefined, { home, approvals: false });
    expect(off.state === "ok" && off.manifest.sources[0]!.ref.approved).toBe(COMMIT);
  });
  it("an unreadable store makes a read with an auto source invalid, and is ignored without one", () => {
    const path = join(home, "skill-sources.yaml");
    put("{");
    writeFileSync(path, yaml(true));
    const bad = readSources(path, undefined, undefined, { home });
    expect(bad.state).toBe("invalid");
    expect(bad.state === "invalid" && bad.problems).toHaveLength(1);
    writeFileSync(path, yaml(false));
    expect(readSources(path, undefined, undefined, { home }).state).toBe("ok");
    expect(withApprovedRefs({ state: "none" }, { home }).state).toBe("none");
  });
  it("uses the file name APPROVALS_FILE in the data folder", () => {
    expect(approvalsPath(home)).toBe(join(home, APPROVALS_FILE));
    chmodSync(home, 0o700);
  });
});
