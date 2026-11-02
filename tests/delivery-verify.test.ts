import { spawnSync } from "node:child_process";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigIssuesError, ConfigSchema, type Config } from "../src/config.js";
import { buildDeliveryContract, contractDigest, deliveryContractText, signDeliveryContract } from "../src/delivery/contract.js";
import { deliveryCommand, deliveryVerifyExitCode, deliveryVerifyReport, DELIVERY_VERIFY_USAGE, verifyRunDelivery } from "../src/delivery/run-verify.js";
import { publicKeyLine } from "../src/delivery/sshsig.js";
import { canonicalJson, eventHash } from "../src/evidence/canonical.js";

const RUN = "run-1";
const PR = { repository: "acme/app", number: 7, url: "https://github.com/acme/app/pull/7" };

const chainLines = (n: number, value = "x", localTest = false): string[] => {
  let prev: string | null = null;
  return Array.from({ length: n }, (_, seq) => {
    const special = value !== "x" && seq === 0;
    if (localTest && seq === 0) {
      const first: Record<string, unknown> = { version: 8, id: "ev-000000", seq, runId: RUN, time: "2026-01-31T12:00:00.000Z", type: "run.created", flow: { name: "f" }, by: { kind: "cli" }, localTest: true, prevHash: null };
      prev = eventHash(first);
      return canonicalJson({ ...first, hash: prev });
    }
    const e: Record<string, unknown> = { version: 1, id: `ev-${String(seq).padStart(6, "0")}`, seq, runId: RUN, time: "2026-01-31T12:00:00.000Z", type: special ? "run.started" : "run.queued", prevHash: prev, ...(special ? { base: { commit: "a".repeat(40), branch: value } } : {}) };
    prev = eventHash(e);
    return canonicalJson({ ...e, hash: prev });
  });
};
const hashOf = (lines: string[]): string => (JSON.parse(lines[lines.length - 1]!) as { hash: string }).hash;

let tmp: string;
let key: KeyObject;
let other: KeyObject;
let pub: string;
let n = 0;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "delivery-verify-"));
  key = generateKeyPairSync("ed25519").privateKey;
  other = generateKeyPairSync("ed25519").privateKey;
  pub = publicKeyLine(key);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

interface Made {
  runsDir: string;
  runDir: string;
  dir: string;
  texts: string[];
  lines: string[];
}
const w = (m: Made, name: string, body: string | Buffer): void => writeFileSync(join(m.dir, name), body);

/** A run with `contracts` contracts, the k-th stating `k + 1` events (events: `events` in all). */
function make(o: { contracts?: number; signed?: boolean; events?: number; artifact?: string; signWith?: KeyObject; value?: string; localTest?: boolean } = {}): Made {
  const { contracts = 2, signed = true, events = 5, artifact = "report", signWith = key, value = "x", localTest = false } = o;
  const runsDir = join(tmp, `case-${n++}`);
  const runDir = join(runsDir, RUN);
  const dir = join(runDir, "delivery");
  mkdirSync(dir, { recursive: true });
  const lines = chainLines(events, value, localTest);
  writeFileSync(join(runDir, "evidence.jsonl"), lines.join("\n") + "\n");
  const m: Made = { runsDir, runDir, dir, texts: [], lines };
  for (let k = 1; k <= contracts; k++) {
    const count = Math.min(events, k + 1);
    const c = buildDeliveryContract({
      runId: RUN,
      sequence: k,
      ...(k > 1 ? { supersedes: contractDigest(m.texts[k - 2]!) } : {}),
      repository: "acme/app",
      pullRequest: PR,
      commit: { sha: "a".repeat(40), branch: "feature/x" },
      dependencyLocks: [],
      ciWorkflows: [],
      requiredChecks: ["ci"],
      evidence: { count, terminalHash: hashOf(lines.slice(0, count)) },
      artifacts: [{ name: artifact }],
      provenance: { required: false },
    });
    const text = deliveryContractText(c);
    m.texts.push(text);
    w(m, `contract-${k}.json`, text);
    if (signed) w(m, `contract-${k}.json.sig`, signDeliveryContract(text, signWith));
  }
  w(m, "contract.json", m.texts[contracts - 1]!);
  if (signed) w(m, "contract.json.sig", signDeliveryContract(m.texts[contracts - 1]!, signWith));
  return m;
}
const check = (m: Made, k = pub) => verifyRunDelivery(m.runDir, RUN, k);
const flip = (path: string, at: number): void => {
  const b = readFileSync(path);
  b[at] = b[at]! ^ 1;
  writeFileSync(path, b);
};

