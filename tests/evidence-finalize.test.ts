import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, type Config } from "../src/config.js";
import { cancelWaitingRun, resumeRun, runFlow, type RunSummary } from "../src/engine/runner.js";
import { loadRun } from "../src/engine/state.js";
import { canonicalHash } from "../src/evidence/canonical.js";
import { readEvidenceChain, splitEvidenceLines } from "../src/evidence/chain.js";
import { finalizeRunEvidence, storeRunDiff } from "../src/evidence/finalize.js";
import { sha256Hex } from "../src/evidence/identity.js";
import { readRunEvidence } from "../src/evidence/parse.js";
import type { RunEvidence } from "../src/evidence/schema.js";
import { parseFlow } from "../src/flow/load.js";

const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
const cfg = (over: Record<string, unknown> = {}): Config => ConfigSchema.parse({ protected_branches: [], ...over });
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
let tmp: string;
let repo: string;
let runsDir: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "evidence-final-"));
  repo = join(tmp, "repo");
  runsDir = join(tmp, "runs");
  mkdirSync(repo);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const start = (yaml: string, o: Partial<Parameters<typeof runFlow>[1]> = {}) => runFlow(parseFlow(yaml), { task: "the task with sk-secret-in-task", repo, runsDir, claudeBin, config: cfg(), ...o });
const manifestText = (s: Pick<RunSummary, "runDir">) => readFileSync(join(s.runDir, "evidence.json"), "utf8");
const manifest = (s: Pick<RunSummary, "runDir">): RunEvidence => {
  const read = readRunEvidence(manifestText(s));
  if (read.state !== "ok") throw new Error(`manifest ${read.state}`);
  return read.evidence;
};
const hasManifest = (s: Pick<RunSummary, "runDir">) => existsSync(join(s.runDir, "evidence.json"));
const chain = (s: Pick<RunSummary, "runDir" | "runId">) => readEvidenceChain(splitEvidenceLines(readFileSync(join(s.runDir, "evidence.jsonl"), "utf8")).lines, s.runId);
const liveLog = (s: Pick<RunSummary, "runDir">) => readFileSync(join(s.runDir, "live.log"), "utf8");

const TWO = `
name: two
workspace: inplace
steps:
  - {id: write, type: claude, prompt: "WRITE out.txt hello"}
  - {id: run_tests, type: shell, run: "grep -q hello out.txt && echo found"}
`;
const COMMIT = `
name: commit
workspace: inplace
steps:
  - {id: change, type: shell, run: "echo changed > file.txt && git add file.txt && git -c user.name=T -c user.email=t@example.com commit -qm change"}
`;
const APPROVE = `
name: ap
workspace: inplace
steps:
  - {id: a, type: shell, run: echo one}
  - {id: ok, type: approval, message: "go on?"}
  - {id: b, type: shell, run: "test -f {{workdir}}/pass"}
`;

