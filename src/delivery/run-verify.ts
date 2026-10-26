import { lstatSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ConfigIssuesError, type Config } from "../config.js";
import { readEvidenceChain, splitEvidenceLines } from "../evidence/chain.js";
import { evidenceIncomplete } from "../evidence/stream.js";
import { EVIDENCE_EVENTS_FILE } from "../evidence/version.js";
import { FACTORY_HOME } from "../flow/load.js";
import { contractDigest, evidenceHeadProblem, verifyDeliveryContract } from "./contract.js";
import { DeliveryContractSchema } from "./schema.js";
import { parseKeyLine, publicKeyLine } from "./sshsig.js";
import { DELIVERY_DIR, DeliveryWriteError, MAX_CONTRACT_BYTES, MAX_EVIDENCE_BYTES, readBoundedBytes, readConfiguredSigningKey } from "./write.js";

/**
 * `scf delivery verify <run-id>` and `scf delivery public-key`: check every delivery contract of a run offline against the
 * trusted key. Reads only. Files are read as raw bytes and decoded as strict UTF-8, so a changed byte can never decode to
 * the signed text. Messages and results hold paths relative to the run folder, never an absolute path.
 */

export const DELIVERY_PRINCIPAL = "scf-delivery";
export const DELIVERY_VERIFY_RESULT_VERSION = 1;
export const DELIVERY_VERIFY_USAGE = `usage: scf delivery verify <run-id> [--json] [--public-key <file>] [--runs-dir <dir>]
       Check the delivery contracts of a run against the trusted key (offline).
       Exit code 0: verified. 1: not verified. 2: unsigned contracts, or no contract.
       scf delivery public-key
       Print the configured signing key as an allowed_signers line (scf-delivery ssh-ed25519 …).
       scf delivery validate …   (see scf delivery validate --help)`;

export type RunDeliveryStatus = "verified" | "failed" | "unsigned" | "none";
export type RunDeliveryFault =
  | "folder" | "unexpected-file" | "numbering" | "orphan-signature"
  | "evidence-incomplete" | "evidence-missing" | "evidence-truncated" | "evidence-broken"
  | "unreadable" | "wrong-version" | "signature-bad" | "wrong-key" | "evidence-head-mismatch"
  | "run-id" | "sequence" | "supersedes" | "latest-copy";

export interface RunDeliveryResult {
  version: typeof DELIVERY_VERIFY_RESULT_VERSION;
  runId: string;
  status: RunDeliveryStatus;
  /** One sentence; no path, no value from a file. */
  explanation: string;
  /** `path` is relative to the run folder. */
  failure?: { fault: RunDeliveryFault; path: string; message: string };
  contracts: { path: string; sequence: number; signed: boolean; digest: string }[];
  events?: { count: number; terminalHash: string };
}

const MAX_KEY_FILE_BYTES = 16 * 1024;
const MAX_SIG_BYTES = 64 * 1024;
const NUMBERED = /^contract-([1-9][0-9]{0,8})\.json$/;
const NUMBERED_SIG = /^contract-([1-9][0-9]{0,8})\.json\.sig$/;

class NotUtf8 extends Error {}

/** The bytes and the strict UTF-8 text of a file; undefined when there is none. Throws ReadProblem, NotUtf8. */
function readText(path: string, max: number): { bytes: Buffer; text: string } | undefined {
  const bytes = readBoundedBytes(path, max);
  if (bytes === undefined) return undefined;
  try {
    // ignoreBOM keeps a leading BOM in the text, so a BOM-prefixed file fails to parse instead of verifying
    return { bytes, text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) };
  } catch {
    throw new NotUtf8();
  }
}

