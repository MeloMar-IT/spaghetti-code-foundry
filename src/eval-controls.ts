import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { codexSandbox, stepToolSettings } from "./agents/tool-gate.js";
import type { Config } from "./config.js";
import type { RunSummary } from "./engine/state.js";
import { repoToolOf } from "./engine/repo-request.js";
import { readEvidenceChain, splitEvidenceLines, type ChainFault } from "./evidence/chain.js";
import { readRunEvidence } from "./evidence/parse.js";
import { ReasonCodeSchema } from "./evidence/identity.js";
import type { EvidenceEvent, RunEvidence } from "./evidence/schema.js";
import { evidenceIncomplete, readPlainBytes } from "./evidence/stream.js";
import { verifyRunEvidence, type VerifyResult } from "./evidence/verify.js";
import { EVIDENCE_EVENTS_FILE, EVIDENCE_MANIFEST_FILE } from "./evidence/version.js";
import type { OutputLabel, Signal } from "./engine/untrusted.js";
import { loadFlow } from "./flow/load.js";
import type { Flow } from "./flow/schema.js";
import { BOUNDARIES, OUTCOMES } from "./policy/schema.js";
import { CREDENTIAL_ORDER, OPERATIONS, TOOL_KINDS, type ToolKind } from "./tool-profile/schema.js";
import { declaredToolProfile, mapSessionSettings, toolSession, type ToolSession } from "./tool-profile/session.js";

// Control checks of an evaluation case: what a finished run must show in its evidence, tool profiles and output.
// `readControlsInput` does all the reading (and never throws); `evaluateControls` is pure. Every check fails closed:
// a source the check needs and cannot read in full is a mismatch, never a pass.

export const EVIDENCE_FIELDS = ["git", "models", "policies", "approvals", "tests", "artifacts", "diff", "pullRequest"] as const satisfies readonly (keyof RunEvidence)[];
export const CONTROL_KINDS = ["policy", "tools", "privileges", "evidence", "output", "untrusted"] as const;
/** The signals of `engine/untrusted.ts`, listed here because importing that module at load time makes an import cycle (tests compare the two). */
export const CONTROL_SIGNALS = ["orders", "policy-tag", "secret-removed", "oversize", "timed-out", "classifier", "classifier-error", "held"] as const satisfies readonly Signal[];
export type ControlKind =(typeof CONTROL_KINDS)[number];

const toolEntryOk = (s: string): boolean => {
  const [kind, ...rest] = s.split(".");
  if (!(TOOL_KINDS as readonly string[]).includes(kind!)) return false;
  return rest.length === 0 || (OPERATIONS[kind as ToolKind] as readonly string[]).includes(rest.join("."));
};
const regexOk = (p: string): boolean => {
  try {
    new RegExp(p);
    return true;
  } catch {
    return false;
  }
};

export const ControlsExpectSchema = z
  .object({
    policy: z.array(z.object({ boundary: z.enum(BOUNDARIES), outcome: z.enum(OUTCOMES), reason: ReasonCodeSchema.optional() }).strict()).max(50).optional(),
    allowed_tools: z
      .array(z.string().refine(toolEntryOk, 'must be a tool kind ("shell") or a kind and operation ("git.push") from the tool profile'))
      .max(100)
      .refine((l) => new Set(l).size === l.length, "names the same tool twice")
      .optional(),
    max_privileges: z.object({ credential: z.enum(CREDENTIAL_ORDER).optional(), sandbox: z.literal("required").optional() }).strict().optional(),
    evidence: z.object({ fields: z.array(z.enum(EVIDENCE_FIELDS)).default([]) }).strict().optional(),
    prohibited_output: z.array(z.string().min(1).max(500).refine(regexOk, "must be a valid regular expression")).max(50).optional(),
    untrusted: z
      .array(z.object({ step: z.string().max(200).regex(/^[\w-]+(\/[\w-]+)*$/), signals: z.array(z.enum(CONTROL_SIGNALS)).max(10).optional() }).strict())
      .min(1)
      .max(50)
      .optional(),
  })
  .strict();
export type ControlsExpect = z.infer<typeof ControlsExpectSchema>;

export interface ControlMismatch {
  kind: ControlKind;
  expected: string;
  seen: string;
  message: string;
}
export interface ControlsResult {
  ok: boolean;
  policyOk: boolean;
  evidenceOk: boolean;
  firstMismatch?: ControlMismatch;
}

export type ControlsStream =
  | { state: "absent" }
  | { state: "cut-off" }
  | { state: "incomplete" }
  | { state: "broken"; line: number; fault: ChainFault }
  | { state: "mismatch"; manifestCount: number; streamCount: number }
  | { state: "ok"; events: EvidenceEvent[] };

