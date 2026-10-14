import { createHash } from "node:crypto";
import { lstatSync, opendirSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { credentialProblem } from "./credential-scan.js";
import {
  EVALUATION_LIMITS, EVALUATION_SUITE_DIGEST_HEADER, EVALUATION_SUITE_LIMITS, type EvaluationDimension,
} from "./evaluation-rules.js";
import { byteCmp } from "./import-plan.js";
import { canonicalJson, plainProblem } from "./normalize-values.js";
import { readRegular } from "./package.js";
import { buildRepoProfile, type RepoProfile } from "./repo-profile.js";
import { relativePathProblem, SKILL_ID_RE } from "./schema.js";
import { hasUnsafeChar, shownValue, type SourceProblem } from "./sources.js";

// The suite file of the skill evaluation: scenarios for selection, conflicts, context size and tool boundaries, checked like
// skill-scan-exceptions.yaml. Pure except readEvaluationSuite, which reads the file and its fixture folders. Nothing is run.

const L = EVALUATION_SUITE_LIMITS;
export interface SelectionScenario { id: string; repo: string; task: string; modules: string[]; expect: "offered" | "not-offered" }
export interface ConflictScenario { id: string; with: "all" | string[] }
export interface ContextScenario { id: string; max_instruction_tokens?: number; max_description_chars?: number }
export interface ToolsScenario { id: string; policy: { shell: boolean; network: boolean; filesystem: "read" | "write" } }
export interface EvaluationSuite {
  schema: 1;
  selection: SelectionScenario[];
  conflicts: ConflictScenario[];
  context: ContextScenario[];
  tools: ToolsScenario[];
}
export type EvaluationSuiteRead =
  | { state: "none" }
  | { state: "invalid"; problems: SourceProblem[] }
  | { state: "ok"; suite: EvaluationSuite; profiles: Map<string, RepoProfile>; digest: string };

type Raw = Record<string, unknown>;
type Dim = Exclude<EvaluationDimension, "instructions">;
const DIMS: readonly Dim[] = ["selection", "conflicts", "context", "tools"];
const isObject = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);

/** The one way to make a problem: nothing in it is credential-like. */
function problem(where: string, message: string): SourceProblem {
  const rule = credentialProblem(message);
  return { where, message: rule ? `holds what looks like a credential (${rule})` : message };
}
const safeSlug = (v: unknown): v is string => typeof v === "string" && SKILL_ID_RE.test(v) && credentialProblem(v) === undefined;

interface Problems { add(field: string, message: string): void }

/** Checks one scenario map; `keys` are the allowed keys. Returns the id and the map, or undefined after reporting. */
function checkScenario(raw: unknown, keys: readonly string[], p: Problems): Raw | undefined {
  if (!isObject(raw)) {
    p.add("", "must be a map");
    return undefined;
  }
  for (const k of Object.keys(raw)) if (k !== "id" && !keys.includes(k)) p.add("", `unknown key "${shownValue(k)}"`);
  return raw;
}

function whole(raw: Raw, field: string, max: number, p: Problems, required: boolean): number | undefined {
  const v = raw[field];
  if (v === undefined) {
    if (required) p.add(field, "is required");
    return undefined;
  }
  if (typeof v !== "number" || !Number.isInteger(v)) {
    p.add(field, "must be a whole number");
    return undefined;
  }
  if (v < 1 || v > max) {
    p.add(field, `must be between 1 and ${max}`);
    return undefined;
  }
  return v;
}
function bool(raw: Raw, field: string, p: Problems): boolean | undefined {
  const v = raw[field];
  if (v === undefined) {
    p.add(field, "is required");
    return undefined;
  }
  if (typeof v !== "boolean") {
    p.add(field, "must be true or false");
    return undefined;
  }
  return v;
}
function text(raw: Raw, field: string, max: number, p: Problems): string | undefined {
  const v = raw[field];
  if (v === undefined || v === null) {
    p.add(field, "is required");
    return undefined;
  }
  if (typeof v !== "string") {
    p.add(field, "must be text");
    return undefined;
  }
  if (hasUnsafeChar(v)) {
    p.add(field, "holds a control or invisible character");
    return undefined;
  }
  const rule = credentialProblem(v);
  if (rule) {
    p.add(field, `holds what looks like a credential (${rule})`);
    return undefined;
  }
  const t = v.trim();
  if (t.length < 1 || t.length > max) {
    p.add(field, `must be 1 to ${max} characters`);
    return undefined;
  }
  return t;
}
/** A plain relative path of 1..pathChars characters, no comma, no control character. */
function pathValue(v: unknown, field: string, p: Problems): string | undefined {
  if (typeof v !== "string") {
    p.add(field, "must be text");
    return undefined;
  }
  const reason = v.length > L.pathChars ? `must be at most ${L.pathChars} characters` : relativePathProblem(v);
  if (reason) {
    p.add(field, reason);
    return undefined;
  }
  if (v.includes(",") || /[\u0000-\u001f\u007f]/.test(v) || hasUnsafeChar(v)) {
    p.add(field, "must not hold a comma or a control character");
    return undefined;
  }
  return v;
}

