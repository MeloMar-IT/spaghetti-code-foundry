import { generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getServiceAccount, tokenState, listServiceAccounts, createServiceAccount, revokeServiceToken, lookupServiceToken } from "../src/auth/service-accounts.js";
import { ConfigSchema, serviceCommandProblem } from "../src/config.js";
import { rawPublicKey } from "../src/skills/release-signature.js";
import { nextDelay } from "../src/services/supervisor.js";
import { ServiceProblem, hasServiceState, programProblem, reconcileServiceTokens, serviceToken, signatureProblem } from "../src/services/setup.js";
import { deleteUser } from "../src/auth/users.js";

// Managed services (#867): config schema, program and signature checks, accounts and tokens. No child process here.

let home: string;
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "svc-setup-"));
  process.env.FACTORY_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const entry = (over: Record<string, unknown> = {}) => ({ name: "echo-bot", command: "/usr/bin/true", scope: ["GET health"], ...over });
const parse = (services: unknown) => ConfigSchema.safeParse({ services });
const program = (name = "prog", body = "#!/bin/sh\nexit 0\n", mode = 0o755) => {
  const p = join(home, "bin", name);
  mkdirSync(join(home, "bin"), { recursive: true });
  writeFileSync(p, body);
  chmodSync(p, mode);
  return p;
};
const live = (token: string) => lookupServiceToken(token)?.state === "live";

describe("config", () => {
  it("accepts a full entry and fills the defaults", () => {
    const key = rawPublicKey(generateKeyPairSync("ed25519").publicKey);
    const r = parse([entry({ args: ["--x"], env: { API_KEY: "v" }, public_key: key })]);
    expect(r.success).toBe(true);
    expect(parse([entry()]).data!.services[0]).toMatchObject({ args: [], env: {} });
  });

  it("has no services by default", () => {
    expect(ConfigSchema.parse({}).services).toEqual([]);
  });

  it.each([
    ["relative command", entry({ command: "bin/x" })],
    ["https url", entry({ command: "https://h/x" })],
    ["file url", entry({ command: "file:///x" })],
    ["dot-dot", entry({ command: "/a/../b" })],
    ["single dot", entry({ command: "/a/./b" })],
    ["double slash", entry({ command: "/a//b" })],
    ["bad name", entry({ name: "Bad Name" })],
    ["bad key", entry({ public_key: "abcd" })],
    ["SCF_ env", entry({ env: { SCF_TOKEN: "x" } })],
    ["FACTORY_ env", entry({ env: { FACTORY_X: "x" } })],
    ["bad env name", entry({ env: { "1BAD": "x" } })],
    ["scope without a method", entry({ scope: ["runs"] })],
    ["scope twice", entry({ scope: ["GET runs", "GET runs"] })],
    ["no scope", { name: "a", command: "/usr/bin/true" }],
    ["unknown key", entry({ extra: 1 })],
  ])("refuses %s", (_n, e) => {
    expect(parse([e]).success).toBe(false);
  });

  it("refuses a command in the runs or workspaces folder", () => {
    expect(parse([entry({ command: join(home, "runs/r1/workspace/x") })].map((e) => e)).success).toBe(false);
    expect(parse([entry({ command: join(home, "workspaces/x") })]).success).toBe(false);
    expect(serviceCommandProblem(join(home, "runs"), home)).toMatch(/workspaces/);
    expect(serviceCommandProblem(join(home, "runsx/p"), home)).toBeUndefined();
  });

  it("refuses duplicates and more than 10", () => {
    expect(parse([entry(), entry()]).success).toBe(false);
    expect(parse(Array.from({ length: 11 }, (_, i) => entry({ name: `s${i}` }))).success).toBe(false);
    expect(parse(Array.from({ length: 10 }, (_, i) => entry({ name: `s${i}` }))).success).toBe(true);
  });
});

describe("programProblem", () => {
  const where = () => ({ home, runsDir: join(home, "runs") });

  it("returns the real path of a good program", () => {
    const p = program();
    expect(programProblem(p, where())).toHaveProperty("realPath");
  });

  it("refuses a missing file, a directory and a file that cannot run", () => {
    expect(programProblem(join(home, "nope"), where())).toHaveProperty("problem");
    mkdirSync(join(home, "d"));
    expect(programProblem(join(home, "d"), where())).toHaveProperty("problem");
    expect(programProblem(program("plain", "x", 0o644), where())).toHaveProperty("problem");
  });

  it("refuses a link into the runs folder", () => {
    const runs = join(home, "runs");
    mkdirSync(join(runs, "r1"), { recursive: true });
    const target = join(runs, "r1", "bot");
    writeFileSync(target, "#!/bin/sh\n", { mode: 0o755 });
    const link = join(home, "link");
    symlinkSync(target, link);
    const r = programProblem(link, where());
    expect(r).toEqual({ problem: "the program is inside the run workspaces" });
  });
});

