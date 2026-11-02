import { execFileSync } from "node:child_process";
import { createPrivateKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BLOCKED, makeRedactor } from "../src/credentials/redact.js";
import { ConfigSchema } from "../src/config.js";
import {
  checkHandoff, checksWaitSec, defaultCheckRuns, handoffCommand, handoffLines, handoffRedactor, handoffText, waitForChecks,
  type CheckRun, type HandoffInput, type HandoffResult, type RemoteHead,
} from "../src/delivery/handoff.js";
import { signDeliveryContract } from "../src/delivery/contract.js";
import { publicKeyLine } from "../src/delivery/sshsig.js";
import { DELIVERY_DIR, writeContract } from "../src/delivery/write.js";
import { canonicalJson, eventHash } from "../src/evidence/canonical.js";
import { fakeGithub } from "./helpers/fake-github.js";

const REPO = "acme/app";
const RUN = "run-1";
const PR_NUMBER = 99;
const TOKEN = "ghp_" + "a1B2c3D4".repeat(5);
const cfg = (delivery: Record<string, unknown> = {}) => ConfigSchema.parse({ delivery }).delivery;

const eventsText = (n: number, runId = RUN, marked = false): string => {
  let prev: string | null = null;
  return (
    Array.from({ length: n }, (_, seq) => {
      const first = marked && seq === 0 ? { version: 8, type: "run.created", flow: { name: "f" }, by: { kind: "cli" }, localTest: true } : {};
      const e: Record<string, unknown> = { version: 1, id: `ev-${String(seq).padStart(6, "0")}`, seq, runId, time: "2026-01-31T12:00:00.000Z", type: "run.queued", prevHash: prev, ...first };
      prev = eventHash(e);
      return canonicalJson({ ...e, hash: prev });
    }).join("\n") + "\n"
  );
};
const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const pem = (k: KeyObject): string => k.export({ type: "pkcs8", format: "pem" }) as string;

let gh: ReturnType<typeof fakeGithub>;
let tmp: string;
let base: string;
beforeAll(() => {
  gh = fakeGithub();
  tmp = mkdtempSync(join(tmpdir(), "delivery-handoff-"));
  const origin = join(tmp, "origin.git");
  base = join(tmp, "base");
  mkdirSync(origin);
  git(origin, "init", "-q", "--bare");
  mkdirSync(base);
  git(base, "init", "-q", "-b", "main");
  mkdirSync(join(base, ".github/workflows"), { recursive: true });
  writeFileSync(join(base, "package-lock.json"), "{}\n");
  writeFileSync(join(base, ".github/workflows/ci.yml"), "on: push\n");
  git(base, "add", "-A");
  git(base, "commit", "-q", "-m", "one");
  git(base, "remote", "add", "origin", origin);
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  gh.restore();
});