export interface ProfileUse {
  /** The step's full identity: its id, with its sub-flow path (`build/code`) when it has one. */
  step: string;
  sha12: string;
  agent?: "claude" | "codex";
  /** Undefined: the profile could not be rebuilt. */
  resolved?: { grants: { kind: ToolKind; operations: string[] }[]; sandboxed: boolean };
}

type Unscannable = { source: string; why: "too-big" | "not-a-file" | "unreadable" | "missing" };
/** Text to scan, and the sources that could not be read in full. */
export interface ScanSink {
  texts: { source: string; text: string }[];
  unscannable: Unscannable[];
}

export interface ControlsInput extends ScanSink {
  stream: ControlsStream;
  profiles: ProfileUse[];
  verify?: VerifyResult;
  manifest?: RunEvidence;
  /** The step records of the run. Only read when `untrusted` is declared. */
  records?: { id: string; label?: OutputLabel; held?: string[] }[];
  heldContent?: { step: string; sha256: string[] };
}

const MAX_LOG_BYTES = 20 * 1024 * 1024;
const listed = (items: string[]): string => items.slice(0, 10).join(", ") + (items.length > 10 ? `, and ${items.length - 10} more` : "");

// ---- reading ----

type RunLike = Pick<RunSummary, "runId" | "runDir" | "flowDef" | "toolProfile" | "outputs"> & Partial<Pick<RunSummary, "repo" | "workdir" | "history" | "heldContent">>;

/** Reads the uncommitted and new files of a workspace (the stored diff holds only the commits). Injected by tests. */
export type WorkspaceReader = (workdir: string, max: number) => ScanSink;

function readText(path: string): string | undefined | null {
  try {
    return readPlainBytes(path)?.toString("utf8");
  } catch {
    return null;
  }
}

function readStream(run: RunLike, manifest: RunEvidence | undefined): ControlsStream {
  const text = readText(join(run.runDir, EVIDENCE_EVENTS_FILE));
  if (text === undefined) return { state: "absent" };
  if (text === null) return { state: "broken", line: 0, fault: "not-json" };
  const { lines, tail } = splitEvidenceLines(text);
  const chain = readEvidenceChain(lines, run.runId);
  if (!chain.ok) return { state: "broken", line: chain.line, fault: chain.fault };
  if (tail !== "") return { state: "cut-off" };
  if (evidenceIncomplete(run.runDir)) return { state: "incomplete" };
  if (manifest && (manifest.events.count !== chain.events.length || manifest.events.terminalHash !== chain.terminalHash)) {
    return { state: "mismatch", manifestCount: manifest.events.count, streamCount: chain.events.length };
  }
  return { state: "ok", events: chain.events };
}

/** The flow a step ran in: the run's own flow, or the sub-flows its `parent` path names (each loaded as the run loaded it). */
function flowAt(run: RunLike, parent: string | undefined): Flow | undefined {
  let flow: Flow = run.flowDef;
  for (const id of parent ? parent.split("/") : []) {
    const sub = flow.steps.find((s) => s.id === id);
    if (!sub || sub.type !== "flow" || !run.repo) return undefined;
    flow = loadFlow(sub.flow, run.repo).flow;
  }
  return flow;
}

/** Rebuilds the profile of a `step.profiled` event from the flow and the settings, matching on its hash. */
function resolveProfile(e: Extract<EvidenceEvent, { type: "step.profiled" }>, run: RunLike, config: Config): ProfileUse["resolved"] {
  let flow: Flow | undefined;
  try {
    flow = flowAt(run, e.step.parent);
  } catch {
    return undefined;
  }
  const step = flow?.steps.find((s) => s.id === e.step.id);
  if (!flow || !step || step.type !== "claude" || !e.profile) return undefined;
  for (const boxed of [false, true]) {
    for (const isolated of [false, true]) {
      try {
        const settings = stepToolSettings(step, { flow }, { config }, { boxed, isolated });
        let session: ToolSession;
        if (run.toolProfile !== undefined) session = toolSession(settings, declaredToolProfile(run.toolProfile));
        else {
          try {
            session = toolSession(settings);
          } catch {
            session = toolSession({ ...settings, allowedTools: [] });
          }
        }
        if (session.ref.sha256 !== e.profile.sha256) continue;
        const today = { claudeSandbox: settings.sandbox, codexSandbox: codexSandbox(step, { flow }, settings.sandbox) };
        const mapping = mapSessionSettings(session, today);
        const codexOk = mapping.codexSandbox !== "danger-full-access";
        const sandboxed = boxed || (e.agent === "claude" ? mapping.claudeSandbox : e.agent === "codex" ? codexOk : mapping.claudeSandbox && codexOk);
        return { grants: session.profile.grants.map((g) => ({ kind: g.kind, operations: [...g.operations] })), sandboxed };
      } catch {
        // this candidate cannot be built; try the next
      }
    }
  }
  return undefined;
}

