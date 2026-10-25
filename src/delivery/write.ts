import { randomBytes, type KeyObject } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import type { Config } from "../config.js";
import type { Engine } from "../engine/execute.js";
import { DELIVERY_KEYS_DIR } from "../engine/os-sandbox.js";
import { FACTORY_HOME } from "../flow/load.js";
import { canonicalJson } from "../evidence/canonical.js";
import { readEvidenceChain, splitEvidenceLines } from "../evidence/chain.js";
import { PullRequestIdentitySchema, RepositorySchema, type PullRequestIdentity } from "../evidence/identity.js";
import { evidenceIncomplete } from "../evidence/stream.js";
import { EVIDENCE_EVENTS_FILE } from "../evidence/version.js";
import { buildDeliveryContract, contractDigest, DeliveryContractError, deliveryContractText, evidenceHeadProblem, signDeliveryContract } from "./contract.js";
import { CommitFactsError, readCommitFacts, type CommitFactsOptions } from "./git-facts.js";
import { DeliveryContractSchema, type DeliveryContract } from "./schema.js";
import { readSigningKey } from "./sshsig.js";

/**
 * Writes the delivery contracts of a run: after a step, once the run has a pull request of its own repository, a new
 * `<run>/delivery/contract-<n>.json` (and `.json.sig`) when something it states changed. Numbered files are written once
 * and never changed; `contract.json` (and `.sig`) is a copy of the latest one, replaced by a rename.
 */

export const DELIVERY_DIR = "delivery";
export { DEPENDENCY_LOCK_NAMES, readCommitFacts, CommitFactsError, type CommitFacts, type CommitFactsOptions } from "./git-facts.js";

export const MAX_EVIDENCE_BYTES = 256 * 1024 * 1024;
export const MAX_CONTRACT_BYTES = 1024 * 1024;
const MAX_KEY_BYTES = 16 * 1024;

const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99})\/([A-Za-z0-9_.-]{1,100})\/pull\/([1-9][0-9]{0,9})$/;

/** The pull request of the run's repository named by `url`; anything else (another repository, another address) gives undefined. */
export function parsePullRequestUrl(url: string, repo: string): PullRequestIdentity | undefined {
  try {
    const m = PR_URL.exec(url);
    if (!m || !RepositorySchema.safeParse(repo).success) return undefined;
    if (`${m[1]}/${m[2]}`.toLowerCase() !== repo.toLowerCase()) return undefined;
    return PullRequestIdentitySchema.parse({ repository: repo, number: Number(m[3]), url });
  } catch {
    return undefined;
  }
}

export interface DeliveryRequirements {
  requiredChecks: string[];
  artifacts: string[];
  provenance: boolean;
}

/** The global requirements, with the repository's entry overriding only the fields it sets. */
export function deliveryRequirements(delivery: Config["delivery"], repo: string): DeliveryRequirements {
  const key = repo.toLowerCase();
  const entry = Object.entries(delivery.repositories).find(([k]) => k.toLowerCase() === key)?.[1];
  return {
    requiredChecks: [...(entry?.required_checks ?? delivery.required_checks)],
    artifacts: [...(entry?.artifacts ?? delivery.artifacts)],
    provenance: entry?.provenance ?? delivery.provenance,
  };
}

export const DELIVERY_WRITE_FAULTS = {
  evidence: "the evidence of the run is missing, too large, broken, incomplete or does not continue the last contract; no contract was written",
  folder: "the delivery folder of the run is not a plain folder; no contract was written",
  latest: "the latest contract cannot be read; no contract was written",
  keyPlace: "the signing key is not in the delivery-keys folder of the data folder; no contract was written",
  key: "the signing key cannot be used; no contract was written",
  write: "the contract cannot be written",
} as const;

/** The message is always one of DELIVERY_WRITE_FAULTS: no path, no text of an fs error. */
export class DeliveryWriteError extends Error {
  constructor(readonly fault: keyof typeof DELIVERY_WRITE_FAULTS) {
    super(DELIVERY_WRITE_FAULTS[fault]);
    this.name = "DeliveryWriteError";
  }
}

export interface WriteContractInput {
  runDir: string;
  runId: string;
  /** The data folder; the signing key must be inside its `delivery-keys` folder. */
  dataDir: string;
  workdir: string;
  repository: string;
  pullRequest: PullRequestIdentity;
  delivery: Config["delivery"];
  git?: Omit<CommitFactsOptions, "reuse">;
  maxEvidenceBytes?: number;
}

export interface WrittenContract {
  sequence: number;
  signed: boolean;
  digest: string;
}

export class ReadProblem extends Error {}

