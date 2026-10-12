import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CANDIDATES_FILE, DISCOVERY_LIMITS, DiscoveryError, candidatesPath, mergeCandidates, parseExport, readCandidates, readExport, type SourceCandidate } from "../src/skills/discovery.js";

// Tokens are built from parts so the secret scan does not trip on this file.
const GHP = "ghp" + "_" + "A1".repeat(18);
const AKIA = "AKIA" + "ABCDEFGHIJKLMNOP";
const SK = "sk" + "-" + "a1".repeat(18);

let dir: string;
let saved: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "skill-discovery-"));
  saved = process.env.FACTORY_HOME;
  process.env.FACTORY_HOME = join(dir, "home");
  mkdirSync(process.env.FACTORY_HOME, { recursive: true, mode: 0o700 });
});
afterEach(() => {
  process.env.FACTORY_HOME = saved;
  rmSync(dir, { recursive: true, force: true });
});

const keys = (r: ReturnType<typeof parseExport>) => (r.ok ? r.repositories.map((x) => x.repositoryKey) : r.reason);
const cand = (key: string, over: Partial<SourceCandidate> = {}): SourceCandidate => ({
  repository: `https://github.com/${key.slice("github.com/".length)}`,
  repositoryKey: key,
  revision: "a".repeat(40),
  status: "proposed",
  origin: "skills.sh",
  listed: 1,
  foundAt: "2026-01-01T00:00:00.000Z",
  ...over,
});
const writeList = (candidates: unknown[], extra: Record<string, unknown> = {}) =>
  writeFileSync(candidatesPath(), JSON.stringify({ version: 1, candidates, ...extra }));

describe("parseExport", () => {
  it("reads an array of entries with a source", () => {
    expect(keys(parseExport(JSON.stringify([{ source: "owner/b" }, { source: "owner/a" }])))).toEqual(["github.com/owner/a", "github.com/owner/b"]);
  });
  it("reads an object with skills or repositories, and the keys repository and repo", () => {
    expect(keys(parseExport(JSON.stringify({ skills: [{ repository: "o/a" }] })))).toEqual(["github.com/o/a"]);
    expect(keys(parseExport(JSON.stringify({ repositories: [{ repo: "o/b" }, "o/c"] })))).toEqual(["github.com/o/b", "github.com/o/c"]);
  });
  it("reads bare strings and a plain line list", () => {
    expect(keys(parseExport(JSON.stringify(["o/a", "https://github.com/o/b"])))).toEqual(["github.com/o/a", "github.com/o/b"]);
    expect(keys(parseExport("# my export\n\no/a\n  o/b  \n"))).toEqual(["github.com/o/a", "github.com/o/b"]);
  });
  it("merges other spellings of one repository and sums how often it is listed", () => {
    const r = parseExport(JSON.stringify(["Owner/Repo2", "https://github.com/owner/repo2.git", { source: "owner/repo2" }]));
    expect(r.ok && r.repositories).toEqual([{ repository: "https://github.com/Owner/Repo2", repositoryKey: "github.com/owner/repo2", listed: 3 }]);
  });
  it("skips and counts what is not a GitHub https repository", () => {
    const entries = ["https://gitlab.com/o/a", "ssh://git@github.com/o/a", "git@github.com:o/a.git", "https://user@github.com/o/a", 5, null, { source: { x: 1 } }, "owner/repo", "https://skills.sh/o/a", "o/ok"];
    const r = parseExport(JSON.stringify(entries));
    expect(r).toEqual({ ok: true, repositories: [{ repository: "https://github.com/o/ok", repositoryKey: "github.com/o/ok", listed: 1 }], skipped: 9, hidden: 0 });
  });
  it("hides and counts credential-like repositories", () => {
    const r = parseExport(JSON.stringify([`owner/${GHP}`, `https://github.com/${AKIA}/x`, `${SK}/x`, "o/fine"]));
    expect(r).toMatchObject({ ok: true, skipped: 0, hidden: 3 });
    expect(keys(r)).toEqual(["github.com/o/fine"]);
  });
  it("never returns names, counts, licences or trust claims", () => {
    const r = parseExport(JSON.stringify([{ source: "o/a", name: "Cool Skill", installs: 99999, license: "MIT", trust: "verified", safe: true }]));
    expect(JSON.stringify(r)).not.toMatch(/Cool|99999|MIT|verified|safe/);
  });
  it("gives a fixed sentence for a bad file", () => {
    expect(parseExport("   ")).toEqual({ ok: false, reason: "is empty" });
    expect(parseExport("{ not json")).toEqual({ ok: false, reason: "is not valid JSON" });
    expect(parseExport(JSON.stringify({ other: [] }))).toMatchObject({ ok: false });
    const many = Array.from({ length: DISCOVERY_LIMITS.repositories + 1 }, (_, i) => `o/r${i}`);
    expect(parseExport(JSON.stringify(many))).toEqual({ ok: false, reason: "holds more than 100 repositories; split the file" });
    expect(parseExport(JSON.stringify(Array(DISCOVERY_LIMITS.entries + 1).fill("o/a")))).toMatchObject({ ok: false, reason: expect.stringContaining("20000 entries") });
  });
});

