import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "./canonical.js";
import { readEvidenceChain, splitEvidenceLines } from "./chain.js";
import { buildRunEvidence, flowDefinitionHash, NotFinalizable } from "./finalize.js";
import { sha256Hex, type ArtifactKind, type ArtifactRef } from "./identity.js";
import { readRunEvidence } from "./parse.js";
import type { RunEvidence } from "./schema.js";
import { evidenceIncomplete, hashPlainFile, readPlainBytes } from "./stream.js";
import { EVIDENCE_EVENTS_FILE, EVIDENCE_MANIFEST_FILE } from "./version.js";

/**
 * Verifying the evidence of a run: is the manifest readable, are the events one unbroken chain that ends where the
 * manifest says, does the manifest say what the events say, and are the files it names still what they were.
 *
 * It needs no model and no network: `verifyEvidence` is pure (it is given the texts and a way to look at a file),
 * `verifyRunEvidence` reads them from a run folder. Neither changes anything and neither throws.
 */

/** The version of the result format. Raise it when a field changes its meaning. */
export const VERIFY_RESULT_VERSION = 1;

/** The checks, in the order they are made. After the first one that fails the later ones are skipped. */
export const VERIFY_CHECKS = ["manifest", "events", "chain", "terminal", "content", "flow", "files"] as const;
export type VerifyCheck = (typeof VERIFY_CHECKS)[number];

export type VerifyFailureCode =
  | "incomplete" | "manifest-unreadable" | "manifest-version" | "manifest-run"
  | "events-missing" | "events-unreadable" | "events-cut"
  | `chain-${"not-json" | "not-canonical" | "unsupported-version" | "invalid" | "order" | "unchained" | "link" | "hash"}`
  | "events-added" | "events-removed" | "terminal-hash"
  | "manifest-changed"
  | "flow-missing" | "flow-changed"
  | "file-missing" | "file-changed" | "file-unreadable";

export interface VerifyFailure {
  check: VerifyCheck;
  code: VerifyFailureCode;
  /** One sentence for a person. It names lines and files, never their content. */
  message: string;
  /** The line of `evidence.jsonl` (from 1), for a failure of the chain. */
  line?: number;
  /** The file, relative to the run folder, for a failure of a file. */
  path?: string;
}

export interface VerifiedFile {
  kind: ArtifactKind;
  path: string;
  required: boolean;
  /** ok: there and unchanged. changed: other content. missing: not there. unreadable: not a plain file of the run folder. */
  state: "ok" | "changed" | "missing" | "unreadable";
}

export type VerifyStatus =
  /** Every check passed. Optional files may be gone (see `missingOptional`). */
  | "verified"
  /** A check failed: see `failure`. */
  | "failed"
  /** There are events in an unbroken chain but no manifest: the run has not ended, or it could not be finalized. */
  | "not-finalized"
  /** The run has no evidence at all: it was made before evidence existed. */
  | "absent";

export interface VerifyResult {
  version: typeof VERIFY_RESULT_VERSION;
  runId: string;
  status: VerifyStatus;
  /** True only for `verified`. */
  verified: boolean;
  /** One or two short sentences: the result, and the first failure when there is one. */
  explanation: string;
  /** The first check that failed. */
  failure?: VerifyFailure;
  checks: { name: VerifyCheck; state: "passed" | "failed" | "skipped" }[];
  /** The manifest that was checked: the SHA-256 of the file, and what it says about the end of the run. */
  manifest?: { sha256: string; status: RunEvidence["status"]; finalizedAt: string };
  /** The events that are an unbroken chain, and the hash of the last of them. */
  events?: { count: number; terminalHash: string | null };
  /** Every file the manifest names, in its order (the diff last). Empty until the files are looked at. */
  files: VerifiedFile[];
  /** Optional files that are no longer there. Not a failure. */
  missingOptional: string[];
}

export type TextProbe = { state: "absent" } | { state: "ok"; text: string } | { state: "unreadable" };
export type FileProbe = { state: "ok"; sha256: string; bytes: number } | { state: "missing" } | { state: "unreadable" };

