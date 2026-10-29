import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ConfigSchema } from "../src/config.js";
import { redactText, resetRedactCache } from "../src/credentials/redact.js";
import { FakeSecretSchema, registerFakeSecrets } from "../src/eval-secrets.js";
import { EVAL_USER, SAFETY_DIR } from "../src/evals.js";
import { shortEnv, shortEnvRun } from "../src/engine/short-env.js";
import { storeRunDiff } from "../src/evidence/finalize.js";
import { credentialProblem, riskyFileName } from "../src/skills/credential-scan.js";

const NAME = "SCF_EVAL_UNIT_TOKEN";
const VALUE = "SCF-EVAL-UNIT-TOKEN-1234567";
let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "factory-eval-secrets-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env[NAME];
  delete process.env.SCF_STEP_ENV_PASS;
  resetRedactCache();
});

describe("FakeSecretSchema", () => {
  it("accepts a prefixed name and a long enough value", () => {
    expect(FakeSecretSchema.safeParse({ name: "SCF_EVAL_X", value: "a".repeat(16) }).success).toBe(true);
  });

  it("refuses other names, short or odd values and extra keys", () => {
    const ok = { name: "SCF_EVAL_X", value: "a".repeat(16) };
    for (const bad of [
      { ...ok, name: "PATH" },
      { ...ok, name: "ANTHROPIC_API_KEY" },
      { ...ok, name: "SCF_EVAL_" },
      { ...ok, name: "scf_eval_x" },
      { ...ok, value: "a".repeat(15) },
      { ...ok, value: "has a space 123456" },
      { ...ok, extra: 1 },
    ]) expect(FakeSecretSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
});

describe("registerFakeSecrets", () => {
  it("sets and hides the value, and removes it once, however often restore is called", () => {
    const restore = registerFakeSecrets([{ name: NAME, value: VALUE }]);
    expect(process.env[NAME]).toBe(VALUE);
    expect(redactText(`x ${VALUE} x`)).toContain("[redacted]");
    expect(redactText(`x ${VALUE} x`)).not.toContain(VALUE);
    restore();
    restore();
    expect(process.env[NAME]).toBeUndefined();
  });

  it("keeps an identical value that was set before", () => {
    process.env[NAME] = VALUE;
    registerFakeSecrets([{ name: NAME, value: VALUE }])();
    expect(process.env[NAME]).toBe(VALUE);
  });

  it("throws before it changes anything: two values for one name, or a name set to another value", () => {
    expect(() => registerFakeSecrets([{ name: NAME, value: VALUE }, { name: NAME, value: `${VALUE}2` }])).toThrow(/different values/);
    expect(process.env[NAME]).toBeUndefined();
    process.env[NAME] = "something-else-entirely";
    expect(() => registerFakeSecrets([{ name: "SCF_EVAL_OTHER_ONE", value: VALUE }, { name: NAME, value: VALUE }])).toThrow(/already set/);
    expect(process.env.SCF_EVAL_OTHER_ONE).toBeUndefined();
    expect(process.env[NAME]).toBe("something-else-entirely");
  });

  it("holds the value until the last of two overlapping registrations lets go", () => {
    const a = registerFakeSecrets([{ name: NAME, value: VALUE }]);
    const b = registerFakeSecrets([{ name: NAME, value: VALUE }]);
    a();
    expect(process.env[NAME]).toBe(VALUE);
    expect(redactText(VALUE)).toBe("[redacted]");
    b();
    expect(process.env[NAME]).toBeUndefined();
  });
});

describe("a safety user run", () => {
  const config = ConfigSchema.parse({});
  const source = { PATH: "/bin", [NAME]: VALUE };

  it("counts as a user's run and its steps do not get the fake key, even when an admin lists it", () => {
    expect(shortEnvRun(EVAL_USER)).toBe(true);
    for (const pass of [undefined, `${NAME},SCF_EVAL_*`]) {
      if (pass) process.env.SCF_STEP_ENV_PASS = pass;
      for (const need of [{ agent: "claude", kind: "anthropic" } as const, undefined]) {
        const env = shortEnv({}, config, need, source);
        expect(env.PATH).toBe("/bin");
        expect(env).not.toHaveProperty(NAME);
        expect(Object.values(env)).not.toContain(VALUE);
      }
    }
  });
});

describe("the stored diff", () => {
  it("hides a registered fake key", () => {
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=a", ...a], { cwd: tmp, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    writeFileSync(join(tmp, "a.txt"), "one\n");
    git("add", "-A");
    git("commit", "-qm", "one");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(tmp, "b.txt"), `${VALUE}\n`);
    git("add", "-A");
    git("commit", "-qm", "two");
    const final = git("rev-parse", "HEAD");
    const runDir = join(tmp, "run");
    mkdirSync(runDir);
    const restore = registerFakeSecrets([{ name: NAME, value: VALUE }]);
    try {
      const ref = storeRunDiff({ runDir, workdir: tmp }, base, final);
      expect(ref).toBeDefined();
      const text = readFileSync(join(runDir, ref!.path), "utf8");
      expect(text).toContain("[redacted]");
      expect(text).not.toContain(VALUE);
    } finally {
      restore();
    }
  });
});

describe("the credential-exposure suite", () => {
  const dir = join(SAFETY_DIR, "credential-exposure");

  it("uses a fake token that matches no provider format and sits in a file that is not risky", () => {
    const suite = parse(readFileSync(join(dir, "suite.yaml"), "utf8"));
    const value = suite.cases[0].fake_secret.value as string;
    expect(readFileSync(join(dir, "fixture", "token.txt"), "utf8").trim()).toBe(value);
    expect(credentialProblem(value)).toBeUndefined();
    expect(riskyFileName("token.txt")).toBe(false);
  });
});
