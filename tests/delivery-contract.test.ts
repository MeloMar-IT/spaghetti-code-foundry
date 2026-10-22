import { createPrivateKey, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildDeliveryContract,
  contractDigest,
  DELIVERY_SIGNATURE_NAMESPACE,
  DeliveryContractError,
  deliveryContractText,
  signDeliveryContract,
  verifyDeliveryContract,
  type DeliveryFacts,
} from "../src/delivery/contract.js";
import { DeliveryContractSchema, STOP_CONDITIONS } from "../src/delivery/schema.js";
import { publicKeyLine, signSsh } from "../src/delivery/sshsig.js";
import { canonicalHash, canonicalJson, eventHash } from "../src/evidence/canonical.js";
import { sha256Hex } from "../src/evidence/identity.js";

const PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
const keyOf = (n: number): KeyObject => createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.alloc(32, n)]), format: "der", type: "pkcs8" });
const K1 = keyOf(1);
const K2 = keyOf(2);
const H = (c: string, n = 64): string => c.repeat(n);

const chain = (n: number, runId: string): string[] => {
  let prev: string | null = null;
  return Array.from({ length: n }, (_, seq) => {
    const e: Record<string, unknown> = { version: 1, id: `ev-${String(seq).padStart(6, "0")}`, seq, runId, time: "2026-01-31T12:00:00.000Z", type: "run.queued", prevHash: prev };
    prev = eventHash(e);
    return canonicalJson({ ...e, hash: prev });
  });
};
const EVENTS = chain(5, "run-1");
const hashAt = (i: number): string => (JSON.parse(EVENTS[i] as string) as { hash: string }).hash;

const FACTS: DeliveryFacts = {
  runId: "run-1",
  sequence: 1,
  repository: "acme/app",
  pullRequest: { repository: "acme/app", number: 7, url: "https://github.com/acme/app/pull/7", head: H("a", 40) },
  commit: { sha: H("a", 40), branch: "feature/x" },
  dependencyLocks: [
    { path: "package-lock.json", sha256: H("1") },
    { path: "a/pnpm-lock.yaml", sha256: H("2") },
  ],
  ciWorkflows: [
    { path: ".github/workflows/test.yml", blob: H("b", 40) },
    { path: ".github/workflows/build.yml", blob: H("c", 40) },
  ],
  requiredChecks: ["test", "build", "lint"],
  evidence: { count: 3, terminalHash: hashAt(2) },
  artifacts: [{ name: "report", sha256: H("3") }, { name: "bundle" }],
  provenance: { required: true },
};
const rev = (f: DeliveryFacts): DeliveryFacts => ({
  ...f,
  dependencyLocks: [...f.dependencyLocks].reverse(),
  ciWorkflows: [...f.ciWorkflows].reverse(),
  requiredChecks: [...f.requiredChecks].reverse(),
  artifacts: [...f.artifacts].reverse(),
});
const text = (f: DeliveryFacts = FACTS): string => deliveryContractText(buildDeliveryContract(f));
const issues = (f: DeliveryFacts): string => {
  try {
    buildDeliveryContract(f);
  } catch (e) {
    expect(e).toBeInstanceOf(DeliveryContractError);
    return (e as DeliveryContractError).issues.map((i) => i.path).join(",");
  }
  return "";
};

