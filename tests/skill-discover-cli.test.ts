import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { DISCOVER_USAGE, skillDiscoverCommand, type HeadResolver } from "../src/skill-import/discover-cli.js";
import { LsRemoteError, type LsRemoteErrorCode } from "../src/skill-import/ls-remote.js";
import { candidatesPath, readCandidates } from "../src/skills/discovery.js";

const GHP = "ghp" + "_" + "A1".repeat(18);
const NOW = new Date("2026-02-03T04:05:06.000Z");
const HEAD = "c".repeat(40);

let dir: string;
let home: string;
let saved: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "skill-discover-cli-"));
  home = join(dir, "home");
  mkdirSync(home, { mode: 0o700 });
  saved = process.env.FACTORY_HOME;
  process.env.FACTORY_HOME = home;
});
afterEach(() => {
  process.env.FACTORY_HOME = saved;
  rmSync(dir, { recursive: true, force: true });
});

const source = (id: string, repository: string, status = "enabled") => ({
  id,
  repository,
  status,
  ...(status === "enabled" ? { ref: { track: "main", approved: "a".repeat(40) } } : { reason: "because", ref: {} }),
  paths: ["skills"],
  adapter: "agent-skills",
  trust: "community",
  licence: { allow: ["MIT"] },
  update: { cadence: "manual" },
  owner: "@example",
});
const writeSources = (sources: Record<string, unknown>[]) => writeFileSync(join(dir, "skill-sources.yaml"), stringify({ schema: 1, sources }));
const writeExport = (body: unknown) => writeFileSync(join(dir, "export.json"), typeof body === "string" ? body : JSON.stringify(body));

const okResolver = (calls: string[]): HeadResolver => async (repository) => {
  calls.push(repository);
  return HEAD;
};
const failing = (code: LsRemoteErrorCode, calls: string[] = []): HeadResolver => async (repository) => {
  calls.push(repository);
  throw new LsRemoteError(code);
};
const run = async (positionals: string[], resolve: HeadResolver, now = NOW) => {
  const lines: string[] = [];
  const status = await skillDiscoverCommand({ positionals, values: {} }, (l) => lines.push(l), { cwd: dir, now, resolve });
  return { status, lines, text: lines.join("\n") };
};
const sigCounts = () => [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];

