import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanRuns } from "../src/clean.js";
import { ConfigSchema } from "../src/config.js";
import { resetRedactCache } from "../src/credentials/redact.js";
import { addCredential, credentialsPath } from "../src/credentials/store.js";
import { runFlow } from "../src/engine/runner.js";
import { loadRun, saveRun } from "../src/engine/state.js";
import { finalizeRunEvidence } from "../src/evidence/finalize.js";
import { EvidenceStream } from "../src/evidence/stream.js";
import { verifyRunEvidence } from "../src/evidence/verify.js";
import { parseFlow } from "../src/flow/load.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";

const SECRET = "tok-Zq7wLm3xPv9sKd2f";
const EVIDENCE = ["evidence.json", "evidence.jsonl", "evidence.diff", "evidence.incomplete"];
let home: string;
let saved: string | undefined;
let kc: FakeKeychain;
let repo: string;
let runsDir: string;

beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "evidence-privacy-"));
  process.env.FACTORY_HOME = home;
  kc = fakeKeychain();
  resetRedactCache();
  repo = join(home, "repo");
  runsDir = join(home, "runs");
  mkdirSync(repo);
});
afterEach(() => {
  kc.remove();
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  resetRedactCache();
  rmSync(home, { recursive: true, force: true });
});

const store = (secret: string) => addCredential({ userId: randomUUID(), type: "token", name: "t", secret }, { ownerOk: () => true });
const breakStore = () => {
  mkdirSync(join(credentialsPath(), ".."), { recursive: true });
  writeFileSync(credentialsPath(), "{ this is not the store");
  resetRedactCache();
};
const config = ConfigSchema.parse({ protected_branches: [] });
const run = (yaml: string, task = "") => runFlow(parseFlow(yaml), { task, repo, runsDir, config });
const read = (dir: string, name: string) => readFileSync(join(dir, name), "utf8");
const FLOW = (name: string) => `name: ${name}\nworkspace: inplace\nsteps:\n  - {id: a, type: shell, run: "echo ${SECRET}"}\n`;

describe("evidence privacy", () => {
  it("hides a stored secret in an event before it is written", () => {
    store(SECRET);
    const dir = join(runsDir, "r1");
    mkdirSync(dir, { recursive: true });
    const said: string[] = [];
    const s = new EvidenceStream(dir, "r1", (l) => said.push(l));
    const event = s.append({ type: "run.created", flow: { name: `flow ${SECRET}` }, by: { kind: "cli" } });
    const text = existsSync(s.file) ? read(dir, "evidence.jsonl") : "";
    expect(text).not.toContain(SECRET);
    expect(said.join("\n")).not.toContain(SECRET);
    expect(event).toMatchObject({ type: "run.created", flow: { name: "flow [redacted]" } });
    expect(text).toContain("flow [redacted]");
    expect(s.hasStopped).toBe(false);
  });

  it("stops the stream when the stored credentials cannot be read, and such a run gets no manifest", () => {
    breakStore();
    const dir = join(runsDir, "r1");
    mkdirSync(dir, { recursive: true });
    const said: string[] = [];
    const s = new EvidenceStream(dir, "r1", (l) => said.push(l));
    expect(s.append({ type: "run.started" })).toBeUndefined();
    expect(s.hasStopped).toBe(true);
    expect(existsSync(join(dir, "evidence.incomplete"))).toBe(true);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("the stored credentials cannot be read");
    expect(read(dir, "evidence.jsonl")).toBe("");
  });

  it("keeps a stored secret out of the events, the manifest and the lines evidence writes to the live log", async () => {
    store(SECRET);
    const s = await run(FLOW("plain"), `do it with ${SECRET}`);
    expect(s.status).toBe("succeeded");
    expect(existsSync(join(s.runDir, "evidence.json"))).toBe(true);
    for (const name of ["evidence.jsonl", "evidence.json"]) expect(read(s.runDir, name)).not.toContain(SECRET);
    expect(read(s.runDir, "live.log").split("\n").filter((l) => l.includes("evidence:")).join("\n")).not.toContain(SECRET);
    expect(verifyRunEvidence(s.runDir, s.runId).status).toBe("verified");
  });

  it("writes no manifest when the events hold a secret that was stored later, and never names it", async () => {
    const s = await run(FLOW("zzlatersecret"));
    expect(existsSync(join(s.runDir, "evidence.json"))).toBe(true);
    store("zzlatersecret");
    resetRedactCache();
    const said: string[] = [];
    const again = finalizeRunEvidence(loadRun(runsDir, s.runId)!, { report: (l) => said.push(l) });
    expect(again).toEqual({ state: "none", reason: "the event stream holds a stored secret" });
    expect(existsSync(join(s.runDir, "evidence.json"))).toBe(false);
    expect(said.join("\n")).not.toContain("zzlatersecret");
  });

  it("writes no manifest when the stored credentials cannot be read", async () => {
    const s = await run(FLOW("plain"));
    breakStore();
    const again = finalizeRunEvidence(loadRun(runsDir, s.runId)!, { report: () => {} });
    expect(again.state).toBe("none");
    expect(again).toMatchObject({ reason: expect.stringContaining("the stored credentials cannot be read") });
    expect(existsSync(join(s.runDir, "evidence.json"))).toBe(false);
  });
});