describe("verifyRunDelivery", () => {
  it("verifies a signed chain, also with valid events added after the last contract", () => {
    const m = make();
    const r = check(m);
    expect(r).toMatchObject({ status: "verified", events: { count: 5 } });
    expect(r.contracts.map((c) => c.path)).toEqual(["delivery/contract-1.json", "delivery/contract-2.json"]);
    expect(deliveryVerifyExitCode(r)).toBe(0);
    const more = chainLines(8);
    writeFileSync(join(m.runDir, "evidence.jsonl"), more.join("\n") + "\n");
    expect(check(m)).toMatchObject({ status: "verified", events: { count: 8 } });
  });

  it("gives none without a delivery folder or with an empty one", () => {
    const m = make();
    rmSync(m.dir, { recursive: true });
    expect(check(m).status).toBe("none");
    mkdirSync(m.dir);
    writeFileSync(join(m.dir, ".contract.abc.tmp"), "x");
    const r = check(m);
    expect(r.status).toBe("none");
    expect(deliveryVerifyExitCode(r)).toBe(2);
  });

  it("fails a contract over the chain of a local-test run, signed or not", () => {
    for (const signed of [true, false]) {
      const m = make({ signed, localTest: true });
      const r = check(m);
      expect(r.status, `signed ${signed}`).toBe("failed");
      expect(r.failure).toMatchObject({ fault: "local-test", path: "delivery/contract-1.json" });
      expect(deliveryVerifyExitCode(r)).toBe(1);
    }
    expect(check(make({ signed: false })).status).toBe("unsigned");
  });

  it("gives unsigned for unsigned and mixed chains, failed for a bad signature among them", () => {
    const u = make({ signed: false });
    const r = check(u);
    expect(r).toMatchObject({ status: "unsigned" });
    expect(r.contracts.every((c) => !c.signed)).toBe(true);
    expect(deliveryVerifyExitCode(r)).toBe(2);
    const mixed = make();
    rmSync(join(mixed.dir, "contract-1.json.sig"));
    expect(check(mixed).status).toBe("unsigned");
    const bad = make();
    rmSync(join(bad.dir, "contract-1.json.sig"));
    flip(join(bad.dir, "contract-2.json.sig"), 100);
    flip(join(bad.dir, "contract.json.sig"), 100);
    expect(check(bad)).toMatchObject({ status: "failed", failure: { fault: "signature-bad", path: "delivery/contract-2.json.sig" } });
  });

  const evidenceEdit = (m: Made, fn: (lines: string[]) => string): void => writeFileSync(join(m.runDir, "evidence.jsonl"), fn([...m.lines]));
  const cases: [string, (m: Made) => void, string, string, boolean?][] = [
    ["a changed byte in a contract", (m) => flip(join(m.dir, "contract-1.json"), 20), "unreadable", "delivery/contract-1.json"],
    ["a changed byte in a signature", (m) => flip(join(m.dir, "contract-2.json.sig"), 100), "signature-bad", "delivery/contract-2.json.sig"],
    ["a changed early event", (m) => evidenceEdit(m, (l) => ((l[0] = l[0]!.replace("run.queued", "run.queueD")), l.join("\n") + "\n")), "evidence-broken", "evidence.jsonl"],
    ["a gap in the numbering", (m) => (rmSync(join(m.dir, "contract-1.json")), rmSync(join(m.dir, "contract-1.json.sig"))), "numbering", "delivery/contract-1.json"],
    ["an orphan signature", (m) => w(m, "contract-9.json.sig", "x"), "orphan-signature", "delivery/contract-9.json.sig"],
    ["a latest signature without the latest contract", (m) => rmSync(join(m.dir, "contract.json")), "orphan-signature", "delivery/contract.json.sig"],
    ["a missing latest copy", (m) => (rmSync(join(m.dir, "contract.json")), rmSync(join(m.dir, "contract.json.sig"))), "latest-copy", "delivery/contract.json"],
    ["a latest copy that differs", (m) => w(m, "contract.json", m.texts[0]!), "latest-copy", "delivery/contract.json"],
    ["a latest signature that differs", (m) => w(m, "contract.json.sig", readFileSync(join(m.dir, "contract-1.json.sig"))), "latest-copy", "delivery/contract.json.sig"],
    ["a missing latest signature", (m) => rmSync(join(m.dir, "contract.json.sig")), "latest-copy", "delivery/contract.json.sig"],
    ["a broken event after count", (m) => evidenceEdit(m, (l) => ((l[4] = l[4]!.replace("run.queued", "run.queueD")), l.join("\n") + "\n")), "evidence-broken", "evidence.jsonl"],
    ["a truncated last line", (m) => evidenceEdit(m, (l) => l.join("\n") + "\n" + l[0]!.slice(0, 10)), "evidence-truncated", "evidence.jsonl"],
    ["an evidence.incomplete marker", (m) => writeFileSync(join(m.runDir, "evidence.incomplete"), ""), "evidence-incomplete", "evidence.incomplete"],
    ["a count above the number of events", (m) => evidenceEdit(m, (l) => l.slice(0, 1).join("\n") + "\n"), "evidence-head-mismatch", "delivery/contract-1.json"],
    ["a missing evidence file", (m) => rmSync(join(m.runDir, "evidence.jsonl")), "evidence-missing", "evidence.jsonl"],
    ["an unexpected file", (m) => w(m, "extra.txt", "x"), "unexpected-file", "delivery/extra.txt"],
  ];
  for (const [name, mutate, fault, path] of cases) {
    it(`fails on ${name}`, () => {
      const m = make();
      mutate(m);
      const r = check(m);
      expect(r.status).toBe("failed");
      expect(r.failure).toMatchObject({ fault, path });
      expect(deliveryVerifyExitCode(r)).toBe(1);
    });
  }

  it("fails with the wrong key", () => {
    const m = make({ signWith: other });
    expect(check(m)).toMatchObject({ status: "failed", failure: { fault: "wrong-key" } });
  });

  it("fails on an unsigned chain with an edited event", () => {
    const m = make({ signed: false });
    evidenceEdit(m, (l) => ((l[1] = l[1]!.replace("run.queued", "run.queueD")), l.join("\n") + "\n"));
    expect(check(m)).toMatchObject({ status: "failed", failure: { fault: "evidence-broken" } });
  });

  it("fails on a wrong supersedes, another run id and a wrong sequence", () => {
    // another run id also breaks the evidence head, which is read with the run id of the contract
    for (const [field, fault] of [["supersedes", "supersedes"], ["runId", "evidence-head-mismatch"], ["sequence", "sequence"]] as const) {
      const m = make({ signed: false });
      const c = JSON.parse(m.texts[1]!) as Record<string, unknown>;
      c[field] = field === "supersedes" ? "b".repeat(64) : field === "runId" ? "run-2" : 7;
      const text = canonicalJson(c);
      w(m, "contract-2.json", text);
      w(m, "contract.json", text);
      expect(check(m).failure?.fault, field).toBe(fault);
    }
  });

  it("fails when delivery is a file or a link, and ignores leftover temporary files", () => {
    const f = make();
    rmSync(f.dir, { recursive: true });
    writeFileSync(f.dir, "x");
    expect(check(f)).toMatchObject({ status: "failed", failure: { fault: "folder", path: "delivery" } });
    const l = make();
    const real = join(l.runDir, "real");
    mkdirSync(real);
    rmSync(l.dir, { recursive: true });
    symlinkSync(real, l.dir);
    expect(check(l).failure?.fault).toBe("folder");
    const t = make();
    w(t, ".contract.abc.tmp", "x");
    expect(check(t).status).toBe("verified");
  });

  describe("raw bytes", () => {
    const bad = Buffer.from([0xff]);
    const replaceFffd = (path: string): void => {
      const b = readFileSync(path);
      const i = b.indexOf(Buffer.from([0xef, 0xbf, 0xbd]));
      expect(i).toBeGreaterThan(0);
      writeFileSync(path, Buffer.concat([b.subarray(0, i), bad, bad, bad, b.subarray(i + 3)]));
    };
    it("fails on an invalid byte in a contract, even where lossy decoding gives the signed text", () => {
      const m = make({ artifact: "a�b" });
      expect(check(m).status).toBe("verified");
      replaceFffd(join(m.dir, "contract-1.json"));
      expect(check(m)).toMatchObject({ status: "failed", failure: { fault: "unreadable", path: "delivery/contract-1.json" } });
    });
    it("fails on an invalid byte in the latest copy only", () => {
      const m = make({ artifact: "a�b" });
      replaceFffd(join(m.dir, "contract.json"));
      const r = check(m);
      expect(r.status).toBe("failed");
      expect(["unreadable", "latest-copy"]).toContain(r.failure?.fault);
    });
    it("fails on an invalid byte in an event", () => {
      const m = make({ value: "a�b" });
      expect(check(m).status).toBe("verified");
      replaceFffd(join(m.runDir, "evidence.jsonl"));
      expect(check(m)).toMatchObject({ status: "failed", failure: { fault: "evidence-broken", path: "evidence.jsonl" } });
    });
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const prefixBom = (path: string): void => writeFileSync(path, Buffer.concat([bom, readFileSync(path)]));
    it("fails on a byte order mark in an early contract", () => {
      const m = make();
      prefixBom(join(m.dir, "contract-1.json"));
      expect(check(m)).toMatchObject({ status: "failed", failure: { fault: "unreadable", path: "delivery/contract-1.json" } });
    });
    it("fails on a byte order mark in the highest contract and in its latest copy", () => {
      const m = make();
      prefixBom(join(m.dir, "contract-2.json"));
      prefixBom(join(m.dir, "contract.json"));
      expect(check(m)).toMatchObject({ status: "failed", failure: { fault: "unreadable", path: "delivery/contract-2.json" } });
    });
    it("fails on a byte order mark in the latest copy only", () => {
      const m = make();
      prefixBom(join(m.dir, "contract.json"));
      expect(check(m)).toMatchObject({ status: "failed", failure: { fault: "latest-copy", path: "delivery/contract.json" } });
    });
    it("fails on a byte order mark in a signature", () => {
      const m = make();
      prefixBom(join(m.dir, "contract-1.json.sig"));
      expect(check(m)).toMatchObject({ status: "failed", failure: { fault: "signature-bad", path: "delivery/contract-1.json.sig" } });
    });
    it("fails on a byte order mark in the evidence", () => {
      const m = make();
      prefixBom(join(m.runDir, "evidence.jsonl"));
      expect(check(m)).toMatchObject({ status: "failed", failure: { fault: "evidence-broken", path: "evidence.jsonl" } });
    });
    it("fails on an invalid byte in a signature", () => {
      const m = make();
      writeFileSync(join(m.dir, "contract-1.json.sig"), Buffer.concat([readFileSync(join(m.dir, "contract-1.json.sig")), bad]));
      expect(check(m)).toMatchObject({ status: "failed", failure: { fault: "signature-bad", path: "delivery/contract-1.json.sig" } });
    });
  });

  it("never puts an absolute path into the result or the report", () => {
    for (const [, mutate] of cases) {
      const m = make();
      mutate(m);
      const r = check(m);
      const text = JSON.stringify(r) + deliveryVerifyReport(r).join("\n");
      expect(text).not.toContain(tmp);
      if (r.failure) expect(r.failure.path).toMatch(/^(delivery(\/[\w.-]+)?|evidence\.jsonl|evidence\.incomplete)$/);
    }
  });
});