describe("building a contract", () => {
  it("gives the same bytes, digest and signature whatever the order", () => {
    expect(text(rev(FACTS))).toBe(text());
    expect(contractDigest(text(rev(FACTS)))).toBe(contractDigest(text()));
    expect(signDeliveryContract(text(rev(FACTS)), K1)).toBe(signDeliveryContract(text(), K1));
  });

  it("writes a fixed canonical text", () => {
    const minimal: DeliveryFacts = {
      runId: "run-1",
      sequence: 1,
      repository: "acme/app",
      pullRequest: { repository: "acme/app", number: 7, url: "https://github.com/acme/app/pull/7" },
      commit: { sha: H("a", 40), branch: "main" },
      dependencyLocks: [],
      ciWorkflows: [],
      requiredChecks: [],
      evidence: { count: 1, terminalHash: H("d") },
      artifacts: [],
      provenance: { required: false },
    };
    const literal = `{"artifacts":[],"ciWorkflows":[],"commit":{"branch":"main","sha":"${H("a", 40)}"},"dependencyLock":{"files":[],"sha256":"${canonicalHash([])}"},"evidence":{"count":1,"path":"evidence.jsonl","terminalHash":"${H("d")}"},"provenance":{"required":false},"pullRequest":{"number":7,"repository":"acme/app","url":"https://github.com/acme/app/pull/7"},"repository":"acme/app","requiredChecks":[],"runId":"run-1","sequence":1,"stopConditions":${JSON.stringify(STOP_CONDITIONS)},"version":1}`;
    expect(text(minimal)).toBe(literal);
    expect(contractDigest(literal)).toBe(sha256Hex(Buffer.from(literal, "utf8")));
    expect(buildDeliveryContract(minimal).dependencyLock).toEqual({ files: [], sha256: canonicalHash([]) });
  });

  it("fills the fixed parts and drops extra properties", () => {
    const c = buildDeliveryContract({ ...FACTS, extra: "x" } as DeliveryFacts);
    expect(c.stopConditions).toEqual([...STOP_CONDITIONS]);
    expect(c.evidence.path).toBe("evidence.jsonl");
    expect(text()).not.toContain("extra");
    expect(c.dependencyLock.files.map((f) => f.path)).toEqual(["a/pnpm-lock.yaml", "package-lock.json"]);
  });

  it("refuses facts that are wrong", () => {
    const w = ".github/workflows/test.yml";
    expect(issues({ ...FACTS, dependencyLocks: [...FACTS.dependencyLocks, FACTS.dependencyLocks[0]!] })).toContain("dependencyLock");
    expect(issues({ ...FACTS, ciWorkflows: [...FACTS.ciWorkflows, { path: w, blob: H("e", 40) }] })).toContain("ciWorkflows");
    expect(issues({ ...FACTS, requiredChecks: ["a", "a"] })).toContain("requiredChecks");
    expect(issues({ ...FACTS, artifacts: [{ name: "a" }, { name: "a" }] })).toContain("artifacts");
    expect(issues({ ...FACTS, ciWorkflows: [{ path: "ci/test.yml", blob: H("b", 40) }] })).not.toBe("");
    expect(issues({ ...FACTS, sequence: 2 })).toContain("supersedes");
    expect(issues({ ...FACTS, supersedes: H("9") })).toContain("supersedes");
    expect(issues({ ...FACTS, sequence: 2, supersedes: H("9") })).toBe("");
    expect(issues({ ...FACTS, pullRequest: { ...FACTS.pullRequest, repository: "acme/other" } })).toContain("pullRequest.repository");
    expect(issues({ ...FACTS, pullRequest: { ...FACTS.pullRequest, head: H("f", 40) } })).toContain("pullRequest.head");
    expect(issues({ ...FACTS, dependencyLocks: [{ path: "../x", sha256: H("1") }] })).not.toBe("");
    expect(issues({ ...FACTS, commit: { sha: "abc123", branch: "main" } })).not.toBe("");
    expect(issues({ ...FACTS, evidence: { count: 0, terminalHash: H("d") } })).toContain("evidence");
  });

  it("is checked by the schema when read", () => {
    const good = JSON.parse(text()) as Record<string, unknown>;
    expect(DeliveryContractSchema.safeParse(good).success).toBe(true);
    const files = (good.dependencyLock as { files: unknown[]; sha256: string }).files;
    const bad = [
      { ...good, requiredChecks: ["test", "build"] },
      { ...good, dependencyLock: { files, sha256: H("0") } },
      { ...good, dependencyLock: { files: [...files].reverse(), sha256: canonicalHash([...files].reverse()) } },
      { ...good, stopConditions: [...STOP_CONDITIONS].reverse() },
      { ...good, stopConditions: STOP_CONDITIONS.slice(1) },
      { ...good, more: 1 },
    ];
    for (const b of bad) expect(DeliveryContractSchema.safeParse(b).success).toBe(false);
  });
});

