/**
 * Bounded technology profile of a checked-out repository: file types, build files, dependencies, import roots,
 * schemas, deployment files and configured commands, each with its source path and the detector that found it.
 *
 * Runs locally: reads the folder, writes nothing into it, starts no process, uses no network. Every limit is in
 * REPO_PROFILE_LIMITS. Only identifiers (see TOKEN_RE) reach a finding, never free text from file bodies. Paths are
 * repository-relative but still repository-controlled text: treat them as untrusted when they go into a prompt.
 */
import { mkdirSync, lstatSync, opendirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { readRegular } from "./package.js";
import { commandsIn, cleanToken, dependenciesIn, importsIn, type RawFinding } from "./repo-profile-detect.js";
import {
  deploymentOf, FINDING_KINDS, languageOf, manifestOf, REPO_PROFILE_FILE, REPO_PROFILE_LIMITS, REPO_PROFILE_VERSION,
  schemaOf, skipDir, skipFile, SKIP_CLASSES, type FindingKind, type SkipClass,
} from "./repo-profile-rules.js";
import { relativePathProblem, SKILL_ID_RE } from "./schema.js";

const int = z.number().int().nonnegative();
const COMMIT_RE = /^[0-9a-f]{7,64}$/;

export const RepoFindingSchema = z
  .object({
    kind: z.enum(FINDING_KINDS),
    name: z.string().min(1).max(120),
    value: z.string().max(120).optional(),
    count: z.number().int().positive().optional(),
    path: z.string().min(1).max(200),
    detector: z.string().regex(SKILL_ID_RE),
    reason: z.string().min(1).max(160),
  })
  .strict()
  .superRefine((f, ctx) => {
    const bad = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    const p = relativePathProblem(f.path);
    if (p) bad("path", p);
    else if (/[\u0000-\u001f\u007f]/.test(f.path)) bad("path", "must not contain control characters");
    if (cleanToken(f.name) === undefined) bad("name", "must be a plain identifier");
    if (f.value !== undefined && cleanToken(f.value, f.kind === "command") === undefined) bad("value", "must be a plain identifier");
  });

const kindCounts = z.object(Object.fromEntries(FINDING_KINDS.map((k) => [k, int])) as Record<FindingKind, typeof int>).strict();

export const RepoProfileSchema = z
  .object({
    version: z.literal(REPO_PROFILE_VERSION),
    commit: z.string().regex(COMMIT_RE).optional(),
    limits: z
      .object({
        files: int, directories: int, depth: int, dirEntries: int, fileBytes: int, totalBytes: int,
        pathChars: int, valueChars: int, findings: kindCounts, artifactBytes: int,
      })
      .strict(),
    stats: z.object({ files: int, directories: int, bytesRead: int }).strict(),
    truncated: z.object({ files: z.boolean(), bytes: z.boolean(), findings: z.boolean() }).strict(),
    skipped: z.record(z.enum(SKIP_CLASSES), int),
    findings: z.array(RepoFindingSchema).max(500),
  })
  .strict();

export type RepoFinding = z.infer<typeof RepoFindingSchema>;
export type RepoProfile = z.infer<typeof RepoProfileSchema>;
type Limits = { -readonly [K in keyof typeof REPO_PROFILE_LIMITS]: (typeof REPO_PROFILE_LIMITS)[K] extends number ? number : Record<FindingKind, number> };

export interface RepoProfileOptions {
  commit?: string;
  /** Can only lower a limit; a value that is not a positive whole number is ignored. */
  limits?: { [K in keyof Omit<typeof REPO_PROFILE_LIMITS, "findings">]?: number } & { findings?: Partial<Record<FindingKind, number>> };
}

const lower = (v: unknown, max: number) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? Math.min(v, max) : max);

function effectiveLimits(o: RepoProfileOptions["limits"]): Limits {
  const d = REPO_PROFILE_LIMITS;
  const l: Limits = { ...d, findings: { ...d.findings } };
  if (!o) return l;
  for (const k of ["files", "directories", "depth", "dirEntries", "fileBytes", "totalBytes", "pathChars", "valueChars", "artifactBytes"] as const) {
    l[k] = lower(o[k], d[k]);
  }
  for (const k of FINDING_KINDS) l.findings[k] = lower(o.findings?.[k], d.findings[k]);
  return l;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf("/")));
const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const BAD_NAME = /[\u0000-\u001f\u007f\\]/;
const CONFIG_PATH = ".claude-factory/config.yaml";
const READ_DEPS = /^(?:package\.json|composer\.json|go\.mod|Cargo\.toml|pyproject\.toml|requirements[\w.-]*\.txt|pom\.xml|build\.gradle(?:\.kts)?|Gemfile)$/;
const READ_CMDS = /^(?:package\.json|go\.mod|Cargo\.toml|pyproject\.toml|Makefile)$/;
const SEE_CMDS = /^(?:pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|gradlew|pom\.xml)$/;
const IMPORT_LANGS = new Set(["typescript", "javascript", "python", "go", "java", "kotlin", "rust", "vue", "svelte"]);

