import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { resumeRun, runFlow } from "../src/engine/runner.js";
import { EVIDENCE_USAGE, evidenceCommand, verifyExitCode, verifyReport } from "../src/evidence/cli.js";
import { readEvidenceChain } from "../src/evidence/chain.js";
import { parseRunEvidence } from "../src/evidence/parse.js";
import { VERIFY_CHECKS, verifyEvidence, verifyRunEvidence, type VerifyResult } from "../src/evidence/verify.js";
import { parseFlow } from "../src/flow/load.js";
import { FIXTURE_FILES, FIXTURE_FLOW, FIXTURE_RUN_ID, fixtureChain, fixtureManifest, writeEvidenceFixture } from "./fixtures/evidence-runs.js";

const ID = FIXTURE_RUN_ID;
let tmp: string;
let runsDir: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "evidence-verify-"));
  runsDir = join(tmp, "runs");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const states = (r: VerifyResult) => Object.fromEntries(r.checks.map((c) => [c.name, c.state]));
const edit = (file: string, change: (text: string) => string) => writeFileSync(file, change(readFileSync(file, "utf8")));
const manifestOf = (runDir: string, change: (m: Record<string, any>) => void) => edit(join(runDir, "evidence.json"), (t) => {
  const m = JSON.parse(t) as Record<string, any>;
  change(m);
  return JSON.stringify(m, null, 2) + "\n";
});

describe("the fixtures", () => {
  it("are what the Foundry itself reads: a chain, and a manifest of the current version", () => {
    const { lines, terminalHash } = fixtureChain();
    expect(readEvidenceChain(lines, ID)).toMatchObject({ ok: true, terminalHash });
    expect(parseRunEvidence(fixtureManifest())).toMatchObject({ runId: ID, status: "succeeded" });
  });
});

