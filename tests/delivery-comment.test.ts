import { execFile, execFileSync } from "node:child_process";
import { createPrivateKey, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DELIVERY_MARKER_RE, DeliveryCommentError, MAX_COMMENT_CHARS, VALIDATOR_MARKER_RE, deliveryCommentBody, deliveryMarker, isDeliveryComment,
  readDeliveryComment, safeLine, validatorMarker, type DeliveryCommentInput,
} from "../src/delivery/comment.js";
import { buildDeliveryContract, contractDigest, deliveryContractText, signDeliveryContract, verifyDeliveryContract } from "../src/delivery/contract.js";
import type { DeliveryContract } from "../src/delivery/schema.js";
import { publicKeyFingerprint, publicKeyLine } from "../src/delivery/sshsig.js";
import { canonicalHash } from "../src/evidence/canonical.js";
import { sha256Hex } from "../src/evidence/identity.js";
import { reportFirst } from "../src/next-step.js";

const execFileAsync = promisify(execFile);
const SCRIPT = resolve("tools/delivery-validate/validate.mjs");
const PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
const keyOf = (n: number): KeyObject => createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.alloc(32, n)]), format: "der", type: "pkcs8" });
const K1 = keyOf(1);
const KEY1 = publicKeyLine(K1);
const FP = publicKeyFingerprint(KEY1)!;
const H = (c: string): string => c.repeat(64);
const SHA = "a".repeat(40);
const RUN = "run-1";
// Built at run time so that no line of this file looks like a secret.
const TOKEN = ["gh", "p_", "a1B2".repeat(10)].join("");
const PAT = ["github", "_pat_", "Zy9X".repeat(8)].join("");

const events = ["EVENT-CONTENT-SENTINEL one", "EVENT-CONTENT-SENTINEL two"].map((e) => ({ type: "x", note: e }));
const TERMINAL = canonicalHash(events);

interface Over {
  branch?: string;
  sequence?: number;
  requiredChecks?: string[];
  artifacts?: { name: string }[];
  locks?: { path: string; sha256: string }[];
  sha?: string;
}
const contractOf = (o: Over = {}): DeliveryContract => {
  const sha = o.sha ?? SHA;
  return buildDeliveryContract({
    runId: RUN,
    sequence: o.sequence ?? 1,
    ...(o.sequence && o.sequence > 1 ? { supersedes: H("9") } : {}),
    repository: "acme/app",
    pullRequest: { repository: "acme/app", number: 7, url: "https://github.com/acme/app/pull/7", head: sha },
    commit: { sha, branch: o.branch ?? "feature/x" },
    dependencyLocks: o.locks ?? [],
    ciWorkflows: [],
    requiredChecks: o.requiredChecks ?? ["build", "test"],
    evidence: { count: events.length, terminalHash: TERMINAL },
    artifacts: o.artifacts ?? [],
    provenance: { required: false },
  });
};

const C = contractOf();
const TEXT = deliveryContractText(C);
const SIG = signDeliveryContract(TEXT, K1);
const body = (over: Partial<DeliveryCommentInput> = {}, run = RUN): string =>
  deliveryCommentBody({ status: { kind: "ok" }, lines: ["build: success", "test: success"], contract: C, signature: SIG, fingerprint: FP, ...over }, run);
const lines = (b: string): string[] => b.split("\n");
const MARK = deliveryMarker(RUN);

describe("markers", () => {
  it("have exact strings", () => {
    expect(deliveryMarker("r-1")).toBe("<!-- spaghetti-code-foundry delivery-contract run=r-1 -->");
    expect(validatorMarker(H("a"), H("b"))).toBe(`<!-- claude-factory delivery-contract digest=${H("a")} evidence=${H("b")} -->`);
  });
  it("refuse bad input", () => {
    for (const r of ["a b", "x-->y", "", "a".repeat(129)]) expect(() => deliveryMarker(r)).toThrow(DeliveryCommentError);
    for (const d of [H("A"), "a".repeat(63), "a".repeat(65), ""]) {
      expect(() => validatorMarker(d, H("b"))).toThrow(DeliveryCommentError);
      expect(() => validatorMarker(H("b"), d)).toThrow(DeliveryCommentError);
    }
  });
});