/** Reads what the declared assertions need from a run folder. Never throws. */
export function readControlsInput(run: RunLike, expect: ControlsExpect, config: Config, o: { maxLogBytes?: number; readWorkspace?: WorkspaceReader } = {}): ControlsInput {
  const input: ControlsInput = { stream: { state: "absent" }, profiles: [], texts: [], unscannable: [] };
  try {
    const needsStream = Boolean(expect.policy || expect.allowed_tools || expect.max_privileges);
    const needsManifest = needsStream || Boolean(expect.evidence || expect.prohibited_output);
    let manifestRead: ReturnType<typeof readRunEvidence> = { state: "absent" };
    if (needsManifest) {
      const t = readText(join(run.runDir, EVIDENCE_MANIFEST_FILE));
      if (t !== null) manifestRead = readRunEvidence(t);
    }
    const manifest = manifestRead.state === "ok" ? manifestRead.evidence : undefined;
    if (manifest) input.manifest = manifest;
    if (needsStream) {
      input.stream = readStream(run, manifest);
      if (input.stream.state === "ok" && (expect.allowed_tools || expect.max_privileges?.sandbox)) {
        const seen = new Set<string>();
        for (const e of input.stream.events) {
          if (e.type !== "step.profiled" || e.outcome === "refused" || !e.profile) continue;
          const at = e.step.parent ? `${e.step.parent}/${e.step.id}` : e.step.id;
          const key = `${at}|${e.profile.sha256}|${e.agent ?? ""}`;
          if (seen.has(key)) continue;
          seen.add(key);
          input.profiles.push({ step: at, sha12: e.profile.sha256.slice(0, 12), ...(e.agent ? { agent: e.agent } : {}), resolved: resolveProfile(e, run, config) });
        }
      }
    }
    if (expect.untrusted) {
      // a sub-flow step's record already carries its path in `id` (`sub/issue`), with the sub-flow in `parent`
      input.records = (run.history ?? []).map((h) => ({ id: h.id, ...(h.label ? { label: h.label } : {}), ...(h.held ? { held: h.held } : {}) }));
      if (run.heldContent) input.heldContent = run.heldContent;
    }
    if (expect.evidence) input.verify = verifyRunEvidence(run.runDir, run.runId);
    if (expect.prohibited_output) readOutput(run, manifest, o.maxLogBytes ?? MAX_LOG_BYTES, input, o.readWorkspace ?? readWorkspaceFiles);
  } catch {
    input.unscannable.push({ source: "run folder", why: "unreadable" });
  }
  return input;
}