let counter = 0;
interface Fixture {
  work: string;
  runDir: string;
  dataDir: string;
  keyPath: string;
  pub: string;
  sha: string;
  branch: string;
  contract: (over?: Partial<Parameters<typeof writeContract>[0]>, checks?: string[]) => void;
  input: (over?: Partial<HandoffInput>) => HandoffInput;
}
function fresh(o: { branch?: string; checks?: string[]; runId?: string } = {}): Fixture {
  const n = counter++;
  const root = join(tmp, `case-${n}`);
  const work = join(root, "work");
  const runDir = join(root, "run");
  const dataDir = join(root, "data");
  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(dataDir, "delivery-keys"), { recursive: true });
  cpSync(base, work, { recursive: true });
  const branch = o.branch ?? `feature/c${n}`;
  git(work, "checkout", "-q", "-b", branch);
  git(work, "push", "-q", "origin", branch);
  const { privateKey } = generateKeyPairSync("ed25519");
  const keyPath = join(dataDir, "delivery-keys", "k");
  writeFileSync(keyPath, pem(privateKey));
  const pub = publicKeyLine(privateKey);
  const runId = o.runId ?? RUN;
  const f: Fixture = {
    work, runDir, dataDir, keyPath, pub, branch, sha: git(work, "rev-parse", "HEAD"),
    contract: (over = {}, checks = o.checks ?? []) => {
      writeContract({
        runDir, runId, dataDir, workdir: work, repository: REPO,
        pullRequest: { repository: REPO, number: PR_NUMBER, url: `https://github.com/${REPO}/pull/${PR_NUMBER}` },
        delivery: cfg({ signing_key_path: keyPath, required_checks: checks }), ...over,
      });
    },
    input: (over = {}) => ({
      runDir, runId, repository: REPO, pullRequest: PR_NUMBER, publicKey: pub, workdir: work, waitSec: 0,
      remoteHead: async (): Promise<RemoteHead> => ({ kind: "sha", sha: f.sha }),
      checkRuns: async (): Promise<CheckRun[]> => [],
      sleep: async () => {},
      now: () => 0,
      ...over,
    }),
  };
  writeFileSync(join(runDir, "evidence.jsonl"), eventsText(5, runId));
  return f;
}
const ready = (o: Parameters<typeof fresh>[0] = {}): Fixture => {
  const f = fresh(o);
  f.contract();
  return f;
};
const dir = (f: Fixture, name = ""): string => join(f.runDir, DELIVERY_DIR, name);
const stopOf = (r: HandoffResult): { condition: string; reason: string } => {
  expect(r.kind).toBe("stop");
  return r as never;
};
const run = (r: HandoffResult, check: string) => (r as { checks: { check: string; status: string; condition?: string; reason?: string }[] }).checks.find((c) => c.check === check)!;
const ok = (name: string, conclusion = "success", status = "completed"): CheckRun => ({ name, status, conclusion });

describe("key and contract states", () => {
  it("'-' or a bad line is a stop, with or without a contract", async () => {
    for (const f of [fresh(), ready()]) {
      for (const publicKey of ["-", "ssh-ed25519 nonsense"]) {
        const r = stopOf(await checkHandoff(f.input({ publicKey })));
        expect(r).toMatchObject({ condition: "signature-unverified", reason: "the signing key cannot be used" });
      }
    }
  });
  it("no contract: none without a key, a stop with one", async () => {
    const f = fresh();
    expect((await checkHandoff(f.input({ publicKey: "" }))).kind).toBe("none");
    expect(stopOf(await checkHandoff(f.input()))).toMatchObject({ condition: "signature-unverified", reason: "the run has no delivery contract" });
  });
  it("a contract without a key is unsigned and calls nothing", async () => {
    const f = ready();
    let calls = 0;
    const r = await checkHandoff(f.input({ publicKey: "", remoteHead: async () => (calls++, { kind: "missing" }), checkRuns: async () => (calls++, []) }));
    expect(r.kind).toBe("unsigned");
    expect(calls).toBe(0);
  });
  it("the happy path is ok with every check ok", async () => {
    const f = ready();
    const r = await checkHandoff(f.input());
    expect(r.kind).toBe("ok");
    expect((r as { checks: { status: string }[] }).checks.map((c) => c.status)).toEqual(Array(7).fill("ok"));
    expect(handoffLines(r).at(-1)).toBe("HANDOFF: ok");
  });
});

describe("signature", () => {
  it("stops for a tampered contract, another key and a missing signature, and skips the rest", async () => {
    const f = ready();
    const other = publicKeyLine(generateKeyPairSync("ed25519").privateKey);
    expect(stopOf(await checkHandoff(f.input({ publicKey: other }))).condition).toBe("signature-unverified");
    const sig = readdirSync(dir(f)).includes("contract.json.sig");
    expect(sig).toBe(true);
    const r = await checkHandoff(f.input({ publicKey: other }));
    expect(run(r, "commit")).toMatchObject({ status: "skipped", reason: "the contract is not trusted" });
    writeFileSync(dir(f, "contract.json"), "not json");
    expect(stopOf(await checkHandoff(f.input())).reason).toBe("the contract is not JSON");
    rmSync(dir(f, "contract.json.sig"));
    expect(stopOf(await checkHandoff(f.input())).condition).toBe("signature-unverified");
  });
  it("stops when the signature file is missing", async () => {
    const f = ready();
    rmSync(dir(f, "contract.json.sig"));
    expect(stopOf(await checkHandoff(f.input())).reason).toBe("the contract has no signature");
  });
});