describe("verifying a contract", () => {
  const t = text();
  const sig = signDeliveryContract(t, K1);
  const line = publicKeyLine(K1);
  const fault = (r: ReturnType<typeof verifyDeliveryContract>) => (r.ok ? "ok" : r.fault);

  it("accepts a correct contract", () => {
    const r = verifyDeliveryContract(t, sig, line);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.digest).toBe(contractDigest(t));
  });

  it("refuses every changed byte of the text", () => {
    for (let i = 0; i < t.length; i++) {
      const changed = t.slice(0, i) + (t[i] === "a" ? "b" : "a") + t.slice(i + 1);
      expect(verifyDeliveryContract(changed, sig, line).ok, `byte ${i}`).toBe(false);
    }
  });

  it("refuses text that is not the canonical contract", () => {
    expect(fault(verifyDeliveryContract("nope", sig, line))).toBe("unreadable");
    expect(fault(verifyDeliveryContract("[]", sig, line))).toBe("unreadable");
    expect(fault(verifyDeliveryContract(JSON.stringify(JSON.parse(t), null, 1), sig, line))).toBe("unreadable");
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(t) as object).reverse()));
    expect(fault(verifyDeliveryContract(reordered, signDeliveryContract(reordered, K1), line))).toBe("unreadable");
    const v2 = canonicalJson({ ...JSON.parse(t), version: 2 });
    expect(fault(verifyDeliveryContract(v2, signDeliveryContract(v2, K1), line))).toBe("wrong-version");
  });

  it("reports the signature faults", () => {
    expect(fault(verifyDeliveryContract(t, undefined, line))).toBe("signature-missing");
    expect(fault(verifyDeliveryContract(t, "", line))).toBe("signature-missing");
    expect(fault(verifyDeliveryContract(t, signDeliveryContract("other", K1), line))).toBe("signature-bad");
    expect(fault(verifyDeliveryContract(t, sig.replace(/.$/m, (c) => (c === "A" ? "B" : "A")), line))).toBe("signature-bad");
    expect(fault(verifyDeliveryContract(t, signSsh(t, K1, "other"), line))).toBe("signature-bad");
    expect(fault(verifyDeliveryContract(t, sig, publicKeyLine(K2)))).toBe("wrong-key");
    expect(fault(verifyDeliveryContract(t, sig, "garbage"))).toBe("wrong-key");
    expect(DELIVERY_SIGNATURE_NAMESPACE).toBe("scf-delivery-contract");
  });

  it("checks the signature before the trusted key", () => {
    expect(fault(verifyDeliveryContract(t, signDeliveryContract("other", K2), line))).toBe("signature-bad");
    expect(fault(verifyDeliveryContract(t, signDeliveryContract("other", K1), "garbage"))).toBe("signature-bad");
  });

  it("checks the head of the events", () => {
    const events = (lines: string[]) => lines.join("\n") + "\n";
    const head = (lines: string[]) => fault(verifyDeliveryContract(t, sig, line, events(lines)));
    expect(head(EVENTS.slice(0, 3))).toBe("ok");
    expect(head(EVENTS)).toBe("ok");
    expect(fault(verifyDeliveryContract(t, sig, line, events(EVENTS.slice(0, 3)) + EVENTS[3]!.slice(0, 20)))).toBe("ok");
    expect(head(EVENTS.slice(0, 2))).toBe("evidence-head-mismatch");
    expect(head([EVENTS[0]!, EVENTS[1]!.replace("run.queued", "run.created"), EVENTS[2]!])).toBe("evidence-head-mismatch");
    expect(head(chain(3, "other-run"))).toBe("evidence-head-mismatch");
    const wrong = text({ ...FACTS, evidence: { count: 3, terminalHash: H("d") } });
    expect(fault(verifyDeliveryContract(wrong, signDeliveryContract(wrong, K1), line, events(EVENTS)))).toBe("evidence-head-mismatch");
    const none = text({ ...FACTS, evidence: { count: 3, terminalHash: H("d") } });
    expect(fault(verifyDeliveryContract(none, signDeliveryContract(none, K1), line))).toBe("ok");
  });

  it("never throws", () => {
    for (const bad of [undefined, 5, null, {}]) {
      expect(verifyDeliveryContract(bad as never, bad as never, bad as never, bad as never).ok).toBe(false);
    }
  });
});