describe("readExport", () => {
  it("reads a file", () => {
    const f = join(dir, "e.json");
    writeFileSync(f, '["o/a"]');
    expect(keys(readExport(f))).toEqual(["github.com/o/a"]);
  });
  it("refuses a missing file, a link, a folder, a large file and invalid UTF-8 without repeating the path", () => {
    const f = join(dir, "e.json");
    writeFileSync(f, '["o/a"]');
    symlinkSync(f, join(dir, "link.json"));
    writeFileSync(join(dir, "big.json"), Buffer.alloc(DISCOVERY_LIMITS.exportBytes + 1, 0x20));
    writeFileSync(join(dir, "bad.txt"), Buffer.from([0xff, 0xfe, 0x41]));
    for (const name of ["missing.json", "link.json", ".", "big.json", "bad.txt"]) {
      const r = readExport(join(dir, name));
      expect(r.ok, name).toBe(false);
      expect(JSON.stringify(r)).not.toContain(dir);
    }
  });
});

describe("readCandidates", () => {
  it("treats a missing file as an empty list", () => {
    expect(readCandidates()).toEqual({ ok: true, candidates: [] });
  });
  it("reads a good list", () => {
    writeList([cand("github.com/o/a")]);
    expect(readCandidates()).toEqual({ ok: true, candidates: [cand("github.com/o/a")] });
  });
  const bad: [string, unknown][] = [
    ["status", cand("github.com/o/a", { status: "approved" as "proposed" })],
    ["short revision", cand("github.com/o/a", { revision: "abc" })],
    ["non-GitHub repository", cand("gitlab.com/o/a", { repository: "https://gitlab.com/o/a" })],
    ["mismatched key", cand("github.com/o/other", { repository: "https://github.com/o/a" })],
    ["credential-like repository", cand(`github.com/o/${GHP.toLowerCase()}`, { repository: `https://github.com/o/${GHP}` })],
    ["unknown field", { ...cand("github.com/o/a"), license: "MIT" }],
  ];
  for (const [name, record] of bad) {
    it(`refuses a ${name}`, () => {
      writeList([record]);
      const r = readCandidates();
      expect(r).toMatchObject({ ok: false });
      expect(JSON.stringify(r)).not.toMatch(/github\.com|ghp_|MIT/);
    });
  }
  it("refuses a wrong version, an unknown top-level key and a link", () => {
    writeFileSync(candidatesPath(), JSON.stringify({ version: 2, candidates: [] }));
    expect(readCandidates().ok).toBe(false);
    writeList([], { extra: 1 });
    expect(readCandidates().ok).toBe(false);
    rmSync(candidatesPath());
    writeFileSync(join(dir, "real.json"), "{}");
    symlinkSync(join(dir, "real.json"), candidatesPath());
    expect(readCandidates()).toMatchObject({ ok: false, reason: "is a symbolic link" });
  });
});

describe("mergeCandidates", () => {
  it("adds new candidates, sorted, with mode 0600", () => {
    const r = mergeCandidates([cand("github.com/o/b"), cand("github.com/o/a")], new Set());
    expect(r).toEqual({ added: ["github.com/o/b", "github.com/o/a"], kept: [], removed: [] });
    const read = readCandidates();
    expect(read.ok && read.candidates.map((c) => c.repositoryKey)).toEqual(["github.com/o/a", "github.com/o/b"]);
    expect(statSync(candidatesPath()).mode & 0o777).toBe(0o600);
  });
  it("keeps an existing candidate as it is", () => {
    mergeCandidates([cand("github.com/o/a")], new Set());
    const r = mergeCandidates([cand("github.com/o/a", { revision: "b".repeat(40), foundAt: "2027-01-01T00:00:00.000Z" }), cand("github.com/o/c")], new Set());
    expect(r).toEqual({ added: ["github.com/o/c"], kept: ["github.com/o/a"], removed: [] });
    const read = readCandidates();
    expect(read.ok && read.candidates[0]).toEqual(cand("github.com/o/a"));
  });
  it("removes a candidate that is now known, and never adds a known one", () => {
    mergeCandidates([cand("github.com/o/a")], new Set());
    const r = mergeCandidates([cand("github.com/o/b")], new Set(["github.com/o/a", "github.com/o/b"]));
    expect(r).toEqual({ added: [], kept: [], removed: ["github.com/o/a"] });
    expect(readCandidates()).toEqual({ ok: true, candidates: [] });
  });
  it("does not rewrite when nothing changes", () => {
    mergeCandidates([cand("github.com/o/a")], new Set());
    const old = new Date(2020, 0, 1);
    utimesSync(candidatesPath(), old, old);
    const before = readFileSync(candidatesPath());
    mergeCandidates([cand("github.com/o/a")], new Set());
    expect(statSync(candidatesPath()).mtimeMs).toBe(old.getTime());
    expect(readFileSync(candidatesPath())).toEqual(before);
  });
  it("throws unreadable on a broken list and leaves it untouched", () => {
    writeFileSync(candidatesPath(), "{ broken");
    try {
      mergeCandidates([cand("github.com/o/a")], new Set());
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DiscoveryError);
      expect((e as DiscoveryError).code).toBe("unreadable");
    }
    expect(readFileSync(candidatesPath(), "utf8")).toBe("{ broken");
  });
  it("throws too-large past the limit and writes nothing", () => {
    const many = Array.from({ length: DISCOVERY_LIMITS.candidates + 1 }, (_, i) => cand(`github.com/o/r${i}`));
    expect(() => mergeCandidates(many, new Set())).toThrowError(expect.objectContaining({ code: "too-large" }));
    expect(() => statSync(join(process.env.FACTORY_HOME!, CANDIDATES_FILE))).toThrow();
  });
});