function selectionOf(raw: Raw, id: string, p: Problems): SelectionScenario | undefined {
  let bad = false;
  const sub: Problems = { add: (f, m) => { bad = true; p.add(f, m); } };
  const repo = raw.repo === undefined ? (sub.add("repo", "is required"), undefined) : pathValue(raw.repo, "repo", sub);
  const task = text(raw, "task", L.taskChars, sub);
  let modules: string[] = [];
  if (raw.modules !== undefined) {
    if (!Array.isArray(raw.modules)) sub.add("modules", "must be a list");
    else if (raw.modules.length > L.modules) sub.add("modules", `must hold at most ${L.modules} paths`);
    else {
      const got = raw.modules.flatMap((m, i) => {
        const v = pathValue(m, `modules[${i}]`, sub);
        return v === undefined ? [] : [v];
      });
      modules = [...new Set(got)].sort(byteCmp);
      if (modules.join(",").length > EVALUATION_LIMITS.inputChars) sub.add("modules", `must be at most ${EVALUATION_LIMITS.inputChars} characters together`);
    }
  }
  const expect = raw.expect;
  if (expect !== "offered" && expect !== "not-offered") sub.add("expect", expect === undefined ? "is required" : 'must be "offered" or "not-offered"');
  if (bad || repo === undefined || task === undefined || (expect !== "offered" && expect !== "not-offered")) return undefined;
  return { id, repo, task, modules, expect };
}
function conflictOf(raw: Raw, id: string, p: Problems): ConflictScenario | undefined {
  const w = raw.with;
  if (w === "all") return { id, with: "all" };
  if (!Array.isArray(w) || w.length < 1) {
    p.add("with", 'must be "all" or a list of skill ids');
    return undefined;
  }
  if (w.length > L.compared) {
    p.add("with", `must name at most ${L.compared} skills`);
    return undefined;
  }
  let ok = true;
  w.forEach((x, i) => {
    if (typeof x !== "string" || !SKILL_ID_RE.test(x)) {
      ok = false;
      p.add(`with[${i}]`, "must be a skill id");
    } else if (credentialProblem(x)) {
      ok = false;
      p.add(`with[${i}]`, "holds what looks like a credential");
    }
  });
  return ok ? { id, with: [...new Set(w as string[])].sort(byteCmp) } : undefined;
}
function contextOf(raw: Raw, id: string, p: Problems): ContextScenario | undefined {
  const t = whole(raw, "max_instruction_tokens", L.maxTokens, p, false);
  const c = whole(raw, "max_description_chars", L.maxChars, p, false);
  if (raw.max_instruction_tokens === undefined && raw.max_description_chars === undefined) {
    p.add("", "needs max_instruction_tokens or max_description_chars");
    return undefined;
  }
  if ((raw.max_instruction_tokens !== undefined && t === undefined) || (raw.max_description_chars !== undefined && c === undefined)) return undefined;
  return { id, ...(t !== undefined ? { max_instruction_tokens: t } : {}), ...(c !== undefined ? { max_description_chars: c } : {}) };
}
function toolsOf(raw: Raw, id: string, p: Problems): ToolsScenario | undefined {
  const pol = raw.policy;
  if (pol === undefined) {
    p.add("policy", "is required");
    return undefined;
  }
  if (!isObject(pol)) {
    p.add("policy", "must be a map");
    return undefined;
  }
  let ok = true;
  const sub: Problems = { add: (f, m) => { ok = false; p.add(`policy.${f}`.replace(/\.$/, ""), m); } };
  for (const k of Object.keys(pol)) if (!["shell", "network", "filesystem"].includes(k)) sub.add("", `unknown key "${shownValue(k)}"`);
  const shell = bool(pol, "shell", sub);
  const network = bool(pol, "network", sub);
  const fs = pol.filesystem;
  if (fs !== "read" && fs !== "write") sub.add("filesystem", fs === undefined ? "is required" : 'must be "read" or "write"');
  if (!ok || shell === undefined || network === undefined || (fs !== "read" && fs !== "write")) return undefined;
  return { id, policy: { shell, network, filesystem: fs } };
}

