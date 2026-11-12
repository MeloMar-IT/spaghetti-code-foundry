import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { credentialHits, riskyFileName } from "../skills/credential-scan.js";
import { readEvaluationSuite } from "../skills/evaluation-suite.js";
import { splitFrontmatter } from "../skills/package.js";
import { compareSkillVersions, SKILL_ID_RE } from "../skills/schema.js";
import { effectEntry, scenarioOffers, scenarioToolGaps } from "./effect.js";
import { loadLocalSkill } from "./package.js";

// The checks of the `skill-write` flow (tools/skill-check): what the writer agent may change, the format of the skill, credentials and
// live endpoints in every file, the limits and the scan of the whole folder, and the sample tasks. Messages never hold file content.

export const SKILL_WRITE_LIMITS = { descriptionChars: 1024, skillMdBytes: 65536, scenariosMin: 3, scenariosMax: 5 } as const;
/** The entries a skill folder may have at its top level: the folders of the Foundry package (src/skills/schema.ts) and a licence file. */
export const SKILL_TOP_LEVEL: readonly string[] = ["SKILL.md", "references", "scripts", "assets", "evals", "LICENSE", "LICENSE.md", "LICENSE.txt"];
/** A changelog the repository already has may get a line from the writer. */
export const CHANGELOG_PATHS: readonly string[] = ["CHANGELOG.md", "docs/CHANGELOG.md"];