interface Walked { rel: string; size: number }
type Finding = RepoFinding;

function listDir(abs: string, max: number): { names: string[]; more: boolean } | undefined {
  let d;
  try {
    d = opendirSync(abs);
  } catch {
    return undefined;
  }
  const names: string[] = [];
  let more = false;
  try {
    for (let e = d.readSync(); e; e = d.readSync()) {
      if (names.length >= max) {
        more = true;
        break;
      }
      names.push(e.name);
    }
  } catch {
    /* keep what was read */
  } finally {
    try {
      d.closeSync();
    } catch {
      /* ignore */
    }
  }
  return { names, more };
}

/** Reads the folder; writes nothing, starts no process. Throws Error("not a folder") only when root is not a directory. */
export function buildRepoProfile(root: string, opts: RepoProfileOptions = {}): RepoProfile {
  let isDir = false;
  try {
    isDir = statSync(root).isDirectory();
  } catch {
    /* not a folder */
  }
  if (!isDir) throw new Error("not a folder");
  if (opts.commit !== undefined && !COMMIT_RE.test(opts.commit)) throw new Error("invalid commit");
  const L = effectiveLimits(opts.limits);

  const skipped = Object.fromEntries(SKIP_CLASSES.map((c) => [c, 0])) as Record<SkipClass, number>;
  const trunc = { files: false, bytes: false, findings: false };
  const groups = new Map<string, Finding>();
  const put = (kind: FindingKind, name: string, detector: string, reason: string, path: string, groupDir?: string, value?: string) => {
    const key = `${kind}\0${groupDir ?? path}\0${name}`;
    const have = groups.get(key);
    if (have) {
      have.count = (have.count ?? 1) + 1;
      return;
    }
    const f: Finding = { kind, name, detector, reason, path };
    if (value !== undefined) f.value = value;
    if (groupDir !== undefined) f.count = 1;
    groups.set(key, f);
  };

  // Walk: breadth first; in each folder known build, schema and deployment files come first, then names in code-unit order.
  const walked: Walked[] = [];
  let files = 0;
  let dirs = 0;
  const queue: { rel: string; depth: number }[] = [{ rel: "", depth: 0 }];
  const priority = (rel: string) => (manifestOf(rel) || schemaOf(rel) || deploymentOf(rel) || rel === ".claude-factory" ? 0 : 1);
  walk: for (let qi = 0; qi < queue.length; qi++) {
    const { rel, depth } = queue[qi]!;
    if (dirs >= L.directories) {
      trunc.files = true;
      break;
    }
    dirs++;
    const listing = listDir(rel ? join(root, rel) : root, L.dirEntries);
    if (!listing) {
      skipped.other++;
      continue;
    }
    if (listing.more) {
      // Which entries come first depends on the file system, so a folder over the limit is left out whole.
      trunc.files = true;
      continue;
    }
    const entries: { name: string; rel: string }[] = [];
    for (const name of listing.names) {
      const r = rel ? `${rel}/${name}` : name;
      if (BAD_NAME.test(name) || r.length > L.pathChars) skipped.other++;
      else entries.push({ name, rel: r });
    }
    entries.sort((a, b) => priority(a.rel) - priority(b.rel) || cmp(a.name, b.name));
    for (const e of entries) {
      let st;
      try {
        st = lstatSync(join(root, e.rel));
      } catch {
        skipped.other++;
        continue;
      }
      if (st.isSymbolicLink()) skipped.symlink++;
      else if (st.isDirectory()) {
        const why = skipDir(e.name);
        if (why) skipped[why]++;
        else if (depth + 1 > L.depth) trunc.files = true;
        else queue.push({ rel: e.rel, depth: depth + 1 });
      } else if (st.isFile()) {
        if (files >= L.files) {
          trunc.files = true;
          break walk;
        }
        files++;
        const why = skipFile(e.rel);
        if (why) skipped[why]++;
        else if (st.size > L.fileBytes && !manifestOf(e.rel)?.lockfile) skipped.large++; // lockfiles are never read, only named
        else walked.push({ rel: e.rel, size: st.size });
      } else skipped.other++;
    }
  }

  // Findings that need the path only.
  for (const f of walked) {
    const dir = dirOf(f.rel);
    const lang = languageOf(f.rel);
    if (lang) put("language", lang, "language-extension", "recognized file extension", f.rel, dir);
    const m = manifestOf(f.rel);
    if (m) put("manifest", m.system, "manifest-name", m.lockfile ? `${m.system} lockfile` : `${m.system} build file`, f.rel, undefined, m.lockfile ? "lockfile" : undefined);
    const s = schemaOf(f.rel);
    if (s) put("schema", s, "schema-name", `${s} schema file`, f.rel, dir);
    const dp = deploymentOf(f.rel);
    if (dp) put("deployment", dp, `deployment-${dp}`, `${dp} deployment file`, f.rel, dp === "terraform" ? dir : undefined);
  }

  // Content passes share one byte budget.
  let bytesRead = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const readText = (f: Walked): string | undefined => {
    if (bytesRead + f.size > L.totalBytes) {
      trunc.bytes = true;
      return undefined;
    }
    const r = readRegular(join(root, f.rel), L.fileBytes);
    if (typeof r === "string") {
      skipped[r === "link" ? "symlink" : r === "large" ? "large" : "other"]++;
      return undefined;
    }
    bytesRead += r.length;
    if (r.includes(0)) {
      skipped.binary++;
      return undefined;
    }
    try {
      return decoder.decode(r);
    } catch {
      skipped.binary++;
      return undefined;
    }
  };
  const addRaw = (r: RawFinding, path: string) => {
    put(r.kind, r.name, r.detector, r.reason, r.path ?? path, undefined, r.value);
  };

  // Pass 1: dependency declarations and command sources.
  const texts = new Map<string, string | undefined>();
  for (const f of walked) {
    const b = baseOf(f.rel);
    const deps = READ_DEPS.test(b);
    if (!deps && !READ_CMDS.test(b) && f.rel !== CONFIG_PATH) continue;
    const text = readText(f);
    texts.set(f.rel, text);
    if (deps && text !== undefined) for (const d of dependenciesIn(f.rel, text)) addRaw(d, f.rel);
  }
  const cmdDirs = new Map<string, Map<string, string | undefined>>();
  for (const f of walked) {
    const b = baseOf(f.rel);
    const isCfg = f.rel === CONFIG_PATH;
    if (!isCfg && !READ_CMDS.test(b) && !SEE_CMDS.test(b)) continue;
    const dir = isCfg ? "" : dirOf(f.rel);
    if (!cmdDirs.has(dir)) cmdDirs.set(dir, new Map());
    cmdDirs.get(dir)!.set(f.rel, texts.get(f.rel));
  }
  for (const dir of [...cmdDirs.keys()].sort(cmp)) for (const c of commandsIn(dir, cmdDirs.get(dir)!)) addRaw(c, dir);

  // Pass 2: import roots.
  for (const f of walked) {
    const lang = languageOf(f.rel);
    if (!lang || !IMPORT_LANGS.has(lang)) continue;
    const text = readText(f);
    if (text === undefined) continue;
    for (const i of importsIn(f.rel, text)) {
      put("import", i.module, `import-${i.ecosystem}`, "import root observed in source", f.rel, `${dirOf(f.rel)}\0${i.ecosystem}`, i.ecosystem);
    }
  }

  // Cap per kind (shallowest first), sort, then fit the artifact size.
  const depthOf = (p: string) => p.split("/").length;
  const order = (a: Finding, b: Finding) => depthOf(a.path) - depthOf(b.path) || cmp(a.path, b.path) || cmp(a.name, b.name);
  const kept: Finding[] = [];
  for (const kind of FINDING_KINDS) {
    const all = [...groups.values()].filter((f) => f.kind === kind).sort(order);
    if (all.length > L.findings[kind]) trunc.findings = true;
    kept.push(...all.slice(0, L.findings[kind]));
  }
  const kindIx = (k: FindingKind) => FINDING_KINDS.indexOf(k);
  kept.sort((a, b) => kindIx(a.kind) - kindIx(b.kind) || cmp(a.path, b.path) || cmp(a.name, b.name));

  const profile: RepoProfile = {
    version: 1,
    ...(opts.commit !== undefined ? { commit: opts.commit } : {}),
    limits: L,
    stats: { files, directories: dirs, bytesRead },
    truncated: trunc,
    skipped,
    findings: kept,
  };
  while (profile.findings.length > 0 && Buffer.byteLength(serializeRepoProfile(profile)) > L.artifactBytes) {
    profile.findings.pop();
    trunc.findings = true;
  }
  return profile;
}

/** Stable text: 2-space JSON, fixed key order, trailing newline. Throws when the profile does not match the schema. */
export function serializeRepoProfile(profile: RepoProfile): string {
  return `${JSON.stringify(RepoProfileSchema.parse(profile), null, 2)}\n`;
}

/** Writes <dir>/repo-profile.json (temp file + rename) and returns its path. `dir` must be outside the repository, e.g. the run folder. */
export function writeRepoProfile(dir: string, profile: RepoProfile): string {
  const text = serializeRepoProfile(profile);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, REPO_PROFILE_FILE);
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, text, { mode: 0o644 });
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return target;
}
