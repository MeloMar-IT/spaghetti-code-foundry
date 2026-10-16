import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { skillsCommand } from "../src/skills/cli.js";
import { clearSkillRegistryCache, discoverSkills } from "../src/skills/registry.js";
import { matchRelease, releaseProblemText, type ApprovedRelease, type ReleaseRead } from "../src/skills/release.js";
import { readSigningKey } from "../src/skills/release-cli.js";
import {
  approvalSignatureProblem,
  approvalSignatureState,
  approvalText,
  decodeBase64Exact,
  rawPublicKey,
  releaseSignatureToken,
  signApproval,
  type ReleaseKey,
} from "../src/skills/release-signature.js";
import { writeV2Release } from "./helpers/skill-release-v2.js";

const newKey = () => generateKeyPairSync("ed25519").privateKey;
const pub = (k: KeyObject) => rawPublicKey(k);
const ID = { catalogue: "acme", version: "1.0.0", digest: `sha256:${"a".repeat(64)}` };
const signed = (priv: KeyObject, key: string, id = ID): ApprovedRelease => ({ ...id, key, signature: signApproval(id, priv) });

describe("signature primitives", () => {
  const k1 = newKey();
  const keys: ReleaseKey[] = [{ id: "k1", ed25519: pub(k1) }];

  it("builds the exact approval text", () => {
    expect(approvalText(ID)).toBe(`scf-skill-catalogue-approval-v1\nacme\n1.0.0\n${ID.digest}\n`);
  });

  it("decodes canonical base64 only", () => {
    const ok = Buffer.alloc(32, 7).toString("base64");
    expect(decodeBase64Exact(ok, 32)?.length).toBe(32);
    expect(decodeBase64Exact(ok, 64)).toBeUndefined();
    expect(decodeBase64Exact(Buffer.alloc(31, 7).toString("base64"), 32)).toBeUndefined();
    expect(decodeBase64Exact(` ${ok}`, 32)).toBeUndefined();
    expect(decodeBase64Exact(`${ok}\n`, 32)).toBeUndefined();
    expect(decodeBase64Exact("_-_-", 3)).toBeUndefined();
    // non-zero padding bits: "AB==" decodes to one byte but re-encodes as "AA=="
    expect(decodeBase64Exact("AB==", 1)).toBeUndefined();
    expect(decodeBase64Exact("AA==", 1)?.length).toBe(1);
  });

  it("signed, unsigned and bad states", () => {
    expect(approvalSignatureState(signed(k1, "k1"), keys)).toEqual({ state: "signed", key: "k1" });
    expect(approvalSignatureState(ID as ApprovedRelease, keys)).toEqual({ state: "unsigned" });
    expect(approvalSignatureState({ ...signed(k1, "k1"), key: "other" }, keys)).toEqual({ state: "unsigned" });
    const other = { ...ID, digest: `sha256:${"b".repeat(64)}` };
    expect(approvalSignatureState({ ...ID, key: "k1", signature: signApproval(other, k1) }, keys).state).toBe("bad");
    expect(approvalSignatureState({ ...ID, version: "2.0.0", key: "k1", signature: signApproval(ID, k1) }, keys).state).toBe("bad");
    expect(approvalSignatureState({ ...ID, key: "k1", signature: signApproval(ID, newKey()) }, keys).state).toBe("bad");
    expect(approvalSignatureState({ ...ID, key: "k1", signature: Buffer.alloc(64).toString("base64") }, keys).state).toBe("bad");
    expect(approvalSignatureProblem(signed(k1, "k1"), [])).toBeUndefined();
    expect(approvalSignatureProblem(ID as ApprovedRelease, [])).toBeUndefined();
    expect(approvalSignatureProblem(ID as ApprovedRelease, keys)).toBe("is not signed by a trusted key");
    expect(approvalSignatureProblem({ ...ID, key: "k1", signature: Buffer.alloc(64).toString("base64") }, keys)).toBe("signature does not verify");
  });

  it("the signature token", () => {
    const entry = signed(k1, "k1");
    expect(releaseSignatureToken(ID, [entry], [])).toBeUndefined();
    expect(releaseSignatureToken(ID, [entry], keys)).toBe("SIGNED k1");
    expect(releaseSignatureToken(ID, [{ ...entry, signature: Buffer.alloc(64).toString("base64") }], keys)).toBe("BAD-SIGNATURE");
    expect(releaseSignatureToken(ID, [], keys)).toBe("UNSIGNED");
    expect(releaseSignatureToken({ ...ID, digest: `sha256:${"c".repeat(64)}` }, [entry], keys)).toBe("UNSIGNED");
    expect(releaseSignatureToken(ID, [{ ...ID }], keys)).toBe("UNSIGNED");
  });
});

