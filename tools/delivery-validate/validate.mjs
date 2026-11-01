#!/usr/bin/env node
// Checks a delivery contract against a checked-out commit. One plain Node script: it imports only node: modules,
// so a CI job can run it without `npm ci` and without `dist/`.
//
//   node validate.mjs --contract <file> --signature <file> --public-key <ssh-ed25519 line or file>
//                     [--repo <dir>] [--checks <file>] [--comment <file>] [--events <file>] [--json] [--version] [--help]
//
// Exit codes: 0 no stop, 1 at least one stop, 2 a usage or read error.
//
// This file COPIES rules from the library, because it cannot load src/ (zod, dist/). CHANGE BOTH, or
// tests/delivery-validate.test.ts (the parity matrix) fails. The copied sources:
//   src/evidence/canonical.ts     canonicalJson, canonicalHash
//   src/evidence/identity.ts      sha256Hex, label, isSafeRelativePath, isPlainHttpsUrl and the id patterns
//   src/delivery/schema.ts        DeliveryContractSchema (as contractProblems), STOP_CONDITIONS, sortedOnce
//   src/delivery/contract.ts      verifyDeliveryContract (the order of the faults and their messages)
//   src/delivery/sshsig.ts        verifySshSignature, Reader, parseKeyLine, armour, signedData
//   src/skills/release-signature.ts  decodeBase64Exact, ed25519PublicKey
//   src/evidence/schema.ts        EvidenceEventSchema (EventUnion, the envelope, the superRefine) and what it reaches:
//                                 identity.ts (actor, step, model, tool, policy, test, git, pull request, artifact, time, UUID),
//                                 policy/schema.ts + reasons.ts (PolicyDecisionSchema), tool-profile/schema.ts, session.ts, resolve.ts,
//                                 engine/repo-request.ts, flow/schema.ts (AGENTS)
//   src/evidence/chain.ts, parse.ts, version.ts, canonical.ts  readEvidenceChain, parseEvidenceEvent, upgradeEvidence, eventHash
// Signing and key reading are left out. The script never writes a file.

import { execFile } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { parseArgs, promisify } from "node:util";

const execFileAsync = promisify(execFile);

const NAMESPACE = "scf-delivery-contract";
// Raise this when a verdict, an option or the output changes. The release files are named after it
// (scf-delivery-validate-<version>.mjs). It is not the `version` of the --json output.
const VALIDATOR_VERSION = "1.2.0";
const STOP_CONDITIONS = ["commit-changed", "lock-changed", "workflow-changed", "required-check-failed", "evidence-unverified", "signature-unverified", "superseded"];
const WORKFLOWS_DIR = ".github/workflows/";
const EVIDENCE_EVENTS_FILE = "evidence.jsonl";
const CHECKS = ["contract", "signature", "commit", "locks", "workflows", "checks", "evidence", "comment"];
const MARKER = /^<!-- claude-factory delivery-contract digest=([0-9a-f]{64}) evidence=([0-9a-f]{64}) -->$/;
const TEXT_MAX = 1024 * 1024;
const KEY_MAX = 16 * 1024;
const CHECKS_MAX = 10000;
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const UNTRUSTED = "the contract is not trusted";

const USAGE =
  "usage: node validate.mjs --contract <file> --signature <file> --public-key <ssh-ed25519 line or file> [--repo <dir>] [--checks <file>] [--comment <file>] [--events <file>] [--json] [--version]\n" +
  "       Checks a delivery contract against the checked-out commit.\n" +
  "       Exit code 0: no stop. 1: at least one stop. 2: a usage or read error.\n";

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** Control characters become `?`; long text is cut. */
const clean = (s) => {
  const t = String(s).replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
  return t.length > 300 ? `${t.slice(0, 300)}…` : t;
};

class InputError extends Error {
  constructor(usage, message) {
    super(message);
    this.usage = usage;
  }
}

// ---- copied: src/evidence/canonical.ts, identity.ts ----

function canonicalJson(value) {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("a number that is not finite has no canonical form");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new TypeError("only plain objects have a canonical form");
      const names = Object.keys(value).filter((k) => value[k] !== undefined).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${names.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
    }
    default:
      throw new TypeError(`a ${typeof value} has no canonical form`);
  }
}
const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");
const canonicalHash = (value) => sha256Hex(Buffer.from(canonicalJson(value), "utf8"));