describe("deliveryCommand", () => {
  const cfg = (signing_key_path?: string): Config => ConfigSchema.parse({ delivery: signing_key_path ? { signing_key_path } : {} });
  const noConfig = (): Config => {
    throw new Error("config must not be read");
  };
  const run = (args: string[], m: Made, o: Partial<Parameters<typeof deliveryCommand>[1]> = {}) => {
    const lines: string[] = [];
    const code = deliveryCommand(args, { runsDir: m.runsDir, config: noConfig, ...o }, (l) => lines.push(l));
    return { code, lines };
  };
  const keyFile = (name: string, body: string): string => {
    const p = join(tmp, name);
    writeFileSync(p, body);
    return p;
  };

  it("verifies with a --public-key file in each accepted form, as text and as JSON", () => {
    const m = make();
    for (const body of [`${pub} me@host\n`, `scf-delivery ${pub}\n`, `# trusted\n\nscf-delivery namespaces="scf-delivery-contract" ${pub}\n`]) {
      const r = run(["verify", RUN], m, { publicKeyFile: keyFile("k1", body) });
      expect(r.code).toBe(0);
      expect(r.lines[0]).toContain("✔ verified");
    }
    const j = run(["verify", RUN], m, { publicKeyFile: keyFile("k1", pub), json: true });
    expect(JSON.parse(j.lines.join("\n"))).toMatchObject({ runId: RUN, status: "verified" });
    const tampered = make();
    flip(join(tampered.dir, "contract-1.json"), 20);
    expect(run(["verify", RUN], tampered, { publicKeyFile: keyFile("k1", pub) }).code).toBe(1);
  });

  it("takes the key from the settings when it is inside delivery-keys, and prints it for public-key", () => {
    const data = join(tmp, `data-${n++}`);
    mkdirSync(join(data, "delivery-keys"), { recursive: true });
    const kp = join(data, "delivery-keys", "k");
    writeFileSync(kp, key.export({ type: "pkcs8", format: "pem" }) as string);
    const m = make();
    expect(run(["verify", RUN], m, { config: () => cfg(kp), dataDir: data }).code).toBe(0);
    expect(run(["public-key"], m, { config: () => cfg(kp), dataDir: data }).lines).toEqual([`scf-delivery ${pub}`]);
    const outside = keyFile("outside-key", key.export({ type: "pkcs8", format: "pem" }) as string);
    expect(() => run(["public-key"], m, { config: () => cfg(outside), dataDir: data })).toThrow("the signing key is not in the delivery-keys folder of the data folder");
    const junk = join(data, "delivery-keys", "junk");
    writeFileSync(junk, "not a key");
    expect(() => run(["public-key"], m, { config: () => cfg(junk), dataDir: data })).toThrow("the signing key cannot be used");
  });

  it("gives messages without a path for every error", () => {
    const m = make();
    const errors: [string[], Partial<Parameters<typeof deliveryCommand>[1]>, string][] = [
      [[], {}, DELIVERY_VERIFY_USAGE],
      [["verify"], {}, DELIVERY_VERIFY_USAGE],
      [["verify", RUN, "x"], {}, DELIVERY_VERIFY_USAGE],
      [["public-key", "x"], {}, DELIVERY_VERIFY_USAGE],
      [["public-key"], { publicKeyFile: "f" }, DELIVERY_VERIFY_USAGE],
      [["other"], {}, DELIVERY_VERIFY_USAGE],
      [["verify", "../x"], {}, "a run id has only letters, digits, _ and -"],
      [["verify", "nope"], {}, "run nope not found"],
      [["verify", RUN], { config: () => cfg() }, "no trusted key"],
      [["public-key"], { config: () => cfg() }, "no trusted key"],
      [["verify", RUN], { config: () => { throw new ConfigIssuesError("/secret/path/config.yaml: bad"); } }, "the settings (config.yaml) are not valid"],
      [["public-key"], { config: () => { throw new Error("/secret/path"); } }, "the settings (config.yaml) cannot be read"],
      [["verify", RUN], { publicKeyFile: join(tmp, "missing-file") }, "the --public-key file cannot be read"],
      [["verify", RUN], { publicKeyFile: tmp }, "the --public-key file cannot be read"],
      [["verify", RUN], { publicKeyFile: keyFile("nokey", "hello\n") }, "the --public-key file has no ssh-ed25519 key"],
      [["verify", RUN], { publicKeyFile: keyFile("empty", "# only a comment\n") }, "the --public-key file has no ssh-ed25519 key"],
    ];
    for (const [args, o, msg] of errors) {
      let got = "";
      try {
        run(args, m, o);
      } catch (e) {
        got = (e as Error).message;
      }
      expect(got, args.join(" ")).toContain(msg);
      expect(got).not.toContain(tmp);
      expect(got).not.toContain("/secret");
    }
  });
});