describe("verifyRunEvidence", () => {
  it("verifies a valid run and gives a result a program can read", () => {
    const r = verifyRunEvidence(writeEvidenceFixture(runsDir, "valid"), ID);
    expect(r).toEqual({
      version: 1,
      runId: ID,
      status: "verified",
      verified: true,
      explanation: "Verified: 8 events in an unbroken chain, 3 files unchanged.",
      checks: VERIFY_CHECKS.map((name) => ({ name, state: "passed" })),
      manifest: { sha256: expect.stringMatching(/^[0-9a-f]{64}$/), status: "succeeded", finalizedAt: "2026-01-31T12:00:02.600Z" },
      events: { count: 8, terminalHash: fixtureChain().terminalHash },
      files: [
        { kind: "transcript", path: "logs/001-code.log", required: true, state: "ok" },
        { kind: "log", path: "logs/002-run_tests.log", required: true, state: "ok" },
        { kind: "diff", path: "evidence.diff", required: false, state: "ok" },
      ],
      missingOptional: [],
    });
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
    expect(verifyExitCode(r)).toBe(0);
  });

  it("fails on a changed event and names the line", () => {
    const r = verifyRunEvidence(writeEvidenceFixture(runsDir, "changed-event"), ID);
    expect(r).toMatchObject({ status: "failed", verified: false, failure: { check: "chain", code: "chain-hash", line: 5 }, events: { count: 4 }, files: [] });
    expect(r.explanation).toBe("Not verified: evidence.jsonl, line 5: was changed (its hash is not the hash of its content).");
    expect(states(r)).toEqual({ manifest: "passed", events: "passed", chain: "failed", terminal: "skipped", content: "skipped", flow: "skipped", files: "skipped" });
    expect(verifyExitCode(r)).toBe(1);
  });

  it("fails on a missing required file, and only notes a missing optional one", () => {
    const required = verifyRunEvidence(writeEvidenceFixture(runsDir, "missing-file"), ID);
    expect(required).toMatchObject({ status: "failed", failure: { check: "files", code: "file-missing", path: "logs/002-run_tests.log" }, missingOptional: [] });
    expect(required.explanation).toBe("Not verified: logs/002-run_tests.log is not there, and the evidence needs it.");
    expect(required.files.map((f) => f.state)).toEqual(["ok", "missing", "ok"]);

    const runDir = writeEvidenceFixture(runsDir, "valid");
    rmSync(join(runDir, "evidence.diff"));
    const optional = verifyRunEvidence(runDir, ID);
    expect(optional).toMatchObject({ status: "verified", verified: true, missingOptional: ["evidence.diff"] });
    expect(optional.failure).toBeUndefined();
    expect(optional.files.at(-1)).toEqual({ kind: "diff", path: "evidence.diff", required: false, state: "missing" });
    expect(optional.explanation).toBe("Verified: 8 events in an unbroken chain, 2 files unchanged. 1 optional file is no longer there (evidence.diff); that is allowed.");
    // both at once: the required one is the failure, the optional one is still only noted
    rmSync(join(runDir, "logs", "001-code.log"));
    expect(verifyRunEvidence(runDir, ID)).toMatchObject({ status: "failed", failure: { code: "file-missing", path: "logs/001-code.log" }, missingOptional: ["evidence.diff"] });
  });

  it("says a run from before evidence has nothing to verify", () => {
    const r = verifyRunEvidence(writeEvidenceFixture(runsDir, "old"), ID);
    expect(r).toMatchObject({ status: "absent", verified: false, files: [], missingOptional: [] });
    expect(r.failure).toBeUndefined();
    expect(r.manifest).toBeUndefined();
    expect(new Set(Object.values(states(r)))).toEqual(new Set(["skipped"]));
    expect(r.explanation).toMatch(/^This run has no evidence/);
    expect(verifyExitCode(r)).toBe(2);
    // a folder that is not there at all reads the same
    expect(verifyRunEvidence(join(runsDir, "nothing"), "nothing").status).toBe("absent");
  });

  it("fails when a transcript, a log or the diff was changed, also by one byte and also the optional one", () => {
    for (const path of Object.keys(FIXTURE_FILES)) {
      const runDir = writeEvidenceFixture(runsDir, "valid");
      edit(join(runDir, path), (t) => t.replace(/e/, "E"));
      const r = verifyRunEvidence(runDir, ID);
      expect(r, path).toMatchObject({ status: "failed", failure: { check: "files", code: "file-changed", path } });
      expect(r.explanation, path).toBe(`Not verified: ${path} was changed.`);
      expect(r.files.find((f) => f.path === path)?.state, path).toBe("changed");
      edit(join(runDir, path), () => FIXTURE_FILES[path as keyof typeof FIXTURE_FILES] + "more\n");
      expect(verifyRunEvidence(runDir, ID).failure, path).toMatchObject({ code: "file-changed", path });
    }
  });

  it("finds every other way the evidence can be wrong, at the first check that sees it", () => {
    const extra = () => fixtureChain([...Array(8).fill(null).map((_, i) => JSON.parse(fixtureChain().lines[i]!) as Record<string, unknown>).map(({ hash: _h, prevHash: _p, id: _i, seq: _s, version: _v, runId: _r, ...body }) => body), { type: "run.resumed", time: "2026-01-31T13:00:00.000Z", from: "code", by: { kind: "cli" } }]).lines;
    const rewritten = () => fixtureChain(fixtureChain().lines.map((l) => JSON.parse(l) as Record<string, unknown>).map(({ hash: _h, prevHash: _p, id: _i, seq: _s, version: _v, runId: _r, ...body }) => (body.type === "step.completed" && body.exitCode === 0 ? { ...body, exitCode: 1 } : body))).lines;
    const cases: [string, (runDir: string) => void, string, string][] = [
      ["a status changed in the manifest", (d) => manifestOf(d, (m) => (m.status = "failed")), "content", "manifest-changed"],
      ["a file taken out of the manifest", (d) => manifestOf(d, (m) => m.artifacts.pop()), "content", "manifest-changed"],
      ["a test result changed in the manifest", (d) => manifestOf(d, (m) => (m.tests[0].result.outcome = "failed")), "content", "manifest-changed"],
      ["a commit changed in the manifest", (d) => manifestOf(d, (m) => (m.git.final = "c".repeat(40))), "content", "manifest-changed"],
      ["a model added to the manifest", (d) => manifestOf(d, (m) => m.models.push({ agent: "codex", provider: "openai", model: "gpt-5" })), "content", "manifest-changed"],
      ["another last hash in the manifest", (d) => manifestOf(d, (m) => (m.events.terminalHash = "0".repeat(64))), "terminal", "terminal-hash"],
      ["another count in the manifest", (d) => manifestOf(d, (m) => (m.events.count = 7)), "terminal", "events-added"],
      ["an event added after the manifest (the run went on)", (d) => writeFileSync(join(d, "evidence.jsonl"), extra().map((l) => `${l}\n`).join("")), "terminal", "events-added"],
      ["the last event removed", (d) => edit(join(d, "evidence.jsonl"), (t) => t.split("\n").slice(0, 7).join("\n") + "\n"), "terminal", "events-removed"],
      ["every event written again with new hashes", (d) => writeFileSync(join(d, "evidence.jsonl"), rewritten().map((l) => `${l}\n`).join("")), "terminal", "terminal-hash"],
      ["two events the other way round", (d) => edit(join(d, "evidence.jsonl"), (t) => { const l = t.split("\n"); return [l[0], l[2], l[1], ...l.slice(3)].join("\n"); }), "chain", "chain-order"],
      ["an event removed from the middle", (d) => edit(join(d, "evidence.jsonl"), (t) => t.split("\n").filter((_, i) => i !== 3).join("\n")), "chain", "chain-order"],
      ["a space in a line", (d) => edit(join(d, "evidence.jsonl"), (t) => t.replace('"seq":2', '"seq": 2')), "chain", "chain-not-canonical"],
      ["an event of a newer version", (d) => edit(join(d, "evidence.jsonl"), (t) => t.replace('"version":1}', '"version":9}')), "chain", "chain-unsupported-version"],
      ["a last line that was cut off", (d) => edit(join(d, "evidence.jsonl"), (t) => t.slice(0, -1)), "events", "events-cut"],
      ["no event file", (d) => rmSync(join(d, "evidence.jsonl")), "events", "events-missing"],
      ["a folder in place of the event file", (d) => (rmSync(join(d, "evidence.jsonl")), mkdirSync(join(d, "evidence.jsonl"))), "events", "events-unreadable"],
      ["a link in place of the event file", (d) => (writeFileSync(join(d, "copy"), readFileSync(join(d, "evidence.jsonl"))), rmSync(join(d, "evidence.jsonl")), symlinkSync(join(d, "copy"), join(d, "evidence.jsonl"))), "events", "events-unreadable"],
      ["a manifest that is not JSON", (d) => writeFileSync(join(d, "evidence.json"), "{"), "manifest", "manifest-unreadable"],
      ["a manifest with an unknown field", (d) => manifestOf(d, (m) => (m.note = "fine")), "manifest", "manifest-unreadable"],
      ["a manifest of a newer version", (d) => manifestOf(d, (m) => (m.version = 2)), "manifest", "manifest-version"],
      ["a manifest of another run", (d) => manifestOf(d, (m) => (m.runId = "other-run")), "manifest", "manifest-run"],
      ["the mark that events were lost", (d) => writeFileSync(join(d, "evidence.incomplete"), ""), "manifest", "incomplete"],
      ["a changed flow definition", (d) => edit(join(d, "run.json"), (t) => t.replace("npm test", "true")), "flow", "flow-changed"],
      ["another flow hash in the manifest", (d) => manifestOf(d, (m) => (m.flow.sha256 = "0".repeat(64))), "flow", "flow-changed"],
      ["no run.json", (d) => rmSync(join(d, "run.json")), "flow", "flow-missing"],
      ["a run.json that is not JSON", (d) => writeFileSync(join(d, "run.json"), "{"), "flow", "flow-missing"],
      ["a link in place of a log", (d) => (writeFileSync(join(d, "copy.log"), FIXTURE_FILES["logs/001-code.log"]), rmSync(join(d, "logs", "001-code.log")), symlinkSync(join(d, "copy.log"), join(d, "logs", "001-code.log"))), "files", "file-unreadable"],
      ["a folder in place of a log", (d) => (rmSync(join(d, "logs", "001-code.log")), mkdirSync(join(d, "logs", "001-code.log"))), "files", "file-unreadable"],
      ["a linked logs folder with the same files", (d) => (execFileSync("mv", [join(d, "logs"), join(tmp, "elsewhere")]), symlinkSync(join(tmp, "elsewhere"), join(d, "logs"))), "files", "file-unreadable"],
      ["another hash for the diff in the manifest", (d) => manifestOf(d, (m) => (m.diff.sha256 = "0".repeat(64))), "files", "file-changed"],
    ];
    for (const [name, change, check, code] of cases) {
      rmSync(tmp, { recursive: true, force: true });
      const runDir = writeEvidenceFixture(runsDir, "valid");
      expect(verifyRunEvidence(runDir, ID).status, name).toBe("verified");
      change(runDir);
      const r = verifyRunEvidence(runDir, ID);
      expect(r, name).toMatchObject({ status: "failed", verified: false, failure: { check, code } });
      expect(r.explanation, name).toBe(`Not verified: ${r.failure!.message}.`);
      expect(r.explanation, name).not.toContain(tmp);
      expect(r.checks.filter((c) => c.state === "failed").map((c) => c.name), name).toEqual([check]);
      const at = VERIFY_CHECKS.indexOf(check as never);
      expect(r.checks.map((c) => c.state), name).toEqual(VERIFY_CHECKS.map((_, i) => (i < at ? "passed" : i === at ? "failed" : "skipped")));
    }
  });

  it("says a run without a manifest is not finalized, and still finds a broken chain in it", () => {
    const runDir = writeEvidenceFixture(runsDir, "valid");
    rmSync(join(runDir, "evidence.json"));
    const r = verifyRunEvidence(runDir, ID);
    expect(r).toMatchObject({ status: "not-finalized", verified: false, events: { count: 8 } });
    expect(r.failure).toBeUndefined();
    expect(r.explanation).toBe("Not verified: the run has 8 events in an unbroken chain but no manifest. It has not ended, or it could not be finalized.");
    expect(verifyExitCode(r)).toBe(2);
    // a run that was interrupted in the middle of a line is the same
    edit(join(runDir, "evidence.jsonl"), (t) => t.slice(0, -30));
    expect(verifyRunEvidence(runDir, ID)).toMatchObject({ status: "not-finalized", events: { count: 7 } });
    edit(join(runDir, "evidence.jsonl"), (t) => t.replace('"durationMs":1200', '"durationMs":1'));
    expect(verifyRunEvidence(runDir, ID)).toMatchObject({ status: "failed", failure: { code: "chain-hash", line: 5 } });
  });
});