describe("isDeliveryComment", () => {
  const m2 = "<!-- claude-factory delivery-contract run=r-2 -->";
  it("is true for the marker on the last line", () => {
    for (const b of [`text\n\n${MARK}`, `${m2}`, `text\n${MARK}\n\n\n`, `text\r\n${MARK}\r\n`]) expect(isDeliveryComment({ body: b })).toBe(true);
  });
  it("is false for anything else", () => {
    const bad = [`${MARK}\nmore`, `> ${MARK}`, "status\n\n<!-- claude-factory run=r1 status -->", validatorMarker(H("a"), H("b")), "<!-- claude-factory delivery-contract run=a b -->", ""];
    for (const b of bad) expect(isDeliveryComment({ body: b })).toBe(false);
  });
});

describe("layout", () => {
  it("writes an ok comment", () => {
    const b = body();
    const l = lines(b);
    expect(l.slice(0, 5)).toEqual([reportFirst("info"), "", "### Delivery contract", "", "**Verified.**"]);
    for (const part of [RUN, "sequence 1", contractDigest(TEXT), SHA, "feature/x", `${events.length} events`, TERMINAL, FP]) expect(b).toContain(part);
    expect(l.indexOf("- build: success")).toBeLessThan(l.indexOf("- test: success"));
    expect(l.filter((x) => VALIDATOR_MARKER_RE.test(x))).toEqual([validatorMarker(contractDigest(TEXT), TERMINAL)]);
    expect(l.at(-2)).toBe(validatorMarker(contractDigest(TEXT), TERMINAL));
    expect(l.at(-1)).toBe(MARK);
    expect(DELIVERY_MARKER_RE.test(l.at(-1)!)).toBe(true);
    expect(isDeliveryComment({ body: b })).toBe(true);
    expect(b.endsWith("\n")).toBe(false);
  });

  it("writes a stop comment", () => {
    const b = body({ status: { kind: "stop", condition: "commit-changed", reason: "the commit moved" } });
    expect(lines(b)[0]).toBe("**What you need to do:** Look at why the delivery stopped, fix it, and run again.");
    expect(b).toContain("**Stopped:** `commit-changed` — the commit moved");
    const unknown = body({ status: { kind: "stop", condition: "nope" as never, reason: "x" } });
    expect(unknown).toContain("**Stopped.**");
    expect(unknown).not.toContain("**Stopped:**");
    expect(body({ status: { kind: "stop", condition: "superseded", reason: "" } })).toContain("**Stopped:** `superseded`\n");
  });

  it("writes an unsigned comment", () => {
    const b = body({ status: { kind: "unsigned" }, signature: undefined });
    expect(b).toContain("**Not verified.** No signing key is set, so the contract is unsigned.");
    expect(b).toContain("- **Key:** unsigned");
    expect(b).not.toContain("scf-delivery-signature");
    expect(b).toContain("scf-delivery-contract");
  });

  it("shows a malformed fingerprint as unsigned", () => {
    expect(body({ fingerprint: "SHA256:short" })).toContain("- **Key:** unsigned");
    expect(body({ fingerprint: undefined })).toContain("- **Key:** unsigned");
  });

  it("writes a stop comment without a contract", () => {
    const b = deliveryCommentBody({ status: { kind: "stop", condition: "evidence-unverified", reason: "no chain" }, lines: [] }, RUN);
    expect(b).toContain("none was written");
    expect(b).not.toContain("<details>");
    expect(lines(b).some((x) => VALIDATOR_MARKER_RE.test(x))).toBe(false);
    expect(lines(b).at(-1)).toBe(MARK);
  });
});

