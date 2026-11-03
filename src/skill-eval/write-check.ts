import { existsSync } from "node:fs";
import { join } from "node:path";
import { credentialHits, riskyFileName } from "../skills/credential-scan.js";
import { readEvaluationSuite } from "../skills/evaluation-suite.js";
import { splitFrontmatter } from "../skills/package.js";
import { SKILL_ID_RE } from "../skills/schema.js";
import { effectEntry, scenarioOffers } from "./effect.js";
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

/** True for a host that cannot reach a real machine: local, or a reserved example name. */
export function localOrExampleHost(host: string): boolean {
  return LOCAL_HOSTS.has(host) || EXAMPLE_HOSTS.has(host) || EXAMPLE_SUFFIXES.some((s) => host.endsWith(s));
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

/**
 * Live endpoints of any of http, https, ws, wss and ftp. Allowed: local and reserved example hosts everywhere, and an https Markdown
 * link target in SKILL.md and references/*.md (a plain http link is not a documentation exception).
 */
export function endpointProblems(files: readonly { path: string; content: Uint8Array }[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    const doc = f.path === "SKILL.md" || (f.path.startsWith("references/") && f.path.endsWith(".md"));
    const t = text(f.content);
    ENDPOINT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ENDPOINT_RE.exec(t))) {
      const scheme = m[1]!.toLowerCase();
      const host = hostOf(m[2]!);
      if (doc && scheme === "https" && t.slice(Math.max(0, m.index - 2), m.index) === "](") continue;
      if (localOrExampleHost(host)) continue;
      out.push(`${f.path}: a live endpoint (${scheme}://${host.slice(0, 60)})`);
      break;
    }
  }
  return out;
}

export interface SkillCheckInput {
  /** Paths changed against the base commit (committed, staged, unstaged, untracked; renames as two paths). */
  changed?: readonly string[];
  /** Changelogs that exist at the base commit. */
  changelogs?: readonly string[];
  /** Files in the folder that git ignores. */
  ignored?: readonly string[];
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
  const suite = readEvaluationSuite(join(dir, "evals", "suite.yaml"));
  if (suite.state === "none") problems.push("evals/suite.yaml is missing");
  else if (suite.state === "invalid") for (const p of suite.problems) problems.push(`evals/suite.yaml ${p.where}: ${p.message}`.slice(0, 200));
  else {
    const scenarios = suite.suite.instructions?.scenarios ?? [];
    const { scenariosMin: lo, scenariosMax: hi } = SKILL_WRITE_LIMITS;
    if (scenarios.length < lo || scenarios.length > hi) problems.push(`evals/suite.yaml must have ${lo} to ${hi} instructions scenarios, not ${scenarios.length}`);
    else if (loaded.skill) {
      try {
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