describe("superseded", () => {
  it("a newer numbered contract, a differing signature copy, another PR, repository and run", async () => {
    const f = ready();
    writeFileSync(dir(f, "contract-2.json"), "{}");
    expect(stopOf(await checkHandoff(f.input()))).toMatchObject({ condition: "superseded", reason: "a newer contract exists" });
    rmSync(dir(f, "contract-2.json"));
    writeFileSync(dir(f, "contract-1.json.sig"), "other");
    expect(stopOf(await checkHandoff(f.input())).reason).toBe("the latest copy differs from the newest contract");
    const g = ready();
    expect(stopOf(await checkHandoff(g.input({ pullRequest: 5 }))).reason).toBe("the contract is for pull request #99, the run's is #5");
    expect(stopOf(await checkHandoff(g.input({ repository: "acme/other" }))).condition).toBe("superseded");
    const r = await checkHandoff(g.input({ runId: "run-2" }));
    expect(stopOf(r).reason).toBe("the contract is of another run");
    expect(run(r, "evidence")).toMatchObject({ status: "skipped", reason: "the contract is not the latest" });
    expect((await checkHandoff(g.input({ repository: "ACME/APP" }))).kind).toBe("ok");
  });
});

describe("commit", () => {
  it("unreadable, missing (names the branch) and another sha", async () => {
    const f = ready();
    let polled = 0;
    const checkRuns = async () => (polled++, []);
    expect(stopOf(await checkHandoff(f.input({ remoteHead: async () => ({ kind: "unreadable" }), checkRuns }))).reason).toBe("the pushed head cannot be read");
    expect(stopOf(await checkHandoff(f.input({ remoteHead: async () => ({ kind: "missing" }) }))).reason).toBe(`the branch ${f.branch} is not on the remote`);
    const other = "b".repeat(40);
    const r = await checkHandoff(f.input({ remoteHead: async () => ({ kind: "sha", sha: other }), checkRuns }));
    expect(stopOf(r)).toMatchObject({ condition: "commit-changed", reason: `the pushed head is ${other}, the contract is for ${f.sha}` });
    expect(polled).toBe(0);
    expect(run(r, "checks")).toMatchObject({ status: "skipped", reason: "the commit changed" });
  });
  it("another local commit and a detached head", async () => {
    const f = fresh({ checks: ["build"] });
    f.contract();
    git(f.work, "commit", "-q", "--allow-empty", "-m", "two");
    const sha2 = git(f.work, "rev-parse", "HEAD");
    expect(stopOf(await checkHandoff(f.input())).reason).toBe(`the checked-out commit is ${sha2}, the contract is for ${f.sha}`);
    git(f.work, "checkout", "-q", "--detach");
    const r = await checkHandoff(f.input());
    expect(stopOf(r)).toMatchObject({ condition: "commit-changed", reason: "the workspace is not on a branch" });
    expect(run(r, "locks")).toMatchObject({ status: "skipped", reason: "the commit cannot be read" });
    git(f.work, "checkout", "-q", "-b", "elsewhere");
    expect(stopOf(await checkHandoff(f.input())).reason).toBe(`the workspace is on branch elsewhere, the contract is for ${f.branch}`);
  });
  it("a remote head that throws gives a stop and never a throw", async () => {
    const f = ready();
    const r = await checkHandoff(f.input({ remoteHead: async () => { throw new Error("boom"); } }));
    expect(stopOf(r)).toMatchObject({ condition: "signature-unverified", reason: "the handoff could not be completed" });
  });
});

describe("head re-read after waiting", () => {
  it("a head that moved while the checks ran turns commit into a stop", async () => {
    const f = ready({ checks: ["build"] });
    let heads = 0;
    let reads = 0;
    const moved = "c".repeat(40);
    const r = await checkHandoff(f.input({
      waitSec: 60,
      remoteHead: async () => (heads++ === 0 ? { kind: "sha", sha: f.sha } : { kind: "sha", sha: moved }),
      checkRuns: async () => (reads++ === 0 ? [ok("build", "", "in_progress")] : [ok("build")]),
    }));
    expect(stopOf(r)).toMatchObject({ condition: "commit-changed", reason: `the pushed head is ${moved}, the contract is for ${f.sha} (after waiting for the checks)` });
    expect(run(r, "checks").status).toBe("skipped");
    expect(heads).toBe(2);
  });
  it("a single read asks for the head once", async () => {
    const f = ready({ checks: ["build"] });
    let heads = 0;
    const r = await checkHandoff(f.input({ remoteHead: async () => (heads++, { kind: "sha", sha: f.sha }), checkRuns: async () => [ok("build")] }));
    expect(r.kind).toBe("ok");
    expect(heads).toBe(1);
  });
});

