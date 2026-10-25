import { execFileSync } from "node:child_process";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { contractDigest, evidenceHeadProblem, verifyDeliveryContract } from "../src/delivery/contract.js";
import { publicKeyLine } from "../src/delivery/sshsig.js";
import { DELIVERY_DIR, DEPENDENCY_LOCK_NAMES, deliveryAfterStep, deliveryRequirements, parsePullRequestUrl, readCommitFacts, writeContract } from "../src/delivery/write.js";
import { RUN_DELIVERY_DIR } from "../src/engine/os-sandbox.js";
import type { Engine } from "../src/engine/execute.js";
import { canonicalJson, eventHash } from "../src/evidence/canonical.js";
import { sha256Hex } from "../src/evidence/identity.js";

const REPO = "acme/app";
const RUN = "run-1";
const PR = { repository: REPO, number: 7, url: "https://github.com/acme/app/pull/7" };
const cfg = (delivery: Record<string, unknown> = {}) => ConfigSchema.parse({ delivery }).delivery;

const chain = (n: number, runId = RUN, time = "2026-01-31T12:00:00.000Z"): string[] => {
  let prev: string | null = null;
  return Array.from({ length: n }, (_, seq) => {
    const e: Record<string, unknown> = { version: 1, id: `ev-${String(seq).padStart(6, "0")}`, seq, runId, time, type: "run.queued", prevHash: prev };
    prev = eventHash(e);
    return canonicalJson({ ...e, hash: prev });
  });
};
const eventsText = (n: number, runId = RUN, time?: string): string => chain(n, runId, time).join("\n") + "\n";

const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const pem = (k: KeyObject): string => k.export({ type: "pkcs8", format: "pem" }) as string;

let tmp: string;
let base: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "delivery-write-"));
  base = join(tmp, "base");
  mkdirSync(base);
  git(base, "init", "-q", "-b", "feature/x");
  mkdirSync(join(base, "sub"));
  mkdirSync(join(base, ".github/workflows/sub"), { recursive: true });
  writeFileSync(join(base, "package-lock.json"), "{}\n");
  writeFileSync(join(base, "sub/pnpm-lock.yaml"), "lock: 1\n");
  writeFileSync(join(base, ".github/workflows/ci.yml"), "on: push\n");
  writeFileSync(join(base, ".github/workflows/sub/x.yml"), "on: pull_request\n");
  writeFileSync(join(base, "README.md"), "x\n");
  git(base, "add", "-A");
  git(base, "commit", "-q", "-m", "one");
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let counter = 0;
interface Fixture {
  work: string;
  runDir: string;
  dataDir: string;
  keyPath: string;
  key: KeyObject;
  pub: string;
  put: (n: number, text?: string) => void;
  input: (over?: Partial<Parameters<typeof writeContract>[0]>) => Parameters<typeof writeContract>[0];
  file: (name: string) => string;
}
function fresh(): Fixture {
  const root = join(tmp, `case-${counter++}`);
  const work = join(root, "work");
  const runDir = join(root, "run");
  const dataDir = join(root, "data");
  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(dataDir, "delivery-keys"), { recursive: true });
  cpSync(base, work, { recursive: true });
  const { privateKey } = generateKeyPairSync("ed25519");
  const keyPath = join(dataDir, "delivery-keys", "k");
  writeFileSync(keyPath, pem(privateKey));
  const f: Fixture = {
    work, runDir, dataDir, keyPath, key: privateKey, pub: publicKeyLine(privateKey),
    put: (n, text) => writeFileSync(join(runDir, "evidence.jsonl"), text ?? eventsText(n)),
    input: (over = {}) => ({ runDir, runId: RUN, dataDir, workdir: work, repository: REPO, pullRequest: PR, delivery: cfg({ signing_key_path: keyPath }), ...over }),
    file: (name) => join(runDir, DELIVERY_DIR, name),
  };
  f.put(5);
  return f;
}
const read = (f: Fixture, name: string): string => readFileSync(f.file(name), "utf8");
const names = (f: Fixture): string[] => readdirSync(f.file("")).sort();
const fault = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  return "";
};