const NAME_RE = SKILL_ID_RE;
// Local hosts and the reserved example names (RFC 2606): example.com/.org/.net and the example, test, invalid and localhost suffixes.
const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);
const EXAMPLE_HOSTS: ReadonlySet<string> = new Set(["example.com", "example.org", "example.net"]);
const EXAMPLE_SUFFIXES: readonly string[] = [".example", ".test", ".invalid", ".localhost"];
// Every scheme a client can reach a host with. The authority is a bracketed IPv6 address or the text up to the path.
const ENDPOINT_RE = /(?<![A-Za-z0-9+.-])(https?|wss?|ftp):\/\/(\[[0-9a-fA-F:.]+\]|[^\s/?#"'`<>)\]\[]*)/gi;
const text = (b: Uint8Array) => Buffer.from(b).toString("utf8");

/** The host of an authority ("user:pass@host:port", "[::1]:9092"), lower case. */
function hostOf(authority: string): string {
  const at = authority.lastIndexOf("@");
  const rest = at >= 0 ? authority.slice(at + 1) : authority;
  return (rest.startsWith("[") ? rest : rest.split(":")[0]!).toLowerCase();
}

// Names that only resolve inside a cluster or a private network: a Kubernetes service, mDNS, and the private-use suffixes.
const INTERNAL_SUFFIXES: readonly string[] = [".svc", ".svc.cluster.local", ".cluster.local", ".local", ".internal", ".lan", ".home.arpa"];

/**
 * True for a host that cannot reach a real machine on the internet: local, a reserved example name or a name under one
 * (api.example.com), a single-label name (otel-collector, a service in a compose file), or a cluster or private-network name.
 */
export function localOrExampleHost(host: string): boolean {
  if (host !== "" && !host.startsWith("[") && !host.includes(".")) return true;
  return LOCAL_HOSTS.has(host) || EXAMPLE_HOSTS.has(host) || EXAMPLE_SUFFIXES.some((s) => host.endsWith(s))
    || [...EXAMPLE_HOSTS].some((h) => host.endsWith(`.${h}`)) || INTERNAL_SUFFIXES.some((s) => host.endsWith(s));
}

/** Every path changed against the base commit must be inside `skills/<name>/` or a changelog the repository already has. */
export function changeProblems(name: string, changed: readonly string[], changelogs: readonly string[] = []): string[] {
  const out: string[] = [];
  const prefix = `skills/${name}/`;
  for (const p of changed) {
    if (p.startsWith(prefix) && !p.slice(prefix.length).split("/").includes("..")) continue;
    if (CHANGELOG_PATHS.includes(p) && changelogs.includes(p)) continue;
    out.push(`changed outside skills/${name}/: ${p.slice(0, 120)}`);
  }
  return out;
}

/** Name, description and size of SKILL.md, and the top-level entries of the folder. */
export function formatProblems(name: string, files: readonly { path: string; content: Uint8Array }[]): string[] {
  const out: string[] = [];
  if (!NAME_RE.test(name)) return [`the skill name "${name.slice(0, 40)}" is not a lower-case slug of 1–64 characters`];
  for (const top of new Set(files.map((f) => f.path.split("/")[0]!))) {
    if (!SKILL_TOP_LEVEL.includes(top)) out.push(`${top} is not allowed at the top of the skill folder (${SKILL_TOP_LEVEL.join(", ")})`);
  }
  const md = files.find((f) => f.path === "SKILL.md");
  if (!md) return [...out, "SKILL.md is missing"];
  let parsed: { data: unknown; body: string };
  try {
    parsed = splitFrontmatter(text(md.content));
  } catch (e) {
    return [...out, `SKILL.md: ${(e as Error).message.slice(0, 120)}`];
  }
  // the limit is for the body; the frontmatter is short and does not count
  const bodyBytes = Buffer.byteLength(parsed.body, "utf8");
  if (bodyBytes >= SKILL_WRITE_LIMITS.skillMdBytes) out.push(`SKILL.md body is ${bodyBytes} bytes; it must be under ${SKILL_WRITE_LIMITS.skillMdBytes} (move long material to references/)`);
  const data = parsed.data as Record<string, unknown>;
  if (data.name !== name) out.push(`SKILL.md: name must be "${name}", the name of the folder`);
  const d = data.description;
  if (typeof d !== "string" || d.trim() === "") out.push("SKILL.md: description is missing");
  else {
    if (d.length > SKILL_WRITE_LIMITS.descriptionChars) out.push(`SKILL.md: description is ${d.length} characters; at most ${SKILL_WRITE_LIMITS.descriptionChars}`);
    if (!/\bUse when\b/.test(d)) out.push('SKILL.md: description must say what the skill does and then "Use when …"');
  }
  return out;
}

/** Credential-shaped text and credential file names, in every file (also under evals/). Only the rule and the path are named. */
export function credentialProblems(files: readonly { path: string; content: Uint8Array }[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (riskyFileName(f.path)) out.push(`${f.path}: a credential file by its name`);
    for (const rule of new Set(credentialHits(Buffer.from(f.content).toString("latin1")).map((h) => h.rule))) out.push(`${f.path}: looks like a credential or a live endpoint (${rule})`);
  }
  return out;
}

/** At most this many live endpoints are listed per file: enough to fix them all in one go. */
const ENDPOINTS_PER_FILE = 20;
const lineAt = (t: string, i: number): number => t.slice(0, i).split("\n").length;
/** True inside a fenced code block (``` or ~~~) or inline code of Markdown: there an address is a command to run, not a link to read. */
function inCode(t: string, i: number): boolean {
  const before = t.slice(0, i);
  const fences = before.split("\n").filter((l) => /^\s{0,3}(```|~~~)/.test(l)).length;
  if (fences % 2 === 1) return true;
  const line = before.slice(before.lastIndexOf("\n") + 1);
  return (line.match(/`/g)?.length ?? 0) % 2 === 1;
}

/**
 * Live endpoints of any of http, https, ws, wss and ftp. Allowed: local, example and internal hosts everywhere, and an https address
 * in the prose of SKILL.md and references/*.md, a documentation link (not in code, and a plain http link is not a documentation
 * exception). Every hit is listed with its line
 * (up to ENDPOINTS_PER_FILE per file), so a writer can fix them all at once.
 */
export function endpointProblems(files: readonly { path: string; content: Uint8Array }[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    const doc = f.path === "SKILL.md" || (f.path.startsWith("references/") && f.path.endsWith(".md"));
    const t = text(f.content);
    let hits = 0;
    ENDPOINT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ENDPOINT_RE.exec(t))) {
      const scheme = m[1]!.toLowerCase();
      const host = hostOf(m[2]!);
      if (doc && scheme === "https" && !inCode(t, m.index)) continue;
      if (localOrExampleHost(host)) continue;
      if (++hits > ENDPOINTS_PER_FILE) { out.push(`${f.path}: more live endpoints after line ${lineAt(t, m.index)}`); break; }
      out.push(`${f.path} line ${lineAt(t, m.index)}: a live endpoint (${scheme}://${host.slice(0, 60)})${doc && scheme === "http" && !inCode(t, m.index) ? "; a documentation link must be https" : "; use a host under example.com or localhost, or remove it"}`);
    }
  }
  return out;
}

/**
 * The sections of evals/suite.yaml that are the same for every skill of a skill library. A suite that lacks one gets it from here, so
 * the writer only writes what is about the skill (selection and instructions).
 */