const FAULT_TEXT: Record<RunDeliveryFault, string> = {
  folder: "the delivery folder is not a plain folder",
  "unexpected-file": "the delivery folder holds a file that is not part of a delivery",
  numbering: "the contracts are not numbered 1, 2, 3 … without a gap",
  "orphan-signature": "a signature has no contract",
  "evidence-incomplete": "the evidence of the run is marked incomplete",
  "evidence-missing": "the evidence of the run is missing, empty or too large",
  "evidence-truncated": "the evidence ends in a line that is not complete",
  "evidence-broken": "the chain of events is broken",
  unreadable: "a contract cannot be read or is not valid",
  "wrong-version": "a contract is of a version this Foundry does not read",
  "signature-bad": "a signature does not verify",
  "wrong-key": "a contract is not signed by the trusted key",
  "evidence-head-mismatch": "the events do not match the evidence a contract states",
  "run-id": "a contract belongs to another run",
  sequence: "a contract has the wrong sequence number",
  supersedes: "a contract does not continue the one before it",
  "latest-copy": "the latest copy differs from the highest numbered contract",
};

/** Checks the delivery contracts of a run. Never throws; reads only. */
export function verifyRunDelivery(runDir: string, runId: string, publicKey: string): RunDeliveryResult {
  const contracts: RunDeliveryResult["contracts"] = [];
  let events: RunDeliveryResult["events"];
  const base = (status: RunDeliveryStatus, explanation: string): RunDeliveryResult => ({ version: DELIVERY_VERIFY_RESULT_VERSION, runId, status, explanation, contracts, ...(events ? { events } : {}) });
  const fail = (fault: RunDeliveryFault, path: string, message = FAULT_TEXT[fault]): RunDeliveryResult => ({
    ...base("failed", FAULT_TEXT[fault]),
    failure: { fault, path, message },
  });
  try {
    // 1. the folder
    const dir = join(runDir, DELIVERY_DIR);
    let st;
    try {
      st = lstatSync(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return base("none", "the run has no delivery contract");
      return fail("folder", DELIVERY_DIR);
    }
    if (!st.isDirectory()) return fail("folder", DELIVERY_DIR);

    // 2. the names
    const numbers = new Set<number>();
    const sigNumbers = new Set<number>();
    let latest = false;
    let latestSig = false;
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".")) continue;
      const m = NUMBERED.exec(name);
      const s = NUMBERED_SIG.exec(name);
      if (m) numbers.add(Number(m[1]));
      else if (s) sigNumbers.add(Number(s[1]));
      else if (name === "contract.json") latest = true;
      else if (name === "contract.json.sig") latestSig = true;
      else return fail("unexpected-file", `${DELIVERY_DIR}/${/^[\w.-]{1,100}$/.test(name) ? name : "(name)"}`);
    }
    if (numbers.size === 0 && sigNumbers.size === 0 && !latest && !latestSig) return base("none", "the run has no delivery contract");

    // 3. the numbering, 4. the signatures without a contract
    const n = numbers.size;
    for (let k = 1; k <= n; k++) if (!numbers.has(k)) return fail("numbering", `${DELIVERY_DIR}/contract-${k}.json`);
    for (const k of [...sigNumbers].sort((a, b) => a - b)) if (!numbers.has(k)) return fail("orphan-signature", `${DELIVERY_DIR}/contract-${k}.json.sig`);
    if (latestSig && !latest) return fail("orphan-signature", `${DELIVERY_DIR}/contract.json.sig`);
    if (n === 0) return fail("latest-copy", `${DELIVERY_DIR}/contract.json`);

    // 5. the evidence, as a whole
    if (evidenceIncomplete(runDir)) return fail("evidence-incomplete", "evidence.incomplete");
    let eventsText: string;
    try {
      const r = readText(join(runDir, EVIDENCE_EVENTS_FILE), MAX_EVIDENCE_BYTES);
      if (r === undefined) return fail("evidence-missing", EVIDENCE_EVENTS_FILE);
      eventsText = r.text;
    } catch (e) {
      return e instanceof NotUtf8 ? fail("evidence-broken", EVIDENCE_EVENTS_FILE) : fail("evidence-missing", EVIDENCE_EVENTS_FILE);
    }
    const { lines, tail } = splitEvidenceLines(eventsText);
    if (tail !== "") return fail("evidence-truncated", EVIDENCE_EVENTS_FILE);
    if (lines.length === 0) return fail("evidence-missing", EVIDENCE_EVENTS_FILE);
    const chain = readEvidenceChain(lines, runId);
    if (!chain.ok) return fail("evidence-broken", EVIDENCE_EVENTS_FILE, `line ${chain.line} of the events is not a chain`);
    if (chain.terminalHash !== null) events = { count: lines.length, terminalHash: chain.terminalHash };

    // 6. each contract
    let prevText: string | undefined;
    let lastBytes: Buffer | undefined;
    let lastSigBytes: Buffer | undefined;
    for (let k = 1; k <= n; k++) {
      const rel = `${DELIVERY_DIR}/contract-${k}.json`;
      let c: { bytes: Buffer; text: string } | undefined;
      try {
        c = readText(join(dir, `contract-${k}.json`), MAX_CONTRACT_BYTES);
      } catch {
        return fail("unreadable", rel);
      }
      if (c === undefined) return fail("unreadable", rel);
      let sig: { bytes: Buffer; text: string } | undefined;
      try {
        sig = readText(join(dir, `contract-${k}.json.sig`), MAX_SIG_BYTES);
      } catch {
        return fail("signature-bad", `${rel}.sig`);
      }
      const v = verifyDeliveryContract(c.text, sig?.text, publicKey, eventsText);
      let contract;
      if (v.ok) {
        contract = v.contract;
      } else if (sig === undefined && v.fault === "signature-missing") {
        // unsigned: the contract must still be well formed and continue the evidence
        const parsed = DeliveryContractSchema.safeParse(JSON.parse(c.text));
        if (!parsed.success) return fail("unreadable", rel);
        const problem = evidenceHeadProblem(eventsText, parsed.data);
        if (problem) return fail("evidence-head-mismatch", rel, problem);
        contract = parsed.data;
      } else {
        const fault: RunDeliveryFault = v.fault === "signature-missing" ? "signature-bad" : v.fault;
        return fail(fault, fault === "signature-bad" || fault === "wrong-key" ? (sig ? `${rel}.sig` : rel) : rel, v.message);
      }
      if (contract.runId !== runId) return fail("run-id", rel);
      if (contract.sequence !== k) return fail("sequence", rel);
      if (k > 1 && contract.supersedes !== contractDigest(prevText ?? "")) return fail("supersedes", rel);
      prevText = c.text;
      lastBytes = c.bytes;
      lastSigBytes = sig?.bytes;
      contracts.push({ path: rel, sequence: k, signed: sig !== undefined, digest: contractDigest(c.text) });
    }

    // 7. the latest copy, byte for byte
    try {
      const copy = readBoundedBytes(join(dir, "contract.json"), MAX_CONTRACT_BYTES);
      if (copy === undefined || !lastBytes || !copy.equals(lastBytes)) return fail("latest-copy", `${DELIVERY_DIR}/contract.json`);
      const copySig = readBoundedBytes(join(dir, "contract.json.sig"), MAX_SIG_BYTES);
      if ((copySig === undefined) !== (lastSigBytes === undefined) || (copySig && lastSigBytes && !copySig.equals(lastSigBytes))) return fail("latest-copy", `${DELIVERY_DIR}/contract.json.sig`);
    } catch {
      return fail("latest-copy", `${DELIVERY_DIR}/contract.json`);
    }

    // 8. signed or not
    if (contracts.some((c) => !c.signed)) return base("unsigned", "a contract has no signature, so it cannot be checked against the trusted key");
    return base("verified", `${contracts.length} contract(s) signed by the trusted key and continuing the evidence`);
  } catch {
    return fail("unreadable", DELIVERY_DIR);
  }
}

