import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createPrivateKey, type KeyObject } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deliveryCommand } from "../src/delivery/cli.js";
import { buildDeliveryContract, contractDigest, deliveryContractText, signDeliveryContract, verifyDeliveryContract } from "../src/delivery/contract.js";
import { publicKeyLine, signSsh } from "../src/delivery/sshsig.js";
import { canonicalHash, canonicalJson } from "../src/evidence/canonical.js";
import { sha256Hex } from "../src/evidence/identity.js";

const execFileAsync = promisify(execFile);
const SCRIPT = resolve("tools/delivery-validate/validate.mjs");
const PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
const keyOf = (n: number): KeyObject => createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.alloc(32, n)]), format: "der", type: "pkcs8" });
const K1 = keyOf(1);
const K2 = keyOf(2);
const KEY1 = publicKeyLine(K1);
const KEY2 = publicKeyLine(K2);
const H = (c: string, n = 64): string => c.repeat(n);
const GIT_ID = ["-c", "user.email=t@example.com", "-c", "user.name=t"];

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}
const run = async (args: string[]): Promise<Run> => {
  try {
    const r = await execFileAsync(process.execPath, [SCRIPT, ...args]);
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const err = e as { code: number; stdout: string; stderr: string };
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
};

let root: string;
let baseline: string;
let head: string;
let GOOD: Record<string, unknown>;
let lockHashes: { path: string; sha256: string }[];
let counter = 0;
const folder = (): string => {
  const d = join(root, `case-${counter++}`);
  mkdirSync(d);
  return d;
};
const git = (dir: string, ...args: string[]): string => execFileSync("git", ["-C", dir, ...GIT_ID, ...args], { encoding: "utf8" }).trim();
const copyRepo = (): string => {
  const d = join(folder(), "repo");
  cpSync(baseline, d, { recursive: true });
  return d;
};
const commitAll = (dir: string, msg = "change"): string => {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", msg);
  return git(dir, "rev-parse", "HEAD");
};

/** A contract for the baseline repository, changed by `mut`, re-canonicalised. */
const contractOf = (mut: (c: any) => void = () => {}): string => {
  const c = structuredClone(GOOD) as any;
  mut(c);
  return canonicalJson(c);
};

interface Files {
  contract: string;
  sig?: string;
  key?: string;
  checks?: unknown;
  comment?: string;
}
/** Writes the inputs of a case into its own folder and returns the arguments. */
const inputs = (f: Files): string[] => {
  const d = folder();
  writeFileSync(join(d, "contract.json"), f.contract);
  writeFileSync(join(d, "contract.sig"), f.sig ?? signDeliveryContract(f.contract, K1));
  let key = f.key ?? KEY1;
  if (!/^ssh-ed25519\s/.test(key) && !existsSync(key)) {
    writeFileSync(join(d, "key.pub"), key + "\n"); // a line that is not an Ed25519 key line is only read from a file
    key = join(d, "key.pub");
  }
  const args = ["--contract", join(d, "contract.json"), "--signature", join(d, "contract.sig"), "--public-key", key];
  if (f.checks !== undefined) {
    writeFileSync(join(d, "checks.json"), typeof f.checks === "string" ? f.checks : JSON.stringify(f.checks));
    args.push("--checks", join(d, "checks.json"));
  }
  if (f.comment !== undefined) {
    writeFileSync(join(d, "comment.md"), f.comment);
    args.push("--comment", join(d, "comment.md"));
  }
  return args;
};
const checkOf = (r: Run, name: string): any => (JSON.parse(r.stdout).checks as any[]).find((c) => c.check === name);
const json = (args: string[]): Promise<Run> => run([...args, "--json"]);
const ALL_OK = [{ name: "build", conclusion: "success" }, { name: "test", conclusion: "success" }];
const marker = (digest: string, evidence: string): string => `<!-- claude-factory delivery-contract digest=${digest} evidence=${evidence} -->`;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "delivery-validate-"));
  baseline = join(root, "baseline");
  mkdirSync(join(baseline, "sub"), { recursive: true });
  mkdirSync(join(baseline, ".github/workflows"), { recursive: true });
  writeFileSync(join(baseline, "package-lock.json"), '{"lock":1}\n');
  writeFileSync(join(baseline, "sub/pnpm-lock.yaml"), "lockfileVersion: 9\n");
  writeFileSync(join(baseline, ".github/workflows/build.yml"), "name: build\n");
  writeFileSync(join(baseline, ".github/workflows/test.yml"), "name: test\n");
  writeFileSync(join(baseline, ".github/dependabot.yml"), "version: 2\n");
  writeFileSync(join(baseline, "README.md"), "# readme\n");
  execFileSync("git", ["init", "-q", "-b", "main", baseline]);
  head = commitAll(baseline, "base");
  lockHashes = ["package-lock.json", "sub/pnpm-lock.yaml"].map((path) => ({ path, sha256: sha256Hex(readFileSync(join(baseline, path))) }));
  const blob = (p: string): string => git(baseline, "rev-parse", `HEAD:${p}`);
  const c = buildDeliveryContract({
    runId: "run-1",
    sequence: 1,
    repository: "acme/app",
    pullRequest: { repository: "acme/app", number: 7, url: "https://github.com/acme/app/pull/7", head },
    commit: { sha: head, branch: "feature/x" },
    dependencyLocks: lockHashes,
    ciWorkflows: [".github/workflows/build.yml", ".github/workflows/test.yml"].map((path) => ({ path, blob: blob(path) })),
    requiredChecks: ["build", "test"],
    evidence: { count: 3, terminalHash: H("e") },
    artifacts: [{ name: "report" }],
    provenance: { required: false },
  });
  GOOD = JSON.parse(deliveryContractText(c));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("parity with verifyDeliveryContract", () => {
  const sign = (t: string): string => signDeliveryContract(t, K1);
  const cases: { name: string; text: string; sig?: string; key?: string }[] = [];
  const add = (name: string, text: string, extra: { sig?: string; key?: string } = {}): void => void cases.push({ name, text, ...extra });
  const mut = (name: string, fn: (c: any) => void): void => add(name, contractOf(fn));

  beforeAll(() => {
    add("good", contractOf());
    mut("good, sequence 2", (c) => ((c.sequence = 2), (c.supersedes = H("9"))));
    add("not JSON", "nope");
    add("an array", "[]");
    add("null", "null");
    add("version 2", contractOf((c) => (c.version = 2)));
    add("version as text", contractOf((c) => (c.version = "1")));
    add("pretty printed", JSON.stringify(GOOD, null, 2));
    add("trailing newline", contractOf() + "\n");
    add("keys out of order", JSON.stringify(Object.fromEntries(Object.entries(GOOD).reverse())));
    add("number that is not finite", `{"version":1,"x":1e400}`);
    add("deeply nested", `{"version":1,"x":${"[".repeat(100000)}${"]".repeat(100000)}}`);
    mut("unknown top field", (c) => (c.extra = 1));
    mut("unknown nested field", (c) => (c.commit.extra = 1));
    add("__proto__ key", contractOf().replace(/^\{/, '{"__proto__":1,'));
    mut("missing field", (c) => delete c.repository);
    mut("sequence 2 without supersedes", (c) => (c.sequence = 2));
    mut("sequence 1 with supersedes", (c) => (c.supersedes = H("9")));
    mut("sequence 0", (c) => (c.sequence = 0));
    mut("sequence 1.5", (c) => (c.sequence = 1.5));
    mut("sequence 2**53", (c) => ((c.sequence = 2 ** 53), (c.supersedes = H("9"))));
    mut("pull request repository", (c) => (c.pullRequest.repository = "acme/other"));
    mut("pull request head", (c) => (c.pullRequest.head = H("d", 40)));
    mut("http url", (c) => (c.pullRequest.url = "http://github.com/acme/app/pull/7"));
    mut("url with user", (c) => (c.pullRequest.url = "https://u@github.com/acme/app/pull/7"));
    mut("url with query", (c) => (c.pullRequest.url = "https://github.com/acme/app/pull/7?q=1"));
    mut("branch with a space", (c) => (c.commit.branch = "a b"));
    mut("unsafe lock path ..", (c) => (c.dependencyLock.files[0].path = "../x"));
    mut("unsafe lock path /abs", (c) => (c.dependencyLock.files[0].path = "/abs"));
    mut("unsafe lock path backslash", (c) => (c.dependencyLock.files[0].path = "a\\b"));
    mut("workflow outside folder", (c) => (c.ciWorkflows[0].path = "ci/x.yml"));
    mut("workflow folder itself", (c) => (c.ciWorkflows[0].path = ".github/workflows/"));
    mut("wrong lock hash", (c) => (c.dependencyLock.sha256 = H("0")));
    mut("locks unsorted", (c) => c.dependencyLock.files.reverse());
    mut("locks duplicated", (c) => ((c.dependencyLock.files[1] = c.dependencyLock.files[0]), (c.dependencyLock.sha256 = canonicalHash(c.dependencyLock.files))));
    mut("workflows unsorted", (c) => c.ciWorkflows.reverse());
    mut("workflows duplicated", (c) => (c.ciWorkflows[1] = c.ciWorkflows[0]));
    mut("checks unsorted", (c) => c.requiredChecks.reverse());
    mut("checks duplicated", (c) => (c.requiredChecks[1] = c.requiredChecks[0]));
    mut("artifacts duplicated", (c) => c.artifacts.push(c.artifacts[0]));
    mut("stop conditions reversed", (c) => c.stopConditions.reverse());
    mut("stop conditions short", (c) => (c.stopConditions = c.stopConditions.slice(1)));
    mut("stop conditions extra", (c) => c.stopConditions.push("commit-changed"));
    mut("count 0", (c) => (c.evidence.count = 0));
    mut("evidence path", (c) => (c.evidence.path = "other.jsonl"));
    mut("name of 201 characters", (c) => (c.requiredChecks = ["a".repeat(201)]));
    mut("name with a control character", (c) => (c.requiredChecks = ["a\u0007b"]));
    mut("name with a leading space", (c) => (c.requiredChecks = [" a"]));
    add("empty signature", contractOf(), { sig: "" });
    add("whitespace signature", contractOf(), { sig: " \n" });
    add("signature of another text", contractOf(), { sig: sign("other") });
    add("another namespace", contractOf(), { sig: signSsh(contractOf(), K1, "other-ns") });
    add("another key", contractOf(), { sig: signDeliveryContract(contractOf(), K2) });
    add("garbage key line", contractOf(), { key: "garbage" });
    add("ssh-rsa key line", contractOf(), { key: "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC" });
    add("key line with a comment", contractOf(), { key: `${KEY1} me@example.com` });
    const good = signDeliveryContract(contractOf(), K1);
    add("armour: CRLF", contractOf(), { sig: good.replace(/\n/g, "\r\n") });
    add("armour: no final newline", contractOf(), { sig: good.slice(0, -1) });
    add("armour: wrapped at 64", contractOf(), { sig: good.replace(/^(.*\n)([\s\S]*?)(-----END)/, (_m, a: string, b: string, e: string) => a + (b.replace(/\n/g, "").match(/.{1,64}/g) ?? []).join("\n") + "\n" + e) });
    add("armour: changed character", contractOf(), { sig: good.replace(/\n([A-Za-z0-9+/])/, (_m, ch: string) => `\n${ch === "A" ? "B" : "A"}`) });
    add("armour: padding removed", contractOf(), { sig: good.replace(/=*\n-----END/, "\n-----END") });
  });

  it("gives the same verdict and fault on every case", async () => {
    const results = await Promise.all(
      cases.map(async (c) => {
        const sig = c.sig ?? signDeliveryContract(c.text, K1);
        const key = c.key ?? KEY1;
        const lib = verifyDeliveryContract(c.text, sig, key);
        const r = await json(inputs({ contract: c.text, sig, key }));
        if (r.stdout === "") throw new Error(`${c.name}: exit ${r.code}, stderr: ${r.stderr.slice(0, 300)}`);
        const out = JSON.parse(r.stdout);
        const failing = out.checks.find((x: any) => x.status === "stop");
        return { name: c.name, lib, code: r.code, failing, out };
      }),
    );
    for (const x of results) {
      if (x.lib.ok) {
        expect(x.failing?.check, x.name).not.toMatch(/^(contract|signature)$/);
        expect(x.out.digest, x.name).toMatch(/^[0-9a-f]{64}$/);
      } else {
        expect(x.code, x.name).toBe(1);
        expect(x.failing, x.name).toMatchObject({ condition: "signature-unverified", fault: x.lib.fault });
        expect(x.failing.check, x.name).toBe(x.lib.fault === "unreadable" || x.lib.fault === "wrong-version" ? "contract" : "signature");
        expect(x.out.digest, x.name).toBeNull();
      }
    }
  });

  it("reads a key from a file and skips # lines and empty lines", async () => {
    const t = contractOf();
    const d = folder();
    writeFileSync(join(d, "key.pub"), `# trusted key\n\n${KEY1} ci\n${KEY2}\n`);
    const args = inputs({ contract: t, key: join(d, "key.pub") });
    expect(verifyDeliveryContract(t, signDeliveryContract(t, K1), `${KEY1} ci`).ok).toBe(true);
    expect(checkOf(await json([...args, "--repo", baseline]), "signature").status).toBe("ok");
    writeFileSync(join(d, "key.pub"), "# only a comment\n");
    expect((await run(args)).code).toBe(2);
  });
});

describe("the git checks", () => {
  it("passes on the baseline", async () => {
    const r = await json([...inputs({ contract: contractOf(), checks: ALL_OK }), "--repo", baseline]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).checks.map((c: any) => `${c.check}:${c.status}`)).toEqual([
      "contract:ok", "signature:ok", "commit:ok", "locks:ok", "workflows:ok", "checks:ok", "evidence:skipped", "comment:skipped",
    ]);
  });

  it("stops when the commit changed, but still checks locks and workflows", async () => {
    const repo = copyRepo();
    writeFileSync(join(repo, "README.md"), "changed\n");
    const newHead = commitAll(repo);
    const r = await json([...inputs({ contract: contractOf() }), "--repo", repo]);
    expect(r.code).toBe(1);
    expect(checkOf(r, "commit")).toMatchObject({ status: "stop", condition: "commit-changed" });
    expect(checkOf(r, "commit").reason).toContain(newHead);
    expect(checkOf(r, "locks").status).toBe("ok");
    expect(checkOf(r, "workflows").status).toBe("ok");
  });

  it("stops when a lock file changed, is missing or is not a file", async () => {
    const outcomes = await Promise.all(
      [
        (repo: string) => writeFileSync(join(repo, "package-lock.json"), "{}\n"),
        (repo: string) => rmSync(join(repo, "package-lock.json")),
        (repo: string) => (rmSync(join(repo, "sub/pnpm-lock.yaml")), mkdirSync(join(repo, "sub/pnpm-lock.yaml")), writeFileSync(join(repo, "sub/pnpm-lock.yaml/x"), "x")),
      ].map(async (change) => {
        const repo = copyRepo();
        change(repo);
        commitAll(repo);
        const r = await json([...inputs({ contract: contractOf((c) => (c.commit.sha = git(repo, "rev-parse", "HEAD")) && (c.pullRequest.head = c.commit.sha)) }), "--repo", repo]);
        return checkOf(r, "locks");
      }),
    );
    expect(outcomes.map((o) => o.condition)).toEqual(["lock-changed", "lock-changed", "lock-changed"]);
    expect(outcomes.map((o) => o.reason)).toEqual(["package-lock.json was changed", "package-lock.json is missing", "sub/pnpm-lock.yaml is not a file"]);
  });

  it("hashes a symlink lock as the stored link, without following it", async () => {
    const repo = copyRepo();
    symlinkSync("package-lock.json", join(repo, "link-lock"));
    commitAll(repo);
    const sha = git(repo, "rev-parse", "HEAD");
    const withLock = (hash: string) =>
      contractOf((c) => {
        c.commit.sha = sha;
        c.pullRequest.head = sha;
        c.dependencyLock.files = [{ path: "link-lock", sha256: hash }];
        c.dependencyLock.sha256 = canonicalHash(c.dependencyLock.files);
      });
    const [ok, followed] = await Promise.all([
      json([...inputs({ contract: withLock(sha256Hex("package-lock.json")) }), "--repo", repo]),
      json([...inputs({ contract: withLock(lockHashes[0]!.sha256) }), "--repo", repo]),
    ]);
    expect(checkOf(ok, "locks").status).toBe("ok");
    expect(checkOf(followed, "locks")).toMatchObject({ status: "stop", condition: "lock-changed" });
  });

  it("stops when a workflow was added, removed or changed, and ignores other files", async () => {
    const change = async (fn: (repo: string) => void): Promise<any> => {
      const repo = copyRepo();
      fn(repo);
      const sha = commitAll(repo);
      const c = contractOf((x) => ((x.commit.sha = sha), (x.pullRequest.head = sha)));
      return checkOf(await json([...inputs({ contract: c }), "--repo", repo]), "workflows");
    };
    const [added, removed, changed, sub, dependabot, tabbed] = await Promise.all([
      change((r) => writeFileSync(join(r, ".github/workflows/deploy.yml"), "x")),
      change((r) => rmSync(join(r, ".github/workflows/test.yml"))),
      change((r) => writeFileSync(join(r, ".github/workflows/build.yml"), "changed")),
      change((r) => (mkdirSync(join(r, ".github/workflows/sub")), writeFileSync(join(r, ".github/workflows/sub/x.yml"), "x"))),
      change((r) => writeFileSync(join(r, ".github/dependabot.yml"), "changed")),
      change((r) => writeFileSync(join(r, ".github/workflows/a\tb.yml"), "x")),
    ]);
    expect(added).toMatchObject({ status: "stop", condition: "workflow-changed", reason: ".github/workflows/deploy.yml was added" });
    expect(removed.reason).toBe(".github/workflows/test.yml was removed");
    expect(changed.reason).toBe(".github/workflows/build.yml was changed");
    expect(sub.reason).toBe(".github/workflows/sub/x.yml was added");
    expect(dependabot.status).toBe("ok");
    expect(tabbed.reason).toBe(".github/workflows/a?b.yml was added");
  });
});