export const SUITE_DEFAULT_SECTIONS: readonly { key: string; text: string }[] = [
  { key: "conflicts", text: "conflicts:\n  - { id: against-approved, with: all }" },
  { key: "context", text: "context:\n  - { id: coder-budget, max_instruction_tokens: 3000, max_description_chars: 160 }" },
  { key: "tools", text: "tools:\n  - { id: read-only, policy: { shell: false, network: false, filesystem: read } }" },
];

/** Adds the missing default sections to the suite file (top-level keys only). Returns the keys it added; a missing file is left alone. */
export function fillSuiteDefaults(file: string): string[] {
  if (!existsSync(file)) return [];
  const t = readFileSync(file, "utf8");
  const missing = SUITE_DEFAULT_SECTIONS.filter((d) => !new RegExp(`^${d.key}:`, "m").test(t));
  if (missing.length === 0) return [];
  writeFileSync(file, `${t.replace(/\s*$/, "")}\n${missing.map((d) => d.text).join("\n")}\n`);
  return missing.map((d) => d.key);
}

export interface SkillCheckInput {
  /** Paths changed against the base commit (committed, staged, unstaged, untracked; renames as two paths). */
  changed?: readonly string[];
  /** Changelogs that exist at the base commit. */
  changelogs?: readonly string[];
  /** Files in the folder that git ignores. */
  ignored?: readonly string[];
  /** The version of the skill at the base commit; set for a change. The new version must be higher. */
  baseVersion?: string;
}

/** All checks for the folder `dir` (the skill folder on disk). Problems fail the check, notes do not. */
export function checkSkillFolder(dir: string, name: string, input: SkillCheckInput = {}): { problems: string[]; notes: string[] } {
  if (!NAME_RE.test(name)) return { problems: formatProblems(name, []), notes: [] };
  const problems = [...changeProblems(name, input.changed ?? [], input.changelogs ?? [])];
  for (const p of input.ignored ?? []) problems.push(`${p.slice(0, 120)} is ignored by git and would not be published`);
  const loaded = loadLocalSkill(dir);
  problems.push(...loaded.problems.filter((p) => !p.startsWith("normalize: ")));
  if (!existsSync(join(dir, "SKILL.md"))) return { problems: [...problems, "SKILL.md is missing"], notes: loaded.notes };
  problems.push(...formatProblems(name, loaded.files), ...credentialProblems(loaded.files), ...endpointProblems(loaded.files));
  problems.push(...loaded.problems.filter((p) => p.startsWith("normalize: ")));
  if (input.baseVersion !== undefined && loaded.skill) {
    try {
      if (compareSkillVersions(loaded.skill.package.version, input.baseVersion) <= 0) problems.push(`the version must be higher than ${input.baseVersion.slice(0, 40)} for a change`);
    } catch { /* an unreadable base version cannot be compared */ }
  }
  const suite = readEvaluationSuite(join(dir, "evals", "suite.yaml"));
  if (suite.state === "none") problems.push("evals/suite.yaml is missing");
  else if (suite.state === "invalid") for (const p of suite.problems) problems.push(`evals/suite.yaml ${p.where}: ${p.message}`.slice(0, 200));
  else {
    const scenarios = suite.suite.instructions?.scenarios ?? [];
    const { scenariosMin: lo, scenariosMax: hi } = SKILL_WRITE_LIMITS;
    if (scenarios.length < lo || scenarios.length > hi) problems.push(`evals/suite.yaml must have ${lo} to ${hi} instructions scenarios, not ${scenarios.length}`);
    else if (loaded.skill) {
      try {
        for (const g of scenarioToolGaps(loaded.skill.package, suite.suite.instructions!)) problems.push(`evals/suite.yaml: ${g.problem}`.slice(0, 300));
        for (const s of scenarioOffers(effectEntry(loaded.skill.package), join(dir, "evals"), suite.suite.instructions!)) {
          if (!s.offered) problems.push(`evals/suite.yaml: the skill is not offered for scenario ${s.id} (its capabilities or technologies do not match the fixture and task)`);
        }
      } catch (e) {
        problems.push(`evals/suite.yaml: ${e instanceof RangeError ? e.message : "the fixtures cannot be read"}`.slice(0, 200));
      }
    }
  }
  return { problems: [...new Set(problems)], notes: loaded.notes };
}