describe("verifyEvidence", () => {
  const input = (over: Partial<Parameters<typeof verifyEvidence>[0]> = {}): Parameters<typeof verifyEvidence>[0] => ({
    runId: ID,
    manifest: { state: "ok", text: JSON.stringify(fixtureManifest()) },
    events: { state: "ok", text: fixtureChain().lines.map((l) => `${l}\n`).join("") },
    incomplete: false,
    flowDef: FIXTURE_FLOW,
    file: (path) => {
      const text = FIXTURE_FILES[path as keyof typeof FIXTURE_FILES];
      return text === undefined ? { state: "missing" } : { state: "ok", sha256: (fixtureManifest().artifacts as { path: string; sha256: string }[]).concat([fixtureManifest().diff as { path: string; sha256: string }]).find((a) => a.path === path)!.sha256, bytes: Buffer.byteLength(text) };
    },
    ...over,
  });

  it("works on texts alone: no file, no model, no network", () => {
    expect(verifyEvidence(input()).status).toBe("verified");
    expect(verifyEvidence(input({ file: () => ({ state: "missing" }) }))).toMatchObject({ status: "failed", failure: { code: "file-missing", path: "logs/001-code.log" }, missingOptional: ["evidence.diff"] });
    expect(verifyEvidence(input({ file: () => ({ state: "ok", sha256: "0".repeat(64), bytes: 1 }) })).failure).toMatchObject({ code: "file-changed" });
    expect(verifyEvidence(input({ manifest: { state: "unreadable" } })).failure).toMatchObject({ code: "manifest-unreadable" });
    expect(verifyEvidence(input({ flowDef: undefined })).failure).toMatchObject({ code: "flow-missing" });
    expect(verifyEvidence(input({ flowDef: { ...FIXTURE_FLOW, name: "other" } })).failure).toMatchObject({ code: "flow-changed" });
    expect(verifyEvidence(input({ runId: "another" })).failure).toMatchObject({ code: "manifest-run" });
  });

  it("never throws, whatever it is given", () => {
    const junk = ["", "\n", "null", "[]", "{}", "\u0000", '{"version":1}', "x".repeat(5000), '{"a":1e999}'];
    for (const m of junk) {
      for (const e of junk) {
        const r = verifyEvidence(input({ manifest: { state: "ok", text: m }, events: { state: "ok", text: e }, flowDef: 1n, file: () => { throw new Error("no"); } } as never));
        expect(r.verified, `${m} / ${e}`).toBe(false);
        expect(r.explanation.length).toBeGreaterThan(10);
      }
    }
    expect(verifyEvidence(input({ flowDef: 1n })).failure).toMatchObject({ code: "flow-changed" });
    expect(verifyEvidence(input({ file: () => { throw new Error("no"); } })).failure).toMatchObject({ code: "file-unreadable", path: "logs/001-code.log" });
  });
});