/** The lines a person reads. */
export function deliveryVerifyReport(r: RunDeliveryResult): string[] {
  const mark = r.status === "verified" ? "✔ verified" : r.status === "failed" ? "✘ not verified" : r.status === "unsigned" ? "■ unsigned" : "· no delivery contract";
  const out = [`${mark} · run ${r.runId}`, `  ${r.explanation}`];
  if (r.failure) out.push(`  check:     ${r.failure.fault} at ${r.failure.path}`);
  const last = r.contracts[r.contracts.length - 1];
  if (last) out.push(`  contracts: ${r.contracts.length}, latest ${last.digest}`);
  if (r.events) out.push(`  events:    ${r.events.count}, last hash ${r.events.terminalHash}`);
  return out;
}

/** 0 verified, 1 not verified, 2 unsigned or nothing to verify. */
export const deliveryVerifyExitCode = (r: RunDeliveryResult): number => (r.status === "verified" ? 0 : r.status === "failed" ? 1 : 2);

/** The `ssh-ed25519 AAAA…` key of a `--public-key` file: a plain key line or an allowed_signers line. Throws an Error without a path. */
export function readPublicKeyFile(path: string): string {
  let text: string | undefined;
  try {
    if (!statSync(path).isFile()) throw new Error("not a file");
    text = readBoundedBytes(path, MAX_KEY_FILE_BYTES)?.toString("utf8");
  } catch {
    text = undefined;
  }
  if (text === undefined) throw new Error("the --public-key file cannot be read");
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "" && !l.startsWith("#"));
  const parts = line?.split(/\s+/) ?? [];
  const i = parts.indexOf("ssh-ed25519");
  const candidate = i >= 0 && parts[i + 1] !== undefined ? `ssh-ed25519 ${parts[i + 1]}` : "";
  if (!parseKeyLine(candidate)) throw new Error("the --public-key file has no ssh-ed25519 key");
  return candidate;
}