describe("scf skills discover", () => {
  it("proposes candidates and writes only the candidate list", async () => {
    writeSources([source("lib", "https://github.com/example/skills")]);
    writeExport([{ source: "o/a" }, { source: "o/b" }, { source: "example/skills" }]);
    const before = readFileSync(join(dir, "skill-sources.yaml"));
    const calls: string[] = [];
    const r = await run(["export.json"], okResolver(calls));
    expect(r.status).toBe(0);
    expect(r.lines).toEqual([
      "KNOWN github.com/example/skills is in the source list (enabled)",
      "PROPOSED github.com/o/a@cccccccccccc (1 listed)",
      "PROPOSED github.com/o/b@cccccccccccc (1 listed)",
      "OK 2 proposed, 0 already candidates, 1 in the source list, 0 unresolved",
      `Candidates: ${candidatesPath()}`,
    ]);
    expect(calls).toEqual(["https://github.com/o/a", "https://github.com/o/b"]);
    expect(candidatesPath().startsWith(home)).toBe(true);
    expect(statSync(candidatesPath()).mode & 0o777).toBe(0o600);
    const list = readCandidates();
    expect(list.ok && list.candidates[0]).toEqual({
      repository: "https://github.com/o/a",
      repositoryKey: "github.com/o/a",
      revision: HEAD,
      status: "proposed",
      origin: "skills.sh",
      listed: 1,
      foundAt: NOW.toISOString(),
    });
    expect(readFileSync(join(dir, "skill-sources.yaml"))).toEqual(before);
    expect(readdirSync(home).filter((n) => !n.includes("lock")).sort()).toEqual(["skill-source-candidates.json"]);
    expect(existsSync(join(home, "skill-quarantine"))).toBe(false);
    expect(existsSync(join(home, "skills.lock.json"))).toBe(false);
  });

  for (const status of ["enabled", "disabled", "quarantined", "retired"]) {
    it(`reports a ${status} source as known and does not resolve it`, async () => {
      writeSources([source("lib", "https://github.com/example/skills", status)]);
      writeExport(["example/skills"]);
      const calls: string[] = [];
      const r = await run(["export.json"], okResolver(calls));
      expect(r.text).toContain(`KNOWN github.com/example/skills is in the source list (${status})`);
      expect(calls).toEqual([]);
      expect(existsSync(candidatesPath())).toBe(false);
    });
  }

  it("does not resolve an existing candidate again", async () => {
    writeExport(["o/a"]);
    await run(["export.json"], okResolver([]));
    const calls: string[] = [];
    const r = await run(["export.json"], okResolver(calls), new Date("2030-01-01T00:00:00Z"));
    expect(calls).toEqual([]);
    expect(r.lines[0]).toBe("NOTE no skill source list was found; nothing is treated as known");
    expect(r.text).toContain("OK 0 proposed, 1 already candidates");
    const list = readCandidates();
    expect(list.ok && list.candidates[0]?.foundAt).toBe(NOW.toISOString());
  });

  for (const code of ["unreachable", "timeout", "bad-answer"] as const) {
    it(`reports ${code} as UNRESOLVED, exit 1, and stores the others`, async () => {
      writeExport(["o/a", "o/b"]);
      const resolver: HeadResolver = async (repository) => {
        if (repository.endsWith("/a")) throw new LsRemoteError(code);
        return HEAD;
      };
      const r = await run(["export.json"], resolver);
      expect(r.status).toBe(1);
      expect(r.text).toContain("UNRESOLVED github.com/o/a: ");
      expect(r.text).toContain("OK 1 proposed, 0 already candidates, 0 in the source list, 1 unresolved");
      const list = readCandidates();
      expect(list.ok && list.candidates.map((c) => c.repositoryKey)).toEqual(["github.com/o/b"]);
    });
  }

  it("stops with one PROBLEM when git is missing and writes nothing", async () => {
    writeExport(["o/a", "o/b"]);
    const calls: string[] = [];
    const r = await run(["export.json"], failing("no-git", calls));
    expect(r.status).toBe(1);
    expect(r.lines.filter((l) => l.startsWith("PROBLEM"))).toEqual(["PROBLEM git was not found; install git and try again"]);
    expect(calls).toHaveLength(1);
    expect(existsSync(candidatesPath())).toBe(false);
  });

  it("removes a stored candidate that is now in the source list", async () => {
    writeExport(["o/a"]);
    await run(["export.json"], okResolver([]));
    writeSources([source("a", "https://github.com/o/a", "disabled")]);
    const r = await run(["export.json"], okResolver([]));
    expect(r.text).toContain("REMOVED github.com/o/a is now in the source list");
    expect(readCandidates()).toEqual({ ok: true, candidates: [] });
  });

  it("keeps candidates that are missing from a newer export", async () => {
    writeExport(["o/a"]);
    await run(["export.json"], okResolver([]));
    writeExport(["o/b"]);
    await run(["export.json"], okResolver([]));
    const list = readCandidates();
    expect(list.ok && list.candidates.map((c) => c.repositoryKey)).toEqual(["github.com/o/a", "github.com/o/b"]);
  });

  it("proposes with a NOTE when there is no source list, and refuses an invalid one", async () => {
    writeExport(["o/a"]);
    const calls: string[] = [];
    expect((await run(["export.json"], okResolver(calls))).lines[0]).toMatch(/^NOTE /);
    expect(calls).toHaveLength(1);
    rmSync(candidatesPath());
    writeFileSync(join(dir, "skill-sources.yaml"), "schema: 2\n");
    const bad = await run(["export.json"], okResolver(calls));
    expect(bad.status).toBe(1);
    expect(bad.text).toContain("PROBLEM");
    expect(calls).toHaveLength(1);
  });

  it("stops before any resolve when the candidate list is broken", async () => {
    writeExport(["o/a"]);
    writeFileSync(candidatesPath(), "{ broken");
    const calls: string[] = [];
    const r = await run(["export.json"], okResolver(calls));
    expect(r.status).toBe(1);
    expect(r.text).toContain("PROBLEM the candidate list is not valid JSON");
    expect(calls).toEqual([]);
    expect(readFileSync(candidatesPath(), "utf8")).toBe("{ broken");
  });

  it("refuses a bad export file", async () => {
    const r = await run(["missing.json"], okResolver([]));
    expect(r).toMatchObject({ status: 1, lines: ["PROBLEM the export file cannot be read"] });
  });

  it("prints nothing from the export but checked repositories", async () => {
    writeExport([{ source: "o/a", name: "Evil\u001b[31m name " + GHP, installs: 12345, license: "GPL", trust: "official" }, { source: `o/${GHP}` }]);
    const calls: string[] = [];
    const r = await run(["export.json"], okResolver(calls));
    expect(r.text).not.toMatch(/Evil|12345|GPL|official|\u001b|ghp_/);
    expect(r.text).toContain("SKIPPED 1 entries that look like a credential");
    expect(calls).toEqual(["https://github.com/o/a"]);
    expect(readFileSync(candidatesPath(), "utf8")).not.toContain("ghp_");
  });

  it("counts entries without a GitHub repository", async () => {
    writeExport(["o/a", "https://gitlab.com/o/b", 7]);
    expect((await run(["export.json"], okResolver([]))).text).toContain("SKIPPED 2 entries without a GitHub repository");
  });

  it("lists the stored candidates with no operand", async () => {
    writeExport(["o/a"]);
    await run(["export.json"], okResolver([]));
    const r = await run([], okResolver([]));
    expect(r).toMatchObject({ status: 0, lines: [`github.com/o/a@cccccccccccc proposed skills.sh ${NOW.toISOString()}`, "OK 1 candidates"] });
  });

  it("checks the syntax before any read", async () => {
    await expect(skillDiscoverCommand({ positionals: ["a"], values: { repo: "." } }, () => {})).rejects.toThrow(DISCOVER_USAGE);
    await expect(skillDiscoverCommand({ positionals: ["a", "b", "c"], values: {} }, () => {})).rejects.toThrow(DISCOVER_USAGE);
  });

  describe("signals", () => {
    it("SIGINT during the first resolve stops the loop and changes nothing", async () => {
      writeExport(["o/a", "o/b"]);
      writeFileSync(candidatesPath(), JSON.stringify({ version: 1, candidates: [] }));
      const before = readFileSync(candidatesPath());
      const calls: string[] = [];
      const resolver: HeadResolver = async (repository) => {
        calls.push(repository);
        process.emit("SIGINT");
        return HEAD;
      };
      const r = await run(["export.json"], resolver);
      expect(r).toMatchObject({ status: 1 });
      expect(r.lines).toContain("PROBLEM the discovery was interrupted; the candidate list was not changed");
      expect(calls).toHaveLength(1);
      expect(readFileSync(candidatesPath())).toEqual(before);
    });

    it("SIGTERM with an interrupted resolver gives the same result", async () => {
      writeExport(["o/a", "o/b"]);
      const calls: string[] = [];
      const resolver: HeadResolver = async (repository) => {
        calls.push(repository);
        process.emit("SIGTERM");
        throw new LsRemoteError("interrupted");
      };
      const r = await run(["export.json"], resolver);
      expect(r.status).toBe(1);
      expect(r.lines).toContain("PROBLEM the discovery was interrupted; the candidate list was not changed");
      expect(calls).toHaveLength(1);
      expect(existsSync(candidatesPath())).toBe(false);
    });

    it("gives the listeners back after a success, a PROBLEM and a thrown error", async () => {
      const start = sigCounts();
      writeExport(["o/a"]);
      await run(["export.json"], okResolver([]));
      expect(sigCounts()).toEqual(start);
      await run(["export.json"], failing("no-git"));
      rmSync(candidatesPath());
      expect(sigCounts()).toEqual(start);
      await expect(run(["export.json"], async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
      expect(sigCounts()).toEqual(start);
    });
  });
});