describe("required checks", () => {
  const checkWith = async (checks?: unknown): Promise<{ code: number; check: any }> => {
    const r = await json([...inputs({ contract: contractOf(), checks }), "--repo", baseline]);
    return { code: r.code, check: checkOf(r, "checks") };
  };
  it("stops on a missing, failed, null or duplicated-with-failure check", async () => {
    const bad = await Promise.all([
      checkWith([{ name: "build", conclusion: "success" }]),
      checkWith([{ name: "build", conclusion: "success" }, { name: "test", conclusion: "failure" }]),
      checkWith([{ name: "build", conclusion: "success" }, { name: "test", conclusion: null }]),
      checkWith([...ALL_OK, { name: "test", conclusion: "failure" }]),
      checkWith([]),
    ]);
    for (const b of bad) expect(b).toMatchObject({ code: 1, check: { status: "stop", condition: "required-check-failed" } });
    expect(bad[0]!.check.reason).toBe("test is missing");
    expect(bad[3]!.check.reason).toBe("test did not pass");
  });
  it("passes when all pass (extra checks and keys are fine); skips without --checks", async () => {
    expect(await checkWith([...ALL_OK, { name: "lint", conclusion: "failure" }, { name: "build", conclusion: "success", id: 5 }])).toMatchObject({ code: 0, check: { status: "ok" } });
    expect(await checkWith(undefined)).toMatchObject({ code: 0, check: { status: "skipped" } });
  });
  it("refuses a file of the wrong shape and never echoes it", async () => {
    const runs = await Promise.all(["{}", "[1]", '[{"name":1,"conclusion":"success"}]', '[{"name":"a"}]', "SECRET-XYZ not json"].map((c) => run(inputs({ contract: contractOf(), checks: c }))));
    for (const r of runs) {
      expect(r.code).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toMatch(/^delivery-validate: --checks is not a JSON list/);
      expect(r.stderr).not.toContain("SECRET");
    }
  });
});