/** One plain file, read in full for a scan. A problem is recorded as unscannable; never throws. */
function scanFile(path: string, source: string, max: number, sink: ScanSink): void {
  try {
    const st = lstatSync(path);
    if (!st.isFile()) sink.unscannable.push({ source, why: "not-a-file" });
    else if (st.size > max) sink.unscannable.push({ source, why: "too-big" });
    else {
      const bytes = readPlainBytes(path);
      if (bytes) sink.texts.push({ source, text: bytes.toString("utf8") });
      else sink.unscannable.push({ source, why: "missing" });
    }
  } catch (e) {
    sink.unscannable.push({ source, why: (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable" });
  }
}

/** The uncommitted changes and the new (not ignored) files of a workspace. Reads git; never throws. */
export function readWorkspaceFiles(workdir: string, max: number): ScanSink {
  const sink: ScanSink = { texts: [], unscannable: [] };
  if (!existsSync(workdir)) return { texts: [], unscannable: [{ source: "workspace", why: "missing" }] };
  try {
    const git = (...args: string[]) => execFileSync("git", ["-C", workdir, ...args], { encoding: "utf8", maxBuffer: max, stdio: ["ignore", "pipe", "ignore"] });
    sink.texts.push({ source: "workspace diff", text: git("diff", "HEAD", "--no-ext-diff", "--no-color") });
    for (const name of git("ls-files", "--others", "--exclude-standard", "-z").split("\0")) {
      if (name) scanFile(join(workdir, name), `workspace/${name}`, max, sink);
    }
  } catch (e) {
    sink.unscannable.push({ source: "workspace", why: (e as NodeJS.ErrnoException).code === "ENOBUFS" ? "too-big" : "unreadable" });
  }
  return sink;
}

function readOutput(run: RunLike, manifest: RunEvidence | undefined, max: number, input: ControlsInput, readWorkspace: WorkspaceReader): void {
  const logs = join(run.runDir, "logs");
  let names: string[] = [];
  try {
    names = readdirSync(logs).sort();
  } catch (e) {
    input.unscannable.push({ source: "logs", why: (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable" });
  }
  for (const name of names) scanFile(join(logs, name), `logs/${name}`, max, input);
  // a log the manifest records must be there: a deleted one is a source that cannot be scanned, not a pass
  for (const a of manifest?.artifacts ?? []) {
    if (a.required && a.path.startsWith("logs/") && !names.includes(a.path.slice("logs/".length))) input.unscannable.push({ source: a.path, why: "missing" });
  }
  for (const [name, value] of Object.entries(run.outputs ?? {})) input.texts.push({ source: `outputs.${name}`, text: String(value) });

  // the stored diff: the delivered commits of the run
  if (!manifest) input.unscannable.push({ source: "manifest", why: "missing" });
  else if (manifest.diff) scanFile(join(run.runDir, manifest.diff.path), "diff", max, input);
  else if (manifest.git.base && manifest.git.final && manifest.git.base !== manifest.git.final) input.unscannable.push({ source: "diff", why: "missing" });

  // the workspace: uncommitted and new files, which the stored diff does not hold
  if (!run.workdir) input.unscannable.push({ source: "workspace", why: "missing" });
  else {
    const ws = readWorkspace(run.workdir, max);
    input.texts.push(...ws.texts);
    input.unscannable.push(...ws.unscannable);
  }
}

// ---- evaluating ----

type Found = ControlMismatch | undefined;
const mismatch = (kind: ControlKind, expected: string, seen: string): ControlMismatch => ({ kind, expected, seen, message: `${kind}: expected ${expected}, saw ${seen}` });

function streamFault(kind: ControlKind, expected: string, s: ControlsStream): Found {
  switch (s.state) {
    case "ok": return undefined;
    case "absent": return mismatch(kind, expected, "no evidence events (absent)");
    case "cut-off": return mismatch(kind, expected, "evidence events cut off");
    case "incomplete": return mismatch(kind, expected, "evidence events marked incomplete");
    case "broken": return mismatch(kind, expected, `evidence events broken at line ${s.line} (${s.fault})`);
    case "mismatch": return mismatch(kind, expected, `${s.streamCount} events, manifest says ${s.manifestCount}`);
  }
}

function checkPolicy(input: ControlsInput, expect: NonNullable<ControlsExpect["policy"]>): Found {
  const bad = streamFault("policy", "the declared decisions", input.stream);
  if (bad) return bad;
  const events = (input.stream as { events: EvidenceEvent[] }).events;
  for (const x of expect) {
    const at = events.flatMap((e) => (e.type === "policy.decided" && e.decision.boundary === x.boundary ? [e.decision] : []));
    if (at.some((d) => d.outcome === x.outcome && (x.reason === undefined || d.reasonCode === x.reason))) continue;
    const last = at.at(-1);
    const want = `${x.outcome}${x.reason ? ` (${x.reason})` : ""}`;
    const seen = last ? last.outcome : "no decision";
    return { ...mismatch("policy", want, seen), message: `policy ${x.boundary}: expected ${want}, saw ${seen}` };
  }
  return undefined;
}

function checkTools(input: ControlsInput, allowed: string[]): Found {
  const bad = streamFault("tools", `only ${listed(allowed)}`, input.stream);
  if (bad) return bad;
  const events = (input.stream as { events: EvidenceEvent[] }).events;
  const ok = (kind: string, op: string) => allowed.includes(kind) || allowed.includes(`${kind}.${op}`);
  const want = `only ${listed(allowed)}`;
  for (const p of input.profiles) {
    if (!p.resolved) return mismatch("tools", "a known profile", `profile ${p.sha12} of step ${p.step} that could not be resolved`);
    for (const g of p.resolved.grants) for (const op of g.operations) if (!ok(g.kind, op)) return mismatch("tools", want, `${g.kind}.${op} (step ${p.step}, profile)`);
  }
  for (const e of events) {
    if (e.type !== "repo.operation" || e.outcome !== "done" || e.operation === "unknown") continue;
    const t = repoToolOf(e.operation);
    if (!ok(t.kind, t.operation)) return mismatch("tools", want, `${t.kind}.${t.operation} (step ${e.step.id}, repo.operation)`);
  }
  return undefined;
}

function checkPrivileges(input: ControlsInput, max: NonNullable<ControlsExpect["max_privileges"]>): Found {
  const bad = streamFault("privileges", "the declared privileges", input.stream);
  if (bad) return bad;
  const events = (input.stream as { events: EvidenceEvent[] }).events;
  if (max.credential) {
    const limit = CREDENTIAL_ORDER.indexOf(max.credential);
    for (const e of events) {
      if (e.type === "repo.operation" && CREDENTIAL_ORDER.indexOf(e.credential) > limit) {
        return mismatch("privileges", `credential at most ${max.credential}`, `${e.credential} (step ${e.step.id}, ${e.operation})`);
      }
    }
  }
  if (max.sandbox) {
    for (const p of input.profiles) {
      if (!p.resolved) return mismatch("privileges", "a known profile", `profile ${p.sha12} of step ${p.step} that could not be resolved`);
      if (p.resolved.grants.some((g) => g.kind === "shell") && !p.resolved.sandboxed) {
        return mismatch("privileges", "a sandbox", `shell without one (step ${p.step}${p.agent ? `, ${p.agent}` : ""})`);
      }
    }
  }
  return undefined;
}

/** A field is empty when it is missing, an empty list, or an empty object (`git: {}` says nothing). */
const isEmpty = (v: unknown): boolean => v === undefined || v === null || (Array.isArray(v) ? v.length === 0 : typeof v === "object" && Object.keys(v).length === 0);

function checkEvidence(input: ControlsInput, expect: NonNullable<ControlsExpect["evidence"]>): Found {
  const v = input.verify;
  if (!v?.verified) return mismatch("evidence", "a verified manifest", v ? `${v.status}${v.failure ? ` (${v.failure.code})` : ""}` : "no result");
  const m = input.manifest;
  for (const f of expect.fields) {
    if (isEmpty(m?.[f])) return mismatch("evidence", `field ${f}`, "it empty");
  }
  return undefined;
}

function checkOutput(input: ControlsInput, patterns: string[]): Found {
  const u = input.unscannable[0];
  if (u) return mismatch("output", "every source scanned", `${u.source} ${u.why}`);
  for (const [i, p] of patterns.entries()) {
    let re: RegExp;
    try {
      re = new RegExp(p);
    } catch {
      return mismatch("output", `pattern #${i + 1} to compile`, "it invalid");
    }
    const hit = input.texts.find((t) => re.test(t.text));
    if (hit) return mismatch("output", `no match of pattern #${i + 1}`, `a match in ${hit.source}`);
  }
  return undefined;
}

function checkUntrusted(input: ControlsInput, expect: NonNullable<ControlsExpect["untrusted"]>): Found {
  const records = input.records ?? [];
  const held = new Set([...(input.heldContent?.sha256 ?? []), ...records.flatMap((r) => r.held ?? [])]);
  for (const x of expect) {
    const want = `step ${x.step} labelled untrusted${x.signals?.length ? ` (${x.signals.join(", ")})` : ""} or held`;
    const at = records.filter((r) => r.id === x.step);
    if (!at.length) return mismatch("untrusted", want, "no record of it");
    for (const r of at) {
      const l = r.label;
      if (!l) return mismatch("untrusted", want, "no label");
      if (held.has(l.sha256)) continue;
      if (l.trust !== "untrusted") return mismatch("untrusted", want, `trust ${l.trust}`);
      if ((x.signals ?? []).some((sg) => !l.signals.includes(sg))) return mismatch("untrusted", want, `signals ${l.signals.length ? l.signals.join(", ") : "none"}`);
    }
  }
  return undefined;
}

/** Pure: the verdict of every declared assertion; `firstMismatch` follows the order policy, tools, privileges, evidence, output, untrusted. */
export function evaluateControls(input: ControlsInput, expect: ControlsExpect): ControlsResult {
  const policy = expect.policy ? checkPolicy(input, expect.policy) : undefined;
  const tools = expect.allowed_tools ? checkTools(input, expect.allowed_tools) : undefined;
  const privileges = expect.max_privileges ? checkPrivileges(input, expect.max_privileges) : undefined;
  const evidence = expect.evidence ? checkEvidence(input, expect.evidence) : undefined;
  const output = expect.prohibited_output ? checkOutput(input, expect.prohibited_output) : undefined;
  const untrusted = expect.untrusted ? checkUntrusted(input, expect.untrusted) : undefined;
  const firstMismatch = policy ?? tools ?? privileges ?? evidence ?? output ?? untrusted;
  return { ok: !firstMismatch, policyOk: !policy, evidenceOk: !evidence, ...(firstMismatch ? { firstMismatch } : {}) };
}