describe("with ssh-keygen", () => {
  it.skipIf(!existsSync("/usr/bin/ssh-keygen"))("accepts the signatures against the public-key output, and refuses a tampered contract", () => {
    const m = make();
    const lines: string[] = [];
    const k2 = cfg2(key);
    deliveryCommand(["public-key"], { runsDir: m.runsDir, config: () => k2.config, dataDir: k2.data }, (l) => lines.push(l));
    const signers = join(m.runsDir, "allowed_signers");
    writeFileSync(signers, lines.join("\n") + "\n");
    const verify = (): number | null =>
      spawnSync("/usr/bin/ssh-keygen", ["-Y", "verify", "-f", signers, "-I", "scf-delivery", "-n", "scf-delivery-contract", "-s", join(m.dir, "contract-1.json.sig")], { input: readFileSync(join(m.dir, "contract-1.json")) }).status;
    expect(verify()).toBe(0);
    flip(join(m.dir, "contract-1.json"), 20);
    expect(verify()).not.toBe(0);
  });
});

/** A config whose key sits in a data folder of its own. */
function cfg2(k: KeyObject): { config: Config; data: string } {
  const data = join(tmp, `data-${n++}`);
  mkdirSync(join(data, "delivery-keys"), { recursive: true });
  const kp = join(data, "delivery-keys", "k");
  writeFileSync(kp, k.export({ type: "pkcs8", format: "pem" }) as string);
  return { config: ConfigSchema.parse({ delivery: { signing_key_path: kp } }), data };
}