describe("locks and workflows", () => {
  it("changed, removed, added and (and N more)", async () => {
    const f = ready();
    writeFileSync(join(f.work, "package-lock.json"), "{ }\n");
    writeFileSync(join(f.work, "yarn.lock"), "x\n");
    writeFileSync(join(f.work, ".github/workflows/new.yml"), "on: push\n");
    writeFileSync(join(f.work, ".github/workflows/new2.yml"), "on: push\n");
    rmSync(join(f.work, ".github/workflows/ci.yml"));
    git(f.work, "add", "-A");
    git(f.work, "commit", "-q", "-m", "change");
    const r = await checkHandoff(f.input());
    expect(run(r, "locks")).toMatchObject({ status: "stop", condition: "lock-changed", reason: "package-lock.json was changed (and 1 more)" });
    expect(run(r, "workflows")).toMatchObject({ status: "stop", condition: "workflow-changed", reason: ".github/workflows/ci.yml was removed (and 2 more)" });
    // the first stop in check order is the commit
    expect(stopOf(r).condition).toBe("commit-changed");
  });
  it("a removed lock file", async () => {
    const f = ready();
    rmSync(join(f.work, "package-lock.json"));
    git(f.work, "add", "-A");
    git(f.work, "commit", "-q", "-m", "rm");
    expect(run(await checkHandoff(f.input()), "locks").reason).toBe("package-lock.json was removed");
  });
});

describe("required checks", () => {
  it("missing, failed, still running and unreadable", async () => {
    const f = ready({ checks: ["build", "test"] });
    const go = (checkRuns: HandoffInput["checkRuns"]) => checkHandoff(f.input({ checkRuns }));
    expect(stopOf(await go(async () => [ok("test")]))).toMatchObject({ condition: "required-check-failed", reason: "build is missing" });
    expect(stopOf(await go(async () => [ok("build"), ok("test", "failure")])).reason).toBe("test did not pass");
    expect(stopOf(await go(async () => [ok("build"), ok("test", "", "in_progress")])).reason).toBe("test did not pass");
    expect(stopOf(await go(async () => { throw new Error("x"); })).reason).toBe("the check runs cannot be read");
    expect((await go(async () => [ok("build"), ok("test")])).kind).toBe("ok");
  });
  it("makes no call when nothing is required", async () => {
    const f = ready();
    let calls = 0;
    expect((await checkHandoff(f.input({ checkRuns: async () => (calls++, []) }))).kind).toBe("ok");
    expect(calls).toBe(0);
  });
});

describe("evidence and the first stop", () => {
  it("a short chain, a missing file and a changed hash", async () => {
    const f = ready();
    writeFileSync(join(f.runDir, "evidence.jsonl"), eventsText(3));
    expect(stopOf(await checkHandoff(f.input())).condition).toBe("evidence-unverified");
    rmSync(join(f.runDir, "evidence.jsonl"));
    expect(stopOf(await checkHandoff(f.input())).reason).toBe("the events cannot be read");
    writeFileSync(join(f.runDir, "evidence.jsonl"), eventsText(5).replace("run.queued", "run.queuef"));
    expect(stopOf(await checkHandoff(f.input())).condition).toBe("evidence-unverified");
  });
  it("with two problems the first in order wins", async () => {
    const f = ready({ checks: ["build"] });
    rmSync(join(f.runDir, "evidence.jsonl"));
    const r = await checkHandoff(f.input({ checkRuns: async () => [] }));
    expect(stopOf(r).condition).toBe("required-check-failed");
    expect(run(r, "evidence").status).toBe("stop");
  });
});