export interface VerifyInput {
  runId: string;
  manifest: TextProbe;
  events: TextProbe;
  /** The run has the mark that its stream stopped after a problem. */
  incomplete: boolean;
  /** The flow definition stored with the run (`flowDef` of `run.json`); undefined when it cannot be read. */
  flowDef: unknown;
  /** Looks at one file the manifest names, by its path relative to the run folder. */
  file: (path: string) => FileProbe;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Checks the evidence of one run. Pure and total: every input gives a result. */
export function verifyEvidence(input: VerifyInput): VerifyResult {
  const states = new Map<VerifyCheck, "passed" | "failed" | "skipped">(VERIFY_CHECKS.map((c) => [c, "skipped"]));
  const result: VerifyResult = { version: VERIFY_RESULT_VERSION, runId: input.runId, status: "failed", verified: false, explanation: "", checks: [], files: [], missingOptional: [] };
  const done = (status: VerifyStatus, explanation: string): VerifyResult => ({ ...result, status, verified: status === "verified", explanation, checks: VERIFY_CHECKS.map((name) => ({ name, state: states.get(name)! })) });
  const fail = (check: VerifyCheck, code: VerifyFailureCode, message: string, at: { line?: number; path?: string } = {}): VerifyResult => {
    states.set(check, "failed");
    result.failure = { check, code, message, ...at };
    return done("failed", `Not verified: ${message}.`);
  };
  const pass = (check: VerifyCheck) => states.set(check, "passed");

  // 1. the manifest
  if (input.manifest.state === "absent" && input.events.state === "absent" && !input.incomplete) {
    return done("absent", "This run has no evidence: it was made before evidence existed. There is nothing to verify.");
  }
  if (input.incomplete) return fail("manifest", "incomplete", "the events of this run are not whole: an event could not be written while it ran (evidence.incomplete)");
  if (input.manifest.state === "unreadable") return fail("manifest", "manifest-unreadable", "evidence.json is not a plain file");
  let manifest: RunEvidence | undefined;
  if (input.manifest.state === "ok") {
    const read = readRunEvidence(input.manifest.text);
    if (read.state !== "ok") {
      return read.state === "unreadable" && read.code === "unsupported-version"
        ? fail("manifest", "manifest-version", "evidence.json was written by a newer Foundry; update to verify it")
        : fail("manifest", "manifest-unreadable", "evidence.json is not a valid manifest");
    }
    manifest = read.evidence;
    result.manifest = { sha256: sha256Hex(Buffer.from(input.manifest.text, "utf8")), status: manifest.status, finalizedAt: manifest.finalizedAt };
    if (manifest.runId !== input.runId) return fail("manifest", "manifest-run", "evidence.json belongs to another run");
    pass("manifest");
  }

  // 2. the event file
  if (input.events.state === "absent") return fail("events", "events-missing", "evidence.jsonl is not there");
  if (input.events.state === "unreadable") return fail("events", "events-unreadable", "evidence.jsonl is not a plain file");
  const { lines, tail } = splitEvidenceLines(input.events.text);
  // without a manifest a cut-off last line is a run that was interrupted, not a change
  if (tail !== "" && manifest) return fail("events", "events-cut", "evidence.jsonl ends in a line that was cut off");
  pass("events");

  // 3. the chain: versions, order, links and hashes of every line
  const chain = readEvidenceChain(lines, input.runId);
  result.events = { count: chain.events.length, terminalHash: chain.ok ? chain.terminalHash : (chain.events.at(-1)?.hash ?? null) };
  if (!chain.ok) return fail("chain", `chain-${chain.fault}`, `evidence.jsonl, ${chain.message}`, { line: chain.line });
  pass("chain");
  if (!manifest) {
    return done("not-finalized", `Not verified: the run has ${plural(chain.events.length, "event")} in an unbroken chain but no manifest. It has not ended, or it could not be finalized.`);
  }

  // 4. the chain ends where the manifest says
  if (chain.events.length > manifest.events.count) {
    return fail("terminal", "events-added", `evidence.jsonl has ${plural(chain.events.length, "event")} but the manifest was written for ${manifest.events.count}: the run went on, or lines were added`);
  }
  if (chain.events.length < manifest.events.count) {
    return fail("terminal", "events-removed", `evidence.jsonl has ${plural(chain.events.length, "event")} but the manifest was written for ${manifest.events.count}: lines were removed`);
  }
  if (chain.terminalHash !== manifest.events.terminalHash) return fail("terminal", "terminal-hash", "the hash of the last event is not the one in the manifest: the events were written again");
  pass("terminal");

  // 5. the manifest says what the events say (the flow hash, the diff and the time of writing are checked on their own)
  try {
    const again = buildRunEvidence(chain.events, { terminalHash: chain.terminalHash, flowSha256: manifest.flow.sha256, finalizedAt: manifest.finalizedAt, diff: manifest.diff });
    if (canonicalJson(again) !== canonicalJson(manifest)) return fail("content", "manifest-changed", "evidence.json does not say what the events say: it was changed after it was written");
  } catch (e) {
    return fail("content", "manifest-changed", e instanceof NotFinalizable ? `evidence.json does not fit the events: ${e.message}` : "evidence.json does not fit the events");
  }
  pass("content");

  // 6. the flow definition stored with the run
  if (input.flowDef === undefined || input.flowDef === null) return fail("flow", "flow-missing", "the flow definition of the run cannot be read (run.json)", { path: "run.json" });
  let flowHash: string | undefined;
  try {
    flowHash = flowDefinitionHash(input.flowDef);
  } catch {
    // a definition that has no canonical form is not the one that was hashed
  }
  if (flowHash !== manifest.flow.sha256) return fail("flow", "flow-changed", "the flow definition in run.json is not the one the run ended with", { path: "run.json" });
  pass("flow");

  // 7. every file the manifest names
  const named: ArtifactRef[] = [...manifest.artifacts, ...(manifest.diff ? [manifest.diff] : [])];
  let first: VerifyFailure | undefined;
  for (const ref of named) {
    let probe: FileProbe;
    try {
      probe = input.file(ref.path);
    } catch {
      probe = { state: "unreadable" };
    }
    const state: VerifiedFile["state"] = probe.state === "ok" ? (probe.sha256 === ref.sha256 && probe.bytes === ref.bytes ? "ok" : "changed") : probe.state;
    result.files.push({ kind: ref.kind, path: ref.path, required: ref.required, state });
    if (state === "missing" && !ref.required) result.missingOptional.push(ref.path);
    else if (state !== "ok" && !first) {
      const what = state === "changed" ? "was changed" : state === "missing" ? "is not there, and the evidence needs it" : "is not a plain file of the run folder";
      first = { check: "files", code: `file-${state}`, message: `${ref.path} ${what}`, path: ref.path };
    }
  }
  if (first) {
    states.set("files", "failed");
    result.failure = first;
    return done("failed", `Not verified: ${first.message}.`);
  }
  pass("files");
  const gone = result.missingOptional;
  return done(
    "verified",
    `Verified: ${plural(chain.events.length, "event")} in an unbroken chain, ${plural(named.length - gone.length, "file")} unchanged.` +
      (gone.length ? ` ${plural(gone.length, "optional file is", "optional files are")} no longer there (${gone.join(", ")}); that is allowed.` : ""),
  );
}

function readText(path: string): TextProbe {
  try {
    const bytes = readPlainBytes(path);
    return bytes ? { state: "ok", text: bytes.toString("utf8") } : { state: "absent" };
  } catch {
    return { state: "unreadable" };
  }
}

/** Looks at a file of the run folder without leaving it: a link on the way, a folder or a pipe is "unreadable". */
function probeFile(runDir: string, path: string): FileProbe {
  const full = join(runDir, path);
  try {
    lstatSync(full);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? { state: "missing" } : { state: "unreadable" };
  }
  try {
    if (realpathSync(full) !== join(realpathSync(runDir), path)) return { state: "unreadable" };
  } catch {
    return { state: "unreadable" };
  }
  const hash = hashPlainFile(full);
  return hash ? { state: "ok", ...hash } : { state: "unreadable" };
}

/** Verifies the evidence in a run folder. `runId` is the name of the folder. Reads only; never throws. */
export function verifyRunEvidence(runDir: string, runId: string): VerifyResult {
  let flowDef: unknown;
  try {
    const bytes = readPlainBytes(join(runDir, "run.json"));
    flowDef = bytes ? (JSON.parse(bytes.toString("utf8")) as { flowDef?: unknown } | null)?.flowDef : undefined;
  } catch {
    flowDef = undefined;
  }
  return verifyEvidence({
    runId,
    manifest: readText(join(runDir, EVIDENCE_MANIFEST_FILE)),
    events: readText(join(runDir, EVIDENCE_EVENTS_FILE)),
    incomplete: evidenceIncomplete(runDir),
    flowDef,
    file: (path) => probeFile(runDir, path),
  });
}