describe("config", () => {
  const k = (id: string, byte = 1) => ({ id, ed25519: Buffer.alloc(32, byte).toString("base64") });
  const sig = Buffer.alloc(64, 3).toString("base64");
  const parse = (releases: Record<string, unknown>) => ConfigSchema.safeParse({ skills: { releases } }).success;
  const entry = { ...ID };

  it("accepts keys and signed entries, defaults to no keys", () => {
    expect(ConfigSchema.parse({}).skills.releases.keys).toEqual([]);
    expect(parse({ keys: [k("k1")], approved: [{ ...entry, key: "k1", signature: sig }] })).toBe(true);
  });
  it("refuses the bad cases", () => {
    expect(parse({ keys: [k("k1")], approved: [{ ...entry, key: "nope", signature: sig }] })).toBe(false);
    expect(parse({ keys: [k("k1"), k("k1", 2)] })).toBe(false);
    expect(parse({ keys: [{ id: "k1", ed25519: Buffer.alloc(31).toString("base64") }] })).toBe(false);
    expect(parse({ keys: [{ id: "k1", ed25519: Buffer.alloc(33).toString("base64") }] })).toBe(false);
    expect(parse({ keys: [k("k1")], approved: [{ ...entry, key: "k1" }] })).toBe(false);
    expect(parse({ keys: [k("k1")], approved: [{ ...entry, signature: sig }] })).toBe(false);
    expect(parse({ keys: [k("k1")], approved: [{ ...entry, key: "k1", signature: "not base64!" }] })).toBe(false);
    expect(parse({ keys: Array.from({ length: 11 }, (_, i) => k(`k${i}`, i + 1)) })).toBe(false);
    expect(parse({ keys: Array.from({ length: 10 }, (_, i) => k(`k${i}`, i + 1)) })).toBe(true);
  });
});

describe("matchRelease", () => {
  const k1 = newKey();
  const keys: ReleaseKey[] = [{ id: "k1", ed25519: pub(k1) }];
  const read = (digest = ID.digest): ReleaseRead => ({ state: "ok", digest, manifest: { schema: 2, catalogue: ID.catalogue, version: ID.version } as never });

  it("applies the gate only when keys are set", () => {
    expect(matchRelease(read(), [signed(k1, "k1")], keys).state).toBe("approved");
    expect(matchRelease(read(), [{ ...ID }], []).state).toBe("approved");
    const un = matchRelease(read(), [{ ...ID }], keys);
    expect(un).toMatchObject({ state: "unsigned", reason: "is not signed by a trusted key" });
    expect(releaseProblemText(un)).toBe("acme@1.0.0 is not signed by a trusted key");
    expect(matchRelease(read(), [{ ...ID, key: "k1", signature: Buffer.alloc(64).toString("base64") }], keys)).toMatchObject({ state: "unsigned", reason: "signature does not verify" });
  });
  it("a different digest stays a mismatch, even next to a valid signature", () => {
    const other = `sha256:${"d".repeat(64)}`;
    expect(matchRelease(read(other), [signed(k1, "k1")], keys)).toMatchObject({ state: "mismatch", reason: "has another digest than the approved one" });
  });
});