describe("a run of the engine", () => {
  const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
  const config = ConfigSchema.parse({ protected_branches: [] });
  const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" };
  const FLOW = `
name: real
workspace: inplace
steps:
  - {id: code, type: claude, prompt: "WRITE file.txt changed"}
  - {id: commit, type: shell, run: "git add file.txt && git -c user.name=T -c user.email=t@example.com commit -qm change"}
  - {id: run_tests, type: shell, run: "test -f {{workdir}}/pass"}
`;

  it("verifies as it was written, fails after a change to a transcript, a log or the diff, and verifies again after a resume", async () => {
    const repo = join(tmp, "repo");
    mkdirSync(repo);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: GIT_ENV });
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "file.txt"), "first\n");
    writeFileSync(join(repo, ".gitignore"), "pass\n");
    git("add", ".");
    git("commit", "-qm", "first");

    const failed = await runFlow(parseFlow(FLOW), { task: "t", repo, runsDir, claudeBin, config });
    expect(failed.status).toBe("failed");
    const first = verifyRunEvidence(failed.runDir, failed.runId);
    expect(first).toMatchObject({ status: "verified", manifest: { status: "failed" } });
    expect(first.files.map((f) => [f.kind, f.state])).toEqual([["transcript", "ok"], ["log", "ok"], ["log", "ok"]]);

    writeFileSync(join(repo, "pass"), "");
    const s = await resumeRun({ runId: failed.runId, runsDir, claudeBin, config, from: "run_tests" });
    expect(s.status).toBe("succeeded");
    const ok = verifyRunEvidence(s.runDir, s.runId);
    expect(ok).toMatchObject({ status: "verified", verified: true, manifest: { status: "succeeded" }, missingOptional: [] });
    expect(ok.events!.count).toBeGreaterThan(first.events!.count);
    expect(ok.files.at(-1)).toEqual({ kind: "diff", path: "evidence.diff", required: false, state: "ok" });

    for (const path of ["logs/001-code.log", "logs/002-commit.log", "evidence.diff"]) {
      const before = readFileSync(join(s.runDir, path));
      writeFileSync(join(s.runDir, path), Buffer.concat([before, Buffer.from(" ")]));
      expect(verifyRunEvidence(s.runDir, s.runId), path).toMatchObject({ status: "failed", failure: { code: "file-changed", path } });
      writeFileSync(join(s.runDir, path), before);
      expect(verifyRunEvidence(s.runDir, s.runId).status, path).toBe("verified");
    }
    // the diff may be removed later (it can be made again); a log may not
    rmSync(join(s.runDir, "evidence.diff"));
    expect(verifyRunEvidence(s.runDir, s.runId)).toMatchObject({ status: "verified", missingOptional: ["evidence.diff"] });
    rmSync(join(s.runDir, "logs", "002-commit.log"));
    expect(verifyRunEvidence(s.runDir, s.runId)).toMatchObject({ status: "failed", failure: { code: "file-missing", path: "logs/002-commit.log" } });
    // verifying wrote nothing
    expect(existsSync(join(s.runDir, "evidence.diff"))).toBe(false);
  });

  it("does not verify a run that waits: it has events but no manifest", async () => {
    const repo = join(tmp, "repo2");
    mkdirSync(repo);
    const s = await runFlow(parseFlow("name: w\nworkspace: inplace\nsteps:\n  - {id: a, type: shell, run: echo one}\n  - {id: ok, type: approval, message: \"go?\"}\n"), { task: "t", repo, runsDir, claudeBin, config });
    expect(s.status).toBe("waiting");
    expect(verifyRunEvidence(s.runDir, s.runId)).toMatchObject({ status: "not-finalized", verified: false });
  });
});