const label = (v, max) => typeof v === "string" && v.length >= 1 && v.length <= max && v === v.trim() && !CONTROL.test(v);
function isSafeRelativePath(path) {
  if (typeof path !== "string" || path.length < 1 || path.length > 1024) return false;
  if (CONTROL.test(path) || path.includes("\\") || /^[A-Za-z]:/.test(path)) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part === part.trim());
}
function isPlainHttpsUrl(text) {
  if (typeof text !== "string" || text.length > 2000 || CONTROL.test(text) || /\s/.test(text)) return false;
  let url;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.username === "" && url.password === "" && url.port === "" && url.search === "" && url.hash === "" && !text.includes("?") && !text.includes("#") && !text.includes("@");
}
const isSha256 = (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const isCommit = (v) => typeof v === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(v);
const isRunId = (v) => typeof v === "string" && /^[\w-]{1,128}$/.test(v);
const isRepository = (v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_.-]{1,100}$/.test(v);
const isBranch = (v) => label(v, 255) && !/\s/.test(v);
const isWholeFrom1 = (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 1;

// ---- copied: src/delivery/schema.ts (DeliveryContractSchema) ----

const compareCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isPlain = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const sortedOnce = (keys) => keys.every((k, i) => i === 0 || compareCodeUnits(keys[i - 1], k) < 0);

/** The field paths where `c` breaks DeliveryContractSchema. Empty when the contract is valid. */
function contractProblems(c) {
  const problems = [];
  const bad = (path) => problems.push(path);
  /** Checks that `v` is an object with exactly these keys (`opt` ones may be missing). Returns whether it is. */
  const strict = (v, path, req, opt = []) => {
    if (!isPlain(v)) {
      bad(path || "(contract)");
      return false;
    }
    const at = (k) => (path ? `${path}.${k}` : k);
    // An unknown name is input text: only its parent path is reported, never the name itself.
    for (const k of Object.keys(v)) if (!req.includes(k) && !opt.includes(k)) bad(path ? `${path}.(unknown field)` : "(unknown field)");
    for (const k of req) if (!Object.hasOwn(v, k)) bad(at(k));
    return true;
  };
  const list = (v, path, max) => {
    if (!Array.isArray(v) || v.length > max) {
      bad(path);
      return false;
    }
    return true;
  };
  const has = (v, k) => isPlain(v) && Object.hasOwn(v, k);

  strict(c, "", ["version", "runId", "sequence", "repository", "pullRequest", "commit", "dependencyLock", "ciWorkflows", "requiredChecks", "evidence", "artifacts", "provenance", "stopConditions"], ["supersedes"]);
  if (!isPlain(c)) return problems;
  if (c.version !== 1) bad("version");
  if (has(c, "runId") && !isRunId(c.runId)) bad("runId");
  if (has(c, "sequence") && !isWholeFrom1(c.sequence)) bad("sequence");
  if (has(c, "supersedes") && !isSha256(c.supersedes)) bad("supersedes");
  if (has(c, "repository") && !isRepository(c.repository)) bad("repository");

  if (has(c, "pullRequest") && strict(c.pullRequest, "pullRequest", ["repository", "number", "url"], ["head"])) {
    const pr = c.pullRequest;
    if (has(pr, "repository") && !isRepository(pr.repository)) bad("pullRequest.repository");
    if (has(pr, "number") && !isWholeFrom1(pr.number)) bad("pullRequest.number");
    if (has(pr, "url") && !isPlainHttpsUrl(pr.url)) bad("pullRequest.url");
    if (has(pr, "head") && !isCommit(pr.head)) bad("pullRequest.head");
  }
  if (has(c, "commit") && strict(c.commit, "commit", ["sha", "branch"])) {
    if (has(c.commit, "sha") && !isCommit(c.commit.sha)) bad("commit.sha");
    if (has(c.commit, "branch") && !isBranch(c.commit.branch)) bad("commit.branch");
  }
  let lockFiles;
  if (has(c, "dependencyLock") && strict(c.dependencyLock, "dependencyLock", ["files", "sha256"])) {
    if (has(c.dependencyLock, "sha256") && !isSha256(c.dependencyLock.sha256)) bad("dependencyLock.sha256");
    if (has(c.dependencyLock, "files") && list(c.dependencyLock.files, "dependencyLock.files", 1000)) {
      lockFiles = c.dependencyLock.files;
      lockFiles.forEach((f, i) => {
        if (!strict(f, `dependencyLock.files.${i}`, ["path", "sha256"])) return;
        if (has(f, "path") && !isSafeRelativePath(f.path)) bad(`dependencyLock.files.${i}.path`);
        if (has(f, "sha256") && !isSha256(f.sha256)) bad(`dependencyLock.files.${i}.sha256`);
      });
    }
  }
  const workflows = has(c, "ciWorkflows") && list(c.ciWorkflows, "ciWorkflows", 1000) ? c.ciWorkflows : undefined;
  workflows?.forEach((f, i) => {
    if (!strict(f, `ciWorkflows.${i}`, ["path", "blob"])) return;
    if (has(f, "path") && !(isSafeRelativePath(f.path) && f.path.startsWith(WORKFLOWS_DIR) && f.path.length > WORKFLOWS_DIR.length)) bad(`ciWorkflows.${i}.path`);
    if (has(f, "blob") && !isCommit(f.blob)) bad(`ciWorkflows.${i}.blob`);
  });
  const checks = has(c, "requiredChecks") && list(c.requiredChecks, "requiredChecks", 500) ? c.requiredChecks : undefined;
  checks?.forEach((n, i) => {
    if (!label(n, 200)) bad(`requiredChecks.${i}`);
  });
  if (has(c, "evidence") && strict(c.evidence, "evidence", ["path", "count", "terminalHash"])) {
    if (has(c.evidence, "path") && c.evidence.path !== EVIDENCE_EVENTS_FILE) bad("evidence.path");
    if (has(c.evidence, "count") && !isWholeFrom1(c.evidence.count)) bad("evidence.count");
    if (has(c.evidence, "terminalHash") && !isSha256(c.evidence.terminalHash)) bad("evidence.terminalHash");
  }
  const artifacts = has(c, "artifacts") && list(c.artifacts, "artifacts", 500) ? c.artifacts : undefined;
  artifacts?.forEach((a, i) => {
    if (!strict(a, `artifacts.${i}`, ["name"], ["sha256"])) return;
    if (has(a, "name") && !label(a.name, 200)) bad(`artifacts.${i}.name`);
    if (has(a, "sha256") && !isSha256(a.sha256)) bad(`artifacts.${i}.sha256`);
  });
  if (has(c, "provenance") && strict(c.provenance, "provenance", ["required"]) && typeof c.provenance.required !== "boolean") bad("provenance.required");
  if (has(c, "stopConditions") && (!Array.isArray(c.stopConditions) || c.stopConditions.some((s) => !STOP_CONDITIONS.includes(s)))) bad("stopConditions");

  if (problems.length > 0) return problems;
  // The cross-field rules (superRefine), run only on a contract whose shape is right.
  if ((c.sequence === 1) !== (c.supersedes === undefined)) bad("supersedes");
  if (c.pullRequest.repository !== c.repository) bad("pullRequest.repository");
  if (c.pullRequest.head !== undefined && c.pullRequest.head !== c.commit.sha) bad("pullRequest.head");
  if (c.dependencyLock.sha256 !== canonicalHash(lockFiles)) bad("dependencyLock.sha256");
  if (!sortedOnce(lockFiles.map((f) => f.path))) bad("dependencyLock");
  if (!sortedOnce(workflows.map((f) => f.path))) bad("ciWorkflows");
  if (!sortedOnce(checks)) bad("requiredChecks");
  if (!sortedOnce(artifacts.map((a) => a.name))) bad("artifacts");
  if (c.stopConditions.length !== STOP_CONDITIONS.length || c.stopConditions.some((s, i) => s !== STOP_CONDITIONS[i])) bad("stopConditions");
  return problems;
}

// ---- copied: src/skills/release-signature.ts, src/delivery/sshsig.ts (verify path only) ----

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const MAGIC = Buffer.from("SSHSIG", "latin1");
const KEY_TYPE = "ssh-ed25519";
const HASH_ALGORITHM = "sha512";
const BEGIN = "-----BEGIN SSH SIGNATURE-----\n";
const END = "-----END SSH SIGNATURE-----\n";

function decodeBase64Exact(s, bytes) {
  if (typeof s !== "string" || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return undefined;
  const buf = Buffer.from(s, "base64");
  return buf.length === bytes && buf.toString("base64") === s ? buf : undefined;
}
const ed25519PublicKey = (raw) => createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });

const sshString = (data) => {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length);
  return Buffer.concat([len, buf]);
};