describe("input checks", () => {
  const throws = (over: Partial<DeliveryCommentInput>, run = RUN): void => expect(() => body(over, run)).toThrow(DeliveryCommentError);

  it("refuses a text that is not the canonical text", () => throws({ text: TEXT + " " }));
  it("accepts the canonical text and digest", () => {
    expect(() => body({ text: TEXT, digest: contractDigest(TEXT) })).not.toThrow();
  });
  it("refuses a digest that is well formed but wrong", () => {
    throws({ digest: contractDigest(deliveryContractText(contractOf({ sequence: 2 }))) });
    throws({ digest: H("0") });
  });
  it("refuses a digest that is not hex", () => throws({ digest: "zz" }));
  it("refuses a private key or a changed armour line as signature", () => {
    throws({ signature: K1.export({ format: "pem", type: "pkcs8" }).toString() });
    throws({ signature: SIG.replace("BEGIN SSH SIGNATURE", "BEGIN SSH SIGNATURES") });
    throws({ signature: SIG.slice(0, -1) });
  });
  it("refuses armour around a payload that is not an SSH signature", () => {
    const wrap = (b64: string): string => `-----BEGIN SSH SIGNATURE-----\n${b64}\n-----END SSH SIGNATURE-----\n`;
    throws({ signature: wrap("AAAA") });
    throws({ signature: wrap(SIG.split("\n").slice(1, -2).join("").slice(0, 60)) });
    throws({ signature: wrap(Buffer.alloc(120, 1).toString("base64")) });
  });
  it("refuses a private key wrapped in the signature armour", () => {
    const der = K1.export({ format: "der", type: "pkcs8" }).toString("base64");
    const wrapped = der.match(/.{1,70}/g)!.join("\n");
    throws({ signature: `-----BEGIN SSH SIGNATURE-----\n${wrapped}\n-----END SSH SIGNATURE-----\n` });
  });
  it("refuses a text, signature or digest without a contract", () => {
    for (const x of [{ text: TEXT }, { signature: SIG }, { digest: H("a") }]) {
      expect(() => deliveryCommentBody({ status: { kind: "stop" }, lines: [], ...x }, RUN)).toThrow(DeliveryCommentError);
    }
  });
  it("needs a signature for ok, and none for unsigned", () => {
    throws({ signature: undefined });
    throws({ status: { kind: "unsigned" } });
    expect(() => deliveryCommentBody({ status: { kind: "ok" }, lines: [] }, RUN)).toThrow(DeliveryCommentError);
  });
  it("refuses a bad run id and a contract that fails the schema", () => {
    throws({}, "a b");
    throws({ contract: { ...C, sequence: 0 } as DeliveryContract });
  });
});