describe("a contract over the evidence of a local-test run", () => {
  /** A contract the writer would refuse: the same contract, but over a marked chain of five events, signed again. */
  const markedReady = (): Fixture => {
    const f = ready();
    const text = eventsText(5, RUN, true);
    writeFileSync(join(f.runDir, "evidence.jsonl"), text);
    const lines = text.trim().split("\n");
    const c = JSON.parse(readFileSync(dir(f, "contract.json"), "utf8")) as { evidence: { terminalHash: string } };
    c.evidence.terminalHash = (JSON.parse(lines[4]!) as { hash: string }).hash;
    const out = canonicalJson(c);
    const key = createPrivateKey(readFileSync(f.keyPath));
    for (const name of ["contract.json", "contract-1.json"]) writeFileSync(dir(f, name), out);
    for (const name of ["contract.json.sig", "contract-1.json.sig"]) writeFileSync(dir(f, name), signDeliveryContract(out, key));
    return f;
  };
  const LOCAL = "the run is a local test, so it is not eligible for delivery";

  it("stops with evidence-unverified when there is a key", async () => {
    const f = markedReady();
    const r = await checkHandoff(f.input());
    expect(stopOf(r)).toMatchObject({ condition: "evidence-unverified", reason: LOCAL });
    expect(run(r, "evidence")).toMatchObject({ status: "stop", condition: "evidence-unverified", reason: LOCAL });
    expect(run(r, "signature").status).toBe("ok");
  });

  it("stops without a key too, and calls nothing", async () => {
    const f = markedReady();
    let calls = 0;
    const r = await checkHandoff(f.input({ publicKey: "", remoteHead: async () => (calls++, { kind: "missing" }), checkRuns: async () => (calls++, []) }));
    expect(stopOf(r)).toMatchObject({ condition: "evidence-unverified", reason: LOCAL });
    expect(calls).toBe(0);
    expect(run(r, "commit").status).toBe("skipped");
  });

  it("without a key an unmarked, a missing or a broken stream is still unsigned", async () => {
    const f = markedReady();
    writeFileSync(join(f.runDir, "evidence.jsonl"), eventsText(5));
    expect((await checkHandoff(f.input({ publicKey: "" }))).kind).toBe("unsigned");
    rmSync(join(f.runDir, "evidence.jsonl"));
    expect((await checkHandoff(f.input({ publicKey: "" }))).kind).toBe("unsigned");
    writeFileSync(join(f.runDir, "evidence.jsonl"), eventsText(5, RUN, true).replace("run.queued", "run.queuef"));
    expect((await checkHandoff(f.input({ publicKey: "" }))).kind).toBe("unsigned");
  });
});

describe("waitForChecks and checksWaitSec", () => {
  const clock = () => {
    let t = 0;
    const slept: number[] = [];
    return { slept, o: (waitSec: number) => ({ waitSec, now: () => t, sleep: async (ms: number) => void (slept.push(ms), (t += ms)) }) };
  };
  it("returns at once when everything is done", async () => {
    const c = clock();
    expect(await waitForChecks(["a"], async () => [ok("a")], c.o(60))).toEqual({ ok: true, runs: [ok("a")], polls: 1 });
    expect(c.slept).toEqual([]);
  });
  it("polls every 15 s until done", async () => {
    const c = clock();
    let n = 0;
    const r = await waitForChecks(["a"], async () => (n++ < 2 ? [ok("a", "", "queued")] : [ok("a")]), c.o(600));
    expect(r).toMatchObject({ ok: true, polls: 3 });
    expect(c.slept).toEqual([15_000, 15_000]);
  });
  it("stops early on a failed check", async () => {
    const c = clock();
    const r = await waitForChecks(["a", "b"], async () => [ok("a", "failure"), ok("b", "", "in_progress")], c.o(600));
    expect(r).toMatchObject({ ok: true, polls: 1 });
  });
  it("returns the last good read at the deadline, and one read for 0", async () => {
    const c = clock();
    const pending = [ok("a", "", "in_progress")];
    expect(await waitForChecks(["a"], async () => pending, c.o(30))).toEqual({ ok: true, runs: pending, polls: 3 });
    const z = clock();
    expect(await waitForChecks(["a"], async () => pending, z.o(0))).toMatchObject({ polls: 1 });
    expect(z.slept).toEqual([]);
  });
  it("keeps a good read after a failed one, and gives ok:false when none ever worked", async () => {
    const c = clock();
    let n = 0;
    const r = await waitForChecks(["a"], async () => {
      if (n++ === 1) throw new Error("x");
      return [ok("a", "", "in_progress")];
    }, c.o(45));
    expect(r).toMatchObject({ ok: true, polls: 4 });
    expect(await waitForChecks(["a"], async () => { throw new Error("x"); }, clock().o(30))).toEqual({ ok: false, polls: 3 });
  });
  it("reads the wait from the environment", () => {
    for (const v of [undefined, "abc", "-1", "1.5", ""]) expect(checksWaitSec({ FACTORY_DELIVERY_CHECKS_WAIT_SEC: v })).toBe(600);
    expect(checksWaitSec({ FACTORY_DELIVERY_CHECKS_WAIT_SEC: "0" })).toBe(0);
    expect(checksWaitSec({ FACTORY_DELIVERY_CHECKS_WAIT_SEC: "5000" })).toBe(3600);
    expect(checksWaitSec({ FACTORY_DELIVERY_CHECKS_WAIT_SEC: "90" })).toBe(90);
  });
});