class Reader {
  pos = 0;
  constructor(buf) {
    this.buf = buf;
  }
  u32() {
    if (this.pos + 4 > this.buf.length) throw new Error("short");
    const n = this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return n;
  }
  bytes() {
    const n = this.u32();
    if (this.pos + n > this.buf.length) throw new Error("short");
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  raw(n) {
    if (this.pos + n > this.buf.length) throw new Error("short");
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  text() {
    return this.bytes().toString("latin1");
  }
  done() {
    return this.pos === this.buf.length;
  }
}

function armour(blob) {
  const b64 = blob.toString("base64");
  let out = BEGIN;
  for (let i = 0; i < b64.length; i += 70) out += `${b64.slice(i, i + 70)}\n`;
  return out + END;
}
function signedData(message, namespace) {
  const digest = createHash(HASH_ALGORITHM).update(message).digest();
  return Buffer.concat([MAGIC, sshString(namespace), sshString(""), sshString(HASH_ALGORITHM), sshString(digest)]);
}
function parseKeyLine(line) {
  try {
    if (typeof line !== "string") return undefined;
    const parts = line.trim().split(/\s+/);
    if (parts[0] !== KEY_TYPE || parts[1] === undefined) return undefined;
    const blob = decodeBase64Exact(parts[1], 4 + KEY_TYPE.length + 4 + 32);
    if (!blob) return undefined;
    const r = new Reader(blob);
    if (r.text() !== KEY_TYPE) return undefined;
    const raw = r.bytes();
    return raw.length === 32 && r.done() ? Buffer.from(raw) : undefined;
  } catch {
    return undefined;
  }
}
/** Never throws. Returns {ok:true} or {ok:false, fault}. */
function verifySshSignature(message, armoured, trustedKeyLine, namespace) {
  const fail = (fault) => ({ ok: false, fault });
  try {
    if (typeof armoured !== "string" || !armoured.startsWith(BEGIN) || !armoured.endsWith(END)) return fail("malformed");
    const b64 = armoured.slice(BEGIN.length, armoured.length - END.length).replace(/\n/g, "");
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return fail("malformed");
    const blob = Buffer.from(b64, "base64");
    if (blob.toString("base64") !== b64 || armour(blob) !== armoured) return fail("malformed");

    const r = new Reader(blob);
    if (!r.raw(MAGIC.length).equals(MAGIC) || r.u32() !== 1) return fail("malformed");
    const pubBlob = new Reader(r.bytes());
    if (pubBlob.text() !== KEY_TYPE) return fail("malformed");
    const embedded = pubBlob.bytes();
    if (embedded.length !== 32 || !pubBlob.done()) return fail("malformed");
    const ns = r.bytes();
    if (r.bytes().length !== 0 || r.text() !== HASH_ALGORITHM) return fail("malformed");
    const sigBlob = new Reader(r.bytes());
    if (sigBlob.text() !== KEY_TYPE) return fail("malformed");
    const sig = sigBlob.bytes();
    if (sig.length !== 64 || !sigBlob.done() || !r.done()) return fail("malformed");

    if (typeof namespace !== "string" || !ns.equals(Buffer.from(namespace, "utf8"))) return fail("namespace");
    if (!verify(null, signedData(message, namespace), ed25519PublicKey(embedded), sig)) return fail("bad");

    const trusted = parseKeyLine(trustedKeyLine);
    if (!trusted) return fail("public-key");
    if (!trusted.equals(embedded)) return fail("wrong-key");
    return { ok: true };
  } catch {
    return fail("malformed");
  }
}

// ---- the contract and signature checks (verifyDeliveryContract without the events) ----

const stop = (check, fault, reason) => ({ check, status: "stop", condition: "signature-unverified", fault, reason });

/** Returns { contract?, digest?, results: [contractResult, signatureResult?] }. Never throws. */
function checkContract(text, sigText, key) {
  const no = (fault, reason) => ({ results: [stop("contract", fault, reason)] });
  try {
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      return no("unreadable", "the contract is not JSON");
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return no("unreadable", "the contract is not a JSON object");
    if (raw.version !== 1) return no("wrong-version", "the contract is of a version this Foundry does not read");
    if (canonicalJson(raw) !== text) return no("unreadable", "the contract is not written in the canonical form");
    const problems = contractProblems(raw);
    if (problems.length > 0) {
      const fields = [...new Set(problems)].slice(0, 5).join(", ");
      return no("unreadable", `the contract is not valid (${fields})`);
    }
    const ok = { check: "contract", status: "ok" };
    if (sigText.trim() === "") return { results: [ok, stop("signature", "signature-missing", "the contract has no signature")] };
    const check = verifySshSignature(text, sigText, key, NAMESPACE);
    if (!check.ok) {
      const wrongKey = check.fault === "wrong-key" || check.fault === "public-key";
      return { results: [ok, wrongKey ? stop("signature", "wrong-key", "the contract is not signed by the trusted key") : stop("signature", "signature-bad", "the signature does not verify")] };
    }
    return { contract: raw, digest: sha256Hex(Buffer.from(text, "utf8")), results: [ok, { check: "signature", status: "ok" }] };
  } catch {
    return no("unreadable", "the contract could not be read");
  }
}

// ---- copied: src/evidence/schema.ts (EvidenceEventSchema) and everything it reaches; chain.ts, parse.ts, version.ts ----
// The script only needs a yes or no per line (the library reports just the line number), so each schema is a predicate.
// CHANGE BOTH: a change to the event schema, an enum it uses, or EVIDENCE_EVENT_VERSION must change this section in the
// same commit. tests/delivery-validate-events.test.ts builds a valid event for every type and enum value and fails if not.

/** The newest event version this script reads. A higher version is refused, so a validator that falls behind stops delivery. */
const EVIDENCE_EVENT_VERSION = 9;
const EVENTS_MAX = 256 * 1024 * 1024;
const ARTIFACT_KINDS = ["log", "transcript", "diff", "flow", "skill-lock", "test-report", "other"];
const STEP_TYPES = ["claude", "shell", "approval", "parallel", "flow"];
const AGENTS = ["claude", "codex"];
const RETRY_CAUSES = ["outage", "limit"];
const TEST_OUTCOMES = ["passed", "failed"];
const OUTCOMES = ["allow", "warn", "require_approval", "deny"];
const MODES = ["observe", "enforce"];
const BOUNDARIES = ["run.start", "step.before", "step.after", "repository.access", "agent.write", "push", "approval.consume", "context.select", "run.complete"];
const CREDENTIALS = ["machine", "repository", "none"];
const REASON_CODES = [
  "branch.protected", "branch.hotfix-exception", "secret.detected", "path.forbidden", "output.limit-exceeded", "timeout.exceeded", "budget.step-exceeded",
  "budget.run-exceeded", "budget.daily-exceeded", "sandbox.required", "workspace.admin-only", "repository.not-allowed", "credential.scope-exceeded",
  "identity.missing", "tool.not-allowed", "issue.closed", "flow.retired", "approval.required", "exception.granted",
  "context.limit-exceeded", "context.sources-omitted", "context.classification-exceeded", "context.uncited",
  "policy.no-rule-matched", "policy.input-incomplete", "policy.invalid", "policy.unavailable", "policy.break-glass",
];
const NO_RULE_REASONS = ["policy.no-rule-matched", "policy.invalid", "policy.unavailable", "policy.break-glass"];
const NO_PACK_REASONS = ["policy.invalid", "policy.unavailable", "policy.break-glass"];
const DENY_ONLY_REASONS = ["policy.input-incomplete", "policy.invalid", "policy.unavailable"];
const TOOL_KINDS = ["files", "shell", "git", "github", "web", "mcp", "builtin"];
const OPERATIONS = {
  files: ["read", "write"],
  shell: ["run"],
  git: ["status", "clone", "fetch", "branch", "commit", "push"],
  github: ["issue.read", "issue.write", "pull-request.read", "pull-request.write", "pull-request.merge", "checks.read"],
  web: ["fetch", "search"],
  mcp: ["call"],
  builtin: ["call"],
};
const PROFILE_SOURCES = ["generated", "declared"];
const FIT_OUTCOMES = ["enforced", "partial", "refused"];
const FIT_RESTRICTIONS = ["deny-kind", "limit-operations", "limit-targets", "require-approval", "timeout", "concurrency", "output-cap", "sandbox-filesystem", "sandbox-network", "data-class"];
const HELD_BY = ["codex-sandbox"];
const UNREADABLE = ["not-an-object", "no-version", "unsupported-version", "invalid", "error"];
const EXCESS_FIELDS = ["operation", "targets", "dataClassification", "credential", "timeoutMs", "maxConcurrent", "outputCapBytes", "approval", "sandbox.filesystem", "sandbox.network"];
const REPO_EVIDENCE_OPERATIONS = ["clone", "fetch", "branch", "commit", "push", "pull-request", "status", "unknown"];
const REPO_OUTCOMES = ["done", "failed", "refused"];
const CONTEXT_OUTCOMES = ["written", "failed"];
const COMPONENT_KINDS = ["flow", "policy-pack", "tool-profile", "model-routes", "context-selector"];
const GOVERNANCE_STATUSES = ["ok", "unapproved", "retired", "review-due"];
const GOVERNANCE_OUTCOMES = ["allowed", "refused"];
const GOVERNANCE_FAILURES = ["book-unreadable", "check-failed"];
const MAX_GOVERNED_COMPONENTS = 200;
const CONTEXT_BUNDLE_FILE = "context.json";
const CONTEXT_OMISSION_REASONS = ["missing", "stale", "ambiguous", "over-budget", "classification", "generated", "unsupported"];
const RUN_CONTEXT_CODES = [
  "marker-failed", "issue-unreadable", "comments-unreadable", "select-invalid", "bundle-invalid", "timeout", "lock-failed", "internal",
  "repository-no-git", "repository-not-a-repository", "repository-no-commit", "repository-too-large", "repository-timeout", "repository-bad-listing", "repository-read-failed",
  "store-no-folder", "store-exists", "store-texts-do-not-match", "store-write-failed",
];
const REPO_REFUSALS = ["invalid-request", "no-target", "not-in-profile", "approval-required", "deploy-key", "no-credential", "unsafe-git-settings", "policy", "not-empty", "other-repository"];

// The patterns of zod's z.uuid() (no version) and z.iso.datetime() (no options), copied from node_modules/zod/v4/core/regexes.js (zod 4.6.5).
const UUID = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
const DATE_SOURCE = "(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))";
const DATETIME = new RegExp(`^${DATE_SOURCE}T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$`);

// Predicate builders. Each schema is a function (value) => boolean. Lookups of input names use Object.hasOwn, never a bare index.
const any = () => true;
const re = (rx) => (v) => typeof v === "string" && rx.test(v);
const oneOf = (list) => (v) => typeof v === "string" && list.includes(v);
const int = (min = -Infinity) => (v) => Number.isSafeInteger(v) && v >= min;
const bool = (v) => typeof v === "boolean";
const lbl = (max) => (v) => label(v, max);
const arr = (item, max = Infinity) => (v) => Array.isArray(v) && v.length <= max && v.every((x) => item(x));
const opt = (t) => Object.assign((v) => t(v), { optional: true });
/** z.object(shape).strict(): no other key, every key present unless it is `opt`. */
const obj = (shape) => (v) =>
  isPlain(v) && Object.keys(v).every((k) => Object.hasOwn(shape, k)) && Object.entries(shape).every(([k, s]) => (Object.hasOwn(v, k) ? s(v[k]) : s.optional === true));
/** z.discriminatedUnion(key, variants) */
const union = (key, variants) => (v) => isPlain(v) && Object.hasOwn(v, key) && typeof v[key] === "string" && Object.hasOwn(variants, v[key]) && variants[v[key]](v);
/** A schema and its superRefine: the rules run only on a value of the right shape. */
const both = (schema, rules) => (v) => schema(v) && rules(v);

const slug = re(/^[a-z0-9][a-z0-9._-]{0,99}$/);
const stepId = re(/^[a-zA-Z][\w-]{0,127}$/);
const time = re(DATETIME);
const actor = union("kind", {
  user: obj({ kind: any, id: re(UUID) }),
  cli: obj({ kind: any }),
  watcher: obj({ kind: any, id: re(/^[\w-]{1,128}$/) }),
  system: obj({ kind: any }),
});
const artifactRef = obj({ kind: oneOf(ARTIFACT_KINDS), path: isSafeRelativePath, sha256: isSha256, bytes: int(0), required: bool });
const step = obj({ id: stepId, visit: int(1), type: oneOf(STEP_TYPES), parent: opt((v) => typeof v === "string" && v.length <= 1024 && v.split("/").every(stepId)) });
const model = obj({ agent: oneOf(AGENTS), provider: lbl(100), model: lbl(200), effort: opt(lbl(32)) });
const tool = obj({ name: re(/^[A-Za-z0-9_.:-]{1,200}$/) });
const policyIdentity = obj({ id: slug, version: re(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/) });
const testResult = obj({ suite: lbl(200), outcome: oneOf(TEST_OUTCOMES), passed: opt(int(0)), failed: opt(int(0)), skipped: opt(int(0)), report: opt(artifactRef) });
const gitIdentity = obj({ commit: isCommit, branch: opt(isBranch), repository: opt(isRepository) });
const pullRequest = obj({ repository: isRepository, number: int(1), url: isPlainHttpsUrl, head: opt(isCommit) });
const flowIdentity = obj({ name: lbl(200), version: opt(int(1)) });
const toolProfileRef = obj({ id: slug, version: re(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/), sha256: isSha256 });
const contextBudget = obj({ maxSources: (v) => int(1)(v) && v <= 1000, maxSourceBytes: int(1), maxTotalBytes: int(1) });
const denial = union("kind", {
  approval: obj({ kind: any, by: actor }),
  tool: obj({ kind: any, tool }),
  policy: obj({ kind: any, policy: policyIdentity, packSha256: opt(isSha256), reasonCode: slug, tool: opt(tool) }),
});
const policyDecision = both(
  obj({ version: (v) => v === 1, policy: policyIdentity, packSha256: opt(isSha256), mode: oneOf(MODES), boundary: oneOf(BOUNDARIES), inputSha256: isSha256, outcome: oneOf(OUTCOMES), reasonCode: oneOf(REASON_CODES), rule: opt(slug), evaluatedAt: time }),
  (d) =>
    NO_RULE_REASONS.includes(d.reasonCode) === (d.rule === undefined) &&
    NO_PACK_REASONS.includes(d.reasonCode) === (d.packSha256 === undefined) &&
    !(DENY_ONLY_REASONS.includes(d.reasonCode) && d.outcome !== "deny") &&
    !(d.reasonCode === "policy.break-glass" && (d.outcome !== "warn" || d.mode !== "enforce")) &&
    !(d.reasonCode === "policy.no-rule-matched" && d.outcome !== "allow" && d.outcome !== "deny"),
);

const event = (shape) =>
  obj({
    version: (v) => v === EVIDENCE_EVENT_VERSION,
    id: re(/^[A-Za-z0-9_-]{1,64}$/),
    seq: int(0),
    runId: isRunId,
    time,
    prevHash: opt((v) => v === null || isSha256(v)),
    hash: opt(isSha256),
    type: any,
    ...shape,
  });
const stepEnd = { step, model: opt(model), exitCode: opt(int()), durationMs: int(0), artifacts: arr(artifactRef), test: opt(testResult) };
const EVENT_TYPES = {
  "run.created": event({ flow: flowIdentity, by: actor, localTest: opt((v) => v === true) }),
  "run.queued": event({}),
  "run.started": event({ base: opt(gitIdentity) }),
  "run.stopped": event({ at: opt(stepId) }),
  "run.resumed": event({ from: stepId, by: actor }),
  "run.cancelled": event({ by: actor }),
  "run.failed": event({ step: opt(step) }),
  "run.completed": event({ final: opt(gitIdentity), pullRequest: opt(pullRequest) }),
  "step.started": event({ step }),
  "step.routed": event({ step, model, fallbackFrom: opt(model) }),
  "step.profiled": event({
    step,
    agent: opt(oneOf(AGENTS)),
    source: oneOf(PROFILE_SOURCES),
    profile: opt(toolProfileRef),
    unreadable: opt(oneOf(UNREADABLE)),
    outcome: oneOf(FIT_OUTCOMES),
    gaps: arr(obj({ kind: oneOf(TOOL_KINDS), restriction: oneOf(FIT_RESTRICTIONS), heldBy: opt(oneOf(HELD_BY)) }), 100),
    excess: arr(obj({ kind: oneOf(TOOL_KINDS), operation: (v) => typeof v === "string" && v.length <= 40, field: oneOf(EXCESS_FIELDS) }), 200),
    unmappedRules: int(0),
    personalSetup: bool,
  }),
  "step.retried": event({ step, cause: oneOf(RETRY_CAUSES) }),
  "step.denied": event({ step: opt(step), denial }),
  "step.approved": event({ step, by: actor }),
  "step.failed": event(stepEnd),
  "step.completed": event({ ...stepEnd, commit: opt(gitIdentity), pullRequest: opt(pullRequest) }),
  "policy.decided": event({ decision: policyDecision, step: opt(step) }),
  "repo.operation": event({
    step,
    operation: oneOf(REPO_EVIDENCE_OPERATIONS),
    repository: opt(isRepository),
    branch: opt(isBranch),
    credential: oneOf(CREDENTIALS),
    policy: opt(oneOf(OUTCOMES)),
    outcome: oneOf(REPO_OUTCOMES),
    refusal: opt(oneOf(REPO_REFUSALS)),
    pullRequest: opt(pullRequest),
  }),
  "context.bundled": event({
    outcome: oneOf(CONTEXT_OUTCOMES),
    bundle: opt(artifactRef),
    sourcesSha256: opt(isSha256),
    limits: opt(contextBudget),
    sources: opt(int(0)),
    bytes: opt(int(0)),
    omitted: opt(obj(Object.fromEntries(CONTEXT_OMISSION_REASONS.map((r) => [r, int(0)])))),
    failure: opt(oneOf(RUN_CONTEXT_CODES)),
  }),
  "governance.decided": event({
    outcome: oneOf(GOVERNANCE_OUTCOMES),
    failure: opt(oneOf(GOVERNANCE_FAILURES)),
    components: arr(obj({ kind: oneOf(COMPONENT_KINDS), id: re(/^[A-Za-z0-9._()-]{1,60}$/), version: opt(re(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/)), status: oneOf(GOVERNANCE_STATUSES), refused: bool }), MAX_GOVERNED_COMPONENTS),
  }),
};
/** The superRefine of EvidenceEventSchema, for an event of the right shape. */
function eventRules(e) {
  if ((e.hash === undefined) !== (e.prevHash === undefined)) return false;
  if (e.hash !== undefined && (e.prevHash === null) !== (e.seq === 0)) return false;
  if ((e.type === "step.failed" || e.type === "step.completed") && new Set(e.artifacts.map((a) => a.path)).size !== e.artifacts.length) return false;
  if (e.type === "policy.decided") {
    const runWide = e.decision.boundary === "run.start" || e.decision.boundary === "run.complete" || e.decision.boundary === "context.select";
    if (runWide && e.step) return false;
    if (!runWide && !e.step && e.decision.boundary !== "repository.access") return false;
  }
  if (e.type === "step.profiled") {
    if (!e.agent && e.outcome !== "refused") return false;
    if (e.source === "generated" && (e.outcome === "refused" || e.excess.length > 0 || !e.profile)) return false;
    if ((e.profile === undefined) !== (e.unreadable !== undefined)) return false;
    if (e.profile === undefined && (e.source !== "declared" || e.outcome !== "refused")) return false;
    if (e.excess.some((x) => !OPERATIONS[x.kind].includes(x.operation))) return false;
    if (e.gaps.some((g) => g.heldBy && e.agent !== "codex")) return false;
  }
  if (e.type === "repo.operation") {
    if ((e.outcome === "refused") !== (e.refusal !== undefined)) return false;
    if (e.operation === "unknown" && (e.outcome !== "refused" || e.refusal !== "invalid-request")) return false;
    if (e.pullRequest && (e.operation !== "pull-request" || e.outcome !== "done")) return false;
  }
  if (e.type === "context.bundled") {
    const data = [e.bundle, e.sourcesSha256, e.limits, e.sources, e.bytes, e.omitted];
    if (e.outcome === "written") {
      if (data.some((x) => x === undefined) || e.failure !== undefined) return false;
      if (e.bundle.kind !== "other" || e.bundle.path !== CONTEXT_BUNDLE_FILE || !e.bundle.required) return false;
    } else if (e.failure === undefined || data.some((x) => x !== undefined)) return false;
  }
  if (e.type === "governance.decided" && (e.outcome === "refused") !== (e.failure !== undefined || e.components.some((c) => c.refused))) return false;
  if (e.type === "step.approved" && e.step.type !== "approval") return false;
  if (e.type === "step.denied" && !e.step && e.denial.kind !== "policy") return false;
  if (e.type === "step.denied" && e.step && e.denial.kind === "approval" && e.step.type !== "approval") return false;
  return true;
}
const isEvent = both(union("type", EVENT_TYPES), eventRules);

/** parseEvidenceEvent: the version is read and upgraded (EVENT_MIGRATIONS 1→2→…→9 only set the version), then the schema holds. */
function readEvent(raw) {
  const v = raw.version;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > EVIDENCE_EVENT_VERSION) return false;
  return isEvent({ ...raw, version: EVIDENCE_EVENT_VERSION });
}

/** readEvidenceChain: the line (from 1) of the first fault, or the hash of the last line. Never throws. */
function readChain(lines, runId) {
  const ids = new Set();
  let prev = null;
  let localTest = false;
  for (const [i, line] of lines.entries()) {
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      return { line: i + 1 };
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { line: i + 1 };
    let canonical;
    try {
      canonical = canonicalJson(raw);
    } catch {
      return { line: i + 1 };
    }
    if (canonical !== line || !readEvent(raw)) return { line: i + 1 };
    if (raw.seq !== i || raw.runId !== runId || ids.has(raw.id)) return { line: i + 1 };
    ids.add(raw.id);
    if (raw.hash === undefined || raw.prevHash === undefined || raw.prevHash !== prev) return { line: i + 1 };
    const { hash, ...rest } = raw;
    if (canonicalHash(rest) !== hash) return { line: i + 1 };
    prev = hash;
    if (raw.type === "run.created" && raw.localTest === true) localTest = true;
  }
  return { terminalHash: prev, localTest };
}

/** The first `count` whole lines, or null when the text has fewer line ends. The rest of the text is never split or read. */
function firstLines(text, count) {
  const lines = [];
  let pos = 0;
  while (lines.length < count) {
    const end = text.indexOf("\n", pos);
    if (end < 0) return null;
    lines.push(text.slice(pos, end));
    pos = end + 1;
  }
  return lines;
}

// copied: LOCAL_TEST_INELIGIBLE in src/delivery/contract.ts
const LOCAL_TEST_INELIGIBLE = "the run is a local test, so it is not eligible for delivery";
const evidenceStop = (reason) => ({ check: "evidence", status: "stop", condition: "evidence-unverified", fault: "evidence-head-mismatch", reason });

/** Mirrors verifyDeliveryContract with events. Never throws. */
function checkEvidence(contract, text) {
  try {
    const { count, terminalHash } = contract.evidence;
    const lines = firstLines(text, count);
    if (lines === null) return evidenceStop("the events have fewer events than the contract");
    const chain = readChain(lines, contract.runId);
    if (chain.line !== undefined) return evidenceStop(`line ${chain.line} of the events is not a chain`);
    if (chain.terminalHash !== terminalHash) return evidenceStop("the event at count - 1 does not have the contract's hash");
    if (chain.localTest) return { check: "evidence", status: "stop", condition: "evidence-unverified", fault: "local-test", reason: LOCAL_TEST_INELIGIBLE };
    return okResult("evidence");
  } catch {
    return evidenceStop("the events could not be read");
  }
}

// ---- inputs ----

function readText(option, path, max) {
  let st;
  try {
    st = statSync(path);
  } catch {
    throw new InputError(false, `${option} cannot be read`);
  }
  if (!st.isFile()) throw new InputError(false, `${option} is not a file`);
  if (st.size > max) throw new InputError(false, `${option} is larger than ${max} bytes`);
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new InputError(false, `${option} cannot be read`);
  }
}