describe("evidence retention", () => {
  const age = (runId: string, days: number) => {
    const s = loadRun(runsDir, runId)!;
    s.finishedAt = new Date(Date.now() - days * 86_400_000).toISOString();
    saveRun(s);
  };
  const files = (dir: string) => EVIDENCE.filter((n) => existsSync(join(dir, n)));

  it("leaves evidence alone without the option, and with it removes all evidence of an old run but keeps the run", async () => {
    const old = await run(FLOW("plain"));
    const recent = await run(FLOW("plain"));
    age(old.runId, 10);
    const before = files(old.runDir);
    expect(before).toContain("evidence.json");

    expect(cleanRuns({ runsDir, olderThanDays: 7 }).evidence).toEqual([]);
    expect(files(old.runDir)).toEqual(before);
    expect(verifyRunEvidence(old.runDir, old.runId).status).toBe("verified");

    // younger than the evidence age: kept
    expect(cleanRuns({ runsDir, olderThanDays: 7, evidenceOlderThanDays: 30 }).evidence).toEqual([]);
    // a dry run only says so
    expect(cleanRuns({ runsDir, olderThanDays: 7, evidenceOlderThanDays: 8, dryRun: true }).evidence).toEqual([old.runId]);
    expect(files(old.runDir)).toEqual(before);

    const r = cleanRuns({ runsDir, olderThanDays: 7, evidenceOlderThanDays: 8 });
    expect(r.evidence).toEqual([old.runId]);
    expect(r.runs).toEqual([]);
    expect(files(old.runDir)).toEqual([]);
    expect(loadRun(runsDir, old.runId)?.status).toBe("succeeded");
    expect(existsSync(join(old.runDir, "live.log"))).toBe(true);
    const verdict = verifyRunEvidence(old.runDir, old.runId);
    expect(verdict.status).toBe("absent");
    expect(verdict.explanation).toContain("no evidence");
    // the recent run was not touched, and nothing is left to remove the second time
    expect(verifyRunEvidence(recent.runDir, recent.runId).status).toBe("verified");
    expect(cleanRuns({ runsDir, olderThanDays: 7, evidenceOlderThanDays: 8 }).evidence).toEqual([]);
  });

  it("does not touch the evidence of a run that can be resumed or is active, and a purge works as before", async () => {
    const paused = await run(`name: p\nworkspace: inplace\nsteps:\n  - {id: a, type: shell, run: 'true', on_success: stop}\n`);
    const done = await run(FLOW("plain"));
    age(paused.runId, 10);
    age(done.runId, 10);
    const r = cleanRuns({ runsDir, olderThanDays: 7, evidenceOlderThanDays: 0, isActive: (id) => id === done.runId });
    expect(r.evidence).toEqual([]);
    expect(files(paused.runDir)).toContain("evidence.jsonl");
    expect(files(done.runDir)).toContain("evidence.json");
    const purged = cleanRuns({ runsDir, olderThanDays: 7, evidenceOlderThanDays: 0, purge: true });
    expect(purged.runs).toEqual([done.runId]);
    expect(purged.evidence).toEqual([]);
    expect(existsSync(done.runDir)).toBe(false);
  });

  it("a run made before evidence existed is cleaned and read as before", async () => {
    const s = await run(FLOW("plain"));
    for (const n of EVIDENCE) rmSync(join(s.runDir, n), { force: true });
    age(s.runId, 10);
    expect(cleanRuns({ runsDir, olderThanDays: 7, evidenceOlderThanDays: 0 }).evidence).toEqual([]);
    expect(loadRun(runsDir, s.runId)?.status).toBe("succeeded");
    expect(verifyRunEvidence(s.runDir, s.runId).status).toBe("absent");
    expect(finalizeRunEvidence(loadRun(runsDir, s.runId)!, { report: () => {} })).toEqual({ state: "none", reason: "the run has no event stream" });
  });
});