/** The text of a plain file of at most `max` bytes (invalid UTF-8 is replaced); undefined when there is none. Throws ReadProblem. */
function readBounded(path: string, max: number): string | undefined {
  return readBoundedBytes(path, max)?.toString("utf8");
}

/** The bytes of a plain file of at most `max` bytes; undefined when there is none. Never follows a link and never waits for a pipe. Throws ReadProblem. */
export function readBoundedBytes(path: string, max: number): Buffer | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ReadProblem();
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max) throw new ReadProblem();
    const buf = Buffer.alloc(Math.min(st.size, max) + 1);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, got);
      if (n === 0) break;
      got += n;
    }
    if (got > max) throw new ReadProblem();
    return buf.subarray(0, got);
  } catch (e) {
    throw e instanceof ReadProblem ? e : new ReadProblem();
  } finally {
    closeSync(fd);
  }
}

/** Replaces `contract.json` (and its `.sig`) with the given contract by renaming temporary files. */
function publishLatest(dir: string, text: string, sig: string | undefined): void {
  const tag = randomBytes(6).toString("hex");
  const tmp = join(dir, `.contract.${tag}.tmp`);
  const sigTmp = join(dir, `.sig.${tag}.tmp`);
  try {
    writeFileSync(tmp, text, { flag: "wx", mode: 0o600 });
    if (sig !== undefined) writeFileSync(sigTmp, sig, { flag: "wx", mode: 0o600 });
    rmSync(join(dir, "contract.json.sig"), { force: true });
    renameSync(tmp, join(dir, "contract.json"));
    if (sig !== undefined) renameSync(sigTmp, join(dir, "contract.json.sig"));
  } finally {
    rmSync(tmp, { force: true });
    rmSync(sigTmp, { force: true });
  }
}

const NOT_FACTS = ["version", "runId", "sequence", "supersedes", "evidence"];
/** The facts a contract states, without the numbering and the evidence: two contracts with equal facts are the same delivery. */
const stable = (c: DeliveryContract): string => canonicalJson(Object.fromEntries(Object.entries(c).filter(([k]) => !NOT_FACTS.includes(k))));

/** Throws DeliveryWriteError, CommitFactsError. Returns the written contract, or undefined when nothing it states changed. */
export function writeContract(input: WriteContractInput): WrittenContract | undefined {
  try {
    return write(input);
  } catch (e) {
    if (e instanceof DeliveryWriteError || e instanceof CommitFactsError) throw e;
    throw new DeliveryWriteError("write");
  }
}

/** The signing key at `signingKeyPath`, which must really be inside `<dataDir>/delivery-keys`. Throws DeliveryWriteError("keyPlace" | "key"). */
export function readConfiguredSigningKey(signingKeyPath: string, dataDir: string): KeyObject {
  let real: string;
  try {
    const keys = realpathSync(join(dataDir, DELIVERY_KEYS_DIR));
    real = realpathSync(signingKeyPath);
    if (!real.startsWith(keys + sep)) throw new Error("outside");
  } catch {
    throw new DeliveryWriteError("keyPlace");
  }
  let keyText: string | undefined;
  try {
    keyText = readBounded(real, MAX_KEY_BYTES);
  } catch {
    keyText = undefined;
  }
  if (keyText === undefined) throw new DeliveryWriteError("key");
  const key = readSigningKey(keyText);
  if (!key.ok) throw new DeliveryWriteError("key");
  return key.key;
}