function readKey(arg) {
  if (/^ssh-ed25519\s/.test(arg)) return arg;
  const text = readText("--public-key", arg, KEY_MAX);
  const line = text.split(/\r?\n/).find((l) => l.trim() !== "" && !l.trim().startsWith("#"));
  if (line === undefined) throw new InputError(false, "--public-key has no key line");
  return line;
}

function readChecksFile(path) {
  const text = readText("--checks", path, TEXT_MAX);
  const shape = new InputError(false, "--checks is not a JSON list of {name, conclusion}");
  let list;
  try {
    list = JSON.parse(text);
  } catch {
    throw shape;
  }
  if (!Array.isArray(list) || list.length > CHECKS_MAX) throw shape;
  for (const e of list) {
    if (!isPlain(e) || typeof e.name !== "string" || !(typeof e.conclusion === "string" || e.conclusion === null)) throw shape;
  }
  return list.map((e) => ({ name: e.name, conclusion: e.conclusion }));
}

function readMarker(path) {
  const found = readText("--comment", path, TEXT_MAX)
    .split("\n")
    .map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l))
    .map((l) => MARKER.exec(l))
    .filter((m) => m !== null);
  if (found.length === 0) throw new InputError(false, "--comment has no delivery-contract marker");
  if (found.length > 1) throw new InputError(false, "--comment has more than one delivery-contract marker");
  return { digest: found[0][1], evidence: found[0][2] };
}