const KEYS: Record<Dim, readonly string[]> = {
  selection: ["repo", "task", "modules", "expect"],
  conflicts: ["with"],
  context: ["max_instruction_tokens", "max_description_chars"],
  tools: ["policy"],
};

/** Checks parsed YAML. Never throws. Scenarios are returned sorted by id. No problem holds a credential-like value. */
export function parseEvaluationSuite(raw: unknown): { suite?: EvaluationSuite; problems: SourceProblem[] } {
  const problems: SourceProblem[] = [];
  const add = (where: string, message: string) => void problems.push(problem(where, message));
  const plain = plainProblem(raw);
  if (plain) {
    add("file", plain);
    return { problems };
  }
  if (!isObject(raw)) {
    add("file", "must be a map with schema and the scenarios");
    return { problems };
  }
  for (const k of Object.keys(raw)) if (k !== "schema" && !(DIMS as readonly string[]).includes(k)) add("file", `unknown key "${shownValue(k)}"`);
  if (raw.schema !== 1) add("schema", "schema must be 1");

  const suite: EvaluationSuite = { schema: 1, selection: [], conflicts: [], context: [], tools: [] };
  const used = new Map<string, string>();
  let total = 0;
  for (const dim of DIMS) {
    const list = raw[dim];
    if (list === undefined) {
      add(dim, "is required");
      continue;
    }
    if (!Array.isArray(list)) {
      add(dim, "must be a list");
      continue;
    }
    if (list.length < 1) {
      add(dim, "must hold at least one scenario");
      continue;
    }
    if (list.length > L.perDimension) {
      add(dim, `must hold at most ${L.perDimension} scenarios`);
      continue;
    }
    total += list.length;
    list.forEach((item, i) => {
      const base = `${dim}[${i}]`;
      const idRaw = isObject(item) ? item.id : undefined;
      const tag = safeSlug(idRaw) ? `${base} (${idRaw})` : base;
      const p: Problems = { add: (field, message) => add(field ? `${tag} ${field}` : tag, message) };
      const map = checkScenario(item, KEYS[dim], p);
      if (!map) return;
      let id: string | undefined;
      if (idRaw === undefined) p.add("id", "is required");
      else if (typeof idRaw !== "string" || !SKILL_ID_RE.test(idRaw)) p.add("id", "must be a lower-case slug of 1–64 characters (letters, digits, single hyphens)");
      else if (credentialProblem(idRaw)) p.add("id", "holds what looks like a credential");
      else {
        const first = used.get(idRaw);
        if (first !== undefined) p.add("id", `is already used by ${first}`);
        else {
          used.set(idRaw, base);
          id = idRaw;
        }
      }
      const found =
        dim === "selection" ? selectionOf(map, id ?? "", p)
        : dim === "conflicts" ? conflictOf(map, id ?? "", p)
        : dim === "context" ? contextOf(map, id ?? "", p)
        : toolsOf(map, id ?? "", p);
      if (found && id !== undefined) (suite[dim] as unknown[]).push(found);
    });
  }
  if (total > L.scenarios) add("file", `must hold at most ${L.scenarios} scenarios in all`);
  if (Array.isArray(raw.selection) && raw.selection.length > 0 && raw.selection.length <= L.perDimension) {
    const exps = raw.selection.map((s) => (isObject(s) ? s.expect : undefined));
    if (!exps.includes("offered") || !exps.includes("not-offered")) add("selection", 'needs at least one "offered" and one "not-offered" scenario');
  }
  if (problems.length) return { problems };
  for (const dim of DIMS) (suite[dim] as { id: string }[]).sort((a, b) => byteCmp(a.id, b.id));
  return { suite, problems };
}