describe("constants and pure functions", () => {
  it("shares the folder name with the sandbox and lists lock names", () => {
    expect(RUN_DELIVERY_DIR).toBe(DELIVERY_DIR);
    expect(DEPENDENCY_LOCK_NAMES).toContain("package-lock.json");
  });

  it("parses only a pull request of the run's repository", () => {
    expect(parsePullRequestUrl("https://github.com/ACME/App/pull/7", REPO)).toEqual({ repository: REPO, number: 7, url: "https://github.com/ACME/App/pull/7" });
    for (const url of ["https://github.com/other/app/pull/7", "http://github.com/acme/app/pull/7", "https://github.com/acme/app/pull/7?x=1", "https://github.com/acme/app/pull/7#c", "https://github.com/acme/app/pull/7/", "https://github.com/acme/app/pull/0", "https://github.com/acme/app/issues/7", "https://example.com/acme/app/pull/7"]) {
      expect(parsePullRequestUrl(url, REPO), url).toBeUndefined();
    }
    expect(parsePullRequestUrl("https://github.com/acme/app/pull/7", "not a repo")).toBeUndefined();
  });

  it("lets a repository entry override only the fields it sets", () => {
    const d = cfg({ required_checks: ["ci"], artifacts: ["a"], repositories: { "acme/app": { provenance: true } } });
    expect(deliveryRequirements(d, "Acme/App")).toEqual({ requiredChecks: ["ci"], artifacts: ["a"], provenance: true });
    expect(deliveryRequirements(d, "other/app")).toEqual({ requiredChecks: ["ci"], artifacts: ["a"], provenance: false });
  });
});

describe("readCommitFacts", () => {
  it("reads the commit, branch, locks and workflows", () => {
    const f = readCommitFacts(base);
    expect(f.commit).toEqual({ sha: git(base, "rev-parse", "HEAD"), branch: "feature/x" });
    expect(f.dependencyLocks).toEqual([
      { path: "package-lock.json", sha256: sha256Hex("{}\n") },
      { path: "sub/pnpm-lock.yaml", sha256: sha256Hex("lock: 1\n") },
    ]);
    expect(f.ciWorkflows.map((w) => w.path).sort()).toEqual([".github/workflows/ci.yml", ".github/workflows/sub/x.yml"]);
    for (const w of f.ciWorkflows) expect(w.blob).toBe(git(base, "rev-parse", `HEAD:${w.path}`));
  });

  it("refuses a detached HEAD, too many locks and too much data", () => {
    const f = fresh();
    expect(fault(() => readCommitFacts(f.work, { maxLockFiles: 1 }))).toBe("the commit has too many lock or workflow files");
    expect(fault(() => readCommitFacts(f.work, { maxBytes: 10 }))).toBe("the data of the commit is too large");
    git(f.work, "checkout", "-q", "--detach");
    expect(fault(() => readCommitFacts(f.work))).toBe("the workspace is not on a branch");
  });

  it("stops at the deadline", () => {
    const slow = join(tmp, "slow-git");
    writeFileSync(slow, "#!/bin/sh\nexec sleep 5\n", { mode: 0o755 });
    const t = Date.now();
    expect(fault(() => readCommitFacts(base, { gitBin: slow, budgetMs: 200 }))).toBe("reading the commit took too long");
    expect(Date.now() - t).toBeLessThan(3000);
  });

  it.each([["package-lock.json"], [".github/workflows/ci.yml"], ["sub"]])("names no path when the object of %s is missing", (path) => {
    const f = fresh();
    const oid = git(f.work, "rev-parse", `HEAD:${path}`);
    rmSync(join(f.work, ".git/objects", oid.slice(0, 2), oid.slice(2)), { force: true });
    const message = fault(() => readCommitFacts(f.work));
    expect(message).toBe("an object of the commit is missing");
    expect(message).not.toContain(path);
  });

  it("skips the tree for the same commit", () => {
    const log = join(tmp, "git.log");
    const wrapper = join(tmp, "log-git");
    writeFileSync(wrapper, `#!/bin/sh\necho "$@" >> '${log}'\nexec git "$@"\n`, { mode: 0o755 });
    const first = readCommitFacts(base);
    writeFileSync(log, "");
    expect(readCommitFacts(base, { gitBin: wrapper, reuse: first })).toEqual(first);
    const same = readFileSync(log, "utf8");
    expect(same).toContain("rev-parse");
    expect(same).toContain("symbolic-ref");
    expect(same).not.toContain("ls-tree");
    expect(same).not.toContain("cat-file");
    writeFileSync(log, "");
    readCommitFacts(base, { gitBin: wrapper, reuse: { ...first, commit: { ...first.commit, sha: "0".repeat(40) } } });
    expect(readFileSync(log, "utf8")).toContain("ls-tree");
    expect(readFileSync(log, "utf8")).toContain("cat-file");
  });
});