function readInputs(args) {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: {
        contract: { type: "string" },
        signature: { type: "string" },
        "public-key": { type: "string" },
        repo: { type: "string" },
        checks: { type: "string" },
        comment: { type: "string" },
        events: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean" },
        version: { type: "boolean" },
      },
    }));
  } catch (e) {
    throw new InputError(true, clean(e instanceof Error ? e.message.split("\n")[0] : "bad options"));
  }
  if (values.version) return { version: true };
  if (values.help) return { help: true };
  for (const o of ["contract", "signature", "public-key"]) if (values[o] === undefined) throw new InputError(true, `--${o} is required`);
  const repo = values.repo ?? ".";
  const contract = readText("--contract", values.contract, TEXT_MAX);
  const signature = readText("--signature", values.signature, TEXT_MAX);
  const key = readKey(values["public-key"]);
  const checks = values.checks === undefined ? undefined : readChecksFile(values.checks);
  const marker = values.comment === undefined ? undefined : readMarker(values.comment);
  const events = values.events === undefined ? undefined : readText("--events", values.events, EVENTS_MAX);
  let isDir = false;
  try {
    isDir = statSync(repo).isDirectory();
  } catch {
    // reported below
  }
  return { contract, signature, key, checks, marker, events, repo, isDir, json: values.json === true };
}