describe("what is printed", () => {
  const stopWith = (reason: string): HandoffResult => ({ kind: "stop", condition: "commit-changed", reason, checks: [{ check: "commit", status: "stop", condition: "commit-changed", reason }] });
  it("turns control characters into ? and keeps spaces", () => {
    expect(handoffText("a\nb\tc\u0007d  e")).toBe("a?b?c?d  e");
    expect(handoffLines(stopWith("x\ny")).join("\n")).toContain("commit: stop commit-changed: x?y");
  });
  it("takes secrets out of every line, also across the cut", () => {
    const lines = handoffLines(stopWith(`the branch feature/${TOKEN} is not on the remote`));
    expect(lines.join("\n")).not.toContain(TOKEN);
    expect(lines.join("\n")).not.toContain("ghp_");
    const cut = handoffText("a".repeat(290) + " " + TOKEN);
    expect(cut).not.toContain("ghp_");
    expect([...cut].length).toBeLessThanOrEqual(300);
  });
  it("gives a fixed text when the scrub fails", () => {
    expect(handoffText("anything", () => { throw new Error("no"); })).toBe("the reason cannot be shown");
    expect(handoffText("anything", () => BLOCKED)).toBe("the reason cannot be shown");
  });
  it("scrubs the branch, a lock path and a check name of a real check", async () => {
    const f = ready({ branch: `feature/${TOKEN}` });
    const r = await checkHandoff(f.input({ remoteHead: async () => ({ kind: "missing" }) }));
    expect(handoffLines(r).join("\n")).not.toContain(TOKEN);
  });
});