/** The inputs of every scenario, as the record wants them (suite.scenarios), sorted by id. */
export function suiteScenarios(suite: EvaluationSuite): { id: string; inputs: Record<string, string> }[] {
  const out: { id: string; inputs: Record<string, string> }[] = [];
  for (const s of suite.selection) {
    out.push({ id: s.id, inputs: { dimension: "selection", repo: s.repo, task: s.task, ...(s.modules.length ? { modules: s.modules.join(",") } : {}), expect: s.expect } });
  }
  for (const s of suite.conflicts) out.push({ id: s.id, inputs: { dimension: "conflicts", with: s.with === "all" ? "all" : s.with.join(",") } });
  for (const s of suite.context) {
    out.push({
      id: s.id,
      inputs: {
        dimension: "context",
        ...(s.max_instruction_tokens !== undefined ? { max_instruction_tokens: String(s.max_instruction_tokens) } : {}),
        ...(s.max_description_chars !== undefined ? { max_description_chars: String(s.max_description_chars) } : {}),
      },
    });
  }
  for (const s of suite.tools) {
    out.push({ id: s.id, inputs: { dimension: "tools", shell: String(s.policy.shell), network: String(s.policy.network), filesystem: s.policy.filesystem } });
  }
  return out.sort((a, b) => byteCmp(a.id, b.id));
}

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Pure. Throws TypeError when a fixture named by the suite has no profile. Key order and scenario order do not matter. */
export function evaluationSuiteDigest(suite: EvaluationSuite, profiles: ReadonlyMap<string, RepoProfile>): string {
  const h = createHash("sha256");
  h.update(EVALUATION_SUITE_DIGEST_HEADER);
  const lines: [string, string][] = [];
  for (const dim of DIMS) for (const s of suite[dim]) lines.push([s.id, canonicalJson({ dimension: dim, ...s })]);
  for (const [, line] of lines.sort((a, b) => byteCmp(a[0], b[0]))) h.update(line + "\n");
  for (const repo of [...new Set(suite.selection.map((s) => s.repo))].sort(byteCmp)) {
    const profile = profiles.get(repo);
    if (!profile) throw new TypeError("a fixture of the suite has no profile");
    // One finding per line: canonicalJson refuses more than 2000 values.
    const fh = createHash("sha256");
    for (const f of profile.findings) fh.update(canonicalJson(f) + "\n");
    h.update(`fixture ${repo} ${fh.digest("hex")}\n`);
  }
  return "sha256:" + h.digest("hex");
}

const errCode = (e: unknown) => String((e as NodeJS.ErrnoException)?.code ?? "unknown error").replace(/[^A-Za-z0-9_ ]/g, "").slice(0, 40);
const LIMITS_TEXT = `is larger than the fixture limits (${L.fixtureFiles} files, ${L.fixtureFileBytes} bytes per file, ${L.fixtureTotalBytes} bytes in total, ${L.fixtureDepth} folders deep)`;

/** Walks the fixture breadth first and counts every file. Returns the reason it is refused, or undefined. Stops at the first limit. */
function fixtureInventory(root: string): string | undefined {
  let files = 0;
  let bytes = 0;
  let entries = 0;
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  for (let q = queue.shift(); q; q = queue.shift()) {
    let d;
    try {
      d = opendirSync(q.dir);
    } catch (e) {
      return `cannot be read (${errCode(e)})`;
    }
    try {
      // One entry at a time: a wide folder is refused after fixtureEntries entries, before it is held in memory.
      for (let e = d.readSync(); e; e = d.readSync()) {
        if (++entries > L.fixtureEntries) return LIMITS_TEXT;
        const abs = join(q.dir, e.name);
        const st = lstatSync(abs);
        if (st.isSymbolicLink()) return "holds a symbolic link";
        if (st.isDirectory()) {
          if (q.depth + 1 > L.fixtureDepth) return LIMITS_TEXT;
          queue.push({ dir: abs, depth: q.depth + 1 });
        } else if (st.isFile()) {
          files++;
          bytes += st.size;
          if (files > L.fixtureFiles || st.size > L.fixtureFileBytes || bytes > L.fixtureTotalBytes) return LIMITS_TEXT;
        } else return "holds a file that is not a regular file";
      }
    } catch (e) {
      return `cannot be read (${errCode(e)})`;
    } finally {
      try {
        d.closeSync();
      } catch {
        /* ignore */
      }
    }
  }
  return undefined;
}