// ---- git: read-only plumbing, no shell ----

async function git(repo, args, buffer = false) {
  try {
    const r = await execFileAsync("git", ["-C", repo, ...args], { maxBuffer: GIT_MAX_BUFFER, encoding: buffer ? "buffer" : "utf8", env: { ...process.env, GIT_LITERAL_PATHSPECS: "1" } });
    return r.stdout;
  } catch (e) {
    const first = String(e?.stderr ?? "").split("\n").find((l) => l.trim() !== "");
    throw new InputError(false, `git failed: ${clean(first ?? e?.code ?? "error")}`);
  }
}

/** Parses `ls-tree -z` output into entries. */
function parseTree(out) {
  const entries = [];
  for (const rec of out.split("\0")) {
    const tab = rec.indexOf("\t");
    if (tab < 0) continue;
    const [, type, oid] = rec.slice(0, tab).split(" ");
    entries.push({ type, oid, path: rec.slice(tab + 1) });
  }
  return entries;
}

const more = (list) => (list.length > 1 ? `${list[0]} (and ${list.length - 1} more)` : list[0]);
const stopWith = (check, condition, reasons) => ({ check, status: "stop", condition, reason: clean(more(reasons)) });
const okResult = (check) => ({ check, status: "ok" });

async function checkCommit(repo, head, contract) {
  if (head === contract.commit.sha) return okResult("commit");
  return stopWith("commit", "commit-changed", [`HEAD is ${head}, the contract is for ${contract.commit.sha}`]);
}