describe("writeContract", () => {
  it("writes contract 1, signed, with private modes", () => {
    const f = fresh();
    const w = writeContract(f.input());
    expect(w).toMatchObject({ sequence: 1, signed: true });
    expect(names(f)).toEqual(["contract-1.json", "contract-1.json.sig", "contract.json", "contract.json.sig"]);
    expect(statSync(f.file("")).mode & 0o777).toBe(0o700);
    for (const n of names(f)) expect(statSync(f.file(n)).mode & 0o777, n).toBe(0o600);
    const text = read(f, "contract-1.json");
    expect(read(f, "contract.json")).toBe(text);
    expect(read(f, "contract.json.sig")).toBe(read(f, "contract-1.json.sig"));
    const v = verifyDeliveryContract(text, read(f, "contract-1.json.sig"), f.pub, readFileSync(join(f.runDir, "evidence.jsonl"), "utf8"));
    expect(v.ok).toBe(true);
    const contract = JSON.parse(text);
    expect(contract.supersedes).toBeUndefined();
    expect(evidenceHeadProblem(readFileSync(join(f.runDir, "evidence.jsonl"), "utf8"), contract)).toBeUndefined();
    expect(w?.digest).toBe(contractDigest(text));
  });

  it("writes nothing when only the evidence or the key changed", () => {
    const f = fresh();
    writeContract(f.input());
    f.put(8);
    expect(writeContract(f.input())).toBeUndefined();
    const other = generateKeyPairSync("ed25519").privateKey;
    writeFileSync(f.keyPath, pem(other));
    expect(writeContract(f.input())).toBeUndefined();
    expect(writeContract(f.input({ delivery: cfg() }))).toBeUndefined();
    expect(names(f)).toEqual(["contract-1.json", "contract-1.json.sig", "contract.json", "contract.json.sig"]);
  });

  it("chains replacements and drops the latest signature for an unsigned contract", () => {
    const f = fresh();
    writeContract(f.input());
    const first = read(f, "contract-1.json");
    git(f.work, "commit", "-q", "--allow-empty", "-m", "two");
    f.put(6);
    expect(writeContract(f.input())).toMatchObject({ sequence: 2, signed: true });
    const second = read(f, "contract-2.json");
    expect(JSON.parse(second).supersedes).toBe(contractDigest(first));
    expect(read(f, "contract.json")).toBe(second);
    expect(read(f, "contract-1.json")).toBe(first);

    f.put(7);
    expect(writeContract(f.input({ delivery: cfg({ signing_key_path: f.keyPath, required_checks: ["ci"] }) }))).toMatchObject({ sequence: 3 });
    expect(JSON.parse(read(f, "contract-3.json")).requiredChecks).toEqual(["ci"]);

    f.put(8);
    expect(writeContract(f.input({ delivery: cfg({ required_checks: ["ci", "lint"] }) }))).toMatchObject({ sequence: 4, signed: false });
    expect(existsSync(f.file("contract-4.json.sig"))).toBe(false);
    expect(existsSync(f.file("contract.json.sig"))).toBe(false);
    expect(read(f, "contract.json")).toBe(read(f, "contract-4.json"));
  });

  it("refuses evidence that does not continue the last contract", () => {
    const f = fresh();
    writeContract(f.input());
    git(f.work, "commit", "-q", "--allow-empty", "-m", "two");
    f.put(4);
    expect(fault(() => writeContract(f.input()))).toMatch(/does not continue the last contract/);
    f.put(0, eventsText(6, RUN, "2027-01-01T00:00:00.000Z"));
    expect(fault(() => writeContract(f.input()))).toMatch(/does not continue the last contract/);
    expect(names(f)).not.toContain("contract-2.json");
  });

  it.each([
    ["deleted", (f: Fixture) => rmSync(f.file("contract.json"))],
    ["stale", (f: Fixture) => writeFileSync(f.file("contract.json"), read(f, "contract-1.json"))],
    ["unsigned", (f: Fixture) => rmSync(f.file("contract.json.sig"))],
  ])("puts a %s latest copy back without a new sequence", (_n, damage) => {
    const f = fresh();
    writeContract(f.input());
    git(f.work, "commit", "-q", "--allow-empty", "-m", "two");
    writeContract(f.input());
    const before = Object.fromEntries(["contract-1.json", "contract-2.json", "contract-2.json.sig"].map((n) => [n, read(f, n)]));
    damage(f);
    expect(writeContract(f.input())).toBeUndefined();
    expect(names(f)).not.toContain("contract-3.json");
    expect(read(f, "contract.json")).toBe(before["contract-2.json"]);
    expect(read(f, "contract.json.sig")).toBe(before["contract-2.json.sig"]);
    for (const [n, text] of Object.entries(before)) expect(read(f, n)).toBe(text);
  });

  it("writes no contract for a key outside delivery-keys, or a link out of it", () => {
    const f = fresh();
    const outside = join(tmp, "outside-key");
    writeFileSync(outside, pem(f.key));
    const link = join(f.dataDir, "delivery-keys", "link");
    symlinkSync(outside, link);
    for (const p of [outside, link, join(f.dataDir, "delivery-keys", "missing")]) {
      const m = fault(() => writeContract(f.input({ delivery: cfg({ signing_key_path: p }) })));
      expect(m).toMatch(/not in the delivery-keys folder/);
      expect(m).not.toContain("/");
    }
    expect(names(f)).toEqual([]);
  });

  it("writes no contract for a key that cannot be used, and never waits for a pipe", () => {
    const f = fresh();
    writeFileSync(f.keyPath, "not a key");
    expect(fault(() => writeContract(f.input()))).toMatch(/cannot be used/);
    rmSync(f.keyPath);
    try {
      execFileSync("mkfifo", [f.keyPath]);
    } catch {
      return;
    }
    expect(fault(() => writeContract(f.input()))).toMatch(/cannot be used/);
    expect(names(f)).toEqual([]);
  });

  it("refuses a delivery folder that is a file or a link", () => {
    const f = fresh();
    writeFileSync(f.file(""), "x");
    expect(fault(() => writeContract(f.input()))).toMatch(/not a plain folder/);
    rmSync(f.file(""));
    const target = join(tmp, "link-target");
    mkdirSync(target, { recursive: true });
    symlinkSync(target, f.file(""));
    expect(fault(() => writeContract(f.input()))).toMatch(/not a plain folder/);
    expect(readdirSync(target)).toEqual([]);
  });

  it("refuses missing, broken, partial, incomplete, empty, foreign and oversized evidence", () => {
    const bad = (setup: (f: Fixture) => void, over: Partial<Parameters<typeof writeContract>[0]> = {}) => {
      const f = fresh();
      setup(f);
      expect(fault(() => writeContract(f.input(over)))).toMatch(/evidence of the run is missing/);
      expect(names(f)).toEqual([]);
    };
    bad((f) => rmSync(join(f.runDir, "evidence.jsonl")));
    bad((f) => f.put(0, eventsText(3).replace('"run.queued"', '"x"')));
    bad((f) => f.put(0, eventsText(3) + '{"partial'));
    bad((f) => writeFileSync(join(f.runDir, "evidence.incomplete"), ""));
    bad((f) => f.put(0, ""));
    bad((f) => f.put(0, eventsText(3, "other-run")));
    bad(() => undefined, { maxEvidenceBytes: 10 });
  });

  it("refuses a tampered latest contract", () => {
    const f = fresh();
    writeContract(f.input());
    writeFileSync(f.file("contract-1.json"), read(f, "contract-1.json") + "\n");
    expect(fault(() => writeContract(f.input()))).toMatch(/latest contract cannot be read/);
  });

  it("gives a fixed line without a path when a file cannot be written", () => {
    const f = fresh();
    writeContract(f.input());
    git(f.work, "commit", "-q", "--allow-empty", "-m", "two");
    writeFileSync(f.file("contract-2.json.sig"), "stray");
    const m = fault(() => writeContract(f.input()));
    expect(m).toBe("the contract cannot be written");
    expect(existsSync(f.file("contract-2.json"))).toBe(false);
    rmSync(f.file("contract-2.json.sig"));

    if (process.getuid?.() !== 0) {
      chmodSync(f.file(""), 0o500);
      try {
        expect(fault(() => writeContract(f.input()))).toBe("the contract cannot be written");
      } finally {
        chmodSync(f.file(""), 0o700);
      }
    }
  });
});