describe("the PR comment", () => {
  const digest = (): string => contractDigest(contractOf());
  const evidence = (): string => H("e");
  const commentWith = async (comment: string): Promise<Run> => json([...inputs({ contract: contractOf(), comment }), "--repo", baseline]);
  it("accepts the marker, also with CRLF and among other text", async () => {
    const m = marker(digest(), evidence());
    for (const c of [m, `${m}\r\n`, `hello\r\n${m}\r\nbye\n`]) expect(checkOf(await commentWith(c), "comment")).toEqual({ check: "comment", status: "ok" });
  });
  it("stops for another digest or evidence hash; the digest wins", async () => {
    const [d, e, both] = await Promise.all([commentWith(marker(H("1"), evidence())), commentWith(marker(digest(), H("1"))), commentWith(marker(H("1"), H("2")))]);
    expect(checkOf(d, "comment")).toMatchObject({ status: "stop", condition: "superseded" });
    expect(checkOf(e, "comment")).toMatchObject({ status: "stop", condition: "evidence-unverified" });
    expect(checkOf(both, "comment").condition).toBe("superseded");
    expect(d.code).toBe(1);
  });
  it("is a read error with no marker, two markers or a quoted marker", async () => {
    const m = marker(digest(), evidence());
    const runs = await Promise.all(["nothing", `${m}\n${marker(H("1"), evidence())}`, `${m}\n${m}`, `> ${m}`, m.toUpperCase()].map(commentWith));
    for (const r of runs) {
      expect(r.code).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toMatch(/^delivery-validate: --comment has/);
    }
  });
});