async function checkLocks(repo, head, contract) {
  const files = contract.dependencyLock.files;
  const found = new Map();
  for (let i = 0; i < files.length; i += 200) {
    const out = await git(repo, ["ls-tree", "-z", "--full-tree", head, "--", ...files.slice(i, i + 200).map((f) => f.path)]);
    for (const e of parseTree(out)) found.set(e.path, e);
  }
  const problems = [];
  for (let i = 0; i < files.length; i += 8) {
    const batch = await Promise.all(
      files.slice(i, i + 8).map(async (f) => {
        const e = found.get(f.path);
        if (e === undefined) return `${f.path} is missing`;
        if (e.type !== "blob") return `${f.path} is not a file`;
        const blob = await git(repo, ["cat-file", "blob", e.oid], true);
        return sha256Hex(blob) === f.sha256 ? undefined : `${f.path} was changed`;
      }),
    );
    problems.push(...batch.filter((p) => p !== undefined));
  }
  return problems.length === 0 ? okResult("locks") : stopWith("locks", "lock-changed", problems);
}

async function checkWorkflows(repo, head, contract) {
  const out = await git(repo, ["ls-tree", "-r", "-z", "--full-tree", head, "--", WORKFLOWS_DIR]);
  const actual = new Map();
  for (const e of parseTree(out)) if (e.type === "blob" && e.path.startsWith(WORKFLOWS_DIR)) actual.set(e.path, e.oid);
  const expected = new Map(contract.ciWorkflows.map((f) => [f.path, f.blob]));
  const problems = [];
  for (const path of [...new Set([...expected.keys(), ...actual.keys()])].sort(compareCodeUnits)) {
    if (!actual.has(path)) problems.push(`${path} was removed`);
    else if (!expected.has(path)) problems.push(`${path} was added`);
    else if (actual.get(path) !== expected.get(path)) problems.push(`${path} was changed`);
  }
  return problems.length === 0 ? okResult("workflows") : stopWith("workflows", "workflow-changed", problems);
}