describe("the built scf", () => {
  const cli = resolve("dist/cli.js");
  const call = (args: string[], home: string) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, FACTORY_HOME: home } });
  const tree = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).sort() : []);

  it("verifies a run without touching the data folder, and keeps validate and the usage", () => {
    if (!existsSync(cli)) throw new Error(`${cli} is missing — run \`npm run build\` first`);
    const m = make();
    const home = join(tmp, "home-cli");
    mkdirSync(home);
    const kf = join(tmp, "cli-key");
    writeFileSync(kf, `scf-delivery ${pub}\n`);
    const before = tree(home);
    const ok = call(["delivery", "verify", RUN, "--runs-dir", m.runsDir, "--public-key", kf, "--json"], home);
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout)).toMatchObject({ status: "verified" });
    expect(ok.stderr).toBe("");
    expect(tree(home)).toEqual(before);
    flip(join(m.dir, "contract-1.json"), 20);
    expect(call(["delivery", "verify", RUN, "--runs-dir", m.runsDir, "--public-key", kf], home).status).toBe(1);
    const nokey = call(["delivery", "public-key"], home);
    expect(nokey.status).toBe(1);
    expect(nokey.stderr).toContain("no trusted key");
    expect(nokey.stderr).not.toContain(tmp);
    expect(call(["--help"], home).stdout).toContain("scf delivery verify <run-id>");
    expect(call(["delivery", "validate", "--help"], home).stdout).toContain("validate");
    expect(call(["delivery"], home).status).toBe(1);
  });
});