function write(input: WriteContractInput): WrittenContract | undefined {
  const { runDir, runId, repository, delivery } = input;
  const fail = (f: keyof typeof DELIVERY_WRITE_FAULTS): never => {
    throw new DeliveryWriteError(f);
  };

  // 1. the folder
  const dir = join(runDir, DELIVERY_DIR);
  let st;
  try {
    st = lstatSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return fail("write");
    mkdirSync(dir, { mode: 0o700 });
    st = lstatSync(dir);
  }
  if (!st.isDirectory()) return fail("folder");

  // 2. the latest numbered contract
  let n = 0;
  for (const name of readdirSync(dir)) {
    const m = /^contract-([1-9][0-9]{0,8})\.json$/.exec(name);
    if (m) n = Math.max(n, Number(m[1]));
  }
  let prev: DeliveryContract | undefined;
  let prevText = "";
  if (n > 0) {
    try {
      const text = readBounded(join(dir, `contract-${n}.json`), MAX_CONTRACT_BYTES);
      if (text === undefined) return fail("latest");
      const raw: unknown = JSON.parse(text);
      const parsed = DeliveryContractSchema.safeParse(raw);
      if (canonicalJson(raw) !== text || !parsed.success || parsed.data.runId !== runId || parsed.data.sequence !== n) return fail("latest");
      prev = parsed.data;
      prevText = text;
    } catch (e) {
      if (e instanceof DeliveryWriteError) throw e;
      return fail("latest");
    }
  }

  // 3. the evidence
  if (evidenceIncomplete(runDir)) return fail("evidence");
  let events: string | undefined;
  try {
    events = readBounded(join(runDir, EVIDENCE_EVENTS_FILE), input.maxEvidenceBytes ?? MAX_EVIDENCE_BYTES);
  } catch {
    events = undefined;
  }
  if (events === undefined) return fail("evidence");
  const { lines, tail } = splitEvidenceLines(events);
  if (tail !== "" || lines.length === 0) return fail("evidence");
  const chain = readEvidenceChain(lines, runId);
  if (!chain.ok || chain.terminalHash === null) return fail("evidence");
  if (prev && evidenceHeadProblem(events, prev) !== undefined) return fail("evidence");

  // 4. the git facts
  const facts = readCommitFacts(input.workdir, {
    ...input.git,
    ...(prev ? { reuse: { commit: prev.commit, dependencyLocks: prev.dependencyLock.files, ciWorkflows: prev.ciWorkflows } } : {}),
  });

  // 5. build
  const req = deliveryRequirements(delivery, repository);
  let next: DeliveryContract;
  try {
    next = buildDeliveryContract({
      runId,
      sequence: n + 1,
      ...(prev ? { supersedes: contractDigest(prevText) } : {}),
      repository,
      pullRequest: input.pullRequest,
      ...facts,
      requiredChecks: req.requiredChecks,
      artifacts: req.artifacts.map((name) => ({ name })),
      provenance: { required: req.provenance },
      evidence: { count: lines.length, terminalHash: chain.terminalHash },
    });
  } catch (e) {
    if (e instanceof DeliveryContractError) return fail("write");
    throw e;
  }

  // 6. compare; when nothing changed, only put the latest copy back if it is missing or stale
  if (prev && stable(prev) === stable(next)) {
    const numberedSig = readBounded(join(dir, `contract-${n}.json.sig`), MAX_CONTRACT_BYTES);
    let copy: string | undefined;
    let copySig: string | undefined;
    try {
      copy = readBounded(join(dir, "contract.json"), MAX_CONTRACT_BYTES);
      copySig = readBounded(join(dir, "contract.json.sig"), MAX_CONTRACT_BYTES);
    } catch {
      copy = undefined;
    }
    if (copy !== prevText || copySig !== numberedSig) publishLatest(dir, prevText, numberedSig);
    return undefined;
  }

  // 7. the key
  const key = delivery.signing_key_path === undefined ? undefined : readConfiguredSigningKey(delivery.signing_key_path, input.dataDir);

  // 8. sign
  const text = deliveryContractText(next);
  const sig = key ? signDeliveryContract(text, key) : undefined;

  // 9. the numbered files, written once
  // a file is owned from the moment it is created, so a failed or partial write is removed too
  const created: string[] = [];
  try {
    for (const [name, body] of [[`contract-${n + 1}.json`, text], ...(sig === undefined ? [] : [[`contract-${n + 1}.json.sig`, sig]])] as [string, string][]) {
      const fd = openSync(join(dir, name), "wx", 0o600);
      created.push(join(dir, name));
      try {
        writeFileSync(fd, body);
      } finally {
        closeSync(fd);
      }
    }
  } catch {
    for (const f of created) rmSync(f, { force: true });
    return fail("write");
  }

  // 10. the latest copy; on failure the numbered files stay and the next call puts the copy back
  publishLatest(dir, text, sig);
  return { sequence: n + 1, signed: sig !== undefined, digest: contractDigest(text) };
}

/** Called after a top-level step: writes a contract when the run has a pull request of its own repository. Never throws. */
export function deliveryAfterStep(engine: Engine): void {
  try {
    const s = engine.summary;
    const url = s.outputs?.pull_request;
    const repo = s.vars?.github_repo;
    if (typeof url !== "string" || typeof repo !== "string" || !s.workdir || !existsSync(s.workdir)) return;
    const pullRequest = parsePullRequestUrl(url, repo);
    if (!pullRequest) return;
    const delivery = (engine.deliverySettings ?? (() => engine.config.delivery))();
    try {
      const w = writeContract({ runDir: s.runDir, runId: s.runId, dataDir: process.env.FACTORY_HOME ?? FACTORY_HOME, workdir: s.workdir, repository: repo, pullRequest, delivery });
      if (w) engine.log(`  delivery: contract ${w.sequence} written (${w.signed ? "signed" : "unsigned"})`);
    } catch (e) {
      engine.log(`  delivery: ${e instanceof DeliveryWriteError || e instanceof CommitFactsError ? e.message : DELIVERY_WRITE_FAULTS.write}`);
    }
  } catch {
    // never fails a step
  }
}