function checkRequired(contract, reported) {
  const problems = [];
  for (const name of contract.requiredChecks) {
    const mine = reported.filter((r) => r.name === name);
    if (mine.length === 0) problems.push(`${name} is missing`);
    else if (mine.some((r) => r.conclusion !== "success")) problems.push(`${name} did not pass`);
  }
  return problems.length === 0 ? okResult("checks") : stopWith("checks", "required-check-failed", problems);
}

function checkComment(contract, digest, marker) {
  if (marker.digest !== digest) return stopWith("comment", "superseded", ["the comment names another contract"]);
  if (marker.evidence !== contract.evidence.terminalHash) return stopWith("comment", "evidence-unverified", ["the comment names another evidence hash"]);
  return okResult("comment");
}

// ---- output ----

const skipped = (check, why) => ({ check, status: "skipped", reason: why });

function formatText(results) {
  return results
    .map((r) => (r.status === "ok" ? `${r.check}: ok` : r.status === "stop" ? `${r.check}: stop ${r.condition}: ${clean(r.reason)}` : `${r.check}: skipped (${r.reason})`))
    .join("\n") + "\n";
}

async function run(inputs) {
  const verdict = checkContract(inputs.contract, inputs.signature, inputs.key);
  const results = [...verdict.results];
  const trusted = verdict.contract !== undefined;
  if (!trusted) {
    for (const c of CHECKS) if (!results.some((r) => r.check === c)) results.push(skipped(c, UNTRUSTED));
  } else {
    const contract = verdict.contract;
    if (!inputs.isDir) throw new InputError(false, "--repo is not a folder");
    const head = (await git(inputs.repo, ["rev-parse", "HEAD"])).trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head)) throw new InputError(false, "git failed: HEAD is not a commit id");
    results.push(await checkCommit(inputs.repo, head, contract));
    results.push(await checkLocks(inputs.repo, head, contract));
    results.push(await checkWorkflows(inputs.repo, head, contract));
    results.push(inputs.checks === undefined ? skipped("checks", "no --checks file was given") : checkRequired(contract, inputs.checks));
    results.push(inputs.events === undefined ? skipped("evidence", "no --events given") : checkEvidence(contract, inputs.events));
    results.push(inputs.marker === undefined ? skipped("comment", "no --comment file was given") : checkComment(contract, verdict.digest, inputs.marker));
  }
  const result = results.some((r) => r.status === "stop") ? "stop" : "ok";
  const out = inputs.json
    ? `${JSON.stringify({ version: 1, result, digest: verdict.digest ?? null, checks: results.map((r) => ({ ...r, reason: r.reason === undefined ? undefined : clean(r.reason) })) })}\n`
    : formatText(results);
  process.stdout.write(out);
  return result === "stop" ? 1 : 0;
}

async function main(args) {
  try {
    const inputs = readInputs(args);
    if (inputs.version) {
      process.stdout.write(VALIDATOR_VERSION + "\n");
      return 0;
    }
    if (inputs.help) {
      process.stdout.write(USAGE);
      return 0;
    }
    return await run(inputs);
  } catch (e) {
    if (e instanceof InputError) {
      process.stderr.write(`delivery-validate: ${e.message}\n${e.usage ? USAGE : ""}`);
      return 2;
    }
    process.stderr.write("delivery-validate: unexpected error\n");
    return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