describe("handoffRedactor", () => {
  it("falls back to the step's own secrets when the store cannot be read", () => {
    const stored = handoffRedactor({ GH_TOKEN: "my-own-secret-123", FACTORY_DELIVERY_PUBLIC_KEY: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIabc", SHORT_KEY: "abc" }, () => BLOCKED)();
    expect(stored).not.toBe(BLOCKED);
    expect(stored.redact("x my-own-secret-123 y")).not.toContain("my-own-secret-123");
    expect(stored.redact("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIabc")).toContain("ssh-ed25519");
    expect(handoffText(`t ${TOKEN} my-own-secret-123`, handoffRedactor({ GH_TOKEN: "my-own-secret-123" }, () => BLOCKED))).not.toMatch(/ghp_|my-own-secret/);
  });
  it("adds the stored credentials when they can be read", () => {
    const r = handoffRedactor({}, () => makeRedactor(["stored-value-xyz"]))();
    expect(r.redact("a stored-value-xyz b")).not.toContain("stored-value-xyz");
  });
});

describe("default checkRuns against the fake gh", () => {
  it("gives no runs by default and the runs of FAKE_GH_CHECK_RUNS when set", async () => {
    const read = defaultCheckRuns(REPO);
    delete process.env.FAKE_GH_CHECK_RUNS;
    expect(await read("a".repeat(40))).toEqual([]);
    process.env.FAKE_GH_CHECK_RUNS = JSON.stringify({ check_runs: [{ name: "build", status: "completed", conclusion: "success" }, { name: "t", status: "queued", conclusion: null }, { bad: 1 }] });
    try {
      expect(await read("a".repeat(40))).toEqual([ok("build"), { name: "t", status: "queued", conclusion: null }]);
    } finally {
      delete process.env.FAKE_GH_CHECK_RUNS;
    }
  });
});

describe("handoffCommand", () => {
  const envOf = (f: Fixture, over: Record<string, string | undefined> = {}) => ({
    FACTORY_RUN_ID: f.input().runId, FACTORY_VAR_GITHUB_REPO: REPO, FACTORY_OUT_RELEASE_PR: `PR: ${PR_NUMBER}\nTITLE: Release`, FACTORY_DELIVERY_PUBLIC_KEY: f.pub, ...over,
  });
  const exec = async (f: Fixture, deps: Parameters<typeof handoffCommand>[2] = {}, env = envOf(f)) => {
    let out = "";
    const code = await handoffCommand([f.runDir], { out: (s) => void (out += s), err: (s) => void (out += s) }, { workdir: f.work, ...deps }, env);
    return { code, out };
  };
  const snapshot = (f: Fixture) => readdirSync(dir(f)).sort().map((n) => `${n}:${statSync(dir(f, n)).mtimeMs}`);
  const calls = () => gh.ghLog().split("\n").filter((l) => l.startsWith("gh "));

  beforeAll(() => {
    process.env.FAKE_GH_COMMENTS_FROM_LOG = "1";
  });
  afterAll(() => {
    delete process.env.FAKE_GH_COMMENTS_FROM_LOG;
  });

  it("posts once, leaves an identical retry alone and edits for another run", async () => {
    const f = ready();
    const before = snapshot(f);
    const first = await exec(f);
    expect(first.code).toBe(0);
    expect(first.out).toContain("HANDOFF: ok");
    expect(first.out).toContain("delivery comment: posted");
    expect(calls().filter((c) => c.startsWith(`gh pr comment ${PR_NUMBER} `))).toHaveLength(1);
    expect(gh.ghLog()).toContain("**Verified.**");
    expect(gh.ghLog()).not.toContain("PRIVATE KEY");
    expect(snapshot(f)).toEqual(before);

    const again = await exec(f);
    expect(again.out).toContain("delivery comment: unchanged");
    expect(gh.ghLog()).not.toContain("--- comment edit");

    const g = ready({ runId: "run-2" });
    const next = await exec(g);
    expect(next.code).toBe(0);
    expect(next.out).toContain("delivery comment: updated");
    expect(gh.ghLog()).toContain("--- comment edit 1");
    expect(calls().filter((c) => c.startsWith(`gh pr comment ${PR_NUMBER} `))).toHaveLength(1);
  });

  it("stops when a new commit was pushed, and the comment says so", async () => {
    const f = ready();
    git(f.work, "commit", "-q", "--allow-empty", "-m", "late");
    git(f.work, "push", "-q", "origin", f.branch);
    const r = await exec(f);
    expect(r.code).toBe(1);
    expect(r.out).toContain("HANDOFF: stop commit-changed");
    expect(gh.ghLog()).toContain("**Stopped:** `commit-changed`");
  });

  it("keeps the verdict when the comment cannot be updated, and never shows gh's text", async () => {
    const f = ready();
    process.env.FAKE_GH_FAIL_ON = "pr view";
    process.env.FAKE_GH_FAIL_TEXT = "gh-secret-text";
    try {
      const r = await exec(f);
      expect(r.code).toBe(0);
      expect(r.out).toContain("HANDOFF: ok");
      expect(r.out).toContain("delivery comment: could not be updated");
      expect(r.out).not.toContain("gh-secret-text");
    } finally {
      delete process.env.FAKE_GH_FAIL_ON;
      delete process.env.FAKE_GH_FAIL_TEXT;
    }
  });

  it("calls gh not at all without a pull request or inputs: skipped without a key, a stop with one", async () => {
    const f = ready();
    const n = calls().length;
    const noPr = await exec(f, {}, envOf(f, { FACTORY_OUT_RELEASE_PR: "no pr here" }));
    expect(noPr).toEqual({ code: 1, out: "HANDOFF: stop superseded: the run has no pull request\n" });
    const bad = await exec(f, {}, envOf(f, { FACTORY_RUN_ID: "bad id!" }));
    expect(bad).toEqual({ code: 1, out: "HANDOFF: stop signature-unverified: the handoff inputs are missing\n" });
    const free = await exec(f, {}, envOf(f, { FACTORY_OUT_RELEASE_PR: "", FACTORY_DELIVERY_PUBLIC_KEY: "" }));
    expect(free.code).toBe(0);
    expect(free.out).toBe("HANDOFF: skipped (the run has no pull request)\n");
    expect(calls()).toHaveLength(n);
  });

  it("takes the last PR line", async () => {
    const f = ready();
    const r = await exec(f, {}, envOf(f, { FACTORY_OUT_RELEASE_PR: "PR: 5\nPR: 99\nTITLE: x" }));
    expect(r.code).toBe(0);
  });

  it("without a key the contract is unsigned and the comment says not verified", async () => {
    const f = ready();
    const r = await exec(f, {}, envOf(f, { FACTORY_DELIVERY_PUBLIC_KEY: "" }));
    expect(r.code).toBe(0);
    expect(r.out).toContain("HANDOFF: skipped (no signing key is set; the contract is unsigned)");
    expect(gh.ghLog()).toContain("**Not verified.**");
  });

  it("without a key a marked chain stops the handoff", async () => {
    const f = ready();
    const text = eventsText(5, RUN, true);
    writeFileSync(join(f.runDir, "evidence.jsonl"), text);
    const r = await exec(f, {}, envOf(f, { FACTORY_DELIVERY_PUBLIC_KEY: "" }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("HANDOFF: stop evidence-unverified: the run is a local test, so it is not eligible for delivery");
  });

  it("with no contract and no key posts nothing", async () => {
    const f = fresh();
    const n = calls().length;
    const r = await exec(f, {}, envOf(f, { FACTORY_DELIVERY_PUBLIC_KEY: "" }));
    expect(r).toEqual({ code: 0, out: "HANDOFF: skipped (the run has no delivery contract)\n" });
    expect(calls()).toHaveLength(n);
  });

  it("in a sandbox that cannot read the store, still posts and says so", async () => {
    const f = ready();
    const r = await exec(f, { live: () => BLOCKED }, envOf(f, { GH_TOKEN: "my-own-secret-123" }));
    expect(r.code).toBe(0);
    expect(r.out).toContain("secret check: the stored credentials cannot be read here");
    expect(r.out).toMatch(/delivery comment: (posted|updated|unchanged)/);
  });

  it("takes a stored value out of the lines and the comment", async () => {
    const f = ready({ branch: "feature/stored-value-xyz" });
    const r = await exec(f, { live: () => makeRedactor(["stored-value-xyz"]), remoteHead: async () => ({ kind: "missing" }) });
    expect(r.code).toBe(1);
    expect(r.out).not.toContain("stored-value-xyz");
    expect(gh.ghLog().split("**Stopped:**").at(-1)).not.toContain("stored-value-xyz");
  });

  it("turns an ok verdict into a stop when the contract cannot be put in a comment", async () => {
    const f = ready({ checks: [TOKEN] });
    const r = await exec(f, { checkRuns: async () => [ok(TOKEN)] });
    expect(r.code).toBe(1);
    expect(r.out).toContain("HANDOFF: stop signature-unverified: the contract cannot be published in a comment");
    expect(r.out).not.toContain(TOKEN);
    const body = gh.ghLog().split("--- comment").filter((s) => s.includes("Stopped:** `signature-unverified`")).at(-1)!;
    expect(body).toContain("- **Contract:** none was written");
    expect(body).not.toContain("delivery-contract digest=");
    expect(body).not.toContain("scf-delivery-signature");
    expect(body).not.toContain(TOKEN);
  });
});