describe("registry, list, verify and sign", () => {
  let base: string;
  let home: string;
  let builtin: string;
  let userHome: string;
  let n = 0;
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "skillsig-")));
    home = join(base, "home");
    builtin = join(base, "builtin");
    userHome = join(base, "user");
    for (const d of [home, builtin, userHome]) mkdirSync(d);
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
    clearSkillRegistryCache();
  });

  function store(catalogue: string, version: string, skill: string): { dir: string; approved: ApprovedRelease } {
    const scratch = join(base, `scratch-${n++}`);
    const d = join(scratch, skill);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "SKILL.md"), `---\nname: ${skill}\ndescription: A test skill called ${skill}.\n---\n\nDo it.\n`);
    writeFileSync(join(d, "skill.yaml"), `id: ${skill}\nversion: ${version}\n`);
    const { approved } = writeV2Release(scratch, { catalogue, version });
    const dest = join(home, "skill-releases", catalogue, version);
    mkdirSync(join(dest, ".."), { recursive: true });
    cpSync(scratch, dest, { recursive: true });
    return { dir: dest, approved };
  }
  const cfg = (approved: ApprovedRelease[], keys: ReleaseKey[], allow = false) =>
    ConfigSchema.parse({ skills: { roots: [], releases: { allow_unreleased: allow, approved, keys } } }).skills;
  const discover = (skills: ReturnType<typeof cfg>) => discoverSkills(skills, { home, builtinRoot: builtin, userHome, env: {} });
  const run = async (args: string[], skills: ReturnType<typeof cfg>, values: Record<string, unknown> = {}) => {
    const lines: string[] = [];
    const code = await skillsCommand({ positionals: ["release", ...args], values }, (l) => lines.push(l), { home, skills, cwd: base, builtinRoot: builtin, userHome, env: {} });
    return { code, lines };
  };

  const k1 = newKey();
  const keys: ReleaseKey[] = [{ id: "k1", ed25519: pub(k1) }];

  it("an unsigned approved release is refused, also with allow_unreleased", () => {
    const { approved } = store("acme", "1.0.0", "alpha");
    for (const allow of [false, true]) {
      const reg = discover(cfg([approved], keys, allow));
      expect(reg.byKey.size).toBe(0);
      const p = reg.problems.find((x) => x.kind === "root-refused" && x.reason.includes("is not signed by a trusted key"));
      expect(p?.reason).toContain("scf skills release sign");
    }
  });
  it("a bad signature is refused", () => {
    const { approved } = store("acme", "1.0.0", "alpha");
    const reg = discover(cfg([{ ...approved, key: "k1", signature: Buffer.alloc(64).toString("base64") }], keys));
    expect(reg.byKey.size).toBe(0);
    expect(reg.problems.some((x) => x.kind === "root-refused" && x.reason.includes("signature does not verify"))).toBe(true);
  });
  it("a signed release loads; without keys an unsigned one loads too", () => {
    const { approved } = store("acme", "1.0.0", "alpha");
    expect(discover(cfg([signed(k1, "k1", approved)], keys)).byKey.has("alpha@1.0.0")).toBe(true);
    expect(discover(cfg([approved], [])).byKey.has("alpha@1.0.0")).toBe(true);
  });
  it("only the unsigned older version is refused", () => {
    const old = store("acme", "1.0.0", "alpha");
    const next = store("acme", "2.0.0", "alpha");
    const reg = discover(cfg([old.approved, signed(k1, "k1", next.approved)], keys));
    expect(reg.byKey.has("alpha@2.0.0")).toBe(true);
    expect(reg.byKey.has("alpha@1.0.0")).toBe(false);
  });

  it("verify and list show the signature state", async () => {
    const { dir, approved } = store("acme", "1.0.0", "alpha");
    const good = cfg([signed(k1, "k1", approved)], keys);
    expect((await run(["verify", dir], good)).lines.at(-1)).toBe("APPROVED SIGNED k1");
    expect((await run(["list"], good)).lines.find((l) => l.startsWith("RELEASE"))).toMatch(/ approved SIGNED k1 1 skill,/);
    const bad = cfg([{ ...approved, key: "k1", signature: Buffer.alloc(64).toString("base64") }], keys);
    expect((await run(["verify", dir], bad)).lines.at(-1)).toBe("NOT-APPROVED BAD-SIGNATURE");
    expect((await run(["list"], bad)).lines.find((l) => l.startsWith("RELEASE"))).toMatch(/ unsigned BAD-SIGNATURE /);
    const unsigned = cfg([approved], keys);
    expect((await run(["verify", dir], unsigned)).lines.at(-1)).toBe("NOT-APPROVED UNSIGNED");
    expect((await run(["list"], unsigned)).lines.find((l) => l.startsWith("RELEASE"))).toMatch(/ unsigned UNSIGNED /);
    const none = cfg([], keys);
    expect((await run(["verify", dir], none)).lines.at(-1)).toBe("NOT-APPROVED UNSIGNED");
    expect((await run(["list"], none)).lines.find((l) => l.startsWith("RELEASE"))).toMatch(/ unapproved UNSIGNED /);
    const mismatch = cfg([{ ...approved, digest: `sha256:${"e".repeat(64)}` }], keys);
    expect((await run(["verify", dir], mismatch)).lines.at(-1)).toBe("NOT-APPROVED UNSIGNED");
    expect((await run(["list"], mismatch)).lines.find((l) => l.startsWith("RELEASE"))).toMatch(/ mismatch UNSIGNED /);
    // no keys: lines are unchanged
    expect((await run(["verify", dir], cfg([approved], []))).lines.at(-1)).toBe("APPROVED");
    expect((await run(["verify", dir], cfg([], []))).lines.at(-1)).toBe("NOT-APPROVED");
    expect((await run(["list"], cfg([approved], []))).lines.find((l) => l.startsWith("RELEASE"))).toMatch(/ approved 1 skill,/);
  });

  describe("sign", () => {
    const pem = (k: KeyObject) => k.export({ format: "pem", type: "pkcs8" }) as string;
    const keyFile = (k: KeyObject, mode = 0o600, name = "key.pem") => {
      const p = join(base, name);
      writeFileSync(p, pem(k));
      chmodSync(p, mode);
      return p;
    };
    const sign1 = (file: string, skills: ReturnType<typeof cfg>, target = "acme@1.0.0") => run(["sign", target], skills, { key: file });

    it("prints a line that, pasted into the config, makes the release load", async () => {
      const { approved } = store("acme", "1.0.0", "alpha");
      const file = keyFile(k1);
      const { code, lines } = await sign1(file, cfg([approved], keys));
      expect(code).toBe(0);
      expect(lines).toHaveLength(1);
      const m = /^APPROVE acme 1\.0\.0 (sha256:[0-9a-f]{64}) key k1 signature (\S+)$/.exec(lines[0]!);
      expect(m).not.toBeNull();
      expect(m![1]).toBe(approved.digest);
      const text = lines.join("\n");
      for (const s of ["BEGIN", file, pub(k1)]) expect(text).not.toContain(s);
      expect(discover(cfg([{ ...approved, key: "k1", signature: m![2]! }], keys)).byKey.has("alpha@1.0.0")).toBe(true);
    });
    it("refuses unsafe or wrong key files", async () => {
      const { approved } = store("acme", "1.0.0", "alpha");
      const skills = cfg([approved], keys);
      const link = join(base, "link.pem");
      symlinkSync(keyFile(k1), link);
      expect((await sign1(link, skills)).code).toBe(1);
      for (const mode of [0o640, 0o604]) {
        const r = await sign1(keyFile(k1, mode, `m${mode}.pem`), skills);
        expect(r.code).toBe(1);
        expect(r.lines[0]).toContain("group or others");
      }
      expect((await sign1(keyFile(k1, 0o600, "ok.pem"), skills)).code).toBe(0);
      expect((await sign1(base, skills)).code).toBe(1);
      const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
      expect((await sign1(keyFile(rsa, 0o600, "rsa.pem"), skills)).lines[0]).toBe("PROBLEM the key is not an Ed25519 private key");
      const enc = join(base, "enc.pem");
      writeFileSync(enc, k1.export({ format: "pem", type: "pkcs8", cipher: "aes-256-cbc", passphrase: "x" }) as string, { mode: 0o600 });
      expect((await sign1(enc, skills)).code).toBe(1);
      const stranger = await sign1(keyFile(newKey(), 0o600, "other.pem"), skills);
      expect(stranger.lines).toEqual(["PROBLEM the key is not listed in skills.releases.keys"]);
    });
    it("refuses a release that is not in the store or was tampered with", async () => {
      const { dir, approved } = store("acme", "1.0.0", "alpha");
      const file = keyFile(k1);
      const skills = cfg([approved], keys);
      expect((await sign1(file, skills, "acme@9.9.9")).lines).toEqual(["PROBLEM acme@9.9.9 is not in the release store"]);
      writeFileSync(join(dir, "alpha", "SKILL.md"), "tampered\n");
      const r = await sign1(file, skills);
      expect(r.code).toBe(1);
      expect(r.lines[0]).toMatch(/^PROBLEM /);
    });
    it("a FIFO is refused without hanging", () => {
      const fifo = join(base, "fifo.pem");
      try {
        execFileSync("mkfifo", [fifo]);
      } catch {
        return;
      }
      chmodSync(fifo, 0o600);
      expect(readSigningKey(fifo)).toBe("the key file is not a regular file");
    });
    it("syntax errors", async () => {
      const skills = cfg([], keys);
      await expect(run(["sign", "acme@1.0.0"], skills)).rejects.toThrow(/needs --key/);
      await expect(run(["verify", base], skills, { key: "x" })).rejects.toThrow(/--key/);
      await expect(run(["sign", "nope", ], skills, { key: "x" })).rejects.toThrow(/<catalogue>@<version>/);
    });
  });
});
