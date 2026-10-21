import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditPath } from "../src/auth/audit.js";
import { ConfigSchema } from "../src/config.js";
import { POLICY_USAGE, policyCommand } from "../src/engine/policy-cli.js";
import { loadPolicyPacks, MAX_PACK_BYTES, readPolicyFile, runPolicy } from "../src/engine/policy-hooks.js";
import { lastKnownGoodFile, restorePolicy, saveLastKnownGood } from "../src/engine/policy-store.js";
import { parsePolicyPack } from "../src/policy/parse.js";
import { policyPackSha256 } from "../src/policy/evaluate.js";
import type { PolicyPack } from "../src/policy/schema.js";
import { coverPack, writePack } from "./fixtures/policy-pack.js";

let home: string;
let saved: string | undefined;
let lines: string[];
beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "policy-restore-"));
  process.env.FACTORY_HOME = home;
  lines = [];
});
afterEach(() => {
  try {
    chmodSync(join(home, "policies"), 0o700);
  } catch {
    // not there
  }
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const start = (config: unknown, vars: Record<string, string> = {}) => runPolicy({ runId: "r", vars, flow: "f" } as never, ConfigSchema.parse(config), (l) => lines.push(l));
const audit = () => (existsSync(auditPath()) ? readFileSync(auditPath(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : []);
const policies = () => join(home, "policies");
const active = (id = "org") => join(policies(), `${id}.json`);
const copyFile = (id = "org") => lastKnownGoodFile(home, id);
const mode = (p: string) => statSync(p).mode & 0o777;
const listing = () => readdirSync(policies()).sort();
const saveOrg = () => {
  writePack(home, "org", coverPack("org"));
  start({ policy: { mandatory: ["org"] } });
};
/** A copy written by hand, as the save would write it, for any pack. */
const writeCopy = (pack: PolicyPack, pretty = false, over: Record<string, unknown> = {}) => {
  mkdirSync(join(policies(), "last-known-good"), { recursive: true });
  const rec = { version: 1, id: pack.policy.id, savedAt: new Date().toISOString(), policyPackSha256: policyPackSha256(pack), pack, ...over };
  writeFileSync(copyFile(pack.policy.id), pretty ? JSON.stringify(rec, null, 2) : JSON.stringify(rec));
};
const failed = () => audit().filter((l) => l.result === "failed" && l.action === "policy-restore");

describe("saving the last-known-good copy", () => {
  it("writes a private, checked copy of a valid mandatory pack", () => {
    saveOrg();
    expect(mode(join(policies(), "last-known-good"))).toBe(0o700);
    expect(mode(copyFile())).toBe(0o600);
    const rec = JSON.parse(readFileSync(copyFile(), "utf8"));
    expect(Object.keys(rec)).toEqual(["version", "id", "savedAt", "policyPackSha256", "pack"]);
    expect(rec.pack).toEqual(coverPack("org"));
    expect(rec.policyPackSha256).toBe(policyPackSha256(coverPack("org")));
    expect(readdirSync(join(policies(), "last-known-good"))).toEqual(["org.json"]);
    expect(lines.filter((l) => l.startsWith("!"))).toEqual([]);
  });

  it("sets the modes of a folder that already exists", () => {
    mkdirSync(join(policies(), "last-known-good"), { recursive: true, mode: 0o755 });
    chmodSync(join(policies(), "last-known-good"), 0o755);
    saveOrg();
    expect(mode(join(policies(), "last-known-good"))).toBe(0o700);
    expect(mode(copyFile())).toBe(0o600);
  });

  it("saves nothing for repository or optional packs, or the baseline", () => {
    writePack(home, "repo", coverPack("repo"));
    writePack(home, "opt", coverPack("opt"));
    start({ policy: { packs: ["opt"], repositories: { "acme/a": ["repo"] } } }, { github_repo: "acme/a" });
    expect(existsSync(join(policies(), "last-known-good"))).toBe(false);
  });

  it("keeps the earlier copy when the pack becomes invalid", () => {
    saveOrg();
    const before = readFileSync(copyFile(), "utf8");
    writeFileSync(active(), "{ nope");
    start({ policy: { mandatory: ["org"] } });
    expect(readFileSync(copyFile(), "utf8")).toBe(before);
    expect(lines.some((l) => l.includes("policy.invalid"))).toBe(true);
    expect(lines.some((l) => l.includes("could not be saved"))).toBe(false);
  });

  it("writes nothing through a linked folder and the policy still works", () => {
    const outside = mkdtempSync(join(tmpdir(), "policy-outside-"));
    try {
      writePack(home, "org", coverPack("org"));
      symlinkSync(outside, join(policies(), "last-known-good"));
      const policy = start({ policy: { mandatory: ["org"] } });
      expect(lines.filter((l) => l.includes("could not be saved"))).toEqual(["! policy org: the last-known-good copy could not be saved"]);
      expect(readdirSync(outside)).toEqual([]);
      expect(policy.mandatoryUnusable).toBe(false);
      expect(policy.at("agent.write", {}).denied).toBeUndefined();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("never throws, even when the logger does", () => {
    const outside = mkdtempSync(join(tmpdir(), "policy-outside-"));
    try {
      mkdirSync(policies(), { recursive: true });
      symlinkSync(outside, join(policies(), "last-known-good"));
      let calls = 0;
      expect(() =>
        saveLastKnownGood(home, "org", coverPack("org"), () => {
          calls++;
          throw new Error("x");
        }),
      ).not.toThrow();
      expect(calls).toBe(1);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("restorePolicy", () => {
  it("puts the copy back, keeps the broken file and writes an audit line", () => {
    saveOrg();
    writeFileSync(active(), "{ nope");
    const r = restorePolicy("org");
    expect(r).toMatchObject({ ok: true, sha256: policyPackSha256(coverPack("org")) });
    const kept = (r as { kept?: string }).kept!;
    expect(kept).toMatch(/^org\.json\.replaced-/);
    expect(readFileSync(join(policies(), kept), "utf8")).toBe("{ nope");
    expect(loadPolicyPacks(["org"], home)[0]).toEqual({ id: "org", pack: coverPack("org") });
    expect(readFileSync(active(), "utf8")).toBe(JSON.stringify(parsePolicyPack(coverPack("org"))));
    expect(mode(active())).toBe(0o600);
    expect(audit().filter((l) => l.action === "policy-restore")).toEqual([expect.objectContaining({ result: "ok", target: "org", by: "cli" })]);
    expect(listing().filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("restores a missing file and keeps nothing", () => {
    saveOrg();
    rmSync(active());
    const r = restorePolicy("org");
    expect(r.ok).toBe(true);
    expect((r as { kept?: string }).kept).toBeUndefined();
    expect(listing().some((n) => n.includes(".replaced-"))).toBe(false);
  });

  it("restores a version 2 copy, and refuses a copy that is enforce on the pack or on a rule", () => {
    const v2 = { ...coverPack("org"), version: 2 } as PolicyPack;
    writeCopy(v2);
    writeFileSync(active(), "{ nope");
    expect(restorePolicy("org", { force: true }).ok).toBe(true);
    expect("pack" in loadPolicyPacks(["org"], home)[0]!).toBe(true);

    const ruleEnforce = { ...v2, rules: v2.rules.map((r, i) => (i === 0 ? { ...r, mode: "enforce" as const } : r)) } as PolicyPack;
    for (const bad of [ruleEnforce, { ...v2, mode: "enforce" } as PolicyPack]) {
      writeCopy(bad);
      writeFileSync(active(), "{ nope");
      expect(restorePolicy("org", { force: true })).toEqual({ ok: false, reason: expect.stringMatching(/is not valid: .*mode enforce/) });
      expect(readFileSync(active(), "utf8")).toBe("{ nope");
    }
  });

  it("needs --force to replace a valid file", () => {
    saveOrg();
    const other = JSON.stringify({ ...coverPack("org"), policy: { id: "org", version: "2" } });
    writeFileSync(active(), other);
    const refused = restorePolicy("org");
    expect(refused).toMatchObject({ ok: false, reason: expect.stringContaining("--force") });
    expect(readFileSync(active(), "utf8")).toBe(other);
    expect(listing().some((n) => n.includes(".replaced-"))).toBe(false);
    const r = restorePolicy("org", { force: true });
    expect(r.ok).toBe(true);
    expect(readFileSync(join(policies(), (r as { kept: string }).kept), "utf8")).toBe(other);
  });

  it("never overwrites a backup", () => {
    saveOrg();
    const now = () => new Date("2026-10-20T10:10:48.123Z");
    const first = join(policies(), "org.json.replaced-2026-10-20T10-10-48Z");
    writeFileSync(first, "old");
    writeFileSync(active(), "{ nope");
    const a = restorePolicy("org", { now });
    expect(a).toMatchObject({ ok: true, kept: "org.json.replaced-2026-10-20T10-10-48Z-1" });
    const b = restorePolicy("org", { now, force: true });
    expect(b).toMatchObject({ ok: true, kept: "org.json.replaced-2026-10-20T10-10-48Z-2" });
    expect(readFileSync(first, "utf8")).toBe("old");
  });

  it("finds a free backup name after 100 taken ones", () => {
    saveOrg();
    const now = () => new Date("2026-10-20T10:10:48.123Z");
    const base = "org.json.replaced-2026-10-20T10-10-48Z";
    writeFileSync(join(policies(), base), "old");
    for (let i = 1; i < 100; i++) writeFileSync(join(policies(), `${base}-${i}`), "old");
    writeFileSync(active(), "{ nope");
    expect(restorePolicy("org", { now })).toMatchObject({ ok: true, kept: `${base}-100` });
    expect(readFileSync(join(policies(), `${base}-99`), "utf8")).toBe("old");
    expect(readFileSync(join(policies(), `${base}-100`), "utf8")).toBe("{ nope");
  });

  it.skipIf(process.getuid?.() === 0)("changes nothing when the folder cannot be written", () => {
    saveOrg();
    writeFileSync(active(), "{ nope");
    chmodSync(policies(), 0o500);
    const r = restorePolicy("org");
    chmodSync(policies(), 0o700);
    expect(r).toEqual({ ok: false, reason: "policies/org.json could not be replaced; nothing was restored" });
    expect(readFileSync(active(), "utf8")).toBe("{ nope");
    expect(listing().filter((n) => n.includes(".replaced-") || n.endsWith(".tmp"))).toEqual([]);
    expect(audit().filter((l) => l.result === "ok")).toEqual([]);
  });

  it("restores a pack that is under 1 MiB compact and over it pretty; refuses one over it compact", () => {
    // the most rules (500) with the most patterns (100) each; `pad` makes the patterns longer
    const big = (pad: string): PolicyPack => ({
      ...coverPack("org"),
      rules: Array.from({ length: 500 }, (_, i) => ({
        id: `r${i}`,
        boundaries: ["step.before"],
        when: { flow: { in: Array.from({ length: 100 }, (_, j) => `f${pad}${j}`) } },
        outcome: "warn",
        reasonCode: "output.limit-exceeded",
      })) as PolicyPack["rules"],
    });
    const fits = big("");
    expect(JSON.stringify(fits).length).toBeLessThan(MAX_PACK_BYTES);
    expect(JSON.stringify(fits, null, 2).length).toBeGreaterThan(MAX_PACK_BYTES);
    writeCopy(fits, true);
    writeFileSync(active(), "{ nope");
    expect(restorePolicy("org").ok).toBe(true);
    expect(readFileSync(active(), "utf8")).toBe(JSON.stringify(parsePolicyPack(fits)));
    expect("pack" in loadPolicyPacks(["org"], home)[0]!).toBe(true);

    const over = big("x".repeat(16));
    expect(JSON.stringify(over).length).toBeGreaterThan(MAX_PACK_BYTES);
    expect(JSON.stringify(over).length).toBeLessThan(2 * MAX_PACK_BYTES - 1000);
    writeCopy(over);
    writeFileSync(active(), "{ nope");
    expect(restorePolicy("org")).toEqual({ ok: false, reason: expect.stringContaining("1 MiB as compact JSON") });
    expect(readFileSync(active(), "utf8")).toBe("{ nope");
    expect(failed()).toHaveLength(1);
  });

  it("refuses a changed copy", () => {
    saveOrg();
    writeFileSync(active(), "{ nope");
    const rec = JSON.parse(readFileSync(copyFile(), "utf8"));
    const edited = structuredClone(rec);
    edited.pack.rules[0].outcome = "warn";
    writeFileSync(copyFile(), JSON.stringify(edited));
    expect(restorePolicy("org")).toEqual({ ok: false, reason: expect.stringContaining("SHA-256 does not match") });
    writeFileSync(copyFile(), JSON.stringify({ ...rec, policyPackSha256: "0".repeat(64) }));
    expect(restorePolicy("org")).toEqual({ ok: false, reason: expect.stringContaining("SHA-256 does not match") });
    expect(readFileSync(active(), "utf8")).toBe("{ nope");
    expect(failed().map((l) => l.target)).toEqual(["org", "org"]);
  });

  it("refuses with nothing written", () => {
    mkdirSync(policies(), { recursive: true });
    const same = () => {
      const before = JSON.stringify(readdirSync(policies()).sort());
      return () => expect(JSON.stringify(readdirSync(policies()).sort())).toBe(before);
    };
    let check = same();
    expect(restorePolicy("org").ok).toBe(false);
    check();
    expect(failed()).toHaveLength(1);

    saveOrg();
    const outside = join(home, "outside.json");
    writeFileSync(outside, readFileSync(copyFile()));
    rmSync(copyFile());
    symlinkSync(outside, copyFile());
    writeFileSync(active(), "{ nope");
    check = same();
    expect(restorePolicy("org")).toEqual({ ok: false, reason: expect.stringContaining("link or not a plain file") });
    check();
    expect(failed()).toHaveLength(2);

    const before = audit().length;
    check = same();
    expect(restorePolicy("foundry.baseline").ok).toBe(false);
    expect(restorePolicy("../x").ok).toBe(false);
    check();
    expect(audit()).toHaveLength(before);

    rmSync(copyFile());
    writeFileSync(copyFile(), readFileSync(outside));
    rmSync(active());
    mkdirSync(active());
    check = same();
    expect(restorePolicy("org")).toEqual({ ok: false, reason: expect.stringContaining("is a folder") });
    check();
  });

  it("names no data-folder path in a refusal", () => {
    const r = restorePolicy("org");
    expect(JSON.stringify(r)).not.toContain(home);
  });
});

describe("readPolicyFile", () => {
  it("tells the problems apart", () => {
    mkdirSync(policies(), { recursive: true });
    const f = join(policies(), "a.json");
    expect(readPolicyFile(f, 10)).toEqual({ problem: "missing" });
    writeFileSync(f, "hello");
    expect(readPolicyFile(f, 10)).toEqual({ text: "hello" });
    expect(readPolicyFile(f, 2)).toEqual({ problem: "too-large" });
    symlinkSync(f, join(policies(), "b.json"));
    expect(readPolicyFile(join(policies(), "b.json"), 10)).toEqual({ problem: "not-file" });
    mkdirSync(join(policies(), "d"));
    expect(readPolicyFile(join(policies(), "d"), 10)).toEqual({ problem: "not-file" });
  });
});

describe("policyCommand", () => {
  it("prints the result and returns the exit code", () => {
    saveOrg();
    writeFileSync(active(), "{ nope");
    const out: string[] = [];
    expect(policyCommand(["restore", "org"], {}, (l) => out.push(l))).toBe(0);
    expect(out[0]).toBe(`✔ restored policy org (sha256 ${policyPackSha256(coverPack("org"))})`);
    expect(out[1]).toMatch(/^ {2}kept the replaced file as policies\/org\.json\.replaced-/);
  });

  it("prints a refusal and returns 1", () => {
    const out: string[] = [];
    expect(policyCommand(["restore", "org"], {}, (l) => out.push(l))).toBe(1);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^✘ /);
    expect(out[0]).not.toContain(home);
  });

  it("throws the usage for wrong arguments", () => {
    for (const args of [[], ["restore"], ["restore", "a", "b"], ["x", "org"]]) {
      expect(() => policyCommand(args, {}, () => {})).toThrow(POLICY_USAGE);
    }
  });
});