describe("secrets in the contract", () => {
  const refused = (c: DeliveryContract, path: RegExp): void => {
    try {
      body({ contract: c, signature: undefined, status: { kind: "stop" } });
      expect.unreachable("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(DeliveryCommentError);
      expect((e as Error).message).toMatch(path);
      expect((e as Error).message).not.toContain(TOKEN);
    }
  };
  it("refuses a token in the branch, a check name or an artifact name", () => {
    refused(contractOf({ branch: `feature/${TOKEN}` }), /commit\.branch/);
    refused(contractOf({ requiredChecks: [`check-${TOKEN}`] }), /requiredChecks/);
    refused(contractOf({ artifacts: [{ name: `art-${TOKEN}` }] }), /artifacts/);
  });
  it("copies a clean contract byte for byte", () => {
    expect(readDeliveryComment(body()).contract).toBe(TEXT);
  });
});

describe("fences", () => {
  it("makes a fence longer than the backticks in the contract", () => {
    const c = contractOf({ branch: "feature/a`````b" });
    const text = deliveryContractText(c);
    const sig = signDeliveryContract(text, K1);
    const b = body({ contract: c, signature: sig });
    const open = lines(b).find((l) => l.endsWith("json scf-delivery-contract"))!;
    expect(open.length - "json scf-delivery-contract".length).toBeGreaterThanOrEqual(6);
    expect(readDeliveryComment(b).contract).toBe(text);
    const bullet = lines(b).find((l) => l.startsWith("- **Commit:**"))!;
    expect(bullet).toContain("feature/a'''''b");
    expect(bullet.match(/`/g)).toHaveLength(4);
  });
});

describe("safeLine", () => {
  it("makes one line without delimiters", () => {
    for (const t of ["a\nb\tc", "<!-- x -->", "<!<!---->--", "--<!-->>", "<details>"]) {
      const s = safeLine(t);
      expect(s).not.toMatch(/[\n\t<>]|<!--|-->/);
    }
    expect(safeLine("a\nb\tc")).toBe("a b c");
  });
  it("replaces backticks and neutralises mentions", () => {
    expect(safeLine("`code` @bob")).toBe("'code' @​bob");
  });
  it("is at most 300 characters counting the ellipsis", () => {
    const s = safeLine("x".repeat(500));
    expect([...s]).toHaveLength(300);
    expect(s.endsWith("…")).toBe(true);
    expect(safeLine("y".repeat(300))).toBe("y".repeat(300));
  });
  it("never leaves a token, also one split by a delimiter", () => {
    expect(safeLine(`${TOKEN}`)).not.toContain(TOKEN);
    const split = safeLine(`gh<!---->p_${"A1b2".repeat(9)}`);
    expect(split).not.toMatch(/gh[pousr]_[A-Za-z0-9]{36}/);
  });
  it("cannot be used to forge a marker", () => {
    const b = body({ lines: [validatorMarker(H("1"), H("2")), deliveryMarker("evil"), `x\n${MARK}`] });
    const l = lines(b);
    expect(l.filter((x) => VALIDATOR_MARKER_RE.test(x))).toHaveLength(1);
    expect(l.filter((x) => DELIVERY_MARKER_RE.test(x))).toEqual([MARK]);
    expect(l.at(-1)).toBe(MARK);
  });
  it("cuts the check lines", () => {
    const b = body({ lines: Array.from({ length: 60 }, (_, i) => `check ${i}`) });
    expect(lines(b).filter((l) => /^- check \d+$/.test(l))).toHaveLength(50);
    expect(b).toContain("- … and 10 more checks");
  });
});

describe("size", () => {
  it("falls back to the file in the run folder", () => {
    const locks = Array.from({ length: 1000 }, (_, i) => ({ path: `dir/f${String(i).padStart(4, "0")}.lock`, sha256: sha256Hex(Buffer.from(String(i))) }));
    const c = contractOf({ locks });
    const text = deliveryContractText(c);
    const full = body({ contract: c, signature: signDeliveryContract(text, K1) });
    expect(full.length).toBeLessThanOrEqual(MAX_COMMENT_CHARS);
    expect(full).not.toContain("<details>");
    expect(full).toContain("delivery/contract-1.json");
    expect(lines(full).filter((l) => VALIDATOR_MARKER_RE.test(l))).toHaveLength(1);
    expect(lines(full).at(-1)).toBe(MARK);
    const r = readDeliveryComment(full);
    expect(r.contract).toBeUndefined();
    expect(r.signature).toBeUndefined();
    expect(r.digest).toBe(contractDigest(text));
    expect(r.evidence).toBe(TERMINAL);
    // Without the fallback the body would be longer than the limit.
    expect(text.length * 1).toBeGreaterThan(MAX_COMMENT_CHARS - 5000);
  });
});

describe("large contracts", () => {
  it("make the fallback comment when a contract has more backtick runs than a call takes arguments", () => {
    // 1000 paths with 500 separated backtick runs each: far more runs than Math.max can take as arguments.
    const locks = Array.from({ length: 1000 }, (_, i) => ({ path: `d${i}/` + "`x".repeat(500) + ".lock", sha256: sha256Hex(Buffer.from(String(i))) }));
    const c = contractOf({ locks });
    const text = deliveryContractText(c);
    expect(text.length).toBeGreaterThan(MAX_COMMENT_CHARS);
    const full = body({ contract: c, signature: signDeliveryContract(text, K1) });
    expect(full.length).toBeLessThanOrEqual(MAX_COMMENT_CHARS);
    expect(full).toContain("delivery/contract-1.json");
    expect(full).not.toContain("<details>");
    expect(lines(full).at(-1)).toBe(MARK);
  });
});

describe("round trip", () => {
  it("reads back the contract, signature, digest and evidence", () => {
    for (const b of [body(), body().replace(/\n/g, "\r\n")]) {
      const r = readDeliveryComment(b);
      expect(r.contract).toBe(TEXT);
      expect(r.signature).toBe(SIG);
      expect(r.signature!.endsWith("\n")).toBe(true);
      expect(r.digest).toBe(contractDigest(TEXT));
      expect(r.evidence).toBe(TERMINAL);
      expect(verifyDeliveryContract(r.contract!, r.signature, KEY1).ok).toBe(true);
    }
  });
  it("gives no digest when the validator marker is there twice", () => {
    const r = readDeliveryComment(`${body()}\n${validatorMarker(H("1"), H("2"))}`);
    expect(r.digest).toBeUndefined();
    expect(r.evidence).toBeUndefined();
  });
  it("never throws", () => {
    expect(readDeliveryComment("junk")).toEqual({});
    expect(readDeliveryComment(undefined as unknown as string)).toEqual({});
  });
});

describe("no secrets in the body", () => {
  const saved = process.env.GH_TOKEN;
  afterAll(() => {
    if (saved === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = saved;
  });

  it("removes secrets from reasons and lines", () => {
    process.env.GH_TOKEN = TOKEN;
    const pem = K1.export({ format: "pem", type: "pkcs8" }).toString();
    const pemBody = pem.split("\n").filter((l) => l && !l.startsWith("-----")).join("");
    const pass = ["pass", "word", "=", "hunter2hunter2"].join("");
    const auth = ["Author", "ization: Bearer ", "q".repeat(30)].join("");
    const b = body({
      status: { kind: "stop", condition: "signature-unverified", reason: `${TOKEN} ${pem}` },
      lines: [auth, pass, PAT],
    });
    for (const s of [TOKEN, PAT, "q".repeat(30), "hunter2hunter2", pemBody, "PRIVATE KEY", "EVENT-CONTENT-SENTINEL"]) expect(b).not.toContain(s);
    expect(b).toContain("[removed: a token]");
    expect(readDeliveryComment(b).signature).toBe(SIG);
  });
});

describe("the validator reads the comment", () => {
  let dir: string;
  let head: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "delivery-comment-"));
    const id = ["-c", "user.email=t@example.com", "-c", "user.name=t"];
    execFileSync("git", ["init", "-q", "-b", "main", dir]);
    writeFileSync(join(dir, "README.md"), "# readme\n");
    execFileSync("git", ["-C", dir, ...id, "add", "-A"]);
    execFileSync("git", ["-C", dir, ...id, "commit", "-q", "-m", "base"]);
    head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const validate = async (comment: string, text: string, sig: string): Promise<{ code: number; stdout: string }> => {
    writeFileSync(join(dir, "contract.json"), text);
    writeFileSync(join(dir, "contract.json.sig"), sig);
    writeFileSync(join(dir, "comment.md"), comment);
    const args = [SCRIPT, "--contract", join(dir, "contract.json"), "--signature", join(dir, "contract.json.sig"), "--public-key", KEY1, "--repo", dir, "--comment", join(dir, "comment.md")];
    try {
      const r = await execFileAsync(process.execPath, args);
      return { code: 0, stdout: r.stdout };
    } catch (e) {
      const err = e as { code: number; stdout: string };
      return { code: err.code, stdout: err.stdout };
    }
  };

  it("accepts the comment and stops on a changed digest", async () => {
    const c = contractOf({ sha: head, requiredChecks: [] });
    const text = deliveryContractText(c);
    const sig = signDeliveryContract(text, K1);
    const good = body({ contract: c, signature: sig });
    const ok = await validate(good, text, sig);
    expect(ok.stdout.split("\n")).toContain("comment: ok");
    expect(ok.code).toBe(0);

    const other = contractDigest(deliveryContractText(contractOf({ sha: head, requiredChecks: [], sequence: 2 })));
    const tampered = good.replace(contractDigest(text) + " evidence", other + " evidence").replace(`digest=${contractDigest(text)}`, `digest=${other}`);
    const bad = await validate(tampered, text, sig);
    expect(bad.stdout).toContain("comment: stop superseded");
    expect(bad.code).toBe(1);
  });
});