describe("scf evidence verify", () => {
  const call = (args: string[], json = false) => {
    const out: string[] = [];
    const code = evidenceCommand(args, { runsDir, json }, (l) => out.push(l));
    return { code, out };
  };

  it("prints the result for a person and gives the exit code", () => {
    const runDir = writeEvidenceFixture(runsDir, "valid");
    const ok = call(["verify", ID]);
    expect(ok.code).toBe(0);
    expect(ok.out[0]).toBe(`✔ verified · run ${ID}`);
    expect(ok.out[1]).toBe("  Verified: 8 events in an unbroken chain, 3 files unchanged.");
    expect(ok.out.join("\n")).toMatch(/events: {4}8, last hash [0-9a-f]{64}\n {2}manifest: {2}sha256 [0-9a-f]{64} \(succeeded, written 2026-01-31T12:00:02\.600Z\)$/);

    edit(join(runDir, "logs", "002-run_tests.log"), () => "0 tests passed\n");
    rmSync(join(runDir, "evidence.diff"));
    const bad = call(["verify", ID]);
    expect(bad.code).toBe(1);
    expect(bad.out.slice(0, 3)).toEqual([`✘ not verified · run ${ID}`, "  Not verified: logs/002-run_tests.log was changed.", "  check:     files (file-changed)"]);
    expect(bad.out).toContain("  file:      logs/002-run_tests.log — changed");
    expect(bad.out).toContain("  file:      evidence.diff — missing (optional)");
    expect(bad.out.join("\n")).not.toContain("tests passed");
  });

  it("prints the whole result as JSON with --json", () => {
    writeEvidenceFixture(runsDir, "changed-event");
    const r = call(["verify", ID], true);
    expect(r.code).toBe(1);
    expect(r.out).toHaveLength(1);
    expect(JSON.parse(r.out[0]!)).toEqual(verifyRunEvidence(join(runsDir, ID), ID));
    expect(verifyReport(JSON.parse(r.out[0]!) as VerifyResult)[0]).toBe(`✘ not verified · run ${ID}`);
  });

  it("exits 2 when there is nothing to verify yet", () => {
    const runDir = writeEvidenceFixture(runsDir, "old");
    expect(call(["verify", ID])).toEqual({ code: 2, out: [`· no evidence · run ${ID}`, "  This run has no evidence: it was made before evidence existed, or its evidence was removed by a clean-up. There is nothing to verify."] });
    writeFileSync(join(runDir, "evidence.jsonl"), fixtureChain().lines.slice(0, 3).map((l) => `${l}\n`).join(""));
    const waiting = call(["verify", ID]);
    expect(waiting.code).toBe(2);
    expect(waiting.out[0]).toBe(`■ not finalized · run ${ID}`);
  });

  it("refuses a wrong call, a run id that is a path, and a run that is not there", () => {
    writeEvidenceFixture(runsDir, "valid");
    for (const args of [[], ["verify"], ["show", ID], ["verify", ID, "extra"]]) expect(() => call(args), args.join(" ")).toThrow(EVIDENCE_USAGE);
    for (const id of ["../runs/" + ID, "..", ".", "a/b", `${ID}/`, "a b", "x".repeat(129)]) expect(() => call(["verify", id]), id).toThrow("a run id has only letters, digits, _ and -");
    expect(() => call(["verify", "20260101-000000-none"])).toThrow("run 20260101-000000-none not found");
    writeFileSync(join(runsDir, "a-file"), "");
    expect(() => call(["verify", "a-file"])).toThrow("run a-file not found");
  });

  it("is a command of the built scf", () => {
    const cli = resolve("dist/cli.js");
    if (!existsSync(cli)) throw new Error(`${cli} is missing — run \`npm run build\` first`);
    writeEvidenceFixture(runsDir, "missing-file");
    const env = { ...process.env, FACTORY_HOME: join(tmp, "home") };
    const r = spawnSync(process.execPath, [cli, "evidence", "verify", ID, "--runs-dir", runsDir, "--json"], { encoding: "utf8", env });
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ runId: ID, status: "failed", failure: { code: "file-missing", path: "logs/002-run_tests.log" } });
    const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8", env });
    expect(help.stdout).toContain("scf evidence verify <run-id> [--json]");
  });
});