describe("signatureProblem", () => {
  const keys = generateKeyPairSync("ed25519");
  const pub = rawPublicKey(keys.publicKey);
  const sigOf = (p: string) => sign(null, readFileSync(p), keys.privateKey);

  it("accepts a raw and a base64 signature", () => {
    const p = program();
    writeFileSync(`${p}.sig`, sigOf(p));
    expect(signatureProblem(p, p, pub)).toBeUndefined();
    writeFileSync(`${p}.sig`, sigOf(p).toString("base64") + "\n");
    expect(signatureProblem(p, p, pub)).toBeUndefined();
  });

  it("gives a fixed sentence for every failure", () => {
    const p = program();
    expect(signatureProblem(p, p, pub)).toBe("the signature file is missing");
    writeFileSync(`${p}.sig`, "junk");
    expect(signatureProblem(p, p, pub)).toBe("the signature file is not a valid Ed25519 signature");
    writeFileSync(`${p}.sig`, sigOf(p));
    writeFileSync(p, "changed");
    expect(signatureProblem(p, p, pub)).toBe("the signature does not match the program");
    writeFileSync(`${p}.sig`, Buffer.alloc(64, 1));
    expect(signatureProblem(p, p, pub)).toBe("the signature does not match the program");
    const other = rawPublicKey(generateKeyPairSync("ed25519").publicKey);
    writeFileSync(p, "same");
    writeFileSync(`${p}.sig`, sigOf(p));
    expect(signatureProblem(p, p, other)).toBe("the signature does not match the program");
  });
});

describe("serviceToken", () => {
  it("makes the account, records it and gives a live token", () => {
    expect(hasServiceState()).toBe(false);
    const { accountId, token } = serviceToken("echo-bot", ["GET health"]);
    expect(hasServiceState()).toBe(true);
    expect(live(token)).toBe(true);
    expect(getServiceAccount(accountId)).toMatchObject({ name: "echo-bot", scope: ["GET health"] });
  });

  it("rotates: same account, the old token is dead", () => {
    const a = serviceToken("echo-bot", ["GET health"]);
    const b = serviceToken("echo-bot", ["GET health"]);
    expect(b.accountId).toBe(a.accountId);
    expect(live(a.token)).toBe(false);
    expect(live(b.token)).toBe(true);
    expect(listServiceAccounts()).toHaveLength(1);
  });

  it("follows a changed scope", () => {
    const a = serviceToken("echo-bot", ["GET health"]);
    serviceToken("echo-bot", ["GET runs"]);
    expect(getServiceAccount(a.accountId)!.scope).toEqual(["GET runs"]);
  });

  it("does not take over an account made by an admin", () => {
    createServiceAccount({ name: "echo-bot", scope: [] });
    expect(() => serviceToken("echo-bot", [])).toThrow(ServiceProblem);
    expect(hasServiceState()).toBe(false);
    expect(listServiceAccounts()).toHaveLength(1);
  });

  it("makes the account again when it was deleted", () => {
    const a = serviceToken("echo-bot", []);
    deleteUser(a.accountId);
    const b = serviceToken("echo-bot", []);
    expect(b.accountId).not.toBe(a.accountId);
    expect(live(b.token)).toBe(true);
  });

  it("refuses a blocked account", async () => {
    const { setStatus } = await import("../src/auth/users.js");
    const a = serviceToken("echo-bot", []);
    await setStatus(a.accountId, "blocked");
    expect(() => serviceToken("echo-bot", [])).toThrow(/blocked/);
  });

  it("removes the new account again when the mapping cannot be written, and a retry works", () => {
    // a directory where the mapping file goes makes the rename fail
    mkdirSync(join(home, "services-accounts.json"));
    expect(() => serviceToken("echo-bot", [])).toThrow(ServiceProblem);
    expect(listServiceAccounts()).toHaveLength(0);
    rmSync(join(home, "services-accounts.json"), { recursive: true });
    expect(live(serviceToken("echo-bot", []).token)).toBe(true);
  });

  it("never adopts an unrelated account of the same name", () => {
    mkdirSync(join(home, "services-accounts.json"));
    createServiceAccount({ name: "other", scope: [] });
    expect(() => serviceToken("other", [])).toThrow(ServiceProblem);
    expect(listServiceAccounts().map((a) => a.name)).toEqual(["other"]);
  });
});

describe("reconcileServiceTokens", () => {
  it("does nothing without state", () => {
    expect(reconcileServiceTokens()).toBe(true);
    expect(hasServiceState()).toBe(false);
  });

  it("revokes live tokens and tolerates a deleted account", () => {
    const a = serviceToken("one", []);
    const b = serviceToken("two", []);
    deleteUser(b.accountId);
    expect(reconcileServiceTokens()).toBe(false);
    expect(live(a.token)).toBe(false);
    expect(tokenState(getServiceAccount(a.accountId)!)).toBe("revoked");
    revokeServiceToken(a.accountId);
  });
});

describe("nextDelay", () => {
  it("doubles from 1 s and stops at 5 minutes", () => {
    expect([0, 1, 8, 9, 20].map((n) => nextDelay(n))).toEqual([1000, 2000, 256000, 300000, 300000]);
  });
});
