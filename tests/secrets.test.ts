import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { protectedBranchEnv } from "../src/engine/guards.js";

const SCAN = resolve("tools/secret-scan");
// Built at runtime so this file itself never contains a key-shaped string.
const GH_TOKEN = "ghp_" + "a1B2c3D4e5".repeat(4);
const AWS_KEY = "AKIA" + "ABCDEFGHIJKLMNOP";

let tmp: string;
let repo: string;
const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
const commit = (file: string, text: string) => {
  mkdirSync(join(repo, file, ".."), { recursive: true });
  writeFileSync(join(repo, file), text);
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", `add ${file}`);
};
const scan = (...args: string[]) => spawnSync(SCAN, args, { cwd: repo, encoding: "utf8" });

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "factory-secrets-"));
  repo = join(tmp, "repo");
  mkdirSync(repo);
  git("init", "-q", "-b", "main");
  commit("README.md", "hello\n");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("secret-scan", () => {
  it("passes clean commits and ignores placeholders", () => {
    commit("src/a.js", 'const password = "changeme-please-123";\nconst apiKey = process.env.API_KEY;\nconst token = "{{vars.token}}";\n');
    const r = scan("HEAD~1..HEAD");
    expect(r.stdout).toContain("no secrets found");
    expect(r.status).toBe(0);
  });

  it("finds tokens, keys and sensitive files, masked, with file and line", () => {
    commit("src/cfg.js", `// config\nexport const gh = "${GH_TOKEN}";\nexport const aws = "${AWS_KEY}";\n`);
    commit(".env", "X=1\n");
    const r = scan("HEAD~2..HEAD");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("src/cfg.js:2  GitHub token  ghp_…");
    expect(r.stderr).toContain("src/cfg.js:3  AWS access key");
    expect(r.stderr).toContain(".env  sensitive file");
    expect(r.stderr).not.toContain(GH_TOKEN);
  });

  it("flags a private key only when key data follows the header", () => {
    const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7" + "x".repeat(20);
    commit("src/gen.java", 'write("-----BEGIN PRIVATE KEY-----\\n" + encode(generated.getPrivate()) + "\\n-----END PRIVATE KEY-----\\n");\n');
    expect(scan().status).toBe(0);
    commit("config/key.txt", `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`);
    const r = scan();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("config/key.txt:1  private key");
  });

  it("honours inline and file allow-lists", () => {
    commit("test/fixture.js", `const t = "${GH_TOKEN}"; // factory:allow-secret\n`);
    expect(scan("HEAD~1..HEAD").status).toBe(0);
    commit("docs/example.md", `aws: ${AWS_KEY}\n`);
    expect(scan("HEAD~1..HEAD").status).toBe(1);
    commit(".claude-factory/secret-allow", "^docs/example\\.md:\n");
    expect(scan("HEAD~2..HEAD").status).toBe(0);
  });

  it("--text replaces secrets in text from stdin, keeps the rest and needs no git repository", () => {
    const pem = ["-----BEGIN RSA " + "PRIVATE KEY-----", "A".repeat(64), "-----END RSA " + "PRIVATE KEY-----"].join("\n");
    const input = `token ${GH_TOKEN} and ${AWS_KEY} fine words\n${pem}\nafter`;
    const r = spawnSync(SCAN, ["--text"], { cwd: tmp, input, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain(GH_TOKEN);
    expect(r.stdout).not.toContain(AWS_KEY);
    expect(r.stdout).not.toContain("AAAAAAAA");
    expect(r.stdout).toContain("fine words");
    expect(r.stdout).toContain("after");
  });

  it("blocks a push through the pre-push hook", () => {
    const remote = join(tmp, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", remote]);
    git("remote", "add", "origin", remote);
    git("push", "-q", "origin", "main");
    git("checkout", "-q", "-b", "factory/x");
    commit("src/leak.js", `export const k = "${GH_TOKEN}";\n`);
    const pushLog = join(tmp, "pushes.log");
    const env = { ...process.env, ...protectedBranchEnv(["main"], true), FACTORY_PUSH_LOG: pushLog, GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    const r = spawnSync("git", ["push", "-q", "-u", "origin", "HEAD"], { cwd: repo, env, encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("src/leak.js:1  GitHub token");
    expect(readFileSync(pushLog, "utf8").trim()).toMatch(new RegExp(`^factory/x\\t${remote.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\t([1-9]\\d*)\\t1$`));
    // Fixing the commit lets the push through.
    git("reset", "-q", "--hard", "HEAD~1");
    commit("src/ok.js", "export const k = process.env.K;\n");
    const ok = spawnSync("git", ["push", "-q", "-u", "origin", "HEAD"], { cwd: repo, env, encoding: "utf8" });
    expect(ok.status).toBe(0);
  });
});

describe("the pre-push hook itself", () => {
  const ZERO = "0".repeat(40);
  const SHA = "a".repeat(40);
  const URL = "https://github.com/acme/x.git";
  let marker: string;
  let pushLog: string;

  /** A fake scanner: appends to the marker, prints `text`, exits with `code`. It never reads stdin. */
  const fakeScanner = (code: number, text = "") => {
    const file = join(tmp, "fake-scan");
    writeFileSync(file, `#!/bin/sh\necho called >> '${marker}'\n${text ? `printf '%s\\n' '${text}'\n` : ""}exit ${code}\n`, { mode: 0o755 });
    return file;
  };
  const run = (refs: string[], opts: { scan?: string; config?: Array<[string, string]>; committer?: boolean } = {}) => {
    const guard = protectedBranchEnv(["main"], true);
    const hook = join(guard.GIT_CONFIG_VALUE_0!, "pre-push");
    const env: Record<string, string | undefined> = { ...process.env, ...guard, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    delete env.EMAIL;
    delete env.GIT_COMMITTER_NAME;
    delete env.GIT_COMMITTER_EMAIL;
    if (opts.committer !== false) Object.assign(env, { GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
    const extra = opts.config ?? [];
    env.GIT_CONFIG_COUNT = String(1 + extra.length);
    extra.forEach(([k, v], i) => Object.assign(env, { [`GIT_CONFIG_KEY_${i + 1}`]: k, [`GIT_CONFIG_VALUE_${i + 1}`]: v }));
    env.FACTORY_SECRET_SCAN = opts.scan ?? fakeScanner(0);
    env.FACTORY_PUSH_LOG = pushLog;
    return spawnSync("sh", [hook, "origin", URL], { cwd: tmp, input: refs.join("\n") + "\n", env: env as NodeJS.ProcessEnv, encoding: "utf8" });
  };
  const logged = () => (existsSync(pushLog) ? readFileSync(pushLog, "utf8").trim().split("\n") : []);
  const calls = () => (existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n").length : 0);
  const ref = (branch: string, local = SHA, remote = ZERO) => `refs/heads/${branch} ${local} refs/heads/${branch} ${remote}`;

  beforeEach(() => {
    marker = join(tmp, "marker");
    pushLog = join(tmp, "push.log");
  });

  it("refuses when the scanner exits with 2 or is missing, and does not know the count", () => {
    const failed = run([ref("feat")], { scan: fakeScanner(2) });
    expect(failed.status).toBe(1);
    expect(logged()).toEqual([`feat\t${URL}\t\t1`]);
    rmSync(pushLog);
    const missing = run([ref("feat")], { scan: join(tmp, "no-such-scanner") });
    expect(missing.status).toBe(1);
    expect(logged()).toEqual([`feat\t${URL}\t\t1`]);
  });

  it("refuses on exit 1 and counts the secrets from the summary line, or 1 without it", () => {
    expect(run([ref("feat")], { scan: fakeScanner(1) }).status).toBe(1);
    expect(logged()).toEqual([`feat\t${URL}\t1\t1`]);
    rmSync(pushLog);
    const r = run([ref("feat")], { scan: fakeScanner(1, "secret-scan: 3 possible secret(s) in the commits being pushed:") });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("secret-scan: 3 possible secret(s)");
    expect(logged()).toEqual([`feat\t${URL}\t3\t1`]);
  });

  it("lets clean pushes and deletions through, and scans a deletion never", () => {
    const r = run([ref("feat"), ref("old", ZERO, SHA)]);
    expect(r.status).toBe(0);
    expect(logged()).toEqual([`feat\t${URL}\t0\t1`, `old\t${URL}\t0\t1`]);
    expect(calls()).toBe(1);
  });

  it("refuses a protected branch without calling the scanner", () => {
    const r = run([ref("main")]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("protected branch 'main'");
    expect(logged()).toEqual([`main\t${URL}\t\t1`]);
    expect(calls()).toBe(0);
  });

  it("finds the commit identity the way git does, and never fails the push for it", () => {
    expect(run([ref("feat")]).status).toBe(0);
    expect(logged()).toEqual([`feat\t${URL}\t0\t1`]);
    rmSync(pushLog);
    const config: Array<[string, string]> = [["committer.name", "c"], ["committer.email", "c@c"], ["user.useConfigOnly", "true"]];
    expect(run([ref("feat")], { committer: false, config }).status).toBe(0);
    expect(logged()).toEqual([`feat\t${URL}\t0\t1`]);
    rmSync(pushLog);
    expect(run([ref("feat")], { committer: false, config: [["user.useConfigOnly", "true"]] }).status).toBe(0);
    expect(logged()).toEqual([`feat\t${URL}\t0\t0`]);
  });
});