describe("output and errors", () => {
  it("prints the 8 lines of a good run", async () => {
    const m = marker(contractDigest(contractOf()), H("e"));
    const r = await run([...inputs({ contract: contractOf(), checks: ALL_OK, comment: m }), "--repo", baseline]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      "contract: ok\nsignature: ok\ncommit: ok\nlocks: ok\nworkflows: ok\nchecks: ok\nevidence: skipped (no --events given)\ncomment: ok\n",
    );
  });
  it("prints one JSON object with --json", async () => {
    const r = await json([...inputs({ contract: contractOf() }), "--repo", baseline]);
    expect(JSON.parse(r.stdout)).toEqual({
      version: 1,
      result: "ok",
      digest: contractDigest(contractOf()),
      checks: [
        { check: "contract", status: "ok" },
        { check: "signature", status: "ok" },
        { check: "commit", status: "ok" },
        { check: "locks", status: "ok" },
        { check: "workflows", status: "ok" },
        { check: "checks", status: "skipped", reason: "no --checks file was given" },
        { check: "evidence", status: "skipped", reason: "no --events given" },
        { check: "comment", status: "skipped", reason: "no --comment file was given" },
      ],
    });
  });
  it("skips every later check, and never calls git, for an untrusted contract", async () => {
    const notARepo = folder();
    const r = await run([...inputs({ contract: contractOf(), key: KEY2 }), "--repo", notARepo]);
    expect(r.code).toBe(1);
    const lines = r.stdout.trim().split("\n");
    expect(lines[0]).toBe("contract: ok");
    expect(lines[1]).toBe("signature: stop signature-unverified: the contract is not signed by the trusted key");
    expect(lines.slice(2)).toEqual(["commit", "locks", "workflows", "checks", "evidence", "comment"].map((c) => `${c}: skipped (the contract is not trusted)`));
  });
  it("is a usage or read error (exit 2) without stdout and without file content", async () => {
    const ok = inputs({ contract: contractOf() });
    const big = folder();
    writeFileSync(join(big, "big"), "x".repeat(1024 * 1024 + 1));
    const plain = folder();
    const cases: string[][] = [
      [],
      [...ok, "--events", "x"],
      [...ok, "--bogus"],
      [...ok, "stray"],
      ["--signature", "a", "--public-key", KEY1],
      ["--contract", join(plain, "missing"), ...ok.slice(2)],
      ["--contract", plain, ...ok.slice(2)],
      ["--contract", join(big, "big"), ...ok.slice(2)],
      [...ok, "--repo", join(plain, "missing")],
      [...ok, "--repo", join(big, "big")],
      [...ok, "--repo", plain],
    ];
    const runs = await Promise.all(cases.map(run));
    for (const r of runs) {
      expect(r.code).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toMatch(/^delivery-validate: /);
      expect(r.stderr).not.toContain("SECRET");
    }
    const secret = await run(inputs({ contract: "SECRET-XYZ" }));
    expect(secret.code).toBe(1); // an unreadable contract is a stop, not an error
    expect(secret.stdout + secret.stderr).not.toContain("SECRET");
  });
  it("never repeats an unknown field name, in text or JSON output", async () => {
    const top = contractOf((c) => (c["SECRET-XYZ"] = 1));
    const nested = contractOf((c) => (c.commit["SECRET-NESTED"] = 1));
    for (const t of [top, nested]) {
      const text = await run([...inputs({ contract: t }), "--repo", baseline]);
      const json = await run([...inputs({ contract: t }), "--repo", baseline, "--json"]);
      for (const r of [text, json]) {
        expect(r.code).toBe(1);
        expect(r.stdout + r.stderr).not.toMatch(/SECRET/);
        expect(r.stdout).toContain("(unknown field)");
      }
    }
  });
  it("prints the usage for --help", async () => {
    const r = await run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("usage:");
  });
});