describe("finalizing a run", () => {
  it("writes a manifest from the chain when the run ends: terminal hash, files, flow hash, models, tests", async () => {
    const s = await start(TWO);
    expect(s.status).toBe("succeeded");
    const read = chain(s);
    expect(read.ok).toBe(true);
    const m = manifest(s);
    expect(m).toMatchObject({ version: 1, runId: s.runId, status: "succeeded", flow: { name: "two" }, events: { path: "evidence.jsonl", count: read.events.length, terminalHash: read.events.at(-1)!.hash }, git: {}, policies: [], approvals: [] });
    expect(m.startedAt).toBe(read.events[0]!.time);
    expect(m.finishedAt).toBe(read.events.at(-1)!.time);
    expect(Date.parse(m.finalizedAt)).toBeGreaterThanOrEqual(Date.parse(m.finishedAt));
    // the flow hash is the hash of the definition that is stored with the run
    expect(m.flow.sha256).toBe(canonicalHash(JSON.parse(readFileSync(join(s.runDir, "run.json"), "utf8")).flowDef));
    expect(m.models).toEqual([{ agent: "claude", provider: "anthropic", model: "default" }]);
    expect(m.tests).toEqual([{ step: { id: "run_tests", visit: 1, type: "shell" }, result: { suite: "run_tests", outcome: "passed" } }]);
    expect(m.artifacts).toEqual(s.history.map((h, i) => {
      const bytes = readFileSync(h.logFile);
      return { kind: i === 0 ? "transcript" : "log", path: `logs/${i === 0 ? "001-write" : "002-run_tests"}.log`, sha256: sha256Hex(bytes), bytes: bytes.length, required: true };
    }));
    expect(m.diff).toBeUndefined();
    // names, ids and hashes only: nothing of the task, the prompt, an output or a path of this machine
    for (const word of ["sk-secret-in-task", "hello", "found", "WRITE", tmp]) expect(manifestText(s)).not.toContain(word);
    expect(Object.keys(JSON.parse(readFileSync(join(s.runDir, "run.json"), "utf8"))).filter((k) => /evidence|manifest/i.test(k))).toEqual([]);
    expect(readdirSync(s.runDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("gives the same manifest again, except for the time it was written", async () => {
    const s = await start(TWO);
    const first = manifest(s);
    const again = finalizeRunEvidence(s, { now: () => new Date("2031-05-05T05:05:05.000Z") });
    expect(again.state).toBe("written");
    const second = manifest(s);
    expect(second.finalizedAt).toBe("2031-05-05T05:05:05.000Z");
    expect({ ...second, finalizedAt: "" }).toEqual({ ...first, finalizedAt: "" });
    expect(manifestText(s).replace(second.finalizedAt, first.finalizedAt)).toBe(JSON.stringify(first, null, 2) + "\n");
    // a clock that was set back never gives a time before the end of the run
    finalizeRunEvidence(s, { now: () => new Date("2001-01-01T00:00:00.000Z") });
    expect(manifest(s).finalizedAt).toBe(first.finishedAt);
  });

  it("has the base and final commit and the hash of the stored diff of a run that changed code", async () => {
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "file.txt"), "first\n");
    git(repo, "add", "file.txt");
    git(repo, "commit", "-qm", "first");
    const base = git(repo, "rev-parse", "HEAD");
    const s = await start(COMMIT, { vars: { github_repo: "acme/app", pr: "12" } });
    expect(s.status).toBe("succeeded");
    const final = git(repo, "rev-parse", "HEAD");
    expect(final).not.toBe(base);
    const m = manifest(s);
    expect(m.git).toEqual({ repository: "acme/app", base, final });
    expect(m.pullRequest).toEqual({ repository: "acme/app", number: 12, url: "https://github.com/acme/app/pull/12" });
    const diff = readFileSync(join(s.runDir, "evidence.diff"));
    expect(diff.toString()).toContain("-first\n+changed\n");
    expect(m.diff).toEqual({ kind: "diff", path: "evidence.diff", sha256: sha256Hex(diff), bytes: diff.length, required: false });
    // made again from the same two commits, it is the same file
    expect(storeRunDiff(s, base, final)).toEqual(m.diff);
    // no diff, and no old file, when it cannot be made
    expect(storeRunDiff(s, base, "0".repeat(40))).toBeUndefined();
    expect(existsSync(join(s.runDir, "evidence.diff"))).toBe(false);
    expect(storeRunDiff(s, base, undefined)).toBeUndefined();
    expect(storeRunDiff({ runDir: s.runDir, workdir: join(tmp, "gone") }, base, final)).toBeUndefined();
    expect(storeRunDiff(s, base, final, join(tmp, "no-such-git"))).toBeUndefined();
  });

  it("finalizes a failed and a cancelled run, and not a run that waits or stopped", async () => {
    const failed = await start("name: f\nworkspace: inplace\nsteps:\n  - {id: a, type: shell, run: exit 3}\n");
    expect(manifest(failed)).toMatchObject({ status: "failed", events: { count: 5 } });

    const waiting = await start(APPROVE);
    expect(waiting.status).toBe("waiting");
    expect(hasManifest(waiting)).toBe(false);
    expect(finalizeRunEvidence(waiting)).toEqual({ state: "none" });
    expect(liveLog(waiting)).not.toContain("evidence:");

    cancelWaitingRun(runsDir, waiting.runId, cfg(), { kind: "cli" });
    expect(manifest(waiting)).toMatchObject({ status: "cancelled", events: { terminalHash: chain(waiting).events.at(-1)!.hash } });
  });

  it("a resumed run keeps its events, has no manifest while it goes on, and gets a new one at its new end", async () => {
    const s = await start(APPROVE);
    const r1 = await resumeRun({ runId: s.runId, runsDir, claudeBin, config: cfg(), decision: { approved: true }, actor: { kind: "cli" } });
    expect(r1.status).toBe("failed"); // step b: the file is not there yet
    const first = manifest(r1);
    const before = readFileSync(join(r1.runDir, "evidence.jsonl"), "utf8");
    expect(first).toMatchObject({ status: "failed", approvals: [{ decision: "approved", by: { kind: "cli" } }] });

    writeFileSync(join(repo, "pass"), "");
    let during: boolean | undefined;
    const r2 = await resumeRun({ runId: s.runId, runsDir, claudeBin, config: cfg(), from: "b", log: (l) => void (l.startsWith("▶ b") && (during = hasManifest(r1))) });
    expect(during).toBe(false);
    expect(r2.status).toBe("succeeded");
    const after = readFileSync(join(r2.runDir, "evidence.jsonl"), "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(chain(r2).ok).toBe(true);
    const second = manifest(r2);
    expect(second.status).toBe("succeeded");
    expect(second.startedAt).toBe(first.startedAt);
    expect(second.events.count).toBeGreaterThan(first.events.count);
    expect(second.events.terminalHash).not.toBe(first.events.terminalHash);
    // the first end is still in the chain, at the place the first manifest named
    expect(chain(r2).events[first.events.count - 1]).toMatchObject({ type: "run.failed", hash: first.events.terminalHash });
    expect(second.approvals).toEqual(first.approvals);
    expect(second.artifacts.length).toBeGreaterThan(first.artifacts.length);
  });

  it("says so and leaves no manifest when the run cannot be finalized", async () => {
    const s = await start(TWO);
    const good = readFileSync(join(s.runDir, "evidence.jsonl"), "utf8");
    const lines = good.split("\n");
    const check = (why: RegExp, mark = "!") => {
      writeFileSync(join(s.runDir, "evidence.jsonl"), good);
      finalizeRunEvidence(s); // a manifest is there before each case
      writeFileSync(join(s.runDir, "live.log"), "");
      expect(hasManifest(s)).toBe(true);
      return (text: string | null, run: RunSummary = s) => {
        if (text === null) rmSync(join(s.runDir, "evidence.jsonl"));
        else writeFileSync(join(s.runDir, "evidence.jsonl"), text);
        const res = finalizeRunEvidence(run);
        expect(res.state).toBe("none");
        expect((res as { reason?: string }).reason).toMatch(why);
        expect(hasManifest(s)).toBe(false);
        const said = liveLog(s).split("\n").filter(Boolean);
        expect(said).toHaveLength(1);
        expect(said[0]).toMatch(mark === "!" ? /^! evidence: no manifest was written \(.*\); this run cannot be verified$/ : /^· evidence: no manifest \(/);
        expect(said[0]).not.toContain(tmp);
      };
    };
    check(/not an unbroken chain \(line 3: /)(good.replace('"id":"write"', '"id":"wrote"'));
    check(/not an unbroken chain \(line 2: /)([lines[0], ...lines.slice(2)].join("\n"));
    check(/do not end with the end of the run/)(lines.slice(0, -2).join("\n") + "\n");
    check(/cut off/)(good.slice(0, -1));
    check(/another status/)(good, { ...s, status: "failed" });
    check(/no event stream/, "·")(null);
    writeFileSync(join(s.runDir, "evidence.jsonl"), good);

    // the place of the manifest cannot be written
    rmSync(join(s.runDir, "evidence.json"), { force: true });
    mkdirSync(join(s.runDir, "evidence.json", "sub"), { recursive: true });
    writeFileSync(join(s.runDir, "live.log"), "");
    expect(finalizeRunEvidence(s)).toMatchObject({ state: "none", reason: expect.stringMatching(/could not be written \(E[A-Z]+\)/) });
    expect(liveLog(s)).toMatch(/^! evidence: no manifest was written/);
    rmSync(join(s.runDir, "evidence.json"), { recursive: true, force: true });
    expect(finalizeRunEvidence(s).state).toBe("written");

    // the stream stopped earlier in the run: never a manifest, whatever the file holds now
    const stopped = check(/stopped earlier/, "·");
    writeFileSync(join(s.runDir, "evidence.incomplete"), "");
    stopped(good);
    // none of this changed the run
    expect(loadRun(runsDir, s.runId)?.status).toBe("succeeded");
  });

  it("a run whose evidence could not be written ends as before, with no manifest and one loud line", async () => {
    const runId = "20260131-120000-bbbb";
    mkdirSync(join(runsDir, runId, "evidence.jsonl"), { recursive: true });
    const s = await start(TWO, { runId });
    expect(s.status).toBe("succeeded");
    expect(hasManifest(s)).toBe(false);
    expect(liveLog(s).match(/! evidence:/g)).toHaveLength(1);
    expect(liveLog(s)).toMatch(/· evidence: no manifest \(the evidence of this run stopped earlier\)/);
    // a later start does not continue it either
    const r = await resumeRun({ runId, runsDir, claudeBin, config: cfg(), from: "run_tests" });
    expect(r.status).toBe("succeeded");
    expect(hasManifest(r)).toBe(false);
  });

  it("a run of an older version that is resumed gets events but no manifest", async () => {
    const s = await start(TWO);
    rmSync(join(s.runDir, "evidence.jsonl"));
    rmSync(join(s.runDir, "evidence.json"));
    const r = await resumeRun({ runId: s.runId, runsDir, claudeBin, config: cfg(), from: "run_tests" });
    expect(r.status).toBe("succeeded");
    expect(chain(r).ok).toBe(true);
    expect(hasManifest(r)).toBe(false);
    expect(liveLog(r)).toMatch(/· evidence: no manifest \(the events do not begin with the start of the run/);
    expect(liveLog(r)).not.toContain("! evidence");
  });
});