it("removes only the files it created when a write fails, and a retry then succeeds", () => {
  const f = fresh();
  writeContract(f.input());
  git(f.work, "commit", "-q", "--allow-empty", "-m", "two");
  writeFileSync(f.file("contract-2.json.sig"), "stray");
  expect(fault(() => writeContract(f.input()))).toBe("the contract cannot be written");
  // the stray file was not created by the call, so it is left alone
  expect(read(f, "contract-2.json.sig")).toBe("stray");
  expect(existsSync(f.file("contract-2.json"))).toBe(false);
  rmSync(f.file("contract-2.json.sig"));
  expect(writeContract(f.input())).toMatchObject({ sequence: 2, signed: true });
  expect(names(f)).toEqual(["contract-1.json", "contract-1.json.sig", "contract-2.json", "contract-2.json.sig", "contract.json", "contract.json.sig"]);
  expect(verifyDeliveryContract(read(f, "contract-2.json"), read(f, "contract-2.json.sig"), f.pub).ok).toBe(true);
});

describe("deliveryAfterStep", () => {
  const engineOf = (f: Fixture, outputs: Record<string, string> | undefined, logs: string[]): Engine =>
    ({
      summary: { runDir: f.runDir, runId: RUN, workdir: f.work, vars: { github_repo: REPO }, outputs },
      config: { delivery: cfg() },
      deliverySettings: () => cfg({ signing_key_path: f.keyPath }),
      log: (m: string) => logs.push(m),
    }) as unknown as Engine;

  it("does nothing without a pull request of the repository", () => {
    const f = fresh();
    const logs: string[] = [];
    deliveryAfterStep(engineOf(f, undefined, logs));
    deliveryAfterStep(engineOf(f, { pull_request: "https://github.com/other/app/pull/7" }, logs));
    expect(existsSync(f.file(""))).toBe(false);
    expect(logs).toEqual([]);
  });

  it("logs a written contract and a fixed fault, and never throws", () => {
    const f = fresh();
    const logs: string[] = [];
    const engine = engineOf(f, { pull_request: PR.url }, logs);
    const home = process.env.FACTORY_HOME;
    process.env.FACTORY_HOME = f.dataDir;
    try {
      deliveryAfterStep(engine);
      expect(logs).toEqual(["  delivery: contract 1 written (signed)"]);
      logs.length = 0;
      rmSync(join(f.runDir, "evidence.jsonl"));
      expect(() => deliveryAfterStep(engine)).not.toThrow();
    } finally {
      process.env.FACTORY_HOME = home;
    }
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^ {2}delivery: the evidence of the run is missing/);
  });
});