describe("the script", () => {
  it("imports only node: modules", () => {
    const src = readFileSync(SCRIPT, "utf8");
    const specs = [...src.matchAll(/(?:^|[\s;(])(?:import\s[^"']*?from\s*|import\s*\(\s*|import\s+)["']([^"']+)["']/gm)].map((m) => m[1]!);
    expect(specs.length).toBeGreaterThan(0);
    for (const s of specs) expect(s, s).toMatch(/^node:/);
    expect(src).not.toMatch(/\brequire\s*\(/);
  });
  it("never writes a file", async () => {
    const repo = copyRepo();
    const snapshot = (dir: string): string[] =>
      readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => {
          const p = join(e.parentPath, e.name);
          return `${p} ${statSync(p).size} ${statSync(p).mtimeMs} ${sha256Hex(readFileSync(p))}`;
        })
        .sort();
    const args = inputs({ contract: contractOf(), checks: ALL_OK, comment: marker(contractDigest(contractOf()), H("e")) });
    const dir = args[1]!.replace(/\/[^/]+$/, "");
    const before = [snapshot(repo), snapshot(dir)];
    await run([...args, "--repo", repo]);
    expect([snapshot(repo), snapshot(dir)]).toEqual(before);
    expect(git(repo, "status", "--porcelain")).toBe("");
  });
});

describe("scf delivery validate", () => {
  const capture = (args: string[]): Run => {
    let stdout = "";
    let stderr = "";
    const code = deliveryCommand(args, { out: (s) => void (stdout += s), err: (s) => void (stderr += s) });
    return { code, stdout, stderr };
  };
  it("gives the output of the script", async () => {
    const good = [...inputs({ contract: contractOf() }), "--repo", baseline];
    const stopped = [...inputs({ contract: contractOf(), key: KEY2 }), "--repo", baseline];
    const broken = ["--contract", "nope"];
    for (const args of [good, stopped, broken, ["--help"]]) {
      expect(capture(["validate", ...args]), args.join(" ")).toEqual(await run(args));
    }
  });
  it("refuses anything but validate", () => {
    for (const args of [[], ["other"]]) {
      const r = capture(args);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("usage: scf delivery validate");
    }
  });
  it("is a command of the built scf", () => {
    const cli = resolve("dist/cli.js");
    if (!existsSync(cli)) throw new Error(`${cli} is missing — run \`npm run build\` first`);
    const args = [...inputs({ contract: contractOf() }), "--repo", baseline];
    const env = { ...process.env, FACTORY_HOME: join(folder(), "home") };
    const viaCli = spawnSync(process.execPath, [cli, "delivery", "validate", ...args], { encoding: "utf8", env });
    const direct = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
    expect({ code: viaCli.status, out: viaCli.stdout, err: viaCli.stderr }).toEqual({ code: direct.status, out: direct.stdout, err: direct.stderr });
    expect(viaCli.status).toBe(0);
    const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8", env });
    expect(help.stdout).toContain("scf delivery validate");
    expect(existsSync(env.FACTORY_HOME)).toBe(false);
  });
});