interface CommandOptions {
  runsDir: string;
  json?: boolean;
  publicKeyFile?: string;
  /** Read only when the key comes from the settings. */
  config: () => Config;
  dataDir?: string;
}

/** The public key of the configured signing key. Throws an Error without a path. */
function configuredPublicKey(o: CommandOptions): string {
  let config: Config;
  try {
    config = o.config();
  } catch (e) {
    throw new Error(e instanceof ConfigIssuesError ? "the settings (config.yaml) are not valid" : "the settings (config.yaml) cannot be read");
  }
  const keyPath = config.delivery.signing_key_path;
  if (keyPath === undefined) throw new Error("no trusted key: set delivery.signing_key_path in the settings, or give --public-key <file>");
  try {
    return publicKeyLine(readConfiguredSigningKey(keyPath, o.dataDir ?? process.env.FACTORY_HOME ?? FACTORY_HOME));
  } catch (e) {
    throw new Error(e instanceof DeliveryWriteError && e.fault === "keyPlace" ? "the signing key is not in the delivery-keys folder of the data folder" : "the signing key cannot be used");
  }
}

/** `scf delivery verify <run-id>` and `scf delivery public-key`. Reads only. Prints through `out`; returns the exit code. */
export function deliveryCommand(positionals: string[], o: CommandOptions, out: (line: string) => void): number {
  const [sub, ...rest] = positionals;
  if (sub === "public-key") {
    if (rest.length || o.publicKeyFile !== undefined) throw new Error(DELIVERY_VERIFY_USAGE);
    out(`${DELIVERY_PRINCIPAL} ${configuredPublicKey(o)}`);
    return 0;
  }
  if (sub !== "verify" || rest.length !== 1) throw new Error(DELIVERY_VERIFY_USAGE);
  const runId = rest[0]!;
  if (!/^[\w-]{1,128}$/.test(runId)) throw new Error("a run id has only letters, digits, _ and -");
  const runDir = join(o.runsDir, runId);
  let isDir = false;
  try {
    isDir = statSync(runDir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) throw new Error(`run ${runId} not found`);
  const key = o.publicKeyFile !== undefined ? readPublicKeyFile(o.publicKeyFile) : configuredPublicKey(o);
  const result = verifyRunDelivery(runDir, runId, key);
  if (o.json) out(JSON.stringify(result, null, 2));
  else for (const line of deliveryVerifyReport(result)) out(line);
  return deliveryVerifyExitCode(result);
}