/** The folder is a real directory below `base`: no segment is a symbolic link. */
function fixtureFolder(base: string, repo: string): string | undefined {
  let cur = base;
  for (const seg of repo.split("/")) {
    cur = join(cur, seg);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      return "is not a folder";
    }
    if (st.isSymbolicLink()) return "is a symbolic link";
    if (!st.isDirectory()) return "is not a folder";
  }
  return undefined;
}

const fail = (message: string): EvaluationSuiteRead => ({ state: "invalid", problems: [problem("file", message)] });

/** Reads the file and its fixture folders (relative to the file). No message repeats a path of the machine or file content. */
export function readEvaluationSuite(path: string): EvaluationSuiteRead {
  let st;
  try {
    st = lstatSync(path);
  } catch (e) {
    return String((e as NodeJS.ErrnoException)?.code) === "ENOENT" ? { state: "none" } : fail(`cannot be read (${errCode(e)})`);
  }
  if (st.isSymbolicLink()) return fail("is a symbolic link");
  if (!st.isFile()) return fail("is not a readable regular file");
  let data: ReturnType<typeof readRegular>;
  try {
    data = readRegular(path, L.fileBytes);
  } catch (e) {
    return fail(`cannot be read (${errCode(e)})`);
  }
  if (data === "link") return fail("is a symbolic link");
  if (data === "other") return fail("is not a readable regular file");
  if (data === "large") return fail(`is larger than ${L.fileBytes} bytes`);
  let doc: unknown;
  try {
    doc = parseYaml(Buffer.from(data).toString("utf8"), { maxAliasCount: 0 });
  } catch (e) {
    const x = e as { code?: unknown; linePos?: { line?: unknown; col?: unknown }[] };
    const code = typeof x.code === "string" && /^[A-Z_]{1,40}$/.test(x.code) ? x.code : undefined;
    const pos = x.linePos?.[0];
    if (code && pos && Number.isInteger(pos.line) && Number.isInteger(pos.col)) return fail(`is not valid YAML (${code} at line ${pos.line}, column ${pos.col})`);
    return fail("is not valid YAML");
  }
  const parsed = parseEvaluationSuite(doc);
  if (!parsed.suite) return { state: "invalid", problems: parsed.problems };
  const suite = parsed.suite;

  const problems: SourceProblem[] = [];
  const profiles = new Map<string, RepoProfile>();
  const refused = new Map<string, string>();
  const base = dirname(path);
  for (const repo of new Set(suite.selection.map((s) => s.repo))) {
    const dir = join(base, repo);
    let why = fixtureFolder(base, repo) ?? fixtureInventory(dir);
    if (!why) {
      try {
        const profile = buildRepoProfile(dir, { limits: { files: L.fixtureFiles, fileBytes: L.fixtureFileBytes, totalBytes: L.fixtureTotalBytes } });
        const s = profile.skipped;
        if (profile.truncated.files || profile.truncated.bytes || (s.large ?? 0) > 0 || (s.symlink ?? 0) > 0 || (s.other ?? 0) > 0) why = "cannot be read completely";
        else profiles.set(repo, profile);
      } catch {
        why = "cannot be read";
      }
    }
    if (why) refused.set(repo, why);
  }
  for (const s of suite.selection) {
    const why = refused.get(s.repo);
    if (why) problems.push(problem(`selection (${s.id}) repo`, why));
  }
  if (problems.length) return { state: "invalid", problems };
  return { state: "ok", suite, profiles, digest: evaluationSuiteDigest(suite, profiles) };
}
